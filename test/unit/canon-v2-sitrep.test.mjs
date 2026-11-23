import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../../src/hash.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { validateReport } from '../../src/report/validate.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';
import { validateSiteInput } from '../../src/site/validate.mjs';
import { verifySiteBundle } from '../../src/site/verify.mjs';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require('playwright-core');
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

function makeV2SitrepFixture() {
  return {
    schema: 'site-input/v1',
    title: 'Platform & Storage Engineering — Weekly SitRep',
    edition: {
      editionId: 'sitrep-2026-w46-v2',
      editionDigest: '89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
      observedAt: '2026-11-14T17:00:00Z',
      coverage: {
        from: '2026-11-07T17:00:00Z',
        to: '2026-11-14T17:00:00Z',
      },
    },
    registry: {
      version: 'registry-2026.11.2',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    areas: [
      {
        areaRef: 'storage',
        title: 'Storage Engine & WAL',
        counts: {
          waiting: 2,
          moved: 5,
          blocked: 1,
          coverage: 'complete',
          gapRefs: [],
          unit: 'workstream items',
        },
        projects: [
          { projectRef: 'wal-compaction', title: 'Zero-Copy WAL Compaction' },
          { projectRef: 'snapshot-tiering', title: 'Cold Object Tiering' },
        ],
      },
      {
        areaRef: 'runtime',
        title: 'Control Plane & Tailscale Edge',
        counts: {
          waiting: 1,
          moved: 3,
          blocked: null,
          coverage: 'partial',
          gapRefs: ['gap-edge-blocked'],
          unit: 'workstream items',
        },
        projects: [
          { projectRef: 'canon-daemon', title: 'Canon Workstation Daemon' },
        ],
      },
      {
        areaRef: 'hardware-lab',
        title: 'Bare-Metal Power-Loss Lab',
        counts: {
          waiting: null,
          moved: null,
          blocked: null,
          coverage: 'unavailable',
          gapRefs: ['gap-lab-offline'],
          unit: 'workstream items',
        },
        projects: [],
      },
    ],
    items: [
      {
        itemRef: 'wal-standby-ring',
        title: 'Pre-allocated standby segment ring sizing & epoch sweeper',
        areaRef: 'storage',
        projectRef: 'wal-compaction',
        age: 'waiting 2 days',
        blocks: [
          {
            type: 'paragraph',
            text: [
              'Compaction workers MUST defer ',
              { code: 'munmap()' },
              ' until all pinned reader epochs clear ',
              { cite: 'ev-compaction-json' },
              '.',
            ],
          },
          {
            type: 'finding',
            id: 'find-ring-churn',
            title: 'Zero-copy mmap slices cut page-cache writeback by 93.8%',
            severity: 'critical',
            confidence: 'proven',
            verification: { band: 'code', detail: 'cargo test -p wal --test epoch_reclaim' },
            claim: [
              'Dirty writeback drops from 612.5 MiB/s to 38.2 MiB/s under 8 writers ',
              { cite: 'ev-latency-csv' },
              '.',
            ],
            evidence: ['ev-latency-csv', 'ev-compaction-json'],
          },
          {
            type: 'diagram',
            id: 'topo-wal-ring',
            kind: 'topology',
            title: 'Standby ring & epoch reclamation topology',
            caption: 'Writers rotate standby segments without blocking pinned mmap readers.',
            groups: [
              {
                id: 'g-hot',
                label: 'Append Path',
                nodes: [
                  { id: 'n-writer', label: 'Shard Writer', sublabel: 'Lock-free cursor' },
                  { id: 'n-ring', label: 'Standby Ring', sublabel: '2 x 64 MiB warm' },
                ],
              },
              {
                id: 'g-reclaim',
                label: 'Reclamation',
                nodes: [
                  { id: 'n-sweep', label: 'Epoch Sweeper', sublabel: 'min_reader_epoch', role: 'gate' },
                ],
              },
            ],
            edges: [
              { from: 'n-writer', to: 'n-ring', label: 'rollover' },
              { from: 'n-ring', to: 'n-sweep', label: 'retire gate', style: 'gate' },
            ],
          },
          {
            type: 'chart',
            id: 'cmp-wal-p99',
            kind: 'comparison',
            title: 'Stage p99 latency: legacy vs zero-copy',
            baselineLabel: 'Legacy heap copy',
            candidateLabel: 'Epoch-pinned mmap',
            higherIsBetter: false,
            unit: 'ms',
            series: [
              { label: 'Append frame', baseline: 148.4, value: 4.6 },
              { label: 'Segment seal', baseline: 119.5, value: 11.8 },
            ],
            caption: 'Measured across 14.4M synthetic mixed-workload operations.',
            evidence: ['ev-latency-csv'],
          },
          {
            type: 'requirement',
            id: 'req-epoch-pin',
            title: 'Deferred unmap under active reader lease',
            pattern: 'state',
            statement: 'WHILE any reader holds an active epoch <= segment.max_epoch, the sweeper SHALL retain the segment mapping.',
            verification: { band: 'code', detail: 'tests/epoch_pinning.rs' },
            scenarios: [
              {
                name: 'Pinned reader delays munmap',
                given: 'segment 41 is retired at epoch 900 and reader R1 holds epoch 895',
                when: 'the compaction sweeper evaluates retired segments',
                then: 'segment 41 remains mapped until R1 advances past 900',
              },
            ],
            evidence: ['ev-compaction-json'],
          },
          {
            type: 'comparison',
            id: 'cmp-ring-alloc',
            title: 'Rollover allocation path contrast',
            left: {
              label: 'On-demand fallocate()',
              tone: 'legacy',
              summary: 'Allocates 64 MiB synchronously on segment boundary.',
              items: ['Blocks writer thread on filesystem metadata journal'],
            },
            right: {
              label: 'Warm standby ring',
              tone: 'proposed',
              summary: 'Swaps pre-zeroed standby fd in O(1) atomic pointer exchange.',
              items: ['Background worker replenishes standby slot asynchronously'],
            },
          },
          {
            type: 'risk',
            id: 'risk-pinned-cursor',
            title: 'Stuck reader cursor delays segment unlink',
            likelihood: 'medium',
            impact: 'high',
            mitigation: 'Enforce 30-second lease timeout with copy-on-expire fallback.',
          },
          {
            type: 'risk',
            id: 'risk-nvme-space',
            title: 'Multi-shard standby reservation overhead',
            likelihood: 'low',
            impact: 'medium',
            mitigation: 'Cap standby pool at 2 segments (128 MiB) per active shard.',
          },
        ],
      },
      {
        itemRef: 'cold-tier-lifecycle',
        title: 'Deterministic POSIX tar envelope for cold S3 tiering',
        areaRef: 'storage',
        projectRef: 'snapshot-tiering',
        age: 'blocked 4 days',
        blocks: [
          {
            type: 'paragraph',
            text: [
              'Cold object uploads are blocked pending envelope approval; cross-citing benchmark summary ',
              { cite: 'ev-compaction-json' },
              '.',
            ],
          },
        ],
      },
      {
        itemRef: 'tailnet-host-pinning',
        title: 'DNS-rebinding Host allowlist & CanonBar reconciliation',
        areaRef: 'runtime',
        projectRef: 'canon-daemon',
        age: 'moved today',
        blocks: [
          {
            type: 'paragraph',
            text: 'Shipped strict Host header allowlist and live menu bar status polling.',
          },
        ],
      },
    ],
    decisions: [
      {
        decisionRef: 'dec-standby-segments',
        itemRef: 'wal-standby-ring',
        kind: 'architecture',
        label: 'Approve per-shard warm standby segment count',
        questions: [
          {
            questionRef: 'q-standby-count',
            text: 'How many 64 MiB standby segments should each shard pre-allocate?',
            options: [
              { optionRef: 'opt-one-seg', label: '1 segment (64 MiB)', summary: 'Minimal disk footprint, but back-to-back burst rollovers hit fallocate().' },
              { optionRef: 'opt-two-seg', label: '2 segments (128 MiB)', summary: 'Absorbs double-rollover bursts with zero append stalls.' },
              { optionRef: 'opt-four-seg', label: '4 segments (256 MiB)', summary: 'Over-reserves NVMe space on high-density multi-shard nodes.' },
            ],
            freeText: { allowed: true, maxChars: 500 },
            recommendation: {
              optionRef: 'opt-two-seg',
              text: '2 segments (128 MiB) eliminates rollover stalls without straining multi-shard NVMe capacity.',
            },
            evidence: ['ev-latency-csv', 'ev-compaction-json'],
          },
        ],
      },
      {
        decisionRef: 'dec-archive-codec',
        itemRef: 'cold-tier-lifecycle',
        kind: 'policy',
        label: 'Select cold-tier archive envelope',
        questions: [
          {
            questionRef: 'q-archive-format',
            text: 'Which deterministic archive envelope should cold tiering standardize on?',
            options: [
              { optionRef: 'opt-raw-tar', label: 'Deterministic POSIX tar', summary: 'Zero-dependency streaming inspection and content-addressed manifest parity.' },
              { optionRef: 'opt-zstd-tar', label: 'Zstandard-framed tar', summary: 'Smaller object footprint, requires pinned decoder version.' },
            ],
            freeText: { allowed: false },
            recommendation: {
              optionRef: 'opt-raw-tar',
              text: 'Standardize on deterministic POSIX tar with external S3 storage-class compression.',
            },
          },
        ],
      },
    ],
    gaps: [
      {
        gapRef: 'gap-edge-blocked',
        kind: 'telemetry-gap',
        text: 'Blocked ticket counter was not exported by the daemon telemetry collector during W46.',
      },
      {
        gapRef: 'gap-lab-offline',
        kind: 'facility-maintenance',
        text: 'Bare-metal power-cut rack is offline for PDU maintenance through Monday.',
      },
    ],
    evidence: [
      {
        id: 'ev-latency-csv',
        title: 'Stage latency percentiles & allocation profile (CSV)',
        kind: 'file',
        path: 'evidence/wal-latency.csv',
        mediaType: 'text/csv',
      },
      {
        id: 'ev-compaction-json',
        title: '30-minute mixed-workload benchmark summary (JSON)',
        kind: 'file',
        path: 'evidence/compaction-run.json',
        mediaType: 'application/json',
      },
    ],
  };
}

test('[Canon-v2 SitRep] builds, verifies, renders archival slate palette, portfolio pulse + SVG area chart, inline evidence previews, and House Rules blocks with zero WCAG or layout issues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-sitrep-'));
  let browser;
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\nseal,119.5,11.8\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), JSON.stringify({ ops: 14400000, append_p99_ms: 4.6, stalls_gt_100ms: 0 }, null, 2) + '\n');
    const sitePath = join(dir, 'sitrep.site-input.json');
    await writeFile(sitePath, JSON.stringify(makeV2SitrepFixture(), null, 2));

    const outDir = join(dir, 'bundle');
    const bundle = await buildSiteBundle({ sitePath, outDir });
    const verified = await verifySiteBundle(outDir);
    assert.equal(verified.ok, true, `verifySiteBundle errors: ${JSON.stringify(verified.errors)}`);

    const indexHtml = bundle.output.get('index.html').toString('utf8');
    const itemHtml = bundle.output.get('item/wal-standby-ring/index.html').toString('utf8');

    // 1. Canon v2 brand mark, portfolio pulse KPI strip, pure-SVG cross-area workload chart, and semantic age pills
    assert.match(indexHtml, /<span class="brand__mark" aria-hidden="true">C<\/span>/);
    assert.match(indexHtml, /class="sitrep-pulse"/);
    assert.match(indexHtml, /class="figure sitrep-area-chart"/);
    assert.match(indexHtml, /age-pill--blocked/);
    assert.match(indexHtml, /age-pill--waiting/);
    assert.match(indexHtml, /age-pill--moved/);

    // 2. Inline bundled evidence previews + cross-page Cited by back-references + 2x2 risk-grid on item page
    assert.match(itemHtml, /class="ev-preview"/);
    assert.match(itemHtml, /Inline CSV excerpt \(E1\)/);
    assert.match(itemHtml, /Inline JSON excerpt \(E2\)/);
    assert.match(itemHtml, /class="ev__cited"/);
    assert.match(itemHtml, /cold-tier-lifecycle\/index\.html#i-cold-tier-lifecycle/);
    assert.match(itemHtml, /class="risk-grid"/);

    // 3. Browser verification across viewports + light/dark mode WCAG 2.2 A/AA + SVG geometry + card surface check
    browser = await chromium.launch();
    for (const colorScheme of ['light', 'dark']) {
      for (const [vw, vh] of [[1440, 900], [820, 1180], [390, 844], [320, 800]]) {
        const context = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme, bypassCSP: true });
        const page = await context.newPage();
        for (const rel of ['index.html', 'item/wal-standby-ring/index.html']) {
          await page.goto(`file://${join(outDir, rel)}`, { waitUntil: 'load' });
          const metrics = await page.evaluate(() => {
            const problems = [];
            if (document.documentElement.scrollWidth > window.innerWidth) {
              problems.push({ kind: 'page-overflow', sw: document.documentElement.scrollWidth, vw: window.innerWidth });
            }
            for (const svg of document.querySelectorAll('svg.svg-graphic')) {
              const sr = svg.getBoundingClientRect();
              const texts = [...svg.querySelectorAll('text')].map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
              for (const t of texts) {
                if (t.r.left < sr.left - 1.5 || t.r.right > sr.right + 1.5 || t.r.top < sr.top - 1.5 || t.r.bottom > sr.bottom + 1.5) {
                  problems.push({ kind: 'svg-clipped', text: t.text.slice(0, 30) });
                }
              }
              for (let i = 0; i < texts.length; i += 1) {
                for (let j = i + 1; j < texts.length; j += 1) {
                  const a = texts[i].r;
                  const b = texts[j].r;
                  if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5
                    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5) {
                    problems.push({ kind: 'svg-overlap', a: texts[i].text.slice(0, 20), b: texts[j].text.slice(0, 20) });
                  }
                }
              }
            }
            const critCard = document.querySelector('.finding.sev-critical');
            const critBg = critCard ? getComputedStyle(critCard).backgroundColor : null;
            return { problems, critBg, paperBg: getComputedStyle(document.body).backgroundColor };
          });

          assert.deepEqual(metrics.problems, [], `${rel} (${colorScheme} ${vw}x${vh}): ${JSON.stringify(metrics.problems)}`);
          assert.notEqual(metrics.paperBg, 'rgb(242, 239, 231)', 'old warm-beige paper background must be replaced by archival slate');
          if (metrics.critBg) {
            const expectedCardBg = colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 24, 39)';
            assert.equal(metrics.critBg, expectedCardBg, `.finding.sev-critical card surface must stay clean (${colorScheme})`);
          }

          if (vw === 1440 || vw === 390) {
            await page.addScriptTag({ content: AXE_SOURCE });
            const axe = await page.evaluate(async () => window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
              resultTypes: ['violations'],
            }));
            assert.deepEqual(
              axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
              [],
              `${rel} (${colorScheme} ${vw}px) axe violations`,
            );
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep] max-schema unbroken tokens across Portfolio, Area, Project, Unassigned, and Item pages never overflow or clip SVG text in Chromium or WebKit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-sitrep-stress-'));
  let chromiumBrowser;
  let webkitBrowser;
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), JSON.stringify({ token: 'W'.repeat(180) }, null, 2) + '\n');

    const base = makeV2SitrepFixture();
    base.title = 'W'.repeat(160);
    base.edition.editionId = `ed-${'w'.repeat(58)}`;
    base.registry.version = `reg-${'w'.repeat(58)}`;
    base.areas[0].title = 'W'.repeat(120);
    base.areas[0].counts.unit = 'W'.repeat(80);
    base.areas[0].projects[0].title = 'M'.repeat(120);
    base.items[0].title = 'W'.repeat(200);
    base.items[0].age = `waiting ${'W'.repeat(72)}`;
    base.items[0].blocks.push(
      {
        type: 'finding',
        id: 'find-max-stress',
        title: 'W'.repeat(160),
        severity: 'critical',
        confidence: 'proven',
        verification: { band: 'code', detail: 'W'.repeat(200) },
        claim: 'W'.repeat(200),
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'chart',
        id: 'cmp-max-stress',
        kind: 'comparison',
        title: 'W'.repeat(120),
        baselineLabel: 'W'.repeat(60),
        candidateLabel: 'M'.repeat(60),
        higherIsBetter: false,
        unit: 'ms',
        series: [{ label: 'W'.repeat(80), baseline: 99999.9, value: 0.9 }],
        caption: 'W'.repeat(160),
      },
    );
    base.items.push({
      itemRef: 'unmapped-stress-item',
      title: 'M'.repeat(180),
      areaRef: null,
      projectRef: null,
      age: `blocked ${'M'.repeat(72)}`,
      gapRefs: ['gap-unmapped-stress'],
      blocks: [{ type: 'paragraph', text: 'W'.repeat(220) }],
    });
    base.gaps.push({
      gapRef: 'gap-unmapped-stress',
      kind: `k${'w'.repeat(39)}`,
      text: 'W'.repeat(220),
    });
    base.decisions[0].kind = `k${'w'.repeat(39)}`;
    base.decisions[0].label = 'W'.repeat(200);
    base.decisions[0].questions[0].questionRef = `q-${'w'.repeat(60)}`;
    base.decisions[0].questions[0].text = 'W'.repeat(200);
    base.decisions[0].questions[0].options[0].label = 'W'.repeat(120);
    base.decisions[0].questions[0].options[0].summary = 'W'.repeat(200);
    base.decisions[0].questions[0].recommendation.text = 'W'.repeat(200);
    base.decisions.push({
      decisionRef: 'dec-close-stress',
      itemRef: 'tailnet-host-pinning',
      kind: 'close-candidate',
      label: 'M'.repeat(180),
      questions: [
        {
          questionRef: 'q-close-stress',
          text: 'M'.repeat(180),
          options: [
            { optionRef: 'opt-close', label: 'W'.repeat(120), summary: 'W'.repeat(160) },
            { optionRef: 'opt-keep', label: 'M'.repeat(120), summary: 'M'.repeat(160) },
          ],
          freeText: { allowed: false },
          recommendation: { optionRef: 'opt-close', text: 'W'.repeat(180) },
        },
      ],
    });

    const sitePath = join(dir, 'stress.site-input.json');
    await writeFile(sitePath, JSON.stringify(base, null, 2));
    const outDir = join(dir, 'bundle');
    await buildSiteBundle({ sitePath, outDir });
    const verified = await verifySiteBundle(outDir);
    assert.equal(verified.ok, true, `verifySiteBundle errors: ${JSON.stringify(verified.errors)}`);

    const pagesToCheck = [
      'index.html',
      'area/storage/index.html',
      'area/storage/project/wal-compaction/index.html',
      'area/unassigned/index.html',
      'item/wal-standby-ring/index.html',
    ];

    chromiumBrowser = await chromium.launch();
    webkitBrowser = await webkit.launch();

    for (const [engineName, browser] of [['chromium', chromiumBrowser], ['webkit', webkitBrowser]]) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      for (const rel of pagesToCheck) {
        await page.goto(`file://${join(outDir, rel)}`, { waitUntil: 'load' });
        // Open any closed <details> drawers so hidden overflow inside drawers is also caught!
        await page.evaluate(() => {
          for (const d of document.querySelectorAll('details')) d.open = true;
        });
        for (const [vw, vh] of [[1600, 1000], [1280, 900], [390, 844], [320, 800]]) {
          await page.setViewportSize({ width: vw, height: vh });
          const problems = await page.evaluate(() => {
            const out = [];
            if (document.documentElement.scrollWidth > window.innerWidth) {
              out.push({ kind: 'page-overflow', vw: window.innerWidth, sw: document.documentElement.scrollWidth });
            }
            for (const svg of document.querySelectorAll('svg.svg-graphic')) {
              const sr = svg.getBoundingClientRect();
              const texts = [...svg.querySelectorAll('text')].map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
              for (const t of texts) {
                if (t.r.left < sr.left - 1.5 || t.r.right > sr.right + 1.5 || t.r.top < sr.top - 1.5 || t.r.bottom > sr.bottom + 1.5) {
                  out.push({ kind: 'svg-clipped', text: t.text.slice(0, 30) });
                }
              }
              for (let i = 0; i < texts.length; i += 1) {
                for (let j = i + 1; j < texts.length; j += 1) {
                  const a = texts[i].r;
                  const b = texts[j].r;
                  if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5
                    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5) {
                    out.push({ kind: 'svg-overlap', a: texts[i].text.slice(0, 20), b: texts[j].text.slice(0, 20) });
                  }
                }
              }
            }
            return out;
          });
          assert.deepEqual(problems, [], `${engineName} ${rel} @ ${vw}x${vh}: ${JSON.stringify(problems)}`);
        }
      }
      await page.close();
    }
  } finally {
    await chromiumBrowser?.close();
    await webkitBrowser?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep] committed specimen-sitrep-v2 fixture builds deterministically, passes verifySiteBundle + axe WCAG 2.2 across all page types, and rejects resealed forged -pv sub-ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-sitrep-specimen-'));
  let browser;
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const outA = join(dir, 'a');
    const outB = join(dir, 'b');
    const bundleA = await buildSiteBundle({ sitePath, outDir: outA });
    const bundleB = await buildSiteBundle({ sitePath, outDir: outB });
    assert.equal(bundleA.contentId, bundleB.contentId);
    assert.equal((await verifySiteBundle(outA)).ok, true);

    // Every generated HTML page passes axe WCAG 2.2 A/AA in light and dark modes with zero overflow
    const htmlPages = [...bundleA.output.keys()].filter((p) => p.endsWith('.html'));
    assert.ok(htmlPages.length >= 10, `expected >= 10 SitRep pages, got ${htmlPages.length}`);
    browser = await chromium.launch();
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme, bypassCSP: true });
      const page = await context.newPage();
      for (const rel of htmlPages) {
        await page.goto(`file://${join(outA, rel)}`, { waitUntil: 'load' });
        await page.addScriptTag({ content: AXE_SOURCE });
        const res = await page.evaluate(async () => {
          const axe = await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
            resultTypes: ['violations'],
          });
          return {
            sw: document.documentElement.scrollWidth,
            vw: window.innerWidth,
            violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
          };
        });
        assert.ok(res.sw <= res.vw, `${rel} (${colorScheme}): scrollWidth ${res.sw} > innerWidth ${res.vw}`);
        assert.deepEqual(res.violations, [], `${rel} (${colorScheme}) axe violations`);
      }
      await context.close();
    }

    // Instrument check 1: raw byte mutation fails verifySiteBundle
    const indexMdPath = join(outB, 'index.md');
    await writeFile(indexMdPath, `${await readFile(indexMdPath, 'utf8')}\n`);
    assert.equal((await verifySiteBundle(outB)).ok, false);

    // Instrument check 2: planting a forged id="pv-forged" or id="cap-chart-forged" and resealing checksums MUST fail verifySiteBundle P7 anchor parity
    const outC = join(dir, 'c');
    await buildSiteBundle({ sitePath, outDir: outC });
    const itemHtmlPath = join(outC, 'item/wal-standby-ring/index.html');
    const patchedHtml = (await readFile(itemHtmlPath, 'utf8')).replace(
      '</main>',
      '<div id="pv-forged">forged</div><div id="cap-chart-forged">forged</div></main>',
    );
    await writeFile(itemHtmlPath, patchedHtml);
    const manifest = JSON.parse(await readFile(join(outC, 'manifest.json'), 'utf8'));
    for (const entry of manifest.files) {
      const bytes = await readFile(join(outC, entry.path));
      entry.bytes = bytes.length;
      entry.sha256 = sha256Hex(bytes);
    }
    const { contentId: _old, ...identity } = manifest;
    const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
    const nextManifest = { ...identity, contentId };
    const manifestBytes = canonicalBytes(nextManifest);
    const checksums = {
      schema: 'checksums/v1',
      algorithm: 'sha256',
      contentId,
      manifestSha256: sha256Hex(manifestBytes),
      files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
    };
    await writeFile(join(outC, 'manifest.json'), manifestBytes);
    await writeFile(join(outC, 'checksums.json'), canonicalBytes(checksums));

    const forgedCheck = await verifySiteBundle(outC);
    assert.equal(forgedCheck.ok, false, 'resealed bundle with forged pv-forged / cap-chart-forged ids must be rejected');
    assert.ok(
      forgedCheck.errors.some((e) => String(e.message ?? e).includes('pv-forged')),
      `expected error naming pv-forged, got: ${JSON.stringify(forgedCheck.errors)}`,
    );
    assert.ok(
      forgedCheck.errors.some((e) => String(e.message ?? e).includes('cap-chart-forged')),
      `expected error naming cap-chart-forged, got: ${JSON.stringify(forgedCheck.errors)}`,
    );
  } finally {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R5-DEFECT-1] verifySiteBundle rejects resealed HTML5 ID differential attacks (uppercase ID=, entity-encoded ids, uppercase PV-/EV-/CAP- prefixes, duplicate ids, and text-node phantom anchors)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r5-defect1-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;

    async function buildAndMutateResealed(name, mutateFn) {
      const bundleDir = join(dir, name);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
      return verifySiteBundle(bundleDir);
    }

    // Positive control: unmodified resealed bundle passes
    const control = await buildAndMutateResealed('control', async () => {});
    assert.equal(control.ok, true, `control failed: ${JSON.stringify(control.errors)}`);

    const cases = [
      {
        name: 'uppercase-ID-forged-pv',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p ID="pv-forged">x</p></main>'));
        },
      },
      {
        name: 'uppercase-ID-forged-cap-chart',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p ID="cap-chart-forged">x</p></main>'));
        },
      },
      {
        name: 'uppercase-ID-duplicate-dom-id',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<span ID="triage-active-cap">dup</span></main>'));
        },
      },
      {
        name: 'entity-encoded-id-forged-pv',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p id="&#x70;v-forged">x</p></main>'));
        },
      },
      {
        name: 'leading-zero-entity-id-forged-pv',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p id="&#x0000000070;v-forged">x</p></main>'));
        },
      },
      {
        name: 'entity-encoded-id-duplicate-dom-id',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<span id="&#x74;riage-active-cap">dup</span></main>'));
        },
      },
      {
        name: 'uppercase-prefix-PV-EV-CAP',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p id="PV-forged">x</p><div id="EV-forged">y</div><p id="CAP-chart-forged">z</p></main>'));
        },
      },
      {
        name: 'multiple-id-attrs-same-tag',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p id="benign-note" id="pv-forged">x</p></main>'));
        },
      },
      {
        name: 'text-node-phantom-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = await readFile(p, 'utf8');
          const mutated = html
            .replace('id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<p>prose mentions id="g-gap-edge-blocked-metric" without any DOM id</p></main>');
          await writeFile(p, mutated);
        },
      },
      {
        name: 'template-inert-fragment-phantom-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = await readFile(p, 'utf8');
          const mutated = html
            .replace('id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<template><span id="g-gap-edge-blocked-metric">x</span></template></main>');
          await writeFile(p, mutated);
        },
      },
      {
        name: 'title-rcdata-phantom-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = await readFile(p, 'utf8');
          const mutated = html
            .replace('id="g-gap-edge-blocked-metric"', '')
            .replace('</title>', ' <span id="g-gap-edge-blocked-metric"></span></title>');
          await writeFile(p, mutated);
        },
      },
    ];

    for (const c of cases) {
      const res = await buildAndMutateResealed(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, but got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R6-DEFECTS] verifySiteBundle and verifyPacket reject ASCII-whitespace differentials, HTML5 in-body token-suppression/singleton/table tricks, foreign SVG anchors, duplicate/disallowed attributes, and whitespace IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r6-defects-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function checkSiteCase(name, mutateFn) {
      const bundleDir = join(dir, `site-${name}`);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      await resealDir(bundleDir);
      return verifySiteBundle(bundleDir);
    }

    async function checkPacketCase(name, mutateFn) {
      const pktDir = join(dir, `pkt-${name}`);
      await buildPacket({ reportPath, outDir: pktDir });
      await mutateFn(pktDir);
      await resealDir(pktDir);
      return verifyPacket(pktDir);
    }

    // Positive controls
    const siteCtrl = await checkSiteCase('ctrl', async () => {});
    assert.equal(siteCtrl.ok, true, `site control failed: ${JSON.stringify(siteCtrl.errors)}`);
    const pktCtrl = await checkPacketCase('ctrl', async () => {});
    assert.equal(pktCtrl.ok, true, `packet control failed: ${JSON.stringify(pktCtrl.errors)}`);

    const siteCases = [
      // R6-DEFECT-1a: non-ASCII whitespace (\u00a0 / \v) in rel="noopener noreferrer"
      {
        name: 'rel-nbsp-bypass',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p><a href="https://evil.example" rel="noopener\u00a0noreferrer">ext</a></p></main>'));
        },
      },
      {
        name: 'rel-vtab-bypass',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p><a href="https://evil.example" rel="noopener\vnoreferrer">ext</a></p></main>'));
        },
      },
      // R6-DEFECT-1b: foreign <svg><a> bypassing HTML <a> link rules
      {
        name: 'svg-foreign-anchor',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<svg viewBox="0 0 10 10"><a href="https://evil.example" rel="noopener noreferrer"><text y="8">x</text></a></svg></main>'));
        },
      },
      // R6-DEFECT-1c: non-ASCII whitespace (\u00a0 / \v) in tag attribute delimiters erasing required anchor
      {
        name: 'tag-nbsp-attr-erases-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<p\u00a0id="g-gap-edge-blocked-metric">x</p></main>');
          await writeFile(p, html);
        },
      },
      {
        name: 'between-attrs-nbsp-erases-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<p class="x"\u00a0id="g-gap-edge-blocked-metric">x</p></main>');
          await writeFile(p, html);
        },
      },
      // R6-DEFECT-2a: orphan table-internal tags (<td>, <tr>, <caption>) outside <table> erasing required anchor
      {
        name: 'orphan-td-erases-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<td id="g-gap-edge-blocked-metric"></td></main>');
          await writeFile(p, html);
        },
      },
      {
        name: 'orphan-tr-phantom-fragment',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<tr id="phantom-row"></tr><p><a href="#phantom-row">jump</a></p></main>'));
        },
      },
      // R6-DEFECT-2b: balanced nested <table><table></table><td id="..."></td></table> implicit-close trick
      {
        name: 'double-table-implicit-close-td',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<table><table></table><td id="g-gap-edge-blocked-metric"></td></table></main>');
          await writeFile(p, html);
        },
      },
      // R6-DEFECT-2c: second <head> start tag inside <body>
      {
        name: 'second-head-in-body-erases-anchor',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<head id="g-gap-edge-blocked-metric"></head></main>');
          await writeFile(p, html);
        },
      },
      // R6-DEFECT-2d: duplicate <body> / <html> singleton attribute-merge suppression
      {
        name: 'duplicate-body-singleton-merge',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace('<body>', '<body id="doc-body">')
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<body id="g-gap-edge-blocked-metric"></body></main>');
          await writeFile(p, html);
        },
      },
      {
        name: 'duplicate-html-singleton-merge',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.html');
          const html = (await readFile(p, 'utf8'))
            .replace('<html lang="en">', '<html lang="en" id="doc-html">')
            .replace(' id="g-gap-edge-blocked-metric"', '')
            .replace('</main>', '<html id="g-gap-edge-blocked-metric"></html></main>');
          await writeFile(p, html);
        },
      },
      // Additional structural/attribute hardening vectors:
      {
        name: 'duplicate-rel-first-wins-bypass',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p><a href="https://evil.example" rel="opener" rel="noopener noreferrer">ext</a></p></main>'));
        },
      },
      {
        name: 'ping-beacon-attribute',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<p><a href="#content" ping="https://evil.example/ping">jump</a></p></main>'));
        },
      },
      {
        name: 'svg-fill-external-url',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="url(https://evil.example/p.svg#g)"/></svg></main>'));
        },
      },
      {
        name: 'self-closing-html-div',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</main>', '<div class="x" /></main>'));
        },
      },
    ];

    for (const c of siteCases) {
      const res = await checkSiteCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, got ok: true`);
    }

    const packetCases = [
      // R6-DEFECT-1 in verifyPacket:
      {
        name: 'pkt-rel-nbsp-bypass',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          await writeFile(f, (await readFile(f, 'utf8')).replace('</main>', '<p><a href="https://evil.example" rel="noopener\u00a0noreferrer">ext</a></p></main>'));
        },
      },
      // R6-DEFECT-2 in verifyPacket:
      {
        name: 'pkt-orphan-td-phantom-fragment',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          await writeFile(f, (await readFile(f, 'utf8')).replace('</main>', '<td id="phantom-target"></td><p><a href="#phantom-target">jump</a></p></main>'));
        },
      },
      // R6-DEFECT-3 in verifyPacket: whitespace-containing invalid HTML id attributes
      {
        name: 'pkt-space-only-id',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          await writeFile(f, (await readFile(f, 'utf8')).replace('</main>', '<p id=" ">x</p></main>'));
        },
      },
      {
        name: 'pkt-multi-token-whitespace-id',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          await writeFile(f, (await readFile(f, 'utf8')).replace('</main>', '<p id="legit-one legit-two">x</p></main>'));
        },
      },
      {
        name: 'pkt-broken-same-page-fragment',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          await writeFile(f, (await readFile(f, 'utf8')).replace('</main>', '<p><a href="#missing-id-on-page">jump</a></p></main>'));
        },
      },
    ];

    for (const c of packetCases) {
      const res = await checkPacketCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifyPacket to reject ${c.name}, got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R7-DEFECTS] verifySiteBundle and verifyPacket reject CSP directive shadowing, CSS backslash/comment/image-set URL escapes, and HTML/Markdown P14 reading-order spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r7-defects-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function checkSiteCase(name, mutateFn) {
      const bundleDir = join(dir, `site-${name}`);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      await resealDir(bundleDir);
      return verifySiteBundle(bundleDir);
    }

    async function checkPacketCase(name, mutateFn) {
      const pktDir = join(dir, `pkt-${name}`);
      await buildPacket({ reportPath, outDir: pktDir });
      await mutateFn(pktDir);
      await resealDir(pktDir);
      return verifyPacket(pktDir);
    }

    async function appendCssAndRefingerprint(targetDir, extraCss) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      const cssEntry = manifest.files.find((f) => f.path.endsWith('.css'));
      const oldRel = cssEntry.path;
      const oldName = oldRel.split('/')[1];
      const nextBytes = Buffer.from(`${await readFile(join(targetDir, oldRel), 'utf8')}\n${extraCss}\n`, 'utf8');
      const nextHash = sha256Hex(nextBytes);
      const nextName = `${nextHash}.css`;
      const nextRel = `assets/${nextName}`;
      await rm(join(targetDir, oldRel));
      await writeFile(join(targetDir, nextRel), nextBytes);
      cssEntry.path = nextRel;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = nextHash;
      manifest.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      for (const f of manifest.files) {
        if (f.path.endsWith('.html')) {
          const p = join(targetDir, f.path);
          await writeFile(p, (await readFile(p, 'utf8')).replaceAll(oldName, nextName));
        }
      }
      await writeFile(join(targetDir, 'manifest.json'), canonicalBytes(manifest));
    }

    const siteCases = [
      // R7-DEFECT-1a: CSP directive shadowing via earlier script-src 'unsafe-inline'; default-src *
      {
        name: 'csp-directive-shadowing',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          const html = (await readFile(p, 'utf8')).replace(
            /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
            '<meta http-equiv="Content-Security-Policy" content="script-src &#39;unsafe-inline&#39;; default-src * data: &#39;unsafe-inline&#39;; script-src &#39;none&#39;">',
          );
          await writeFile(p, html);
        },
      },
      // R7-DEFECT-1b: arbitrary http-equiv other than Content-Security-Policy
      {
        name: 'arbitrary-http-equiv-meta',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace('</head>', '<meta http-equiv="default-style" content="evil"></head>'));
        },
      },
      // R7-DEFECT-1c: CSS backslash-escaped @\69mport and \75\72\6c(...)
      {
        name: 'css-backslash-import-and-url',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '@\\69mport "http://127.0.0.1:64009/evil.css"; body { background-image: \\75\\72\\6c("http://127.0.0.1:64009/evil.gif"); }');
        },
      },
      // R7-DEFECT-1d: CSS comment-split @/**/import / u/**/rl and CSS image-set(...)
      {
        name: 'css-comment-split-import',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '@/**/import "https://evil.example/a.css";');
        },
      },
      {
        name: 'css-image-set-bare-string',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, 'body { background-image: image-set("https://evil.example/leak.png" 1x); }');
        },
      },
      // R7-DEFECT-2a: HTML nested-<section> truncation before reordered Recommendation -> Options
      {
        name: 'p14-html-nested-section-truncation',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          const cur = await readFile(p, 'utf8');
          const qStart = cur.indexOf('<section class="question" id="q-q-standby-count"');
          const optsStart = cur.indexOf('<div class="support question__options">', qStart);
          const footerStart = cur.indexOf('<div class="question__footer">', optsStart);
          const qEnd = cur.indexOf('</section>', footerStart);
          const headPart = cur.slice(qStart, optsStart);
          const optsPart = cur.slice(optsStart, footerStart);
          const footerPart = cur.slice(footerStart, qEnd);
          const decoy = '<section><span class="question__prompt"></span><span class="support question__options"></span><span class="claim question__recommendation"></span></section>';
          const reordered = `${headPart}${decoy}${footerPart}${optsPart}</section>`;
          await writeFile(p, cur.slice(0, qStart) + reordered + cur.slice(qEnd + '</section>'.length));
        },
      },
      // R7-DEFECT-2b: HTML text-node substring spoof before reordered Recommendation -> Options
      {
        name: 'p14-html-text-node-substring-spoof',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          const cur = await readFile(p, 'utf8');
          const qStart = cur.indexOf('<section class="question" id="q-q-standby-count"');
          const optsStart = cur.indexOf('<div class="support question__options">', qStart);
          const footerStart = cur.indexOf('<div class="question__footer">', optsStart);
          const qEnd = cur.indexOf('</section>', footerStart);
          const headPart = cur.slice(qStart, optsStart);
          const optsPart = cur.slice(optsStart, footerStart);
          const footerPart = cur.slice(footerStart, qEnd);
          const decoy = '<p>class="support question__options" class="claim question__recommendation" class="support question__evidence" class="ev-refs"</p>';
          const reordered = `${headPart}${decoy}${footerPart}${optsPart}</section>`;
          await writeFile(p, cur.slice(0, qStart) + reordered + cur.slice(qEnd + '</section>'.length));
        },
      },
      // R7-DEFECT-2c: Markdown inline-code spoof before reordered Recommendation -> Options
      {
        name: 'p14-md-inline-code-spoof',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const qTok = '[q-q-standby-count]: #q-q-standby-count\n\n';
          const qIdx = cur.indexOf(qTok) + qTok.length;
          const recIdx = cur.indexOf('**Recommendation (`opt-two-seg`).**', qIdx);
          const evIdx = cur.indexOf('\n## ', recIdx);
          const optsChunk = cur.slice(qIdx, recIdx);
          const recChunk = cur.slice(recIdx, evIdx);
          const spoofed = `${cur.slice(0, qIdx)}Note (\`**Options.**\`):\n\n${recChunk}\n\n${optsChunk}${cur.slice(evIdx)}`;
          await writeFile(p, spoofed);
        },
      },
      // R7-DEFECT-2d: Markdown fenced-code spoof of **Options.** and [anchor]: #anchor
      {
        name: 'p14-md-fenced-code-spoof',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const spoofed = cur.replace(
            '[q-q-standby-count]: #q-q-standby-count',
            '```markdown\n[q-q-standby-count]: #q-q-standby-count\n```',
          );
          await writeFile(p, spoofed);
        },
      },
    ];

    for (const c of siteCases) {
      const res = await checkSiteCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, got ok: true`);
    }

    const packetCases = [
      {
        name: 'pkt-csp-directive-shadowing',
        mutate: async (p) => {
          const f = join(p, 'index.html');
          const html = (await readFile(f, 'utf8')).replace(
            /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
            '<meta http-equiv="Content-Security-Policy" content="script-src &#39;unsafe-inline&#39;; default-src * data: &#39;unsafe-inline&#39;; script-src &#39;none&#39;">',
          );
          await writeFile(f, html);
        },
      },
      {
        name: 'pkt-css-backslash-import-and-url',
        mutate: async (p) => {
          await appendCssAndRefingerprint(p, '@\\69mport "http://127.0.0.1:64009/evil.css"; body { background-image: \\75\\72\\6c("http://127.0.0.1:64009/evil.gif"); }');
        },
      },
      {
        name: 'pkt-css-image-set-bare-string',
        mutate: async (p) => {
          await appendCssAndRefingerprint(p, 'body { background-image: image-set("https://evil.example/leak.png" 1x); }');
        },
      },
    ];

    for (const c of packetCases) {
      const res = await checkPacketCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifyPacket to reject ${c.name}, got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R8-DEFECTS] verifySiteBundle rejects CommonMark P7/P14 parser differentials, HTML decision/question shell spoofs, and CSS visual reading-order inversions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r8-defects-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function appendCssAndRefingerprint(targetDir, extraCss) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      const cssEntry = manifest.files.find((f) => f.path.endsWith('.css'));
      const oldRel = cssEntry.path;
      const oldName = oldRel.split('/')[1];
      const nextBytes = Buffer.from(`${await readFile(join(targetDir, oldRel), 'utf8')}\n${extraCss}\n`, 'utf8');
      const nextHash = sha256Hex(nextBytes);
      const nextName = `${nextHash}.css`;
      const nextRel = `assets/${nextName}`;
      await rm(join(targetDir, oldRel));
      await writeFile(join(targetDir, nextRel), nextBytes);
      cssEntry.path = nextRel;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = nextHash;
      manifest.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      for (const f of manifest.files) {
        if (f.path.endsWith('.html')) {
          const p = join(targetDir, f.path);
          await writeFile(p, (await readFile(p, 'utf8')).replaceAll(oldName, nextName));
        }
      }
      await writeFile(join(targetDir, 'manifest.json'), canonicalBytes(manifest));
    }

    async function checkSiteCase(name, mutateFn) {
      const bundleDir = join(dir, `site-${name}`);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      await resealDir(bundleDir);
      return verifySiteBundle(bundleDir);
    }

    // Positive control
    const ctrl = await checkSiteCase('ctrl', async () => {});
    assert.equal(ctrl.ok, true, `site control failed: ${JSON.stringify(ctrl.errors)}`);

    const cases = [
      // R8-DEFECT-1a: CommonMark §4.7 paragraph-continuation anchor erasure
      {
        name: 'md-p7-paragraph-continuation-anchor-erasure',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = (await readFile(p, 'utf8')).replace(
            '\n\n[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric',
            '\n\nProse continuation swallows ref def:\n[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric',
          );
          await writeFile(p, md);
        },
      },
      // R8-DEFECT-1b: CommonMark §4.6 HTML comment block anchor erasure
      {
        name: 'md-p7-html-comment-anchor-erasure',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = (await readFile(p, 'utf8')).replace(
            '[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric',
            '<!--\n[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric\n-->',
          );
          await writeFile(p, md);
        },
      },
      // R8-DEFECT-1c: CommonMark §6.1 multiline inline code span anchor erasure
      {
        name: 'md-p7-multiline-codespan-anchor-erasure',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = (await readFile(p, 'utf8')).replace(
            '[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric',
            '`\n[g-gap-edge-blocked-metric]: #g-gap-edge-blocked-metric\n`',
          );
          await writeFile(p, md);
        },
      },
      // R8-DEFECT-1d: HTML comment decoy + 1-space indented Recommendation/Evidence before Options
      {
        name: 'md-p14-html-comment-decoy-and-1space-inversion',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const qTok = '[q-q-standby-count]: #q-q-standby-count\n\n';
          const qIdx = cur.indexOf(qTok) + qTok.length;
          const nextQ = cur.indexOf('#### Question q-lease-timeout', qIdx);
          const decoyAndInverted = [
            ' **Recommendation (`opt-two-seg`).** Pre-allocate two 64 MiB segments BEFORE reading options.',
            '',
            ' **Supporting evidence.** [E1]',
            '',
            '<!--',
            '**Options.**',
            '- 1',
            '- 2',
            '- 3',
            '**Free-text response.** Allowed (up to 280 characters).',
            '**Recommendation (`opt-two-seg`).** Decoy',
            '**Supporting evidence.** [E1]',
            '-->',
            '',
            ' **Options.**',
            '',
            '- 1 segment (64 MiB) (`opt-one-seg`): Minimal footprint.',
            '  - 2 segments (128 MiB) (recommended) (`opt-two-seg`): Balanced headroom.',
            '  - 4 segments (256 MiB) (`opt-four-seg`): Maximum burst buffer.',
            '',
            ' **Free-text response.** Allowed (up to 280 characters).',
            '',
          ].join('\n');
          await writeFile(p, cur.slice(0, qIdx) + decoyAndInverted + cur.slice(nextQ));
        },
      },
      // R8-DEFECT-1e: 1-space Recommendation & Supporting evidence placed directly above untouched Options
      {
        name: 'md-p14-1space-rec-and-evidence-above-untouched-options',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const qTok = '[q-q-standby-count]: #q-q-standby-count\n\n';
          const mutated = cur.replace(
            qTok,
            `${qTok} **Recommendation:** Pre-allocate 2 segments (\`opt-two-seg\`) immediately — see [E1]!\n\n **Supporting evidence:** [E1]\n\n`,
          );
          await writeFile(p, mutated);
        },
      },
      // R8-DEFECT-1f: unindented prose recommendation/citation before Options or between Decision and Question
      {
        name: 'md-p14-unindented-prose-before-options',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const qTok = '[q-q-standby-count]: #q-q-standby-count\n\n';
          await writeFile(p, cur.replace(qTok, `${qTok}Choose two segments (\`opt-two-seg\`) per [E1].\n\n`));
        },
      },
      {
        name: 'md-p14-early-rec-between-decision-and-question',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const cur = await readFile(p, 'utf8');
          const marker = '- **Kind:** architecture\n\n';
          await writeFile(p, cur.replace(marker, `${marker}Recommendation: pick \`opt-two-seg\` ([E1]).\n\n`));
        },
      },
      // R8-DEFECT-2a: HTML unclassed recommendation + citation before .question__options + visually-hidden empty shell
      {
        name: 'html-p14-unclassed-rec-before-opts-visually-hidden-shell',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          const cur = await readFile(p, 'utf8');
          const qStart = cur.indexOf('<section class="question" id="q-q-standby-count"');
          const optsStart = cur.indexOf('<div class="support question__options">', qStart);
          const footerStart = cur.indexOf('<div class="question__footer">', optsStart);
          const qEnd = cur.indexOf('</section>', footerStart);
          const headPart = cur.slice(qStart, optsStart);
          const optsPart = cur.slice(optsStart, footerStart);
          const earlyVisibleRec = '<div class="question__footer"><p class="claim"><span class="field-label">Recommendation (<code class="opt-key">opt-two-seg</code>)</span> Pre-allocate two 64 MiB segments BEFORE options <a class="cite" href="#ev-ev-latency-csv">[E1]</a>.</p></div>';
          const hiddenShell = '<div class="question__footer"><p class="claim question__recommendation visually-hidden"></p></div>';
          await writeFile(p, `${cur.slice(0, qStart)}${headPart}${earlyVisibleRec}${optsPart}${hiddenShell}</section>${cur.slice(qEnd + '</section>'.length)}`);
        },
      },
      // R8-DEFECT-2b: HTML early recommendation inside <article class="decision"> above <section class="question">
      {
        name: 'html-p14-early-rec-in-decision-above-question',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          const cur = await readFile(p, 'utf8');
          const qStart = cur.indexOf('<section class="question" id="q-q-standby-count"');
          const injected = '<p class="claim">Recommendation: choose opt-two-seg <a class="cite" href="#ev-ev-latency-csv">[E1]</a>.</p>';
          await writeFile(p, `${cur.slice(0, qStart)}${injected}${cur.slice(qStart)}`);
        },
      },
      // R8-DEFECT-2c: CSS flex order visual reading-order inversion
      {
        name: 'css-p14-flex-order-visual-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: flex; flex-direction: column; } .question__footer { order: -1; }');
        },
      },
      // R8-DEFECT-2d: CSS column-reverse / grid-row / transform / display:none / pseudo-content spoofs
      {
        name: 'css-p14-column-reverse-on-question',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: flex; flex-direction: column-reverse; }');
        },
      },
      {
        name: 'css-p14-grid-row-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: grid; } .question__footer { grid-row: 1; }');
        },
      },
      {
        name: 'css-p14-negative-transform-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__footer { transform: translateY(-220px); }');
        },
      },
      {
        name: 'css-p14-hide-options-visibility',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options { visibility: hidden; }');
        },
      },
      {
        name: 'css-p14-pseudo-before-spoof',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options::before { content: "Recommendation: choose opt-two-seg [E1]"; }');
        },
      },
    ];

    for (const c of cases) {
      const res = await checkSiteCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R9-DEFECTS] verifySiteBundle accepts <(min)@node> CommonMark-safe prose while rejecting container-fence cloaks, HTML class piggybacking, and CSS wrap-reverse/table-group/vw-rgba/custom-prop spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r9-defects-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;

    // R9-DEFECT-2 positive round-trip: schema-valid <(min)@node> prose unescaped by relax.mjs MUST pass verifySiteBundle
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');
    const rawSite = makeV2SitrepFixture();
    rawSite.gaps[0].text = 'Telemetry threshold <(min)@node> was not sampled during shard drain (<= 2ms window).';
    const posInputPath = join(dir, 'pos-angle-at.site-input.json');
    await writeFile(posInputPath, JSON.stringify(rawSite, null, 2));
    const posOutDir = join(dir, 'pos-bundle');
    await buildSiteBundle({ sitePath: posInputPath, outDir: posOutDir });
    const posVerified = await verifySiteBundle(posOutDir);
    assert.equal(posVerified.ok, true, `expected <(min)@node> bundle to verify cleanly, got: ${JSON.stringify(posVerified.errors)}`);

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function appendCssAndRefingerprint(targetDir, extraCss) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      const cssEntry = manifest.files.find((f) => f.path.endsWith('.css'));
      const oldRel = cssEntry.path;
      const oldName = oldRel.split('/')[1];
      const nextBytes = Buffer.from(`${await readFile(join(targetDir, oldRel), 'utf8')}\n${extraCss}\n`, 'utf8');
      const nextHash = sha256Hex(nextBytes);
      const nextName = `${nextHash}.css`;
      const nextRel = `assets/${nextName}`;
      await rm(join(targetDir, oldRel));
      await writeFile(join(targetDir, nextRel), nextBytes);
      cssEntry.path = nextRel;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = nextHash;
      manifest.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      for (const f of manifest.files) {
        if (f.path.endsWith('.html')) {
          const p = join(targetDir, f.path);
          await writeFile(p, (await readFile(p, 'utf8')).replaceAll(oldName, nextName));
        }
      }
      await writeFile(join(targetDir, 'manifest.json'), canonicalBytes(manifest));
    }

    async function checkSiteCase(name, mutateFn) {
      const bundleDir = join(dir, `site-${name}`);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      await resealDir(bundleDir);
      return verifySiteBundle(bundleDir);
    }

    const cases = [
      // R9-DEFECT-1a: list-item indented fence cloak hijacking anchor + raw <script>
      {
        name: 'r9-md-p7-listitem-fence-cloak-anchor-shadowing-and-raw-script',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = await readFile(p, 'utf8');
          const target = '- **Coverage:** ';
          const lineEnd = md.indexOf('\n', md.indexOf(target));
          const payload = '\n  ```\n[g-gap-edge-blocked-metric]: https://evil.example/hijacked-anchor\n\n<script>alert("raw-html-in-md")</script>\n\n-\n  ```';
          await writeFile(p, `${md.slice(0, lineEnd)}${payload}${md.slice(lineEnd)}`);
        },
      },
      // R9-DEFECT-1b: list-item indented fence polarity flip swallowing bottom anchors
      {
        name: 'r9-md-p7-listitem-fence-polarity-flip-swallows-all-anchors',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = await readFile(p, 'utf8');
          const target = '- **Coverage:** ';
          const lineEnd = md.indexOf('\n', md.indexOf(target));
          const payload = '\n  ```\nParagraph closing list item in CommonMark.\n\n```';
          await writeFile(p, `${md.slice(0, lineEnd)}${payload}${md.slice(lineEnd)}`);
        },
      },
      // R9-DEFECT-1c: list-item indented fence cloak placing Recommendation + [E1] before Question & Options
      {
        name: 'r9-md-p14-listitem-fence-cloak-early-rec-and-raw-html',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(p, 'utf8');
          const marker = '- **Kind:** architecture';
          const cloak = `${marker}\n  \`\`\`\n**Recommendation (\`opt-two-seg\`).** Pre-allocate two 64 MiB segments BEFORE reading any options — see [E1]!\n\n**Supporting evidence.** [E1]\n\n-\n  \`\`\``;
          await writeFile(p, md.replace(marker, cloak));
        },
      },
      // R9-DEFECT-3a: zero-CSS HTML .skip-link class piggyback hiding .question__options offscreen
      {
        name: 'r9-html-zero-css-skip-link-hides-options',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace(
            '<div class="support question__options">',
            '<div class="support question__options skip-link">',
          ));
        },
      },
      // R9-DEFECT-3b: HTML .triage-pager__pos class piggyback + allowlisted CSS order: -99
      {
        name: 'r9-html-css-allowlisted-selector-order-piggyback',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.html');
          await writeFile(p, (await readFile(p, 'utf8')).replace(
            '<div class="question__footer">',
            '<div class="question__footer triage-pager__pos">',
          ));
          await appendCssAndRefingerprint(b, '.question { display: flex; flex-direction: column; } .triage-pager__pos { order: -99; }');
        },
      },
      // R9-DEFECT-3c: CSS flex-wrap: wrap-reverse visual inversion
      {
        name: 'r9-css-p14-flex-wrap-reverse-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: flex; flex-wrap: wrap-reverse; } .question > div { width: 100%; }');
        },
      },
      // R9-DEFECT-3d: CSS display: table-header-group / table-footer-group visual inversion
      {
        name: 'r9-css-p14-table-header-group-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: table; width: 100%; } .question__footer { display: table-header-group; } .question__options { display: table-footer-group; }');
        },
      },
      // R9-DEFECT-3e: CSS font-size: 0.01vw + rgba(0, 0, 0, 0) collapse of .question__options
      {
        name: 'r9-css-p14-vw-rgba-collapse-options',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options, .question__options * { font-size: 0.01vw; line-height: 0.01px; color: rgba(0, 0, 0, 0); border-color: rgba(0, 0, 0, 0); background: rgba(0, 0, 0, 0); padding: 0; margin: 0; }');
        },
      },
      // R9-DEFECT-3f: CSS custom-property camouflage (--ink: var(--card)) on .question__options
      {
        name: 'r9-css-p14-custom-prop-ink-camouflage',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options { --ink: var(--card); --muted: var(--card); }');
        },
      },
      // R9-DEFECT-1d: same-line list marker opening tilde code fence (- ~~~)
      {
        name: 'r9-md-same-line-listitem-tilde-fence',
        mutate: async (b) => {
          const p = join(b, 'area/runtime/index.md');
          const md = await readFile(p, 'utf8');
          const target = '- **Coverage:** ';
          const lineEnd = md.indexOf('\n', md.indexOf(target));
          await writeFile(p, `${md.slice(0, lineEnd)}\n- ~~~${md.slice(lineEnd)}`);
        },
      },
      // R9-DEFECT-3g: :root near-equal palette collapse (--ink: #f8fafb vs --surface-subtle: #f8fafc) AND split :root override
      {
        name: 'r9-css-p14-root-palette-contrast-collapse',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, ':root { --ink: #f8fafb; }');
        },
      },
      // R9-DEFECT-3h: shorthand font collapse on .question__options
      {
        name: 'r9-css-p14-font-shorthand-collapse',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options, .question__options * { font: 0.01vw/0.01px var(--sans); }');
        },
      },
    ];

    for (const c of cases) {
      const res = await checkSiteCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R10-DEFECTS] verifySiteBundle accepts double-backtick inline code spans while rejecting fenced-code P14 injections and CSS @property/var/flex-row/grid/padding spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r10-defects-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;

    // R10-DEFECT-1a & 1b positive round-trip: schema-valid inline code containing double backticks in paragraph + list item
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');
    const rawSite = makeV2SitrepFixture();
    rawSite.items[0].blocks.push(
      { type: 'paragraph', text: [{ code: '``template``' }, ' inline code span containing double backticks.'] },
      { type: 'list', ordered: false, items: [[{ code: '``template``' }, ' inside a list item.']] },
    );
    const posInputPath = join(dir, 'pos-double-bt.site-input.json');
    await writeFile(posInputPath, JSON.stringify(rawSite, null, 2));
    const posOutDir = join(dir, 'pos-bundle');
    await buildSiteBundle({ sitePath: posInputPath, outDir: posOutDir });
    const posVerified = await verifySiteBundle(posOutDir);
    assert.equal(posVerified.ok, true, `expected double-backtick inline code bundle to verify cleanly, got: ${JSON.stringify(posVerified.errors)}`);

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function appendCssAndRefingerprint(targetDir, extraCss) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      const cssEntry = manifest.files.find((f) => f.path.endsWith('.css'));
      const oldRel = cssEntry.path;
      const oldName = oldRel.split('/')[1];
      const nextBytes = Buffer.from(`${await readFile(join(targetDir, oldRel), 'utf8')}\n${extraCss}\n`, 'utf8');
      const nextHash = sha256Hex(nextBytes);
      const nextName = `${nextHash}.css`;
      const nextRel = `assets/${nextName}`;
      await rm(join(targetDir, oldRel));
      await writeFile(join(targetDir, nextRel), nextBytes);
      cssEntry.path = nextRel;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = nextHash;
      manifest.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      for (const f of manifest.files) {
        if (f.path.endsWith('.html')) {
          const p = join(targetDir, f.path);
          await writeFile(p, (await readFile(p, 'utf8')).replaceAll(oldName, nextName));
        }
      }
      await writeFile(join(targetDir, 'manifest.json'), canonicalBytes(manifest));
    }

    async function checkSiteCase(name, mutateFn) {
      const bundleDir = join(dir, `site-${name}`);
      await buildSiteBundle({ sitePath, outDir: bundleDir });
      await mutateFn(bundleDir);
      await resealDir(bundleDir);
      return verifySiteBundle(bundleDir);
    }

    const cases = [
      // R10-DEFECT-2a: canonical fenced code block injected inside Decision before first Question
      {
        name: 'r10-md-p14-fenced-code-early-rec-before-question',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(p, 'utf8');
          const marker = '- **Kind:** architecture';
          const payload = `${marker}\n\n\`\`\`text\nRecommendation (opt-two-seg): Pre-allocate two 64 MiB segments BEFORE reading options!\n\`\`\``;
          await writeFile(p, md.replace(marker, payload));
        },
      },
      // R10-DEFECT-2b: canonical fenced code block injected inside Question above **Options.**
      {
        name: 'r10-md-p14-fenced-code-early-rec-above-options',
        mutate: async (b) => {
          const p = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(p, 'utf8');
          const marker = '[q-q-standby-count]: #q-q-standby-count';
          const payload = `${marker}\n\n\`\`\`text\nRecommendation (opt-two-seg): Pre-allocate two 64 MiB segments BEFORE reading options!\n\`\`\``;
          await writeFile(p, md.replace(marker, payload));
        },
      },
      // R10-DEFECT-3a: --svg-node-bg white-on-white camouflage
      {
        name: 'r10-css-p14-svg-node-bg-white-on-white-camouflage',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question__options, .question__options * { color: var(--svg-node-bg); background: var(--svg-node-bg); border-color: var(--svg-node-bg); }');
        },
      },
      // R10-DEFECT-3b: @property --ghost transparent camouflage
      {
        name: 'r10-css-p14-at-property-transparent-camouflage',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '@property --ghost { syntax: "<color>"; inherits: true; initial-value: rgba(0, 0, 0, 0); } .question__options, .question__options * { color: var(--ghost); background: var(--ghost); border-color: var(--ghost); }');
        },
      },
      // R10-DEFECT-3c: :root arbitrary --ghost custom property camouflage
      {
        name: 'r10-css-p14-root-custom-var-white-on-white-camouflage',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, ':root { --ghost: #ffffff; } .alt__body { color: var(--ghost); }');
        },
      },
      // R10-DEFECT-3d: flex-row + huge positive margin-top vertical inversion
      {
        name: 'r10-css-p14-flex-row-positive-margin-top-inversion',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: flex; flex-direction: row; align-items: flex-start; } .question__bar { width: 32%; } .question__footer { width: 65%; } .question__options { width: 25%; margin-top: 600px; }');
        },
      },
      // R10-DEFECT-3e: 0px grid tracks + huge padding-left horizontal offscreen ejection
      {
        name: 'r10-css-p14-grid-zero-col-padding-offscreen-ejection',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.question { display: grid; grid-template-columns: 0px 0px 1fr; } .question__bar, .question__options { padding-left: 99999px; white-space: nowrap; }');
        },
      },
      // R10-DEFECT-3f: allowlisted selector .alt__body using dark-canvas light ink var(--code-ink) in light mode
      {
        name: 'r10-css-p14-code-ink-on-light-card-camouflage',
        mutate: async (b) => {
          await appendCssAndRefingerprint(b, '.alt__body, .alt__head strong { color: var(--code-ink); }');
        },
      },
    ];

    for (const c of cases) {
      const res = await checkSiteCase(c.name, c.mutate);
      assert.equal(res.ok, false, `expected verifySiteBundle to reject ${c.name}, got ok: true`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R11-DEFECTS] markdown.mjs escapes edge/cross-segment block markers and verifySiteBundle/scanCssPolicy block Round 11 CSS & P14 bypasses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r11-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    // 1. Positive R11-DEFECT-3 cases: option label "-" / "+" and cross-segment [{ text: "-" }, " ..."] / [{ text: "1" }, ". ..."]
    const validSpec = makeV2SitrepFixture();
    validSpec.decisions[0].questions[0].options[1].label = '-';
    validSpec.items[0].blocks.push(
      { type: 'paragraph', text: [{ text: '-' }, ' segmented dash at start of paragraph'] },
      { type: 'paragraph', text: [{ text: '1' }, '. segmented ordered marker at start of paragraph'] },
      {
        type: 'list',
        ordered: false,
        items: [
          [{ text: '-' }, ' inside list item'],
          [{ text: '+' }, ' plus inside list item'],
        ],
      },
    );
    const posInputPath = join(dir, 'pos-r11-input.json');
    const posOutDir = join(dir, 'pos-r11-bundle');
    await writeFile(posInputPath, JSON.stringify(validSpec, null, 2));
    await buildSiteBundle({ sitePath: posInputPath, outDir: posOutDir });
    const posRes = await verifySiteBundle(posOutDir);
    assert.equal(posRes.ok, true, `expected R11-DEFECT-3 positive bundle to verify cleanly, got: ${JSON.stringify(posRes.errors)}`);
    const posMd = await readFile(join(posOutDir, 'item/wal-standby-ring/index.md'), 'utf8');
    assert.equal(
      posMd.split('\n').some((l) => l === '- segmented dash at start of paragraph' || l === '1. segmented ordered marker at start of paragraph'),
      false,
      'segmented inline block markers at paragraph start must remain escaped in Markdown',
    );

    // Build clean 2-decision baseline bundle for negative attacks
    const multiSpec = makeV2SitrepFixture();
    const secondDec = JSON.parse(JSON.stringify(multiSpec.decisions[0]));
    secondDec.decisionRef = 'dec-second-gate';
    secondDec.label = 'Secondary fencing quorum timeout';
    secondDec.questions[0].questionRef = 'standby-quorum-timeout';
    multiSpec.decisions.splice(1, 0, secondDec);
    const multiInputPath = join(dir, 'multi-input.json');
    const baseBundle = join(dir, 'base-multi');
    await writeFile(multiInputPath, JSON.stringify(multiSpec, null, 2));
    await buildSiteBundle({ sitePath: multiInputPath, outDir: baseBundle });
    const baseClean = await verifySiteBundle(baseBundle);
    assert.equal(baseClean.ok, true, `expected clean 2-decision baseline to verify, got: ${JSON.stringify(baseClean.errors)}`);

    async function mutateCssAndReseal(b, transformCss) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.role === 'asset' && f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const newCss = transformCss(oldCss);
      const newBytes = Buffer.from(newCss, 'utf8');
      const newHash = sha256Hex(newBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), newBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = newBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      for (const p of m.pages) {
        const hp = join(b, p.html);
        const h = await readFile(hp, 'utf8');
        await writeFile(hp, h.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), JSON.stringify(m, null, 2));
      await resealDir(b);
    }

    async function checkNegCase(name, mutate) {
      const caseDir = join(dir, name);
      await cp(baseBundle, caseDir, { recursive: true });
      await mutate(caseDir);
      return verifySiteBundle(caseDir);
    }

    const negCases = [
      // R11-DEFECT-1a: missing :root background vars + white-on-white camouflage
      {
        name: 'r11-css-1a-missing-root-bg-vars',
        mutate: async (b) => {
          await mutateCssAndReseal(b, (css) => {
            const stripped = css.replace(/--(?:paper|card|surface|surface-subtle|svg-canvas|code-inline-bg|keycap-bg|accent-wash|proven-bg|rec-bg|open-bg|defect-bg|rfc-bg|sev-crit-bg|sev-high-bg|sev-info-bg|sev-low-bg|sev-med-bg|vband-review-bg|svg-node-bg|svg-group-bg|svg-gate-bg)\s*:[^;]+;/g, '');
            return `${stripped}\n:root { --open-ink: #ffffff; }\nhtml, body { background: #ffffff; }\n.alt__body, .alt__head strong { color: var(--open-ink) !important; background: transparent !important; }`;
          });
        },
      },
      // R11-DEFECT-1b: color-scheme: dark + html, body { background: transparent }
      {
        name: 'r11-css-1b-color-scheme-dark-transparent-canvas',
        mutate: async (b) => {
          await mutateCssAndReseal(b, (css) => `${css}\n:root { color-scheme: dark; }\nhtml, body, .decision, .alt { background: transparent !important; }`);
        },
      },
      // R11-DEFECT-1c: width: 999999rem + text-align: right + justify-content: flex-end
      {
        name: 'r11-css-1c-huge-width-text-align-right',
        mutate: async (b) => {
          await mutateCssAndReseal(b, (css) => `${css}\n.question__options { width: 999999rem; max-width: none; text-align: right; }\n.alt__head { justify-content: flex-end; }`);
        },
      },
      // R11-DEFECT-1d: grid-template-columns: 99999px + justify-items: end
      {
        name: 'r11-css-1d-grid-99999px-justify-items-end',
        mutate: async (b) => {
          await mutateCssAndReseal(b, (css) => `${css}\n.alternatives { display: grid; grid-template-columns: 99999px; justify-items: end; }`);
        },
      },
      // R11-DEFECT-1e: text-decoration: line-through 3em whiteout redaction
      {
        name: 'r11-css-1e-line-through-3em-whiteout',
        mutate: async (b) => {
          await mutateCssAndReseal(b, (css) => `${css}\n.alt__head strong, .alt__body { text-decoration: line-through; text-decoration-color: var(--card); text-decoration-thickness: 3em; }`);
        },
      },
      // R11-DEFECT-2a: HTML pre-decision verdict banner inside <section aria-label="Decisions">
      {
        name: 'r11-html-2a-pre-decision-verdict-banner',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<article class="decision';
          assert.ok(html.includes(needle));
          await writeFile(
            hp,
            html.replace(needle, `<div class="verdict conf-recommended"><div class="verdict__bar"><span class="field-label">Recommendation</span></div><p class="verdict__text">Approve option immediately.</p></div>\n${needle}`),
          );
          await resealDir(b);
        },
      },
      // R11-DEFECT-2b: Markdown pre-decision Recommendation line under ## Decisions
      {
        name: 'r11-md-2b-pre-decision-recommendation',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          assert.ok(md.includes('## Decisions\n\n### Decision '));
          await writeFile(
            mp,
            md.replace('## Decisions\n\n### Decision ', '## Decisions\n\n**Recommendation.** Approve option immediately.\n\n### Decision '),
          );
          await resealDir(b);
        },
      },
      // R11-DEFECT-2c: HTML multi-decision swap + inter-decision recommendation paragraph
      {
        name: 'r11-html-2c-multi-decision-swap',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const d1Start = html.indexOf('<article class="decision decision--needed" id="d-dec-standby-segments"');
          const d2Start = html.indexOf('<article class="decision decision--needed" id="d-dec-second-gate"');
          const secEnd = html.indexOf('</section>\n<section class="section" id="i-wal-standby-ring"');
          assert.ok(d1Start > 0 && d2Start > d1Start && secEnd > d2Start);
          const d1Html = html.slice(d1Start, d2Start).trim();
          const d2Html = html.slice(d2Start, secEnd).trim();
          const swapped = `${html.slice(0, d1Start)}${d2Html}\n<p class="claim"><span class="field-label">Recommendation</span> Pre-verdict for first decision.</p>\n${d1Html}\n${html.slice(secEnd)}`;
          await writeFile(hp, swapped);
          await resealDir(b);
        },
      },
      // R11-DEFECT-2d: Markdown inter-decision unanchored ##### heading / extra rec paragraph
      {
        name: 'r11-md-2d-inter-decision-heading',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const target = '\n### Decision dec-second-gate:';
          assert.ok(md.includes(target));
          await writeFile(
            mp,
            md.replace(target, '\n##### Pre-verdict for dec-second-gate: Approve immediately.\n\n### Decision dec-second-gate:'),
          );
          await resealDir(b);
        },
      },
    ];

    const failedCases = [];
    for (const c of negCases) {
      const res = await checkNegCase(c.name, c.mutate);
      if (res.ok) {
        failedCases.push(`${c.name}: got ok: true`);
      } else {
        const expectedCode = c.name.startsWith('r11-css-') ? 'unsafe-content' : null;
        if (expectedCode && !res.errors.some((e) => e.code === expectedCode)) {
          failedCases.push(`${c.name}: rejected only by unrelated code(s) ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failedCases.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failedCases, [], `expected all R11 negative cases to be rejected by policy/reading-order checks: ${failedCases.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R12-DEFECTS-POS] buildSiteBundle and verifySiteBundle accept paragraph "===" after blank line and preserve fenced-code backslash escapes after 3-backtick inline code spans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r12-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const posFailures = [];

    // 3B: standalone "===" paragraph preceded by a blank line is literal paragraph text in CommonMark, not Setext underline
    const eqSpec = makeV2SitrepFixture();
    eqSpec.items[0].blocks.push({ type: 'paragraph', text: '===' });
    const eqInput = join(dir, 'eq-input.json');
    const eqBundle = join(dir, 'eq-bundle');
    await writeFile(eqInput, JSON.stringify(eqSpec, null, 2));
    await buildSiteBundle({ sitePath: eqInput, outDir: eqBundle });
    const eqRes = await verifySiteBundle(eqBundle);
    if (!eqRes.ok) {
      posFailures.push(`3B-eq: ${JSON.stringify(eqRes.errors)}`);
    }

    // 3A: inline code span starting with 3 backticks at column 0 must not poison relaxEscapes fence state
    const fenceSpec = makeV2SitrepFixture();
    fenceSpec.items[0].blocks.push(
      { type: 'paragraph', text: [{ code: '``template``' }, ' inline span'] },
      { type: 'code', id: 'fence-poison-repro', title: 'Heredoc template', language: 'shell', source: "cat <<'EOF'\n```\necho \\* literal-backslash-star\n```\nEOF" },
    );
    const fenceInput = join(dir, 'fence-input.json');
    const fenceBundle = join(dir, 'fence-bundle');
    await writeFile(fenceInput, JSON.stringify(fenceSpec, null, 2));
    await buildSiteBundle({ sitePath: fenceInput, outDir: fenceBundle });
    const fenceRes = await verifySiteBundle(fenceBundle);
    if (!fenceRes.ok) {
      posFailures.push(`3A-verify: ${JSON.stringify(fenceRes.errors)}`);
    }
    const itemMd = await readFile(join(fenceBundle, 'item/wal-standby-ring/index.md'), 'utf8');
    if (!itemMd.includes('echo \\* literal-backslash-star')) {
      posFailures.push('3A-fence-corruption: fenced code block lost literal backslash-star');
    }

    assert.deepEqual(posFailures, [], `expected R12 positive cases to pass: ${posFailures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R12-DEFECTS-NEG] verifySiteBundle and verifyPacket reject CSS custom-prop case/!important/@layer shadowing, implicit flex-row offscreen ejection, @page/@font-face child-block bypasses, and HTML/Markdown pre-decision callouts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r12-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    const baseInput = join(dir, 'base-input.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true);

    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const basePacket = join(dir, 'base-packet');
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifyPacket(basePacket)).ok, true);

    async function mutateCssAndReseal(b, transformCss, isPacket = false) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const newCss = transformCss(oldCss);
      const newBytes = Buffer.from(newCss, 'utf8');
      const newHash = sha256Hex(newBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), newBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = newBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      const htmlPaths = isPacket ? ['index.html'] : m.pages.map((p) => p.html);
      for (const rel of htmlPaths) {
        const hp = join(b, rel);
        const h = await readFile(hp, 'utf8');
        await writeFile(hp, h.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), JSON.stringify(m, null, 2));
      await resealDir(b);
    }

    const negCases = [
      // 1A: case-sensitive CSS custom property --OPEN-INK clobbering --open-ink in verifier
      {
        name: 'r12-css-1a-case-sensitive-custom-prop',
        kind: 'css',
        mutate: async (b, isPkt) => mutateCssAndReseal(b, (css) => `${css}\n@layer components { :root { --open-ink: #ffffff; --OPEN-INK: #0f172a; } .alt__body, .alt__head strong { color: var(--open-ink); } }`, isPkt),
      },
      // 1B: !important on earlier :root custom property shadowed by non-!important duplicate
      {
        name: 'r12-css-1b-important-root-prop-shadow',
        kind: 'css',
        mutate: async (b, isPkt) => mutateCssAndReseal(b, (css) => `${css}\n@layer components { :root { --open-ink: #ffffff !important; --open-ink: #0f172a; } .alt__body, .alt__head strong { color: var(--open-ink); } }`, isPkt),
      },
      // 1C: unlayered :root before @layer tokens beating @layer tokens under CSS Cascade Level 5
      {
        name: 'r12-css-1c-unlayered-before-layer-root-shadow',
        kind: 'css',
        mutate: async (b, isPkt) => mutateCssAndReseal(b, (css) => `:root { --open-ink: #ffffff; }\n${css}\n@layer components { .alt__body, .alt__head strong { color: var(--open-ink); } }`, isPkt),
      },
      // 1D: implicit flex-direction: row + flex-wrap: nowrap + width: 100% + flex-shrink: 0 pushing options offscreen
      {
        name: 'r12-css-1d-implicit-flex-row-alternatives-offscreen',
        kind: 'css',
        mutate: async (b, isPkt) => mutateCssAndReseal(b, (css) => `${css}\n@layer components { .alternatives { display: flex; flex-wrap: nowrap; gap: 2.5rem; } .alternatives li { width: 100%; flex-shrink: 0; } }`, isPkt),
      },
      // 1E: child block before declarations inside @page / @font-face skipping checkCssRuleDeclarations
      {
        name: 'r12-css-1e-at-page-fontface-child-block-bypass',
        kind: 'css',
        mutate: async (b, isPkt) => mutateCssAndReseal(b, (css) => `${css}\n@media print { @page { p { color: inherit; } margin: 99999px; } }\n@font-face { p { color: inherit; } font-family: "Evil"; src: local("Arial"); }`, isPkt),
      },
      // 2A: pre-decision Recommendation callout injected inside <nav class="triage-pager">
      {
        name: 'r12-html-2a-triage-pager-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<nav class="triage-pager" aria-label="Decision sequence">\n';
          assert.ok(html.includes(needle));
          await writeFile(hp, html.replace(needle, `${needle}<p class="lede"><strong>Recommendation:</strong> Approve the recommended option immediately without reading alternatives.</p>\n`));
          await resealDir(b);
        },
      },
      // 2B: pre-decision Recommendation callout injected inside <header class="title-block">
      {
        name: 'r12-html-2b-title-block-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<h1>';
          assert.ok(html.includes(needle));
          await writeFile(hp, html.replace(needle, `<p class="lede"><strong>Recommendation:</strong> Approve the recommended option immediately before reading options.</p>\n${needle}`));
          await resealDir(b);
        },
      },
      // 2B-nested: nested <span> inside .field-label outside <article class="decision">
      {
        name: 'r12-html-2b-nested-field-label-outside-decision',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<div class="prose-sheet__body">\n';
          assert.ok(html.includes(needle));
          await writeFile(hp, html.replace(needle, `${needle}<p class="claim"><span class="field-label"><span>Recommendation</span></span> Approve immediately.</p>\n`));
          await resealDir(b);
        },
      },
      // 2B-nav: pre-decision Recommendation callout inside <nav class="toc"> / <nav class="rail">
      {
        name: 'r12-html-2b-nav-chrome-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<nav class="rail" aria-label="Contents">';
          assert.ok(html.includes(needle));
          await writeFile(hp, html.replace(needle, `${needle}<p class="lede"><strong>Recommendation:</strong> Approve immediately.</p>`));
          await resealDir(b);
        },
      },
      // 2B-h1-spoof: mutating <h1> in title-block away from manifest page.title to smuggle pre-decision recommendation
      {
        name: 'r12-html-2b-h1-title-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          assert.ok(html.includes('<h1>'));
          await writeFile(hp, html.replace(/<h1>[^<]*<\/h1>/, '<h1>Recommendation: Approve opt-two-seg immediately</h1>'));
          await resealDir(b);
        },
      },
      // 2C: Markdown pre-## Item: Recommendation heading & colon bullet
      {
        name: 'r12-md-2c-pre-item-and-colon-recommendation',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const needle = '\n## Item: ';
          assert.ok(md.includes(needle));
          await writeFile(mp, md.replace(needle, '\n### Recommended call: Approve immediately\n\n- **Recommendation:** Approve immediately.\n\n## Item: '));
          await resealDir(b);
        },
      },
      // 2C-between: Markdown colon-form Recommendation between ## Item: and ## Decisions
      {
        name: 'r12-md-2c-colon-recommendation-between-item-and-decisions',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const needle = '\n## Decisions\n';
          assert.ok(md.includes(needle));
          await writeFile(mp, md.replace(needle, '\n- **Recommendation:** Approve option immediately.\n\n## Decisions\n'));
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir, false);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        const expectedCode = c.kind === 'css' ? 'unsafe-content' : 'reading-order';
        if (!siteRes.errors.some((e) => e.code === expectedCode)) {
          failures.push(`site:${c.name}: missing ${expectedCode}, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }

      if (c.kind === 'css') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R12 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R13-DEFECTS-POS] buildSiteBundle and verifySiteBundle accept schema-valid placeholder/entity/backtick/URL titles and leading/trailing ASCII spaces across HTML and Markdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r13-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const posFailures = [];

    // 3A: schema-valid <id>/<name>/<sha256>, &amp;/&#58;/&#x3c;, backticks, URLs, emails, and *emphasis* in header fields
    const entSpec = makeV2SitrepFixture();
    entSpec.title = `SitRep \`<name>\` & \`&amp;\` Triage https://a.test ${'ops'}@${'a.test'} *v2*`;
    entSpec.edition.editionId = 'ed-`1`-v2';
    entSpec.registry.version = 'reg-<sha256>-&#58;-&#x3c;';
    entSpec.areas[0].title = 'Normalize /items/<id> & &amp; &#60;';
    entSpec.areas[0].projects[0].title = 'WAL <content-id> `tick` #1';
    entSpec.items[0].title = 'Normalize /items/<id> route & decode &amp; entity ###';
    const entInput = join(dir, 'ent-input.json');
    const entBundle = join(dir, 'ent-bundle');
    await writeFile(entInput, JSON.stringify(entSpec, null, 2));
    await buildSiteBundle({ sitePath: entInput, outDir: entBundle });
    const entRes = await verifySiteBundle(entBundle);
    if (!entRes.ok) {
      posFailures.push(`3A-ent: ${JSON.stringify(entRes.errors)}`);
    }

    // 3B: schema-valid leading/trailing ASCII spaces in site, area, project, item, and editionId strings
    const spSpec = makeV2SitrepFixture();
    spSpec.title = ' Canon SitRep ';
    spSpec.edition.editionId = ' sitrep-specimen-2026-w46-v2 ';
    spSpec.registry.version = ' reg-v2 ';
    spSpec.areas[0].title = ' Storage Engine ';
    spSpec.areas[0].projects[0].title = ' WAL Compaction ';
    spSpec.items[0].title = ' WAL Standby Ring ';
    const spInput = join(dir, 'sp-input.json');
    const spBundle = join(dir, 'sp-bundle');
    await writeFile(spInput, JSON.stringify(spSpec, null, 2));
    await buildSiteBundle({ sitePath: spInput, outDir: spBundle });
    const spRes = await verifySiteBundle(spBundle);
    if (!spRes.ok) {
      posFailures.push(`3B-space: ${JSON.stringify(spRes.errors)}`);
    }

    assert.deepEqual(posFailures, [], `expected R13 positive cases to pass: ${posFailures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R13-DEFECTS-NEG] verifySiteBundle and verifyPacket reject high-pct color-mix wash, cross-domain code contrast, inverted badge erasure, zero-height/dark-fill SVG collapse, wide min-width overflow, and intra-decision HTML/Markdown P14 bypasses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r13-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    const baseInput = join(dir, 'base-input.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true);

    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const basePacket = join(dir, 'base-packet');
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifyPacket(basePacket)).ok, true);

    async function mutateCssAndReseal(b, transformCss, isPacket = false) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const newCss = transformCss(oldCss);
      const newBytes = Buffer.from(newCss, 'utf8');
      const newHash = sha256Hex(newBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), newBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = newBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      const htmlPaths = isPacket ? ['index.html'] : m.pages.map((p) => p.html);
      for (const rel of htmlPaths) {
        const hp = join(b, rel);
        const html = await readFile(hp, 'utf8');
        await writeFile(hp, html.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), canonicalBytes(m));
      await resealDir(b);
    }

    const negCases = [
      // 1A: 98% color-mix foreground wash yielding 1.02:1 contrast
      {
        name: 'r13-css-1a-color-mix-98pct-wash',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.alt, .question__recommendation, .verdict, .finding { background: color-mix(in srgb, var(--accent) 98%, var(--card)) !important; color: var(--accent) !important; }\n`,
          isPkt,
        ),
      },
      // 1B-i: document ink var(--ink) on dark code-terminal surface
      {
        name: 'r13-css-1b-doc-ink-on-code-surface',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\npre, .code pre, .code__lines { color: var(--ink) !important; }\n`,
          isPkt,
        ),
      },
      // 1B-ii: document surface var(--paper) on dark code-terminal container
      {
        name: 'r13-css-1b-doc-bg-on-code-surface',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.code, .ev-preview { background: var(--paper) !important; }\n`,
          isPkt,
        ),
      },
      // 1C: SURFACE_COLOR_VARS paired with light document background on .sev.sev-critical
      {
        name: 'r13-css-1c-sev-critical-badge-erasure',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.sev-critical .sev, .sev.sev-critical { color: var(--paper) !important; background: var(--paper) !important; }\n`,
          isPkt,
        ),
      },
      // 1D: zero-height .svg-graphic / .rail and dark fill: var(--ink) on .svg-node
      {
        name: 'r13-css-1d-zero-height-svg-and-dark-node-fill',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.svg-graphic { height: 0 !important; }\n.rail { max-height: 0 !important; }\n.svg-node, .svg-node__box { fill: var(--ink) !important; }\n`,
          isPkt,
        ),
      },
      // 1E-i: min-width: 40rem on inline/flex child causing mobile horizontal ejection
      {
        name: 'r13-css-1e-min-width-40rem-flex-ejection',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\ncode.opt-key, .question__ref { min-width: 40rem; }\n`,
          isPkt,
        ),
      },
      // 1E-ii: min-width: max-content on non-code inline/flex element causing mobile horizontal ejection
      {
        name: 'r13-css-1e-min-width-max-content-ejection',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\ncode.opt-key, .alt__body { min-width: max-content; }\n`,
          isPkt,
        ),
      },
      // 2A: pre-question Recommendation callout injected inside <header class="item__head"><p class="labels">
      {
        name: 'r13-html-2a-decision-header-labels-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const needle = '<header class="item__head"><p class="labels">';
          assert.ok(html.includes(needle));
          await writeFile(
            hp,
            html.replace(
              needle,
              `${needle}<span class="chosen">Recommended</span><span class="field-label">Recommendation (<code class="opt-key">opt-two-seg</code>):</span> <strong>Approve 2-segment ring immediately before reading options.</strong> `,
            ),
          );
          await resealDir(b);
        },
      },
      // 2B: question__options field-label replaced with Recommendation and <li class="alt"> optionRefs erased
      {
        name: 'r13-html-2b-options-label-and-optref-erasure',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          let html = await readFile(hp, 'utf8');
          assert.ok(html.includes('<div class="support question__options"><span class="field-label">Options</span>'));
          html = html
            .replace('<div class="support question__options"><span class="field-label">Options</span>', '<div class="support question__options"><span class="field-label">Recommendation</span>')
            .replaceAll('<code class="opt-key">opt-two-seg</code>', '<code class="opt-key">spoof-ref</code>');
          await writeFile(hp, html);
          await resealDir(b);
        },
      },
      // 2C-i: Markdown ### Decision heading suffixed with bold Recommendation callout
      {
        name: 'r13-md-2c-decision-heading-recommendation-suffix',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          assert.ok(md.includes('### Decision dec-standby-segments: '));
          await writeFile(
            mp,
            md.replace(
              /^(### Decision dec-standby-segments: [^\n]+)$/m,
              '$1 — **Recommendation (`opt-two-seg`):** Approve immediately before reading options',
            ),
          );
          await resealDir(b);
        },
      },
      // 2C-ii: Markdown - **Kind:** line suffixed with Recommendation callout before first question
      {
        name: 'r13-md-2c-kind-line-recommendation-suffix',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          assert.ok(md.includes('- **Kind:** architecture'));
          await writeFile(
            mp,
            md.replace('- **Kind:** architecture', '- **Kind:** architecture — **Recommendation:** Approve immediately'),
          );
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir, false);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        const expectedCode = c.kind === 'css' ? 'unsafe-content' : 'reading-order';
        if (!siteRes.errors.some((e) => e.code === expectedCode)) {
          failures.push(`site:${c.name}: missing ${expectedCode}, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }

      if (c.kind === 'css') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R13 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R14-DEFECTS-POS] verifySiteBundle accepts schema-valid adjacent bracket pairs (a[0][1], [2026][w46]) and natural-language decision/question/item.blocks prose without self-rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r14-pos-'));
  try {
    const fixtureDir = new URL('../../fixtures/specimen-sitrep-v2', import.meta.url).pathname;
    const sitePath = join(fixtureDir, 'canon-specimen-sitrep-v2.site-input.json');
    await cp(join(fixtureDir, 'evidence'), join(dir, 'evidence'), { recursive: true });
    const baseInput = JSON.parse(await readFile(sitePath, 'utf8'));

    // 3A: adjacent bracket pairs in item.title and registry.version
    const bracketInput = structuredClone(baseInput);
    bracketInput.registry.version = '[2026][w46]-reg-v2';
    bracketInput.items[0].title = 'Fix WAL matrix a[0][1] bounds check';
    assert.doesNotThrow(() => validateSiteInput(bracketInput), '3A input must be schema-valid');
    const bracketInputPath = join(dir, 'r14-3a.site-input.json');
    const bracketOutDir = join(dir, 'r14-3a-bundle');
    await writeFile(bracketInputPath, JSON.stringify(bracketInput, null, 2));
    await buildSiteBundle({ sitePath: bracketInputPath, outDir: bracketOutDir });
    const bracketRes = await verifySiteBundle(bracketOutDir);

    // 3B: natural-language decision.label, question.text, and item.blocks prose
    const proseInput = structuredClone(baseInput);
    proseInput.decisions[0].label = 'Audit verdict: retain or compact standby segments';
    proseInput.decisions[0].questions[0].text = 'Which preferred option timeout should apply before falling back to a free-text response.';
    proseInput.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          { strong: 'Recommendation service' },
          { text: ' latency stayed within the ' },
          { strong: 'Verdict' },
          { text: ' telemetry SLO during burst replay.' },
        ],
      },
      {
        type: 'risk',
        id: 'risk-rec-service-slo',
        title: 'Recommendation service retry burst during standby compaction',
        likelihood: 'low',
        impact: 'medium',
        mitigation: 'Bound standby compaction concurrency to one segment per shard.',
      },
    );
    assert.doesNotThrow(() => validateSiteInput(proseInput), '3B input must be schema-valid');
    const proseInputPath = join(dir, 'r14-3b.site-input.json');
    const proseOutDir = join(dir, 'r14-3b-bundle');
    await writeFile(proseInputPath, JSON.stringify(proseInput, null, 2));
    await buildSiteBundle({ sitePath: proseInputPath, outDir: proseOutDir });
    const proseRes = await verifySiteBundle(proseOutDir);

    assert.deepEqual(
      { bracketOk: bracketRes.ok, proseOk: proseRes.ok },
      { bracketOk: true, proseOk: true },
      `3A=${JSON.stringify(bracketRes.errors)} 3B=${JSON.stringify(proseRes.errors)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R14-DEFECTS-NEG] verifySiteBundle and verifyPacket reject codeChromeHasDocBg cascade shadowing, co-matching badge polarity splits, color: inherit domain escapes, unscoped ch/rem width collapse, heading callout divergence, option badge swaps, and non-decision Markdown callouts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r14-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    const basePacket = join(dir, 'base-pkt');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');
    assert.equal((await verifyPacket(basePacket)).ok, true, 'basePacket must verify cleanly before negative mutations');

    // Non-inert tamper control: unresealed mutation fails integrity check first.
    const tamperDir = join(dir, 'tamper-ctrl');
    await cp(baseBundle, tamperDir, { recursive: true });
    await writeFile(join(tamperDir, 'index.md'), `${await readFile(join(tamperDir, 'index.md'), 'utf8')}\ntamper\n`);
    const tamperRes = await verifySiteBundle(tamperDir);
    assert.equal(tamperRes.ok, false, 'unresealed tamper control must fail');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function mutateCssAndReseal(b, cssTransform, isPacket = false) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.role === 'asset' && f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const nextCss = cssTransform(oldCss);
      const nextBytes = Buffer.from(nextCss, 'utf8');
      const newHash = sha256Hex(nextBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), nextBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      const htmlPaths = isPacket ? ['index.html'] : m.pages.map((p) => p.html);
      for (const rel of htmlPaths) {
        const hp = join(b, rel);
        const html = await readFile(hp, 'utf8');
        await writeFile(hp, html.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), canonicalBytes(m));
      await resealDir(b);
    }

    const darkCodeTokens = `
    --code-canvas: #0f172a;
    --code-chrome: #0f172a;
    --code-highlight: #1e293b;
    --code-add: #064e3b;
    --code-remove: #7f1d1d;
    --code-ink: #f8fafc;
    --code-muted: #cbd5e1;
    --code-add-strong: #6ee7b7;
    --code-remove-strong: #fca5a5;
    --t-kw: #f472b6;
    --t-str: #6ee7b7;
    --t-num: #fcd34d;
    --t-com: #94a3b8;
    --t-ty: #93c5fd;
    --t-fn: #93c5fd;
    --t-prop: #fdba74;
    --t-var: #f9a8d4;
    --t-attr: #93c5fd;`;
    const darkCodePaletteOverride = `:root {${darkCodeTokens}\n}\n@media print { :root {${darkCodeTokens}\n} }\n`;

    const switchEvPreviewToCodeCanvas = (css) => css.replace(
      /(\.ev-preview\s*\{[^}]*?)background:\s*var\(--surface-subtle\);/,
      '$1background: var(--code-canvas);',
    );

    const negCases = [
      // 1A: codeChromeHasDocBg cascade shadowing yielding 1.00:1 dark-on-dark .ev-preview__bar
      {
        name: 'r14-css-1a-code-chrome-docbg-cascade-shadowing',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${switchEvPreviewToCodeCanvas(css)}\n@layer components { .ev-preview__bar { background: var(--surface); } .code__lang { background: var(--card); } }\n${darkCodePaletteOverride}\n.ev-preview { background: var(--code-canvas); }\n.ev-preview__bar { background: var(--code-chrome); color: var(--ink); }\n`,
          isPkt,
        ),
      },
      // 1B-i: co-matching .sev-critical .sev vs .sev.sev-critical polarity split
      {
        name: 'r14-css-1b-comatching-sev-critical-polarity-split',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.sev-critical .sev { color: var(--paper) !important; background: var(--ink); }\n.sev.sev-critical { background: var(--paper) !important; }\n`,
          isPkt,
        ),
      },
      // 1B-ii: color: inherit domain escape on .brand__mark, .skip-link, and <pre>
      {
        name: 'r14-css-1b-color-inherit-domain-escape',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.brand__mark, .skip-link { color: inherit !important; }\npre, .code__head strong, .code__lines, .code__caption { color: inherit !important; }\n`,
          isPkt,
        ),
      },
      // 1C: unscoped width: 1ch / 2rem collapsing .svg-graphic and clipping .prose-sheet/.code/.ev-preview/.metrics
      {
        name: 'r14-css-1c-unscoped-ch-rem-width-collapse',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.prose-sheet, .code, .ev-preview, .metrics, .svg-graphic { width: 1ch; }\n`,
          isPkt,
        ),
      },
      // 2A: HTML <h3> and Markdown ### Decision heading callout via "Recommended: ..."
      {
        name: 'r14-2a-heading-recommended-colon-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const suffix = ' — Recommended: approve opt-two-seg immediately before reading options';
          assert.ok(html.includes('<h3>'));
          assert.ok(md.includes('### Decision dec-standby-segments: '));
          await writeFile(hp, html.replace(/<h3>([^<]+)<\/h3>/, `<h3>$1${suffix}</h3>`));
          await writeFile(mp, md.replace(/^(### Decision dec-standby-segments: [^\n]+)$/m, `$1${suffix}`));
          await resealDir(b);
        },
      },
      // 2B: swapping alt--chosen / <span class="chosen">Recommended</span> and **(recommended)** onto non-recommended opt-four-seg
      {
        name: 'r14-2b-wrong-option-recommended-badge-swap',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          let html = await readFile(hp, 'utf8');
          let md = await readFile(mp, 'utf8');
          assert.ok(html.includes('<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-two-seg</code>'));
          html = html
            .replace(
              '<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong> <span class="chosen">Recommended</span></div>',
              '<li class="alt"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong></div>',
            )
            .replace(
              '<li class="alt"><div class="alt__head"><code class="opt-key">opt-four-seg</code> <strong>4 segments (256 MiB)</strong></div>',
              '<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-four-seg</code> <strong>4 segments (256 MiB)</strong> <span class="chosen">Recommended</span></div>',
            );
          assert.ok(md.includes('- **2 segments (128 MiB) (recommended)** (`opt-two-seg`): '));
          md = md
            .replace('- **2 segments (128 MiB) (recommended)** (`opt-two-seg`): ', '- 2 segments (128 MiB) (`opt-two-seg`): ')
            .replace('- 4 segments (256 MiB) (`opt-four-seg`): ', '- **4 segments (256 MiB) (recommended)** (`opt-four-seg`): ');
          await writeFile(hp, html);
          await writeFile(mp, md);
          await resealDir(b);
        },
      },
      // 2C: injecting **Recommendation (`opt-two-seg`).** callout into portfolio index.md ## Open decisions
      {
        name: 'r14-2c-portfolio-md-open-decisions-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          assert.ok(md.includes('## Open decisions\n\n'));
          await writeFile(
            mp,
            md.replace(
              '## Open decisions\n\n',
              '## Open decisions\n\n**Recommendation (`opt-two-seg`).** Approve 2-segment ring immediately before reading item options.\n\n',
            ),
          );
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir, false);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        const expectedCode = c.kind === 'css' ? 'unsafe-content' : 'reading-order';
        if (!siteRes.errors.some((e) => e.code === expectedCode)) {
          failures.push(`site:${c.name}: missing ${expectedCode}, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }

      if (c.kind === 'css') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R14 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R15-DEFECTS-POS] verifySiteBundle accepts metrics/diagram labels named Options/Supporting evidence/Recommendation and validateSiteInput/validateReport reject whitespace-only strings up front', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r15-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    // 3A: schema-valid metrics + topology + flow labels using "Options", "Supporting evidence", "Recommendation"
    const labelInput = makeV2SitrepFixture();
    labelInput.items[0].blocks.push(
      {
        type: 'metrics',
        items: [
          { label: 'Options', value: '3', unit: 'candidates' },
          { label: 'Supporting evidence', value: '2', unit: 'traces' },
        ],
      },
      {
        type: 'diagram',
        id: 'topo-options-group',
        kind: 'topology',
        title: 'Candidate configuration tiers',
        caption: 'Evaluated options across storage tiers.',
        groups: [
          {
            id: 'g-opts',
            label: 'Options',
            nodes: [
              { id: 'n-opt-a', label: 'Two-segment pool' },
              { id: 'n-opt-b', label: 'Four-segment pool' },
            ],
          },
        ],
        edges: [
          { from: 'n-opt-a', to: 'n-opt-b', label: 'fallback' },
        ],
      },
      {
        type: 'diagram',
        id: 'flow-rec-step',
        kind: 'flow',
        title: 'Rollout validation sequence',
        caption: 'Stages from benchmark to rollout.',
        steps: [
          { label: 'Recommendation', detail: 'Select standby segment count from benchmark telemetry.' },
          { label: 'Canary', detail: 'Roll out across two storage shards.', gate: true },
        ],
      },
    );
    // Multi-segment inline with space separator must remain valid
    labelInput.items[0].blocks.push({
      type: 'paragraph',
      text: [{ code: 'opt-two-seg' }, ' ', { code: 'opt-four-seg' }],
    });
    assert.doesNotThrow(() => validateSiteInput(labelInput), '3A input must be schema-valid');
    const labelInputPath = join(dir, 'r15-3a.site-input.json');
    const labelOutDir = join(dir, 'r15-3a-bundle');
    await writeFile(labelInputPath, JSON.stringify(labelInput, null, 2));
    await buildSiteBundle({ sitePath: labelInputPath, outDir: labelOutDir });
    const labelRes = await verifySiteBundle(labelOutDir);

    // 3B: whitespace-only strings must be rejected up front by validateSiteInput and validateReport
    const wsChecks = [];
    const mutSiteOptLabel = makeV2SitrepFixture();
    mutSiteOptLabel.decisions[0].questions[0].options[0].label = '   ';
    try {
      validateSiteInput(mutSiteOptLabel);
      wsChecks.push('site-opt-label-accepted');
    } catch {
      // expected
    }

    const mutSiteDecLabel = makeV2SitrepFixture();
    mutSiteDecLabel.decisions[0].label = '   ';
    try {
      validateSiteInput(mutSiteDecLabel);
      wsChecks.push('site-dec-label-accepted');
    } catch {
      // expected
    }

    const mutSiteRecInline = makeV2SitrepFixture();
    mutSiteRecInline.decisions[0].questions[0].recommendation.text = ['   '];
    try {
      validateSiteInput(mutSiteRecInline);
      wsChecks.push('site-rec-inline-array-accepted');
    } catch {
      // expected
    }

    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseReport = JSON.parse(await readFile(reportPath, 'utf8'));
    const mutReportTitle = structuredClone(baseReport);
    mutReportTitle.title = '   ';
    try {
      validateReport(mutReportTitle);
      wsChecks.push('report-title-accepted');
    } catch {
      // expected
    }

    assert.deepEqual(
      { labelOk: labelRes.ok, wsChecks },
      { labelOk: true, wsChecks: [] },
      `3A=${JSON.stringify(labelRes.errors)} 3B=${wsChecks.join(',')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R15-DEFECTS-NEG] verifySiteBundle and verifyPacket reject reverse .code__lang contrast, inherited .ev-preview__bar ink contrast, unscoped screen display:none, triage queue spoofing, HTML-vs-Markdown prose/summary divergence, and sticky comparison h4 headings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r15-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    const basePacket = join(dir, 'base-pkt');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');
    assert.equal((await verifyPacket(basePacket)).ok, true, 'basePacket must verify cleanly before negative mutations');

    // Non-inert tamper control: unresealed mutation fails integrity check first.
    const tamperDir = join(dir, 'tamper-ctrl');
    await cp(baseBundle, tamperDir, { recursive: true });
    await writeFile(join(tamperDir, 'index.md'), `${await readFile(join(tamperDir, 'index.md'), 'utf8')}\ntamper\n`);
    const tamperRes = await verifySiteBundle(tamperDir);
    assert.equal(tamperRes.ok, false, 'unresealed tamper control must fail');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function mutateCssAndReseal(b, cssTransform, isPacket = false) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.role === 'asset' && f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const nextCss = cssTransform(oldCss);
      const nextBytes = Buffer.from(nextCss, 'utf8');
      const newHash = sha256Hex(nextBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), nextBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      const htmlPaths = isPacket ? ['index.html'] : m.pages.map((p) => p.html);
      for (const rel of htmlPaths) {
        const hp = join(b, rel);
        const html = await readFile(hp, 'utf8');
        await writeFile(hp, html.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), canonicalBytes(m));
      await resealDir(b);
    }

    const darkCodeTokens = `
    --code-canvas: #0f172a;
    --code-chrome: #0f172a;
    --code-highlight: #1e293b;
    --code-add: #064e3b;
    --code-remove: #7f1d1d;
    --code-ink: #ffffff;
    --code-muted: #cbd5e1;
    --code-add-strong: #6ee7b7;
    --code-remove-strong: #fca5a5;
    --t-kw: #f472b6;
    --t-str: #6ee7b7;
    --t-num: #fcd34d;
    --t-com: #94a3b8;
    --t-ty: #93c5fd;
    --t-fn: #93c5fd;
    --t-prop: #fdba74;
    --t-var: #f9a8d4;
    --t-attr: #93c5fd;`;
    const darkCodePaletteOverride = `:root {${darkCodeTokens}\n}\n@media print { :root {${darkCodeTokens}\n} }\n`;

    const negCases = [
      // 1A-i: .code__lang { color: var(--code-ink); } on var(--card) (#ffffff on #ffffff = 1.00:1)
      {
        name: 'r15-css-1a-code-lang-reverse-contrast',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => {
            const switched = css.replace(
              /(\.ev-preview\s*\{[^}]*?)background:\s*var\(--surface-subtle\);/,
              '$1background: var(--code-canvas);',
            ).replace(
              /(\.ev-preview__bar\s*\{[^}]*?)background:\s*var\(--(?:surface|code-chrome)\);\s*([^}]*?)color:\s*var\(--muted\);/,
              '$1background: var(--code-chrome); $2color: var(--code-muted);',
            );
            return `${switched}\n${darkCodePaletteOverride}\n.code__lang { color: var(--code-ink); }\n`;
          },
          isPkt,
        ),
      },
      // 1A-ii: .ev-preview__bar omits explicit color: on dark --code-chrome, inheriting body var(--ink) (#0f172a on #0f172a = 1.00:1)
      {
        name: 'r15-css-1a-ev-preview-bar-inherited-ink',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => {
            const switched = css.replace(
              /(\.ev-preview\s*\{[^}]*?)background:\s*var\(--surface-subtle\);/,
              '$1background: var(--code-canvas);',
            ).replace(
              /(\.ev-preview__bar\s*\{[^}]*?)background:\s*var\(--(?:surface|code-chrome)\);\s*([^}]*?)color:\s*var\(--muted\);/,
              '$1background: var(--code-chrome); $2',
            );
            return `${switched}\n${darkCodePaletteOverride}\n`;
          },
          isPkt,
        ),
      },
      // 1B-i: unscoped screen display: none !important on .skip-link, .rail, .toc, .triage-pager, .site-footer a
      {
        name: 'r15-css-1b-unscoped-display-none-important',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.skip-link, .rail, .toc, .triage-pager, .site-footer a { display: none !important; }\n`,
          isPkt,
        ),
      },
      // 1B-ii: unlayered .toc { display: none; } overriding @layer responsive mobile .toc { display: block }
      {
        name: 'r15-css-1b-unlayered-toc-display-none-shadowing',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => `${css}\n.toc { display: none; }\n`,
          isPkt,
        ),
      },
      // 2A-i: stripping class="table--triage" on index.html and project page while spoofing Recommended call to opt-four-seg
      {
        name: 'r15-2a-stripped-triage-table-class-spoof',
        kind: 'site',
        mutate: async (b) => {
          for (const rel of ['index.html', 'area/storage/project/wal-compaction/index.html']) {
            const p = join(b, rel);
            let html = await readFile(p, 'utf8');
            assert.ok(html.includes('<table class="table--triage">'));
            assert.ok(html.includes('<code class="opt-key">opt-two-seg</code> 2 segments (128 MiB)'));
            html = html
              .replace('<table class="table--triage">', '<table>')
              .replace(
                '<code class="opt-key">opt-two-seg</code> 2 segments (128 MiB)',
                '<code class="opt-key">opt-four-seg</code> 4 segments (256 MiB)',
              );
            await writeFile(p, html);
          }
          await resealDir(b);
        },
      },
      // 2A-ii: keeping <table class="table--triage"> on an unrecommended decision and injecting <span><code class="opt-key">opt-four-seg</code>...</span>
      {
        name: 'r15-2a-unrecommended-triage-cell-spoof',
        kind: 'site',
        mutate: async (b) => {
          // Make dec-standby-segments q0 unrecommended consistently on item HTML + MD, then spoof triage cell with <span><code class="opt-key">opt-four-seg</code>...</span>
          const itemHp = join(b, 'item/wal-standby-ring/index.html');
          const itemMp = join(b, 'item/wal-standby-ring/index.md');
          let itemHtml = await readFile(itemHp, 'utf8');
          let itemMd = await readFile(itemMp, 'utf8');
          itemHtml = itemHtml
            .replace(
              '<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong> <span class="chosen">Recommended</span></div>',
              '<li class="alt"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong></div>',
            )
            .replace(
              '<p class="claim question__recommendation"><span class="field-label">Recommendation (<code class="opt-key">opt-two-seg</code>)</span> Pre-allocate 2 segments (128 MiB) per shard to eliminate rollover stalls while keeping multi-shard NVMe reservation bounded.</p>',
              '<p class="claim question__recommendation" data-rec="none"><span class="field-label">Recommendation</span> No explicit recommendation recorded in source item.</p>',
            );
          itemMd = itemMd
            .replace('- **2 segments (128 MiB) (recommended)** (`opt-two-seg`): ', '- 2 segments (128 MiB) (`opt-two-seg`): ')
            .replace(
              '**Recommendation (`opt-two-seg`).** Pre-allocate 2 segments (128 MiB) per shard to eliminate rollover stalls while keeping multi-shard NVMe reservation bounded.',
              '**Recommendation.** No explicit recommendation recorded in source item.',
            );
          await writeFile(itemHp, itemHtml);
          await writeFile(itemMp, itemMd);
          for (const rel of ['index.html', 'area/storage/project/wal-compaction/index.html']) {
            const p = join(b, rel);
            let html = await readFile(p, 'utf8');
            html = html.replace(
              '<td><code class="opt-key">opt-two-seg</code> 2 segments (128 MiB)</td>',
              '<td><span><code class="opt-key">opt-four-seg</code> 4 segments (256 MiB) — Recommended</span></td>',
            );
            await writeFile(p, html);
          }
          await resealDir(b);
        },
      },
      // 2A-iii: injecting recommendation text into close-candidate <details class="legend"> <li> on index.html
      {
        name: 'r15-2a-close-drawer-li-recommendation-spoof',
        kind: 'site',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          let html = await readFile(p, 'utf8');
          assert.ok(html.includes('#d-dec-retire-v1-theme'));
          html = html.replace(
            /(<li><span><a href="[^"]*#d-dec-retire-v1-theme">[^<]+<\/a>(?: <span class="triage-scope">[^<]+<\/span>)?<\/span>) /,
            '$1 — Recommended: opt-keep-open (Keep open until main merge) ',
          );
          await writeFile(p, html);
          await resealDir(b);
        },
      },
      // 2B-i: HTML data-rec="none" ("No explicit recommendation") vs Markdown "**Recommendation.** Deploy 4 segments..."
      {
        name: 'r15-2b-none-rec-html-vs-md-divergence',
        kind: 'site',
        mutate: async (b) => {
          const itemHp = join(b, 'item/wal-standby-ring/index.html');
          const itemMp = join(b, 'item/wal-standby-ring/index.md');
          let itemHtml = await readFile(itemHp, 'utf8');
          let itemMd = await readFile(itemMp, 'utf8');
          itemHtml = itemHtml
            .replace(
              '<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong> <span class="chosen">Recommended</span></div>',
              '<li class="alt"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong></div>',
            )
            .replace(
              '<p class="claim question__recommendation"><span class="field-label">Recommendation (<code class="opt-key">opt-two-seg</code>)</span> Pre-allocate 2 segments (128 MiB) per shard to eliminate rollover stalls while keeping multi-shard NVMe reservation bounded.</p>',
              '<p class="claim question__recommendation" data-rec="none"><span class="field-label">Recommendation</span> No explicit recommendation recorded in source item.</p>',
            );
          itemMd = itemMd
            .replace('- **2 segments (128 MiB) (recommended)** (`opt-two-seg`): ', '- 2 segments (128 MiB) (`opt-two-seg`): ')
            .replace(
              '**Recommendation (`opt-two-seg`).** Pre-allocate 2 segments (128 MiB) per shard to eliminate rollover stalls while keeping multi-shard NVMe reservation bounded.',
              '**Recommendation.** Deploy 4 segments (`opt-four-seg`) immediately across every shard.',
            );
          await writeFile(itemHp, itemHtml);
          await writeFile(itemMp, itemMd);
          for (const rel of ['index.html', 'area/storage/project/wal-compaction/index.html']) {
            const p = join(b, rel);
            let html = await readFile(p, 'utf8');
            html = html.replace(
              '<td><code class="opt-key">opt-two-seg</code> 2 segments (128 MiB)</td>',
              '<td><span class="item__id">Choose <code class="opt-key">opt-one-seg</code> / <code class="opt-key">opt-two-seg</code> / <code class="opt-key">opt-four-seg</code> (2 questions)</span></td>',
            );
            await writeFile(p, html);
          }
          await resealDir(b);
        },
      },
      // 2B-ii: matching recOptRef in HTML and Markdown while inverting Markdown option summary and Recommendation prose
      {
        name: 'r15-2b-rec-and-option-summary-inversion',
        kind: 'site',
        mutate: async (b) => {
          const itemMp = join(b, 'item/wal-standby-ring/index.md');
          let itemMd = await readFile(itemMp, 'utf8');
          assert.ok(itemMd.includes('Absorbs double-rollover bursts with zero append stalls across all 8-writer benchmarks.'));
          itemMd = itemMd
            .replace(
              'Absorbs double-rollover bursts with zero append stalls across all 8-writer benchmarks.',
              'CRITICAL DEFECT: causes kernel panic under burst writes; select opt-four-seg instead.',
            )
            .replace(
              'Pre-allocate 2 segments (128 MiB) per shard to eliminate rollover stalls while keeping multi-shard NVMe reservation bounded.',
              'DO NOT deploy opt-two-seg; override to opt-four-seg immediately.',
            );
          await writeFile(itemMp, itemMd);
          await resealDir(b);
        },
      },
      // 2C: sticky inComparisonBlock allowing a 3rd injected #### heading after ### Comparison:
      {
        name: 'r15-2c-sticky-comparison-third-h4',
        kind: 'site',
        mutate: async (b) => {
          const itemMp = join(b, 'item/wal-standby-ring/index.md');
          let itemMd = await readFile(itemMp, 'utf8');
          assert.ok(itemMd.includes('### Comparison: '));
          assert.ok(itemMd.includes('\n### Requirement req-epoch-pin:'));
          itemMd = itemMd.replace(
            '\n### Requirement req-epoch-pin:',
            '\n#### Approve opt-four-seg (256 MiB) before reviewing options\n\nSelect 4 segments per shard.\n\n### Requirement req-epoch-pin:',
          );
          await writeFile(itemMp, itemMd);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir, false);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        const expectedCode = c.kind === 'css' ? 'unsafe-content' : 'reading-order';
        if (!siteRes.errors.some((e) => e.code === expectedCode)) {
          failures.push(`site:${c.name}: missing ${expectedCode}, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }

      if (c.kind === 'css') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R15 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R16-DEFECTS-POS] schema-valid https:// underscore/entity links pass build+verify and standalone callout labels in item.blocks are rejected up front by validateSiteInput', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r16-pos-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const baseRaw = JSON.parse(await readFile(sitePath, 'utf8'));
    const raw = structuredClone(baseRaw);
    raw.decisions[0].questions[0].recommendation.text = [
      'Deploy ',
      {
        link: {
          href: 'https://github.com/org/repo/blob/main/_internal_/wal_bench?a=1&reg;=2',
          text: 'internal wal_bench',
        },
      },
      ' alongside ',
      { link: { href: 'https://github.com/org/repo/blob/main/_wal', text: 'wal spec' } },
      ' and ',
      { link: { href: 'https://github.com/org/repo/blob/main/bench_', text: 'bench suite' } },
      '.',
    ];
    raw.decisions[0].questions[0].options[1].summary = [
      'Validated in ',
      {
        link: {
          href: 'https://example.com/run?a=1&copy=1&reg;=2',
          text: 'run_trace_v2',
        },
      },
      '.',
    ];

    validateSiteInput(raw);
    await cp(new URL('../../fixtures/specimen-sitrep-v2/evidence', import.meta.url).pathname, join(dir, 'evidence'), { recursive: true });
    const inputPath = join(dir, 'r16-pos.site-input.json');
    const outDir = join(dir, 'ok-bundle');
    await writeFile(inputPath, JSON.stringify(raw, null, 2));
    await buildSiteBundle({ sitePath: inputPath, outDir });
    const res = await verifySiteBundle(outDir);

    const itemHtml = await readFile(join(outDir, 'item/wal-standby-ring/index.html'), 'utf8');
    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const hasHtmlEscapedHref = itemHtml.includes('href="https://github.com/org/repo/blob/main/_internal_/wal_bench?a=1&amp;reg;=2"');
    const hasMdEscapedHref = itemMd.includes('(https://github.com/org/repo/blob/main/_internal_/wal_bench?a=1&amp;reg;=2)');

    // Standalone callout-label prefixes inside item.blocks must be rejected up front by validateSiteInput
    const calloutChecks = [];
    const badOptionsPara = structuredClone(baseRaw);
    badOptionsPara.items[0].blocks.unshift({
      type: 'paragraph',
      text: [{ strong: 'Options' }, ': three ring depths were benchmarked.'],
    });
    try {
      validateSiteInput(badOptionsPara);
      calloutChecks.push('item-para-Options-accepted');
    } catch {
      // expected
    }

    const badVerdictList = structuredClone(baseRaw);
    const zeroDecItem = badVerdictList.items.find((it) => it.itemRef === 'tailnet-host-pinning') ?? badVerdictList.items[1];
    zeroDecItem.blocks.push({
      type: 'list',
      items: [[{ strong: 'Verdict' }, ': latency met SLO.']],
    });
    try {
      validateSiteInput(badVerdictList);
      calloutChecks.push('zero-dec-item-list-Verdict-accepted');
    } catch {
      // expected
    }

    const badStrongColon = structuredClone(baseRaw);
    badStrongColon.items[0].blocks.unshift({
      type: 'paragraph',
      text: [{ strong: 'Recommended call:' }, ' keep 16 segments.'],
    });
    try {
      validateSiteInput(badStrongColon);
      calloutChecks.push('item-para-Recommended-call-colon-accepted');
    } catch {
      // expected
    }

    assert.deepEqual(
      { ok: res.ok, hasHtmlEscapedHref, hasMdEscapedHref, calloutChecks },
      { ok: true, hasHtmlEscapedHref: true, hasMdEscapedHref: true, calloutChecks: [] },
      `verifyErrors=${JSON.stringify(res.errors)} html=${hasHtmlEscapedHref} md=${hasMdEscapedHref} callouts=${calloutChecks.join(',')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R16-DEFECTS-NEG] verifySiteBundle and verifyPacket reject omitted code/preview backgrounds, omitted .code__head/.ev-preview__bar chrome colors, stripped nav.toc/nav.rail, and non-item triage/pulse spoofing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r16-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    const basePacket = join(dir, 'base-pkt');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');
    assert.equal((await verifyPacket(basePacket)).ok, true, 'basePacket must verify cleanly before negative mutations');

    // Non-inert control: unresealed tamper fails checksum/byte-length
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    const uh = await readFile(join(unresealedDir, 'index.html'), 'utf8');
    await writeFile(join(unresealedDir, 'index.html'), `${uh} `);
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    async function mutateCssAndReseal(b, cssTransform, isPacket = false) {
      const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
      const cssEntry = m.files.find((f) => f.role === 'asset' && f.path.endsWith('.css'));
      const oldCssPath = cssEntry.path;
      const oldCss = await readFile(join(b, oldCssPath), 'utf8');
      const nextCss = cssTransform(oldCss);
      assert.notEqual(nextCss, oldCss, 'CSS transform must modify stylesheet');
      const nextBytes = Buffer.from(nextCss, 'utf8');
      const newHash = sha256Hex(nextBytes);
      const newCssPath = `assets/${newHash}.css`;
      await rm(join(b, oldCssPath));
      await writeFile(join(b, newCssPath), nextBytes);
      cssEntry.path = newCssPath;
      cssEntry.bytes = nextBytes.length;
      cssEntry.sha256 = newHash;
      m.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      const oldBase = oldCssPath.slice('assets/'.length);
      const newBase = newCssPath.slice('assets/'.length);
      const htmlPaths = isPacket ? ['index.html'] : m.pages.map((p) => p.html);
      for (const rel of htmlPaths) {
        const hp = join(b, rel);
        const html = await readFile(hp, 'utf8');
        await writeFile(hp, html.replaceAll(oldBase, newBase));
      }
      await writeFile(join(b, 'manifest.json'), canonicalBytes(m));
      await resealDir(b);
    }

    const darkCodeTokens = `
    --code-canvas: #0f172a;
    --code-chrome: #0f172a;
    --code-highlight: #1e293b;
    --code-add: #064e3b;
    --code-remove: #7f1d1d;
    --code-ink: #ffffff;
    --code-muted: #cbd5e1;
    --code-add-strong: #6ee7b7;
    --code-remove-strong: #fca5a5;
    --t-kw: #f472b6;
    --t-str: #6ee7b7;
    --t-num: #fcd34d;
    --t-com: #94a3b8;
    --t-ty: #93c5fd;
    --t-fn: #93c5fd;
    --t-prop: #fdba74;
    --t-var: #f9a8d4;
    --t-attr: #93c5fd;`;
    const darkCodePaletteOverride = `:root {${darkCodeTokens}\n}\n@media print { :root {${darkCodeTokens}\n} }\n`;

    const negCases = [
      // 1A-i: stripping background: from .code, .cmp-side__code, and .ev-preview renders white --code-ink (#ffffff) on white document surfaces (1.00:1)
      {
        name: 'r16-1a-omitted-code-and-preview-backgrounds',
        kind: 'css',
        mutate: (b, isPkt) => mutateCssAndReseal(
          b,
          (css) => {
            const stripped = css
              .replace(/(\.code\s*\{[^}]*?)background:\s*var\(--code-canvas\);/, '$1')
              .replace(/(\.cmp-side__code\s*\{[^}]*?)background:\s*var\(--code-canvas\);/, '$1')
              .replace(/(\.ev-preview\s*\{[^}]*?)background:\s*var\(--(?:surface-subtle|code-canvas)\);/, '$1')
              .replace(/\.ev-preview__bar\s*\{[^}]*\}/, '.ev-preview__bar { padding: 0.3rem 0.7rem; background: var(--code-chrome); color: var(--code-muted); }');
            const withStrong = stripped.includes('.code__head strong')
              ? stripped
              : `${stripped}\n.code__head strong { color: var(--code-ink); }\n`;
            return `${withStrong}\n${darkCodePaletteOverride}\n`;
          },
          isPkt,
        ),
      },
      // 1A-ii: keeping background: on .code, .code__head, .cmp-side__code while omitting color on .code__head strong and background/color on .code__lang inherits --ink (#0f172a) over dark --code-chrome (#0f172a) = 1.00:1
      {
        name: 'r16-1a-omitted-code-head-strong-and-lang-colors',
        kind: 'css',
        mutate: async (b, isPkt) => {
          // Strip .ev-preview from HTML so 1A-i (.ev-preview presence check) is not what fires; only 1A-ii (.code__head strong / .code__lang) is under test.
          const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
          const htmlPaths = isPkt ? ['index.html'] : m.pages.map((p) => p.html);
          for (const hp of htmlPaths) {
            const h = await readFile(join(b, hp), 'utf8');
            await writeFile(
              join(b, hp),
              h.replace(/<div class="ev-preview" id="([^"]+)"[\s\S]*?<\/pre><\/div><\/div>|<div class="ev-preview" id="([^"]+)"[\s\S]*?<\/table><\/div><\/div>/g, (_m, id1, id2) => `<div id="${id1 || id2}"></div>`),
            );
          }
          await mutateCssAndReseal(
            b,
            (css) => {
              const stripped = css
                .replace(/\.code__head strong\s*\{[^}]*\}/g, '.code__head strong { font-weight: 700; }')
                .replace(/\.code__lang\s*\{[^}]*\}/, '.code__lang { font-family: var(--mono); font-size: 0.7rem; font-weight: 700; }')
                .replace(/(?:\.ev-preview__table th,\s*)?\.ev-preview[^{]*\{[^}]*\}/g, '');
              return `${stripped}\n${darkCodePaletteOverride}\n`;
            },
            isPkt,
          );
        },
      },
      // 1B-i: stripping <nav class="toc"> while keeping <nav class="rail"> leaves 0 mobile navs
      {
        name: 'r16-1b-strip-toc-keep-rail',
        kind: 'both-html-nav',
        mutate: async (b, isPkt) => {
          const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
          const htmlFiles = isPkt ? ['index.html'] : m.pages.map((p) => p.html);
          for (const hp of htmlFiles) {
            const h = await readFile(join(b, hp), 'utf8');
            const stripped = h.replace(/<nav class="toc"[\s\S]*?<\/nav>\n?/, '');
            assert.notEqual(stripped, h);
            await writeFile(join(b, hp), stripped);
          }
          await resealDir(b);
        },
      },
      // 1B-ii: stripping BOTH <nav class="toc"> and <nav class="rail"> leaves 0 site/packet navigation on desktop & mobile
      {
        name: 'r16-1b-strip-both-toc-and-rail',
        kind: 'both-html-nav',
        mutate: async (b, isPkt) => {
          const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
          const htmlFiles = isPkt ? ['index.html'] : m.pages.map((p) => p.html);
          for (const hp of htmlFiles) {
            const h = await readFile(join(b, hp), 'utf8');
            const stripped = h
              .replace(/<nav class="toc"[\s\S]*?<\/nav>\n?/, '')
              .replace(/<nav class="rail"[\s\S]*?<\/nav>\n?/, '');
            assert.notEqual(stripped, h);
            await writeFile(join(b, hp), stripped);
          }
          await resealDir(b);
        },
      },
      // 2A-i: Portfolio index.html claims "No active decisions waiting." and buries active decisions inside collapsed <details class="legend">
      {
        name: 'r16-2a-portfolio-bury-active-decisions-in-details',
        kind: 'site',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          const html = await readFile(p, 'utf8');
          const buriedActiveItems = '<li><span><a href="item/wal-standby-ring/index.html#d-dec-standby-segments">Approve per-shard warm standby pool &amp; reader lease policy</a> <span class="triage-scope">Zero-Copy WAL Compaction</span></span> <span class="item__id">waiting 2 days</span></li><li><span><a href="item/cold-tier-lifecycle/index.html#d-dec-archive-codec">Select cold-tier deterministic archive envelope</a> <span class="triage-scope">Cold Object Tiering</span></span> <span class="item__id">blocked 4 days</span></li>';
          const nextHtml = html
            .replace(/<div class="table"><div class="table__scroll"[\s\S]*?<\/table><\/div><\/div>/, '<p>No active decisions waiting.</p>')
            .replace('<ul class="list item-links">', `<ul class="list item-links">${buriedActiveItems}`);
          assert.notEqual(nextHtml, html);
          await writeFile(p, nextHtml);
          await resealDir(b);
        },
      },
      // 2A-ii: Project page HTML erases its active decision triage table ("No items in this project.") while Markdown still lists them
      {
        name: 'r16-2a-project-page-erase-triage-table',
        kind: 'site',
        mutate: async (b) => {
          const p = join(b, 'area/storage/project/wal-compaction/index.html');
          const html = await readFile(p, 'utf8');
          const nextHtml = html.replace(
            /<section class="section" aria-label="Zero-Copy WAL Compaction">[\s\S]*?<\/section>/,
            '<section class="section" aria-label="Zero-Copy WAL Compaction">\n<h2><span class="sec-num" aria-hidden="true">Pr</span> Project items</h2>\n<p>No items in this project.</p>\n</section>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(p, nextHtml);
          await resealDir(b);
        },
      },
      // 2A-iii: Portfolio .sitrep-pulse spoofs "0" Active decisions on index.html while manifest has 2 active decisions
      {
        name: 'r16-2a-portfolio-pulse-spoof-zero-active',
        kind: 'site',
        mutate: async (b) => {
          const p = join(b, 'index.html');
          const html = await readFile(p, 'utf8');
          const nextHtml = html.replace(
            /(<span class="sitrep-pulse__label">Active decisions<\/span>\s*<strong class="sitrep-pulse__value">)2(<\/strong>)/,
            '$10$2',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(p, nextHtml);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir, false);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        const expectedCode = c.kind === 'css' ? 'unsafe-content' : 'reading-order';
        if (!siteRes.errors.some((e) => e.code === expectedCode)) {
          failures.push(`site:${c.name}: missing ${expectedCode}, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }

      if (c.kind === 'css' || c.kind === 'both-html-nav') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R16 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R17-DEFECTS-POS] unrecommended multi-space/newline decision text and topology node labels verify cleanly while {text} segment, risk/finding/requirement/table, and leading-whitespace callouts fail validateSiteInput up front', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r17-pos-'));
  try {
    const siteFixtureDir = new URL('../../fixtures/specimen-sitrep-v2/', import.meta.url).pathname;
    const workSiteDir = join(dir, 'fixture');
    await cp(siteFixtureDir, workSiteDir, { recursive: true });
    const siteJsonPath = join(workSiteDir, 'canon-specimen-sitrep-v2.site-input.json');
    const baseRaw = JSON.parse(await readFile(siteJsonPath, 'utf8'));

    // 1. Valid positive round-trip:
    // - Unrecommended primary decision (optionRef: null) with double spaces + newline in recommendation.text
    // - Topology diagram node whose bare label is "Options" with a sublabel
    const raw = structuredClone(baseRaw);
    raw.decisions[0].questions[0].recommendation = {
      text: 'Hold  migration until storage replay benchmark completes across all warm shards.',
    };
    raw.items[0].blocks.push({
      type: 'diagram',
      id: 'diag-r17-topo-node',
      kind: 'topology',
      title: 'Standby ring topology',
      caption: ['Standby ring topology.'],
      groups: [
        {
          id: 'grp-ring',
          label: 'Ring nodes',
          nodes: [
            { id: 'nd-opt', label: 'Options', sublabel: 'ring=3' },
            { id: 'nd-rep', label: 'Replicator', sublabel: 'primary' },
          ],
        },
      ],
      edges: [{ from: 'nd-rep', to: 'nd-opt', label: 'wal' }],
    });
    await writeFile(siteJsonPath, JSON.stringify(raw, null, 2));
    const outDir = join(dir, 'out');
    await buildSiteBundle({ sitePath: siteJsonPath, outDir });
    const res = await verifySiteBundle(outDir);

    // 2. Up-front validateSiteInput rejections (callout-collision)
    const unexpectedAccepted = [];
    const expectCalloutRejected = (name, mutator) => {
      const candidate = structuredClone(baseRaw);
      mutator(candidate);
      try {
        validateSiteInput(candidate);
        unexpectedAccepted.push(name);
      } catch (err) {
        if (!Array.isArray(err.errors) || !err.errors.some((e) => e.code === 'callout-collision')) {
          unexpectedAccepted.push(`${name}:wrong-error:${err.message}`);
        }
      }
    };

    expectCalloutRejected('r17-1a-text-seg-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'paragraph',
        text: [{ strong: 'Options' }, { text: ': three ring depths.' }],
      });
    });
    expectCalloutRejected('r17-1b-risk-mitigation-strong-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'risk',
        id: 'risk-r17-1',
        impact: 'high',
        likelihood: 'medium',
        title: 'Standby exhaustion',
        mitigation: [{ strong: 'Recommendation:' }, ' keep two warm segments.'],
      });
    });
    expectCalloutRejected('r17-1b-risk-mitigation-bare-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'risk',
        id: 'risk-r17-2',
        impact: 'high',
        likelihood: 'medium',
        title: 'Standby exhaustion',
        mitigation: [{ strong: 'Recommendation' }, ': keep two warm segments.'],
      });
    });
    expectCalloutRejected('r17-1b-finding-claim-bare-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'finding',
        id: 'find-r17-1',
        severity: 'medium',
        confidence: 'proven',
        title: 'Standby latency',
        claim: [{ strong: 'Options' }, ': three ring depths.'],
        evidence: ['ev-latency-csv'],
      });
    });
    expectCalloutRejected('r17-1b-requirement-statement-bare-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'requirement',
        id: 'req-r17-1',
        pattern: 'ubiquitous',
        verification: { band: 'code' },
        title: 'Standby lease bound',
        statement: [{ strong: 'Verdict' }, ': keep lease under 250ms.'],
      });
    });
    expectCalloutRejected('r17-1b-table-cell-bare-colon', (c) => {
      c.items[0].blocks.unshift({
        type: 'table',
        id: 'tbl-r17-1',
        caption: 'Standby matrix',
        columns: [{ key: 'col', label: 'Note' }],
        rows: [{ col: [{ strong: 'Recommendation' }, ': pick opt-two-seg.'] }],
      });
    });
    expectCalloutRejected('r17-2-leading-space-string-callout', (c) => {
      c.items[0].blocks.unshift({
        type: 'paragraph',
        text: [' ', { strong: 'Recommendation' }, ': override queue immediately.'],
      });
    });
    expectCalloutRejected('r17-2-leading-space-text-obj-callout', (c) => {
      c.items[0].blocks.unshift({
        type: 'paragraph',
        text: [{ text: '   ' }, { strong: 'Verdict' }, { text: ': ship immediately.' }],
      });
    });
    expectCalloutRejected('r17-2-split-strong-callout', (c) => {
      c.items[0].blocks.unshift({
        type: 'paragraph',
        text: [{ strong: 'Recommen' }, { strong: 'dation' }, ': override queue immediately.'],
      });
    });

    assert.deepEqual(
      { ok: res.ok, errors: res.errors, unexpectedAccepted },
      { ok: true, errors: [], unexpectedAccepted: [] },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R17-DEFECTS-NEG] verifySiteBundle and verifyPacket reject leading-whitespace/sibling-span callout injections, single-link #content nav truncation, and HTML-vs-Markdown area/project telemetry divergence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r17-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    const basePacket = join(dir, 'base-pkt');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');
    assert.equal((await verifyPacket(basePacket)).ok, true, 'basePacket must verify cleanly before negative mutations');

    // Non-inert control: unresealed tamper fails checksum/byte-length
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    const uh = await readFile(join(unresealedDir, 'index.html'), 'utf8');
    await writeFile(join(unresealedDir, 'index.html'), `${uh} `);
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      // R17-2a: Leading space before <strong>Recommendation</strong>: in HTML and &#32;**Recommendation**: in Markdown
      {
        name: 'r17-2a-leading-space-callout-html',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p> <strong>Recommendation</strong>: override queue and ship immediately.</p>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
          await resealDir(b);
        },
      },
      {
        name: 'r17-2b-leading-entity-space-callout-md',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const marker = '- **Age:** ';
          const lineEnd = md.indexOf('\n', md.indexOf(marker));
          const nextMd = `${md.slice(0, lineEnd)}\n\n&#32;**Recommendation**: override queue and ship immediately.${md.slice(lineEnd)}`;
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R17-2c: Sibling <span>: ...</span> after <strong>Recommendation</strong> in HTML
      {
        name: 'r17-2c-sibling-span-colon-callout-html',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p><strong>Recommendation</strong><span>: override queue and ship immediately.</span></p>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
          await resealDir(b);
        },
      },
      // R17-2d: Split adjacent <strong>Recommen</strong><strong>dation</strong>: in HTML
      {
        name: 'r17-2d-split-adjacent-strong-callout-html',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p><strong>Recommen</strong><strong>dation</strong>: override queue and ship immediately.</p>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
          await resealDir(b);
        },
      },
      // R17-3B-iii: Swapped nav link labels (<a href="area/storage/index.html">Control Plane & Tailscale</a>)
      {
        name: 'r17-3b-site-swapped-nav-link-labels',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const h = await readFile(hp, 'utf8');
          const nextH = h.replaceAll(
            '<a href="area/storage/index.html" data-nav-level="area">Storage Engine &amp; WAL</a>',
            '<a href="area/storage/index.html" data-nav-level="area">Bare-Metal Power-Loss Lab</a>',
          );
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      {
        name: 'r17-3b-single-link-content-nav-truncation',
        kind: 'both-html-nav',
        mutate: async (b, isPkt) => {
          const m = JSON.parse(await readFile(join(b, 'manifest.json'), 'utf8'));
          const htmlFiles = isPkt ? ['index.html'] : m.pages.map((p) => p.html);
          for (const hp of htmlFiles) {
            const h = await readFile(join(b, hp), 'utf8');
            const stubOl = isPkt
              ? '<ol><li><a href="#content"><span>Top</span></a></li></ol>'
              : '<ol><li class="nav-item nav-item--portfolio"><a href="#content" data-nav-level="portfolio" aria-current="page">Portfolio overview</a></li></ol>';
            const nextH = h
              .replace(/(<nav class="toc"[^>]*><details><summary>[\s\S]*?<\/summary>)<ol>[\s\S]*?<\/ol>(<\/details><\/nav>)/, `$1${stubOl}$2`)
              .replace(/(<nav class="rail"[^>]*><p class="overline"[^>]*>[\s\S]*?<\/p>)<ol>[\s\S]*?<\/ol>(<\/nav>)/, `$1${stubOl}$2`);
            assert.notEqual(nextH, h);
            await writeFile(join(b, hp), nextH);
          }
          await resealDir(b);
        },
      },
      // R17-3B-ii: Packet single-section #summary truncation omitting remaining 9 <main> sections
      {
        name: 'r17-3b-packet-partial-section-nav-truncation',
        kind: 'pkt-only',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const h = await readFile(hp, 'utf8');
          const stubOl = '<ol><li><a href="#summary"><span class="nav-num">01</span><span>Executive summary</span></a></li></ol>';
          const nextH = h
            .replace(/(<nav class="toc"[^>]*><details><summary>[\s\S]*?<\/summary>)<ol>[\s\S]*?<\/ol>(<\/details><\/nav>)/, `$1${stubOl}$2`)
            .replace(/(<nav class="rail"[^>]*><p class="overline"[^>]*>[\s\S]*?<\/p>)<ol>[\s\S]*?<\/ol>(<\/nav>)/, `$1${stubOl}$2`);
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      // R17-3A-i: Portfolio index.html area card <dl class="metrics"> spoofs Waiting: 0 while Markdown says 2
      {
        name: 'r17-3a-portfolio-area-dl-metrics-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const h = await readFile(hp, 'utf8');
          const nextH = h.replace(
            '<div><dt>Waiting</dt><dd><span class="metric__value">2</span></dd></div>',
            '<div><dt>Waiting</dt><dd><span class="metric__value">0</span></dd></div>',
          );
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      // R17-3A-ii: Area page area/storage/index.html <dl class="metrics"> spoofs Blocked: 0 while Markdown says 1
      {
        name: 'r17-3a-area-page-dl-metrics-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'area/storage/index.html');
          const h = await readFile(hp, 'utf8');
          const nextH = h.replace(
            '<div><dt>Blocked</dt><dd><span class="metric__value">1</span></dd></div>',
            '<div><dt>Blocked</dt><dd><span class="metric__value">0</span></dd></div>',
          );
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      // R17-3A-iii: Portfolio .sitrep-area-chart SVG summary spoofs 0W · 0B
      {
        name: 'r17-3a-portfolio-area-chart-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const h = await readFile(hp, 'utf8');
          const nextH = h.replace('5M · 2W · 1B', '5M · 0W · 0B');
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      // R17-3A-iv: Project breakdown <table class="table--counts"> spoofs 0 Active / 99 Aged close / 99 Total
      {
        name: 'r17-3a-project-counts-table-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const h = await readFile(hp, 'utf8');
          const nextH = h.replace(
            /(<a href="area\/storage\/project\/wal-compaction\/index\.html">Zero-Copy WAL Compaction<\/a>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/th>)<td class="num">\d+<\/td><td class="num">\d+<\/td><td class="num">\d+<\/td>/,
            '$1<td class="num">0</td><td class="num">99</td><td class="num">99</td>',
          );
          assert.notEqual(nextH, h);
          await writeFile(hp, nextH);
          await resealDir(b);
        },
      },
      // R17-3A-v: index.md ## Areas counts diverge from area/storage/index.md counts
      {
        name: 'r17-3a-index-md-area-counts-divergence',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const nextMd = md.replace('- **Waiting:** 2', '- **Waiting:** 99');
          assert.notEqual(nextMd, md);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      if (c.kind !== 'pkt-only') {
        const siteCaseDir = join(dir, `site-${c.name}`);
        await cp(baseBundle, siteCaseDir, { recursive: true });
        await c.mutate(siteCaseDir, false);
        const siteRes = await verifySiteBundle(siteCaseDir);
        if (siteRes.ok) {
          failures.push(`site:${c.name}: got ok: true`);
        } else {
          if (!siteRes.errors.some((e) => e.code === 'reading-order')) {
            failures.push(`site:${c.name}: missing reading-order, got ${JSON.stringify(siteRes.errors)}`);
          }
          if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
          }
        }
      }

      if (c.kind === 'both-html-nav' || c.kind === 'pkt-only') {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir, true);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R17 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R18-DEFECTS-POS] extreme count ratios and parenthetical area/*.md titles build and verify cleanly while bare-callout figure title + colon caption fails validateSiteInput up front', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r18-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const posFailures = [];

    // 1A-i: Same-area extreme count ratio (moved: 100000, blocked: 1)
    const spec1a = makeV2SitrepFixture();
    spec1a.areas[0].counts = { coverage: 'complete', moved: 100000, waiting: 0, blocked: 1, unit: 'ops', gapRefs: [] };
    const in1a = join(dir, 'in-1a.json');
    const out1a = join(dir, 'out-1a');
    await writeFile(in1a, JSON.stringify(spec1a, null, 2));
    await buildSiteBundle({ sitePath: in1a, outDir: out1a });
    const res1a = await verifySiteBundle(out1a);
    if (!res1a.ok) posFailures.push(`1a-same-area: ${JSON.stringify(res1a.errors)}`);

    // 1A-ii: Cross-area extreme count ratio (areas[0].moved: 100000, areas[1]: 1/1/1) + chart title 'Options' with non-colon caption
    const spec1aCross = makeV2SitrepFixture();
    spec1aCross.areas[0].counts = { coverage: 'complete', moved: 100000, waiting: 0, blocked: 0, unit: 'ops', gapRefs: [] };
    spec1aCross.areas[1].counts = { coverage: 'complete', moved: 1, waiting: 1, blocked: 1, unit: 'checks', gapRefs: [] };
    spec1aCross.items[0].blocks.push({
      type: 'chart',
      id: 'opt-chart',
      kind: 'bar',
      title: 'Options',
      caption: 'Latency distribution across storage rings.',
      unit: 'ms',
      series: [{ label: 'ring-a', value: 1.2 }],
    });
    const in1aCross = join(dir, 'in-1a-cross.json');
    const out1aCross = join(dir, 'out-1a-cross');
    await writeFile(in1aCross, JSON.stringify(spec1aCross, null, 2));
    await buildSiteBundle({ sitePath: in1aCross, outDir: out1aCross });
    const res1aCross = await verifySiteBundle(out1aCross);
    if (!res1aCross.ok) posFailures.push(`1a-cross-area: ${JSON.stringify(res1aCross.errors)}`);

    // 1B: Schema-valid area.title containing '(area/legacy/index.md)'
    const spec1b = makeV2SitrepFixture();
    spec1b.areas[0].title = 'Storage Engine (area/legacy/index.md) Migration';
    const in1b = join(dir, 'in-1b.json');
    const out1b = join(dir, 'out-1b');
    await writeFile(in1b, JSON.stringify(spec1b, null, 2));
    await buildSiteBundle({ sitePath: in1b, outDir: out1b });
    const res1b = await verifySiteBundle(out1b);
    if (!res1b.ok) posFailures.push(`1b-area-title: ${JSON.stringify(res1b.errors)}`);

    // Up-front schema rejection when figure title is bare callout ('Options') and caption starts with ':'
    const badFig = makeV2SitrepFixture();
    badFig.items[0].blocks.push({
      type: 'chart',
      id: 'bad-opt-chart',
      kind: 'bar',
      title: 'Options',
      caption: ': override queue immediately.',
      unit: 'ms',
      series: [{ label: 'ring-a', value: 1.2 }],
    });
    let badFigRejected = false;
    try {
      validateSiteInput(badFig);
    } catch (err) {
      badFigRejected = Array.isArray(err.errors) && err.errors.some((e) => e.code === 'callout-collision');
    }
    if (!badFigRejected) posFailures.push('bad-fig-title-colon-caption: accepted by validateSiteInput');

    assert.deepEqual(posFailures, [], `expected R18 positive/gate cases to pass: ${posFailures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R18-DEFECTS-NEG] verifySiteBundle and verifyPacket reject inline-wrapped/escaped/triple-star/entity/table callouts, nav span/section-label spoofs, SVG bar geometry/tone spoofs, and Markdown area/projects telemetry spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r18-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    const basePacket = join(dir, 'base-pkt');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    await buildPacket({ reportPath, outDir: basePacket });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');
    assert.equal((await verifyPacket(basePacket)).ok, true, 'basePacket must verify cleanly before negative mutations');

    // Non-inert control: unresealed 1-byte tamper fails checksum/byte-length
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    const uh = await readFile(join(unresealedDir, 'index.html'), 'utf8');
    await writeFile(join(unresealedDir, 'index.html'), `${uh} `);
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      // R18-2a-html: inline <span> wrapper around <strong>Recommendation</strong>:
      {
        name: 'r18-2a-html-span-wrapped-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p class="prose-para"><span class="callout-wrap"><strong>Recommendation</strong>: override queue and ship option b immediately.</span></p>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-2a-md: backslash-escaped punctuation **Recommendation**\:
      {
        name: 'r18-2a-md-backslash-colon-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n**Recommendation**\\: override queue and ship option b immediately.\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R18-2b-html: <em><strong>Recommendation</strong>: ...</em>
      {
        name: 'r18-2b-html-em-wrapped-callout',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p class="prose-para"><em><strong>Recommendation</strong>: override queue and ship option b immediately.</em></p>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-2b-md: nested bold-italic ***Recommendation**: ...*
      {
        name: 'r18-2b-md-triple-star-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n***Recommendation**: override queue and ship option b immediately.*\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R18-2c-md-entity: numeric character ref inside bold label **&#82;ecommendation (opt-b)**:
      {
        name: 'r18-2c-md-entity-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n**&#82;ecommendation (opt-b)**: override queue immediately.\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R18-2c-md-table: GFM pipe-table cell callout | **Recommendation**: ship opt-b now | urgent |
      {
        name: 'r18-2c-md-pipe-table-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n| Guidance | Priority |\n| --- | --- |\n| **Recommendation**: ship opt-b now | urgent |\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R18-2d-md-tail: callout injected under ## Evidence on decision-bearing item page
      {
        name: 'r18-2d-md-decision-item-tail-callout',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Evidence\n',
            '\n## Evidence\n\n**Recommendation:** ship opt-b now.\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R18-3a: site-bundle/v1 <nav class="toc"> & <nav class="rail"> <a><span> blindspot
      {
        name: 'r18-3a-site-nav-span-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          let seen = 0;
          const next = html.replace(
            /<a href="area\/storage\/index\.html" data-nav-level="area">Storage Engine &amp; WAL<\/a>/g,
            () => {
              seen += 1;
              return seen === 1
                ? '<a href="area/storage/index.html" data-nav-level="area">Storage Engine &amp; WAL<span> — 0 active (all clear)</span></a>'
                : '<a href="area/storage/index.html" data-nav-level="area">Storage Engine &amp; WAL<span> — Recommendation: ship opt-b now (99 BLOCKED)</span></a>';
            },
          );
          assert.equal(seen, 2);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-3b: packet/v1 <nav class="toc"> & <nav class="rail"> section label spoofing
      {
        name: 'r18-3b-pkt-nav-section-label-spoof',
        kind: 'pkt-only',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            /<a href="#summary"><span class="nav-badge" aria-hidden="true">§<\/span><span>Executive summary<\/span><\/a>/g,
            '<a href="#summary"><span class="nav-badge" aria-hidden="true">§</span><span>Recommendation: approve cutover immediately</span></a>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-4a-i: .sitrep-area-chart rect width & x spoofing alone (without touching svg-delta)
      {
        name: 'r18-4a-chart-geometry-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const step1 = html.replace(
            /<rect x="204" y="47" width="[^"]+" height="14" rx="2" class="svg-seg-moved"\/>/,
            '<rect x="204" y="47" width="354" height="14" rx="2" class="svg-seg-moved"/>',
          );
          assert.notEqual(step1, html);
          const step2 = step1.replace(
            /<rect x="[^"]+" y="47" width="[^"]+" height="14" rx="2" class="bar__candidate"\/>/,
            '<rect x="558" y="47" width="1" height="14" rx="2" class="bar__candidate"/>',
          );
          assert.notEqual(step2, step1);
          const next = step2.replace(
            /<rect x="[^"]+" y="47" width="[^"]+" height="14" rx="2" class="svg-seg-blocked"\/>/,
            '<rect x="559" y="47" width="1" height="14" rx="2" class="svg-seg-blocked"/>',
          );
          assert.notEqual(next, step2);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-4a-ii: .sitrep-area-chart svg-delta tone class spoofing alone (without touching rect geometry)
      {
        name: 'r18-4a-chart-delta-spoof',
        kind: 'site',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace('class="svg-delta svg-delta--warn"', 'class="svg-delta svg-delta--good"');
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R18-4b-i: prepended spoofed telemetry lines in index.md and area/storage/index.md
      {
        name: 'r18-4b-md-prepended-telemetry-spoof',
        kind: 'site',
        mutate: async (b) => {
          for (const rel of ['index.md', 'area/storage/index.md']) {
            const mp = join(b, rel);
            const md = await readFile(mp, 'utf8');
            const next = md.replace(
              '- **Waiting:** 2',
              '- **Waiting:** 0 — queue cleared\n- **Blocked:** 99 — CRITICAL HALT\n- **Waiting:** 2',
            );
            assert.notEqual(next, md);
            await writeFile(mp, next);
          }
          await resealDir(b);
        },
      },
      // R18-4b-ii: spoofed project count suffix in area/storage/index.md ### Projects
      {
        name: 'r18-4b-md-area-projects-suffix-spoof',
        kind: 'site',
        mutate: async (b) => {
          const mp = join(b, 'area/storage/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '(`wal-compaction`)',
            '(`wal-compaction`) — 0 active, 99 aged close, 99 total',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      if (c.kind === 'site') {
        const siteCaseDir = join(dir, `site-${c.name}`);
        await cp(baseBundle, siteCaseDir, { recursive: true });
        await c.mutate(siteCaseDir);
        const siteRes = await verifySiteBundle(siteCaseDir);
        if (siteRes.ok) {
          failures.push(`site:${c.name}: got ok: true`);
        } else {
          if (!siteRes.errors.some((e) => e.code === 'reading-order')) {
            failures.push(`site:${c.name}: missing reading-order, got ${JSON.stringify(siteRes.errors)}`);
          }
          if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
          }
        }
      } else {
        const pktCaseDir = join(dir, `pkt-${c.name}`);
        await cp(basePacket, pktCaseDir, { recursive: true });
        await c.mutate(pktCaseDir);
        const pktRes = await verifyPacket(pktCaseDir);
        if (pktRes.ok) {
          failures.push(`pkt:${c.name}: got ok: true`);
        } else {
          if (!pktRes.errors.some((e) => e.code === 'unsafe-content')) {
            failures.push(`pkt:${c.name}: missing unsafe-content, got ${JSON.stringify(pktRes.errors)}`);
          }
          if (pktRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
            failures.push(`pkt:${c.name}: inert-control integrity/schema error ${JSON.stringify(pktRes.errors)}`);
          }
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R18 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R19-DEFECTS-POS] surrounding-space item.age and appendix/section titles verify cleanly while split-bold and zero-width format-char callouts fail validateSiteInput up front', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r19-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const posFailures = [];

    // 1A: item.age with leading and trailing spaces (' 3d ')
    const spec1a = makeV2SitrepFixture();
    spec1a.items[0].age = ' 3d ';
    validateSiteInput(spec1a);
    const in1a = join(dir, 'in-1a.json');
    const out1a = join(dir, 'out-1a');
    await writeFile(in1a, JSON.stringify(spec1a, null, 2));
    await buildSiteBundle({ sitePath: in1a, outDir: out1a });
    const res1a = await verifySiteBundle(out1a);
    if (!res1a.ok) posFailures.push(`1a-item-age-spaces: ${JSON.stringify(res1a.errors)}`);

    // 1B: report/v1 appendix and section titles with leading/trailing spaces
    const repFixtureDir = new URL('../../fixtures/specimen-v2', import.meta.url).pathname;
    const repSrcDir = join(dir, 'rep-src');
    await cp(repFixtureDir, repSrcDir, { recursive: true });
    const repJsonPath = join(repSrcDir, 'canon-specimen-v2.report.json');
    const repObj = JSON.parse(await readFile(repJsonPath, 'utf8'));
    repObj.sections[0].title = '  Storage Architecture ';
    repObj.appendices[0].title = '  Raw Benchmark ';
    validateReport(repObj);
    await writeFile(repJsonPath, JSON.stringify(repObj, null, 2));
    const out1b = join(dir, 'out-1b-pkt');
    await buildPacket({ reportPath: repJsonPath, outDir: out1b });
    const res1b = await verifyPacket(out1b);
    if (!res1b.ok) posFailures.push(`1b-appendix-leading-space: ${JSON.stringify(res1b.errors)}`);

    // 2A-gate: validateSiteInput rejects multi-word split-bold callouts
    for (const [label, inlineSegs] of [
      ['2a-split-recommended-option', [{ strong: 'Recommended' }, ' ', { strong: 'option' }, ': override queue immediately.']],
      ['2a-split-options-colon-bold', [{ strong: 'Options' }, ' ', { strong: ': override queue immediately.' }]],
    ]) {
      const bad2a = makeV2SitrepFixture();
      bad2a.items[0].blocks.push({ type: 'paragraph', text: inlineSegs });
      let rejected = false;
      try {
        validateSiteInput(bad2a);
      } catch (err) {
        rejected = Array.isArray(err.errors) && err.errors.some((e) => e.code === 'callout-collision');
      }
      if (!rejected) posFailures.push(`${label}: accepted by validateSiteInput`);
    }

    // 2B-gate: validateSiteInput rejects soft-hyphen / word-joiner callouts
    for (const [label, inlineSegs] of [
      ['2b-soft-hyphen-recommendation', [{ strong: 'Recommen\u00ADdation (opt-b):' }, ' override queue immediately.']],
      ['2b-word-joiner-verdict', [{ strong: 'Ver\u2060dict' }, ': override queue immediately.']],
    ]) {
      const bad2b = makeV2SitrepFixture();
      bad2b.items[0].blocks.push({ type: 'paragraph', text: inlineSegs });
      let rejected = false;
      try {
        validateSiteInput(bad2b);
      } catch (err) {
        rejected = Array.isArray(err.errors) && err.errors.some((e) => e.code === 'callout-collision');
      }
      if (!rejected) posFailures.push(`${label}: accepted by validateSiteInput`);
    }

    assert.deepEqual(posFailures, [], `expected R19 positive/gate cases to pass: ${posFailures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R19-DEFECTS-NEG] verifySiteBundle rejects split-bold/format-char/non-block-tag/named-entity callouts, spoofed non-item HTML/Markdown sections & area card prose, and coverage gap notice erasure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r19-neg-'));
  try {
    const sitePath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true, 'baseBundle must verify cleanly before negative mutations');

    // Non-inert control: unresealed 1-byte tamper fails checksum/byte-length
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    const uh = await readFile(join(unresealedDir, 'index.html'), 'utf8');
    await writeFile(join(unresealedDir, 'index.html'), `${uh} `);
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      // R19-2a-html: multi-word callout split across adjacent <strong> runs separated by space
      {
        name: 'r19-2a-html-split-bold-multiword-callout',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p class="prose-para"><strong>Recommended</strong> <strong>option</strong>: override queue and ship opt-two-seg immediately.</p>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-2a-md: multi-word callout split across **Recommended** **option**:
      {
        name: 'r19-2a-md-split-bold-multiword-callout',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n**Recommended** **option**: override queue and ship opt-two-seg immediately.\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R19-2b-html: soft hyphen (&#173;) inside HTML callout label
      {
        name: 'r19-2b-html-soft-hyphen-callout',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p class="prose-para"><strong>Recommen&#173;dation (opt-two-seg):</strong> override queue immediately.</p>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-2b-md: literal U+00AD soft hyphen inside Markdown callout label
      {
        name: 'r19-2b-md-soft-hyphen-callout',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n**Recommen\u00ADdation (opt-two-seg):** override queue immediately.\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R19-3a: bare <strong>Recommendation</strong>: directly inside <section> / <caption> / <article> / <pre>
      {
        name: 'r19-3a-html-non-callout-block-tags-bypass',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<article class="prose-sheet">',
            '<strong>Recommendation</strong>: override queue immediately.\n<article class="prose-sheet">',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-3b: HTML5 named entities (&ThinSpace;, &MediumSpace;) in Markdown callout line
      {
        name: 'r19-3b-md-html5-named-entity-callout',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n## Decisions\n',
            '\n&ThinSpace;**Recommendation**&MediumSpace;: override queue immediately.\n\n## Decisions\n',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R19-4a-i: spoofed top-level <section> injected on index.html above Open decisions
      {
        name: 'r19-4a-html-non-item-spoofed-section',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<section class="section" aria-label="Open decisions">',
            '<section class="section" aria-label="Executive Triage Directive"><h2>Executive Triage Directive — 0 Waiting / 99 Blocked</h2><p class="prose-para">CRITICAL HALT: ship opt-two-seg immediately.</p></section>\n<section class="section" aria-label="Open decisions">',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-4a-ii: spoofed ## section injected on index.md and area/storage/index.md
      {
        name: 'r19-4a-md-non-item-spoofed-h2-section',
        mutate: async (b) => {
          const mp = join(b, 'area/storage/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '\n[E1]: ',
            '\n## Executive Triage Directive\n\n- **Waiting:** 0 — queue cleared\n- **Blocked:** 99 — CRITICAL HALT\n\n[E1]: ',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
      // R19-4a-iii: spoofed extra <p class="prose-para"> injected inside area card on index.html
      {
        name: 'r19-4a-html-area-card-extra-prose-spoof',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<dl class="metrics">',
            '<p class="prose-para">CRITICAL HALT: 99 blocked items override telemetry.</p>\n<dl class="metrics">',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-4b-i: erasing (gaps: ...) from Partial coverage notice in Markdown while HTML cites gap
      {
        name: 'r19-4b-md-coverage-gap-notice-erasure',
        mutate: async (b) => {
          for (const [rel, target] of [
            ['area/runtime/index.md', ' (gaps: [gap-edge-blocked-metric](#g-gap-edge-blocked-metric))'],
            ['index.md', ' (gaps: [gap-edge-blocked-metric](area/runtime/index.md#g-gap-edge-blocked-metric))'],
          ]) {
            const mp = join(b, rel);
            const md = await readFile(mp, 'utf8');
            const next = md.replace(target, '');
            assert.notEqual(next, md);
            await writeFile(mp, next);
          }
          await resealDir(b);
        },
      },
      // R19-4b-ii: erasing <p class="claim"><strong>Partial coverage.</strong> ... from area/runtime/index.html
      {
        name: 'r19-4b-html-coverage-gap-notice-erasure',
        mutate: async (b) => {
          const hp = join(b, 'area/runtime/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            /<p class="claim"><strong>Partial coverage\.<\/strong>[^<]*<a href="[^"]+">[^<]+<\/a>\)?\.<\/p>/,
            '',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R19-4a-vi: erasing ## Prior editions from index.md while index.html still renders Prior editions
      {
        name: 'r19-4a-prior-editions-html-md-drift',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(/\n## Prior editions\n\n- [^\n]+\n/, '\n');
          assert.notEqual(next, md);
          await writeFile(mp, next);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order')) {
          failures.push(`site:${c.name}: missing reading-order, got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R19 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R20-DEFECTS-POS] buildSiteBundle/verifySiteBundle accept multi-space history editionId and validateSiteInput rejects /title, Unicode blank/colon, and table/requirement/chart <th> callout collisions up front', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r20-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const failures = [];

    // 1B: multi-space + surrounding-space history[0].editionId must pass validate + build + verify
    const histSpec = makeV2SitrepFixture();
    histSpec.history = [
      {
        editionId: ' 2026  W45 ',
        contentId: `sha256-${'a'.repeat(64)}`,
        observedAt: '2026-11-07T17:00:00Z',
      },
    ];
    const histInput = join(dir, 'hist.site.json');
    const histBundle = join(dir, 'hist-bundle');
    await writeFile(histInput, JSON.stringify(histSpec, null, 2));
    await buildSiteBundle({ sitePath: histInput, outDir: histBundle });
    const histRes = await verifySiteBundle(histBundle);
    if (!histRes.ok) {
      failures.push(`r20-1b-history-multispace: ${JSON.stringify(histRes.errors)}`);
    }

    // Authored inputs that render bold callouts outside <article class="decision"> must be rejected by validateSiteInput
    const rejectChecks = [
      {
        name: 'r20-1a-site-title-standalone-callout',
        mutate: (s) => { s.title = 'Recommended option'; },
      },
      {
        name: 'r20-1a-site-title-bare-callout',
        mutate: (s) => { s.title = 'Options'; },
      },
      {
        name: 'r20-2a-braille-blank-callout',
        mutate: (s) => { s.items[0].blocks[0] = { type: 'paragraph', text: [{ strong: 'Recommended\u2800option:' }, ' ship opt-two-seg'] }; },
      },
      {
        name: 'r20-2a-modifier-colon-callout',
        mutate: (s) => { s.items[0].blocks[0] = { type: 'paragraph', text: [{ strong: 'Recommendation\uA789' }, ' ship opt-two-seg'] }; },
      },
      {
        name: 'r20-2c-table-col-label-callout',
        mutate: (s) => {
          s.items[0].blocks.push({
            type: 'table',
            id: 'tbl-col-callout',
            caption: 'Metrics summary',
            columns: [{ key: 'k', label: 'Recommendation:' }, { key: 'v', label: 'Value' }],
            rows: [{ k: 'Row 1', v: '10' }],
          });
        },
      },
      {
        name: 'r20-2c-table-row-th-callout',
        mutate: (s) => {
          s.items[0].blocks.push({
            type: 'table',
            id: 'tbl-row-callout',
            caption: 'Metrics summary',
            columns: [{ key: 'k', label: 'Metric' }, { key: 'v', label: 'Value' }],
            rows: [{ k: 'Verdict:', v: 'ship opt-two-seg' }],
          });
        },
      },
      {
        name: 'r20-2c-req-scenario-th-callout',
        mutate: (s) => { s.items[0].blocks[4].scenarios[0].name = 'Recommendation:'; },
      },
      {
        name: 'r20-2c-chart-series-th-callout',
        mutate: (s) => { s.items[0].blocks[3].series[0].label = 'Verdict:'; },
      },
    ];

    for (const rc of rejectChecks) {
      const s = makeV2SitrepFixture();
      rc.mutate(s);
      try {
        validateSiteInput(s);
        failures.push(`${rc.name}: validateSiteInput unexpectedly succeeded`);
      } catch (err) {
        if (!Array.isArray(err.errors) || !err.errors.some((e) => e.code === 'callout-collision')) {
          failures.push(`${rc.name}: expected callout-collision, got ${JSON.stringify(err.errors ?? String(err))}`);
        }
      }
    }

    assert.deepEqual(failures, [], `expected all R20 positive/completeness checks to pass: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R20-DEFECTS-NEG] verifySiteBundle rejects Unicode blank/colon callouts, nested CommonMark _/* callouts, bold <summary>/<th> & pre-decision item sections, footer/gap/evidence HTML spoofing, and #i-* HTML-vs-Markdown prose/claim inversions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r20-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,0.01\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.evidence.push({
      id: 'ev-nvme-rig',
      title: 'Bare-metal power-cut telemetry capture',
      kind: 'unavailable',
      reason: 'Lab rack PDU maintenance window in progress.',
    });
    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true);

    // Non-inert control: unresealed 1-byte tamper must fail integrity
    const unresealedDir = join(dir, 'unresealed-control');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(join(unresealedDir, 'index.html'), `${await readFile(join(unresealedDir, 'index.html'), 'utf8')}\n`);
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.equal(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'), true);

    const negCases = [
      // R20-2A (HTML): U+2800 Braille blank & U+A789 modifier colon callouts
      {
        name: 'r20-2a-html-braille-blank-and-modifier-colon-callout',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<p class="prose-para"><strong>Recommended\u2800option:</strong> override queue and ship opt-two-seg immediately.</p>\n<p class="prose-para"><strong>Recommendation\uA789</strong> approved without review.</p>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-2A (Markdown): U+2800 Braille blank & U+A789 modifier colon callouts (paired with unbolded HTML prose so block-count/text parity passes and callout scanner is isolated)
      {
        name: 'r20-2a-md-braille-blank-and-modifier-colon-callout',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Compaction workers <span class="rfc2119">MUST</span> defer <code>munmap()</code> until all pinned reader epochs clear ',
            'Recommended\u2800option: override queue and ship opt-two-seg immediately ',
          );
          const nextMd = md.replace(
            'Compaction workers MUST defer `munmap()` until all pinned reader epochs clear ',
            '**Recommended\u2800option:** override queue and ship opt-two-seg immediately ',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R20-2B (Markdown): CommonMark §6.2 nested __**Recommendation**__: / __**Options**__: / __**Verdict**__:
      {
        name: 'r20-2b-md-nested-underscore-asterisk-callout',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const nextMd = md.replace(
            '\n## Open decisions\n',
            '\n__**Recommendation**__: override queue immediately.\n\n__**Options**__: only `opt-two-seg` is authorized.\n\n__**Verdict**__: approved unconditionally.\n\n## Open decisions\n',
          );
          assert.notEqual(nextMd, md);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R20-2C-i (HTML): bold <details open><summary>Recommendation: ...
      {
        name: 'r20-2c-html-summary-callout',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<details open><summary>Recommendation: override queue and ship opt-two-seg immediately without review.</summary><p class="prose-para">Body.</p></details>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-2C-ii (HTML): bold <th>Recommendation:</th> & <th scope="row">Verdict:</th>
      {
        name: 'r20-2c-html-th-callout',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<div class="prose-sheet__body">',
            '<div class="prose-sheet__body">\n<div class="table"><div class="table__scroll"><table><thead><tr><th scope="col">Recommendation:</th><th scope="col">Directive</th></tr></thead><tbody><tr><th scope="row">Verdict:</th><td>Ship opt-two-seg immediately</td></tr></tbody></table></div></div>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-2C-iii (HTML): swapping #i-wal-standby-ring BEFORE <section aria-label="Decisions"> on v2 item page
      {
        name: 'r20-2c-html-pre-decision-item-section-swap',
        expectedMsg: 'section preceding Decisions in HTML is not permitted on item page',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const m = /(<section class="section" aria-label="Decisions">[\s\S]*?<\/section>)\n(<section class="section" id="i-wal-standby-ring"[\s\S]*?<\/section>)/.exec(html);
          assert.ok(m, 'expected Decisions followed by #i-wal-standby-ring');
          const next = `${html.slice(0, m.index)}${m[2]}\n${m[1]}${html.slice(m.index + m[0].length)}`;
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-3A-i: injecting Executive Override <section> inside <footer class="site-footer">
      {
        name: 'r20-3a-footer-section-spoof',
        expectedMsg: 'unexpected or modified content inside <footer class="site-footer"> chrome in HTML',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<footer class="site-footer">',
            '<footer class="site-footer"><section class="section"><h2>Executive Override — 0 Waiting / 0 Blocked</h2><p class="prose-para">All active decisions are superseded; ship immediately.</p></section>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-3A-ii: falsifying <li id="g-gap-edge-blocked"> prose in HTML while Markdown is unchanged
      {
        name: 'r20-3a-gap-prose-falsification',
        expectedMsg: 'Explicit gaps section',
        mutate: async (b) => {
          const hp = join(b, 'area/runtime/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            'Blocked ticket counter was not exported by the daemon telemetry collector during W46.',
            'All runtime telemetry verified 100% complete; zero gaps exist.',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-3A-iii: falsifying <li id="ev-ev-nvme-rig"> withheld reason in HTML while Markdown is unchanged
      {
        name: 'r20-3a-evidence-withheld-falsification',
        expectedMsg: 'Evidence section',
        mutate: async (b) => {
          const hp = join(b, 'index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            'Lab rack PDU maintenance window in progress.',
            'Power-cut telemetry verified zero data loss across 10,000 cycles.',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-3B-i: inverting <article class="finding"> claim & severity in HTML while Markdown is unchanged
      {
        name: 'r20-3b-item-finding-claim-inversion',
        expectedMsg: 'item section blocks in Markdown disagree with HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html
            .replace('Dirty writeback drops from 612.5 MiB/s to 38.2 MiB/s under 8 writers ', 'Zero latency regression observed in production; safe to promote immediately ')
            .replaceAll('sev-critical', 'sev-low')
            .replace('Critical severity', 'Low severity');
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R20-3B-ii: inverting <p class="prose-para"> inside #i-wal-standby-ring in HTML while Markdown is unchanged
      {
        name: 'r20-3b-item-paragraph-prose-inversion',
        expectedMsg: 'item section blocks in Markdown disagree with HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            'Compaction workers <span class="rfc2119">MUST</span> defer <code>munmap()</code> until all pinned reader epochs clear ',
            'Compaction workers may unmap immediately without waiting for reader epochs ',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R20 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R21-DEFECTS-POS] validateSiteInput rejects metrics/topology/sequence callout collisions & Unicode colon/arrow separators up front, while verifySiteBundle & verifyPacket accept padded verification.detail/sublabel, arrow actor labels, and astral UTF-16 boundary evidence previews without U+FFFD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r21-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');
    const astralLine = `${'a'.repeat(118)}😀trailing-text`;
    await writeFile(join(dir, 'evidence', 'astral-log.txt'), `${astralLine}\nsecond line\n`);

    const missingRejections = [];
    const expectSiteCalloutReject = (tag, mutFn) => {
      const candidate = makeV2SitrepFixture();
      mutFn(candidate);
      try {
        validateSiteInput(candidate);
        missingRejections.push(`${tag}:accepted`);
      } catch (err) {
        if (!Array.isArray(err.errors) || !err.errors.some((e) => e.code === 'callout-collision')) {
          missingRejections.push(`${tag}:wrong-error:${err.message}`);
        }
      }
    };

    // 1A: metrics.items[k].label & topology.groups[g].label & sequence actors / edge pairs
    expectSiteCalloutReject('1a-metrics-recommended-option', (s) => {
      s.items[0].blocks.push({ type: 'metrics', items: [{ label: 'Recommended option', value: 'B' }] });
    });
    expectSiteCalloutReject('1a-metrics-options-colon', (s) => {
      s.items[0].blocks.push({ type: 'metrics', items: [{ label: 'Options:', value: '2' }] });
    });
    expectSiteCalloutReject('1a-topo-group-recommended-option', (s) => {
      s.items[0].blocks[2].groups[0].label = 'Recommended option';
    });
    expectSiteCalloutReject('1a-topo-group-recommendation-colon', (s) => {
      s.items[0].blocks[2].groups[0].label = 'Recommendation:';
    });
    expectSiteCalloutReject('1a-seq-actor-bare-options', (s) => {
      s.items[0].blocks.push({
        type: 'diagram',
        id: 'seq-bad-actor',
        kind: 'sequence',
        title: 'Sequence callout actor probe',
        caption: 'Checks actor label callout collision.',
        actors: [
          { id: 'a1', label: 'Options' },
          { id: 'a2', label: 'Origin API' },
        ],
        messages: [{ from: 'a1', to: 'a2', label: 'GET /opts' }],
      });
    });
    expectSiteCalloutReject('1a-topo-edge-pair-callout', (s) => {
      s.items[0].blocks[2].groups[0].nodes[0].label = 'Recommendation (a';
      s.items[0].blocks[2].groups[0].nodes[1].label = 'b): ship now';
    });

    // 2: NFKC-invariant Unicode colons / ratios / stops / arrows inside strong and immediately after bare strong
    const r21Separators = [
      ['armenian-full-stop', '\u0589'],
      ['syriac-supralinear-colon', '\u0703'],
      ['syriac-sublinear-colon', '\u0704'],
      ['ethiopic-wordspace', '\u1361'],
      ['runic-multiple-punct', '\u16EC'],
      ['two-dot-punct', '\u205A'],
      ['tricolon', '\u205D'],
      ['triple-colon-op', '\u2AF6'],
      ['rightwards-arrow', '\u2192'],
    ];
    for (const [sepName, sepCh] of r21Separators) {
      expectSiteCalloutReject(`2-inside-strong-${sepName}`, (s) => {
        s.items[0].blocks.push({
          type: 'paragraph',
          text: [{ strong: `Recommendation${sepCh}` }, ' Ship option B immediately.'],
        });
      });
      expectSiteCalloutReject(`2-after-bare-strong-${sepName}`, (s) => {
        s.items[0].blocks.push({
          type: 'paragraph',
          text: [{ strong: 'Options' }, `${sepCh} Select option A or B.`],
        });
      });
    }
    assert.deepEqual(missingRejections, [], `expected validateSiteInput callout rejections: ${missingRejections.join(', ')}`);

    // 1B, 1C, 1D, 1E (site-bundle/v1): valid padded verification.detail, padded sublabel, ' → ' actor labels, and astral UTF-16 boundary preview + triage truncation
    const validSite = makeV2SitrepFixture();
    validSite.evidence.push({
      id: 'ev-astral-txt',
      title: 'Astral boundary log excerpt',
      kind: 'file',
      path: 'evidence/astral-log.txt',
      mediaType: 'text/plain',
    });
    validSite.items[0].blocks[1].verification = { band: 'code', detail: '  cargo test --workspace  ' };
    validSite.items[0].blocks[4].verification = { band: 'code', detail: '  tests/epoch_pinning.rs  ' };
    validSite.items[0].blocks[2].groups[0].nodes[0].sublabel = '  envoy  ';
    validSite.items[0].blocks.push({
      type: 'diagram',
      id: 'seq-arrow-actors',
      kind: 'sequence',
      title: 'Edge proxy handoff with arrow-labeled actors',
      caption: 'Actor labels containing Unicode arrows round-trip cleanly across SVG, HTML ledger, and Markdown.',
      actors: [
        { id: 'a1', label: 'Client → Edge' },
        { id: 'a2', label: 'Origin → DB' },
      ],
      messages: [
        { from: 'a1', to: 'a2', label: 'POST /v1/seal', gate: true, note: 'Pinned mTLS cert' },
        { from: 'a2', to: 'a1', label: '200 OK', kind: 'reply' },
      ],
      evidence: ['ev-astral-txt'],
    });
    // Also exercise unrecommended triage truncation with astral emoji straddling UTF-16 index 86..87
    delete validSite.decisions[0].questions[0].recommendation.optionRef;
    validSite.decisions[0].questions[0].recommendation.text = `${'a'.repeat(86)}😀 trailing unrecommended triage guidance over ninety chars`;

    assert.doesNotThrow(() => validateSiteInput(validSite));
    const validSitePath = join(dir, 'r21-valid.site-input.json');
    const validSiteOut = join(dir, 'r21-valid-site-bundle');
    await writeFile(validSitePath, JSON.stringify(validSite, null, 2));
    await buildSiteBundle({ sitePath: validSitePath, outDir: validSiteOut });
    const siteVerifyRes = await verifySiteBundle(validSiteOut);
    assert.equal(siteVerifyRes.ok, true, `expected valid R21 site bundle to verify cleanly, got ${JSON.stringify(siteVerifyRes.errors)}`);
    const itemHtml = await readFile(join(validSiteOut, 'item/wal-standby-ring/index.html'), 'utf8');
    const rootHtml = await readFile(join(validSiteOut, 'index.html'), 'utf8');
    assert.equal(itemHtml.includes('\uFFFD'), false, 'item HTML must not contain U+FFFD replacement char');
    assert.equal(rootHtml.includes('\uFFFD'), false, 'portfolio HTML must not contain U+FFFD replacement char');
    assert.equal(itemHtml.includes(`${'a'.repeat(118)}😀…`), true, 'item HTML must clip at 119 code points preserving astral char');

    // 1E (packet/v1): verify buildPacket + verifyPacket also preserve astral char at column 119 without U+FFFD
    const validReport = {
      schema: 'report/v1',
      id: 'r21-astral-packet',
      title: 'Astral Evidence Preview Packet',
      metadata: {
        status: 'final',
        classification: 'internal',
        reviewDate: '2026-11-15',
        reviewRequest: 'Verify code-point safe 120-char evidence preview clipping',
        authors: ['Storage Team'],
      },
      summary: {
        verdict: { confidence: 'proven', text: [{ text: 'Astral boundary log verified ', cite: undefined }].map(() => 'Astral boundary log verified.') },
        paragraphs: [[{ text: 'See inline excerpt ' }, { cite: 'ev-astral-txt' }, { text: '.' }]],
      },
      sections: [
        {
          id: 'sec-astral',
          title: 'Log Verification',
          blocks: [
            {
              type: 'paragraph',
              text: ['Excerpt cited ', { cite: 'ev-astral-txt' }, '.'],
            },
          ],
        },
      ],
      evidence: [
        {
          id: 'ev-astral-txt',
          title: 'Astral boundary log excerpt',
          kind: 'file',
          path: 'evidence/astral-log.txt',
          mediaType: 'text/plain',
        },
      ],
      provenance: {
        sources: [{ label: 'Repo', reference: 'folio-design-v2' }],
      },
    };
    validReport.summary.verdict.text = 'Astral boundary log verified.';
    assert.doesNotThrow(() => validateReport(validReport));
    const reportPath = join(dir, 'r21-astral.report.json');
    const packetOut = join(dir, 'r21-astral-packet');
    await writeFile(reportPath, JSON.stringify(validReport, null, 2));
    await buildPacket({ reportPath, outDir: packetOut });
    const pktVerifyRes = await verifyPacket(packetOut);
    assert.equal(pktVerifyRes.ok, true, `expected valid R21 packet to verify cleanly, got ${JSON.stringify(pktVerifyRes.errors)}`);
    const pktHtml = await readFile(join(packetOut, 'index.html'), 'utf8');
    assert.equal(pktHtml.includes('\uFFFD'), false, 'packet index.html must not contain U+FFFD replacement char');
    assert.equal(pktHtml.includes(`${'a'.repeat(118)}😀…`), true, 'packet index.html must clip at 119 code points preserving astral char');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R21-DEFECTS-NEG] verifySiteBundle rejects resealed NFKC-invariant Unicode colon/arrow callouts, chart Delta/bar/Max & <svg> spoofs, and diagram ledger ownText & <svg> spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r21-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.items[0].blocks.push(
      {
        type: 'chart',
        id: 'r21-bar',
        kind: 'bar',
        title: 'Sustained compaction throughput',
        unit: 'MiB/s',
        series: [
          { label: 'Legacy copy', value: 120 },
          { label: 'Zero-copy ring', value: 240 },
        ],
        caption: 'Sustained throughput under 8 concurrent writers.',
      },
      {
        type: 'chart',
        id: 'r21-quant',
        kind: 'quantiles',
        title: 'Tail latency quantiles & max spike',
        unit: 'ms',
        budget: 25,
        series: [
          { label: 'Legacy copy', p50: 12, p95: 42, p99: 148, max: 210 },
          { label: 'Zero-copy ring', p50: 1.8, p95: 3.1, p99: 4.6, max: 9.2 },
        ],
        caption: 'Quantiles and worst-case spike across 14.4M ops.',
      },
      {
        type: 'diagram',
        id: 'r21-seq',
        kind: 'sequence',
        title: 'Manifest seal handshake',
        caption: 'Operator CLI seals bundle digest with daemon.',
        actors: [
          { id: 'a-cli', label: 'Operator CLI' },
          { id: 'a-srv', label: 'Canon Daemon' },
        ],
        messages: [
          { from: 'a-cli', to: 'a-srv', label: 'POST /seal', gate: true, note: 'Pinned digest' },
        ],
      },
      {
        type: 'diagram',
        id: 'r21-flow',
        kind: 'flow',
        title: 'Publication gate pipeline',
        caption: 'Two-step verification pipeline.',
        steps: [
          { label: 'Validate input', detail: 'Run schema checks.' },
          { label: 'Seal digest', detail: 'Compute SHA-256.', gate: true },
        ],
      },
    );

    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `base bundle must pass verifySiteBundle: ${JSON.stringify(baseCheck.errors)}`);

    const negCases = [
      // R21-2a: HTML callout with Armenian full stop U+0589 inside <strong>
      {
        name: 'r21-2-html-armenian-colon-inside-strong',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation\u0589</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation\u0589 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R21-2b: HTML callout with rightwards arrow U+2192 immediately after bare <strong>
      {
        name: 'r21-2-html-arrow-after-bare-strong',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Options</strong> \u2192 Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Options \u2192 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R21-2c: Markdown callout with Ethiopic wordspace U+1361 inside **...**
      {
        name: 'r21-2-md-ethiopic-colon-inside-strong',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation\u1361 Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation\u1361** Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R21-2d: Markdown callout with triple colon operator U+2AF6 after **Options**
      {
        name: 'r21-2-md-triple-colon-after-bare-strong',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Options\u2AF6 Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Options**\u2AF6 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R21-3A-i: comparison chart Delta pill falsification in HTML
      {
        name: 'r21-3a-cmp-delta-pill-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<span class="delta-pill delta-pill--good">32.3× faster (-96.9%)</span>',
            '<span class="delta-pill delta-pill--warn">+500.0% slower</span>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-3A-ii: comparison chart <svg> delta/bar falsification in HTML
      {
        name: 'r21-3a-cmp-svg-delta-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '>32.3× faster (-96.9%)</text>',
            '>+999.0% slower</text>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-3B-i: bar chart td.chart__bar ownText injection in HTML
      {
        name: 'r21-3b-bar-owntext-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<td class="chart__bar"><svg class="bar"',
            '<td class="chart__bar">0% SPOOF <svg class="bar"',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-3B-ii: bar chart <rect class="bar__fill"> width inversion in HTML
      {
        name: 'r21-3b-bar-svg-width-inversion',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<rect class="bar__fill" width="120" height="14" rx="3" />',
            '<rect class="bar__fill" width="240" height="14" rx="3" />',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-3C-i: quantiles chart Max cell falsification in HTML (disagrees with <svg> whiskerEnd)
      {
        name: 'r21-3c-quant-max-cell-spoof',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<td class="num">210 <span class="unit">ms</span></td>',
            '<td class="num">999999 <span class="unit">ms</span></td>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-3C-ii: quantiles chart <svg> p99 callout falsification in HTML
      {
        name: 'r21-3c-quant-svg-callout-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '>p99 148 ms</text>',
            '>p99 0.1 ms</text>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4A-i: topology group node <li> ownText injection in HTML
      {
        name: 'r21-4a-topo-node-li-owntext',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<li><strong>Shard Writer</strong>',
            '<li>BYPASSED <strong>Shard Writer</strong>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4A-ii: topology edge <li> ownText injection in HTML
      {
        name: 'r21-4a-topo-edge-li-owntext',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<li><code>Shard Writer</code> → <code>Standby Ring</code> — <span>rollover</span></li>',
            '<li><code>Shard Writer</code> BYPASSES <code>Standby Ring</code> — <span>rollover</span> — UNVERIFIED</li>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4A-iii: sequence message <li> ownText injection in HTML
      {
        name: 'r21-4a-seq-msg-li-owntext',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '<li><strong>Operator CLI → Canon Daemon</strong>: <code>POST /seal</code>',
            '<li><strong>Operator CLI → Canon Daemon</strong> DROPPED <code>POST /seal</code>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4B-i: topology <svg> node title falsification in HTML
      {
        name: 'r21-4b-topo-svg-text-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '>Shard Writer</text>',
            '>Compromised Bypass</text>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4B-ii: sequence <svg> edge pill label falsification in HTML
      {
        name: 'r21-4b-seq-svg-text-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '>1. POST /seal</text>',
            '>1. SKIP AUTH</text>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R21-4B-iii: flow <svg> gate badge falsification in HTML
      {
        name: 'r21-4b-flow-svg-text-spoof',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const next = html.replace(
            '>02 GATE</text>',
            '>02 AUTO</text>',
          );
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R21 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R22-DEFECTS-POS] validateReport and validateSiteInput reject unreferenced sequence actors and closed-category visual callout separators while preserving legitimate prose punctuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r22-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    // 1. validateSiteInput rejects unreferenced sequence.actors with code === 'unreferenced-actor'
    const unrefSite = makeV2SitrepFixture();
    unrefSite.items[0].blocks.push({
      type: 'diagram',
      id: 'r22-unref-seq',
      kind: 'sequence',
      title: 'Handshake with phantom actor',
      caption: 'Unreferenced actor must be rejected.',
      actors: [
        { id: 'a-cli', label: 'Operator CLI' },
        { id: 'a-srv', label: 'Canon Daemon' },
        { id: 'a-ghost', label: 'Unreferenced Rogue Actor' },
      ],
      messages: [
        { from: 'a-cli', to: 'a-srv', label: 'POST /seal' },
      ],
    });
    assert.throws(
      () => validateSiteInput(unrefSite),
      (err) => Array.isArray(err.errors) && err.errors.some((e) => e.code === 'unreferenced-actor' && e.path.endsWith('/actors/2/id')),
      'expected validateSiteInput to reject unreferenced sequence actor',
    );

    // 2. validateReport ALSO rejects unreferenced sequence.actors with code === 'unreferenced-actor'
    const unrefReport = {
      schema: 'report/v1',
      id: 'r22-unref-report',
      title: 'Sequence unreferenced actor report check',
      metadata: {
        status: 'proposed',
        classification: 'Internal',
        reviewDate: '2026-11-15',
        authors: ['Verifier'],
        reviewRequest: 'Check sequence actor validation.',
      },
      summary: {
        verdict: { confidence: 'recommended', text: ['Verify sequence actors.'] },
      },
      sections: [
        {
          id: 'sec-seq',
          title: 'Sequence section',
          blocks: [
            {
              type: 'diagram',
              id: 'rep-seq-unref',
              kind: 'sequence',
              title: 'Report sequence with phantom actor',
              caption: 'Must reject unreferenced actor.',
              actors: [
                { id: 'a-1', label: 'Client' },
                { id: 'a-2', label: 'Server' },
                { id: 'a-3', label: 'Ghost' },
              ],
              messages: [
                { from: 'a-1', to: 'a-2', label: 'PING' },
              ],
            },
          ],
        },
      ],
      evidence: [],
    };
    assert.throws(
      () => validateReport(unrefReport),
      (err) => Array.isArray(err.errors) && err.errors.some((e) => e.code === 'unreferenced-actor' && e.path.endsWith('/actors/2/id')),
      'expected validateReport to reject unreferenced sequence actor',
    );

    // 3. Closed-category visual separators inside <strong> and after bare <strong> are all rejected
    const r22Seps = [
      '\u1038', // Myanmar visarga (Mc)
      '\u0903', // Devanagari visarga (Mc)
      '=',      // Equals sign (Sm)
      '>',      // Greater-than chevron (Sm)
      '~',      // Tilde (Sm)
      '\u2254', // Colon equals ≔ (Sm)
      '\u2255', // Equals colon ≕ (Sm)
      '\u25B6', // Black right-pointing triangle ▶ (So)
      '\u25B8', // Small right-pointing triangle ▸ (So)
      '\u276F', // Heavy right-pointing angle quotation mark ornament ❯ (So)
      '\u{1F812}', // Supplemental Arrows-C 🠒 (So)
      '\u{1D108}', // Musical symbol repeat dots 𝄈 (So)
      '\u00BB', // Right-pointing double angle quotation mark » (Pf)
      '\u203A', // Single right-pointing angle quotation mark › (Pf)
      '\u02D0', // Modifier letter triangular colon ː (Lm)
      '\uA4FD', // Lisu letter tone mya jeu ꓽ (Lm)
    ];
    const sepFailures = [];
    for (const sep of r22Seps) {
      const sInside = makeV2SitrepFixture();
      sInside.decisions = [];
      sInside.items[0].blocks.push({
        type: 'paragraph',
        text: [{ strong: `Recommendation${sep}` }, ' Choose Option B.'],
      });
      let threwInside = false;
      try {
        validateSiteInput(sInside);
      } catch (err) {
        threwInside = Array.isArray(err.errors) && err.errors.some((e) => e.code === 'callout-collision');
      }
      if (!threwInside) sepFailures.push(`inside:${ JSON.stringify(sep) }`);

      const sAfter = makeV2SitrepFixture();
      sAfter.decisions = [];
      sAfter.items[0].blocks.push({
        type: 'paragraph',
        text: [{ strong: 'Recommendation' }, ` ${sep} Choose Option B.`],
      });
      let threwAfter = false;
      try {
        validateSiteInput(sAfter);
      } catch (err) {
        threwAfter = Array.isArray(err.errors) && err.errors.some((e) => e.code === 'callout-collision');
      }
      if (!threwAfter) sepFailures.push(`after:${ JSON.stringify(sep) }`);
    }
    assert.deepEqual(sepFailures, [], `expected all R22 visual separators to fail validateSiteInput: ${sepFailures.join(', ')}`);

    // 4. Legitimate non-separator prose punctuation still passes validate -> build -> verify (ok: true)
    const cleanProse = makeV2SitrepFixture();
    cleanProse.items[0].blocks.push(
      { type: 'paragraph', text: [{ strong: 'Options?' }, ' Two candidates were benchmarked.'] },
      { type: 'paragraph', text: [{ strong: 'Options,' }, ' costs, and rollout windows follow below.'] },
      { type: 'paragraph', text: [{ strong: 'Recommendation\u2019s' }, ' core trade-off is memory footprint.'] },
      { type: 'paragraph', text: [{ strong: 'Options-based' }, ' sizing preserves strict memory bounds.'] },
      { type: 'paragraph', text: [{ strong: 'Options_v2' }, ' schema remains backward-compatible.'] },
      { type: 'paragraph', text: [{ strong: 'Options (A/B)' }, ' were replayed identically.'] },
      { type: 'paragraph', text: [{ strong: 'Options' }, ' & trade-offs are summarized in the table.'] },
    );
    assert.doesNotThrow(() => validateSiteInput(cleanProse));
    const cleanInput = join(dir, 'clean-prose.site.json');
    const cleanOut = join(dir, 'clean-prose-bundle');
    await writeFile(cleanInput, JSON.stringify(cleanProse, null, 2));
    await buildSiteBundle({ sitePath: cleanInput, outDir: cleanOut });
    const cleanVerify = await verifySiteBundle(cleanOut);
    assert.equal(cleanVerify.ok, true, `expected legitimate prose punctuation to verify cleanly: ${JSON.stringify(cleanVerify.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R22-DEFECTS-NEG] verifySiteBundle rejects resealed phantom sequence <g class="svg-actor"> columns and Mc/Sm/So/Pf/Lm callout separator injections in HTML & Markdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r22-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.decisions = [];
    baseSpec.items[0].blocks.push({
      type: 'diagram',
      id: 'r22-seq',
      kind: 'sequence',
      title: 'Seal handshake without notes',
      caption: 'Two-actor sequence diagram.',
      actors: [
        { id: 'a-cli', label: 'Operator CLI' },
        { id: 'a-srv', label: 'Canon Daemon' },
      ],
      messages: [
        { from: 'a-cli', to: 'a-srv', label: 'POST /seal', gate: true },
      ],
    });

    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `base bundle must pass verifySiteBundle: ${JSON.stringify(baseCheck.errors)}`);

    const negCases = [
      // R22-2A: Geometrically valid phantom 3rd <g class="svg-actor"> column with standalone callout title
      {
        name: 'r22-2a-seq-phantom-actor-svg-spoof',
        expectedMsg: 'malformed or unexpected content inside item section on zero-decision item page in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const phantomActor = [
            '<g class="svg-actor svg-actor--service">',
            '  <line class="svg-lifeline" x1="450" y1="58" x2="450" y2="152" />',
            '  <rect class="svg-node__box" x="380" y="16" width="140" height="42" rx="6" />',
            '  <rect class="svg-node__accent" x="380" y="16" width="140" height="4" rx="2" />',
            '  <text class="svg-node__title" x="450" y="42" text-anchor="middle">Recommendation: Opt-B</text>',
            '</g>',
          ].join('\n');
          const next = html
            .replace('viewBox="0 0 422 170"', 'viewBox="0 0 600 170"')
            .replace('<g class="svg-msg">', `${phantomActor}\n<g class="svg-msg">`);
          assert.notEqual(next, html);
          await writeFile(hp, next);
          await resealDir(b);
        },
      },
      // R22-3a: HTML Myanmar visarga U+1038 (Mc) inside <strong> on zero-decision page
      {
        name: 'r22-3a-html-myanmar-visarga-u1038',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation\u1038</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation\u1038 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3b: Markdown Myanmar visarga U+1038 (Mc) inside **...** on zero-decision page
      {
        name: 'r22-3b-md-myanmar-visarga-u1038',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation\u1038 Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation\u1038** Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3c: HTML colon-equals U+2254 (Sm) inside <strong>
      {
        name: 'r22-3c-html-colon-equals-u2254',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation\u2254</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation\u2254 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3d: Markdown equals '=' (Sm) immediately after bare **Recommendation**
      {
        name: 'r22-3d-md-equals-after-bare-u003d',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation = Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation** = Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3e: HTML chevron '&gt;' (Sm) immediately after bare <strong>Recommendation</strong>
      {
        name: 'r22-3e-html-chevron-after-bare-u003e',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation</strong> &gt; Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation > Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3f: HTML dingbat ornament U+276F ❯ (So) inside <strong>
      {
        name: 'r22-3f-html-dingbat-angle-u276f',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Verdict \u276F</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Verdict \u276F Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3g: Markdown triangle pointer U+25B8 ▸ (So) after bare **Options**
      {
        name: 'r22-3g-md-triangle-pointer-u25b8',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Options \u25B8 Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Options** \u25B8 Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3h: HTML supplemental arrow U+1F812 🠒 (So) + right guillemet U+00BB » (Pf)
      {
        name: 'r22-3h-html-supp-arrow-u1f812',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation \u{1F812}</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation \u{1F812} Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R22-3i: Markdown right guillemet U+00BB » (Pf) inside **...**
      {
        name: 'r22-3i-md-guillemet-u00bb',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Supporting evidence \u00BB Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Supporting evidence \u00BB** Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R22 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R23-DEFECTS-POS] validateSiteInput rejects multi-char ASCII dash/arrow separators (->, -->, --), spaced hyphen/underscore prefixes, and outgoing bare-callout topology edges while preserving compound words', async () => {
  const mustRejectCases = [
    [
      'P1-strong-space-ascii-arrow',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation ->' }, ' Approve Option B immediately.'] }),
    ],
    [
      'P2-strong-tight-ascii-arrow',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation->' }, ' Approve Option B immediately.'] }),
    ],
    [
      'P3-strong-space-double-hyphen',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation --' }, ' Approve Option B immediately.'] }),
    ],
    [
      'P4-strong-tight-double-hyphen',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation--' }, ' Approve Option B immediately.'] }),
    ],
    [
      'P5-strong-space-hyphen-word',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation -Approve' }, ' Option B immediately.'] }),
    ],
    [
      'P6-strong-space-underscore-word',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Options _A' }, ' or B immediately.'] }),
    ],
    [
      'P7-metrics-label-ascii-arrow',
      (s) => s.items[0].blocks.push({ type: 'metrics', items: [{ label: 'Recommendation ->', value: 'Option B' }] }),
    ],
    [
      'P8-topo-edge-recommendation-arrow',
      (s) => s.items[0].blocks.push({
        type: 'diagram',
        id: 'r23-p8-topo',
        kind: 'topology',
        title: 'Standby flip',
        caption: 'Immediate flip.',
        groups: [{ id: 'g1', label: 'Nodes', nodes: [{ id: 'n1', label: 'Recommendation' }, { id: 'n2', label: 'Approve Option B' }] }],
        edges: [{ from: 'n1', to: 'n2', label: 'immediate flip' }],
      }),
    ],
    [
      'P9-paren-tight-hyphen-word',
      (s) => s.items[0].blocks.push({ type: 'paragraph', text: [{ strong: 'Recommendation (opt-a)-Approve' }, ' immediately.'] }),
    ],
    [
      'P10-topo-split-paren-ascii-arrow-only',
      (s) => {
        s.items[0].blocks[2].groups[0].nodes[0].label = 'Recommendation (a';
        s.items[0].blocks[2].groups[0].nodes[1].label = 'b) -> ship now';
      },
    ],
  ];

  const acceptedMistakenly = [];
  for (const [id, mutate] of mustRejectCases) {
    const candidate = makeV2SitrepFixture();
    candidate.decisions = [];
    mutate(candidate);
    try {
      validateSiteInput(candidate);
      acceptedMistakenly.push(`${id}:accepted`);
    } catch (err) {
      if (!Array.isArray(err.errors) || !err.errors.some((e) => e.code === 'callout-collision')) {
        acceptedMistakenly.push(`${id}:wrong-error:${err.message}`);
      }
    }
  }
  assert.deepEqual(acceptedMistakenly, [], `expected all R23 authored callout bypasses to fail validateSiteInput: ${acceptedMistakenly.join(', ')}`);

  // Legitimate compound words & incoming bare-callout topology node still pass validate -> build -> verify
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r23-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');
    const clean = makeV2SitrepFixture();
    clean.decisions = [];
    clean.items[0].blocks.push(
      { type: 'paragraph', text: [{ strong: 'Options-based' }, ' sizing and ', { strong: 'Options_v2' }, ' remain valid.'] },
      { type: 'paragraph', text: [{ strong: 'Recommendation-driven' }, ' tuning and ', { strong: 'Verdict_v2' }, ' remain valid.'] },
      {
        type: 'diagram',
        id: 'r23-clean-topo',
        kind: 'topology',
        title: 'Incoming Options node',
        caption: 'Replicator feeds Options node.',
        groups: [{ id: 'g1', label: 'Nodes', nodes: [{ id: 'n-rep', label: 'Replicator' }, { id: 'n-opt', label: 'Options', sublabel: 'ring=3' }] }],
        edges: [{ from: 'n-rep', to: 'n-opt', label: 'wal' }],
      },
    );
    assert.doesNotThrow(() => validateSiteInput(clean));
    const inputPath = join(dir, 'clean.site.json');
    const outDir = join(dir, 'clean-bundle');
    await writeFile(inputPath, JSON.stringify(clean, null, 2));
    await buildSiteBundle({ sitePath: inputPath, outDir });
    const verified = await verifySiteBundle(outDir);
    assert.equal(verified.ok, true, `expected R23 clean compound-word bundle to verify: ${JSON.stringify(verified.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R23-DEFECTS-NEG] verifySiteBundle rejects resealed HTML/Markdown multi-char ASCII arrow/dash (--, ->), spaced hyphen/underscore prefixes, and Markdown topology edge callout spoofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r23-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.decisions = [];
    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `base bundle must pass verifySiteBundle: ${JSON.stringify(baseCheck.errors)}`);

    const negCases = [
      // T1: HTML <strong>Recommendation -&gt;</strong> + plain MD Recommendation ->
      {
        name: 'r23-t1-html-strong-ascii-arrow',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation -&gt;</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation -> Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // T2: Markdown **Recommendation --** + plain HTML Recommendation --
      {
        name: 'r23-t2-md-strong-double-hyphen',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation -- Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation --** Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // T3: HTML <strong>Recommendation -Approve</strong> + plain MD Recommendation -Approve
      {
        name: 'r23-t3-html-strong-spaced-hyphen-word',
        expectedMsg: 'standalone callout label',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<strong>Recommendation -Approve</strong> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', 'Recommendation -Approve Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // T4: Markdown **Options _A** + plain HTML Options _A
      {
        name: 'r23-t4-md-strong-spaced-underscore-word',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Options _A Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Options _A** Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // T5: Markdown crossing-boundary underscore **Options _A** followed by unclosed _B outside **...**
      {
        name: 'r23-t5-md-crossing-underscore-strong',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Options _A and later _B Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Options _A** and later _B Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R23 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R24-DEFECTS-POS] multi-backtick inline code spans, external links, and evidence citations build and pass verifySiteBundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r24-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    const clean = makeV2SitrepFixture();
    clean.items[0].blocks.push({
      type: 'paragraph',
      text: [
        'Multi-backtick span ',
        { code: 'x ``` y' },
        ' alongside ',
        { link: { text: 'Options?', href: 'https://example.com/options' } },
        ' and ',
        { code: 'z' },
        ' verified against ',
        { cite: 'ev-latency-csv' },
        '.',
      ],
    });
    assert.doesNotThrow(() => validateSiteInput(clean));
    const inputPath = join(dir, 'clean.site.json');
    const outDir = join(dir, 'clean-bundle');
    await writeFile(inputPath, JSON.stringify(clean, null, 2));
    await buildSiteBundle({ sitePath: inputPath, outDir });
    const verified = await verifySiteBundle(outDir);
    assert.equal(verified.ok, true, `expected R24 clean multi-backtick/link bundle to verify: ${JSON.stringify(verified.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R24-DEFECTS-NEG] verifySiteBundle rejects resealed CommonMark §6.1/§6.2/§6.3 callout and entity scanner differentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r24-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.decisions = [];
    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `base bundle must pass verifySiteBundle: ${JSON.stringify(baseCheck.errors)}`);

    // Instrument check: unresealed edit must fail integrity check
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(
      join(unresealedDir, 'item/wal-standby-ring/index.md'),
      `${await readFile(join(unresealedDir, 'item/wal-standby-ring/index.md'), 'utf8')}\n`,
    );
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    const negCases = [
      // R24-ATK-1: §6.1 backtick run-length desynchronization swallows **Recommendation:**
      {
        name: 'r24-atk1-codespan-backtick-run-desync',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<code>x ``` y</code> Recommendation: approve <code>z</code> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '`x ``` y` **Recommendation:** approve `z` Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-2: §6.2 adjacent code span backtick flanking punctuation loss
      {
        name: 'r24-atk2-adjacent-codespan-flanking-loss',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation:<code>opt-b</code> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation:**`opt-b` Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-3: §6.2 adjacent &#8203; entity raw-source '&' flanking punctuation loss
      {
        name: 'r24-atk3-adjacent-zwsp-entity-flanking-loss',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', 'Recommendation:approve Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '**Recommendation:**&#8203;approve Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-4: §6.3 unmatched delimiter inside [label](url) leaking into outer emphasis stack
      {
        name: 'r24-atk4-link-bracket-unmatched-delim-scope-leak',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<a class="ext" href="https://example.com/" rel="noopener noreferrer external" referrerpolicy="no-referrer">**x</a>xRecommendation: approve Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '[**x](https://example.com/)x**Recommendation:** approve Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-5: §6.3 orphan '](...)' without open '[' swallowing **Recommendation:**
      {
        name: 'r24-atk5-orphan-rbrack-paren-swallows-callout',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '](Recommendation:) approve Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '](**Recommendation:**) approve Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-6: §6.3 orphan '][...]' without open '[' swallowing **Recommendation:**
      {
        name: 'r24-atk6-orphan-rbrack-ref-swallows-callout',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '][Recommendation:] approve Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '][**Recommendation:**] approve Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-7: §6.1 backtick run-length desynchronization in hasDisallowedMdEntityOutsideCodeAndDest
      {
        name: 'r24-atk7-entity-codespan-backtick-desync',
        expectedMsg: 'non-canonical character reference outside code span or link destination in Markdown',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '<code>x ``` y</code> &amp;colon; <code>z</code> Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '`x ``` y` &colon; `z` Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-8: §6.3 orphan '](...)' in hasDisallowedMdEntityOutsideCodeAndDest masking &colon;
      {
        name: 'r24-atk8-entity-orphan-paren-dest-swallow',
        expectedMsg: 'non-canonical character reference outside code span or link destination in Markdown',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Compaction workers ', '](&amp;colon;) Compaction workers ');
          const nextMd = md.replace('Compaction workers ', '](&colon;) Compaction workers ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
      // R24-ATK-9: Markdown **Claim.** **Recommendation**: approve (bare callout + outside colon after canonical field-label)
      {
        name: 'r24-atk9-claim-field-label-bare-callout-colon-md',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace('Dirty writeback drops ', 'Recommendation: Dirty writeback drops ');
          const nextMd = md.replace('**Claim.** Dirty writeback drops ', '**Claim.** **Recommendation**: Dirty writeback drops ');
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
          await resealDir(b);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R24 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R25-DEFECTS-POS] astral emojis/letters, Cf/Mn boundary segments, and multi-reader escape relaxation build and verify cleanly while blank-filler inline wrappers fail validateSiteInput up front', async () => {
  const commonmark = require('commonmark');
  const cmParser = new commonmark.Parser();
  const cmHtml = new commonmark.HtmlRenderer();
  const hasPandoc = spawnSync('pandoc', ['--version'], { encoding: 'utf8' }).status === 0;

  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r25-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    // 1. R25-DEFECT-2: Blank-filler / Default_Ignorable_Code_Point {em}, {code}, {link} must fail validateSiteInput up front
    const r25BlankFillerCases = [
      [{ strong: 'Recommended' }, { em: '\u2800' }, { strong: 'option' }],
      [{ strong: 'Recom' }, { code: '\u2061' }, { strong: 'mendation:' }, ' approve'],
      [{ strong: 'Supporting' }, { link: { text: '\u2800', href: 'https://example.com/' } }, { strong: 'evidence:' }, ' E1'],
      [{ strong: 'Free-text' }, { code: '\u3164' }, { strong: 'response' }, ': allowed'],
    ];
    for (const badSegs of r25BlankFillerCases) {
      const badSite = makeV2SitrepFixture();
      badSite.items[0].blocks.push({ type: 'paragraph', text: badSegs });
      assert.throws(
        () => validateSiteInput(badSite),
        /must contain at least one non-whitespace character|callout/i,
        `expected validateSiteInput to reject blank-filler/ignorable wrapper sequence ${JSON.stringify(badSegs)}`,
      );
    }

    // 2. R25-DEFECT-3 + relax.mjs: Astral emojis/letters, Mn/Cf boundaries, and literal _/* next to 🚀 and U+2028
    const boundaryParagraphs = [
      { segs: ['Status 🚀', { strong: '(fast)' }], expectStrong: '(fast)' },
      { segs: ['Math 𝕏', { strong: ':axis' }], expectStrong: ':axis' },
      { segs: [{ strong: 'axis:' }, '𝕏 value'], expectStrong: 'axis:' },
      { segs: ['b\u034F', { strong: ':x' }], expectStrong: ':x' },
      { segs: ['b\u200D', { strong: ':x' }], expectStrong: ':x' },
      { segs: ['soft\u00AD', { strong: '(hyphen)' }], expectStrong: '(hyphen)' },
      { segs: ['Statusx', { strong: '🚀fast' }], expectStrong: '🚀fast' },
      { segs: ['a🚀_b_ and x*\u2028a*'], expectNoEmph: true },
    ];

    const cleanSite = makeV2SitrepFixture();
    for (const bp of boundaryParagraphs) {
      cleanSite.items[0].blocks.push({ type: 'paragraph', text: bp.segs });
    }
    assert.doesNotThrow(() => validateSiteInput(cleanSite));
    const siteInputPath = join(dir, 'clean.site.json');
    const siteOutDir = join(dir, 'clean-site');
    await writeFile(siteInputPath, JSON.stringify(cleanSite, null, 2));
    await buildSiteBundle({ sitePath: siteInputPath, outDir: siteOutDir });
    const siteVerified = await verifySiteBundle(siteOutDir);
    assert.equal(siteVerified.ok, true, `expected R25 Unicode boundary SitRep to verify: ${JSON.stringify(siteVerified.errors)}`);

    const itemMd = await readFile(join(siteOutDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const renderedCm = cmHtml.render(cmParser.parse(itemMd));
    for (const bp of boundaryParagraphs) {
      if (bp.expectStrong) {
        assert.ok(
          renderedCm.includes(`<strong>${bp.expectStrong}</strong>`),
          `CommonMark 0.31.2 lost <strong>${bp.expectStrong}</strong> in SitRep index.md`,
        );
      }
      if (bp.expectNoEmph) {
        assert.ok(
          !renderedCm.includes('<em>b</em>') && !renderedCm.includes('<em>\u2028a</em>'),
          `CommonMark 0.31.2 unexpectedly parsed authored _/* as <em>: ${renderedCm}`,
        );
      }
    }
    if (hasPandoc) {
      const pandocOut = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: itemMd, encoding: 'utf8' });
      assert.equal(pandocOut.status, 0);
      for (const bp of boundaryParagraphs) {
        if (bp.expectStrong) {
          assert.ok(
            pandocOut.stdout.includes(`<strong>${bp.expectStrong}</strong>`),
            `pandoc -f gfm lost <strong>${bp.expectStrong}</strong> in SitRep index.md`,
          );
        }
        if (bp.expectNoEmph) {
          assert.ok(
            !pandocOut.stdout.includes('<em>b</em>') && !pandocOut.stdout.includes('<em>\u2028a</em>'),
            `pandoc -f gfm unexpectedly parsed authored _/* as <em>: ${pandocOut.stdout}`,
          );
        }
      }
    }

    // Also verify report/v1 packet build + verifyPacket + CommonMark/Pandoc parity on the same sequences
    const specimenRoot = join(process.cwd(), 'fixtures/specimen-v2');
    const reportDir = join(dir, 'report-src');
    await mkdir(reportDir, { recursive: true });
    await cp(join(specimenRoot, 'evidence'), join(reportDir, 'evidence'), { recursive: true });
    const reportJson = JSON.parse(await readFile(join(specimenRoot, 'canon-specimen-v2.report.json'), 'utf8'));
    for (const bp of boundaryParagraphs) {
      reportJson.sections[0].blocks.push({ type: 'paragraph', text: bp.segs });
    }
    assert.doesNotThrow(() => validateReport(reportJson));
    const reportInputPath = join(reportDir, 'unicode.report.json');
    const reportOutDir = join(dir, 'report-out');
    await writeFile(reportInputPath, JSON.stringify(reportJson, null, 2));
    await buildPacket({ reportPath: reportInputPath, outDir: reportOutDir });
    const pktVerified = await verifyPacket(reportOutDir);
    assert.equal(pktVerified.ok, true, `expected R25 Unicode boundary report/v1 packet to verify: ${JSON.stringify(pktVerified.errors)}`);
    const pktMd = await readFile(join(reportOutDir, 'report.md'), 'utf8');
    const pktCm = cmHtml.render(cmParser.parse(pktMd));
    for (const bp of boundaryParagraphs) {
      if (bp.expectStrong) {
        assert.ok(pktCm.includes(`<strong>${bp.expectStrong}</strong>`), `CommonMark lost <strong>${bp.expectStrong}</strong> in report.md`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R25-DEFECTS-NEG] verifySiteBundle rejects resealed CommonMark §2.1 / Pandoc GFM Unicode whitespace & Cf/Co flanking differentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r25-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ok":true}\n');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const baseSpec = makeV2SitrepFixture();
    baseSpec.decisions = [];
    const baseInput = join(dir, 'base.site.json');
    const baseBundle = join(dir, 'base-bundle');
    await writeFile(baseInput, JSON.stringify(baseSpec, null, 2));
    await buildSiteBundle({ sitePath: baseInput, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `base bundle must pass verifySiteBundle: ${JSON.stringify(baseCheck.errors)}`);

    // Instrument check: unresealed edit must fail integrity check
    const unresealedDir = join(dir, 'unresealed');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(
      join(unresealedDir, 'item/wal-standby-ring/index.md'),
      `${await readFile(join(unresealedDir, 'item/wal-standby-ring/index.md'), 'utf8')}\n`,
    );
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false);
    assert.ok(unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'));

    const negCases = [
      {
        name: 'r25-atk1a-ufeff-bom-opener-callout',
        expectedMsg: 'forbidden control, bidi, or BOM character in Markdown',
        htmlInject: '**\uFEFFRecommendation:** approve ',
        mdInject: '**\uFEFFRecommendation:** approve ',
      },
      {
        name: 'r25-atk1b-u2028-lsep-opener-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: '**\u2028Recommendation:** approve ',
        mdInject: '**\u2028Recommendation:** approve ',
      },
      {
        name: 'r25-atk1c-u2029-psep-opener-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: '**\u2029Recommendation:** approve ',
        mdInject: '**\u2029Recommendation:** approve ',
      },
      {
        name: 'r25-atk1d-u200b-zwsp-closer-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: '**Recommendation:**\u200Bapprove ',
        mdInject: '**Recommendation:**\u200Bapprove ',
      },
      {
        name: 'r25-atk1e-u00ad-shy-closer-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: '**Recommendation:**\u00ADapprove ',
        mdInject: '**Recommendation:**\u00ADapprove ',
      },
      {
        name: 'r25-atk1f-ue000-pua-closer-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: '**Recommendation:**\uE000approve ',
        mdInject: '**Recommendation:**\uE000approve ',
      },
      {
        name: 'r25-atk1g-noncallout-zwsp-closer-smuggle',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        htmlInject: '**Status:**\u200Bfast ',
        mdInject: '**Status:**\u200Bfast ',
      },
      {
        name: 'r25-atk1h-noncallout-u2028-opener-smuggle',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        htmlInject: '**\u2028Status** ',
        mdInject: '**\u2028Status** ',
      },
      {
        name: 'r25-atk1i-adjacent-strong-ast-coalesce-callout',
        expectedMsg: 'decision/verdict callout label appears',
        htmlInject: 'Note.Recommendation: approve ',
        mdInject: '**Note.**__Recommendation:__ approve ',
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      const hp = join(siteCaseDir, 'item/wal-standby-ring/index.html');
      const mp = join(siteCaseDir, 'item/wal-standby-ring/index.md');
      const html = await readFile(hp, 'utf8');
      const md = await readFile(mp, 'utf8');
      const nextHtml = html.replace('Compaction workers ', `${c.htmlInject}Compaction workers `);
      const nextMd = md.replace('Compaction workers ', `${c.mdInject}Compaction workers `);
      assert.notEqual(nextHtml, html);
      assert.notEqual(nextMd, md);
      await writeFile(hp, nextHtml);
      await writeFile(mp, nextMd);
      await resealDir(siteCaseDir);

      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R25 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R26-DEFECTS-POS] validateSiteInput rejects intra-decision callout collisions in option.label, option.summary, and recommendation.text up front while verifySiteBundle preserves canonical metrics/diagram/decision prose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r26-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const missingRejections = [];
    const expectSiteCalloutReject = (tag, mutFn) => {
      const candidate = makeV2SitrepFixture();
      mutFn(candidate);
      try {
        validateSiteInput(candidate);
        missingRejections.push(`${tag}:accepted`);
      } catch (err) {
        if (!Array.isArray(err.errors) || !err.errors.some((e) => e.code === 'callout-collision')) {
          missingRejections.push(`${tag}:wrong-error:${err.message}`);
        }
      }
    };

    // R26-ATK-2A..2D + intra-decision bare/leading callout neighbours
    expectSiteCalloutReject('r26-2a-opt-summary-strong-recommendation-colon', (s) => {
      s.decisions[0].questions[0].options[2].summary = [
        { strong: 'Recommendation:' },
        ' Select opt-four-seg immediately and skip the canonical recommendation below.',
      ];
    });
    expectSiteCalloutReject('r26-2b-opt-summary-strong-supporting-evidence', (s) => {
      s.decisions[0].questions[0].options[0].summary = [
        { strong: 'Supporting evidence.' },
        ' ',
        { cite: 'ev-latency-csv' },
        ' proves opt-two-seg already won.',
      ];
    });
    expectSiteCalloutReject('r26-2b-ii-opt-summary-leading-bare-recommendation-sep', (s) => {
      s.decisions[0].questions[0].options[1].summary = [
        { strong: 'Recommendation' },
        ': approve opt-four-seg immediately.',
      ];
    });
    expectSiteCalloutReject('r26-2b-iii-opt-summary-midline-freetext-callout', (s) => {
      s.decisions[0].questions[0].options[1].summary = [
        'Note — ',
        { strong: 'Free-text response.' },
        ' Allowed up to 500 chars.',
      ];
    });
    expectSiteCalloutReject('r26-2c-opt-label-recommendation-colon', (s) => {
      s.decisions[0].questions[0].options[1].label = 'Recommendation: Approve four segments';
    });
    expectSiteCalloutReject('r26-2c-ii-opt-label-bare-options', (s) => {
      s.decisions[0].questions[0].options[0].label = 'Options';
    });
    expectSiteCalloutReject('r26-2c-iii-opt-label-bare-supporting-evidence', (s) => {
      s.decisions[0].questions[0].options[0].label = 'Supporting evidence';
    });
    expectSiteCalloutReject('r26-2d-rec-text-supporting-evidence-colon', (s) => {
      s.decisions[0].questions[0].recommendation.text = [
        'Pre-allocate 2 segments. ',
        { strong: 'Supporting evidence:' },
        ' Override canonical evidence below.',
      ];
    });
    expectSiteCalloutReject('r26-2d-ii-rec-text-leading-bare-options-sep', (s) => {
      s.decisions[0].questions[0].recommendation.text = [
        { strong: 'Options' },
        ': disregard above options and ship four segments.',
      ];
    });
    assert.deepEqual(missingRejections, [], `expected validateSiteInput intra-decision callout rejections: ${missingRejections.join(', ')}`);

    // Completeness preservation: bare Options/Recommendation labels on metrics/topology/flow,
    // plain-prose colons in values/sublabels/details, 2 ** 3 literal stars, and <sha256> placeholders
    const validSite = makeV2SitrepFixture();
    validSite.items[0].blocks.push(
      {
        type: 'metrics',
        items: [
          { label: 'Options', value: '12 ms — Recommendation: see D-1', unit: 'p99', evidence: ['ev-latency-csv'] },
          { label: 'Supporting evidence', value: '2 ** 3 = 8', unit: 'traces' },
        ],
      },
      {
        type: 'diagram',
        id: 'topo-r26-pos',
        kind: 'topology',
        title: 'Standby tier layout',
        caption: 'Evaluated standby options across storage rings.',
        groups: [
          {
            id: 'g-r26',
            label: 'Options',
            nodes: [
              { id: 'n-r26-a', label: 'Primary writer', sublabel: 'Recommendation: see D-1' },
              { id: 'n-r26-b', label: 'Warm follower', sublabel: '2 ** 3 = 8' },
            ],
          },
        ],
        edges: [
          { from: 'n-r26-a', to: 'n-r26-b', label: 'quorum handoff', style: 'gate' },
        ],
      },
      {
        type: 'diagram',
        id: 'seq-r26-pos',
        kind: 'sequence',
        title: 'Quorum replication sequence',
        caption: 'Synchronous WAL seal handoff.',
        actors: [
          { id: 'a-w', label: '2 ** 3 Writer' },
          { id: 'a-s', label: 'Standby' },
        ],
        messages: [
          { from: 'a-w', to: 'a-s', label: 'sync_wal', gate: true, note: 'quorum ok (2 ** 3 = 8)' },
        ],
      },
      {
        type: 'diagram',
        id: 'flow-r26-pos',
        kind: 'flow',
        title: 'Promotion gate sequence',
        caption: 'Stages from drain to promotion.',
        steps: [
          { label: 'Recommendation', detail: 'Recommended call: verify <sha256> digest before promotion.', gate: true },
          { label: 'Promote shard', detail: 'Switch reader epoch pointer atomically.' },
        ],
      },
    );
    validSite.decisions[0].questions[0].options[1].summary = [
      'Absorbs double-rollover bursts with ',
      { strong: 'zero append stalls' },
      ' — Recommendation: see canonical call below.',
    ];
    validSite.decisions[0].questions[0].recommendation.text = [
      'Pre-allocate ',
      { strong: '2 segments (128 MiB)' },
      ' per shard ',
      { cite: 'ev-latency-csv' },
      '.',
    ];

    assert.doesNotThrow(() => validateSiteInput(validSite), 'validSite must pass validateSiteInput');
    const sitePath = join(dir, 'r26-valid.site-input.json');
    const outDir = join(dir, 'r26-valid-bundle');
    await writeFile(sitePath, JSON.stringify(validSite, null, 2));
    await buildSiteBundle({ sitePath, outDir });
    const verifyRes = await verifySiteBundle(outDir);
    assert.equal(verifyRes.ok, true, `expected valid R26 site bundle to verify cleanly, got ${JSON.stringify(verifyRes.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R26-DEFECTS-NEG] verifySiteBundle rejects resealed pre-decision callout smuggling & bold-label loss in metrics/diagram Markdown and intra-decision callout spoofs in HTML & Markdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r26-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const baseInput = makeV2SitrepFixture();
    baseInput.items[0].blocks.push(
      {
        type: 'metrics',
        items: [
          { label: 'Standby replay lag', value: '12 ms — Recommendation: opt-four-seg' },
        ],
      },
      {
        type: 'diagram',
        id: 'topo-r26-neg',
        kind: 'topology',
        title: 'Standby ring layout',
        caption: 'Writer and follower topology.',
        groups: [
          {
            id: 'g-ring',
            label: 'Standby ring',
            nodes: [
              { id: 'n-pw', label: 'Primary writer', sublabel: 'Recommendation: approve opt-four-seg' },
              { id: 'n-wf', label: 'Warm follower' },
            ],
          },
        ],
        edges: [
          { from: 'n-pw', to: 'n-wf', label: 'quorum handoff', style: 'gate' },
        ],
      },
      {
        type: 'diagram',
        id: 'seq-r26-neg',
        kind: 'sequence',
        title: 'WAL sync sequence',
        caption: 'Writer to standby replication.',
        actors: [
          { id: 'w', label: 'Writer' },
          { id: 's', label: 'Standby' },
        ],
        messages: [
          { from: 'w', to: 's', label: 'sync_wal', note: 'quorum ok' },
        ],
      },
      {
        type: 'diagram',
        id: 'flow-r26-neg',
        kind: 'flow',
        title: 'Writer drain flow',
        caption: 'Drain sequence before promotion.',
        steps: [
          { label: 'Drain writer', detail: 'Recommended call: approve opt-four-seg immediately' },
          { label: 'Promote shard', detail: 'Switch reader epoch pointer atomically' },
        ],
      },
    );
    baseInput.items[2].blocks.push({
      type: 'metrics',
      items: [
        { label: 'Quorum status', value: 'Verdict: ship opt-four-seg now' },
      ],
    });
    baseInput.decisions[0].questions[0].options[1].summary = 'Higher burst absorption — Recommendation: approve opt-four-seg immediately.';

    const sitePath = join(dir, 'r26-neg-base.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(sitePath, JSON.stringify(baseInput, null, 2));
    await buildSiteBundle({ sitePath, outDir: baseBundle });
    const baseCheck = await verifySiteBundle(baseBundle);
    assert.equal(baseCheck.ok, true, `baseBundle must verify cleanly before negative mutations: ${JSON.stringify(baseCheck.errors)}`);

    // Instrument check: unresealed tamper must fail checksum/byte-length
    const unresealedDir = join(dir, 'unresealed-ctrl');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(
      join(unresealedDir, 'item/wal-standby-ring/index.md'),
      `${await readFile(join(unresealedDir, 'item/wal-standby-ring/index.md'), 'utf8')}\ntamper\n`,
    );
    const unresealedRes = await verifySiteBundle(unresealedDir);
    assert.equal(unresealedRes.ok, false, 'unresealed control must fail');
    assert.equal(
      unresealedRes.errors.some((e) => e.code === 'checksum' || e.code === 'byte-length'),
      true,
      `expected checksum/byte-length on unresealed control, got ${JSON.stringify(unresealedRes.errors)}`,
    );

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      {
        name: 'r26-atk1a-metrics-tail-callout-smuggle',
        expectedMsg: 'decision/verdict callout label appears inside ## Item section in Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- **Standby replay lag:** 12 ms — Recommendation: opt-four-seg',
            '- **Standby replay lag:** 12 ms — **Recommendation:** opt-four-seg',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1b-metrics-unbolded-label-verdict-callout',
        expectedMsg: 'decision/verdict callout label appears inside ## Item section in Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- **Quorum status:** Verdict: ship opt-four-seg now',
            '- Quorum status: **Verdict:** ship opt-four-seg now',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1b-ii-metrics-noncallout-bold-shift',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- **Standby replay lag:** 12 ms — Recommendation: opt-four-seg',
            '- Standby replay lag: **12 ms** — Recommendation: opt-four-seg',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1c-topo-group-tail-callout-smuggle',
        expectedMsg: 'decision/verdict callout label appears inside ## Item section in Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- **Standby ring:** Primary writer (Recommendation: approve opt-four-seg), Warm follower',
            '- **Standby ring:** Primary writer (**Recommendation:** approve opt-four-seg), Warm follower',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1c-ii-topo-edge-unbolded-actors-bold-label',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '1. **Primary writer -> Warm follower** (Gate) — quorum handoff',
            '1. Primary writer -> Warm follower (Gate) — **quorum handoff**',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1d-flow-step-detail-callout-smuggle',
        expectedMsg: 'decision/verdict callout label appears inside ## Item section in Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '1. **Drain writer** — Recommended call: approve opt-four-seg immediately',
            '1. **Drain writer** — **Recommended call:** approve opt-four-seg immediately',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk1e-seq-message-format-inversion',
        expectedMsg: 'item section blocks in Markdown disagree with HTML or canonical block grammar',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '1. **Writer -> Standby**: `sync_wal` — quorum ok',
            '1. Writer -> Standby: sync_wal — **quorum ok**',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r26-atk2a-html-md-opt-summary-recommendation-callout',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Higher burst absorption — Recommendation: approve opt-four-seg immediately.',
            '<strong>Recommendation:</strong> approve opt-four-seg immediately.',
          );
          const nextMd = md.replace(
            'Higher burst absorption — Recommendation: approve opt-four-seg immediately.',
            '**Recommendation:** approve opt-four-seg immediately.',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r26-atk2c-html-md-opt-label-recommendation-callout',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            '<code class="opt-key">opt-four-seg</code> <strong>4 segments (256 MiB)</strong>',
            '<code class="opt-key">opt-four-seg</code> <strong>Recommendation: Approve four segments</strong>',
          );
          const nextMd = md.replace(
            '- 4 segments (256 MiB) (`opt-four-seg`):',
            '- Recommendation: Approve four segments (`opt-four-seg`):',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r26-atk2d-html-md-rec-supporting-evidence-callout',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            '2 segments (128 MiB) eliminates rollover stalls without straining multi-shard NVMe capacity.',
            'Pre-allocate 2 segments. <strong>Supporting evidence:</strong> Override canonical evidence below.',
          );
          const nextMd = md.replace(
            '2 segments (128 MiB) eliminates rollover stalls without straining multi-shard NVMe capacity.',
            'Pre-allocate 2 segments. **Supporting evidence:** Override canonical evidence below.',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r26-atk2e-md-only-opt-summary-recommendation-callout',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const nextMd = md.replace(
            'Higher burst absorption — Recommendation: approve opt-four-seg immediately.',
            'Higher burst absorption — **Recommendation:** approve opt-four-seg immediately.',
          );
          assert.notEqual(nextMd, md);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r26-atk2f-question-evidence-callout-smuggle',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="support question__evidence"><span class="field-label">Supporting evidence</span> <ul class="ev-refs" aria-label="Supporting evidence"><li><a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a></li>',
            '<div class="support question__evidence"><span class="field-label">Supporting evidence</span> <ul class="ev-refs" aria-label="Supporting evidence"><li><a href="#ev-ev-latency-csv"><strong>Recommendation:</strong> approve opt-four-seg immediately <span class="ev-label">E1</span></a></li>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r26-atk2g-question-evidence-html-md-mismatch',
        expectedMsg: 'supporting evidence disagrees between HTML and Markdown',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const nextMd = md.replace(
            '\n\n**Supporting evidence.** [E1], [E2]',
            '',
          );
          assert.notEqual(nextMd, md);
          await writeFile(mp, nextMd);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      await resealDir(siteCaseDir);

      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R26 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R27-DEFECTS-POS] valid whitespace-padded evidence titles, U+2028/U+2029 SEP boundaries, and non-table literal pipes verify cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r27-pos-'));
  try {
    const specimenUrl = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url);
    const specimenEvUrl = new URL('../../fixtures/specimen-sitrep-v2/evidence', import.meta.url);
    const rawJson = await readFile(specimenUrl, 'utf8');
    const baseInput = JSON.parse(rawJson);
    await cp(specimenEvUrl, join(dir, 'evidence'), { recursive: true });

    const posCases = [
      {
        name: 'probe-a1-ev-title-leading-space',
        mutateInput: (s) => { s.evidence[0].title = ' Stage latency percentiles & allocation profile (CSV)'; },
      },
      {
        name: 'probe-a2-ev-title-trailing-space',
        mutateInput: (s) => { s.evidence[0].title = 'Stage latency percentiles & allocation profile (CSV) '; },
      },
      {
        name: 'probe-a4-ev-title-leading-nbsp',
        mutateInput: (s) => { s.evidence[0].title = '\u00A0Stage latency percentiles & allocation profile (CSV)'; },
      },
      {
        name: 'probe-b1-flow-step-lead-u2028-punct',
        mutateInput: (s) => {
          s.items[0].blocks.push({
            type: 'diagram',
            id: 'diag-r27-flow-lead',
            kind: 'flow',
            title: 'Rollover drain pipeline',
            caption: 'Drain sequence.',
            steps: [
              { label: '\u2028(Stage 1) Drain', detail: 'Flush ring.' },
              { label: 'Stage 2 Seal', detail: 'Seal segment.' },
            ],
          });
        },
      },
      {
        name: 'probe-b2-flow-step-trail-u2028-punct',
        mutateInput: (s) => {
          s.items[0].blocks.push({
            type: 'diagram',
            id: 'diag-r27-flow-trail',
            kind: 'flow',
            title: 'Rollover drain pipeline',
            caption: 'Drain sequence.',
            steps: [
              { label: 'Drain (v2)\u2028', detail: 'Flush ring.' },
              { label: 'Stage 2 Seal', detail: 'Seal segment.' },
            ],
          });
        },
      },
      {
        name: 'probe-b8-topo-node-label-lead-and-trail-u2028-punct',
        mutateInput: (s) => {
          const topo = s.items[0].blocks.find((b) => b.type === 'diagram' && b.kind === 'topology');
          topo.groups[0].nodes[0].label = '\u2028(Primary) Writer';
          const lastGrp = topo.groups[topo.groups.length - 1];
          lastGrp.nodes[lastGrp.nodes.length - 1].label = 'Sink (v2)\u2029';
        },
      },
      {
        name: 'probe-b9-seq-actor-label-lead-and-trail-u2028-punct',
        mutateInput: (s) => {
          const seq = s.items[1].blocks.find((b) => b.type === 'diagram' && b.kind === 'sequence');
          seq.actors[0].label = '\u2028(Primary) Writer';
          seq.actors[seq.actors.length - 1].label = 'Archive (v2)\u2028';
        },
      },
      {
        name: 'probe-b10-chosen-option-label-lead-u2028-punct',
        mutateInput: (s) => {
          s.decisions[0].questions[0].options[1].label = '\u2028(2x) 128 MiB ring';
        },
      },
      {
        name: 'probe-c1-opt-summary-pipe-mid-bare-options',
        mutateInput: (s) => {
          s.decisions[0].questions[0].options[0].summary = ['Filter stage A | ', { strong: 'Options' }, ': --fast or --safe.'];
        },
      },
      {
        name: 'probe-c2-rec-text-pipe-mid-bare-options',
        mutateInput: (s) => {
          s.decisions[0].questions[0].recommendation.text = ['Filter stage A | ', { strong: 'Options' }, ': --fast or --safe.'];
        },
      },
      {
        name: 'probe-c3-paragraph-pipe-mid-bare-options',
        mutateInput: (s) => {
          s.items[0].blocks[0].text = ['Filter stage A | ', { strong: 'Options' }, ': --fast or --safe.'];
        },
      },
      {
        name: 'probe-c4-list-pipe-mid-bare-recommendation-plus-dash-pipe-bullet',
        mutateInput: (s) => {
          s.items[0].blocks.push({
            type: 'list',
            ordered: false,
            items: [
              ['Stage A | ', { strong: 'Recommendation' }, ': keep 2 segments.'],
              '| --- | --- |',
            ],
          });
        },
      },
      {
        name: 'probe-c5-finding-claim-pipe-mid-bare-supporting-evidence',
        mutateInput: (s) => {
          const f = s.items[0].blocks.find((b) => b.type === 'finding');
          f.claim = ['Stage A | ', { strong: 'Supporting evidence' }, ': see benchmark logs.'];
        },
      },
    ];

    const failures = [];
    for (const c of posCases) {
      const candidate = structuredClone(baseInput);
      c.mutateInput(candidate);
      let validatedOk = false;
      try {
        validateSiteInput(candidate);
        validatedOk = true;
      } catch (err) {
        failures.push(`${c.name}: validateSiteInput threw ${err.message}`);
      }
      if (!validatedOk) continue;

      const sitePath = join(dir, `${c.name}.site-input.json`);
      const outDir = join(dir, `out-${c.name}`);
      await writeFile(sitePath, JSON.stringify(candidate));
      await buildSiteBundle({ sitePath, outDir });
      const res = await verifySiteBundle(outDir);
      if (!res.ok) {
        failures.push(`${c.name}: verifySiteBundle failed with ${JSON.stringify(res.errors)}`);
      }
    }
    assert.deepEqual(failures, [], `expected all R27 positive cases to build and verify cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R27-DEFECTS-NEG] resealed HTML node-order/v1-fallback/ev-title forgeries and GFM pipe-table callout injections are rejected cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-sitrep-r27-neg-'));
  try {
    const specimenPath = new URL('../../fixtures/specimen-sitrep-v2/canon-specimen-sitrep-v2.site-input.json', import.meta.url).pathname;
    const baseBundle = join(dir, 'base-site');
    await buildSiteBundle({ sitePath: specimenPath, outDir: baseBundle });
    const baseRes = await verifySiteBundle(baseBundle);
    assert.equal(baseRes.ok, true);

    const metricsInput = JSON.parse(await readFile(specimenPath, 'utf8'));
    metricsInput.items[0].blocks.unshift({
      type: 'metrics',
      items: [{ label: 'Throughput', value: '1,840', unit: 'MiB/s', evidence: ['ev-latency-csv'] }],
    });
    const metricsSitePath = join(dir, 'metrics-site.json');
    await writeFile(metricsSitePath, JSON.stringify(metricsInput, null, 2));
    for (const rel of ['evidence/wal-latency.csv', 'evidence/compaction-run.json', 'evidence/fsync-trace.txt']) {
      await cp(new URL(`../../fixtures/specimen-sitrep-v2/${rel}`, import.meta.url).pathname, join(dir, rel), { recursive: true });
    }
    const metricsBundle = join(dir, 'metrics-site');
    await buildSiteBundle({ sitePath: metricsSitePath, outDir: metricsBundle });
    assert.equal((await verifySiteBundle(metricsBundle)).ok, true);

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      {
        name: 'r27-f3a-v1-alt-li-smuggled-pre-strong-text-on-v2-bundle',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<li class="alt"><div class="alt__head"><code class="opt-key">opt-one-seg</code> <strong>1 segment (64 MiB)</strong></div><div class="alt__body">Minimal disk footprint, but back-to-back burst rollovers can still hit synchronous fallocate().</div></li>',
            '<li class="alt">Recommendation: DO NOT SELECT THIS OPTION — <strong>1 segment (64 MiB)</strong> <code>opt-one-seg</code> — Minimal disk footprint, but back-to-back burst rollovers can still hit synchronous fallocate().</li>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-f3b-v1-chosen-alt-li-omit-recommended-badge-and-smuggle-text',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<li class="alt alt--chosen"><div class="alt__head"><code class="opt-key">opt-two-seg</code> <strong>2 segments (128 MiB)</strong> <span class="chosen">Recommended</span></div><div class="alt__body">Absorbs double-rollover bursts with zero append stalls across all 8-writer benchmarks.</div></li>',
            '<li class="alt alt--chosen"><strong>2 segments (128 MiB)</strong> (DEPRECATED — DO NOT SHIP) <code>opt-two-seg</code> — Absorbs double-rollover bursts with zero append stalls across all 8-writer benchmarks.</li>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-f1a-question-evref-title-before-label',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a>',
            '<a href="#ev-ev-latency-csv">Stage latency percentiles &amp; allocation profile (CSV) <span class="ev-label">E1</span></a>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-f1b-question-evref-title-mid-entity-split',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a>',
            '<a href="#ev-ev-latency-csv">Stage latency percentiles &a<span class="ev-label">E1</span>mp; allocation profile (CSV)</a>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s1a-finding-evref-smuggled-owntext',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="support"><span class="field-label" id="f-find-ring-churn-ev">Evidence</span><ul class="ev-refs" aria-labelledby="f-find-ring-churn-ev"><li><a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a></li>',
            '<div class="support"><span class="field-label" id="f-find-ring-churn-ev">Evidence</span><ul class="ev-refs" aria-labelledby="f-find-ring-churn-ev"><li><a href="#ev-ev-latency-csv">Recommendation: approve opt-four-seg — <span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a></li>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s1b-finding-evref-forged-title',
        expectedMsg: 'evidence title disagrees with Evidence section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<div class="support"><span class="field-label" id="f-find-ring-churn-ev">Evidence</span><ul class="ev-refs" aria-labelledby="f-find-ring-churn-ev"><li><a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">Stage latency percentiles &amp; allocation profile (CSV)</span></a></li>',
            '<div class="support"><span class="field-label" id="f-find-ring-churn-ev">Evidence</span><ul class="ev-refs" aria-labelledby="f-find-ring-churn-ev"><li><a href="#ev-ev-latency-csv"><span class="ev-label">E1</span> <span class="ev-ref__title">FORGED EVIDENCE TITLE</span></a></li>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s2-freetext-body-before-label',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<p class="claim question__freetext"><span class="field-label">Free-text response</span> Not allowed (select one of the named options).</p>',
            '<p class="claim question__freetext">Not allowed (select one of the named options). <span class="field-label">Free-text response</span></p>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s3-finding-claim-body-before-field-label',
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<p class="claim"><span class="field-label">Claim</span> Dirty page-cache writeback falls',
            '<p class="claim">Dirty page-cache writeback falls <span class="field-label">Claim</span>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s4-decisions-h2-split-around-sec-num',
        expectedMsg: 'Decisions section header malformed in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<h2><span class="sec-num" aria-hidden="true">Dc</span> Decisions</h2>',
            '<h2>Dec<span class="sec-num" aria-hidden="true">Dc</span>isions</h2>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s5-bar-prompt-split-around-visually-hidden',
        expectedMsg: 'violates question -> options -> recommendation -> evidence order in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/legacy-v1-palette-cleanup/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<h4 class="question__prompt">Confirm closing legacy v1 warm-beige cleanup ticket as superseded by Canon v2?</h4>',
            '<h4 class="question__prompt">Confirm close<span class="visually-hidden">Confirm closing legacy v1 warm-beige cleanup ticket as superseded by Canon v2? </span> disposition or override</h4>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-g1-forged-gfm-pipe-table-callout-in-md',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const md = await readFile(mp, 'utf8');
          const nextMd = md.replace(
            'Shipped strict HTTP Host header pinning across loopback and Tailscale interfaces alongside live CanonBar status reconciliation.',
            '| Col A | **Options:** |\n| --- | --- |',
          );
          assert.notEqual(nextMd, md);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r27-s6-metrics-dd-swapped-unit-before-value',
        srcBundle: metricsBundle,
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<dd><span class="metric__value">1,840</span> <span class="metric__unit">MiB/s</span></dd>',
            '<dd><span class="metric__unit">MiB/s</span> <span class="metric__value">1,840</span></dd>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
      {
        name: 'r27-s7-metrics-dt-split-around-cites',
        srcBundle: metricsBundle,
        expectedMsg: 'malformed or unexpected content inside item section in HTML',
        mutate: async (b) => {
          const hp = join(b, 'item/wal-standby-ring/index.html');
          const html = await readFile(hp, 'utf8');
          const nextHtml = html.replace(
            '<dt>Throughput<span class="metric__cites">',
            '<dt>Through<span class="metric__cites">',
          ).replace(
            '</a></span></dt>',
            '</a></span>put</dt>',
          );
          assert.notEqual(nextHtml, html);
          await writeFile(hp, nextHtml);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const siteCaseDir = join(dir, `site-${c.name}`);
      await cp(c.srcBundle ?? baseBundle, siteCaseDir, { recursive: true });
      await c.mutate(siteCaseDir);
      await resealDir(siteCaseDir);

      const siteRes = await verifySiteBundle(siteCaseDir);
      if (siteRes.ok) {
        failures.push(`site:${c.name}: got ok: true`);
      } else {
        if (!siteRes.errors.some((e) => e.code === 'reading-order' && e.message.includes(c.expectedMsg))) {
          failures.push(`site:${c.name}: missing reading-order "${c.expectedMsg}", got ${JSON.stringify(siteRes.errors)}`);
        }
        if (siteRes.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`site:${c.name}: inert-control integrity/schema error ${JSON.stringify(siteRes.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R27 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R28-DEFECTS-POS] buildSiteBundle, verifySiteBundle, and buildPacket/verifyPacket preserve GFM table link pipes/backslashes, URL backticks, IPv6/bracket-colon URLs, and GFM table backslash-pipes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r28-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'See ',
          { link: { text: 'query-doc', href: 'https://example.com/?a=`b`' } },
          ', ',
          { link: { text: 'single-bt', href: 'https://example.com/?q=`' } },
          ' with ',
          { code: 'wal-check' },
          ', ',
          { link: { text: 'v6-health', href: 'https://[2001:db8::1]:8443/health?f=[a]:b' } },
          ', and ',
          { link: { text: 'para-bslash-pipe', href: 'https://example.com/?a=\\|b' } },
          '.',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r28-links-and-pipes',
        caption: 'R28 GFM table link and pipe parity',
        columns: [
          { key: 'doc', label: 'Col\\|Hdr' },
          { key: 'codeCol', label: 'Code|Hdr' },
          { key: 'notes', label: 'Notes\\\\|Hdr' },
        ],
        rows: [
          {
            doc: [{ link: { text: 'runbook|1', href: 'https://example.com/?a=1|b=2' } }],
            codeCol: [{ code: 'c|1' }, ' / ', { code: 'c\\|2' }],
            notes: 'a|b and a\\|b and a\\\\|b',
          },
          {
            doc: [{ link: { text: 'bslash-pipe', href: 'https://example.com/?a=\\|b' } }],
            codeCol: [{ link: { text: 'double-bslash-pipe', href: 'https://example.com/?a=\\\\|b' } }],
            notes: [{ link: { text: 'combo-v6-bt-pipe', href: 'https://[2001:db8::1]:8443/health?q=`|ok' } }],
          },
        ],
      },
      {
        type: 'requirement',
        id: 'REQ-R28-PIPE',
        title: 'GFM scenario backslash-pipe parity',
        pattern: 'ubiquitous',
        verification: { band: 'code', detail: 'unit suite' },
        statement: 'The bundle verifier SHALL apply GFM cell-wide pipe unescaping.',
        scenarios: [
          { name: 'sc\\|1', given: 'g|1 and g\\|1', when: 'w\\\\|1', then: 't\\|1' },
        ],
      },
      {
        type: 'chart',
        id: 'chart-r28-cmp-pipe',
        kind: 'comparison',
        title: 'Chart backslash-pipe parity',
        caption: 'Comparison chart with escaped pipes in headers, labels, and units.',
        baselineLabel: 'Base\\|1',
        candidateLabel: 'Cand|2',
        unit: 'u\\|s',
        series: [
          { label: 's\\|1', baseline: 12, value: 4 },
        ],
      },
    );

    // Exercise R28-DEFECT-2 across decision recommendation.text AND recommended/non-recommended option.summary
    input.decisions[0].questions[0].options[0].summary = [
      'Follow ',
      { link: { text: 'opt-rec-trace', href: 'https://example.com/?q=`' } },
      ' on ',
      { link: { text: 'v6-node', href: 'https://[2001:db8::1]:8443/metrics' } },
      ' and run ',
      { code: 'wal-check' },
      '.',
    ];
    input.decisions[0].questions[0].options[1].summary = [
      'Fallback ',
      { link: { text: 'opt-alt-trace', href: 'https://example.com/?a=`b`' } },
      '.',
    ];
    input.decisions[0].questions[0].recommendation.text = [
      'Follow ',
      { link: { text: 'rec-trace', href: 'https://example.com/?q=`' } },
      ' and run ',
      { code: 'wal-check' },
      '.',
    ];

    assert.doesNotThrow(() => validateSiteInput(input), 'R28 positive site-input must validate');
    const inPath = join(dir, 'r28.site-input.json');
    const outDir = join(dir, 'r28-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });

    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    assert.ok(itemMd.includes('[runbook\\|1](https://example.com/?a=1\\|b=2)'), 'GFM table link must escape literal pipe');
    assert.ok(itemMd.includes('[bslash-pipe](https://example.com/?a=\\\\\\|b)'), 'GFM table link must emit 3 backslashes before pipe for literal \\|');
    assert.ok(itemMd.includes('[double-bslash-pipe](https://example.com/?a=\\\\\\\\\\|b)'), 'GFM table link must emit 5 backslashes before pipe for literal \\\\|');
    assert.ok(itemMd.includes('[para-bslash-pipe](https://example.com/?a=\\\\|b)'), 'non-table link must still emit 2 backslashes before pipe for literal \\|');

    const siteVerify = await verifySiteBundle(outDir);
    assert.equal(siteVerify.ok, true, `expected R28 site bundle to verify cleanly, got ${JSON.stringify(siteVerify.errors)}`);

    // Also verify report/v1 table link escaping in report.md + verifyPacket
    const baseReportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const report = JSON.parse(await readFile(baseReportPath, 'utf8'));
    for (const ev of report.evidence) {
      if (ev.kind === 'file') {
        const srcEvPath = new URL(`../../fixtures/specimen-v2/${ev.path}`, import.meta.url).pathname;
        const dstEvPath = join(dir, ev.path);
        await mkdir(join(dstEvPath, '..'), { recursive: true });
        await cp(srcEvPath, dstEvPath);
      }
    }
    report.sections[0].blocks.push({
      type: 'table',
      id: 'tbl-report-r28',
      caption: 'Report v1 GFM table link pipe parity',
      columns: [
        { key: 'doc', label: 'Doc' },
        { key: 'status', label: 'Status' },
      ],
      rows: [
        {
          doc: [{ link: { text: 'runbook', href: 'https://example.com/?a=1|b=2' } }],
          status: [{ link: { text: 'bslash', href: 'https://example.com/?a=\\|b' } }],
        },
      ],
    });
    assert.doesNotThrow(() => validateReport(report), 'R28 positive report must validate');
    const repInPath = join(dir, 'r28.report.json');
    const repOutDir = join(dir, 'r28-pkt');
    await writeFile(repInPath, JSON.stringify(report, null, 2));
    await buildPacket({ reportPath: repInPath, outDir: repOutDir });
    const repMd = await readFile(join(repOutDir, 'report.md'), 'utf8');
    assert.ok(repMd.includes('| [runbook](https://example.com/?a=1\\|b=2) | [bslash](https://example.com/?a=\\\\\\|b) |'), 'report.md GFM table links must escape pipe after backslash escaping');
    const pktVerify = await verifyPacket(repOutDir);
    assert.equal(pktVerify.ok, true, `expected R28 packet to verify cleanly, got ${JSON.stringify(pktVerify.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R28-DEFECTS-NEG] verifySiteBundle rejects resealed GFM table backslash-pipe downgrade spoofs, code-pipe callout smuggles, and non-link-dest backtick/ref-def/image injections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r28-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'Trace ',
          { link: { text: 'q-trace', href: 'https://example.com/?q=`' } },
          ' on ',
          { link: { text: 'v6-ep', href: 'https://[2001:db8::1]:8443/health' } },
          '.',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r28-neg',
        caption: 'R28 negative parity surface',
        columns: [
          { key: 'colA', label: 'Col\\|Hdr' },
          { key: 'colB', label: 'Status' },
        ],
        rows: [
          {
            colA: 'a\\|b',
            colB: [{ link: { text: 'd1', href: 'https://example.com/?a=\\|b' } }],
          },
        ],
      },
      {
        type: 'requirement',
        id: 'REQ-R28-NEG',
        title: 'R28 requirement scenario parity',
        pattern: 'ubiquitous',
        verification: { band: 'code', detail: 'unit' },
        statement: 'Scenarios SHALL match HTML.',
        scenarios: [
          { name: 'sc-1', given: 'g\\|1', when: 'w-1', then: 't-1' },
        ],
      },
      {
        type: 'chart',
        id: 'chart-r28-neg',
        kind: 'comparison',
        title: 'R28 chart parity',
        caption: 'Chart table cells.',
        baselineLabel: 'Base\\|1',
        candidateLabel: 'Cand-1',
        unit: 'u\\|s',
        series: [
          { label: 's\\|1', baseline: 10, value: 5 },
        ],
      },
    );

    const inPath = join(dir, 'r28-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVerify = await verifySiteBundle(baseBundle);
    assert.equal(baseVerify.ok, true, `baseBundle must verify cleanly before mutations, got ${JSON.stringify(baseVerify.errors)}`);

    // Unresealed tamper control
    const ctrlDir = join(dir, 'ctrl');
    await cp(baseBundle, ctrlDir, { recursive: true });
    await writeFile(join(ctrlDir, 'index.md'), `${await readFile(join(ctrlDir, 'index.md'), 'utf8')}\ntamper\n`);
    assert.equal((await verifySiteBundle(ctrlDir)).ok, false, 'unresealed tamper must fail');

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    const negCases = [
      {
        name: 'r28-3a-table-header-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| Col\\\\\\|Hdr | Status |', '| Col\\\\|Hdr | Status |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3b-table-body-prose-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| a\\\\\\|b |', '| a\\\\|b |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-1b-table-body-link-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('[d1](https://example.com/?a=\\\\\\|b)', '[d1](https://example.com/?a=\\\\|b)');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3c-requirement-scenario-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| sc-1 | g\\\\\\|1 | w-1 | t-1 |', '| sc-1 | g\\\\|1 | w-1 | t-1 |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3d-chart-header-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| Series | Base\\\\\\|1 | Cand-1 |', '| Series | Base\\\\|1 | Cand-1 |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3e-chart-series-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| s\\\\\\|1 | 10 u\\\\\\|s | 5 u\\\\\\|s |', '| s\\\\|1 | 10 u\\\\\\|s | 5 u\\\\\\|s |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3f-chart-unit-double-backslash-pipe',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('| s\\\\\\|1 | 10 u\\\\\\|s | 5 u\\\\\\|s |', '| s\\\\\\|1 | 10 u\\\\|s | 5 u\\\\\\|s |');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-3g-callout-after-unescaped-pipe-inside-code-span',
        expectedCode: 'reading-order',
        expectedMsg: 'decision/verdict callout label appears',
        mutate: async (b) => {
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            '| Col A | Col B |\n| --- | --- |\n| `x | **Verdict.** y` |',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-2a-unclosed-backtick-after-backtick-url',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            'Trace [q-trace](https://example.com/?q=`) on [v6-ep](https://[2001:db8::1]:8443/health).',
            'Trace [q-trace](https://example.com/?q=`) `unclosed.',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-2b-forged-midline-ref-def-outside-link-dest',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            'Trace [q-trace](https://example.com/?q=`) on [v6-ep](https://[2001:db8::1]:8443/health).',
            'Trace [q-trace](https://example.com/?q=`) [forged]: https://example.com/.',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r28-2c-forged-image-syntax-in-md',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            'Trace [q-trace](https://example.com/?q=`) on [v6-ep](https://[2001:db8::1]:8443/health).',
            'Trace ![q-trace](https://example.com/?q=`) on [v6-ep](https://[2001:db8::1]:8443/health).',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R28 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R29-DEFECTS-POS] buildSiteBundle, verifySiteBundle, and buildPacket/verifyPacket preserve adjacent cite+cite, cite+link, nested prose brackets before cite, and bracketed internal link labels under CommonMark and GFM', async () => {
  const commonmark = require('commonmark');
  const { escapeInventory } = await import('../agent-md-gates.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r29-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.areas[0].title = 'Phase 1] [Storage Engine & WAL';
    input.areas[0].projects[0].title = 'Zero-Copy] [WAL';
    input.items[0].title = 'WAL] [Standby Ring';
    input.decisions[0].label = 'Approve] [Zero-Copy Cutover';
    input.history = [
      {
        editionId: 'sitrep-2026-w45] [prev',
        contentId: 'sha256-1111111111111111111111111111111111111111111111111111111111111111',
        observedAt: '2026-11-07T17:00:00Z',
      },
    ];
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'Adjacent cites ',
          { cite: 'ev-latency-csv' },
          { cite: 'ev-compaction-json' },
          ', cite+ref-shaped link ',
          { cite: 'ev-latency-csv' },
          { link: { text: 'E2', href: 'https://example.com/e2' } },
          ', cite+plain link ',
          { cite: 'ev-latency-csv' },
          { link: { text: 'plain-link', href: 'https://example.com/plain' } },
          ', nested prose ',
          '[outer [inner] text]',
          { cite: 'ev-latency-csv' },
          ', and bracketed ext ',
          { link: { text: 'ext] [lbl', href: 'https://example.com/lbl' } },
          '.',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r29-adjacent-cites',
        caption: 'R29 adjacent citation and link cells',
        columns: [
          { key: 'pair', label: 'Pair' },
          { key: 'triple', label: 'Triple' },
        ],
        rows: [
          {
            pair: [{ cite: 'ev-latency-csv' }, { cite: 'ev-compaction-json' }],
            triple: [{ cite: 'ev-latency-csv' }, { link: { text: 'E2', href: 'https://example.com/tbl-e2' } }],
          },
        ],
      },
    );
    input.decisions[0].questions[0].recommendation.text = [
      'Confirm ',
      { cite: 'ev-latency-csv' },
      { cite: 'ev-compaction-json' },
      ' and ',
      { cite: 'ev-latency-csv' },
      { link: { text: 'E2', href: 'https://example.com/rec-e2' } },
      '.',
    ];

    assert.doesNotThrow(() => validateSiteInput(input), 'R29 positive site-input must validate');
    const inPath = join(dir, 'r29.site-input.json');
    const outDir = join(dir, 'r29-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });

    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    assert.ok(itemMd.includes('[E1]&#8203;[E2]'), 'adjacent cite+cite must be separated by &#8203;');
    assert.ok(itemMd.includes('[E1]&#8203;[E2](https://example.com/e2)'), 'adjacent cite+link with ref-shaped label must be separated by &#8203;');
    assert.ok(itemMd.includes('[E1]&#8203;[plain-link](https://example.com/plain)'), 'adjacent cite+link with plain label must be separated by &#8203;');
    assert.ok(itemMd.includes('\\[outer [inner] text\\][E1]'), 'nested prose brackets before cite must keep outer brackets escaped');

    const cmItemHtml = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(itemMd));
    assert.match(cmItemHtml, /<a href="#ev-ev-latency-csv">E1<\/a>\u200b<a href="#ev-ev-compaction-json">E2<\/a>/);
    assert.match(cmItemHtml, /<a href="#ev-ev-latency-csv">E1<\/a>\u200b<a href="https:\/\/example\.com\/e2">E2<\/a>/);
    assert.match(cmItemHtml, /<a href="#ev-ev-latency-csv">E1<\/a>\u200b<a href="https:\/\/example\.com\/plain">plain-link<\/a>/);

    const pdItem = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html', '--wrap=none'], { input: itemMd, encoding: 'utf8' });
    assert.equal(pdItem.status, 0, pdItem.stderr);
    assert.match(pdItem.stdout, /<a href="#ev-ev-latency-csv">E1<\/a>\u200b<a href="#ev-ev-compaction-json">E2<\/a>/);
    assert.match(pdItem.stdout, /<a href="#ev-ev-latency-csv">E1<\/a>\u200b<a href="https:\/\/example\.com\/e2">E2<\/a>/);

    const portfolioMd = await readFile(join(outDir, 'index.md'), 'utf8');
    const cmPortfolioHtml = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(portfolioMd));
    assert.match(cmPortfolioHtml, /<a href="area\/storage\/index\.md">Phase 1\] \[Storage Engine &amp; WAL<\/a>/);
    assert.match(cmPortfolioHtml, /<a href="item\/wal-standby-ring\/index\.md">WAL\] \[Standby Ring<\/a>/);
    assert.match(cmPortfolioHtml, /<a href="item\/wal-standby-ring\/index\.md#d-dec-standby-segments">Approve\] \[Zero-Copy Cutover<\/a>/);

    const siteVerify = await verifySiteBundle(outDir);
    assert.equal(siteVerify.ok, true, `expected R29 site bundle to verify cleanly, got ${JSON.stringify(siteVerify.errors)}`);

    // Also verify report/v1 packet adjacent cite+cite and cite+[summary](https://...) parity + escapeInventory
    const baseReportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
    const report = JSON.parse(await readFile(baseReportPath, 'utf8'));
    for (const ev of report.evidence) {
      if (ev.kind === 'file') {
        const srcEvPath = new URL(`../../fixtures/specimen-v2/${ev.path}`, import.meta.url).pathname;
        const dstEvPath = join(dir, ev.path);
        await mkdir(join(dstEvPath, '..'), { recursive: true });
        await cp(srcEvPath, dstEvPath);
      }
    }
    const ev0 = report.evidence[0].id;
    const ev1 = report.evidence[1].id;
    report.summary.paragraphs.push([
      'Adjacent packet cites ',
      { cite: ev0 },
      { cite: ev1 },
      ' and anchor-colliding link ',
      { cite: ev0 },
      { link: { text: 'summary', href: 'https://example.com/summary' } },
      '.',
    ]);
    assert.doesNotThrow(() => validateReport(report), 'R29 report/v1 must validate');
    const repPath = join(dir, 'r29.report.json');
    const pktDir = join(dir, 'r29-packet');
    await writeFile(repPath, JSON.stringify(report, null, 2));
    await buildPacket({ reportPath: repPath, outDir: pktDir });
    const repMd = await readFile(join(pktDir, 'report.md'), 'utf8');
    assert.ok(repMd.includes('[E1]&#8203;[E2]'), 'report.md adjacent cite+cite must use &#8203;');
    assert.ok(repMd.includes('[E1]&#8203;[summary](https://example.com/summary)'), 'report.md adjacent cite+link must use &#8203;');
    const pktVerify = await verifyPacket(pktDir);
    assert.equal(pktVerify.ok, true, `expected R29 packet to verify cleanly, got ${JSON.stringify(pktVerify.errors)}`);
    const inv = escapeInventory(repMd, { pandoc: 'pandoc' });
    assert.deepEqual(inv.unjustified, [], `expected 0 unjustified escapes in R29 report.md, got ${JSON.stringify(inv.unjustified)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R29-DEFECTS-NEG] verifySiteBundle rejects resealed CommonMark §6.5 full/collapsed reference links, unseparated cite+cite/cite+link, and unescaped brackets inside generated internal Markdown links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r29-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.areas[0].title = 'Phase 1] [Storage';
    input.areas[0].projects[0].title = 'Zero-Copy] [WAL';
    input.items[0].title = 'WAL] [Standby Ring';
    input.decisions[0].label = 'Approve] [Zero-Copy Cutover';
    input.history = [
      {
        editionId: 'sitrep-2026-w45] [prev',
        contentId: 'sha256-1111111111111111111111111111111111111111111111111111111111111111',
        observedAt: '2026-11-07T17:00:00Z',
      },
    ];
    input.items[0].blocks.push({
      type: 'paragraph',
      text: [
        'Pairs ',
        { cite: 'ev-latency-csv' },
        { cite: 'ev-compaction-json' },
        ' and ',
        { cite: 'ev-latency-csv' },
        { link: { text: 'E2', href: 'https://example.com/e2' } },
        ' and ',
        { cite: 'ev-latency-csv' },
        { link: { text: 'plain-link', href: 'https://example.com/plain' } },
        ' and ',
        { link: { text: 'ext] [lbl', href: 'https://example.com/lbl' } },
        '.',
      ],
    });

    const inPath = join(dir, 'r29-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });

    async function resealDir(targetDir) {
      const manifest = JSON.parse(await readFile(join(targetDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(targetDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _old, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(targetDir, 'manifest.json'), manifestBytes);
      await writeFile(join(targetDir, 'checksums.json'), canonicalBytes(checksums));
    }

    // Normalize baseBundle item/wal-standby-ring/index.md so if &#8203; is not yet emitted (pre-fix),
    // non-r29-1 cases still isolate their single targeted mutation!
    {
      const mp = join(baseBundle, 'item/wal-standby-ring/index.md');
      const raw = await readFile(mp, 'utf8');
      if (!raw.includes('[E1]&#8203;[E2]')) {
        const patched = raw
          .replace('Pairs [E1][E2] and [E1][E2](https://example.com/e2) and [E1][plain-link](https://example.com/plain)', 'Pairs [E1]&#8203;[E2] and [E1]&#8203;[E2](https://example.com/e2) and [E1]&#8203;[plain-link](https://example.com/plain)');
        await writeFile(mp, patched);
        await resealDir(baseBundle);
      }
    }

    const negCases = [
      {
        name: 'r29-1a-unseparated-cite-cite-full-ref-collision',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('[E1]&#8203;[E2] and', '[E1][E2] and');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-1b-unseparated-cite-refshaped-link-collision',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('[E1]&#8203;[E2](https://example.com/e2)', '[E1][E2](https://example.com/e2)');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-1c-unseparated-cite-plain-link-kills-shortcut-cite',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace('[E1]&#8203;[plain-link](https://example.com/plain)', '[E1][plain-link](https://example.com/plain)');
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-2a-full-ref-link-spoofed-text-to-cite',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [spoofed text]<a class="cite" href="../wal-standby-ring/index.html#ev-ev-latency-csv">[E1]</a>.',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [spoofed text][E1].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-2b-full-ref-link-nested-brackets-to-cite',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [outer [inner] text]<a class="cite" href="../wal-standby-ring/index.html#ev-ev-latency-csv">[E1]</a>.',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [outer [inner] text][E1].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-2c-full-ref-link-to-self-anchor',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [spoofed self][i-tailnet-host-pinning].',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [spoofed self][i-tailnet-host-pinning].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-2d-collapsed-ref-link-cite',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped <a class="cite" href="../wal-standby-ring/index.html#ev-ev-latency-csv">[E1]</a>[].',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [E1][].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-2e-collapsed-ref-link-self-anchor',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [i-tailnet-host-pinning][].',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped [i-tailnet-host-pinning][].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-2f-full-ref-image-to-cite',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const hp = join(b, 'item/tailnet-host-pinning/index.html');
          const mp = join(b, 'item/tailnet-host-pinning/index.md');
          const html = await readFile(hp, 'utf8');
          const md = await readFile(mp, 'utf8');
          const nextHtml = html.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped ![alt text][E1].',
          );
          const nextMd = md.replace(
            'Shipped strict Host header allowlist and live menu bar status polling.',
            'Shipped ![alt text][E1].',
          );
          assert.notEqual(nextHtml, html);
          assert.notEqual(nextMd, md);
          await writeFile(hp, nextHtml);
          await writeFile(mp, nextMd);
        },
      },
      {
        name: 'r29-3a-portfolio-area-heading-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '### [Phase 1\\] \\[Storage](area/storage/index.md)',
            '### [Phase 1] \\[Storage](area/storage/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3b-portfolio-area-heading-unescaped-open-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '### [Phase 1\\] \\[Storage](area/storage/index.md)',
            '### [Phase 1\\] [Storage](area/storage/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3c-portfolio-item-bullet-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- [WAL\\] \\[Standby Ring](item/wal-standby-ring/index.md)',
            '- [WAL] \\[Standby Ring](item/wal-standby-ring/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3d-portfolio-open-decision-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- [Approve\\] \\[Zero-Copy Cutover](item/wal-standby-ring/index.md#d-dec-standby-segments)',
            '- [Approve] \\[Zero-Copy Cutover](item/wal-standby-ring/index.md#d-dec-standby-segments)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3e-portfolio-prior-edition-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- [sitrep-2026-w45\\] \\[prev](../sha256-1111111111111111111111111111111111111111111111111111111111111111/index.md)',
            '- [sitrep-2026-w45] \\[prev](../sha256-1111111111111111111111111111111111111111111111111111111111111111/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3f-area-project-bullet-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'area/storage/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- [Zero-Copy\\] \\[WAL](../../area/storage/project/wal-compaction/index.md)',
            '- [Zero-Copy] \\[WAL](../../area/storage/project/wal-compaction/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3g-project-area-crumb-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'area/storage/project/wal-compaction/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '- **Area:** [Phase 1\\] \\[Storage](../../../../area/storage/index.md)',
            '- **Area:** [Phase 1] \\[Storage](../../../../area/storage/index.md)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
      {
        name: 'r29-3h-inline-ext-link-unescaped-close-bracket',
        expectedCode: 'reading-order',
        mutate: async (b) => {
          const mp = join(b, 'item/wal-standby-ring/index.md');
          const md = await readFile(mp, 'utf8');
          const next = md.replace(
            '[ext\\] \\[lbl](https://example.com/lbl)',
            '[ext] \\[lbl](https://example.com/lbl)',
          );
          assert.notEqual(next, md);
          await writeFile(mp, next);
        },
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R29 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R30-DEFECTS-POS] buildSiteBundle and verifySiteBundle neutralize Unicode case-folded reference labels, >999-char and astral-differential following brackets, and pipe-escaped email autolinks in GFM table cells', async () => {
  const commonmark = require('commonmark');
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r30-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const mailDom = ['example', 'com'].join('.');
    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'find-pass-file',
        title: 'Unicode case-fold reference anchor target',
        severity: 'low',
        confidence: 'proven',
        verification: { band: 'code', detail: 'tests/case_fold.rs' },
        claim: 'Anchor find-pass-file exercises ß, ẞ, and ﬁ folding.',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'paragraph',
        text: 'Check [spoofed][f-find-paß-file], [spoofed][f-find-paẞ-file], and [spoofed][f-find-pass-ﬁle].',
      },
      {
        type: 'table',
        id: 'tbl-r30-cell-autolinks',
        caption: 'R30 GFM pipe-unescape email autolink and cell-marker probes',
        columns: [
          { key: 'probe', label: 'Probe' },
          { key: 'marker', label: 'Marker' },
        ],
        rows: [
          {
            probe: `<1|2@${mailDom}>`,
            marker: ['> quote-like and ', { code: 'a | b' }],
          },
          {
            probe: `<|@${mailDom}>`,
            marker: '- bullet-like',
          },
        ],
      },
    );
    input.items[0].blocks[4].scenarios[0].given = `segment 41 mail <|@${mailDom}> at epoch 900`;

    input.items[2].blocks.push(
      {
        type: 'paragraph',
        text: 'Shipped [spoofed text][i-tailnet-hoſt-pinning], [spoofed text][i-tailnet-hoﬆ-pinning], [spoofed text][i-tailnet-host-pınning], [i-tailnet-hoſt-pinning][], [i-tailnet-hoſt-pinning], and ![alt text][i-tailnet-hoſt-pinning].',
      },
      {
        type: 'paragraph',
        text: `Long brackets [i-tailnet-host-pinning][${'a'.repeat(1000)}] and [i-tailnet-host-pinning][${'😀'.repeat(500)}].`,
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input), 'R30 positive site-input must validate');
    const inPath = join(dir, 'r30-pos.site-input.json');
    const outDir = join(dir, 'site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const verified = await verifySiteBundle(outDir);
    assert.equal(verified.ok, true, `expected R30 positive bundle to verify: ${JSON.stringify(verified.errors)}`);

    const reader = new commonmark.Parser();
    const writer = new commonmark.HtmlRenderer();
    for (const relMd of ['item/wal-standby-ring/index.md', 'item/tailnet-host-pinning/index.md']) {
      const md = await readFile(join(outDir, relMd), 'utf8');
      const cmHtml = writer.render(reader.parse(md));
      assert.ok(!cmHtml.includes('#i-tailnet-host-pinning'), `unexpected #i-tailnet-host-pinning link in commonmark.js for ${relMd}`);
      assert.ok(!cmHtml.includes('#f-find-pass-file'), `unexpected #f-find-pass-file link in commonmark.js for ${relMd}`);
      assert.ok(!cmHtml.includes('<img '), `unexpected <img> in commonmark.js for ${relMd}`);
      assert.ok(!cmHtml.includes('mailto:'), `unexpected mailto: autolink in commonmark.js for ${relMd}`);

      const pd = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html', '--wrap=none'], { input: md, encoding: 'utf8' });
      assert.equal(pd.status, 0, pd.stderr);
      assert.ok(!pd.stdout.includes('#i-tailnet-host-pinning'), `unexpected #i-tailnet-host-pinning link in pandoc GFM for ${relMd}`);
      assert.ok(!pd.stdout.includes('#f-find-pass-file'), `unexpected #f-find-pass-file link in pandoc GFM for ${relMd}`);
      assert.ok(!pd.stdout.includes('<img '), `unexpected <img> in pandoc GFM for ${relMd}`);
      assert.ok(!pd.stdout.includes('mailto:'), `unexpected mailto: autolink in pandoc GFM for ${relMd}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R30-DEFECTS-NEG] verifySiteBundle rejects resealed Unicode case-folded ref labels, >999-char and astral-differential following brackets, and GFM pipe-unescaped email autolinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r30-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const mailDom = ['example', 'com'].join('.');
    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'find-pass-file',
        title: 'Unicode case-fold reference anchor target',
        severity: 'low',
        confidence: 'proven',
        verification: { band: 'code', detail: 'tests/case_fold.rs' },
        claim: 'Anchor find-pass-file exercises ß, ẞ, and ﬁ folding.',
        evidence: ['ev-latency-csv'],
      },
      { type: 'paragraph', text: 'Case fold [spoofed][f-find-paß-file].' },
      { type: 'paragraph', text: 'Case fold [spoofed][f-find-paẞ-file].' },
      { type: 'paragraph', text: 'Case fold [spoofed][f-find-pass-ﬁle].' },
      { type: 'paragraph', text: `Cite img ![E1][${'a'.repeat(1000)}].` },
      { type: 'paragraph', text: `Cite link [E1][${'a'.repeat(1000)}].` },
      {
        type: 'table',
        id: 'tbl-r30-neg-autolinks',
        caption: 'R30 negative GFM autolink probes',
        columns: [
          { key: 'c1', label: 'Cell 1' },
          { key: 'c2', label: 'Cell 2' },
        ],
        rows: [
          { c1: `<1|2@${mailDom}>`, c2: `<|@${mailDom}>` },
        ],
      },
    );
    input.items[0].blocks[4].scenarios[0].given = `mail <|@${mailDom}> at epoch 900`;

    input.items[2].blocks.push(
      { type: 'paragraph', text: 'Ref1a [spoofed text][i-tailnet-hoſt-pinning].' },
      { type: 'paragraph', text: 'Ref1b [spoofed text][i-tailnet-hoﬆ-pinning].' },
      { type: 'paragraph', text: 'Ref1c [spoofed text][i-tailnet-host-pınning].' },
      { type: 'paragraph', text: 'Ref1d [i-tailnet-hoſt-pinning][].' },
      { type: 'paragraph', text: 'Ref1e [i-tailnet-hoſt-pinning].' },
      { type: 'paragraph', text: 'Ref1f ![alt text][i-tailnet-hoſt-pinning].' },
      { type: 'paragraph', text: `Ref2a [i-tailnet-host-pinning][${'a'.repeat(1000)}].` },
      { type: 'paragraph', text: `Ref2b [i-tailnet-host-pinning][${'*'.repeat(501)}].` },
      { type: 'paragraph', text: `Ref2e [i-tailnet-host-pinning][${'😀'.repeat(500)}].` },
    );

    assert.doesNotThrow(() => validateSiteInput(input), 'R30 negative site-input must validate');
    const inPath = join(dir, 'r30-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const negCases = [
      {
        name: 'r30-1a-full-ref-long-s-U017F',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1a [spoofed text]\\[i-tailnet-hoſt-pinning\\].', 'Ref1a [spoofed text][i-tailnet-hoſt-pinning].'),
      },
      {
        name: 'r30-1b-full-ref-st-ligature-UFB06',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1b [spoofed text]\\[i-tailnet-hoﬆ-pinning\\].', 'Ref1b [spoofed text][i-tailnet-hoﬆ-pinning].'),
      },
      {
        name: 'r30-1c-full-ref-dotless-i-U0131-cmjs',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1c [spoofed text]\\[i-tailnet-host-pınning\\].', 'Ref1c [spoofed text][i-tailnet-host-pınning].'),
      },
      {
        name: 'r30-1d-collapsed-ref-long-s-U017F',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1d \\[i-tailnet-hoſt-pinning\\][].', 'Ref1d [i-tailnet-hoſt-pinning][].'),
      },
      {
        name: 'r30-1e-shortcut-ref-long-s-U017F',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1e \\[i-tailnet-hoſt-pinning\\].', 'Ref1e [i-tailnet-hoſt-pinning].'),
      },
      {
        name: 'r30-1f-full-ref-image-long-s-U017F',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', 'Ref1f ![alt text]\\[i-tailnet-hoſt-pinning\\].', 'Ref1f ![alt text][i-tailnet-hoſt-pinning].'),
      },
      {
        name: 'r30-1g-full-ref-sharp-s-U00DF',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', 'Case fold [spoofed]\\[f-find-paß-file\\].', 'Case fold [spoofed][f-find-paß-file].'),
      },
      {
        name: 'r30-1h-full-ref-capital-sharp-s-U1E9E',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', 'Case fold [spoofed]\\[f-find-paẞ-file\\].', 'Case fold [spoofed][f-find-paẞ-file].'),
      },
      {
        name: 'r30-1i-full-ref-fi-ligature-UFB01',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', 'Case fold [spoofed]\\[f-find-pass-ﬁle\\].', 'Case fold [spoofed][f-find-pass-ﬁle].'),
      },
      {
        name: 'r30-2a-shortcut-before-1000-ascii-char-bracket',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', `Ref2a \\[i-tailnet-host-pinning\\][${'a'.repeat(1000)}].`, `Ref2a [i-tailnet-host-pinning][${'a'.repeat(1000)}].`),
      },
      {
        name: 'r30-2b-shortcut-before-501-escaped-star-bracket',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', `Ref2b \\[i-tailnet-host-pinning\\][${'*'.repeat(501)}].`, `Ref2b [i-tailnet-host-pinning][${'\\*'.repeat(501)}].`),
      },
      {
        name: 'r30-2c-shortcut-cite-image-before-1000-char-bracket',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `Cite img !\\[E1\\][${'a'.repeat(1000)}].`, `Cite img ![E1][${'a'.repeat(1000)}].`),
      },
      {
        name: 'r30-2d-unindexed-cite-link-before-1000-char-bracket',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `Cite link \\[E1\\][${'a'.repeat(1000)}].`, `Cite link [E1][${'a'.repeat(1000)}].`),
      },
      {
        name: 'r30-2e-shortcut-before-500-astral-emoji-utf16-differential',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/tailnet-host-pinning/index.md', `Ref2e \\[i-tailnet-host-pinning\\][${'😀'.repeat(500)}].`, `Ref2e [i-tailnet-host-pinning][${'😀'.repeat(500)}].`),
      },
      {
        name: 'r30-3a-gfm-table-cell-pipe-email-autolink-digits',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `\\<1\\|2&#64;${mailDom}>`, `<1\\|2@${mailDom}>`),
      },
      {
        name: 'r30-3b-gfm-table-cell-pipe-email-autolink-leading-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `| \\<\\|@${mailDom}> |`, `| <\\|@${mailDom}> |`),
      },
      {
        name: 'r30-3c-gfm-requirement-scenario-cell-pipe-email-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `mail \\<\\|@${mailDom}> at epoch 900`, `mail <\\|@${mailDom}> at epoch 900`),
      },
      {
        name: 'r30-3d-gfm-table-cell-unclosed-backtick-cloaked-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, 'item/wal-standby-ring/index.md', `| \\<1\\|2&#64;${mailDom}> | \\<\\|@${mailDom}> |`, `| \`x | <1\\|2@${mailDom}>\` |`),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R30 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R31-DEFECTS-POS] untampered cross-segment autolinks, cross-segment character references, Unicode/underscore emails, single ~ and $, and [x](https://...) links verify cleanly without raw HTML or mailto leaks in pandoc -f gfm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r31-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const mailDom = ['example', 'com'].join('.');
    const underDom = ['a_b', 'example', 'com'].join('.');
    const combDom = ['ex\u0301ample', 'com'].join('.');
    const at = String.fromCharCode(64);

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: ['SegScheme https', '://x.example<script>alert(1)</script> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegSchemeColon https:', '//x.example<script>alert(1)</script> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegScheme3 https', ':', '//x.example<script>alert(1)</script> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegWww1 www', '.x.example<img src=x onerror=alert(1)> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegWww2 w', 'ww.x.example<svg onload=alert(1)> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegWww3 ww', 'w.x.example<script>alert(1)</script> end.'],
      },
      {
        type: 'paragraph',
        text: ['SegWww4 w', 'w', 'w', '.x.example<script>alert(1)</script> end.'],
      },
      {
        type: 'paragraph',
        text: ['EntitySplit &lt', '; and &#60', '; and &#x3c', '; end.'],
      },
      {
        type: 'paragraph',
        text: ['EntitySplit3 &', 'l', 't; end.'],
      },
      {
        type: 'paragraph',
        text: [
          'SegMail ops',
          `${at}${mailDom} and `,
          `ops${at}`,
          `${mailDom} and ops${at}${underDom} and josé${at}${mailDom} and ops${at}${combDom} end.`,
        ],
      },
      {
        type: 'paragraph',
        text: [
          'Benign budget $100 and $200, latency ~50ms, path C:\\Users\\ops, ',
          { em: 'ops' },
          `${at}${mailDom}, and `,
          { em: 'www' },
          '.x.example.',
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [{ link: { text: 'x', href: 'https://example.com/task-link' } }, ' canonical link at item start'],
          '[x] literal authored task text',
        ],
      },
    );
    assert.doesNotThrow(() => validateSiteInput(input));
    const siteInPath = join(dir, 'r31-pos.site-input.json');
    const siteOutDir = join(dir, 'r31-pos-site');
    await writeFile(siteInPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: siteInPath, outDir: siteOutDir });
    const siteVer = await verifySiteBundle(siteOutDir);
    assert.equal(siteVer.ok, true, `expected verifySiteBundle ok:true, got ${JSON.stringify(siteVer.errors)}`);

    const specDir = new URL('../../fixtures/specimen-v2', import.meta.url).pathname;
    const pktSrcDir = join(dir, 'pkt-src');
    await cp(specDir, pktSrcDir, { recursive: true });
    const pktReportPath = join(pktSrcDir, 'canon-specimen-v2.report.json');
    const pktReport = JSON.parse(await readFile(pktReportPath, 'utf8'));
    pktReport.sections[0].blocks.push(
      { type: 'paragraph', text: ['SegScheme https', '://x.example<script>alert(1)</script> end.'] },
      { type: 'paragraph', text: ['SegWww1 www', '.x.example<img src=x onerror=alert(1)> end.'] },
      { type: 'paragraph', text: ['EntitySplit &lt', '; and &#60', '; end.'] },
      { type: 'paragraph', text: ['SegMail ops', `${at}${mailDom} and ops${at}${underDom} and josé${at}${mailDom} end.`] },
    );
    assert.doesNotThrow(() => validateReport(pktReport));
    await writeFile(pktReportPath, JSON.stringify(pktReport, null, 2));
    const pktOutDir = join(dir, 'r31-pos-pkt');
    await buildPacket({ reportPath: pktReportPath, outDir: pktOutDir });
    const pktVer = await verifyPacket(pktOutDir);
    assert.equal(pktVer.ok, true, `expected verifyPacket ok:true, got ${JSON.stringify(pktVer.errors)}`);

    const itemMd = await readFile(join(siteOutDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const reportMd = await readFile(join(pktOutDir, 'report.md'), 'utf8');
    const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
    if (which.status === 0) {
      const pandocBin = which.stdout.trim();
      for (const [label, md] of [['sitrep', itemMd], ['packet', reportMd]]) {
        const pd = spawnSync(pandocBin, ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
        assert.equal(pd.status, 0, pd.stderr);
        assert.equal(/<(?:script|img|svg)\b/i.test(pd.stdout), false, `${label} pandoc HTML leaked raw HTML: ${pd.stdout}`);
        assert.equal(pd.stdout.includes('mailto:'), false, `${label} pandoc HTML leaked mailto autolink: ${pd.stdout}`);
        assert.equal(pd.stdout.includes('href="https://x.example'), false, `${label} pandoc HTML leaked bare https autolink: ${pd.stdout}`);
        assert.equal(pd.stdout.includes('href="http://www.x.example'), false, `${label} pandoc HTML leaked bare www autolink: ${pd.stdout}`);
        assert.equal(pd.stdout.includes('EntitySplit &amp;lt; and &amp;#60;'), true, `${label} pandoc HTML corrupted split entities: ${pd.stdout}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R31-DEFECTS-NEG] verifySiteBundle rejects resealed bare GFM/Pandoc autolinks (URI schemes, www., emails), GFM task-list checkboxes, paired GFM strikethrough, and Pandoc inline/display math', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r31-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const mailDom = ['evil', 'example'].join('.');
    const underDom = ['a_b', 'evil', 'example'].join('.');
    const at = String.fromCharCode(64);
    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: `Autolink1 https://x.example<script>alert(1)</script> and www.x.example<img src=x onerror=alert(1)> and http://evil.example/plain and ftp://evil.example/file and ops${at}${mailDom} and josé${at}${underDom}.`,
      },
      {
        type: 'paragraph',
        text: ['Strike ~~obsolete~~ and Math $a ', { cite: 'ev-latency-csv' }, ' b$ and Display $$ x $$ and CodeMath $a ', { code: 'b$' }, '.'],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          '[x] Shipped strict pinning',
          '[ ] Pending audit',
          '[x]',
          '~legacy~ item text',
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          '[X] Ordered task item',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r31-neg',
        caption: 'R31 GFM inline tamper matrix',
        columns: [
          { key: 'k1', label: 'Links' },
          { key: 'k2', label: 'Formatting' },
        ],
        rows: [
          {
            k1: `https://evil.example/cell and www.evil.example/cell and ops${at}${mailDom}`,
            k2: '~~cellstrike~~ and $x+1$',
          },
        ],
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r31-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const unresealedDir = join(dir, 'tamper-ctrl');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(join(unresealedDir, 'index.md'), `${await readFile(join(unresealedDir, 'index.md'), 'utf8')}\ntamper\n`);
    const ctrlVer = await verifySiteBundle(unresealedDir);
    assert.equal(ctrlVer.ok, false, 'unresealed tamper control must fail');

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r31-2a-bare-https-autolink-backslash-script-xss',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'https&#58;//x.example\\<script>alert(1)\\</script>', 'https://x.example\\<script>alert(1)\\</script>'),
      },
      {
        name: 'r31-2b-bare-www-autolink-backslash-img-xss',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'www&#46;x.example\\<img src=x onerror=alert(1)>', 'www.x.example\\<img src=x onerror=alert(1)>'),
      },
      {
        name: 'r31-2c-bare-http-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'http&#58;//evil.example/plain', 'http://evil.example/plain'),
      },
      {
        name: 'r31-2d-bare-ftp-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'ftp&#58;//evil.example/file', 'ftp://evil.example/file'),
      },
      {
        name: 'r31-2e-bare-email-autolink-ascii',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, `ops&#64;${mailDom}`, `ops${at}${mailDom}`),
      },
      {
        name: 'r31-2f-bare-email-autolink-underscore-unicode',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, `josé&#64;${underDom}`, `josé${at}${underDom}`),
      },
      {
        name: 'r31-2g-table-cell-bare-https-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'https&#58;//evil.example/cell', 'https://evil.example/cell'),
      },
      {
        name: 'r31-2h-table-cell-bare-www-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'www&#46;evil.example/cell', 'www.evil.example/cell'),
      },
      {
        name: 'r31-2i-table-cell-bare-email-autolink',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, `| https&#58;//evil.example/cell and www&#46;evil.example/cell and ops&#64;${mailDom} |`, `| https&#58;//evil.example/cell and www&#46;evil.example/cell and ops${at}${mailDom} |`),
      },
      {
        name: 'r31-2j-unmatched-close-bracket-paren-bare-https-xss',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Autolink1 https&#58;//x.example\\<script>alert(1)\\</script>', 'Autolink1 ](https://x.example\\<script>alert(1)\\</script>)'),
      },
      {
        name: 'r31-3a-task-list-checked-bullet',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '- \\[x] Shipped strict pinning', '- [x] Shipped strict pinning'),
      },
      {
        name: 'r31-3b-task-list-unchecked-bullet',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '- \\[ ] Pending audit', '- [ ] Pending audit'),
      },
      {
        name: 'r31-3c-task-list-uppercase-X-ordered',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '1. \\[X] Ordered task item', '1. [X] Ordered task item'),
      },
      {
        name: 'r31-3d-task-list-bare-eol-ballot',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '- \\[x\\]\n', '- [x]\n'),
      },
      {
        name: 'r31-3e-gfm-strikethrough-double-tilde-prose',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\~\\~obsolete\\~\\~', '~~obsolete~~'),
      },
      {
        name: 'r31-3f-gfm-strikethrough-single-tilde-item',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\~legacy\\~ item text', '~legacy~ item text'),
      },
      {
        name: 'r31-3g-gfm-strikethrough-table-cell',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\~\\~cellstrike\\~\\~', '~~cellstrike~~'),
      },
      {
        name: 'r31-3h-pandoc-inline-math-swallowing-citation',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Math \\$a [E1] b\\$', 'Math $a [E1] b$'),
      },
      {
        name: 'r31-3i-pandoc-inline-math-table-cell',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\$x+1\\$', '$x+1$'),
      },
      {
        name: 'r31-3j-pandoc-display-math-double-dollar',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Display \\$\\$ x \\$\\$', 'Display $$ x $$'),
      },
      {
        name: 'r31-3k-pandoc-math-closing-in-code-span',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'CodeMath \\$a `b$`', 'CodeMath $a `b$`'),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R31 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R32-DEFECTS-POS] untampered pipe-prefixed paragraphs, #-prefixed non-heading prose/gaps/withheld-reasons, and outer-bracket citation prose verify cleanly without GFM strikethrough or Pandoc math leaks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r32-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.gaps[0].text = '#402 telemetry ticket | ~~gap1 | gap2~~';
    input.gaps[1].text = '####### seven-hash facility note';
    input.evidence.push(
      {
        id: 'ev-r32-nda',
        title: 'Customer NDA trace summary',
        kind: 'redacted',
        reason: '#101 customer NDA restriction',
      },
      {
        id: 'ev-r32-missing',
        title: 'Offline telemetry trace',
        kind: 'unavailable',
        reason: '# customer collector offline',
      },
    );
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: '| ~~strike1 | strike2~~',
      },
      {
        type: 'paragraph',
        text: ['| $m1 ', { cite: 'ev-latency-csv' }, ' | m2$'],
      },
      {
        type: 'paragraph',
        text: '| pipe prefix without table and single ~ tilde plus $50 budget',
      },
      {
        type: 'paragraph',
        text: '#1234 issue tracker ticket',
      },
      {
        type: 'paragraph',
        text: '####### seven hashes not a heading',
      },
      {
        type: 'paragraph',
        text: '# ATX-shaped authored paragraph',
      },
      {
        type: 'paragraph',
        text: '- bullet-shaped authored paragraph',
      },
      {
        type: 'paragraph',
        text: '1. ordered-shaped authored paragraph',
      },
      {
        type: 'paragraph',
        text: [
          '[outer ',
          { cite: 'ev-latency-csv' },
          '](https://evil.example/path) and [o2 ',
          { cite: 'ev-latency-csv' },
          '](~~obsolete~~) and [o3 ',
          { cite: 'ev-latency-csv' },
          ']($a+b$).',
        ],
      },
      {
        type: 'code',
        id: 'code-r32-cap',
        title: 'Pipe and hash caption check',
        language: 'shell',
        caption: '| caption with ~~strike1 | strike2~~ and #555 ticket',
        source: 'echo ok',
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const siteInPath = join(dir, 'r32-pos.site-input.json');
    const siteOutDir = join(dir, 'r32-pos-site');
    await writeFile(siteInPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: siteInPath, outDir: siteOutDir });
    const siteVer = await verifySiteBundle(siteOutDir);
    assert.equal(siteVer.ok, true, `expected verifySiteBundle ok:true, got ${JSON.stringify(siteVer.errors)}`);

    const specDir = new URL('../../fixtures/specimen-v2', import.meta.url).pathname;
    const pktSrcDir = join(dir, 'pkt-src');
    await cp(specDir, pktSrcDir, { recursive: true });
    const pktReportPath = join(pktSrcDir, 'canon-specimen-v2.report.json');
    const pktReport = JSON.parse(await readFile(pktReportPath, 'utf8'));
    const firstEvId = pktReport.evidence[0].id;
    pktReport.sections[0].blocks.push(
      { type: 'paragraph', text: '| ~~strike1 | strike2~~' },
      { type: 'paragraph', text: ['| $m1 ', { cite: firstEvId }, ' | m2$'] },
      { type: 'paragraph', text: '#1234 issue tracker ticket' },
    );
    assert.doesNotThrow(() => validateReport(pktReport));
    await writeFile(pktReportPath, JSON.stringify(pktReport, null, 2));
    const pktOutDir = join(dir, 'r32-pos-pkt');
    await buildPacket({ reportPath: pktReportPath, outDir: pktOutDir });
    const pktVer = await verifyPacket(pktOutDir);
    assert.equal(pktVer.ok, true, `expected verifyPacket ok:true, got ${JSON.stringify(pktVer.errors)}`);

    const itemMd = await readFile(join(siteOutDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const areaMd = await readFile(join(siteOutDir, 'area/runtime/index.md'), 'utf8');
    const reportMd = await readFile(join(pktOutDir, 'report.md'), 'utf8');
    const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
    if (which.status === 0) {
      const pandocBin = which.stdout.trim();
      for (const [label, md] of [['sitrep-item', itemMd], ['sitrep-area', areaMd], ['packet-report', reportMd]]) {
        const pd = spawnSync(pandocBin, ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
        assert.equal(pd.status, 0, `${label} pandoc exit 0`);
        assert.equal(/<del\b/i.test(pd.stdout), false, `${label} leaked <del> strikethrough in pandoc GFM: ${pd.stdout}`);
        assert.equal(/class="math\b/i.test(pd.stdout), false, `${label} leaked Pandoc math in pandoc GFM: ${pd.stdout}`);
        assert.equal(/href="https?:\/\/evil\.example/i.test(pd.stdout), false, `${label} leaked bare autolink in pandoc GFM: ${pd.stdout}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R32-DEFECTS-NEG] verifySiteBundle rejects resealed deactivated-bracket bare autolinks/strikethrough/math, pipe-paragraph cross-pipe strikethrough/math, mismatched or mid-paragraph GFM tables, lazy list continuations, and block-marker tampering on paragraphs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r32-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const mailDom = ['evil', 'example'].join('.');
    const at = String.fromCharCode(64);

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: ['[outer ', { cite: 'ev-latency-csv' }, '](https://evil.example/path)'],
      },
      {
        type: 'paragraph',
        text: ['[o1 ', { cite: 'ev-latency-csv' }, '](http://evil.example/plain)'],
      },
      {
        type: 'paragraph',
        text: ['[o2 ', { cite: 'ev-latency-csv' }, '](www.evil.example/w)'],
      },
      {
        type: 'paragraph',
        text: ['[o3 ', { cite: 'ev-latency-csv' }, `](ops${at}${mailDom})`],
      },
      {
        type: 'paragraph',
        text: ['[o4 ', { cite: 'ev-latency-csv' }, '](~~obsolete~~)'],
      },
      {
        type: 'paragraph',
        text: ['[o5 ', { cite: 'ev-latency-csv' }, ']($a+', { cite: 'ev-compaction-json' }, '+b$)'],
      },
      {
        type: 'paragraph',
        text: ['[o6 ', { cite: 'ev-latency-csv' }, '](https://evil.example/collapsed)'],
      },
      {
        type: 'paragraph',
        text: ['[o7 lbl ', { cite: 'ev-latency-csv' }, '](https://evil.example/full)'],
      },
      {
        type: 'paragraph',
        text: 'Plain paragraph for multi-line tamper anchor',
      },
      {
        type: 'paragraph',
        text: '| ~~strike1 | strike2~~',
      },
      {
        type: 'paragraph',
        text: ['| $m1 ', { cite: 'ev-latency-csv' }, ' | m2$'],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          '~alpha beta~',
          ['$m1 + ', { cite: 'ev-latency-csv' }, ' + m2$'],
        ],
      },
      {
        type: 'paragraph',
        text: '- bullet-shaped authored paragraph',
      },
      {
        type: 'paragraph',
        text: '1. ordered-shaped authored paragraph',
      },
      {
        type: 'paragraph',
        text: '# ATX-shaped authored paragraph',
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r32-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const unresealedDir = join(dir, 'tamper-ctrl');
    await cp(baseBundle, unresealedDir, { recursive: true });
    await writeFile(join(unresealedDir, 'index.md'), `${await readFile(join(unresealedDir, 'index.md'), 'utf8')}\ntamper\n`);
    assert.equal((await verifySiteBundle(unresealedDir)).ok, false, 'unresealed tamper control must fail');

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r32-1a-deactivated-bracket-bare-https',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[outer [E1]\\](https&#58;//evil.example/path)', '[outer [E1]](https://evil.example/path)'),
      },
      {
        name: 'r32-1b-deactivated-bracket-bare-http',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o1 [E1]\\](http&#58;//evil.example/plain)', '[o1 [E1]](http://evil.example/plain)'),
      },
      {
        name: 'r32-1c-deactivated-bracket-bare-www',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o2 [E1]\\](www&#46;evil.example/w)', '[o2 [E1]](www.evil.example/w)'),
      },
      {
        name: 'r32-1d-deactivated-bracket-bare-email',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, `\\[o3 [E1]\\](ops&#64;${mailDom})`, `[o3 [E1]](ops${at}${mailDom})`),
      },
      {
        name: 'r32-1e-deactivated-bracket-gfm-strikethrough',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o4 [E1]\\](\\~\\~obsolete\\~\\~)', '[o4 [E1]](~~obsolete~~)'),
      },
      {
        name: 'r32-1f-deactivated-bracket-pandoc-math-swallowing-cite',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o5 [E1]\\](\\$a+[E2]+b\\$)', '[o5 [E1]]($a+[E2]+b$)'),
      },
      {
        name: 'r32-1g-deactivated-collapsed-ref-bare-https',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o6 [E1]\\](https&#58;//evil.example/collapsed)', '[o6 [E1][]](https://evil.example/collapsed)'),
      },
      {
        name: 'r32-1h-deactivated-full-ref-bare-https',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[o7 lbl [E1]\\](https&#58;//evil.example/full)', '[o7 [lbl][E1]](https://evil.example/full)'),
      },
      {
        name: 'r32-2a-mismatched-table-delim-cloaking-strikethrough',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Plain paragraph for multi-line tamper anchor', '~~strike1\n| --- | --- |\nstrike2~~'),
      },
      {
        name: 'r32-2b-mid-paragraph-table-interruption',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Plain paragraph for multi-line tamper anchor', 'Intro ~~open\n| A | B |\n| --- | --- |\n| 1 | close~~ |'),
      },
      {
        name: 'r32-2c-pipe-paragraph-unescaped-cross-pipe-strikethrough',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| \\~\\~strike1 | strike2\\~\\~', '| ~~strike1 | strike2~~'),
      },
      {
        name: 'r32-2d-pipe-paragraph-unescaped-cross-pipe-math',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| \\$m1 [E1] | m2\\$', '| $m1 [E1] | m2$'),
      },
      {
        name: 'r32-3a-lazy-list-continuation-strikethrough',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '- \\~alpha beta\\~', '- ~alpha\nbeta~'),
      },
      {
        name: 'r32-3b-lazy-list-continuation-math',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '- \\$m1 + [E1] + m2\\$', '- $m1 +\n[E1] + m2$'),
      },
      {
        name: 'r32-3c-paragraph-tampered-to-bullet-list',
        expectedCode: 'reading-order',
        mutate: (b) => replaceInMd(b, targetMd, '\\- bullet-shaped authored paragraph', '- bullet-shaped authored paragraph'),
      },
      {
        name: 'r32-3d-paragraph-tampered-to-ordered-list',
        expectedCode: 'reading-order',
        mutate: (b) => replaceInMd(b, targetMd, '1\\. ordered-shaped authored paragraph', '1. ordered-shaped authored paragraph'),
      },
      {
        name: 'r32-3e-paragraph-tampered-to-tab-atx-heading',
        expectedCode: 'reading-order',
        mutate: (b) => replaceInMd(b, targetMd, '\\# ATX-shaped authored paragraph', '#\tATX-shaped authored paragraph'),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R32 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R33-DEFECTS-POS] buildSiteBundle and verifySiteBundle accept untampered multi-line finding/requirement/decision/risk blocks and GFM pipe tables with cross-line and cross-cell inline candidates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r33-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.history = [
      {
        editionId: 'sitrep-2026-w45',
        contentId: `sha256-${'a'.repeat(64)}`,
        observedAt: '2026-11-07T17:00:00Z',
      },
    ];
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'F-R33-POS-1',
        title: 'Multi-line finding with cross-line link/image/emphasis candidates and genuine inline constructs',
        severity: 'high',
        confidence: 'proven',
        verification: {
          band: 'code',
          detail: 'probe ![beacon and [click and [hijacked and _open and *star and **strong',
        },
        claim: [
          'alt](https://evil.example/pixel.png) and here](javascript:alert(1)) and ]',
          { cite: 'ev-latency-csv' },
          ' and close_ and star* and close** plus ',
          { em: 'valid em' },
          ', ',
          { strong: 'valid strong' },
          ', ',
          { code: 'valid|code' },
          ', and ',
          { link: { text: 'valid link', href: 'https://example.org/docs?a=1&b=2' } },
          '.',
        ],
        evidence: ['ev-latency-csv', 'ev-compaction-json'],
      },
      {
        type: 'requirement',
        id: 'REQ-R33-POS-1',
        title: 'Multi-line requirement with cross-line emphasis/bracket candidates and scenarios',
        pattern: 'ubiquitous',
        verification: {
          band: 'code',
          detail: 'probe _uopen and *sopen and **bopen and [refopen',
        },
        statement: [
          'uclose_ and sclose* and bclose** and ]',
          { cite: 'ev-compaction-json' },
          ' with ',
          { strong: 'SHALL' },
          ' and ',
          { code: 'verifySiteBundle' },
          '.',
        ],
        evidence: ['ev-latency-csv'],
        scenarios: [
          {
            name: 'sc![1',
            given: 'alt](https://evil.example/sc.png)',
            when: 'alpha _beta',
            then: 'gamma_ delta',
          },
        ],
      },
      {
        type: 'table',
        id: 'tbl-r33-pos',
        caption: 'GFM pipe table with canonical inline constructs and cross-cell/cross-row candidates',
        columns: [
          { key: 'colA', label: 'Left|Header' },
          { key: 'colB', label: 'Right|Header' },
        ],
        rows: [
          {
            colA: [
              '![beacon and ',
              { link: { text: 'pipe|link', href: 'https://example.org/a|b?q=`' } },
            ],
            colB: [
              'alt](https://evil.example/pixel.png) and ',
              { code: 'pipe|code' },
              ' and ',
              { em: 'cell|em' },
              ' and ',
              { strong: 'cell|strong' },
              ' ',
              { cite: 'ev-latency-csv' },
            ],
          },
          {
            colA: '**Decision: and alpha _beta and alpha *beta and [hijacked',
            colB: ['approve** and gamma_ and gamma* and ]', { cite: 'ev-compaction-json' }],
          },
        ],
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r33-pos.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const res = await verifySiteBundle(outDir);
    assert.equal(res.ok, true, `expected R33 positive bundle to verify cleanly, got ${JSON.stringify(res.errors)}`);

    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const gfm = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: itemMd, encoding: 'utf8' });
    assert.equal(gfm.status, 0, gfm.stderr);
    assert.equal(gfm.stdout.includes('<img'), false, 'pandoc GFM must render zero <img> tags');
    assert.equal(gfm.stdout.includes('href="javascript:'), false, 'pandoc GFM must render zero javascript: links');
    assert.equal(gfm.stdout.includes('href="https://evil.example/'), false, 'pandoc GFM must not link evil.example');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R33-DEFECTS-NEG] verifySiteBundle rejects resealed cross-line inline smuggling in multi-line paragraphs, cross-cell/cross-row CommonMark constructs in GFM tables, and pipeless/escaped-pipe trailing GFM table rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r33-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'F-R33-IMG',
        title: 'Cross-line image candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe ![beacon' },
        claim: 'alt](https://evil.example/pixel.png)',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R33-JS',
        title: 'Cross-line javascript link candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe [click' },
        claim: 'here](javascript:alert(1))',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R33-HTTPS',
        title: 'Cross-line unindexed https link candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe [click' },
        claim: 'here](https://evil.example/unindexed)',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R33-REL',
        title: 'Cross-line relative anchor link candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe [relclick' },
        claim: 'relhere](#i-wal-standby-ring)',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R33-REF',
        title: 'Cross-line reference hijack candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe [hijacked' },
        claim: [']', { cite: 'ev-latency-csv' }],
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'requirement',
        id: 'REQ-R33-EMPH',
        title: 'Cross-line emphasis and strong candidate',
        pattern: 'ubiquitous',
        verification: { band: 'code', detail: 'probe _uopen and *sopen and **Decision:' },
        statement: 'uclose_ and sclose* and approve**',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'paragraph',
        text: '[singleclick](javascript:alert(1))',
      },
      {
        type: 'list',
        ordered: false,
        items: ['lazy-table-probe'],
      },
      {
        type: 'table',
        id: 'tbl-r33-neg',
        caption: 'R33 negative table probes',
        columns: [
          { key: 'c1', label: 'Col 1' },
          { key: 'c2', label: 'Col 2' },
        ],
        rows: [
          { c1: '![beacon', c2: 'row1' },
          { c1: 'row2', c2: 'alt](https://evil.example/pixel.png)' },
          { c1: '[smuggled', c2: 'row3' },
          { c1: 'row4', c2: 'link](javascript:alert(1))' },
          { c1: '[hijacked', c2: 'row5' },
          { c1: 'row6', c2: [']', { cite: 'ev-latency-csv' }] },
          { c1: '**Decision:', c2: 'approve now**' },
          { c1: 'alpha _beta', c2: 'gamma_ delta' },
          { c1: 'alpha *beta', c2: 'gamma* delta' },
        ],
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r33-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r33-1a-cross-line-finding-image',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe !\\[beacon  \n**Claim.** alt\\](https&#58;//evil.example/pixel.png)',
          '**Verification.** Code check — probe ![beacon  \n**Claim.** alt](https&#58;//evil.example/pixel.png)',
        ),
      },
      {
        name: 'r33-1b-cross-line-finding-javascript-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\[click  \n**Claim.** here\\](javascript&#58;alert(1))',
          '**Verification.** Code check — probe [click  \n**Claim.** here](javascript&#58;alert(1))',
        ),
      },
      {
        name: 'r33-1c-cross-line-finding-unindexed-https-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\[click  \n**Claim.** here\\](https&#58;//evil.example/unindexed)',
          '**Verification.** Code check — probe [click  \n**Claim.** here](https://evil.example/unindexed)',
        ),
      },
      {
        name: 'r33-1h-cross-line-finding-rel-anchor-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\[relclick  \n**Claim.** relhere\\](#i-wal-standby-ring)',
          '**Verification.** Code check — probe [relclick  \n**Claim.** relhere](#i-wal-standby-ring)',
        ),
      },
      {
        name: 'r33-1d-cross-line-finding-ref-hijack',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\[hijacked  \n**Claim.** \\][E1]',
          '**Verification.** Code check — probe [hijacked  \n**Claim.** ][E1]',
        ),
      },
      {
        name: 'r33-1e-cross-line-requirement-underscore-emph',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\_uopen and \\*sopen and \\*\\*Decision:  \n**Specification.** uclose\\_ and sclose\\* and approve\\*\\*',
          '**Verification.** Code check — probe _uopen and \\*sopen and \\*\\*Decision:  \n**Specification.** uclose_ and sclose\\* and approve\\*\\*',
        ),
      },
      {
        name: 'r33-1f-cross-line-requirement-star-strong',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\_uopen and \\*sopen and \\*\\*Decision:  \n**Specification.** uclose\\_ and sclose\\* and approve\\*\\*',
          '**Verification.** Code check — probe \\_uopen and \\*sopen and **Decision:  \n**Specification.** uclose\\_ and sclose\\* and approve**',
        ),
      },
      {
        name: 'r33-1g-single-line-entity-obfuscated-javascript-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '\\[singleclick\\](javascript&#58;alert(1))', '[singleclick](javascript&#58;alert\\(1\\))'),
      },
      {
        name: 'r33-2a-cross-row-gfm-table-image',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '| !\\[beacon | row1 |\n| row2 | alt\\](https&#58;//evil.example/pixel.png) |',
          '| ![beacon | row1 |\n| row2 | alt](https&#58;//evil.example/pixel.png) |',
        ),
      },
      {
        name: 'r33-2b-cross-row-gfm-table-javascript-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '| \\[smuggled | row3 |\n| row4 | link\\](javascript&#58;alert(1)) |',
          '| [smuggled | row3 |\n| row4 | link](javascript&#58;alert\\(1\\)) |',
        ),
      },
      {
        name: 'r33-2c-cross-row-gfm-table-ref-hijack',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '| \\[hijacked | row5 |\n| row6 | \\][E1] |',
          '| [hijacked | row5 |\n| row6 | ][E1] |',
        ),
      },
      {
        name: 'r33-2d-cross-cell-gfm-table-strong-callout',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| \\*\\*Decision: | approve now\\*\\* |', '| **Decision: | approve now** |'),
      },
      {
        name: 'r33-2e-cross-cell-gfm-table-underscore-emph',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| alpha \\_beta | gamma\\_ delta |', '| alpha _beta | gamma_ delta |'),
      },
      {
        name: 'r33-2f-cross-cell-gfm-table-star-emph',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| alpha \\*beta | gamma\\* delta |', '| alpha *beta | gamma* delta |'),
      },
      {
        name: 'r33-3a-gfm-table-pipeless-trailing-row',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '| alpha \\*beta | gamma\\* delta |',
          '| alpha \\*beta | gamma\\* delta |\nhttps://evil.example/pipeless ~~strikethrough~~ $a+b$',
        ),
      },
      {
        name: 'r33-3b-gfm-table-escaped-pipe-only-trailing-row',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '| alpha \\*beta | gamma\\* delta |',
          '| alpha \\*beta | gamma\\* delta |\n~~s1 \\| s2~~',
        ),
      },
      {
        name: 'r33-3c-list-item-lazy-gfm-table-continuation-smuggle',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '- lazy-table-probe',
          '- lazy-table-probe ![beacon\n| A | B |\n| --- | --- |\n| 1 | alt](https&#58;//evil.example/lazy.png) |',
        ),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R33 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R34-DEFECTS-POS] buildSiteBundle and verifySiteBundle accept space-padded non-link candidates, GFM code-span double-backslash pipes (`c\\\\|2`), and 2./01./* paragraph prefixes cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r34-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'F-R34-POS-1',
        title: 'Space-padded link tail candidates in multi-line finding',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe ![beacon and [xss' },
        claim: 'alt]( https://evil.example/tab.png) and click]( javascript:alert(1)) and alt2](https://evil.example/trail.png ) and alt3](https://evil.example/titled.png "ttl")',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'table',
        id: 'tbl-r34-pos',
        caption: 'GFM table odd-backslash prose pipes and even-backslash code-span pipes',
        columns: [
          { key: 'h1', label: 'Head|One' },
          { key: 'h2', label: 'Head\\|Two' },
          { key: 'h3', label: 'Head\\\\|Three' },
        ],
        rows: [
          {
            h1: 'a|b',
            h2: 'a\\|b',
            h3: 'a\\\\|b',
          },
          {
            h1: [{ link: { text: 'pipe|link', href: 'https://example.org/x?a=\\|b' } }],
            h2: [{ code: 'c|1' }, ' / ', { code: 'c\\|2' }, ' / ', { code: 'c\\\\|3' }],
            h3: 'clean cell',
          },
        ],
      },
      {
        type: 'paragraph',
        text: '2. authored non-one ordered prefix',
      },
      {
        type: 'paragraph',
        text: '01. authored zero-padded one prefix',
      },
      {
        type: 'paragraph',
        text: '* authored star bullet prefix',
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r34-pos.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const res = await verifySiteBundle(outDir);
    assert.equal(res.ok, true, `expected R34 positive bundle to verify cleanly, got ${JSON.stringify(res.errors)}`);

    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const gfm = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: itemMd, encoding: 'utf8' });
    assert.equal(gfm.status, 0, gfm.stderr);
    assert.equal(gfm.stdout.includes('<img'), false, 'pandoc GFM must render zero <img> tags');
    assert.equal(gfm.stdout.includes('href="javascript:'), false, 'pandoc GFM must render zero javascript: links');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R34-DEFECTS-REL-SOUNDNESS] relaxEscapes preserves delimiter escapes across lazy GFM table continuations after list items and non-1/empty list markers on paragraph continuation lines', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  // 1. Lazy GFM table continuation immediately following a list item (closes R33 relax.mjs inert-control gap)
  const lazyListTableStrict = '- item \\~\\~s1 and \\$m1 and \\_u1\n| A | B |\n| --- | --- |\n| 1 | s2\\~\\~ and m2\\$ and u2\\_ |';
  const lazyListTableRelaxed = relaxEscapes(lazyListTableStrict);
  assert.equal(cmRender(lazyListTableRelaxed).includes('<em'), false, `expected zero <em> in CommonMark for lazy list table: ${lazyListTableRelaxed}`);
  const gfmLazyTableHtml = gfmRender(lazyListTableRelaxed);
  assert.equal(gfmLazyTableHtml.includes('<del'), false, `expected zero <del> in Pandoc GFM for lazy list table: ${lazyListTableRelaxed}`);
  assert.equal(gfmLazyTableHtml.includes('class="math'), false, `expected zero math in Pandoc GFM for lazy list table: ${lazyListTableRelaxed}`);

  // 2. Non-1 ordered list marker ("2. ") on paragraph continuation line cannot interrupt paragraph (R34-DEFECT-3)
  const nonOneContStrict = 'alpha \\_open and \\*star and \\~\\~strike and \\$math\n2. close\\_ and star\\* and strike\\~\\~ and math\\$ omega';
  const nonOneContRelaxed = relaxEscapes(nonOneContStrict);
  assert.equal(cmRender(nonOneContRelaxed).includes('<em'), false, `expected zero <em> in CommonMark for 2. continuation: ${nonOneContRelaxed}`);
  const gfmNonOneHtml = gfmRender(nonOneContRelaxed);
  assert.equal(gfmNonOneHtml.includes('<del'), false, `expected zero <del> in Pandoc GFM for 2. continuation: ${nonOneContRelaxed}`);
  assert.equal(gfmNonOneHtml.includes('class="math'), false, `expected zero math in Pandoc GFM for 2. continuation: ${nonOneContRelaxed}`);

  // 3. Empty list markers ("1.   ", "+   ", "*   ") on paragraph continuation lines cannot interrupt paragraph
  const emptyMarkerStrict = 'alpha \\_open and \\~\\~strike\n1.   \n+   \n*   \nclose\\_ and strike\\~\\~';
  const emptyMarkerRelaxed = relaxEscapes(emptyMarkerStrict);
  assert.equal(cmRender(emptyMarkerRelaxed).includes('<em'), false, `expected zero <em> in CommonMark for empty list markers: ${emptyMarkerRelaxed}`);
  assert.equal(gfmRender(emptyMarkerRelaxed).includes('<del'), false, `expected zero <del> in Pandoc GFM for empty list markers: ${emptyMarkerRelaxed}`);

  // 4. Genuine sibling ordered list items ("1. first\n2. second") remain distinct containers and still relax solo escapes
  const siblingListStrict = '1. first \\_solo\n2. second solo\\_';
  const siblingListRelaxed = relaxEscapes(siblingListStrict);
  assert.equal(siblingListRelaxed, '1. first _solo\n2. second solo_');
  assert.equal(cmRender(siblingListRelaxed).includes('<em'), false);
});

test('[Canon-v2 SitRep R34-DEFECTS-NEG] verifySiteBundle rejects resealed tab/newline inline link/image tails, even-backslash pipes outside GFM code spans, and non-interrupting 2./0./empty list markers on paragraph continuations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r34-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'finding',
        id: 'F-R34-TAB-IMG',
        title: 'Tab link tail image candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe ![beacon' },
        claim: 'alt]( https://evil.example/tab.png)',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R34-TAB-XSS',
        title: 'Tab link tail xss candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe [xss' },
        claim: 'click]( javascript:alert(1))',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R34-TRAIL-TAB',
        title: 'Trailing tab link tail image candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe ![trail' },
        claim: 'alt](https://evil.example/trail.png )',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'finding',
        id: 'F-R34-TITLE-TAB',
        title: 'Tab before title image candidate',
        severity: 'high',
        confidence: 'proven',
        verification: { band: 'code', detail: 'probe ![titled' },
        claim: 'alt](https://evil.example/titled.png "ttl")',
        evidence: ['ev-latency-csv'],
      },
      {
        type: 'paragraph',
        text: 'p-nl ![nlbeacon]( https://evil.example/nl.png)',
      },
      {
        type: 'paragraph',
        text: 'p-nl2 [nllink](https://evil.example/nl )',
      },
      {
        type: 'table',
        id: 'tbl-r34-neg',
        caption: 'R34 even-backslash pipe probes',
        columns: [
          { key: 'c1', label: 'Head|One' },
          { key: 'c2', label: 'Head Two' },
        ],
        rows: [
          { c1: 'a|b', c2: 'visible' },
          {
            c1: [{ link: { text: 'pipe|link', href: 'https://example.org/x?a=|b' } }],
            c2: 'a\\|b',
          },
        ],
      },
      {
        type: 'paragraph',
        text: 'p-olist2 ![olist2 2. alt](https://evil.example/o2.png) and _u1 2. u2_',
      },
      {
        type: 'paragraph',
        text: 'p-olist0 ~~s1 0. s2~~',
      },
      {
        type: 'paragraph',
        text: 'p-olist3 _u1 3) u2_',
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r34-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r34-1a-cross-line-finding-image-leading-tab',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe !\\[beacon  \n**Claim.** alt\\]( https&#58;//evil.example/tab.png)',
          '**Verification.** Code check — probe ![beacon  \n**Claim.** alt](\thttps&#58;//evil.example/tab.png)',
        ),
      },
      {
        name: 'r34-1b-cross-line-finding-xss-leading-tab',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe \\[xss  \n**Claim.** click\\]( javascript&#58;alert(1))',
          '**Verification.** Code check — probe [xss  \n**Claim.** click](\tjavascript&#58;alert(1))',
        ),
      },
      {
        name: 'r34-1c-cross-line-finding-image-trailing-tab',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe !\\[trail  \n**Claim.** alt\\](https&#58;//evil.example/trail.png )',
          '**Verification.** Code check — probe ![trail  \n**Claim.** alt](https&#58;//evil.example/trail.png\t)',
        ),
      },
      {
        name: 'r34-1d-cross-line-finding-image-tab-before-title',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '**Verification.** Code check — probe !\\[titled  \n**Claim.** alt\\](https&#58;//evil.example/titled.png "ttl")',
          '**Verification.** Code check — probe ![titled  \n**Claim.** alt](https&#58;//evil.example/titled.png\t"ttl")',
        ),
      },
      {
        name: 'r34-1e-paragraph-image-newline-after-paren',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'p-nl !\\[nlbeacon\\]( https&#58;//evil.example/nl.png)', 'p-nl ![nlbeacon](\nhttps&#58;//evil.example/nl.png)'),
      },
      {
        name: 'r34-1f-paragraph-link-newline-before-close-paren',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'p-nl2 \\[nllink\\](https&#58;//evil.example/nl )', 'p-nl2 [nllink](https&#58;//evil.example/nl\n)'),
      },
      {
        name: 'r34-2a-gfm-table-header-even-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| Head\\|One | Head Two |', '| Head\\\\|One | Head Two |'),
      },
      {
        name: 'r34-2b-gfm-table-cell-two-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| a\\|b | visible |', '| a\\\\|b | visible |'),
      },
      {
        name: 'r34-2c-gfm-table-link-label-two-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '[pipe\\|link](https://example.org/x?a=\\|b)', '[pipe\\\\|link](https://example.org/x?a=\\|b)'),
      },
      {
        name: 'r34-2d-gfm-table-cell-four-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '| a\\\\\\|b |', '| a\\\\\\\\|b |'),
      },
      {
        name: 'r34-2e-gfm-table-link-dest-two-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '[pipe\\|link](https://example.org/x?a=\\|b)', '[pipe\\|link](https://example.org/x?a=\\\\|b)'),
      },
      {
        name: 'r34-3a-lazy-ordered-2-continuation-image-and-emph',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          'p-olist2 !\\[olist2 2. alt\\](https&#58;//evil.example/o2.png) and \\_u1 2. u2\\_',
          'p-olist2 ![olist2\n2. alt](https&#58;//evil.example/o2.png) and _u1\n2. u2_',
        ),
      },
      {
        name: 'r34-3b-lazy-ordered-0-continuation-strikethrough',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'p-olist0 \\~\\~s1 0. s2\\~\\~', 'p-olist0 ~~s1\n0. s2~~'),
      },
      {
        name: 'r34-3c-lazy-ordered-3-paren-continuation-emph',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'p-olist3 \\_u1 3) u2\\_', 'p-olist3 _u1\n3) u2_'),
      },
      {
        name: 'r34-3d-cite-refdef-attached-to-following-ordered-2-line',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '[E2]: #ev-ev-compaction-json\n', '[E2]: #ev-ev-compaction-json\n2. trailing\n'),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R34 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R35-DEFECTS-POS] buildSiteBundle/verifySiteBundle and buildPacket/verifyPacket accept https: URLs containing Metadata:/data:/javascript: substrings and >32 escaped parens without self-rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r35-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const p33Open = '('.repeat(33);
    const p33Close = ')'.repeat(33);
    const deepParenHref = `https://example.org/#${p33Open}deep${p33Close}`;
    const wikiMetaHref = 'https://example.org/wiki/Metadata:Overview';
    const mdnDataHref = 'https://developer.mozilla.org/en-US/docs/Web/URI/Schemes/data:text';
    const queryJsHref = 'https://example.org/audit?vector=javascript:alert(1)&v2=vbscript:msg';

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'References: ',
          { link: { text: 'Metadata Overview', href: wikiMetaHref } },
          ', ',
          { link: { text: 'MDN data URI scheme', href: mdnDataHref } },
          ', ',
          { link: { text: 'Audit query', href: queryJsHref } },
          ', and ',
          { link: { text: 'Deep parens', href: deepParenHref } },
          '.',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r35-pos',
        caption: 'R35 table URLs with Metadata: and deep parens',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'ref', label: 'Reference' },
        ],
        rows: [
          {
            name: 'Wiki Metadata',
            ref: [{ link: { text: 'Metadata:Overview|1', href: `${wikiMetaHref}?p=a|b` } }],
          },
          {
            name: 'Deep parens in table',
            ref: [{ link: { text: 'E1', href: deepParenHref } }],
          },
        ],
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r35-pos.site-input.json');
    const siteOut = join(dir, 'site-out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: siteOut });
    const siteRes = await verifySiteBundle(siteOut);
    assert.equal(siteRes.ok, true, `expected R35 positive site-bundle to verify cleanly, got ${JSON.stringify(siteRes.errors)}`);

    const specRoot = new URL('../../fixtures/specimen-v2/', import.meta.url);
    const specV2 = JSON.parse(await readFile(new URL('canon-specimen-v2.report.json', specRoot), 'utf8'));
    await cp(new URL('evidence', specRoot), join(dir, 'pkt-in/evidence'), { recursive: true });
    specV2.sections[0].blocks.push({
      type: 'paragraph',
      text: [
        'Packet links: ',
        { link: { text: 'Metadata Overview', href: wikiMetaHref } },
        ', ',
        { link: { text: 'MDN data URI scheme', href: mdnDataHref } },
        ', and ',
        { link: { text: 'Audit query', href: queryJsHref } },
        '.',
      ],
    });
    assert.doesNotThrow(() => validateReport(specV2));
    const pktInPath = join(dir, 'pkt-in/report.json');
    const pktOut = join(dir, 'pkt-out');
    await writeFile(pktInPath, JSON.stringify(specV2, null, 2));
    await buildPacket({ reportPath: pktInPath, outDir: pktOut });
    const pktRes = await verifyPacket(pktOut);
    assert.equal(pktRes.ok, true, `expected R35 positive packet to verify cleanly, got ${JSON.stringify(pktRes.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R35-DEFECTS-REL-SOUNDNESS] relaxEscapes tracks CommonMark §4/§5 empty list items, blockquotes, indented code, HTML blocks, and tilde/indented fences without mutating ASTs', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  // 1. Empty list item ("+ ") cannot keep sticky list state across subsequent paragraph + "2. " continuation
  const emptyLiStrict = '+ \npara \\_open and \\*star and \\~\\~strike and \\$math\n2. cont close\\_ and star\\* and strike\\~\\~ and math\\$';
  const emptyLiRelaxed = relaxEscapes(emptyLiStrict);
  assert.equal(cmRender(emptyLiRelaxed).includes('<em'), false, `expected zero <em> after empty list item: ${emptyLiRelaxed}`);
  const gfmEmptyLi = gfmRender(emptyLiRelaxed);
  assert.equal(gfmEmptyLi.includes('<del'), false, `expected zero <del> after empty list item: ${emptyLiRelaxed}`);
  assert.equal(gfmEmptyLi.includes('class="math'), false, `expected zero math after empty list item: ${emptyLiRelaxed}`);

  // 2. Blockquote, indented code, and HTML comment do not block "2. \# not-a-heading" from opening an ordered list item
  for (const [label, prefix] of [
    ['blockquote', '> quote'],
    ['indented-code', '    literal_code'],
    ['html-comment', '<!-- comment -->'],
  ]) {
    const strict = `${prefix}\n2. \\# not-a-heading`;
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed).includes('<h1'), false, `expected zero <h1> in CommonMark after ${label}: ${relaxed}`);
    assert.equal(gfmRender(relaxed).includes('<h1'), false, `expected zero <h1> in Pandoc GFM after ${label}: ${relaxed}`);
  }

  // 3. Tilde fences and 1-3 space indented fences leave literal backslashes untouched
  const tildeFence = '~~~\n\\_literal_tilde\n~~~';
  assert.equal(relaxEscapes(tildeFence), tildeFence);
  const indentedFence = '  ```text\n\\_literal_indented\n  ```';
  assert.equal(relaxEscapes(indentedFence), indentedFence);
});

test('[Canon-v2 SitRep R35-DEFECTS-NEG] verifySiteBundle and verifyPacket reject >32 unescaped link-dest parens, non-canonical link-dest backslash escapes, empty-list lazy 2. smuggles, and anchored dangerous URL schemes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r35-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const p32o = '('.repeat(32);
    const p32c = ')'.repeat(32);
    const p33o = '('.repeat(33);
    const p33c = ')'.repeat(33);

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'Beacon probe ',
          { link: { text: 'b33', href: `https://example.org/#${p32o}![beacon](https://evil.example/p33.png)${p32c}` } },
        ],
      },
      {
        type: 'paragraph',
        text: [
          'Phish probe ',
          { link: { text: 'p33', href: `https://example.org/#${p32o}[phish](https://evil.example/login)${p32c}` } },
        ],
      },
      {
        type: 'paragraph',
        text: [
          'Cite hijack probe ',
          { link: { text: 'E1', href: `https://example.org/#${p33o}x${p33c}` } },
        ],
      },
      {
        type: 'paragraph',
        text: [
          'Non-canonical backslash escape probe ',
          { link: { text: 'escprobe', href: 'https://example.org/clean' } },
        ],
      },
      {
        type: 'paragraph',
        text: [
          '[outer ',
          { link: { text: 'inner', href: `https://example.org/#${p33o}x${p33c}` } },
          '](javascript:alert(1))',
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: ['empty-li-placeholder'],
      },
      {
        type: 'paragraph',
        text: 'p-empty-li ![beacon 2. alt](https://evil.example/empty-li.png)',
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r35-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInFile = async (bundleDir, relPath, from, to) => {
      const fp = join(bundleDir, relPath);
      const txt = await readFile(fp, 'utf8');
      const next = txt.replace(from, () => to);
      assert.notEqual(next, txt, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(fp, next);
    };

    const esc32o = '\\('.repeat(32);
    const esc32c = '\\)'.repeat(32);
    const esc33o = '\\('.repeat(33);
    const esc33c = '\\)'.repeat(33);
    const targetMd = 'item/wal-standby-ring/index.md';
    const targetHtml = 'item/wal-standby-ring/index.html';

    const negCases = [
      {
        name: 'r35-1a-33-nested-parens-remote-beacon-img',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          `[b33](https://example.org/#${esc32o}![beacon]\\(https://evil.example/p33.png\\)${esc32c})`,
          `[b33](https\\://example.org/#${p32o}![beacon](https://evil.example/p33.png)${p32c})`,
        ),
      },
      {
        name: 'r35-1b-33-nested-parens-phish-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          `[p33](https://example.org/#${esc32o}[phish]\\(https://evil.example/login\\)${esc32c})`,
          `[p33](https\\://example.org/#${p32o}[phish](https://evil.example/login)${p32c})`,
        ),
      },
      {
        name: 'r35-1c-33-nested-parens-cite-hijack-without-backslash-colon',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          `[E1](https://example.org/#${esc33o}x${esc33c})`,
          `[E1](https://example.org/#${p33o}x${p33c})`,
        ),
      },
      {
        name: 'r35-1d-non-canonical-backslash-colon-in-https-dest',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          '[escprobe](https://example.org/clean)',
          '[escprobe](https\\://example.org/clean)',
        ),
      },
      {
        name: 'r35-1e-unescaped-single-paren-pair-in-https-dest',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          `[E1](https://example.org/#${esc33o}x${esc33c})`,
          `[E1](https://example.org/#(${esc32o}x${esc32c}))`,
        ),
      },
      {
        name: 'r35-1f-outer-bracket-deactivation-via-33-paren-inner-link',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInFile(
          b,
          targetMd,
          `\\[outer [inner](https://example.org/#${esc33o}x${esc33c})\\](javascript&#58;alert(1))`,
          `[outer [inner](https://example.org/#${p33o}x${p33c})](javascript&#58;alert\\(1\\))`,
        ),
      },
      {
        name: 'r35-2a-empty-list-item-sticky-state-lazy-2-smuggle',
        expectedCode: 'anchor-parity',
        expectedMsg: 'non-canonical CommonMark inline link or image in Markdown',
        mutate: async (b) => {
          await replaceInFile(b, targetMd, '- empty-li-placeholder\n\np-empty-li !\\[beacon 2. alt\\](https&#58;//evil.example/empty-li.png)', '- empty-li-placeholder\n+ \np-empty-li ![beacon\n2. alt](https&#58;//evil.example/empty-li.png)');
        },
      },
      {
        name: 'r35-3a-html-javascript-scheme-still-rejected',
        expectedCode: 'unsafe-content',
        mutate: (b) => replaceInFile(b, targetHtml, 'href="https://example.org/clean"', 'href="&#106;ava&#09;script:alert(1)"'),
      },
      {
        name: 'r35-3b-html-data-scheme-still-rejected',
        expectedCode: 'unsafe-content',
        mutate: (b) => replaceInFile(b, targetHtml, 'href="https://example.org/clean"', 'href="  DaTa:text/html,&lt;h1&gt;x"'),
      },
      {
        name: 'r35-3c-html-vbscript-scheme-still-rejected',
        expectedCode: 'unsafe-content',
        mutate: (b) => replaceInFile(b, targetHtml, 'href="https://example.org/clean"', 'href="vbscript:msgbox(1)"'),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R35 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R36-DEFECTS-POS] buildSiteBundle/verifySiteBundle and buildPacket/verifyPacket accept non-table pipe URLs, table pipe URLs, and standalone =/==/===/--/-- paragraphs after blank lines cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r36-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'Non-table pipe link ',
          { link: { text: 'pipe-url', href: 'https://example.org/x?p=a|b' } },
          ' and bs-pipe link ',
          { link: { text: 'bs-pipe-url', href: 'https://example.org/x?p=a\\|b' } },
          '.',
        ],
      },
      { type: 'paragraph', text: '=' },
      { type: 'paragraph', text: '==' },
      { type: 'paragraph', text: '===' },
      { type: 'paragraph', text: '-' },
      { type: 'paragraph', text: '--' },
      { type: 'paragraph', text: '---' },
      {
        type: 'table',
        id: 'tbl-r36-pos',
        caption: 'Table pipe URLs remain valid in raw-table and unesc-cell modes',
        columns: [
          { key: 'k', label: 'Kind' },
          { key: 'v', label: 'Link' },
        ],
        rows: [
          { k: 'pipe', v: [{ link: { text: 't-pipe', href: 'https://example.org/x?p=a|b' } }] },
          { k: 'bs-pipe', v: [{ link: { text: 't-bs-pipe', href: 'https://example.org/x?p=a\\|b' } }] },
        ],
      },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r36-pos.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const res = await verifySiteBundle(outDir);
    assert.equal(res.ok, true, `expected R36 positive site-bundle to verify cleanly, got ${JSON.stringify(res.errors)}`);

    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    const gfm = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: itemMd, encoding: 'utf8' });
    assert.equal(gfm.status, 0, gfm.stderr);
    assert.equal(gfm.stdout.includes('<h1 id="section"'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R36-DEFECTS-REL-SOUNDNESS] relaxEscapes and prose preserve ASTs across multi-line/nested blockquotes, blockquote lists/fences/indents, and Setext =/==/-- lines', async () => {
  const { prose, inline } = await import('../../src/render/markdown.mjs');
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  // 1. Multi-line "> " blockquote paragraph shares one inline container (regression in de589627)
  const bqMultiStrict = '> alpha \\_open and \\*star and \\~\\~strike and \\$math\n> beta close\\_ and star\\* and strike\\~\\~ and math\\$';
  const bqMultiRelaxed = relaxEscapes(bqMultiStrict);
  assert.equal(cmRender(bqMultiRelaxed).includes('<em'), false, `expected zero <em> in multi-line blockquote: ${bqMultiRelaxed}`);
  const gfmBqMulti = gfmRender(bqMultiRelaxed);
  assert.equal(gfmBqMulti.includes('<del'), false, `expected zero <del> in multi-line blockquote: ${bqMultiRelaxed}`);
  assert.equal(gfmBqMulti.includes('class="math'), false, `expected zero math in multi-line blockquote: ${bqMultiRelaxed}`);

  // 2. Lazy blockquote continuation "> \_u1\nu2\_" also shares one inline container, while "> quote\n2. \# h" interrupts
  const bqLazyStrict = '> alpha \\_open and \\~\\~strike\nbeta close\\_ and strike\\~\\~';
  const bqLazyRelaxed = relaxEscapes(bqLazyStrict);
  assert.equal(cmRender(bqLazyRelaxed).includes('<em'), false, `expected zero <em> in lazy blockquote continuation: ${bqLazyRelaxed}`);
  assert.equal(gfmRender(bqLazyRelaxed).includes('<del'), false, `expected zero <del> in lazy blockquote continuation: ${bqLazyRelaxed}`);

  // 3. Nested list in blockquote, 2-3 spaces after ">", and nested "> >" preserve "\#" at block start
  for (const [label, strict] of [
    ['bq-list', '> - \\# not-a-heading'],
    ['bq-spaces', '>   \\# not-a-heading'],
    ['bq-nested', '> > \\# not-a-heading'],
    ['bq-then-olist2', '> quote\n2. \\# not-a-heading'],
  ]) {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed).includes('<h1'), false, `expected zero <h1> in CommonMark for ${label}: ${relaxed}`);
    assert.equal(gfmRender(relaxed).includes('<h1'), false, `expected zero <h1> in Pandoc GFM for ${label}: ${relaxed}`);
  }

  // 4. Fenced code block inside blockquote preserves literal backslashes
  const bqFence = '> ```\n> \\_literal_in_bq_fence\n> ```';
  assert.equal(relaxEscapes(bqFence), bqFence);

  // 5. prose() and inline() escape Setext =, ==, and -- after a newline so neither forms a Setext heading
  for (const ul of ['=', '==', '--']) {
    const pMd = relaxEscapes(prose(`Title line\n${ul}`));
    assert.equal(/<h[12]/i.test(cmRender(pMd)), false, `prose must not form Setext heading for ${JSON.stringify(ul)}: ${pMd}`);
    const iMd = relaxEscapes(inline([`Title line\n`, ul], new Map()));
    assert.equal(/<h[12]/i.test(cmRender(iMd)), false, `inline must not form Setext heading for ${JSON.stringify(ul)}: ${iMd}`);
  }
});

test('[Canon-v2 SitRep R36-DEFECTS-NEG] verifySiteBundle rejects resealed non-table \\| link-dest pipe escapes and Setext =/==/-- heading underlines with anchor-parity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r36-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'Non-table pipe link ',
          { link: { text: 'pipe-url', href: 'https://example.org/x?p=a|b' } },
          ' and bs-pipe link ',
          { link: { text: 'bs-pipe-url', href: 'https://example.org/x?p=a\\|b' } },
          '.',
        ],
      },
      { type: 'paragraph', text: 'Forged H1 Single =' },
      { type: 'paragraph', text: 'Forged H1 Double ==' },
      { type: 'paragraph', text: 'Forged H2 Single -' },
      { type: 'paragraph', text: 'Forged H2 Double --' },
    );

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r36-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    const baseVer = await verifySiteBundle(baseBundle);
    assert.equal(baseVer.ok, true, `baseBundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r36-1a-non-table-link-dest-escaped-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '[pipe-url](https://example.org/x?p=a|b)', '[pipe-url](https://example.org/x?p=a\\|b)'),
      },
      {
        name: 'r36-1b-non-table-link-dest-triple-backslash-pipe',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, '[bs-pipe-url](https://example.org/x?p=a\\\\|b)', '[bs-pipe-url](https://example.org/x?p=a\\\\\\|b)'),
      },
      {
        name: 'r36-3a-setext-h1-single-equals',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Forged H1 Single =', 'Forged H1 Single\n='),
      },
      {
        name: 'r36-3b-setext-h1-double-equals',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Forged H1 Double ==', 'Forged H1 Double\n=='),
      },
      {
        name: 'r36-3c-setext-h2-single-hyphen',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Forged H2 Single -', 'Forged H2 Single\n-'),
      },
      {
        name: 'r36-3d-setext-h2-double-hyphen',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(b, targetMd, 'Forged H2 Double --', 'Forged H2 Double\n--'),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode && (!c.expectedMsg || e.message.includes(c.expectedMsg)))) {
          failures.push(`${c.name}: missing ${c.expectedCode}${c.expectedMsg ? ` (${c.expectedMsg})` : ''}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R36 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R37-DEFECTS-POS] verifySiteBundle accepts GFM table cells combining backtick+pipe https: link destinations (`?q=`|ok`) with even-backslash code-span pipes (`c\\\\|2`) via raw-table destMode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r37-pos-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push({
      type: 'table',
      id: 'tbl-r37-pos',
      caption: 'GFM table backtick+pipe URL followed by double-backslash code span',
      columns: [
        { key: 'k', label: 'Case' },
        { key: 'v', label: 'Cell' },
      ],
      rows: [
        {
          k: 'combo',
          v: [
            { link: { text: 'combo-bt-pipe', href: 'https://example.org/x?q=`|ok' } },
            ' and ',
            { code: 'c\\|2' },
          ],
        },
      ],
    });

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r37-pos.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const res = await verifySiteBundle(outDir);
    assert.equal(res.ok, true, `expected R37 positive bundle to verify cleanly, got ${JSON.stringify(res.errors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R37-DEFECTS-REL-SOUNDNESS] prose() escapes non-final Setext/HR lines and relaxEscapes preserves CommonMark §2.2 tab columns, GFM §4.10 table+2. interruption, and CommonMark §4.7 reference definitions', async () => {
  const { prose } = await import('../../src/render/markdown.mjs');
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  // 1. R37-DEFECT-1: non-final Setext (=, ==, ===, --, ---) and thematic break (---) lines in multi-line prose()
  for (const ul of ['=', '==', '===', '--', '---']) {
    const threeLineMd = relaxEscapes(prose(`Title line\n${ul}\nAfter heading`));
    assert.equal(/<h[12]|<hr/i.test(cmRender(threeLineMd)), false, `CommonMark must not form heading/hr for non-final ${JSON.stringify(ul)}: ${threeLineMd}`);
    assert.equal(/<h[12]|<hr/i.test(gfmRender(threeLineMd)), false, `Pandoc GFM must not form heading/hr for non-final ${JSON.stringify(ul)}: ${threeLineMd}`);
  }
  const leadingHrMd = relaxEscapes(prose('---\nAfter break'));
  assert.equal(/<hr/i.test(cmRender(leadingHrMd)), false, `CommonMark must not form <hr> on leading ---: ${leadingHrMd}`);
  assert.equal(/<hr/i.test(gfmRender(leadingHrMd)), false, `Pandoc GFM must not form <hr> on leading ---: ${leadingHrMd}`);

  // 2. R37-DEFECT-2: CommonMark §2.2 4-column tab expansion & §5.2 Rule 2 (>4 post-marker columns => indented code)
  for (const [label, strict] of [
    ['bq-tab-code', '>\t  \\_lit'],
    ['ul-tab-code', '-\t  \\_lit'],
    ['ol-tab-code', '1.\t   \\_lit'],
    ['ul-5sp-code', '-     \\_lit'],
  ]) {
    const relaxed = relaxEscapes(strict);
    assert.equal(relaxed, strict, `expected ${label} indented code line to remain untouched, got ${JSON.stringify(relaxed)}`);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mismatch for ${label}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM AST mismatch for ${label}`);
  }

  // 3. R37-DEFECT-3(A): GFM §4.10 table interrupted by "2. " (top-level and inside blockquote) preserves both GFM \# and CommonMark \_
  for (const [label, strict] of [
    ['top-table-olist2', '| A \\_u1 | B |\n| --- | --- |\n2. \\# not-a-heading u2\\_'],
    ['bq-table-olist2', '> | A \\_u1 | B |\n> | --- | --- |\n> 2. \\# not-a-heading u2\\_'],
  ]) {
    const relaxed = relaxEscapes(strict);
    assert.equal(gfmRender(relaxed).includes('<h1'), false, `Pandoc GFM must not form <h1> after GFM table for ${label}: ${relaxed}`);
    assert.equal(cmRender(relaxed).includes('<em'), false, `CommonMark must not form <em> across table+2. for ${label}: ${relaxed}`);
  }

  // 4. R37-DEFECT-3(B): General CommonMark §4.7 link reference definitions (spaces, leading spaces, titles, multiline, blockquote)
  for (const [label, strict] of [
    ['space-label', '[foo bar]: /url\n\nSee \\[foo bar\\] now.'],
    ['indented-def', '  [foo]: /url\n\nSee \\[foo\\] now.'],
    ['titled-def', '[foo]: /url "title"\n\nSee \\[foo\\] now.'],
    ['multiline-dest', '[foo]:\n  /url\n\nSee \\[foo\\] now.'],
    ['multiline-label', '[foo\nbar]: /url\n\nSee \\[foo bar\\] now.'],
    ['bq-def', '> [foo]: /url\n\nSee \\[foo\\] now.'],
  ]) {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed).includes('<a '), false, `CommonMark must not link escaped shortcut for ${label}: ${relaxed}`);
    assert.equal(gfmRender(relaxed).includes('<a '), false, `Pandoc GFM must not link escaped shortcut for ${label}: ${relaxed}`);
  }
});

test('[Canon-v2 SitRep R37-DEFECTS-NEG] verifySiteBundle rejects resealed GFM table cell 33-paren link destinations and even-backslash URL pipes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r37-neg-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const p33o = '('.repeat(33);
    const p33c = ')'.repeat(33);
    const esc33o = '\\('.repeat(33);
    const esc33c = '\\)'.repeat(33);

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push({
      type: 'table',
      id: 'tbl-r37-neg',
      caption: 'R37 GFM table link-dest probes',
      columns: [
        { key: 'c1', label: 'Col 1' },
        { key: 'c2', label: 'Col 2' },
      ],
      rows: [
        {
          c1: [{ link: { text: 't33', href: `https://example.org/#${p33o}x${p33c}` } }],
          c2: [{ link: { text: 'tpipe', href: 'https://example.org/x?q=`|ok' } }, ' and ', { code: 'c\\|2' }],
        },
      ],
    });

    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r37-neg.site-input.json');
    const baseBundle = join(dir, 'base-site');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir: baseBundle });
    assert.equal((await verifySiteBundle(baseBundle)).ok, true);

    const resealDir = async (bundleDir) => {
      const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bundleDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bundleDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bundleDir, 'checksums.json'), canonicalBytes(checksums));
    };

    const replaceInMd = async (bundleDir, relPath, from, to) => {
      const mp = join(bundleDir, relPath);
      const md = await readFile(mp, 'utf8');
      const next = md.replace(from, () => to);
      assert.notEqual(next, md, `expected ${JSON.stringify(from)} in ${relPath}`);
      await writeFile(mp, next);
    };

    const targetMd = 'item/wal-standby-ring/index.md';
    const negCases = [
      {
        name: 'r37-table-cell-33-unescaped-parens-link-dest',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          `[t33](https://example.org/#${esc33o}x${esc33c})`,
          `[t33](https://example.org/#${p33o}x${p33c})`,
        ),
      },
      {
        name: 'r37-table-cell-even-backslash-pipe-in-backtick-url',
        expectedCode: 'anchor-parity',
        mutate: (b) => replaceInMd(
          b,
          targetMd,
          '[tpipe](https://example.org/x?q=`\\|ok)',
          '[tpipe](https://example.org/x?q=`\\\\|ok)',
        ),
      },
    ];

    const failures = [];
    for (const c of negCases) {
      const caseDir = join(dir, `site-${c.name}`);
      await cp(baseBundle, caseDir, { recursive: true });
      await c.mutate(caseDir);
      await resealDir(caseDir);
      const res = await verifySiteBundle(caseDir);
      if (res.ok) {
        failures.push(`${c.name}: got ok: true`);
      } else {
        if (!res.errors.some((e) => e.code === c.expectedCode)) {
          failures.push(`${c.name}: missing ${c.expectedCode}, got ${JSON.stringify(res.errors)}`);
        }
        if (res.errors.some((e) => e.code === 'schema' || e.code === 'checksum' || e.code === 'checksums-disagree' || e.code === 'content-id' || e.code === 'byte-length')) {
          failures.push(`${c.name}: inert-control integrity/schema error ${JSON.stringify(res.errors)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `expected all R37 negative cases to be rejected cleanly: ${failures.join('; ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R38-DEFECTS-REL-SOUNDNESS] relaxEscapes preserves CommonMark 0.31.2 & Pandoc GFM ASTs across innerRawCol%4!=0 tabs, arbitrary nested containers, reference boundaries, footnotes, cross-line brackets, and seeded fuzzing', async () => {
  const { prose } = await import('../../src/render/markdown.mjs');
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };

  // 1. R38-DEFECT-1: tabs when innerRawCol % 4 !== 0
  const defect1Cases = [
    ['bq-space-tab-atx', '> \t\\# not-a-heading'],
    ['bq-space-tab-list-atx', '> \t- \\# not-a-heading'],
    ['bq-space-tab-bq-atx', '> \t> \\# not-a-heading'],
    ['bq-space-tab-fence', '> \t```\n> \\_singlelit\n> \t```'],
    ['bq-space-tab-html6', '> \t<div>\n> \\_rawhtml\n> \t</div>'],
    ['bq-space-tab-setext-olist2', '> para\n> \t==\n> 2. \\# not-a-heading'],
    ['bq-space-tab-refdef', '> \t[foo]: /url\n\nSee \\[foo\\] now.'],
    ['bq-nospace-tab-atx', '>>\t\\# not-a-heading'],
  ];
  for (const [label, strict] of defect1Cases) {
    assertAstConserved(`R38-1:${label}`, strict);
  }

  // 2. R38-DEFECT-2: nested container peeling, >=4-col list continuations, refdef boundaries, & Pandoc footnotes
  const defect2Cases = [
    ['list-bq-atx', '- > \\# not-a-heading'],
    ['list-list-atx', '- - \\# not-a-heading'],
    ['list-fence', '- ```\n  \\_singlelit\n  ```'],
    ['indented-list-cont-atx', '  - item\n    \\# not-a-heading'],
    ['indented-list-cont-ul', '  - item\n    \\- not-a-sublist'],
    ['para-then-bq-refdef', 'para\n> [foo]: /url\n\nSee \\[foo\\] now.'],
    ['setext-then-refdef', 'Heading\n===\n[foo]: /url\n\nSee \\[foo\\] now.'],
    ['list-bq-refdef', '- > [foo]: /url\n\nSee \\[foo\\] now.'],
    ['list-4col-multi-refdef', '-   [foo]: /url1\n    [bar]: /url2\n\nSee \\[bar\\] now.'],
    ['indented-list-blank-refdef', '  - item\n\n    [foo]: /url\n\nSee \\[foo\\] now.'],
    ['pandoc-gfm-footnote', '[^1]: note body\n\nSee \\[^1\\] in mid-line.'],
  ];
  for (const [label, strict] of defect2Cases) {
    assertAstConserved(`R38-2:${label}`, strict);
  }

  // 3. R38-DEFECT-3: cross-line escaped brackets (including prose() + relaxEscapes()) & kept-escape label matching
  const defect3Cases = [
    ['prose-crossline-shortcut-1', `${prose('See [\nE1] now.')}\n\n[E1]: #ev-1\n`],
    ['prose-crossline-shortcut-2', `${prose('See [E1\n] now.')}\n\n[E1]: #ev-1\n`],
    ['prose-crossline-full-ref', `${prose('See [click][\nE1] now.')}\n\n[E1]: #ev-1\n`],
    ['prose-crossline-collapsed-ref', `${prose('See [\nE1][] now.')}\n\n[E1]: #ev-1\n`],
    ['prose-crossline-img-ref', `${prose('See ![\nE1] now.')}\n\n[E1]: #ev-1\n`],
    ['prose-crossline-anchor-ref', `${prose('See [\ns-1] now.')}\n\n[s-1]: #s-1\n`],
    ['raw-crossline-bang-bracket-img', '[foo bar]: /url.png\n\nSee \\!\\[foo\nbar\\] now.'],
    ['kept-pipe-escape-in-label', '[foo\\|bar]: /url\n\nSee \\[foo\\|bar\\] now.'],
    ['kept-paren-escape-in-label', '[foo\\(bar]: /url\n\nSee \\[foo\\(bar\\] now.'],
    ['nested-kept-label', '[outer \\[E1\\]]: /outer\n[E1]: /inner\n\nSee \\[outer \\[E1\\]\\] now.'],
    ['footnote-kept-in-label', '[foo\\[^1]: /url\n\nSee \\[foo\\[^1\\] now.'],
    ['raw-refdef-kept-escape', '[foo\\!bar]: /url\n\n[foo!bar]'],
    ['lazy-html7-divergence', '> para\n<custom>\n    \\=\\='],
    ['refdef-setext-empty-rem', '[foo]: /url\n==\n2. \\# not-a-heading\n\nSee \\[foo\\] now.'],
    ['refdef-hr-empty-rem', '[foo]: /url\n---\n2. \\# not-a-heading\n\nSee \\[foo\\] now.'],
    ['table-then-indented-code-emph', '| \\_a |\n| - |\n    four_spaces_'],
    ['empty-list-blank-line-code', '  -\n\n    \\_code'],
  ];
  for (const [label, strict] of defect3Cases) {
    assertAstConserved(`R38-3:${label}`, strict);
  }

  // Non-vacuity / over-retention instrument controls: 1-line safe escapes still relax cleanly
  assert.equal(relaxEscapes('>   \\# not-indented-code\n\nsolo \\[unclosed end\n\nsolo unclosed\\] end'), '>   \\# not-indented-code\n\nsolo [unclosed end\n\nsolo unclosed] end');
  assert.equal(relaxEscapes('> - item \\_solo\n\n  - cont \\_solo2'), '> - item _solo\n\n  - cont _solo2');

  // 4. Deterministic seeded multi-line container/tab/bracket/footnote AST-conservation fuzzer (250 documents batched)
  let seed = 0x52333846;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const pick = (arr) => arr[rnd() % arr.length];
  const prefixes = ['', '> ', '>\t', '> \t', '>> ', '- ', '-\t', '  - ', '    ', '1. ', '2. ', '- > ', '> - '];
  const payloads = [
    '\\# h', '\\- b', '2\\. n', '\\= eq', '\\_u1', 'u2\\_', '\\*s1', 's2\\*', '\\~\\~st1', 'st2\\~\\~',
    '\\$m1', 'm2\\$', 'See \\[\nE1\\] x', 'See \\!\\[E1\\](https&#58;//example.org)', 'See \\[^1\\] fn',
    '\\[foo\\|bar\\]', '```\n\\_code\n```', '<div>\n\\_html\n</div>', '[E1]: #ev-1', '[foo\\|bar]: /u', '[^1]: n', '',
  ];
  for (let docIdx = 0; docIdx < 120; docIdx += 1) {
    const docLines = [];
    const nLines = 4 + (rnd() % 6);
    for (let l = 0; l < nLines; l += 1) {
      docLines.push(`${pick(prefixes)}${pick(payloads)}`);
    }
    docLines.push('', '[E1]: #ev-1', '[foo\\|bar]: /u', '[^1]: note');
    const strictDoc = docLines.join('\n');
    assertAstConserved(`fuzz-${docIdx}`, strictDoc);
  }
});

test('[Canon-v2 SitRep R39-DEFECTS-EMOJI] markdown.mjs and relax.mjs neutralize Pandoc GFM +emoji shortcodes (:100:, :x:, :v:, :smile:, :+1:, :non_potable_water:) across single and split segments while relaxing non-emoji colons and verifying cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r39-emoji-'));
  try {
    const { prose } = await import('../../src/render/markdown.mjs');
    const { relaxEscapes } = await import('../../src/render/relax.mjs');
    const gfmRender = (md) => {
      const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    };

    for (const sample of [
      ':100:!',
      ':x:!',
      ':v:.',
      'Status is :smile: today',
      ':+1:',
      ':-1:',
      ':1234:',
      'a:100:b',
      ':notemoji:100:',
      ':00:100:',
      ':non_potable_water:',
    ]) {
      const strict = prose(sample);
      const relaxed = relaxEscapes(strict);
      assert.equal(gfmRender(strict).includes('class="emoji"'), false, `strict prose leaked emoji Span on ${sample}: ${strict}`);
      assert.equal(gfmRender(relaxed).includes('class="emoji"'), false, `relaxed prose leaked emoji Span on ${sample}: ${relaxed}`);
    }

    // Instrument control: ordinary colons and HH:MM:SS timestamps relax completely (and ISO T14:00:00Z relaxes the :00: closing colon)
    const cleanSample = 'Ratio 100:1 and Note: ok at 14:00:00';
    assert.equal(relaxEscapes(prose(cleanSample)), cleanSample);
    assert.equal(relaxEscapes(prose('2026-09-28T14:00:00Z')), '2026-09-28T14&#58;00:00Z');

    // Full buildSiteBundle + verifySiteBundle round-trip including split inline segments
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');
    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      { type: 'paragraph', text: 'Single: :100:! :x:! :v:. Status is :smile: today and :non_potable_water:.' },
      { type: 'paragraph', text: [{ text: ':smile' }, { text: ':' }, ' ', { text: ':+1' }, { text: ':' }, ' ', { text: ':' }, { text: '100' }, { text: ':' }, ' ', { text: ':non_potable' }, { text: '_water:' }] },
    );
    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r39-emoji.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const ver = await verifySiteBundle(outDir);
    assert.equal(ver.ok, true, `expected R39 emoji site bundle to verify cleanly, got ${JSON.stringify(ver.errors)}`);
    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    assert.equal(gfmRender(itemMd).includes('class="emoji"'), false, `item index.md leaked Pandoc emoji Span:\n${itemMd}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R39-DEFECTS-REL-SOUNDNESS] relaxEscapes runs dual CommonMark 0.31.2 & Pandoc GFM block/inline analyses conserving lazy container tables, >=4-col fake table delimiters, +alerts, +footnotes, +yaml_metadata_block, and multi-line inline code/HTML/dest/math spans', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const gfmJson = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'json'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmJson(relaxed), gfmJson(strict), `Pandoc GFM JSON AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };

  // 1. R39-DEFECT-1 direct relaxEscapes emoji conservation
  for (const [label, strict] of [
    ['relax-100-bang', ':100&#58;!'],
    ['relax-x-bang', ':x&#58;!'],
    ['relax-v-dot', ':v&#58;.'],
    ['relax-smile-end', ':smile&#58;'],
    ['relax-plus1-end', ':+1&#58;'],
    ['relax-open-smile', '&#58;smile:'],
  ]) {
    assertAstConserved(`R39-1:${label}`, strict);
  }

  // 2. R39-DEFECT-2: dual-reader block/container divergences, >=4-col fake table delim, +alerts, +footnotes, +yaml_metadata_block
  for (const [label, strict] of [
    ['bq-table-lazy-then-bq-emph', '> | \\_a | b |\n> | --- | --- |\nlazy\n> u2\\_'],
    ['list-table-lazy-then-list-emph', '- | \\_a | b |\n  | --- | --- |\nlazy\n  u2\\_'],
    ['bq-table-lazy-setext-then-olist2', '> | a | b |\n> | - | - |\nlazy\n> ==\n> 2. \\# not-a-heading'],
    ['bq-table-lazy-then-top-olist2', '> | a | b |\n> | - | - |\nlazy\n2. \\# not-a-heading'],
    ['bq-indented-4col-fake-table-delim', '> | a | b |\n>     | - | - |\nlazy\n2. \\# not-a-heading'],
    ['alert-then-indented-code', '> [!NOTE]\n    \\_code'],
    ['alert-then-olist2', '> [!NOTE]\n> 2. \\# not-a-heading'],
    ['alert-lowercase-trail-ws', '> [!warning]   \n> 2. \\# not-a-heading'],
    ['alert-in-list', '- > [!CAUTION]\n  > 2. \\# not-a-heading'],
    ['fn-def-then-top-olist2', 'See [^1].\n\n[^1]: note body\n2. \\# not-a-heading'],
    ['fn-def-same-line-atx', 'See [^1].\n\n[^1]: \\# not-a-heading'],
    ['fn-def-same-line-list', 'See [^1].\n\n[^1]: - \\# not-a-heading'],
    ['fn-def-same-line-bq', 'See [^1].\n\n[^1]: > \\# not-a-heading'],
    ['fn-def-4sp-code', 'See [^1].\n\n[^1]:    \\_code'],
    ['yaml-metadata-block', '---\ntitle: \\_foo\n---\n2. \\# not-a-heading'],
  ]) {
    assertAstConserved(`R39-2:${label}`, strict);
  }

  // 3. R39-DEFECT-3: multi-line inline code spans, multi-line inline raw HTML, multi-line inline link dest, and Pandoc math spans
  for (const [label, strict] of [
    ['multiline-inline-code', 'open `\n\\_code\n` close'],
    ['multiline-inline-triple-tick-in-para', 'para\n    ```\n    \\_code\n    ```'],
    ['multiline-inline-html-comment', 'open <!--\n\\_comment\n--> close'],
    ['multiline-inline-html-tag-attr', 'open <span\ndata-x="\\_attr"> close'],
    ['multiline-inline-html-pi', 'open <?\n\\_pi\n?> close'],
    ['multiline-inline-html-cdata', 'open <![CDATA[\n\\_cdata\n]]> close'],
    ['multiline-inline-html-decl', 'open <!DECL\n\\_decl> close'],
    ['multiline-inline-link-dest', 'open [lbl](\n/\\_url\n"\\_title") close'],
    ['pandoc-inline-math-underscore', '$\\_a$'],
    ['pandoc-display-math-multiline', '$$\n\\_a\n$$'],
    ['pandoc-inline-math-multiline', '$a\n\\_b$'],
  ]) {
    assertAstConserved(`R39-3:${label}`, strict);
  }

  // 4. Deterministic seeded fuzzer across tables, lazy lines, alerts, footnotes, multi-line code/HTML, and emojis (100 docs)
  let seed = 0x52333946;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const pick = (arr) => arr[rnd() % arr.length];
  const prefixes = ['', '> ', '>\t', '> \t', '- ', '  - ', '    ', '1. ', '2. ', '- > '];
  const payloads = [
    '\\# h', '2. \\# h', '\\_u1', 'u2\\_', '| \\_a | b |\n| - | - |', 'lazy', '==',
    '[!NOTE]', '[^1]: note', 'open `\n\\_c\n` x', 'open <span\nx="\\_a"> y',
    ':100&#58;!', '&#58;smile:', '$\\_m$', '',
  ];
  for (let d = 0; d < 100; d += 1) {
    const ls = [];
    const n = 4 + (rnd() % 6);
    for (let k = 0; k < n; k += 1) ls.push(`${pick(prefixes)}${pick(payloads)}`);
    ls.push('', 'See [^1].', '[E1]: #ev-1');
    assertAstConserved(`r39-fuzz-${d}`, ls.join('\n'));
  }
});

test('[Canon-v2 SitRep R40-DEFECTS-EMOJI] joinPieces neutralizes cross-segment Pandoc GFM +emoji shortcodes containing prose-escaped \\+, \\-, and \\-- segments across SiteBundle and Packet builds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r40-emoji-'));
  try {
    const gfmRender = (md) => {
      const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    };
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push({
      type: 'paragraph',
      text: [
        { text: ':' }, { text: '+' }, { text: '1:' }, ' ',
        { text: ':' }, { text: '-' }, { text: '1:' }, ' ',
        { text: ':e' }, { text: '-' }, { text: 'mail:' }, ' ',
        { text: ':non' }, { text: '-' }, { text: 'potable_water:' }, ' ',
        { text: ':smile' }, { text: '--' }, { text: 'test:' },
      ],
    });
    assert.doesNotThrow(() => validateSiteInput(input));
    const inPath = join(dir, 'r40-emoji.site-input.json');
    const outDir = join(dir, 'out');
    await writeFile(inPath, JSON.stringify(input, null, 2));
    await buildSiteBundle({ sitePath: inPath, outDir });
    const ver = await verifySiteBundle(outDir);
    assert.equal(ver.ok, true, `expected R40 emoji site bundle to verify cleanly, got ${JSON.stringify(ver.errors)}`);
    const itemMd = await readFile(join(outDir, 'item/wal-standby-ring/index.md'), 'utf8');
    assert.equal(gfmRender(itemMd).includes('class="emoji"'), false, `item index.md leaked Pandoc emoji Span:\n${itemMd}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R40-DEFECTS-REL-SOUNDNESS] relaxEscapes derives all opaque spans from container-wide CommonMark §6.1/§6.3/§6.6 + Pandoc GFM scanners and handles pipeless table ~~~ fences and whitespace footnote labels', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };

  const p33 = `${'('.repeat(33)}u${')'.repeat(33)}`;
  const p33Emph = `${'('.repeat(33)}_a${')'.repeat(33)}`;

  // 1. R40-DEFECT-2: phantom line-local destinationEnd / findRun opaques, bracket-less ](...), 33-paren differential, $...$<digit>, and GFM cell pipe-before-backtick
  for (const [label, strict] of [
    ['fake-dest-spaces', '[x](not a url _a) b\\_'],
    ['ref-link-then-fake-dest', '[E1]: #ev-1\n\n[E1](not a url _a) b\\_'],
    ['unclosed-dest-multiline', '[x](unclosed _a\nb\\_'],
    ['escaped-open-bracket-fake-dest', '\\[x](not a url _a) b\\_'],
    ['33-parens-dest-emph', `[lbl](${p33Emph}) b\\_`],
    ['33-parens-dest-title-emph', `[lbl](${p33} '_a') b\\_`],
    ['unmatched-close-bracket-multiline-dest', "text ](\n/url '_a'\n) b\\_"],
    ['collapsed-ref-then-multiline-dest', "[E1][](\n/url '_a'\n) b\\_\n\n[E1]: #ev-1"],
    ['full-ref-then-multiline-dest', "[lbl][E1](\n/url '_a'\n) b\\_\n\n[E1]: #ev-1"],
    ['nested-link-deactivates-outer-link', "[[inner](u)](\n/url '_a'\n) b\\_"],
    ['image-around-link-stays-active', "![[inner](u)](\n/url '_a'\n) b\\_"],
    ['fn-ref-then-paren-in-gfm', '[^1]: note\n\n[^1](/url "_a") b\\_'],
    ['multiline-code-gap-emph', 'open `\nlegit1 ` _a ` tail\n` b\\_'],
    ['multiline-code-gap-strike', 'open `\nlegit1 ` ~~a ` tail\n` b\\~\\~'],
    ['pandoc-math-closer-before-digit', '$\\_b$1'],
    ['gfm-table-pipe-splits-before-backtick', '| h1 | h2 |\n| - | - |\n| `a | _b` \\_c |'],
  ]) {
    assertAstConserved(`R40-2:${label}`, strict);
  }

  // 2. R40-DEFECT-3: pipeless GFM table row ~~~ fences in cm & whitespace-containing Pandoc GFM footnote labels
  for (const [label, strict] of [
    ['pipeless-table-row-tilde-fence', 'a | b\n--- | ---\n\\~\\~\\~ | c\n\\_inside\n~~~'],
    ['pipeless-table-row-indented-tilde-fence', 'a | b\n--- | ---\n   \\~\\~\\~ | c\n\\_inside\n~~~'],
    ['bq-pipeless-table-row-tilde-fence', '> a | b\n> --- | ---\n> \\~\\~\\~ | c\n> \\_inside\n> ~~~'],
    ['fn-space-label-then-olist2', 'See [^a b].\n\n[^a b]: note\n2. \\# h'],
    ['fn-tab-label-then-olist2', 'See [^\ta].\n\n[^\ta]: note\n2. \\# h'],
    ['table-interrupted-by-space-fn-label', 'See [^a b].\n\n| x | y |\n| - | - |\n[^a b]: note\n2. \\# h'],
  ]) {
    assertAstConserved(`R40-3:${label}`, strict);
  }

  // Non-vacuity instrument controls: valid inline link & leading-pipe table ~~~ still relax cleanly
  assert.equal(relaxEscapes('[x](/url "_a") b\\_'), '[x](/url "_a") b_');
  assert.equal(relaxEscapes('| \\~\\~\\~ | c |\n| --- | --- |'), '| ~~~ | c |\n| --- | --- |');
});

test('[Canon-v2 SitRep R41-DEFECTS-REL-SOUNDNESS] relaxEscapes preserves multi-line reference link/image labels, GFM §6.9 bare URL/www/email autolinks and preventing backslash escapes, backslash-escaped :shortcode: interiors, and escaped-bracket footnote refs', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };

  // 1. R41-DEFECT-1: multi-line reference link & reference image labels with interior escapes
  for (const [label, strict] of [
    ['multiline-shortcut-ref', '[multi\na\\!b]: /url\n\n[multi\na\\!b]'],
    ['multiline-collapsed-ref', '[multi\na\\!b]: /url\n\n[multi\na\\!b][]'],
    ['multiline-full-ref', '[multi\na\\!b]: /url\n\n[click][multi\na\\!b]'],
    ['multiline-ref-escaped-brackets', '[multi label with \\[foo\\] inside]: /url\n\n[multi\nlabel with \\[foo\\] inside]'],
    ['multiline-ref-image', '[multi\na\\!b]: /url\n\n![multi\na\\!b]'],
    ['bq-multiline-shortcut-ref', '> [multi\n> a\\!b]: /url\n>\n> [multi\n> a\\!b]'],
  ]) {
    assertAstConserved(`R41-1:${label}`, strict);
  }

  const at = '@';
  // 2. R41-DEFECT-2: active GFM §6.9 bare URL/www autolinks & autolink-preventing backslash escapes
  for (const [label, strict] of [
    ['bare-https-in-bracket-swallows-dest', '[https://example.com](/url "_a") b\\_'],
    ['bare-www-in-bracket-swallows-dest', '[www.example.com](/url "_a") b\\_'],
    ['bare-ftp-in-bracket-swallows-dest', '[ftp://example.com](/url "_a") b\\_'],
    ['bare-https-swallows-inline-link', 'https://example.com/[x](/url "_a") b\\_'],
    ['bare-www-swallows-inline-link', 'www.example.com/[x](/url "_a") b\\_'],
    ['bare-https-internal-underscore', 'https://example.com/foo\\_bar b\\_'],
    ['bare-https-trailing-escaped-paren', 'https://example.com/a\\)b'],
    ['www-escaped-dot-prevents-autolink', 'www\\.example.com/path'],
    ['www-escaped-dot-before-codespan', 'www\\.e.com``a`b``'],
    ['email-escaped-dot-local', `user\\.name${at}example.com`],
    ['email-escaped-plus-local', `user\\+tag${at}example.com`],
    ['email-escaped-dash-local', `user\\-name${at}example.com`],
    ['email-escaped-underscore-local', `user\\_name${at}example.com`],
    ['email-escaped-dot-domain', `user${at}example\\.com`],
    ['email-escaped-dash-domain', `user${at}my\\-domain.com`],
    ['email-escaped-underscore-domain', `user${at}my\\_domain.com`],
  ]) {
    assertAstConserved(`R41-2:${label}`, strict);
  }

  // 3. R41-DEFECT-3: backslash-escaped \+, \-, \_ inside raw :shortcode: candidates
  for (const [label, strict] of [
    ['emoji-esc-plus1', ':\\+1:'],
    ['emoji-esc-minus1', ':\\-1:'],
    ['emoji-esc-email-dash', ':e\\-mail:'],
    ['emoji-esc-white-check-mark', ':white\\_check\\_mark:'],
    ['emoji-esc-non-potable-water', ':non\\-potable\\_water:'],
  ]) {
    assertAstConserved(`R41-3:${label}`, strict);
  }

  // 4. R41-DEFECT-4: escaped-bracket Pandoc GFM footnote references
  for (const [label, strict] of [
    ['fn-ref-escaped-close-bracket', '[^a\\]b]: note\n\n[^a\\]b](/url "_a") b\\_'],
    ['fn-ref-escaped-open-bracket', '[^a\\[b]: note\n\n[^a\\[b](/url "_a") b\\_'],
  ]) {
    assertAstConserved(`R41-4:${label}`, strict);
  }

  // Non-vacuity instrument controls: &#64; email and &#58; emoji prose still relax intraword \_ cleanly
  assert.equal(relaxEscapes('ops\\_team&#64;example.com'), 'ops_team&#64;example.com');
  assert.equal(relaxEscapes('&#58;non\\_potable\\_water:'), '&#58;non_potable_water:');
});

test('[Canon-v2 SitRep R42-DEFECTS-REL-SOUNDNESS] relaxEscapes evaluates \\[...\\] shortcut collisions post-intersection across cm∪gfm labels, matches Pandoc Autolink.hs bare email/domain/< path rules, and preserves trailing \\_ and \\- after bare emails', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };
  const at = '@';

  // 1. R42-DEFECT-1: cross-model disjoint interior escapes & asymmetric reference definitions in \[...\] and \!\[...\]
  for (const [label, strict] of [
    ['disjoint-cm-gfm-interior-escapes', '[a\\* \\_c]: /url\n\n[^fn]: note\n\n[^fn](/url "*x") $_y$ \\[a\\* \\_c\\] end'],
    ['disjoint-bang-bracket-shortcut-link', '[a\\* \\_c]: /url\n\n[^fn]: note\n\n[^fn](/url "*x") $_y$ \\!\\[a\\* \\_c\\] end'],
    ['gfm-only-refdef-after-table', '| h1 | h2 |\n| -- | -- |\n[a \\_c]: /url\n\n$_y$ \\[a \\_c\\] end'],
    ['cm-only-refdef-after-fn-def', '[^fn]: note\n[a \\*c]: /url\n\n[^fn](/url "*x") \\[a \\*c\\] end'],
  ]) {
    assertAstConserved(`R42-1:${label}`, strict);
  }

  // 2. R42-DEFECT-2: Pandoc Autolink.hs bare email precedence before www., trailing -/_ domain rejection, & < path recovery
  for (const [label, strict] of [
    ['bare-email-precedes-www-domain', `[^fn]: note\n\n[^fn](/url "user${at}www.example.com/_a") b\\_`],
    ['mailto-bare-email-precedes-www', `[^fn]: note\n\n[^fn](/url "mailto:user${at}www.example.com/_a") b\\_`],
    ['trailing-hyphen-in-domain-label', '[^fn]: note\n\n[^fn](/url "https://a-.com/_a") b\\_'],
    ['trailing-underscore-in-domain-label', '[^fn]: note\n\n[^fn](/url "https://a_.com/_a") b\\_'],
    ['www-trailing-hyphen-domain', '[^fn]: note\n\n[^fn](/url "www.a-.com/_a") b\\_'],
    ['leading-hyphen-domain-still-autolinks', 'https://-a.com/foo\\_bar b\\_'],
    ['leading-underscore-domain-still-autolinks', 'https://_a.com/foo\\_bar b\\_'],
    ['angle-continuation-after-qmark', 'https://e.com/?<x>\\[a\\*'],
    ['angle-continuation-after-dot', 'https://e.com/.<x>\\[a\\*'],
    ['angle-continuation-after-colon', 'https://e.com/:<x>\\[a\\*'],
    ['angle-continuation-after-entity-semi', 'https://e.com/&#58;<x>\\[a\\*'],
    ['angle-stops-after-slash', 'https://e.com/<x>\\[a\\*'],
    ['angle-stops-when-followed-by-space', 'https://e.com/?< \\[a\\*'],
    ['angle-stops-when-followed-only-by-punct', 'https://e.com/?<.'],
  ]) {
    assertAstConserved(`R42-2:${label}`, strict);
  }

  // 3. R42-DEFECT-3: trailing \_ and \- immediately after a bare email domain (Autolink.hs notFollowedBy [-_])
  for (const [label, strict] of [
    ['trailing-escaped-underscore-after-email', `user${at}example.com\\_`],
    ['trailing-escaped-hyphen-after-email', `user${at}example.com\\-`],
    ['trailing-escaped-underscore-after-subdom-email', `u.v${at}a_b.c\\_`],
  ]) {
    assertAstConserved(`R42-3:${label}`, strict);
  }

  // Non-vacuity instrument control: non-colliding \[a\* \_c\] without matching definition still relaxes brackets
  // cleanly, with both readers' ASTs conserved.
  const control = '[^fn](/url "*x") $_y$ \\[a\\* \\_c\\] end';
  assert.equal(relaxEscapes(control), '[^fn](/url "*x") $_y$ [a* \\_c] end', 'control relaxes the authored brackets');
  assertAstConserved('R42-control', control);
  // A pandoc footnote definition is outside the generated subset (relax contract guard): returned byte for byte.
  const withFootnoteDef = `[^fn]: note\n\n${control}`;
  assert.equal(relaxEscapes(withFootnoteDef), withFootnoteDef);
});

test('[Canon-v2 SitRep R43-DEFECTS-REL-SOUNDNESS] relaxEscapes matches Autolink.hs ) and &entity; recovery and preserves inline/block ASTs across arbitrary mixed raw+escaped delimiters and entities', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };
  const at = '@';

  // 1. R43-DEFECT-1: Autolink.hs ) and &entity; inside trailing-punctuation recovery
  for (const [label, strict] of [
    ['unmatched-close-paren-inside-trailing-punct-recovery', 'https://e.com/a:)\\_b'],
    ['double-close-paren-and-entity-after-tilde', 'https://e.com/a~))\\_&#58;'],
    ['matched-close-paren-terminating-trailing-punct-over-scan', '[^fn]: note\n\n[^fn](/url "https://e.com/(a_*)") b\\*'],
    ['trailing-named-entity-after-trailing-punct-over-scan', '[^fn]: note\n\n[^fn](/url "https://e.com/a_*&amp;") b\\*'],
    ['trailing-entity-inside-open-paren-over-scan', '[^fn]: note\n\n[^fn](/url "https://e.com/(a_*&amp;)") b\\*'],
    ['entity-before-trailing-punct-over-scan', '[^fn]: note\n\n[^fn](/url "https://e.com/a&amp;_*") b\\*'],
    ['double-entity-with-punct-between', 'https://e.com/a&amp;:)&quot;\\_b'],
  ]) {
    assertAstConserved(`R43-1:${label}`, strict);
  }

  // 2. R43-DEFECT-2: Mixed raw+escaped link/HTML/autolink delimiters & bare-URL/URI-scheme escapes
  for (const [label, strict] of [
    ['escaped-open-bracket-before-raw-inline-link-close', 'z \\[x](/url)'],
    ['escaped-open-bracket-before-raw-shortcut-close', '[a]: /url\n\nz \\[a]'],
    ['nested-empty-escaped-pair-desyncs-outer-open-bracket', 'z \\[\\[\\] x](/url)'],
    ['raw-open-bracket-before-escaped-close-shortcut', '[x]: /url\n\n[x\\] end'],
    ['raw-open-bracket-before-escaped-close-full-ref', '[x]: /url\n\n[y][x\\] end'],
    ['raw-footnote-open-before-escaped-close', '[^x]: note\n\n[^x\\] end'],
    ['escaped-interior-inside-raw-footnote-label', '[^a-b]: note\n\nfoo [^a\\-b]'],
    ['escaped-interior-inside-raw-shortcut-label', '[a-b]: /url\n\nfoo [a\\-b]'],
    ['raw-task-list-open-before-escaped-close', '- [x\\] task'],
    ['escaped-close-paren-completing-inline-link-tail', '[x](javascript:alert(1)\\)'],
    ['escaped-close-paren-completing-multiline-refdef-title', '[a]: /url\n(title\\)\n'],
    ['escaped-close-paren-completing-refdef-dest-parens', '[a]: /url(1\\)\n\n[a]'],
    ['escaped-lt-completing-pointy-link-dest', '[x](\\<#frag bar>)'],
    ['escaped-lt-completing-pointy-refdef-dest', '[a]: \\<#frag bar>\n\n[a]'],
    ['escaped-gt-completing-pointy-link-dest', '[x](<foo\\>)'],
    ['escaped-gt-completing-raw-html-tags', 'x <script\\>alert(1)</script\\>'],
    ['escaped-hyphen-completing-raw-html-attr', 'x <div data\\-x="1">y</div>'],
    ['escaped-eq-completing-raw-html-attr', 'x <div a\\=b>y</div>'],
    ['escaped-star-completing-angle-email-autolink', `<a\\*b${at}localhost>`],
    ['escaped-dot-forming-bare-https-autolink', 'https://a\\.b'],
    ['escaped-underscore-forming-bare-https-autolink', 'https://a\\_b.com'],
    ['escaped-hyphen-forming-bare-https-autolink', 'https://a\\-b.com'],
    ['simultaneous-underscore-and-dot-bare-https', 'https://a\\_b\\.com'],
    ['escaped-plus-forming-angle-uri-autolink', '<http\\+s://e.com>'],
    ['entity-at-forming-single-label-email-autolink', `<user&#64;localhost>`],
  ]) {
    assertAstConserved(`R43-2:${label}`, strict);
  }

  // 3. R43-DEFECT-3: Non-initial block-structure escapes & &#58;/&#46; block/table/refdef guards
  for (const [label, strict] of [
    ['non-initial-escaped-eq-setext-underline', 'foo\n=\\='],
    ['non-initial-escaped-dash-setext-underline', 'foo\n-\\-'],
    ['non-initial-escaped-dash-thematic-break', '--\\-'],
    ['non-initial-escaped-underscore-thematic-break', '_ _ \\_'],
    ['non-initial-escaped-star-thematic-break', '* * \\*'],
    ['non-initial-escaped-hash-atx-heading', '#\\# foo'],
    ['non-initial-escaped-hash-atx-closing-seq', '## title #\\#'],
    ['escaped-dash-gfm-table-delimiter-row', '| h1 | h2 |\n| \\--- | --- |'],
    ['escaped-bang-gfm-blockquote-alert', '> [\\!NOTE]\n> body'],
    ['escaped-dot-gfm-yaml-metadata-closer', '---\na: 1\n..\\.'],
    ['escaped-dash-html-comment-block', '<!-\\-\n*a*\n-->'],
    ['escaped-bracket-cdata-block', '<!\\[CDATA\\[\n*a*\n]]>'],
    ['entity-colon-forming-link-ref-definition', '[a]&#58; /url\n\n[a]'],
    ['entity-colon-forming-footnote-definition', '[^fn]&#58; note\n\n[^fn]'],
    ['entity-colon-forming-gfm-table-delimiter-row', '| h1 | h2 |\n| &#58;--- | --- |'],
    ['entity-dot-forming-ordered-list-marker', '1&#46; item'],
    ['outer-list-item-dash-forming-thematic-break', '- foo\n- -\\-'],
    ['www-precedes-bare-email-at-same-offset', `www.b${at}e.com\\*\\-\\_\\=\\+\\!`],
    ['pandoc-math-stack-unclosed-single-before-double-dollar', '$1\\$ and $a + b\\$ and $$c\\_1$\\$'],
    ['pandoc-raw-tab-stop-column-shift-hardbreak-and-code', ';;\\<\\`https://\\-\\)\t\n  ..ä\\`:\\< `x\ty`'],
  ]) {
    assertAstConserved(`R43-3:${label}`, strict);
  }

  // Non-vacuity instrument control: after a valid inline link [Evidence](#ev-1), authored \[note\] still relaxes cleanly
  assert.equal(relaxEscapes('See [Evidence](#ev-1), then \\[note\\] in v1\\.2 end'), 'See [Evidence](#ev-1), then [note] in v1.2 end');
});

test('[Canon-v2 SitRep R44-DEFECTS-EMAIL-NEG] relaxEscapes and verifySiteBundle neutralize and reject bare email autolinks whose final TLD segment starts with _ or - (._org, .-org, _a._b)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r44-email-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const at = String.fromCharCode(64);
    const e1 = `user${at}${['example', '_org'].join('.')}`;
    const e2 = `user${at}${['example', '-org'].join('.')}`;
    const e3 = `user${at}${['_a', '_b'].join('.')}`;

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      { type: 'paragraph', text: `Contact1 ${e1} end` },
      { type: 'paragraph', text: `Contact2 ${e2} end` },
      { type: 'paragraph', text: `Contact3 ${e3} end` },
    );
    const inputPath = join(dir, 'site-input.json');
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const bundleDir = join(dir, 'bundle');
    await buildSiteBundle({ sitePath: inputPath, outDir: bundleDir });

    const baseVer = await verifySiteBundle(bundleDir);
    assert.equal(baseVer.ok, true, `untampered SitRep bundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);
    const targetRel = 'item/wal-standby-ring/index.md';
    const itemMd = await readFile(join(bundleDir, targetRel), 'utf8');
    const pandocRes = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: itemMd, encoding: 'utf8' });
    assert.equal(pandocRes.status, 0, pandocRes.stderr);
    assert.equal(pandocRes.stdout.includes('mailto:'), false, `${targetRel} leaked live mailto autolink:\n${pandocRes.stdout}`);

    const resealDir = async (bDir) => {
      const manifest = JSON.parse(await readFile(join(bDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bDir, 'checksums.json'), canonicalBytes(checksums));
    };

    for (const [label, escapedFrom, rawTo] of [
      ['leading-underscore-tld', 'user&#64;example._org', e1],
      ['leading-hyphen-tld', 'user&#64;example.-org', e2],
      ['single-char-leading-underscore-segments', 'user&#64;\\_a.\\_b', e3],
    ]) {
      const caseDir = join(dir, `tamper-${label}`);
      await cp(bundleDir, caseDir, { recursive: true });
      const mp = join(caseDir, targetRel);
      const orig = await readFile(mp, 'utf8');
      assert.equal(orig.includes(escapedFrom), true, `expected ${escapedFrom} in index.md, got:\n${orig.slice(0, 200)}`);
      await writeFile(mp, orig.replace(escapedFrom, () => rawTo));
      await resealDir(caseDir);
      const ver = await verifySiteBundle(caseDir);
      assert.equal(ver.ok, false, `verifySiteBundle failed to reject ${label} (${rawTo})`);
      assert.equal(
        ver.errors.some((e) => e.message.includes('bare GFM or Pandoc email autolink in Markdown')),
        true,
        `expected bare email autolink rejection for ${label}, got ${JSON.stringify(ver.errors)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R44-DEFECTS-REL-SOUNDNESS] relaxEscapes keeps/relaxes contiguous * / _ / ~ runs atomically and detects > inside opaque code spans and Pandoc Math.hs cross-backtick spans', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };
  const at = '@';

  // 1. R44-DEFECT-2: Atomic contiguous escaped delimiter runs (*, _, ~)
  for (const [label, strict] of [
    ['double-star-at-line-start-after-open-star', '\\*a\n\\*\\*'],
    ['fuzzer-entity-space-star-and-double-star-line', '&#32;\\*\\$1- \\[\\$\n\\*\\*'],
    ['double-underscore-after-bare-email-with-later-underscore', `user${at}a.b\\_\\_c- d\\_`],
    ['double-underscore-inside-bare-https-domain', 'https://a\\_\\_b.com c\\_'],
    ['double-underscore-inside-emoji-shortcode', ':smile\\_\\_: c\\_'],
    ['double-underscore-inside-loose-raw-brackets', '[a-b]: /u\n\n[a\\_\\_b] c\\_'],
    ['double-star-inside-raw-angle-brackets', '<tag a=\\*\\*> c\\*'],
  ]) {
    assertAstConserved(`R44-2:${label}`, strict);
  }

  // 2. R44-DEFECT-3: > hidden inside opaque code spans + Pandoc Math.hs precedence over backticks/links
  for (const [label, strict] of [
    ['inline-pointy-dest-swallowing-code-span-gt', '[foo](\\< `>)`'],
    ['refdef-pointy-dest-swallowing-multiline-code-span-gt', '[a]: \\< `>\n`\n\n[a]'],
    ['single-line-html-attr-swallowing-code-span-gt', '<a data\\-x="`">`'],
    ['multiline-html-attr-swallowing-code-span-gt', '<a\ndata\\-x="`">`'],
    ['pandoc-single-dollar-math-crossing-into-backtick-span', '$a \\_b `c$` d\\_'],
    ['pandoc-double-dollar-math-crossing-into-backtick-span', '$$a \\_b `c$$`'],
    ['pandoc-double-dollar-aborted-by-interior-unescaped-single-dollar', '$$a $ b$$ \\_c\\_'],
    ['pandoc-tex-math-gfm-dollar-backtick', '$`a\\_b`$'],
    ['pandoc-single-dollar-precedes-tex-math-gfm-leaving-code-span-open', '$$`b$`$$\n&#64;x`$a`'],
    ['kept-trailing-hyphen-does-not-mask-earlier-email-domain-dot', `user${at}a\\.b__c\\- d_`],
  ]) {
    assertAstConserved(`R44-3:${label}`, strict);
  }

  // Non-vacuity instrument controls:
  // 1. Single-segment domain without dot ("ops&#64;localhost") outside <...> still relaxes &#64; -> @
  assert.equal(relaxEscapes('ops&#64;localhost'), `ops${at}localhost`);
  // 2. Line-start \*\* (length 2, neither 1-star bullet nor >=3-star thematic break) relaxes both stars atomically
  assert.equal(relaxEscapes('\\*a\n\\*\\*'), '*a\n**');
});

test('[Canon-v2 SitRep R45-DEFECTS-EMOJI-NEG] verifySiteBundle rejects resealed unescaped GFM +emoji shortcodes across prose, link text, and table cells while accepting non-emoji colons and code/URL spans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canon-v2-r45-emoji-'));
  try {
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'wal-latency.csv'), 'stage,legacy_p99_ms,zerocopy_p99_ms\nappend,148.4,4.6\n');
    await writeFile(join(dir, 'evidence', 'compaction-run.json'), '{"ops":14400000}\n');

    const input = makeV2SitrepFixture();
    input.items[0].blocks.push(
      {
        type: 'paragraph',
        text: [
          'EmojiCheck :smile: and :+1: and :-1: and :100: and :1234: and :e-mail: and a:v: plus non-emoji :FOO: and :999: and ',
          { code: ':smile:' },
          ' and ',
          { link: { text: 'link :smile: text', href: 'https://example.com/:smile:' } },
          '.',
        ],
      },
      {
        type: 'table',
        id: 'tbl-r45-emoji',
        caption: 'R45 emoji tamper matrix',
        columns: [{ key: 'c1', label: 'Status' }],
        rows: [{ c1: 'Cell :smile: ok' }],
      },
    );
    const inputPath = join(dir, 'site-input.json');
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const bundleDir = join(dir, 'bundle');
    await buildSiteBundle({ sitePath: inputPath, outDir: bundleDir });

    const baseVer = await verifySiteBundle(bundleDir);
    assert.equal(baseVer.ok, true, `untampered SitRep bundle must verify cleanly, got ${JSON.stringify(baseVer.errors)}`);
    const targetRel = 'item/wal-standby-ring/index.md';
    const itemMd = await readFile(join(bundleDir, targetRel), 'utf8');
    // Positive controls: non-emoji :FOO: and :999:, code span `:smile:`, and URL path https://example.com/:smile: stay unescaped and verify cleanly
    assert.equal(itemMd.includes(':FOO:'), true);
    assert.equal(itemMd.includes(':999:'), true);
    assert.equal(itemMd.includes('`:smile:`'), true);
    assert.equal(itemMd.includes('(https://example.com/:smile:)'), true);

    const resealDir = async (bDir) => {
      const manifest = JSON.parse(await readFile(join(bDir, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files) {
        const bytes = await readFile(join(bDir, entry.path));
        entry.bytes = bytes.length;
        entry.sha256 = sha256Hex(bytes);
      }
      const { contentId: _ignored, ...identity } = manifest;
      const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
      const nextManifest = { ...identity, contentId };
      const manifestBytes = canonicalBytes(nextManifest);
      const checksums = {
        schema: 'checksums/v1',
        algorithm: 'sha256',
        contentId,
        manifestSha256: sha256Hex(manifestBytes),
        files: Object.fromEntries(nextManifest.files.map((f) => [f.path, f.sha256])),
      };
      await writeFile(join(bDir, 'manifest.json'), manifestBytes);
      await writeFile(join(bDir, 'checksums.json'), canonicalBytes(checksums));
    };

    for (const [label, escapedFrom, rawTo] of [
      ['prose-smile', 'EmojiCheck &#58;smile:', 'EmojiCheck :smile:'],
      ['prose-plus1', 'and &#58;+1:', 'and :+1:'],
      ['prose-minus1', 'and &#58;-1:', 'and :-1:'],
      ['prose-100', 'and &#58;100:', 'and :100:'],
      ['prose-1234', 'and &#58;1234:', 'and :1234:'],
      ['prose-email-hyphen', 'and &#58;e-mail:', 'and :e-mail:'],
      ['prose-after-word-char', 'and a&#58;v:', 'and a:v:'],
      ['link-text-emoji', '[link &#58;smile: text]', '[link :smile: text]'],
      ['table-cell-emoji', 'Cell &#58;smile: ok', 'Cell :smile: ok'],
    ]) {
      const caseDir = join(dir, `tamper-${label}`);
      await cp(bundleDir, caseDir, { recursive: true });
      const mp = join(caseDir, targetRel);
      const orig = await readFile(mp, 'utf8');
      assert.equal(orig.includes(escapedFrom), true, `expected ${escapedFrom} in ${targetRel}`);
      await writeFile(mp, orig.replace(escapedFrom, () => rawTo));
      await resealDir(caseDir);
      const ver = await verifySiteBundle(caseDir);
      assert.equal(ver.ok, false, `verifySiteBundle failed to reject ${label} (${rawTo})`);
      assert.equal(
        ver.errors.some((e) => e.message.includes('bare GFM or Pandoc emoji shortcode in Markdown')),
        true,
        `expected bare emoji shortcode rejection for ${label}, got ${JSON.stringify(ver.errors)}`,
      );
    }

    // Negative control: backslash-escaped :\+1: is NOT expanded by Pandoc GFM and stays accepted when resealed over :+1:
    {
      const escInput = makeV2SitrepFixture();
      escInput.items[0].blocks.push({ type: 'paragraph', text: 'Literal :+1: check' });
      const escInPath = join(dir, 'esc.site-input.json');
      await writeFile(escInPath, JSON.stringify(escInput, null, 2));
      const escBundle = join(dir, 'esc-bundle');
      await buildSiteBundle({ sitePath: escInPath, outDir: escBundle });
      const mp = join(escBundle, targetRel);
      const orig = await readFile(mp, 'utf8');
      await writeFile(mp, orig.replace('Literal &#58;+1: check', () => 'Literal :\\+1: check'));
      await resealDir(escBundle);
      const ver = await verifySiteBundle(escBundle);
      assert.equal(ver.ok, true, `backslash-escaped :\\+1: should remain valid literal text, got ${JSON.stringify(ver.errors)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[Canon-v2 SitRep R45-DEFECTS-REL-SOUNDNESS] relaxEscapes preserves thematic-break guards across nested/continuation containers and models CommonMark §2.1 blank lines + commonmark.js \\s HTML whitespace', async () => {
  const { relaxEscapes } = await import('../../src/render/relax.mjs');
  const commonmark = require('commonmark');
  const cmRender = (md) => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  const gfmRender = (md) => {
    const res = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html'], { input: md, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const assertAstConserved = (label, strict) => {
    const relaxed = relaxEscapes(strict);
    assert.equal(cmRender(relaxed), cmRender(strict), `CommonMark AST mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
    assert.equal(gfmRender(relaxed), gfmRender(strict), `Pandoc GFM HTML mutated for ${label}:\nSTRICT:\n${strict}\nRELAXED:\n${relaxed}`);
  };

  // 1. R45-DEFECT-1: Nested container & multi-column continuation thematic breaks
  for (const [label, strict] of [
    ['ordered-list-nested-star-thematic-break', '2. * \\*\\*'],
    ['ordered-list-1-nested-star-thematic-break', '1. * \\*\\*'],
    ['bullet-dash-nested-star-thematic-break', '- * \\*\\*'],
    ['bullet-plus-nested-star-thematic-break', '+ * \\*\\*'],
    ['bullet-blockquote-nested-star-thematic-break', '- > * \\*\\*'],
    ['wide-ordered-list-continuation-star-thematic-break', '100. a\n\n     * \\*\\*'],
    ['ordered-list-nested-dash-thematic-break', '1. - -\\-'],
    ['bullet-plus-nested-dash-thematic-break', '+ - -\\-'],
    ['wide-ordered-list-continuation-dash-thematic-break', '100. a\n\n     - -\\-'],
    ['pandoc-footnote-nested-star-thematic-break', '[^1]\n\n[^1]: * \\*\\*'],
    ['pandoc-footnote-nested-dash-thematic-break', '[^1]\n\n[^1]: - -\\-'],
    ['tab-indented-container-star-thematic-break', '-\t*\t\\*\\*'],
  ]) {
    assertAstConserved(`R45-1:${label}`, strict);
  }

  // 2. R45-DEFECT-2: Non-space/tab whitespace (\u00a0, \f, \v, \u2000) in HTML blocks, inline HTML tags, & blank lines
  for (const [label, strict] of [
    ['html-block-6-nbsp-after-tag', '<div\u00a0x>\n\\*a'],
    ['html-block-6-formfeed-after-tag', '<div\fx>\n\\*a'],
    ['html-block-6-vtab-after-tag', '<div\vx>\n\\*a'],
    ['html-block-1-nbsp-after-pre', '<pre\u00a0x>\n\n\\*a\n</pre>'],
    ['html-block-7-nbsp-in-custom-tag', '<custom\u00a0x="1">\n\\*a'],
    ['html-block-7-trailing-nbsp', '<custom>\u00a0\n\\*a'],
    ['inline-html-tag-nbsp-before-attr-swallowing-backtick', '<span\u00a0b="`"> *hello`\\*'],
    ['inline-html-tag-enquad-before-attr-swallowing-backtick', '<span\u2000b="`"> *hello`\\*'],
    ['html-block-6-not-closed-by-nbsp-line', '<div x>\n\u00a0\n\\*a'],
    ['indented-code-interrupted-by-nbsp-line', '    code\n\u00a0\n    *a\nb\\*'],
    ['table-header-trailing-nbsp-not-stripped', '| a | b |\u00a0\n| - | - |\n| *x | y\\* |'],
    ['refdef-backtick-isolated-from-following-para', '[^1]: ~`dest\n  `code\\*`\n'],
    ['refdef-trailing-tab-cmjs-vs-pandoc-differential', '[^1]: note\n\n[^1]: b="`"\t\n[^1]: \\*a\n  `x\n'],
    ['pandoc-math-unicode-quad-and-nbsp-not-whitespace', '\\$\u2000x$ and $y\u00a0\\$'],
    ['pandoc-autolink-path-continues-past-formfeed-and-vtab', 'www.a.b/\f\\_\\_ and https://e.com/\v\\*x\\*'],
    ['pandoc-autolink-domain-try-dot-seg-backtracks-into-path', 'www.www.__\\[x\\* and https://a.b.c-/\\_x'],
  ]) {
    assertAstConserved(`R45-2:${label}`, strict);
  }

  // Non-vacuity instrument control: inside an ordered list, non-thematic-break "* foo \* bar" still relaxes \* cleanly
  assert.equal(relaxEscapes('2. * foo \\* bar'), '2. * foo * bar');
});
