// Shared real-browser harness: builds the fixture, publishes it to a temporary
// store, points alias "review" at it, and serves it on loopback. Evidence
// (screenshots, PDFs, traces, JSON observations) is written under
// CANON_EVIDENCE_DIR when set; otherwise tests still assert but keep no artifacts.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright-core';
import { setAlias } from '../../src/alias/alias.mjs';
import { archivePacket } from '../../src/archive/tar.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { FIXTURE } from '../helpers.mjs';
import { spawnSync } from 'node:child_process';

export const ENGINES = [
  { name: 'chromium', type: chromium },
  { name: 'webkit', type: webkit },
];

export const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'ipad-portrait', width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'ipad-landscape', width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'laptop', width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 2 },
];

export const EVIDENCE_DIR = process.env.CANON_EVIDENCE_DIR ?? null;

export async function evidencePath(...parts) {
  if (!EVIDENCE_DIR) return null;
  const p = join(EVIDENCE_DIR, ...parts);
  await mkdir(join(p, '..'), { recursive: true });
  return p;
}

// Recorded observations must not depend on where the repository or temp
// directory lives: evidence paths become evidence-relative and temp paths <tmp>.
const TMP_PREFIXES = [...new Set([tmpdir(), realpathSync(tmpdir())])].sort((a, b) => b.length - a.length);

export function portablePaths(text) {
  let out = text;
  if (EVIDENCE_DIR) out = out.split(`${EVIDENCE_DIR}/`).join('');
  for (const prefix of TMP_PREFIXES) out = out.split(prefix).join('<tmp>');
  return out;
}

export async function saveJson(name, value) {
  const p = await evidencePath(name);
  if (p) await writeFile(p, `${portablePaths(JSON.stringify(value, null, 2))}\n`);
  return p;
}

export function contextOptions(vp, extra = {}) {
  return { viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, hasTouch: vp.hasTouch, isMobile: vp.isMobile, ...extra };
}

export async function setupPublished() {
  const work = await mkdtemp(join(tmpdir(), 'canon-browser-'));
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(work, 'built') });
  const store = join(work, 'store');
  const pub = await publishPacket({ packetDir: built.outDir, root: store });
  await setAlias({ root: store, name: 'review', contentId: built.contentId, expectGeneration: 0 });
  const { bytes } = await archivePacket(built.outDir);
  const tar = join(work, 'packet.tar');
  await writeFile(tar, bytes);
  const extracted = join(work, 'extracted');
  await mkdir(extracted);
  const x = spawnSync('tar', ['-xf', tar, '-C', extracted]);
  if (x.status !== 0) throw new Error('tar extraction failed');
  const { server, url } = await startServer({ root: store });
  return {
    work,
    store,
    built,
    contentId: built.contentId,
    packetUrl: `${url}/p/${built.contentId}/`,
    aliasUrl: `${url}/a/review/`,
    origin: url,
    fileUrl: `file://${extracted}/index.html`,
    publishedDir: pub.target,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(work, { recursive: true, force: true });
    },
  };
}
