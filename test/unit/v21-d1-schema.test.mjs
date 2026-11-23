// V2.1 slice 02: the D1 schema goes over the D1 HTTP query API (wrangler is off the path).
// The loopback fake executes each statement on a real SQLite database (node:sqlite), so
// idempotency and the sqlite_master verification are real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cfApi } from '../../scripts/lib/cf-api.mjs';
import { applySchema, EXIT, refusals, SCHEMA_FILE, statements } from '../../scripts/d1-schema.mjs';
import { REPO } from '../helpers.mjs';
import { fakeCfApi } from '../v21/fake-cf-api.mjs';

const TOKEN = 'fake-token-for-loopback-tests-only';
const env = { CLOUDFLARE_API_TOKEN: TOKEN };
const SQL = readFileSync(join(REPO, SCHEMA_FILE), 'utf8');
const Q = 'POST /client/v4/accounts/acct123/d1/database/db-1/query';

function d1(db, fail = null) {
  return {
    [Q]: ({ body }) => {
      if (fail) return fail;
      try {
        if (/^\s*SELECT/i.test(body.sql)) return { status: 200, json: { success: true, errors: [], result: [{ success: true, results: db.prepare(body.sql).all(), meta: {} }] } };
        db.exec(body.sql);
        return { status: 200, json: { success: true, errors: [], result: [{ success: true, results: [], meta: { changes: 0 } }] } };
      } catch (err) {
        return { status: 400, json: { success: false, errors: [{ code: 7500, message: err.message }] } };
      }
    },
  };
}
const live = (fake) => cfApi({ live: true, env, connectTo: fake.origin });

test('[V2.1-02] the schema is applied statement by statement over the D1 query API, then verified', async () => {
  const db = new DatabaseSync(':memory:');
  const fake = await fakeCfApi(d1(db));
  try {
    const r = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: SQL });
    assert.equal(r.exit, EXIT.ok, JSON.stringify(r));
    assert.deepEqual(r.verified.sort(), ['alias', 'alias_history']);
    const stmts = statements(SQL);
    assert.equal(fake.requests.length, stmts.length + 1, 'one request per statement plus the verification read');
    for (const q of fake.requests) {
      assert.equal(q.method, 'POST');
      assert.equal(q.path, '/client/v4/accounts/acct123/d1/database/db-1/query');
      assert.equal(q.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(Object.keys(q.body), ['sql'], 'the body is { sql }');
    }
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  } finally {
    await fake.close();
  }
});

test('[V2.1-02] re-running is idempotent: the same statements, no error, the same verified schema', async () => {
  const db = new DatabaseSync(':memory:');
  const fake = await fakeCfApi(d1(db));
  try {
    const first = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: SQL });
    db.exec("INSERT INTO alias VALUES ('a', 'sha256-x', 1, 'op', 't')");
    const second = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: SQL });
    assert.equal(first.exit, EXIT.ok);
    assert.equal(second.exit, EXIT.ok);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alias').get().n, 1, 'existing rows are untouched');
  } finally {
    await fake.close();
  }
});

test('[V2.1-02] non-idempotent DDL is refused before any request', async () => {
  const fake = await fakeCfApi({});
  try {
    for (const bad of ['CREATE TABLE alias (name TEXT);', 'DROP TABLE alias;', 'ALTER TABLE alias ADD COLUMN x TEXT;', "INSERT INTO alias VALUES ('a');", 'DELETE FROM alias;', 'PRAGMA foreign_keys = ON;', `${SQL}\nDROP TABLE alias_history;`]) {
      const r = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: bad });
      assert.equal(r.exit, EXIT.refused, bad);
    }
    assert.equal(fake.requests.length, 0, 'nothing sent for a refused schema');
    assert.deepEqual(refusals(statements(SQL)), [], 'the committed schema is idempotent');
  } finally {
    await fake.close();
  }
});

test('[V2.1-02] a table whose existing definition differs from the schema is reported, not silently accepted', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE alias (name TEXT PRIMARY KEY)');
  const fake = await fakeCfApi(d1(db));
  try {
    const r = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: SQL });
    assert.equal(r.exit, EXIT.mismatch);
    assert.ok(r.mismatches.some((m) => m.startsWith('alias: differs')), JSON.stringify(r.mismatches));
  } finally {
    await fake.close();
  }
});

test('[V2.1-02] API errors are mapped, including the 9106 class seen live', async () => {
  for (const [code, re] of [[9106, /9106: authentication failed for this call/], [10000, /10000: authentication error/], [7404, /7404: database not found/], [9999, /9999: unrecognised/]]) {
    const fake = await fakeCfApi(d1(null, { status: 400, json: { success: false, errors: [{ code, message: 'x' }] } }));
    try {
      const r = await applySchema({ api: live(fake), accountId: 'acct123', databaseId: 'db-1', sql: SQL });
      assert.equal(r.exit, EXIT.apiError);
      assert.match(r.message, re);
      assert.equal(fake.requests.length, 1, 'it stops at the first failed statement');
    } finally {
      await fake.close();
    }
  }
});

test('[V2.1-02] a dry run is the default: it prints every request and sends nothing', () => {
  const run = (args, e = {}) => spawnSync(process.execPath, [join(REPO, 'scripts/d1-schema.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...e } });
  const dry = run(['--account', 'acct123', '--database', 'db-1']);
  assert.equal(dry.status, 0);
  assert.equal((dry.stdout.match(/^POST https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct123\/d1\/database\/db-1\/query$/gm) ?? []).length, statements(SQL).length + 1);
  assert.match(dry.stdout, /dry run: nothing sent/);
  assert.equal(run(['--account', 'acct123', '--database', 'db-1', '--live']).status, 2, 'live without a token is a usage error');
});
