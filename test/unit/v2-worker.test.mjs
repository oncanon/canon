// The deployable Worker (src/publication/worker/index.mjs), run under Node against
// in-process R2/D1 fakes and a fake Access edge (test/v2/worker-bindings.mjs). The
// ingest API is driven through the real Cloudflare adapter and the publication
// protocol, exactly as a publish against the test deployment would be; serving and
// Access checks go straight to the Worker's fetch handler. A real workerd run is a
// provider-evidence cell (NOT_EXECUTED): workerd/miniflare are not installed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { cloudflareAdapter } from '../../src/publication/adapters/cloudflare.mjs';
import { CODES } from '../../src/publication/errors.mjs';
import { CACHE_IMMUTABLE, objectKey, promote, publish, reconcile, rollback } from '../../src/publication/protocol.mjs';
import { sha256Hex } from '../../src/hash.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';
import { workerDeployment } from '../v2/worker-bindings.mjs';

const GRANTS = new Set(['upload', 'promote']);

async function setup(t) {
  const d = await workerDeployment();
  const dir = await tempDir(t, 'rpk-worker');
  const target = { name: 'cf-real', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST', endpoint: d.origin, ledgerDir: join(dir, 'ledger') };
  const adapter = cloudflareAdapter({ transport: d.transport, credentials: d.credentials, kind: 'cloudflare' });
  const opts = { adapter, target, grants: GRANTS, retry: { sleep: async () => {} } };
  return { d, dir, target, adapter, opts };
}

// A request straight to the Worker, as a human reviewer (any Access identity) or as
// the service token, with a signed Access JWT.
async function asUser(d, method, path, { headers = {}, claims, token } = {}) {
  const jwt = token ?? await d.access.token(claims ?? d.access.userClaims('reviewer@example.com'));
  return d.worker.fetch(new Request(`${d.origin}${path}`, { method, headers: { 'cf-access-jwt-assertion': jwt, ...headers } }), d.env);
}

test('[PV-05 Worker] publish, idempotent republish, promote, rollback and reconcile through the real adapter', async (t) => {
  const { d, dir, adapter, opts } = await setup(t);
  const a = await syntheticPacket(dir, 'a');
  const b = await syntheticPacket(dir, 'b');
  const first = await publish({ ...opts, packetDir: a.dir });
  assert.equal(first.state, 'READBACK_VERIFIED');
  assert.ok(first.receipt.objects.every((o) => o.outcome === 'created'));
  assert.ok((await publish({ ...opts, packetDir: a.dir })).receipt.objects.every((o) => o.outcome === 'identical'), 'republish is identical');
  await publish({ ...opts, packetDir: b.dir });
  assert.equal((await promote({ ...opts, alias: 'review', contentId: a.contentId, expectGeneration: 0 })).record.generation, 1);
  assert.equal((await promote({ ...opts, alias: 'review', contentId: b.contentId, expectGeneration: 1 })).record.generation, 2);
  const back = await rollback({ ...opts, alias: 'review', to: a.contentId, expectGeneration: 2 });
  assert.equal(back.record.generation, 3);
  assert.deepEqual((await adapter.readHistory('review')).map((r) => [r.generation, r.contentId]), [[1, a.contentId], [2, b.contentId], [3, a.contentId]]);
  assert.equal((await adapter.readAlias('review')).previousContentId, b.contentId);
  assert.equal((await reconcile(opts)).state, 'RECONCILED');
  const receipts = [...d.env.PACKETS.objects.keys()].filter((k) => k.startsWith('receipts/'));
  assert.ok(receipts.length >= 8, `${receipts.length} receipts stored`);
  for (const k of receipts) {
    const body = d.env.PACKETS.objects.get(k).bytes.toString('utf8');
    assert.ok(!body.includes(d.credentials.clientSecret) && !body.includes(d.credentials.clientId), `${k} is secret-free`);
  }
});

test('[PV-05 Worker] put-if-absent: identical, conflict, bad digest and unconditional puts', async (t) => {
  const { d, dir, adapter, opts } = await setup(t);
  const p = await syntheticPacket(dir);
  await publish({ ...opts, packetDir: p.dir });
  const key = objectKey(p.contentId, 'report.md');
  const original = Buffer.from(d.env.PACKETS.objects.get(key).bytes);
  const req = (bytes, sha = sha256Hex(bytes)) => ({ key, sha256: sha, bytes: bytes.length, contentType: 'text/markdown; charset=utf-8', cacheControl: CACHE_IMMUTABLE });
  assert.equal((await adapter.putIfAbsent(req(original), original)).outcome, 'identical');
  const other = Buffer.from('different bytes under the same content-addressed key');
  const conflict = await adapter.putIfAbsent(req(other), other);
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.existingSha256, sha256Hex(original));
  assert.deepEqual(d.env.PACKETS.objects.get(key).bytes, original, 'nothing was overwritten');
  const fresh = objectKey(`sha256-${'b'.repeat(64)}`, 'x.md');
  await assert.rejects(adapter.putIfAbsent({ ...req(other, sha256Hex(Buffer.from('lie'))), key: fresh }, other), (e) => e.code === CODES.BAD_DIGEST);
  assert.equal(d.env.PACKETS.objects.has(fresh), false, 'a bad digest stores nothing');
  const unconditional = await d.edge({ method: 'PUT', path: `/_admin/objects/${fresh}`, headers: { 'cf-access-client-id': d.credentials.clientId, 'cf-access-client-secret': d.credentials.clientSecret, 'x-rp-sha256': sha256Hex(other) }, body: other });
  assert.equal(unconditional.status, 428, 'a put without If-None-Match: * is refused');
});

test('[PV-05 Worker] alias CAS in D1: one winner, dense history, own-operation replay, manifest precondition', async (t) => {
  const { d, dir, adapter, opts } = await setup(t);
  const a = await syntheticPacket(dir, 'a');
  const b = await syntheticPacket(dir, 'b');
  for (const p of [a, b]) await publish({ ...opts, packetDir: p.dir });
  await promote({ ...opts, alias: 'review', contentId: a.contentId, expectGeneration: 0 });
  const results = await Promise.allSettled([b, a, b].map((p) => promote({ ...opts, alias: 'review', contentId: p.contentId, expectGeneration: 1 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one winner');
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, CODES.ALIAS_CONFLICT);
  assert.deepEqual((await adapter.readHistory('review')).map((r) => r.generation), [1, 2], 'history is dense');
  // A lost response: the same operation retried is answered with its own move.
  const once = await adapter.casAlias('review', 2, a.contentId, { opId: 'op-replay-1' });
  const again = await adapter.casAlias('review', 2, a.contentId, { opId: 'op-replay-1' });
  assert.ok(once.ok && again.ok);
  assert.equal(again.record.generation, 3, 'the replay did not move the alias again');
  assert.deepEqual((await adapter.readHistory('review')).map((r) => r.generation), [1, 2, 3]);
  const other = await adapter.casAlias('review', 2, a.contentId, { opId: 'op-other' });
  assert.deepEqual(other, { ok: false, currentGeneration: 3 }, 'a different operation with the stale expectation loses');
  await assert.rejects(adapter.casAlias('review', 3, `sha256-${'c'.repeat(64)}`, { opId: 'op-x' }), (e) => e.code === CODES.TARGET_NOT_VERIFIED, 'no manifest, no move');
});

test('[PV-05 Worker] receipts are append-only and must match their path and schema', async (t) => {
  const { d, adapter } = await setup(t);
  const receipt = { schema: 'receipt/v2', receiptId: 'rcpt-test-1', operation: 'publish' };
  await adapter.writeReceipt(receipt);
  await assert.rejects(adapter.writeReceipt(receipt), (e) => e.code === CODES.RECEIPT_FAILED, 'an existing receipt ID fails');
  const h = { 'cf-access-client-id': d.credentials.clientId, 'cf-access-client-secret': d.credentials.clientSecret, 'content-type': 'application/json' };
  assert.equal((await d.edge({ method: 'PUT', path: '/_admin/receipts/rcpt-2.json', headers: h, body: Buffer.from(JSON.stringify({ ...receipt, receiptId: 'rcpt-other' })) })).status, 400);
  assert.equal((await d.edge({ method: 'PUT', path: '/_admin/receipts/rcpt-3.json', headers: h, body: Buffer.from('{not json') })).status, 400);
});

test('[PV-05 Worker] serving: manifest media type, security headers, ETag = sha256, HEAD, Range, 304, alias 307', async (t) => {
  const { d, dir, opts } = await setup(t);
  const p = await syntheticPacket(dir);
  await publish({ ...opts, packetDir: p.dir });
  await promote({ ...opts, alias: 'review', contentId: p.contentId, expectGeneration: 0 });
  const md = await asUser(d, 'GET', `/p/${p.contentId}/report.md`);
  const bytes = Buffer.from(await md.arrayBuffer());
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(md.headers.get('etag'), `"${sha256Hex(bytes)}"`);
  assert.equal(md.headers.get('cache-control'), CACHE_IMMUTABLE);
  assert.match(md.headers.get('content-security-policy'), /default-src 'none'.*script-src 'none'.*frame-ancestors 'none'/);
  assert.equal(md.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(md.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(md.headers.get('x-frame-options'), 'DENY');
  const index = await asUser(d, 'GET', `/p/${p.contentId}/`);
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
  const head = await asUser(d, 'HEAD', `/p/${p.contentId}/report.md`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await asUser(d, 'GET', `/p/${p.contentId}/report.md`, { headers: { range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-15/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 16));
  const bad = await asUser(d, 'GET', `/p/${p.contentId}/report.md`, { headers: { range: `bytes=${bytes.length + 5}-` } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${bytes.length}`);
  assert.equal((await asUser(d, 'GET', `/p/${p.contentId}/report.md`, { headers: { 'if-none-match': md.headers.get('etag') } })).status, 304);
  for (const [path, location] of [['/a/review/', `/p/${p.contentId}/`], ['/a/review/report.md', `/p/${p.contentId}/report.md`]]) {
    const r = await asUser(d, 'GET', path);
    assert.equal(r.status, 307);
    assert.equal(r.headers.get('location'), location);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await asUser(d, 'GET', '/a/missing/')).status, 404);
  assert.equal((await asUser(d, 'GET', `/p/${p.contentId}/nothing-here.md`)).status, 404);
  assert.equal((await asUser(d, 'GET', '/elsewhere')).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await asUser(d, method, `/p/${p.contentId}/report.md`)).status, 405, method);
  // The content type is the stored manifest type, not a guess from the extension.
  const txt = objectKey(p.contentId, 'notes.txt');
  await d.env.PACKETS.put(txt, '# notes\n', { httpMetadata: { contentType: 'text/markdown; charset=utf-8' }, customMetadata: { sha256: sha256Hex(Buffer.from('# notes\n')) } });
  assert.equal((await asUser(d, 'GET', `/p/${p.contentId}/notes.txt`)).headers.get('content-type'), 'text/markdown; charset=utf-8');
});

test('[PV-05 Worker] Access: every request needs a valid RS256 token for this team and audience; the ingest API needs an allowlisted service token', async (t) => {
  const { d } = await setup(t);
  const svc = d.access.serviceClaims(d.credentials.clientId);
  const now = Math.floor(Date.now() / 1000);
  const refusals = [
    ['no token', { token: '' }, /no Access token/],
    ['malformed', { token: 'abc.def' }, /malformed token/],
    ['alg none', { token: `${Buffer.from(JSON.stringify({ alg: 'none', kid: d.access.kid })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.` }, /unexpected token algorithm/],
    ['bad signature', { token: await d.access.token(svc, { signWith: d.access.otherKey }) }, /bad token signature/],
    ['wrong issuer', { token: await d.access.token({ ...svc, iss: 'https://other.cloudflareaccess.com' }) }, /wrong token issuer/],
    ['wrong audience', { token: await d.access.token({ ...svc, aud: ['other-aud'] }) }, /wrong token audience/],
    ['expired', { token: await d.access.token({ ...svc, exp: now - 3600 }) }, /token expired/],
    ['not yet valid', { token: await d.access.token({ ...svc, nbf: now + 3600 }) }, /not yet valid/],
    ['unknown key', { token: await d.access.token(svc, { header: { kid: 'kid-unknown' } }) }, /unknown signing key/],
    ['a person on the ingest API', { claims: d.access.userClaims('reviewer@example.com') }, /allowlisted service token/],
    ['a service token not allowlisted', { claims: d.access.serviceClaims('other-client.access') }, /allowlisted service token/],
  ];
  for (const [label, how, why] of refusals) {
    const res = await asUser(d, 'GET', '/_admin/aliases', how.token !== undefined ? { token: how.token } : { claims: how.claims });
    assert.equal(res.status, 403, label);
    assert.match((await res.json()).error, why, label);
  }
  const fetchesBefore = d.certsFetched.length;
  await asUser(d, 'GET', '/_admin/aliases', { token: await d.access.token(svc, { header: { kid: 'kid-rotated' } }) });
  assert.equal(d.certsFetched.length, fetchesBefore + 1, 'an unknown key ID refetches the team certs once');
  assert.equal((await asUser(d, 'GET', '/_admin/aliases', { claims: svc })).status, 200, 'the allowlisted service token is accepted');
  const unconfigured = await d.worker.fetch(new Request(`${d.origin}/_admin/aliases`, { headers: { 'cf-access-jwt-assertion': await d.access.token(svc) } }), { ...d.env, POLICY_AUD: '' });
  assert.equal(unconfigured.status, 403, 'a Worker without POLICY_AUD refuses everything');
  const { createWorker } = await import('../../src/publication/worker/index.mjs');
  const noCerts = createWorker({ fetchCerts: async () => { throw new Error('unreachable'); } });
  const res = await noCerts.fetch(new Request(`${d.origin}/_admin/aliases`, { headers: { 'cf-access-jwt-assertion': await d.access.token(svc) } }), d.env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /signing keys unavailable/);
});

test('[PV-05 Worker] no delete route and no deletion: DELETE is refused everywhere and the bindings offer no delete', async (t) => {
  const { d, dir, opts } = await setup(t);
  const p = await syntheticPacket(dir);
  await publish({ ...opts, packetDir: p.dir });
  await promote({ ...opts, alias: 'review', contentId: p.contentId, expectGeneration: 0 });
  const objectsBefore = d.env.PACKETS.objects.size;
  const h = { 'cf-access-client-id': d.credentials.clientId, 'cf-access-client-secret': d.credentials.clientSecret };
  for (const path of [`/_admin/objects/${objectKey(p.contentId, 'report.md')}`, '/_admin/aliases/review', '/_admin/receipts/x.json', '/_admin/aliases']) {
    const r = await d.edge({ method: 'DELETE', path, headers: h });
    assert.ok([404, 405].includes(r.status), `DELETE ${path} -> ${r.status}`);
  }
  assert.equal(d.env.PACKETS.objects.size, objectsBefore, 'no object was removed');
  assert.equal(d.env.ALIASES.db.prepare('SELECT count(*) AS n FROM alias').get().n, 1);
  assert.equal(typeof d.env.PACKETS.delete, 'undefined', 'the R2 fake has no delete, so a Worker delete call would fail loudly');
});
