import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPacket } from '../../src/packet/build.mjs';
import { RENDER_POLICIES } from '../../src/policy.mjs';
import { validateReport } from '../../src/report/validate.mjs';
import { FIXTURE, REPO } from '../helpers.mjs';
import { contextOptions, ENGINES, evidencePath, saveJson, setupPublished, VIEWPORTS } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

const observations = [];
test.after(() => saveJson('p11-responsive.json', observations));

async function measure(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
    const rect = (el) => el.getBoundingClientRect();
    const targets = [...document.querySelectorAll('.toc a, .rail a, .toc summary, .legend summary, .site-footer a')].filter(vis);
    const smallTargets = targets.filter((el) => rect(el).height < 44 || rect(el).width < 24).map((el) => `${el.tagName}.${el.className}:${el.textContent.trim().slice(0, 30)}:${Math.round(rect(el).height)}`);
    const textEls = [...document.querySelectorAll('main p, main li, main td, main th, main dd, main dt, main small, main span, main code')].filter(vis);
    const minFont = Math.min(...textEls.map((el) => px(el, 'fontSize')));
    const codeScrolls = [...document.querySelectorAll('.code__scroll')].map((el) => ({ scrollable: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX, focusable: el.tabIndex === 0, width: Math.round(rect(el).width) }));
    const tables = [...document.querySelectorAll('.table__scroll')].map((el) => ({ scrollable: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX, width: Math.round(rect(el).width) }));
    const figures = [...document.querySelectorAll('figure.figure')].map((el) => ({ id: el.id, width: Math.round(rect(el).width), right: Math.round(rect(el).right), visible: vis(el) }));
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyFont: px(document.body, 'fontSize'),
      h1Font: px(document.querySelector('h1'), 'fontSize'),
      h2Font: px(document.querySelector('.section > h2'), 'fontSize'),
      minFont,
      railVisible: vis(document.querySelector('.rail')),
      tocVisible: vis(document.querySelector('.toc')),
      targetsChecked: targets.length,
      smallTargets,
      codeScrolls,
      tables,
      figures,
      viewportMeta: document.querySelector('meta[name=viewport]').content,
    };
  });
}

for (const engine of ENGINES) {
  for (const vp of VIEWPORTS) {
    test(`[P11] ${engine.name} ${vp.name} ${vp.width}x${vp.height}: navigation, density, tables, code, figures, touch targets, no page scroll`, async () => {
      const browser = await engine.type.launch();
      try {
        const context = await browser.newContext(contextOptions(vp));
        const page = await context.newPage();
        await page.goto(env.packetUrl, { waitUntil: 'load' });
        const m = await measure(page);
        const shot = await evidencePath('browser', engine.name, `p11-${vp.name}-full.png`);
        if (shot) await page.screenshot({ path: shot, fullPage: true });
        const top = await evidencePath('browser', engine.name, `p11-${vp.name}-viewport.png`);
        if (top) await page.screenshot({ path: top });

        assert.ok(m.scrollWidth <= m.innerWidth, `horizontal page scroll: ${m.scrollWidth} > ${m.innerWidth}`);
        assert.doesNotMatch(m.viewportMeta, /maximum-scale|user-scalable=no/, 'zoom must not be disabled');
        const wide = vp.width > 1024;
        assert.equal(m.railVisible, wide, 'rail navigation on wide layouts');
        assert.equal(m.tocVisible, !wide, 'compact contents on narrow layouts');
        assert.ok(m.bodyFont >= 15 && m.bodyFont <= 17, `body font ${m.bodyFont}`);
        assert.ok(m.h1Font <= 37, `bounded title scale ${m.h1Font}`);
        assert.ok(m.h2Font <= 26, `bounded heading scale ${m.h2Font}`);
        assert.ok(m.minFont >= 10, `min text size ${m.minFont}`);
        assert.deepEqual(m.smallTargets, [], 'navigation/control touch targets >= 44px tall');
        assert.ok(m.codeScrolls.every((c) => c.overflowX === 'auto' && c.focusable && c.width <= m.innerWidth));
        assert.ok(m.tables.every((c) => c.overflowX === 'auto' && c.width <= m.innerWidth));
        assert.ok(m.figures.length >= 2 && m.figures.every((f) => f.visible && f.right <= m.innerWidth), JSON.stringify(m.figures));
        if (vp.name === 'phone') assert.ok(m.codeScrolls.some((c) => c.scrollable), 'long code scrolls inside its region on phone');

        // Navigation works: jump to Findings through the visible contents control.
        if (!wide) await page.locator('.toc summary').click();
        await page.locator(`${wide ? '.rail' : '.toc'} a[href="#sec-findings"]`).click();
        await page.waitForFunction(() => location.hash === '#sec-findings');
        const inView = await page.evaluate(() => { const r = document.querySelector('#sec-findings').getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight; });
        assert.ok(inView, 'navigation target scrolled into view');
        observations.push({ engine: engine.name, version: browser.version(), viewport: vp, url: env.packetUrl, contentId: env.contentId, ...m, navigation: 'ok', screenshot: shot });
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }

  for (const zoom of [{ name: 'laptop-200pct', width: 720, height: 450 }, { name: 'reflow-320', width: 320, height: 568 }]) {
    test(`[P11] ${engine.name} ${zoom.name}: 200% zoom / 320px reflow keeps content usable without page scroll`, async () => {
      const browser = await engine.type.launch();
      try {
        const context = await browser.newContext({ viewport: { width: zoom.width, height: zoom.height }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        await page.goto(env.packetUrl);
        const m = await measure(page);
        const shot = await evidencePath('browser', engine.name, `p11-${zoom.name}.png`);
        if (shot) await page.screenshot({ path: shot, fullPage: true });
        assert.ok(m.scrollWidth <= m.innerWidth, `horizontal page scroll at ${zoom.name}: ${m.scrollWidth} > ${m.innerWidth}`);
        assert.ok(m.tocVisible && !m.railVisible);
        observations.push({ engine: engine.name, version: browser.version(), viewport: zoom, zoomEquivalent: zoom.name, ...m, screenshot: shot });
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }
}

// No page scroll under every render policy (src/policy.mjs RENDER_POLICIES, so a future
// policy is covered without editing this file), for the golden fixture and the v2 specimen
// as authored and with every authored string replaced by one long unbroken token (an id, a
// path, a hash): no label, chip, caption, cell, rail entry or colophon line may push the
// page wider than the viewport at any P11 width or at 320 px reflow.
const POLICY_INPUTS = [
  { name: 'fixture', path: FIXTURE },
  { name: 'specimen-v2', path: join(REPO, 'fixtures/specimen-v2/canon-specimen-v2.report.json') },
];
// render-policy/1 is frozen (R1): its renderer and stylesheet cannot change, and these
// overflow under unbroken tokens. Recorded, not hidden: node:test reports them as todo.
const FROZEN_TOKEN_OVERFLOW = {
  'render-policy/1': 'frozen render-policy/1 (R1): .classification, .item__meta and .metric__cites hold unbroken tokens',
};
const REFLOW = [...VIEWPORTS, { name: 'reflow-320', width: 320, height: 568, isMobile: false, hasTouch: false, deviceScaleFactor: 2 }];

// Every authored string becomes the longest unbroken token the schema accepts: a 64+
// character run, else its own length, else the string with its whitespace removed.
// Identifiers, enums, references and paths keep their values so the report stays valid.
const STRUCTURAL = new Set(['id', 'type', 'schema', 'href', 'path', 'sha256', 'severity', 'confidence', 'status', 'kind', 'band', 'language', 'mediaType', 'ordered', 'likelihood', 'impact', 'ears', 'cite', 'key', 'align', 'from', 'to', 'role', 'layer', 'edge', 'date', 'generatedAt', 'version', 'lines', 'unit', 'format', 'lang', 'withheld', 'evidence', 'chosen', 'recommended', 'mode', 'shape']);
function unbrokenTokens(report) {
  const r = structuredClone(report);
  const paths = [];
  (function walk(v, path) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!STRUCTURAL.has(k)) walk(x, [...path, k]); }
    else if (typeof v === 'string' && v.length > 0) paths.push(path);
  })(r, []);
  const parent = (p) => p.slice(0, -1).reduce((a, k) => a[k], r);
  const valid = () => { try { validateReport(r); return true; } catch { return false; } };
  let stressed = 0;
  for (const p of paths) {
    const o = parent(p)[p.at(-1)];
    for (const cand of ['W'.repeat(Math.max(64, o.length)), 'W'.repeat(64), 'W'.repeat(Math.max(o.length, 12)), o.replace(/\s+/g, '')]) {
      parent(p)[p.at(-1)] = cand;
      if (valid()) { stressed += cand !== o; break; }
      parent(p)[p.at(-1)] = o;
    }
  }
  return { report: r, strings: paths.length, stressed };
}

async function buildVariant(input, renderPolicy, tokens) {
  const work = await mkdtemp(join(tmpdir(), 'canon-p11-policy-'));
  await cp(dirname(input.path), work, { recursive: true });
  const source = JSON.parse(await readFile(input.path, 'utf8'));
  let report = source;
  if (tokens) {
    const s = unbrokenTokens(source);
    // Instrument check: the stress really reached the page text.
    assert.ok(s.stressed >= s.strings * 0.9, `stressed ${s.stressed} of ${s.strings} authored strings`);
    report = s.report;
  }
  const reportPath = join(work, basename(input.path));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const built = await buildPacket({ reportPath, outDir: join(work, 'out'), renderPolicy });
  return { work, url: pathToFileURL(join(built.outDir, 'index.html')).href, contentId: built.contentId };
}

for (const renderPolicy of RENDER_POLICIES) {
  for (const input of POLICY_INPUTS) {
    for (const tokens of [false, true]) {
      for (const engine of ENGINES) {
        const todo = tokens ? FROZEN_TOKEN_OVERFLOW[renderPolicy] : undefined;
        test(`[P11-POLICY] ${renderPolicy} ${input.name}${tokens ? ' (unbroken tokens)' : ''} ${engine.name}: no horizontal page scroll at any width`, { todo }, async () => {
          const v = await buildVariant(input, renderPolicy, tokens);
          const browser = await engine.type.launch();
          try {
            const failures = [];
            for (const vp of REFLOW) {
              const context = await browser.newContext(contextOptions(vp));
              const page = await context.newPage();
              await page.goto(v.url, { waitUntil: 'load' });
              const m = await page.evaluate(() => {
                const W = document.documentElement.clientWidth;
                const scrolls = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
                const offenders = [...document.querySelectorAll('body *')]
                  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > W + 1 && !scrolls(el); })
                  .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
                return { innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
              });
              if (m.scrollWidth > m.innerWidth || m.offenders.length) failures.push({ viewport: vp.name, ...m });
              if (tokens && vp.name === 'phone') {
                const shot = await evidencePath('browser', engine.name, `p11-policy-${renderPolicy.replace('/', '-')}-${input.name}-tokens-phone.png`);
                if (shot) await page.screenshot({ path: shot, fullPage: true });
              }
              await context.close();
            }
            observations.push({ check: 'P11-POLICY', renderPolicy, input: input.name, tokens, engine: engine.name, contentId: v.contentId, failures });
            assert.deepEqual(failures, [], `horizontal page scroll under ${renderPolicy}`);
          } finally {
            await browser.close();
            await rm(v.work, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
