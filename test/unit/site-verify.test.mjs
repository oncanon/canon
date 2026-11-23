// Slice S4: independent site-bundle/v1 verifier, filesystem publisher and server integration
// (docs/projects/interactive-sitrep-contract.md, revision 4).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setAlias } from '../../src/alias/alias.mjs';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../../src/hash.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { verifyArtifact, verifySiteBundle } from '../../src/site/verify.mjs';
import { CLI, REPO } from '../helpers.mjs';

const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');
const REPORT_FIXTURE = join(REPO, 'fixtures/report/phase1-review.report.json');

let builtFixture;

test.before(async () => {
  builtFixture = await buildSiteBundle({ sitePath: SITE_FIXTURE });
});

async function writeBundle(outputMap, mutateFiles = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'canon-site-s4-'));
  const bundleDir = join(root, 'bundle');
  await mkdir(bundleDir, { recursive: true });
  for (const [rel, bytes] of outputMap) {
    const abs = join(bundleDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
  await mutateFiles(bundleDir);
  return { root, bundleDir };
}

// Recompute manifest.json and checksums.json after an intentional page mutation so the
// test isolates the structural/policy verifier check rather than failing on sha256 first.
async function resealBundle(bundleDir, mutateManifest = () => {}) {
  const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const bytes = await readFile(join(bundleDir, entry.path));
    entry.bytes = bytes.length;
    entry.sha256 = sha256Hex(bytes);
  }
  mutateManifest(manifest);
  const { contentId: _old, ...identity } = manifest;
  const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
  const nextManifest = { ...identity, contentId };
  const manifestBytes = canonicalBytes(nextManifest);
  const checksums = {
    schema: 'checksums/v1',
    algorithm: 'sha256',
    contentId,
    manifestSha256: sha256Hex(manifestBytes),
    files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
  };
  await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
  await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
  return contentId;
}

test('[SITE-S4] a valid built site-bundle/v1 passes verifySiteBundle and verifyArtifact', async () => {
  const { root, bundleDir } = await writeBundle(builtFixture.output);
  try {
    const res = await verifySiteBundle(bundleDir);
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(res.contentId, builtFixture.contentId);
    assert.equal(res.recomputedContentId, builtFixture.contentId);

    const viaDispatch = await verifyArtifact(bundleDir);
    assert.equal(viaDispatch.ok, true);
    assert.equal(viaDispatch.contentId, builtFixture.contentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[SITE-S4] P9 tamper rejection: corrupted byte, missing file, extra file, non-canonical JSON, wrong contentId, and checksums mismatch all fail', async () => {
  // 1. Corrupted byte in an HTML page
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'area/platform/index.html');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, `${cur}<!-- tampered -->`);
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // 2. Missing file
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      await rm(join(dir, 'area/platform/index.md'));
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'missing-file' && e.path === 'area/platform/index.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // 3. Extra uninventoried file
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      await writeFile(join(dir, 'stray.txt'), 'untracked\n');
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'extra-file' && e.path === 'stray.txt'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // 4. Non-canonical manifest.json (trailing newline)
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'manifest.json');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, `${cur}\n`);
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'not-canonical' && e.path === 'manifest.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // 5. Wrong contentId in canonical manifest.json
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'manifest.json');
      const m = JSON.parse(await readFile(p, 'utf8'));
      m.contentId = `sha256-${'00'.repeat(32)}`;
      await writeFile(p, canonicalBytes(m));
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'content-id'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // 6. checksums.json disagreement with manifest
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'checksums.json');
      const c = JSON.parse(await readFile(p, 'utf8'));
      c.files['index.html'] = '00'.repeat(32);
      await writeFile(p, canonicalBytes(c));
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'checksums-disagree'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('[SITE-S4] adversarial verifier regressions: unlisted HTML page, path-escaping href, Markdown P14 reorder, dropped HTML/MD anchor, forged decisions/evidence, and empty stray directory are all rejected', async () => {
  // F6: Unlisted HTML page in manifest.files with <script>
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = 'item/backdoor/index.html';
      const evil = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
      await mkdir(join(dir, 'item/backdoor'), { recursive: true });
      await writeFile(join(dir, p), evil);
      await resealBundle(dir, (m) => {
        m.files.push({ path: p, role: 'page', mediaType: 'text/html; charset=utf-8', bytes: evil.length, sha256: sha256Hex(evil) });
        m.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'unlisted-page' || e.code === 'unsafe-content'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F7: Relative href escaping bundle root via ../../../../../../index.html or /index.html
  for (const badHref of ['../../../../../../index.html', '/index.html', 'http://bundle.local/index.html', '../../manifest.json#frag', 'index.html?q=1']) {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'item/retention-window/index.html');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, cur.replace('</main>', `<p><a href="${badHref}">x</a></p></main>`));
      await resealBundle(dir);
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false, `expected failure for ${badHref}`);
      assert.ok(res.errors.some((e) => e.code === 'unsafe-content'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F8A: P14 reading order violated in Markdown
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'item/retention-window/index.md');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, cur.replace('**Options.**', '**Recommendation (`days-90`).** 90 days first!\n\n**Options.**'));
      await resealBundle(dir);
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'reading-order' && e.path === 'item/retention-window/index.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F8B: P14 bypass attempt by emptying manifest.decisions while decision/question anchors remain
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      await resealBundle(dir, (m) => { m.decisions = []; });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'anchor-parity' || e.code === 'schema'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F9: Dropping an element anchor from Markdown + manifest.anchors while keeping it in HTML
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'item/retention-window/index.md');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, cur.replace('[r-store-growth]: #r-store-growth\n\n', ''));
      await resealBundle(dir, (m) => { m.anchors = m.anchors.filter((a) => a.anchor !== 'r-store-growth'); });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'anchor-parity'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // R2-F2: Dropping an element anchor whose id ends in "-t" (e.g. id="r-foo-t" with sub-id "r-foo-t-t") is caught
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const htmlPath = join(dir, 'item/retention-window/index.html');
      const mdPath = join(dir, 'item/retention-window/index.md');
      const html = await readFile(htmlPath, 'utf8');
      const md = await readFile(mdPath, 'utf8');
      await writeFile(htmlPath, html.replace('id="r-store-growth-t"', 'id="r-foo-t-t"').replace('id="r-store-growth"', 'id="r-foo-t"').replace('aria-labelledby="r-store-growth-t"', 'aria-labelledby="r-foo-t-t"'));
      await writeFile(mdPath, md.replace('[r-store-growth]: #r-store-growth\n\n', ''));
      await resealBundle(dir, (m) => { m.anchors = m.anchors.filter((a) => a.anchor !== 'r-store-growth'); });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'anchor-parity'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F10: Forged manifest.decisions and manifest.evidence
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      await resealBundle(dir, (m) => {
        m.decisions = [{
          decisionRef: '../../../evil',
          kind: 12345,
          page: 'item/retention-window',
          anchor: 'a-platform',
          questions: [{ questionRef: '../../../evil-q', anchor: 'q-retention-length', optionRefs: [null, 42], freeText: { allowed: 'not-a-bool', maxChars: -999 } }],
        }];
        m.evidence[0].citedBy = [12345, null, 'nonexistent-anchor'];
        m.evidence.push({ ...m.evidence[0] });
      });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'schema'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // F11: Empty unexpected directories at depth 1..2
  {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      await mkdir(join(dir, 'item/retention-window/act'), { recursive: true });
      await mkdir(join(dir, 'assets/sub'), { recursive: true });
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'unexpected-directory'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('[SITE-S4] forbidden interactive paths (act/ or data/) in a resealed bundle are rejected', async () => {
  const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
    await mkdir(join(dir, 'act/retention-choice'), { recursive: true });
    const bytes = Buffer.from('<!doctype html><title>x</title>', 'utf8');
    await writeFile(join(dir, 'act/retention-choice/index.html'), bytes);
    await resealBundle(dir, (m) => {
      m.files.push({
        path: 'act/retention-choice/index.html',
        role: 'page',
        mediaType: 'text/html; charset=utf-8',
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      });
      m.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    });
  });
  try {
    const res = await verifySiteBundle(bundleDir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === 'unexpected-directory' || e.code === 'unsafe-path'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[SITE-S4] P2 & link check: planted <script>, <form>, <input>, <button>, inline style=, onclick=, or broken relative href on any page is rejected even when resealed', async () => {
  for (const snippet of [
    '<script>alert(1)</script>',
    '<form action="/x"><input name="q"><button>Go</button></form>',
    '<p style="color:red">bad</p>',
    '<p onclick="alert(1)">bad</p>',
    '<p><a href="../missing-target/index.html">broken</a></p>',
    '<p><a href="#no-such-anchor">broken-frag</a></p>',
  ]) {
    const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
      const p = join(dir, 'item/retention-window/index.html');
      const cur = await readFile(p, 'utf8');
      await writeFile(p, cur.replace('</main>', `${snippet}</main>`));
      await resealBundle(dir);
    });
    try {
      const res = await verifySiteBundle(bundleDir);
      assert.equal(res.ok, false, `expected failure for ${snippet}`);
      assert.ok(res.errors.some((e) => e.code === 'unsafe-content' && e.path === 'item/retention-window/index.html'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('[SITE-S4] P7 anchor parity check: missing or mismatched anchor between HTML, Markdown, and manifest.anchors is rejected', async () => {
  // Remove an anchor definition from item Markdown and reseal
  const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
    const p = join(dir, 'item/retention-window/index.md');
    const cur = await readFile(p, 'utf8');
    await writeFile(p, cur.replace('[q-retention-length]: #q-retention-length\n', ''));
    await resealBundle(dir);
  });
  try {
    const res = await verifySiteBundle(bundleDir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === 'anchor-parity'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[SITE-S4] P14 reading order check: placing recommendation before options on an item page is rejected', async () => {
  const { root, bundleDir } = await writeBundle(builtFixture.output, async (dir) => {
    const p = join(dir, 'item/retention-window/index.html');
    const cur = await readFile(p, 'utf8');
    const optsIdx = cur.indexOf('<div class="support question__options"><span class="field-label">Options</span>');
    const recMatch = cur.match(/<p class="claim question__recommendation"><span class="field-label">Recommendation[\s\S]*?<\/p>/);
    assert.ok(optsIdx > 0 && recMatch);
    const mutated = cur.replace(recMatch[0], '').slice(0, optsIdx) + recMatch[0] + cur.replace(recMatch[0], '').slice(optsIdx);
    await writeFile(p, mutated);
    await resealBundle(dir);
  });
  try {
    const res = await verifySiteBundle(bundleDir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === 'reading-order'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[SITE-S4] publishPacket and startServer publish and serve both site-bundle/v1 and packet/v1 with security headers and per-request digest verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-site-pub-'));
  let srv = null;
  try {
    const siteOut = join(dir, 'site-built');
    const pktOut = join(dir, 'pkt-built');
    const storeRoot = join(dir, 'store');

    const siteBuilt = await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir: siteOut });
    const pktBuilt = await buildPacket({ reportPath: REPORT_FIXTURE, outDir: pktOut });

    const sitePub = await publishPacket({ packetDir: siteOut, root: storeRoot });
    assert.equal(sitePub.outcome, 'created');
    assert.equal(sitePub.contentId, siteBuilt.contentId);
    assert.equal(sitePub.readBack.verified, true);

    // Idempotent re-publish
    const sitePubAgain = await publishPacket({ packetDir: siteOut, root: storeRoot });
    assert.equal(sitePubAgain.outcome, 'already-present');

    // Existing packet/v1 still publishes cleanly
    const pktPub = await publishPacket({ packetDir: pktOut, root: storeRoot });
    assert.equal(pktPub.outcome, 'created');
    assert.equal(pktPub.contentId, pktBuilt.contentId);

    // Point alias "latest-sitrep" at the site-bundle/v1 contentId
    await setAlias({ root: storeRoot, name: 'latest-sitrep', contentId: siteBuilt.contentId, expectGeneration: 0 });

    srv = await startServer({ root: storeRoot });
    const get = (path, redirect = 'manual') => fetch(`${srv.url}${path}`, { redirect });

    // Portfolio entry
    const rEntry = await get(`/p/${siteBuilt.contentId}/`);
    assert.equal(rEntry.status, 200);
    assert.equal(rEntry.headers.get('x-content-type-options'), 'nosniff');
    assert.match(rEntry.headers.get('content-type'), /^text\/html/);
    assert.match(await rEntry.text(), /Portfolio situation report/);

    // Portfolio Markdown
    const rMd = await get(`/p/${siteBuilt.contentId}/index.md`);
    assert.equal(rMd.status, 200);
    assert.match(rMd.headers.get('content-type'), /^text\/markdown/);

    // Area and item sub-pages
    const rArea = await get(`/p/${siteBuilt.contentId}/area/platform/index.html`);
    assert.equal(rArea.status, 200);
    assert.match(await rArea.text(), /id="a-platform"/);

    const rItem = await get(`/p/${siteBuilt.contentId}/item/retention-window/index.html`);
    assert.equal(rItem.status, 200);
    assert.match(await rItem.text(), /id="d-retention-choice"/);

    // Trailing slash on sub-page is 404 (files are served by exact path)
    const rSubSlash = await get(`/p/${siteBuilt.contentId}/area/platform/`);
    assert.equal(rSubSlash.status, 404);

    // Alias redirect
    const rAlias = await get('/a/latest-sitrep/');
    assert.equal(rAlias.status, 307);
    assert.equal(rAlias.headers.get('location'), `/p/${siteBuilt.contentId}/`);
    assert.equal(rAlias.headers.get('cache-control'), 'no-store');

    // Per-request SHA-256 re-verification catches post-verification on-disk tampering
    const itemOnDisk = join(storeRoot, 'packets', siteBuilt.contentId, 'item/retention-window/index.html');
    await chmod(itemOnDisk, 0o644);
    await writeFile(itemOnDisk, 'tampered bytes');
    const rTampered = await get(`/p/${siteBuilt.contentId}/item/retention-window/index.html`);
    assert.equal(rTampered.status, 500);
  } finally {
    if (srv) srv.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[SITE-S4] CLI pathways keep single-page packet/v1 (build, verify, review) and multi-page site-bundle/v1 (build-site, verify-site, sitrep) separate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-site-cli-'));
  const env = { ...process.env, CANON_HOME: join(dir, 'isolated-home') };
  const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  try {
    const siteOut = join(dir, 'site-out');
    const pktOut = join(dir, 'pkt-out');
    const storeRoot = join(dir, 'store');

    // 1. Multi-page SitRep pathway: build-site -> verify-site -> sitrep
    const bs = runCli(['build-site', SITE_FIXTURE, '--out', siteOut]);
    assert.equal(bs.status, 0, bs.stderr);
    const bsJson = JSON.parse(bs.stdout);
    assert.equal(bsJson.contentId, builtFixture.contentId);

    const vs = runCli(['verify-site', siteOut]);
    assert.equal(vs.status, 0, vs.stderr);
    assert.match(vs.stdout, /^OK sha256-/);

    const vsJson = JSON.parse(runCli(['verify-site', siteOut, '--json']).stdout);
    assert.equal(vsJson.ok, true);
    assert.equal(vsJson.contentId, builtFixture.contentId);

    const sr = runCli(['sitrep', SITE_FIXTURE, '--store', storeRoot, '--alias', 'sitrep-cli']);
    assert.equal(sr.status, 0, sr.stderr);
    const srJson = JSON.parse(sr.stdout);
    assert.equal(srJson.contentId, builtFixture.contentId);
    assert.equal(srJson.publish, 'created');
    assert.deepEqual(srJson.alias, { name: 'sitrep-cli', generation: 1, changed: true });
    assert.deepEqual(srJson.paths, {
      alias: '/a/sitrep-cli/',
      bundle: `/p/${builtFixture.contentId}/`,
      html: `/p/${builtFixture.contentId}/index.html`,
      markdown: `/p/${builtFixture.contentId}/index.md`,
    });

    // 2. Single-page packet/v1 pathway still works via build -> verify -> review
    const bp = runCli(['build', REPORT_FIXTURE, '--out', pktOut]);
    assert.equal(bp.status, 0, bp.stderr);
    const vp = runCli(['verify', pktOut]);
    assert.equal(vp.status, 0, vp.stderr);

    // 3. Cross-pathway inputs are strictly refused on the wrong command
    assert.equal(runCli(['build', SITE_FIXTURE, '--out', join(dir, 'bad-1')]).status, 1);
    assert.equal(runCli(['build-site', REPORT_FIXTURE, '--out', join(dir, 'bad-2')]).status, 1);
    assert.equal(runCli(['verify', siteOut]).status, 1);
    assert.equal(runCli(['verify-site', pktOut]).status, 1);
    assert.equal(runCli(['brief', SITE_FIXTURE, '--store', storeRoot, '--alias', 'bad-r']).status, 1);
    assert.equal(runCli(['sitrep', REPORT_FIXTURE, '--store', storeRoot, '--alias', 'bad-s']).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
