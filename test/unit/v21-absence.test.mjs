// V2.1 slice 05: teardown absence proof over FULL account listings, against a loopback fake
// with pagination, and the filtered-versus-full check QA can run on saved evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { cfApi } from '../../scripts/lib/cf-api.mjs';
import { absence, checkEvidence, EXIT } from '../../scripts/cf-absence.mjs';
import { fakeCfApi } from '../v21/fake-cf-api.mjs';

const env = { CLOUDFLARE_API_TOKEN: 'fake-token-for-loopback-tests-only' };
const T = { worker: 'rp-publisher-test', bucket: 'rp-packets-test-20261001-a1', database: 'rp-aliases-test-20261001-a1' };

// An account with other resources; D1 spans 3 pages of 100, R2 2 cursor pages.
function account({ leftover = null } = {}) {
  const d1 = Array.from({ length: 250 }, (_, i) => ({ name: `other-db-${i}`, uuid: `u${i}` }));
  if (leftover === 'd1-last-page') d1[249] = { name: T.database, uuid: 'u249' };
  return {
    'GET /client/v4/accounts/acct123/workers/scripts': () => ({ status: 200, json: { success: true, result: [{ id: 'other-worker' }, ...(leftover === 'worker' ? [{ id: T.worker }] : [])] } }),
    'GET /client/v4/accounts/acct123/r2/buckets': ({ query }) => (query.cursor
      ? { status: 200, json: { success: true, result: { buckets: [{ name: 'other-b2' }] }, result_info: {} } }
      : { status: 200, json: { success: true, result: { buckets: [{ name: 'other-b1' }] }, result_info: { cursor: 'next-1' } } }),
    'GET /client/v4/accounts/acct123/d1/database': ({ query }) => {
      const page = Number(query.page); const per = Number(query.per_page);
      return { status: 200, json: { success: true, result: d1.slice((page - 1) * per, page * per), result_info: { page, per_page: per, total_count: d1.length } } };
    },
  };
}
async function endpoint(status) {
  const s = createServer((_, res) => { res.writeHead(status); res.end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, close: () => new Promise((r) => s.close(r)) };
}

test('[V2.1-05] absence is proved over full, paginated account listings, and the endpoint answers 404', async () => {
  const fake = await fakeCfApi(account());
  const ep = await endpoint(404);
  try {
    const r = await absence({ api: cfApi({ live: true, env, connectTo: fake.origin }), accountId: 'acct123', ...T, endpoint: ep.url });
    assert.equal(r.exit, EXIT.absent, JSON.stringify(r.problems));
    const d1 = r.evidence.listings.find((l) => l.kind === 'd1-databases');
    assert.equal(d1.requests.length, 3, 'every D1 page was read');
    assert.equal(d1.names.length, 250);
    assert.equal(r.evidence.listings.find((l) => l.kind === 'r2-buckets').requests.length, 2, 'the R2 cursor was followed');
    assert.deepEqual(checkEvidence(r.evidence), []);
    for (const q of fake.requests) assert.ok(!['name', 'name_contains', 'prefix'].some((p) => p in q.query), 'no request is name-filtered');
  } finally {
    await fake.close();
    await ep.close();
  }
});

test('[V2.1-05] a resource left on the LAST page, a live Worker, or a live endpoint is caught', async () => {
  for (const [leftover, status, re] of [['d1-last-page', 404, /d1-databases: rp-aliases-test-20261001-a1 is still present/], ['worker', 404, /workers-scripts: rp-publisher-test is still present/], [null, 200, /answered 200, not 404/]]) {
    const fake = await fakeCfApi(account({ leftover }));
    const ep = await endpoint(status);
    try {
      const r = await absence({ api: cfApi({ live: true, env, connectTo: fake.origin }), accountId: 'acct123', ...T, endpoint: ep.url });
      assert.equal(r.exit, EXIT.present);
      assert.ok(r.problems.some((p) => re.test(p)), JSON.stringify(r.problems));
    } finally {
      await fake.close();
      await ep.close();
    }
  }
});

test('[V2.1-05] saved evidence proves nothing if a listing is filtered, partial, or has no captured URL', () => {
  const full = (kind, path, names = []) => ({ kind, requests: [`https://api.cloudflare.com/client/v4/accounts/acct123/${path}`], names, complete: true });
  const good = { targets: { 'workers-scripts': T.worker, 'r2-buckets': T.bucket, 'd1-databases': T.database }, listings: [full('workers-scripts', 'workers/scripts'), full('r2-buckets', 'r2/buckets'), full('d1-databases', 'd1/database')] };
  assert.deepEqual(checkEvidence(good), []);
  const filtered = structuredClone(good); filtered.listings[2].requests = ['https://api.cloudflare.com/client/v4/accounts/acct123/d1/database?name=rp-aliases-test-20261001-a1'];
  assert.ok(checkEvidence(filtered).some((p) => /filtered \(name\)/.test(p)));
  const partial = structuredClone(good); partial.listings[2].complete = false;
  assert.ok(checkEvidence(partial).some((p) => /pagination was not followed/.test(p)));
  // The live fire's shape: an empty result with no request URL recorded.
  const liveFire = { listings: [{ kind: 'workers-scripts', names: [] }, { kind: 'r2-buckets', names: [] }, { kind: 'd1-databases', names: [] }] };
  assert.equal(checkEvidence(liveFire).filter((p) => /request URL was not captured/.test(p)).length, 3);
});

test('[V2.1-05] a dry run sends nothing', async () => {
  const fake = await fakeCfApi({});
  try {
    const r = await absence({ api: cfApi({ connectTo: fake.origin }), accountId: 'acct123', ...T });
    assert.equal(r.dryRun, true);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});
