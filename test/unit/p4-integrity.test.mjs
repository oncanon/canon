import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '../../src/canonical-json.mjs';
import { sha256Hex } from '../../src/hash.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { copyPacket, FIXTURE, runCli, treeDigest } from '../helpers.mjs';

let golden;
let work;
test.before(async () => {
  work = await mkdtemp(join(tmpdir(), 'canon-p4-'));
  golden = join(work, 'golden');
  await buildPacket({ reportPath: FIXTURE, outDir: golden });
});
test.after(() => rm(work, { recursive: true, force: true }));

let n = 0;
async function mutated(mutate) {
  n += 1;
  const dir = await copyPacket(golden, join(work, `case-${n}`));
  await mutate(dir);
  return dir;
}

// Rewrite manifest.json (and checksums.json) canonically with a recomputed content
// ID, so the only defect left is the one the case introduces.
async function rewriteManifest(dir, edit) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  edit(manifest);
  delete manifest.contentId;
  manifest.contentId = `sha256-${sha256Hex(Buffer.from(canonicalize(manifest)))}`;
  const bytes = Buffer.from(canonicalize(manifest));
  await writeFile(join(dir, 'manifest.json'), bytes);
  const checksums = JSON.parse(await readFile(join(dir, 'checksums.json'), 'utf8'));
  checksums.contentId = manifest.contentId;
  checksums.manifestSha256 = sha256Hex(bytes);
  await writeFile(join(dir, 'checksums.json'), canonicalize(checksums));
}

async function expectRejected(dir, code) {
  const before = await treeDigest(dir);
  const result = await verifyPacket(dir);
  const after = await treeDigest(dir);
  assert.equal(result.ok, false, `${code}: verifier accepted a defective packet`);
  assert.ok(result.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(result.errors.map((e) => e.code))}`);
  assert.deepEqual(after, before, 'verifier must not modify (repair) the packet');
  const cli = runCli(['verify', dir]);
  assert.equal(cli.status, 1, 'CLI exits non-zero');
  return result;
}

test('[P4] golden packet verifies (control for the rejection cases)', async () => {
  const r = await verifyPacket(golden);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(runCli(['verify', golden]).status, 0);
});

test('[P4] a single tampered byte is rejected', async () => {
  const dir = await mutated(async (d) => {
    const p = join(d, 'index.html');
    const b = await readFile(p);
    b[200] ^= 0x01;
    await writeFile(p, b);
  });
  await expectRejected(dir, 'checksum');
});

test('[P4] a missing file is rejected', async () => {
  const dir = await mutated(async (d) => {
    const m = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8'));
    await unlink(join(d, m.files.find((f) => f.role === 'evidence').path));
  });
  await expectRejected(dir, 'missing-file');
});

test('[P4] an extra file is rejected', async () => {
  await expectRejected(await mutated((d) => writeFile(join(d, 'notes.txt'), 'extra')), 'extra-file');
  await expectRejected(await mutated((d) => writeFile(join(d, 'assets', `${'0'.repeat(64)}.css`), 'body{}')), 'extra-file');
});

test('[P4] manifest/checksums disagreement is rejected', async () => {
  const dir = await mutated(async (d) => {
    const c = JSON.parse(await readFile(join(d, 'checksums.json'), 'utf8'));
    c.files['index.html'] = '0'.repeat(64);
    await writeFile(join(d, 'checksums.json'), canonicalize(c));
  });
  await expectRejected(dir, 'checksums-disagree');
});

test('[P4] an edited manifest no longer matches its content ID', async () => {
  const dir = await mutated(async (d) => {
    const m = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8'));
    m.report.title = 'Edited title';
    await writeFile(join(d, 'manifest.json'), canonicalize(m));
  });
  await expectRejected(dir, 'content-id');
});

test('[P4] a duplicate canonical path is rejected', async () => {
  const dir = await mutated((d) => rewriteManifest(d, (m) => { m.files.splice(1, 0, { ...m.files.find((f) => f.path === 'index.html') }); m.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))); }));
  await expectRejected(dir, 'duplicate-path');
});

test('[P4] a case-folding path collision is rejected', async () => {
  const dir = await mutated((d) => rewriteManifest(d, (m) => { m.files.unshift({ ...m.files.find((f) => f.path === 'index.html'), path: 'INDEX.html' }); }));
  await expectRejected(dir, 'path-collision');
});

test('[P4] a Unicode NFC/NFD path collision is rejected', async () => {
  const nfc = 'evidence/café.txt';
  const nfd = 'evidence/café.txt';
  const dir = await mutated((d) => rewriteManifest(d, (m) => {
    const ev = m.files.find((f) => f.role === 'evidence');
    m.files.push({ ...ev, path: nfc }, { ...ev, path: nfd });
  }));
  const r = await expectRejected(dir, 'path-collision');
  assert.ok(r.errors.some((e) => e.code === 'unicode-normalization'));
});

test('[P4] non-canonical manifest bytes are rejected', async () => {
  const dir = await mutated(async (d) => {
    const m = JSON.parse(await readFile(join(d, 'manifest.json'), 'utf8'));
    await writeFile(join(d, 'manifest.json'), JSON.stringify(m, null, 2));
  });
  await expectRejected(dir, 'not-canonical');
});

test('[P4] a symlink inside a packet is rejected, not followed', async () => {
  const dir = await mutated((d) => symlink('/etc/hosts', join(d, 'evidence', 'link.txt')));
  await expectRejected(dir, 'symlink');
});

test('[P4] a conflicting immutable publish fails closed and leaves the stored packet untouched', async () => {
  const store = join(work, 'store-conflict');
  const first = await publishPacket({ packetDir: golden, root: store });
  assert.equal(first.outcome, 'created');
  // Corrupt the stored copy, then publish the same content ID again.
  const { chmod } = await import('node:fs/promises');
  const target = join(first.target, 'index.html');
  await chmod(target, 0o644);
  await appendFile(target, '<!-- tampered -->');
  const before = await treeDigest(first.target);
  await assert.rejects(publishPacket({ packetDir: golden, root: store }), (err) => err.code === 'conflict');
  assert.deepEqual(await treeDigest(first.target), before, 'no silent repair of the stored packet');
});
