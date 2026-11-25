// V2-QA-2: the red-control harness fails closed. A run for a control ID that does not
// exist must not report success: an unknown, mistyped or empty ID, alone or mixed with
// real ones, stops the run before anything executes, naming every unmatched ID. A full
// run must find exactly the expected number of controls, each with a unique ID.
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { assertFullSet, baselineKey, CONTROLS, exactName, tapTests, ControlSelectionError, EXPECTED_CONTROL_COUNT, poolSize, runControls, runVerdict, selectControls, testTimeoutMs } from '../../scripts/red-controls.mjs';
// What the host-safety tests call by name. A namespace: a harness without one of these fails the
// test that needs it, not every test of this file at load.
import * as harness from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';

const SCRIPT = join(REPO, 'scripts/red-controls.mjs');
const run = (...ids) => spawnSync(process.execPath, [SCRIPT, ...ids], { cwd: REPO, encoding: 'utf8', env: { ...process.env, CANON_LOOPBACK_ONLY: '1' } });

// R90 is a real control (fast to run) standing in for "a good ID" in the mixed case.
const GOOD = 'R90';

test('[V2-QA-2] red-controls: unknown, mistyped, mixed and empty IDs exit non-zero, name every unmatched ID and run nothing', () => {
  assert.ok(CONTROLS.some((c) => c.id === GOOD), 'the stand-in good ID exists');
  const cases = [
    ['unknown', ['R999'], ['R999']],
    ['mistyped (case)', ['r71'], ['r71']],
    ['mistyped (padding)', ['R071'], ['R071']],
    ['mixed good and bad', [GOOD, 'R999', 'R4X'], ['R999', 'R4X']],
    ['empty match', [''], ['']],
  ];
  for (const [label, ids, unmatched] of cases) {
    const r = run(...ids);
    assert.notEqual(r.status, 0, `${label}: exit status ${r.status}`);
    for (const id of unmatched) assert.ok(r.stderr.includes(JSON.stringify(id)), `${label}: ${JSON.stringify(id)} is named in: ${r.stderr.trim()}`);
    assert.equal(r.stdout, '', `${label}: nothing ran (no results were written)`);
    if (label.startsWith('mixed')) assert.ok(!r.stderr.includes(JSON.stringify(GOOD)), 'the good ID is not reported as unmatched');
  }
});

test('[V2-QA-2] red-controls: selection is exact, and a selection matching nothing is a failure', () => {
  const controls = [{ id: 'R1' }, { id: 'R2' }];
  assert.deepEqual(selectControls(['R2'], controls).map((c) => c.id), ['R2']);
  assert.throws(() => selectControls(['R1', 'R3', 'R4'], controls), (e) => e instanceof ControlSelectionError && e.details.unmatched.join() === 'R3,R4');
  assert.throws(() => selectControls(['R1'], []), (e) => e instanceof ControlSelectionError && e.details.unmatched.join() === 'R1');
});

test('[V2-QA-2] red-controls: a full run asserts the expected control count and unique IDs', () => {
  assert.doesNotThrow(() => assertFullSet(CONTROLS), `the control set has ${CONTROLS.length} controls; EXPECTED_CONTROL_COUNT is ${EXPECTED_CONTROL_COUNT}`);
  assert.throws(() => assertFullSet(CONTROLS.slice(1)), (e) => e instanceof ControlSelectionError && e.details.count === CONTROLS.length - 1, 'a lost control fails the full run');
  assert.throws(() => assertFullSet([...CONTROLS.slice(1), CONTROLS[1]]), (e) => e instanceof ControlSelectionError && e.details.duplicates.join() === CONTROLS[1].id, 'a duplicated ID fails the full run');
  assert.throws(() => selectControls([], CONTROLS.slice(1)), ControlSelectionError, 'a full selection checks the count');
});


// V2-QA-5: a scratch copy that vanishes at ANY phase makes its control NOT red and the run
// fail, while every other result is kept. Deletion is done either through the harness's
// own hooks or by an external watcher process (like QA's attack), always inside a private
// TMPDIR this test creates, so only this run's own copies are ever removed.
const FIXTURE = { id: 'FIXTURE-INERT', rows: ['harness'], file: 'test/harness-fixtures/target.txt', find: 'pristine', replace: 'MUTATED', tests: ['test/harness-fixtures/vanish.test.mjs'], intends: ['harness fixture: an inert check that only a vanished copy can fail'], defect: 'an inert mutation no test can catch' };
const R90 = CONTROLS.find((c) => c.id === 'R90');

async function inPrivateTmp(fn) {
  const saved = process.env.TMPDIR;
  const priv = await mkdtemp(join(tmpdir(), 'canon-harness-test-'));
  process.env.TMPDIR = priv;
  try {
    return await fn(priv);
  } finally {
    process.env.TMPDIR = saved;
    if (saved === undefined) delete process.env.TMPDIR;
    await rm(priv, { recursive: true, force: true });
  }
}

// An external process that acts on the first scratch copy under `priv` that raises the
// fixture's signal, recording the copy's path. 'delete' removes the whole copy; 'truncate'
// empties the fixture's target file and 'modify' rewrites it with the same length (so
// only a content check, not a size check, sees it); both then clear the signal.
const TARGET = 'test/harness-fixtures/target.txt';
// Synchronized by signals, never by wall-clock time (R152: a 10 s fixture wait and a 60 s
// watcher self-exit made the baseline intermittently red under load). The watcher prints
// "ready" once it is polling, and the caller waits for that before starting the run. It
// lives until it has acted, or until the caller stops it, or until `priv` is gone. It
// prints the path it acted on, then exits 0.
function watcher(priv, action = 'delete') {
  const act = action === 'delete'
    // Atomic from the run's point of view: one rename takes the whole copy away at once (its
    // signal included), then the renamed tree, which nothing else writes to, is deleted. A plain
    // recursive rm could drop the signal first and race the harness's next write (ENOTEMPTY).
    ? "const g=p.join(d,'gone-'+n);fs.renameSync(c,g);fs.rmSync(g,{recursive:true,force:true});"
    : `const f=p.join(c,${JSON.stringify(TARGET)});const b=fs.readFileSync(f);fs.writeFileSync(f,${action === 'truncate' ? "''" : "'x'.repeat(b.length)"});fs.rmSync(p.join(c,'.canon-vanish-now'));`;
  const src = `const fs=require('node:fs'),p=require('node:path');const d=${JSON.stringify(priv)};const scan=()=>{let names;try{names=fs.readdirSync(d);}catch{process.exit(3);}for(const n of names){const c=p.join(d,n);if(n.startsWith('canon-red-')&&fs.existsSync(p.join(c,'.canon-vanish-now'))){${act}console.log(c);clearInterval(t);process.exit(0);}}};const t=setInterval(scan,20);scan();console.log('ready');`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  child.stdout.on('data', (b) => { out += b; if (/^ready$/m.test(out)) markReady(); });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => { markReady(); resolve({ code, signal, removed: out.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'ready').at(-1) ?? '' }); }));
  // Stop the watcher if it is still running (it never acted), then report how it ended.
  const finish = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); return done; };
  return { ready, finish };
}

async function runWith({ phase, hooks = {} }) {
  if (phase) process.env.CANON_TEST_VANISH_PHASE = phase;
  try {
    return await runControls([FIXTURE.id, 'R90'], { controls: [FIXTURE, R90], ...hooks });
  } finally {
    delete process.env.CANON_TEST_VANISH_PHASE;
  }
}

test('[V2-QA-5] untouched: the inert fixture is not red, R90 is red', async () => {
  await inPrivateTmp(async () => {
    const results = await runWith({});
    assert.equal(results[0].wentRed, false, 'an inert mutation is never red');
    assert.equal(results[0].vanished, undefined);
    assert.equal(results[1].wentRed, true);
  });
});

for (const [phase, how] of [['prepare', 'hook'], ['baseline', 'watcher'], ['mutated run', 'watcher'], ['cleanup', 'hook']]) {
  test(`[V2-QA-5] a copy deleted during ${phase} (${how}): that control is not red, the run fails, R90's result survives`, async () => {
    await inPrivateTmp(async (priv) => {
      let results;
      let removed = null;
      if (how === 'watcher') {
        const w = watcher(priv);
        await w.ready;
        results = await runWith({ phase: phase === 'baseline' ? 'baseline' : 'mutated' });
        const done = await w.finish();
        assert.equal(done.code, 0, 'the watcher removed a copy');
        removed = done.removed;
      } else if (phase === 'prepare') {
        results = await runWith({ hooks: { afterPrepare: async (dir, c) => { if (c.id === FIXTURE.id) { removed = dir; await rm(dir, { recursive: true, force: true }); } } } });
      } else {
        results = await runWith({ hooks: { beforeCleanup: async (dir, c) => { if (c.id === FIXTURE.id) { removed = dir; await rm(dir, { recursive: true, force: true }); } } } });
      }
      assert.ok(removed && removed.startsWith(priv), 'only a copy under this test\'s private TMPDIR was removed');
      assert.deepEqual(results.map((r) => r.id), [FIXTURE.id, 'R90'], 'every control has a result');
      const lost = results[0];
      assert.equal(lost.wentRed, false, 'a vanished copy is never red');
      assert.equal(lost.vanished?.phase, phase, `recorded as vanished during ${phase}`);
      assert.ok(lost.warnings.length > 0);
      assert.equal(results[1].wentRed, true, 'R90 still ran and went red');
      const verdict = runVerdict(results);
      assert.equal(verdict.ok, false, 'the run fails');
      assert.ok(verdict.problems.some((p) => p.includes('vanished')));
    });
  });
}

test('[V2-QA-5] a RED control whose copy vanishes at cleanup is reported not red, and the run fails', async () => {
  await inPrivateTmp(async () => {
    const results = await runControls(['R90'], { controls: [R90], beforeCleanup: async (dir) => rm(dir, { recursive: true, force: true }) });
    assert.equal(results[0].broken.exitCode, 1, 'the mutated run itself failed as intended');
    assert.equal(results[0].wentRed, false, 'but a vanished copy at cleanup withdraws the red');
    assert.equal(results[0].vanished.phase, 'cleanup');
    assert.equal(runVerdict(results).ok, false);
  });
});

// V2-QA-5 addendum (QA s7, R32): a control is red only at its intended assertion.
test('[V2-QA-5] every control names its intended assertion(s)', () => {
  const missing = CONTROLS.filter((c) => !Array.isArray(c.intends) || !c.intends.length || c.intends.some((n) => typeof n !== 'string' || !n.trim())).map((c) => c.id);
  assert.deepEqual(missing, []);
});

test('[V2-QA-5] a control that fails only at an unintended assertion is not red, and the run fails', async () => {
  await inPrivateTmp(async () => {
    // Since PERF-1 the mutated run executes only the intended tests, so "failed elsewhere" means the
    // run failed without the intended test failing: here the mutated test file no longer loads.
    const CRASH = 'test/unit/zz-planted-crash.test.mjs';
    const plantCrash = async (dir) => {
      await writeFile(join(dir, CRASH), `import test from 'node:test';\nimport { readFileSync } from 'node:fs';\nif (readFileSync(new URL('../harness-fixtures/target.txt', import.meta.url), 'utf8').includes('MUTATED')) throw new Error('the mutated file does not load');\ntest(${JSON.stringify(NAMED)}, () => {});\n`);
    };
    const results = await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl([NAMED]), tests: [CRASH] }], afterPrepare: plantCrash });
    assert.equal(results[0].baseline.exitCode, 0, 'the baseline is green');
    assert.equal(results[0].broken.exitCode, 1, 'its tests did fail');
    assert.deepEqual(results[0].intendedFailed, []);
    assert.equal(results[0].wentRed, false, 'but not at the intended assertion, so not red');
    const verdict = runVerdict(results);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes('not at its intended assertion')));
    // The intended test fails, but a second test file stops loading under the mutation: that
    // failure is not an intended one, so the control is still not red.
    const [both] = await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl([NAMED]), tests: [PLANT_TEST, CRASH] }], afterPrepare: async (dir) => { await plantNames(dir); await plantCrash(dir); await writeFile(join(dir, CRASH), (await readFile(join(dir, CRASH), 'utf8')).replace(JSON.stringify(NAMED), "'[P] in the file that stops loading'")); } });
    assert.deepEqual([both.baseline.exitCode, both.intendedFailed, both.wentRed], [0, [NAMED], false], JSON.stringify(both.broken));
    assert.ok(runVerdict([both]).problems.some((p) => p.includes('did not run exactly its intended tests') && p.includes(CRASH)), JSON.stringify(runVerdict([both]).problems));
  });
});

// V2-QA-6 (b): a copy MODIFIED or TRUNCATED at any phase (not only one that vanished) makes
// its control not red and the run fail. The fixture's intended check fails on either, for
// the wrong reason, which must never count as red.
async function tamper(dir, action) {
  const f = join(dir, TARGET);
  const b = await readFile(f);
  await writeFile(f, action === 'truncate' ? '' : 'x'.repeat(b.length));
}
for (const action of ['truncate', 'modify']) {
  for (const [phase, how] of [['prepare', 'hook'], ['baseline', 'watcher'], ['mutated run', 'watcher'], ['cleanup', 'hook']]) {
    test(`[V2-QA-6] a copy ${action === 'truncate' ? 'truncated' : 'modified (same size)'} during ${phase} (${how}): that control is not red, and the run fails`, async () => {
      await inPrivateTmp(async (priv) => {
        let results;
        let touched = null;
        const env = process.env.CANON_TEST_VANISH_PHASE;
        if (how === 'watcher') {
          const w = watcher(priv, action);
          await w.ready;
          process.env.CANON_TEST_VANISH_PHASE = phase === 'baseline' ? 'baseline' : 'mutated';
          try {
            results = await runControls([FIXTURE.id], { controls: [FIXTURE] });
          } finally {
            if (env === undefined) delete process.env.CANON_TEST_VANISH_PHASE;
            else process.env.CANON_TEST_VANISH_PHASE = env;
          }
          const done = await w.finish();
          assert.equal(done.code, 0, 'the watcher acted on a copy');
          touched = done.removed;
        } else {
          const hook = async (dir) => { touched = dir; await tamper(dir, action); };
          results = await runControls([FIXTURE.id], { controls: [FIXTURE], ...(phase === 'prepare' ? { afterPrepare: hook } : { beforeCleanup: hook }) });
        }
        assert.ok(touched && touched.startsWith(priv), 'only a copy under this test\'s private TMPDIR was touched');
        assert.equal(results[0].wentRed, false, 'a tampered copy is never red');
        assert.equal(results[0].modified?.phase, phase, `recorded as modified during ${phase}`);
        assert.equal(results[0].vanished, undefined, 'nothing vanished');
        const verdict = runVerdict(results);
        assert.equal(verdict.ok, false, 'the run fails');
        assert.ok(verdict.problems.some((p) => p.includes('modified during')));
      });
    });
  }
}

test('[V2-QA-6] a RED control whose copy is modified at cleanup is reported not red, and the run fails', async () => {
  await inPrivateTmp(async () => {
    const results = await runControls(['R90'], { controls: [R90], beforeCleanup: async (dir) => { const f = join(dir, R90.file); await writeFile(f, `${await readFile(f, 'utf8')}\n`); } });
    assert.equal(results[0].broken.exitCode, 1, 'the mutated run itself failed as intended');
    assert.equal(results[0].wentRed, false, 'but a modified copy at cleanup withdraws the red');
    assert.equal(results[0].modified.phase, 'cleanup');
    assert.equal(runVerdict(results).ok, false);
  });
});

test('[V2-QA-5] runVerdict: all red with no warnings passes; any warning, vanish, error, gap or empty run fails', () => {
  const red = { id: 'A', wentRed: true, warnings: [] };
  assert.equal(runVerdict([red]).ok, true);
  assert.equal(runVerdict([{ ...red, warnings: ['x'] }]).ok, false);
  assert.equal(runVerdict([{ ...red, vanished: { phase: 'cleanup' } }]).ok, false);
  assert.equal(runVerdict([{ ...red, modified: { phase: 'baseline' } }]).ok, false);
  assert.equal(runVerdict([{ ...red, error: 'boom' }]).ok, false);
  assert.equal(runVerdict([red], 2).ok, false);
  assert.equal(runVerdict([]).ok, false);
  assert.equal(runVerdict([{ ...red, broken: { exitCode: 1 }, intendedFailed: [] }]).ok, false);
  assert.equal(runVerdict([{ ...red, broken: { exitCode: 1 }, intendedFailed: ['t'] }]).ok, true);
});

// V2.1-04: TAP escapes `#` and `\` in a test's description, so a test named "… PKCS#8" is
// reported as "… PKCS\#8". The harness must read it back as the real name, or an intended test
// whose name holds `#` can never match, and its control reads "not red" although it failed.
test('[V2.1-04] the harness reads failing test names through TAP escaping (# and \\)', async () => {
  const { tapFailures } = await import('../../scripts/red-controls.mjs');
  const out = ['TAP version 13', 'not ok 1 - [V2.1-04] as raw PKCS\\#8', 'ok 2 - fine', 'not ok 3 - a back\\\\slash and \\# both', '# tests 3'].join('\n');
  assert.deepEqual(tapFailures(out), ['[V2.1-04] as raw PKCS#8', 'a back\\slash and # both']);
});

// Integration item I-2 (AP.8): the runner itself refuses a control whose find text is not in its
// file exactly once. With two occurrences it would change the first, which need not be the line the
// control was written for, and report a baseline that proves nothing; with none it has nothing to
// change. The refusal comes before any copy is made, and names every such control.
test('[H-8.I2] red-controls: a run refuses, before it prepares anything, a control whose find text is not in its file exactly once', async () => {
  let prepared = 0;
  const hooks = { afterPrepare: async () => { prepared += 1; } };
  const twice = { ...FIXTURE, id: 'X-TWICE', file: 'package.json', find: '"' };
  const nowhere = { ...FIXTURE, id: 'X-NOWHERE', find: 'a text the fixture file does not hold' };
  const missing = { ...FIXTURE, id: 'X-MISSING', file: 'test/harness-fixtures/no-such-file.txt' };
  for (const [bad, said] of [[twice, /X-TWICE: its find occurs \d+ times in package\.json/], [nowhere, /X-NOWHERE: its find occurs 0 times/], [missing, /X-MISSING: its find occurs nowhere \(file missing\)/]]) {
    // Refused even when the other selected control is sound: nothing of the selection runs.
    await assert.rejects(runControls([FIXTURE.id, bad.id], { controls: [FIXTURE, bad], ...hooks }), (e) => e instanceof ControlSelectionError && said.test(e.message), bad.id);
  }
  await assert.rejects(runControls([twice.id, nowhere.id], { controls: [twice, nowhere], ...hooks }), (e) => /X-TWICE/.test(e.message) && /X-NOWHERE/.test(e.message), 'every such control is named');
  assert.equal(prepared, 0, 'no scratch copy was made for a refused selection');
  // A control that is not selected does not stop a run of the ones that are.
  const results = await runControls([FIXTURE.id], { controls: [FIXTURE, twice], ...hooks });
  assert.deepEqual([results.length, prepared], [1, 1]);
});

// PERF-1 and host safety: no test or helper process may outlive its control or the run, and the
// harness stops only what it can prove it started. The plants are test files written into the
// control's own copy (adding a file is allowed) that start a process and leave it. Each plant RECORDS
// its stand-in's pid and start time when it starts it (CANON_TEST_LEAKS, a file outside the copy), and
// this file signals a stand-in only through that record, the pid's start time read again first.
const leakTest = (options, program = "'/usr/bin/perl', ['-e', 'for (1 .. 900) { last unless -d $ARGV[0]; sleep 1 }', process.env.CANON_TEST_IDLE.slice(0, process.env.CANON_TEST_IDLE.lastIndexOf('/'))]") => `import test from 'node:test';\nimport { spawn, spawnSync } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\ntest('[plant] leaves a process running', () => { const c = spawn(${program}, ${options}); c.unref(); const start = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(c.pid)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim().replace(/\\s+/g, ' '); appendFileSync(process.env.CANON_TEST_LEAKS, JSON.stringify({ pid: c.pid, start }) + '\\n'); });\n`;
const LEAK = 'test/unit/zz-planted-leak.test.mjs';
// This file's own reading of a start time: /bin/ps by path, in one fixed locale and time zone.
const startOf = (pid) => { const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }); return r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : ''; };
const sameProcess = (p) => Boolean(p?.start) && startOf(p.pid) === p.start;
// Runs `fn` with a fresh record file; whatever recorded stand-in is still alive afterwards is stopped
// here, by its record only. While `fn` runs, every signal this process is asked to send goes through
// withKillSpy (below): only a recorded stand-in can be reached, whatever the harness under test aims at.
const withRecords = async (fn) => inPrivateTmp(async (priv) => {
  const file = join(priv, 'leaks.jsonl');
  await writeFile(file, '');
  const saved = process.env.CANON_TEST_LEAKS;
  process.env.CANON_TEST_LEAKS = file;
  // The idle stand-in program (lead 2026-10-06 05:12Z): it ends by itself, with no signal, within a
  // second of this test's private directory being removed, and after 900 s at the latest. So no
  // stand-in ends while a wait still depends on it, and none can outlive its test.
  const idle = join(priv, 'idle.cjs');
  await writeFile(idle, "const fs = require('node:fs'); const home = __dirname; setInterval(() => { if (!fs.existsSync(home)) process.exit(0); }, 1000); setTimeout(() => process.exit(0), 900000);\n");
  const savedIdle = process.env.CANON_TEST_IDLE;
  process.env.CANON_TEST_IDLE = idle;
  const recorded = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const alive = () => recorded().filter(sameProcess);
  try {
    return await fn({ recorded, alive });
  } finally {
    for (const p of alive()) if (sameProcess(p)) try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
    if (saved === undefined) delete process.env.CANON_TEST_LEAKS; else process.env.CANON_TEST_LEAKS = saved;
    if (savedIdle === undefined) delete process.env.CANON_TEST_IDLE; else process.env.CANON_TEST_IDLE = savedIdle;
  }
});
const withLeaks = (fn) => withRecords((records) => withKillSpy(records.recorded, () => fn(records)));

test('[PERF-1] a control whose unmutated tests leave a process in their group is not red, the run fails, and the process is stopped', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    const results = await runControls(['R90'], { controls: [{ ...R90, tests: [...R90.tests, LEAK] }], afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore' }")) });
    const [r] = results;
    assert.equal(r.baseline.exitCode, 0, 'the baseline itself is green');
    assert.ok(r.leftBehind.baseline >= 1, `the baseline's leftover is counted (${JSON.stringify(r.leftBehind)})`);
    assert.equal(r.wentRed, false);
    const verdict = runVerdict(results);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => /R90: the unmutated tests left \d+ process\(es\) running/.test(p)), JSON.stringify(verdict.problems));
    assert.ok(recorded().length >= 1, 'the plant did start and record its stand-in');
    assert.deepEqual(alive(), [], 'nothing of the control is left running: its held group was ended from inside');
    // The leftover is seen right after the baseline, before that baseline could be handed on.
    const pair = twins(2).map((c) => ({ ...c, tests: [...c.tests, LEAK] }));
    const both = await runControls(ids(pair), { controls: pair, jobs: 1, afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore' }")) });
    assert.deepEqual(both.map((r) => [r.baselineReusedFrom ?? null, r.leftBehind.baseline >= 1, r.wentRed]), [[null, true, false], [null, true, false]], 'a baseline that left a process is never offered to the next control');
  });
});

test('[HOST-SAFETY] a process that left its group and is found only by its working directory is reported and counted and is NOT stopped: the control is not red and the run fails', async () => {
  // A detached stand-in with the run token stripped from its own environment: it carries no proof
  // and names no copy by command line, so neither proof holds (the token is removed explicitly here,
  // not left to a host's own process-introspection restrictions, which vary by machine and are not
  // this test's business). The harness may not stop what it cannot prove it started.
  await withLeaks(async ({ recorded, alive }) => {
    const results = await runControls(['R90'], { controls: [{ ...R90, tests: [...R90.tests, LEAK] }], afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore', detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }")) });
    const [r] = results;
    const mine = recorded();
    assert.ok(mine.length >= 1, 'the plant did start and record its stand-in');
    assert.ok(r.strays?.some((s) => s.phase === 'run end' && /^cwd /.test(s.command) && s.signalled === false && mine.some((p) => p.pid === s.pid && p.start === s.start)), `the run-end sweep names it by its working directory, with its pid and start time (${JSON.stringify(r.strays)})`);
    assert.equal(r.wentRed, false);
    const verdict = runVerdict(results);
    assert.ok(verdict.problems.some((p) => /R90: \d+ stray process\(es\) outlived the control/.test(p)), JSON.stringify(verdict.problems));
    assert.ok(verdict.problems.some((p) => /R90: a process found by path only was NOT stopped \(pid \d+, started /.test(p)), 'the verdict says it was not stopped');
    assert.deepEqual(alive().map((p) => p.pid).sort(), mine.map((p) => p.pid).sort(), 'the harness did not signal it: it is still running when the run returns');
  });
});

test('[HOST-SAFETY] a server that left its group but carries the run token and sits in the copy is proven the run\'s and is stopped; one that carries no token is not', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    // A detached NODE process started by the control's test: it inherits the test run's token, and
    // its working directory is the copy.
    const daemon = "process.execPath, [process.env.CANON_TEST_IDLE]";
    const results = await runControls(['R90'], { controls: [{ ...R90, tests: [...R90.tests, LEAK] }], afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore', detached: true }", daemon)) });
    assert.ok(recorded().length >= 1, 'the plant did start and record its stand-in');
    assert.deepEqual(alive(), [], 'the token carrier in the copy was stopped');
    assert.ok(results[0].leftBehind.baseline >= 1, `and counted (${JSON.stringify(results[0].leftBehind)})`);
    assert.equal(results[0].wentRed, false, 'an unmutated run that leaves a process is not red');
    // The same program with the same working directory, started with the token taken out of its
    // environment: nothing proves it, so it is reported and left alone (lead condition, 2026-10-05).
    const before = recorded().length;
    const stripped = await runControls(['R90'], { controls: [{ ...R90, tests: [...R90.tests, LEAK] }], afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore', detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }", daemon)) });
    const mine = recorded().slice(before);
    assert.ok(mine.length >= 1);
    assert.deepEqual(alive().map((p) => p.pid).sort(), mine.map((p) => p.pid).sort(), 'the one without the token was not signalled');
    assert.ok(stripped[0].strays?.some((s) => s.signalled === false && mine.some((p) => p.pid === s.pid)), JSON.stringify(stripped[0].strays));
    // The token is never written to a result.
    assert.ok(!/CANON_RED_RUN=/.test(JSON.stringify([results, stripped])), 'no result carries the token variable');
  });
});

test('[PERF-1] a clean control leaves nothing and reports it; runVerdict refuses a baseline leftover and a stray on an otherwise red result', async () => {
  const results = await runControls(['R90'], { controls: [R90] });
  assert.deepEqual(results[0].leftBehind, { baseline: 0, mutated: 0 });
  assert.equal(results[0].strays, undefined);
  assert.equal(runVerdict(results).ok, true);
  const red = { id: 'R1', wentRed: true, warnings: [], leftBehind: { baseline: 0, mutated: 2 } };
  assert.equal(runVerdict([red]).ok, true, 'a mutated run whose leftovers were stopped is still red');
  assert.deepEqual(runVerdict([{ ...red, leftBehind: { baseline: 1, mutated: 0 } }]).problems, ['R1: the unmutated tests left 1 process(es) running']);
  assert.deepEqual(runVerdict([{ ...red, strays: [{ pid: 1, command: 'x' }] }]).problems, ['R1: 1 stray process(es) outlived the control']);
});

// PERF-1: a baseline is run once per identical (tests, copy, Node) within a run, and never reused
// across any difference in its inputs.
const twins = (n) => Array.from({ length: n }, (_, i) => ({ ...R90, id: `R90-${i + 1}` }));
const ids = (controls) => controls.map((c) => c.id);

test('[PERF-1] a second control with the same tests on an identical copy reuses the first green baseline, and both are still red at intent', async () => {
  const controls = twins(3);
  const results = await runControls(ids(controls), { controls, jobs: 1 });
  assert.deepEqual(results.map((r) => r.baselineReusedFrom ?? null), [null, 'R90-1', 'R90-1'], 'one baseline run, two reuses');
  assert.deepEqual(results.map((r) => [r.aloneReusedFrom ?? null, r.intendedAlone]), [[null, true], ['R90-1', true], ['R90-1', true]], 'the intended tests ran alone once, unmutated, and the twins reuse that run');
  for (const r of results) assert.deepEqual([r.wentRed, r.baseline.exitCode, r.intendedFailed.length > 0, r.mutationApplied], [true, 0, true, true], `${r.id} is red at intent on a green baseline`);
  assert.deepEqual(results[1].baseline, results[0].baseline, 'the reused baseline is the first one, unchanged');
  assert.equal(runVerdict(results).ok, true);
  const fresh = await runControls(ids(controls.slice(0, 2)), { controls: controls.slice(0, 2), jobs: 1, reuseBaselines: false });
  assert.deepEqual(fresh.map((r) => r.baselineReusedFrom ?? null), [null, null], 'with reuse off every control runs its own baseline');
});

test('[PERF-1] a baseline is not reused when the copy differs by an added file, a changed file or the tests, nor when the first baseline was red', async () => {
  const controls = twins(2);
  const second = (hook) => async (dir, c) => { if (c.id === 'R90-2') await hook(dir); };
  const added = await runControls(ids(controls), { controls, jobs: 1, afterPrepare: second((dir) => writeFile(join(dir, 'test/zz-added-helper.txt'), 'x')) });
  assert.deepEqual(added.map((r) => r.baselineReusedFrom ?? null), [null, null], 'a file added to the copy gives another key');
  assert.equal(added[1].wentRed, true, 'adding a file is allowed, and the control ran its own baseline');
  const changed = await runControls(ids(controls), { controls, jobs: 1, afterPrepare: second(async (dir) => { const f = join(dir, 'README.md'); await writeFile(f, `${await readFile(f, 'utf8').catch(() => '')}\n`); }) });
  assert.equal(changed[1].baselineReusedFrom, undefined, 'a changed copy is never keyed');
  const otherTests = [controls[0], { ...controls[1], tests: [...R90.tests, R90.tests[0]] }];
  assert.deepEqual((await runControls(ids(otherTests), { controls: otherTests, jobs: 1 })).map((r) => r.baselineReusedFrom ?? null), [null, null], 'another test list gives another key');
  const RED = 'test/unit/zz-planted-red.test.mjs';
  const red = controls.map((c) => ({ ...c, tests: [...c.tests, RED] }));
  const failing = await runControls(ids(red), { controls: red, jobs: 1, afterPrepare: (dir) => writeFile(join(dir, RED), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('[plant] red', () => assert.fail('planted'));\n") });
  assert.deepEqual(failing.map((r) => [r.baseline.exitCode !== 0, r.baselineReusedFrom ?? null, r.wentRed]), [[true, null, false], [true, null, false]], 'a red baseline is never offered on: each control sees its own');
  const files = new Map([['a.mjs', 'h1'], ['b.mjs', 'h2']]);
  const key = baselineKey(['t.test.mjs'], files);
  assert.equal(baselineKey(['t.test.mjs'], new Map([['b.mjs', 'h2'], ['a.mjs', 'h1']])), key, 'the key does not depend on walk order');
  for (const [name, tests, other] of [['a changed hash', ['t.test.mjs'], new Map([['a.mjs', 'h1'], ['b.mjs', 'hX']])], ['a renamed file', ['t.test.mjs'], new Map([['a.mjs', 'h1'], ['c.mjs', 'h2']])], ['an added file', ['t.test.mjs'], new Map([...files, ['c.mjs', 'h3']])], ['a removed file', ['t.test.mjs'], new Map([['a.mjs', 'h1']])], ['another test', ['u.test.mjs'], files]]) assert.notEqual(baselineKey(tests, other), key, name);
  assert.notEqual(baselineKey(['t.test.mjs', 'u.test.mjs'], files), baselineKey(['u.test.mjs', 't.test.mjs'], files), 'the order of the test list is part of the key');
});

test('[PERF-1] the worker pool: size from cores and load, results in selection order, never more controls at once than the size, one baseline per key', async () => {
  assert.deepEqual([poolSize('auto', 18, 5), poolSize('auto', 18, 40), poolSize('auto', 4, 0), poolSize('auto', 64, 0), poolSize('auto', 2, 0), poolSize(3, 18, 99), poolSize('1', 18, 0)], [4, 1, 1, 6, 1, 3, 1], 'auto is a quarter of the cores, at most 6, and 1 on a loaded host; a number is taken as given');
  for (const bad of [0, -1, 1.5, 'many', '']) assert.throws(() => poolSize(bad, 18, 0), ControlSelectionError, `jobs ${JSON.stringify(bad)} is refused`);
  const controls = twins(4);
  for (const [jobs, atMost, atLeast] of [[1, 1, 1], [3, 3, 2]]) {
    let active = 0;
    let peak = 0;
    const results = await runControls(ids(controls), { controls, jobs, afterPrepare: async () => { active += 1; peak = Math.max(peak, active); }, beforeCleanup: async () => { active -= 1; } });
    assert.deepEqual(results.map((r) => r.id), ids(controls), `jobs ${jobs}: results are in selection order`);
    assert.ok(peak <= atMost && peak >= atLeast, `jobs ${jobs}: at most ${atMost} controls at once (peak ${peak})`);
    assert.equal(results.filter((r) => !r.baselineReusedFrom).length, 1, `jobs ${jobs}: one baseline run for one key, even when controls start together`);
    assert.equal(runVerdict(results, controls.length).ok, true, `jobs ${jobs}: all red`);
  }
});

// PERF-1: the mutated run executes only the intended tests, and must prove that exactly those ran.
// The plant is a test file written into the control's own copy; its target is the committed fixture,
// because a run refuses a control whose find is not in its file in the repository (I-2, I-6).
const PLANT_TARGET = TARGET;
const PLANT_TEST = 'test/unit/zz-planted-names.test.mjs';
const NAMED = '[P] exact (one) a+b? #1 [x] ^$ {2} a|b \\d';
const plantNames = async (dir) => {
  await writeFile(join(dir, PLANT_TEST), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nconst pristine = () => assert.match(readFileSync(new URL('../harness-fixtures/target.txt', import.meta.url), 'utf8'), /pristine/);\ntest(${JSON.stringify(NAMED)}, pristine);\ntest(${JSON.stringify(`${NAMED} and more`)}, pristine);\ntest('[P] another that breaks', pristine);\ntest('[P] stays green', () => {});\n`);
};
const plantControl = (intends) => ({ id: 'PLANT-NAMES', rows: ['harness'], file: PLANT_TARGET, find: 'pristine', replace: 'MUTATED', tests: [PLANT_TEST], intends, defect: 'a planted defect three of the four planted tests catch' });
const runPlant = async (intends) => (await runControls(['PLANT-NAMES'], { controls: [plantControl(intends)], afterPrepare: plantNames, jobs: 1 }))[0];

test('[PERF-1] the mutated run executes exactly the intended tests, by whole name with every pattern character literal, and nothing else', async () => {
  const one = await runPlant([NAMED]);
  assert.deepEqual([one.wentRed, one.ranIntended, one.broken.ran, one.intendedFailed, one.broken.failed], [true, true, [NAMED], [NAMED], [NAMED]], 'only the named test ran: not its longer sibling, not the other failing test');
  assert.equal(one.baseline.pass, 4, 'the baseline still runs the whole file');
  assert.deepEqual([one.intendedAlone, one.alone.ran, one.alone.failed], [true, [NAMED], []], 'and before the mutation the intended test ran alone and passed');
  // A second test file that holds none of the intended tests ran nothing: it is not counted as a test.
  const OTHER = 'test/unit/zz-planted-other.test.mjs';
  const [wide] = await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl([NAMED]), tests: [PLANT_TEST, OTHER] }], afterPrepare: async (dir) => { await plantNames(dir); await writeFile(join(dir, OTHER), `import test from 'node:test';\ntest('[P] elsewhere', () => {});\n`); }, jobs: 1 });
  assert.deepEqual([wide.wentRed, wide.ranIntended, wide.broken.ran, wide.intendedFailed], [true, true, [NAMED], [NAMED]], `a file with no intended test does not unmake the control (${JSON.stringify(wide.broken)})`);
  assert.equal(wide.baseline.pass, 5, 'the baseline ran both files');
  const two = await runPlant([NAMED, '[P] another that breaks']);
  assert.deepEqual([two.wentRed, [...two.broken.ran].sort()], [true, [NAMED, '[P] another that breaks'].sort()]);
  assert.equal(new RegExp(exactName(NAMED)).test(NAMED), true);
  for (const other of [`${NAMED} and more`, ` ${NAMED}`, NAMED.replace('a+b', 'aab'), NAMED.replace('(one)', 'one'), NAMED.replace('\\d', '7')]) assert.equal(new RegExp(exactName(NAMED)).test(other), false, `the pattern does not match ${JSON.stringify(other)}`);
  assert.deepEqual(tapTests('ok 1 - a\nnot ok 2 - b \\#1 c\\\\d\nok 3 - skipped one # SKIP because\n    ok 1 - nested\n# pass 2\n'), [{ name: 'a', ok: true }, { name: 'b #1 c\\d', ok: false }, { name: 'skipped one', ok: true }], 'top-level tests only, names unescaped');
});

test('[PERF-1] a control is not red when its pattern matches nothing, matches another test, or an intended test does not fail', async () => {
  const cases = [
    ['an intended name that no test has', ['[P] no such test'], /did not run exactly its intended tests/],
    ['a prefix of real names', ['[P] exact (one) a+b? #1'], /did not run exactly its intended tests/],
    ['one real and one missing name', [NAMED, '[P] no such test'], /did not run exactly its intended tests/],
    ['an intended test that stays green', [NAMED, '[P] stays green'], /1 intended test\(s\) did not fail/],
    ['an intended name that two test files share', [NAMED], /did not run exactly its intended tests \(ran \[.*,.*\]\)/, true],
  ];
  const TWIN = 'test/unit/zz-planted-names-twin.test.mjs';
  for (const [name, intends, why, twin] of cases) {
    const r = twin
      ? (await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl(intends), tests: [PLANT_TEST, TWIN] }], afterPrepare: async (dir) => { await plantNames(dir); await writeFile(join(dir, TWIN), await readFile(join(dir, PLANT_TEST), 'utf8')); }, jobs: 1 }))[0]
      : await runPlant(intends);
    assert.equal(r.wentRed, false, `${name}: not red (${JSON.stringify(r.broken)})`);
    const verdict = runVerdict([r]);
    assert.ok(verdict.problems.some((p) => why.test(p)), `${name}: ${JSON.stringify(verdict.problems)}`);
  }
  const none = await runPlant(['[P] no such test']);
  assert.ok(!none.broken.ran.includes('[P] no such test') && none.ranIntended === false, `a pattern that matches nothing is seen (ran ${JSON.stringify(none.broken.ran)})`);
  const red = { id: 'R1', wentRed: true, warnings: [], intends: ['a', 'b'], intendedFailed: ['a', 'b'], ranIntended: true, broken: { exitCode: 1, ran: ['a', 'b'], failed: ['a', 'b'] } };
  assert.equal(runVerdict([red]).ok, true);
  assert.deepEqual(runVerdict([{ ...red, ranIntended: false, broken: { ...red.broken, ran: ['a', 'c'] } }]).problems, ['R1: the mutated run did not run exactly its intended tests (ran ["a","c"])']);
  assert.deepEqual(runVerdict([{ ...red, intendedFailed: ['a'] }]).problems, ['R1: 1 intended test(s) did not fail']);
});

// QA OD-1: the mutated run executes the intended tests alone, so they must pass alone unmutated.
test('[PERF-1] a control whose intended test does not pass alone on the unmutated copy is not red, even though it fails alone after the mutation', async () => {
  const DEP = 'test/unit/zz-planted-dependent.test.mjs';
  const NEEDS = '[P] needs the test before it';
  const plantDependent = async (dir) => {
    await writeFile(join(dir, DEP), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nlet ready = false;\ntest('[P] sets up', () => { ready = true; });\ntest(${JSON.stringify(NEEDS)}, () => assert.ok(ready, 'the earlier test did not run'));\n`);
  };
  // The mutation is inert for this test: it never reads the target.
  const [r] = await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl([NEEDS]), tests: [DEP] }], afterPrepare: plantDependent, jobs: 1 });
  assert.deepEqual([r.baseline.exitCode, r.baseline.pass], [0, 2], 'the whole file is green in sequence');
  assert.deepEqual([r.intendedAlone, r.alone.ran, r.alone.failed], [false, [NEEDS], [NEEDS]], 'alone, unmutated, the intended test fails');
  assert.deepEqual([r.ranIntended, r.intendedFailed], [true, [NEEDS]], 'and it fails alone after the mutation too, which proves nothing');
  assert.equal(r.wentRed, false);
  const verdict = runVerdict([r]);
  assert.ok(verdict.problems.some((p) => p.startsWith('PLANT-NAMES: its intended tests do not pass alone on the unmutated copy')), JSON.stringify(verdict.problems));
  // The unmutated alone-run is shared only between controls with the same copy AND the same names.
  const pair = [{ ...plantControl([NAMED]), id: 'PLANT-A' }, { ...plantControl([NAMED, '[P] another that breaks']), id: 'PLANT-B' }];
  const both = await runControls(['PLANT-A', 'PLANT-B'], { controls: pair, afterPrepare: plantNames, jobs: 1 });
  assert.deepEqual(both.map((x) => [x.baselineReusedFrom ?? null, x.aloneReusedFrom ?? null, x.intendedAlone, x.wentRed]), [[null, null, true, true], ['PLANT-A', null, true, true]], 'other intended names get their own unmutated alone-run');
});

// QA BR-2: a baseline is handed on before the run-end sweep can see a process that left its group.
test('[PERF-1] a stray found only at run end unmakes every control that reused its owner\'s unmutated run', async () => {
  await withLeaks(async ({ recorded, alive }) => {
  const controls = twins(2).map((c) => ({ ...c, tests: [...c.tests, LEAK] }));
  const results = await runControls(ids(controls), { controls, jobs: 1, afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore', detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }")) });
  assert.equal(results[1].baselineReusedFrom, 'R90-1', 'the second control took the first one\'s baseline');
  assert.ok(results[0].strays?.some((s) => s.phase === 'run end'), `the stray is found at run end and is the first control's (${JSON.stringify(results[0].strays)})`);
  assert.deepEqual([results[1].reusedFromStrayOwner, results[1].wentRed], ['R90-1', false], 'so the second control is not red either');
  assert.ok(runVerdict(results).problems.includes('R90-2: reused an unmutated run of R90-1, which left a stray process'), JSON.stringify(runVerdict(results).problems));
  // Found by path only: counted against its owner, and left running (this file stops it by its record).
  assert.deepEqual(alive().map((p) => p.pid).sort(), recorded().map((p) => p.pid).sort(), 'the stray was not signalled');
  });
});

// The run-end sweep must answer within its time limit, or the run has proved nothing about strays.
const withPath = async (path, fn) => { const saved = process.env.PATH; process.env.PATH = path; try { return await fn(); } finally { process.env.PATH = saved; } };
const detachedLeak = async () => runControls(['R90'], { controls: [{ ...R90, tests: [...R90.tests, LEAK] }], afterPrepare: (dir) => writeFile(join(dir, LEAK), leakTest("{ stdio: 'ignore', detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }")) });

test('[PERF-1] a run-end sweep that cannot ask lsof, or gets no answer in time, fails the run', async () => {
  await withLeaks(() => inPrivateTmp(async (priv) => {
    {
      // No lsof on the PATH at all.
      const without = process.env.PATH.split(':').filter((d) => spawnSync('/bin/test', ['-x', join(d, 'lsof')]).status !== 0).join(':');
      const missing = await withPath(without, () => detachedLeak());
      assert.match(missing[0].sweepIncomplete ?? '', /lsof could not run/, JSON.stringify(missing[0]));
      assert.ok(runVerdict(missing).problems.some((p) => /R90: the run-end sweep for stray processes did not complete/.test(p)), JSON.stringify(runVerdict(missing).problems));
      // An lsof that does not answer.
      const bin = join(priv, 'slow-bin');
      spawnSync('/bin/mkdir', ['-p', bin]);
      await writeFile(join(bin, 'lsof'), '#!/bin/sh\nexec /bin/sleep 40\n');
      await chmod(join(bin, 'lsof'), 0o755);
      const started = Date.now();
      const slow = await withPath(`${bin}:${process.env.PATH}`, () => detachedLeak());
      assert.match(slow[0].sweepIncomplete ?? '', /lsof did not answer within 15 s/, JSON.stringify(slow[0]));
      assert.equal(runVerdict(slow).ok, false);
      assert.ok(Date.now() - started < 39_000, 'the sweep gave up at its limit, before the stand-in would have answered');
    }
  }));
});

// A hung test runner is stopped at the time limit, and its control fails closed.
test('[PERF-1] a test run that outlasts the time limit is stopped with its process group, and the control is not red', async () => {
  for (const bad of ['0', '-1', 'soon', '']) assert.throws(() => testTimeoutMs(bad), ControlSelectionError, `a limit of ${JSON.stringify(bad)} is refused`);
  assert.deepEqual([testTimeoutMs('2.5'), testTimeoutMs(900)], [2500, 900_000]);
  const HANG = 'test/unit/zz-planted-hang.test.mjs';
  let copy = null;
  const saved = process.env.CANON_RED_TEST_TIMEOUT_S;
  process.env.CANON_RED_TEST_TIMEOUT_S = '3';
  const started = Date.now();
  let results;
  try {
    results = await runControls(['PLANT-NAMES'], { controls: [{ ...plantControl(['[P] never ends']), tests: [HANG] }], jobs: 1, afterPrepare: async (dir) => { copy = dir; await writeFile(join(dir, HANG), "import test from 'node:test';\ntest('[P] never ends', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n"); } });
  } finally {
    if (saved === undefined) delete process.env.CANON_RED_TEST_TIMEOUT_S; else process.env.CANON_RED_TEST_TIMEOUT_S = saved;
  }
  assert.ok(Date.now() - started < 60_000, 'the run came back');
  assert.match(results[0].error ?? '', /ETESTTIMEOUT a test run of .* was stopped after 3 s/, JSON.stringify(results[0]));
  assert.equal(results[0].wentRed, false);
  assert.equal(runVerdict(results).ok, false);
  assert.equal(spawnSync('/usr/bin/pgrep', ['-f', copy.split('/').at(-1)], { encoding: 'utf8' }).stdout.trim(), '', 'nothing of the hung run is left');
});

// HOST SAFETY (2026-10-05): the run-end sweep of this harness once matched 19 processes of other
// work on the host by a remembered group number and stopped them. From here on the harness sends a
// signal only to what it can prove it started, and these tests hold it to that. Every stand-in is
// started here (or by a plant) and recorded with its pid and start time; nothing else is signalled
// or probed. `withKillSpy` records every signal this process is asked to send and passes on only
// the ones aimed at a recorded stand-in: a harness that aims anywhere else reaches nothing.
const withKillSpy = async (mine, fn, { passAll = false } = {}) => {
  const calls = [];
  const allowed = (pid) => passAll || mine().some((p) => p.pid === pid && sameProcess(p));
  // Node's own kill functions call one another (process.kill calls process._kill, a child's kill calls
  // its handle's): while a vetted signal is being passed on, the layers under it stay out of the way.
  let passing = false;
  const pass = (send) => { passing = true; try { return send(); } finally { passing = false; } };
  // Every way this process can send a signal: process.kill, the raw process._kill under it, a child's
  // kill() (which a spawn time limit and an abort signal also use) and the child's handle under that.
  const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const handles = Object.getPrototypeOf(probe._handle);
  const real = { kill: process.kill, raw: process._kill, child: ChildProcess.prototype.kill, handle: handles.kill };
  process.kill = (pid, sig = 'SIGTERM') => {
    if (passing || sig === 0) return real.kill.call(process, pid, sig);
    calls.push({ pid, sig });
    if (pid > 0 || passAll) return allowed(pid) ? pass(() => real.kill.call(process, pid, sig)) : true;
    // A group number: never passed on. The recorded stand-ins are ended instead, by their records,
    // so a harness that waits for its group to die still comes back and the failure can be named.
    for (const p of mine()) if (sameProcess(p)) try { pass(() => real.kill.call(process, p.pid, 'SIGKILL')); } catch { /* already gone */ }
    return true;
  };
  process._kill = (pid, signum) => {
    if (passing || signum === 0) return real.raw.call(process, pid, signum);
    calls.push({ pid, sig: signum, via: 'process._kill' });
    return (pid > 0 ? allowed(pid) : passAll) ? real.raw.call(process, pid, signum) : 0;
  };
  ChildProcess.prototype.kill = function kill(sig) {
    if (passing || sig === 0) return real.child.call(this, sig);
    calls.push({ pid: this.pid, sig: sig ?? 'SIGTERM', via: 'child.kill' });
    return allowed(this.pid) ? pass(() => real.child.call(this, sig)) : true;
  };
  handles.kill = function kill(signum) {
    if (passing || signum === 0) return real.handle.call(this, signum);
    calls.push({ pid: this.pid, sig: signum, via: 'child handle' });
    return allowed(this.pid) ? real.handle.call(this, signum) : 0;
  };
  try { return await fn(calls); } finally { process.kill = real.kill; process._kill = real.raw; ChildProcess.prototype.kill = real.child; handles.kill = real.handle; }
};
const toGroups = (calls) => calls.filter((c) => !(c.pid > 0));
const record = (pid) => { const p = { pid, start: startOf(pid) }; appendFileSync(process.env.CANON_TEST_LEAKS, `${JSON.stringify(p)}\n`); return p; };
const until = async (ok, ms = 20_000) => { for (let waited = 0; waited < ms; waited += 100) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return ok(); };
// A plant: one test file that is the control's only test. The mutation target is never read.
const PLANT_FILE = 'test/unit/zz-planted-host-safety.test.mjs';
// KEEP: a lightweight stand-in for a long-running process that ends with its test's private dir,
// 900 s at most (QA S6: it must not rely on its record alone). Where a plant below must carry no
// proof of this run, it strips the run token from KEEP's own environment explicitly, rather than
// relying on any host's process-introspection restrictions to hide it (those vary by machine).
const RECORD_SELF = "const KEEP = ['-e', 'for (1 .. 900) { last unless -d $ARGV[0]; sleep 1 }', process.env.CANON_TEST_IDLE.slice(0, process.env.CANON_TEST_IDLE.lastIndexOf('/'))];\nconst lstart = (pid) => spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim().replace(/\\s+/g, ' ');\nconst rec = (pid) => appendFileSync(process.env.CANON_TEST_LEAKS, JSON.stringify({ pid, start: lstart(pid) }) + '\\n');\n";
const plantSource = (body) => `import test from 'node:test';\nimport { spawn, spawnSync } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\n${RECORD_SELF}test('[plant] host safety', async () => {\n${body}\n});\n`;
const planted = (body, id = 'PLANT-HOST') => ({
  controls: [{ id, rows: ['harness'], file: PLANT_TARGET, find: 'pristine', replace: 'MUTATED', tests: [PLANT_FILE], intends: ['[plant] host safety'], defect: 'a planted mutation the planted test never reads' }],
  afterPrepare: async (dir) => { await writeFile(join(dir, PLANT_TARGET), 'pristine\n'); await writeFile(join(dir, PLANT_FILE), plantSource(body)); },
});
const withTimeout = async (seconds, fn) => { const saved = process.env.CANON_RED_TEST_TIMEOUT_S; process.env.CANON_RED_TEST_TIMEOUT_S = String(seconds); try { return await fn(); } finally { if (saved === undefined) delete process.env.CANON_RED_TEST_TIMEOUT_S; else process.env.CANON_RED_TEST_TIMEOUT_S = saved; } };
const HANGS = 'rec(process.pid); rec(process.ppid); setInterval(() => {}, 1000); await new Promise(() => {});';

// QA A1, A5, R-a: a group NUMBER proves nothing (the leader may be gone and the number someone
// else's), so no path of the harness may signal one.
test('[HOST-SAFETY] a leftover in the test run\'s group is ended from inside the group: the harness itself sends no signal, to a number or to a pid', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await withKillSpy(recorded, async (calls) => {
      // Two leftovers in the group: one that ends on SIGTERM, and one that ignores it (and says when its
      // handler is in place), so the holder's last word, SIGKILL to its own group, is needed too.
      const leak = planted("const c = spawn('/usr/bin/perl', KEEP, { stdio: 'ignore' }); c.unref(); rec(c.pid);\nconst deaf = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => {}, 900000);\"], { stdio: ['ignore', 'pipe', 'ignore'] });\nawait new Promise((ready) => deaf.stdout.once('data', ready));\ndeaf.stdout.destroy(); deaf.unref(); rec(deaf.pid);");
      const [r] = await runControls(['PLANT-HOST'], { ...leak, jobs: 1 });
      assert.ok(recorded().length >= 2, 'the plant did start and record both stand-ins');
      assert.ok(r.leftBehind.baseline >= 2, `both leftovers in the group are counted (${JSON.stringify(r.leftBehind)})`);
      assert.deepEqual(toGroups(calls), [], 'no signal to a group number after a test run');
      assert.deepEqual(calls, [], `and none to a pid either: the group was ended by its own holder (recorded stand-ins ${recorded().map((p) => p.pid).join(',')}; signals asked ${calls.map((c) => `${c.pid}:${c.sig}`).join(',') || 'none'})`);
      assert.deepEqual(alive(), [], 'both are gone, the one that ignores SIGTERM too');
    });
  });
});

test('[HOST-SAFETY] a test run past its time limit is ended from inside its group: the harness sends no signal to a process group number', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await withKillSpy(recorded, async (calls) => {
      const before = recorded().length;
      const hang = planted(HANGS);
      const [h] = await withTimeout(3, () => runControls(['PLANT-HOST'], { ...hang, jobs: 1 }));
      assert.match(h.error ?? '', /ETESTTIMEOUT/, JSON.stringify(h));
      assert.ok(recorded().length > before, 'the hung test recorded itself');
      assert.deepEqual(toGroups(calls), [], 'no signal to a group number at the time limit');
      assert.ok(await until(() => alive().length === 0), 'the hung run was ended');
    });
  });
});

// QA A4, R-b: a process that merely NAMES the copy on its command line (a tail, an editor, a grep)
// is not the run's.
test('[HOST-SAFETY] a process whose command line names the copy but which the run did not start is reported, makes the control not red, and is never signalled', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await inPrivateTmp(async (elsewhere) => {
      let standIn = null;
      const start = async (dir) => {
        await plantNames(dir);
        if (standIn) return;
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN'));
        const c = spawn(process.execPath, [process.env.CANON_TEST_IDLE, join(dir, 'named-by-a-stranger')], { stdio: 'ignore', detached: true, cwd: elsewhere, env });
        c.unref();
        standIn = record(c.pid);
      };
      await withKillSpy(recorded, async (calls) => {
        // Without the stand-in this control is red (see the exact-name test above).
        const results = await runControls(['PLANT-NAMES'], { controls: [plantControl([NAMED])], afterPrepare: start, jobs: 1 });
        const [r] = results;
        assert.ok(standIn?.start, 'the stand-in was started and recorded');
        assert.deepEqual(calls.filter((c) => c.pid === standIn.pid), [], 'no signal was sent to it');
        assert.deepEqual(toGroups(calls), []);
        assert.ok(alive().some((p) => p.pid === standIn.pid), 'it is still running');
        assert.ok(r.strays?.some((s) => s.pid === standIn.pid && s.start === standIn.start && s.signalled === false && s.phase === 'baseline'), `it is reported with its pid and start time by the control's own sweep, right after the unmutated run (${JSON.stringify(r.strays)})`);
        assert.equal(r.wentRed, false, 'and counted against the control whose copy it names');
        assert.ok(runVerdict(results).problems.some((p) => p.startsWith(`PLANT-NAMES: a process found by path only was NOT stopped (pid ${standIn.pid}, started ${standIn.start})`)), JSON.stringify(runVerdict(results).problems));
      });
    });
  });
});

// QA A2, R-d, V3: a test that ends its own group takes the holder with it. From then on nobody
// holds the number.
test('[HOST-SAFETY] a test that kills its own process group, holder included: the control and the run fail with the group unknown, and no number is signalled', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await withKillSpy(recorded, async (calls) => {
      const plant = planted("const c = spawn('/usr/bin/perl', KEEP, { stdio: 'ignore', detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }); c.unref(); rec(c.pid); process.kill(0, 'SIGKILL'); await new Promise(() => {});");
      const results = await runControls(['PLANT-HOST'], { ...plant, jobs: 1 });
      const [r] = results;
      assert.match(r.error ?? '', /EHOLDERLOST .*its process group is unknown/, JSON.stringify(r));
      assert.equal(r.wentRed, false);
      const verdict = runVerdict(results);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.problems.some((p) => /^run: PLANT-HOST: the holder of a test run/.test(p)), `the RUN fails, by name (${JSON.stringify(verdict.problems)})`);
      assert.deepEqual(calls, [], 'nothing was signalled afterwards: no number, no pid');
      const mine = recorded();
      assert.ok(mine.length >= 1 && alive().length === mine.length, 'the member that had left the group lives on, unsignalled');
      assert.ok(r.strays?.some((s) => s.signalled === false && mine.some((p) => p.pid === s.pid)), `and is reported (${JSON.stringify(r.strays)})`);
    });
  });
});

// QA A5, R-e. What QA asked for (the leader gone, a process outside the group holding the harness's
// output pipe, the limit then firing at the dead leader's number) cannot be built from a test file:
// the test runner gives each file a pipe of its own, so nothing a test starts can hold the pipe the
// harness reads. What a test CAN do is hold the FILE's pipe, and then the runner itself waits and the
// run truly outlasts its limit. That case is held here: it ends from inside the group, no number is
// signalled, and the process that left is found by path only and left alone.
test('[HOST-SAFETY] a process that left the group but holds the test file\'s output pipe: the run ends at its limit from inside the group, and neither a number nor that process is signalled', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await withKillSpy(recorded, async (calls) => {
      const plant = planted("const c = spawn('/usr/bin/perl', KEEP, { stdio: ['ignore', 'inherit', 'inherit'], detached: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN')) }); c.unref(); rec(c.pid);");
      const started = Date.now();
      const results = await withTimeout(8, () => runControls(['PLANT-HOST'], { ...plant, jobs: 1 }));
      const [r] = results;
      assert.match(r.error ?? '', /ETESTTIMEOUT/, 'the runner waits for the pipe, so the run is stopped at its limit');
      assert.deepEqual(toGroups(calls), [], 'no signal to a group number');
      assert.deepEqual(calls, [], 'and none to the process that left: it is found by path only');
      const mine = recorded();
      assert.ok(mine.length >= 1 && alive().length === mine.length, 'it is still running');
      assert.ok(r.strays?.some((s) => s.signalled === false && mine.some((p) => p.pid === s.pid && p.start === s.start)), `and it is reported (${JSON.stringify(r.strays)})`);
      assert.ok(Date.now() - started < 38_000, 'the harness did not wait for the pipe holder to exit');
    });
  });
});

// QA A3, R-f: a pid is a number too. Between SIGTERM and the SIGKILL after the grace the process can
// exit and its pid can go to someone else.
test('[HOST-SAFETY] reap signals a pid only while its start time matches the record: a stale record gets nothing, and a pid that changes hands during the grace gets no SIGKILL', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await inPrivateTmp(async (priv) => {
      const flag = join(priv, 'saw-term');
      const ready = join(priv, 'ready');
      // Survives SIGTERM, and says when it got one.
      const c = spawn(process.execPath, ['-e', `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(flag)}, '')); fs.writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => { if (!fs.existsSync(${JSON.stringify(priv)})) process.exit(0); }, 1000); setTimeout(() => process.exit(0), 900000);`], { stdio: 'ignore', detached: true });
      c.unref();
      assert.ok(await until(() => spawnSync('/bin/test', ['-e', ready]).status === 0), 'the stand-in is ready');
      const standIn = record(c.pid);
      await withKillSpy(recorded, async (calls) => {
        // A record with another start time: the pid belongs to someone else.
        await harness.reap([{ pid: standIn.pid, start: 'Mon Jan 1 00:00:00 2001' }, { pid: standIn.pid }]);
        assert.deepEqual(calls, [], 'a record that does not match, or has no start time, gets no signal');
        // The reuse, injected: once the stand-in has had its SIGTERM, ps answers another start time
        // for that pid, as it would if the process had exited and the pid had been given away.
        const bin = join(priv, 'bin');
        spawnSync('/bin/mkdir', ['-p', bin]);
        await writeFile(join(bin, 'ps'), `#!/bin/sh\nif [ -e ${JSON.stringify(flag)} ]; then case " $* " in *lstart*" -p ${standIn.pid} "*) echo 'Mon Jan  1 00:00:00 2001'; exit 0 ;; esac; fi\nexec /bin/ps "$@"\n`);
        await chmod(join(bin, 'ps'), 0o755);
        // A script's first run can stall on a loaded host: run it once before the harness relies on it.
        assert.equal(spawnSync(join(bin, 'ps'), ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).status, 0, 'the injected ps answers');
        assert.ok(sameProcess(standIn), 'the stand-in is still running when reap is asked');
        await withPath(`${bin}:${process.env.PATH}`, () => harness.reap([standIn]));
        assert.deepEqual(calls, [{ pid: standIn.pid, sig: 'SIGTERM' }], 'SIGTERM while it was ours, and no SIGKILL once the pid was someone else\'s');
        assert.equal(spawnSync('/bin/test', ['-e', flag]).status, 0, 'the stand-in did get the SIGTERM');
        assert.ok(alive().some((p) => p.pid === standIn.pid), 'and was not killed');
      });
    });
  });
});

// Lead 2026-10-06 00:42Z: a process the harness stopped stays in the process table, with its pid and
// start time, until its parent collects it.
test('[HOST-SAFETY] a process that reap stopped is not reported as a survivor while its parent has not collected it', async () => {
  await withLeaks(async ({ recorded }) => {
    await inPrivateTmp(async (priv) => {
      const file = join(priv, 'child');
      // A parent that never collects its child; the child idles until it is signalled.
      const c = spawn('/usr/bin/perl', ['-e', 'my ($home) = $ARGV[0] =~ m{^(.*)/}; my $p = fork; if (!$p) { for (1 .. 900) { last unless -d $home; sleep 1 } exit 0 } open(my $f, q{>}, $ARGV[0]); print $f $p; close($f); for (1 .. 900) { last unless -d $home; sleep 1 }', file], { stdio: 'ignore', detached: true });
      c.unref();
      record(c.pid);
      assert.ok(await until(() => { try { return /^\d+$/.test(readFileSync(file, 'utf8')); } catch { return false; } }), 'the child started');
      const child = record(Number(readFileSync(file, 'utf8')));
      assert.ok(sameProcess(child), 'and is running');
      await withKillSpy(recorded, async (calls) => {
        const survivors = await harness.reap([child]);
        assert.deepEqual(calls, [{ pid: child.pid, sig: 'SIGTERM' }], 'one SIGTERM while it was running; once it is dead it gets no signal at all, no SIGKILL after the grace');
        const state = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
        assert.match(state, /^Z/, 'it is dead and not yet collected: ps still shows it, in state Z');
        assert.deepEqual(survivors, [], 'and reap does not report it as still running');
        assert.deepEqual([harness.stillRunning(child), harness.stillRunning({ pid: child.pid, start: 'Mon Jan 1 00:00:00 2001' }), harness.stillRunning(recorded()[0])], [false, false, true], 'still running means: the recorded process, and running');
      });
    });
  });
});

// QA A6, R-g: a path that names no control's copy has no owner. It is never given to the last control.
test('[HOST-SAFETY] a process found by a path that belongs to no control is nobody\'s: no control is blamed, and the run fails', () => {
  const owned = [{ id: 'A', dirs: ['/copies/a'] }, { id: 'B', dirs: ['/copies/b'] }];
  assert.equal(harness.ownerByPath({ pid: 7, command: 'cwd /copies/a/test' }, owned)?.id, 'A', 'a path inside a copy has that copy\'s control as owner');
  assert.equal(harness.ownerByPath({ pid: 7, command: 'cwd /somewhere/else' }, owned), null, 'any other path has none');
  const red = { id: 'B', wentRed: true, warnings: [], leftBehind: { baseline: 0, mutated: 0 } };
  const problem = 'a process (pid 7, started Mon Oct 5 22:00:00 2026) has its working directory in a copy of this run that belongs to no control: it was NOT stopped, and no control is blamed';
  const verdict = runVerdict(Object.assign([red], { runProblems: [problem] }));
  assert.deepEqual([verdict.ok, verdict.problems], [false, [`run: ${problem}`]], 'the run fails on it, and control B stays as it was');
});

// QA E4, R-h, V2: ps prints arguments and environment in one column.
test('[HOST-SAFETY] the run token is matched in the environment only: the token in the arguments, or another run\'s token, proves nothing and is not signalled', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    const token = 'a'.repeat(16) + '0123456789abcdef';
    const other = 'b'.repeat(16) + '0123456789abcdef';
    const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN'));
    const run = (args, env) => { const c = spawn(process.execPath, [process.env.CANON_TEST_IDLE, ...args], { stdio: 'ignore', detached: true, env }); c.unref(); return record(c.pid); };
    const carrier = run([], { ...bare, CANON_RED_RUN: token });
    const inArguments = run([`CANON_RED_RUN=${token}`], bare);
    const otherRun = run([], { ...bare, CANON_RED_RUN: other });
    const asked = [carrier.pid, inArguments.pid, otherRun.pid];
    assert.ok(await until(() => harness.tokenCarrierPids(token, asked).includes(carrier.pid)), 'the instrument can see a token: the carrier is found');
    assert.deepEqual(harness.tokenCarrierPids(token, asked), [carrier.pid], 'and only the carrier');
    assert.deepEqual(harness.tokenCarrierPids('not-a-token', asked), [], 'a value that is not a token matches nothing');
    await withKillSpy(recorded, async (calls) => {
      await harness.reap([inArguments, otherRun], token);
      assert.deepEqual(calls, [], 'neither is signalled on this token');
      assert.equal(alive().length, 3);
      await harness.reap([carrier], token);
      assert.deepEqual(calls.map((c) => c.pid), [carrier.pid], 'the carrier is');
    });
  });
});

// 2026-10-06, the integration rerun at load 70: the token check timed out (R1073 not red, fail closed).
// The check must scale with the number of processes, not with the number of matches, and when it cannot
// finish it must still fail closed.
test('[HOST-SAFETY] the token check answers for many tokens and hundreds of candidates within its limit, and finds exactly the carriers', async () => {
  await withLeaks(async ({ recorded }) => {
    const A = 'd'.repeat(16) + '0123456789abcdef';
    const B = 'e'.repeat(16) + '0123456789abcdef';
    const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN'));
    const idle = (args, env) => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', ...args], { stdio: 'ignore', env }); return record(c.pid).pid; };
    // Three hundred processes that carry nothing (a platform binary shows no environment at all); each
    // ends with this test's private dir.
    const home = process.env.CANON_TEST_IDLE.slice(0, process.env.CANON_TEST_IDLE.lastIndexOf('/'));
    const crowd = Array.from({ length: 300 }, () => record(spawn('/usr/bin/perl', ['-e', 'for (1 .. 900) { last unless -d $ARGV[0]; sleep 1 }', home], { stdio: 'ignore' }).pid).pid);
    const a1 = idle([], { ...bare, CANON_RED_RUN: A });
    const a2 = idle([], { ...bare, CANON_RED_RUN: A });
    const b1 = idle([], { ...bare, CANON_RED_RUN: B });
    const inArgs = idle([`CANON_RED_RUN=${A}`], bare);
    const none = idle([], bare);
    const asked = [...crowd, a1, a2, b1, inArgs, none];
    assert.ok(await until(() => harness.tokenCarriers([A, B], [a1, a2, b1]).size === 3, 30_000), 'the carriers are visible to the check');
    const started = Date.now();
    const found = harness.tokenCarriers([A, B], asked);
    const ms = Date.now() - started;
    assert.deepEqual([...found.entries()].sort((x, y) => x[0] - y[0]), [[a1, A], [a2, A], [b1, B]].sort((x, y) => x[0] - y[0]), 'exactly the three carriers, each with its own token; not the one with the token in its arguments');
    assert.ok(ms < harness.SWEEP_TIMEOUT_MS, `${asked.length} candidates in ${ms} ms, inside the limit of ${harness.SWEEP_TIMEOUT_MS} ms`);
    assert.ok(recorded().length >= 305);
  });
});

test('[HOST-SAFETY] the run-end sweep answers every control from one pass, and a process carrying one control\'s token is never proven another control\'s', async () => {
  await withLeaks(async ({ recorded }) => {
    await inPrivateTmp(async (priv) => {
      const dirA = join(priv, 'copy-a');
      const dirB = join(priv, 'copy-b');
      spawnSync('/bin/mkdir', ['-p', dirA, dirB]);
      const A = '1'.repeat(16) + '0123456789abcdef';
      const B = '2'.repeat(16) + '0123456789abcdef';
      const before = harness.processSnapshot();
      const run = (cwd, token) => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', cwd, env: { ...process.env, CANON_RED_RUN: token } }); return record(c.pid); };
      const a = run(dirA, A);
      const b = run(dirB, B);
      const crossed = run(dirB, A); // A's token, living in B's copy
      assert.ok(await until(() => harness.tokenCarriers([A, B], [a.pid, b.pid, crossed.pid]).size === 3, 30_000), 'the carriers are visible');
      await withKillSpy(recorded, async (calls) => {
        const all = harness.leftOutsideAll({ owners: [{ id: 'A', token: A, dirs: [dirA] }, { id: 'B', token: B, dirs: [dirB] }], before });
        const pidsOf = (list) => list.map((p) => p.pid).sort((x, y) => x - y);
        assert.deepEqual([pidsOf(all.get('A').proven), pidsOf(all.get('B').proven)], [[a.pid], [b.pid]], 'each control proves only its own carrier in its own copy');
        assert.deepEqual(all.get('A').reported.map((p) => [p.pid, p.why]), [[crossed.pid, 'carries the run token but names no copy of this control']], 'A\'s token in B\'s copy is only reported, for A');
        assert.deepEqual(all.get('B').reported, [], 'and B does not take it as its own');
        const one = harness.leftOutside({ token: A, dirs: [dirA], before });
        assert.deepEqual([pidsOf(one.proven), one.reported.map((p) => p.pid)], [[a.pid], [crossed.pid]], 'the one-control answer is the same as the many-control answer for that control');
        assert.deepEqual(calls, []);
      });
    });
  });
});

test('[HOST-SAFETY] a copy named through a symlink still proves its own carrier by working directory (lsof names the real path)', async () => {
  await withLeaks(async ({ recorded }) => {
    await inPrivateTmp(async (priv) => {
      const real = join(priv, 'real-copy');
      const named = join(priv, 'named-copy');
      spawnSync('/bin/mkdir', ['-p', real]);
      spawnSync('/bin/ln', ['-s', real, named]);
      const T = '3'.repeat(16) + '0123456789abcdef';
      const before = harness.processSnapshot();
      const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', cwd: named, env: { ...process.env, CANON_RED_RUN: T } });
      const carrier = record(c.pid);
      assert.ok(await until(() => harness.tokenCarriers([T], [carrier.pid]).size === 1, 30_000), 'the carrier is visible');
      await withKillSpy(recorded, async (calls) => {
        const one = harness.leftOutside({ token: T, dirs: [named], before });
        assert.deepEqual([one.proven.map((p) => p.pid), one.reported.map((p) => p.pid)], [[carrier.pid], []], 'proven through the symlinked name, not merely reported');
        assert.deepEqual(calls, []);
      });
    });
  });
});

test('[HOST-SAFETY] a token check that cannot finish within its limit fails closed: an error, never a guess', async () => {
  await withLeaks(async ({ recorded }) => {
    const token = 'f'.repeat(16) + '0123456789abcdef';
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', env: { ...process.env, CANON_RED_RUN: token } });
    record(c.pid);
    await withKillSpy(recorded, async (calls) => {
      assert.throws(() => harness.tokenCarriers([token], [c.pid], { limitMs: 1 }), (e) => e.code === 'ETOKENCHECK', 'a check that runs out of time is an error');
      assert.throws(() => harness.leftOutside({ token, dirs: ['/nonexistent-rpk-copy'], before: new Set(), limitMs: 1 }), (e) => e.code === 'ETOKENCHECK', 'and so is the sweep that relies on it');
      assert.deepEqual(calls, [], 'and nothing was signalled');
    });
  });
});

test('[HOST-SAFETY] a ps that does not answer within its limit shows nothing: no start time, not running, and reap sends no signal', async () => {
  await withLeaks(async ({ recorded }) => {
    await inPrivateTmp(async (priv) => {
      const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
      const standIn = record(c.pid);
      assert.ok(sameProcess(standIn), 'the stand-in is running');
      const bin = join(priv, 'bin');
      spawnSync('/bin/mkdir', ['-p', bin]);
      // A ps that answers only after much longer than the limit (the process becomes the sleep, so the
      // limit ends it and nothing is left over).
      await writeFile(join(bin, 'ps'), '#!/bin/sh\nexec /bin/sleep 60\n');
      await chmod(join(bin, 'ps'), 0o755);
      await withKillSpy(recorded, async (calls) => {
        const started = Date.now();
        const [start, running] = await withPath(`${bin}:${process.env.PATH}`, async () => [harness.startOf(standIn.pid), harness.stillRunning(standIn)]);
        const ms = Date.now() - started;
        assert.deepEqual([start, running], [null, false], 'no answer is no start time, and not running');
        assert.ok(ms < 2 * harness.PS_TIMEOUT_MS + 10_000, `both gave up at their limit (${ms} ms for two calls, limit ${harness.PS_TIMEOUT_MS} ms each)`);
        const left = await withPath(`${bin}:${process.env.PATH}`, () => harness.reap([standIn]));
        assert.deepEqual(calls, [], 'reap signals nothing it cannot confirm');
        assert.deepEqual(left.map((p) => [p.pid, p.state]), [[standIn.pid, 'unknown']], 'and reports it as NOT confirmed stopped: a survivor, so its control cannot be red (QA H1)');
        assert.equal(await withPath(`${bin}:${process.env.PATH}`, async () => harness.processState(standIn)), 'unknown', 'the three-valued answer itself');
        assert.deepEqual([harness.processState(standIn), harness.processState({ pid: standIn.pid, start: 'Mon Jan 1 00:00:00 2001' })], ['running', 'gone'], 'with a ps that answers: running, and another start time is gone');
        // QA H1b: exit 1 with nothing on stdout means "no such process" ONLY when stderr is empty too.
        const erring = join(priv, 'bin-erring');
        const dead = join(priv, 'bin-dead');
        spawnSync('/bin/mkdir', ['-p', erring, dead]);
        await writeFile(join(erring, 'ps'), "#!/bin/sh\necho 'ps: process id too large' >&2\nexit 1\n");
        await writeFile(join(dead, 'ps'), '#!/bin/sh\nexit 1\n');
        await chmod(join(erring, 'ps'), 0o755);
        await chmod(join(dead, 'ps'), 0o755);
        assert.equal(await withPath(`${erring}:${process.env.PATH}`, async () => harness.processState(standIn)), 'unknown', 'a ps that exits 1 and says why on stderr is an error, not a stopped process');
        const erringLeft = await withPath(`${erring}:${process.env.PATH}`, () => harness.reap([standIn]));
        assert.deepEqual(calls, [], 'reap sends no signal on an erring ps');
        assert.deepEqual(erringLeft.map((p) => [p.pid, p.state]), [[standIn.pid, 'unknown']], 'and reports the process as unknown: not confirmed stopped');
        assert.equal(await withPath(`${dead}:${process.env.PATH}`, async () => harness.processState(standIn)), 'gone', 'exit 1 with nothing on stdout or stderr is the no-such-process answer');
      });
      assert.ok(sameProcess(standIn), 'the stand-in was not touched');
    });
  });
});

// QA E5, V1: reading environments to find the token must not carry anything out of them.
test('[HOST-SAFETY] a secret in the environment of a process the sweeps look at appears in no result, verdict or output of the run', async () => {
  await withLeaks(async ({ recorded }) => {
    const secret = `canon-fake-secret-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    // Two stand-ins with the secret FIRST in their environment: one proven the run's (token, in the
    // copy), one that dropped the token and is only reported.
    const idle = "process.execPath, [process.env.CANON_TEST_IDLE]";
    const plant = planted(`const secret = ${JSON.stringify(secret)};\nconst rest = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CANON_RED_RUN'));\nfor (const env of [{ CANON_FAKE_SECRET: secret, ...process.env }, { CANON_FAKE_SECRET: secret, ...rest }]) { const c = spawn(${idle}, { stdio: 'ignore', detached: true, env }); c.unref(); rec(c.pid); }`);
    let output = '';
    const taps = [process.stdout, process.stderr].map((stream) => { const real = stream.write; stream.write = function write(chunk, ...rest) { output += String(chunk); return real.call(this, chunk, ...rest); }; return () => { stream.write = real; }; });
    let results;
    try { results = await runControls(['PLANT-HOST'], { ...plant, jobs: 1 }); } finally { for (const off of taps) off(); }
    assert.ok(recorded().length >= 2, 'both stand-ins were started');
    assert.ok(results[0].strays?.some((s) => s.signalled === false), `the one without the token was looked at and reported (${JSON.stringify(results[0].strays)})`);
    const everything = `${JSON.stringify(results)}${JSON.stringify(results.runProblems ?? [])}${JSON.stringify(runVerdict(results))}${output}`;
    assert.ok(!everything.includes(secret), 'the secret is nowhere in what the run produced');
    assert.ok(!/CANON_RED_RUN=|CANON_FAKE_SECRET/.test(everything), 'nor is any environment text, the token included');
  });
});

// QA V4: the member listing decides the verdict (a leftover means not red). An instrument that lists
// nothing would turn that into a false red.
test('[HOST-SAFETY] the held-group listing finds planted members, leaves out the holder and a member that is no longer running, and lists nothing for a holder whose start time does not match', async () => {
  await withLeaks(async ({ recorded }) => {
    await inPrivateTmp(async (priv) => {
      const pids = join(priv, 'members');
      const dead = join(priv, 'dead');
      // Two sleeps, and a parent that forks a child which exits at once and is never collected: the
      // child stays in the group as a zombie for as long as its parent lives.
      const keeper = `my ($home) = $ARGV[0] =~ m{^(.*)/}; my $p = fork; exit 0 unless $p; open(my $f, '>', $ARGV[0]); print $f $p; close($f); for (1 .. 900) { last unless -d $home; sleep 1 }`;
      // Members that end with the test: each idles while the private dir exists (900 s at most).
      const member = `/usr/bin/perl -e 'for (1 .. 900) { last unless -d $ARGV[0]; sleep 1 }' ${JSON.stringify(priv)}`;
      const c = spawn('/bin/sh', ['-c', `${member} & echo $! >> ${JSON.stringify(pids)}; ${member} & echo $! >> ${JSON.stringify(pids)}; /usr/bin/perl -e "$0" ${JSON.stringify(dead)} & echo $! >> ${JSON.stringify(pids)}; wait`, keeper], { stdio: 'ignore', detached: true });
      c.unref();
      const read = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
      assert.ok(await until(() => read(pids).length === 3 && read(dead).length === 1), 'the three members started and the dead one was recorded');
      const holder = record(c.pid);
      const members = read(pids).map((p) => record(p));
      const [zombie] = read(dead);
      const stateOf = (pid) => spawnSync('/bin/ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      assert.ok(await until(() => /^Z/.test(stateOf(zombie)), 5000), `ps does show the dead member, in state Z (${stateOf(zombie)}): there is something to leave out`);
      const listed = harness.heldGroupMembers({ ...holder, reader: null });
      assert.deepEqual(listed?.map((p) => [p.pid, p.start]).sort(), members.map((p) => [p.pid, p.start]).sort(), 'exactly the three running members, each with its start time; the zombie is not one');
      assert.equal(harness.heldGroupMembers({ ...holder, reader: members[0].pid })?.length, 2, 'the holder\'s reader is not a leftover');
      assert.equal(harness.heldGroupMembers({ pid: holder.pid, start: 'Mon Jan 1 00:00:00 2001', reader: null }), null, 'a holder that is not the recorded process holds nothing: no listing by its number');
      assert.deepEqual(['Z', 'Z+', 'SE', 'RNE', 'S', 'Ss', 'R+', 'I', 'T', 'U', 'SNs'].map((state) => harness.notRunning(state)), [true, true, true, true, false, false, false, false, false, false, false], 'not running: a zombie, or one marked as trying to exit; anything else is running');
      assert.deepEqual(['SE', 'RNE', 'Z', 'ZE', 'S', 'R+'].map((state) => harness.isExiting(state)), [true, true, false, false, false, false], 'exiting: marked as trying to exit and not dead yet');
      assert.deepEqual(harness.heldGroupExiting({ ...holder, reader: null }), [], 'none of these members is on its way out');
      assert.ok(recorded().length === 4);
    });
  });
});

// QA A8, V5: the harness itself can be stopped, or killed outright. The test runs it started are in
// their own sessions, so only their holders can end them: on a word from the harness, or when the
// harness is simply gone and its end of the pipe closes.
const harnessGone = (signal) => async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await inPrivateTmp(async (priv) => {
      const driver = join(priv, 'driver.mjs');
      // Every signal the driver's harness tries to send is written down and NOT sent.
      await writeFile(driver, `import { appendFileSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst [repo, log] = process.argv.slice(2);\nimport { ChildProcess } from 'node:child_process';\nconst note = (pid, sig) => { if (sig !== 0) appendFileSync(log, JSON.stringify({ pid, sig }) + '\\n'); return true; };\nprocess.kill = (pid, sig = 'SIGTERM') => note(pid, sig);\nprocess._kill = (pid, sig) => { note(pid, sig); return 0; };\nChildProcess.prototype.kill = function kill(sig = 'SIGTERM') { return note(this.pid, sig); };\nconst { runControls } = await import(join(repo, 'scripts/red-controls.mjs'));\nconst FILE = ${JSON.stringify(PLANT_FILE)};\nconst control = { id: 'PLANT-HOST', rows: ['harness'], file: ${JSON.stringify(PLANT_TARGET)}, find: 'pristine', replace: 'MUTATED', tests: [FILE], intends: ['[plant] host safety'], defect: 'none' };\nawait runControls(['PLANT-HOST'], { controls: [control], jobs: 1, afterPrepare: async (dir) => { writeFileSync(join(dir, control.file), 'pristine\\n'); writeFileSync(join(dir, FILE), ${JSON.stringify(plantSource(HANGS))}); } });\n`);
      {
        const log = join(priv, `signals-${signal}`);
        await writeFile(log, '');
        const child = spawn(process.execPath, [driver, REPO, log], { stdio: 'ignore' });
        const gone = new Promise((r) => child.on('exit', r));
        const me = record(child.pid);
        const before = recorded().length;
        assert.ok(await until(() => recorded().length >= before + 2, 120_000), `${signal}: the hung test run started under the driver's harness`);
        const run = recorded().slice(before);
        assert.ok(run.every(sameProcess), 'and is running');
        assert.ok(sameProcess(me), 'the driver is the process this test started');
        child.kill(signal);
        await gone;
        const survived = !(await until(() => !run.some(sameProcess), 15_000));
        // The signals first: a harness that aimed at a group number is named for that, not for what
        // became of its test run once this driver had withheld the signal.
        assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !(c.pid > 0)), [], `${signal}: no signal to a group number`);
        assert.equal(survived, false, `${signal}: the test run did not outlive its harness`);
      }
      assert.deepEqual(alive(), []);
    });
  });
};
test('[HOST-SAFETY] a harness that is told to stop (SIGTERM) takes its test run with it and signals no group number', harnessGone('SIGTERM'));
test('[HOST-SAFETY] a harness that is killed outright (SIGKILL) leaves no test run behind: the holder ends its group when the pipe closes', harnessGone('SIGKILL'));

// QA V6: the two tests above watch what the harness DOES on the paths they drive. This one reads
// what it COULD do: every place its source can send a signal, or read an environment.
const signalSites = (source) => {
  // The control table quotes harness lines as data: those rows are not code.
  // Nor are whole-line comments.
  const code = source.split('\n').filter((line) => !/^\s*\{\s*"?id"?\s*:\s*['"]R\d+['"]/.test(line) && !/^\s*\/\//.test(line)).join('\n');
  const problems = [];
  const direct = [...code.matchAll(/\bprocess\s*\??\.\s*kill\s*\(\s*([^,)]*)/g)].map((m) => m[1].trim());
  for (const target of direct) if (target !== 'p.pid') problems.push(`process.kill is called on ${JSON.stringify(target)}: only a re-checked record's pid (p.pid) may be signalled`);
  if (/\bprocess\s*\[/.test(code) || /\bkill\s*:\s*\w+\s*\}\s*=\s*process\b/.test(code) || /=\s*process\.kill\b/.test(code)) problems.push('process.kill is reached by another name');
  // The bare word 'kill' is what the harness says to a holder: tell('kill'). A program is a spawn.
  if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:[\w./]*\/)?(?:kill|pkill|killall)\b/.test(code)) problems.push('a kill program is run');
  if (/\b(?:pkill|killall)\b/.test(code)) problems.push('pkill or killall is named');
  // In shell text the only target is 0: the caller's own group.
  for (const m of code.matchAll(/\bkill\s+-(?:\w+)\s+(\S+)/g)) if (!/^0[\s;)'"`]?$/.test(m[1])) problems.push(`a shell kill is aimed at ${JSON.stringify(m[1])}: only 0, the caller's own group`);
  if (/\.kill\s*\(/.test(code.replace(/\bprocess\s*\??\.\s*kill\s*\(/g, ''))) problems.push('a child handle is signalled directly (child.kill): the holder ends its own group instead');
  // Environments are listed (ps -E, ps e) in one place only: the token check that prints pids.
  const envListings = [...code.matchAll(/^.*\bps\b[^\n]*?\s-\w*E\b.*$/gm)].map((m) => m[0]);
  for (const line of envListings) if (!line.startsWith('const TOKEN_CHECK = ')) problems.push('an environment listing outside the token check');
  return { direct, envListings, problems };
};
test('[HOST-SAFETY] the harness source can signal only a re-checked record or its own group, and lists environments only in the token check', async () => {
  const source = await readFile(join(REPO, 'scripts/red-controls.mjs'), 'utf8');
  const found = signalSites(source);
  assert.deepEqual(found.problems, []);
  assert.deepEqual(found.direct, ['p.pid'], 'one place sends a signal, and the check found it');
  assert.equal(found.envListings.length, 1, 'one place lists environments, and the check found it');
  // The check can refuse: each of these, added to the source, is named.
  const refused = (line) => signalSites(`${source}\n${line}\n`).problems.length > 0;
  for (const line of [
    "process.kill(-group, 'SIGKILL');",
    "process.kill(-child.pid, 'SIGTERM');",
    'process.kill(pid, signal);',
    "process?.kill(-g, 'SIGKILL');",
    "process['kill'](-g);",
    'const { kill: send } = process;',
    'const send = process.kill;',
    "spawnSync('kill', ['-9', `-${group}`]);",
    "spawnSync('/usr/bin/pkill', ['-f', dir]);",
    'const STOP = `kill -KILL -$1`;',
    'const STOP = `kill -TERM $pid`;',
    "child.kill('SIGKILL');",
    "const listing = spawnSync('/bin/sh', ['-c', 'ps -E -axo pid=,command=']);",
  ]) assert.ok(refused(line), `refused: ${line}`);
  assert.equal(refused('const note = 1;'), false, 'and a harmless line is not');
});

// The tests above rest on the spy: on a harness that aims badly it is what stands between a signal
// and the host. So the spy is tested as a guard is: on every path, and against a spy that does not hold.
test('[HOST-SAFETY] the signal spy of these tests withholds a signal on every path of this process, and a spy that passes signals on is seen to fail', async () => {
  const KILL = osConstants.signals.SIGKILL;
  const paths = {
    'process.kill on a pid': (c) => process.kill(c.pid, 'SIGKILL'),
    // The canary is detached: it leads a group of its own, with nobody else in it.
    'process.kill on a group number': (c) => process.kill(-c.pid, 'SIGKILL'),
    'process._kill': (c) => process._kill(c.pid, KILL),
    'child.kill': (c) => c.child.kill('SIGKILL'),
    'the child handle': (c) => c.child._handle.kill(KILL),
  };
  const attempt = (options) => withRecords(async () => {
    const canaries = Object.fromEntries(Object.keys(paths).map((name) => { const child = spawn(process.execPath, [process.env.CANON_TEST_IDLE], { stdio: 'ignore', detached: true }); child.unref(); return [name, { child, ...record(child.pid) }]; }));
    assert.ok(Object.values(canaries).every(sameProcess), 'every canary is running');
    // The spy is told that nothing is a recorded stand-in: every signal must be withheld.
    const calls = await withKillSpy(() => [], async (seen) => { for (const [name, send] of Object.entries(paths)) send(canaries[name]); return [...seen]; }, options);
    await until(() => !Object.values(canaries).some(sameProcess), 3000);
    return { calls, killed: Object.keys(paths).filter((name) => !sameProcess(canaries[name])) };
  });
  const held = await attempt();
  assert.deepEqual(held.killed, [], 'no canary was reached');
  assert.deepEqual(held.calls.map((c) => c.via ?? 'process.kill'), ['process.kill', 'process.kill', 'process._kill', 'child.kill', 'child handle'], 'and every attempt was written down');
  const open = await attempt({ passAll: true });
  assert.deepEqual(open.killed, Object.keys(paths), 'the same attempts through a spy that passes signals on reach every canary: this check can fail');
});

// QA E6: the token says who started a process, not that it is still the run's alone. A helper the
// host has since adopted (an agent, a credential cache) carries the token and lives elsewhere.
test('[HOST-SAFETY] a process that carries the run token but lives outside the copy is reported and never signalled', async () => {
  await withLeaks(async ({ recorded, alive }) => {
    await withKillSpy(recorded, async (calls) => {
      const plant = planted("const c = spawn(process.execPath, [process.env.CANON_TEST_IDLE], { stdio: 'ignore', detached: true, cwd: '/' }); c.unref(); rec(c.pid);");
      const results = await runControls(['PLANT-HOST'], { ...plant, jobs: 1 });
      const mine = recorded();
      assert.ok(mine.length >= 1, 'the plant did start and record its stand-in');
      assert.deepEqual(calls, [], 'no signal was sent');
      assert.equal(alive().length, mine.length, 'every one of them is still running');
      assert.ok(results[0].strays?.some((s) => s.signalled === false && /carries the run token but names no copy/.test(s.why ?? '') && mine.some((p) => p.pid === s.pid && p.start === s.start)), `it is reported as a token carrier outside the copy (${JSON.stringify(results[0].strays)})`);
      assert.equal(runVerdict(results).ok, false, 'and the run fails on it');
    });
  });
});

// 2026-10-06: a baseline failed once in seven runs and nobody could say why: a result held the NAME of
// the failing test and nothing else.
test('[PERF-1] a result keeps the first line of each failing test\'s assertion message, at most 300 characters, for the unmutated, alone and mutated runs', async () => {
  const long = 'x'.repeat(400);
  const tap = ['TAP version 13', '# Subtest: one', 'not ok 1 - one', '  ---', '  duration_ms: 1', "  failureType: 'testCodeFailure'", '  error: |-', '    the first line', '    + actual - expected', "  code: 'ERR_ASSERTION'", '  ...', '# Subtest: two', 'ok 2 - two', '  ---', '  duration_ms: 1', '  ...', '# Subtest: three', 'not ok 3 - three', '  ---', "  error: 'said on one line'", '  ...', '# Subtest: four', 'not ok 4 - four', '  ---', '  error: |-', `    ${long}`, '  ...', 'not ok 5 - five', '  ---', '  duration_ms: 1', '  ...', ''].join('\n');
  assert.deepEqual(harness.tapFailureMessages(tap), [{ name: 'one', message: 'the first line' }, { name: 'three', message: 'said on one line' }, { name: 'four', message: 'x'.repeat(300) }, { name: 'five', message: null }], 'the first line only, cut at 300; a failing test with no message says so');
  // Through a control: the mutated run of the planted control fails on the planted assertion.
  const [r] = await runControls(['PLANT-NAMES'], { controls: [plantControl([NAMED])], afterPrepare: plantNames, jobs: 1 });
  assert.equal(r.wentRed, true);
  assert.deepEqual([r.baseline.failedWhy, r.alone.failedWhy], [[], []], 'the unmutated runs failed nothing, and say so');
  assert.deepEqual(r.broken.failedWhy.map((w) => w.name), [NAMED], 'the mutated run names its one failing test');
  assert.match(r.broken.failedWhy[0].message, /did not match the regular expression/, `with the first line of its assertion (${JSON.stringify(r.broken.failedWhy)})`);
  assert.ok(r.broken.failedWhy[0].message.length <= 300 && !r.broken.failedWhy[0].message.includes('\n'));
});
