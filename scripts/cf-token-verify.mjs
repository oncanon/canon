#!/usr/bin/env node
// V2.1 slice 06: the machine half of the scope proof (runbook "Scope proof"). It asks
// Cloudflare whether the deploy token in $CLOUDFLARE_API_TOKEN is an ACTIVE, account-owned
// token for this account, and when it expires. It prints the token's ID, status and expiry,
// never the token. The token's PERMISSIONS are not readable with the granted scopes, so the
// human half is the dashboard summary of `rp-deploy-<run>`, checked row by row against the
// generated table; together they turn sufficiencyForApply into evidence.
//
//   node scripts/cf-token-verify.mjs --account <id>          dry run: prints the request only
//   node scripts/cf-token-verify.mjs --account <id> --live   verifies, with $CLOUDFLARE_API_TOKEN
//
// Exit: 0 active (or a dry run), 3 not active or expiring beyond the 1-day TTL, 4 API error, 2 usage.
import { pathToFileURL } from 'node:url';
import { cfApi, CfApiError, checkId, errorCodes } from './lib/cf-api.mjs';

export const EXIT = { ok: 0, usage: 2, notActive: 3, apiError: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

export async function verifyToken({ api, accountId, now = Date.now() }) {
  const r = await api.request('GET', `/accounts/${checkId('account ID', accountId)}/tokens/verify`);
  if (r.dryRun) return { exit: EXIT.ok, state: 'dry-run', request: r.request };
  if (r.status !== 200 || r.json?.success !== true) return { exit: EXIT.apiError, state: 'api-error', message: `verify failed: HTTP ${r.status}${errorCodes(r.json).length ? `, codes ${errorCodes(r.json).join(', ')}` : ''}`, request: r.request };
  const { id = null, status = null, expires_on: expiresOn = null } = r.json.result ?? {};
  const expiry = expiresOn ? Date.parse(expiresOn) : NaN;
  const problems = [];
  if (status !== 'active') problems.push(`status is ${status}, not active`);
  if (!Number.isFinite(expiry)) problems.push('no expiry: the deploy token must have a 1-day TTL (runbook step 3)');
  else if (expiry - now > DAY_MS + 60 * 60 * 1000) problems.push(`expires ${expiresOn}, later than the 1-day TTL allows`);
  return { exit: problems.length ? EXIT.notActive : EXIT.ok, state: problems.length ? 'not-acceptable' : 'active', id, status, expiresOn, problems, request: r.request };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const i = argv.indexOf('--account');
  const account = i >= 0 ? argv[i + 1] : null;
  if (!account || argv.some((a, k) => !['--live', '--account'].includes(a) && k !== i + 1)) {
    process.stderr.write('usage: cf-token-verify.mjs --account <id> [--live]\n');
    process.exit(EXIT.usage);
  }
  try {
    const r = await verifyToken({ api: cfApi({ live }), accountId: account });
    process.stdout.write(`${JSON.stringify({ state: r.state, id: r.id ?? null, status: r.status ?? null, expiresOn: r.expiresOn ?? null, problems: r.problems ?? [], message: r.message ?? null, request: `${r.request.method} ${r.request.url}` }, null, 2)}\n`);
    process.exit(r.exit);
  } catch (err) {
    process.stderr.write(`cf-token-verify: ${err.message}\n`);
    process.exit(err instanceof CfApiError && err.code === 'credential-missing' ? EXIT.usage : EXIT.apiError);
  }
}
