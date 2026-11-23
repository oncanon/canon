import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { clean, isOurServe, paths, readStateTolerant, start, status, stop, writeStateAtomic } from '../../src/service.mjs';
import { CLI, FIXTURE, treeDigest } from '../helpers.mjs';

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Every serve this run started: pid and state path from each fixture's own events
// log, taken before the fixture directory is removed. The leak check judges only
// these, by pid and command line, so it never lists the host and cannot see the
// serves of another run of this file (I-8: red-controls runs copies in parallel).
const startedServes = [];
async function recordServes(stateDir) {
  const text = await readFile(paths(stateDir).events, 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });
  for (const e of text.split('\n').filter(Boolean).map(JSON.parse)) {
    if (e.event === 'start') startedServes.push({ pid: e.pid, statePath: paths(stateDir).state });
  }
}

// The recorded serves that are still running as that state directory's serve.
function leakedServes(records) {
  return records.filter((r) => isOurServe(r.pid, r.statePath));
}

// One cleanup hook per fixture: stop this fixture's service first, then remove its
// directory. (Separate hooks ran in registration order, removed the state file
// first, and left the serve process running.)
async function storeWithPacket(t) {
  const dir = await mkdtemp(join(tmpdir(), 'canon-e4-'));
  t.after(async () => {
    await stop({ stateDir: join(dir, 'service') }).catch(() => {});
    await recordServes(join(dir, 'service'));
    await rm(dir, { recursive: true, force: true });
  });
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'built') });
  await publishPacket({ packetDir: built.outDir, root: join(dir, 'store') });
  return { dir, store: join(dir, 'store'), stateDir: join(dir, 'service'), contentId: built.contentId };
}

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid;
}

// No serve process from these fixtures may outlive the suite.
test.after(() => {
  assert.deepEqual(leakedServes(startedServes), [], 'serve processes leaked by lifecycle tests');
});

test('[E4] I-8: the leak check reports a recorded serve that still runs, and not a recycled pid or another run\'s serve', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-e4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ownState = join(dir, 'service', 'state.json');
  // Another run's state path: same prefix, never created or recorded by this run.
  const otherState = join(tmpdir(), `canon-e4-other-run-${process.pid}`, 'service', 'state.json');
  // Each stand-in is ended and waited for before the file's leak check runs.
  const spawnOwn = async (args) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', ...args], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    t.after(async () => { child.kill(); await exited; });
    await new Promise((r, j) => { child.once('spawn', r); child.once('error', j); });
    return child.pid;
  };
  // Serve-shaped command lines; neither runs cli.mjs.
  const own = await spawnOwn([CLI, 'serve', '--state-file', ownState]);
  const other = await spawnOwn([CLI, 'serve', '--state-file', otherState]);
  // A live process that is not a serve, recorded as if its pid had been recycled.
  const recycled = await spawnOwn([]);
  const pids = (records) => leakedServes(records).map((r) => r.pid);
  assert.deepEqual(pids([{ pid: own, statePath: ownState }, { pid: recycled, statePath: ownState }]), [own], 'a recorded serve that still runs is reported; a recycled pid is not');
  assert.deepEqual(pids([{ pid: other, statePath: otherState }]), [other], 'the check can see the other run\'s serve once it is named');
  assert.ok(!pids(startedServes).includes(other), 'the file\'s leak check never names the other run\'s serve');
});

test('[E4] start -> ready (healthz) -> idempotent start -> status -> stop, with exit codes', async (t) => {
  const { store, stateDir, contentId } = await storeWithPacket(t);
  const port = await freePort();
  const started = cli(['service', 'start', '--root', store, '--state-dir', stateDir, '--port', String(port)]);
  assert.equal(started.status, 0, started.err);
  assert.equal(started.json.state, 'running');
  assert.equal(started.json.url, `http://127.0.0.1:${port}`);
  const again = cli(['service', 'start', '--root', store, '--state-dir', stateDir, '--port', String(port)]);
  assert.equal(again.status, 0);
  assert.equal(again.json.alreadyRunning, true);
  assert.equal(again.json.pid, started.json.pid);
  const st = cli(['service', 'status', '--state-dir', stateDir]);
  assert.equal(st.status, 0);
  assert.equal(st.json.health.ok, true);
  const res = await fetch(`http://127.0.0.1:${port}/p/${contentId}/report.md`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const stopped = cli(['service', 'stop', '--state-dir', stateDir]);
  assert.equal(stopped.status, 0);
  assert.deepEqual({ state: stopped.json.state, wasRunning: stopped.json.wasRunning, forced: stopped.json.forced }, { state: 'stopped', wasRunning: true, forced: false });
  assert.equal(cli(['service', 'status', '--state-dir', stateDir]).status, 1, 'status exits 1 when stopped');
  assert.equal(await fetch(`http://127.0.0.1:${port}/healthz`).then(() => 'open', () => 'refused'), 'refused');
  const events = (await readFile(paths(stateDir).events, 'utf8')).trim().split('\n').map(JSON.parse).map((e) => e.event);
  assert.deepEqual(events, ['start', 'ready', 'stop']);
});

test('[E4] recovery: a stale state file from a dead process is detected and cleared on start', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  await mkdir(stateDir, { recursive: true });
  const pid = await deadPid();
  await writeFile(paths(stateDir).state, JSON.stringify({ pid, url: `http://127.0.0.1:${port}`, hostHeader: `127.0.0.1:${port}` }));
  const st = cli(['service', 'status', '--state-dir', stateDir]);
  assert.equal(st.status, 2, 'status exits 2 for stale state');
  assert.equal(st.json.state, 'stale');
  const started = await start({ stateDir, root: store, port });
  assert.equal(started.state, 'running');
  assert.deepEqual(started.recovery, [{ recovered: 'stale-state', stalePid: pid }]);
});

test('[E4] recovery: a pid recycled by an unrelated process is never signalled', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  await mkdir(stateDir, { recursive: true });
  // A live process that is not our serve (e.g. a recycled pid).
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => bystander.kill());
  await writeFile(paths(stateDir).state, JSON.stringify({ pid: bystander.pid, url: `http://127.0.0.1:${port}`, hostHeader: `127.0.0.1:${port}` }));
  assert.equal((await status(stateDir)).state, 'stale');
  const stopped = await stop({ stateDir });
  assert.equal(stopped.wasRunning, false);
  assert.equal(bystander.exitCode, null, 'bystander still running');
  assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  assert.equal((await start({ stateDir, root: store, port })).state, 'running');
});

test('[E4] QA N4: tampered state naming a foreign pid never reports a live server as stopped', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  const started = await start({ stateDir, root: store, port });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => bystander.kill());
  const statePath = paths(stateDir).state;
  const real = JSON.parse(await readFile(statePath, 'utf8'));
  // The real state is put back however the test ends, so the fixture cleanup, which
  // runs first, stops the real server through stop() and waits for it to exit. (An
  // unwaited SIGTERM by pid left it dying when the file's leak check ran: I-8, R18.)
  try {
    await writeFile(statePath, JSON.stringify({ ...real, pid: bystander.pid }));
    const st = cli(['service', 'status', '--state-dir', stateDir]);
    assert.equal(st.status, 5, 'status exits 5 (orphaned)');
    assert.equal(st.json.state, 'orphaned');
    const stopped = cli(['service', 'stop', '--state-dir', stateDir]);
    assert.equal(stopped.status, 5, stopped.err);
    assert.match(stopped.err, /orphaned: a server answers at the recorded URL/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200, 'server still running and not misreported');
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'bystander never signalled');
    assert.equal(cli(['service', 'start', '--root', store, '--state-dir', stateDir, '--port', String(port)]).status, 5);
    assert.ok(JSON.parse(await readFile(statePath, 'utf8')).pid === bystander.pid, 'state not cleared');
  } finally {
    await writeFile(statePath, JSON.stringify(real));
  }
  assert.equal(started.pid, real.pid);
});

test('[E4] recovery: port already in use is refused with exit 4 and names the holder', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const blocker = createServer();
  await new Promise((r) => blocker.listen({ host: '127.0.0.1', port: 0 }, r));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const r = cli(['service', 'start', '--root', store, '--state-dir', stateDir, '--port', String(port)]);
  assert.equal(r.status, 4, r.err);
  assert.match(r.err, new RegExp(`port-in-use: 127\\.0\\.0\\.1:${port} is in use by node \\(pid ${process.pid}\\)`));
  assert.equal((await status(stateDir)).state, 'stopped');
});

test('[E4] recovery: after a crash (SIGKILL) status reports stale and restart brings the service back', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  const first = await start({ stateDir, root: store, port });
  process.kill(first.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await status(stateDir)).state, 'stale');
  const restarted = cli(['service', 'restart', '--state-dir', stateDir]);
  assert.equal(restarted.status, 0, restarted.err);
  assert.equal(restarted.json.started.state, 'running');
  assert.notEqual(restarted.json.started.pid, first.pid);
  assert.equal(restarted.json.stopped.recovered, 'stale-state');
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`, { headers: {} })).status, 200);
});

test('[E4] clean removes only dead-publisher staging and stale state; never packets, aliases, locks, logs or tracked paths', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const pid = await deadPid();
  const deadStaging = join(store, '.staging', `sha256-${'a'.repeat(64)}.${pid}.abcdef`);
  const liveStaging = join(store, '.staging', `sha256-${'b'.repeat(64)}.${process.pid}.abcdef`);
  await mkdir(deadStaging, { recursive: true });
  await mkdir(liveStaging, { recursive: true });
  await mkdir(join(store, 'aliases'), { recursive: true });
  await writeFile(join(store, 'aliases', 'review.lock'), '1\n');
  await mkdir(stateDir, { recursive: true });
  await writeFile(paths(stateDir).state, JSON.stringify({ pid, url: 'http://127.0.0.1:1', hostHeader: '127.0.0.1:1' }));
  await writeFile(paths(stateDir).log, 'log line\n');
  const packetsBefore = await treeDigest(join(store, 'packets'));
  const result = await clean({ stateDir, store });
  assert.deepEqual(result.removed.map((r) => r.path).sort(), [deadStaging, paths(stateDir).state].sort());
  assert.ok(result.kept.some((k) => k.path === liveStaging));
  assert.ok(result.kept.some((k) => k.path.endsWith('review.lock')));
  assert.deepEqual(await treeDigest(join(store, 'packets')), packetsBefore);
  assert.deepEqual((await readdir(join(store, '.staging'))), [liveStaging.split('/').pop()]);
  assert.equal(await readFile(paths(stateDir).log, 'utf8'), 'log line\n');
});

test('[E4] clean refuses tracked or un-ignored paths inside a git work tree', async (t) => {
  // Hermetic: a throwaway repository with a tracked file, an ignored output dir,
  // and an unignored dir (red-control copies of this repo are not git work trees).
  const repo = await mkdtemp(join(tmpdir(), 'canon-e4-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=canon-test', '-c', 'user.email=canon-test@localhost', ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  await writeFile(join(repo, '.gitignore'), 'dist/\n');
  await mkdir(join(repo, 'evidence'), { recursive: true });
  await writeFile(join(repo, 'evidence', 'kept.txt'), 'evidence\n');
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-q', '-m', 'fixture').status, 0);
  await mkdir(join(repo, 'dist', 'service'), { recursive: true });
  await mkdir(join(repo, 'scratch'), { recursive: true });
  await assert.rejects(clean({ stateDir: join(repo, 'evidence') }), /tracked or not gitignored/);
  await assert.rejects(clean({ stateDir: join(repo, 'scratch') }), /tracked or not gitignored/);
  await assert.rejects(clean({ stateDir: join(repo, 'dist', 'service'), store: join(repo, 'evidence') }), /tracked or not gitignored/);
  const ok = await clean({ stateDir: join(repo, 'dist', 'service') });
  assert.deepEqual(ok.removed, []);
  assert.equal(await readFile(join(repo, 'evidence', 'kept.txt'), 'utf8'), 'evidence\n');
});

// QA D-F2: `service start` crashed with "Unexpected end of JSON input" when its
// ready poll read state.json while the serve child was still writing it.
test('[E4] D-F2: the state reader retries torn reads and returns the complete state', async () => {
  const full = JSON.stringify({ pid: 4242, url: 'http://127.0.0.1:1' });
  const reads = ['', full.slice(0, 7), full];
  let n = 0;
  const state = await readStateTolerant('/unused', { delayMs: 1, read: async () => reads[n++] });
  assert.deepEqual(state, JSON.parse(full));
  assert.equal(n, 3, 'two torn reads were retried, not thrown');
  const missing = await readStateTolerant('/unused', { read: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.equal(missing, null, 'a missing state file means not ready');
});

test('[E4] D-F2: a state file that stays unparseable is reported as state-corrupt, not a SyntaxError', async (t) => {
  let n = 0;
  await assert.rejects(readStateTolerant('/x/state.json', { attempts: 4, delayMs: 1, read: async () => { n += 1; return '{"pid": 1'; } }),
    (err) => err.code === 'state-corrupt' && /state\.json is not valid JSON after 4 reads/.test(err.message));
  assert.equal(n, 4);
  const dir = await mkdtemp(join(tmpdir(), 'canon-e4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'service');
  await mkdir(stateDir);
  await writeFile(paths(stateDir).state, '{"pid": 1');
  const st = cli(['service', 'status', '--state-dir', stateDir]);
  assert.equal(st.status, 6, st.err);
  assert.match(st.err, /state-corrupt|not valid JSON after/);
  assert.doesNotMatch(st.err, /SyntaxError|at readJson/);
  assert.equal(await readFile(paths(stateDir).state, 'utf8'), '{"pid": 1', 'a corrupt state file is kept for inspection');
});

test('[E4] D-F2: state.json does not exist until its complete content is published, and stays exclusive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-e4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'state.json');
  const value = { pid: 7, url: 'http://127.0.0.1:2', allowedHosts: ['127.0.0.1:2'] };
  let observed = null;
  await writeStateAtomic(target, value, {
    beforePublish: async (temp) => {
      observed = {
        targetExists: await access(target).then(() => true, () => false),
        tempComplete: JSON.parse(await readFile(temp, 'utf8')),
      };
    },
  });
  assert.deepEqual(observed, { targetExists: false, tempComplete: value }, 'target absent until the fsynced temp is complete');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), value);
  assert.deepEqual(await readdir(dir), ['state.json'], 'no temp file left behind');
  await assert.rejects(writeStateAtomic(target, { pid: 8 }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), value, 'an existing state file is never overwritten');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('[E4] D-F2: start keeps polling through torn state reads and becomes ready', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  let torn = 0;
  // Serve the first three reads of an existing state file truncated, as a reader
  // racing a non-atomic writer would see them.
  const readState = async (f) => {
    const text = await readFile(f, 'utf8');
    if (torn < 3) { torn += 1; return text.slice(0, torn * 5); }
    return text;
  };
  const started = await start({ stateDir, root: store, port, readState });
  assert.equal(torn, 3, 'the torn reads were exercised');
  assert.equal(started.state, 'running');
  assert.equal((await status(stateDir)).state, 'running');
  const stopped = await stop({ stateDir });
  assert.equal(stopped.wasRunning, true);
});

test('[E4] D-F2: a state file still corrupt at the ready deadline fails start cleanly and leaves no serve process', async (t) => {
  const { store, stateDir } = await storeWithPacket(t);
  const port = await freePort();
  let childPid = null;
  const readState = async (f) => {
    const text = await readFile(f, 'utf8');
    childPid = JSON.parse(text).pid;
    return '{"pid":';
  };
  await assert.rejects(start({ stateDir, root: store, port, readState, readyTimeoutMs: 1500 }), { code: 'state-corrupt' });
  assert.ok(childPid, 'the serve child published its state');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { process.kill(childPid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 50)); }
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'the spawned serve process was stopped');
  const events = (await readFile(paths(stateDir).events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1), { ...events.at(-1), event: 'start-failed', reason: 'state-corrupt' });
});

// I-8: a failed start must not return while its own serve child is still there. The
// reader below stops the child (SIGSTOP) once it has published its state, so SIGTERM
// alone cannot end it: start() has to wait out the grace, SIGKILL, and see the exit.
// The child is proven to be this fixture's serve in the same synchronous step that
// signals it, so it is alive and unreaped (node reaps a child only on its event loop).
async function publishedState(stateDir, f) {
  for (;;) {
    try { return await readFile(f, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const begun = (await readFile(paths(stateDir).events, 'utf8')).trim().split('\n').map(JSON.parse).findLast((e) => e.event === 'start');
    if (!isOurServe(begun.pid, f)) throw new Error(`the serve child ${begun.pid} exited before publishing its state`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function stopOnceItPublishes(stateDir) {
  const stopped = { pid: null };
  const readState = async (f) => {
    const text = await publishedState(stateDir, f);
    if (stopped.pid === null) {
      const { pid } = JSON.parse(text);
      assert.ok(isOurServe(pid, f), 'the published pid is this fixture\'s serve');
      process.kill(pid, 'SIGSTOP');
      stopped.pid = pid;
    }
    return text;
  };
  return { stopped, readState };
}

for (const failure of [
  { name: 'a state read error', reason: 'EIO', opts: (readState) => ({ readState: async (f) => { await readState(f); throw Object.assign(new Error('injected read failure'), { code: 'EIO' }); } }) },
  { name: 'a state still corrupt at the ready deadline', reason: 'state-corrupt', opts: (readState) => ({ readyTimeoutMs: 1000, readState: async (f) => { await readState(f); return '{"pid":'; } }) },
]) {
  test(`[E4] I-8: a start that fails on ${failure.name} returns only after its serve child has exited, by SIGKILL when SIGTERM is not enough`, async (t) => {
    const { store, stateDir } = await storeWithPacket(t);
    const port = await freePort();
    const { stopped, readState } = stopOnceItPublishes(stateDir);
    await assert.rejects(start({ stateDir, root: store, port, stopTimeoutMs: 100, ...failure.opts(readState) }), { code: failure.reason });
    assert.ok(stopped.pid, 'the serve child published its state and was stopped');
    assert.equal(isOurServe(stopped.pid, paths(stateDir).state), false, 'start() returned while its serve child was still there');
    const events = (await readFile(paths(stateDir).events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.at(-1), { ...events.at(-1), event: 'start-failed', pid: stopped.pid, reason: failure.reason, forced: true });
  });
}
