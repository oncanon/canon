// doc/v1 CLI wiring: build-docs and verify-docs, exercised as a subprocess exactly as a
// real caller would invoke them (test/helpers.mjs's runCli), not by importing the
// command functions directly.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { REPO, runCli, tempDir } from '../helpers.mjs';

const MINIMAL_MANIFEST = join(REPO, 'fixtures/doc-set/minimal/manifest.doc-set.json');
const GUIDE_MANIFEST = join(REPO, 'fixtures/doc/guide.doc-set.json');

test('[DOC-CLI] build-docs then verify-docs succeed end-to-end on a fully-resolving doc set', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  const outDir = join(dir, 'out');

  const build = runCli(['build-docs', MINIMAL_MANIFEST, '--out', outDir]);
  assert.equal(build.status, 0, build.stderr);
  const built = JSON.parse(build.stdout);
  assert.match(built.contentId, /^sha256-[0-9a-f]{64}$/);

  const verify = runCli(['verify-docs', outDir, '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  const verified = JSON.parse(verify.stdout);
  assert.equal(verified.ok, true);
  assert.equal(verified.contentId, built.contentId);

  const verifyPlain = runCli(['verify-docs', outDir]);
  assert.equal(verifyPlain.status, 0);
  assert.match(verifyPlain.stdout, /^OK sha256-[0-9a-f]{64}/);
});

test('[DOC-CLI] build-docs then verify-docs succeed end-to-end on the real Install + Quick start fixtures, with "cli"/"schemas" resolved as external pages', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  const outDir = join(dir, 'out');

  const build = runCli(['build-docs', GUIDE_MANIFEST, '--out', outDir]);
  assert.equal(build.status, 0, build.stderr);
  const built = JSON.parse(build.stdout);
  assert.match(built.contentId, /^sha256-[0-9a-f]{64}$/);

  const { readFile } = await import('node:fs/promises');
  const html = await readFile(join(outDir, 'guide/quick-start/index.md'), 'utf8');
  assert.match(html, /\[CLI reference\]\(\/cli\/\)/);

  const verify = runCli(['verify-docs', outDir, '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});

test('[DOC-CLI] build-docs exits 1 and writes a failure receipt when a ref does not resolve', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  const outDir = join(dir, 'out');
  const receiptPath = join(dir, 'build.receipt.json');
  const { writeFile, readFile } = await import('node:fs/promises');

  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }],
  }));
  await writeFile(join(dir, 'a.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'a', title: 'A', description: 'Page A.',
    sections: [{ id: 'intro', title: 'Intro', blocks: [{ type: 'paragraph', text: [{ ref: { page: 'ghost', text: 'Ghost' } }] }] }],
  }));

  const build = runCli(['build-docs', join(dir, 'manifest.doc-set.json'), '--out', outDir, '--receipt', receiptPath]);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /unknown-page/);

  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.result, 'failure');
});

test('[DOC-CLI] verify-docs exits 1 and reports findings when a built page is tampered', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  const outDir = join(dir, 'out');
  assert.equal(runCli(['build-docs', MINIMAL_MANIFEST, '--out', outDir]).status, 0);

  const { readFile, writeFile } = await import('node:fs/promises');
  const target = join(outDir, 'a/index.html');
  await writeFile(target, (await readFile(target, 'utf8')).replace('Page A', 'Page A, tampered'));

  const verify = runCli(['verify-docs', outDir, '--json']);
  assert.equal(verify.status, 1);
  const result = JSON.parse(verify.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'a/index.html' && e.code === 'digest'));
});

test('[DOC-CLI] build-docs succeeds into a --out whose parent directories do not exist yet', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  // Nested two levels below dir, neither of which exists until build-docs creates them —
  // writePacketDirectory's staging mkdir is sibling-only (recursive: false), so without
  // this, missing parents surface as a raw ENOENT instead of a built packet.
  const outDir = join(dir, 'nested', 'deeper', 'out');

  const build = runCli(['build-docs', MINIMAL_MANIFEST, '--out', outDir]);
  assert.equal(build.status, 0, build.stderr);
  const built = JSON.parse(build.stdout);
  assert.match(built.contentId, /^sha256-[0-9a-f]{64}$/);

  const verify = runCli(['verify-docs', outDir, '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});

test('[DOC-CLI] build-docs succeeds on rebuild into the same --out after the old output is removed, even with the old receipt still beside it', async (t) => {
  const dir = await tempDir(t, 'canon-doc-cli');
  const outDir = join(dir, 'out');

  const first = runCli(['build-docs', MINIMAL_MANIFEST, '--out', outDir]);
  assert.equal(first.status, 0, first.stderr);

  // Only the packet output is cleared, as the "packets are never overwritten" error
  // message implies is sufficient — the stale <out>.build-receipt.json beside it is left
  // in place, same as a user who deletes just the build output and reruns the command.
  const { rm } = await import('node:fs/promises');
  await rm(outDir, { recursive: true, force: true });

  const second = runCli(['build-docs', MINIMAL_MANIFEST, '--out', outDir]);
  assert.equal(second.status, 0, second.stderr);
  const built = JSON.parse(second.stdout);
  assert.match(built.contentId, /^sha256-[0-9a-f]{64}$/);

  const verify = runCli(['verify-docs', outDir, '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});
