#!/usr/bin/env node
// E5/E4 access and recovery proof over the real Tailscale interface, using only
// the supported CLI (canon brief / canon service). Prints one JSON record; exits 0
// only if every check holds. Binds nothing but this machine's Tailscale address.
//
//   node scripts/e2e-access.mjs --tailnet [--port 8791]   (opt-in: binds the tailnet)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(REPO, 'src/cli.mjs');
if (!process.argv.includes('--tailnet')) {
  console.error('e2e-access binds this machine\'s Tailscale address; pass --tailnet to opt in (npm run proof:tailnet-access)');
  process.exit(2);
}
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8791;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const now = () => new Date().toISOString();

function canon(args) {
  const startedAt = now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { command: `canon ${args.join(' ')}`, exitCode: r.status, startedAt, finishedAt: now(), json, stderr: r.stderr.trim().slice(0, 600) };
}

function http(url, { method = 'GET', headers = {} } = {}) {
  const u = new URL(url);
  return new Promise((resolveReq) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveReq({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolveReq({ status: null, error: 'timeout' }); });
    req.on('error', (err) => resolveReq({ status: null, error: err.code ?? err.message }));
    req.end();
  });
}

const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
  return ok;
}

const work = await mkdtemp(join(tmpdir(), 'canon-e2e-access-'));
const store = join(work, 'review-store');
const stateDir = join(work, 'service');
const record = { ranAt: now(), port: PORT, commands: [], checks };
try {
  const ts = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
  const status = JSON.parse(spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' }).stdout);
  const tsIp = ts.stdout.trim().split('\n').find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
  const tsName = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  record.tailscale = { ip: tsIp, dnsName: tsName, backend: status.BackendState };

  const review = canon(['brief', join(REPO, 'fixtures/report/phase1-review.report.json'), '--store', store, '--alias', 'phase1-review']);
  record.commands.push(review);
  check('review pipeline exits 0', review.exitCode === 0);
  const contentId = review.json?.contentId;
  record.contentId = contentId;

  const started = canon(['service', 'start', '--root', store, '--state-dir', stateDir, '--tailscale', '--expect-tailscale-address', tsIp, '--expect-tailscale-name', tsName, '--port', String(PORT)]);
  record.commands.push(started);
  check('service start --tailscale exits 0 and is running', started.exitCode === 0 && started.json?.state === 'running');
  check('bound exactly the Tailscale address', started.json?.url === `http://${tsIp}:${PORT}`, { url: started.json?.url });
  check('Host allowlist is the Tailscale authority and MagicDNS name only', JSON.stringify([...(started.json?.allowedHosts ?? [])].sort()) === JSON.stringify([`${tsIp}:${PORT}`, `${tsName}:${PORT}`].sort()), { allowedHosts: started.json?.allowedHosts });

  const manifestBytes = await readFile(join(store, 'packets', contentId, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const inventory = [...manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, mediaType: f.mediaType, bytes: f.bytes })), { path: 'manifest.json', sha256: sha256(manifestBytes), mediaType: 'application/json' }];
  record.urls = {};
  for (const [label, host] of [['tailscale-ip', tsIp], ['magicdns', tsName]]) {
    const base = `http://${host}:${PORT}`;
    // Connect to the Tailscale IP; send the Host a browser would send for this URL.
    const target = `http://${tsIp}:${PORT}`;
    const H = { Host: `${host}:${PORT}` };
    const results = { base, files: [] };
    const health = await http(`${target}/healthz`, { headers: H });
    check(`${label}: /healthz 200`, health.status === 200, { status: health.status });
    const alias = await http(`${target}/a/phase1-review/`, { headers: H });
    check(`${label}: alias 307 to immutable packet, no-store`, alias.status === 307 && alias.headers.location === `/p/${contentId}/` && alias.headers['cache-control'] === 'no-store', { status: alias.status, location: alias.headers.location });
    const aliasJson = await http(`${target}/a/phase1-review.json`, { headers: H });
    check(`${label}: alias record no-store and names the content ID`, aliasJson.status === 200 && aliasJson.headers['cache-control'] === 'no-store' && JSON.parse(aliasJson.body).contentId === contentId);
    const index = await http(`${target}/p/${contentId}/`, { headers: H });
    check(`${label}: packet index 200 text/html with CSP and nosniff`, index.status === 200 && index.headers['content-type'] === 'text/html; charset=utf-8' && /script-src 'none'/.test(index.headers['content-security-policy'] ?? '') && index.headers['x-content-type-options'] === 'nosniff');
    for (const f of inventory) {
      const res = await http(`${target}/p/${contentId}/${f.path}`, { headers: H });
      const digest = res.body ? sha256(res.body) : null;
      const ok = res.status === 200 && digest === f.sha256 && res.headers['content-type'] === f.mediaType && res.headers['cache-control'] === 'public, max-age=31536000, immutable';
      results.files.push({ path: f.path, status: res.status, contentType: res.headers?.['content-type'], sha256: digest, matchesManifest: digest === f.sha256 });
      check(`${label}: read-back ${f.path} bytes equal manifest, correct type, immutable cache`, ok);
    }
    const css = manifest.files.find((f) => f.role === 'asset');
    const head = await http(`${target}/p/${contentId}/${css.path}`, { method: 'HEAD', headers: H });
    check(`${label}: HEAD asset 200 with length and empty body`, head.status === 200 && Number(head.headers['content-length']) === css.bytes && head.body.length === 0);
    const cond = await http(`${target}/p/${contentId}/${css.path}`, { headers: { ...H, 'If-None-Match': `"${css.sha256}"` } });
    check(`${label}: conditional GET 304`, cond.status === 304);
    const foreign = await http(`${target}/a/phase1-review/`, { headers: { Host: `evil.example:${PORT}` } });
    check(`${label}: foreign Host 421`, foreign.status === 421);
    record.urls[label] = results;
  }
  for (const [label, host] of [['loopback', '127.0.0.1'], ['lan', '192.168.68.57']]) {
    const res = await http(`http://${host}:${PORT}/healthz`);
    check(`${label}: not listening while bound to Tailscale only`, res.status === null && res.error === 'ECONNREFUSED', { error: res.error });
  }

  // Recovery on the real service: crash, stale detection, restart.
  const pid = started.json?.pid;
  process.kill(pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  const staleStatus = canon(['service', 'status', '--state-dir', stateDir]);
  record.commands.push(staleStatus);
  check('after SIGKILL, status exits 2 (stale)', staleStatus.exitCode === 2 && staleStatus.json?.state === 'stale');
  const restarted = canon(['service', 'restart', '--state-dir', stateDir]);
  record.commands.push(restarted);
  check('restart recovers stale state and is running on the same Tailscale URL', restarted.exitCode === 0 && restarted.json?.stopped?.recovered === 'stale-state' && restarted.json?.started?.url === `http://${tsIp}:${PORT}`);
  const healthAfter = await http(`http://${tsIp}:${PORT}/healthz`, { headers: { Host: `${tsIp}:${PORT}` } });
  check('healthz 200 after restart', healthAfter.status === 200);

  // Port conflict: a blocker this script owns, on the same Tailscale address.
  const blocker = createServer();
  await new Promise((r) => blocker.listen({ host: tsIp, port: 0 }, r));
  const blockedPort = blocker.address().port;
  const conflict = canon(['service', 'start', '--root', store, '--state-dir', join(work, 'service-conflict'), '--tailscale', '--expect-tailscale-address', tsIp, '--expect-tailscale-name', tsName, '--port', String(blockedPort)]);
  record.commands.push(conflict);
  check('port in use: start exits 4 and names the holder', conflict.exitCode === 4 && /port-in-use: .* is in use by node \(pid \d+\)/.test(conflict.stderr), { stderr: conflict.stderr });
  await new Promise((r) => blocker.close(r));

  const stopped = canon(['service', 'stop', '--state-dir', stateDir]);
  record.commands.push(stopped);
  check('stop exits 0, clean (not forced)', stopped.exitCode === 0 && stopped.json?.wasRunning === true && stopped.json?.forced === false);
  const finalStatus = canon(['service', 'status', '--state-dir', stateDir]);
  record.commands.push(finalStatus);
  check('final status exits 1 (stopped)', finalStatus.exitCode === 1);
  const gone = await http(`http://${tsIp}:${PORT}/healthz`, { headers: { Host: `${tsIp}:${PORT}` } });
  const listener = spawnSync('lsof', ['-nP', `-iTCP@${tsIp}:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
  check('Tailscale port closed after stop (no HTTP response and no listener)', gone.status === null && listener === '', { error: gone.error, listener });
  record.events = (await readFile(join(stateDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).map((e) => e.event);
  record.serverLogLines = (await readFile(join(stateDir, 'server.log'), 'utf8')).trim().split('\n').length;
} finally {
  // Never leave a server behind; then remove this run's own temporary files.
  canon(['service', 'stop', '--state-dir', stateDir]);
  await rm(work, { recursive: true, force: true });
}
record.allOk = checks.length > 0 && checks.every((c) => c.ok);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
process.exit(record.allOk ? 0 : 1);
