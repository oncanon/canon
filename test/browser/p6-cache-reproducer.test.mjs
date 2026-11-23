import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setAlias } from '../../src/alias/alias.mjs';
import { buildPacket, DEFAULT_STYLESHEET } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { FIXTURE } from '../helpers.mjs';
import { ENGINES, saveJson, setupPublished } from './setup.mjs';

let env;
let packetB;
test.before(async () => {
  env = await setupPublished();
  const css = Buffer.concat([await readFile(DEFAULT_STYLESHEET), Buffer.from('\n@layer tokens { :root { --paper: #fffdf5; } @media (prefers-color-scheme: dark) { :root { --paper: #0b1120; } } }\n')]);
  const b = await buildPacket({ reportPath: FIXTURE, outDir: join(env.work, 'built-b'), stylesheetBytes: css });
  await publishPacket({ packetDir: b.outDir, root: env.store });
  packetB = b.contentId;
});
test.after(() => env?.close());

const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const cssHref = (page) => page.evaluate(() => document.querySelector('link[rel=stylesheet]').href);

// Naive stable-path server (test-only control): HTML is revalidated every time,
// but the stylesheet lives at a stable URL with a long cache lifetime. This is the
// failure class the packet design avoids; the control shows the probe can see it.
async function naiveServer() {
  let version = 'a';
  const server = createServer((req, res) => {
    if (req.url === '/naive/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><link rel="stylesheet" href="/naive/style.css"><body><p>version ${version}</p></body>`);
    } else if (req.url === '/naive/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=31536000' });
      res.end(version === 'a' ? 'body{background:rgb(241, 238, 231)}' : 'body{background:rgb(255, 253, 245)}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, flip() { version = 'b'; } };
}

const results = [];
test.after(() => saveJson('p6-cache-reproducer.json', results));

for (const engine of ENGINES) {
  test(`[P6] ${engine.name} control: a stable asset path with a long cache serves stale bytes after the content changes`, async () => {
    const naive = await naiveServer();
    const browser = await engine.type.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${naive.url}/naive/`);
      const before = await bodyBg(page);
      naive.flip();
      await page.goto(`${naive.url}/naive/`);
      const text = await page.textContent('p');
      const after = await bodyBg(page);
      results.push({ engine: engine.name, version: browser.version(), scenario: 'naive-stable-path-control', before, after, htmlSays: text, stale: text.includes('version b') && after === before });
      assert.equal(text.trim(), 'version b', 'new HTML was served');
      assert.equal(after, before, 'control reproduces the stale stylesheet (the probe can observe staleness)');
    } finally {
      await browser.close();
      naive.server.close();
    }
  });

  test(`[P6] ${engine.name}: alias change never pairs new HTML with a stale asset (fingerprinted assets + no-store alias)`, async () => {
    await setAlias({ root: env.store, name: `repro-${engine.name}`, contentId: env.contentId, expectGeneration: 0 });
    const browser = await engine.type.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const responses = [];
      page.on('response', (r) => responses.push({ url: r.url(), status: r.status(), cacheControl: r.headers()['cache-control'] ?? null, fromCache: r.fromServiceWorker() }));
      const aliasUrl = `${env.origin}/a/repro-${engine.name}/`;
      await page.goto(aliasUrl);
      const a = { url: page.url(), css: await cssHref(page), bg: await bodyBg(page) };
      await setAlias({ root: env.store, name: `repro-${engine.name}`, contentId: packetB, expectGeneration: 1 });
      await page.goto(aliasUrl);
      const b = { url: page.url(), css: await cssHref(page), bg: await bodyBg(page) };
      await page.reload();
      const bReload = { url: page.url(), css: await cssHref(page), bg: await bodyBg(page) };
      // Switching back must also be immediate: the old packet is still immutable and valid.
      await setAlias({ root: env.store, name: `repro-${engine.name}`, contentId: env.contentId, expectGeneration: 2 });
      await page.goto(aliasUrl);
      const back = { url: page.url(), css: await cssHref(page), bg: await bodyBg(page) };
      results.push({ engine: engine.name, version: browser.version(), scenario: 'packet-alias-switch', a, b, bReload, back, responses });
      assert.ok(a.url.endsWith(`/p/${env.contentId}/`));
      assert.ok(b.url.endsWith(`/p/${packetB}/`));
      assert.notEqual(b.css, a.css, 'new packet uses a different fingerprinted stylesheet URL');
      assert.equal(a.bg, 'rgb(244, 246, 249)');
      assert.equal(b.bg, 'rgb(255, 253, 245)', 'new packet renders with its own stylesheet, not a cached old one');
      assert.equal(bReload.bg, 'rgb(255, 253, 245)');
      assert.equal(back.bg, 'rgb(244, 246, 249)');
      assert.ok(back.url.endsWith(`/p/${env.contentId}/`));
      const aliasResponses = responses.filter((r) => r.url === aliasUrl);
      assert.ok(aliasResponses.length >= 3 && aliasResponses.every((r) => r.status === 307 && r.cacheControl === 'no-store'), JSON.stringify(aliasResponses));
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
