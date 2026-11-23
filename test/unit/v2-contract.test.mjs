// publication/v1 contract suite: the same scenarios against the fs adapter and the
// mock Cloudflare adapter, one test per proof-matrix row and adapter
// (docs/v2/architecture.md §7). Each row also records its provider-evidence cell,
// which in this phase is always NOT_EXECUTED (provider evidence required) or n/a.
// The runtime no-network guard is installed before anything else runs.
import { attempts as networkAttempts } from '../v2/no-network.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { readAlias as readV1Alias } from '../../src/alias/alias.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { CODES } from '../../src/publication/errors.mjs';
import { objectKey, promote, publish, reconcile, rollback } from '../../src/publication/protocol.mjs';
import { secretProblems } from '../../src/publication/receipts.mjs';
import { validate } from '../../src/publication/schemas.mjs';
import { sha256Hex } from '../../src/hash.mjs';
import { allReceipts, GRANTS, harness, KINDS, syntheticPacket } from '../v2/harness.mjs';
import { lockReleased } from '../v2/lock-wait.mjs';

const PROVIDER = {
  'V2-1': 'n/a',
  'V2-2': 'NOT_EXECUTED (provider evidence required): R2 binding onlyIf under real concurrency',
  'V2-3': 'NOT_EXECUTED (provider evidence required): real R2 checksum-mismatch errors',
  'V2-4': 'NOT_EXECUTED (provider evidence required): D1 UPDATE-WHERE under real contention',
  'V2-5': 'NOT_EXECUTED (provider evidence required): rollback against real stores',
  'V2-6': 'NOT_EXECUTED (provider evidence required): real throttling, timeouts and credential expiry',
  'V2-7': 'NOT_EXECUTED (provider evidence required): headers as served by the real Worker',
  'V2-8': 'NOT_EXECUTED (provider evidence required): real Access enforcement',
  'V2-9': 'NOT_EXECUTED (provider evidence required): receipts from real provider runs',
  'V2-10': 'NOT_EXECUTED (provider evidence required): real billing against the ceiling',
  'V2-12': 'n/a',
};
const record = (t, row, kind, extra = {}) => t.diagnostic(`v2-row ${JSON.stringify({ row, adapter: kind, provider: PROVIDER[row], ...extra })}`);
const expectCode = async (promise, code) => assert.rejects(promise, (e) => e.code === code || (console.error(e), false));

for (const kind of KINDS) {
  test(`[V2-1] ${kind}: conforms to publication/v1 (publish, idempotent republish, promote, reconcile) with receipts`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    const first = await publish({ ...h.opts(), packetDir: p.dir });
    assert.equal(first.state, 'READBACK_VERIFIED');
    assert.ok(first.receipt.objects.every((o) => o.outcome === 'created'));
    assert.equal(first.receipt.objects.at(-1).key, objectKey(p.contentId, 'manifest.json'), 'manifest.json is written last');
    const again = await publish({ ...h.opts(), packetDir: p.dir });
    assert.ok(again.receipt.objects.every((o) => o.outcome === 'identical'), 'republish is idempotent');
    const moved = await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    assert.equal(moved.record.generation, 1);
    assert.equal((await h.adapter.readAlias('review')).contentId, p.contentId);
    assert.equal((await reconcile(h.opts())).state, 'RECONCILED');
    if (kind === 'fs') {
      // The V1 store view: a verified packet directory and a V1 alias record.
      const packetDir = join(h.target.root, 'packets', p.contentId);
      assert.equal((await verifyPacket(packetDir)).ok, true, 'V1 verify accepts the adapter-written packet');
      assert.equal((await readV1Alias(h.target.root, 'review')).contentId, p.contentId, 'V1 alias reader sees the promotion');
      assert.equal((await publishPacket({ packetDir: p.dir, root: h.target.root })).outcome, 'already-present', 'V1 publish of the same packet is idempotent against it');
      assert.deepEqual((await readdir(join(h.target.root, '.uploads'))).filter((n) => n !== '.tmp'), [], 'no staged upload left after commit');
    }
    record(t, 'V2-1', kind);
  });

  test(`[V2-2] ${kind}: putIfAbsent returns created, identical or conflict and never overwrites`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    await publish({ ...h.opts(), packetDir: p.dir });
    const key = objectKey(p.contentId, 'report.md');
    const original = await h.adapter.getObject(key);
    const req = (bytes) => ({ key, sha256: sha256Hex(bytes), bytes: bytes.length, contentType: 'text/markdown; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' });
    assert.equal((await h.adapter.putIfAbsent(req(original), original)).outcome, 'identical');
    const other = Buffer.from('different bytes under the same key');
    const conflict = await h.adapter.putIfAbsent(req(other), other);
    assert.equal(conflict.outcome, 'conflict');
    assert.deepEqual(await h.adapter.getObject(key), original, 'the stored object is unchanged after a conflicting put');
    await expectCode(h.adapter.putIfAbsent({ ...req(other), sha256: sha256Hex(Buffer.from('lie')) }, other), CODES.BAD_DIGEST);
    record(t, 'V2-2', kind);
  });

  test(`[V2-3] ${kind}: a read-back mismatch blocks promotion`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    h.inject({ corruptReads: 1 });
    const err = await publish({ ...h.opts(), packetDir: p.dir }).then(() => null, (e) => e);
    assert.equal(err?.code, CODES.READBACK_MISMATCH);
    assert.equal(err.details.state, 'READBACK_MISMATCH');
    h.inject({ corruptReads: 1 });
    await expectCode(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), CODES.TARGET_NOT_VERIFIED);
    assert.equal(await h.adapter.readAlias('review'), null, 'no alias points at an unverified packet');
    record(t, 'V2-3', kind);
  });

  test(`[V2-4] ${kind}: concurrent promoters with the same generation have exactly one winner and complete history`, async (t) => {
    const h = await harness(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    await publish({ ...h.opts(), packetDir: a.dir });
    await publish({ ...h.opts(), packetDir: b.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    // On fs, writers serialize on the V1 lock file, and a writer that finds it held gets
    // `throttled` and retries. The harness's retry sleep is a no-op for speed, which
    // could exhaust the attempts while another writer still holds the lock. Here the
    // backoff waits for the lock to be released instead: each loser can then collide
    // at most twice (with the winner and the other loser), within the four attempts.
    // The wait is on the release itself (test/v2/lock-wait.mjs), never a count of
    // event-loop turns: that bound broke the baseline under load (the R81 flake).
    const retry = { sleep: async () => { if (kind === 'fs') await lockReleased(join(h.target.root, 'aliases', 'review.lock')); } };
    const results = await Promise.allSettled([
      promote({ ...h.opts({ retry }), alias: 'review', contentId: b.contentId, expectGeneration: 1 }),
      promote({ ...h.opts({ retry }), alias: 'review', contentId: a.contentId, expectGeneration: 1 }),
      promote({ ...h.opts({ retry }), alias: 'review', contentId: b.contentId, expectGeneration: 1 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, 'exactly one promoter wins');
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === CODES.ALIAS_CONFLICT && r.reason.details.currentGeneration === 2));
    const history = await h.adapter.readHistory('review');
    assert.deepEqual(history.map((r) => r.generation), [1, 2], 'history is dense and complete');
    assert.equal((await h.adapter.readAlias('review')).generation, 2);
    record(t, 'V2-4', kind);
  });

  test(`[V2-5] ${kind}: rollback moves the alias forward to an earlier verified ID and deletes nothing`, async (t) => {
    const h = await harness(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    const c = await syntheticPacket(h.dir, 'c');
    for (const p of [a, b, c]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    await promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 });
    const back = await rollback({ ...h.opts(), alias: 'review', to: a.contentId, expectGeneration: 2 });
    assert.equal(back.record.generation, 3, 'rollback increases the generation');
    assert.equal(back.record.contentId, a.contentId);
    for (const p of [a, b]) assert.ok(await h.adapter.getObject(objectKey(p.contentId, 'manifest.json')), `${p.contentId} is still present`);
    await expectCode(rollback({ ...h.opts(), alias: 'review', to: c.contentId, expectGeneration: 3 }), CODES.TARGET_NOT_VERIFIED); // never a generation of this alias
    await expectCode(rollback({ ...h.opts(), alias: 'review', to: `sha256-${'0'.repeat(64)}`, expectGeneration: 3 }), CODES.TARGET_NOT_VERIFIED); // missing
    assert.equal((await h.adapter.readAlias('review')).generation, 3);
    assert.equal(typeof h.adapter.deleteObject, 'undefined');
    record(t, 'V2-5', kind);
  });

  test(`[V2-6] ${kind}: every injected fault ends in its specified state and recovers`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    const faults = {};
    // Partial upload: stops PARTIAL; a rerun completes, reusing what landed.
    h.inject({ failPutsAfter: 3 });
    const partial = await publish({ ...h.opts(), packetDir: p.dir }).then(() => null, (e) => e);
    assert.equal(partial?.details.state, 'PARTIAL');
    const resumed = await publish({ ...h.opts(), packetDir: p.dir });
    assert.deepEqual(resumed.receipt.objects.slice(0, 3).map((o) => o.outcome), ['identical', 'identical', 'identical']);
    faults.partialUpload = 'PARTIAL -> resumed READBACK_VERIFIED';
    // Throttling and timeouts: bounded retry succeeds; exhausting it fails cleanly.
    h.inject({ throttle: 2 });
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED');
    h.inject({ timeout: 2 });
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED');
    h.inject({ throttle: 50 });
    await expectCode(publish({ ...h.opts(), packetDir: p.dir }), CODES.THROTTLED);
    h.inject({ throttle: 0 });
    faults.throttle = 'retried; THROTTLED when exhausted';
    faults.timeout = 'retried';
    // Stale read: a promoter acting on an old alias record loses the CAS and re-decides.
    const b = await syntheticPacket(h.dir, 'b');
    await publish({ ...h.opts(), packetDir: b.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    await promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 });
    h.inject({ staleAliasReads: 1 });
    const stale = await h.adapter.readAlias('review');
    assert.equal(stale.generation, 1, 'the injected stale read returns the old record');
    const lost = await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: stale.generation }).then(() => null, (e) => e);
    assert.equal(lost?.code, CODES.ALIAS_CONFLICT);
    const fresh = await h.adapter.readAlias('review');
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: fresh.generation })).record.generation, 3);
    faults.staleRead = 'ALIAS_CONFLICT, then re-read and promote';
    // Receipt-write failure: the intent receipt fails, so the alias does not move.
    h.inject({ failReceipts: 1 });
    await expectCode(promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 3 }), CODES.RECEIPT_FAILED);
    assert.equal((await h.adapter.readAlias('review')).generation, 3, 'no promotion without a receipt');
    faults.receiptWrite = 'RECEIPT_FAILED, alias unchanged';
    // Credential expiry mid-publish: stops CREDENTIAL_EXPIRED; resumes after renewal.
    if (h.expireCredential) {
      const c = await syntheticPacket(h.dir, 'c');
      h.inject({ expireAfterRequests: 4 });
      const expired = await publish({ ...h.opts(), packetDir: c.dir }).then(() => null, (e) => e);
      assert.equal(expired?.code, CODES.CREDENTIAL_EXPIRED);
      h.renewCredential();
      assert.equal((await publish({ ...h.opts(), packetDir: c.dir })).state, 'READBACK_VERIFIED');
      faults.credentialExpiry = 'CREDENTIAL_EXPIRED, resumed after renewal';
    } else {
      faults.credentialExpiry = 'NOT_APPLICABLE (fs has no credential)';
    }
    record(t, 'V2-6', kind, { faults });
  });

  test(`[V2-7] ${kind}: served headers and content types match V1 (text/markdown, CSP, nosniff; HEAD, Range, 304)`, async (t) => {
    const h = await harness(kind, t);
    if (kind === 'fs') {
      // The fs target is served by the V1 server, whose headers are checked by the
      // V1 route tests ([P7]) and the README gate ([E9]) against a live server.
      record(t, 'V2-7', kind, { note: 'served by the V1 server: covered by [P7] and [E9] route/header tests' });
      return;
    }
    const p = await syntheticPacket(h.dir);
    await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    const get = (path, headers = {}, method = 'GET') => h.endpoint.handle({ method, path, headers, body: null });
    const md = await get(`/p/${p.contentId}/report.md`);
    assert.equal(md.status, 200);
    assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.match(md.headers['content-security-policy'], /default-src 'none'.*script-src 'none'.*frame-ancestors 'none'/);
    assert.equal(md.headers['x-content-type-options'], 'nosniff');
    assert.equal(md.headers['referrer-policy'], 'no-referrer');
    assert.equal(md.headers['cache-control'], 'public, max-age=31536000, immutable');
    const head = await get(`/p/${p.contentId}/report.md`, {}, 'HEAD');
    assert.equal(head.body.length, 0);
    const range = await get(`/p/${p.contentId}/report.md`, { range: 'bytes=0-9' });
    assert.equal(range.status, 206);
    assert.equal(range.body.length, 10);
    assert.equal((await get(`/p/${p.contentId}/report.md`, { range: 'bytes=999999-' })).status, 416);
    assert.equal((await get(`/p/${p.contentId}/report.md`, { 'if-none-match': md.headers.etag })).status, 304);
    const alias = await get('/a/review/report.md');
    assert.equal(alias.status, 307);
    assert.equal(alias.headers.location, `/p/${p.contentId}/report.md`);
    assert.equal(alias.headers['cache-control'], 'no-store');
    const sha = sha256Hex(await h.adapter.getObject(objectKey(p.contentId, 'report.md')));
    assert.equal(md.headers.etag, `"${sha}"`, 'the Worker sets ETag to the SHA-256');
    record(t, 'V2-7', kind);
  });

  test(`[V2-8] ${kind}: classification, access mode and synthetic-only refusals`, async (t) => {
    const h = await harness(kind, t);
    const confidential = await syntheticPacket(h.dir, 'conf', { classification: 'confidential', dataOrigin: 'synthetic' });
    assert.equal((await publish({ ...h.opts(), packetDir: confidential.dir })).state, 'READBACK_VERIFIED', 'confidential is allowed on an access-controlled target');
    const production = await syntheticPacket(h.dir, 'prod', { classification: 'private-review', dataOrigin: 'production' });
    const v1 = await syntheticPacket(h.dir, 'v1', null);
    if (kind === 'fs') {
      assert.equal((await publish({ ...h.opts(), packetDir: v1.dir })).state, 'READBACK_VERIFIED', 'the local V1 target takes any packet');
    } else {
      await expectCode(publish({ ...h.opts(), packetDir: production.dir }), CODES.SYNTHETIC_ONLY);
      await expectCode(publish({ ...h.opts(), packetDir: v1.dir }), CODES.SYNTHETIC_ONLY);
      const pub = { ...h.target, accessMode: 'public' };
      await expectCode(publish({ ...h.opts(), target: pub, packetDir: confidential.dir }), CODES.NOT_AVAILABLE);
    }
    record(t, 'V2-8', kind);
  });

  test(`[V2-9] ${kind}: receipts are receipt/v2, secret-free and append-only`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    const pub = await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    const receipts = await allReceipts(h);
    assert.ok(receipts.length >= 3, 'publish, promote intent and promote result');
    for (const r of receipts) {
      assert.deepEqual(validate('receipt/v2', r), [], r.receiptId);
      assert.deepEqual(secretProblems(r, h.secret ? [h.secret] : []), [], `${r.receiptId} carries no secret`);
    }
    await expectCode(h.adapter.writeReceipt(pub.receipt), CODES.RECEIPT_FAILED);
    record(t, 'V2-9', kind, { receipts: receipts.length });
  });

  test(`[V2-10] ${kind}: the cost ledger refuses above the ceiling before any request`, async (t) => {
    const h = await harness(kind, t, { ceiling: 0 });
    const p = await syntheticPacket(h.dir);
    if (kind === 'fs') {
      assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED', 'fs costs nothing');
    } else {
      const before = h.adapter.requestCount();
      await expectCode(publish({ ...h.opts(), packetDir: p.dir }), CODES.COST_CEILING);
      assert.equal(h.adapter.requestCount(), before, 'no request reached the provider');
    }
    const h2 = await harness(kind, t, { ceiling: 100 });
    const p2 = await syntheticPacket(h2.dir);
    await publish({ ...h2.opts(), packetDir: p2.dir });
    const ledger = await import('../../src/publication/policy.mjs').then((m) => m.monthToDate(h2.target, h2.clock()));
    assert.ok(kind === 'fs' ? ledger === 0 : ledger > 0, `ledger month-to-date ${ledger}`);
    record(t, 'V2-10', kind);
  });

  test(`[V2-12] ${kind}: no provider call without its grant; no delete, DNS or public-exposure path`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    const before = h.adapter.requestCount();
    if (kind === 'fs') {
      assert.equal((await publish({ ...h.opts(), grants: new Set(), packetDir: p.dir })).state, 'READBACK_VERIFIED', 'local fs publish is V1 behaviour and needs no grant');
    } else {
      await expectCode(publish({ ...h.opts(), grants: new Set(), packetDir: p.dir }), CODES.GRANT_MISSING);
      await expectCode(publish({ ...h.opts(), grants: new Set(['promote']), packetDir: p.dir }), CODES.GRANT_MISSING);
      assert.equal(h.adapter.requestCount(), before, 'refusals make no provider request');
      await publish({ ...h.opts(), grants: new Set(['upload']), packetDir: p.dir });
    }
    await expectCode(promote({ ...h.opts(), grants: new Set(['upload']), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), CODES.GRANT_MISSING);
    await expectCode(reconcile({ ...h.opts(), grants: new Set(['upload']) }), CODES.GRANT_MISSING);
    for (const real of ['cloudflare']) await expectCode(publish({ ...h.opts(), target: { ...h.target, kind: real }, packetDir: p.dir }), CODES.NOT_AVAILABLE);
    const methods = Object.keys(h.adapter);
    assert.deepEqual(methods.filter((m) => /delete|remove|purge|invalidat|dns|domain/i.test(m)), [], 'no destructive or DNS method on the adapter');
    record(t, 'V2-12', kind, { grantsChecked: [...GRANTS] });
  });
}

test('[V2-12] runtime guard: the contract suite made zero network calls (and the guard is watched blocking one)', (t) => {
  const before = networkAttempts.length;
  assert.throws(() => net.connect(9, '127.0.0.1'), { code: 'ERR_V2_NETWORK_BLOCKED' }, 'the guard blocks a connect');
  assert.throws(() => fetch('https://example.invalid/'), { code: 'ERR_V2_NETWORK_BLOCKED' }, 'the guard blocks fetch');
  assert.equal(networkAttempts.length, before + 2, 'the guard records blocked attempts');
  assert.deepEqual(networkAttempts.slice(0, before), [], 'no network attempt was made by the contract suite');
  t.diagnostic(`v2-network ${JSON.stringify({ suiteAttempts: before, guardSelfTest: 2 })}`);
});
