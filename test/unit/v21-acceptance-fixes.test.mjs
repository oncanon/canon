// V2.1 acceptance review of 6db872f: the runbooks must be
// runnable as written. Each check is derived from the files, never from a typed list of lines:
// - a LEXICAL token-order guard: no "revoke" is followed by a use of the deploy token without a new
//   token in between (the public teardown revoked it before `cf-absence --live`); it catches only
//   the phrasings in TOKEN_GUARD, and QA's misses are pinned below as known limits;
// - mode (b), idp-domain, is runnable: the one-time IdP step, reviewer ALLOW and DENY captures
//   per mode, and how both modes are exercised;
// - the public target has its prerequisites, the pre-flight and the lockfile check, and names its
//   one credential on disk exactly;
// - the run residue of every Cloudflare module is git-ignored (proved with `git check-ignore`);
// - a LEXICAL step-reference guard: the reference forms in STEP_GUARD, outside the runbooks, name a
//   step with their topic; other forms are known limits.
// coverage.md (*Runbook guards: what they catch*) quotes both guards' patterns, and a test fails if
// the quotes and the patterns drift apart (QA ff4710a §3, claim-narrowing).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO, tempDir } from '../helpers.mjs';

const read = (f) => readFileSync(join(REPO, f), 'utf8');
const PRIVATE = 'docs/v2/cloudflare/runbook.md';
const PUBLIC = 'docs/v2/cloudflare/runbook-public.md';
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const section = (text, heading) => { const i = text.indexOf(`\n## ${heading}`); assert.ok(i >= 0, `section ${heading}`); const j = text.indexOf('\n## ', i + 1); return text.slice(i, j < 0 ? undefined : j); };
function steps(text) {
  return section(text, 'Steps').split('\n').filter((l) => /^\| P?\d+ \|/.test(l)).map((l) => { const c = cells(l); return { n: c[0], where: c[1], text: c.slice(1).join(' | '), row: l }; });
}
const teardown = (text) => section(text, 'Teardown').split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => ({ n: `teardown ${l.match(/^(\d+)/)[1]}`, text: l }));

// ---- 1. token order ---------------------------------------------------------------------------
// The scripts that read the deploy token are the ones built on scripts/lib/cf-api.mjs, and it
// reads CLOUDFLARE_API_TOKEN: derived, so a new API script is covered without editing this test.
// A Terraform action is an invocation with its var file; a mention such as "`tofu destroy` has
// already removed …" is not one.
const API_SCRIPTS = readdirSync(join(REPO, 'scripts')).filter((f) => f.endsWith('.mjs') && /from '\.\/lib\/cf-api\.mjs'/.test(read(`scripts/${f}`)));
const SCRIPT_USE = '[^`]*--live';
const TF_USE = 'tofu (?:plan|apply|destroy) -var-file';
const SCRIPT_ALT = `(?:${API_SCRIPTS.map((f) => f.replace('.', '\\.')).join('|')})`;
const NEEDS = new RegExp(`node scripts/${SCRIPT_ALT}${SCRIPT_USE}|${TF_USE}`, 'g');
const REVOKE = /\brevoke\b/gi;
const CREATE = /Create Token|create a new 1-day/gi;
// What the guard catches, exactly: each regex as /source/flags, the whole use pattern included (with
// the derived script names shown as <cf-api script>). coverage.md quotes these and names the scripts;
// the test in section 6 checks both (QA V2.1-QA-3: flags and the script-use half were unchecked).
const show = (re) => `/${re.source}/${re.flags}`;
export const TOKEN_GUARD = { use: show(NEEDS).replace(SCRIPT_ALT, '(?:<cf-api script>)'), revoke: show(REVOKE), create: show(CREATE) };
export const TOKEN_GUARD_SCRIPTS = API_SCRIPTS.map((f) => f.replace(/\.mjs$/, ''));
const events = (item) => [...[...item.text.matchAll(NEEDS)].map((m) => ({ at: m.index, kind: 'needs', what: m[0].slice(0, 60) })),
  ...[...item.text.matchAll(REVOKE)].map((m) => ({ at: m.index, kind: 'revoke' })), ...[...item.text.matchAll(CREATE)].map((m) => ({ at: m.index, kind: 'create' }))].sort((a, b) => a.at - b.at);

export function tokenOrderProblems(text) {
  const problems = [];
  let live = false;
  let revokedAt = null;
  for (const item of [...steps(text), ...teardown(text)]) {
    for (const e of events(item)) {
      if (e.kind === 'create') live = true;
      else if (e.kind === 'revoke') { live = false; revokedAt = item.n; } else if (!live) problems.push(`${item.n}: ${e.what} needs the deploy token${revokedAt ? `, which ${revokedAt} revoked` : ', and none has been created'}`);
    }
  }
  return problems;
}

test('[V2.1-05] lexical token-order guard: in either runbook, no "revoke" is followed by a cf-api script run with --live or by tofu plan, apply or destroy with -var-file unless a token is created in between', () => {
  assert.match(read('scripts/lib/cf-api.mjs'), /CLOUDFLARE_API_TOKEN/, 'cf-api.mjs reads the deploy token');
  assert.deepEqual([...API_SCRIPTS].sort(), ['cf-absence.mjs', 'cf-preflight.mjs', 'cf-token-verify.mjs', 'd1-schema.mjs'], 'the API scripts are derived from their import');
  for (const f of [PRIVATE, PUBLIC]) {
    const text = read(f);
    const needs = [...steps(text), ...teardown(text)].flatMap(events).filter((e) => e.kind === 'needs');
    assert.ok(needs.length >= 4, `${f}: the check sees the token-using steps`);
    assert.deepEqual(tokenOrderProblems(text), [], f);
  }
  // The public teardown proves absence with the teardown token, then revokes it.
  const td = teardown(read(PUBLIC));
  const abs = td.findIndex((t) => t.text.includes('node scripts/cf-absence.mjs'));
  const rev = td.findIndex((t) => /\brevoke\b/i.test(t.text));
  assert.ok(abs >= 0 && rev > abs, 'cf-absence runs before the token is revoked');
});

// ---- 2. mode (b) --------------------------------------------------------------------------------
test('[V2.1-03] mode (b) is runnable: the one-time IdP step, reviewer ALLOW and DENY captures per mode, and the mode switch', () => {
  const text = read(PRIVATE);
  const all = steps(text);
  const num = (s) => Number(s.n);
  const idp = all.find((s) => /identity provider settings/.test(s.where));
  const apply = all.find((s) => s.text.includes('tofu apply'));
  const service = all.find((s) => s.text.includes('--name service-auth'));
  const reviewer = all.find((s) => /reviewer-allow-root/.test(s.text));
  const sw = all.find((s) => /switch `access_mode`/.test(s.text));
  assert.ok(idp && apply && service && reviewer && sw, 'the IdP, first apply, service-auth, reviewer and switch steps exist');
  assert.match(idp.where, /mode \(b\), idp-domain, only/);
  assert.match(idp.text, /\[S16\] in `docs\/v2\/research\/cloudflare-adapter\.md`/);
  assert.match(idp.text, /it is the value of `identity_provider_id` in step (\d+)/);
  assert.equal(Number(idp.text.match(/`identity_provider_id` in step (\d+)/)[1]), num(apply), 'the IdP step feeds the first apply');
  assert.match(apply.text, new RegExp(`step ${idp.n}'s \`identity_provider_id\``), 'the apply step takes the ID from the IdP step');
  assert.match(idp.text, /If you cannot find the ID, stop: do not guess it/);
  assert.match(idp.text, /Never its client secret/);
  assert.ok(num(idp) < num(apply) && num(apply) < num(service) && num(service) < num(reviewer) && num(reviewer) < num(sw), 'IdP, apply, service auth, reviewer cells, switch: in that order');
  for (const cell of ['allow-root', 'allow-admin', 'deny']) assert.match(reviewer.text, new RegExp(`\`<mode>-reviewer-${cell}\``), `capture ${cell}`);
  assert.match(reviewer.text, /\*\*\(1\) ALLOW:\*\*[^]*exact-person: an address in `reviewer_emails`; idp-domain: an account at the identity provider whose address is in `reviewer_email_domain`/);
  assert.match(reviewer.text, /\*\*\(2\) DENY:\*\*[^]*exact-person: an address not in `reviewer_emails`; idp-domain: an address outside `reviewer_email_domain`/);
  assert.match(reviewer.text, /Never export a HAR file, cookies or tokens/);
  assert.match(reviewer.text, /`<mode>` is `exact-person` or `idp-domain`/);
  assert.match(sw.text, new RegExp(`repeat step ${reviewer.n} for the new mode`), 'the switch repeats the reviewer cells');
  assert.match(sw.text, /otherwise the second mode is a separate run of this runbook/);
  assert.match(sw.text, /if the plan destroys or replaces any resource, stop/);
  // What the switch may change is derived from access.tf: exactly the resources that read access_mode.
  const tf = read('infra/cloudflare/terraform/access.tf');
  const byMode = [...tf.matchAll(/resource "([^"]+)" "([^"]+)" \{([^]*?)\n\}/g)].filter((m) => m[3].includes('var.access_mode')).map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual(byMode, ['cloudflare_zero_trust_access_application.reviewers', 'cloudflare_zero_trust_access_policy.reviewers'], 'only the application and the reviewers policy depend on the mode');
  assert.match(sw.text, /only the Access application \(`allowed_idps`, `auto_redirect_to_identity`\) and the reviewers policy \(`include`\) depend on the mode/);
  assert.match(read('docs/v2/cloudflare/coverage.md'), new RegExp(`for idp-domain mode only, the identity provider \\(configured once in the dashboard: runbook step ${idp.n},`));
});

// ---- 3. the public target ----------------------------------------------------------------------
test('[V2.1-04] the public target: prerequisites, pre-flight before the apply, the lockfile check, and its one credential on disk', () => {
  const text = read(PUBLIC);
  const all = steps(text);
  const p0 = all.find((s) => s.n === 'P0');
  const p4 = all.find((s) => s.text.includes('tofu apply'));
  assert.ok(p0 && p4 && all.indexOf(p0) < all.indexOf(p4), 'P0 comes before the apply');
  assert.match(p0.where, /The private runbook \(`runbook\.md`\), steps 1 and 2/);
  assert.match(p0.text, /enable R2 once for the account/);
  const privSteps = steps(read(PRIVATE));
  assert.match(privSteps.find((s) => s.n === '1').text, /Copy the \*\*Account ID\*\*/, 'private step 1 is the Account ID');
  assert.match(privSteps.find((s) => s.n === '2').text, /Enable R2 once for the account/, 'private step 2 enables R2');
  const t = p4.text;
  const pre = t.indexOf('node scripts/cf-preflight.mjs --account <account_id> --live');
  const init = t.indexOf('tofu init');
  const lock = t.indexOf('git diff --exit-code .terraform.lock.hcl');
  const apply = t.indexOf('tofu apply');
  assert.ok(pre >= 0 && pre < init && init < lock && lock < apply, 'pre-flight, init, lockfile check, apply: in that order');
  assert.match(t, /must print `OK r2-enabled`; if it reports R2 not enabled \(exit 3\), go back to step P0/);
  assert.match(read('infra/cloudflare/terraform-public/.terraform.lock.hcl'), /^provider "[^"]+\/cloudflare\/cloudflare" \{$/m, 'the public lockfile the check protects exists and pins the Cloudflare provider');
  assert.match(text, /\*\*Credentials on disk:\*\* exactly one\. Step P1 writes the publisher signing key to a new file with mode 0600, outside the repository; the teardown deletes it\./);
  assert.match(all.find((s) => s.n === 'P1').text, /writes the credential to a new file with mode 0600/, 'P1 is the credential the wording names');
  const claims = (dir) => readdirSync(join(REPO, dir)).flatMap((e) => (statSync(join(REPO, dir, e)).isDirectory() ? claims(`${dir}/${e}`) : e.endsWith('.md') ? [`${dir}/${e}`] : []));
  for (const f of claims('docs/v2')) assert.ok(!/credentials? never reach(es)? disk/i.test(read(f)), `${f} does not claim credentials never reach disk`);
});

// ---- 4. run residue ----------------------------------------------------------------------------
// Proved with git itself: the repository's .gitignore in a scratch repository (the red-control
// harness copies are not git repositories), asked with `git check-ignore --no-index`.
test('[V2.1-06] the run residue of every Cloudflare module is git-ignored, and its lockfile and example are not', async (t) => {
  const dir = await tempDir(t, 'canon-gitignore');
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  copyFileSync(join(REPO, '.gitignore'), join(dir, '.gitignore'));
  const ignored = (p) => { const r = spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: dir }); assert.ok(r.status === 0 || r.status === 1, `git check-ignore ${p}: ${r.stderr}`); return r.status === 0; };
  const modules = readdirSync(join(REPO, 'infra/cloudflare')).filter((e) => /^terraform/.test(e) && statSync(join(REPO, 'infra/cloudflare', e)).isDirectory());
  assert.deepEqual(modules.sort(), ['terraform', 'terraform-public']);
  for (const m of modules) {
    const at = (f) => `infra/cloudflare/${m}/${f}`;
    mkdirSync(join(dir, `infra/cloudflare/${m}`), { recursive: true });
    for (const f of ['terraform.tfstate', 'terraform.tfstate.backup', 'test.tfvars', '.terraform/providers/x', 'run.tfplan']) assert.ok(ignored(at(f)), `${at(f)} is ignored`);
    for (const f of ['.terraform.lock.hcl', 'test.tfvars.example', 'main.tf']) assert.ok(!ignored(at(f)), `${at(f)} is not ignored`);
  }
  assert.ok(!ignored('README.md'), 'the check can say "not ignored"');
});

// ---- 5. step references ------------------------------------------------------------------------
// A reference from outside a runbook must share a topic with the step it cites. The topics are
// words on the reference's line (or the line before); the cited step must be the one that does it.
const TOPICS = [
  { name: 'service token', context: /service[ _]token/i, step: /Create Service Token/ },
  { name: 'identity provider', context: /identity[ _]provider|\bIdP\b/, step: /identity provider settings/ },
  { name: 'subdomain or R2', context: /subdomain|\bR2\b|r2-not-enabled|10042/i, step: /Your subdomain|R2/ },
  { name: 'deploy token', context: /deploy token|API token|token creation|\bTTL\b|the token \(/i, notContext: /service[ _]token/i, step: /Create Token\b/ },
  { name: 'schema', context: /d1-schema|sqlite_master|D1 query API/i, step: /node scripts\/d1-schema\.mjs/ },
  { name: 'pre-flight', context: /pre-flight|cf-preflight/i, step: /node scripts\/cf-preflight\.mjs/ },
  { name: 'apply', context: /\bapply\b|Access as code|team domain|TEAM_DOMAIN/i, step: /tofu apply/ },
  { name: 'mode switch', context: /switch|access_mode/, step: /switch `access_mode`/ },
  { name: 'revoke', context: /revoke/i, step: /\*\*Revoke the deploy token/ },
  { name: 'public unsigned admin', context: /unsigned|signed upload|WebCrypto/i, step: /--name unsigned-admin/ },
];
// The file extensions the step guard reads (V2.1-QA-5 G12): coverage.md names exactly these (C8).
export const STEP_EXTENSIONS = ['md', 'mjs', 'tf', 'json', 'example'];
const STEP_EXT_RE = new RegExp(`\\.(${STEP_EXTENSIONS.join('|')})$`);
const REF = [{ file: PRIVATE, re: /\brunbook(?:\.md`)? step (\d+)\b/g }, { file: PUBLIC, re: /runbook-public(?:\.md`)? step (P\d+)\b/g }];
// What the guard catches, exactly (quoted by coverage.md and checked there).
export const STEP_GUARD = { private: show(REF[0].re), public: show(REF[1].re) };
const SKIP = new Set([PRIVATE, PUBLIC, 'scripts/red-controls.mjs', 'test/unit/v21-acceptance-fixes.test.mjs']);
const walk = (d) => readdirSync(join(REPO, d)).flatMap((e) => (e === 'node_modules' ? [] : statSync(join(REPO, d, e)).isDirectory() ? walk(`${d}/${e}`) : [`${d}/${e}`]));

export function stepReferenceProblems(readFile = read) {
  const problems = [];
  let seen = 0;
  const books = REF.map((r) => ({ ...r, steps: steps(readFile(r.file)) }));
  for (const f of ['docs', 'infra', 'scripts', 'src', 'test'].flatMap(walk).filter((x) => STEP_EXT_RE.test(x) && !SKIP.has(x))) {
    const lines = readFile(f).split('\n');
    lines.forEach((line, i) => {
      for (const b of books) {
        for (const m of line.matchAll(b.re)) {
          seen += 1;
          const at = `${f}:${i + 1}: ${m[0]}`;
          const step = b.steps.find((s) => s.n === m[1]);
          if (!step) { problems.push(`${at}: ${b.file} has no such step`); continue; }
          const ctx = `${lines[i - 1] ?? ''}\n${line}`;
          const topics = TOPICS.filter((tp) => tp.context.test(ctx) && !(tp.notContext && tp.notContext.test(ctx)));
          if (!topics.length) problems.push(`${at}: no known topic on the line to check the step against`);
          else if (!topics.some((tp) => tp.step.test(step.row))) problems.push(`${at}: step ${m[1]} does not do ${topics.map((tp) => tp.name).join(' or ')}`);
        }
      }
    });
  }
  return { problems, seen };
}

test('[V2.1-01] lexical step-reference guard: every lower-case "runbook step N", "runbook.md step N" or "runbook-public step PN" outside the runbooks names a step that has its topic', () => {
  const { problems, seen } = stepReferenceProblems();
  assert.ok(seen >= 20, `the check sees the references (${seen})`);
  assert.deepEqual(problems, []);
  // Inside the private runbook: the stop-point range, the provider-download decision and every
  // step number named exist.
  const text = read(PRIVATE);
  const all = steps(text);
  const last = Math.max(...all.map((s) => Number(s.n)));
  assert.match(text, new RegExp(`Steps 1–${last} are yours`), 'the stop point names every step');
  const init = all.find((s) => s.text.includes('tofu init'));
  assert.match(text, new RegExp(`\\| D-a \\| [^\\n]*\\| step ${init.n} \\|`), 'D-a names the step that runs tofu init');
  for (const m of text.matchAll(/\bsteps? (\d+)(?:[–-](\d+))?/g)) for (const n of [m[1], m[2]].filter(Boolean)) assert.ok(Number(n) >= 1 && Number(n) <= last, `step ${n} exists (${m[0]})`);
  const pub = read(PUBLIC);
  const pinit = steps(pub).find((s) => s.text.includes('tofu init'));
  assert.match(pub, new RegExp(`\\| P-a \\| [^\\n]*\\| step ${pinit.n} \\|`), 'P-a names the step that runs tofu init');
});

// ---- 6. the guards' claims ---------------------------------------------------------------------
// QA ff4710a §3: both guards are lexical. coverage.md must quote exactly what each catches, and
// list QA's missed variants as known limits; each miss is run through the guard here, so widening a
// guard (or narrowing it) fails this test until the documented claim is updated with it.
const book = (items) => `# A synthetic runbook\n\n## Steps\n\n| # | Where | Do | Expected | Evidence |\n| --- | --- | --- | --- | --- |\n| 1 | Dashboard | Create Token for this run. | - | - |\n\n## Teardown\n\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n## Safety notes\n`;
const REVOKED = 'Revoke the teardown token.';
const DESTROY = '`tofu destroy -var-file=test.tfvars`';
export const TOKEN_CAUGHT = [['V1', [REVOKED, DESTROY]], ['V9', [REVOKED, '`node scripts/cf-absence.mjs --account a --live`']], ['W5', [REVOKED, '`node scripts/d1-schema.mjs --account a --database d --live`']]];
export const TOKEN_KNOWN_LIMITS = [
  ['V2', 'is revoked', ['The teardown token is revoked.', DESTROY]],
  ['V3', 'delete the teardown token', ['Delete the teardown token.', DESTROY]],
  ['V4', 'roll the token', ['Roll the token.', DESTROY]],
  ['W2', 'terraform destroy -var-file', [REVOKED, '`terraform destroy -var-file=test.tfvars`']],
  ['W3', 'tofu destroy -auto-approve', [REVOKED, '`tofu destroy -auto-approve`']],
  ['W4', 'tofu apply <planfile>', [REVOKED, '`tofu apply run.tfplan`']],
  ['V7', 'npx wrangler … --remote', [REVOKED, '`npx wrangler d1 execute db --remote`']],
  ['V8', 'curl … Bearer $CLOUDFLARE_API_TOKEN', [REVOKED, '`curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts`']],
];
const PLANT = 'infra/cloudflare/terraform/access.tf';
const withLine = (line) => (f) => (f === PLANT ? `${read(PLANT)}\n# service token (${line})\n` : read(f));
export const STEP_CAUGHT = [['X1', 'runbook step 9'], ['X6', 'runbook-public step P7'], ['X8', 'runbook step 36']];
export const STEP_KNOWN_LIMITS = [['X2', 'Runbook step N', 'Runbook step 9'], ['X3', 'step N of the runbook', 'step 9 of the runbook'], ['X4', "the runbook's step N", "the runbook's step 9"], ['X5', 'Runbook-public step PN', 'Runbook-public step P7']];

// V2.1-QA-4 (lead ruling): the self-check is an ENUMERATION. Each entry of CLAIMS is exactly one
// assertion family, with the words coverage.md uses for it; the test body only runs CLAIMS and
// requires coverage.md's two lists to equal CLAIMS and NOT_ENFORCED, rendered here. So the
// documented list and the assertions cannot diverge.
const covSection = () => section(read('docs/v2/cloudflare/coverage.md'), 'Runbook guards: what they catch');
const guardBlock = (start, next) => { const cov = covSection(); const i = cov.indexOf(start); assert.ok(i >= 0, `coverage.md has the ${start} block`); const j = next ? cov.indexOf(next, i) : cov.length; return cov.slice(i, j < 0 ? cov.length : j); };
const LIMITS = '**Known limits (not caught):**';
const splitBlock = (b) => { const k = b.indexOf(LIMITS); assert.ok(k >= 0, 'a known-limits list'); return { catches: b.slice(0, k), limits: b.slice(k) }; };
const tokenBlock = () => guardBlock('**Token order**', '**Step references**');
const stepBlock = () => guardBlock('**Step references**');
const stepAt = (line) => stepReferenceProblems(withLine(line)).problems.filter((p) => p.startsWith(`${PLANT}:`));
const listedAsLimit = (b, id, phrase) => {
  const { catches, limits } = splitBlock(b);
  assert.ok(limits.includes(phrase) && limits.includes(`(${id})`), `${id} (${phrase}) is listed under its guard's known limits`);
  assert.ok(!catches.includes(`(${id})`) && !catches.includes(phrase), `${id} (${phrase}) is not among its guard's catches`);
};
export const CLAIMS = [
  ['C1', "Each regex of `TOKEN_GUARD` and `STEP_GUARD` is quoted as `/source/flags`, byte for byte, among its own guard's catches.", () => {
    for (const [b, guard] of [[tokenBlock(), TOKEN_GUARD], [stepBlock(), STEP_GUARD]]) for (const [k, q] of Object.entries(guard)) assert.ok(splitBlock(b).catches.split('\n').some((l) => l.includes(q)), `coverage.md quotes the ${k} pattern ${q}`);
  }],
  ['C2', 'The line quoting each regex says "in any case" if its flags include `i`, and "case-sensitive" if they do not.', () => {
    for (const [b, guard] of [[tokenBlock(), TOKEN_GUARD], [stepBlock(), STEP_GUARD]]) for (const [k, q] of Object.entries(guard)) {
      const line = splitBlock(b).catches.split('\n').find((l) => l.includes(q));
      const flags = q.slice(q.lastIndexOf('/') + 1);
      const [said, wrong] = flags.includes('i') ? ['in any case', 'case-sensitive'] : ['case-sensitive', 'in any case'];
      assert.ok(line && line.includes(said) && !line.includes(wrong), `the ${k} line says "${said}", not "${wrong}" (flags ${flags})`);
    }
  }],
  ['C3', "The script alternation inside the token guard's use regex is exactly the derived list of scripts that import `scripts/lib/cf-api.mjs` compared exactly as regex source, with every dot escaped (so nothing hides behind `<cf-api script>`, and no dot matches any character), and the token block names each of them.", () => {
    const alt = NEEDS.source.match(/^node scripts\\\/\(\?:([^)]*)\)/);
    assert.ok(alt, 'the use regex starts with the script alternation');
    assert.equal(alt[1], API_SCRIPTS.map((f) => f.replace(/\./g, '\\.')).join('|'), 'the alternation is exactly the derived script list, every dot escaped');
    for (const name of TOKEN_GUARD_SCRIPTS) assert.ok(splitBlock(tokenBlock()).catches.includes(name), `coverage.md names the cf-api script ${name}`);
  }],
  ['C4', "QA's caught token cases (V1, V9, W5) are caught by the token guard.", () => {
    for (const [id, items] of TOKEN_CAUGHT) assert.notDeepEqual(tokenOrderProblems(book(items)), [], `${id} is caught`);
  }],
  ['C5', 'Each token known limit (V2, V3, V4, W2, W3, W4, V7, V8) is not caught, is listed under the token guard\'s known limits, and is not among its catches.', () => {
    for (const [id, phrase, items] of TOKEN_KNOWN_LIMITS) { assert.deepEqual(tokenOrderProblems(book(items)), [], `${id} (${phrase}) is NOT caught`); listedAsLimit(tokenBlock(), id, phrase); }
  }],
  ['C6', 'The caught step-reference cases (X1, X6, X8) are caught by the step guard: a step its runbook lacks (X1, X6), and a step number past the last step of the private runbook (X8).', () => {
    assert.deepEqual(STEP_CAUGHT.map(([id]) => id), ['X1', 'X6', 'X8']);
    for (const [id, line] of STEP_CAUGHT) assert.equal(stepAt(line).length, 1, `${id} is caught`);
  }],
  ['C8', 'The step-references line names exactly the file extensions the step guard reads (`STEP_EXTENSIONS`).', () => {
    const line = covSection().split('\n').find((l) => l.startsWith('**Step references**'));
    const exts = STEP_EXTENSIONS.map((e) => `\`.${e}\``);
    assert.ok(line && line.includes(`files ending ${exts.slice(0, -1).join(', ')} or ${exts.at(-1)}`), `the step-references line names ${exts.join(' ')}`);
    assert.ok(!/every file/.test(line), 'and does not claim every file');
  }],
  ['C7', "Each step-reference known limit (X2, X3, X4, X5) is not caught, is listed under the step guard's known limits, and is not among its catches.", () => {
    for (const [id, phrase, line] of STEP_KNOWN_LIMITS) { assert.deepEqual(stepAt(line), [], `${id} (${phrase}) is NOT caught`); listedAsLimit(stepBlock(), id, phrase); }
  }],
];
export const NOT_ENFORCED = [
  ['N1', "What the token guard walks: which runbooks, and which of their sections (*Steps* rows, *Teardown* items). Changing that set is not detected here."],
  ['N2', "The step guard's walk: which directories it reads, and its skip list (the two runbooks, the control table, this test). Changing either is not detected here. (Its file extensions are enforced: C8.)"],
  ['N3', "The step guard's topic words (`TOPICS`): they are listed in the test and not quoted here."],
  ['N4', 'Any phrasing not listed as caught or as a known limit: it is neither promised caught nor pinned as missed.'],
];
const render = (rows) => rows.map(([id, text]) => `- (${id}) ${text}`).join('\n');

test('[V2.1-01] the runbook guards claim exactly what they catch: coverage.md quotes their patterns, and QA\'s missed variants stay uncaught and listed as known limits', () => {
  const cov = covSection();
  const list = (heading) => { const i = cov.indexOf(heading); assert.ok(i >= 0, `coverage.md has ${heading}`); const body = cov.slice(i + heading.length); return body.slice(0, body.search(/\n\n(?!- )/)).trim(); };
  assert.equal(list('**What the self-check enforces** (one line per assertion, rendered from `CLAIMS` in the test):'), render(CLAIMS), 'coverage.md enumerates exactly the assertions the test runs');
  assert.equal(list('**NOT enforced** (rendered from `NOT_ENFORCED` in the test):'), render(NOT_ENFORCED), 'coverage.md lists exactly what is not enforced');
  for (const [, , run] of CLAIMS) run();
});
