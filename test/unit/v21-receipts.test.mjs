// V2.1 slice 05: receipts are read back from R2 into evidence during the run, through the
// Worker's admin API, with the Worker and its bindings running locally (test/v2/worker-bindings).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cloudflareAdapter } from '../../src/publication/adapters/cloudflare.mjs';
import { publish } from '../../src/publication/protocol.mjs';
import { fetchReceipts, idsIn } from '../../scripts/cf-receipts.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';
import { workerDeployment } from '../v2/worker-bindings.mjs';

async function published(t) {
  const d = await workerDeployment();
  const dir = await tempDir(t, 'canon-v21-rcpt');
  const target = { name: 'cf-real', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST', endpoint: d.origin, ledgerDir: join(dir, 'ledger') };
  const adapter = cloudflareAdapter({ transport: d.transport, credentials: d.credentials, kind: 'cloudflare' });
  const a = await syntheticPacket(dir, 'a');
  const r = await publish({ adapter, target, grants: new Set(['upload', 'promote']), retry: { sleep: async () => {} }, packetDir: a.dir });
  return { d, dir, receiptId: r.receipt.receiptId };
}

test('[V2.1-05] a published receipt is read back into evidence, valid receipt/v2 and secret-free', async (t) => {
  const { d, dir, receiptId } = await published(t);
  const out = join(dir, 'evidence');
  const r = await fetchReceipts({ transport: d.transport, credentials: d.credentials, ids: [receiptId], outDir: out });
  assert.equal(r.ok, true, JSON.stringify(r));
  const saved = readFileSync(join(out, 'receipts', `${receiptId}.json`), 'utf8');
  assert.equal(saved, d.env.PACKETS.objects.get(`receipts/${receiptId}.json`).bytes.toString('utf8'), 'byte for byte');
  assert.equal(JSON.parse(saved).schema, 'receipt/v2');
});

test('[V2.1-05] a missing receipt, or one holding a credential, is refused and not written', async (t) => {
  const { d, dir, receiptId } = await published(t);
  const out = join(dir, 'evidence');
  const missing = await fetchReceipts({ transport: d.transport, credentials: d.credentials, ids: ['2026-01-01T00-00-00-000Z-publish-00000000'], outDir: out });
  assert.equal(missing.ok, false);
  assert.match(missing.results[0].problems[0], /HTTP 404/);
  // A receipt that leaks the live client secret (planted in the fake R2 behind the Worker).
  const key = `receipts/${receiptId}.json`;
  const leaked = JSON.parse(d.env.PACKETS.objects.get(key).bytes.toString('utf8'));
  leaked.note = d.credentials.clientSecret;
  d.env.PACKETS.objects.get(key).bytes = Buffer.from(JSON.stringify(leaked));
  const bad = await fetchReceipts({ transport: d.transport, credentials: d.credentials, ids: [receiptId], outDir: out });
  assert.equal(bad.ok, false);
  assert.ok(bad.results[0].problems.some((p) => p.startsWith('secret:') || p.startsWith('schema:')), JSON.stringify(bad.results[0].problems));
  assert.equal(existsSync(join(out, 'receipts')) && readdirSync(join(out, 'receipts')).length, false, 'nothing written');
});

test('[V2.1-05] receipt IDs are taken from the publisher\'s own output', () => {
  const text = 'published: receipt 2026-09-29T00-36-22-462Z-publish-2cb79c02\npromote result 2026-09-29T00-36-50-568Z-promote-4a61dcb4-result and again 2026-09-29T00-36-22-462Z-publish-2cb79c02';
  assert.deepEqual(idsIn(text), ['2026-09-29T00-36-22-462Z-publish-2cb79c02', '2026-09-29T00-36-50-568Z-promote-4a61dcb4-result']);
});

// ---- V2.1-QA-1: the public target's receipts are read back too, with signed admin requests ----

async function publishedPublic(t) {
  const { publicDeployment, PUBLIC_TARGET_ID } = await import('../v21/public-deployment.mjs');
  const d = await publicDeployment();
  const dir = await tempDir(t, 'canon-v21-rcpt-public');
  const target = { name: 'cf-public', kind: 'cloudflare', accessMode: 'public', targetId: PUBLIC_TARGET_ID, costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_PUBLIC', endpoint: d.origin, ledgerDir: join(dir, 'ledger') };
  const adapter = cloudflareAdapter({ transport: d.transport, credentials: d.credentials, kind: 'cloudflare', signer: (req) => d.sign(req) });
  const a = await syntheticPacket(dir, 'a', { classification: 'public', dataOrigin: 'synthetic' });
  const r = await publish({ adapter, target, grants: new Set(['upload', 'promote']), retry: { sleep: async () => {} }, packetDir: a.dir });
  return { d, dir, target, receiptId: r.receipt.receiptId };
}

test('[V2.1-04] public target: a receipt is read back with a signed admin request, byte for byte; the service-token read-back is refused', async (t) => {
  const { d, dir, receiptId } = await publishedPublic(t);
  const out = join(dir, 'evidence');
  const r = await fetchReceipts({ transport: d.transport, credentials: d.credentials, signer: (req) => d.sign(req), ids: [receiptId], outDir: out });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(join(out, 'receipts', `${receiptId}.json`), 'utf8'), d.env.PACKETS.objects.get(`receipts/${receiptId}.json`).bytes.toString('utf8'));
  // What QA found (V2.1-QA-1): the Access service-token read-back cannot work on the public target.
  const old = await fetchReceipts({ transport: d.transport, credentials: { clientId: 'svc.access', clientSecret: 's'.repeat(40) }, ids: [receiptId], outDir: join(dir, 'old') });
  assert.equal(old.ok, false);
  assert.match(old.results[0].problems[0], /HTTP 403/);
  assert.equal(existsSync(join(dir, 'old', 'receipts')), false);
});

test('[V2.1-04] public target: a receipt holding the signing key is refused and not written', async (t) => {
  const { d, dir, receiptId } = await publishedPublic(t);
  const stored = d.env.PACKETS.objects.get(`receipts/${receiptId}.json`);
  const leaked = JSON.parse(stored.bytes.toString('utf8'));
  leaked.note = d.credentials.privateKey;
  stored.bytes = Buffer.from(JSON.stringify(leaked));
  const out = join(dir, 'evidence');
  const r = await fetchReceipts({ transport: d.transport, credentials: d.credentials, signer: (req) => d.sign(req), ids: [receiptId], outDir: out });
  assert.equal(r.ok, false);
  // Both layers fire, each on its own: the live-credential check (the key this read-back holds) and
  // the secret gate (the key's format).
  assert.ok(r.results[0].problems.some((p) => /^secret: /.test(p)), `live-credential check: ${JSON.stringify(r.results[0].problems)}`);
  assert.ok(r.results[0].problems.some((p) => /^secret gate: publisher-signing-key/.test(p)), `secret gate: ${JSON.stringify(r.results[0].problems)}`);
  assert.equal(existsSync(join(out, 'receipts')), false);
});

test('[V2.1-04] the read-back mode comes from the target: public signs, access-private uses the service token, others are refused', async (t) => {
  const { readbackPlan, credentialsFor, dryRunRequests } = await import('../../scripts/cf-receipts.mjs');
  const { generateSigningKey } = await import('../../src/publication/signing.mjs');
  const { writeFile } = await import('node:fs/promises');
  const dir = await tempDir(t, 'canon-v21-rcpt-plan');
  const file = join(dir, 'targets.json');
  const priv = { name: 'cf-private', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_PRIVATE', endpoint: 'https://rp-publisher-test.example.workers.dev', stateDir: 'private' };
  const pub = { name: 'cf-public', kind: 'cloudflare', accessMode: 'public', targetId: 'rp-public-test-20260930-a1', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_PUBLIC', endpoint: 'https://rp-public-test.example.workers.dev', stateDir: 'public' };
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [priv, pub, { name: 'mock', kind: 'mock-cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_X', stateDir: 'mock' }] }));
  const p = await readbackPlan({ targetsFile: file, targetName: 'cf-public' });
  assert.deepEqual(p, { endpoint: pub.endpoint, mode: 'public', credentialEnv: 'RP_CF_PUBLIC', targetId: pub.targetId });
  assert.deepEqual(dryRunRequests(p, ['r1'])[0].auth, ['x-canon-timestamp', 'x-canon-signature']);
  assert.equal((await readbackPlan({ targetsFile: file, targetName: 'cf-private' })).mode, 'access-private');
  await assert.rejects(readbackPlan({ targetsFile: file, targetName: 'mock' }), /real Cloudflare target only/);
  const key = generateSigningKey();
  assert.equal(typeof credentialsFor(p, { RP_CF_PUBLIC: JSON.stringify({ privateKey: key.privateKey }) }).signer, 'function');
  assert.throws(() => credentialsFor(p, { RP_CF_PUBLIC: JSON.stringify({ privateKey: key.privateKey, clientSecret: 'x' }) }), /privateKey only/);
  assert.throws(() => credentialsFor({ ...p, mode: 'access-private' }, { RP_CF_PUBLIC: JSON.stringify({ privateKey: key.privateKey }) }), /clientId and clientSecret/);
});

test('[V2.1-05] cf-receipts is a dry run by default: it shows the requests, contacts nothing, and prints no credential', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { REPO } = await import('../helpers.mjs');
  const dir = await tempDir(t, 'canon-v21-rcpt-dry');
  const secret = 'dry-run-secret-must-not-print-0123456789';
  // The no-network guard is preloaded: even a CLI that wrongly went live could not leave the machine.
  const r = spawnSync(process.execPath, ['--import', join(REPO, 'test/v2/no-network.mjs'), join(REPO, 'scripts/cf-receipts.mjs'), '--endpoint', 'https://rp-publisher-test.example.workers.dev', '--out', dir, '--id', '2026-01-01T00-00-00-000Z-publish-00000000'], { encoding: 'utf8', env: { ...process.env, RP_CF_TEST: JSON.stringify({ clientId: 'id.access', clientSecret: secret }) } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.requests, [{ method: 'GET', url: 'https://rp-publisher-test.example.workers.dev/_admin/receipts/2026-01-01T00-00-00-000Z-publish-00000000.json', auth: ['cf-access-client-id', 'cf-access-client-secret'] }]);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  assert.equal(existsSync(join(dir, 'receipts')), false, 'nothing was written');
});
