// Agent-Markdown parity and evidence (requirement items 2, 3, 5): every source
// element of the golden report maps to a report.md node inside its anchored block and
// to an HTML element inside the block with the same id; anything unmapped fails.
// Writes the parity table, anchor map, escape inventory and a readable excerpt of the
// golden report.md to CANON_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { anchor } from '../../src/render/anchors.mjs';
import { anchorProblems, codeSpanLiterals, CONSERVATIVE_CLASSES, escapeInventory, expectedAnchors } from '../agent-md-gates.mjs';
import { FIXTURE } from '../helpers.mjs';
import { buildCorpusPacket } from '../md-corpus.mjs';
import { ENGINES, evidencePath, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

const squash = (s) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();
const plain = (value, labels) => (typeof value === 'string' ? value : value.map((s) => (typeof s === 'string' ? s : s.text ?? s.code ?? s.em ?? s.strong ?? s.link?.text ?? (s.cite ? `[${labels.get(s.cite)}]` : ''))).join(''));

// Enum values: index.html shows their display label ("proposed" -> "Proposed").
const CASELESS = new Set(['metadata-status', 'evidence-status']);

// Every authored element of report/v1, with the innermost anchored block it belongs
// to ("document" for the title block before the summary).
function sourceElements(report, labels) {
  const out = [];
  const add = (scope, kind, value, verbatim = false) => out.push({ scope, kind, text: verbatim ? value : squash(value), verbatim, caseless: CASELESS.has(kind) });
  const meta = report.metadata;
  add('document', 'title', report.title);
  if (report.subtitle) add('document', 'subtitle', report.subtitle);
  for (const [k, v] of [['status', meta.status], ['classification', meta.classification], ['review-date', meta.reviewDate], ['review-request', meta.reviewRequest]]) add('document', `metadata-${k}`, v);
  for (const a of meta.authors) add('document', 'metadata-author', a);
  add('summary', 'verdict', plain(report.summary.verdict.text, labels));
  for (const p of report.summary.paragraphs) add('summary', 'summary-paragraph', plain(p, labels));
  for (const m of report.summary.metrics?.items ?? []) { add('summary', 'metric-label', m.label); add('summary', 'metric-value', m.value); if (m.unit) add('summary', 'metric-unit', m.unit); }
  const block = (scope, b) => {
    switch (b.type) {
      case 'paragraph': add(scope, 'paragraph', plain(b.text, labels)); break;
      case 'list': for (const i of b.items) add(scope, 'list-item', plain(i, labels)); break;
      case 'finding': {
        const s = anchor.finding(b);
        add(s, 'finding-id', b.id); add(s, 'finding-title', b.title); add(s, 'claim', plain(b.claim, labels));
        if (b.verification?.detail) add(s, 'finding-verification', b.verification.detail);
        for (const e of b.evidence) out.push({ scope: s, kind: 'finding-evidence-ref', text: `[${labels.get(e)}]`, href: `#${anchor.evidenceItem(e)}` });
        for (const d of b.detail ?? []) block(s, d);
        break;
      }
      case 'decision': {
        const s = anchor.decision(b);
        add(s, 'decision-id', b.id); add(s, 'decision-question', b.question); add(s, 'recommendation', plain(b.recommendation, labels));
        if (b.owner) add(s, 'decision-owner', b.owner);
        if (b.context) add(s, 'decision-context', plain(b.context, labels));
        for (const a of b.alternatives) { add(s, 'alternative-label', a.label); add(s, 'alternative-summary', plain(a.summary, labels)); }
        for (const c of b.consequences ?? []) add(s, 'decision-consequence', plain(c, labels));
        break;
      }
      case 'risk': { const s = anchor.risk(b); add(s, 'risk-id', b.id); add(s, 'risk-title', b.title); add(s, 'likelihood', b.likelihood); add(s, 'impact', b.impact); add(s, 'mitigation', plain(b.mitigation, labels)); break; }
      case 'requirement': {
        const s = anchor.requirement(b);
        add(s, 'req-id', b.id); add(s, 'req-title', b.title); add(s, 'req-statement', plain(b.statement, labels));
        for (const sc of b.scenarios ?? []) { add(s, 'sc-name', sc.name); add(s, 'sc-given', sc.given); add(s, 'sc-when', sc.when); add(s, 'sc-then', sc.then); }
        break;
      }
      case 'comparison': {
        const s = anchor.comparison(b);
        add(s, 'cmp-title', b.title);
        if (b.caption) add(s, 'cmp-caption', plain(b.caption, labels));
        for (const side of [b.left, b.right]) {
          add(s, 'cmp-side-label', side.label);
          add(s, 'cmp-side-summary', plain(side.summary, labels));
          for (const it of side.items ?? []) add(s, 'cmp-side-item', plain(it, labels));
          if (side.code) for (const line of side.code.source.split('\n').filter((l) => l.trim())) add(s, 'cmp-code-line', line, true);
        }
        break;
      }
      case 'code': case 'diff': {
        const s = anchor.code(b);
        add(s, `${b.type}-title`, b.title);
        if (b.caption) add(s, `${b.type}-caption`, plain(b.caption, labels));
        for (const line of (b.type === 'code' ? b.source : b.patch).split('\n').filter((l) => l.trim())) add(s, `${b.type}-line`, line, true);
        break;
      }
      case 'table': { const s = anchor.table(b); add(s, 'table-caption', b.caption); for (const c of b.columns) add(s, 'table-column', c.label); for (const r of b.rows) for (const c of b.columns) add(s, 'table-cell', plain(r[c.key], labels)); break; }
      case 'chart': {
        const s = anchor.chart(b);
        add(s, 'chart-title', b.title); add(s, 'chart-caption', plain(b.caption, labels));
        if (b.kind === 'quantiles') {
          for (const p of b.series) { add(s, 'chart-label', p.label); add(s, 'chart-p50', String(p.p50)); add(s, 'chart-p95', String(p.p95)); add(s, 'chart-p99', String(p.p99)); }
        } else {
          for (const p of b.series) { add(s, 'chart-label', p.label); if (b.kind === 'comparison') add(s, 'chart-baseline', String(p.baseline)); add(s, 'chart-value', String(p.value)); }
        }
        add(s, 'chart-unit', b.unit);
        break;
      }
      case 'diagram': {
        const s = anchor.diagram(b);
        add(s, 'diagram-title', b.title); add(s, 'diagram-caption', plain(b.caption, labels));
        if (b.kind === 'topology') {
          for (const g of b.groups) { add(s, 'diagram-group', g.label); for (const n of g.nodes) add(s, 'diagram-node', n.label); }
        } else if (b.kind === 'sequence') {
          for (const m of b.messages) add(s, 'diagram-msg', m.label);
        } else {
          for (const st of b.steps) { add(s, 'diagram-step', st.label); add(s, 'diagram-detail', st.detail); }
        }
        break;
      }
      default: throw new Error(`unmapped block type ${b.type}`);
    }
  };
  const section = (s, appendix) => { const id = anchor.section(s, appendix); add(id, 'section-title', s.title); if (s.lede) add(id, 'section-lede', s.lede); for (const b of s.blocks) block(id, b); };
  report.sections.forEach((s) => section(s, false));
  for (const e of report.evidence) {
    const s = anchor.evidenceItem(e.id);
    add(s, 'evidence-id', e.id); add(s, 'evidence-title', e.title);
    if (e.kind !== 'file') { add(s, 'evidence-status', e.kind); add(s, 'evidence-reason', e.reason); }
  }
  (report.appendices ?? []).forEach((s) => section(s, true));
  if (report.provenance.notes) add('provenance', 'provenance-notes', plain(report.provenance.notes, labels));
  for (const src of report.provenance.sources) { add('provenance', 'source-label', src.label); add('provenance', 'source-reference', src.reference); if (src.revision) add('provenance', 'source-revision', src.revision); if (src.sha256) add('provenance', 'source-sha256', src.sha256); }
  return out;
}

// report.md scopes: for each anchor, the lines from its heading to the next heading of
// the same or a higher level; "document" is everything before the first anchor.
function markdownScopes(md) {
  const lines = md.split('\n');
  const scopes = new Map();
  const headings = [];
  let fence = null;
  lines.forEach((l, n) => {
    const f = l.match(/^(`{3,})/);
    if (fence) { if (f && f[1].length >= fence && /^`+$/.test(l)) fence = null; return; }
    if (f) { fence = f[1].length; return; }
    const m = l.match(/^(#{1,6}) /);
    if (m) headings.push({ n, level: m[1].length });
  });
  lines.forEach((l, n) => {
    const d = l.match(/^\[([^\]]+)\]: #\1$/);
    if (!d) return;
    const h = headings.findLast((x) => x.n < n);
    const end = headings.find((x) => x.n > h.n && x.level <= h.level)?.n ?? lines.length;
    scopes.set(d[1], lines.slice(h.n, end).join('\n'));
  });
  scopes.set('document', lines.slice(0, headings.find((x) => x.level === 2)?.n ?? lines.length).join('\n'));
  return scopes;
}

// Block nodes of a Markdown slice with their text; GFM table rows (paragraphs to
// CommonMark) are reported as table rows.
function markdownNodes(slice) {
  const nodes = [];
  const doc = new commonmark.Parser().parse(slice);
  const text = (node) => { let s = ''; const w = node.walker(); let e; while ((e = w.next())) if (e.entering) { if (e.node.type === 'text' || e.node.type === 'code') s += e.node.literal; else if (e.node.type === 'softbreak' || e.node.type === 'linebreak') s += ' '; } return s; };
  const w = doc.walker();
  let e;
  while ((e = w.next())) {
    if (!e.entering) continue;
    const n = e.node;
    if (n.type === 'heading' || n.type === 'item') nodes.push({ type: n.type === 'item' ? 'list-item' : `heading${n.level}`, text: squash(text(n)) });
    else if (n.type === 'paragraph' && n.parent.type !== 'item') { const t = text(n); nodes.push({ type: /^\|/.test(t) ? 'table-row' : 'paragraph', text: squash(t) }); }
    else if (n.type === 'code_block') nodes.push({ type: 'code-block', lines: n.literal.split('\n'), info: n.info });
  }
  return nodes;
}

function mapMarkdown(el, scopes, nodeCache) {
  const slice = scopes.get(el.scope);
  if (!slice) return null;
  if (!nodeCache.has(el.scope)) nodeCache.set(el.scope, markdownNodes(slice));
  const nodes = nodeCache.get(el.scope);
  const hit = el.verbatim ? nodes.find((x) => x.type === 'code-block' && x.lines.includes(el.text)) : nodes.find((x) => (el.caseless ? x.text?.toLowerCase().includes(el.text.toLowerCase()) : x.text?.includes(el.text)));
  return hit ? hit.type : null;
}

const results = { parity: [], anchors: null, escapes: null };
test.after(async () => {
  await saveJson('e8-parity.json', results.parity);
  if (results.anchors) await saveJson('e8-anchor-map.json', results.anchors);
  if (results.escapes) await saveJson('e8-escape-inventory.json', results.escapes);
});

for (const engine of ENGINES) {
  test(`[E8] ${engine.name}: every source element maps to a report.md node and an HTML element in the same anchored block`, async () => {
    const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const manifest = await (await fetch(`${env.packetUrl}manifest.json`)).json();
    const labels = new Map(manifest.evidence.map((e) => [e.id, e.label]));
    const elements = sourceElements(report, labels);
    const md = await (await fetch(`${env.packetUrl}report.md`)).text();
    const scopes = markdownScopes(md);
    const cache = new Map();
    const browser = await engine.type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(env.packetUrl);
      const htmlTags = await page.evaluate((els) => {
        const squashIn = (s) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();
        return els.map((el) => {
          const root = el.scope === 'document' ? document.body : document.getElementById(el.scope);
          if (!root) return null;
          // An evidence reference is a link to the evidence item's anchor.
          if (el.href) return root.querySelector(`a[href="${el.href}"]`) ? 'a' : null;
          if (el.verbatim) {
            const pre = [...root.querySelectorAll('pre')].find((p) => p.innerText.split('\n').includes(el.text));
            return pre ? 'pre' : null;
          }
          const candidates = [root, ...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,dd,dt,figcaption,strong,span,code,a,caption,summary,div,dl')];
          // textContent, not innerText: CSS text-transform must not hide source text.
          const norm = (x) => (el.caseless ? squashIn(x).toLowerCase() : squashIn(x));
          const want = el.caseless ? el.text.toLowerCase() : el.text;
          const hits = candidates.filter((c) => norm(c.textContent ?? '').includes(want));
          // The innermost element that contains the text.
          const inner = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
          return inner[0]?.tagName.toLowerCase() ?? null;
        });
      }, elements);
      const rows = elements.map((el, i) => ({ kind: el.kind, anchor: el.scope, text: el.text.length > 90 ? `${el.text.slice(0, 87)}…` : el.text, markdownNode: mapMarkdown(el, scopes, cache), htmlElement: htmlTags[i] }));
      const unmapped = rows.filter((r) => !r.markdownNode || !r.htmlElement);
      results.parity.push({ engine: engine.name, version: browser.version(), contentId: manifest.contentId, elements: rows.length, unmapped: unmapped.length, rows });
      assert.deepEqual(unmapped, [], 'source elements with no report.md node or HTML element in their anchored block');
      assert.ok(rows.length > 100, `parity covers ${rows.length} source elements`);
    } finally {
      await browser.close();
    }
  });
}

test('[E8] anchor map, escape inventory and readable excerpt of the golden report.md', async (t) => {
  const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const manifest = await (await fetch(`${env.packetUrl}manifest.json`)).json();
  const md = await (await fetch(`${env.packetUrl}report.md`)).text();
  const html = await (await fetch(env.packetUrl)).text();
  const bytes = new Map(manifest.files.map((f) => [f.path, f.bytes]));
  const ctx = { labels: new Map(manifest.evidence.map((e) => [e.id, e.label])), evidence: new Map(manifest.evidence.filter((e) => e.path).map((e) => [e.id, { href: e.path, sha256: e.sha256, bytes: bytes.get(e.path) }])), sourceSha256: manifest.report.sourceSha256 };
  const expected = expectedAnchors(report, ctx, anchor);
  const a = anchorProblems(md, html, expected);
  assert.deepEqual(a.problems, []);
  results.anchors = {
    convention: 'reference-definitions/1: the CommonMark link reference definition "[id]: #id" on its own line directly after a heading (one blank line between) names that heading\'s anchor; id is the id of the same block in index.html',
    contentId: manifest.contentId,
    anchors: a.definitions.map((d) => ({ id: d.id, markdownLine: d.line, markdownHeading: d.heading, htmlElement: html.match(new RegExp(`<(\\w+)[^>]*\\bid="${d.id}"`))?.[1] ?? null, reportUrlFragment: `report.md#${d.id}`, htmlUrlFragment: `index.html#${d.id}` })),
    htmlOnlySubIds: 'element ids for parts of a block (heading "-h"/"-t", "-cap", "-ev", "-alts", "-title", code line "-L<n>", "content", "prov-cap", "verify-h") have no report.md anchor: they address parts of an anchored block',
  };
  const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
  const pandoc = which.status === 0 ? which.stdout.trim() : null;
  const dir = await mkdtemp(join(tmpdir(), 'canon-e8-inv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const corpus = await buildCorpusPacket(dir);
  const goldenInv = escapeInventory(md, { pandoc });
  const corpusInv = escapeInventory(corpus.markdown, { pandoc });
  results.escapes = {
    oracle: 'per character: from the document with every escape replaced by what it stands for, an escape is required when restoring it alone changes the commonmark 0.31.2 or pandoc -f gfm parse; any other escape must be in a listed conservative class',
    conservativeClasses: CONSERVATIVE_CLASSES,
    golden: { contentId: manifest.contentId, ...goldenInv, unjustified: goldenInv.unjustified.length, codeSpanLiterals: codeSpanLiterals(md) },
    corpus: { source: 'fixtures/corpus/realistic-prose.json', ...corpusInv, unjustified: corpusInv.unjustified.length, codeSpanLiterals: codeSpanLiterals(corpus.markdown) },
  };
  assert.equal(goldenInv.unjustified.length + corpusInv.unjustified.length, 0);
  // A readable excerpt: the start of the golden report.md as served, and its
  // CommonMark rendering.
  const excerpt = md.split('\n').slice(0, 80).join('\n');
  const mdPath = await evidencePath('e8-report-md-excerpt.md');
  if (mdPath) await writeFile(mdPath, `${excerpt}\n`);
  const htmlPath = await evidencePath('e8-report-md-excerpt.rendered.html');
  if (htmlPath) await writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><title>report.md excerpt (CommonMark rendering)</title>\n${new commonmark.HtmlRenderer({ safe: true }).render(new commonmark.Parser().parse(excerpt))}`);
});
