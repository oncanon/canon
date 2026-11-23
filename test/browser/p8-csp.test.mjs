import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { CSP } from '../../src/policy.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { CASES, XSS_STRINGS } from '../corpus/cases.mjs';
import { REPO } from '../helpers.mjs';
import { ENGINES, evidencePath, saveJson, setupPublished } from './setup.mjs';

let env;
let xssId;
test.before(async () => {
  env = await setupPublished();
  const src = join(env.work, 'xss-src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const report = JSON.parse(await readFile(join(src, 'phase1-review.report.json'), 'utf8'));
  await CASES.find((c) => c.category === 'escaped-xss').mutate(report, src);
  await writeFile(join(src, 'phase1-review.report.json'), JSON.stringify(report));
  const built = await buildPacket({ reportPath: join(src, 'phase1-review.report.json'), outDir: join(env.work, 'xss-built') });
  await publishPacket({ packetDir: built.outDir, root: env.store });
  xssId = built.contentId;
});
test.after(() => env?.close());

const HOSTILE = `<!doctype html><body><p id="x">control</p>
<script>window.__xss = 'inline-script';</script>
<img src="data:," onerror="window.__xss = 'inline-handler'">
<p style="color: rgb(255, 0, 0)" id="styled">styled</p></body>`;

const results = [];
test.after(() => saveJson('p8-browser-csp.json', results));

for (const engine of ENGINES) {
  test(`[P8] ${engine.name}: XSS corpus packet renders payloads as text; nothing executes`, async () => {
    const browser = await engine.type.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
      await page.goto(`${env.origin}/p/${xssId}/`);
      const observed = await page.evaluate(() => ({
        xss: window.__xss ?? null,
        scripts: document.scripts.length,
        iframes: document.querySelectorAll('iframe').length,
        imgs: document.querySelectorAll('img').length,
        styleElements: document.querySelectorAll('style').length,
        titleText: document.querySelector('h1').textContent,
        bodyText: document.body.innerText,
      }));
      const shot = await evidencePath('browser', engine.name, 'p8-xss-corpus.png');
      if (shot) await page.screenshot({ path: shot, fullPage: false });
      results.push({ engine: engine.name, version: browser.version(), scenario: 'xss-corpus-packet', contentId: xssId, xss: observed.xss, scripts: observed.scripts, dialogs, screenshot: shot });
      assert.equal(observed.xss, null);
      assert.deepEqual(dialogs, []);
      assert.equal(observed.scripts + observed.iframes + observed.imgs + observed.styleElements, 0);
      assert.equal(observed.titleText, XSS_STRINGS[0], 'payload shown verbatim as text');
      for (const s of XSS_STRINGS.slice(0, 5)) assert.ok(observed.bodyText.includes(s), `payload text visible: ${s}`);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  test(`[P8] ${engine.name}: the packet CSP blocks inline script, inline handlers and inline style (control without CSP executes)`, async () => {
    const browser = await engine.type.launch();
    try {
      const run = async (headers) => {
        const context = await browser.newContext();
        await context.route(`${env.origin}/csp-probe.html`, (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/html', ...headers }, body: HOSTILE }));
        const page = await context.newPage();
        await page.addInitScript(() => {
          window.__violations = [];
          document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective));
        });
        await page.goto(`${env.origin}/csp-probe.html`);
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => ({ xss: window.__xss ?? null, color: getComputedStyle(document.getElementById('styled')).color, violations: window.__violations }));
        await context.close();
        return r;
      };
      const withCsp = await run({ 'Content-Security-Policy': CSP });
      const withoutCsp = await run({});
      results.push({ engine: engine.name, version: browser.version(), scenario: 'csp-enforcement', withCsp, withoutCsp });
      assert.notEqual(withoutCsp.xss, null, 'control: payload executes without CSP');
      assert.equal(withoutCsp.color, 'rgb(255, 0, 0)', 'control: inline style applies without CSP');
      assert.equal(withCsp.xss, null, 'CSP blocked inline script and handler');
      assert.notEqual(withCsp.color, 'rgb(255, 0, 0)', 'CSP blocked inline style attribute');
      assert.ok(withCsp.violations.some((v) => v.startsWith('script-src')), JSON.stringify(withCsp.violations));
    } finally {
      await browser.close();
    }
  });
}
