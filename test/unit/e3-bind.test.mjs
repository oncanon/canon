import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import test from 'node:test';
import { allowedHostsFor, assertBindAllowed, BindError, classifyAddress, detectTailscale, resolveBind } from '../../src/server/bind.mjs';
import { isAllowedHost, startServer } from '../../src/server/server.mjs';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { paths, restart, runningNodeProblem, serveLaunch, ServiceError, start, START_IDENTITY_TIMEOUT_MS, startIdentity, status, stop } from '../../src/service.mjs';
import { liveTailnet, runCli } from '../helpers.mjs';

// Interface table modelled on the review host: Tailscale on utun5, an unrelated
// VPN holding a 100.x address on utun0, and the Wi-Fi LAN on en0.
const IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }],
  utun0: [{ address: '100.64.0.22', family: 'IPv4' }, { address: '10.8.0.2', family: 'IPv4' }],
  utun5: [{ address: '100.64.0.11', family: 'IPv4' }],
  en0: [{ address: '192.168.68.57', family: 'IPv4' }, { address: 'fe80::1c36:cba3:37ae:bee6', family: 'IPv6' }],
};
const TS = () => ({ address: '100.64.0.11', dnsName: 'review-host.example-tailnet.ts.net' });
const NO_TS = () => { throw new BindError('tailscale unavailable'); };
const EXPECT = { address: TS().address, name: TS().dnsName };
const bind = (opts) => resolveBind({ interfaces: IFACES, detect: TS, ...opts });

test('[E3] loopback is the default bind and needs no opt-in', () => {
  assert.deepEqual(bind({}), { host: '127.0.0.1', kind: 'loopback', names: [] });
  assert.deepEqual(bind({ host: '::1' }), { host: '::1', kind: 'loopback', names: [] });
  assert.deepEqual(bind({ host: '[::1]' }), { host: '::1', kind: 'loopback', names: [] });
});

test('[E3] --tailscale binds exactly the Tailscale address and allows its MagicDNS name', () => {
  assert.deepEqual(bind({ tailscale: true, expectTailscale: EXPECT }), { host: '100.64.0.11', kind: 'tailscale', names: ['review-host.example-tailnet.ts.net'] });
  assert.equal(bind({ host: '100.64.0.11' }).host, '100.64.0.11', '--host naming the Tailscale address is allowed');
  assert.throws(() => bind({ tailscale: true, host: '100.64.0.11' }), /either --host or --tailscale/);
  assert.throws(() => resolveBind({ interfaces: IFACES, detect: NO_TS, tailscale: true, expectTailscale: EXPECT }), /tailscale unavailable/);
});

test('[E3] an explicitly named private LAN address on a physical interface is allowed', () => {
  assert.deepEqual(bind({ host: '192.168.68.57' }), { host: '192.168.68.57', kind: 'private', names: [] });
  assert.deepEqual(bind({ host: '192.168.68.57', allowHosts: ['review.lan'] }).names, ['review.lan']);
});

test('[E3] refused: wildcards, public, link-local, hostnames, unassigned, other-VPN and tunnel addresses', () => {
  const refused = {
    '0.0.0.0': /wildcard/, '::': /wildcard/, '[::]': /wildcard/, '0:0:0:0:0:0:0:0': /wildcard/, '': /wildcard/,
    '8.8.8.8': /public/, '2001:4860:4860::8888': /public/,
    '169.254.1.1': /link-local/, 'fe80::1c36:cba3:37ae:bee6': /link-local/,
    localhost: /not an IP literal/, 'review-host.example-tailnet.ts.net': /not an IP literal/, 'evil.example': /not an IP literal/,
    '192.168.1.10': /not assigned/, '10.0.0.9': /not assigned/, '100.100.100.100': /not assigned/,
    '100.64.0.22': /not this machine's Tailscale address/, // the unrelated VPN address on utun0
    '10.8.0.2': /tunnel interface utun0/,
  };
  for (const [host, re] of Object.entries(refused)) {
    assert.throws(() => bind({ host }), (err) => err instanceof BindError && re.test(err.message) && /^refusing to bind/.test(err.message), `${host} should be refused with ${re}`);
  }
  // Without a working Tailscale detector the CGNAT address is still refused.
  assert.throws(() => resolveBind({ interfaces: IFACES, detect: NO_TS, host: '100.64.0.11' }), /not this machine's Tailscale address/);
  assert.throws(() => bind({ allowHosts: ['review.lan'] }), /only to non-loopback/);
  assert.throws(() => bind({ host: '192.168.68.57', allowHosts: ['*.evil'] }), /not a plain hostname/);
  assert.throws(() => bind({ host: '192.168.68.57', allowHosts: ['localhost'] }), /not a plain hostname/);
});

test('[E3] CANON_LOOPBACK_ONLY=1 refuses every non-loopback bind, loopback still works', () => {
  const saved = process.env.CANON_LOOPBACK_ONLY;
  process.env.CANON_LOOPBACK_ONLY = '1';
  try {
    for (const opts of [{ tailscale: true, expectTailscale: EXPECT }, { host: '100.64.0.11' }, { host: '192.168.68.57' }]) {
      assert.throws(() => assertBindAllowed(bind(opts)), /CANON_LOOPBACK_ONLY=1 disables non-loopback binds/, JSON.stringify(opts));
    }
    assert.equal(assertBindAllowed(bind({})).host, '127.0.0.1');
    assert.equal(assertBindAllowed(bind({ host: '::1' })).host, '::1');
  } finally {
    if (saved === undefined) delete process.env.CANON_LOOPBACK_ONLY;
    else process.env.CANON_LOOPBACK_ONLY = saved;
  }
});

test('[E3] under the lockdown, startServer refuses a non-loopback bind before opening a socket', async () => {
  if (process.env.CANON_LOOPBACK_ONLY !== '1') return;
  await assert.rejects(startServer({ root: '/nonexistent', host: '192.168.68.57', interfaces: IFACES, detect: TS }), /CANON_LOOPBACK_ONLY=1/);
  await assert.rejects(startServer({ root: '/nonexistent', tailscale: true, expectTailscale: EXPECT, interfaces: IFACES, detect: TS }), /CANON_LOOPBACK_ONLY=1/);
});

test('[E3] the default unit suite runs with the loopback lockdown on', () => {
  // npm test sets CANON_LOOPBACK_ONLY=1 and never CANON_LIVE_TAILNET; the opt-in
  // script is the only way to run live tailnet binds.
  if (liveTailnet()) return;
  assert.equal(process.env.CANON_LOOPBACK_ONLY, '1', 'run the default suite via npm test (CANON_LOOPBACK_ONLY=1)');
});

test('[E3] address classification', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('100.64.0.11'), 'cgnat');
  assert.equal(classifyAddress('192.168.68.57'), 'private');
  assert.equal(classifyAddress('172.31.255.255'), 'private');
  assert.equal(classifyAddress('172.32.0.1'), 'public');
  assert.equal(classifyAddress('fd7a:115c:a1e0::ee35:2211'), 'private');
});

test('[E3] Host allowlist: bound authority, localhost only for loopback, named hosts for other binds', () => {
  const lo = { address: '127.0.0.1', family: 'IPv4', port: 8791 };
  assert.deepEqual([...allowedHostsFor(lo)].sort(), ['127.0.0.1:8791', 'localhost:8791']);
  const ts = { address: '100.64.0.11', family: 'IPv4', port: 8791 };
  const names = ['review-host.example-tailnet.ts.net'];
  assert.deepEqual([...allowedHostsFor(ts, names)].sort(), ['100.64.0.11:8791', 'review-host.example-tailnet.ts.net:8791']);
  for (const ok of ['100.64.0.11:8791', 'Review-Host.example-tailnet.ts.net:8791']) assert.equal(isAllowedHost(ok, ts, names), true, ok);
  for (const bad of ['localhost:8791', '127.0.0.1:8791', 'review-host.example-tailnet.ts.net.:8791', 'review-host.example-tailnet.ts.net', 'review-host:8791', '100.64.0.11:8792', 'evil.example:8791', '192.168.68.57:8791', '100.64.0.22:8791', '']) {
    assert.equal(isAllowedHost(bad, ts, names), false, bad);
  }
});

// Live check on the real Tailscale interface (the only authorized non-loopback
// address). Skipped, with a diagnostic, where Tailscale is not running.
test('[E3] live Tailscale bind serves the Tailscale authority and MagicDNS name, and refuses other Hosts', async (t) => {
  if (!liveTailnet()) {
    t.skip('opt-in only: CANON_LIVE_TAILNET=1 (npm run test:tailnet); the default suite never binds the tailnet');
    return;
  }
  let ts;
  try {
    ts = detectTailscale();
  } catch (err) {
    t.skip(`tailscale unavailable: ${err.message}`);
    return;
  }
  if (!ts.dnsName) {
    t.skip('this node reports no Self DNS name, so no expectation can be stated');
    return;
  }
  const srv = await startServer({ root: '/nonexistent-store', tailscale: true, expectTailscale: { address: ts.address, name: ts.dnsName }, port: 0 });
  t.after(() => srv.server.close());
  assert.equal(srv.address.address, ts.address);
  const get = (host) => new Promise((resolve, reject) => {
    const req = request({ host: ts.address, port: srv.address.port, path: '/healthz', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await get(`${ts.address}:${srv.address.port}`), 200);
  if (ts.dnsName) assert.equal(await get(`${ts.dnsName}:${srv.address.port}`), 200);
  for (const bad of [`localhost:${srv.address.port}`, `127.0.0.1:${srv.address.port}`, `evil.example:${srv.address.port}`]) assert.equal(await get(bad), 421, bad);
  t.diagnostic(`tailscale=${ts.address} name=${ts.dnsName} port=${srv.address.port}`);
});

// Two Tailscale nodes on one host. Each
// node's CLI answers consistently for itself; which one answers depends on PATH and on
// socket discovery. Node A is the one the operator means. The CLI is a stub at the spawn
// boundary: no real tailscale call is made and nothing listens off loopback.
const NODE_A = TS();
const NODE_B = { address: IFACES.utun0[0].address, dnsName: NODE_A.dnsName.replace(/^[^.]+/, 'second-node') };
const TWO_NODE_IFACES = { ...IFACES, utun0: [{ address: NODE_B.address, family: 'IPv4' }] };
const cliFor = (node, { dnsName = `${node.dnsName}.` } = {}) => (command, args) => {
  assert.equal(command, 'tailscale');
  if (args[0] === 'ip') return { status: 0, stdout: `${node.address}\n` };
  return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: dnsName, TailscaleIPs: [node.address, 'fd7a:115c:a1e0::1'] } }) };
};
// A discovery that counts its calls and answers from a list, repeating the last answer.
function discovery(...clis) {
  const seen = { calls: 0 };
  const detect = () => {
    const cli = clis[Math.min(seen.calls, clis.length - 1)];
    seen.calls += 1;
    return detectTailscale(cli);
  };
  return { detect, seen };
}
const expectA = { address: NODE_A.address, name: NODE_A.dnsName };
const twoNode = (opts) => resolveBind({ interfaces: TWO_NODE_IFACES, ...opts });
const refusal = (re) => (err) => err instanceof BindError && /^refusing to bind/.test(err.message) && re.test(err.message);

test('[E3] two Tailscale nodes on one host each answer consistently, so discovery alone cannot tell them apart', () => {
  assert.deepEqual(detectTailscale(cliFor(NODE_A)), NODE_A);
  assert.deepEqual(detectTailscale(cliFor(NODE_B)), NODE_B);
  assert.notEqual(NODE_A.address, NODE_B.address);
});

test('[E3] an expected node is bound only when discovery returns exactly that node', () => {
  assert.deepEqual(twoNode({ tailscale: true, expectTailscale: expectA, detect: discovery(cliFor(NODE_A)).detect }), { host: NODE_A.address, kind: 'tailscale', names: [NODE_A.dnsName] });
  // The expected name is compared as discovery reports it: lower case, no trailing dot.
  assert.equal(twoNode({ tailscale: true, expectTailscale: { address: NODE_A.address, name: `${NODE_A.dnsName.toUpperCase()}.` }, detect: discovery(cliFor(NODE_A)).detect }).host, NODE_A.address);

  // The other node is a valid node, and it is refused.
  assert.throws(() => twoNode({ tailscale: true, expectTailscale: expectA, detect: discovery(cliFor(NODE_B)).detect }), (err) => {
    assert.ok(refusal(/a different node/)(err), err.message);
    assert.ok(err.message.includes(NODE_B.address) && err.message.includes(NODE_A.address) && err.message.includes(NODE_A.dnsName), 'names what was found and what was expected');
    assert.ok(/nothing was bound/.test(err.message));
    return true;
  });
  // The right address under another name, or under none.
  assert.throws(() => twoNode({ tailscale: true, expectTailscale: expectA, detect: discovery(cliFor(NODE_A, { dnsName: `${NODE_B.dnsName}.` })).detect }), refusal(/reports the DNS name second-node\./));
  assert.throws(() => twoNode({ tailscale: true, expectTailscale: expectA, detect: discovery(cliFor(NODE_A, { dnsName: '' })).detect }), refusal(/reports the DNS name \(none\)/));
});

test('[E3] a discovery that changes between two resolutions is refused the second time', () => {
  // The service resolves once itself, again in the serve process, and again on every restart.
  const { detect, seen } = discovery(cliFor(NODE_A), cliFor(NODE_B));
  assert.equal(twoNode({ tailscale: true, expectTailscale: expectA, detect }).host, NODE_A.address);
  assert.throws(() => twoNode({ tailscale: true, expectTailscale: expectA, detect }), refusal(/a different node/));
  assert.equal(seen.calls, 2);
});

test('[E3] --host with an expected node needs that address and a matching discovery, and a failed discovery is the refusal', () => {
  assert.deepEqual(twoNode({ host: NODE_A.address, expectTailscale: expectA, detect: discovery(cliFor(NODE_A)).detect }), { host: NODE_A.address, kind: 'cgnat', names: [] });
  assert.throws(() => twoNode({ host: NODE_A.address, expectTailscale: expectA, detect: discovery(cliFor(NODE_B)).detect }), refusal(/a different node/));
  assert.throws(() => twoNode({ host: NODE_A.address, expectTailscale: expectA, detect: NO_TS }), refusal(/tailscale unavailable/));
  const other = discovery(cliFor(NODE_B));
  assert.throws(() => twoNode({ host: NODE_B.address, expectTailscale: expectA, detect: other.detect }), refusal(/--host \S+ is not the expected Tailscale address/));
  assert.equal(other.seen.calls, 0, 'refused before the CLI is asked');
});

test('[E3] a malformed or misapplied expectation is refused before the CLI is asked', () => {
  const cases = [
    ['an address with no name', { tailscale: true, expectTailscale: { address: NODE_A.address } }, /needs both --expect-tailscale-address and --expect-tailscale-name/],
    ['a name with no address', { tailscale: true, expectTailscale: { name: NODE_A.dnsName } }, /needs both --expect-tailscale-address and --expect-tailscale-name/],
    ['a LAN address', { tailscale: true, expectTailscale: { ...expectA, address: '192.168.68.57' } }, /is not an IPv4 address in 100\.64\.0\.0\/10/],
    ['an IPv6 address', { tailscale: true, expectTailscale: { ...expectA, address: 'fd7a:115c:a1e0::1' } }, /is not an IPv4 address in 100\.64\.0\.0\/10/],
    ['a name that is not a hostname', { tailscale: true, expectTailscale: { ...expectA, name: '*.evil' } }, /is not a plain hostname/],
    ['localhost as the name', { tailscale: true, expectTailscale: { ...expectA, name: 'localhost' } }, /is not a plain hostname/],
    ['the loopback default', { expectTailscale: expectA }, /applies only to a Tailscale bind/],
    ['a loopback --host', { host: '127.0.0.1', expectTailscale: expectA }, /is not the expected Tailscale address/],
    ['a LAN --host', { host: '192.168.68.57', expectTailscale: expectA }, /is not the expected Tailscale address/],
  ];
  for (const [what, opts, re] of cases) {
    const { detect, seen } = discovery(cliFor(NODE_A));
    assert.throws(() => twoNode({ ...opts, detect }), refusal(re), what);
    assert.equal(seen.calls, 0, `${what}: the CLI was asked`);
  }
});

test('[E3] startServer refuses a different node before the lockdown is even consulted, and opens no socket', async () => {
  if (process.env.CANON_LOOPBACK_ONLY !== '1') return;
  const base = { root: '/nonexistent', tailscale: true, expectTailscale: expectA, interfaces: TWO_NODE_IFACES };
  await assert.rejects(startServer({ ...base, detect: discovery(cliFor(NODE_B)).detect }), refusal(/a different node/));
  // The matching node passes the node check and is then stopped by the lockdown: nothing binds here.
  await assert.rejects(startServer({ ...base, detect: discovery(cliFor(NODE_A)).detect }), /CANON_LOOPBACK_ONLY=1/);
});

test('[E3] service start and restart carry the expectation to the bind check, and the CLI carries both flags', async (t) => {
  // An expectation on a loopback bind is refused before the tailscale CLI is asked, so these
  // refusals show the expectation arriving at the bind check without any tailscale call.
  const stateDir = await mkdtemp(join(tmpdir(), 'canon-expect-'));
  t.after(async () => { await stop({ stateDir }).catch(() => {}); await rm(stateDir, { recursive: true, force: true }); });
  const port = await new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: '127.0.0.1', port: 0 }, () => { const found = s.address().port; s.close(() => resolve(found)); });
  });
  const started = async () => (await readFile(paths(stateDir).events, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.event === 'start');

  await assert.rejects(start({ stateDir, root: stateDir, expectTailscale: expectA, port }), refusal(/applies only to a Tailscale bind/));
  assert.deepEqual(await started(), [], 'no serve process was started');

  await writeFile(paths(stateDir).config, JSON.stringify({ root: stateDir, host: null, tailscale: false, allowHosts: [], port, expectTailscale: expectA }));
  await assert.rejects(restart({ stateDir }), refusal(/applies only to a Tailscale bind/));
  assert.deepEqual(await started(), [], 'no serve process was started by the restart');

  const oneFlag = runCli(['serve', '--root', stateDir, '--port', String(port), '--expect-tailscale-address', NODE_A.address]);
  assert.equal(oneFlag.status, 1);
  assert.match(oneFlag.stderr, /needs both --expect-tailscale-address and --expect-tailscale-name/);
  const bothFlags = runCli(['service', 'start', '--root', stateDir, '--state-dir', stateDir, '--port', String(port), '--expect-tailscale-address', NODE_A.address, '--expect-tailscale-name', NODE_A.dnsName]);
  assert.equal(bothFlags.status, 1);
  assert.match(bothFlags.stderr, /applies only to a Tailscale bind/);
});

test('[E3] --tailscale with no expected node is refused, with the two flags and where to read their values', async (t) => {
  const { detect, seen } = discovery(cliFor(NODE_A));
  assert.throws(() => twoNode({ tailscale: true, detect }), (err) => {
    assert.ok(refusal(/--tailscale needs the node you expect/)(err), err.message);
    for (const part of ['--expect-tailscale-address', '--expect-tailscale-name', 'tailscale ip -4', 'tailscale status --json', 'Self.DNSName']) assert.ok(err.message.includes(part), part);
    return true;
  });
  assert.equal(seen.calls, 0, 'refused before the CLI is asked: nothing is auto-selected');
  // Naming both ways of binding is still the older, more specific refusal.
  assert.throws(() => twoNode({ tailscale: true, host: NODE_A.address, detect }), refusal(/either --host or --tailscale/));

  // A service config saved before the expectation existed: restart refuses it with the same
  // message and starts nothing. One that holds an expectation still reaches the node check
  // (shown above, where the saved expectation arrives at the bind check).
  const stateDir = await mkdtemp(join(tmpdir(), 'canon-saved-'));
  t.after(async () => { await stop({ stateDir }).catch(() => {}); await rm(stateDir, { recursive: true, force: true }); });
  await writeFile(paths(stateDir).config, JSON.stringify({ root: stateDir, host: null, tailscale: true, allowHosts: [], port: 8791 }));
  await assert.rejects(restart({ stateDir }), refusal(/--tailscale needs the node you expect: add --expect-tailscale-address <ipv4> and --expect-tailscale-name <dns-name>/));
  assert.equal(await readFile(paths(stateDir).events, 'utf8').catch(() => ''), '', 'no event: nothing was started or probed');

  const bare = runCli(['service', 'start', '--root', stateDir, '--state-dir', stateDir, '--tailscale']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--tailscale needs the node you expect/);
});

test('[E3] the serve arguments and the saved config both carry the expectation, from one place', () => {
  const bound = { host: NODE_A.address, kind: 'tailscale', names: [NODE_A.dnsName] };
  const withNode = serveLaunch({ root: '/store', statePath: '/state/state.json', bind: bound, tailscale: true, allowHosts: ['review.lan'], expectTailscale: expectA, port: 8791 });
  assert.deepEqual(withNode.args, [
    'serve', '--root', '/store', '--port', '8791', '--state-file', '/state/state.json', '--tailscale', '--allow-host', 'review.lan',
    '--expect-tailscale-address', NODE_A.address, '--expect-tailscale-name', NODE_A.dnsName,
  ], 'the serve process is given the expectation');
  assert.deepEqual(withNode.config, { root: '/store', host: null, tailscale: true, allowHosts: ['review.lan'], port: 8791, expectTailscale: expectA }, 'the saved config holds the expectation');

  const loopback = serveLaunch({ root: '/store', statePath: '/state/state.json', bind: { host: '127.0.0.1', kind: 'loopback', names: [] }, port: 8791 });
  assert.deepEqual(loopback.args, ['serve', '--root', '/store', '--port', '8791', '--state-file', '/state/state.json', '--host', '127.0.0.1']);
  assert.deepEqual(loopback.config, { root: '/store', host: '127.0.0.1', tailscale: false, allowHosts: [], port: 8791 });
});

test('[E3] a running service is the expected node only on that address and started with that expectation', () => {
  const expected = { address: NODE_A.address, name: NODE_A.dnsName };
  const urlOf = (node) => `http://${node.address}:8791`;
  assert.equal(runningNodeProblem(expected, { url: urlOf(NODE_A), savedConfig: { expectTailscale: expectA } }), null);
  assert.equal(runningNodeProblem(expected, { url: urlOf(NODE_A), savedConfig: { expectTailscale: { address: NODE_A.address, name: `${NODE_A.dnsName.toUpperCase()}.` } } }), null, 'the saved name is compared as discovery reports it');
  const cases = [
    ['on the other node', { url: urlOf(NODE_B), savedConfig: { expectTailscale: { address: NODE_B.address, name: NODE_B.dnsName } } }, /already running on \S+, started for the node/],
    ['on the right address, started before expectations existed', { url: urlOf(NODE_A), savedConfig: { tailscale: true } }, /started without an expected node/],
    ['on the right address, started for another name', { url: urlOf(NODE_A), savedConfig: { expectTailscale: { address: NODE_A.address, name: NODE_B.dnsName } } }, /started for the node/],
    ['with no saved config', { url: urlOf(NODE_A), savedConfig: null }, /started without an expected node/],
    ['on loopback', { url: 'http://127.0.0.1:8791', savedConfig: { tailscale: false } }, /already running on 127\.0\.0\.1/],
    // The saved expectation is the one asked for, and only the running address is wrong.
    ['saved for this node but running on loopback', { url: 'http://127.0.0.1:8791', savedConfig: { expectTailscale: expectA } }, /already running on 127\.0\.0\.1, started for the node/],
    ['saved for this node but running on the other address', { url: urlOf(NODE_B), savedConfig: { expectTailscale: expectA } }, /already running on \S+, started for the node/],
  ];
  for (const [what, running, re] of cases) {
    const problem = runningNodeProblem(expected, running);
    assert.match(problem ?? '', re, what);
    assert.ok(problem.includes(NODE_A.address) && problem.includes(NODE_A.dnsName) && /left running: stop it first/.test(problem), `${what}: names the expected node and says to stop the running one`);
  }
});

test('[E3] a running service does not answer a start for another node, and a refused restart leaves it running', async (t) => {
  // The running service is a real one on loopback, started and stopped by this test. No
  // tailscale call is made: every refusal below is decided before discovery.
  const stateDir = await mkdtemp(join(tmpdir(), 'canon-running-'));
  t.after(async () => { await stop({ stateDir }).catch(() => {}); await rm(stateDir, { recursive: true, force: true }); });
  const port = await new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: '127.0.0.1', port: 0 }, () => { const found = s.address().port; s.close(() => resolve(found)); });
  });
  const first = await start({ stateDir, root: stateDir, port });
  assert.equal(first.state, 'running');
  const stillRunning = async (why) => {
    const now = await status(stateDir);
    assert.ok(now.state === 'running' && now.pid === first.pid, `${why}: the running service was left untouched`);
  };
  // What start saved is what serveLaunch returns for the same request.
  assert.deepEqual(JSON.parse(await readFile(paths(stateDir).config, 'utf8')), serveLaunch({ root: stateDir, statePath: paths(stateDir).state, bind: { host: '127.0.0.1' }, port }).config, 'the saved config is the launch config');

  // Before this fix each of these returned "already running" and exit 0. If the loopback
  // service had died, this start would go on to discovery; so it is checked alive first,
  // and for the call itself PATH is a directory that holds only a link to ps (which the
  // service needs to recognise its own process): no tailscale CLI can be found on it.
  await stillRunning('before the start for node A');
  const onlyPs = await mkdtemp(join(tmpdir(), 'canon-onlyps-'));
  t.after(() => rm(onlyPs, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  const ps = savedPath.split(delimiter).map((dir) => join(dir, 'ps')).find((file) => existsSync(file));
  assert.ok(ps, 'ps is on PATH');
  await symlink(ps, join(onlyPs, 'ps'));
  process.env.PATH = onlyPs;
  try {
    await assert.rejects(start({ stateDir, root: stateDir, port, tailscale: true, expectTailscale: expectA }), (err) => {
      assert.ok(err instanceof ServiceError && err.code === 'already-running-elsewhere', String(err));
      assert.ok(err.message.includes('127.0.0.1') && err.message.includes(NODE_A.address) && /stop it first/.test(err.message), err.message);
      return true;
    }, 'a start for node A is not answered by the loopback service');
  } finally {
    process.env.PATH = savedPath;
  }
  await assert.rejects(start({ stateDir, root: stateDir, port, tailscale: true }), refusal(/--tailscale needs the node you expect/), 'a bare --tailscale');
  await assert.rejects(start({ stateDir, root: stateDir, port, tailscale: true, expectTailscale: { address: NODE_A.address } }), refusal(/needs both/), 'one flag alone');
  await assert.rejects(start({ stateDir, root: stateDir, port, tailscale: true, expectTailscale: { ...expectA, address: '192.168.68.57' } }), refusal(/is not an IPv4 address in 100\.64\.0\.0\/10/), 'a malformed address');
  await stillRunning('after the refused starts');

  // The same request as the running one is still answered by it.
  const again = await start({ stateDir, root: stateDir, port });
  assert.ok(again.alreadyRunning === true && again.pid === first.pid, 'an identical start is idempotent');

  // A config saved by a --tailscale start from before the expected node existed: restart
  // refuses BEFORE it stops anything.
  await writeFile(paths(stateDir).config, JSON.stringify({ root: stateDir, host: null, tailscale: true, allowHosts: [], port }));
  await assert.rejects(restart({ stateDir }), refusal(/--tailscale needs the node you expect/));
  await stillRunning('after the refused restart');
  const events = (await readFile(paths(stateDir).events, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line).event);
  assert.ok(!events.includes('stop'), 'no stop event was recorded');
});

// A pid can be reused; a pid with its start time names one process. The service records that pair where it
// is known exactly: the parent for its child at the spawn, the serve process for itself.
test('[E3] a started service records its start identity: the parent in its start line, the serve process in its own state file', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'canon-identity-'));
  t.after(async () => { await stop({ stateDir }).catch(() => {}); await rm(stateDir, { recursive: true, force: true }); });
  const port = await new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: '127.0.0.1', port: 0 }, () => { const found = s.address().port; s.close(() => resolve(found)); });
  });
  const first = await start({ stateDir, root: stateDir, port });
  const FORM = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
  const now = startIdentity(first.pid);
  assert.match(now ?? '', FORM, 'the running serve has a start identity, in the one fixed form');

  const startLine = (await readFile(paths(stateDir).events, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).findLast((e) => e.event === 'start');
  assert.equal(startLine.pid, first.pid);
  assert.equal(startLine.startIdentity, now, 'the start line holds the child identity taken at the spawn');
  const state = JSON.parse(await readFile(paths(stateDir).state, 'utf8'));
  assert.equal(state.pid, first.pid);
  assert.equal(state.startIdentity, now, 'the serve process recorded its own identity');

  // Never a guess: no identity for something that is not one running process.
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  for (const [what, pid] of [['a process that has exited', dead.pid], ['pid 1', 1], ['a negative number', -first.pid], ['a fraction', first.pid + 0.5], ['text', String(first.pid)]]) {
    assert.equal(startIdentity(pid), null, what);
  }
});

// `service start` waits for this ps, so it has a time limit, and an answer that did not arrive whole is no
// answer. The launcher is stood in for: no ps is started and nothing waits.
test('[E3] the start identity comes from one bounded ps call, and a ps that timed out or was signalled gives none', () => {
  const IDENTITY = 'Mon Oct 12 23:00:09 2026';
  const calls = [];
  const answering = (answer) => (command, args, options) => { calls.push({ command, args, options }); return answer; };

  assert.equal(startIdentity(4242, answering({ status: 0, signal: null, stdout: `${IDENTITY}\n` })), IDENTITY);
  assert.equal(startIdentity(4242, answering({ status: 0, signal: null, stdout: 'Mon Oct 12  23:00:09   2026 \n' })), IDENTITY, 'white space is made single');
  const { command, args, options } = calls[0];
  assert.deepEqual([command, args], ['ps', ['-o', 'lstart=', '-p', '4242']], 'one pid, its start time only');
  assert.equal(options.timeout, START_IDENTITY_TIMEOUT_MS, 'the ps call has a time limit');
  assert.equal(START_IDENTITY_TIMEOUT_MS, 2000);
  assert.equal(options.killSignal, 'SIGKILL', 'at the limit ps is killed, not asked to stop');
  assert.deepEqual([options.env.LC_ALL, options.env.TZ], ['C', 'UTC0'], 'the fixed locale and zone are set on the call');

  const timedOut = Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const none = [
    ['a ps that timed out', { status: null, signal: 'SIGTERM', error: timedOut, stdout: '' }],
    ['a ps that timed out after printing an answer', { status: null, signal: 'SIGTERM', error: timedOut, stdout: `${IDENTITY}\n` }],
    ['a ps ended by a signal', { status: null, signal: 'SIGKILL', stdout: `${IDENTITY}\n` }],
    ['a ps that could not be started', { status: null, signal: null, error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }), stdout: '' }],
    // Each of these printed a well-formed identity, so only the status can refuse it.
    ['a ps that exited 1 after printing an identity', { status: 1, signal: null, stdout: `${IDENTITY}\n` }],
    ['a ps that could not be started but has identity text', { status: null, signal: null, error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }), stdout: `${IDENTITY}\n` }],
    ['a ps that failed with nothing printed', { status: 1, signal: null, stdout: '' }],
    ['an answer that is not in the fixed form', { status: 0, signal: null, stdout: '12 Oct 2026 23:00\n' }],
    ['no answer text at all', { status: 0, signal: null, stdout: null }],
  ];
  for (const [what, answer] of none) assert.equal(startIdentity(4242, answering(answer)), null, what);
  const before = calls.length;
  assert.equal(startIdentity(1, answering({ status: 0, signal: null, stdout: `${IDENTITY}\n` })), null, 'pid 1 is never asked about');
  assert.equal(calls.length, before, 'and no ps is started for it');
});
