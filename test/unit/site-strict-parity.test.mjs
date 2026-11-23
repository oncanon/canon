import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../../src/hash.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { verifySiteBundle } from '../../src/site/verify.mjs';
import { REPO } from '../helpers.mjs';

const SITE_FIXTURE = join(REPO, 'fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json');
const MARK_RE = /(<span class="brand__mark" aria-hidden="true">)[^<]*(<\/span>)/g;

// Rewrite every HTML page, then reseal manifest and checksums so only parity can object.
async function editAndReseal(dir, edit) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    if (!entry.path.endsWith('.html')) continue;
    const p = join(dir, entry.path);
    await writeFile(p, edit(await readFile(p, 'utf8')));
  }
  for (const entry of manifest.files) {
    const bytes = await readFile(join(dir, entry.path));
    entry.bytes = bytes.length;
    entry.sha256 = sha256Hex(bytes);
  }
  const { contentId: _old, ...identity } = manifest;
  const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
  const next = { ...identity, contentId };
  const manifestBytes = canonicalBytes(next);
  await writeFile(join(dir, 'manifest.json'), manifestBytes);
  await writeFile(join(dir, 'checksums.json'), canonicalBytes({
    schema: 'checksums/v1',
    algorithm: 'sha256',
    contentId,
    manifestSha256: sha256Hex(manifestBytes),
    files: Object.fromEntries(next.files.map((f) => [f.path, f.sha256])),
  }));
}

test('[V2] verify-site: strict v2 parity is the default; no masthead mark other than the v1 "SR" relaxes it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-strict-parity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = join(dir, 'built');
  await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir: built });
  const html = await readFile(join(built, 'index.html'), 'utf8');
  assert.match(html, /<span class="brand__mark" aria-hidden="true">C<\/span>/, 'the fixture carries the Canon mark');

  for (const mark of ['C', 'F', 'X']) {
    // Control: the mark alone, resealed, still verifies, so the reseal is sound.
    const kept = join(dir, `kept-${mark}`);
    await cp(built, kept, { recursive: true });
    await editAndReseal(kept, (s) => s.replace(MARK_RE, `$1${mark}$2`));
    const keptResult = await verifySiteBundle(kept);
    assert.equal(keptResult.ok, true, `mark ${mark} with v2 markup verifies: ${JSON.stringify(keptResult.errors?.slice(0, 3))}`);

    // Stripping the v2 paragraph class is a v2 parity failure whatever the mark claims.
    const stripped = join(dir, `stripped-${mark}`);
    await cp(built, stripped, { recursive: true });
    let removed = 0;
    await editAndReseal(stripped, (s) => s.replace(MARK_RE, `$1${mark}$2`).replace(/ class="prose-para"/g, () => { removed += 1; return ''; }));
    assert.ok(removed > 0, 'the fixture has v2 prose paragraphs to strip');
    const strippedResult = await verifySiteBundle(stripped);
    assert.equal(strippedResult.ok, false, `mark ${mark} does not buy the lenient v1 rules`);
  }
});
