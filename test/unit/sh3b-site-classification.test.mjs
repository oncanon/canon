// [SH3B] docs/projects/review-packet-publisher.md, SH-3 follow-up: a site-bundle/v1
// manifest had no `publication` field, so packetPublication() (src/publication/policy.mjs)
// always read `manifest.report?.publication` (undefined for a site bundle) and defaulted
// every site to classification: private-review, dataOrigin: production — refusing every
// `canon publish --site` to a provider target with SYNTHETIC_ONLY, synthetic or not.
//
// This mirrors report/v1's optional `publication` extension (docs/v2/publication-protocol.md
// §6) onto site-input/v1 and site-bundle/v1: same names, same values, same default when absent.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packetPublication } from '../../src/publication/policy.mjs';
import { publishSite } from '../../src/publication/protocol.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { validateSiteInput } from '../../src/site/validate.mjs';
import { verifySiteBundle } from '../../src/site/verify.mjs';
import { REPO } from '../helpers.mjs';
import { harness } from '../v2/harness.mjs';

const SITE_FIXTURE_DIR = join(REPO, 'fixtures/site');
const SITE_FIXTURE = join(SITE_FIXTURE_DIR, 'first-slice.site-input.json');

async function mkdtempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sh3b-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Build a site bundle from the first-slice fixture, with `publication` set (or removed,
// for `publication: undefined`) on the site-input before it is validated and built.
async function siteBundle(dir, variant, publication) {
  const src = join(dir, `src-${variant}`);
  await cp(SITE_FIXTURE_DIR, src, { recursive: true });
  const path = join(src, 'first-slice.site-input.json');
  const input = JSON.parse(await readFile(path, 'utf8'));
  if (publication) input.publication = publication;
  else delete input.publication;
  await writeFile(path, JSON.stringify(input));
  return buildSiteBundle({ sitePath: path, outDir: join(dir, `bundle-${variant}`) });
}

// ---- unit: validateSiteInput accepts the same publication extension as report/v1 --------

test('[SH3B-0] validateSiteInput accepts an optional publication block with the report/v1 enum values', async () => {
  const base = JSON.parse(await readFile(SITE_FIXTURE, 'utf8'));
  const withPub = { ...base, publication: { classification: 'public', dataOrigin: 'synthetic' } };
  assert.doesNotThrow(() => validateSiteInput(withPub));
  assert.doesNotThrow(() => validateSiteInput(base), 'absent is still valid');
});

test('[SH3B-0] validateSiteInput refuses an unknown publication key or an out-of-enum value', async () => {
  const base = JSON.parse(await readFile(SITE_FIXTURE, 'utf8'));
  assert.throws(() => validateSiteInput({ ...base, publication: { classification: 'top-secret' } }));
  assert.throws(() => validateSiteInput({ ...base, publication: { dataOrigin: 'live' } }));
  assert.throws(() => validateSiteInput({ ...base, publication: { classification: 'public', extra: true } }));
});

// ---- unit: packetPublication() reads a site-bundle manifest's own shape -------------------

test('[SH3B-0] packetPublication() reads manifest.site.publication for a site-bundle/v1 manifest', () => {
  const siteManifest = (publication) => ({ schema: 'site-bundle/v1', site: publication ? { publication } : {} });
  assert.deepEqual(packetPublication(siteManifest({ classification: 'public', dataOrigin: 'synthetic' })), { classification: 'public', dataOrigin: 'synthetic' });
  assert.deepEqual(packetPublication(siteManifest(null)), { classification: 'private-review', dataOrigin: 'production' }, 'absent still defaults exactly as report/v1 does');
  // A report/v1 (packet) manifest is unaffected: still reads manifest.report.publication.
  const reportManifest = (publication) => ({ schema: 'packet/v1', report: publication ? { publication } : {} });
  assert.deepEqual(packetPublication(reportManifest({ classification: 'confidential' })), { classification: 'confidential', dataOrigin: 'production' });
});

// ---- EARS-3: changing the publication block changes the bundle's content id --------------

test('[SH3B-3] when the publication block changes, the bundle content id changes', async (t) => {
  const dir = await mkdtempDir(t);
  const absent = await siteBundle(dir, 'absent', null);
  const synthetic = await siteBundle(dir, 'synthetic', { dataOrigin: 'synthetic' });
  const synthDup = await siteBundle(dir, 'synthetic-dup', { dataOrigin: 'synthetic' });
  const publicClass = await siteBundle(dir, 'public', { classification: 'public', dataOrigin: 'synthetic' });
  assert.notEqual(absent.contentId, synthetic.contentId, 'adding a publication block changes the content id');
  assert.notEqual(synthetic.contentId, publicClass.contentId, 'changing classification changes the content id');
  assert.equal(synthetic.contentId, synthDup.contentId, 'the same publication block is still deterministic');
  const manifest = JSON.parse(await readFile(join(synthetic.outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.site.publication, { dataOrigin: 'synthetic' }, 'the block is copied onto manifest.site verbatim');
  const absentManifest = JSON.parse(await readFile(join(absent.outDir, 'manifest.json'), 'utf8'));
  assert.ok(!Object.hasOwn(absentManifest.site, 'publication'), 'absent on the input stays absent on the manifest (byte-identical V1 sites)');
  const verified = await verifySiteBundle(synthetic.outDir);
  assert.equal(verified.ok, true, 'a bundle carrying a publication block still verifies');
});

// ---- EARS-1 and EARS-2: the policy check on canon publish --site --dry-run ----------------

test('[SH3B-1] a site input declaring dataOrigin: synthetic passes publish --site --dry-run to a provider target', async (t) => {
  const h = await harness('mock-cloudflare', t);
  const dir = await mkdtempDir(t);
  const bundle = await siteBundle(dir, 'synthetic', { dataOrigin: 'synthetic' });
  const result = await publishSite({ ...h.opts({ dryRun: true }), bundleDir: bundle.outDir });
  assert.equal(result.state, 'PLANNED');
  assert.equal(result.dryRun, true);
});

test('[SH3B-2] a site input with no publication block still fails SYNTHETIC_ONLY against a provider target', async (t) => {
  const h = await harness('mock-cloudflare', t);
  const dir = await mkdtempDir(t);
  const bundle = await siteBundle(dir, 'absent', null);
  await assert.rejects(
    publishSite({ ...h.opts({ dryRun: true }), bundleDir: bundle.outDir }),
    { code: 'synthetic-only' },
  );
});
