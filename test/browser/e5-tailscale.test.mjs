// Real access surface: the packet served on this machine's Tailscale address,
// loaded in Chromium and WebKit by IP and by MagicDNS name. Skipped (with a
// diagnostic) where Tailscale is not running. Loopback is not bound here.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { detectTailscale } from '../../src/server/bind.mjs';
import { startServer } from '../../src/server/server.mjs';
import { FIXTURE, liveTailnet } from '../helpers.mjs';
import { ENGINES, evidencePath, saveJson } from './setup.mjs';

let ts = null;
let srv = null;
let work = null;
let contentId = null;
if (!liveTailnet()) {
  ts = { error: 'opt-in only: CANON_LIVE_TAILNET=1 (npm run test:tailnet); the default suite never binds the tailnet' };
} else {
  try {
    ts = detectTailscale();
    // --tailscale needs the expected node, name included; a node with no Self DNS name
    // cannot state one, so it is skipped with that reason (as the E3 live test does).
    if (!ts.dnsName) ts = { error: 'this node reports no Self DNS name, so no expectation can be stated' };
  } catch (err) {
    ts = { error: err.message };
  }
}

test.before(async () => {
  if (ts.error) return;
  work = await mkdtemp(join(tmpdir(), 'canon-e5-'));
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(work, 'built') });
  contentId = built.contentId;
  await publishPacket({ packetDir: built.outDir, root: join(work, 'store') });
  await setAlias({ root: join(work, 'store'), name: 'phase1-review', contentId, expectGeneration: 0 });
  srv = await startServer({ root: join(work, 'store'), tailscale: true, expectTailscale: { address: ts.address, name: ts.dnsName }, port: 0 });
});
test.after(async () => {
  if (srv) await new Promise((r) => srv.server.close(r));
  if (work) await rm(work, { recursive: true, force: true });
});

const results = [];
test.after(() => saveJson('e5-tailscale-browser.json', results));

for (const engine of ENGINES) {
  test(`[E5] ${engine.name}: packet loads over the Tailscale IP and MagicDNS URL with zero requests outside that origin`, async (t) => {
    if (ts.error) {
      t.skip(`tailscale unavailable: ${ts.error}`);
      return;
    }
    const port = srv.address.port;
    const bases = [`http://${ts.address}:${port}`, ...(ts.dnsName ? [`http://${ts.dnsName}:${port}`] : [])];
    const browser = await engine.type.launch();
    try {
      for (const base of bases) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
        const requests = [];
        context.on('request', (r) => requests.push(r.url()));
        const page = await context.newPage();
        const response = await page.goto(`${base}/a/phase1-review/`);
        assert.equal(response.status(), 200);
        assert.equal(page.url(), `${base}/p/${contentId}/`, 'alias redirect followed to the immutable packet');
        const facts = await page.evaluate(() => ({
          h1: document.querySelector('h1').textContent,
          styled: getComputedStyle(document.body).backgroundColor,
          noHorizontalScroll: document.documentElement.scrollWidth <= innerWidth,
        }));
        const md = await page.request.get(`${base}/p/${contentId}/report.md`);
        const shot = await evidencePath('browser', engine.name, `e5-${base.includes(ts.address) ? 'tailscale-ip' : 'magicdns'}-phone.png`);
        if (shot) await page.screenshot({ path: shot });
        const external = requests.filter((u) => !u.startsWith(`${base}/`));
        results.push({ engine: engine.name, version: browser.version(), base, contentId, status: response.status(), finalUrl: page.url(), ...facts, markdownStatus: md.status(), markdownType: md.headers()['content-type'], requests, external, screenshot: shot });
        assert.equal(facts.h1, 'Local immutable review packets: Phase 1 design review');
        assert.equal(facts.styled, 'rgb(241, 238, 231)', 'fingerprinted stylesheet applied');
        assert.ok(facts.noHorizontalScroll);
        assert.equal(md.status(), 200);
        assert.equal(md.headers()['content-type'], 'text/markdown; charset=utf-8');
        assert.deepEqual(external, []);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
