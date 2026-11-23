import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readAlias, setAlias } from '../../src/alias/alias.mjs';
import { buildPacket, DEFAULT_STYLESHEET } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { FIXTURE, REPO, tempDir, treeDigest } from '../helpers.mjs';

async function twoPublishedPackets(t) {
  const dir = await tempDir(t, 'canon-p6');
  const store = join(dir, 'store');
  const a = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'a') });
  const css = Buffer.concat([await readFile(DEFAULT_STYLESHEET), Buffer.from('\n/* variant b */\n')]);
  const b = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'b'), stylesheetBytes: css });
  await publishPacket({ packetDir: join(dir, 'a'), root: store });
  await publishPacket({ packetDir: join(dir, 'b'), root: store });
  return { dir, store, a: a.contentId, b: b.contentId };
}

test('[P6] alias record lives at <root>/aliases/<name>.json, separate from packets, and holds only a content ID', async (t) => {
  const { store, a } = await twoPublishedPackets(t);
  const packetsBefore = await treeDigest(join(store, 'packets'));
  const rec = await setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 });
  assert.deepEqual(rec, { schema: 'alias/v1', name: 'review', contentId: a, generation: 1, previousContentId: null });
  const onDisk = JSON.parse(await readFile(join(store, 'aliases', 'review.json'), 'utf8'));
  assert.deepEqual(onDisk, rec);
  assert.deepEqual(await treeDigest(join(store, 'packets')), packetsBefore, 'alias write never touches packet bytes');
  assert.deepEqual((await readdir(join(store, 'aliases'))).sort(), ['review.history.jsonl', 'review.json']);
});

test('[P6] compare-and-swap: correct generation updates, stale generation fails without writing', async (t) => {
  const { store, a, b } = await twoPublishedPackets(t);
  await setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 });
  const updated = await setAlias({ root: store, name: 'review', contentId: b, expectGeneration: 1 });
  assert.equal(updated.generation, 2);
  assert.equal(updated.previousContentId, a);
  await assert.rejects(setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 1 }), (e) => e.code === 'generation-conflict');
  await assert.rejects(setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 }), (e) => e.code === 'generation-conflict');
  assert.equal((await readAlias(store, 'review')).contentId, b);
  const history = (await readFile(join(store, 'aliases/review.history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(history.map((h) => [h.generation, h.contentId]), [[1, a], [2, b]]);
});

test('[P6] concurrent writers with the same expectation: exactly one wins', async (t) => {
  const { store, a, b } = await twoPublishedPackets(t);
  await setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 });
  const child = join(REPO, 'test/support/alias-child.mjs');
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [child, store, 'review', b, '1']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(JSON.parse(out.trim())));
  })));
  const winners = runs.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(runs));
  // Losers must lose on the generation check itself, not merely on lock contention.
  assert.ok(runs.filter((r) => !r.ok).every((r) => r.code === 'generation-conflict'), JSON.stringify(runs));
  const final = await readAlias(store, 'review');
  assert.equal(final.generation, 2);
  assert.deepEqual((await readdir(join(store, 'aliases'))).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
});

test('[P6] a left-behind lock fails closed; aliases cannot point at unpublished or malformed IDs', async (t) => {
  const { store, a } = await twoPublishedPackets(t);
  await setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 });
  await writeFile(join(store, 'aliases', 'review.lock'), '99999\n');
  await assert.rejects(setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 1 }), (e) => e.code === 'alias-locked');
  await assert.rejects(setAlias({ root: store, name: 'other', contentId: `sha256-${'a'.repeat(64)}`, expectGeneration: 0 }), (e) => e.code === 'target-not-published');
  await assert.rejects(setAlias({ root: store, name: 'other', contentId: '../../etc', expectGeneration: 0 }), (e) => e.code === 'invalid-content-id');
  await assert.rejects(setAlias({ root: store, name: '../x', contentId: a, expectGeneration: 0 }), (e) => e.code === 'invalid-alias-name');
});

test('[P6] served alias responses are no-store redirects; fingerprinted packet bytes are immutable; alias change moves to new asset URLs', async (t) => {
  const { store, a, b } = await twoPublishedPackets(t);
  await setAlias({ root: store, name: 'review', contentId: a, expectGeneration: 0 });
  const { server, url } = await startServer({ root: store });
  t.after(() => server.close());
  const r1 = await fetch(`${url}/a/review/`, { redirect: 'manual' });
  assert.equal(r1.status, 307);
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  assert.equal(r1.headers.get('location'), `/p/${a}/`);
  const rj = await fetch(`${url}/a/review.json`);
  assert.equal(rj.headers.get('cache-control'), 'no-store');
  const indexA = await (await fetch(`${url}/p/${a}/`)).text();
  const cssA = indexA.match(/href="(assets\/[0-9a-f]{64}\.css)"/)[1];
  const assetA = await fetch(`${url}/p/${a}/${cssA}`);
  assert.equal(assetA.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await setAlias({ root: store, name: 'review', contentId: b, expectGeneration: 1 });
  const r2 = await fetch(`${url}/a/review/`, { redirect: 'manual' });
  assert.equal(r2.headers.get('location'), `/p/${b}/`);
  const indexB = await (await fetch(`${url}/p/${b}/`)).text();
  const cssB = indexB.match(/href="(assets\/[0-9a-f]{64}\.css)"/)[1];
  assert.notEqual(cssB, cssA, 'new packet references a different fingerprinted asset URL');
  assert.equal((await fetch(`${url}/p/${a}/${cssA}`)).status, 200, 'old immutable asset still served unchanged');
});
