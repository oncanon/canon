// Slice S3: site-bundle/v1 builder, HTML and Markdown page renderers
// (docs/projects/interactive-sitrep-contract.md, revision 4).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { Parser } from 'commonmark';
import { chromium } from 'playwright-core';
import { setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { scanCssPolicy } from '../../src/packet/verify.mjs';
import { siteAnchors, siteDecisions, sitePages } from '../../src/site/manifest.mjs';
import { assembleSiteBundle, buildSiteBundle, collectSiteCitations, loadSiteInput } from '../../src/site/build.mjs';
import { validateSiteInput } from '../../src/site/validate.mjs';
import { REPO } from '../helpers.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');
const REPORT_FIXTURE = join(REPO, 'fixtures/report/phase1-review.report.json');
const BUNDLE_URL = `http://site.test/p/sha256-${'ab'.repeat(32)}/`;

let fixtureText;
let loadedFixture;
let builtFixture;

test.before(async () => {
  fixtureText = await readFile(SITE_FIXTURE, 'utf8');
  loadedFixture = await loadSiteInput(SITE_FIXTURE);
  builtFixture = await buildSiteBundle({ sitePath: SITE_FIXTURE });
});

function customInput(mutate = () => {}) {
  const value = JSON.parse(fixtureText);
  mutate(value);
  return validateSiteInput(value);
}

function buildCustom(mutate = () => {}) {
  const site = customInput(mutate);
  return assembleSiteBundle(site, {
    evidenceBytes: new Map([['queue-snapshot', Buffer.from('queue snapshot line 1\n', 'utf8')]]),
    stylesheetBytes: Buffer.from(':root { color-scheme: light dark; }\n', 'utf8'),
    fontAssets: [],
  });
}

const textOf = (bundle, path) => bundle.output.get(path).toString('utf8');
const landsOn = (fromFile, href) => new URL(href, new URL(fromFile, BUNDLE_URL)).href.slice(BUNDLE_URL.length);

function htmlIds(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

function markdownAnchors(md) {
  return [...md.matchAll(/^\[([^\]\n]+)\]: #\1$/gm)].map((m) => m[1]);
}

test('[SITE-S3] P8 determinism: building the same site input twice produces byte-identical bundles, and changing one input byte changes contentId', async () => {
  const second = await buildSiteBundle({ sitePath: SITE_FIXTURE });
  assert.equal(second.contentId, builtFixture.contentId);
  assert.deepEqual([...second.output.keys()], [...builtFixture.output.keys()]);
  for (const [path, bytes] of builtFixture.output) {
    assert.ok(bytes.equals(second.output.get(path)), `byte parity for ${path}`);
  }

  const changed = buildCustom((s) => { s.title = `${s.title}!`; });
  const baseline = buildCustom();
  assert.notEqual(changed.contentId, baseline.contentId);
});

test('[SITE-S3] P10 packet/v1 invariance: existing report/v1 fixture builds to the exact same contentId', async () => {
  const pkt = await buildPacket({ reportPath: REPORT_FIXTURE });
  assert.equal(pkt.contentId, 'sha256-3632c33a430f5fafd6a4f7f42971a3d3fbcaf3efd60858b1918aada908d51231');
});

test('[SITE-S3] manifest and checksums include every page, asset, evidence file, anchor and decision, with no act/ or data/decision/ files', () => {
  const { manifest, checksums, output } = builtFixture;
  assert.equal(manifest.schema, 'site-bundle/v1');
  assert.equal(manifest.entry, 'index.html');
  assert.deepEqual(manifest.agentEntry, { path: 'index.md', anchors: 'reference-definitions/1' });
  assert.deepEqual(manifest.pages, sitePages(loadedFixture.site));
  assert.deepEqual(manifest.anchors, siteAnchors(loadedFixture.site));
  assert.deepEqual(manifest.decisions, siteDecisions(loadedFixture.site));
  assert.equal(checksums.contentId, manifest.contentId);

  const paths = manifest.files.map((f) => f.path);
  for (const page of manifest.pages) {
    assert.ok(paths.includes(page.html), `missing ${page.html}`);
    assert.ok(paths.includes(page.markdown), `missing ${page.markdown}`);
  }
  assert.ok(!paths.some((p) => p.startsWith('act/') || p.startsWith('data/')), `unexpected interactive paths in ${JSON.stringify(paths)}`);
  assert.equal(output.size, manifest.files.length + 2);
  assert.deepEqual(collectSiteCitations(loadedFixture.site).get('queue-snapshot'), ['i-retention-window', 'q-retention-length']);
});

test('[SITE-S3] P7 anchor parity: every page has the exact same siteAnchors in HTML (id attribute) and Markdown ([id]: #id)', () => {
  const { manifest } = builtFixture;
  for (const page of manifest.pages) {
    const expected = manifest.anchors.filter((a) => a.page === page.id).map((a) => a.anchor);
    const ids = new Set(htmlIds(textOf(builtFixture, page.html)));
    const mdDefs = markdownAnchors(textOf(builtFixture, page.markdown));
    assert.deepEqual(mdDefs, expected, `markdown anchors on ${page.markdown}`);
    for (const anchor of expected) {
      assert.ok(ids.has(anchor), `HTML id "${anchor}" missing on ${page.html}`);
    }
  }
});

test('[SITE-S3] P2 & link resolution: every HTML page passes the security policy scan and every relative href resolves to an inventoried file and existing anchor', () => {
  const { manifest } = builtFixture;
  const inventory = new Set(manifest.files.map((f) => f.path));
  const idsByFile = new Map();
  for (const page of manifest.pages) {
    idsByFile.set(page.html, new Set(htmlIds(textOf(builtFixture, page.html))));
    idsByFile.set(page.markdown, new Set(markdownAnchors(textOf(builtFixture, page.markdown))));
  }

  for (const page of manifest.pages) {
    const html = textOf(builtFixture, page.html);
    assert.ok(!/<(?:script|form|input|button|select|textarea|iframe)\b/i.test(html), `forbidden tag on ${page.html}`);
    // Resolve relative hrefs from page.html to bundle-root paths before passing to scanHtmlPolicy,
    // and check fragment targets on the destination page.
    for (const [, rawHref] of html.matchAll(/\shref="([^"]+)"/g)) {
      const href = rawHref.replace(/&amp;/g, '&');
      if (href.startsWith('#')) {
        const frag = href.slice(1);
        assert.ok(idsByFile.get(page.html).has(frag), `${page.html}: missing local fragment #${frag}`);
        continue;
      }
      if (href.startsWith('https://')) continue;
      const [relPart, frag] = href.split('#');
      const target = landsOn(page.html, relPart);
      assert.ok(inventory.has(target) || target === 'manifest.json' || target === 'checksums.json', `${page.html}: href ${href} -> ${target} not in inventory`);
      if (frag) {
        assert.ok(idsByFile.get(target)?.has(frag), `${page.html}: href ${href} -> ${target}#${frag} missing target id`);
      }
    }
  }

  for (const file of manifest.files.filter((f) => f.path.endsWith('.css'))) {
    assert.deepEqual(scanCssPolicy(textOf(builtFixture, file.path), inventory), []);
  }
});

test('[SITE-S3] counts, coverage and unassigned rules: null is "not recorded", 0 is "0", partial labels numbers, unavailable links gaps, unassigned page only when needed', () => {
  const bundle = buildCustom((s) => {
    s.areas.push({
      areaRef: 'ops',
      title: 'Operations',
      counts: { waiting: 2, moved: 0, blocked: null, coverage: 'partial', gapRefs: ['research-unread'], unit: 'tracked ops tickets' },
      projects: [],
    });
  });
  const portfolioHtml = textOf(bundle, 'index.html');
  const portfolioMd = textOf(bundle, 'index.md');
  const researchHtml = textOf(bundle, 'area/research/index.html');
  const opsHtml = textOf(bundle, 'area/ops/index.html');
  const opsMd = textOf(bundle, 'area/ops/index.md');

  // Platform has complete coverage with waiting=3, moved=1, blocked=0
  assert.match(portfolioHtml, /original waiting items/);
  assert.match(portfolioHtml, />0</);
  // Research has unavailable coverage: null renders as "not recorded", never "0"
  assert.match(researchHtml, /not recorded/);
  assert.match(researchHtml, /unavailable/i);
  assert.match(researchHtml, /#g-research-unread/);
  // Ops has partial coverage: recorded counts are labelled partial, null is not recorded
  assert.match(opsHtml, /2 \(partial\)/);
  assert.match(opsHtml, /0 \(partial\)/);
  assert.match(opsHtml, /not recorded/);
  assert.match(opsHtml, /tracked ops tickets/);
  assert.match(opsMd, /2 \(partial\)/);
  assert.match(opsMd, /not recorded/);
  assert.match(portfolioMd, /tracked ops tickets/);
});

test('[SITE-S3] P14 reading order on item page: question -> options -> recommendation -> evidence, in both HTML and Markdown', () => {
  const itemHtml = textOf(builtFixture, 'item/retention-window/index.html');
  const itemMd = textOf(builtFixture, 'item/retention-window/index.md');

  for (const text of [itemHtml, itemMd]) {
    const qPos = text.indexOf('How long must a published edition stay readable?');
    const opt1Pos = text.indexOf('30 days');
    const opt2Pos = text.indexOf('90 days');
    const opt3Pos = text.indexOf('Keep everything');
    const recPos = text.indexOf('90 days covers every review cycle seen so far.');
    const evPos = text.indexOf('Queue snapshot');
    assert.ok(qPos > 0 && opt1Pos > qPos && opt2Pos > opt1Pos && opt3Pos > opt2Pos && recPos > opt3Pos && evPos > recPos, 'reading order holds');
    assert.ok(!text.includes('Answering needs the SitRep service'), 'no shell-less warning boilerplate');
    assert.ok(!text.includes('act/retention-choice'), 'no action route link');
  }
});

test('[SITE-S3] history links resolve to sibling bundles when history is present', () => {
  const priorId = `sha256-${'11'.repeat(32)}`;
  const bundle = buildCustom((s) => {
    s.history = [{ editionId: 'synthetic-edition-0000', contentId: priorId, observedAt: '2026-10-11T09:00:00Z' }];
  });
  const html = textOf(bundle, 'index.html');
  const md = textOf(bundle, 'index.md');
  assert.ok(html.includes(`href="../${priorId}/index.html"`));
  assert.ok(md.includes(`(../${priorId}/index.md)`));
});

test('[SITE-S3] P5 escaping: hostile markup and Markdown syntax in site input fields stay inert text in HTML and CommonMark', () => {
  const hostile = '<script>alert(1)</script> & "q" [x](https://evil.example) `c` *e*';
  const bundle = buildCustom((s) => {
    s.title = `Title ${hostile}`;
    s.areas[0].title = `Area ${hostile}`;
    s.areas[0].counts.unit = `unit ${hostile}`;
    s.areas[0].projects[0].title = `Project ${hostile}`;
    s.items[0].title = `Item ${hostile}`;
    s.items[0].age = `age ${hostile}`;
    s.decisions[0].label = `Decision ${hostile}`;
    s.decisions[0].questions[0].text = `Question ${hostile}`;
    s.decisions[0].questions[0].options[0].label = `Option ${hostile}`;
    s.decisions[0].questions[0].options[0].summary = `Summary ${hostile}`;
    s.decisions[0].questions[0].recommendation.text = `Rec ${hostile}`;
    s.gaps[0].text = `Gap ${hostile}`;
  });
  const parser = new Parser();
  for (const page of bundle.manifest.pages) {
    const html = textOf(bundle, page.html);
    assert.ok(!html.includes('<script>'), `raw <script> in ${page.html}`);
    assert.ok(!html.includes('href="https://evil.example"'), `injected link in ${page.html}`);

    const md = textOf(bundle, page.markdown);
    const ast = parser.parse(md);
    const walker = ast.walker();
    let event;
    while ((event = walker.next())) {
      if (!event.entering) continue;
      const { type, destination } = event.node;
      assert.notEqual(type, 'html_block', `raw html_block in ${page.markdown}`);
      assert.notEqual(type, 'html_inline', `raw html_inline in ${page.markdown}`);
      if (type === 'link') {
        assert.notEqual(destination, 'https://evil.example', `injected markdown link in ${page.markdown}`);
      }
    }
  }
});

test('[SITE-S3] editionDigest and registry version/sha256 appear on every page, arbitrary gap/decision kinds render literally, and cross-page Markdown citations resolve', () => {
  const bundle = buildCustom((s) => {
    s.gaps[0].kind = 'decision-coverage-loss';
    s.decisions[0].kind = 'constructor';
    s.items[1].blocks = [{ type: 'paragraph', text: ['Second item also cites ', { cite: 'queue-snapshot' }, '.'] }];
  });
  for (const page of bundle.manifest.pages) {
    const html = textOf(bundle, page.html);
    const md = textOf(bundle, page.markdown);
    assert.ok(html.includes(loadedFixture.site.edition.editionDigest), `editionDigest in ${page.html}`);
    assert.ok(html.includes(loadedFixture.site.registry.version), `registry.version in ${page.html}`);
    assert.ok(html.includes(loadedFixture.site.registry.sha256), `registry.sha256 in ${page.html}`);
    assert.ok(md.includes(loadedFixture.site.edition.editionDigest), `editionDigest in ${page.markdown}`);
    assert.ok(md.includes(loadedFixture.site.registry.version), `registry.version in ${page.markdown}`);
    assert.ok(md.includes(loadedFixture.site.registry.sha256), `registry.sha256 in ${page.markdown}`);
    const ids = htmlIds(html);
    assert.equal(ids.length, new Set(ids).size, `no duplicate HTML ids on ${page.html}`);
  }
  const researchHtml = textOf(bundle, 'area/research/index.html');
  const itemHtml = textOf(bundle, 'item/retention-window/index.html');
  assert.ok(researchHtml.includes('decision-coverage-loss') && !researchHtml.includes('undefined'));
  assert.ok(itemHtml.includes('>constructor<') && !itemHtml.includes('native code'));

  // Second item page cites E1 (owned by item/retention-window) and defines [E1] pointing there
  const orphanMd = textOf(bundle, 'item/orphan-request/index.md');
  assert.match(orphanMd, /^\[E1\]: \.\.\/\.\.\/item\/retention-window\/index\.md#ev-queue-snapshot$/m);

  // R2-F1: Authored literal "[E1]" in prose is never unescaped into a live CommonMark link
  const withLiteralCite = buildCustom((s) => {
    s.gaps[0].text = 'Plain text mentioning [E1] and [e2] must stay literal text.';
  });
  const researchMd = textOf(withLiteralCite, 'area/research/index.md');
  const ast = new Parser().parse(researchMd);
  const walker = ast.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'link') {
      assert.ok(!ev.node.destination.includes('#ev-'), `unexpected citation link ${ev.node.destination} from authored prose`);
    }
  }
});

test('[SITE-S3] buildSiteBundle writes the complete bundle directory and refuses to overwrite an existing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-site-s3-'));
  try {
    const outDir = join(dir, 'bundle');
    const res = await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir });
    assert.equal(res.outDir, outDir);
    const manifestOnDisk = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifestOnDisk.contentId, res.contentId);
    await assert.rejects(() => buildSiteBundle({ sitePath: SITE_FIXTURE, outDir }), { code: 'output-exists' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[SITE-S3] P11/P13 browser geometry and accessibility: every site-bundle/v1 page renders in the full document column without horizontal scroll, duplicate headings, or WCAG violations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-site-browser-'));
  let srv;
  let browser;
  try {
    const bundleDir = join(dir, 'bundle');
    const storeDir = join(dir, 'store');
    await buildSiteBundle({ sitePath: SITE_FIXTURE, outDir: bundleDir });
    const pub = await publishPacket({ packetDir: bundleDir, root: storeDir });
    await setAlias({ root: storeDir, name: 'sitrep-test', contentId: pub.contentId, expectGeneration: 0 });
    srv = await startServer({ root: storeDir });
    browser = await chromium.launch();

    for (const [vpName, width, height] of [['desktop', 1600, 1000], ['laptop', 1280, 900], ['phone', 390, 844]]) {
      const context = await browser.newContext({ bypassCSP: true, viewport: { width, height } });
      const page = await context.newPage();
      for (const pageEntry of builtFixture.manifest.pages) {
        const url = `${srv.url}/p/${pub.contentId}/${pageEntry.html}`;
        await page.goto(url, { waitUntil: 'load' });
        const m = await page.evaluate(() => {
          const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
          const rect = (el) => el.getBoundingClientRect();
          const mainRect = rect(document.querySelector('main.document'));
          const targets = [...document.querySelectorAll('.toc a, .rail a, .toc summary, .site-footer a')].filter(vis);
          const smallTargets = targets
            .filter((el) => rect(el).height < 44 || rect(el).width < 24)
            .map((el) => `${el.tagName}.${el.className}:${el.textContent.trim().slice(0, 30)}:${Math.round(rect(el).height)}`);
          const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
            .filter(vis)
            .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.replace(/^[A-Za-z0-9]{2}\s+/, '').trim() }));
          const skips = headings.filter((h, i) => i > 0 && h.level > headings[i - 1].level + 1);
          const h1Text = document.querySelector('h1')?.textContent.trim() ?? '';
          const firstH2Text = (document.querySelector('.section > h2')?.textContent ?? '').replace(/^[A-Za-z0-9]{2}\s+/, '').trim();
          const sectionNums = [...document.querySelectorAll('.section > h2 .sec-num')].map((el) => el.textContent.trim());
          const proseEl = document.querySelector('.question__prompt, .section > p:not(.lede):not(.claim)');
          const proseFont = proseEl ? getComputedStyle(proseEl).fontFamily : '';
          const inlineCodeEl = document.querySelector('main.document code');
          const inlineCodeStyle = inlineCodeEl ? getComputedStyle(inlineCodeEl) : null;
          const inlineCodeColor = inlineCodeStyle ? inlineCodeStyle.color : '';
          const inlineCodeBorder = inlineCodeStyle ? inlineCodeStyle.borderTopWidth : '0px';
          const bodyColor = getComputedStyle(document.body).color;
          const proseSheet = document.querySelector('.prose-sheet');
          const proseSheetWidthGap = proseSheet ? Math.round(mainRect.width - rect(proseSheet).width) : 0;
          const proseSheetBody = document.querySelector('.prose-sheet__body');
          const proseSheetBodyWidth = proseSheetBody ? Math.round(rect(proseSheetBody).width) : null;
          const proseSheetMeta = document.querySelector('.prose-sheet__meta');
          const proseSheetMetaWidth = proseSheetMeta ? Math.round(rect(proseSheetMeta).width) : null;
          const visibleUppercaseLabels = [...document.querySelectorAll('main *')].filter(
            (el) => vis(el) && getComputedStyle(el).textTransform === 'uppercase' && el.children.length === 0,
          ).length;
          const railLevels = [...document.querySelectorAll('.rail a[data-nav-level]')].map((el) => el.getAttribute('data-nav-level'));
          const tableOverflowPx = [...document.querySelectorAll('.table__scroll')]
            .filter(vis)
            .reduce((max, el) => Math.max(max, Math.round(el.scrollWidth - el.clientWidth)), 0);
          const maxMetaDtHeight = [...document.querySelectorAll('.title-meta dt')]
            .filter(vis)
            .reduce((max, el) => Math.max(max, Math.round(rect(el).height)), 0);
          const maxQuestionRefHeight = [...document.querySelectorAll('.question__ref')]
            .filter(vis)
            .reduce((max, el) => Math.max(max, Math.round(rect(el).height)), 0);
          const tocSummary = document.querySelector('.toc summary');
          const tocChevronContent = tocSummary ? getComputedStyle(tocSummary, '::after').content : 'none';
          const triageScopeCount = document.querySelectorAll('.table--triage .triage-scope').length;
          const unassignedOverlineCount = document.querySelectorAll('#a-unassigned .field-label').length;
          let existingLegend = document.querySelector('details.legend');
          let tempLegend = false;
          if (!existingLegend) {
            existingLegend = document.createElement('details');
            existingLegend.className = 'legend';
            existingLegend.innerHTML = '<summary>Aged close candidates (1)</summary><ul class="list item-links"><li><a href="#content">Item</a></li></ul>';
            document.querySelector('main.document').appendChild(existingLegend);
            tempLegend = true;
          }
          const legendSum = existingLegend.querySelector('summary');
          const sumTextRect = () => {
            const r = document.createRange();
            r.selectNodeContents(legendSum.firstChild);
            return r.getBoundingClientRect();
          };
          const prevOpen = existingLegend.open;
          existingLegend.open = false;
          const closedRect = sumTextRect();
          existingLegend.open = true;
          const openRect = sumTextRect();
          existingLegend.open = prevOpen;
          if (tempLegend) existingLegend.remove();
          const legendSummaryTextShiftPx = Math.max(
            Math.abs(openRect.top - closedRect.top),
            Math.abs(openRect.left - closedRect.left),
          );
          const railLinks = [...document.querySelectorAll('.rail .nav-item > a')].filter(vis);
          let maxNavBorderGapPx = 0;
          for (let i = 0; i < railLinks.length; i += 1) {
            const a = railLinks[i];
            const li = a.parentElement;
            const nextLi = li.nextElementSibling;
            if (nextLi) {
              const gapToNextItem = Math.abs(rect(nextLi).top - rect(a).bottom);
              maxNavBorderGapPx = Math.max(maxNavBorderGapPx, Math.round(gapToNextItem * 10) / 10);
            }
          }
          const metricsEl = document.querySelector('.metrics');
          let metricsGapRight = 0;
          if (metricsEl) {
            const mRect = rect(metricsEl);
            const lastCellRect = rect(metricsEl.lastElementChild);
            metricsGapRight = Math.round(mRect.right - lastCellRect.right);
          }
          return {
            innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            mastheadRight: Math.round(rect(document.querySelector('.masthead')).right),
            mainRight: Math.round(mainRect.right),
            mainWidth: Math.round(mainRect.width),
            metricsWidth: metricsEl ? Math.round(rect(metricsEl).width) : null,
            metricsGapRight,
            findingInnerWidth: document.querySelector('.finding > h3') ? Math.round(rect(document.querySelector('.finding > h3')).width) : null,
            railVisible: vis(document.querySelector('.rail')),
            tocVisible: vis(document.querySelector('.toc')),
            smallTargets,
            skips,
            h1Text,
            firstH2Text,
            sectionNums,
            proseFont,
            inlineCodeColor,
            inlineCodeBorder,
            bodyColor,
            proseSheetWidthGap,
            proseSheetBodyWidth,
            proseSheetMetaWidth,
            visibleUppercaseLabels,
            railLevels,
            tableOverflowPx,
            maxMetaDtHeight,
            maxQuestionRefHeight,
            tocChevronContent,
            triageScopeCount,
            unassignedOverlineCount,
            legendSummaryTextShiftPx,
            maxNavBorderGapPx,
          };
        });
        assert.ok(m.scrollWidth <= m.innerWidth, `${pageEntry.html} (${vpName}): horizontal scroll ${m.scrollWidth} > ${m.innerWidth}`);
        assert.ok(m.tableOverflowPx <= 2, `${pageEntry.html} (${vpName}): .table__scroll overflows horizontally by ${m.tableOverflowPx}px`);
        assert.ok(m.maxMetaDtHeight <= 26, `${pageEntry.html} (${vpName}): .title-meta dt wrapped onto multiple lines (${m.maxMetaDtHeight}px > 26px)`);
        assert.ok(m.maxQuestionRefHeight <= 32, `${pageEntry.html} (${vpName}): .question__ref wrapped onto multiple lines (${m.maxQuestionRefHeight}px > 32px)`);
        assert.notEqual(m.tocChevronContent, 'none', `${pageEntry.html} (${vpName}): .toc summary must render a disclosure chevron via ::after`);
        assert.ok(m.legendSummaryTextShiftPx === 0, `${pageEntry.html} (${vpName}): details.legend summary text shifted by ${m.legendSummaryTextShiftPx}px when toggled open/closed`);
        assert.equal(m.maxNavBorderGapPx, 0, `${pageEntry.html} (${vpName}): .rail nav item has ${m.maxNavBorderGapPx}px gap between its highlight box and the next item's border`);
        assert.ok(m.visibleUppercaseLabels <= 12, `${pageEntry.html} (${vpName}): too many tracked-out ALL-CAPS labels (${m.visibleUppercaseLabels} > 12)`);
        assert.ok(m.railLevels.includes('area') && m.railLevels.includes('project'), `${pageEntry.html} (${vpName}): .rail must encode structural hierarchy via data-nav-level, got ${JSON.stringify(m.railLevels)}`);
        assert.ok(m.proseSheetWidthGap <= 2, `${pageEntry.html} (${vpName}): .prose-sheet is narrowed by ${m.proseSheetWidthGap}px relative to main.document (${m.mainWidth}px)`);
        if (pageEntry.html === 'index.html') {
          assert.ok(m.triageScopeCount > 0, `index.html (${vpName}): portfolio triage table must show project/area .triage-scope attribution`);
        }
        if (pageEntry.html === 'area/unassigned/index.html') {
          assert.ok(m.unassignedOverlineCount > 0, `area/unassigned/index.html (${vpName}): unassigned area page must group items via renderItemLinksList (.overline)`);
        }
        if (m.inlineCodeColor) {
          assert.notEqual(m.inlineCodeColor, m.bodyColor, `${pageEntry.html} (${vpName}): inline <code> must have dedicated syntax ink color distinct from body ink (${m.bodyColor})`);
          assert.notEqual(m.inlineCodeBorder, '0px', `${pageEntry.html} (${vpName}): inline <code> must have a crisp border token`);
        }
        if (pageEntry.html.startsWith('item/') && width >= 1280) {
          assert.ok(m.proseSheetBodyWidth !== null && m.proseSheetBodyWidth <= 760, `${pageEntry.html} (${vpName}): item supporting context must have a bounded .prose-sheet__body speed-reading measure (<=760px), got ${m.proseSheetBodyWidth}`);
          assert.ok(m.proseSheetMetaWidth !== null && m.proseSheetMetaWidth <= 320, `${pageEntry.html} (${vpName}): item supporting context must have a side-by-side .prose-sheet__meta dossier column (<=320px) filling the right side of the card, got ${m.proseSheetMetaWidth}`);
        }
        if (m.proseFont) {
          assert.match(m.proseFont, /Libron/i, `${pageEntry.html} (${vpName}): reading prose must use Libron serif, got ${m.proseFont}`);
        }
        if (pageEntry.html === 'index.html') {
          assert.equal(m.sectionNums[0], 'Dc', `index.html (${vpName}): Decision triage queue (Dc) must appear above Areas (01), got ${JSON.stringify(m.sectionNums)}`);
        }
        if (pageEntry.html === 'item/retention-window/index.html') {
          assert.equal(m.sectionNums[0], 'Dc', `item/retention-window/index.html (${vpName}): BLUF requires Decisions (Dc) above Item summary (It), got ${JSON.stringify(m.sectionNums)}`);
        }
        if (width > 1024) {
          assert.equal(m.railVisible, true, `${pageEntry.html} (${vpName}): .rail must be visible on wide viewports (mainWidth=${m.mainWidth})`);
          assert.equal(m.tocVisible, false, `${pageEntry.html} (${vpName}): .toc must be hidden on wide viewports`);
          assert.ok(m.mainWidth >= 700, `${pageEntry.html} (${vpName}): main.document width ${m.mainWidth}px crushed into rail column`);
          assert.ok(Math.abs(m.mainRight - m.mastheadRight) <= 2, `${pageEntry.html} (${vpName}): main.document right edge (${m.mainRight}px) must align with .masthead right edge (${m.mastheadRight}px)`);
        } else {
          assert.equal(m.railVisible, false, `${pageEntry.html} (${vpName}): .rail must be hidden on narrow viewports`);
          assert.equal(m.tocVisible, true, `${pageEntry.html} (${vpName}): .toc must be visible on narrow viewports`);
          assert.ok(m.mainWidth >= 320, `${pageEntry.html} (${vpName}): main.document width ${m.mainWidth}px too narrow on phone`);
        }
        if (m.metricsWidth !== null) {
          assert.ok(m.metricsGapRight <= 2, `${pageEntry.html} (${vpName}): .metrics last cell leaves ${m.metricsGapRight}px of unfilled grey background on the right`);
          if (m.findingInnerWidth !== null) {
            assert.ok(Math.abs(m.metricsWidth - m.findingInnerWidth) <= 2, `${pageEntry.html} (${vpName}): .metrics width (${m.metricsWidth}px) must span the full finding container width (${m.findingInnerWidth}px)`);
          }
        }
        assert.deepEqual(m.smallTargets, [], `${pageEntry.html} (${vpName}): touch targets < 44px`);
        assert.deepEqual(m.skips, [], `${pageEntry.html} (${vpName}): skipped heading levels ${JSON.stringify(m.skips)}`);
        assert.notEqual(m.firstH2Text, m.h1Text, `${pageEntry.html} (${vpName}): first <h2> duplicates <h1> "${m.h1Text}"`);

        await page.addScriptTag({ content: AXE_SOURCE });
        const axe = await page.evaluate(async () => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
          resultTypes: ['violations'],
        }));
        assert.deepEqual(
          axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
          [],
          `${pageEntry.html} (${vpName}): axe violations`,
        );
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    if (srv?.server) await new Promise((r) => srv.server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
