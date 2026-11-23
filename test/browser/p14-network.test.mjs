import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ENGINES, evidencePath, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

const ROUTES = [
  ['served', () => env.packetUrl],
  ['alias', () => env.aliasUrl],
  ['file-archive', () => env.fileUrl],
];

for (const engine of ENGINES) {
  for (const [label, url] of ROUTES) {
    test(`[P14] ${engine.name} ${label}: every request stays inside the packet origin; zero external requests`, async () => {
      const browser = await engine.type.launch();
      try {
        const har = (await evidencePath('browser', engine.name, `p14-${label}.har`)) ?? join(env.work, `${engine.name}-${label}.har`);
        const context = await browser.newContext({ recordHar: { path: har, content: 'omit' }, viewport: { width: 390, height: 844 } });
        const requests = [];
        const failures = [];
        context.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
        context.on('requestfailed', (r) => failures.push({ url: r.url(), error: r.failure()?.errorText }));
        const page = await context.newPage();
        const consoleMessages = [];
        page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
        await page.goto(url(), { waitUntil: 'load' });
        // Exercise the page: open disclosures, jump through anchors, scroll to the end.
        for (const summary of await page.locator('summary').all()) if (await summary.isVisible()) await summary.click();
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        await context.close(); // flushes the HAR
        const expectedPrefix = label === 'file-archive' ? 'file://' : env.origin;
        const external = requests.filter((r) => !r.url.startsWith(expectedPrefix));
        const summary = {
          engine: engine.name, version: browser.version(), route: label, url: url(), contentId: env.contentId,
          requestCount: requests.length, requests, failures, external, consoleMessages, har,
        };
        await saveJson(`browser/${engine.name}/p14-${label}.json`, summary);
        assert.deepEqual(external, [], `external requests: ${JSON.stringify(external)}`);
        assert.ok(requests.some((r) => r.type === 'stylesheet'), 'the stylesheet request was observed (the probe sees subresources)');
        assert.ok(requests.every((r) => ['document', 'stylesheet', 'font', 'other'].includes(r.type)), `unexpected resource types: ${requests.map((r) => r.type)}`);
        assert.ok(!requests.some((r) => /\.map($|\?)|analytics|w3\.org/.test(r.url)), 'no source maps, analytics, or link targets fetched');
        const fonts = requests.filter((r) => r.type === 'font');
        assert.ok(fonts.length >= 1 || label === 'file-archive', 'served packets load at least one local Libron font');
        assert.ok(fonts.every((r) => /\/assets\/[0-9a-f]{64}\.woff2$/.test(r.url)), `only fingerprinted local WOFF2 fonts load: ${JSON.stringify(fonts)}`);
        assert.deepEqual(failures.filter((f) => !/favicon/.test(f.url)), []);
        assert.equal(requests.filter((r) => r.type === 'stylesheet').length, 1, 'exactly one stylesheet');
      } finally {
        await browser.close();
      }
    });
  }
}

// Control: the same probe must flag an external request when one exists. The
// control page is test-only (never a packet); its external request is aborted by
// the harness before any network access, but is still observed by the probe.
for (const engine of ENGINES) {
  test(`[P14] ${engine.name} control: the request probe detects an external request when one is present`, async () => {
    const browser = await engine.type.launch();
    try {
      const context = await browser.newContext();
      await context.route((u) => !u.href.startsWith(env.origin), (route) => route.abort());
      await context.route(`${env.origin}/control.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="https://fonts.example.invalid/x.css"><p>control</p>' }));
      const requests = [];
      context.on('request', (r) => requests.push(r.url()));
      const page = await context.newPage();
      await page.goto(`${env.origin}/control.html`);
      await page.waitForTimeout(300);
      const external = requests.filter((u) => !u.startsWith(env.origin));
      assert.deepEqual(external, ['https://fonts.example.invalid/x.css']);
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
