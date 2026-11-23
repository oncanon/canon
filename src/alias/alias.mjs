// Mutable alias records: <root>/aliases/<name>.json -> one immutable content ID.
//
// Concurrency (docs/decisions/phase1-contract.md D5): every update is a
// compare-and-swap on `generation`. Writers serialize on an exclusive lock file
// (O_CREAT|O_EXCL), re-read the record under the lock, and fail with
// `generation-conflict` if the caller's expectation is stale. The new record is
// written to a private temp file and renamed over the old one, so readers see
// either the old or the new record, never a partial one. A lock left by a crashed
// writer is not broken automatically: updates fail with `alias-locked` until an
// operator confirms no writer is running and removes it.
import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { CONTENT_ID_PATTERN } from '../hash.mjs';
import { ALIAS_SCHEMA } from '../policy.mjs';
import { packetPath } from '../publish/filesystem.mjs';
// Full verify: site bundles via site/verify.mjs; packets with the independent rules plus,
// for render-policy/2, reproduction (R11).
import { verifyArtifactFull as verifyArtifact } from '../packet/reproduce.mjs';

import { ALIAS_NAME_PATTERN } from './name.mjs';

export { ALIAS_NAME_PATTERN };

export class AliasError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'AliasError';
    this.code = code;
    this.details = details;
  }
}

function aliasPaths(root, name) {
  if (!ALIAS_NAME_PATTERN.test(name)) throw new AliasError('invalid-alias-name', `alias name must match ${ALIAS_NAME_PATTERN}`);
  const dir = join(resolve(root), 'aliases');
  return { dir, record: join(dir, `${name}.json`), lock: join(dir, `${name}.lock`), history: join(dir, `${name}.history.jsonl`) };
}

function validateRecord(record, name) {
  const keys = Object.keys(record ?? {}).sort().join(',');
  if (keys !== 'contentId,generation,name,previousContentId,schema') throw new AliasError('alias-corrupt', `alias ${name} has unexpected members`);
  if (record.schema !== ALIAS_SCHEMA || record.name !== name) throw new AliasError('alias-corrupt', `alias ${name} schema/name mismatch`);
  if (!CONTENT_ID_PATTERN.test(record.contentId)) throw new AliasError('alias-corrupt', `alias ${name} has a malformed content ID`);
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) throw new AliasError('alias-corrupt', `alias ${name} has an invalid generation`);
  if (record.previousContentId !== null && !CONTENT_ID_PATTERN.test(record.previousContentId)) throw new AliasError('alias-corrupt', `alias ${name} has a malformed previous ID`);
  return record;
}

export async function readAlias(root, name) {
  const { record } = aliasPaths(root, name);
  let bytes;
  try {
    const st = await lstat(record);
    if (!st.isFile()) throw new AliasError('alias-corrupt', `alias ${name} is not a regular file`);
    bytes = await readFile(record);
  } catch (err) {
    if (err instanceof AliasError) throw err;
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AliasError('alias-corrupt', `alias ${name} is not valid JSON`);
  }
  return validateRecord(parsed, name);
}

// expectGeneration: the generation the caller believes is current (0 = alias must
// not exist yet). Required: there is no unconditional overwrite.
export async function setAlias({ root, name, contentId, expectGeneration }) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new AliasError('invalid-content-id', `malformed content ID ${JSON.stringify(contentId)}`);
  if (!Number.isSafeInteger(expectGeneration) || expectGeneration < 0) throw new AliasError('expect-generation-required', 'expectGeneration must be a non-negative integer');
  const target = packetPath(root, contentId);
  const check = await verifyArtifact(target);
  if (!check.ok || check.contentId !== contentId) {
    throw new AliasError('target-not-published', `${contentId} is not a verified published packet under ${resolve(root)}`, { errors: check.errors });
  }

  const paths = aliasPaths(root, name);
  await mkdir(paths.dir, { recursive: true });
  let lock;
  try {
    lock = await open(paths.lock, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') throw new AliasError('alias-locked', `alias ${name} is locked by another writer (${paths.lock})`);
    throw err;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const current = await readAlias(root, name);
    const currentGeneration = current ? current.generation : 0;
    if (currentGeneration !== expectGeneration) {
      throw new AliasError('generation-conflict', `alias ${name} is at generation ${currentGeneration}, caller expected ${expectGeneration}`, { currentGeneration, currentContentId: current?.contentId ?? null });
    }
    const record = {
      schema: ALIAS_SCHEMA,
      name,
      contentId,
      generation: currentGeneration + 1,
      previousContentId: current ? current.contentId : null,
    };
    const temp = join(paths.dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, 'wx', 0o644);
    try {
      await handle.writeFile(canonicalBytes(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, paths.record);
    await appendFile(paths.history, `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    await lock.close();
    // Release: remove this writer's own lock file.
    await unlink(paths.lock);
  }
}

// Append the history line for `record` when it is missing, under the same writer lock.
// This repairs the one gap setAlias can leave: it renames the new record into place,
// then appends its history line, and that append can fail after the rename committed
// (used by the V2 fs adapter; docs/v2/publication-protocol.md §4.1). Idempotent and
// keyed by generation. It never changes the alias record, and it appends only the
// entry for the current record, directly after the last one. setAlias is unchanged.
export async function appendAliasHistory({ root, name, record }) {
  const paths = aliasPaths(root, name);
  let lock;
  try {
    lock = await open(paths.lock, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') throw new AliasError('alias-locked', `alias ${name} is locked by another writer (${paths.lock})`);
    throw err;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const line = { schema: ALIAS_SCHEMA, name, contentId: record.contentId, generation: record.generation, previousContentId: record.previousContentId ?? null };
    let text = '';
    try {
      text = await readFile(paths.history, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let entries;
    try {
      entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      throw new AliasError('alias-corrupt', `alias ${name} history is not valid JSON lines`);
    }
    const entry = entries.find((r) => r.generation === line.generation);
    if (entry) {
      if (entry.contentId === line.contentId && (entry.previousContentId ?? null) === line.previousContentId) return { written: false };
      throw new AliasError('history-conflict', `alias ${name} history already holds a different generation ${line.generation}`);
    }
    const current = await readAlias(root, name);
    const last = entries.at(-1)?.generation ?? 0;
    if (!current || current.generation !== line.generation || current.contentId !== line.contentId || last !== line.generation - 1) {
      throw new AliasError('history-gap', `alias ${name} is at generation ${current?.generation ?? 0} and its history ends at ${last}; only the entry for the current record can be appended`);
    }
    await appendFile(paths.history, `${JSON.stringify(line)}\n`);
    return { written: true };
  } finally {
    await lock.close();
    await unlink(paths.lock);
  }
}

export async function listAliases(root) {
  const dir = join(resolve(root), 'aliases');
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const jsonFiles = names.filter((f) => !f.startsWith('.') && f.endsWith('.json')).sort();
  const out = [];
  for (const file of jsonFiles) {
    const name = file.slice(0, -5);
    if (!ALIAS_NAME_PATTERN.test(name)) {
      throw new AliasError('alias-corrupt', `unexpected alias record filename ${JSON.stringify(file)}`);
    }
    const record = await readAlias(root, name);
    if (!record) continue;
    const st = await lstat(join(dir, file));
    let artifactSchema = null;
    let title = null;
    let entry = 'index.html';
    let agentEntry = null;
    try {
      const manifestPath = join(packetPath(root, record.contentId), 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      artifactSchema = manifest.schema ?? null;
      title = manifest.report?.title ?? manifest.site?.title ?? null;
      entry = manifest.entry ?? 'index.html';
      agentEntry = typeof manifest.agentEntry === 'string' ? manifest.agentEntry : (manifest.agentEntry?.path ?? null);
    } catch {
      // Target metadata is informational; readAlias/setAlias handle verification.
    }
    out.push({
      name: record.name,
      generation: record.generation,
      contentId: record.contentId,
      previousContentId: record.previousContentId,
      artifactSchema,
      title,
      entry,
      agentEntry,
      updatedAt: st.mtime.toISOString(),
    });
  }
  return out;
}
