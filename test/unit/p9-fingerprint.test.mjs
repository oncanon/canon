import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket, DEFAULT_STYLESHEET } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { FIXTURE, sha256, tempDir, treeDigest } from '../helpers.mjs';

test('[P9] every runtime asset and evidence file is named by its own SHA-256', async (t) => {
  const dir = join(await tempDir(t, 'canon-p9'), 'pkt');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: dir });
  const runtime = built.manifest.files.filter((f) => f.role === 'asset' || f.role === 'evidence');
  assert.ok(runtime.length >= 4);
  for (const f of runtime) {
    const digest = sha256(await readFile(join(dir, f.path)));
    assert.match(f.path, new RegExp(`^(assets|evidence)/${digest}\\.[a-z0-9]+$`), f.path);
  }
});

test('[P9] HTML references only fingerprinted local assets and packet files', async (t) => {
  const dir = join(await tempDir(t, 'canon-p9b'), 'pkt');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: dir });
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  const inventory = new Set([...built.manifest.files.map((f) => f.path), 'manifest.json', 'checksums.json']);
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.ok(refs.length > 10);
  for (const ref of refs) {
    if (ref.startsWith('#')) continue;
    if (/^https:\/\//.test(ref)) continue; // user-initiated navigation links, never loaded (see P14)
    assert.ok(inventory.has(ref), `unfingerprinted or unknown reference ${ref}`);
    if (ref.startsWith('assets/')) assert.match(ref, /^assets\/[0-9a-f]{64}\.css$/);
  }
  assert.equal([...html.matchAll(/<link\s+rel="stylesheet"/g)].length, 1, 'exactly one stylesheet link');
  assert.equal([...html.matchAll(/<link\s+rel="alternate"\s+type="text\/markdown"\s+href="report\.md"/g)].length, 1, 'exactly one Markdown alternate link');
  assert.ok(!/\?v=|\?ver=/.test(html), 'no query-string cache busting');
});

test('[P9] Libron fonts are local, fingerprinted, licensed, and referenced only by the packet stylesheet', async (t) => {
  const dir = join(await tempDir(t, 'canon-p9-fonts'), 'pkt');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: dir });
  const fonts = built.manifest.files.filter((f) => f.mediaType === 'font/woff2');
  assert.equal(fonts.length, 4);
  for (const font of fonts) {
    assert.equal(font.role, 'asset');
    assert.match(font.path, /^assets\/[0-9a-f]{64}\.woff2$/);
    assert.equal(font.path.slice(7, -6), font.sha256);
  }
  const cssEntry = built.manifest.files.find((f) => f.mediaType === 'text/css; charset=utf-8');
  const css = await readFile(join(dir, cssEntry.path), 'utf8');
  assert.equal((css.match(/@font-face/g) ?? []).length, 4);
  assert.match(css, /font-family:"Libron"/);
  for (const font of fonts) assert.ok(css.includes(`url("./${font.path.slice('assets/'.length)}")`));
  assert.ok(!/https?:|data:/.test(css));
  const license = await readFile(join(process.cwd(), 'src/presentation/fonts/libron/OFL-1.1.txt'), 'utf8');
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/i);
});

test('[P9] asset mutation changes the asset name and the content ID; the old published packet is unchanged', async (t) => {
  const dir = await tempDir(t, 'canon-p9c');
  const store = join(dir, 'store');
  const a = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'a') });
  const pubA = await publishPacket({ packetDir: join(dir, 'a'), root: store });
  const beforeA = await treeDigest(pubA.target);
  const css = Buffer.concat([await readFile(DEFAULT_STYLESHEET), Buffer.from('\n@layer tokens { :root { --paper: #fffdf5; } @media (prefers-color-scheme: dark) { :root { --paper: #0b1120; } } }\n')]);
  const b = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'b'), stylesheetBytes: css });
  const cssA = a.manifest.files.find((f) => f.mediaType === 'text/css; charset=utf-8').path;
  const cssB = b.manifest.files.find((f) => f.mediaType === 'text/css; charset=utf-8').path;
  assert.notEqual(cssB, cssA);
  assert.notEqual(b.contentId, a.contentId);
  const pubB = await publishPacket({ packetDir: join(dir, 'b'), root: store });
  assert.notEqual(pubB.target, pubA.target);
  assert.deepEqual(await treeDigest(pubA.target), beforeA, 'old immutable packet bytes unchanged');
});
