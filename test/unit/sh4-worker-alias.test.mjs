// SH-4: the Worker's alias route redirects /a/<name>/index.md to the promoted
// edition's index.md, matching the local server's three alias cases
// (src/server/server.mjs: /a/<name>/, /a/<name>/report.md, /a/<name>/index.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareAdapter } from '../../src/publication/adapters/cloudflare.mjs';
import { promote, publish } from '../../src/publication/protocol.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';
import { workerDeployment } from '../v2/worker-bindings.mjs';
import { join } from 'node:path';

const GRANTS = new Set(['upload', 'promote']);

async function setup(t) {
  const d = await workerDeployment();
  const dir = await tempDir(t, 'canon-sh4-worker');
  const target = { name: 'cf-real', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST', endpoint: d.origin, ledgerDir: join(dir, 'ledger') };
  const adapter = cloudflareAdapter({ transport: d.transport, credentials: d.credentials, kind: 'cloudflare' });
  const opts = { adapter, target, grants: GRANTS, retry: { sleep: async () => {} } };
  return { d, dir, opts };
}

const REVIEWER_EMAIL = ['reviewer', 'example.com'].join('@');

async function asUser(d, method, path) {
  const jwt = await d.access.token(d.access.userClaims(REVIEWER_EMAIL));
  return d.worker.fetch(new Request(`${d.origin}${path}`, { method, headers: { 'cf-access-jwt-assertion': jwt } }), d.env);
}

test('[SH4-1] GET /a/<name>/index.md redirects 307 to /p/<id>/index.md', async (t) => {
  const { d, dir, opts } = await setup(t);
  const p = await syntheticPacket(dir);
  await publish({ ...opts, packetDir: p.dir });
  await promote({ ...opts, alias: 'review', contentId: p.contentId, expectGeneration: 0 });
  const r = await asUser(d, 'GET', '/a/review/index.md');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), `/p/${p.contentId}/index.md`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
