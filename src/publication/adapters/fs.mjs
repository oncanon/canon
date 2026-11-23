// fs adapter: the V1 filesystem store behind publication/v1 (docs/v2/architecture.md
// §6). It uses the V1 layout unchanged: <root>/packets/<content-id>/ (immutable, as
// V1 publish creates it), <root>/aliases/<name>.json and .history.jsonl (V1 alias
// records, updated through V1 setAlias), plus <root>/receipts/v2/.
//
// Objects arrive one at a time. They are staged under <root>/.uploads/<content-id>/
// with exclusive creates; the write of manifest.json (the commit marker) verifies the
// staged packet with the V1 verifier and renames it into packets/<content-id>/
// atomically, exactly as V1 publish does. Reads see only committed packets, so V1
// readers (the server, aliases) never observe a partial packet.
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AliasError, appendAliasHistory, readAlias, setAlias } from '../../alias/alias.mjs';
import { CONTENT_ID_PATTERN, sha256Hex } from '../../hash.mjs';
// Full verify: independent rules plus, for render-policy/2, reproduction (R11).
import { verifyArtifactFull as verifyArtifact } from '../../packet/reproduce.mjs';
import { admissionDecision, manifestRenderPolicy } from '../../publish/admission.mjs';
import { CODES, PublicationError } from '../errors.mjs';

const MEDIA = { html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' };
const mediaType = (path) => MEDIA[path.slice(path.lastIndexOf('.') + 1)];

function parseKey(key) {
  const m = key.match(/^p\/(sha256-[0-9a-f]{64})\/(.+)$/);
  if (!m || !CONTENT_ID_PATTERN.test(m[1]) || m[2].split('/').some((s) => s === '' || s === '.' || s === '..')) throw new PublicationError(CODES.INVALID, `not a packet object key: ${key}`);
  return { contentId: m[1], path: m[2] };
}

const exists = (p) => lstat(p).then(() => true, () => false);

// allowRenderPolicy1: the store's own admission gate (render-policy-2.md R12). The put of
// manifest.json, which triggers the commit, refuses a render-policy/1 packet once the
// default has moved, unless the adapter was built for an operator who passed
// --allow-render-policy-1. It decides from the manifest bytes before staging them, so a
// refused packet stays uncommitted and a rerun with the flag commits it. Dormant while the
// default is render-policy/1.
export function fsAdapter({ root, allowRenderPolicy1 = false }) {
  const base = resolve(root);
  const committed = (id) => join(base, 'packets', id);
  const staged = (id) => join(base, '.uploads', id);
  const tmpDir = join(base, '.uploads', '.tmp');
  let requests = 0;

  // The only removal in this adapter: this call's own temp file, after it has
  // been linked into place (or lost the race). Never a packet, alias or receipt.
  async function removeOwnTemp(temp) {
    if (dirname(temp) !== tmpDir) throw new Error(`refusing to remove ${temp}: not an own temp file`);
    await unlink(temp);
  }

  // Exclusive create: write and fsync a private temp file, then link() it to the
  // destination, which fails if the destination exists. No partial file is ever
  // visible at the destination.
  async function createExclusive(dest, bytes) {
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(dest), { recursive: true });
    const temp = join(tmpDir, `${randomBytes(8).toString('hex')}.tmp`);
    const h = await open(temp, 'wx', 0o444);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await link(temp, dest);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    } finally {
      await removeOwnTemp(temp);
    }
  }

  async function compare(file, sha256) {
    const have = await readFile(file).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!have) return { outcome: 'conflict' };
    const existing = sha256Hex(have);
    return existing === sha256 ? { outcome: 'identical' } : { outcome: 'conflict', existingSha256: existing };
  }

  async function commit(contentId) {
    const check = await verifyArtifact(staged(contentId));
    if (!check.ok || check.contentId !== contentId) return false;
    await mkdir(join(base, 'packets'), { recursive: true });
    try {
      await rename(staged(contentId), committed(contentId));
    } catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(err.code)) throw err;
    }
    return true;
  }

  return {
    describe: () => ({ kind: 'fs', credentialClass: 'none' }),
    liveSecrets: () => [],
    requestCount: () => requests,

    async putIfAbsent({ key, sha256 }, bytes) {
      requests += 1;
      if (sha256Hex(bytes) !== sha256) throw new PublicationError(CODES.BAD_DIGEST, `${key}: bytes do not match the declared SHA-256`);
      const { contentId, path } = parseKey(key);
      if (await exists(committed(contentId))) return compare(join(committed(contentId), path), sha256);
      if (path === 'manifest.json') {
        let manifest = null;
        try { manifest = JSON.parse(bytes.toString('utf8')); } catch { /* the commit's verify refuses it */ }
        const admission = admissionDecision(manifestRenderPolicy(manifest), { allowRenderPolicy1 });
        if (!admission.admit) throw new PublicationError(CODES.RENDER_POLICY_REFUSED, `${contentId}: ${admission.message}`);
      }
      const dest = join(staged(contentId), path);
      if (!(await createExclusive(dest, bytes))) return compare(dest, sha256);
      if (path === 'manifest.json') await commit(contentId);
      return { outcome: 'created' };
    },

    async headObject(key) {
      requests += 1;
      const { contentId, path } = parseKey(key);
      const bytes = await readFile(join(committed(contentId), path)).catch(() => null);
      if (!bytes) return { exists: false };
      return { exists: true, bytes: bytes.length, sha256: sha256Hex(bytes), contentType: mediaType(path), cacheControl: 'public, max-age=31536000, immutable' };
    },

    async getObject(key) {
      requests += 1;
      const { contentId, path } = parseKey(key);
      return readFile(join(committed(contentId), path)).catch(() => null);
    },

    async readAlias(name) {
      requests += 1;
      return readAlias(base, name);
    },

    // V1 setAlias renames the new record into place, then appends its history line.
    // If it fails with anything but a V1 alias error, re-read under the V1 layout: a
    // record at expectGeneration + 1 pointing at this content means the rename
    // committed and only the history append failed. That is this writer's move; the
    // protocol then repairs the history (appendHistory).
    async casAlias(name, expectGeneration, contentId) {
      requests += 1;
      try {
        return { ok: true, record: await setAlias({ root: base, name, contentId, expectGeneration }) };
      } catch (err) {
        if (!(err instanceof AliasError)) {
          const now = await readAlias(base, name).catch(() => null);
          if (now && now.generation === expectGeneration + 1 && now.contentId === contentId) return { ok: true, record: now };
          throw new PublicationError(CODES.PROTOCOL, `alias CAS ${name}: ${err.code ?? err.message}`);
        }
        if (err.code === 'generation-conflict') return { ok: false, currentGeneration: err.details.currentGeneration };
        if (err.code === 'alias-locked') throw new PublicationError(CODES.THROTTLED, err.message);
        if (err.code === 'target-not-published') throw new PublicationError(CODES.TARGET_NOT_VERIFIED, err.message);
        throw new PublicationError(CODES.PROTOCOL, err.message);
      }
    },

    // Idempotent and keyed by generation, under the V1 writer lock.
    async appendHistory(name, record) {
      requests += 1;
      try {
        return await appendAliasHistory({ root: base, name, record });
      } catch (err) {
        if (err instanceof AliasError && err.code === 'alias-locked') throw new PublicationError(CODES.THROTTLED, err.message);
        if (err instanceof AliasError && err.code === 'history-gap') throw new PublicationError(CODES.HISTORY_INCOMPLETE, err.message);
        throw new PublicationError(CODES.PROTOCOL, `alias history ${name}#${record.generation}: ${err.code ?? err.message}`);
      }
    },

    async readHistory(name) {
      requests += 1;
      // A missing log is an empty history; any other read error is an error.
      const text = await readFile(join(base, 'aliases', `${name}.history.jsonl`), 'utf8').catch((err) => (err.code === 'ENOENT' ? '' : Promise.reject(new PublicationError(CODES.PROTOCOL, `alias history ${name}: ${err.code}`))));
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },

    async listAliases() {
      requests += 1;
      return (await readdir(join(base, 'aliases')).catch(() => [])).filter((f) => /^[a-z0-9][a-z0-9-]*\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
    },

    async writeReceipt(receipt) {
      requests += 1;
      const dest = join(base, 'receipts', 'v2', `${receipt.receiptId}.json`);
      if (!(await createExclusive(dest, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)))) throw new PublicationError(CODES.RECEIPT_FAILED, `receipt ${receipt.receiptId} already exists`);
    },
  };
}
