import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { FIXTURE, tempDir } from '../helpers.mjs';

const MEDIA = { html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' };

// Third, independent implementation of the content ID: Python's json module with
// sorted keys and compact separators over the manifest minus contentId.
const PY_CONTENT_ID = `
import hashlib, json, sys
m = json.load(open(sys.argv[1], encoding='utf-8'))
declared = m.pop('contentId')
canon = json.dumps(m, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print(declared)
print('sha256-' + hashlib.sha256(canon.encode('utf-8')).hexdigest())
`;

test('[P3] manifest declares schema, entry, sorted inventory, MIME, lengths, digests; all agree with bytes and an independent implementation', async (t) => {
  const dir = join(await tempDir(t, 'canon-p3'), 'pkt');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: dir });
  const manifestBytes = await readFile(join(dir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, 'packet/v1');
  assert.equal(manifest.entry, 'index.html');
  assert.equal(manifest.contentId, built.contentId);

  const paths = manifest.files.map((f) => f.path);
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(paths, sorted, 'inventory sorted by path bytes');
  assert.equal(new Set(paths).size, paths.length, 'no duplicate paths');

  // Per-file digests via the system shasum tool, lengths via stat, MIME by extension.
  const shasum = spawnSync('shasum', ['-a', '256', ...paths], { cwd: dir, encoding: 'utf8' });
  assert.equal(shasum.status, 0, shasum.stderr);
  const cliDigests = Object.fromEntries(shasum.stdout.trim().split('\n').map((l) => { const [h, p] = l.split(/\s+/); return [p, h]; }));
  for (const f of manifest.files) {
    assert.equal(f.sha256, cliDigests[f.path], `sha256 ${f.path}`);
    assert.equal(f.bytes, (await stat(join(dir, f.path))).size, `bytes ${f.path}`);
    assert.equal(f.mediaType, MEDIA[f.path.split('.').pop()], `mediaType ${f.path}`);
  }

  const py = spawnSync('python3', ['-c', PY_CONTENT_ID, join(dir, 'manifest.json')], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const [declared, recomputed] = py.stdout.trim().split('\n');
  assert.equal(recomputed, declared, 'python recomputation of content ID');

  const checksums = JSON.parse(await readFile(join(dir, 'checksums.json')));
  assert.equal(checksums.schema, 'checksums/v1');
  assert.equal(checksums.contentId, manifest.contentId);
  assert.equal(checksums.manifestSha256, spawnSync('shasum', ['-a', '256', 'manifest.json'], { cwd: dir, encoding: 'utf8' }).stdout.split(/\s+/)[0]);
  assert.deepEqual(Object.keys(checksums.files).sort(), [...paths].sort());
  for (const f of manifest.files) assert.equal(checksums.files[f.path], f.sha256);

  const result = await verifyPacket(dir);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.recomputedContentId, manifest.contentId);
  t.diagnostic(`contentId=${manifest.contentId} manifestSha256=${result.manifestSha256}`);
});

test('[P3] evidence relations in the manifest link evidence files to the claims that cite them', async (t) => {
  const dir = join(await tempDir(t, 'canon-p3b'), 'pkt');
  await buildPacket({ reportPath: FIXTURE, outDir: dir });
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json')));
  const byId = Object.fromEntries(manifest.evidence.map((e) => [e.id, e]));
  assert.ok(byId['ev-cache-probe'].citedBy.includes('f-F-1'));
  assert.equal(byId['ev-reviewer-notes'].kind, 'redacted');
  assert.equal(byId['ev-reviewer-notes'].path, undefined, 'withheld evidence has no bytes in the packet');
  for (const e of manifest.evidence.filter((x) => x.kind === 'file')) {
    assert.ok(manifest.files.some((f) => f.path === e.path && f.sha256 === e.sha256 && f.role === 'evidence'));
  }
});
