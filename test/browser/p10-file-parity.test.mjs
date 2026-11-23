import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINES, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

const results = [];
test.after(() => saveJson('p10-browser-parity.json', results));

for (const engine of ENGINES) {
  test(`[P10] ${engine.name}: extracted archive opened from file:// renders the same content and styling as the served packet`, async () => {
    const browser = await engine.type.launch();
    try {
      const snapshot = async (url) => {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
        await page.goto(url);
        return page.evaluate(() => ({
          text: document.body.innerText,
          bg: getComputedStyle(document.body).backgroundColor,
          h1Font: getComputedStyle(document.querySelector('h1')).fontFamily,
          stylesheetApplied: getComputedStyle(document.querySelector('.rail')).position === 'sticky',
          sheets: [...document.styleSheets].map((s) => s.href?.split('/').slice(-2).join('/')),
        }));
      };
      const served = await snapshot(env.packetUrl);
      const file = await snapshot(env.fileUrl);
      results.push({ engine: engine.name, version: browser.version(), served: { ...served, text: `${served.text.length} chars` }, file: { ...file, text: `${file.text.length} chars` }, textEqual: served.text === file.text });
      assert.ok(served.stylesheetApplied, 'stylesheet applied when served');
      assert.ok(file.stylesheetApplied, 'stylesheet applied from file:// (meta CSP style-src self permits the local asset)');
      assert.equal(file.bg, served.bg);
      assert.deepEqual(file.sheets, served.sheets);
      assert.equal(file.text, served.text, 'identical rendered text');
    } finally {
      await browser.close();
    }
  });
}
