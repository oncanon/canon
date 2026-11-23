// README gate (artifact-publisher-readme-gate): README.md is a product interface, so
// every command, route, header, status and exit code, path, link and viewport it
// states is executed or mechanically checked against the current tree, and the test
// fails closed on anything it cannot classify or check.
//
//   - Quick start: executed verbatim (PORT := an ephemeral port) in a temp directory
//     populated by `git archive HEAD` when the tree is clean, else by a file copy
//     (red-control scratch copies have no .git); loopback only.
//   - Every other fenced shell command: mechanically checked (npm script exists; CLI
//     subcommand and flags exist in the CLI's usage; script flags exist in the
//     script's argument parsing), or exempt with a reason. Unclassified commands fail.
//   - Tables: routes, security headers and exit codes are checked against live
//     loopback servers; paths against the tree and the quick-start outputs;
//     viewports against the browser suite.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../../src/server/server.mjs';
import { allowedHostsFor, resolveBind } from '../../src/server/bind.mjs';
import { isOurServe } from '../../src/service.mjs';
import { REPO } from '../helpers.mjs';
import { BROWSER_SUITES, code, commandsOf, fencedBlocks, fileRefs, linkTargets, locationPaths, NODE_SCRIPT, npmBody, npmScriptName, proseOf, QUICK_START, QUICK_START_INPUTS, tableAfterHeader as tableIn, words } from '../readme-paths.mjs';

const README = readFileSync(join(REPO, 'README.md'), 'utf8');
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const ALIAS = 'phase1-review';

// ---- README parsing -------------------------------------------------------------------
// The parsing is shared with the red-controls copy-scope guard (test/readme-paths.mjs): one copy of each pattern.
const lines = README.split('\n');
const BLOCKS = fencedBlocks(lines);
const COMMANDS = commandsOf(BLOCKS);

const tableAfterHeader = (headerRow) => tableIn(lines, headerRow);

function slug(text) {
  return text.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}
const HEADINGS = new Set(lines.filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#{1,6} /, ''))));

// ---- CLI and script introspection -------------------------------------------------------
const USAGE = spawnSync(process.execPath, [join(REPO, 'src/cli.mjs')], { encoding: 'utf8' }).stderr;
const usageLines = USAGE.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('canon '));

// "node src/cli.mjs <sub> [<sub2>] ...flags": the subcommand (and service action) must
// have a usage line, and every --flag must appear in that line.
function checkCli(argv) {
  const [sub, maybe] = argv;
  const candidates = usageLines.filter((u) => {
    const [, s, a] = u.split(/\s+/);
    if (s !== sub) return false;
    if (sub === 'alias' || sub === 'service') return a.split('|').includes(maybe);
    return true;
  });
  if (!candidates.length) return `no usage line for "${argv.slice(0, 2).join(' ')}"`;
  for (const flag of argv.filter((a) => a.startsWith('--'))) {
    const name = flag.split('=')[0];
    if (!candidates.some((u) => u.includes(`${name} `) || u.includes(`${name}]`) || u.endsWith(name))) return `flag ${name} not in usage for ${sub}`;
  }
  return null;
}

function checkScript(file, argv) {
  const path = join(REPO, file);
  if (!existsSync(path)) return `${file} does not exist`;
  const src = readFileSync(path, 'utf8');
  for (const flag of argv.filter((a) => a.startsWith('--'))) if (!src.includes(`'${flag}'`)) return `${file} does not parse ${flag}`;
  return null;
}

function checkNpm(argv) {
  const name = npmScriptName(argv);
  if (!name || !PKG.scripts[name]) return `npm script "${name}" is not defined in package.json`;
  const body = npmBody(PKG, name);
  if (body.startsWith('node src/cli.mjs ')) return checkCli(body.split(/\s+/).slice(2));
  if (body.startsWith('node scripts/')) return checkScript(body.split(/\s+/)[1], body.split(/\s+/).slice(2));
  return null;
}

// Explicit exemptions with reasons: commands the test must never run.
const EXEMPT = new Map([
  ['node node_modules/playwright-core/cli.js install chromium webkit', 'downloads Playwright browser builds from the network; offline cycles never run it (README "Browser prerequisite")'],
  ['npx skills@latest add OWNER/canon', 'illustrative Agent Skills installer command; OWNER is replaced by the repository owner and installation is an explicit network action'],
]);

// Does a command bind a non-loopback address? Derived from package.json and the CLI
// flags, not from a hand-kept list of names.
function bindsTailnet(cmd) {
  const w = words(cmd);
  if (/\bCANON_LIVE_TAILNET=1\b/.test(cmd)) return true;
  if (w[0] === 'npm' && w[1] === 'run') return /(?:--tailscale|--tailnet|CANON_LIVE_TAILNET=1)/.test(PKG.scripts[w[2]] ?? '');
  if (w.includes('--tailscale') || w.includes('--tailnet')) return true;
  const host = w.indexOf('--host');
  return host >= 0 && !['127.0.0.1', '::1'].includes(w[host + 1]);
}

function classify(c) {
  if (c.block === QUICK_START) return { kind: 'executed', how: 'quick start, executed verbatim by this test' };
  if (EXEMPT.has(c.cmd)) return { kind: 'exempt', how: EXEMPT.get(c.cmd) };
  const w = words(c.cmd);
  if (w[0] === 'npm') {
    const problem = checkNpm(w.slice(1));
    const binds = w[1] === 'run' && /tailscale|tailnet/.test(w[2]);
    return { kind: 'mechanical', how: `package.json script ${w[1] === 'run' ? w[2] : w[1]} exists${PKG.scripts[w[1] === 'run' ? w[2] : w[1]]?.startsWith('node src/cli.mjs') ? '; CLI flags checked' : ''}${binds ? '; binds the tailnet: never executed by the default tests' : ''}`, problem };
  }
  if (w[0] === 'node' && w[1] === 'src/cli.mjs') return { kind: 'mechanical', how: 'CLI subcommand and flags checked against its usage', problem: checkCli(w.slice(2)) };
  if (w[0] === 'node' && NODE_SCRIPT.test(w[1])) return { kind: 'mechanical', how: `${w[1]} exists and parses its flags`, problem: checkScript(w[1], w.slice(2)) };
  return { kind: 'unclassified', how: null, problem: 'command is not executed, mechanically checkable or exempt' };
}

const CLASSIFIED = COMMANDS.map((c) => ({ ...c, ...classify(c) }));

test('[E9] every fenced shell command in README.md is classified (executed, mechanically checked or exempt) and every check passes', (t) => {
  assert.ok(COMMANDS.length > 20, `README has ${COMMANDS.length} commands`);
  const unclassified = CLASSIFIED.filter((c) => c.kind === 'unclassified').map((c) => `line ${c.line}: ${c.cmd}`);
  assert.deepEqual(unclassified, [], 'unclassified README commands');
  const failing = CLASSIFIED.filter((c) => c.problem).map((c) => `line ${c.line}: ${c.cmd}: ${c.problem}`);
  assert.deepEqual(failing, [], 'mechanical checks that fail');
  t.diagnostic(`readme-sha256 ${JSON.stringify({ path: 'README.md', sha256: sha256(Buffer.from(README, 'utf8')), bytes: Buffer.byteLength(README) })}`);
  t.diagnostic(`readme-classification ${JSON.stringify(CLASSIFIED.map(({ line, cmd, kind, how, expectedExit }) => ({ line, command: cmd, class: kind, check: how, expectedExit })))}`);
});

// ---- Quick start --------------------------------------------------------------------------
async function freePort() {
  return new Promise((resolve) => { const s = createServer(); s.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function populate(dir) {
  // git archive HEAD is exact when every input the quick start uses is unmodified
  // relative to HEAD (a proof run writes its own evidence directory meanwhile).
  const clean = existsSync(join(REPO, '.git')) && spawnSync('git', ['status', '--porcelain', '--', ...QUICK_START_INPUTS], { cwd: REPO, encoding: 'utf8' }).stdout === '';
  if (clean) {
    const r = spawnSync('sh', ['-c', 'git -C "$1" archive HEAD | tar -x -C "$2"', 'sh', REPO, dir]);
    assert.equal(r.status, 0, 'git archive extraction');
    return { mode: 'git archive HEAD', commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() };
  }
  for (const e of QUICK_START_INPUTS.filter((x) => x !== 'README.md')) await cp(join(REPO, e), join(dir, e), { recursive: true });
  return { mode: 'file copy (working tree not clean or no .git)', commit: null };
}

// One quick-start run is shared by the tests below; its directory lives until the
// end of the file, and no serve process started from it may outlive the file.
let quick = null; // { dir, results, snapshots, port }
let quickDir = null;

// The serve processes this file started, from what they recorded themselves: every state
// directory in the quick-start copy (dist/service, and the svc-* directories of the exit-code
// test) has an events.jsonl whose "start" lines name the pid of each serve it started.
async function recordedServes(dir) {
  const stateDirs = [join(dir, 'dist/service'), ...(await readdir(dir)).filter((e) => e.startsWith('svc-')).map((e) => join(dir, e))];
  const found = [];
  for (const stateDir of stateDirs) {
    const text = await readFile(join(stateDir, 'events.jsonl'), 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });
    for (const line of text.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.event === 'start' && Number.isSafeInteger(record.pid)) found.push({ pid: record.pid, statePath: join(stateDir, 'state.json') });
    }
  }
  return found;
}

// No serve started from the quick-start copy may outlive the file. Each recorded pid is looked
// at alone, and only a process that is still that state directory's serve is signalled
// (isOurServe: the one process's own command line must name this state file). No list of the
// host's processes is taken, and nothing is signalled because its command line looks right.
test.after(async () => {
  if (!quickDir) return;
  for (const { pid, statePath } of await recordedServes(quickDir)) {
    if (isOurServe(pid, statePath)) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await rm(quickDir, { recursive: true, force: true });
});

async function runQuickStart() {
  if (quick) return quick;
  const dir = await mkdtemp(join(tmpdir(), 'canon-readme-'));
  quickDir = dir;
  const source = await populate(dir);
  const topBefore = new Set(await readdir(dir));
  const port = await freePort();
  const steps = CLASSIFIED.filter((c) => c.block === QUICK_START);
  assert.ok(steps.length >= 15, 'the quick start has its steps');
  await mkdir(join(dir, '.snap'));
  const script = ['exec 2>&1', ...steps.map((s, i) => {
    const cmd = /^PORT=\d+$/.test(s.cmd) ? `PORT=${port}` : s.cmd;
    return `printf '\\n::step ${i}::\\n'\n${cmd}\nprintf '\\n::exit ${i} %d::\\n' $?\nfind dist -print > .snap/${i}.txt 2>/dev/null`;
  })].join('\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CANON_LOOPBACK_ONLY: '1', npm_config_audit: 'false', npm_config_fund: 'false' };
  const out = await new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd: dir, env });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('close', () => resolve(buf));
  });
  const results = steps.map((s, i) => {
    const body = out.split(`::step ${i}::`)[1]?.split(`::exit ${i} `)[0] ?? '';
    const exit = Number(out.match(new RegExp(`::exit ${i} (\\d+)::`))?.[1] ?? NaN);
    return { step: i + 1, command: s.cmd, ran: /^PORT=\d+$/.test(s.cmd) ? `PORT=${port}` : s.cmd, expectedExit: s.expectedExit, exit, output: body.trim().slice(0, 1500) };
  });
  const snapshots = new Set();
  for (let i = 0; i < steps.length; i += 1) {
    const f = join(dir, '.snap', `${i}.txt`);
    if (existsSync(f)) for (const p of (await readFile(f, 'utf8')).split('\n').filter(Boolean)) snapshots.add(p);
  }
  // Top-level entries the quick start created (the test's own .snap excluded).
  const created = (await readdir(dir)).filter((e) => !topBefore.has(e) && e !== '.snap').sort();
  quick = { dir, source, results, snapshots, port, created };
  return quick;
}

test('[E9] the quick start runs end to end on loopback with the documented exit codes, URLs and byte-exact read-back', async (t) => {
  const q = await runQuickStart();
  const bad = q.results.filter((r) => r.exit !== r.expectedExit).map((r) => `step ${r.step} "${r.ran}": exit ${r.exit}, expected ${r.expectedExit}\n${r.output}`);
  assert.deepEqual(bad, [], 'quick-start steps with an unexpected exit code');
  const step = (prefix, nth = 0) => q.results.filter((r) => r.ran.startsWith(prefix))[nth];
  const manifest = JSON.parse(await readFile(join(q.dir, 'dist/packet/manifest.json'), 'utf8'));
  const started = JSON.parse(step('node src/cli.mjs service start').output);
  assert.equal(started.state, 'running');
  assert.equal(started.url, `http://127.0.0.1:${q.port}`);
  assert.equal(JSON.parse(step('node src/cli.mjs service status').output).state, 'running');
  assert.equal(step('curl -fsS').output, 'ok');
  const md = await readFile(join(q.dir, 'dist/review.md'));
  const html = await readFile(join(q.dir, 'dist/review.html'));
  assert.deepEqual(q.created, ['dist', 'node_modules'], 'the quick start writes only under dist/ (gitignored) and node_modules/');
  const entry = (p) => manifest.files.find((f) => f.path === p);
  assert.equal(sha256(md), entry('report.md').sha256, 'agent alias route reads back report.md byte for byte');
  assert.equal(sha256(html), entry('index.html').sha256, 'human alias route reads back index.html byte for byte');
  const sums = step('shasum').output.split('\n').map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(sums, [entry('report.md').sha256, entry('report.md').sha256]);
  assert.equal(JSON.parse(step('node src/cli.mjs service status', 1).output).state, 'stopped');
  assert.equal(JSON.parse(step('node src/cli.mjs service status', 2).output).state, 'stale');
  const recovered = JSON.parse(step('node src/cli.mjs service restart', 1).output);
  assert.equal(recovered.started.state, 'running', 'restart after the crash brings the service back');
  const events = (await readFile(join(q.dir, 'dist/service/events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).event);
  assert.ok(events.includes('recovered-stale-state'), `events: ${events.join(',')}`);
  assert.equal(JSON.parse(step('node src/cli.mjs service stop', 1).output).state, 'stopped');
  t.diagnostic(`readme-quickstart ${JSON.stringify({ source: q.source, port: q.port, contentId: manifest.contentId, steps: q.results.map(({ step: n, command, ran, expectedExit, exit, output }) => ({ step: n, command, ran, expectedExit, exit, output: output.slice(0, 600) })) })}`);
});

// ---- Live checks: routes, headers, exit codes -------------------------------------------------
// Raw HTTP so the Host header is sent exactly as documented (fetch forbids setting it).
function raw(base, method, path, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function served(t) {
  const q = await runQuickStart();
  const srv = await startServer({ root: join(q.dir, 'dist/review-store') });
  t.after(() => srv.server.close());
  const manifest = JSON.parse(await readFile(join(q.dir, 'dist/packet/manifest.json'), 'utf8'));
  return { ...srv, q, manifest };
}

test('[E9] every route in the README routes table answers with the documented status, Location, Content-Type and Cache-Control', async (t) => {
  const s = await served(t);
  const rows = tableAfterHeader('| Request | Status | Content-Type | Cache-Control |');
  const vars = { '<content-id>': s.manifest.contentId, '<name>': ALIAS, '<sha256>': s.manifest.files.find((f) => f.path === 'report.md').sha256 };
  const fill = (x) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), x);
  const checked = [];
  for (const [request, status, type, cache] of rows) {
    const [reqLine, headerSpec] = code(request);
    const [method, path] = fill(reqLine).split(' ');
    const headers = {};
    if (headerSpec) { const [k, ...v] = fill(headerSpec).split(': '); headers[k] = v.join(': '); }
    const res = await raw(s.url, method, path, headers);
    const expectedStatus = Number(status.match(/^\d{3}/)[0]);
    assert.equal(res.status, expectedStatus, `${request}: status`);
    const location = code(status)[0];
    if (location) assert.equal(res.headers.location, fill(location), `${request}: Location`);
    if (type === 'none') assert.equal(res.headers['content-type'], undefined, `${request}: no Content-Type`);
    else assert.equal(res.headers['content-type'], code(type)[0], `${request}: Content-Type`);
    assert.equal(res.headers['cache-control'], code(cache)[0], `${request}: Cache-Control`);
    const file = { [`/p/${s.manifest.contentId}/`]: 'index.html', [`/p/${s.manifest.contentId}/report.md`]: 'report.md' }[path];
    if (file && res.status === 200) {
      const entry = s.manifest.files.find((f) => f.path === file);
      assert.equal(res.headers.etag, `"${entry.sha256}"`, `${request}: ETag is the manifest digest`);
      assert.equal(sha256(res.body), entry.sha256, `${request}: body matches the manifest`);
    }
    checked.push({ request: `${method} ${path}${headerSpec ? ` (${fill(headerSpec)})` : ''}`, status: res.status });
  }
  // Every route written in backticks anywhere in the README matches a table row.
  const templates = rows.map((r) => code(r[0])[0].split(' ')[1]);
  const mentioned = [...README.matchAll(/`(\/(?:a|p)\/[^`]*)`/g)].map((m) => m[1]);
  const matchesTemplate = (m) => templates.some((tpl) => tpl === m || tpl.startsWith(m) || (m.includes('...') && tpl.startsWith(m.split('...')[0])));
  assert.deepEqual(mentioned.filter((m) => !matchesTemplate(m)), [], 'routes in prose that are not in the routes table');
  // Every HTTP status named in the README is one the table documents.
  const documented = new Set(rows.map((r) => r[1].slice(0, 3)));
  const named = [...README.matchAll(/\b(200|204|206|301|302|303|304|307|308|400|401|403|404|405|416|421|500|502|503)\b(?![0-9x%p])/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].filter((n) => !documented.has(n)), [], 'HTTP statuses in the README that the routes table does not document');
  t.diagnostic(`readme-routes ${JSON.stringify(checked)}`);
});

test('[E9] every documented security header is present with its documented value', async (t) => {
  const s = await served(t);
  const rows = tableAfterHeader('| Header | Value |');
  for (const path of ['/healthz', `/p/${s.manifest.contentId}/`, `/p/${s.manifest.contentId}/report.md`, `/a/${ALIAS}/`]) {
    const res = await raw(s.url, 'GET', path);
    for (const [name, value] of rows) assert.equal(res.headers[code(name)[0].toLowerCase()], code(value)[0], `${path}: ${code(name)[0]}`);
  }
  const html = await readFile(join(s.q.dir, 'dist/packet/index.html'), 'utf8');
  const csp = code(rows.find((r) => code(r[0])[0] === 'Content-Security-Policy')[1])[0];
  // The meta tag carries the header policy without frame-ancestors (ignored in <meta>).
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1]?.replace(/&#39;/g, "'");
  assert.equal(meta, csp.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; '), 'the page carries the documented policy, minus frame-ancestors, in a meta tag');
  assert.match(README, /minus `frame-ancestors`/, 'the README states the meta-tag difference');
});

async function cli(dir, args) {
  const r = spawnSync(process.execPath, [join(REPO, 'src/cli.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANON_LOOPBACK_ONLY: '1' } });
  return r;
}

test('[E9] every documented service exit code (0-6) and CLI exit code (0-2) is produced live on loopback', async (t) => {
  const q = await runQuickStart();
  const serviceRows = tableAfterHeader('| Exit | Service state |');
  const cliRows = tableAfterHeader('| Exit | Meaning |');
  const store = join(q.dir, 'dist/review-store');
  const observed = {};
  const sd = (n) => join(q.dir, `svc-${n}`);
  const port = await freePort();
  // 0 running, then 3 unhealthy (state points at a closed port), then 1 stopped.
  assert.equal((await cli(q.dir, ['service', 'start', '--root', store, '--state-dir', sd('a'), '--port', String(port)])).status, 0);
  observed[0] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('a')])).status;
  // 4 port in use.
  observed[4] = (await cli(q.dir, ['service', 'start', '--root', store, '--state-dir', sd('b'), '--port', String(port)])).status;
  // 5 orphaned: state names a live process that is not this service, while a server answers.
  const sleeper = spawn('sleep', ['30']);
  t.after(() => sleeper.kill());
  const stateA = JSON.parse(await readFile(join(sd('a'), 'state.json'), 'utf8'));
  await mkdir(sd('c'), { recursive: true });
  await writeFile(join(sd('c'), 'state.json'), JSON.stringify({ ...stateA, pid: sleeper.pid }));
  observed[5] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('c')])).status;
  // 6 corrupt.
  await mkdir(sd('d'), { recursive: true });
  await writeFile(join(sd('d'), 'state.json'), '{"pid":');
  observed[6] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('d')])).status;
  // 3 unhealthy: this service's own pid, but a URL where nothing answers.
  const closed = await freePort();
  const statePath = join(sd('a'), 'state.json');
  const original = await readFile(statePath, 'utf8');
  await writeFile(statePath, JSON.stringify({ ...stateA, url: `http://127.0.0.1:${closed}`, hostHeader: `127.0.0.1:${closed}` }));
  observed[3] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('a')])).status;
  await writeFile(statePath, original);
  assert.equal((await cli(q.dir, ['service', 'stop', '--state-dir', sd('a')])).status, 0);
  observed[1] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('a')])).status;
  // 2 stale: a dead pid.
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.on('exit', r));
  await mkdir(sd('e'), { recursive: true });
  await writeFile(join(sd('e'), 'state.json'), JSON.stringify({ ...stateA, pid: dead.pid }));
  observed[2] = (await cli(q.dir, ['service', 'status', '--state-dir', sd('e')])).status;
  const documentedService = Object.fromEntries(serviceRows.map(([code2, meaning]) => [Number(code2), meaning]));
  assert.deepEqual(Object.keys(documentedService).map(Number).sort(), [0, 1, 2, 3, 4, 5, 6], 'the service table documents exactly 0-6');
  for (const [codeN] of Object.entries(documentedService)) assert.equal(observed[codeN], Number(codeN), `service exit ${codeN} (${documentedService[codeN]})`);
  // CLI: 0 success, 1 failure (tampered packet), 2 usage.
  const cliObserved = { 0: (await cli(q.dir, ['verify', 'dist/packet'])).status };
  const tampered = join(q.dir, 'tampered');
  await cp(join(q.dir, 'dist/packet'), tampered, { recursive: true });
  await writeFile(join(tampered, 'report.md'), 'tampered\n');
  cliObserved[1] = (await cli(q.dir, ['verify', tampered])).status;
  cliObserved[2] = (await cli(q.dir, ['verify'])).status;
  // The usage-error shapes the table distinguishes, produced live.
  const shapes = {
    'unknown flag': { args: ['verify', '--bogus', 'x'], exit: (await cli(q.dir, ['verify', '--bogus', 'x'])).status },
    'unknown command': { args: ['bogus'], exit: (await cli(q.dir, ['bogus'])).status },
    'missing required argument': { args: ['verify'], exit: (await cli(q.dir, ['verify'])).status },
    'no command': { args: [], exit: (await cli(q.dir, [])).status },
  };
  const rowFor = (phrase) => cliRows.find(([, meaning]) => meaning.includes(phrase));
  for (const [phrase, { exit }] of Object.entries(shapes)) {
    const row = rowFor(phrase);
    assert.ok(row, `the CLI table names "${phrase}"`);
    assert.equal(exit, Number(row[0]), `${phrase} exits ${exit}; the README says ${row[0]}`);
  }
  assert.deepEqual(cliRows.map(([c]) => Number(c)), [0, 1, 2], 'the CLI table documents exactly 0-2');
  for (const [c] of cliRows) assert.equal(cliObserved[c], Number(c), `CLI exit ${c}`);
  // Every "exit N" / "exits N" in the README names a documented code.
  const all = new Set([...Object.keys(documentedService), ...cliRows.map(([c]) => c)].map(Number));
  const named = [...README.matchAll(/\bexits? (\d+)\b/g)].map((m) => Number(m[1]));
  assert.deepEqual(named.filter((n) => !all.has(n)), [], 'exit codes named in the README but not documented');
  t.diagnostic(`readme-exit-codes ${JSON.stringify({ service: observed, cli: cliObserved })}`);
});

test('[E9] every path in the README locations table exists in the tree or is produced by the quick start', async (t) => {
  const q = await runQuickStart();
  const missing = [];
  for (const p of locationPaths(lines)) {
    const inTree = existsSync(join(REPO, p));
    const produced = q.snapshots.has(p);
    if (!inTree && !produced) missing.push(p);
  }
  assert.deepEqual(missing, [], 'documented paths that neither exist nor are produced');
  // Paths named in backticks elsewhere that look like repository files must exist.
  assert.deepEqual(fileRefs(README).filter((f) => !existsSync(join(REPO, f))), [], 'repository paths in the README that do not exist');
});

test('[E9] every relative link resolves to a file, every anchor link to a heading, and there are no unexempted external links', () => {
  const EXTERNAL_ALLOWED = new Set();
  const prose = proseOf(lines, BLOCKS);
  const links = linkTargets(prose);
  assert.ok(links.length > 0);
  const problems = [];
  for (const target of links) {
    if (/^[a-z]+:/i.test(target)) { if (!EXTERNAL_ALLOWED.has(target)) problems.push(`external link ${target}`); continue; }
    const [file, frag] = target.split('#');
    if (file) {
      if (!existsSync(join(REPO, file))) problems.push(`missing file ${file}`);
      else if (frag) {
        const other = readFileSync(join(REPO, file), 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#{1,6} /, '')));
        if (!other.includes(frag)) problems.push(`missing heading #${frag} in ${file}`);
      }
    } else if (!HEADINGS.has(frag)) problems.push(`missing heading #${frag}`);
  }
  assert.deepEqual(problems, [], 'broken README links');
  assert.doesNotMatch(prose.replace(/`[^`]*`/g, ''), /<[a-z][a-z0-9-]*[\s>/]/i, 'no HTML in the README prose');
});

test('[E9] the Tailscale example is mechanically checked (flags exist, the URL form is the service\'s allowed MagicDNS authority) and is not bound', () => {
  const ts = CLASSIFIED.filter((c) => /tailscale/.test(c.cmd));
  assert.ok(ts.length >= 2 && ts.every((c) => c.kind === 'mechanical' && !c.problem), 'tailscale commands are mechanically checked');
  const defaultPort = USAGE.match(/\[--port (\d+)\]/)[1];
  const urls = [...README.matchAll(/`(http:\/\/<machine>\.<tailnet>\.ts\.net:(\d+)(\/[^`]*))`/g)];
  assert.ok(urls.length >= 2, 'the README gives the human and agent Tailscale URLs');
  const bind = resolveBind({ tailscale: true, expectTailscale: { address: '100.64.0.7', name: 'machine.tailnet.ts.net' }, detect: () => ({ address: '100.64.0.7', dnsName: 'machine.tailnet.ts.net' }), interfaces: { utun9: [{ address: '100.64.0.7', family: 'IPv4', internal: false }] } });
  for (const [, url, port, path] of urls) {
    assert.equal(port, defaultPort, `${url}: the service's default port`);
    const allowed = allowedHostsFor({ address: bind.host, family: 'IPv4', port: Number(port) }, bind.names);
    assert.ok(allowed.has(`machine.tailnet.ts.net:${port}`), `${url}: the MagicDNS name at that port is an allowed Host`);
    assert.ok([`/a/${ALIAS}/`, `/a/${ALIAS}/report.md`].includes(path), `${url}: a documented alias route`);
  }
});

test('[E9] documented test commands exist, the default suites are loopback-only, and counts are not hard-coded', () => {
  for (const name of ['test', 'test:browser', 'test:tailnet']) assert.ok(CLASSIFIED.some((c) => c.cmd === (name === 'test' ? 'npm test' : `npm run ${name}`)), `README documents ${name}`);
  assert.match(PKG.scripts.test, /CANON_LOOPBACK_ONLY=1/, 'the default suite is loopback-only as documented');
  assert.match(PKG.scripts['test:browser'], /CANON_LOOPBACK_ONLY=1/);
  const dev = README.slice(README.indexOf('## Development and verification'), README.indexOf('## Scope and known residuals'));
  assert.doesNotMatch(dev, /\b\d+ (?:tests?|passed|passing|controls|seeds|cases|suites)\b/, 'no brittle counts');
});

test('[E9] the viewport table and browser-test references match the browser suites', async () => {
  const { VIEWPORTS } = await import('../browser/setup.mjs');
  const rows = tableAfterHeader('| Viewport | Size |');
  assert.deepEqual(rows.map(([n, s]) => `${n} ${s}`), VIEWPORTS.map((v) => `${v.name} ${v.width}x${v.height}`));
  const browserTests = BROWSER_SUITES.map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
  for (const tag of new Set([...README.matchAll(/\((P1[0-9])\)/g)].map((m) => m[1]))) assert.ok(browserTests.includes(`[${tag}]`), `${tag} is a browser test tag`);
});

test('[E9] README covers the nine brief sections under stable headings', () => {
  const required = ['what-it-guarantees', 'quick-start-five-minutes', 'output-contract', 'serving-and-security', 'reviewing-on-laptop-iphone-and-ipad', 'operations', 'development-and-verification', 'scope-and-known-residuals', 'architecture'];
  assert.deepEqual(required.filter((h) => !HEADINGS.has(h)), []);
  const text = README;
  for (const must of ['D-G1', 'D-G2', 'cmark-gfm', 'commonmark', 'D1b', 'R1', 'D2', 'D4', 'D5', 'D6', 'Range', 'tailnet membership', 'ACLs']) assert.ok(text.includes(must), `residuals mention ${must}`);
});

test('[E9] a command that binds the tailnet appears only in a block labelled opt-in-tailnet, under an explicit warning', () => {
  const violations = CLASSIFIED.filter((c) => bindsTailnet(c.cmd) && !c.labels.includes('opt-in-tailnet')).map((c) => `line ${c.line}: ${c.cmd}`);
  assert.deepEqual(violations, [], 'tailnet-binding commands in a default (unlabelled) block');
  const optIn = BLOCKS.filter((b) => b.labels.includes('opt-in-tailnet'));
  assert.ok(optIn.length >= 2, 'the Tailscale example and test:tailnet are opt-in blocks');
  // Each opt-in block sits under the bold opt-in warning: the nearest warning above
  // it is at most 20 lines back, with only prose and other opt-in blocks between.
  const WARNING = /^\*\*Opt-in: binds this machine's Tailscale address\./;
  for (const b of optIn) {
    let n = b.start - 2;
    while (n >= 0 && !WARNING.test(lines[n])) n -= 1;
    assert.ok(n >= 0 && b.start - 1 - n <= 20, `block at line ${b.start} has the opt-in warning above it`);
    const between = BLOCKS.filter((o) => o.start > n + 1 && o.start < b.start);
    assert.ok(between.every((o) => o.labels.includes('opt-in-tailnet')), `only opt-in blocks sit between the warning and the block at line ${b.start}`);
  }
  // No fenced command carries a bare <placeholder> that a shell would read as a redirection.
  const redirects = CLASSIFIED.filter((c) => /(^|\s)[^\s"'`]*<[A-Za-z][^>\s]*>/.test(c.cmd.replace(/"[^"]*"|'[^']*'/g, ''))).map((c) => `line ${c.line}: ${c.cmd}`);
  assert.deepEqual(redirects, [], 'unquoted <placeholder> in a fenced command');
});
