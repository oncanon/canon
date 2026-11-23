// SH-2: an explicit operator switch, `allowCustomDomain: true` in the target file, lets a
// Cloudflare target use a non-workers.dev https origin. Two call sites independently judge
// a Cloudflare endpoint (src/publication/policy.mjs:47 and
// src/publication/transports/cloudflare-http.mjs:18): SH2-1 proves the transport itself
// honours the switch, not only target validation, since an earlier version of this plan
// found that fixing policy.mjs alone leaves the transport refusing a target policy had
// already waved through.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CODES } from '../../src/publication/errors.mjs';
import { createCloudflareWorker } from '../../src/publication/mocks/cloudflare-worker.mjs';
import { assertTargetAvailable } from '../../src/publication/policy.mjs';
import { promote, publish } from '../../src/publication/protocol.mjs';
import { adapterFor, loadTargets } from '../../src/publication/targets.mjs';
import { CloudflareHttpTransport } from '../../src/publication/transports/cloudflare-http.mjs';
import { customHttpsOrigin, workersDevOrigin } from '../../src/publication/transports/endpoint.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';

const CUSTOM = 'https://review.example.com';
const WORKERS_DEV = 'https://rp-publisher-test.example.workers.dev';
const GRANTS = new Set(['upload', 'promote']);
const target = (extra = {}) => ({ name: 'cf-custom', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST', endpoint: CUSTOM, ...extra });

async function loopback(t, handle) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
      const r = await handle({ method: req.method, path: req.url, headers: { ...req.headers }, body });
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
  });
  await new Promise((r) => server.listen({ host: '127.0.0.1', port: 0 }, r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

// ---- unit: the new shape-check function -------------------------------------------------

test('[SH-2] customHttpsOrigin accepts a plain https origin and refuses the same malformed shapes workersDevOrigin refuses', () => {
  assert.equal(customHttpsOrigin(CUSTOM), CUSTOM);
  assert.equal(customHttpsOrigin('https://example.com'), 'https://example.com', 'unlike workersDevOrigin, a non-workers.dev host is accepted');
  const bad = [
    ['http://review.example.com', /is not https/],
    [`https://${['user', 'pw'].join(':')}@review.example.com`, /user information/],
    ['https://review.example.com:8443', /port 8443/],
    ['https://review.example.com/_admin/', /path, query or fragment/],
    ['https://review.example.com/?x=1', /path, query or fragment/],
    ['not a url', /not a URL/],
    [undefined, /none given/],
  ];
  for (const [endpoint, why] of bad) assert.throws(() => customHttpsOrigin(endpoint), (e) => e.code === CODES.INVALID && why.test(e.message), String(endpoint));
  // workersDevOrigin is unchanged: it still refuses the same custom host customHttpsOrigin accepts.
  assert.throws(() => workersDevOrigin(CUSTOM), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message));
});

// ---- policy: assertTargetAvailable at the first call site -------------------------------

test('[SH-2] assertTargetAvailable: a custom https endpoint needs allowCustomDomain: true; absent or false is refused exactly as today', () => {
  assert.throws(() => assertTargetAvailable(target()), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message), 'absent: refused, as today');
  assert.throws(() => assertTargetAvailable(target({ allowCustomDomain: false })), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message), 'explicitly false: still refused');
  assert.doesNotThrow(() => assertTargetAvailable(target({ allowCustomDomain: true })), 'explicit true: accepted');
  assert.doesNotThrow(() => assertTargetAvailable(target({ endpoint: WORKERS_DEV, allowCustomDomain: true })), 'a workers.dev endpoint stays accepted when the switch happens to be set too');
});

// ---- SH2-1: the transport itself, independently of policy -------------------------------

test('[SH2-1] CloudflareHttpTransport: a custom https endpoint needs allowCustomDomain: true at construction, not only at policy.mjs:47', () => {
  // The regression this guards: policy.mjs already accepts this exact endpoint (previous test),
  // yet the transport, constructed directly with no network call, still throws without its own switch.
  assert.doesNotThrow(() => assertTargetAvailable(target({ allowCustomDomain: true })), 'policy has already waved this endpoint through');
  assert.throws(() => new CloudflareHttpTransport({ endpoint: CUSTOM }), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message), 'the transport still refuses on its own when allowCustomDomain is omitted');
  assert.throws(() => new CloudflareHttpTransport({ endpoint: CUSTOM, allowCustomDomain: false }), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message));
  const t = new CloudflareHttpTransport({ endpoint: CUSTOM, allowCustomDomain: true });
  assert.equal(t.origin, CUSTOM);
  const dev = new CloudflareHttpTransport({ endpoint: WORKERS_DEV, allowCustomDomain: true });
  assert.equal(dev.origin, WORKERS_DEV, 'a workers.dev endpoint still works when the switch is set');
});

test('[SH-2] loadTargets accepts allowCustomDomain as a plain boolean field (the endpoint check happens later, at assertTargetAvailable)', async (t) => {
  const dir = await tempDir(t, 'canon-cf-custom-cfg');
  const file = join(dir, 'targets.json');
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [target({ allowCustomDomain: true })] }));
  await assert.doesNotReject(loadTargets(file));
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [{ ...target(), allowCustomDomain: 'yes' }] }));
  await assert.rejects(loadTargets(file), (e) => e.code === CODES.INVALID, 'a non-boolean value is refused by the schema');
});

// ---- end to end: adapterFor wires the one target-file field through both construction sites --

test('[SH2-1] publish and promote reach a custom-domain target through the real transport when allowCustomDomain is true', async (t) => {
  const worker = createCloudflareWorker({});
  const { origin, seen } = await loopback(t, (req) => worker.handle({ method: req.method, path: req.path, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: req.body }));
  const dir = await tempDir(t, 'canon-cf-custom-loop');
  const env = { RP_CF_TEST: JSON.stringify(worker.credentials()) };
  const tgt = { ...target({ allowCustomDomain: true }), ledgerDir: join(dir, 'ledger') };
  const adapter = adapterFor(tgt, { env, grants: GRANTS, connectTo: origin });
  assert.equal(adapter.describe().kind, 'cloudflare');
  const p = await syntheticPacket(dir);
  const published = await publish({ adapter, target: tgt, packetDir: p.dir, grants: GRANTS });
  assert.equal(published.state, 'READBACK_VERIFIED');
  const moved = await promote({ adapter, target: tgt, alias: 'review', contentId: p.contentId, expectGeneration: 0, grants: GRANTS });
  assert.equal(moved.state, 'PROMOTED');
  assert.ok(seen.length > 0 && seen.length === adapter.requestCount(), 'every request the adapter made reached the loopback server');
  for (const r of seen) assert.equal(r.headers.host, origin.slice('http://'.length), 'sent to the loopback origin only (never the configured custom hostname)');
});

test('[SH2-1] the same custom-domain target without allowCustomDomain is refused before any adapter is built', async (t) => {
  const worker = createCloudflareWorker({});
  const dir = await tempDir(t, 'canon-cf-custom-refuse');
  const tgt = { ...target(), ledgerDir: join(dir, 'ledger') };
  assert.throws(() => adapterFor(tgt, { env: { RP_CF_TEST: JSON.stringify(worker.credentials()) }, grants: GRANTS }), (e) => e.code === CODES.INVALID && /not a workers\.dev host/.test(e.message));
});
