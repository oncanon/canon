import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { archivePacket } from '../../src/archive/tar.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { FIXTURE, sha256, tempDir, treeDigest } from '../helpers.mjs';

// Documented HTTP-only exceptions (docs/decisions/phase1-contract.md D3): response
// headers exist only over HTTP. Under file:// the <meta> CSP applies instead and
// frame-ancestors / X-Frame-Options / nosniff / cache headers are unavailable.
export const HTTP_ONLY = ['Content-Security-Policy frame-ancestors', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy header (meta referrer applies offline)', 'Cache-Control/ETag', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Permissions-Policy'];

test('[P10] built, published, served and extracted-archive packets have the same content ID and bytes', async (t) => {
  const dir = await tempDir(t, 'canon-p10');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'built') });
  const builtTree = await treeDigest(built.outDir);

  const pub = await publishPacket({ packetDir: built.outDir, root: join(dir, 'store') });
  assert.equal(pub.contentId, built.contentId);
  assert.deepEqual(await treeDigest(pub.target), builtTree);

  const { server, url } = await startServer({ root: join(dir, 'store') });
  t.after(() => server.close());
  for (const [path, digest] of Object.entries(builtTree)) {
    const res = await fetch(`${url}/p/${built.contentId}/${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(sha256(Buffer.from(await res.arrayBuffer())), digest, `served bytes differ for ${path}`);
    assert.equal(res.headers.get('x-content-id'), built.contentId);
  }

  const first = await archivePacket(built.outDir);
  const second = await archivePacket(pub.target);
  assert.equal(first.contentId, built.contentId);
  assert.ok(first.bytes.equals(second.bytes), 'archive bytes are deterministic across built and published copies');
  const tarPath = join(dir, 'packet.tar');
  await writeFile(tarPath, first.bytes);
  // Deterministic metadata as read back by the system tar: uid/gid 0, mtime epoch,
  // fixed modes, entries sorted, no top-level directory.
  const listing = spawnSync('tar', ['-tvf', tarPath], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  assert.equal(listing.status, 0);
  const lines = listing.stdout.trim().split('\n');
  const entryRe = /^(-rw-r--r--|drwxr-xr-x)\s+0 0\s+0\s+\d+ Jan  1  1970 (\S+)$/;
  assert.ok(lines.every((l) => entryRe.test(l)), listing.stdout);
  const names = lines.map((l) => l.match(entryRe)[2]);
  assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.deepEqual(names.filter((n) => !n.endsWith('/')).sort(), Object.keys(builtTree).sort());
  const extracted = join(dir, 'extracted');
  await mkdir(extracted);
  // Extraction uses the system tar (bsdtar/libarchive), not our own writer.
  const x = spawnSync('tar', ['-xf', tarPath, '-C', extracted], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const v = await verifyPacket(extracted);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.contentId, built.contentId);
  assert.deepEqual(await treeDigest(extracted), builtTree);
  t.diagnostic(`archiveSha256=${sha256(first.bytes)} bytes=${first.bytes.length}`);
});

test('[P10] extracted index.html references only relative packet paths, so file:// reading needs no server', async (t) => {
  const dir = await tempDir(t, 'canon-p10b');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'built') });
  const html = await readFile(join(built.outDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\s(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('https://'));
  assert.ok(refs.every((r) => !r.startsWith('/') && !r.includes('://')), refs.join(','));
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  t.diagnostic(`httpOnlyExceptions=${HTTP_ONLY.join('; ')}`);
});
