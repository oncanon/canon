// V2 schemas (docs/v2/publication-protocol.md): the report/v1 publication extension
// is optional and leaves V1 packets byte-identical; alias/v1 is unchanged; receipt/v2
// and target configuration are closed schemas.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readAlias, setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { SCHEMAS, validate } from '../../src/publication/schemas.mjs';
import { FIXTURE, tempDir } from '../helpers.mjs';
import { syntheticPacket } from '../v2/harness.mjs';

// The packet ID changes when the presentation asset set changes (Libron v0.25 is
// now part of packet identity), while the optional publication extension remains
// absent for an ordinary report/v1 source.
const V1_GOLDEN = 'sha256-3632c33a430f5fafd6a4f7f42971a3d3fbcaf3efd60858b1918aada908d51231';

test('[V2-1] the optional publication extension leaves V1 packets and content IDs unchanged', async (t) => {
  const dir = await tempDir(t, 'canon-v2-schema');
  const v1 = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'v1') });
  assert.equal(v1.contentId, V1_GOLDEN, 'the fixture (no extension) builds the V1 golden content ID');
  const manifest = JSON.parse(await readFile(join(v1.outDir, 'manifest.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest.report, 'publication'), false);
  const ext = await syntheticPacket(dir, 'ext', { classification: 'confidential', dataOrigin: 'synthetic' });
  assert.equal((await verifyPacket(ext.dir)).ok, true, 'a packet with the extension verifies');
  assert.deepEqual(JSON.parse(await readFile(join(ext.dir, 'manifest.json'), 'utf8')).report.publication, { classification: 'confidential', dataOrigin: 'synthetic' });
  assert.deepEqual(validate('report-publication/v1', { classification: 'confidential', dataOrigin: 'synthetic' }), []);
  const bad = join(dir, 'bad.json');
  const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
  report.publication = { classification: 'secret' };
  await writeFile(bad, JSON.stringify(report));
  await assert.rejects(buildPacket({ reportPath: bad, outDir: join(dir, 'bad') }), (e) => e.errors?.some((x) => x.path === '/publication/classification'));
});

test('[V2-9] alias/v1 is unchanged: V1 alias records validate against the V2 schema', async (t) => {
  const dir = await tempDir(t, 'canon-v2-alias');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'p') });
  await publishPacket({ packetDir: built.outDir, root: join(dir, 'store') });
  await setAlias({ root: join(dir, 'store'), name: 'review', contentId: built.contentId, expectGeneration: 0 });
  assert.deepEqual(validate('alias/v1', await readAlias(join(dir, 'store'), 'review')), []);
  assert.notDeepEqual(validate('alias/v1', { schema: 'alias/v1', name: 'review', contentId: built.contentId, generation: 0, previousContentId: null }), [], 'generation starts at 1');
});

test('[V2-9] receipt/v2 and target configuration are closed schemas', () => {
  assert.equal(SCHEMAS['receipt/v2'].additionalProperties, false);
  assert.notDeepEqual(validate('receipt/v2', { schema: 'receipt/v2' }), []);
  const target = { schema: 'publication-targets/v1', targets: [{ name: 'cf', kind: 'mock-cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5 }] };
  assert.deepEqual(validate('publication-targets/v1', target), []);
  target.targets[0].apiToken = 'x';
  assert.deepEqual(validate('publication-targets/v1', target), ['/targets/0/apiToken: not allowed']);
});
