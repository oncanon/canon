// V2.1 slice 04: the public target's IaC (infra/cloudflare/terraform-public) is its own root
// module with its own state, and it shares no resource, variable, state or credential with the
// private module (infra/cloudflare/terraform). Two checks, both derived from the parsed files
// (scripts/hcl-scan.mjs):
// - the public module's own STRICT allowlist (the same rules as test/unit/pv-iac-allowlist.test.mjs
//   applies to the private module: every block at every depth and every attribute, pinned values,
//   exact bindings, no credential), with no Access of any kind;
// - cross-module separation: no Access in the public module, no shared resource address, no
//   shared variable beyond the structural inputs, no shared name prefix for the bucket, database
//   or Worker, no reference to the private module's directory or state, and a private module
//   whose access_mode never admits "public".
// Every planted case (test/iac-cases.mjs PUBLIC_CASES) and every red control planted in the public
// module is refused for its own reason, on every run.
// (The engine repeats pv-iac-allowlist's instead of sharing it: red controls anchor on that file's
// exact text, so it is not refactored.)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { scanHcl } from '../../scripts/hcl-scan.mjs';
import { CONTROLS } from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';
import { PUBLIC_CASES } from '../iac-cases.mjs';

const DIRS = { public: 'infra/cloudflare/terraform-public', private: 'infra/cloudflare/terraform' };
const FILES = Object.fromEntries(Object.entries(DIRS).map(([m, d]) => [m, readdirSync(join(REPO, d))]));
const EXAMPLE = 'test.tfvars.example';
const LOCKFILE = '.terraform.lock.hcl';

const APPROVED_VARS = ['account_id', 'worker_name', 'run_id', 'worker_module_path', 'compatibility_date', 'publisher_public_key'];
// Structural inputs both modules may name: the same account and run, and the Worker source. The
// public module's worker_name default is pinned to its own name, never the private one.
const SHARED_INPUTS = ['account_id', 'worker_name', 'run_id', 'worker_module_path', 'compatibility_date'];
// The public key is not a secret (the Worker's plain var); it is the one approved name the
// secret-name pattern matches.
const NOT_SECRET_VARS = ['publisher_public_key'];
const SECRET_NAME = /secret|token|key|passw/i;
const RESOURCES = {
  cloudflare_r2_bucket: { names: ['public_packets'], attrs: ['account_id', 'name', 'storage_class'] },
  cloudflare_d1_database: { names: ['public_aliases'], attrs: ['account_id', 'name', 'read_replication', 'read_replication.mode'] },
  cloudflare_workers_script: { names: ['public_publisher'], attrs: ['account_id', 'script_name', 'content_file', 'content_sha256', 'main_module', 'compatibility_date', 'bindings', 'bindings[].name', 'bindings[].type', 'bindings[].bucket_name', 'bindings[].id', 'bindings[].text'] },
  cloudflare_workers_script_subdomain: { names: ['public_publisher'], attrs: ['account_id', 'script_name', 'enabled', 'previews_enabled'] },
};
const EXACT = {
  'locals bucket_name': '"rp-public-test-${var.run_id}"',
  'locals database_name': '"rp-public-aliases-test-${var.run_id}"',
  'locals target_id': '"${var.worker_name}-${var.run_id}"',
  'variable.worker_name default': '"rp-public-test"',
  'variable.publisher_public_key/validation condition': 'can(regex("^canon-ed25519-pk:[A-Za-z0-9_-]{43}$", var.publisher_public_key))',
};
const BLOCKS = {
  '/terraform': { labels: () => true, attrs: ['required_version'] },
  'terraform/required_providers': { labels: (l) => l.length === 0, attrs: ['cloudflare', 'cloudflare.source', 'cloudflare.version'] },
  '/provider': { labels: (l) => l.length === 1 && l[0] === 'cloudflare', attrs: [] },
  '/variable': { labels: (l) => l.length === 1 && APPROVED_VARS.includes(l[0]), attrs: ['description', 'type', 'default'] },
  'variable/validation': { labels: (l) => l.length === 0, attrs: ['condition', 'error_message'] },
  '/locals': { labels: (l) => l.length === 0, attrs: ['bucket_name', 'database_name', 'target_id'] },
  '/output': { labels: (l) => l.length === 1 && ['public_bucket_name', 'public_d1_database_id', 'public_worker_name', 'public_target_id'].includes(l[0]), attrs: ['value', 'description'] },
  '/resource': { labels: (l) => l.length === 2 && (RESOURCES[l[0]]?.names ?? []).includes(l[1]), attrs: null },
};
const PINNED = [
  ['cloudflare_workers_script_subdomain', 'enabled', true],
  ['cloudflare_workers_script_subdomain', 'previews_enabled', false],
  ['cloudflare_d1_database', 'read_replication.mode', 'disabled'],
  ['required_providers', 'cloudflare.source', 'cloudflare/cloudflare'],
  ['terraform', 'required_version', '>= 1.6.0'],
];
// The public Worker's bindings: its own bucket and database, MODE = "public", its TARGET_ID, and
// the PUBLIC signing key. No Access binding (TEAM_DOMAIN, POLICY_AUD, SERVICE_TOKEN_CLIENT_IDS).
const BINDINGS = [
  { name: 'PACKETS', type: 'r2_bucket', key: 'bucket_name', text: 'cloudflare_r2_bucket.public_packets.name' },
  { name: 'ALIASES', type: 'd1', key: 'id', text: 'cloudflare_d1_database.public_aliases.id' },
  { name: 'MODE', type: 'plain_text', key: 'text', text: '"public"' },
  { name: 'TARGET_ID', type: 'plain_text', key: 'text', text: 'local.target_id' },
  { name: 'PUBLISHER_PUBLIC_KEY', type: 'plain_text', key: 'text', text: 'var.publisher_public_key' },
];
const CREDENTIAL_ATTR = /^(api_token|api_key|api_user_service_key|email|password|token|user_service_key)$|secret|passw|_token$|_key$/i;
const TOKEN_LIKE_LITERAL = /^[A-Za-z0-9_+/=-]{32,}$/;

const read = (module, f) => readFileSync(join(REPO, DIRS[module], f), 'utf8');
// Keys of `override[module]` are file names in that module; a new .tf name adds a file.
const scans = (module, override = {}) => [...new Set([...FILES[module], ...Object.keys(override)])].filter((f) => f.endsWith('.tf')).map((f) => ({ file: `${DIRS[module]}/${f}`, ...scanHcl(override[f] ?? read(module, f)) }));

function located(scan) {
  const byPath = new Map(scan.blocks.map((b) => [b.blockPath, b]));
  return scan.attributes.map((a) => {
    let owner = a.path;
    while (owner && !byPath.has(owner)) owner = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
    const rest = a.path.slice(owner.length).replace(/^\//, '');
    return { ...a, owner: byPath.get(owner) ?? null, key: `${rest ? `${rest}.` : ''}${a.name}`.replace(/\[\d+\]/g, '[]').replace(/\.\[/g, '[').replace(/\]\./g, '].') };
  });
}
const kindOf = (scan, b) => `${scan.blocks.find((x) => x.blockPath === b.path)?.type ?? ''}/${b.type}`;

// The public module's own allowlist.
export function publicViolations(all) {
  const problems = [];
  const resources = [];
  const declared = [];
  for (const scan of all) {
    for (const b of scan.blocks) {
      const kind = kindOf(scan, b);
      if (!BLOCKS[kind]) problems.push(`${scan.file}:${b.line}: block ${b.type}${b.labels.map((l) => ` "${l}"`).join('')} is not allowed ${b.path ? `inside ${b.path}` : 'at top level'}`);
      else if (!BLOCKS[kind].labels(b.labels)) problems.push(`${scan.file}:${b.line}: ${b.type}${b.labels.map((l) => ` "${l}"`).join('')} is not an approved ${kind === '/resource' ? 'resource' : b.type}`);
      if (kind === '/resource') resources.push(b.labels[0]);
      if (kind === '/variable') declared.push(b.labels[0]);
    }
    for (const a of located(scan)) {
      const b = a.owner;
      if (!b) { problems.push(`${scan.file}:${a.line}: attribute ${a.key} outside any block`); continue; }
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
      if (CREDENTIAL_ATTR.test(a.name)) problems.push(`${scan.file}:${a.line}: credential-like attribute ${a.name}`);
      for (const s of a.value.strings ?? []) if (TOKEN_LIKE_LITERAL.test(s)) problems.push(`${scan.file}:${a.line}: token-like literal in ${a.name}`);
    }
    for (const b of scan.blocks.filter((x) => x.type === 'provider')) {
      if (scan.attributes.some((a) => a.path === b.blockPath || a.path.startsWith(`${b.blockPath}/`)) || scan.blocks.some((x) => x.path === b.blockPath)) problems.push(`${scan.file}:${b.line}: the provider block must be empty`);
    }
  }
  for (const v of declared) if (SECRET_NAME.test(v) && !NOT_SECRET_VARS.includes(v)) problems.push(`variable ${v}: a secret-like input is not allowed`);
  const terraformBlocks = all.flatMap((scan) => scan.blocks.filter((b) => b.type === 'terraform' && !b.path));
  if (terraformBlocks.length !== 1) problems.push(`exactly one terraform block is allowed, found ${terraformBlocks.length}`);
  for (const t of Object.keys(RESOURCES)) if (!resources.includes(t)) problems.push(`resource ${t} is missing`);
  const instances = Object.values(RESOURCES).reduce((n, r) => n + r.names.length, 0);
  if (resources.length !== instances) problems.push(`expected exactly ${instances} resources, found ${resources.length}`);
  for (const [where, want] of Object.entries(EXACT)) {
    const [path, name] = where.split(' ');
    const got = all.flatMap((scan) => scan.attributes.filter((a) => a.path === path && a.name === name));
    if (got.length !== 1 || got[0].text !== want) problems.push(`${path.replace(/^variable\./, '')} ${name} must be exactly ${want}, found ${got.map((a) => a.text).join(' | ') || 'nothing'}`);
  }
  if ([...declared].sort().join() !== [...APPROVED_VARS].sort().join()) problems.push(`declared variables ${declared.join(', ')} differ from the approved set`);
  problems.push(...bindingProblems(all));
  return problems;
}

function bindingProblems(all) {
  const lists = all.flatMap((scan) => scan.attributes.filter((a) => a.name === 'bindings'));
  if (lists.length !== 1 || lists[0].value.kind !== 'tuple') return ['exactly one bindings list (a tuple) is required'];
  const got = lists[0].value.items.map((o) => {
    if (o.kind !== 'object') return { bad: true };
    const keys = Object.fromEntries(o.items.map((it) => [it.key, it]));
    const valueKey = o.items.map((it) => it.key).find((k) => k !== 'name' && k !== 'type');
    return { name: keys.name?.value.literal, type: keys.type?.value.literal, key: valueKey, text: keys[valueKey]?.text, keys: o.items.length };
  });
  return JSON.stringify(got) === JSON.stringify(BINDINGS.map((b) => ({ ...b, keys: 3 }))) ? [] : ["the public Worker's bindings differ from the approved set"];
}

// Names a module gives the things it creates: the literal prefix of each name-bearing local (up
// to the first interpolation) and the Worker name default.
function namePrefixes(all) {
  const attrs = all.flatMap((scan) => scan.attributes);
  const locals = attrs.filter((a) => a.path === 'locals' && ['bucket_name', 'database_name'].includes(a.name));
  const worker = attrs.filter((a) => a.path === 'variable.worker_name' && a.name === 'default');
  return [...locals, ...worker].map((a) => String(a.value.literal ?? '').split('${')[0]).filter(Boolean);
}

// Cross-module separation: derived from both modules as parsed.
export function separationProblems(pub, priv) {
  const problems = [];
  const blocksOf = (all) => all.flatMap((scan) => scan.blocks.map((b) => ({ ...b, file: scan.file })));
  for (const b of blocksOf(pub)) {
    if (b.labels.some((l) => /zero_trust|access/i.test(l))) problems.push(`${b.file}:${b.line}: no Access in the public module (${b.type} ${b.labels.join(' ')})`);
  }
  const addresses = (all) => new Set(blocksOf(all).filter((b) => b.type === 'resource').map((b) => `${b.labels[0]}.${b.labels[1]}`));
  const privAddresses = addresses(priv);
  for (const a of addresses(pub)) if (privAddresses.has(a)) problems.push(`resource ${a} is also a private-module address`);
  const vars = (all) => blocksOf(all).filter((b) => b.type === 'variable' && !b.path).map((b) => b.labels[0]);
  const privVars = new Set(vars(priv));
  for (const v of vars(pub)) if (privVars.has(v) && !SHARED_INPUTS.includes(v)) problems.push(`the public module shares the private module's variable ${v}`);
  const privNames = namePrefixes(priv);
  for (const n of namePrefixes(pub)) for (const p of privNames) if (n.startsWith(p) || p.startsWith(n)) problems.push(`name "${p}" is shared with the private module (public "${n}")`);
  for (const scan of pub) {
    for (const a of scan.attributes) {
      for (const s of a.value.strings ?? []) if (/(^|\/)\.\.\/terraform(\/|$)|infra\/cloudflare\/terraform\//.test(s)) problems.push(`${scan.file}:${a.line}: references the private module's directory (${s})`);
    }
  }
  const cond = priv.flatMap((scan) => scan.attributes).find((a) => a.path === 'variable.access_mode/validation' && a.name === 'condition');
  if (!cond || /"public"/.test(cond.text)) problems.push('the private module\'s access_mode must not admit "public"');
  return problems;
}

test('[V2.1-04] public IaC: its own root module, only .tf files, the tfvars example and the pinned lockfile', () => {
  assert.deepEqual(FILES.public.filter((f) => !f.endsWith('.tf') && f !== EXAMPLE && f !== LOCKFILE), []);
  const pin = JSON.parse(readFileSync(join(REPO, 'infra/cloudflare/provider-lock.json'), 'utf8'));
  assert.equal(createHash('sha256').update(read('public', LOCKFILE)).digest('hex'), pin.sha256, 'the public lockfile is the one pinned provider lockfile, byte for byte');
  const example = scanHcl(read('public', EXAMPLE));
  assert.deepEqual(example.blocks, [], 'the tfvars example holds only assignments');
  for (const a of example.attributes) assert.ok(APPROVED_VARS.includes(a.name) && (!CREDENTIAL_ATTR.test(a.name) || NOT_SECRET_VARS.includes(a.name)), `tfvars example: ${a.name}`);
});

test('[V2.1-04] public IaC: only allowlisted blocks, attributes and bindings, with no Access and no credential', () => {
  assert.ok(scans('public').length >= 4, 'the gate reads the public .tf files');
  assert.deepEqual(publicViolations(scans('public')), []);
});

test('[V2.1-04] public and private modules share no resource, variable, name prefix, directory or state; the private module never admits public', () => {
  assert.deepEqual(separationProblems(scans('public'), scans('private')), []);
});

test('[V2.1-04] every planted public-target case and red control is refused for its own reason', () => {
  const problemsFor = (module, file, text) => {
    try {
      const pub = scans('public', module === 'public' ? { [file]: text } : {});
      const priv = scans('private', module === 'private' ? { [file]: text } : {});
      return [...publicViolations(pub), ...separationProblems(pub, priv)];
    } catch (err) {
      return [`parse: ${err.message}`];
    }
  };
  const missed = [];
  for (const c of PUBLIC_CASES) {
    const base = read(c.module, c.file);
    const text = c.mutate(base);
    if (text === base) { missed.push(`${c.id}: the payload no longer applies`); continue; }
    const problems = problemsFor(c.module, c.file, text);
    if (!problems.some((p) => c.reason.test(p))) missed.push(`${c.id}: expected ${c.reason}, got ${JSON.stringify(problems)}`);
  }
  for (const c of CONTROLS.filter((x) => x.file.startsWith(`${DIRS.public}/`))) {
    const src = readFileSync(join(REPO, c.file), 'utf8');
    if (!src.includes(c.find)) { missed.push(`${c.id}: its find string is no longer in ${c.file}`); continue; }
    if (!problemsFor('public', c.file.slice(DIRS.public.length + 1), src.replace(c.find, () => c.replace)).length) missed.push(`${c.id}: ${c.defect}`);
  }
  assert.deepEqual(missed, []);
});
