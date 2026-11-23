import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright-core';
import { evidencePath, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

// Legend definitions that must survive into print (render-policy/1 label meanings).
export const LEGEND_TEXT = [
  'Measured or directly observed',
  'Proposed adaptation, not yet proven',
  'Known problem; do not copy',
  'Evidence or decision still required',
  'the confidence label says how strongly the claim is established',
];

async function printMediaFacts(page) {
  return page.evaluate((legendText) => {
    const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => getComputedStyle(el).display !== 'none');
    const clipped = [...document.querySelectorAll('.code__scroll, .table__scroll')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.parentElement.id || el.getAttribute('aria-labelledby'));
    const extLink = document.querySelector('a.ext');
    return {
      navHidden: !shown('.rail') && !shown('.toc') && !shown('.skip-link'),
      clipped,
      extLinkSuffix: extLink ? getComputedStyle(extLink, '::after').content : null,
      addedLabel: getComputedStyle(document.querySelector('.ln.add'), '::after').content,
      findingsBreakInside: getComputedStyle(document.querySelector('.finding')).breakInside,
      headingBreakAfter: getComputedStyle(document.querySelector('.section > h2')).breakAfter,
      // innerText reflects rendered text only, so content inside a closed <details>
      // that print CSS failed to reveal is absent here.
      legendRendered: legendText.map((t) => [t, document.body.innerText.includes(t)]),
      // Collapsible content other than the legend, reported for review: which stays
      // closed in print (navigation contents is intentionally hidden).
      otherDetails: [...document.querySelectorAll('details:not(.legend)')].map((d) => ({ inside: d.parentElement.className, displayed: getComputedStyle(d.parentElement).display !== 'none' })),
    };
  }, LEGEND_TEXT);
}

test('[P12] Chromium print/PDF keeps claims, evidence references, URLs, code and tables legible; hides only navigation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(env.packetUrl);
    await page.emulateMedia({ media: 'print' });
    const facts = await printMediaFacts(page);
    const pdfPath = (await evidencePath('browser', 'chromium', 'p12-print.pdf')) ?? join(env.work, 'print.pdf');
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: false, preferCSSPageSize: true });
    const text = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(text.status, 0, text.stderr);
    const pages = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).stdout.match(/Pages:\s+(\d+)/)?.[1];
    const pdfText = text.stdout;
    const txtPath = await evidencePath('browser', 'chromium', 'p12-print.txt');
    if (txtPath) await writeFile(txtPath, pdfText);

    assert.ok(facts.navHidden, 'navigation hidden in print');
    assert.deepEqual(facts.clipped, [], 'no code/table content clipped by scroll containers in print');
    assert.match(facts.extLinkSuffix, /attr\(href\)|https:/, 'external link targets printed');
    assert.match(facts.addedLabel, /added/);
    assert.equal(facts.findingsBreakInside, 'avoid');
    assert.equal(facts.headingBreakAfter, 'avoid');
    // Labels are uppercased by CSS text-transform, so compare case-insensitively.
    const flat = pdfText.replace(/\s+/g, ' ').toLowerCase();
    for (const needle of [
      'Stable asset paths serve stale bytes after an alias change', // finding title
      'Claim', 'Evidence', '[E2]', 'Alias switch cache probe (fixture)', // claim -> evidence relationship
      'Cited by', // evidence -> claim back-reference
      'https://www.w3.org/TR/CSP3/', // printed URL
      'const contentId', // code
      'packet/v1 files and cache policy', 'Served cache policy', // table
      'p95 latency by stage', '265 ms', // chart values as text
      '[added]', '[removed]', // diff semantics without color
      'Decision needed', 'Should packets ever include first-party JavaScript?',
    ]) assert.ok(flat.includes(needle.toLowerCase()), `PDF text missing: ${needle}`);
    assert.ok(!flat.includes('skip to content'), 'skip link not printed');
    for (const t of LEGEND_TEXT) assert.ok(flat.includes(t.toLowerCase()), `PDF text layer missing legend definition: ${t}`);
    assert.deepEqual(facts.legendRendered.filter(([, ok]) => !ok).map(([t]) => t), [], 'legend definitions rendered under print media');
    assert.deepEqual(facts.otherDetails.filter((d) => d.displayed), [], 'no other collapsible content is shown collapsed in print');
    assert.ok(Number(pages) >= 3 && Number(pages) <= 20, `page count ${pages}`);
    await saveJson('p12-print.json', { engine: 'chromium', version: browser.version(), pdf: pdfPath, pages: Number(pages), facts, url: env.packetUrl, contentId: env.contentId });
  } finally {
    await browser.close();
  }
});

test('[P12] WebKit print media applies the same print rules (screenshot evidence; WebKit has no PDF export in Playwright)', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await page.goto(env.packetUrl);
    await page.emulateMedia({ media: 'print' });
    const facts = await printMediaFacts(page);
    const shot = await evidencePath('browser', 'webkit', 'p12-print-media.png');
    if (shot) await page.screenshot({ path: shot, fullPage: true });
    assert.ok(facts.navHidden);
    assert.deepEqual(facts.clipped, []);
    assert.match(facts.addedLabel, /added/);
    assert.deepEqual(facts.legendRendered.filter(([, ok]) => !ok).map(([t]) => t), [], 'WebKit print media renders every legend definition');
    await saveJson('p12-print-webkit.json', { engine: 'webkit', version: browser.version(), facts, screenshot: shot, limitation: 'Playwright WebKit cannot produce a PDF; print CSS verified via print media emulation only.' });
  } finally {
    await browser.close();
  }
});
