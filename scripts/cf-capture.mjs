#!/usr/bin/env node
// V2.1 slice 05: safe capture for live-run matrix cells (replaces `curl -si ... > x.headers`).
// The live fire's capture wrote live Access session cookies into evidence (F-LF-1). This tool
// strips credentials AT THE SOURCE, before anything touches disk:
//
// - request and response headers `set-cookie`, `cookie`, `authorization`, and every
//   `cf-access-*` header (the service token's client ID and secret included): the value is
//   replaced by `<stripped: N bytes>`;
// - a `location` pointing at an Access login page keeps its path but loses its query (it
//   carries a signed parameter);
// - `x-canon-signature`, the public target's signed-admin-request signature (V2.1 slice 04,
//   N-V21-3): not a credential, but replayable for 60 s, so it never reaches evidence either.
//
// Status line, header names and the body are kept, so every matrix cell stays derivable. The
// request is recorded too (the live fire recorded responses only). After writing, the secret
// gate runs over what was written; a finding deletes nothing but fails the capture.
//
//   node scripts/cf-capture.mjs --out <dir> --name <cell> --url <https://…> [--method GET]
//     [--header 'name: value' ...] [--service-token-env RP_CF_TEST]
// With --service-token-env, the Access service-token headers are added from that variable's
// JSON ({ clientId, clientSecret }) and stripped in the record like any other.
// Running it contacts the endpoint: an external action needing the maintainer's confirmation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanTree } from './secret-gate.mjs';

const STRIP = /^(?:set-cookie|cookie|authorization|proxy-authorization|cf-access-.*)$/i;
const SIGNED = /^x-canon-signature$/i;
export const EXIT = { ok: 0, gate: 1, usage: 2, failed: 4 };

export function sanitizeHeaders(pairs) {
  return pairs.map(([name, value]) => {
    const v = String(value);
    if (STRIP.test(name) || SIGNED.test(name)) return [name, `<stripped: ${Buffer.byteLength(v)} bytes>`];
    if (/^location$/i.test(name) && /cloudflareaccess\.com\/cdn-cgi\/access\/login\//.test(v) && v.includes('?')) return [name, `${v.slice(0, v.indexOf('?'))}?<stripped query>`];
    return [name, v];
  });
}

// Headers.entries() folds repeated set-cookie headers; getSetCookie() keeps each one.
function responsePairs(res) {
  const pairs = [...res.headers].filter(([k]) => k.toLowerCase() !== 'set-cookie');
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return [...pairs, ...cookies.map((c) => ['set-cookie', c])];
}

// Perform one request and write <name>.request, <name>.headers and <name>.body under outDir.
export async function capture({ outDir, name, url, method = 'GET', headers = [], fetchImpl = globalThis.fetch, connectTo = null }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('--name must be [a-z0-9-]');
  const target = new URL(url);
  if (target.protocol !== 'https:' && !connectTo) throw new Error('only https URLs are captured');
  let wire = target;
  if (connectTo) {
    const o = new URL(connectTo);
    if (o.protocol !== 'http:' || o.hostname !== '127.0.0.1' || !o.port) throw new Error('connectTo must be a loopback http://127.0.0.1:<port> origin');
    wire = new URL(`${target.pathname}${target.search}`, o.origin);
  }
  const res = await fetchImpl(wire, { method, headers: Object.fromEntries(headers), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(outDir, { recursive: true });
  const reqLines = [`${method} ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`, ...sanitizeHeaders(headers).map(([k, v]) => `${k}: ${v}`)];
  const resLines = [`HTTP/1.1 ${res.status} ${res.statusText}`, ...sanitizeHeaders(responsePairs(res)).map(([k, v]) => `${k}: ${v}`)];
  writeFileSync(join(outDir, `${name}.request`), `${reqLines.join('\n')}\n`);
  writeFileSync(join(outDir, `${name}.headers`), `${resLines.join('\n')}\n`);
  writeFileSync(join(outDir, `${name}.body`), body);
  const gate = scanTree(outDir);
  return { status: res.status, bytes: body.length, gate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const headers = argv.flatMap((a, i) => (a === '--header' ? [argv[i + 1]] : [])).map((h) => { const k = h.indexOf(':'); return [h.slice(0, k).trim(), h.slice(k + 1).trim()]; });
  if (!opt('--out') || !opt('--name') || !opt('--url')) {
    process.stderr.write('usage: cf-capture.mjs --out <dir> --name <cell> --url <https://…> [--method M] [--header "k: v"]... [--service-token-env VAR]\n');
    process.exit(EXIT.usage);
  }
  const tokenEnv = opt('--service-token-env');
  if (tokenEnv) {
    let t;
    try { t = JSON.parse(process.env[tokenEnv] ?? ''); } catch { t = null; }
    if (!t?.clientId || !t?.clientSecret) { process.stderr.write(`cf-capture: $${tokenEnv} must be JSON with clientId and clientSecret\n`); process.exit(EXIT.usage); }
    headers.push(['cf-access-client-id', t.clientId], ['cf-access-client-secret', t.clientSecret]);
  }
  try {
    const r = await capture({ outDir: opt('--out'), name: opt('--name'), url: opt('--url'), method: opt('--method') ?? 'GET', headers });
    process.stdout.write(`${JSON.stringify({ status: r.status, bytes: r.bytes, gate: r.gate.exit === 0 ? 'clean' : r.gate }, null, 2)}\n`);
    process.exit(r.gate.exit === 0 ? EXIT.ok : EXIT.gate);
  } catch (err) {
    process.stderr.write(`cf-capture: ${err.message}\n`);
    process.exit(EXIT.failed);
  }
}
