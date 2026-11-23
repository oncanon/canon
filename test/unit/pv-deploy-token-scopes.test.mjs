// The Cloudflare deploy token's scopes are stated once, in infra/cloudflare/deploy-token-scopes.json.
// V2-QA-3: every document's copy (between `deploy-token-scopes:begin` and `:end` markers) must
// agree with it. V2-QA-7: those copies are GENERATED (scripts/scope-tables.mjs) and must be
// byte-identical to the generated output; and no Cloudflare permission-group NAME from
// Cloudflare's own list (infra/cloudflare/permission-vocabulary.json) may appear outside them
// in any repo document, in any case or separator form, nor the shape "<resource>
// Edit|Read|Write|Revoke" (scripts/scope-mentions.mjs). That is a lexical check: free prose
// that describes a scope in other words is NOT detected (V2-QA-8, accepted residual; see
// docs/v2/threat-model.md T8).
//
// Every check below is a function of `read(file)`, so the same checks run on the committed
// tree and, in the permanent regression suite at the end, on every case ever planted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CONTROLS } from '../../scripts/red-controls.mjs';
import { deriveNouns, matcher, scopeViolations, VOCABULARY_FILE } from '../../scripts/scope-mentions.mjs';
import { CANONICAL_FILE, PUBLIC_CANONICAL_FILE, TOKENS, tableProblems } from '../../scripts/scope-tables.mjs';
import { REPO } from '../helpers.mjs';
import { QA_SCOPE_CASES } from '../scope-cases.mjs';

const MD_DOCS = ['docs/v2/cloudflare/coverage.md', 'docs/v2/cloudflare/runbook.md'];
const IAC_DOCS = ['infra/cloudflare/terraform/versions.tf'];
const disk = (f) => readFileSync(join(REPO, f), 'utf8');
// A reader over the committed tree with some files replaced or added in memory.
const world = (override = {}) => (f) => (f in override ? override[f] : disk(f));
const canonicalOf = (read) => JSON.parse(read(CANONICAL_FILE));

function block(text) {
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.includes('deploy-token-scopes:begin'));
  const end = lines.findIndex((l) => l.includes('deploy-token-scopes:end'));
  if (begin < 0 || end <= begin || lines.filter((l) => l.includes('deploy-token-scopes:begin')).length !== 1) return null;
  return { inside: lines.slice(begin + 1, end) };
}
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function rowProblems(read) {
  const c = canonicalOf(read);
  const want = [...c.granted.map((g) => [g.permission, 'yes', g.neededFor, g.source, g.necessity]), ...c.notGranted.map((n) => [n.permission, 'no', n.reason, '—', '—'])];
  const problems = [];
  for (const file of MD_DOCS) {
    const b = block(read(file));
    if (!b) { problems.push(`${file}: no single marked block`); continue; }
    const rows = b.inside.filter((l) => l.trim().startsWith('|')).map(cells);
    if (!same(rows[0], ['Permission', 'Granted', 'Needed for', 'Source', 'Necessity'])) problems.push(`${file}: header`);
    if (!same(rows.slice(2), want)) problems.push(`${file}: the rows differ from ${CANONICAL_FILE}`);
  }
  for (const file of IAC_DOCS) {
    const b = block(read(file));
    const line = b?.inside.find((l) => /#\s+granted:/.test(l));
    if (!line) { problems.push(`${file}: no granted line`); continue; }
    const listed = line.replace(/^#\s+granted:\s*/, '').split(' | ').map((s) => s.trim());
    if (!same(listed, c.granted.map((g) => g.permission + (g.necessity === 'verified' ? '' : ' (unverified)')))) problems.push(`${file}: the granted list differs`);
  }
  return problems;
}

function canonicalProblems(read) {
  const c = canonicalOf(read);
  const problems = [];
  const names = c.granted.map((g) => g.permission);
  // V2.1 (Access as code) adds the Access application-and-policy scope.
  if (!same(names, ['Workers Scripts Edit', 'Workers R2 Storage Edit', 'D1 Edit', 'Account Settings Read', 'Access: Apps and Policies Edit'])) problems.push(`granted scopes are ${names}`);
  for (const g of c.granted) {
    if (!g.neededFor || !g.source) problems.push(`${g.permission}: needed-for and source`);
    if (!(g.necessity === 'verified' || /^unverified; drop if apply succeeds without it$/.test(g.necessity))) problems.push(`${g.permission}: necessity`);
  }
  if (c.granted.find((g) => g.permission === 'Account Settings Read')?.necessity !== 'unverified; drop if apply succeeds without it') problems.push('Account Settings Read must be unverified with the drop rule');
  for (const n of c.notGranted) if (names.includes(n.permission)) problems.push(`${n.permission} is both granted and not granted`);
  return problems;
}

function files(dir) {
  if (!existsSync(join(REPO, dir))) return [];
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}
// Every repo document (root *.md, docs/**, infra/**) plus any added in memory, except the
// canonical JSON, the vocabulary itself, and the verbatim research records while each is
// byte-for-byte its pinned record (N-PV-6; an edited one is scanned like any other).
function scannedDocs(read, added = []) {
  const pins = new Map(read('docs/v2/research/SHA256SUMS').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [`docs/v2/research/${f}`, h]; }));
  const pinned = (f) => pins.has(f) && createHash('sha256').update(read(f)).digest('hex') === pins.get(f);
  const all = [...new Set([...readdirSync(REPO).filter((f) => /\.md$/i.test(f)), ...files('docs'), ...files('infra'), ...added])];
  const canonicals = new Set(TOKENS.map((t) => t.canonical));
  return all.filter((f) => !canonicals.has(f) && f !== VOCABULARY_FILE && !pinned(f));
}
function mentionProblems(read, added = []) {
  const vocab = JSON.parse(read(VOCABULARY_FILE));
  return scopeViolations(scannedDocs(read, added).map((f) => [f, read(f)]), vocab);
}

function sufficiencyProblems(read) {
  const s = canonicalOf(read).sufficiencyForApply ?? '';
  if (!/^NOT_EXECUTED: /.test(s)) return ['sufficiencyForApply is not NOT_EXECUTED'];
  const row = read('docs/v2/cloudflare/coverage.md').split('\n').find((l) => l.startsWith('| Deploy-token scope sufficiency for `apply` |'));
  if (!row) return ['coverage.md has no sufficiency cell'];
  return row.includes(`| **NOT_EXECUTED**:${s.slice('NOT_EXECUTED:'.length)}`) ? [] : ['the coverage.md cell differs from the canonical text'];
}

const stepsOf = (text) => text.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => ({ n: Number(l.match(/^\| (\d+) \|/)[1]), cells: cells(l) }));
function deviationProblems(read) {
  const problems = [];
  const dev = read('docs/v2/architecture.md').split('\n').find((l) => l.startsWith('18. '));
  if (!(dev && /N-PV-7/.test(dev) && /1-day/.test(dev) && /one fewer token/.test(dev) && /runbook\.md` step (\d+)/.test(dev))) return ['deviation 18 with its rationale and runbook step is missing'];
  const d1 = canonicalOf(read).granted.find((g) => g.necessity && g.neededFor.includes('cloudflare_d1_database'));
  if (!/whole 1-day life.*architecture\.md deviation 18/.test(d1?.neededFor ?? '')) problems.push('the database write scope row does not cite deviation 18');
  const steps = stepsOf(read('docs/v2/cloudflare/runbook.md'));
  if (!same(steps.map((s) => s.n), steps.map((_, i) => i + 1))) problems.push('runbook steps are not numbered 1..n');
  const lastApply = Math.max(...steps.filter((s) => s.cells[2].includes('tofu apply')).map((s) => s.n));
  const revoke = steps.find((s) => /Revoke the deploy token `rp-deploy-<run>` immediately after/.test(s.cells[2]));
  if (!revoke) return [...problems, 'no revoke step'];
  if (revoke.n !== lastApply + 1) problems.push('the revoke step is not right after the last apply');
  if (!(revoke.cells[4]?.length > 10)) problems.push('the revoke step captures no evidence');
  if (Number(dev.match(/runbook\.md` step (\d+)/)[1]) !== revoke.n) problems.push('deviation 18 names another step');
  return problems;
}

function lifecycleProblems(read) {
  const text = read('docs/v2/cloudflare/runbook.md');
  const steps = stepsOf(text);
  const create = steps.find((s) => /Create Token/.test(s.cells[1]) && /rp-deploy-<run>/.test(s.cells[2]));
  if (!create) return ['no token-creation step'];
  // A step uses the deploy token when it runs tofu or one of the V2.1 scripts live.
  const uses = steps.filter((s) => /tofu (plan|apply|destroy)|wrangler d1 migrations apply|node scripts\/(?:cf-preflight|d1-schema|cf-token-verify)\.mjs[^|]*--live/.test(s.cells[2])).map((s) => s.n);
  const problems = [];
  if (uses.length < 2) problems.push(`token-using steps: ${uses}`);
  if (!(create.n < Math.min(...uses))) problems.push('the token is used before it is created');
  const revoke = steps.find((s) => /Revoke the deploy token `rp-deploy-<run>` immediately after/.test(s.cells[2]));
  if (!revoke) return [...problems, 'no revoke step'];
  if (revoke.n !== Math.max(...uses) + 1) problems.push('not revoked right after the last use');
  const nums = (m) => (m ? [...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])) : []);
  if (!same(nums(revoke.cells[2].match(/used by steps ([^;.]*)/)), uses)) problems.push('the revoke step does not name every using step');
  const fallback = revoke.cells[2].match(/If a session ends before step \d+,(.*)$/)?.[1] ?? '';
  if (!same(nums(fallback.match(/before the next of steps ([\d, or]+)/)), uses.filter((u) => u > create.n))) problems.push('the session rule strands a later use');
  if (!new RegExp(`create a new 1-day deploy token exactly as in step ${create.n}`).test(fallback)) problems.push('the session rule does not recreate the token as in the creation step');
  const teardown = text.slice(text.indexOf('## Teardown'), text.indexOf('## Safety notes')).split('\n').filter((l) => /^\d+\. /.test(l));
  const destroy = teardown.find((l) => l.includes('tofu destroy'));
  if (!destroy) return [...problems, 'teardown does not destroy with tofu'];
  const fresh = destroy.search(new RegExp(`new 1-day deploy token exactly as in step ${create.n}`));
  const revokeAfter = destroy.search(/revoke that token immediately/);
  if (!(fresh >= 0 && fresh < destroy.indexOf('tofu destroy') && revokeAfter > destroy.indexOf('tofu destroy'))) problems.push('teardown has no fresh token before destroy, revoked after');
  return problems;
}

// V2-QA-8 (maintainer decision, 2026-09-28: accept the narrowed claim). The runbook's token
// creation grants only the generated table's rows and names the table the authority; the
// accepted residual is recorded; and the gate's own description states the narrowed
// guarantee, not the old "impossible to write" one.
function authorityProblems(read) {
  const create = stepsOf(read('docs/v2/cloudflare/runbook.md')).find((s) => /Create Token/.test(s.cells[1]) && /rp-deploy-<run>/.test(s.cells[2]));
  if (!create) return ['no token-creation step'];
  const problems = [];
  if (!/grant only the Granted: yes rows of the generated \*Deploy token scopes\* table/.test(create.cells[2])) problems.push('step 3 does not grant only the generated table\'s rows');
  if (!/The table is the authority:\*\* if any prose anywhere disagrees with it, the table wins/.test(create.cells[2])) problems.push('step 3 does not name the table the authority over prose');
  if (!/checked row by row against the table/.test(create.cells[4] ?? '')) problems.push('step 3 does not check the token against the table');
  return problems;
}
function residualProblems(read) {
  const problems = [];
  const tm = read('docs/v2/threat-model.md');
  const t8 = tm.slice(tm.indexOf('## T8.'), tm.indexOf('\n## ', tm.indexOf('## T8.') + 1));
  if (!/^## T8\. .*V2-QA-8: accepted residual/m.test(t8)) problems.push('threat-model T8 (V2-QA-8 accepted residual) is missing');
  if (!/Residual risk: accepted\*\* \(maintainer decision, 2026-09-28, V2-QA-8\)/.test(t8)) problems.push('T8 does not cite the maintainer decision');
  for (const cls of ['a verb before the resource', 'an inflected level', 'separate table cells', 'a link around the resource name', 'wrapped across two lines', 'all-scope credentials']) if (!t8.includes(cls)) problems.push(`T8 does not list: ${cls}`);
  const header = read('scripts/scope-mentions.mjs').split('\nimport ')[0];
  if (/impossible/i.test(header) || !/does NOT understand free prose/.test(header)) problems.push('scope-mentions.mjs does not state the narrowed guarantee');
  if (!read('docs/v2/cloudflare/coverage.md').includes('**What the gate covers, and what it does not.**')) problems.push('coverage.md does not state what the gate covers');
  if (!/does not understand free prose/.test(JSON.parse(read(VOCABULARY_FILE)).description)) problems.push('the vocabulary description overclaims');
  return problems;
}

test('[V2-QA-8] the runbook\'s token creation grants only the generated table\'s rows, and the table is the authority over prose', () => {
  assert.deepEqual(authorityProblems(committed), []);
});

test('[V2-QA-8] the narrowed claim is stated and the accepted residual is recorded', () => {
  assert.deepEqual(residualProblems(committed), []);
});

// Every document gate, over one reader.
const allDocProblems = (read, added = []) => [...vocabularyProblems(read), ...matcherProblems(read), ...tableProblems(read), ...rowProblems(read), ...canonicalProblems(read), ...mentionProblems(read, added), ...sufficiencyProblems(read), ...deviationProblems(read), ...lifecycleProblems(read), ...authorityProblems(read), ...residualProblems(read), ...publicCanonicalProblems(read)];

const committed = world();

test('[V2-QA-3] every document states the canonical deploy-token scopes, row for row', () => {
  assert.deepEqual(rowProblems(committed), []);
});

test('[V2-QA-7] every marked scope table is byte-identical to the output generated from the canonical list', () => {
  assert.deepEqual(tableProblems(committed), []);
});

// V2.1 slice 04: the public target's deploy token is a separate canonical list. It holds the scopes the
// public module needs and no Access scope (the public target has no Access anywhere), and it names
// a different token from the private one.
function publicCanonicalProblems(read) {
  const c = JSON.parse(read(PUBLIC_CANONICAL_FILE));
  const priv = canonicalOf(read);
  const problems = [];
  const names = c.granted.map((g) => g.permission);
  if (!same(names, ['Workers Scripts Edit', 'Workers R2 Storage Edit', 'D1 Edit', 'Account Settings Read'])) problems.push(`public granted scopes are ${names}`);
  if (names.some((n) => /^Access/.test(n))) problems.push('the public deploy token must hold no Access scope');
  for (const n of ['Access: Apps and Policies Edit', 'Access: Service Tokens Edit']) if (!c.notGranted.some((x) => x.permission === n)) problems.push(`the public list must record ${n} as not granted`);
  for (const g of c.granted) {
    if (!g.neededFor || !g.source) problems.push(`public ${g.permission}: needed-for and source`);
    if (!(g.necessity === 'verified' || /^unverified; drop if apply succeeds without it$/.test(g.necessity))) problems.push(`public ${g.permission}: necessity`);
  }
  if (!/rp-public-deploy-<run>/.test(c.description) || /rp-public-deploy/.test(priv.description)) problems.push('the public list must name its own token, rp-public-deploy-<run>, and the private list must not');
  if (c.sufficiencyForApply !== priv.sufficiencyForApply) problems.push('public sufficiencyForApply must be NOT_EXECUTED like the private one');
  return problems;
}

test('[V2.1-04] the public deploy token: its own canonical list, the public module\'s scopes, no Access scope, its own name', () => {
  assert.deepEqual(publicCanonicalProblems(disk), []);
});

test('[V2-QA-3] the canonical list itself: the IaC scopes, each sourced, and unverified ones marked to drop', () => {
  assert.deepEqual(canonicalProblems(committed), []);
});

function vocabularyProblems(read) {
  const v = JSON.parse(read(VOCABULARY_FILE));
  const problems = [];
  if (v.source?.url !== 'https://developers.cloudflare.com/fundamentals/api/reference/permissions/') problems.push('vocabulary source URL');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.source?.read ?? '')) problems.push('vocabulary read date');
  if (!/^[0-9a-f]{64}$/.test(v.source?.sha256 ?? '')) problems.push('vocabulary page hash');
  if (!(v.names?.length >= 300)) problems.push(`only ${v.names?.length} permission-group names`);
  for (const n of v.names ?? []) if (!(n.name && ['user', 'account', 'zone'].includes(n.scope) && n.source === v.source.url && n.read === v.source.read)) problems.push(`name entry ${JSON.stringify(n)}`);
  const all = new Set((v.names ?? []).map((n) => n.name));
  const c = canonicalOf(read);
  for (const p of [...c.granted, ...c.notGranted].flatMap((x) => x.permission.split(' / '))) if (!all.has(p.replace(/^Zone · /, ''))) problems.push(`canonical permission ${p} is not in Cloudflare's list`);
  if (!same(v.nouns, deriveNouns((v.names ?? []).map((n) => n.name)))) problems.push('the nouns are not exactly those derived from the names');
  for (const a of v.abbreviations ?? []) if (!(a.noun && typeof a.bare === 'boolean' && a.why?.length > 10)) problems.push(`abbreviation ${JSON.stringify(a)}`);
  for (const a of v.allowedPhrases ?? []) if (!(a.file && a.phrase && Number.isInteger(a.count) && a.why?.length > 10)) problems.push(`allowed phrase ${JSON.stringify(a)}`);
  return problems;
}

test('[V2-QA-7] the permission vocabulary is Cloudflare\'s list with its source, and its nouns are derived from it', () => {
  assert.deepEqual(vocabularyProblems(committed), []);
});

// What the matcher must catch, in any form, and the ordinary prose it must not.
const MUST_CATCH = ['The deploy token does not include workers r2 storage edit.', 'It needs R2 Edit.', 'grant r2 write here', 'The token grants write access to R2.', 'D1 write is enough', 'account settings read', 'Workers-Scripts: Edit', 'zone · workers routes edit', 'no Apps and Policies scope', 'READ PERMISSION ON D1', 'user details read', 'Grant Zone · DNS · Edit.', 'DNS Edit', 'Workers KV Storage Edit', 'Access: Organizations, Identity Providers, and Groups Edit', 'Cloudflare Tunnel Edit', '# also granted: Workers Routes', 'workers_routes', 'without R2 Storage permissions', 'Use the Global API Key for apply.', 'Run apply as a Super Administrator.', 'The token also needs Zero Trust Edit.'];
const MUST_PASS = ['R2 storage above 10 GB costs little.', 'R2 writes are put-if-absent.', 'Read replication off, on the D1 database', 'The Worker script binds R2 and D1.', 'DNS-rebinding defense', 'the packet origin. Read it.', 'public R2 access', 'resource "cloudflare_zero_trust_access_policy" "reviewers" {', 'text = cloudflare_zero_trust_access_application.reviewers.aud'];
function matcherProblems(read) {
  const mentions = matcher(JSON.parse(read(VOCABULARY_FILE)));
  return [...MUST_CATCH.filter((l) => !mentions(l).length).map((l) => `not caught: ${l}`), ...MUST_PASS.filter((l) => mentions(l).length).map((l) => `ordinary prose caught: ${l}`)];
}

test('[V2-QA-6] the scope-name matcher catches names, synonyms and paraphrases in any case, and not ordinary prose', () => {
  assert.deepEqual(matcherProblems(committed), []);
});

test('[V2-QA-6] no scope name or synonym appears in any repo document outside the canonical JSON and the marked blocks', () => {
  const scanned = scannedDocs(committed);
  for (const want of ['README.md', 'docs/v2/architecture.md', 'docs/projects/review-packet-publisher.md', 'infra/cloudflare/terraform/main.tf']) assert.ok(scanned.includes(want), `the scan covers ${want}`);
  assert.deepEqual(mentionProblems(committed), [], 'scope names outside the canonical list and its generated copies');
});

// QA N-PV-5: "verified" rests on permission descriptions only; whether the scopes suffice
// for a real apply is a NOT_EXECUTED cell, stated once in the canonical list and carried
// into coverage.md's validation table word for word.
test('[N-PV-5] scope sufficiency for apply is NOT_EXECUTED, in the canonical list and in coverage.md', () => {
  assert.deepEqual(sufficiencyProblems(committed), []);
});

// QA N-PV-7 (lead decision): the database write scope stays on the single 1-day token.
test('[N-PV-7] the database write scope deviation is recorded, cited, and followed by a revoke step', () => {
  assert.deepEqual(deviationProblems(committed), []);
});

// V2-QA-6 addendum (c): the runbook's deploy-token lifecycle strands no step.
test('[V2-QA-6] the runbook\'s deploy-token lifecycle strands no step, and teardown uses a fresh token it revokes', () => {
  assert.deepEqual(lifecycleProblems(committed), []);
});

// V2-QA-7 (4): a PERMANENT regression suite. Every case QA has ever planted against these
// document gates (test/scope-cases.mjs) and every red control planted in a document or in
// the canonical list is re-applied in memory on every run, and at least one document gate
// must refuse it. P-I1 was caught at a06cbe6 and missed at 30279b8 because it was only a QA
// attack, never re-run; nothing that was once caught can now pass silently.
test('[V2-QA-7] permanent regression: every scope case ever planted (QA attacks and red controls) is still refused', () => {
  assert.deepEqual(allDocProblems(committed), [], 'the committed tree passes every document gate');
  const planted = CONTROLS.filter((c) => c.tests.includes('test/unit/pv-deploy-token-scopes.test.mjs') && !/\.m?js$/.test(c.file));
  // The filter must keep finding the known document plants (it cannot go quietly inert).
  for (const id of ['R147', 'R148', 'R149', 'R162', 'R163', 'R172', 'R174', 'R197', 'R198', 'R208', 'R209']) assert.ok(planted.some((c) => c.id === id), `${id} is in the permanent suite`);
  const missed = [];
  for (const c of planted) {
    const src = disk(c.file);
    if (!src.includes(c.find)) { missed.push(`${c.id}: its find string is no longer in ${c.file}`); continue; }
    if (!allDocProblems(world({ [c.file]: src.replace(c.find, () => c.replace) })).length) missed.push(`${c.id}: ${c.defect}`);
  }
  for (const q of QA_SCOPE_CASES) {
    const exists = existsSync(join(REPO, q.file));
    const text = `${exists ? disk(q.file) : ''}\n${q.text}\n`;
    if (!allDocProblems(world({ [q.file]: text }), exists ? [] : [q.file]).length) missed.push(`QA ${q.id}: ${q.text}`);
  }
  assert.deepEqual(missed, [], 'previously caught cases that now pass');
});
