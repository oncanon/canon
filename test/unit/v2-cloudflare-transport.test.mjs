// The real Cloudflare transport (provider-validation slice 05). It is refused by
// default: a `cloudflare` target needs an explicit workers.dev endpoint, the credential
// in its environment variable, and a grant for the operation, each with a named error.
// Request construction is checked only against a loopback fake server: the mock Worker
// served over HTTP on 127.0.0.1. No request leaves the host, and no real credential is
// read: the credentials here are synthetic values given to a test-local env object.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CODES } from '../../src/publication/errors.mjs';
import { createCloudflareWorker } from '../../src/publication/mocks/cloudflare-worker.mjs';
import { assertTargetAvailable } from '../../src/publication/policy.mjs';
import { promote, publish } from '../../src/publication/protocol.mjs';
import { adapterFor, loadTargets } from '../../src/publication/targets.mjs';
import { CloudflareHttpTransport } from '../../src/publication/transports/cloudflare-http.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://rp-publisher-test.example.workers.dev';
const GRANTS = new Set(['upload', 'promote']);
const target = (extra = {}) => ({ name: 'cf-real', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST', endpoint: ENDPOINT, ...extra });

// A loopback HTTP server; every request is recorded before `handle` answers it.
async function loopback(t, handle) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, path: req.url, headers: { ...req.headers }, body };
      seen.push(entry);
      const r = await handle(entry, res);
      if (r === undefined) return; // the handler answered (or deliberately did not)
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
  });
  await new Promise((r) => server.listen({ host: '127.0.0.1', port: 0 }, r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

test('[PV-05] default refusal: a cloudflare target without an endpoint is not-available everywhere it is checked', async (t) => {
  const bare = target({ endpoint: undefined });
  assert.throws(() => assertTargetAvailable(bare), (e) => e.code === CODES.NOT_AVAILABLE && /has no endpoint/.test(e.message));
  assert.throws(() => adapterFor(bare, { env: {}, grants: GRANTS }), (e) => e.code === CODES.NOT_AVAILABLE);
  // Even with a working adapter in hand, the protocol refuses before any request.
  const worker = createCloudflareWorker({});
  const dir = await tempDir(t, 'canon-cf-refuse');
  const p = await syntheticPacket(dir);
  const { adapter, requests } = (() => { const a = adapterFor({ ...target({ kind: 'mock-cloudflare', endpoint: undefined }), ledgerDir: join(dir, 'l') }, { env: { RP_CF_TEST: JSON.stringify(worker.credentials()) }, endpoint: worker }); return { adapter: a, requests: () => a.requestCount() }; })();
  await assert.rejects(publish({ adapter, target: { ...bare, ledgerDir: join(dir, 'l') }, packetDir: p.dir, grants: GRANTS }), (e) => e.code === CODES.NOT_AVAILABLE);
  assert.equal(requests(), 0, 'no request was made');
});

test('[PV-05] the endpoint must be the bare origin https://<worker>.workers.dev: every other form is refused, named', () => {
  const env = { RP_CF_TEST: JSON.stringify({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret' }) };
  const bad = [
    ['http://rp.example.workers.dev', /scheme http: is not https/],
    ['https://example.com', /not a workers\.dev host/],
    ['https://rp.workers.dev.attacker.example', /not a workers\.dev host/],
    ['https://workers.dev', /not a workers\.dev host/],
    ['https://user:pw@rp.example.workers.dev', /user information/],
    ['https://rp.example.workers.dev:8443', /port 8443/],
    ['https://rp.example.workers.dev/_admin/', /path, query or fragment/],
    ['https://rp.example.workers.dev/?x=1', /path, query or fragment/],
    ['http://127.0.0.1:8080', /scheme http: is not https/],
    ['not a url', /not a URL/],
  ];
  for (const [endpoint, why] of bad) {
    assert.throws(() => adapterFor(target({ endpoint }), { env, grants: GRANTS }), (e) => e.code === CODES.INVALID && why.test(e.message), endpoint);
  }
  assert.doesNotThrow(() => adapterFor(target(), { env, grants: GRANTS }), 'a workers.dev origin with a grant and a credential is accepted');
});

test('[PV-05] a target file cannot select a loopback or non-https endpoint, or any connect override', async (t) => {
  const dir = await tempDir(t, 'canon-cf-cfg');
  const file = join(dir, 'targets.json');
  for (const endpoint of ['http://127.0.0.1:9', 'http://rp.example.workers.dev']) {
    await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [target({ endpoint })] }));
    await assert.rejects(loadTargets(file), (e) => e.code === CODES.INVALID, endpoint);
  }
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [target({ connectTo: 'http://127.0.0.1:9' })] }));
  await assert.rejects(loadTargets(file), (e) => e.code === CODES.INVALID && /connectTo/.test(e.message), 'connectTo is not a target field');
  assert.throws(() => new CloudflareHttpTransport({ endpoint: ENDPOINT, connectTo: 'http://10.0.0.1:80' }), (e) => e.code === CODES.INVALID, 'a test connect target must be loopback');
  assert.throws(() => new CloudflareHttpTransport({ endpoint: ENDPOINT, connectTo: 'https://127.0.0.1:1' }), (e) => e.code === CODES.INVALID);
});

test('[PV-05] even with an endpoint: no grant, no credential, or a malformed credential is refused, named, without echoing values', () => {
  const secret = 'synthetic-secret-do-not-echo';
  assert.throws(() => adapterFor(target(), { env: { RP_CF_TEST: JSON.stringify({ clientId: 'id', clientSecret: secret }) } }), (e) => e.code === CODES.GRANT_MISSING);
  assert.throws(() => adapterFor(target(), { env: { RP_CF_TEST: JSON.stringify({ clientId: 'id', clientSecret: secret }) }, grants: new Set() }), (e) => e.code === CODES.GRANT_MISSING);
  assert.throws(() => adapterFor(target(), { env: {}, grants: GRANTS }), (e) => e.code === CODES.CREDENTIAL_MISSING && /\$RP_CF_TEST/.test(e.message));
  assert.throws(() => adapterFor(target({ credentialEnv: undefined }), { env: {}, grants: GRANTS }), (e) => e.code === CODES.INVALID && /names no credentialEnv/.test(e.message));
  for (const raw of [`{not json ${secret}`, JSON.stringify({ clientId: 'id' }), JSON.stringify({ clientId: '', clientSecret: secret })]) {
    assert.throws(() => adapterFor(target(), { env: { RP_CF_TEST: raw }, grants: GRANTS }), (e) => e.code === CODES.INVALID && !e.message.includes(secret) && !e.message.includes('clientId: id'), raw.slice(0, 20));
  }
});

test('[PV-05] request construction over loopback: publish and promote reach the mock Worker through the real transport', async (t) => {
  const worker = createCloudflareWorker({});
  const { origin, seen } = await loopback(t, (req) => worker.handle({ method: req.method, path: req.path, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: req.body }));
  const dir = await tempDir(t, 'canon-cf-loop');
  const env = { RP_CF_TEST: JSON.stringify(worker.credentials()) };
  const tgt = { ...target(), ledgerDir: join(dir, 'ledger') };
  const adapter = adapterFor(tgt, { env, grants: GRANTS, connectTo: origin });
  assert.equal(adapter.describe().kind, 'cloudflare');
  const p = await syntheticPacket(dir);
  const published = await publish({ adapter, target: tgt, packetDir: p.dir, grants: GRANTS });
  assert.equal(published.state, 'READBACK_VERIFIED');
  const moved = await promote({ adapter, target: tgt, alias: 'review', contentId: p.contentId, expectGeneration: 0, grants: GRANTS });
  assert.equal(moved.state, 'PROMOTED');
  const { clientId, clientSecret } = worker.credentials();
  assert.ok(seen.length > 0 && seen.length === adapter.requestCount(), 'every request the adapter made reached the loopback server');
  for (const r of seen) {
    assert.ok(r.path.startsWith('/_admin/'), `${r.method} ${r.path} is an ingest API request`);
    assert.equal(r.headers.host, origin.slice('http://'.length), 'sent to the loopback origin only');
    assert.equal(r.headers['cf-access-client-id'], clientId);
    assert.equal(r.headers['cf-access-client-secret'], clientSecret);
    assert.equal(r.headers.cookie, undefined, 'no cookie is sent');
  }
  const puts = seen.filter((r) => r.method === 'PUT' && r.path.startsWith('/_admin/objects/'));
  assert.ok(puts.length >= 3);
  for (const r of puts) {
    assert.equal(r.headers['if-none-match'], '*', 'object puts are create-if-absent');
    assert.match(r.headers['x-rp-sha256'], /^[0-9a-f]{64}$/);
    assert.ok(r.headers['content-type']);
  }
  const cas = seen.find((r) => r.method === 'POST' && r.path === '/_admin/aliases/review');
  assert.deepEqual(Object.keys(JSON.parse(cas.body)).sort(), ['contentId', 'expectGeneration', 'opId']);
  assert.ok(!seen.some((r) => r.method === 'DELETE'), 'no DELETE is ever sent');
  // Receipts written over the real transport carry no secret.
  const receipts = Object.values(worker.state.receipts);
  assert.ok(receipts.length >= 3);
  for (const r of receipts) assert.ok(!r.includes(clientSecret) && !r.includes(clientId), 'receipt is secret-free');
});

test('[PV-05] an Access login redirect is never followed and is reported as a rejected credential', async (t) => {
  // The Location stays on the loopback server, so even a transport that wrongly followed
  // it would never leave the host (it would loop here, and the count below would catch it).
  let origin;
  const server = await loopback(t, () => ({ status: 302, headers: { location: `${origin}/cdn-cgi/access/login` } }));
  origin = server.origin;
  const { seen } = server;
  const adapter = adapterFor(target(), { env: { RP_CF_TEST: JSON.stringify({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret' }) }, grants: GRANTS, connectTo: origin });
  await assert.rejects(adapter.readAlias('review'), (e) => e.code === CODES.CREDENTIAL_EXPIRED && /Access redirected to login/.test(e.message));
  assert.equal(seen.length, 1, 'exactly one request: the redirect was not followed');
});

test('[PV-05] a timeout is the retryable 599, and an oversized response is refused', async (t) => {
  const slow = await loopback(t, () => new Promise(() => {})); // never answers
  const transport = new CloudflareHttpTransport({ endpoint: ENDPOINT, connectTo: slow.origin, timeoutMs: 200 });
  const r = await transport.request({ method: 'GET', path: '/_admin/aliases' });
  assert.equal(r.status, 599);
  const big = await loopback(t, () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(4096, 0x61) }));
  const capped = new CloudflareHttpTransport({ endpoint: ENDPOINT, connectTo: big.origin, maxResponseBytes: 1024 });
  await assert.rejects(capped.request({ method: 'GET', path: '/_admin/aliases' }), (e) => e.code === CODES.PROTOCOL && /exceeds 1024 bytes/.test(e.message));
});

test('[PV-05] the transport sends only /_admin/ requests to its own origin', async (t) => {
  const { origin, seen } = await loopback(t, () => ({ status: 200, body: '[]' }));
  const transport = new CloudflareHttpTransport({ endpoint: ENDPOINT, connectTo: origin });
  for (const path of ['/p/x', '/_admin/../p/x', '//evil.example/_admin/x', 'http://evil.example/_admin/x', '/_admin/x y']) {
    await assert.rejects(transport.request({ method: 'GET', path }), (e) => e.code === CODES.INVALID, path);
  }
  assert.equal(seen.length, 0, 'no refused request was sent');
  assert.equal(transport.requests, 0);
});

test('[PV-05] end to end over loopback: the real transport, a fake Access edge and the real Worker on fake bindings', async (t) => {
  const { workerDeployment } = await import('../v2/worker-bindings.mjs');
  const d = await workerDeployment();
  const { origin, seen } = await loopback(t, (req) => d.edge({ method: req.method, path: req.path, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: req.body.length ? req.body : null }));
  const dir = await tempDir(t, 'canon-cf-e2e');
  const tgt = { ...target(), ledgerDir: join(dir, 'ledger') };
  const adapter = adapterFor(tgt, { env: { RP_CF_TEST: JSON.stringify(d.credentials) }, grants: GRANTS, connectTo: origin });
  const p = await syntheticPacket(dir);
  assert.equal((await publish({ adapter, target: tgt, packetDir: p.dir, grants: GRANTS })).state, 'READBACK_VERIFIED');
  assert.equal((await promote({ adapter, target: tgt, alias: 'review', contentId: p.contentId, expectGeneration: 0, grants: GRANTS })).state, 'PROMOTED');
  assert.equal(seen.length, adapter.requestCount());
  assert.ok(seen.every((r) => r.path.startsWith('/_admin/') && r.headers.host === origin.slice('http://'.length)));
  const served = await d.worker.fetch(new Request(`${d.origin}/a/review/report.md`, { headers: { 'cf-access-jwt-assertion': await d.access.token(d.access.userClaims('reviewer@example.com')) } }), d.env);
  assert.equal(served.status, 307);
  assert.equal(served.headers.get('location'), `/p/${p.contentId}/report.md`);
});
