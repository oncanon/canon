// [SH-3] docs/projects/review-packet-publisher.md: publishSite shares protocol.mjs's
// state machine, upload order, read-back and receipt code with publish, swapping
// verifyPacket for verifySiteBundle (the same switch point `fs.mjs`'s commit() needed,
// via the existing verifyArtifact dispatcher in src/site/verify.mjs).
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { objectKey, publishSite } from '../../src/publication/protocol.mjs';
import { copyPacket, exists, REPO } from '../helpers.mjs';
import { harness } from '../v2/harness.mjs';

const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');

async function syntheticSiteBundle(dir) {
  const built = await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir: join(dir, 'bundle') });
  return { dir: built.outDir, contentId: built.contentId };
}

test('[P0-3] publishSite reaches READBACK_VERIFIED for a verified site bundle', async (t) => {
  const h = await harness('fs', t);
  const bundle = await syntheticSiteBundle(h.dir);
  const result = await publishSite({ ...h.opts(), bundleDir: bundle.dir });
  assert.equal(result.state, 'READBACK_VERIFIED');
  assert.equal(result.contentId, bundle.contentId);
  assert.ok(result.receipt.objects.every((o) => o.outcome === 'created'));
  assert.equal(result.receipt.objects.at(-1).key, objectKey(bundle.contentId, 'manifest.json'), 'manifest.json is written last');
  const manifestBytes = await h.adapter.getObject(objectKey(bundle.contentId, 'manifest.json'));
  assert.equal(JSON.parse(manifestBytes.toString('utf8')).schema, 'site-bundle/v1', 'the published artifact is a site bundle, not a packet');
  // Idempotent republish, exactly like publish().
  const again = await publishSite({ ...h.opts(), bundleDir: bundle.dir });
  assert.ok(again.receipt.objects.every((o) => o.outcome === 'identical'));
});

test('[SH3-1] a site bundle with one corrupted file is refused before any upload', async (t) => {
  const h = await harness('fs', t);
  const good = await syntheticSiteBundle(h.dir);
  const bad = await copyPacket(good.dir, join(h.dir, 'bad-bundle'));
  await appendFile(join(bad, 'index.html'), ' ');
  await assert.rejects(
    publishSite({ ...h.opts(), bundleDir: bad }),
    (err) => err.code === 'invalid' && err.details.errors.some((e) => e.code === 'byte-length' && e.path === 'index.html'),
  );
  assert.equal(h.adapter.requestCount(), 0, 'nothing was uploaded before the local verify ran');
  assert.equal(await exists(join(h.target.root, 'packets')), false, 'no object was written on the target');
});
