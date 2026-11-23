#!/usr/bin/env node
// V2.1 slice 05: read receipts back from R2 into the live run's evidence, DURING the run. In the
// live fire the receipts stayed in R2 and were deleted at teardown unread, so the "receipts
// complete and redacted" cell can never be settled; this closes that gap.
//
// Each receipt is read through the Worker's admin API (GET /_admin/receipts/<id>.json) with the
// publish credential, exactly as the publisher talks to that Worker. It is written to
// <out>/receipts/<id>.json only if it parses, is a valid receipt/v2 whose receiptId matches, holds
// no live credential, and passes the secret gate.
//
// Which credential is selected by the target's access mode (V2.1-QA-1):
// - access-private: the Access service token (--endpoint, or a --targets entry);
// - public (V2.1 slice 04): the publisher signing key. Every receipt GET is a signed admin request
//   (adminSigner), and no Access header is ever sent, because the public Worker refuses them.
//
//   node scripts/cf-receipts.mjs --targets <targets.json> --target <name> --out <dir>
//     (--id <receipt-id>)... | --ids-from <file>                               [--live]
//   node scripts/cf-receipts.mjs --endpoint https://<worker>.<sub>.workers.dev --out <dir>
//     (--id <receipt-id>)... | --ids-from <file>      [--credential-env RP_CF_TEST] [--live]
// Receipt IDs are taken verbatim from --id, or every receipt ID found in --ids-from (the
// publisher's own stdout or ledger). DRY RUN BY DEFAULT (N-V21-5): without --live it prints the
// requests it would send (authentication by header name only) and contacts nothing. With --live
// it contacts the Worker: an external action needing the maintainer's confirmation.
// Exit: 0 all read and valid (or a dry run), 1 any problem, 2 usage.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from '../src/publication/schemas.mjs';
import { adminSigner } from '../src/publication/signing.mjs';
import { findTarget, loadTargets } from '../src/publication/targets.mjs';
import { secretProblems } from '../src/publication/receipts.mjs';
import { CloudflareHttpTransport } from '../src/publication/transports/cloudflare-http.mjs';
import { scanText } from './secret-gate.mjs';

export const RECEIPT_ID = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z]+(?:-[a-z]+)*-[0-9a-f]{8}(?:-(?:intent|result))?\b/g;
export const idsIn = (text) => [...new Set(text.match(RECEIPT_ID) ?? [])];

// `signer` (a public target) signs each request and replaces the Access headers; `credentials` is
// then { privateKey }. Without a signer, `credentials` is the Access service token.
export async function fetchReceipts({ transport, credentials, signer = null, ids, outDir }) {
  const results = [];
  const auth = signer ? (req) => signer(req) : () => ({ 'cf-access-client-id': credentials.clientId, 'cf-access-client-secret': credentials.clientSecret });
  const liveSecrets = signer ? [credentials.privateKey] : [credentials.clientId, credentials.clientSecret];
  for (const id of ids) {
    const path = `/_admin/receipts/${encodeURIComponent(id)}.json`;
    const res = await transport.request({ method: 'GET', path, headers: auth({ method: 'GET', path, body: null }) });
    const problems = [];
    let receipt = null;
    if (res.status !== 200) problems.push(`HTTP ${res.status}`);
    else {
      try {
        receipt = JSON.parse(res.body.toString('utf8'));
      } catch {
        problems.push('not JSON');
      }
    }
    if (receipt) {
      problems.push(...validate('receipt/v2', receipt).map((e) => `schema: ${e}`));
      if (receipt.receiptId !== id) problems.push('receiptId does not match the requested ID');
      problems.push(...secretProblems(receipt, liveSecrets).map((p) => `secret: ${p}`));
      problems.push(...scanText(res.body.toString('utf8')).map((f) => `secret gate: ${f.family} at line ${f.line}`));
    }
    if (!problems.length) {
      mkdirSync(join(outDir, 'receipts'), { recursive: true });
      writeFileSync(join(outDir, 'receipts', `${id}.json`), res.body);
    }
    results.push({ id, ok: problems.length === 0, status: res.status, problems });
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

// How to read receipts for a target: its endpoint, mode, and the credential variable. Refuses any
// access mode it has no read-back path for.
export async function readbackPlan({ targetsFile = null, targetName = null, endpoint = null, credentialEnv = null }) {
  if (targetsFile) {
    const target = findTarget(await loadTargets(targetsFile), targetName);
    if (target.kind !== 'cloudflare') throw new Error(`target ${target.name} is ${target.kind}: receipts are read back from a real Cloudflare target only`);
    if (target.accessMode === 'public') return { endpoint: target.endpoint, mode: 'public', credentialEnv: target.credentialEnv, targetId: target.targetId };
    if (target.accessMode === 'access-private') return { endpoint: target.endpoint, mode: 'access-private', credentialEnv: target.credentialEnv };
    throw new Error(`target ${target.name}: no receipt read-back for access mode ${target.accessMode}`);
  }
  return { endpoint, mode: 'access-private', credentialEnv: credentialEnv ?? 'RP_CF_TEST' };
}

// The requests a dry run shows: method, URL and the authentication header NAMES, never a value.
export function dryRunRequests(plan, ids) {
  const auth = plan.mode === 'public' ? ['x-canon-timestamp', 'x-canon-signature'] : ['cf-access-client-id', 'cf-access-client-secret'];
  return ids.map((id) => ({ method: 'GET', url: `${new URL(plan.endpoint).origin}/_admin/receipts/${encodeURIComponent(id)}.json`, auth }));
}

export function credentialsFor(plan, env) {
  let credentials;
  try { credentials = JSON.parse(env[plan.credentialEnv] ?? ''); } catch { credentials = null; }
  if (plan.mode === 'public') {
    if (!credentials?.privateKey || Object.keys(credentials).some((k) => k !== 'privateKey')) throw new Error(`$${plan.credentialEnv} must be JSON with privateKey only (a public target)`);
    return { credentials, signer: adminSigner({ targetId: plan.targetId, privateKey: credentials.privateKey }) };
  }
  if (!credentials?.clientId || !credentials?.clientSecret) throw new Error(`$${plan.credentialEnv} must be JSON with clientId and clientSecret`);
  return { credentials, signer: null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const ids = [...argv.flatMap((a, i) => (a === '--id' ? [argv[i + 1]] : [])), ...(opt('--ids-from') ? idsIn(readFileSync(opt('--ids-from'), 'utf8')) : [])];
  const byTarget = Boolean(opt('--targets'));
  if (!opt('--out') || !ids.length || (byTarget ? !opt('--target') || opt('--endpoint') : !opt('--endpoint'))) {
    process.stderr.write('usage: cf-receipts.mjs (--targets <file> --target <name> | --endpoint https://<worker>.<sub>.workers.dev [--credential-env VAR]) --out <dir> (--id <id>)... | --ids-from <file> [--live]\n');
    process.exit(2);
  }
  let plan;
  try {
    plan = await readbackPlan({ targetsFile: opt('--targets'), targetName: opt('--target'), endpoint: opt('--endpoint'), credentialEnv: opt('--credential-env') });
  } catch (err) {
    process.stderr.write(`cf-receipts: ${err.message}\n`);
    process.exit(2);
  }
  if (!argv.includes('--live')) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, mode: plan.mode, requests: dryRunRequests(plan, ids) }, null, 2)}\n`);
    process.exit(0);
  }
  let auth;
  try {
    auth = credentialsFor(plan, process.env);
  } catch (err) {
    process.stderr.write(`cf-receipts: ${err.message}\n`);
    process.exit(2);
  }
  const r = await fetchReceipts({ transport: new CloudflareHttpTransport({ endpoint: plan.endpoint }), credentials: auth.credentials, signer: auth.signer, ids, outDir: opt('--out') });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.ok ? 0 : 1);
}
