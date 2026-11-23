#!/usr/bin/env node
// V2.1 slice 02: apply the Worker's D1 schema over the D1 HTTP query API, replacing wrangler.
// The live fire's `wrangler d1 migrations apply` failed with code 9106 on /memberships: it
// needs account-membership scopes the deploy token does not have. The query endpoint needs
// only the D1 scope the token already holds.
//
// The schema is src/publication/worker/schema.sql (the wrangler migration is byte-identical).
// Every statement must be idempotent DDL, `CREATE TABLE|INDEX IF NOT EXISTS`; anything else
// (DROP, ALTER, INSERT, DELETE, a CREATE without IF NOT EXISTS, PRAGMA, ...) is refused before
// any request, so a re-run can never change or destroy data.
//
//   node scripts/d1-schema.mjs --account <id> --database <d1-id>          dry run (default)
//   node scripts/d1-schema.mjs --account <id> --database <d1-id> --live   apply, then verify
//
// Live: one POST /accounts/<id>/d1/database/<d1-id>/query per statement, then a read of
// sqlite_master that must show every table exactly as the schema defines it.
// Exit: 0 applied and verified (or a dry run), 3 verification mismatch, 4 API error,
// 5 refused (non-idempotent schema), 2 usage. Running it live is an external action.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cfApi, CfApiError, checkId, errorCodes } from './lib/cf-api.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SCHEMA_FILE = 'src/publication/worker/schema.sql';
export const EXIT = { ok: 0, usage: 2, mismatch: 3, apiError: 4, refused: 5 };
const VERIFY_SQL = "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name";

// Known D1/API error codes, with what the operator should do.
export const ERRORS = {
  9106: 'authentication failed for this call (the live fire saw this from wrangler on /memberships): the token lacks a scope this call needs; the D1 query API needs only the D1 scope in the generated table. Check the account and database IDs, and that the token is the deploy token from step 3',
  10000: 'authentication error: the token is missing, expired or revoked (step 3; Scope proof)',
  7404: 'database not found: use `tofu output d1_database_id` from step 4',
  7500: 'the SQL was rejected by D1',
};
export const explain = (codes) => codes.map((c) => `${c}: ${ERRORS[c] ?? 'unrecognised Cloudflare error code'}`).join('; ');

// Split the schema into statements (the schema has no string literals containing ';').
export function statements(sql) {
  return sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const IDEMPOTENT = /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS [A-Za-z_][A-Za-z0-9_]*\b/i;
export function refusals(stmts) {
  return stmts.filter((s) => !IDEMPOTENT.test(s)).map((s) => `not idempotent DDL (only CREATE TABLE|INDEX IF NOT EXISTS is allowed): ${s.slice(0, 80)}`);
}
// A CREATE statement as SQLite stores it in sqlite_master (without IF NOT EXISTS), normalized.
const canonical = (s) => s.replace(/\s+/g, ' ').replace(/ ?\( ?/g, '(').replace(/ ?\) ?/g, ')').replace(/ ?, ?/g, ',').replace(/\bIF NOT EXISTS /i, '').trim();
const nameOf = (s) => s.match(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/i)[1];

export async function applySchema({ api, accountId, databaseId, sql }) {
  const stmts = statements(sql);
  const refused = refusals(stmts);
  if (!stmts.length) refused.push('the schema has no statements');
  if (refused.length) return { exit: EXIT.refused, refused, requests: [] };
  const path = `/accounts/${checkId('account ID', accountId)}/d1/database/${checkId('database ID', databaseId)}/query`;
  const requests = [];
  for (const s of stmts) {
    const r = await api.request('POST', path, { body: { sql: s } });
    requests.push(r.request);
    if (r.dryRun) continue;
    if (r.status !== 200 || r.json?.success !== true) return { exit: EXIT.apiError, requests, message: `statement failed: HTTP ${r.status}; ${explain(errorCodes(r.json)) || 'no error code'}` };
  }
  const v = await api.request('POST', path, { body: { sql: VERIFY_SQL } });
  requests.push(v.request);
  if (v.dryRun) return { exit: EXIT.ok, dryRun: true, requests };
  if (v.status !== 200 || v.json?.success !== true) return { exit: EXIT.apiError, requests, message: `verification read failed: HTTP ${v.status}; ${explain(errorCodes(v.json)) || 'no error code'}` };
  const rows = v.json.result?.[0]?.results ?? [];
  const have = new Map(rows.filter((r) => r.type === 'table' || r.type === 'index').filter((r) => r.sql).map((r) => [r.name, canonical(r.sql)]));
  const mismatches = [];
  for (const s of stmts) {
    const name = nameOf(s);
    if (!have.has(name)) mismatches.push(`${name}: missing`);
    else if (have.get(name) !== canonical(s)) mismatches.push(`${name}: differs from the schema (the database has an older or different definition; a CREATE ... IF NOT EXISTS never changes an existing table)`);
  }
  return { exit: mismatches.length ? EXIT.mismatch : EXIT.ok, requests, verified: [...have.keys()], mismatches };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const known = new Set(['--live', '--account', '--database', '--sql']);
  const bad = argv.filter((a, k) => a.startsWith('--') && !known.has(a));
  if (!opt('--account') || !opt('--database') || bad.length) {
    process.stderr.write('usage: d1-schema.mjs --account <id> --database <d1-id> [--sql <file>] [--live]\n');
    process.exit(EXIT.usage);
  }
  try {
    const sql = readFileSync(opt('--sql') ?? join(REPO, SCHEMA_FILE), 'utf8');
    const r = await applySchema({ api: cfApi({ live: argv.includes('--live') }), accountId: opt('--account'), databaseId: opt('--database'), sql });
    for (const q of r.requests) process.stdout.write(`${q.method} ${q.url}\n  ${JSON.stringify(q.body)}\n`);
    for (const x of r.refused ?? []) process.stdout.write(`REFUSED ${x}\n`);
    if (r.message) process.stdout.write(`FAIL ${r.message}\n`);
    for (const m of r.mismatches ?? []) process.stdout.write(`MISMATCH ${m}\n`);
    if (r.dryRun) process.stdout.write('dry run: nothing sent; re-run with --live to apply\n');
    else if (r.exit === EXIT.ok) process.stdout.write(`OK applied and verified: ${r.verified.join(', ')}\n`);
    process.exit(r.exit);
  } catch (err) {
    process.stderr.write(`d1-schema: ${err.message}\n`);
    process.exit(err instanceof CfApiError && err.code === 'credential-missing' ? EXIT.usage : EXIT.apiError);
  }
}
