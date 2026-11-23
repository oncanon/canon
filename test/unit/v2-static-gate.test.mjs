// V2 static gate (docs/v2/publication-protocol.md §8): the build fails if any module
// under src/ can reach the network or a provider SDK outside the transport
// abstraction, or if any publication code path can issue a delete.
//
// The only network-capable imports allowed are V1's loopback serving, named exactly:
// the review server's createServer, the service's loopback health probe and
// port-availability check, and the bind policy's isIP (pure). The only network client
// is the real Cloudflare transport, named exactly: it alone may use `fetch`, only the
// adapter factory may import it, and it imports nothing but the error taxonomy and
// the pure endpoint rule. The in-process transport imports nothing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = sources(join(REPO, 'src')).map((p) => ({ path: relative(REPO, p), text: readFileSync(p, 'utf8') }));

const NETWORK_MODULE = /^(node:)?(http|https|http2|net|tls|dgram|dns)(\/.*)?$|^(undici|node-fetch|axios|got|ws|@aws-sdk\/.*|aws-sdk|cloudflare|wrangler|miniflare|@cloudflare\/.*)$/;
// file -> exact named imports allowed from a network module
const ALLOWED = {
  'src/service.mjs': { 'node:http': ['request'], 'node:net': ['createServer'] },
  'src/server/server.mjs': { 'node:http': ['createServer'] },
  'src/server/bind.mjs': { 'node:net': ['isIP'] },
};
const HTTP_TRANSPORT = 'src/publication/transports/cloudflare-http.mjs';
// Every file under src/ that may name a network client, one per line. Each has its own rule for
// where it may connect (endpoint.mjs for Cloudflare: refused by default).
const NETWORK_CLIENTS = [
  HTTP_TRANSPORT,
];
// The deployable Worker runs in Cloudflare, not in the publisher. It imports nothing;
// `fetch` appears only as its handler's name and in its one outbound call, fetching its
// own team's Access signing keys. It has no delete route and deletes nothing.
const WORKER = 'src/publication/worker/index.mjs';
const WORKER_FETCH_ALLOWED = ['    async fetch(request, env) {', '  const res = await globalThis.fetch(certsUrl, '];
const workerCode = (text) => WORKER_FETCH_ALLOWED.reduce((t, s) => t.split(s).join(''), text.replace(/^\s*\/\/.*$/gm, ''));


function imports(text) {
  const out = [];
  for (const m of text.matchAll(/import\s+(?:(\{[^}]*\})|(\*\s+as\s+\w+)|(\w+))?\s*(?:,\s*(\{[^}]*\}))?\s*(?:from\s*)?['"]([^'"]+)['"]/g)) {
    const names = [m[1], m[4]].filter(Boolean).flatMap((b) => b.replace(/[{}]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    out.push({ module: m[5], names: m[2] || m[3] ? ['*'] : names });
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ module: m[1], names: ['*'] });
  return out;
}

test('[V2-12] static gate: no module under src/ imports a network or provider SDK outside the allowlisted V1 loopback uses', () => {
  const problems = [];
  for (const f of FILES) {
    for (const imp of imports(f.text).filter((i) => NETWORK_MODULE.test(i.module))) {
      const mod = imp.module.startsWith('node:') ? imp.module : `node:${imp.module}`;
      const allowed = ALLOWED[f.path]?.[mod];
      if (!allowed || !imp.names.every((n) => allowed.includes(n))) problems.push(`${f.path}: imports ${imp.names.join(',')} from ${imp.module}`);
    }
    const code = f.text.replace(/^\s*\/\/.*$/gm, '');
    const scanned = f.path === WORKER ? workerCode(f.text) : code;
    if (!NETWORK_CLIENTS.includes(f.path) && /\bfetch\b|new\s+WebSocket\b|XMLHttpRequest|\bEventSource\b|\bconnect\s*\(/.test(scanned)) problems.push(`${f.path}: uses a network client global`);
    if (f.path !== 'src/publication/targets.mjs' && imports(f.text).some((i) => /transports\/cloudflare-http\.mjs$/.test(i.module))) problems.push(`${f.path}: imports a real transport (only targets.mjs may)`);
  }
  const transport = FILES.find((f) => f.path === HTTP_TRANSPORT);
  assert.ok(transport, 'the gate scans the real Cloudflare transport');
  assert.deepEqual(imports(transport.text).map((i) => i.module).sort(), ['../errors.mjs', './endpoint.mjs'], 'the real transport imports only the error taxonomy and the endpoint rule');
  for (const client of NETWORK_CLIENTS) assert.ok(FILES.some((f) => f.path === client), `the gate scans ${client}`);
  const worker = FILES.find((f) => f.path === WORKER);
  assert.ok(worker, 'the gate scans the Worker');
  assert.deepEqual(imports(worker.text), [], 'the Worker imports nothing');
  for (const s of WORKER_FETCH_ALLOWED) assert.equal(worker.text.split(s).length - 1, 1, `the Worker's allowed fetch use appears exactly once: ${s.trim()}`);
  assert.deepEqual(problems, []);
  assert.ok(FILES.some((f) => f.path === 'src/publication/transport.mjs'), 'the gate scans the transport');
  assert.deepEqual(imports(readFileSync(join(REPO, 'src/publication/transport.mjs'), 'utf8')), [], 'the transport imports nothing');
});

test('[V2-12] static gate: no publication code path can issue a delete', () => {
  const pub = FILES.filter((f) => f.path.startsWith('src/publication/'));
  const clients = pub.filter((f) => !f.path.startsWith('src/publication/mocks/'));
  const problems = [];
  for (const f of clients) {
    const text = f.text.replace(/^\s*\/\/.*$/gm, '');
    for (const [re, what] of [
      [/['"]DELETE['"]/, 'an HTTP DELETE'],
      [/\b(deleteObject|DeleteObject|DeleteKey|UpdateKeys|CreateInvalidation|deleteBucket|deleteRule|DeleteRule|purge)\b/, 'a provider delete/purge call'],
      [/\b(rm|rmdir|rmSync|rmdirSync|unlinkSync)\s*\(/, 'a filesystem removal'],
    ]) if (re.test(text)) problems.push(`${f.path}: ${what}`);
    // The one allowed unlink: the fs adapter's own temp file, through removeOwnTemp.
    const unlinks = [...text.matchAll(/\bunlink\s*\(/g)].length;
    const allowedUnlinks = f.path === 'src/publication/adapters/fs.mjs' ? 1 : 0;
    if (unlinks !== allowedUnlinks) problems.push(`${f.path}: ${unlinks} unlink call(s), ${allowedUnlinks} allowed`);
    if (f.path === 'src/publication/adapters/fs.mjs' && !/async function removeOwnTemp\(temp\) \{\n\s+if \(dirname\(temp\) !== tmpDir\) throw/.test(f.text)) problems.push('fs adapter: removeOwnTemp lost its own-temp guard');
  }
  // The Worker and its D1 schema never delete: no binding delete call, no DELETE FROM.
  const worker = FILES.find((f) => f.path === WORKER);
  const schema = readFileSync(join(REPO, 'src/publication/worker/schema.sql'), 'utf8');
  if (/\.delete\s*\(/.test(worker.text.replace(/^\s*\/\/.*$/gm, ''))) problems.push(`${WORKER}: calls a binding delete`);
  for (const [name, t] of [[WORKER, worker.text], ['src/publication/worker/schema.sql', schema.replace(/^\s*--.*$/gm, '')]]) if (/\bDELETE\s+FROM\b|\bDROP\s+TABLE\b|\bTRUNCATE\b/i.test(t)) problems.push(`${name}: deletes rows or tables`);
  // Mock providers answer a DELETE with a refusal and never drop stored data.
  for (const f of pub.filter((x) => x.path.startsWith('src/publication/mocks/'))) {
    if (/delete\s+s\.(r2|d1|receipts)\b/.test(f.text)) problems.push(`${f.path}: removes stored provider data`);
  }
  assert.deepEqual(problems, []);
});
