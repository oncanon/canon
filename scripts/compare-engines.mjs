#!/usr/bin/env node
// Compare two engines' runs: two `npm test` outputs (any mix of TAP and spec reporters)
// test by test, and optionally two red-control JSON runs control by control. Exit 1 on
// any disagreement, or if a parse does not reproduce its own run's summary counts (an
// inert parser). Controls are compared at their INTENDED assertions (`intends`): both
// engines must be red there. The rest of a control's failed-test list is reported as a
// note, not a disagreement: some defects are racy by design (R32), and which collateral
// tests fail under them varies from run to run (QA s7, V2-QA-5 addendum).
//   node scripts/compare-engines.mjs <npm-test-A> <npm-test-B> [<red-controls-A.json> <red-controls-B.json> --expect-a full --expect-b R1-R65]
// "full" is every control ID in the table in scripts/red-controls.mjs (derived, so it never goes stale;
// retired controls leave gaps, so the set is not a contiguous range).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONTROLS } from './red-controls.mjs';

function parse(file) {
  const text = readFileSync(file, 'utf8');
  const results = new Map();
  const add = (name, outcome) => {
    const key = name.replace(/\s+\(\d+(\.\d+)?m?s\)$/, '').trim();
    if (results.has(key)) throw new Error(`${file}: duplicate test name ${key}`);
    results.set(key, outcome);
  };
  for (const line of text.split('\n')) {
    let m;
    // Node's TAP reporter escapes backslash, '#' and newlines in test names; the spec
    // reporter prints them raw. Decode so both reporters name a test the same way.
    if ((m = line.match(/^(not ok|ok) \d+ - ((?:\\.|[^\\#])*?)(?: # (SKIP|TODO)\b.*)?$/))) add(m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)), m[3] === 'SKIP' ? 'skip' : m[1] === 'ok' ? 'pass' : 'fail');
    else if ((m = line.match(/^✔ (.*)$/))) add(m[1], 'pass');
    else if ((m = line.match(/^✖ (.*)$/)) && !/^✖ failing tests:/.test(line)) add(m[1], 'fail');
    else if ((m = line.match(/^﹣ (.*?\(\d+(?:\.\d+)?m?s\))(?: # .*)?$/))) add(m[1], 'skip');
  }
  const num = (k) => Number(text.match(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`, 'm'))?.[1]);
  const summary = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
  const counts = { tests: results.size, pass: 0, fail: 0, skipped: 0 };
  for (const o of results.values()) counts[o === 'skip' ? 'skipped' : o] += 1;
  const problems = Object.keys(summary).filter((k) => summary[k] !== counts[k]).map((k) => `${file}: parsed ${k}=${counts[k]} but summary says ${summary[k]}`);
  return { results, summary, problems };
}

// "R1-R65,R70" -> the set of control IDs it names; "full" -> every control in the full set.
export function expandIds(spec) {
  if (spec === 'full') return new Set(CONTROLS.map((c) => c.id));
  const ids = new Set();
  for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^R(\d+)(?:-R(\d+))?$/);
    if (!m || (m[2] && Number(m[2]) < Number(m[1]))) throw new Error(`bad control ID set: ${part}`);
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n += 1) ids.add(`R${n}`);
  }
  return ids;
}

// Red-control results of two engines, keyed by control ID. Each engine must have run
// exactly its DECLARED set (V2-QA-6 addendum (b)): a shortfall (a declared control that
// did not run) or an undeclared one is a disagreement, so a run that stopped early, or
// selected fewer controls, can never pass as agreement. The controls both ran are compared.
export function compareControls(A, B, { expectA, expectB } = {}) {
  const problems = [];
  const notes = [];
  if (!expectA || !expectB) problems.push('no expected control ID set declared for each engine');
  for (const [name, got, want] of [['A', A, expectA], ['B', B, expectB]]) {
    if (!want) continue;
    const short = [...want].filter((id) => !got.has(id));
    const extra = [...got.keys()].filter((id) => !want.has(id));
    if (short.length) problems.push(`engine ${name} is short of its declared set by ${short.length}: ${short.slice(0, 10).join(', ')}${short.length > 10 ? ', …' : ''}`);
    if (extra.length) problems.push(`engine ${name} ran ${extra.length} undeclared: ${extra.slice(0, 10).join(', ')}`);
  }
  const ids = [...B.keys()].filter((id) => A.has(id));
  if (!ids.length) problems.push('no controls in common');
  for (const id of ids) {
    const x = A.get(id);
    const y = B.get(id);
    if (x.wentRed !== y.wentRed) problems.push(`${id}: wentRed ${x.wentRed} vs ${y.wentRed}`);
    if (!x.wentRed || !y.wentRed) problems.push(`${id}: not red in both`);
    if (!x.intends?.length || !y.intends?.length) problems.push(`${id}: no intended assertion recorded`);
    else if (JSON.stringify(x.intends) !== JSON.stringify(y.intends)) problems.push(`${id}: the engines ran different intended assertions`);
    for (const name of x.intends ?? []) {
      const fx = x.broken?.failed?.includes(name) ?? false;
      const fy = y.broken?.failed?.includes(name) ?? false;
      if (fx !== fy) problems.push(`${id}: intended assertion "${name}" ${fx ? 'failed' : 'passed'} vs ${fy ? 'failed' : 'passed'}`);
    }
    if (!x.intendedFailed?.length || !y.intendedFailed?.length) problems.push(`${id}: not red at its intended assertion in both`);
    const other = (r) => (r.broken?.failed ?? []).filter((n) => !(r.intends ?? []).includes(n)).sort();
    const ox = other(x);
    const oy = other(y);
    if (JSON.stringify(ox) !== JSON.stringify(oy)) notes.push({ id, onlyA: ox.filter((n) => !oy.includes(n)), onlyB: oy.filter((n) => !ox.includes(n)) });
  }
  return { compared: ids.length, problems, notes };
}

function main(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--expect-a' || argv[i] === '--expect-b') opts[argv[i] === '--expect-a' ? 'expectA' : 'expectB'] = expandIds(argv[++i]);
    else args.push(argv[i]);
  }
  const [testA, testB, rcA, rcB] = args;
  const a = parse(testA);
  const b = parse(testB);
  const problems = [...a.problems, ...b.problems];
  for (const name of new Set([...a.results.keys(), ...b.results.keys()])) {
    if (a.results.get(name) !== b.results.get(name)) problems.push(`test ${name}: ${a.results.get(name) ?? 'absent'} vs ${b.results.get(name) ?? 'absent'}`);
  }
  let controls = null;
  if (rcA && rcB) {
    const load = (f) => new Map(JSON.parse(readFileSync(f, 'utf8')).map((c) => [c.id, c]));
    const r = compareControls(load(rcA), load(rcB), opts);
    controls = { compared: r.compared, expectedA: opts.expectA?.size ?? null, expectedB: opts.expectB?.size ?? null, collateralDifferences: r.notes };
    problems.push(...r.problems);
  }
  console.log(JSON.stringify({ a: { file: testA, summary: a.summary }, b: { file: testB, summary: b.summary }, testsCompared: new Set([...a.results.keys(), ...b.results.keys()]).size, controls, problems }, null, 2));
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
