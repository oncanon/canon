import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { RENDER_POLICIES } from '../../src/policy.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { anchor } from '../../src/render/anchors.mjs';
import { validateReport } from '../../src/report/validate.mjs';
import { anchorProblems, commonmarkOutline, expectedAnchors, expectedOutline } from '../agent-md-gates.mjs';
import { tempDir } from '../helpers.mjs';

function makeV2SpecimenReport() {
  return {
    schema: 'report/v1',
    id: 'canon-v2-design-contract',
    title: 'Deterministic verification pipeline architecture',
    subtitle: 'Canon v2 visual grammar, House-Rules semantics, and zero-JS SVG diagrams',
    metadata: {
      status: 'proposed',
      classification: 'Internal engineering review',
      reviewDate: '2026-11-14',
      authors: ['Systems Architecture', 'Verification Engineering'],
      reviewRequest: 'Approve v2 visual grammar and schema extensions.',
    },
    summary: {
      verdict: {
        confidence: 'recommended',
        text: [
          'The builder MUST seal every runtime asset by SHA-256 digest before publication ',
          { cite: 'bench-csv' },
          '.',
        ],
      },
      paragraphs: [
        'Active technical prose states one verifiable claim per sentence. Every visual figure pairs a deterministic SVG graphic with accessible tabular text.',
      ],
      metrics: {
        items: [
          { label: 'p99 build latency', value: '18.4', unit: 'ms', evidence: ['bench-csv'] },
          { label: 'Speedup vs legacy', value: '14.7x', evidence: ['bench-csv'] },
        ],
      },
    },
    evidence: [
      {
        id: 'bench-csv',
        title: 'Stage latency benchmark (CSV)',
        kind: 'file',
        path: 'evidence/bench.csv',
        mediaType: 'text/csv',
      },
      {
        id: 'trace-json',
        title: 'Protocol verification receipt (JSON)',
        kind: 'file',
        path: 'evidence/receipt.json',
        mediaType: 'application/json',
      },
    ],
    sections: [
      {
        id: 'architecture',
        title: 'System topology and protocol flow',
        lede: 'Layered architecture and sequence lifelines replace flat box grids.',
        blocks: [
          {
            type: 'diagram',
            id: 'pipeline-flow',
            title: 'Sealed build pipeline',
            kind: 'flow',
            steps: [
              { label: 'Validate JSON', detail: 'Reject unknown members and bidi controls', gate: true },
              { label: 'Render HTML + MD', detail: 'Emit coequal views from canonical AST' },
              { label: 'Verify seal', detail: 'Recompute every digest and check CSP', gate: true },
            ],
            caption: 'Each gate halts publication on non-zero exit.',
          },
          {
            type: 'diagram',
            id: 'system-topology',
            title: 'Immutable store and serving topology',
            kind: 'topology',
            groups: [
              {
                id: 'authoring',
                label: 'Authoring & Seal',
                nodes: [
                  { id: 'report-ast', label: 'report/v1 JSON', sublabel: 'Closed schema', role: 'entry' },
                  { id: 'builder', label: 'Packet Builder', sublabel: 'Deterministic AST', role: 'core' },
                  { id: 'verifier', label: 'Policy Verifier', sublabel: 'SHA-256 + CSP gate', role: 'gate' },
                ],
              },
              {
                id: 'serving',
                label: 'Local / Tailnet Store',
                nodes: [
                  { id: 'cas-store', label: 'CAS Store', sublabel: 'packets/<sha256>/', role: 'store' },
                  { id: 'alias-ptr', label: 'Alias Record', sublabel: 'aliases/<name>.json', role: 'core' },
                ],
              },
            ],
            edges: [
              { from: 'report-ast', to: 'builder', label: 'validateReport' },
              { from: 'builder', to: 'verifier', label: 'verifyPacket', style: 'gate' },
              { from: 'verifier', to: 'cas-store', label: 'atomic rename' },
              { from: 'alias-ptr', to: 'cas-store', label: '302 /p/<contentId>/', style: 'dashed' },
            ],
            caption: 'Content-addressed packets decouple mutable aliases from immutable bytes.',
          },
          {
            type: 'diagram',
            id: 'publish-sequence',
            title: 'Zero-stale alias switch protocol',
            kind: 'sequence',
            actors: [
              { id: 'operator', label: 'Author CLI', kind: 'actor' },
              { id: 'verifier-svc', label: 'Packet Verifier', kind: 'verifier' },
              { id: 'store-fs', label: 'CAS Store', kind: 'store' },
              { id: 'reader', label: 'Tailnet Browser', kind: 'service' },
            ],
            messages: [
              { from: 'operator', to: 'verifier-svc', label: 'verifyPacket(stagingDir)', kind: 'sync', gate: true },
              { from: 'verifier-svc', to: 'operator', label: 'ok + contentId', kind: 'reply' },
              { from: 'operator', to: 'store-fs', label: 'publish + CAS swap alias', kind: 'sync', note: 'Atomic generation check' },
              { from: 'reader', to: 'store-fs', label: 'GET /a/spec/', kind: 'sync' },
              { from: 'store-fs', to: 'reader', label: '302 /p/sha256-.../ (no-store)', kind: 'reply' },
            ],
            caption: 'Alias redirects never cache; packet assets cache for one year.',
          },
        ],
      },
      {
        id: 'benchmarks',
        title: 'Quantitative performance and code comparison',
        blocks: [
          {
            type: 'chart',
            id: 'throughput-cmp',
            title: 'Stage execution time: Legacy vs Canon v2',
            kind: 'comparison',
            baselineLabel: 'Legacy DOM scraper',
            candidateLabel: 'Canon v2 AST renderer',
            unit: 'ms',
            series: [
              { label: 'Schema validation', baseline: 42.0, value: 3.1 },
              { label: 'HTML + SVG render', baseline: 188.0, value: 9.4 },
              { label: 'Cryptographic seal', baseline: 64.0, value: 5.9 },
            ],
            caption: ['Measured across 500 warm iterations ', { cite: 'bench-csv' }, '.'],
            evidence: ['bench-csv'],
          },
          {
            type: 'chart',
            id: 'latency-quantiles',
            title: 'End-to-end build latency quantiles',
            kind: 'quantiles',
            unit: 'ms',
            budget: 25,
            series: [
              { label: 'Small brief (12 blocks)', p50: 4.2, p95: 6.8, p99: 9.1 },
              { label: 'Full specimen (40 blocks)', p50: 11.5, p95: 15.9, p99: 18.4 },
            ],
            caption: 'All workloads stay below the 25 ms interactive budget.',
            evidence: ['bench-csv'],
          },
          {
            type: 'comparison',
            id: 'asset-addressing',
            title: 'Asset cache addressing: Mutable path vs Content-addressed path',
            caption: 'Fingerprinted paths eliminate cross-revision cache poisoning.',
            left: {
              label: 'Legacy: Mutable relative path',
              tone: 'legacy',
              summary: 'Reuses assets/app.css across alias updates; browsers serve stale styles.',
              items: [
                'Alias update leaves URL unchanged when sub-resource path is fixed.',
                'Requires cache-busting query strings forbidden by packet policy.',
              ],
              code: {
                language: 'javascript',
                source: 'const href = "assets/style.css";\nreturn `<link rel="stylesheet" href="${href}">`;',
              },
            },
            right: {
              label: 'Canon v2: SHA-256 content-addressed path',
              tone: 'proposed',
              summary: ['Embeds full SHA-256 digest in filename ', { cite: 'trace-json' }, '.'],
              items: [
                'Every byte change produces a distinct immutable asset URL.',
                'Safe under Cache-Control: public, max-age=31536000, immutable.',
              ],
              code: {
                language: 'javascript',
                source: 'const href = `assets/${sha256Hex(cssBytes)}.css`;\nreturn `<link rel="stylesheet" href="${href}">`;',
              },
            },
            evidence: ['trace-json'],
          },
        ],
      },
      {
        id: 'governance',
        title: 'Findings, requirements, and MADR decisions',
        blocks: [
          {
            type: 'finding',
            id: 'cache-seal',
            title: 'Immutable asset digests prevent stale stylesheet injection',
            severity: 'high',
            confidence: 'proven',
            verification: {
              band: 'code',
              detail: 'p6-cache-reproducer.test.mjs (Chromium + WebKit)',
            },
            claim: [
              ' packets MUST address every CSS and WOFF2 file by SHA-256 digest ',
              { cite: 'trace-json' },
              '.',
            ],
            evidence: ['trace-json'],
          },
          {
            type: 'requirement',
            id: 'zero-runtime-net',
            title: 'Zero external runtime network egress',
            pattern: 'unwanted',
            statement: [
              'If a rendered packet contains an external sub-resource URL or inline style, then the verifier MUST reject the packet before publication ',
              { cite: 'trace-json' },
              '.',
            ],
            verification: {
              band: 'code',
              detail: 'verifyPacket scanHtmlPolicy + P14 network trap',
            },
            scenarios: [
              {
                name: 'Reject inline style attribute',
                given: 'an index.html file containing a style attribute on an SVG element',
                when: 'verifyPacket inspects the packet directory',
                then: 'verification fails with unsafe-content and non-zero exit status',
              },
              {
                name: 'Pass pure CSS-classed SVG',
                given: 'an index.html file with class-styled SVG diagrams and aria-hidden="true"',
                when: 'verifyPacket inspects the packet directory',
                then: 'verification succeeds with zero errors',
              },
            ],
            evidence: ['trace-json'],
          },
          {
            type: 'decision',
            id: 'svg-dataviz',
            question: 'How should Canon render architecture diagrams and statistical charts without client-side JavaScript?',
            status: 'decided',
            owner: 'Systems Architecture',
            context: 'Client-side charting libraries violate script-src none and introduce non-deterministic layout jitter across browsers.',
            recommendation: [
              'Compile validated diagram and chart AST nodes into deterministic server-rendered SVG paired with accessible HTML tables ',
              { cite: 'bench-csv' },
              '.',
            ],
            alternatives: [
              {
                label: 'Deterministic build-time SVG + accessible HTML table',
                chosen: true,
                summary: 'Zero runtime JS, crisp at any Retina zoom, adapts to light/dark/print via CSS variables.',
              },
              {
                label: 'Pre-rasterized PNG images',
                summary: 'Blurry on high-DPI displays, opaque to dark-mode theming, and bloated byte size.',
              },
            ],
            consequences: [
              'Positive: Packet verification enforces zero inline styles and zero script execution.',
              'Trade-off: Layout algorithms for flow, topology, and sequence diagrams must stay bounded and deterministic.',
            ],
          },
        ],
      },
    ],
    provenance: {
      notes: 'Synthetic test fixture for Canon v2 design and House-Rules contract.',
      sources: [
        {
          label: 'Canon v2 design contract',
          reference: 'docs/projects/review-packet-publisher.md',
        },
      ],
    },
  };
}

test('[Canon-v2] validates topology/sequence diagrams, comparison/quantile charts, comparison & requirement blocks, and HR-004/MADR fields', () => {
  const report = makeV2SpecimenReport();
  assert.equal(validateReport(report), report);

  // Reject topology edge referencing unknown node
  const badTopo = structuredClone(report);
  badTopo.sections[0].blocks[1].edges.push({ from: 'builder', to: 'ghost-node' });
  assert.throws(() => validateReport(badTopo), /unknown-ref|ghost-node/);

  // Reject sequence message referencing unknown actor
  const badSeq = structuredClone(report);
  badSeq.sections[0].blocks[2].messages.push({ from: 'operator', to: 'ghost-actor', label: 'ping' });
  assert.throws(() => validateReport(badSeq), /unknown-ref|ghost-actor/);

  // Reject quantile chart where p50 > p95
  const badQuant = structuredClone(report);
  badQuant.sections[1].blocks[1].series[0] = { label: 'Broken', p50: 20, p95: 10, p99: 30 };
  assert.throws(() => validateReport(badQuant), /quantile|range/);

  // Reject invalid HR-004 verification band
  const badBand = structuredClone(report);
  badBand.sections[2].blocks[0].verification.band = 'vibes';
  assert.throws(() => validateReport(badBand), /enum/);
});

test('[Canon-v2] builds, seals, verifies CSP/HTML policy, renders SVG graphics + evidence previews, and preserves 1-to-1 Markdown parity', async (t) => {
  const work = await tempDir(t, 'canon-v2-pkt');
  await writeFile(join(work, 'report.json'), JSON.stringify(makeV2SpecimenReport(), null, 2));
  const evDir = join(work, 'evidence');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(evDir, { recursive: true });
  await writeFile(join(evDir, 'bench.csv'), 'stage,legacy_ms,v2_ms\nvalidate,42.0,3.1\nrender,188.0,9.4\nseal,64.0,5.9\n');
  await writeFile(join(evDir, 'receipt.json'), JSON.stringify({ ok: true, policy: 'security-policy/1', checks: 14 }, null, 2));

  const outDir = join(work, 'out');
  const built = await buildPacket({ reportPath: join(work, 'report.json'), outDir });
  const verified = await verifyPacket(outDir);
  assert.equal(verified.ok, true, JSON.stringify(verified.errors, null, 2));

  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const md = await readFile(join(outDir, 'report.md'), 'utf8');
  const cssFile = built.manifest.files.find((f) => f.path.endsWith('.css')).path;
  const css = await readFile(join(outDir, cssFile), 'utf8');

  // 1. Brand masthead & honest section numbering (no 00 vs 01 mismatch)
  assert.match(html, /Canon/);
  assert.ok(!html.includes('>Review packet<'), 'legacy Review packet masthead label removed');
  assert.ok(!html.includes('>00<'), 'off-by-one 00 section badge removed');

  // 2. Typography & palette upgrades in variant-a.css
  assert.ok(!/font:\s*500[^;]*var\(--serif\)/.test(css), 'no faux weight 500 on Libron serif');
  assert.ok(!css.includes('#f1eee7') && !css.includes('#d84f2a'), 'oatmeal/terracotta cliche removed');

  // 3. Deterministic zero-JS, zero-inline-style SVGs for flow, topology, sequence, comparison, quantiles
  const svgCount = (html.match(/<svg\b[^>]*aria-hidden="true"/g) ?? []).length;
  assert.ok(svgCount >= 5, `expected >= 5 accessible SVGs, got ${svgCount}`);
  assert.ok(!/\sstyle\s*=/.test(html), 'zero inline style attributes');

  // 4. Inline CSV & JSON evidence previews + RFC 2119 + HR-004 + Gherkin + Comparison panels
  assert.match(html, /class="[^"]*\bev-preview\b/);
  assert.match(html, /class="rfc2119">MUST<\/span>/);
  assert.match(html, /302 \/p\/sha256-\.\.\.\/ \(no-store\)/);
  assert.match(html, /13\.5×|13\.5x|-92\.6%/); // automatic comparison delta badge
  assert.match(html, /Reject inline style attribute/);

  // 5. 1-to-1 HTML <-> report.md anchor and CommonMark outline parity
  const report = makeV2SpecimenReport();
  const bytes = new Map(built.manifest.files.map((f) => [f.path, f.bytes]));
  const ctx = {
    labels: new Map(built.manifest.evidence.map((e) => [e.id, e.label])),
    evidence: new Map(built.manifest.evidence.filter((e) => e.path).map((e) => [e.id, { href: e.path, sha256: e.sha256, bytes: bytes.get(e.path) }])),
    sourceSha256: built.manifest.report.sourceSha256,
  };
  const expected = expectedAnchors(report, ctx, anchor);
  const anchorCheck = anchorProblems(md, html, expected);
  assert.deepEqual(anchorCheck.problems, []);

  const cm = commonmarkOutline(md);
  const expOutline = expectedOutline(report, ctx);
  assert.deepEqual(
    cm.blocks,
    expOutline.blocks.filter((b) => b.t !== 'table'),
  );
});

// Runs under every render policy (src/policy.mjs RENDER_POLICIES), so a new policy is covered automatically.
for (const renderPolicy of RENDER_POLICIES) {
  test(`[Canon-v2 Adv-1] hostile markup and attribute-like prose in verification.detail and evidence.title pass verifyPacket while real inline attributes fail scanHtmlPolicy [${renderPolicy}]`, async (t) => {
  const { scanHtmlPolicy } = await import('../../src/packet/verify.mjs');
  const { mkdir } = await import('node:fs/promises');
  const work = await tempDir(t, 'canon-v2-adv1');
  await mkdir(join(work, 'evidence'), { recursive: true });
  await writeFile(join(work, 'evidence', 'bench.csv'), 'a,b\n1,2\n');
  await writeFile(join(work, 'evidence', 'receipt.json'), '{"ok":true}\n');

  const r = makeV2SpecimenReport();
  const payload = '<script>alert(1)</script><img src=x onerror=alert(1) style=color:red>';
  r.evidence[0].title = `Hostile title ${payload}`;
  r.sections[2].blocks[0].verification = { band: 'code', detail: `scanHtmlPolicy ${payload}` };
  r.sections[2].blocks[1].verification = { band: 'judgment', detail: `onload=init() and style=color:red ${payload}` };
  await writeFile(join(work, 'report.json'), JSON.stringify(r, null, 2));

  const outDir = join(work, 'out');
  await buildPacket({ reportPath: join(work, 'report.json'), outDir, renderPolicy });
  const verified = await verifyPacket(outDir);
  assert.equal(verified.ok, true, JSON.stringify(verified.errors, null, 2));

  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag never emitted');
  assert.ok(!html.includes('<img src=x'), 'raw img tag never emitted');

  // Instrument control: real inline attributes outside title/content/aria-label still fail scanHtmlPolicy
  const edition = { manifest: JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')), report: renderPolicy === 'render-policy/1' ? null : JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) };
  assert.ok(html.includes('<main id="content"'), 'instrument anchor present');
  const badProblems = scanHtmlPolicy(html.replace('<main id="content"', '<main onclick="x()" style="color:red" id="content"'), new Set(['assets/0'.padEnd(71, '0') + '.css']), { renderPolicy, edition });
  assert.ok(badProblems.some((p) => p.includes('inline event handler')));
  assert.ok(badProblems.some((p) => p.includes('inline style attribute')));
});
}

test('[Canon-v2 Adv-2] validateReport and validateSiteInput reject generated sub-element DOM ID collisions (ev-*-pv, req-*-sc, cmp-*-left-code, chart-*-cap)', async () => {
  const rEv = makeV2SpecimenReport();
  rEv.evidence.push({ id: 'bench-csv-pv', title: 'Collides with bench-csv preview label', kind: 'unavailable', reason: 'test' });
  assert.throws(() => validateReport(rEv), /duplicate-id|html-id-collision/);

  const rReq = makeV2SpecimenReport();
  rReq.sections[2].blocks.push({
    type: 'requirement',
    id: 'zero-runtime-net-sc',
    title: 'Collides with req-zero-runtime-net-sc scenario caption',
    pattern: 'ubiquitous',
    statement: 'The verifier MUST reject duplicate DOM IDs.',
    verification: { band: 'code' },
  });
  assert.throws(() => validateReport(rReq), /duplicate-id|html-id-collision/);

  const rCmp = makeV2SpecimenReport();
  rCmp.sections[1].blocks.push({
    type: 'comparison',
    id: 'asset-addressing-left-code',
    title: 'Collides with cmp-asset-addressing-left-code',
    left: { label: 'A', summary: 'Left' },
    right: { label: 'B', summary: 'Right' },
  });
  assert.throws(() => validateReport(rCmp), /duplicate-id|html-id-collision/);

  const rChart = makeV2SpecimenReport();
  rChart.sections[1].blocks.push({
    type: 'chart',
    id: 'throughput-cmp-cap',
    kind: 'bar',
    title: 'Collides with chart-throughput-cmp-cap',
    unit: 'ms',
    caption: 'Test',
    series: [{ label: 'S', value: 1 }],
  });
  assert.throws(() => validateReport(rChart), /duplicate-id|html-id-collision/);

  const { validateSiteInput } = await import('../../src/site/validate.mjs');
  const site = JSON.parse(await readFile(new URL('../../fixtures/site/first-slice.site-input.json', import.meta.url), 'utf8'));
  site.items[0].blocks.push(
    {
      type: 'requirement',
      id: 'req-a',
      title: 'Requirement A',
      pattern: 'ubiquitous',
      statement: 'System SHALL enforce ID uniqueness.',
      verification: { band: 'code' },
    },
    {
      type: 'requirement',
      id: 'req-a-sc',
      title: 'Collides with req-a-sc on same item page',
      pattern: 'ubiquitous',
      statement: 'Duplicate DOM id.',
      verification: { band: 'code' },
    },
  );
  assert.throws(() => validateSiteInput(site), /duplicate-id/);
});

// Runs under every render policy (src/policy.mjs RENDER_POLICIES), so a new policy is covered automatically.
for (const renderPolicy of RENDER_POLICIES) {
  test(`[Canon-v2 Adv-3] CommonMark and Pandoc GFM do not merge section-level lists into preceding comparison, decision, or diagram blocks [${renderPolicy}]`, async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const work = await tempDir(t, 'canon-v2-adv3');
  await mkdir(join(work, 'evidence'), { recursive: true });
  await writeFile(join(work, 'evidence', 'bench.csv'), 'a,b\n1,2\n');
  await writeFile(join(work, 'evidence', 'receipt.json'), '{"ok":true}\n');

  const r = makeV2SpecimenReport();
  r.sections.push({
    id: 'list-adjacency-edge-cases',
    title: 'List adjacency edge cases',
    blocks: [
      {
        type: 'comparison',
        id: 'cmp-bullets-end',
        title: 'Comparison ending in unordered bullets',
        left: { label: 'Legacy', summary: 'Old path', items: ['Left item'] },
        right: { label: 'Proposed', summary: 'New path', items: ['Right item'] },
      },
      { type: 'list', ordered: false, items: ['Section bullet after comparison', 'Second bullet'] },
      { type: 'list', ordered: false, items: ['Consecutive section bullet list'] },
      {
        type: 'decision',
        id: 'dec-bullets-end',
        status: 'decided',
        question: 'Decision ending in unordered bullets?',
        recommendation: 'Keep lists separate.',
        alternatives: [
          { label: 'Separate', chosen: true, summary: 'Distinct CommonMark lists.' },
          { label: 'Merged', chosen: false, summary: 'Swallowed into prior list.' },
        ],
        consequences: ['Consequence bullet'],
      },
      { type: 'metrics', items: [{ label: 'Metric after decision', value: '100', unit: '%' }] },
      {
        type: 'diagram',
        id: 'diag-ordered-end',
        kind: 'topology',
        title: 'Topology ending in ordered edge list',
        caption: 'Edges end with 1. ...',
        groups: [{ id: 'g1', label: 'Tier 1', nodes: [{ id: 'n1', label: 'Node A' }, { id: 'n2', label: 'Node B' }] }],
        edges: [{ from: 'n1', to: 'n2', label: 'sync' }],
      },
      { type: 'list', ordered: true, items: ['Ordered item after diagram', 'Second ordered item'] },
      { type: 'list', ordered: true, items: ['Second consecutive ordered list'] },
    ],
  });
  await writeFile(join(work, 'report.json'), JSON.stringify(r, null, 2));
  const outDir = join(work, 'out');
  const built = await buildPacket({ reportPath: join(work, 'report.json'), outDir, renderPolicy });
  const md = await readFile(join(outDir, 'report.md'), 'utf8');

  const bytes = new Map(built.manifest.files.map((f) => [f.path, f.bytes]));
  const ctx = {
    labels: new Map(built.manifest.evidence.map((e) => [e.id, e.label])),
    evidence: new Map(built.manifest.evidence.filter((e) => e.path).map((e) => [e.id, { href: e.path, sha256: e.sha256, bytes: bytes.get(e.path) }])),
    sourceSha256: built.manifest.report.sourceSha256,
  };
  const cm = commonmarkOutline(md);
  const exp = expectedOutline(r, ctx);
  assert.deepEqual(cm.blocks, exp.blocks.filter((b) => b.t !== 'table'));
});
}

// Runs under every render policy (src/policy.mjs RENDER_POLICIES), so a new policy is covered automatically.
for (const renderPolicy of RENDER_POLICIES) {
  test(`[Canon-v2 Adv-4] long schema-valid comparison chart baselineLabel and candidateLabel never overlap <text> bounding boxes in Chromium [${renderPolicy}]`, async (t) => {
  const { createRequire } = await import('node:module');
  const { chromium } = await import('playwright-core').catch(() =>
    createRequire(import.meta.url)('playwright-core'));
  const { mkdir } = await import('node:fs/promises');
  const work = await tempDir(t, 'canon-v2-adv4');
  await mkdir(join(work, 'evidence'), { recursive: true });
  await writeFile(join(work, 'evidence', 'bench.csv'), 'a,b\n1,2\n');
  await writeFile(join(work, 'evidence', 'receipt.json'), '{"ok":true}\n');

  const r = makeV2SpecimenReport();
  r.sections[1].blocks[0].baselineLabel = 'Legacy Mutex-Locked Page-Cache Reader (v1.4)';
  r.sections[1].blocks[0].candidateLabel = 'Proposed Epoch-Pinned Zero-Copy Arena Reader (v2.0)';
  await writeFile(join(work, 'report.json'), JSON.stringify(r, null, 2));
  const outDir = join(work, 'out');
  await buildPacket({ reportPath: join(work, 'report.json'), outDir, renderPolicy });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${join(outDir, 'index.html')}`);
    const overlaps = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('#chart-throughput-cmp svg text')];
      const rects = texts.map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
      const found = [];
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i].r;
          const b = rects[j].r;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 1 && oy > 1) found.push({ a: rects[i].text, b: rects[j].text, ox, oy });
        }
      }
      return found;
    });
    assert.deepEqual(overlaps, []);
  } finally {
    await browser.close();
  }
});
}

test('[Canon-v2 Adv-5] scanHtmlPolicy and verifySiteBundle reject single-quoted attribute masking and raw > inside attribute quotes', async (t) => {
  const { scanHtmlPolicy } = await import('../../src/packet/verify.mjs');
  const { buildSiteBundle } = await import('../../src/site/build.mjs');
  const { verifySiteBundle } = await import('../../src/site/verify.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdir } = await import('node:fs/promises');

  const work = await tempDir(t, 'canon-v2-adv5');
  await mkdir(join(work, 'evidence'), { recursive: true });
  await writeFile(join(work, 'evidence', 'bench.csv'), 'a,b\n1,2\n');
  await writeFile(join(work, 'evidence', 'receipt.json'), '{"ok":true}\n');
  await writeFile(join(work, 'report.json'), JSON.stringify(makeV2SpecimenReport(), null, 2));
  // Attacks 1-2 run under every render policy (src/policy.mjs RENDER_POLICIES); site bundles are policy/1 only (R1).
  for (const renderPolicy of RENDER_POLICIES) {
    const outDir = join(work, `out-${renderPolicy.replace('/', '-')}`);
    const built = await buildPacket({ reportPath: join(work, 'report.json'), outDir, renderPolicy });
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    const inv = new Set(built.manifest.files.map((f) => f.path));
    const report = built.output.has('report.json') ? JSON.parse(built.output.get('report.json').toString('utf8')) : null;
    const opts = { renderPolicy, edition: { manifest: built.manifest, report } };

    // Attack 1: single-quoted attribute masking opening a fake title=" span
    const maskedHtml = html.replace(
      '</main>',
      `<a class=' title="' onclick='alert(1)' style='color:red' href='javascript:alert(1)' data-z='"'>Bypass</a></main>`,
    );
    const maskedProblems = scanHtmlPolicy(maskedHtml, inv, opts);
    assert.ok(maskedProblems.length > 0, `single-quoted attribute masking must fail scanHtmlPolicy (${renderPolicy})`);

    // Attack 2: raw ">" inside double-quoted attribute hiding trailing onclick=
    const gtHtml = html.replace(
      '</main>',
      `<span title="a>b" onclick="alert(1)">Bypass</span></main>`,
    );
    const gtProblems = scanHtmlPolicy(gtHtml, inv, opts);
    assert.ok(gtProblems.some((p) => p.includes('inline event handler') || p.includes('malformed')), `raw > inside attribute must not hide onclick (${renderPolicy})`);
  }

  // Attack 3: resealed site-bundle/v1 with single-quoted attribute masking must fail verifySiteBundle
  const siteDir = join(work, 'site');
  await buildSiteBundle({
    sitePath: new URL('../../fixtures/site/first-slice.site-input.json', import.meta.url).pathname,
    outDir: siteDir,
  });
  const itemPath = join(siteDir, 'item/retention-window/index.html');
  const itemHtml = (await readFile(itemPath, 'utf8')).replace(
    '</main>',
    `<a class=' title="' onclick='alert(1)' style='color:red' href='javascript:alert(1)' data-z='"'>Bypass</a></main>`,
  );
  await writeFile(itemPath, itemHtml);
  const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  const manifest = JSON.parse(await readFile(join(siteDir, 'manifest.json'), 'utf8'));
  const fEntry = manifest.files.find((f) => f.path === 'item/retention-window/index.html');
  const buf = Buffer.from(itemHtml, 'utf8');
  fEntry.bytes = buf.length;
  fEntry.sha256 = sha(buf);
  const { contentId: _, ...unsigned } = manifest;
  manifest.contentId = `sha256-${sha(Buffer.from(canonical(unsigned), 'utf8'))}`;
  await writeFile(join(siteDir, 'manifest.json'), `${canonical(manifest)}\n`);
  const checksums = { schema: 'checksums/v1', algorithm: 'sha256', contentId: manifest.contentId, files: manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  await writeFile(join(siteDir, 'checksums.json'), `${canonical(checksums)}\n`);

  const siteVerified = await verifySiteBundle(siteDir);
  assert.equal(siteVerified.ok, false, 'resealed forged site bundle must fail verifySiteBundle');
  assert.ok(siteVerified.errors.some((e) => e.code === 'unsafe-content'));
});

// Runs under every render policy (src/policy.mjs RENDER_POLICIES), so a new policy is covered automatically.
for (const renderPolicy of RENDER_POLICIES) {
  test(`[Canon-v2 Adv-6] max-length schema inputs across chart series/units and flow/topology/sequence diagrams have zero <text> overlaps and zero <svg> viewBox clipping in Chromium [${renderPolicy}]`, async (t) => {
  const { createRequire } = await import('node:module');
  const { chromium } = await import('playwright-core').catch(() =>
    createRequire(import.meta.url)('playwright-core'));
  const { mkdir } = await import('node:fs/promises');
  const work = await tempDir(t, 'canon-v2-adv6');
  await mkdir(join(work, 'evidence'), { recursive: true });
  await writeFile(join(work, 'evidence', 'bench.csv'), 'a,b\n1,2\n');
  await writeFile(join(work, 'evidence', 'receipt.json'), '{"ok":true}\n');

  const r = makeV2SpecimenReport();
  r.sections.push({
    id: 'max-schema-svg-stress',
    title: 'Max schema SVG geometry stress',
    blocks: [
      {
        type: 'chart',
        id: 'cmp-max-stress',
        kind: 'comparison',
        title: 'Max comparison stress',
        baselineLabel: 'W'.repeat(80),
        candidateLabel: 'M'.repeat(80),
        unit: 'requests per second',
        series: [
          { label: 'W'.repeat(80), baseline: 1200, value: 4800 },
          { label: 'ROCKSDB_COMPACTION_WRITE_STALL', baseline: 1000, value: 1 },
        ],
        caption: 'Max width comparison chart.',
      },
      {
        type: 'chart',
        id: 'quant-max-stress',
        kind: 'quantiles',
        title: 'Max quantiles stress',
        unit: 'microseconds',
        budget: 250,
        series: [
          { label: 'W'.repeat(80), p50: 45.2, p95: 98.4, p99: 142.5, max: 240.0 },
          { label: 'ROCKSDB_COMPACTION_WRITE_STALL', p50: 12.1, p95: 33.0, p99: 88.9 },
        ],
        caption: 'Max width quantiles chart.',
      },
      {
        type: 'diagram',
        id: 'flow-max-stress',
        kind: 'flow',
        title: 'Max flow stress',
        caption: 'Max width flow.',
        steps: [
          { label: 'W'.repeat(80), detail: 'Step 1', gate: true },
          { label: 'M'.repeat(80), detail: 'Step 2' },
          { label: 'ROCKSDB_COMPACTION_WRITE_STALL_GATE', detail: 'Step 3', gate: true },
        ],
      },
      {
        type: 'diagram',
        id: 'topo-max-stress',
        kind: 'topology',
        title: 'Max topology stress',
        caption: 'Max width topology.',
        groups: [
          {
            id: 'tg1',
            label: 'W'.repeat(80),
            nodes: [
              { id: 'tn1', label: 'W'.repeat(80), sublabel: 'W'.repeat(80) },
              { id: 'tn2', label: 'ROCKSDB_COMPACTION_WRITE_STALL', sublabel: 'M'.repeat(80) },
            ],
          },
        ],
        edges: [{ from: 'tn1', to: 'tn2', label: 'W'.repeat(60), style: 'gate' }],
      },
      {
        type: 'diagram',
        id: 'seq-max-stress',
        kind: 'sequence',
        title: 'Max sequence stress',
        caption: 'Max width sequence.',
        actors: [
          { id: 'sa1', label: 'W'.repeat(60) },
          { id: 'sa2', label: 'M'.repeat(60) },
        ],
        messages: [
          { from: 'sa1', to: 'sa2', label: 'W'.repeat(80), note: 'W'.repeat(120), gate: true },
        ],
      },
      {
        type: 'requirement',
        id: 'req-max-stress',
        title: 'W'.repeat(100),
        pattern: 'event',
        statement: 'WHEN ' + 'W'.repeat(80) + ', the engine SHALL ' + 'M'.repeat(80) + '.',
        verification: { band: 'code', detail: 'W'.repeat(200) },
      },
      {
        type: 'comparison',
        id: 'cmp-block-max-stress',
        title: 'W'.repeat(100),
        left: { label: 'W'.repeat(80), summary: 'W'.repeat(120), items: ['W'.repeat(100)] },
        right: { label: 'M'.repeat(80), summary: 'M'.repeat(120), items: ['M'.repeat(100)] },
      },
      {
        type: 'decision',
        id: 'dec-max-stress',
        status: 'decided',
        context: ['W'.repeat(120)],
        question: 'W'.repeat(120),
        recommendation: ['W'.repeat(120)],
        alternatives: [
          { label: 'W'.repeat(80), summary: 'W'.repeat(120), chosen: true },
          { label: 'M'.repeat(80), summary: 'M'.repeat(120) },
        ],
        consequences: ['W'.repeat(120)],
      },
    ],
  });

  await writeFile(join(work, 'report.json'), JSON.stringify(r, null, 2));
  const outDir = join(work, 'out');
  await buildPacket({ reportPath: join(work, 'report.json'), outDir, renderPolicy });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${join(outDir, 'index.html')}`);
    const issues = await page.evaluate(() => {
      const ids = [
        '#chart-cmp-max-stress svg',
        '#chart-quant-max-stress svg',
        '#diagram-flow-max-stress svg',
        '#diagram-topo-max-stress svg',
        '#diagram-seq-max-stress svg',
      ];
      const problems = [];
      for (const sel of ids) {
        const svg = document.querySelector(sel);
        const sr = svg.getBoundingClientRect();
        const texts = [...svg.querySelectorAll('text')].map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
        for (const t of texts) {
          if (t.r.left < sr.left - 1.5 || t.r.right > sr.right + 1.5 || t.r.top < sr.top - 1.5 || t.r.bottom > sr.bottom + 1.5) {
            problems.push({ sel, kind: 'clipped', text: t.text.slice(0, 30), leftOut: sr.left - t.r.left, rightOut: t.r.right - sr.right });
          }
        }
        for (let i = 0; i < texts.length; i += 1) {
          for (let j = i + 1; j < texts.length; j += 1) {
            const a = texts[i].r;
            const b = texts[j].r;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 1.5 && oy > 1.5) {
              problems.push({ sel, kind: 'overlap', a: texts[i].text.slice(0, 24), b: texts[j].text.slice(0, 24), ox, oy });
            }
          }
        }
      }
      if (document.documentElement.scrollWidth > window.innerWidth) {
        problems.push({ kind: 'page-overflow', vw: window.innerWidth, sw: document.documentElement.scrollWidth });
      }
      return problems;
    });
    assert.deepEqual(issues, []);

    for (const vw of [390, 320]) {
      await page.setViewportSize({ width: vw, height: 800 });
      const overflow = await page.evaluate(() => ({
        vw: window.innerWidth,
        sw: document.documentElement.scrollWidth,
      }));
      assert.ok(overflow.sw <= overflow.vw, `expected scrollWidth (${overflow.sw}) <= innerWidth (${overflow.vw}) on max-schema stress`);
    }
  } finally {
    await browser.close();
  }
});
}

test('[Canon-v2] committed specimen-v2 fixture builds deterministically, passes verifyPacket, and rejects tampering', async (t) => {
  const work = await tempDir(t, 'canon-v2-specimen-fixture');
  const reportPath = new URL('../../fixtures/specimen-v2/canon-specimen-v2.report.json', import.meta.url).pathname;
  const outA = join(work, 'a');
  const outB = join(work, 'b');
  const pktA = await buildPacket({ reportPath, outDir: outA });
  const pktB = await buildPacket({ reportPath, outDir: outB });
  assert.equal(pktA.contentId, pktB.contentId);
  assert.equal((await verifyPacket(outA)).ok, true);

  // Negative check: mutating 1 character in report.md fails verifyPacket
  const mdPath = join(outB, 'report.md');
  const md = await readFile(mdPath, 'utf8');
  await writeFile(mdPath, `${md}\n`);
  assert.equal((await verifyPacket(outB)).ok, false);
});
