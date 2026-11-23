// V2-QA-6 addendum (a): a control's intended assertion is AUTHORED, reviewed data, never
// derived from what happened to fail. Every control carries intendsProvenance "reviewed"
// and a one-line intendsWhy tying the test to its defect, and its intends must include a
// test under one of the control's row tags ("[E4] …", "[PV-05 Worker] …") unless an
// explicit tagException says why the guarding test sits under another row. An exception
// that is not needed is itself a failure, so exceptions cannot accumulate unexamined.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLS } from '../../scripts/red-controls.mjs';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tagged = (c) => (c.intends ?? []).some((name) => (c.rows ?? []).some((tag) => new RegExp(`^\\[${escape(tag)}[\\] ]`).test(name)));

export function intendsProblems(controls) {
  const problems = [];
  for (const c of controls) {
    if (!Array.isArray(c.intends) || !c.intends.length) problems.push(`${c.id}: no intended assertion`);
    if (c.intendsProvenance !== 'reviewed') problems.push(`${c.id}: intends provenance is ${JSON.stringify(c.intendsProvenance)}, not "reviewed"`);
    if (typeof c.intendsWhy !== 'string' || c.intendsWhy.trim().length < 20) problems.push(`${c.id}: no rationale tying the intended test to the defect`);
    // Who reviewed it and when (V2-QA-6 addendum (3)): a declared provenance string alone
    // proves nothing, so the reviewer is named, and a self-review says so.
    if (typeof c.intendsReviewer !== 'string' || !c.intendsReviewer.trim()) problems.push(`${c.id}: no reviewer recorded`);
    else if (/^author\b/.test(c.intendsReviewer) && !/self-review/.test(c.intendsReviewer)) problems.push(`${c.id}: a review by the author must be marked self-review`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.intendsReviewed ?? '')) problems.push(`${c.id}: no review date`);
    const exception = typeof c.tagException === 'string' && c.tagException.trim().length >= 20;
    if (!tagged(c) && !exception) problems.push(`${c.id}: no intended test under its row tag(s) ${JSON.stringify(c.rows)} and no tagException`);
    if (tagged(c) && c.tagException !== undefined) problems.push(`${c.id}: tagException given although an intended test is under its row tag`);
  }
  return problems;
}

test('[V2-QA-6] every control\'s intended assertion is reviewed, justified and tied to its row tag (or an explicit exception)', () => {
  assert.equal(CONTROLS.length > 0, true);
  assert.deepEqual(intendsProblems(CONTROLS), []);
});

test('[V2-QA-6] the intends gate refuses derived, unjustified, untagged and stale-exception entries', () => {
  const ok = { id: 'X1', rows: ['E4'], intends: ['[E4] a test'], intendsProvenance: 'reviewed', intendsWhy: 'the E4 test asserts exactly what the defect breaks', intendsReviewer: 'author (self-review, not independent; pending QA)', intendsReviewed: '2026-09-28' };
  assert.deepEqual(intendsProblems([ok]), []);
  const cases = [
    [{ ...ok, intendsProvenance: 'derived' }, /not "reviewed"/],
    [{ ...ok, intendsWhy: '' }, /no rationale/],
    [{ ...ok, intends: [] }, /no intended assertion/],
    [{ ...ok, intends: ['[E2] another row'] }, /no intended test under its row tag/],
    [{ ...ok, rows: ['P1'], intends: ['[P16] a prefix-only match'] }, /no intended test under its row tag/],
    [{ ...ok, tagException: 'an exception that the row tag already makes unnecessary' }, /tagException given although/],
    [{ ...ok, intendsReviewer: '' }, /no reviewer recorded/],
    [{ ...ok, intendsReviewer: 'author' }, /must be marked self-review/],
    [{ ...ok, intendsReviewed: 'yesterday' }, /no review date/],
  ];
  for (const [c, reason] of cases) {
    const p = intendsProblems([c]);
    assert.ok(p.some((x) => reason.test(x)), `${JSON.stringify(c)}: expected ${reason}, got ${JSON.stringify(p)}`);
  }
  assert.deepEqual(intendsProblems([{ ...ok, intends: ['[E2] another row'], tagException: 'the E4 defect is guarded by an E2 property test, justified here' }]), []);
});
