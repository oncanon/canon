// The Cloudflare IaC may manage only the approved resources, with only the approved
// settings, so the deploy token's scopes cover it exactly (V2-QA-5 (a)). V2-QA-6: the
// check is structural. scripts/hcl-scan.mjs parses every .tf file the way Terraform reads
// it (all comment kinds, strings, heredocs, nesting) and this gate enforces a STRICT
// allowlist on every block at every depth and every attribute, including keys inside
// object values: no backend, cloud, module, data, provisioner, connection, lifecycle or
// dynamic block anywhere; no credential in any attribute; bindings exactly as approved,
// referencing only approved non-secret inputs. A file the scanner cannot parse fails.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { scanHcl } from '../../scripts/hcl-scan.mjs';
import { ACCESS_CASES, QA_CASES, QA_IAC_REGRESSION } from '../iac-cases.mjs';
import { CONTROLS } from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';

const TF_DIR = 'infra/cloudflare/terraform';
const TF_FILES = readdirSync(join(REPO, TF_DIR));
const EXAMPLE = 'test.tfvars.example';
const LOCKFILE = '.terraform.lock.hcl';

// The variables the configuration may declare and reference. service_token_client_ids (the
// Access Client IDs) and service_token_id (the token's ID) are identifiers, not secrets
// (runbook step 4); they are the only approved names the secret-name pattern would match.
const APPROVED_VARS = ['account_id', 'worker_name', 'run_id', 'worker_module_path', 'compatibility_date', 'team_domain', 'service_token_client_ids', 'workers_subdomain', 'access_mode', 'reviewer_emails', 'reviewer_email_domain', 'identity_provider_id', 'service_token_id'];
const IDENTIFIER_VARS = ['service_token_client_ids', 'service_token_id'];
const SECRET_NAME = /secret|token|key|passw/i;
// Each approved resource type, the instance names it may have, and its attributes. V2.1 slice
// 03 adds exactly the Access application and its policies (no service token: its secret would
// be stored in state).
const RESOURCES = {
  cloudflare_r2_bucket: { names: ['packets'], attrs: ['account_id', 'name', 'storage_class'] },
  cloudflare_d1_database: { names: ['aliases'], attrs: ['account_id', 'name', 'read_replication', 'read_replication.mode'] },
  cloudflare_zero_trust_access_application: { names: ['reviewers'], attrs: ['account_id', 'name', 'type', 'domain', 'session_duration', 'app_launcher_visible', 'allowed_idps', 'auto_redirect_to_identity', 'policies', 'policies[].id', 'policies[].precedence'] },
  cloudflare_zero_trust_access_policy: { names: ['reviewers', 'publisher'], attrs: ['account_id', 'name', 'decision', 'include', 'include[].service_token', 'include[].service_token.token_id'] },
  cloudflare_workers_script: { names: ['publisher'], attrs: ['account_id', 'script_name', 'content_file', 'content_sha256', 'main_module', 'compatibility_date', 'bindings', 'bindings[].name', 'bindings[].type', 'bindings[].bucket_name', 'bindings[].id', 'bindings[].text'] },
  cloudflare_workers_script_subdomain: { names: ['publisher'], attrs: ['account_id', 'script_name', 'enabled', 'previews_enabled'] },
};
// Access expressions that must be exactly these (resource address, attribute): the reviewer
// modes, the Service Auth rule, and what the application protects.
const EXACT = {
  'resource.cloudflare_zero_trust_access_policy.reviewers decision': '"allow"',
  'resource.cloudflare_zero_trust_access_policy.reviewers include': 'var.access_mode == "exact-person" ? [for e in var.reviewer_emails : { email = { email = e } }] : [{ email_domain = { domain = var.reviewer_email_domain } }]',
  'resource.cloudflare_zero_trust_access_policy.publisher decision': '"non_identity"',
  'resource.cloudflare_zero_trust_access_policy.publisher include': '[{ service_token = { token_id = var.service_token_id } }]',
  'resource.cloudflare_zero_trust_access_application.reviewers type': '"self_hosted"',
  'resource.cloudflare_zero_trust_access_application.reviewers domain': '"${var.worker_name}.${var.workers_subdomain}.workers.dev"',
  'resource.cloudflare_zero_trust_access_application.reviewers allowed_idps': 'var.access_mode == "idp-domain" ? [var.identity_provider_id] : []',
};
// Block kinds by where they may appear (the parent's kind, '' for top level), with the
// attributes each may hold. Anything not listed is refused.
const BLOCKS = {
  '/terraform': { labels: () => true, attrs: ['required_version'] },
  'terraform/required_providers': { labels: (l) => l.length === 0, attrs: ['cloudflare', 'cloudflare.source', 'cloudflare.version'] },
  '/provider': { labels: (l) => l.length === 1 && l[0] === 'cloudflare', attrs: [] },
  '/variable': { labels: (l) => l.length === 1 && APPROVED_VARS.includes(l[0]), attrs: ['description', 'type', 'default'] },
  'variable/validation': { labels: (l) => l.length === 0, attrs: ['condition', 'error_message'] },
  '/locals': { labels: (l) => l.length === 0, attrs: ['bucket_name', 'database_name'] },
  '/output': { labels: (l) => l.length === 1 && ['bucket_name', 'd1_database_id', 'worker_name'].includes(l[0]), attrs: ['value', 'description'] },
  '/resource': { labels: (l) => l.length === 2 && (RESOURCES[l[0]]?.names ?? []).includes(l[1]), attrs: null },
};
// Values that must be exactly these (resource type or block kind, attribute key, literal).
const PINNED = [
  ['cloudflare_workers_script_subdomain', 'enabled', true],
  ['cloudflare_workers_script_subdomain', 'previews_enabled', false],
  ['cloudflare_d1_database', 'read_replication.mode', 'disabled'],
  ['required_providers', 'cloudflare.source', 'cloudflare/cloudflare'],
  ['terraform', 'required_version', '>= 1.6.0'],
];
const BINDINGS = [
  { name: 'PACKETS', type: 'r2_bucket', key: 'bucket_name', text: 'cloudflare_r2_bucket.packets.name' },
  { name: 'ALIASES', type: 'd1', key: 'id', text: 'cloudflare_d1_database.aliases.id' },
  { name: 'TEAM_DOMAIN', type: 'plain_text', key: 'text', text: 'var.team_domain' },
  { name: 'POLICY_AUD', type: 'plain_text', key: 'text', text: 'cloudflare_zero_trust_access_application.reviewers.aud' },
  { name: 'SERVICE_TOKEN_CLIENT_IDS', type: 'plain_text', key: 'text', text: 'join(",", var.service_token_client_ids)' },
];
const CREDENTIAL_ATTR = /^(api_token|api_key|api_user_service_key|email|password|token|user_service_key)$|secret|passw|_token$|_key$/i;
const TOKEN_LIKE_LITERAL = /^[A-Za-z0-9_+/=-]{32,}$/;

// The committed files, or in-memory variants of them (for the negative cases below).
const read = (f) => readFileSync(join(REPO, TF_DIR, f), 'utf8');
// Keys of `override` are file names in the Terraform directory; a new .tf name adds a file.
const scans = (override = {}) => [...new Set([...TF_FILES, ...Object.keys(override)])].filter((f) => f.endsWith('.tf')).map((f) => ({ file: `${TF_DIR}/${f}`, ...scanHcl(override[f] ?? read(f)) }));

// Where an attribute lives: its owning block and its key relative to that block
// ("read_replication.mode", "bindings[].text").
function located(scan) {
  const byPath = new Map(scan.blocks.map((b) => [b.blockPath, b]));
  return scan.attributes.map((a) => {
    let owner = a.path;
    while (owner && !byPath.has(owner)) owner = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
    const rest = a.path.slice(owner.length).replace(/^\//, '');
    return { ...a, owner: byPath.get(owner) ?? null, key: `${rest ? `${rest}.` : ''}${a.name}`.replace(/\[\d+\]/g, '[]').replace(/\.\[/g, '[').replace(/\]\./g, '].') };
  });
}
const kindOf = (scan, b) => {
  const parent = scan.blocks.find((x) => x.blockPath === b.path);
  return `${parent ? parent.type : ''}/${b.type}`;
};

function iacViolations(all) {
  const problems = [];
  const resources = [];
  const declared = [];
  for (const scan of all) {
    for (const b of scan.blocks) {
      const kind = kindOf(scan, b);
      if (!BLOCKS[kind]) problems.push(`${scan.file}:${b.line}: block ${b.type}${b.labels.map((l) => ` "${l}"`).join('')} is not allowed ${b.path ? `inside ${b.path}` : 'at top level'}`);
      else if (!BLOCKS[kind].labels(b.labels)) problems.push(`${scan.file}:${b.line}: ${b.type} ${JSON.stringify(b.labels)} is not an approved ${b.type}`);
      if (kind === '/resource') resources.push(b.labels[0]);
      if (kind === '/variable') declared.push(b.labels[0]);
    }
    for (const a of located(scan)) {
      const b = a.owner;
      if (!b) {
        problems.push(`${scan.file}:${a.line}: attribute ${a.key} outside any block`);
        continue;
      }
      const kind = kindOf(scan, b);
      const allowed = kind === '/resource' ? RESOURCES[b.labels[0]]?.attrs ?? [] : BLOCKS[kind]?.attrs ?? [];
      if (!allowed.includes(a.key)) problems.push(`${scan.file}:${a.line}: attribute ${a.key} is not allowed in ${b.blockPath}`);
      for (const [owner, key, want] of PINNED) {
        if ((b.labels[0] === owner || b.type === owner) && a.key === key && a.value.literal !== want) problems.push(`${scan.file}:${a.line}: ${owner} ${key} must be ${JSON.stringify(want)}, not ${a.text}`);
      }
      if (kind === '/resource' && a.key === 'account_id' && a.text !== 'var.account_id') problems.push(`${scan.file}:${a.line}: ${b.blockPath} account_id must be var.account_id`);
      for (const ref of a.value.refs ?? []) {
        const [root, name] = ref.split('.');
        if (root === 'var' && !APPROVED_VARS.includes(name)) problems.push(`${scan.file}:${a.line}: reference to unapproved variable var.${name}`);
        if (root === 'data' || root === 'module') problems.push(`${scan.file}:${a.line}: reference to ${ref}`);
      }
    }
  }
  for (const v of declared) if (SECRET_NAME.test(v) && !IDENTIFIER_VARS.includes(v)) problems.push(`variable ${v}: a secret-like input is not allowed`);
  // Exactly one terraform {} block in the whole configuration (V2-QA-6 addendum, QA F4/F4d):
  // a second one could loosen required_version or add settings the first never shows.
  const terraformBlocks = all.flatMap((scan) => scan.blocks.filter((b) => b.type === 'terraform' && !b.path).map((b) => `${scan.file}:${b.line}`));
  if (terraformBlocks.length !== 1) problems.push(`exactly one terraform block is allowed, found ${terraformBlocks.length}: ${terraformBlocks.join(', ')}`);
  for (const t of Object.keys(RESOURCES)) if (!resources.includes(t)) problems.push(`resource ${t} is missing`);
  const instances = Object.values(RESOURCES).reduce((n, r) => n + r.names.length, 0);
  if (resources.length !== instances) problems.push(`expected exactly ${instances} resources, found ${resources.length}`);
  for (const [where, want] of Object.entries(EXACT)) {
    const [path, name] = where.split(' ');
    const got = all.flatMap((scan) => scan.attributes.filter((a) => a.path === path && a.name === name));
    if (got.length !== 1 || got[0].text !== want) problems.push(`${path} ${name} must be exactly ${want}, found ${got.map((a) => a.text).join(' | ') || 'nothing'}`);
  }
  if ([...declared].sort().join() !== [...APPROVED_VARS].sort().join()) problems.push(`declared variables ${declared.join(', ')} differ from the approved set`);
  return problems;
}

function credentialViolations(all) {
  const problems = [];
  for (const scan of all) {
    for (const a of scan.attributes) {
      // An Access policy's `service_token` include rule is the rule's name; it holds only the
      // token's ID (token_id), never its secret.
      const accessRule = a.name === 'service_token' && /^resource\.cloudflare_zero_trust_access_policy\.[a-z]+\/include\[\d+\]$/.test(a.path);
      if (CREDENTIAL_ATTR.test(a.name) && !accessRule) problems.push(`${scan.file}:${a.line}: credential-like attribute ${a.name}`);
      for (const s of a.value.strings ?? []) if (TOKEN_LIKE_LITERAL.test(s)) problems.push(`${scan.file}:${a.line}: token-like literal in ${a.name}`);
    }
    for (const b of scan.blocks.filter((x) => x.type === 'provider')) {
      const inside = scan.attributes.filter((a) => a.path === b.blockPath || a.path.startsWith(`${b.blockPath}/`)).length + scan.blocks.filter((x) => x.path === b.blockPath).length;
      if (inside) problems.push(`${scan.file}:${b.line}: the provider block must be empty (the token comes only from CLOUDFLARE_API_TOKEN)`);
    }
  }
  return problems;
}

test('[V2-QA-6] every Terraform file parses, and the directory holds only .tf files and the tfvars example', () => {
  // .terraform.lock.hcl is the pinned provider lockfile (V2.1 slice 06; test/unit/v21-lockfile.test.mjs).
  assert.deepEqual(TF_FILES.filter((f) => !f.endsWith('.tf') && f !== EXAMPLE && f !== LOCKFILE), [], 'only .tf files, the tfvars example and the lockfile');
  const all = scans();
  assert.ok(all.length >= 4, 'the gate reads the .tf files');
  const example = scanHcl(readFileSync(join(REPO, TF_DIR, EXAMPLE), 'utf8'));
  assert.deepEqual(example.blocks, [], 'the tfvars example holds only assignments');
  for (const a of example.attributes) assert.ok(APPROVED_VARS.includes(a.name) && !CREDENTIAL_ATTR.test(a.name), `tfvars example: ${a.name}`);
});

test('[V2-QA-6] Terraform/OpenTofu: only allowlisted blocks and attributes at every depth, with pinned values', () => {
  assert.deepEqual(iacViolations(scans()), []);
});

test('[V2-QA-6] no credential-like attribute or literal anywhere in the IaC, and the provider block is empty', () => {
  assert.deepEqual(credentialViolations(scans()), []);
});

function bindingProblems(all) {
  const main = all.find((x) => x.file.endsWith('/main.tf'));
  const lists = main.attributes.filter((a) => a.name === 'bindings');
  if (lists.length !== 1 || lists[0].value.kind !== 'tuple') return ['exactly one bindings list (a tuple) is required'];
  const problems = [];
  const got = lists[0].value.items.map((o) => {
    if (o.kind !== 'object') { problems.push('a binding is not an object'); return {}; }
    const keys = Object.fromEntries(o.items.map((it) => [it.key, it]));
    const valueKey = o.items.map((it) => it.key).find((k) => k !== 'name' && k !== 'type');
    return { name: keys.name?.value.literal, type: keys.type?.value.literal, key: valueKey, text: keys[valueKey]?.text, keys: o.items.length, refs: keys[valueKey]?.value.refs ?? [] };
  });
  for (const b of got) {
    for (const ref of b.refs ?? []) {
      const [root, name] = ref.split('.');
      if (root === 'var' && !(APPROVED_VARS.includes(name) && (!SECRET_NAME.test(name) || IDENTIFIER_VARS.includes(name)))) problems.push(`${b.name}: references var.${name}`);
    }
  }
  if (JSON.stringify(got.map(({ refs, ...rest }) => rest)) !== JSON.stringify(BINDINGS.map((b) => ({ ...b, keys: 3 })))) problems.push('the bindings differ from the approved set');
  return problems;
}

test('[V2-QA-6] the Worker binds exactly the approved bindings, referencing only approved non-secret inputs', () => {
  assert.deepEqual(bindingProblems(scans()), []);
});

// wrangler.jsonc: whole-line // comments only; anything else that is not plain JSON
// (a block comment, a trailing comment) fails to parse, and so fails the gate.
const WRANGLER = 'infra/cloudflare/wrangler/wrangler.jsonc';
function wranglerViolations(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'));
  } catch (err) {
    return [`wrangler.jsonc does not parse as JSON after removing whole-line comments: ${err.message}`];
  }
  const problems = [];
  const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };
  eq('keys', Object.keys(cfg).sort(), ['$schema', 'compatibility_date', 'd1_databases', 'main', 'name', 'preview_urls', 'r2_buckets', 'workers_dev']);
  eq('workers_dev', cfg.workers_dev, true);
  eq('preview_urls', cfg.preview_urls, false);
  eq('r2_buckets keys', (cfg.r2_buckets ?? []).map((b) => Object.keys(b).sort()), [['binding', 'bucket_name']]);
  eq('d1_databases keys', (cfg.d1_databases ?? []).map((d) => Object.keys(d).sort()), [['binding', 'database_id', 'database_name', 'migrations_dir']]);
  eq('bindings', [...(cfg.r2_buckets ?? []), ...(cfg.d1_databases ?? [])].map((b) => b.binding).sort(), ['ALIASES', 'PACKETS']);
  eq('migrations_dir', cfg.d1_databases?.[0]?.migrations_dir, 'migrations');
  return problems;
}

test('[V2-QA-5] wrangler: only the approved keys, workers.dev on, previews off, no routes or vars', () => {
  assert.deepEqual(wranglerViolations(readFileSync(join(REPO, WRANGLER), 'utf8')), []);
});

test('[V2-QA-6] wrangler: routes, previews, vars, extra binding keys and non-JSON comments are refused', () => {
  const raw = readFileSync(join(REPO, WRANGLER), 'utf8');
  const cases = [
    ['routes', raw.replace('"workers_dev": true,', '"workers_dev": true,\n  "routes": [{ "pattern": "x.example.com/*", "zone_name": "example.com" }],'), /keys/],
    ['route', raw.replace('"workers_dev": true,', '"workers_dev": true,\n  "route": "x.example.com/*",'), /keys/],
    ['previews on', raw.replace('"preview_urls": false', '"preview_urls": true'), /preview_urls/],
    ['workers.dev off', raw.replace('"workers_dev": true', '"workers_dev": false'), /workers_dev/],
    ['vars', raw.replace('"workers_dev": true,', '"workers_dev": true,\n  "vars": { "X": "y" },'), /keys/],
    ['preview bucket', raw.replace('"bucket_name":', '"preview_bucket_name": "p",\n      "bucket_name":'), /r2_buckets keys/],
    ['block comment', raw.replace('"workers_dev": true,', '"workers_dev": true, /* "routes": [] */'), /does not parse/],
  ];
  for (const [name, text, reason] of cases) {
    assert.notEqual(text, raw, `${name}: the payload applies`);
    const problems = wranglerViolations(text);
    assert.ok(problems.some((p) => reason.test(p)), `${name}: expected ${reason}, got ${JSON.stringify(problems)}`);
  }
});

test('[V2-QA-5] the wrangler migration is byte-identical to the Worker schema', () => {
  assert.ok(readFileSync(join(REPO, 'infra/cloudflare/wrangler/migrations/0001_init.sql')).equals(readFileSync(join(REPO, 'src/publication/worker/schema.sql'))));
});

test('[V2-QA-6] each of QA\'s B1-B9 cases is refused for its own reason', () => {
  for (const { name, file, mutate, reason } of QA_CASES) {
    const text = mutate(read(file));
    assert.notEqual(text, read(file), `${name}: the payload applies`);
    const all = scans({ [file]: text });
    const problems = [...iacViolations(all), ...credentialViolations(all)];
    assert.ok(problems.some((p) => reason.test(p)), `${name}: expected ${reason}, got ${JSON.stringify(problems)}`);
  }
});

// V2-QA-7 (4): a PERMANENT regression suite. Every IaC case QA has ever planted (B1-B9 and
// the regression list in test/iac-cases.mjs) and every red control planted in the Cloudflare
// IaC is re-applied in memory on every run, and at least one IaC gate must refuse it, so a
// case that was once caught can never pass silently.
const MIGRATION = 'infra/cloudflare/wrangler/migrations/0001_init.sql';
function allIacProblems({ tf = {}, wrangler, migration } = {}) {
  const problems = [];
  for (const f of Object.keys(tf)) if (!f.endsWith('.tf') && f !== EXAMPLE) problems.push(`${f}: not a .tf file`);
  try {
    const all = scans(tf);
    problems.push(...iacViolations(all), ...credentialViolations(all), ...bindingProblems(all), ...accessModeProblems(all));
  } catch (err) {
    problems.push(`parse: ${err.message}`);
  }
  problems.push(...wranglerViolations(wrangler ?? readFileSync(join(REPO, WRANGLER), 'utf8')));
  const sql = migration ?? readFileSync(join(REPO, MIGRATION), 'utf8');
  if (sql !== readFileSync(join(REPO, 'src/publication/worker/schema.sql'), 'utf8')) problems.push('the migration differs from the Worker schema');
  return problems;
}

test('[V2-QA-7] permanent regression: every IaC case ever planted (QA attacks and red controls) is still refused', () => {
  assert.deepEqual(allIacProblems(), [], 'the committed IaC passes every IaC gate');
  const planted = CONTROLS.filter((c) => c.tests.includes('test/unit/pv-iac-allowlist.test.mjs') && c.file.startsWith('infra/cloudflare/'));
  for (const id of ['R156', 'R157', 'R158', 'R159', 'R160', 'R161', 'R177', 'R178', 'R183', 'R186']) assert.ok(planted.some((c) => c.id === id), `${id} is in the permanent suite`);
  const missed = [];
  for (const c of planted) {
    const src = readFileSync(join(REPO, c.file), 'utf8');
    if (!src.includes(c.find)) { missed.push(`${c.id}: its find string is no longer in ${c.file}`); continue; }
    const text = src.replace(c.find, () => c.replace);
    const input = c.file === WRANGLER ? { wrangler: text } : c.file === MIGRATION ? { migration: text } : { tf: { [c.file.slice(TF_DIR.length + 1)]: text } };
    if (!allIacProblems(input).length) missed.push(`${c.id}: ${c.defect}`);
  }
  for (const q of [...QA_CASES.map((x) => ({ id: x.name, file: x.file, mutate: x.mutate })), ...QA_IAC_REGRESSION, ...ACCESS_CASES]) {
    const base = TF_FILES.includes(q.file) ? read(q.file) : '';
    const text = q.mutate(base);
    if (text === base) { missed.push(`QA ${q.id}: the payload no longer applies`); continue; }
    if (!allIacProblems({ tf: { [q.file]: text } }).length) missed.push(`QA ${q.id}`);
  }
  assert.deepEqual(missed, [], 'previously caught IaC cases that now pass');
});

// V2.1 slice 03: Access as code. The reviewer mode is one of exactly two, chosen by a validated
// variable; the service token's secret can never reach state (no service-token resource, no
// secret variable or output, no client_secret attribute); the reviewer and Service Auth rules
// are pinned. Each planted case is refused for its own reason.
// The reviewer mode is exactly one of two, validated, defaulting to exact-person.
function accessModeProblems(all) {
  const attrs = all.flatMap((scan) => scan.attributes);
  const cond = attrs.find((a) => a.path === 'variable.access_mode/validation' && a.name === 'condition');
  const def = attrs.find((a) => a.path === 'variable.access_mode' && a.name === 'default');
  const problems = [];
  if (cond?.text !== 'contains(["exact-person", "idp-domain"], var.access_mode)') problems.push(`access_mode must be validated as exactly exact-person or idp-domain, found ${cond?.text ?? 'no validation'}`);
  if (def?.value.literal !== 'exact-person') problems.push('access_mode must default to exact-person');
  return problems;
}

test('[V2.1-03] Access modes are exact-person or idp-domain by a validated variable; planted secret-in-state cases are refused', () => {
  assert.deepEqual(accessModeProblems(scans()), []);
  for (const c of ACCESS_CASES) {
    const text = c.mutate(read(c.file));
    assert.notEqual(text, read(c.file), `${c.id}: the payload applies`);
    const all = scans({ [c.file]: text });
    const problems = [...iacViolations(all), ...credentialViolations(all)];
    assert.ok(problems.some((p) => c.reason.test(p)), `${c.id}: expected ${c.reason}, got ${JSON.stringify(problems)}`);
  }
});

