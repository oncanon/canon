// V2-QA-5 addendum (QA s7): the engine comparator compares each red control at its
// INTENDED assertion. A racy control (R32) whose collateral failures differ between
// engines is a note, not a disagreement; a difference at the intended assertion, or a
// control red in only one engine, is a disagreement.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareControls, expandIds } from '../../scripts/compare-engines.mjs';
import { CONTROLS, EXPECTED_CONTROL_COUNT } from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';

// R32 at integrate/cf 985d5f2: v26 failed 7 tests, v22 failed 8 (evidence ev-985d5f2).
const INTENDED = '[E4] D-F2: state.json does not exist until its complete content is published, and stays exclusive';
const COMMON = [
  '[E4] start -> ready (healthz) -> idempotent start -> status -> stop, with exit codes',
  '[E4] recovery: a pid recycled by an unrelated process is never signalled',
  INTENDED,
  '[E4] D-F2: a state file still corrupt at the ready deadline fails start cleanly and leaves no serve process',
];
const STALE = '[E4] recovery: a stale state file from a dead process is detected and cleared on start';
const r32 = (failed, extra = {}) => ({ id: 'R32', wentRed: true, intends: [INTENDED], intendedFailed: failed.includes(INTENDED) ? [INTENDED] : [], broken: { exitCode: 1, failed }, ...extra });
const one = (r) => new Map([[r.id, r]]);
const E = { expectA: new Set(['R32']), expectB: new Set(['R32']) };

test('[V2-QA-5] collateral variance in a racy control is a note, not a disagreement', () => {
  const r = compareControls(one(r32(COMMON)), one(r32([...COMMON, STALE])), E);
  assert.deepEqual(r.problems, []);
  assert.equal(r.compared, 1);
  assert.deepEqual(r.notes, [{ id: 'R32', onlyA: [], onlyB: [STALE] }]);
});

test('[V2-QA-5] a difference at the intended assertion is a disagreement', () => {
  const without = COMMON.filter((n) => n !== INTENDED);
  const r = compareControls(one(r32(COMMON)), one(r32(without, { wentRed: false })), E);
  assert.ok(r.problems.some((p) => p.includes('intended assertion') && p.includes('failed vs passed')), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => p.includes('not red in both')));
});

test('[V2-QA-5] a control with no intended assertion, or different ones per engine, is a disagreement', () => {
  assert.ok(compareControls(one(r32(COMMON, { intends: [] })), one(r32(COMMON)), E).problems.some((p) => p.includes('no intended assertion')));
  assert.ok(compareControls(one(r32(COMMON)), one(r32(COMMON, { intends: [STALE] })), E).problems.some((p) => p.includes('different intended assertions')));
  assert.ok(compareControls(new Map(), one(r32(COMMON)), E).problems.includes('no controls in common'));
});

test('[V2-QA-5] CLI: exit 0 on collateral variance only, exit 1 on a test or intended-assertion difference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canon-compare-'));
  try {
    const tap = (fail) => `TAP version 13\nok 1 - alpha\n${fail ? 'not ok' : 'ok'} 2 - beta\n1..2\n# tests 2\n# pass ${fail ? 1 : 2}\n# fail ${fail ? 1 : 0}\n# skipped 0\n`;
    const w = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    const ta = w('a.tap', tap(false));
    const tb = w('b.tap', tap(false));
    const tf = w('f.tap', tap(true));
    const ra = w('a.json', JSON.stringify([r32(COMMON)]));
    const rb = w('b.json', JSON.stringify([r32([...COMMON, STALE])]));
    const rx = w('x.json', JSON.stringify([r32(COMMON.filter((n) => n !== INTENDED), { wentRed: false })]));
    const run = (...args) => spawnSync(process.execPath, [join(REPO, 'scripts/compare-engines.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(run(ta, tb, ra, rb, '--expect-a', 'R32', '--expect-b', 'R32').status, 0);
    assert.equal(run(ta, tb, ra, rb).status, 1, 'no declared ID sets');
    assert.equal(run(ta, tf).status, 1, 'a test outcome differs');
    assert.equal(run(ta, tb, ra, rx, '--expect-a', 'R32', '--expect-b', 'R32').status, 1, 'the intended assertion differs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// V2-QA-6 addendum (b): each engine must run exactly its declared set; an engine that ran
// only R1 while R1-R65 was declared is a disagreement, not a smaller agreement.
test('[V2-QA-6] a shortfall against an engine\'s declared control set is a disagreement', () => {
  assert.deepEqual([...expandIds('R1-R3,R7')], ['R1', 'R2', 'R3', 'R7']);
  assert.throws(() => expandIds('R5-R2'));
  // "full" is derived from the control table itself, never written by hand, and has the harness's
  // expected count (retired controls leave gaps, so it is not R1..R<count>).
  assert.deepEqual([...expandIds('full')], CONTROLS.map((c) => c.id));
  assert.equal(expandIds('full').size, EXPECTED_CONTROL_COUNT);
  const red = (id) => ({ ...r32(COMMON), id });
  const A = new Map(['R1', 'R2', 'R3'].map((id) => [id, red(id)]));
  const onlyR1 = new Map([['R1', red('R1')]]);
  const r = compareControls(A, onlyR1, { expectA: expandIds('R1-R3'), expectB: expandIds('R1-R3') });
  assert.ok(r.problems.some((p) => /engine B is short of its declared set by 2: R2, R3/.test(p)), JSON.stringify(r.problems));
  assert.deepEqual(compareControls(A, A, { expectA: expandIds('R1-R3'), expectB: expandIds('R1-R3') }).problems, []);
  assert.ok(compareControls(A, A, { expectA: expandIds('R1-R2'), expectB: expandIds('R1-R3') }).problems.some((p) => /engine A ran 1 undeclared: R3/.test(p)));
  assert.ok(compareControls(A, A).problems.includes('no expected control ID set declared for each engine'));
});
