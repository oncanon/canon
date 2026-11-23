// V2.1 slice 06: the token-verify half of the scope proof, against a loopback fake.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cfApi } from '../../scripts/lib/cf-api.mjs';
import { EXIT, verifyToken } from '../../scripts/cf-token-verify.mjs';
import { fakeCfApi } from '../v21/fake-cf-api.mjs';

const TOKEN = 'fake-token-for-loopback-tests-only';
const env = { CLOUDFLARE_API_TOKEN: TOKEN };
const V = 'GET /client/v4/accounts/acct123/tokens/verify';
const NOW = Date.parse('2026-10-01T12:00:00Z');

async function run(out) {
  const fake = await fakeCfApi({ [V]: () => out });
  try {
    return { r: await verifyToken({ api: cfApi({ live: true, env, connectTo: fake.origin }), accountId: 'acct123', now: NOW }), requests: fake.requests };
  } finally {
    await fake.close();
  }
}

test('[V2.1-06] an active 1-day token passes; the output carries its ID and expiry, never the token', async () => {
  const { r, requests } = await run({ status: 200, json: { success: true, result: { id: 'tok-id-1', status: 'active', expires_on: '2026-10-02T11:00:00Z' } } });
  assert.equal(r.exit, EXIT.ok);
  assert.equal(r.state, 'active');
  assert.equal(r.id, 'tok-id-1');
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('[V2.1-06] an inactive token, one without expiry, or one outliving the 1-day TTL is refused', async () => {
  for (const result of [
    { id: 'x', status: 'disabled', expires_on: '2026-10-02T11:00:00Z' },
    { id: 'x', status: 'active' },
    { id: 'x', status: 'active', expires_on: '2026-10-09T12:00:00Z' },
  ]) {
    const { r } = await run({ status: 200, json: { success: true, result } });
    assert.equal(r.exit, EXIT.notActive, JSON.stringify(result));
  }
  const { r } = await run({ status: 401, json: { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] } });
  assert.equal(r.exit, EXIT.apiError);
});

test('[V2.1-06] a dry run sends nothing', async () => {
  const fake = await fakeCfApi({});
  try {
    const r = await verifyToken({ api: cfApi({ connectTo: fake.origin }), accountId: 'acct123' });
    assert.equal(r.state, 'dry-run');
    assert.equal(fake.requests.length, 0);
    assert.equal(r.request.url, 'https://api.cloudflare.com/client/v4/accounts/acct123/tokens/verify');
  } finally {
    await fake.close();
  }
});
