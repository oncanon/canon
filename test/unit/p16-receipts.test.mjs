import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { FIXTURE, runCli, tempDir, treeDigest } from '../helpers.mjs';

const RECEIPT_KEYS = ['alias', 'contentId', 'destination', 'durationMs', 'errorClass', 'fileCount', 'finishedAt', 'manifestSha256', 'operation', 'outcome', 'provider', 'readBack', 'result', 'schema', 'startedAt', 'tool, totalBytes, warnings'.split(', ')].flat().sort();
const SECRETISH = /(token|secret|password|passwd|authorization|bearer|cookie|api[_-]?key|x-amz|signature|capability|session)/i;

function assertReceiptShape(r) {
  assert.deepEqual(Object.keys(r).sort(), RECEIPT_KEYS);
  assert.equal(r.schema, 'receipt/v1');
  assert.ok(!SECRETISH.test(JSON.stringify(r)), 'receipt contains secret-like material');
  assert.ok(!/https?:\/\//.test(JSON.stringify(r)), 'receipt contains no URLs');
  assert.ok(Number.isInteger(r.durationMs) && r.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(r.startedAt)) && !Number.isNaN(Date.parse(r.finishedAt)));
}

test('[P16] build and publish receipts carry the required fields, live outside the packet, and hold no secrets', async (t) => {
  const dir = await tempDir(t, 'canon-p16');
  assert.equal(runCli(['build', FIXTURE, '--out', join(dir, 'pkt'), '--receipt', join(dir, 'receipts/build.json')]).status, 0);
  assert.equal(runCli(['publish', join(dir, 'pkt'), '--root', join(dir, 'store'), '--build-receipt', join(dir, 'receipts/build.json')]).status, 0);
  const build = JSON.parse(await readFile(join(dir, 'receipts/build.json'), 'utf8'));
  assertReceiptShape(build);
  assert.equal(build.operation, 'build');
  assert.equal(build.provider, 'local-builder');
  assert.match(build.contentId, /^sha256-[0-9a-f]{64}$/);
  assert.equal(build.result, 'success');
  assert.equal(build.fileCount, 12);
  assert.ok(build.totalBytes > 0);

  const storeReceipts = await readdir(join(dir, 'store/receipts'));
  assert.equal(storeReceipts.length, 1);
  const publish = JSON.parse(await readFile(join(dir, 'store/receipts', storeReceipts[0]), 'utf8'));
  assertReceiptShape(publish);
  assert.equal(publish.operation, 'publish');
  assert.equal(publish.provider, 'filesystem');
  assert.equal(publish.contentId, build.contentId);
  assert.equal(publish.destination.kind, 'filesystem-store');
  assert.equal(publish.readBack.verified, true);
  assert.equal(publish.readBack.matchesBuildReceipt, true);
  assert.equal(publish.manifestSha256, build.manifestSha256);

  const packetFiles = Object.keys(await treeDigest(join(dir, 'pkt')));
  assert.ok(packetFiles.every((f) => !f.includes('receipt')), 'no receipt inside the packet');
  const manifest = await readFile(join(dir, 'pkt/manifest.json'), 'utf8');
  assert.ok(!manifest.includes(dir) && !manifest.includes('receipt') && !manifest.includes(build.startedAt), 'receipt data never enters identity');
});

test('[P16] receipts do not perturb identity: different receipt paths and times give the same content ID', async (t) => {
  const dir = await tempDir(t, 'canon-p16b');
  runCli(['build', FIXTURE, '--out', join(dir, 'a'), '--receipt', join(dir, 'ra.json')]);
  await new Promise((r) => setTimeout(r, 25));
  runCli(['build', FIXTURE, '--out', join(dir, 'b'), '--receipt', join(dir, 'elsewhere/rb.json')]);
  const ra = JSON.parse(await readFile(join(dir, 'ra.json'), 'utf8'));
  const rb = JSON.parse(await readFile(join(dir, 'elsewhere/rb.json'), 'utf8'));
  assert.notEqual(ra.startedAt, rb.startedAt);
  assert.equal(ra.contentId, rb.contentId);
});

test('[P16] failures produce receipts with an error class', async (t) => {
  const dir = await tempDir(t, 'canon-p16c');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'bad.json'), '{"schema":"report/v1","html":"<b>x</b>"}');
  const r = runCli(['build', join(dir, 'bad.json'), '--out', join(dir, 'pkt'), '--receipt', join(dir, 'fail.json')]);
  assert.equal(r.status, 1);
  const receipt = JSON.parse(await readFile(join(dir, 'fail.json'), 'utf8'));
  assertReceiptShape(receipt);
  assert.equal(receipt.result, 'failure');
  assert.equal(receipt.errorClass, 'report-invalid');
  assert.equal(receipt.contentId, null);

  const other = await tempDir(t, 'canon-p16d');
  assert.equal(runCli(['build', FIXTURE, '--out', join(other, 'pkt')]).status, 0);
  const { chmod, appendFile } = await import('node:fs/promises');
  const store = join(other, 'store');
  assert.equal(runCli(['publish', join(other, 'pkt'), '--root', store]).status, 0);
  const id = (await readdir(join(store, 'packets')))[0];
  await chmod(join(store, 'packets', id, 'index.html'), 0o644);
  await appendFile(join(store, 'packets', id, 'index.html'), 'x');
  assert.equal(runCli(['publish', join(other, 'pkt'), '--root', store]).status, 1);
  const receipts = await Promise.all((await readdir(join(store, 'receipts'))).map(async (f) => JSON.parse(await readFile(join(store, 'receipts', f), 'utf8'))));
  const failed = receipts.find((x) => x.result === 'failure');
  assert.ok(failed);
  assert.equal(failed.errorClass, 'conflict');
});
