// Fault matrix (slice 05; docs/v2/publication-protocol.md §4, §5): every fault class,
// injected into every adapter, as its own cell on a fresh target. Each cell asserts the
// specified state and recovery. After every cell, three invariants are checked against
// the target:
//   - no overwrite and no deletion: every immutable or append-only object present
//     before the fault is still present, byte-identical;
//   - no promotion before verified read-back: every alias points at content that
//     verifies on the target now;
//   - alias history is dense (1..g) and ends at the current record.
// Each cell reports a `v2-fault` diagnostic; a cell a target cannot have (credential
// expiry on fs) reports NOT_APPLICABLE and asserts why.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { sha256Hex } from '../../src/hash.mjs';
import { CODES } from '../../src/publication/errors.mjs';
import { CACHE_IMMUTABLE, objectKey, promote, publish, reconcile, rollback, verifyOnTarget } from '../../src/publication/protocol.mjs';
import { allReceipts, harness, KINDS, storedObjects, syntheticPacket } from '../v2/harness.mjs';
import { lockReleased } from '../v2/lock-wait.mjs';

const MISSING = `sha256-${'0'.repeat(64)}`;
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (e) => e);

async function assertInvariants(h, before) {
  const after = await storedObjects(h);
  for (const [key, fp] of before) {
    assert.ok(after.has(key), `no deletion: ${key} is still on the target`);
    assert.equal(after.get(key), fp, `no overwrite: ${key} is byte-identical`);
  }
  h.inject({ corruptReads: 0, staleAliasReads: 0, throttle: 0, timeout: 0, failReceipts: 0 });
  for (const name of await h.adapter.listAliases()) {
    const record = await h.adapter.readAlias(name);
    const check = await verifyOnTarget(h.adapter, record.contentId);
    assert.ok(check.verified, `alias ${name} points at ${record.contentId}, which verifies on the target`);
    const history = await h.adapter.readHistory(name);
    assert.deepEqual(history.map((r) => r.generation), Array.from({ length: record.generation }, (_, i) => i + 1), `alias ${name} history is dense`);
    assert.equal(history.at(-1).contentId, record.contentId, `alias ${name} history ends at the current record`);
  }
}

// On fs, writers serialize on the V1 lock file; a concurrent writer's backoff waits
// for the lock to be released (see V2-4 in v2-contract).
// The wait is on the release itself (test/v2/lock-wait.mjs), never a count of event-loop turns: that
// bound broke the baseline under load (the R112 collateral).
const lockWait = (h) => ({
  sleep: async () => { if (h.kind === 'fs') await lockReleased(join(h.target.root, 'aliases', 'review.lock')); },
});

// The result receipts an operation added, found by diffing receipt IDs around it.
async function newResults(h, run) {
  const seen = new Set((await allReceipts(h)).map((r) => r.receiptId));
  const outcome = await run().then((value) => ({ value }), (error) => ({ error }));
  const added = (await allReceipts(h)).filter((r) => !seen.has(r.receiptId) && r.phase === 'result');
  assert.equal(added.length, 1, 'exactly one result receipt');
  return { ...outcome, receipt: added[0] };
}
const aliasWriteRule = (h, status, extra = {}) => ({ when: '^POST /_admin/aliases/review$', status, ...extra });

const FAULTS = {
  async partialUpload(h) {
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    h.inject({ failPutsAfter: 3 });
    const err = await rejection(publish({ ...h.opts(), packetDir: p.dir }));
    assert.equal(err.details.state, 'PARTIAL');
    await assertInvariants(h, before);
    assert.equal((await verifyOnTarget(h.adapter, p.contentId)).verified, false, 'a partial packet is not verified');
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED);
    const resumed = await publish({ ...h.opts(), packetDir: p.dir });
    assert.deepEqual(resumed.receipt.objects.slice(0, 3).map((o) => o.outcome), ['identical', 'identical', 'identical'], 'the rerun reuses what landed');
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 })).record.generation, 1);
    return { state: 'PARTIAL', recovery: 'rerun publish: first objects identical, READBACK_VERIFIED, then promote' };
  },

  async staleRead(h) {
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    await promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 });
    const before = await storedObjects(h);
    h.inject({ staleAliasReads: 1 });
    const stale = await h.adapter.readAlias('review');
    assert.equal(stale.generation, 1, 'the injected stale read returns the old record');
    const err = await rejection(promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: stale.generation }));
    assert.equal(err.code, CODES.ALIAS_CONFLICT);
    assert.equal((await h.adapter.readAlias('review')).contentId, b.contentId, 'the alias did not move');
    await assertInvariants(h, before);
    const fresh = await h.adapter.readAlias('review');
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: fresh.generation })).record.generation, 3);
    return { state: 'ALIAS_CONFLICT', recovery: 're-read the alias, then promote at the current generation' };
  },

  async aliasRace(h) {
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    const before = await storedObjects(h);
    const retry = lockWait(h);
    const results = await Promise.allSettled([b, a, b].map((p) => promote({ ...h.opts({ retry }), alias: 'review', contentId: p.contentId, expectGeneration: 1 })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one winner');
    for (const r of results.filter((x) => x.status === 'rejected')) {
      assert.equal(r.reason.code, CODES.ALIAS_CONFLICT);
      assert.equal(r.reason.details.currentGeneration, 2);
    }
    await assertInvariants(h, before);
    // Deterministic interleaving: another promoter commits between this writer's read
    // and its conditional write. The store's own CAS (D1 WHERE generation,
    // V1 lock + generation) must refuse the stale write.
    const racedFrom = await storedObjects(h);
    h.inject({ raceAliasWrite: 1 });
    const raced = await rejection(promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 2 }));
    assert.equal(raced.code, CODES.ALIAS_CONFLICT);
    assert.equal(raced.details.currentGeneration, 3, 'the competing write took generation 3');
    await assertInvariants(h, racedFrom);
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 3 })).record.generation, 4);
    return { state: 'ALIAS_CONFLICT for every loser (concurrent and interleaved); one PROMOTED', recovery: 'losers re-read and re-decide; history dense' };
  },

  async conflict(h) {
    const p = await syntheticPacket(h.dir);
    await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    const before = await storedObjects(h);
    // Different bytes under an existing content-addressed key: refused, nothing replaced.
    const key = objectKey(p.contentId, 'report.md');
    const other = Buffer.from('different bytes under the same content-addressed key');
    const put = await h.adapter.putIfAbsent({ key, sha256: sha256Hex(other), bytes: other.length, contentType: 'text/markdown; charset=utf-8', cacheControl: CACHE_IMMUTABLE }, other);
    assert.equal(put.outcome, 'conflict');
    await assertInvariants(h, before);
    // The protocol stops CONFLICT when a key it must write holds different bytes.
    const q = await syntheticPacket(h.dir, 'q');
    const qBytes = Buffer.from('planted before publish');
    const qKey = objectKey(q.contentId, 'checksums.json');
    await h.adapter.putIfAbsent({ key: qKey, sha256: sha256Hex(qBytes), bytes: qBytes.length, contentType: 'application/json', cacheControl: CACHE_IMMUTABLE }, qBytes);
    const planted = await storedObjects(h);
    const err = await rejection(publish({ ...h.opts(), packetDir: q.dir }));
    assert.equal(err.code, CODES.CONFLICT);
    assert.equal(err.details.state, 'CONFLICT');
    await assertInvariants(h, planted);
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: q.contentId, expectGeneration: 1 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED);
    assert.equal((await h.adapter.readAlias('review')).contentId, p.contentId);
    return { state: 'CONFLICT', recovery: 'stop: integrity alarm for a human; nothing overwritten, alias unchanged' };
  },

  async timeout(h) {
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    h.inject({ timeout: 2 });
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED', 'bounded retry absorbs two timeouts');
    const q = await syntheticPacket(h.dir, 'q');
    h.inject({ timeout: 50 });
    const err = await rejection(publish({ ...h.opts(), packetDir: q.dir }));
    assert.equal(err.code, CODES.TIMEOUT);
    await assertInvariants(h, before);
    assert.equal((await publish({ ...h.opts(), packetDir: q.dir })).state, 'READBACK_VERIFIED');
    return { state: 'TIMEOUT when retries are exhausted', recovery: 'bounded retry; rerun publish' };
  },

  async throttle(h) {
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    h.inject({ throttle: 2 });
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED', 'bounded retry absorbs two throttles');
    const q = await syntheticPacket(h.dir, 'q');
    h.inject({ throttle: 50 });
    const err = await rejection(publish({ ...h.opts(), packetDir: q.dir }));
    assert.equal(err.code, CODES.THROTTLED);
    await assertInvariants(h, before);
    assert.equal((await publish({ ...h.opts(), packetDir: q.dir })).state, 'READBACK_VERIFIED');
    return { state: 'THROTTLED when retries are exhausted', recovery: 'bounded retry; rerun publish' };
  },

  async credentialExpiry(h) {
    if (!h.expireCredential) {
      assert.equal(h.target.credentialEnv, undefined, 'fs holds no credential');
      return { notApplicable: 'fs has no credential' };
    }
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    h.inject({ expireAfterRequests: 4 });
    const err = await rejection(publish({ ...h.opts(), packetDir: p.dir }));
    assert.equal(err.code, CODES.CREDENTIAL_EXPIRED);
    h.renewCredential(); // reading the target to check the invariants needs a live credential
    await assertInvariants(h, before);
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED');
    return { state: 'CREDENTIAL_EXPIRED (PARTIAL)', recovery: 'renew the credential; rerun publish' };
  },

  async hashMismatch(h) {
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    // Upload: bytes that do not match the declared SHA-256 are refused and not stored.
    const key = objectKey(p.contentId, 'report.md');
    const bytes = Buffer.from('bytes whose declared digest is a lie');
    await assert.rejects(h.adapter.putIfAbsent({ key, sha256: sha256Hex(Buffer.from('lie')), bytes: bytes.length, contentType: 'text/markdown; charset=utf-8', cacheControl: CACHE_IMMUTABLE }, bytes), (e) => e.code === CODES.BAD_DIGEST);
    assert.equal(await h.adapter.getObject(key), null, 'nothing was stored');
    // Read-back: a corrupted read fails verification; publish stops and nothing is promoted.
    h.inject({ corruptReads: 1 });
    const err = await rejection(publish({ ...h.opts(), packetDir: p.dir }));
    assert.equal(err.code, CODES.READBACK_MISMATCH);
    assert.equal(err.details.state, 'READBACK_MISMATCH');
    h.inject({ corruptReads: 1 });
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED);
    assert.equal(await h.adapter.readAlias('review'), null, 'no promotion before verified read-back');
    await assertInvariants(h, before);
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED');
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 })).record.generation, 1);
    return { state: 'BAD_DIGEST on upload; READBACK_MISMATCH on read-back', recovery: 'stop; after a clean read-back, publish and promote' };
  },

  async rollbackUnverified(h) {
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    const c = await syntheticPacket(h.dir, 'c');
    for (const p of [a, b, c]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    await promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 });
    const before = await storedObjects(h);
    await assert.rejects(rollback({ ...h.opts(), alias: 'review', to: MISSING, expectGeneration: 2 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED, 'missing');
    await assert.rejects(rollback({ ...h.opts(), alias: 'review', to: c.contentId, expectGeneration: 2 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED, 'never a generation');
    h.inject({ corruptReads: 1 });
    await assert.rejects(rollback({ ...h.opts(), alias: 'review', to: a.contentId, expectGeneration: 2 }), (e) => e.code === CODES.TARGET_NOT_VERIFIED, 'unverified read-back');
    assert.equal((await h.adapter.readAlias('review')).contentId, b.contentId, 'the alias did not move');
    await assertInvariants(h, before);
    const back = await rollback({ ...h.opts(), alias: 'review', to: a.contentId, expectGeneration: 2 });
    assert.equal(back.record.generation, 3, 'rollback moves forward');
    await assertInvariants(h, before);
    return { state: 'TARGET_NOT_VERIFIED', recovery: 'roll back only to a verified earlier generation; nothing deleted' };
  },

  async receiptWrite(h) {
    const p = await syntheticPacket(h.dir);
    const before = await storedObjects(h);
    h.inject({ failReceipts: 1 });
    const err = await rejection(publish({ ...h.opts(), packetDir: p.dir }));
    assert.equal(err.code, CODES.RECEIPT_FAILED);
    assert.equal((await publish({ ...h.opts(), packetDir: p.dir })).state, 'READBACK_VERIFIED', 'the rerun completes');
    h.inject({ failReceipts: 1 });
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), (e) => e.code === CODES.RECEIPT_FAILED);
    assert.equal(await h.adapter.readAlias('review'), null, 'no promotion without its intent receipt');
    await assertInvariants(h, before);
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 })).record.generation, 1);
    return { state: 'RECEIPT_FAILED', recovery: 'rerun; the alias moves only after its intent receipt is written' };
  },

  // The alias commits, then its history append fails (docs/v2/publication-protocol.md
  // §4.1). Transient failures are retried inside the operation; a failure that
  // outlasts that is reported truthfully as HISTORY_INCOMPLETE, moves are refused with
  // that reason until reconcile repairs the history, and rollback then works.
  async historyAfterCommit(h) {
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    if (h.kind === 'mock-cloudflare') {
      assert.deepEqual(await h.adapter.appendHistory('review', await h.adapter.readAlias('review')), { written: false }, 'D1 wrote the entry with the CAS');
      return { notApplicable: 'history is written in the CAS\'s own D1 batch: there is no second write to fail' };
    }
    const before = await storedObjects(h);
    const other = (g) => (g % 2 === 1 ? b : a);
    const transient = [['append refused once', { failHistoryAppend: 1 }]];
    for (const [label, fault] of transient) {
      const g = (await h.adapter.readAlias('review')).generation;
      h.inject(fault);
      const { value, error, receipt } = await newResults(h, () => promote({ ...h.opts(), alias: 'review', contentId: other(g).contentId, expectGeneration: g }));
      assert.equal(error, undefined, `${label}: the move completes`);
      assert.equal(value.record.generation, g + 1, `${label}: moved exactly once`);
      assert.deepEqual((await h.adapter.readHistory('review')).map((r) => r.generation), Array.from({ length: g + 1 }, (_, i) => i + 1), `${label}: history dense`);
      assert.equal(receipt.state, value.state, `${label}: the receipt states the move`);
      assert.equal(receipt.toGeneration, g + 1);
    }
    const persistent = [['append refused twice', { failHistoryAppend: 2 }, CODES.PROTOCOL]];
    for (const [label, fault, errorClass] of persistent) {
      const g = (await h.adapter.readAlias('review')).generation;
      const target = other(g);
      h.inject(fault);
      const { error, receipt } = await newResults(h, () => promote({ ...h.opts(), alias: 'review', contentId: target.contentId, expectGeneration: g }));
      assert.equal(error?.code, CODES.HISTORY_INCOMPLETE, `${label}: reported as HISTORY_INCOMPLETE, not a conflict`);
      const moved = await h.adapter.readAlias('review');
      assert.equal(moved.generation, g + 1, `${label}: the alias moved exactly once`);
      assert.equal(moved.contentId, target.contentId);
      assert.equal(receipt.state, 'HISTORY_INCOMPLETE', `${label}: truthful receipt state`);
      assert.equal(receipt.toGeneration, g + 1, `${label}: the receipt records the move`);
      assert.equal(receipt.errorClass, errorClass, `${label}: the receipt names the append's error class`);
      assert.ok(receipt.transitions.includes('PROMOTED'));
      // Before the repair, moves are refused with the real reason.
      const refusedPromote = await rejection(promote({ ...h.opts(), alias: 'review', contentId: other(g + 1).contentId, expectGeneration: g + 1 }));
      assert.equal(refusedPromote.code, CODES.HISTORY_INCOMPLETE);
      const refusedRollback = await rejection(rollback({ ...h.opts(), alias: 'review', to: other(g + 1).contentId, expectGeneration: g + 1 }));
      assert.equal(refusedRollback.code, CODES.HISTORY_INCOMPLETE, `${label}: rollback refused as history-incomplete, not "never a generation"`);
      assert.match(refusedRollback.message, /run reconcile/i);
      assert.equal((await h.adapter.readAlias('review')).generation, g + 1, 'refusals did not move the alias');
      // reconcile repairs the one missing entry from the current record.
      const rec = await reconcile(h.opts());
      assert.equal(rec.results.find((r) => r.alias === 'review').historyRepaired, g + 1, `${label}: reconcile repaired generation ${g + 1}`);
      assert.equal((await h.adapter.readAlias('review')).generation, g + 1, 'reconcile never moves the alias');
      assert.deepEqual((await h.adapter.readHistory('review')).map((r) => r.generation), Array.from({ length: g + 1 }, (_, i) => i + 1), `${label}: history dense after repair`);
      // After the repair, rollback to the earlier content works.
      const back = await rollback({ ...h.opts(), alias: 'review', to: other(g + 1).contentId, expectGeneration: g + 1 });
      assert.equal(back.record.generation, g + 2, `${label}: rollback works after the repair`);
    }
    await assertInvariants(h, before);
    return { state: 'transient: PROMOTED with history appended in the operation; persistent: HISTORY_INCOMPLETE (alias at g+1, errorClass named)', recovery: 'moves refused as history-incomplete; reconcile appends the entry; rollback works' };
  },

  // The alias write commits, but its response is lost (a timeout after the store
  // applied it). The retry recognises its own move by operation ID: never a conflict.
  async lostResponseAfterCommit(h) {
    if (h.kind === 'fs') return { notApplicable: 'a local filesystem write has no response to lose' };
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    const before = await storedObjects(h);
    h.inject({ respond: [aliasWriteRule(h, 599, { afterCommit: true })] });
    const { value, error, receipt } = await newResults(h, () => promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 }));
    assert.equal(error, undefined, 'the move is recognised as this operation\'s own');
    assert.equal(value.record.generation, 2, 'moved exactly once');
    assert.equal(receipt.state, value.state);
    assert.deepEqual((await h.adapter.readHistory('review')).map((r) => r.generation), [1, 2]);
    // A different operation with the same stale expectation is a real conflict.
    assert.equal((await rejection(promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 1 }))).code, CODES.ALIAS_CONFLICT);
    await assertInvariants(h, before);
    return { state: 'PROMOTED (own committed write recognised)', recovery: 'retry by operation ID; never reported as a conflict' };
  },

  // The alias write fails before it commits: every such exit leaves a result receipt
  // with its own state, and the alias does not move.
  async aliasWriteFailure(h) {
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    const before = await storedObjects(h);
    const times = (n, rule) => Array.from({ length: n }, () => ({ ...rule }));
    const cases = h.kind === 'fs'
      ? [['aliases directory read-only', { failAliasWrite: 1 }, 'FAILED', CODES.PROTOCOL]]
      : [
          ['500', { respond: [aliasWriteRule(h, 500)] }, 'FAILED', CODES.PROTOCOL],
          ['503 until retries run out', { respond: times(4, aliasWriteRule(h, 503)) }, 'THROTTLED', CODES.THROTTLED],
          ['599 until retries run out', { respond: times(4, aliasWriteRule(h, 599)) }, 'TIMEOUT', CODES.TIMEOUT],
          ['credential expired', { respond: [aliasWriteRule(h, 403)] }, 'CREDENTIAL_EXPIRED', CODES.CREDENTIAL_EXPIRED],
        ];
    for (const [label, fault, state, code] of cases) {
      h.inject(fault);
      const { error, receipt } = await newResults(h, () => promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 }));
      assert.equal(error?.code, code, `${label}: error code`);
      assert.equal(receipt.state, state, `${label}: result receipt state`);
      assert.equal(receipt.errorClass, code, `${label}: result receipt error class`);
      assert.equal(receipt.toGeneration, undefined, `${label}: no move recorded`);
      assert.equal((await h.adapter.readAlias('review')).generation, 1, `${label}: the alias did not move`);
    }
    await assertInvariants(h, before);
    assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 })).record.generation, 2);
    return { state: 'FAILED | THROTTLED | TIMEOUT | CREDENTIAL_EXPIRED, each with a result receipt', recovery: 'rerun the promote; the alias never moved' };
  },
};

for (const kind of KINDS) {
  for (const [fault, run] of Object.entries(FAULTS)) {
    test(`[V2-6] fault matrix ${kind} × ${fault}`, async (t) => {
      const h = await harness(kind, t);
      const cell = await run(h);
      if (!cell.notApplicable) await assertInvariants(h, new Map());
      t.diagnostic(`v2-fault ${JSON.stringify({ adapter: kind, fault, verdict: cell.notApplicable ? 'NOT_APPLICABLE' : 'PASS', ...cell })}`);
    });
  }
}
