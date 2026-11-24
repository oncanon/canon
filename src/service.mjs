// Review-service lifecycle without a daemon: `canon service start|status|stop|
// restart|clean` supervise one detached `canon serve` process through files in a
// gitignored state directory (default dist/service):
//
//   state.json   written by the serve process after it is listening (pid, URLs,
//                bound address, allowed Host values, root); removed on SIGTERM
//   config.json  the last start request, reused by restart
//   server.log   serve stdout/stderr, appended
//   events.jsonl lifecycle events (start/stop/recovery), appended
//
// A pid is signalled only after its command line proves it is this state
// directory's serve process, so a recycled pid is never killed.
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { fstatSync, ftruncateSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBindAllowed, checkBindRequest, resolveBind } from './server/bind.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));

export class ServiceError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

export function paths(stateDir) {
  const dir = resolve(stateDir);
  return { dir, state: join(dir, 'state.json'), config: join(dir, 'config.json'), log: join(dir, 'server.log'), events: join(dir, 'events.jsonl') };
}

// server.log keeps one rotated generation (server.log + server.log.1), each capped at
// this many bytes: with successful /healthz requests no longer logged (src/server/server.mjs),
// a surviving line is an error, a drift or a real request, so a few MB holds a long history;
// two generations cap the service's own disk footprint at 10 MB, in line with its other
// state files (state.json, events.jsonl) being small and bounded.
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Rotate fd's underlying file once it reaches maxBytes: copy it to `${path}.1`
// (overwriting any previous one), then truncate fd to empty. fd MUST be open on path
// with O_APPEND (as serve's own stdio and server.log's own writer are): truncating an
// O_APPEND fd, rather than reopening it, is what keeps appends landing at the new,
// empty end of file instead of leaving a gap. A caller with nothing to rotate against
// (stdout/stderr pointed at a terminal or pipe, not a file) gets false back, untouched.
export function rotateLogIfOversize(fd, path, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  let stat;
  try {
    stat = fstatSync(fd);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < maxBytes) return false;
  writeFileSync(`${path}.1`, readFileSync(path));
  ftruncateSync(fd, 0);
  return true;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// state.json is published atomically (writeStateAtomic), but the reader still
// tolerates a partial or unparseable read by retrying within a bounded budget: a
// missing file is "not ready", and only a state that stays unparseable after every
// retry is reported as corrupt (QA D-F2: `service start` crashed with "Unexpected
// end of JSON input" when it read a half-written state file).
export async function readStateTolerant(path, { attempts = 10, delayMs = 25, read = (f) => readFile(f, 'utf8') } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    let text;
    try {
      text = await read(path);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new ServiceError('state-corrupt', `${path} is not valid JSON after ${attempts} reads (${lastError.message}); inspect it, confirm no serve process is using it, then remove it`);
}

// Publish a state file atomically and exclusively: write and fsync a private temp
// file in the same directory, then link() it into place (atomic; fails with EEXIST
// if a state file already exists, like the former 'wx' flag), then remove the temp
// name. A reader therefore sees either no file or the complete file.
export async function writeStateAtomic(path, value, { beforePublish } = {}) {
  return writeJsonAtomic(path, value, { exclusive: true, beforePublish });
}

// exclusive: link() into place (EEXIST if the target exists); otherwise rename(),
// which atomically replaces it. Either way the target is never partially written.
export async function writeJsonAtomic(path, value, { exclusive = false, beforePublish } = {}) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'wx', 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (beforePublish) await beforePublish(temp);
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function event(p, record) {
  await mkdir(p.dir, { recursive: true });
  await appendFile(p.events, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

// How long a serve process is given to exit on SIGTERM before SIGKILL: stop() and a
// failed start() use the same grace.
const STOP_TIMEOUT_MS = 5000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The start identity of ONE process: the text `LC_ALL=C TZ=UTC0 ps -o lstart= -p <pid>` prints, with
// white space made single. A pid can be given to another process later; a pid with this text names
// one process. It is the form the shared run supervisor uses for ownership, so a record that carries
// it can be matched exactly, without guessing from wall-clock times. Null when ps does not answer, the
// process is not there, or the text is not in that form: never a guess.
// The ps call has a time limit, because `service start` waits for it, and at the limit ps is ended
// with SIGKILL, so the limit is a real bound and not a request. A ps that did not end by itself with
// status 0 has shown nothing, and the answer is null. `run` is the process launcher, replaceable in
// tests so that a stalled ps can be stood in for without a real one.
// LIMITS of this identity, stated:
//   - ps prints the start time to the second. Two processes that held the same pid and started inside
//     the same second have the same text and cannot be told apart by it.
//   - On macOS a process's start time is fixed, and that is the only system service mode has been
//     run on; the product names no platform for it. On Linux ps computes the start time from the
//     boot time and it can differ by a second between two calls. An equality test would then fail
//     for the right process (it would not be matched); it would not match a wrong one.
export const START_IDENTITY_TIMEOUT_MS = 2000;
const START_IDENTITY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
export function startIdentity(pid, run = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const r = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: START_IDENTITY_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } });
  // Only a ps that ended by itself with status 0 is believed, whatever it printed: a ps that timed out, was
  // signalled or could not be started has no status 0.
  const answered = r.status === 0 && typeof r.stdout === 'string';
  const text = answered ? r.stdout.trim().split(/\s+/).join(' ') : '';
  return START_IDENTITY.test(text) ? text : null;
}

// The pid must be a live `cli.mjs serve` whose --state-file is this directory's.
export function isOurServe(pid, statePath) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) return false;
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.status !== 0) return false;
  const cmd = ps.stdout.trim();
  return cmd.includes('cli.mjs serve') && cmd.includes(statePath);
}

export function probe(url, hostHeader, timeoutMs = 1500) {
  return new Promise((resolveProbe) => {
    const u = new URL('/healthz', url);
    const req = request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: u.pathname, headers: { Host: hostHeader }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolveProbe({ status: res.statusCode, ok: res.statusCode === 200 && body === 'ok\n' }));
    });
    req.on('timeout', () => { req.destroy(); resolveProbe({ status: null, ok: false, error: 'timeout' }); });
    req.on('error', (err) => resolveProbe({ status: null, ok: false, error: err.code ?? err.message }));
    req.end();
  });
}

export function portFree(host, port) {
  return new Promise((resolvePort) => {
    const s = createServer();
    s.once('error', (err) => resolvePort({ free: false, code: err.code }));
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolvePort({ free: true })));
  });
}

function holderOf(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const line = r.stdout.trim().split('\n')[1];
  return line ? { command: line.split(/\s+/)[0], pid: Number(line.split(/\s+/)[1]) } : null;
}

export async function status(stateDir) {
  const p = paths(stateDir);
  const state = await readStateTolerant(p.state);
  if (!state) return { state: 'stopped', paths: p };
  if (!isOurServe(state.pid, p.state)) {
    // The recorded pid is not provably this service. If a server still answers at
    // the recorded URL, the state is tampered or recycled and the real server is
    // orphaned: never report it stopped, never clear its state (QA N4).
    const answering = state.url && state.hostHeader ? await probe(state.url, state.hostHeader) : { ok: false };
    if (answering.ok) return { state: 'orphaned', pid: state.pid, url: state.url, detail: 'a server answers at the recorded URL but the recorded pid is not this service; find the listener with lsof and stop it by hand', paths: p, recorded: state };
    return { state: 'stale', pid: state.pid, detail: 'state file names a process that is not running (or not this service)', paths: p, recorded: state };
  }
  const health = await probe(state.url, state.hostHeader);
  return { state: health.ok ? 'running' : 'unhealthy', pid: state.pid, url: state.url, urls: state.urls, allowedHosts: state.allowedHosts, root: state.root, health, paths: p };
}

async function clearStale(p, st) {
  // Only this service's own state file is removed, and only once the recorded
  // process is proven not to be our serve process.
  await unlink(p.state).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  await event(p, { event: 'recovered-stale-state', stalePid: st.pid });
  return { recovered: 'stale-state', stalePid: st.pid };
}

// A failed start ends its own serve child and returns only after the child's exit
// event (I-8): until that event the child is unreaped, so its pid cannot belong to
// another process. SIGTERM first; SIGKILL if it has not exited within graceMs.
// Returns whether SIGKILL was needed.
async function endChild(child, exited, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.ref();
  child.kill('SIGTERM');
  let timer;
  const grace = new Promise((r) => { timer = setTimeout(r, graceMs, 'grace'); });
  const first = await Promise.race([exited, grace]);
  clearTimeout(timer);
  if (first !== 'grace') return false;
  child.kill('SIGKILL');
  await exited;
  return true;
}

// The serve arguments and the saved config for one start, built in one place. The serve
// process discovers the Tailscale node again and every restart reads the config, so an
// expectation that is missing from either one would let a different node be bound later.
export function serveLaunch({ root, statePath, bind, tailscale = false, allowHosts = [], expectTailscale, port }) {
  const args = ['serve', '--root', resolve(root), '--port', String(port), '--state-file', statePath];
  if (tailscale) args.push('--tailscale');
  else args.push('--host', bind.host);
  for (const name of allowHosts) args.push('--allow-host', name);
  if (expectTailscale) args.push('--expect-tailscale-address', expectTailscale.address, '--expect-tailscale-name', expectTailscale.name);
  const config = { root: resolve(root), host: tailscale ? null : bind.host, tailscale, allowHosts, port, ...(expectTailscale ? { expectTailscale } : {}) };
  return { args, config };
}

// Why a running service is not the node a start request expects, or null when it is.
// It is that node only if it listens on the expected address AND was itself started
// with the same expectation: a service started before expectations existed may sit on
// the right address without its name ever having been checked.
export function runningNodeProblem(expected, { url, savedConfig }) {
  const runningHost = new URL(url).hostname;
  const saved = savedConfig?.expectTailscale;
  const savedName = saved ? String(saved.name).toLowerCase().replace(/\.$/, '') : null;
  if (runningHost === expected.address && saved && saved.address === expected.address && savedName === expected.name) return null;
  const startedFor = saved ? `started for the node ${saved.address} (${saved.name})` : 'started without an expected node';
  return `a service is already running on ${runningHost}, ${startedFor}; that is not the expected node ${expected.address} (${expected.name}). It was left running: stop it first with "service stop", then start again`;
}

// readState is the ready poll's state reader; tests inject torn reads through it
// to reproduce QA D-F2 deterministically.
export async function start({ stateDir, root, host, tailscale = false, allowHosts = [], expectTailscale, port = 8791, readyTimeoutMs = 10000, stopTimeoutMs = STOP_TIMEOUT_MS, readState = (f) => readFile(f, 'utf8') }) {
  const p = paths(stateDir);
  // The request is judged before the running service is looked at: a malformed or
  // missing expectation is refused whether or not something is already running.
  // One object carries the bind request to the request check, the bind and the launch,
  // so none of the three can be given less than the others.
  const request = { host, tailscale, allowHosts, expectTailscale };
  const requested = checkBindRequest(request);
  await mkdir(p.dir, { recursive: true });
  const current = await status(stateDir);
  const recovery = [];
  if (current.state === 'running' || current.state === 'unhealthy') {
    const same = current.root === resolve(root);
    if (current.state === 'running' && same) {
      // "Already running" answers the request only when it runs on the node asked for.
      if (requested.expected) {
        const problem = runningNodeProblem(requested.expected, { url: current.url, savedConfig: await readJson(p.config) });
        if (problem) throw new ServiceError('already-running-elsewhere', `${problem} (pid ${current.pid})`);
      }
      return { state: 'running', alreadyRunning: true, pid: current.pid, url: current.url, urls: current.urls, recovery };
    }
    throw new ServiceError('already-running', `service in ${p.dir} is ${current.state} (pid ${current.pid}); stop it first`);
  }
  if (current.state === 'orphaned') throw new ServiceError('orphaned', `${current.detail} (${current.url})`);
  if (current.state === 'stale') recovery.push(await clearStale(p, current));

  const bind = assertBindAllowed(resolveBind(request));
  const free = await portFree(bind.host, port);
  if (!free.free) {
    const holder = holderOf(port);
    await event(p, { event: 'start-refused', reason: 'port-in-use', host: bind.host, port, holder });
    throw new ServiceError('port-in-use', `${bind.host}:${port} is in use${holder ? ` by ${holder.command} (pid ${holder.pid})` : ''}; choose another --port`, { holder });
  }

  const { args, config } = serveLaunch({ ...request, root, statePath: p.state, bind, port });
  await writeJsonAtomic(p.config, config);
  const log = await open(p.log, 'a');
  const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  // The child's start identity, taken here and nowhere later. Why the pid is still the child's: there is
  // no await and no turn of the event loop between the spawn and this call; the call is synchronous
  // (spawnSync runs a loop of its own and never collects this process's other children); and unref
  // comes after it. So this process cannot have collected the child yet, and while a child is
  // uncollected the system gives its pid to no one else. If the child has already died it is still an
  // uncollected zombie, and ps may still report its start time: that identity is then recorded for a
  // process that is gone, which is harmless, because any later holder of the pid has another start time.
  const childStart = Number.isSafeInteger(child.pid) ? startIdentity(child.pid) : null;
  const exited = new Promise((r) => child.once('exit', () => r('exited')));
  child.unref();
  await log.close();
  await event(p, { event: 'start', pid: child.pid, ...(childStart ? { startIdentity: childStart } : {}), config });

  const deadline = Date.now() + readyTimeoutMs;
  let corrupt = null;
  while (Date.now() < deadline) {
    // An unparseable read keeps polling until the deadline; only a state that is
    // still corrupt when the budget runs out (or the child exits) is an error.
    let state = null;
    corrupt = null;
    try {
      state = await readStateTolerant(p.state, { attempts: 1, read: readState });
    } catch (err) {
      if (err.code !== 'state-corrupt') {
        const forced = await endChild(child, exited, stopTimeoutMs);
        await event(p, { event: 'start-failed', pid: child.pid, reason: err.code ?? err.message, forced });
        throw err;
      }
      corrupt = err;
    }
    if (state && state.pid === child.pid) {
      const health = await probe(state.url, state.hostHeader);
      if (health.ok) {
        await event(p, { event: 'ready', pid: child.pid, url: state.url });
        return { state: 'running', pid: child.pid, url: state.url, urls: state.urls, allowedHosts: state.allowedHosts, recovery };
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const forced = await endChild(child, exited, stopTimeoutMs);
  if (corrupt) {
    await event(p, { event: 'start-failed', pid: child.pid, reason: 'state-corrupt', forced });
    throw corrupt;
  }
  const tail = (await readFile(p.log, 'utf8').catch(() => '')).split('\n').slice(-8).join('\n');
  await event(p, { event: 'start-failed', pid: child.pid, forced });
  throw new ServiceError('not-ready', `serve did not become ready within ${readyTimeoutMs}ms; log tail:\n${tail}`);
}

export async function stop({ stateDir, timeoutMs = STOP_TIMEOUT_MS }) {
  const p = paths(stateDir);
  const current = await status(stateDir);
  if (current.state === 'stopped') return { state: 'stopped', wasRunning: false };
  if (current.state === 'orphaned') throw new ServiceError('orphaned', `${current.detail} (${current.url})`);
  if (current.state === 'stale') return { state: 'stopped', wasRunning: false, ...(await clearStale(p, current)) };
  process.kill(current.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (alive(current.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  let forced = false;
  if (alive(current.pid)) {
    // Own serve process ignored SIGTERM: identity was proven above, so force it.
    process.kill(current.pid, 'SIGKILL');
    forced = true;
    await new Promise((r) => setTimeout(r, 200));
  }
  await unlink(p.state).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  await event(p, { event: 'stop', pid: current.pid, forced });
  return { state: 'stopped', wasRunning: true, pid: current.pid, forced };
}

export async function restart({ stateDir, ...overrides }) {
  const p = paths(stateDir);
  const saved = await readJson(p.config);
  if (!saved && !overrides.root) throw new ServiceError('no-config', `no previous start recorded in ${p.config}; use service start`);
  const config = { ...saved, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };
  // Refuse before stopping. A config that can no longer be started (a --tailscale start
  // saved without its expected node, or a discovery that now returns another node) must
  // leave the running service as it is, not stop it and then refuse.
  assertBindAllowed(resolveBind({ host: config.host ?? undefined, tailscale: config.tailscale, allowHosts: config.allowHosts ?? [], expectTailscale: config.expectTailscale ?? undefined }));
  const stopped = await stop({ stateDir });
  const started = await start({ stateDir, root: config.root, host: config.host ?? undefined, tailscale: config.tailscale, allowHosts: config.allowHosts ?? [], expectTailscale: config.expectTailscale ?? undefined, port: config.port });
  await event(p, { event: 'restart', previousPid: stopped.pid ?? null, pid: started.pid });
  return { stopped, started };
}

async function nearestExisting(path) {
  let dir = path;
  while (!(await lstat(dir).catch(() => null))) dir = dirname(dir);
  return dir;
}

async function gitIgnored(path) {
  const cwd = await nearestExisting(dirname(path));
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    inRepo: git('rev-parse', '--is-inside-work-tree').status === 0,
    ignored: git('check-ignore', '-q', path).status === 0,
    tracked: git('ls-files', '--error-unmatch', path).status === 0,
  };
}

// Residue cleanup. Removes only: this service's stale state file (when its process
// is gone) and dead-publisher staging directories inside a store
// (<store>/.staging/<id>.<pid>.<rand> whose pid is not alive). Never removes
// packets, aliases, receipts, logs, evidence, lock files, or tracked files, and
// refuses any target that is tracked or not gitignored.
export async function clean({ stateDir, store }) {
  const removed = [];
  const kept = [];
  const p = paths(stateDir);
  for (const target of [p.dir, ...(store ? [resolve(store)] : [])]) {
    const g = await gitIgnored(target);
    if (g.inRepo && (g.tracked || !g.ignored)) throw new ServiceError('refused', `${target} is tracked or not gitignored; clean only touches ignored outputs`);
  }
  const st = await status(stateDir);
  if (st.state === 'stale') {
    await clearStale(p, st);
    removed.push({ path: p.state, reason: `stale state for dead pid ${st.pid}` });
  } else if (st.state !== 'stopped') {
    kept.push({ path: p.state, reason: `service is ${st.state}` });
  }
  if (store) {
    const staging = join(resolve(store), '.staging');
    const entries = await readdir(staging).catch(() => []);
    for (const name of entries) {
      const pid = Number(name.split('.')[1]);
      const abs = join(staging, name);
      const info = await lstat(abs);
      if (!info.isDirectory() || !/^sha256-[0-9a-f]{64}\.\d+\.[0-9a-f]+$/.test(name)) {
        kept.push({ path: abs, reason: 'not a publisher staging directory' });
      } else if (alive(pid)) {
        kept.push({ path: abs, reason: `publisher pid ${pid} still running` });
      } else {
        await rm(abs, { recursive: true, force: true });
        removed.push({ path: abs, reason: `staging left by dead publisher pid ${pid}` });
      }
    }
    const locks = (await readdir(join(resolve(store), 'aliases')).catch(() => [])).filter((f) => f.endsWith('.lock'));
    for (const lock of locks) kept.push({ path: join(resolve(store), 'aliases', lock), reason: 'alias locks fail closed; remove manually after confirming no writer (runbook)' });
  }
  await event(p, { event: 'clean', removed: removed.map((r) => r.path), kept: kept.map((k) => k.path) });
  return { removed, kept };
}
