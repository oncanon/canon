// Machine profile, alias catalog (`alias list`), and status introspection (`canon status`).
// Authority contract: `~/.canon/profile.json` (or `$CANON_HOME/profile.json`) is
// owned exclusively by the operator / Menu Bar app. Agents read status and catalog, and
// mutate artifacts/aliases in the store, without ever mutating exposure policy or server state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { listAliases, setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { activeVisibilityFromService, defaultHomeDir, loadProfile, preferredBaseUrlFromService, ProfileError } from '../../src/profile.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { stop as serviceStop } from '../../src/service.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { verifySiteBundle } from '../../src/site/verify.mjs';
import { CLI, REPO } from '../helpers.mjs';

const REPORT_FIXTURE = join(REPO, 'fixtures/report/phase1-review.report.json');
const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

test('[PROFILE-1] listAliases returns empty array on fresh store, sorts records, resolves packet/v1 and site-bundle/v1 metadata, and fails closed on corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-alias-list-'));
  try {
    const storeRoot = join(dir, 'store');
    assert.deepEqual(await listAliases(storeRoot), []);

    const pktOut = join(dir, 'pkt');
    const siteOut = join(dir, 'site');
    const pkt = await buildPacket({ reportPath: REPORT_FIXTURE, outDir: pktOut });
    const site = await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir: siteOut });
    await publishPacket({ packetDir: pktOut, root: storeRoot });
    await publishPacket({ packetDir: siteOut, root: storeRoot });

    await setAlias({ root: storeRoot, name: 'zeta-sitrep', contentId: site.contentId, expectGeneration: 0 });
    await setAlias({ root: storeRoot, name: 'alpha-review', contentId: pkt.contentId, expectGeneration: 0 });
    // Leave a benign lock/temp file to verify non-.json artifacts are ignored by listAliases
    await writeFile(join(storeRoot, 'aliases', 'alpha-review.lock'), '123\n');

    const listed = await listAliases(storeRoot);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((a) => a.name), ['alpha-review', 'zeta-sitrep']);

    assert.equal(listed[0].generation, 1);
    assert.equal(listed[0].contentId, pkt.contentId);
    assert.equal(listed[0].artifactSchema, 'packet/v1');
    assert.equal(listed[0].entry, 'index.html');
    assert.equal(listed[0].agentEntry, 'report.md');
    assert.match(listed[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(listed[1].generation, 1);
    assert.equal(listed[1].contentId, site.contentId);
    assert.equal(listed[1].artifactSchema, 'site-bundle/v1');
    assert.equal(listed[1].entry, 'index.html');
    assert.equal(listed[1].agentEntry, 'index.md');

    // Corrupting an alias JSON file must fail closed rather than silently hiding it
    await writeFile(join(storeRoot, 'aliases', 'broken.json'), '{not-json');
    await assert.rejects(() => listAliases(storeRoot), /alias-corrupt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[PROFILE-2] loadProfile enforces closed schema, exposure modes, and Tailscale node expectations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-profile-val-'));
  try {
    // Missing profile returns null
    assert.equal(await loadProfile(dir), null);

    const writeProf = (obj) => writeFile(join(dir, 'profile.json'), `${JSON.stringify(obj, null, 2)}\n`);

    // Valid tailscale profile
    await writeProf({
      schema: 'profile/v1',
      exposure: 'tailscale',
      port: 8791,
      storeRoot: join(dir, 'store'),
      stateDir: join(dir, 'service'),
      buildsDir: join(dir, 'builds'),
      tailscale: {
        address: '100.64.0.33',
        name: 'node-a.example-tailnet.ts.net',
      },
    });
    const loaded = await loadProfile(dir);
    assert.equal(loaded.exposure, 'tailscale');
    assert.equal(loaded.tailscale.name, 'node-a.example-tailnet.ts.net');

    // Closed schema: unknown member rejected
    await writeProf({
      schema: 'profile/v1',
      exposure: 'local',
      port: 8791,
      storeRoot: join(dir, 'store'),
      stateDir: join(dir, 'service'),
      buildsDir: join(dir, 'builds'),
      extraField: true,
    });
    await assert.rejects(() => loadProfile(dir), ProfileError);

    // Tailscale exposure without pinned tailscale node rejected
    await writeProf({
      schema: 'profile/v1',
      exposure: 'tailscale',
      port: 8791,
      storeRoot: join(dir, 'store'),
      stateDir: join(dir, 'service'),
      buildsDir: join(dir, 'builds'),
    });
    await assert.rejects(() => loadProfile(dir), ProfileError);

    // Invalid exposure enum rejected
    await writeProf({
      schema: 'profile/v1',
      exposure: 'public-internet',
      port: 8791,
      storeRoot: join(dir, 'store'),
      stateDir: join(dir, 'service'),
      buildsDir: join(dir, 'builds'),
    });
    await assert.rejects(() => loadProfile(dir), ProfileError);

    // Service URL preference selects MagicDNS hostname over bare IP when Tailscale is bound
    const tailnetState = {
      state: 'running',
      url: 'http://100.64.0.33:8791',
      urls: ['http://100.64.0.33:8791', 'http://node-a.example-tailnet.ts.net:8791'],
    };
    assert.equal(preferredBaseUrlFromService(tailnetState), 'http://node-a.example-tailnet.ts.net:8791');
    assert.equal(activeVisibilityFromService(tailnetState), 'tailscale');

    const localState = {
      state: 'running',
      url: 'http://127.0.0.1:8791',
      urls: ['http://127.0.0.1:8791'],
    };
    assert.equal(preferredBaseUrlFromService(localState), 'http://127.0.0.1:8791');
    assert.equal(activeVisibilityFromService(localState), 'local');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[PROFILE-3] CLI profile defaults, canon status, canon alias list, and non-escalation authority boundary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'canon-home-cli-'));
  const port = await freePort();
  const storeRoot = join(home, 'store');
  const stateDir = join(home, 'service');
  const buildsDir = join(home, 'builds');
  const env = { ...process.env, CANON_HOME: home, CANON_LOOPBACK_ONLY: '1' };
  const runCli = (args, customEnv = env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: customEnv });

  try {
    // 1. Without profile.json and without --root/--store, commands fail closed with exit 2
    assert.equal(runCli(['status']).status, 2);
    assert.equal(runCli(['alias', 'list']).status, 2);
    assert.equal(runCli(['brief', REPORT_FIXTURE, '--alias', 'no-prof']).status, 2);

    // 2. Agents have no CLI command to mutate profile/exposure policy
    assert.equal(runCli(['profile', 'set', 'tailscale']).status, 2);

    // 3. Operator writes profile.json with exposure: "stopped"
    await mkdir(home, { recursive: true });
    const profilePath = join(home, 'profile.json');
    const profileObj = {
      schema: 'profile/v1',
      exposure: 'stopped',
      port,
      storeRoot,
      stateDir,
      buildsDir,
    };
    const originalProfileBytes = `${JSON.stringify(profileObj, null, 2)}\n`;
    await writeFile(profilePath, originalProfileBytes);

    // 4. canon status reports stopped service and empty aliases
    const st1 = runCli(['status']);
    assert.equal(st1.status, 0, st1.stderr);
    const st1Json = JSON.parse(st1.stdout);
    assert.equal(st1Json.profile.configured, true);
    assert.equal(st1Json.profile.exposure, 'stopped');
    assert.equal(st1Json.service.state, 'stopped');
    assert.equal(st1Json.service.preferredBaseUrl, null);
    assert.deepEqual(st1Json.aliases, []);

    // 5. Agent publishes via `canon brief` using profile defaults (no --store flag).
    //    Crucially, publishing NEVER starts a stopped server or alters profile.json!
    const rev = runCli(['brief', REPORT_FIXTURE, '--alias', 'arch-audit']);
    assert.equal(rev.status, 0, rev.stderr);
    const revJson = JSON.parse(rev.stdout);
    assert.equal(revJson.alias.name, 'arch-audit');
    assert.equal(revJson.alias.generation, 1);
    assert.equal(revJson.urls, null, 'stopped server yields urls: null rather than auto-starting');
    assert.equal(await readFile(profilePath, 'utf8'), originalProfileBytes, 'profile.json untouched by agent');

    const stAfterStoppedPub = JSON.parse(runCli(['status']).stdout);
    assert.equal(stAfterStoppedPub.service.state, 'stopped', 'agent publish must not start listener');
    assert.equal(stAfterStoppedPub.aliases.length, 1);
    assert.equal(stAfterStoppedPub.aliases[0].name, 'arch-audit');

    // 6. Operator switches profile to local and starts service
    profileObj.exposure = 'local';
    await writeFile(profilePath, `${JSON.stringify(profileObj, null, 2)}\n`);
    const started = runCli(['service', 'start', '--root', storeRoot, '--state-dir', stateDir, '--port', String(port)]);
    assert.equal(started.status, 0, started.stderr);

    // 7. canon status and canon alias list reflect live listener + aliases
    const stLive = runCli(['status']);
    assert.equal(stLive.status, 0, stLive.stderr);
    const stLiveJson = JSON.parse(stLive.stdout);
    assert.equal(stLiveJson.service.state, 'running');
    assert.equal(stLiveJson.service.preferredBaseUrl, `http://127.0.0.1:${port}`);

    const alLive = runCli(['alias', 'list']);
    assert.equal(alLive.status, 0, alLive.stderr);
    const alLiveJson = JSON.parse(alLive.stdout);
    assert.equal(alLiveJson.length, 1);
    assert.equal(alLiveJson[0].name, 'arch-audit');

    // 8. Agent runs `canon sitrep` without --store; receives live verified URLs
    const sr = runCli(['sitrep', SITE_FIXTURE, '--alias', 'ops-sitrep']);
    assert.equal(sr.status, 0, sr.stderr);
    const srJson = JSON.parse(sr.stdout);
    assert.equal(srJson.urls.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(srJson.urls.humanAlias, `http://127.0.0.1:${port}/a/ops-sitrep/`);
    assert.equal(srJson.urls.agentAlias, `http://127.0.0.1:${port}/a/ops-sitrep/index.md`);

    const respHtml = await fetch(srJson.urls.humanAlias);
    assert.equal(respHtml.status, 200);
    const respMd = await fetch(srJson.urls.agentAlias);
    assert.equal(respMd.status, 200);
    assert.match(respMd.headers.get('content-type'), /^text\/markdown/);
    assert.equal(srJson.urls.visibility, 'local');
  } finally {
    await serviceStop({ stateDir }).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

function extractTaggedJsonBlock(markdown, tag) {
  const re = new RegExp(`<!--\\s*${tag}\\s*-->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``);
  const match = markdown.match(re);
  assert.ok(match, `expected tagged JSON block <!-- ${tag} --> in skill reference`);
  return match[1];
}

test('[PROFILE-4] skill schema reference skeletons build and verify cleanly through packet/v1 and site-bundle/v1 validators', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-skill-skeleton-'));
  try {
    const refsDir = join(REPO, 'skills/canon/references');
    const reportMd = await readFile(join(refsDir, 'report-v1-schema.md'), 'utf8');
    const siteMd = await readFile(join(refsDir, 'site-input-v1-schema.md'), 'utf8');

    const reportSkeleton = extractTaggedJsonBlock(reportMd, 'minimal-report-v1');
    const siteSkeleton = extractTaggedJsonBlock(siteMd, 'minimal-site-input-v1');

    // Write referenced evidence file alongside each skeleton and execute real builders + verifiers
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'check.txt'), 'exit=0 ok\n');

    const reportPath = join(dir, 'minimal.report.json');
    await writeFile(reportPath, `${reportSkeleton}\n`);
    const pktOut = join(dir, 'out-packet');
    await buildPacket({ reportPath, outDir: pktOut });
    const pktVerified = await verifyPacket(pktOut);
    assert.equal(pktVerified.ok, true, JSON.stringify(pktVerified.errors));

    const sitePath = join(dir, 'minimal.site-input.json');
    await writeFile(sitePath, `${siteSkeleton}\n`);
    const siteOut = join(dir, 'out-site');
    await buildSiteBundle({ sitePath, outDir: siteOut });
    const siteVerified = await verifySiteBundle(siteOut);
    assert.equal(siteVerified.ok, true, JSON.stringify(siteVerified.errors));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[PROFILE-5] explicit --store / --root bypasses corrupt or unreadable $CANON_HOME/profile.json while implicit profile calls fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-explicit-override-'));
  const home = join(dir, 'home');
  const customStore = join(dir, 'custom-store');
  const customState = join(dir, 'custom-service');
  const env = { ...process.env, CANON_HOME: home };
  const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

  try {
    await mkdir(home, { recursive: true });
    const profilePath = join(home, 'profile.json');

    // 1. Corrupt profile.json: implicit commands fail closed (exit 1), explicit --store/--root succeed (exit 0)
    await writeFile(profilePath, '{corrupt-json\n');
    assert.equal(runCli(['status']).status, 1);
    assert.equal(runCli(['brief', REPORT_FIXTURE, '--alias', 'implicit-fail']).status, 1);
    assert.equal(runCli(['sitrep', SITE_FIXTURE, '--alias', 'implicit-fail']).status, 1);

    const revExplicit = runCli(['brief', REPORT_FIXTURE, '--store', customStore, '--alias', 'exp-rev']);
    assert.equal(revExplicit.status, 0, revExplicit.stderr);
    assert.equal(JSON.parse(revExplicit.stdout).urls, null);

    const sitExplicit = runCli(['sitrep', SITE_FIXTURE, '--store', customStore, '--alias', 'exp-sit']);
    assert.equal(sitExplicit.status, 0, sitExplicit.stderr);
    assert.equal(JSON.parse(sitExplicit.stdout).urls, null);

    const stExplicit = runCli(['status', '--root', customStore, '--state-dir', customState]);
    assert.equal(stExplicit.status, 0, stExplicit.stderr);
    const stJson = JSON.parse(stExplicit.stdout);
    assert.equal(stJson.aliases.length, 2);

    // 2. Unreadable profile.json (0o000 / EACCES, analogous to sandbox EPERM): explicit --store still succeeds
    await chmod(profilePath, 0o000);
    const revUnreadable = runCli(['brief', REPORT_FIXTURE, '--store', customStore, '--alias', 'exp-rev']);
    assert.equal(revUnreadable.status, 0, revUnreadable.stderr);
  } finally {
    await chmod(join(home, 'profile.json'), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('[PROFILE-6] Canon primary CLI (`canon brief`) and `CANON_HOME` priority; no Folio/RPK homes and no `review` shim', async () => {
  assert.equal(defaultHomeDir({ CANON_HOME: '/tmp/canon-a' }), '/tmp/canon-a');
  // Clean cut: the Folio/RPK home variables are not read.
  assert.match(defaultHomeDir({ FOLIO_HOME: '/tmp/folio-a', RPK_HOME: '/tmp/rpk-b' }), /\/\.canon$/);
  assert.match(defaultHomeDir({}), /\/\.canon$/);
  // ...and ~/.folio is not a fallback: under a HOME that holds only a Folio home, the default is still ~/.canon.
  const fakeHome = await mkdtemp(join(tmpdir(), 'canon-fake-home-'));
  try {
    await mkdir(join(fakeHome, '.folio'));
    await writeFile(join(fakeHome, '.folio', 'profile.json'), '{}');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import { defaultHomeDir } from ${JSON.stringify(pathToFileURL(join(REPO, 'src/profile.mjs')).href)}; process.stdout.write(defaultHomeDir({}));`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome } });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, join(fakeHome, '.canon'), 'a HOME with only ~/.folio still defaults to ~/.canon');
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }

  const home = await mkdtemp(join(tmpdir(), 'canon-home-cli-'));
  const env = { ...process.env, CANON_HOME: home };
  const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

  try {
    const help = runCli([]);
    assert.equal(help.status, 2);
    assert.match(help.stderr, /canon brief <report\.json>/);
    assert.match(help.stderr, /canon sitrep <site-input\.json>/);

    await writeFile(join(home, 'profile.json'), `${JSON.stringify({
      schema: 'profile/v1',
      exposure: 'stopped',
      port: 8791,
      storeRoot: join(home, 'store'),
      stateDir: join(home, 'service'),
      buildsDir: join(home, 'builds'),
    }, null, 2)}\n`);

    const briefRes = runCli(['brief', REPORT_FIXTURE, '--alias', 'canon-brief-smoke']);
    assert.equal(briefRes.status, 0, briefRes.stderr);
    const briefJson = JSON.parse(briefRes.stdout);
    assert.equal(briefJson.alias.name, 'canon-brief-smoke');
    assert.equal(briefJson.alias.generation, 1);

    // Clean cut: the RPK-era `review` alias is gone; it is an unknown command (usage error).
    const revGone = runCli(['review', REPORT_FIXTURE, '--alias', 'canon-brief-smoke']);
    assert.equal(revGone.status, 2, revGone.stderr);
    assert.doesNotMatch(help.stderr, /canon review/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
