// Bind policy for the review server (docs/decisions/phase1-contract.md D6, E2E
// serving). Loopback is the default. A non-loopback bind happens only when the
// operator names it: --tailscale (this machine's Tailscale IPv4 and MagicDNS name,
// from the local tailscale CLI, which must answer for the node the caller expects), or
// an explicit IP literal (--host) that is either
// that same Tailscale address or a private LAN address on a non-tunnel interface.
// Refused always: wildcards, public, link-local, unassigned and hostname binds;
// CGNAT (100.64.0.0/10) addresses that are not the Tailscale address; and any
// address on a tunnel interface (utun/tun/tap/wg/ppp/ipsec) other than Tailscale's,
// because another VPN's reachability is unknown (e.g. a second utun holding a
// 100.x address that is not Tailscale).
//
// A host can run more than one Tailscale node. Which one the CLI answers for depends
// on PATH and on how it finds its daemon socket, and each node's answer is consistent
// with itself. So the caller may name the node it expects (address and Self DNS name),
// and any other answer is refused before a socket is opened.
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export const LOOPBACK = new Set(['127.0.0.1', '::1']);
const WILDCARDS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0']);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class BindError extends Error {
  constructor(message) {
    super(`refusing to bind: ${message}`);
    this.name = 'BindError';
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
}

function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

// Ranges an operator may deliberately expose the review server on.
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];
export function classifyAddress(ip) {
  if (LOOPBACK.has(ip)) return 'loopback';
  if (isIP(ip) === 4) {
    if (inV4(ip, '169.254.0.0/16')) return 'link-local';
    if (inV4(ip, '100.64.0.0/10')) return 'cgnat';
    return PRIVATE_V4.some((c) => inV4(ip, c)) ? 'private' : 'public';
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:')) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'private';
  return 'public';
}

const TUNNEL = /^(?:utun|tun|tap|wg|ppp|ipsec|gif|stf)\d*/;

function localAddresses(interfaces) {
  const out = new Map();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) out.set(a.address.toLowerCase(), name);
  }
  return out;
}

// Local Tailscale identity via the tailscale CLI (talks only to the local daemon).
export function detectTailscale(run = spawnSync) {
  const ip = run('tailscale', ['ip', '-4'], { encoding: 'utf8' });
  const status = run('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (ip.status !== 0 || status.status !== 0) throw new BindError('tailscale is not available or not running (tailscale ip -4 / status failed)');
  const address = ip.stdout.trim().split('\n').map((l) => l.trim()).find((l) => isIP(l) === 4);
  let parsed;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    throw new BindError('tailscale status --json is not valid JSON');
  }
  if (!address) throw new BindError('tailscale reported no IPv4 address');
  if (parsed.BackendState !== 'Running') throw new BindError(`tailscale backend is ${parsed.BackendState}, not Running`);
  const dnsName = String(parsed.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  const selfIps = parsed.Self?.TailscaleIPs ?? [];
  if (!selfIps.includes(address)) throw new BindError(`tailscale ip ${address} is not in Self.TailscaleIPs`);
  return { address, dnsName: HOSTNAME.test(dnsName) ? dnsName : null };
}

// The node the caller expects, normalized, or null when none is named. Both parts are
// required: an address alone would accept another node that was later given it, and a
// name alone says nothing about which address is bound.
function expectedNode(expect) {
  if (expect === undefined || expect === null) return null;
  const address = String(expect.address ?? '');
  const name = String(expect.name ?? '').toLowerCase().replace(/\.$/, '');
  if (expect.address === undefined || expect.name === undefined) throw new BindError('the expected Tailscale node needs both --expect-tailscale-address and --expect-tailscale-name');
  if (isIP(address) !== 4 || classifyAddress(address) !== 'cgnat') throw new BindError(`expected Tailscale address ${address} is not an IPv4 address in 100.64.0.0/10`);
  if (!HOSTNAME.test(name) || name === 'localhost') throw new BindError(`expected Tailscale name ${expect.name} is not a plain hostname`);
  return { address, name };
}

// Discovery must return exactly the expected node. A different valid node is the case
// this exists for: nothing is bound, and the operator fixes PATH or the socket.
function assertExpectedNode(found, expected) {
  if (found.address !== expected.address) {
    throw new BindError(`tailscale discovery returned a different node: ${found.address} (${found.dnsName ?? 'no DNS name'}), expected ${expected.address} (${expected.name}). This host may run more than one Tailscale node; nothing was bound`);
  }
  if (found.dnsName !== expected.name) {
    throw new BindError(`tailscale node ${found.address} reports the DNS name ${found.dnsName ?? '(none)'}, expected ${expected.name}; nothing was bound`);
  }
}

// --tailscale lets the CLI choose the node, so it must come with the node the caller
// expects. This is also what a service config saved before the expectation existed is
// refused with at restart: it is never auto-selected again.
export const TAILSCALE_NEEDS_EXPECTATION = '--tailscale needs the node you expect: add --expect-tailscale-address <ipv4> and --expect-tailscale-name <dns-name>. '
  + 'Read the two values from the tailscale CLI you mean to use: the address from "tailscale ip -4", and the name from Self.DNSName in "tailscale status --json", without its trailing dot';

// Everything about a bind request that can be judged without asking the tailscale CLI:
// the expectation is well formed, it fits the kind of bind, and --tailscale names its
// node. Returns the normalized expectation (or null) and the address the request asks
// for, which is known here because --tailscale must name it. The service checks a
// request with this before it looks at a running service, so that an already-running
// service on another node is never taken for the one asked for. resolveBind starts from
// the address returned here.
export function checkBindRequest({ host, tailscale = false, expectTailscale } = {}) {
  const expected = expectedNode(expectTailscale);
  if (expected && !tailscale) {
    if (host === undefined) throw new BindError('an expected Tailscale node applies only to a Tailscale bind (--tailscale, or --host with that address)');
    if (String(host) !== expected.address) throw new BindError(`--host ${host} is not the expected Tailscale address ${expected.address}`);
  }
  if (tailscale) {
    if (host !== undefined) throw new BindError('use either --host or --tailscale, not both');
    if (!expected) throw new BindError(TAILSCALE_NEEDS_EXPECTATION);
    return { expected, address: expected.address };
  }
  return { expected, address: host === undefined ? '127.0.0.1' : String(host).replace(/^\[(.*)\]$/, '$1') };
}

// Returns { host, kind, names } or throws BindError. `interfaces` and `tailscale`
// are injectable for tests.
export function resolveBind({ host, tailscale = false, allowHosts = [], expectTailscale, interfaces = networkInterfaces(), detect = detectTailscale } = {}) {
  let names = [];
  // The requested address comes from the request check: one place strips IPv6 brackets
  // and supplies the loopback default.
  const { expected, address } = checkBindRequest({ host, tailscale, expectTailscale });
  let ip = address;
  if (tailscale) {
    const ts = detect();
    assertExpectedNode(ts, expected);
    ip = ts.address;
    if (ts.dnsName) names.push(ts.dnsName);
  }
  if (WILDCARDS.has(ip) || ip === '') throw new BindError(`${ip} is a wildcard address (all interfaces); name one specific address`);
  if (!isIP(ip)) throw new BindError(`${ip} is not an IP literal; bind an address, not a hostname`);
  const kind = classifyAddress(ip);
  if (kind === 'public') throw new BindError(`${ip} is a public address; the review server is never exposed to the internet`);
  if (kind === 'link-local') throw new BindError(`${ip} is link-local`);
  if (kind !== 'loopback') {
    const local = localAddresses(interfaces);
    const iface = local.get(ip.toLowerCase());
    if (!iface) throw new BindError(`${ip} is not assigned to any local interface`);
    // With an expected node, discovery must answer and must match: a failure is not
    // read as "not Tailscale" here, it is the refusal.
    if (expected && !tailscale) assertExpectedNode(detect(), expected);
    const isTailscale = tailscale || Boolean(expected) || (() => {
      try {
        return detect().address === ip;
      } catch {
        return false;
      }
    })();
    if (!isTailscale && kind === 'cgnat') throw new BindError(`${ip} (on ${iface}) is in 100.64.0.0/10 but is not this machine's Tailscale address; use --tailscale`);
    if (!isTailscale && TUNNEL.test(iface)) throw new BindError(`${ip} is on tunnel interface ${iface}, which is not Tailscale; binding another VPN's address is refused`);
  }
  for (const name of allowHosts) {
    const n = String(name).toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(n) || n === 'localhost') throw new BindError(`--allow-host ${name} is not a plain hostname`);
    if (kind === 'loopback') throw new BindError('--allow-host applies only to non-loopback binds');
    names.push(n);
  }
  names = [...new Set(names)];
  return { host: ip, kind: tailscale ? 'tailscale' : kind, names };
}

// Process-wide lockdown, checked wherever a socket is actually opened (server
// listen, service port probe). The default test suites and red controls set
// CANON_LOOPBACK_ONLY=1, so no code path in them can bind a tailnet or LAN address,
// even if a live test loses its opt-in gate. resolveBind itself stays pure.
export function assertBindAllowed(bind) {
  if (process.env.CANON_LOOPBACK_ONLY === '1' && !LOOPBACK.has(bind.host)) {
    throw new BindError(`${bind.host}: CANON_LOOPBACK_ONLY=1 disables non-loopback binds in this process (live tailnet tests are opt-in: npm run test:tailnet)`);
  }
  return bind;
}

// Host header allowlist for a bound server: the exact bound authority, plus
// localhost for loopback binds, plus explicitly allowed names for other binds.
export function allowedHostsFor(address, names = []) {
  const bound = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const authorities = [bound];
  if (LOOPBACK.has(address.address)) authorities.push('localhost');
  authorities.push(...names);
  const hosts = new Set(authorities.map((h) => `${h}:${address.port}`));
  if (address.port === 80) for (const h of authorities) hosts.add(h);
  return hosts;
}
