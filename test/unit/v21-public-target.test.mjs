// V2.1 slice 04: the structurally separate public target (mode (c), SPEC AP.4.0.4).
// - A public target shares no endpoint, credential, state, root, ledger or Worker-name
//   prefix with an access-controlled target (loadTargets).
// - The public Worker has no Access anywhere. Serving needs no identity; /_admin/* needs a
//   signed admin request, and every attack on the signature is refused.
// - It fails closed without its key or target ID, or with any Access setting. Private
//   mode never accepts a signature.
// - The classification guard keeps private-review and confidential packets off it.
// - Replays inside the window change nothing (shown here, not asserted).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { cloudflareAdapter } from '../../src/publication/adapters/cloudflare.mjs';
import { assertTargetAvailable } from '../../src/publication/policy.mjs';
import { promote, publish } from '../../src/publication/protocol.mjs';
import { generateSigningKey, parsePrivateKey } from '../../src/publication/signing.mjs';
import { adapterFor, loadTargets } from '../../src/publication/targets.mjs';
import { CloudflareHttpTransport } from '../../src/publication/transports/cloudflare-http.mjs';
import { canonicalAdminMessage } from '../../src/publication/worker/index.mjs';
import { tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';
import { workerDeployment } from '../v2/worker-bindings.mjs';
import { PUBLIC_TARGET_ID, publicDeployment } from '../v21/public-deployment.mjs';

const GRANTS = new Set(['upload', 'promote']);
const PUBLIC = { classification: 'public', dataOrigin: 'synthetic' };
const privateTarget = (extra = {}) => ({ name: 'cf:private', kind: 'mock-cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 10, credentialEnv: 'RP_CF_PRIVATE', stateDir: 'private-state', endpoint: 'https://rp-publisher-test.example.workers.dev', ...extra });
const publicTarget = (extra = {}) => ({ name: 'cf:public', kind: 'cloudflare', accessMode: 'public', targetId: PUBLIC_TARGET_ID, costCeilingUsdPerMonth: 10, credentialEnv: 'RP_CF_PUBLIC', stateDir: 'public-state', endpoint: 'https://rp-public-test.example.workers.dev', ...extra });

async function load(t, targets) {
  const dir = await tempDir(t, 'canon-v21-public');
  const file = join(dir, 'targets.json');
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets }));
  return loadTargets(file);
}

async function setup(t, { now } = {}) {
  const d = await publicDeployment({ now });
  const dir = await tempDir(t, 'canon-v21-public-worker');
  const target = publicTarget({ ledgerDir: join(dir, 'ledger') });
  const adapter = cloudflareAdapter({ transport: d.transport, credentials: d.credentials, kind: 'cloudflare', signer: (req) => d.sign(req) });
  return { d, dir, target, adapter, opts: { adapter, target, grants: GRANTS, retry: { sleep: async () => {} } } };
}

const errorOf = (res) => JSON.parse(res.body.toString('utf8')).error;

// ---- configuration separation ------------------------------------------------------------

test('[V2.1-04] a public target that shares nothing with a private target loads', async (t) => {
  const targets = await load(t, [privateTarget(), publicTarget()]);
  assert.deepEqual(targets.map((x) => x.name), ['cf:private', 'cf:public']);
});

test('[V2.1-04] a public target sharing any setting with a private target is refused, naming the setting', async (t) => {
  const cases = [
    ['endpoint', { endpoint: 'https://rp-publisher-test.example.workers.dev/other' }],
    ['credentialEnv', { credentialEnv: 'RP_CF_PRIVATE' }],
    ['stateDir', { stateDir: 'private-state' }],
    ['ledger', { stateDir: undefined, ledgerDir: 'private-state' }],
    ['worker name prefix', { endpoint: 'https://rp-publisher-test-public.example.workers.dev' }],
  ];
  for (const [setting, extra] of cases) {
    await assert.rejects(load(t, [privateTarget(), publicTarget(extra)]), (e) => e.code === 'invalid' && e.message.includes(`public target cf:public shares`) && e.message.includes(setting), setting);
  }
});

test('[V2.1-04] two private targets may share settings; the rule is only public against private', async (t) => {
  const targets = await load(t, [privateTarget(), privateTarget({ name: 'cf:private-2' })]);
  assert.equal(targets.length, 2);
});

test('[V2.1-04] public exists only as a real Cloudflare target, and it needs a targetId and a signing key alone', () => {
  assert.throws(() => assertTargetAvailable({ ...publicTarget(), kind: 'mock-cloudflare' }), { code: 'not-available' }, 'mock-cloudflare');
  assert.throws(() => assertTargetAvailable(publicTarget({ targetId: undefined })), (e) => e.code === 'invalid' && /needs a targetId/.test(e.message));
  const key = generateSigningKey();
  const env = (cred) => ({ RP_CF_PUBLIC: JSON.stringify(cred) });
  assert.throws(() => adapterFor(publicTarget(), { env: env({ privateKey: key.privateKey, clientSecret: 'x'.repeat(30) }), grants: GRANTS }), (e) => e.code === 'invalid' && /privateKey only/.test(e.message));
  assert.throws(() => adapterFor(publicTarget(), { env: env({ privateKey: 'not-a-key' }), grants: GRANTS }), (e) => e.code === 'invalid' && !e.message.includes('not-a-key'));
  const adapter = adapterFor(publicTarget(), { env: env({ privateKey: key.privateKey }), grants: GRANTS });
  assert.equal(adapter.describe().credentialClass, 'publisher-signing-key');
  assert.deepEqual(adapter.liveSecrets(), [key.privateKey]);
});

// ---- the public Worker: end to end -------------------------------------------------------

test('[V2.1-04] public target: publish, promote and rollback through signed admin requests; serving needs no identity', async (t) => {
  const { d, dir, opts } = await setup(t);
  const a = await syntheticPacket(dir, 'a', PUBLIC);
  const first = await publish({ ...opts, packetDir: a.dir });
  assert.equal(first.state, 'READBACK_VERIFIED');
  assert.equal((await promote({ ...opts, alias: 'public', contentId: a.contentId, expectGeneration: 0 })).record.generation, 1);
  const page = await d.send({ method: 'GET', path: `/p/${a.contentId}/index.html` });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'public, max-age=31536000, immutable');
  const alias = await d.send({ method: 'GET', path: '/a/public/' });
  assert.equal(alias.status, 307);
  assert.equal(alias.headers['cache-control'], 'no-store');
  assert.equal(d.certsFetched.length, 0, 'a public Worker never fetches Access keys');
});

test('[V2.1-04] public target refuses private-review and confidential packets, before any request and on promote', async (t) => {
  const { d, dir, opts } = await setup(t);
  for (const classification of ['private-review', 'confidential']) {
    const p = await syntheticPacket(dir, classification, { classification, dataOrigin: 'synthetic' });
    const before = d.transport.requests;
    await assert.rejects(publish({ ...opts, packetDir: p.dir }), { code: 'classification-refused' }, classification);
    assert.equal(d.transport.requests, before, `${classification}: no request was sent`);
  }
  const absent = await syntheticPacket(dir, 'absent', null);
  await assert.rejects(publish({ ...opts, packetDir: absent.dir }), { code: 'classification-refused' }, 'absent classification means private-review');
  // Defence in depth: a whole confidential packet that reached the bucket by other means
  // (raw signed PUTs, bypassing publish's guard) is still never promoted on the public target.
  const smuggled = await syntheticPacket(dir, 'smuggled', { classification: 'confidential', dataOrigin: 'synthetic' });
  const { readdir, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const types = Object.fromEntries(JSON.parse(await readFile(join(smuggled.dir, 'manifest.json'), 'utf8')).files.map((f) => [f.path, f.mediaType]));
  for (const rel of (await readdir(smuggled.dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name).slice(smuggled.dir.length + 1))) {
    const bytes = await readFile(join(smuggled.dir, rel));
    const path = `/_admin/objects/p/${smuggled.contentId}/${rel}`;
    const put = await d.send({ method: 'PUT', path, headers: { 'if-none-match': '*', 'x-rp-sha256': createHash('sha256').update(bytes).digest('hex'), 'content-type': types[rel] ?? 'application/json', ...d.sign({ method: 'PUT', path, body: bytes, contentType: types[rel] ?? 'application/json' }) }, body: bytes });
    assert.equal(put.status, 201, rel);
  }
  await assert.rejects(promote({ ...opts, alias: 'public', contentId: smuggled.contentId, expectGeneration: 0 }), { code: 'classification-refused' });
});

// ---- the signature contract: every attack refused ----------------------------------------

test('[V2.1-04] signed admin requests: missing, malformed, wrong-key, other-target, substituted and stale signatures are refused', async (t) => {
  const clock = { at: Date.parse('2026-09-30T02:00:00Z') };
  const { d } = await setup(t, { now: () => clock.at });
  const path = '/_admin/aliases';
  const ok = await d.send({ method: 'GET', path, headers: d.sign({ method: 'GET', path }) });
  assert.equal(ok.status, 200, 'the honest request is accepted (the attacks below are refused for their own reason)');
  const body = Buffer.from(JSON.stringify({ expectGeneration: 0, contentId: `sha256-${'a'.repeat(64)}` }));
  const substituted = Buffer.from(JSON.stringify({ expectGeneration: 0, contentId: `sha256-${'b'.repeat(64)}` }));
  assert.notDeepEqual(substituted, body, 'the substituted body really differs');
  const cas = '/_admin/aliases/public';
  const honestPost = await d.send({ method: 'POST', path: cas, body, headers: { 'content-type': 'application/json', ...d.sign({ method: 'POST', path: cas, body, contentType: 'application/json' }) } });
  assert.notEqual(honestPost.status, 403, 'the honest signed POST passes authentication (it may then fail on its content, 412)');
  const attacks = [
    ['no signature', { method: 'GET', path }, /no signature timestamp/],
    ['malformed signature', { method: 'GET', path, headers: { ...d.sign({ method: 'GET', path }), 'x-canon-signature': 'abc' } }, /no signature$/],
    ['wrong key', { method: 'GET', path, headers: d.sign({ method: 'GET', path }, { privateKey: d.other.privateKey }) }, /bad signature/],
    ['another target', { method: 'GET', path, headers: d.sign({ method: 'GET', path }, { targetId: 'rp-public-test-20260930-b2' }) }, /bad signature/],
    ['substituted body', { method: 'POST', path: cas, body: substituted, headers: { 'content-type': 'application/json', ...d.sign({ method: 'POST', path: cas, body, contentType: 'application/json' }) } }, /bad signature/],
    // N-V21-1: the content-type is signed, so a replay cannot change it.
    ['substituted content-type', { method: 'POST', path: cas, body, headers: { 'content-type': 'text/html', ...d.sign({ method: 'POST', path: cas, body, contentType: 'application/json' }) } }, /bad signature/],
    ['substituted path', { method: 'GET', path: '/_admin/aliases/public', headers: d.sign({ method: 'GET', path }) }, /bad signature/],
    ['substituted query', { method: 'GET', path: `${path}?x=1`, headers: d.sign({ method: 'GET', path }) }, /bad signature/],
    ['substituted method', { method: 'HEAD', path, headers: d.sign({ method: 'GET', path }) }, /bad signature/],
    ['stale timestamp', { method: 'GET', path, headers: d.sign({ method: 'GET', path }, { at: clock.at - 61_000 }) }, /outside the window/],
    ['future timestamp', { method: 'GET', path, headers: d.sign({ method: 'GET', path }, { at: clock.at + 61_000 }) }, /outside the window/],
  ];
  for (const [name, req, reason] of attacks) {
    const res = await d.send(req);
    assert.equal(res.status, 403, name);
    if (req.method !== 'HEAD') assert.match(errorOf(res), reason, name);
  }
  // The window's edge is inclusive: 60 s either way is accepted.
  for (const skew of [-60_000, 60_000]) assert.equal((await d.send({ method: 'GET', path, headers: d.sign({ method: 'GET', path }, { at: clock.at + skew }) })).status, 200, `skew ${skew}`);
});

test('[V2.1-04] an Access token or service-token header is refused on the public Worker, even beside a valid signature', async (t) => {
  const { d } = await setup(t);
  const path = '/_admin/aliases';
  for (const header of ['cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret']) {
    const res = await d.send({ method: 'GET', path, headers: { ...d.sign({ method: 'GET', path }), [header]: 'x'.repeat(40) } });
    assert.equal(res.status, 403, header);
    assert.match(errorOf(res), /Access credentials are not accepted/, header);
  }
});

test('[V2.1-04] the public Worker verifies the request target exactly as received, never a normalized one', async (t) => {
  const { d } = await setup(t);
  // A request object whose URL string is not in canonical form (a runtime that passed it
  // through unnormalized). The signature is over the raw string, and it is refused anyway,
  // because the route would act on a different (normalized) path.
  const raw = '/_admin/./aliases';
  const headers = new Headers(d.sign({ method: 'GET', path: raw }));
  const res = await d.worker.fetch({ url: `${d.origin}${raw}`, method: 'GET', headers, arrayBuffer: async () => new ArrayBuffer(0) }, d.env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /not in canonical form/);
  // The transport refuses to send such a path at all.
  const transport = new CloudflareHttpTransport({ endpoint: d.origin, fetchImpl: async () => { throw new Error('must not send'); } });
  await assert.rejects(transport.request({ method: 'GET', path: raw }), /not in canonical form/);
});

test('[V2.1-04] the public Worker fails closed: no key, no target ID, any Access setting, or an unknown MODE refuses every request', async (t) => {
  const { d, dir, opts } = await setup(t);
  const a = await syntheticPacket(dir, 'a', PUBLIC);
  await publish({ ...opts, packetDir: a.dir });
  const serving = { method: 'GET', path: `/p/${a.contentId}/index.html` };
  assert.equal((await d.send(serving)).status, 200);
  const broken = [
    ['no key', { PUBLISHER_PUBLIC_KEY: undefined }, /PUBLISHER_PUBLIC_KEY/],
    ['malformed key', { PUBLISHER_PUBLIC_KEY: 'canon-ed25519-pk:short' }, /PUBLISHER_PUBLIC_KEY/],
    ['no target id', { TARGET_ID: undefined }, /TARGET_ID/],
    ['TEAM_DOMAIN', { TEAM_DOMAIN: 'https://rp-test.cloudflareaccess.com' }, /Access configuration present/],
    ['POLICY_AUD', { POLICY_AUD: 'aud' }, /Access configuration present/],
    ['SERVICE_TOKEN_CLIENT_IDS', { SERVICE_TOKEN_CLIENT_IDS: 'id.access' }, /Access configuration present/],
    ['unknown MODE', { MODE: 'publik' }, /unknown MODE/],
  ];
  for (const [name, change, reason] of broken) {
    const env = { ...d.env, ...change };
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete env[k];
    for (const req of [serving, { method: 'GET', path: '/_admin/aliases', headers: d.sign({ method: 'GET', path: '/_admin/aliases' }) }]) {
      const res = await d.send(req, env);
      assert.equal(res.status, 403, `${name}: ${req.path}`);
      assert.match(errorOf(res), reason, name);
    }
  }
});

test('[V2.1-04] private mode never accepts a signature, even with a public key configured', async (t) => {
  const w = await workerDeployment();
  const pub = await publicDeployment();
  const path = '/_admin/aliases';
  for (const env of [w.env, { ...w.env, PUBLISHER_PUBLIC_KEY: pub.keys.publicKey, TARGET_ID: PUBLIC_TARGET_ID }]) {
    const res = await w.worker.fetch(new Request(`${w.origin}${path}`, { method: 'GET', headers: pub.sign({ method: 'GET', path }) }), env);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no Access token/);
  }
});

// ---- replay inside the window is harmless ------------------------------------------------

test('[V2.1-04] replayed signed requests change nothing: object puts, alias CAS and receipts', async (t) => {
  const { d, dir, opts } = await setup(t);
  const a = await syntheticPacket(dir, 'a', PUBLIC);
  const b = await syntheticPacket(dir, 'b', PUBLIC);
  await publish({ ...opts, packetDir: a.dir });
  await publish({ ...opts, packetDir: b.dir });
  // Record every signed request the publisher sends from here on, then replay them all.
  const sent = [];
  const recording = { get requests() { return d.transport.requests; }, async request(req) { sent.push(req); return d.transport.request(req); } };
  const adapter = cloudflareAdapter({ transport: recording, credentials: d.credentials, kind: 'cloudflare', signer: (req) => d.sign(req) });
  const ropts = { ...opts, adapter };
  const c = await syntheticPacket(dir, 'c', PUBLIC);
  await publish({ ...ropts, packetDir: c.dir });
  await promote({ ...ropts, alias: 'public', contentId: a.contentId, expectGeneration: 0 });
  await promote({ ...ropts, alias: 'public', contentId: b.contentId, expectGeneration: 1 });
  const snapshot = async () => ({ objects: [...d.env.PACKETS.objects].map(([k, o]) => [k, o.etag]).sort(), alias: await adapter.readAlias('public'), history: await adapter.readHistory('public') });
  const before = await snapshot();
  const statuses = { PUT: [], POST: [] };
  for (const req of sent.filter((r) => r.method === 'PUT' || r.method === 'POST')) statuses[req.method].push((await d.send(req)).status);
  assert.deepEqual(await snapshot(), before, 'no object, alias or history changed');
  assert.ok(statuses.PUT.every((s) => s === 200 || s === 409), `object and receipt replays are identical or refused: ${statuses.PUT}`);
  assert.ok(statuses.POST.length === 2 && statuses.POST.every((s) => s === 409 || s === 200), `alias replays: ${statuses.POST}`);
  assert.equal(before.alias.generation, 2, 'the replayed CAS moves never re-applied');
});

// ---- the canonical message --------------------------------------------------------------

test('[V2.1-04] the canonical message: versioned, target-bound, and no field can carry a line break', () => {
  const base = { targetId: PUBLIC_TARGET_ID, method: 'PUT', target: '/_admin/receipts/r1.json', bodySha256: 'a'.repeat(64), timestamp: 1790000000 };
  assert.equal(canonicalAdminMessage(base), ['canon-admin-sig/v1', PUBLIC_TARGET_ID, 'PUT', '/_admin/receipts/r1.json', '', 'a'.repeat(64), '1790000000'].join('\n'));
  assert.equal(canonicalAdminMessage({ ...base, contentType: 'application/json' }).split('\n')[4], 'application/json', 'the content-type is a field of its own');
  for (const bad of [{ targetId: 'x\ny' }, { method: 'PUT\n' }, { target: '/a\nb' }, { target: '/a b' }, { contentType: 'text/html\nx' }, { bodySha256: 'z' }, { timestamp: '1\n2' }]) {
    assert.throws(() => canonicalAdminMessage({ ...base, ...bad }), /malformed/, JSON.stringify(bad));
  }
  assert.throws(() => parsePrivateKey('canon-ed25519-sk:AAAA'), (e) => e.code === 'invalid' && !/AAAA/.test(e.message));
});

// ---- the signing key: generation and the secret gate -------------------------------------

test('[V2.1-04] keygen writes the key only to a new 0600 file outside the repository, or prints it once', async (t) => {
  const { main } = await import('../../scripts/public-target-keygen.mjs');
  const { readFile, stat } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { REPO } = await import('../helpers.mjs');
  const io = () => { const o = { out: '', err: '' }; return { o, streams: { stdout: { write: (s) => { o.out += s; } }, stderr: { write: (s) => { o.err += s; } } } }; };
  const dir = await tempDir(t, 'canon-v21-keygen');
  const path = join(dir, 'public-target.key.json');
  let r = io();
  assert.equal(main(['--out', path], r.streams), 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const cred = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(cred), ['privateKey']);
  const { publicKeyText } = await import('../../src/publication/signing.mjs');
  assert.equal(r.o.err.trim(), `publisher_public_key = "${publicKeyText(parsePrivateKey(cred.privateKey))}"`);
  assert.equal(r.o.out, '', 'nothing on stdout with --out');
  assert.ok(!r.o.err.includes(cred.privateKey), 'the private key is never echoed');
  r = io();
  assert.equal(main(['--out', path], r.streams), 1, 'an existing key is never overwritten');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).privateKey, cred.privateKey);
  const inRepo = join(REPO, 'test', 'public-target.key.json');
  r = io();
  assert.equal(main(['--out', inRepo], r.streams), 1, 'inside the repository is refused');
  assert.match(r.o.err, /inside the repository/);
  assert.equal(existsSync(inRepo), false);
  r = io();
  assert.equal(main(['--print-once'], r.streams), 0);
  assert.ok(parsePrivateKey(JSON.parse(r.o.out).privateKey));
  for (const bad of [[], ['--out'], ['--print-once', 'x'], ['--nope']]) assert.equal(main(bad, io().streams), 2, JSON.stringify(bad));
});

test('[V2.1-04] the secret gate knows the publisher signing key, in its own format and as raw PKCS#8', async () => {
  const { instrumentCheck, scanText } = await import('../../scripts/secret-gate.mjs');
  assert.deepEqual(instrumentCheck(), [], 'every family catches its plant');
  const key = generateSigningKey();
  assert.deepEqual(scanText(JSON.stringify({ privateKey: key.privateKey })).map((f) => f.family), ['publisher-signing-key']);
  const der = parsePrivateKey(key.privateKey).export({ format: 'der', type: 'pkcs8' });
  for (const text of [der.toString('base64'), der.toString('base64url')]) assert.deepEqual(scanText(`key: ${text}`).map((f) => f.family), ['publisher-signing-key']);
  assert.deepEqual(scanText(`publisher_public_key = "${key.publicKey}"`), [], 'the public key is not a secret');
  // An RPK-era private key file may still exist on disk: the fixed PKCS#8 DER header still catches it.
  const legacy = key.privateKey.replace(/^canon-ed25519-sk:/, 'rpk-ed25519-sk:');
  assert.notEqual(legacy, key.privateKey);
  assert.deepEqual(scanText(JSON.stringify({ privateKey: legacy })).map((f) => f.family), ['publisher-signing-key']);
});

// ---- the caching and deletion story (SPEC AP.4.0.4 proof contract) ----------------------

test('[V2.1-04] the caching and deletion story is documented: immutable for a year, no recall, irreversible, a named decision', async () => {
  const { readFileSync } = await import('node:fs');
  const { REPO } = await import('../helpers.mjs');
  const runbook = readFileSync(join(REPO, 'docs/v2/cloudflare/runbook-public.md'), 'utf8');
  const threat = readFileSync(join(REPO, 'docs/v2/threat-model.md'), 'utf8');
  const section = runbook.slice(runbook.indexOf('## Caching and deletion'), runbook.indexOf('## Teardown'));
  for (const claim of [
    '**Publishing to the public target is irreversible in practice.**',
    '`public, max-age=31536000, immutable`',
    'No provider action can recall a copy fetched by a third party.',
    '**Aliases** are `no-store` redirects',
    '**The publisher has no delete, purge or invalidation path.**',
  ]) assert.ok(section.includes(claim), `runbook-public Caching and deletion: ${claim}`);
  assert.match(runbook, /\| P-b \| Publishing public is irreversible in practice/, 'the irreversibility is a named decision before the first upload');
  const t5 = threat.slice(threat.indexOf('## T5.'), threat.indexOf('## T6.'));
  assert.ok(t5.includes('**nothing recalls a copy already taken: publishing public is irreversible in practice.**'), 'threat model T5 states it');
  assert.ok(threat.includes('## T9. The public target\'s write path (V2.1 slice 04)'), 'threat model T9 exists');
});

// N-V21-2: the separation compares directories as the filesystem resolves them.
test('[V2.1-04] a public stateDir that is a symlink to the private stateDir is refused', async (t) => {
  const { mkdir, symlink, writeFile } = await import('node:fs/promises');
  const dir = await tempDir(t, 'canon-v21-public-symlink');
  await mkdir(join(dir, 'private-state'));
  await symlink(join(dir, 'private-state'), join(dir, 'public-link'));
  const file = join(dir, 'targets.json');
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [privateTarget(), publicTarget({ stateDir: 'public-link' })] }));
  await assert.rejects(loadTargets(file), (e) => e.code === 'invalid' && /public target cf:public shares [^.]*stateDir/.test(e.message));
  // A stateDir that does not exist yet still resolves through its existing ancestor.
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [privateTarget(), publicTarget({ stateDir: 'public-link/sub', ledgerDir: 'l-pub' }), privateTarget({ name: 'cf:private-2', stateDir: 'private-state/sub', credentialEnv: 'RP_CF_PRIVATE', endpoint: 'https://rp-publisher-test.example.workers.dev' })] }));
  await assert.rejects(loadTargets(file), (e) => e.code === 'invalid' && /stateDir/.test(e.message));
});

// V2.1-QA-1: the public runbook reads receipts back during the run, with signed requests.
test('[V2.1-04] the public runbook reads every receipt back during the run with signed requests; both runbooks go live only with --live', async () => {
  const { readFileSync } = await import('node:fs');
  const { REPO } = await import('../helpers.mjs');
  const pub = readFileSync(join(REPO, 'docs/v2/cloudflare/runbook-public.md'), 'utf8');
  const priv = readFileSync(join(REPO, 'docs/v2/cloudflare/runbook.md'), 'utf8');
  const section = pub.slice(pub.indexOf('## Evidence capture: receipt read-back'), pub.indexOf('## Public deploy token scopes'));
  assert.ok(section.includes('`node scripts/cf-receipts.mjs --targets <targets.cf.json> --target cf-public --out <evidence> --ids-from <the publisher\'s output> --live`'), 'the read-back command, by target');
  assert.ok(section.includes('**signed admin request**'), 'signed, not Access');
  assert.ok(section.includes('After **every** upload and promote'), 'during the run, every operation');
  assert.match(priv, /cf-receipts\.mjs --endpoint https:\/\/rp-publisher-test\.<sub>\.workers\.dev --out <evidence> --ids-from <the publisher's output> --live`/, 'the private read-back goes live only with --live');
});

// N-V21-1: the signed message is canon-admin-sig/v1 (content-type bound). A signature over any
// earlier message format (RPK-era rpk-admin-sig/v1 without content-type, rpk-admin-sig/v2 with it),
// made with the right key, target and timestamp, is REFUSED.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
for (const [legacy, fields] of [
  ['rpk-admin-sig/v1', (path, ts) => ['rpk-admin-sig/v1', PUBLIC_TARGET_ID, 'GET', path, EMPTY_SHA256, ts]],
  ['rpk-admin-sig/v2', (path, ts) => ['rpk-admin-sig/v2', PUBLIC_TARGET_ID, 'GET', path, '', EMPTY_SHA256, ts]],
]) {
  test(`[V2.1-04] a signature over the old ${legacy} message is refused, even with the right key`, async (t) => {
    const { d } = await setup(t);
    const { sign } = await import('node:crypto');
    const path = '/_admin/aliases';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = fields(path, timestamp).join('\n');
    const headers = { 'x-canon-timestamp': timestamp, 'x-canon-signature': sign(null, Buffer.from(message), parsePrivateKey(d.credentials.privateKey)).toString('base64url') };
    const res = await d.send({ method: 'GET', path, headers });
    assert.equal(res.status, 403);
    assert.match(errorOf(res), /bad signature/);
    assert.equal((await d.send({ method: 'GET', path, headers: d.sign({ method: 'GET', path }) })).status, 200, 'the same request signed as canon-admin-sig/v1 is accepted');
  });
}

// Clean cut: the RPK-era header and key names are not read, even when what they carry is valid.
test('[V2.1-04] RPK-era header and key names are refused: x-rpk-* headers, an rpk-ed25519-pk: publisher key, an rpk-ed25519-sk: private key', async (t) => {
  const { d } = await setup(t);
  const path = '/_admin/aliases';
  const good = d.sign({ method: 'GET', path });
  assert.equal((await d.send({ method: 'GET', path, headers: good })).status, 200, 'control: the canon headers are accepted');
  const legacyHeaders = { 'x-rpk-timestamp': good['x-canon-timestamp'], 'x-rpk-signature': good['x-canon-signature'] };
  assert.equal((await d.send({ method: 'GET', path, headers: legacyHeaders })).status, 403, 'the same signature under x-rpk-* headers');
  const legacyEnv = { ...d.env, PUBLISHER_PUBLIC_KEY: d.keys.publicKey.replace(/^canon-ed25519-pk:/, 'rpk-ed25519-pk:') };
  assert.notEqual(legacyEnv.PUBLISHER_PUBLIC_KEY, d.keys.publicKey, 'the legacy key is a real rename');
  const res = await d.send({ method: 'GET', path, headers: good }, legacyEnv);
  assert.notEqual(res.status, 200, 'a Worker configured with an rpk-ed25519-pk: key serves no admin request');
  const legacyPrivate = d.keys.privateKey.replace(/^canon-ed25519-sk:/, 'rpk-ed25519-sk:');
  assert.notEqual(legacyPrivate, d.keys.privateKey);
  assert.throws(() => parsePrivateKey(legacyPrivate), (e) => e.code === 'invalid', 'an rpk-ed25519-sk: private key is not parsed');
});

// N-V21-6 / N-V21-7: paths are compared canonically. A symlink, a case variant (on a case-insensitive
// volume) and a missing leaf under an existing parent all name the directory they resolve to.
test('[V2.1-04] canonical paths: a case variant, a symlink and a missing leaf resolve to the directory they name', async (t) => {
  const { canonicalPath, caseInsensitiveAt } = await import('../../src/publication/paths.mjs');
  const { mkdir, symlink } = await import('node:fs/promises');
  const { realpathSync } = await import('node:fs');
  const dir = realpathSync.native(await tempDir(t, 'canon-v21-canon'));
  await mkdir(join(dir, 'Private-State'));
  await symlink(join(dir, 'Private-State'), join(dir, 'link'));
  const insensitive = caseInsensitiveAt(dir);
  assert.equal(caseInsensitiveAt(join(dir, 'link')), insensitive, 'the probe answers the same through a symlinked spelling of a directory');
  assert.equal(insensitive, process.platform === 'darwin', 'this host\'s volume is probed correctly (APFS default: case-insensitive)');
  assert.equal(canonicalPath(join(dir, 'link')), join(dir, 'Private-State'), 'symlink');
  if (insensitive) {
    assert.equal(canonicalPath(join(dir, 'PRIVATE-STATE')), join(dir, 'Private-State'), 'case variant, existing');
    assert.equal(canonicalPath(join(dir, 'PRIVATE-STATE', 'Sub', 'KEY.json')), canonicalPath(join(dir, 'private-state', 'sub', 'key.json')), 'case variant, missing leaf');
  }
});

test('[V2.1-04] a public stateDir that is a case variant of the private stateDir is refused (N-V21-6), existing or not yet created', async (t) => {
  const { caseInsensitiveAt } = await import('../../src/publication/paths.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await tempDir(t, 'canon-v21-public-case');
  await mkdir(join(dir, 'private-state'));
  const file = join(dir, 'targets.json');
  const load2 = async (pubState, privState) => {
    await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [privateTarget({ stateDir: privState }), publicTarget({ stateDir: pubState, ledgerDir: 'l-pub' })] }));
    return loadTargets(file);
  };
  if (caseInsensitiveAt(dir)) {
    await assert.rejects(load2('PRIVATE-STATE', 'private-state'), (e) => e.code === 'invalid' && /shares [^.]*stateDir/.test(e.message), 'existing directory');
    await assert.rejects(load2('PRIVATE-STATE/SUB', 'private-state/sub'), (e) => e.code === 'invalid' && /shares [^.]*stateDir/.test(e.message), 'missing leaf');
  } else {
    await load2('PRIVATE-STATE', 'private-state');
  }
});

test('[V2.1-04] keygen refuses a key path inside the repository by case variant, symlink or missing leaf, and inside any git worktree (N-V21-7)', async (t) => {
  const { main } = await import('../../scripts/public-target-keygen.mjs');
  const { caseInsensitiveAt } = await import('../../src/publication/paths.mjs');
  const { REPO } = await import('../helpers.mjs');
  const { existsSync, realpathSync } = await import('node:fs');
  const { mkdir, symlink } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const quiet = { stdout: { write: () => {} }, stderr: { write: () => {} } };
  const err = () => { const o = { text: '' }; return { o, streams: { stdout: { write: () => {} }, stderr: { write: (s) => { o.text += s; } } } }; };
  const repo = realpathSync.native(REPO);
  const tried = [];
  // A case variant of the repository path (flip the first letter of its last segment).
  const flipped = join(repo.slice(0, repo.lastIndexOf('/') + 1) + repo.slice(repo.lastIndexOf('/') + 1).replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())), 'test', 'k1.json');
  if (caseInsensitiveAt(repo)) tried.push(['case variant', flipped]);
  tried.push(['missing leaf', join(repo, 'no-such-dir', 'deeper', 'k2.json')]);
  // A regressed keygen would WRITE a real key at these paths (inside the repository): remove any it
  // wrote, so a failing run never leaves a key behind (the assertions below still fail).
  const { rmSync } = await import('node:fs');
  t.after(() => { for (const [, path] of tried) rmSync(path, { force: true }); });
  const outside = await tempDir(t, 'canon-v21-keygen-canon');
  await symlink(repo, join(outside, 'into-repo'));
  tried.push(['symlink into the repo', join(outside, 'into-repo', 'test', 'k3.json')]);
  for (const [name, path] of tried) {
    const r = err();
    assert.equal(main(['--out', path], r.streams), 1, name);
    assert.match(r.o.text, /inside the repository/, name);
    assert.equal(existsSync(path), false, `${name}: nothing written`);
  }
  // Another git worktree (not this repository): refused by asking git, not by path prefix.
  const other = join(outside, 'other-repo');
  await mkdir(other);
  assert.equal(spawnSync('git', ['init', '-q', other]).status, 0);
  const r = err();
  assert.equal(main(['--out', join(other, 'nested', 'k4.json')], r.streams), 1);
  assert.match(r.o.text, /inside a git worktree/);
  assert.equal(main(['--out', join(outside, 'plain', 'k5.json')], quiet), 1, 'a missing parent outside any repository cannot be created (exclusive create), and nothing is written');
});
