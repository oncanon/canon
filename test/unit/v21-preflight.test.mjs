// V2.1 slice 01: the R2 pre-flight detects R2-not-enabled (HTTP 403, code 10042, as seen
// live) before any apply, against a loopback fake of the Cloudflare API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { cfApi } from '../../scripts/lib/cf-api.mjs';
import { EXIT, preflight } from '../../scripts/cf-preflight.mjs';
import { REPO } from '../helpers.mjs';
import { fakeCfApi } from '../v21/fake-cf-api.mjs';

const TOKEN = 'fake-token-for-loopback-tests-only';
const env = { CLOUDFLARE_API_TOKEN: TOKEN };
const R2 = 'GET /client/v4/accounts/acct123/r2/buckets';

test('[V2.1-01] a dry run sends nothing and shows the exact request', async () => {
  const fake = await fakeCfApi({});
  try {
    const r = await preflight({ api: cfApi({ connectTo: fake.origin }), accountId: 'acct123' });
    assert.equal(fake.requests.length, 0, 'nothing sent');
    assert.equal(r.exit, EXIT.ready);
    assert.deepEqual(r.checks[0].request, { method: 'GET', url: 'https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets', body: null });
  } finally {
    await fake.close();
  }
});

test('[V2.1-01] R2 not enabled (403, code 10042) is reported before any apply, with the runbook step', async () => {
  const fake = await fakeCfApi({ [R2]: () => ({ status: 403, json: { success: false, errors: [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }], messages: [], result: null } }) });
  try {
    const r = await preflight({ api: cfApi({ live: true, env, connectTo: fake.origin }), accountId: 'acct123' });
    assert.equal(r.exit, EXIT.r2NotEnabled);
    assert.equal(r.checks[0].state, 'r2-not-enabled');
    assert.match(r.checks[0].message, /runbook step 2/);
    assert.match(r.checks[0].message, /Do not run tofu apply/);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].authorization, `Bearer ${TOKEN}`, 'the token is sent as a bearer header');
    assert.ok(!JSON.stringify(r).includes(TOKEN), 'the token appears nowhere in the result');
  } finally {
    await fake.close();
  }
});

test('[V2.1-01] R2 enabled passes; any other error is an API failure, not "enabled"', async () => {
  for (const [out, exit, state] of [
    [{ status: 200, json: { success: true, errors: [], result: { buckets: [] } } }, EXIT.ready, 'r2-enabled'],
    [{ status: 403, json: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }, EXIT.apiError, 'api-error'],
    [{ status: 200, json: { success: false, errors: [{ code: 10042 }] } }, EXIT.apiError, 'api-error'],
    [{ status: 500, json: { success: false, errors: [] } }, EXIT.apiError, 'api-error'],
  ]) {
    const fake = await fakeCfApi({ [R2]: () => out });
    try {
      const r = await preflight({ api: cfApi({ live: true, env, connectTo: fake.origin }), accountId: 'acct123' });
      assert.equal(r.exit, exit, JSON.stringify(out));
      assert.equal(r.checks[0].state, state);
    } finally {
      await fake.close();
    }
  }
});

test('[V2.1-01] live mode needs a token; the test origin must be loopback; IDs are validated', () => {
  assert.throws(() => cfApi({ live: true, env: {} }), /needs a token/);
  assert.throws(() => cfApi({ connectTo: 'http://10.0.0.1:8080/' }), /not a loopback/);
  assert.throws(() => cfApi({ connectTo: 'https://127.0.0.1:8080/' }), /not a loopback/);
  return assert.rejects(preflight({ api: cfApi(), accountId: '../x' }), /identifier/);
});

test('[V2.1-01] the CLI dry run prints the request and exits 0; a missing token in live mode exits 2', () => {
  const run = (args, e = {}) => spawnSync(process.execPath, [join(REPO, 'scripts/cf-preflight.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...e } });
  const dry = run(['--account', 'acct123']);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /GET https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct123\/r2\/buckets/);
  assert.equal(run(['--account', 'acct123', '--live']).status, 2);
  assert.equal(run([]).status, 2);
});
