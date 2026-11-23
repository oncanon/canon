import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ENGINES, evidencePath, saveJson, setupPublished } from './setup.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_VERSION = require('axe-core/package.json').version;

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

for (const engine of ENGINES) {
  for (const [scheme, width, height] of [['light', 1280, 900], ['dark', 1280, 900], ['light', 390, 844], ['dark', 390, 844]]) {
    test(`[P13] ${engine.name} ${scheme} ${width}px: axe-core WCAG 2.2 A/AA + best-practice finds no violations`, async () => {
      const browser = await engine.type.launch();
      try {
        // The packet CSP forbids all script, so the axe engine can only be injected
        // with CSP bypassed for this audit context. Packet bytes are unchanged.
        const context = await browser.newContext({ bypassCSP: true, colorScheme: scheme, viewport: { width, height } });
        const page = await context.newPage();
        await page.goto(env.packetUrl);
        await page.addScriptTag({ content: AXE_SOURCE });
        const results = await page.evaluate(async () => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
          resultTypes: ['violations', 'incomplete'],
        }));
        const summary = {
          engine: engine.name, version: browser.version(), scheme, viewport: { width, height }, axe: AXE_VERSION, url: env.packetUrl,
          violations: results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })),
          incomplete: results.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })),
          passes: results.passes?.length ?? null,
        };
        await saveJson(`browser/${engine.name}/p13-axe-${scheme}-${width}.json`, summary);
        assert.deepEqual(summary.violations, [], JSON.stringify(summary.violations, null, 1));
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }

  test(`[P13] ${engine.name}: keyboard navigation, skip link, visible focus, landmarks, heading order, labels`, async () => {
    const browser = await engine.type.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(env.packetUrl);
      // WebKit only moves Tab focus to links when "tab to all controls" is on;
      // Alt+Tab is WebKit's equivalent of Safari's Option+Tab.
      const tabKey = engine.name === 'webkit' ? 'Alt+Tab' : 'Tab';
      const stops = [];
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press(tabKey);
        stops.push(await page.evaluate(() => {
          const el = document.activeElement;
          const cs = getComputedStyle(el);
          return { tag: el.tagName, text: (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40), outline: `${cs.outlineStyle} ${cs.outlineWidth}`, focusVisible: el.matches(':focus-visible') };
        }));
      }
      assert.equal(stops[0].text, 'Skip to content', 'skip link is the first tab stop');
      for (const s of stops) {
        assert.ok(s.focusVisible, `focus-visible on ${s.tag} ${s.text}`);
        assert.ok(!s.outline.startsWith('none') && parseFloat(s.outline.split(' ')[1]) >= 2, `visible focus outline on ${s.tag} ${s.text}: ${s.outline}`);
      }
      await page.goto(env.packetUrl);
      await page.keyboard.press(tabKey);
      await page.keyboard.press('Enter');
      const afterSkip = await page.evaluate(() => location.hash);
      assert.equal(afterSkip, '#content');

      // Code and table regions are reachable and scrollable by keyboard.
      const regionFocusable = await page.evaluate(() => [...document.querySelectorAll('.code__scroll, .table__scroll')].every((el) => el.tabIndex === 0 && el.getAttribute('role') === 'region' && el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))));
      assert.ok(regionFocusable);

      const structure = await page.evaluate(() => {
        const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => getComputedStyle(h).display !== 'none').map((h) => Number(h.tagName[1]));
        const skips = headings.filter((lvl, i) => i > 0 && lvl > headings[i - 1] + 1);
        return {
          lang: document.documentElement.lang,
          title: document.title,
          h1: headings.filter((l) => l === 1).length,
          headingLevels: headings,
          skips,
          landmarks: {
            banner: document.querySelectorAll('body > header').length,
            main: document.querySelectorAll('main').length,
            navVisible: [...document.querySelectorAll('nav')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.getAttribute('aria-label')),
            contentinfo: document.querySelectorAll('body > footer').length,
          },
          unlabeledFigures: [...document.querySelectorAll('figure')].filter((f) => !f.getAttribute('aria-labelledby') || !document.getElementById(f.getAttribute('aria-labelledby'))).length,
          tablesWithoutCaption: [...document.querySelectorAll('table')].filter((t) => !t.querySelector('caption') && !t.closest('figure')).length,
          svgExposed: [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('aria-hidden') !== 'true').length,
        };
      });
      assert.equal(structure.lang, 'en');
      assert.equal(structure.h1, 1);
      assert.deepEqual(structure.skips, [], `heading levels skip: ${structure.headingLevels}`);
      assert.equal(structure.headingLevels[0], 1);
      assert.deepEqual(structure.landmarks, { banner: 1, main: 1, navVisible: ['Contents'], contentinfo: 1 });
      assert.equal(structure.unlabeledFigures, 0);
      assert.equal(structure.tablesWithoutCaption, 0);
      assert.equal(structure.svgExposed, 0, 'decorative chart bars are hidden from assistive tech; values are table text');

      // Screen-reader spot check: the accessibility tree as exposed by the engine.
      const tree = await page.locator('body').ariaSnapshot();
      const treePath = await evidencePath('browser', engine.name, 'p13-aria-snapshot.yaml');
      if (treePath) await writeFile(treePath, tree);
      for (const expected of ['banner', 'navigation "Contents"', 'main', 'heading "Local immutable review packets: Phase 1 design review" [level=1]', 'region "packet/v1 files and cache policy"', 'contentinfo']) {
        assert.ok(tree.includes(expected), `accessibility tree missing ${expected}`);
      }
      assert.ok(/link "\[E2\]"|link "E2 Alias switch cache probe \(fixture\)"/.test(tree), 'evidence citations exposed as links');
      await saveJson(`browser/${engine.name}/p13-keyboard-structure.json`, { engine: engine.name, version: browser.version(), tabKey, stops, afterSkip, structure, ariaSnapshot: treePath });
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
