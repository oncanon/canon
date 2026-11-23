// doc-set/v1 verify: independently re-derives a built output directory's integrity
// without importing the builder or either renderer (src/doc/verify.mjs's own header).
// Every tamper case starts from a real build (buildDocSet) and damages exactly one
// thing, so each assertion is about that one thing, not an artificial fixture.
import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildDocSet } from '../../src/doc/docset.mjs';
import { verifyDocSet } from '../../src/doc/verify.mjs';
import { REPO, tempDir } from '../helpers.mjs';

const MINIMAL_MANIFEST = join(REPO, 'fixtures/doc-set/minimal/manifest.doc-set.json');

async function builtOutput(t) {
  const outDir = join(await tempDir(t, 'canon-docset-verify'), 'out');
  const built = await buildDocSet({ manifestPath: MINIMAL_MANIFEST, outDir });
  return { outDir, built };
}

test('[DOC-VERIFY] a fresh build verifies clean', async (t) => {
  const { outDir, built } = await builtOutput(t);
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.contentId, built.edition);
});

test('[DOC-VERIFY] a tampered page file fails with its own digest mismatch, not a false pass', async (t) => {
  const { outDir } = await builtOutput(t);
  const target = join(outDir, 'a/index.html');
  await writeFile(target, (await readFile(target, 'utf8')).replace('Page A', 'Page A, tampered'));
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'a/index.html' && e.code === 'digest'));
});

test('[DOC-VERIFY] a hand-edited edition id no longer matches the manifest\'s own recomputed identity', async (t) => {
  const { outDir } = await builtOutput(t);
  const manifestPath = join(outDir, '.well-known/canon/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.edition = `sha256-${'0'.repeat(64)}`;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'content-id' && e.path.includes('manifest.json')));
});

test('[DOC-VERIFY] a file present on disk but missing from checksums.json is caught, not silently allowed', async (t) => {
  const { outDir } = await builtOutput(t);
  await writeFile(join(outDir, 'a/extra.html'), '<p>not in the manifest</p>');
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'a/extra.html' && e.code === 'unlisted'));
});

test('[DOC-VERIFY] a file checksums.json lists but that is missing from disk is caught', async (t) => {
  const { outDir } = await builtOutput(t);
  await rm(join(outDir, 'b/index.md'));
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'b/index.md' && e.code === 'missing'));
});

test('[DOC-VERIFY] a symbolic link anywhere in the output is refused, even if it points at a valid file', async (t) => {
  const { outDir } = await builtOutput(t);
  await symlink(join(outDir, 'a/index.html'), join(outDir, 'a/link.html'));
  const result = await verifyDocSet(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'a/link.html' && e.code === 'unsafe'));
});
