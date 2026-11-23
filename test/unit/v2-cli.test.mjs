// V2 CLI authority gates (docs/v2/publication-protocol.md §6): each provider-reaching
// action needs its own explicit grant; classification, synthetic-data, public-exposure
// and cost refusals happen before any provider request; there is no delete, DNS or
// public-exposure command; credentials come from the environment and are never printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createCloudflareWorker } from '../../src/publication/mocks/cloudflare-worker.mjs';
import { CLI, tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';

async function setup(t) {
  const dir = await tempDir(t, 'canon-v2-cli');
  const cf = createCloudflareWorker({ stateDir: join(dir, 'cf-state') });
  cf.inject({}); // persist initial state (and its credentials)
  const targets = {
    schema: 'publication-targets/v1',
    targets: [
      { name: 'local', kind: 'fs', root: 'store', accessMode: 'local', costCeilingUsdPerMonth: 0 },
      { name: 'cf-test', kind: 'mock-cloudflare', stateDir: 'cf-state', ledgerDir: 'ledger', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST' },
      { name: 'cf-broke', kind: 'mock-cloudflare', stateDir: 'cf-state', ledgerDir: 'ledger-broke', accessMode: 'access-private', costCeilingUsdPerMonth: 0, credentialEnv: 'RP_CF_TEST' },
      // Its own state and credential: a public target sharing either with a private one is
      // refused when the file loads (V2.1 slice 04). It is refused here for being a mock.
      { name: 'cf-public', kind: 'mock-cloudflare', stateDir: 'cf-public-state', accessMode: 'public', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_PUBLIC' },
      { name: 'cf-real', kind: 'cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_TEST' },
    ],
  };
  await writeFile(join(dir, 'targets.json'), JSON.stringify(targets));
  const env = { ...process.env, CANON_LOOPBACK_ONLY: '1', RP_CF_TEST: JSON.stringify(cf.credentials()) };
  const secrets = [cf.credentials().clientSecret];
  const canon = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8' });
    for (const s of secrets) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), `canon ${args[0]} never prints a credential`);
    return { status: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  const cfObjects = () => Object.keys(createCloudflareWorker({ stateDir: join(dir, 'cf-state') }).state.r2).length;
  return { dir, canon, cfObjects, targetsFile: join(dir, 'targets.json') };
}

test('[V2-12] CLI: publish, promote, rollback and reconcile each need their own explicit grant', async (t) => {
  const s = await setup(t);
  const p = await syntheticPacket(s.dir);
  const T = ['--targets', s.targetsFile];
  let r = s.canon('publish', p.dir, '--target', 'cf-test', ...T);
  assert.equal(r.status, 1);
  assert.equal(r.json.error, 'grant-missing');
  r = s.canon('publish', p.dir, '--target', 'cf-test', ...T, '--grant', 'promote');
  assert.equal(r.json.error, 'grant-missing', 'the promote grant does not allow upload');
  assert.equal(s.cfObjects(), 0, 'refused publishes wrote nothing to the provider');
  r = s.canon('publish', p.dir, '--target', 'cf-test', ...T, '--grant', 'upload');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.json.state, 'READBACK_VERIFIED');
  r = s.canon('promote', '--target', 'cf-test', ...T, '--alias', 'review', '--content-id', p.contentId, '--expect-generation', '0', '--grant', 'upload');
  assert.equal(r.json.error, 'grant-missing', 'the upload grant does not allow promote');
  r = s.canon('promote', '--target', 'cf-test', ...T, '--alias', 'review', '--content-id', p.contentId, '--expect-generation', '0', '--grant', 'promote');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.json.record.generation, 1);
  r = s.canon('rollback', '--target', 'cf-test', ...T, '--alias', 'review', '--to', `sha256-${'0'.repeat(64)}`, '--expect-generation', '1', '--grant', 'promote');
  assert.equal(r.json.error, 'target-not-verified');
  assert.equal(s.canon('reconcile', '--target', 'cf-test', ...T).json.error, 'grant-missing');
  assert.equal(s.canon('reconcile', '--target', 'cf-test', ...T, '--grant', 'promote').status, 0);
  // The local fs target is V1 behaviour: no grant needed.
  assert.equal(s.canon('publish', p.dir, '--target', 'local', ...T).status, 0);
});

test('[V2-8] CLI: synthetic-only, public exposure, real providers and cost ceiling are refused before any request', async (t) => {
  const s = await setup(t);
  const T = ['--targets', s.targetsFile];
  const production = await syntheticPacket(s.dir, 'prod', { classification: 'private-review', dataOrigin: 'production' });
  const synthetic = await syntheticPacket(s.dir, 'syn');
  assert.equal(s.canon('publish', production.dir, '--target', 'cf-test', ...T, '--grant', 'upload').json.error, 'synthetic-only');
  assert.equal(s.canon('publish', synthetic.dir, '--target', 'cf-public', ...T, '--grant', 'upload').json.error, 'not-available');
  assert.equal(s.canon('publish', synthetic.dir, '--target', 'cf-real', ...T, '--grant', 'upload').json.error, 'not-available');
  assert.equal(s.canon('publish', synthetic.dir, '--target', 'cf-broke', ...T, '--grant', 'upload').json.error, 'cost-ceiling');
  assert.equal(s.cfObjects(), 0, 'no refusal reached the provider');
});

test('[V2-12] CLI: no delete, DNS or public command exists; unknown grants are usage errors; target files hold no secrets', async (t) => {
  const s = await setup(t);
  for (const cmd of ['delete', 'purge', 'dns', 'expose', 'invalidate']) assert.equal(s.canon(cmd).status, 2, `canon ${cmd} is not a command`);
  const p = await syntheticPacket(s.dir);
  assert.equal(s.canon('publish', p.dir, '--target', 'cf-test', '--targets', s.targetsFile, '--grant', 'delete').status, 2);
  const bad = join(s.dir, 'bad-targets.json');
  await writeFile(bad, JSON.stringify({ schema: 'publication-targets/v1', targets: [{ name: 'x', kind: 'mock-cloudflare', stateDir: 'token=abc123', accessMode: 'access-private', costCeilingUsdPerMonth: 1, credentialEnv: 'RP_CF_TEST' }] }));
  const r = s.canon('publish', p.dir, '--target', 'x', '--targets', bad, '--grant', 'upload');
  assert.equal(r.status, 1);
  assert.equal(r.json.error, 'invalid');
  const unknown = join(s.dir, 'extra-field.json');
  await writeFile(unknown, JSON.stringify({ schema: 'publication-targets/v1', targets: [{ name: 'x', kind: 'mock-cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 1, credentialEnv: 'RP_CF_TEST', apiToken: 'x' }] }));
  assert.equal(s.canon('publish', p.dir, '--target', 'x', '--targets', unknown, '--grant', 'upload').json.error, 'invalid', 'unknown target fields (such as a token) are rejected');
});
