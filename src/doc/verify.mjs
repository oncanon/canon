// Independent doc-set/v1 verifier: re-derives everything from a built output directory
// alone (.well-known/canon/manifest.json, its checksums.json, and the files they
// describe) and imports nothing from src/doc/docset.mjs or either renderer. A verify
// built from the same code as the builder could not catch a mismatch between what the
// builder claims it wrote and what is actually on disk.
//
// This checks integrity and self-consistency only (every listed file matches its
// recorded hash; the manifest's identity reduces to its own edition id; nothing on disk
// is unaccounted for). It does not re-scan rendered HTML for injected markup the way
// src/packet/verify.mjs and src/site/verify.mjs do for report/v1 and site-bundle/v1:
// doc/v1's schema has no raw-HTML escape hatch (src/report/validate.mjs's
// ESCAPE_HATCHES), so there is no authored channel for that class of defect to enter
// through in the first place.
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { sha256Hex } from '../hash.mjs';
import { CHECKSUMS_SCHEMA } from '../policy.mjs';
import { DOC_SET_MANIFEST_SCHEMA } from './docset.mjs';

const MANIFEST_PATH = '.well-known/canon/manifest.json';
const CHECKSUMS_PATH = '.well-known/canon/checksums.json';

const finding = (path, code, message) => ({ path, code, message });

async function readJson(dir, relPath) {
  return JSON.parse(await readFile(join(dir, relPath), 'utf8'));
}

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push({ path: relative(base, abs), unsafe: 'symbolic links are not allowed in a doc-set output' });
    } else if (entry.isDirectory()) {
      out.push(...await walkFiles(abs, base));
    } else if (entry.isFile()) {
      out.push({ path: relative(base, abs) });
    } else {
      out.push({ path: relative(base, abs), unsafe: 'not a regular file (device, FIFO, or socket)' });
    }
  }
  return out;
}

// Verifies a built doc-set/v1 output directory against itself: manifest.json's identity
// must reduce to its own edition id, checksums.json must match manifest.json's bytes,
// every file checksums.json lists must exist with the recorded hash, and no other file
// may be present. Returns { ok, errors, contentId }, same shape as every other Canon verify.
export async function verifyDocSet(dir) {
  const root = resolve(dir);
  const errors = [];

  let manifest;
  try {
    manifest = await readJson(root, MANIFEST_PATH);
  } catch (err) {
    return { ok: false, errors: [finding(MANIFEST_PATH, 'unreadable', `${MANIFEST_PATH} is unreadable: ${err.message}`)], contentId: null };
  }
  let checksums;
  try {
    checksums = await readJson(root, CHECKSUMS_PATH);
  } catch (err) {
    return { ok: false, errors: [finding(CHECKSUMS_PATH, 'unreadable', `${CHECKSUMS_PATH} is unreadable: ${err.message}`)], contentId: manifest.edition ?? null };
  }

  if (manifest.schema !== DOC_SET_MANIFEST_SCHEMA) errors.push(finding(`${MANIFEST_PATH}#/schema`, 'schema-version', `expected "${DOC_SET_MANIFEST_SCHEMA}"`));
  if (checksums.schema !== CHECKSUMS_SCHEMA) errors.push(finding(`${CHECKSUMS_PATH}#/schema`, 'schema-version', `expected "${CHECKSUMS_SCHEMA}"`));

  const { edition, ...identity } = manifest;
  const recomputedId = `sha256-${sha256Hex(canonicalBytes(identity))}`;
  if (edition !== recomputedId) errors.push(finding(`${MANIFEST_PATH}#/edition`, 'content-id', `edition ${JSON.stringify(edition)} does not match the manifest's own identity (recomputed ${recomputedId})`));
  if (checksums.contentId !== recomputedId) errors.push(finding(`${CHECKSUMS_PATH}#/contentId`, 'content-id', `contentId ${JSON.stringify(checksums.contentId)} does not match the manifest's own identity (recomputed ${recomputedId})`));

  let manifestBytesOnDisk;
  try {
    manifestBytesOnDisk = await readFile(join(root, MANIFEST_PATH));
  } catch (err) {
    errors.push(finding(MANIFEST_PATH, 'unreadable', err.message));
    manifestBytesOnDisk = null;
  }
  if (manifestBytesOnDisk) {
    const manifestSha256 = sha256Hex(manifestBytesOnDisk);
    if (checksums.manifestSha256 !== manifestSha256) errors.push(finding(`${CHECKSUMS_PATH}#/manifestSha256`, 'digest', `recorded ${checksums.manifestSha256}, actual ${manifestSha256}`));
  }

  const listed = isPlainRecord(checksums.files) ? checksums.files : {};
  if (!isPlainRecord(checksums.files)) errors.push(finding(`${CHECKSUMS_PATH}#/files`, 'type', 'expected an object of path -> sha256'));
  for (const [path, want] of Object.entries(listed)) {
    let have;
    try {
      have = sha256Hex(await readFile(join(root, path)));
    } catch (err) {
      errors.push(finding(path, 'missing', `listed in checksums.json but unreadable: ${err.message}`));
      continue;
    }
    if (have !== want) errors.push(finding(path, 'digest', `recorded ${want}, actual ${have}`));
  }

  const accounted = new Set([MANIFEST_PATH, CHECKSUMS_PATH, ...Object.keys(listed)]);
  for (const entry of await walkFiles(root)) {
    if (entry.unsafe) {
      errors.push(finding(entry.path, 'unsafe', entry.unsafe));
    } else if (!accounted.has(entry.path)) {
      errors.push(finding(entry.path, 'unlisted', 'present on disk but not in checksums.json'));
    }
  }

  return { ok: errors.length === 0, errors, contentId: manifest.edition ?? null };
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
