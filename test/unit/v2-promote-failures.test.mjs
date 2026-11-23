// Promote and rollback failures (docs/v2/publication-protocol.md §4, §7; cost-model.md
// §3): the cost ceiling is checked before any provider request, and every failure
// after a request has reached the target leaves a result receipt and a ledger line
// for what it spent. The alias never moves.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CODES } from '../../src/publication/errors.mjs';
import { ledgerPath } from '../../src/publication/policy.mjs';
import { promote, publish, rollback } from '../../src/publication/protocol.mjs';
import { allReceipts, harness, KINDS, syntheticPacket } from '../v2/harness.mjs';

const ledger = async (h) => (await readFile(ledgerPath(h.target), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

for (const kind of KINDS) {
  test(`[V2-10] ${kind}: a promote over the ceiling is refused before any request`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    await publish({ ...h.opts(), packetDir: p.dir });
    h.target.costCeilingUsdPerMonth = (await ledger(h)).reduce((n, e) => n + e.estimatedCostUsd, 0);
    const before = h.adapter.requestCount?.() ?? 0;
    if (kind === 'fs') {
      assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 })).state, 'PROMOTED', 'fs costs nothing');
      return;
    }
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), (e) => e.code === CODES.COST_CEILING);
    assert.equal(h.adapter.requestCount(), before, 'no request reached the provider');
    assert.equal(await h.adapter.readAlias('review'), null);
  });

  test(`[V2-6] ${kind}: failed promotes and rollbacks leave a result receipt and a ledger line`, async (t) => {
    const h = await harness(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    await publish({ ...h.opts(), packetDir: a.dir });
    await publish({ ...h.opts(), packetDir: b.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    const cases = [
      ['target not on the store', () => promote({ ...h.opts(), alias: 'review', contentId: `sha256-${'0'.repeat(64)}`, expectGeneration: 1 }), CODES.TARGET_NOT_VERIFIED, 'TARGET_NOT_VERIFIED'],
      ['stale generation', () => promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 5 }), CODES.ALIAS_CONFLICT, 'ALIAS_CONFLICT'],
      ['rollback to a packet that was never a generation', () => rollback({ ...h.opts(), alias: 'review', to: b.contentId, expectGeneration: 1 }), CODES.TARGET_NOT_VERIFIED, 'TARGET_NOT_VERIFIED'],
    ];
    for (const [name, run, code, state] of cases) {
      const lines = (await ledger(h)).length;
      const seen = new Set((await allReceipts(h)).map((r) => r.receiptId));
      await assert.rejects(run(), (e) => e.code === code, name);
      const added = (await allReceipts(h)).filter((r) => !seen.has(r.receiptId));
      assert.ok(added.some((r) => r.state === state && r.errorClass === code && r.phase === 'result'), `${name}: a ${state} result receipt was written`);
      const newLines = (await ledger(h)).slice(lines);
      assert.equal(newLines.length, 1, `${name}: one ledger line`);
      assert.ok(newLines[0].requestCount > 0 && newLines[0].operation !== 'publish', `${name}: the ledger line records the requests spent`);
      assert.equal((await h.adapter.readAlias('review')).contentId, a.contentId, `${name}: the alias did not move`);
    }
  });

  test(`[V2-8] ${kind}: a production packet on a provider store is refused at promote with a REFUSED receipt`, async (t) => {
    const h = await harness(kind, t);
    // A packet that reached the store by some other path: published here through the
    // same adapter under a local-kind target, so the provider guard was not applied.
    const p = await syntheticPacket(h.dir, 'prod', { classification: 'private-review', dataOrigin: 'production' });
    await publish({ ...h.opts(), target: { ...h.target, kind: 'fs', accessMode: 'local' }, packetDir: p.dir });
    if (kind === 'fs') {
      assert.equal((await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 })).state, 'PROMOTED', 'the local V1 target takes production data');
      return;
    }
    const lines = (await ledger(h)).length;
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 }), (e) => e.code === CODES.SYNTHETIC_ONLY);
    const refused = (await allReceipts(h)).filter((r) => r.state === 'REFUSED');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].errorClass, CODES.SYNTHETIC_ONLY);
    assert.equal((await ledger(h)).length, lines + 1);
    assert.equal(await h.adapter.readAlias('review'), null, 'the alias was never created');
  });
}

// The history guard reads the alias and its history separately (protocol §4.1). A move
// committed between the two reads must not be mistaken for a missing history entry: the
// caller lost the race, which is a conflict.
for (const kind of KINDS) {
  test(`[V2-6] ${kind}: a move committed between the guard's reads is a conflict, never a false history-incomplete`, async (t) => {
    const h = await harness(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    let raced = false;
    const racing = {
      ...h.adapter,
      async readHistory(name) {
        if (!raced) {
          raced = true;
          // Another writer commits generation 2 (with its history) right now.
          const cur = await h.adapter.readAlias(name);
          const r = await h.adapter.casAlias(name, cur.generation, b.contentId, { opId: 'competitor' });
          assert.ok(r.ok, 'the competing move committed');
          await h.adapter.appendHistory(name, r.record);
        }
        return h.adapter.readHistory(name);
      },
    };
    const err = await promote({ ...h.opts(), adapter: racing, alias: 'review', contentId: a.contentId, expectGeneration: 1 }).then(() => null, (e) => e);
    assert.ok(raced, 'the race was injected');
    assert.equal(err?.code, CODES.ALIAS_CONFLICT, `lost the race: ${err?.code}`);
    assert.equal(err.details.currentGeneration, 2);
    assert.deepEqual((await h.adapter.readHistory('review')).map((r) => r.generation), [1, 2]);
  });
}

// A caller whose expectation is already stale is told it lost (conflict), even when the
// current generation's history is incomplete; a caller at the current generation is
// refused with history-incomplete until reconcile repairs it.
for (const kind of ['fs']) {
  test(`[V2-6] ${kind}: a stale caller meeting an incomplete history gets a conflict; a current caller gets history-incomplete`, async (t) => {
    const h = await harness(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    for (const p of [a, b]) await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    h.inject({ failHistoryAppend: 2 });
    await assert.rejects(promote({ ...h.opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 }), (e) => e.code === CODES.HISTORY_INCOMPLETE);
    const stale = await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 1 }).then(() => null, (e) => e);
    assert.equal(stale?.code, CODES.ALIAS_CONFLICT, 'the stale caller lost');
    assert.equal(stale.details.currentGeneration, 2);
    const current = await promote({ ...h.opts(), alias: 'review', contentId: a.contentId, expectGeneration: 2 }).then(() => null, (e) => e);
    assert.equal(current?.code, CODES.HISTORY_INCOMPLETE, 'a move from the incomplete generation is refused');
    assert.equal((await h.adapter.readAlias('review')).generation, 2, 'nothing moved');
  });
}
