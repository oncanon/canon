// V2.1: the runbook carries what the live fire taught, checked against the runbook text.
// Slice 01: R2 enablement is a one-time account step before the first apply, and the
// pre-flight (scripts/cf-preflight.mjs) runs, and must pass, before any `tofu apply`; the
// 403/10042 re-apply rule is written down.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

const RUNBOOK = readFileSync(join(REPO, 'docs/v2/cloudflare/runbook.md'), 'utf8');
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const steps = RUNBOOK.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => ({ n: Number(l.match(/^\| (\d+) \|/)[1]), cells: cells(l) }));

test('[V2.1-01] R2 enablement is a one-time account step before the first apply', () => {
  const r2 = steps.find((s) => /Enable R2 once for the account/.test(s.cells[2]));
  assert.ok(r2, 'a step enables R2');
  assert.match(r2.cells[2], /403, code 10042/);
  const firstApply = Math.min(...steps.filter((s) => s.cells[2].includes('tofu apply')).map((s) => s.n));
  assert.ok(r2.n < firstApply, 'before the first apply');
});

test('[V2.1-01] the pre-flight runs, and must pass, before any tofu apply; the 10042 re-apply rule is written', () => {
  const firstApply = steps.filter((s) => s.cells[2].includes('tofu apply')).sort((a, b) => a.n - b.n)[0];
  const text = firstApply.cells[2];
  const pre = text.indexOf('node scripts/cf-preflight.mjs');
  assert.ok(pre >= 0, 'the first apply step runs the pre-flight');
  assert.ok(pre < text.indexOf('tofu apply'), 'before tofu apply');
  assert.match(text, /must print `OK r2-enabled`/);
  assert.match(text, /reports R2 not enabled \(exit 3\), go back to step 2/);
  assert.match(text, /If the apply still fails with 403, code 10042/);
  assert.match(text, /re-run `tofu apply -var-file=test\.tfvars`; it creates only what is missing/);
});

// V2.1 slice 06: the scope proof procedure turns sufficiencyForApply into evidence and
// settles the unverified scope with a real apply.
test('[V2.1-06] the runbook has the scope proof: token verify, dashboard summary, sufficiency, and the unverified-scope rule', () => {
  const sec = RUNBOOK.slice(RUNBOOK.indexOf('## Scope proof'), RUNBOOK.indexOf('## Teardown'));
  assert.ok(sec.startsWith('## Scope proof'), 'a Scope proof section before teardown');
  assert.match(sec, /node scripts\/cf-token-verify\.mjs --account <account_id> --live/);
  assert.match(sec, /dashboard summary of `rp-deploy-<run>`, checked row by row against the generated table/);
  const firstApply = steps.filter((s) => s.cells[2].includes('tofu apply')).sort((a, b) => a.n - b.n)[0];
  assert.match(sec, new RegExp(`step ${firstApply.n}'s successful \`tofu apply\`, run with exactly those scopes, is the evidence`), 'sufficiency cites the first apply step');
  assert.match(sec, /`sufficiencyForApply` changes from NOT_EXECUTED to verified/);
  assert.match(sec, /remove the one scope the generated table marks \*unverified\*/);
  assert.match(sec, /If both succeed,\*\* that scope is not needed for apply: the canonical list drops it/);
  assert.match(sec, /If either fails with an authorization error,\*\* record the error, add the scope back/);
  const s3 = steps.find((s) => s.n === 3);
  const s10 = steps.find((s) => s.cells[2].includes('First run the unverified-scope test'));
  assert.match(s3.cells[4], /token-verify output \(\*Scope proof\* below\)/, 'step 3 captures the verify output');
  assert.ok(s10 && s10.cells[2].indexOf('unverified-scope test') < s10.cells[2].indexOf('tofu apply'), 'step 10 runs the unverified-scope test before its apply');
});

// V2.1 slice 02: the D1 schema goes through scripts/d1-schema.mjs (dry run, then live), and
// wrangler is off the required path.
test('[V2.1-02] the schema step runs the D1 query script (dry run, then live) and no step runs wrangler', () => {
  const s6 = steps.find((s) => s.cells[2].includes('node scripts/d1-schema.mjs'));
  assert.ok(s6, 'a step applies the schema with the script');
  const dry = s6.cells[2].indexOf('node scripts/d1-schema.mjs');
  const live = s6.cells[2].indexOf('--live');
  assert.ok(dry >= 0 && live > dry, 'the dry run comes first, then --live');
  assert.match(s6.cells[3], /OK applied and verified: alias, alias_history/);
  for (const s of steps) assert.ok(!/wrangler d1|npx wrangler/.test(s.cells[2]), `step ${s.n} does not run wrangler`);
  assert.match(RUNBOOK, /\| D-b \| \*Retired in V2\.1:\*/);
});

// V2.1 slice 05: live runs capture safely, read receipts back, gate evidence before any packet,
// and prove absence at teardown.
test('[V2.1-05] live HTTP cells use the safe capture tool, receipts are read back, the gate runs before any packet, and teardown proves absence', () => {
  for (const s of steps) assert.ok(!/curl -si/.test(s.cells[2]), `step ${s.n} does not capture with raw curl`);
  for (const cell of ['unauth', 'service-auth']) {
    const s = steps.find((x) => x.cells[2].includes(`--name ${cell} `));
    assert.ok(s, `a step captures the ${cell} cell`);
    assert.match(s.cells[2], /node scripts\/cf-capture\.mjs --out <evidence>\/matrix --name /, `step ${s.n} uses cf-capture`);
  }
  const ev = RUNBOOK.slice(RUNBOOK.indexOf('## Evidence capture'), RUNBOOK.indexOf('## Scope proof'));
  assert.match(ev, /`scripts\/cf-capture\.mjs` for every HTTP matrix cell/);
  assert.match(ev, /`scripts\/cf-receipts\.mjs` during the run/);
  assert.match(ev, /`scripts\/secret-gate\.mjs` before any packet is built/);
  assert.match(ev, /node scripts\/evidence-packet\.mjs --report/);
  const td = RUNBOOK.slice(RUNBOOK.indexOf('## Teardown'), RUNBOOK.indexOf('## Safety notes')).split('\n').find((l) => l.includes('tofu destroy'));
  const destroy = td.indexOf('tofu destroy'), abs = td.indexOf('node scripts/cf-absence.mjs'), revoke = td.indexOf('revoke that token immediately');
  assert.ok(destroy < abs && abs < revoke, 'absence is proved after destroy, with the token, before it is revoked');
  assert.match(td, /--live --out <evidence>\/absence\.json/);
  assert.match(td, /Do not create R2 S3 API credentials/);
});

// V2.1 slice 03: Access is code; the runbook creates only the service token by hand, and the
// threat model records the IdP trust that mode (b) adds.
test('[V2.1-03] Access is applied as code, the service token alone is manual, and the threat model records IdP trust', () => {
  const tokenStep = steps.find((s) => /Create Service Token/.test(s.cells[1]));
  const firstApply = steps.filter((s) => s.cells[2].includes('tofu apply')).sort((a, b) => a.n - b.n)[0];
  assert.ok(tokenStep && tokenStep.n < firstApply.n, 'the service token exists before the first apply needs its ID');
  assert.match(tokenStep.cells[2], /never in IaC, so its client secret never enters Terraform state or any file/);
  assert.match(firstApply.cells[2], /the Access application and its two policies/);
  for (const s of steps) assert.ok(!/Enable Cloudflare Access|Manage Cloudflare Access/.test(s.cells[1] + s.cells[2]), `step ${s.n} does not configure Access by hand`);
  const tm = readFileSync(join(REPO, 'docs/v2/threat-model.md'), 'utf8');
  assert.match(tm, /\*\*\(b\) idp-domain:\*\* anyone the named identity provider authenticates/);
  assert.match(tm, /\*\*This adds the IdP's trust:\*\*/);
});

