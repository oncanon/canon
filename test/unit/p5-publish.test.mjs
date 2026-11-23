import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { copyPacket, exists, FIXTURE, REPO, runCli, tempDir, treeDigest } from '../helpers.mjs';

test('[P5] publish creates <root>/packets/<content-id>/ and read-back matches the build receipt', async (t) => {
  const dir = await tempDir(t, 'canon-p5');
  const pkt = join(dir, 'pkt');
  const build = runCli(['build', FIXTURE, '--out', pkt, '--receipt', join(dir, 'build.json')]);
  assert.equal(build.status, 0, build.stderr);
  const buildReceipt = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8'));
  const pub = runCli(['publish', pkt, '--root', join(dir, 'store'), '--build-receipt', join(dir, 'build.json'), '--receipt', join(dir, 'publish.json')]);
  assert.equal(pub.status, 0, pub.stderr);
  const receipt = JSON.parse(await readFile(join(dir, 'publish.json'), 'utf8'));
  assert.equal(receipt.outcome, 'created');
  assert.equal(receipt.destination.path, join(dir, 'store', 'packets', buildReceipt.contentId));
  assert.deepEqual(receipt.readBack, { verified: true, manifestSha256: buildReceipt.manifestSha256, matchesSource: true, matchesBuildReceipt: true });
  assert.equal(receipt.fileCount, buildReceipt.fileCount);
  assert.equal(receipt.totalBytes, buildReceipt.totalBytes);
  assert.deepEqual(await treeDigest(join(dir, 'store/packets', buildReceipt.contentId)), await treeDigest(pkt), 'published bytes identical to built bytes');
  assert.deepEqual(await readdir(join(dir, 'store/.staging')), [], 'no staging residue');
  const mode = (await stat(join(dir, 'store/packets', buildReceipt.contentId, 'index.html'))).mode & 0o777;
  assert.equal(mode, 0o444, 'published files are read-only');
});

test('[P5] identical republish is idempotent and changes nothing', async (t) => {
  const dir = await tempDir(t, 'canon-p5b');
  const pkt = join(dir, 'pkt');
  await buildPacket({ reportPath: FIXTURE, outDir: pkt });
  const store = join(dir, 'store');
  const a = await publishPacket({ packetDir: pkt, root: store });
  const before = await treeDigest(a.target);
  const beforeMtime = (await stat(join(a.target, 'index.html'))).mtimeMs;
  const b = await publishPacket({ packetDir: pkt, root: store });
  assert.equal(a.outcome, 'created');
  assert.equal(b.outcome, 'already-present');
  assert.equal(b.contentId, a.contentId);
  assert.deepEqual(await treeDigest(a.target), before);
  assert.equal((await stat(join(a.target, 'index.html'))).mtimeMs, beforeMtime, 'existing packet not rewritten');
});

test('[P5] a receipt that does not match the packet is refused before anything is written', async (t) => {
  const dir = await tempDir(t, 'canon-p5c');
  const pkt = join(dir, 'pkt');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: pkt });
  await assert.rejects(
    publishPacket({ packetDir: pkt, root: join(dir, 'store'), expectedBuild: { contentId: built.contentId, manifestSha256: '0'.repeat(64) } }),
    (err) => err.code === 'receipt-mismatch',
  );
  assert.equal(await exists(join(dir, 'store/packets', built.contentId)), false);
});

test('[P5] a source packet that fails verification is never published', async (t) => {
  const dir = await tempDir(t, 'canon-p5d');
  const pkt = join(dir, 'pkt');
  await buildPacket({ reportPath: FIXTURE, outDir: pkt });
  const bad = await copyPacket(pkt, join(dir, 'bad'));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(bad, 'index.html'), ' ');
  await assert.rejects(publishPacket({ packetDir: bad, root: join(dir, 'store') }), (err) => err.code === 'source-invalid');
  assert.equal(await exists(join(dir, 'store/packets')), false);
});

test('[P5] concurrent publishers of the same packet: exactly one creates, the rest are idempotent', async (t) => {
  const dir = await tempDir(t, 'canon-p5e');
  const pkt = join(dir, 'pkt');
  await buildPacket({ reportPath: FIXTURE, outDir: pkt });
  const store = join(dir, 'store');
  const child = join(REPO, 'test/support/publish-child.mjs');
  const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [child, pkt, store]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, ...JSON.parse(out.trim()) }));
  })));
  assert.ok(runs.every((r) => r.code === 0), JSON.stringify(runs));
  assert.equal(runs.filter((r) => r.outcome === 'created').length, 1, JSON.stringify(runs));
  assert.equal(runs.filter((r) => r.outcome === 'already-present').length, 5);
  assert.deepEqual(await readdir(join(store, '.staging')), []);
  assert.deepEqual(await treeDigest(join(store, 'packets', runs[0].contentId)), await treeDigest(pkt));
});
