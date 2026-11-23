#!/usr/bin/env node
// V2.1 slice 05: teardown with absence proof. The live fire's teardown listings were empty, but
// their request URLs were not captured, so QA could not tell an account-wide listing from a
// name-filtered one. This script lists the WHOLE account (no name filter), follows every page,
// records every request URL, and proves the run's resources are absent; it also checks the
// Worker's workers.dev endpoint answers 404.
//
//   node scripts/cf-absence.mjs --account <id> --worker <name> --bucket <name> --database <name>
//     [--endpoint https://<worker>.<sub>.workers.dev] [--live] [--out <evidence.json>]
// Dry run by default (prints the first request of each listing). Exit: 0 absent, 3 something
// still present or the listing is not provably full, 4 API error, 2 usage.
// `checkEvidence` re-judges a saved evidence file (QA): a listing whose URL carries a filter,
// or whose pagination was not followed to the end, or with no URL at all, proves nothing.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cfApi, CfApiError, checkId, errorCodes } from './lib/cf-api.mjs';

export const EXIT = { absent: 0, usage: 2, present: 3, apiError: 4 };
const FILTER_PARAMS = ['name', 'name_contains', 'name_prefix', 'prefix', 'search', 'q', 'filter', 'id'];

// List one kind across every page. Returns { kind, requests: [url], names: [..], complete }.
async function listAll(api, kind, path, namesOf, next) {
  const requests = [];
  const names = [];
  let query = next(null, null);
  for (let page = 0; page < 1000 && query; page += 1) {
    const r = await api.request('GET', path, { query });
    requests.push(r.request.url);
    if (r.dryRun) return { kind, requests, names, complete: false, dryRun: true };
    if (r.status !== 200 || r.json?.success !== true) throw new CfApiError(`${kind} listing failed: HTTP ${r.status}${errorCodes(r.json).length ? `, codes ${errorCodes(r.json).join(', ')}` : ''}`);
    names.push(...namesOf(r.json));
    query = next(r.json, query);
  }
  return { kind, requests, names, complete: query === null };
}

export async function absence({ api, accountId, worker, bucket, database, endpoint = null, endpointFetch = globalThis.fetch }) {
  const a = checkId('account ID', accountId);
  const listings = [
    await listAll(api, 'workers-scripts', `/accounts/${a}/workers/scripts`, (j) => (j.result ?? []).map((s) => s.id), (j) => (j === null ? {} : null)),
    await listAll(api, 'r2-buckets', `/accounts/${a}/r2/buckets`, (j) => (j.result?.buckets ?? []).map((b) => b.name), (j, q) => {
      if (j === null) return { per_page: 1000 };
      const cursor = j.result_info?.cursor;
      return cursor ? { per_page: 1000, cursor } : null;
    }),
    await listAll(api, 'd1-databases', `/accounts/${a}/d1/database`, (j) => (j.result ?? []).map((d) => d.name), (j, q) => {
      if (j === null) return { page: 1, per_page: 100 };
      const info = j.result_info ?? {};
      const seen = (q.page) * q.per_page;
      return Number.isFinite(info.total_count) && seen < info.total_count && (j.result ?? []).length ? { page: q.page + 1, per_page: 100 } : null;
    }),
  ];
  if (listings.some((l) => l.dryRun)) return { exit: EXIT.absent, dryRun: true, listings };
  const wanted = { 'workers-scripts': worker, 'r2-buckets': bucket, 'd1-databases': database };
  const present = listings.filter((l) => l.names.includes(wanted[l.kind])).map((l) => `${l.kind}: ${wanted[l.kind]} is still present`);
  let endpointCheck = null;
  if (endpoint) {
    const res = await endpointFetch(endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    endpointCheck = { url: endpoint, status: res.status };
    await res.body?.cancel();
    if (res.status !== 404) present.push(`endpoint ${endpoint} answered ${res.status}, not 404`);
  }
  const evidence = { schema: 'cf-absence/v1', accountId: a, targets: wanted, listings, endpoint: endpointCheck };
  const problems = [...present, ...checkEvidence(evidence)];
  return { exit: problems.length ? EXIT.present : EXIT.absent, problems, evidence };
}

// Re-judge saved absence evidence. Returns the reasons it does NOT prove absence ([] if it does).
export function checkEvidence(evidence) {
  const problems = [];
  for (const kind of ['workers-scripts', 'r2-buckets', 'd1-databases']) {
    const l = (evidence.listings ?? []).find((x) => x.kind === kind);
    if (!l) { problems.push(`${kind}: no listing`); continue; }
    if (!Array.isArray(l.requests) || !l.requests.length) { problems.push(`${kind}: the request URL was not captured, so the listing's scope is unknown`); continue; }
    for (const url of l.requests) {
      const u = new URL(url);
      const filtered = FILTER_PARAMS.filter((p) => u.searchParams.has(p));
      if (filtered.length) problems.push(`${kind}: ${u.pathname} is filtered (${filtered.join(', ')}), not account-wide`);
      if (!/^\/client\/v4\/accounts\/[A-Za-z0-9-]+\/(workers\/scripts|r2\/buckets|d1\/database)$/.test(u.pathname)) problems.push(`${kind}: ${u.pathname} is not the account-wide listing endpoint`);
    }
    if (l.complete !== true) problems.push(`${kind}: pagination was not followed to the end`);
    if (evidence.targets && l.names?.includes(evidence.targets[kind])) problems.push(`${kind}: ${evidence.targets[kind]} is present`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (!opt('--account') || !opt('--worker') || !opt('--bucket') || !opt('--database')) {
    process.stderr.write('usage: cf-absence.mjs --account <id> --worker <name> --bucket <name> --database <name> [--endpoint <url>] [--live] [--out <file>]\n');
    process.exit(EXIT.usage);
  }
  try {
    const r = await absence({ api: cfApi({ live: argv.includes('--live') }), accountId: opt('--account'), worker: opt('--worker'), bucket: opt('--bucket'), database: opt('--database'), endpoint: argv.includes('--live') ? opt('--endpoint') : null });
    if (opt('--out') && !r.dryRun) writeFileSync(opt('--out'), `${JSON.stringify(r.evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(r.dryRun ? { dryRun: true, firstRequests: r.listings.map((l) => l.requests[0]) } : { verdict: r.exit === 0 ? 'absent' : 'NOT PROVEN ABSENT', problems: r.problems }, null, 2)}\n`);
    process.exit(r.exit);
  } catch (err) {
    process.stderr.write(`cf-absence: ${err.message}\n`);
    process.exit(err instanceof CfApiError && err.code === 'credential-missing' ? EXIT.usage : EXIT.apiError);
  }
}
