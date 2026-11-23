#!/usr/bin/env node
// V2.1 slice 01: the pre-flight before the first `tofu apply` (runbook step 6; runbook-public step P4). The live fire
// found that R2 must be enabled once per account in the dashboard: the first apply created
// D1, then failed on the bucket with HTTP 403, code 10042 ("Please enable R2 through the
// Cloudflare Dashboard"). This check reads the account's R2 bucket list (read-only; the
// deploy token's R2 scope covers it) and reports R2-not-enabled BEFORE any apply.
//
//   node scripts/cf-preflight.mjs --account <id>           dry run: prints the request only
//   node scripts/cf-preflight.mjs --account <id> --live    reads, with $CLOUDFLARE_API_TOKEN
//
// Exit: 0 ready (or a dry run), 3 R2 not enabled, 4 any other API or auth failure, 2 usage.
// Running it live contacts Cloudflare: an external action needing the maintainer's confirmation.
import { pathToFileURL } from 'node:url';
import { cfApi, CfApiError, checkId, errorCodes } from './lib/cf-api.mjs';

export const R2_NOT_ENABLED = 10042;
export const EXIT = { ready: 0, usage: 2, r2NotEnabled: 3, apiError: 4 };

// One check: is R2 enabled? Returns { ok, state, message, request }.
export async function checkR2(api, accountId) {
  const r = await api.request('GET', `/accounts/${checkId('account ID', accountId)}/r2/buckets`);
  if (r.dryRun) return { ok: true, state: 'dry-run', message: 'dry run: nothing sent', request: r.request };
  const codes = errorCodes(r.json);
  if (r.status === 200 && r.json?.success === true) return { ok: true, state: 'r2-enabled', message: 'R2 is enabled on this account', request: r.request };
  if (r.status === 403 && codes.includes(R2_NOT_ENABLED)) {
    return {
      ok: false,
      state: 'r2-not-enabled',
      message: 'R2 is NOT enabled on this account (HTTP 403, code 10042). Enable it once in the dashboard (runbook step 2: R2 Object Storage, then accept the R2 plan), wait a few minutes for it to propagate, and re-run this pre-flight. Do not run tofu apply until it passes: an apply now creates D1 and then fails on the bucket.',
      request: r.request,
    };
  }
  return { ok: false, state: 'api-error', message: `R2 check failed: HTTP ${r.status}${codes.length ? `, codes ${codes.join(', ')}` : ''}. Check the token (runbook step 3) and the account ID.`, request: r.request };
}

export async function preflight({ api, accountId }) {
  const r2 = await checkR2(api, accountId);
  const exit = r2.state === 'r2-not-enabled' ? EXIT.r2NotEnabled : r2.ok ? EXIT.ready : EXIT.apiError;
  return { exit, checks: [{ name: 'r2-enabled', ...r2 }] };
}

function parseArgs(argv) {
  const out = { live: false, account: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--live') out.live = true;
    else if (argv[i] === '--account') out.account = argv[++i];
    else throw new CfApiError(`unknown argument ${argv[i]}`);
  }
  if (!out.account) throw new CfApiError('--account <id> is required');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`cf-preflight: ${err.message}\n`);
    process.exit(EXIT.usage);
  }
  try {
    const result = await preflight({ api: cfApi({ live: args.live }), accountId: args.account });
    for (const c of result.checks) process.stdout.write(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.message}\n     ${c.request.method} ${c.request.url}\n`);
    process.exit(result.exit);
  } catch (err) {
    process.stderr.write(`cf-preflight: ${err.message}\n`);
    process.exit(err.code === 'credential-missing' ? EXIT.usage : EXIT.apiError);
  }
}
