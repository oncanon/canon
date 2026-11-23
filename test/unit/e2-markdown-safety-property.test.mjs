// Structural safety property for report.md (E2E fix cycle 2, QA D-E1..D-E3).
//
// For every authored-text insertion point, an adversarial string must not change
// the structure the renderer generates. Each attack is injected into all
// insertion points at once and compared with a benign build (the same fields set
// to a plain word). Two independent readers parse the output:
//   - CommonMark: the project's commonmark 0.31.2 (dev dependency);
//   - GFM: the system pandoc (`pandoc -f gfm -t json`). Pandoc's gfm reader is
//     not GitHub's cmark-gfm; it is an equivalence approximation of GFM.
// Asserted for every attack, under both readers:
//   - no raw HTML nodes, no images;
//   - links only to the structured destinations the report defines, except (GFM
//     only, accepted residual) a bare-URL autolink whose text is that literal URL
//     and which appears verbatim in the authored string;
//   - every code/diff block is one code block whose literal is exactly the source;
//   - the structure signature (block and inline node types, heading levels,
//     table shapes) equals the benign baseline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { buildPacket } from '../../src/packet/build.mjs';
import { REPO, tempDir } from '../helpers.mjs';

const BS = '\\';
const TICK = '`';
const BENIGN = 'benign';

// ---- adversarial corpus -------------------------------------------------------
const indents = ['', ' ', '  ', '   '];
const SINGLE_LINE = [
  // backtick and tilde runs, indentation 0-3
  ...indents.flatMap((i) => [`${i}${TICK}`, `${i}${TICK.repeat(3)}`, `${i}${TICK.repeat(4)}x`, `${i}~~~`, `${i}~~~~ x`]),
  `open ${TICK} tick`, `a ${TICK}${TICK} b`, '~~strike~~', '~single~', 'x ~~ y',
  // raw HTML start forms, both cases
  '<script>alert(1)</script>', '<SCRIPT>alert(1)</SCRIPT>', '</div>', '</DIV>', '<!-- c -->', '<?php x ?>',
  '<!doctype html>', '<!DOCTYPE html>', '<!x-y z>', '<!X-Y Z>', '<![CDATA[x]]>', '<img src=x onerror=alert(1)>',
  '<IMG SRC=x ONERROR=alert(1)>', '<a href="https://evil.example">a</a>', '<svg onload=alert(1)>', '<x:y z>', '<b>bold</b>',
  // autolinks and bare URLs
  '<https://auto.example>', '<HTTPS://AUTO.EXAMPLE>', '<mailto:a@b.example>', '<a@b.example>',
  'https://bare.example/path', 'see https://bare.example.', 'www.bare.example', 'bare@mail.example',
  // bare URL, www and email tokens glued to markup (pandoc autolinks swallow escapes)
  ...['https://x.example', 'www.x.example', 'a@b.example', 'mailto:a@b.example', 'ftp://x.example', 'note:'].flatMap((u) => [
    `${u}<script>alert(1)</script>`, `${u}<b>x</b>`, `${u}*bold*`, `${u}${TICK}code${TICK}`, `${u}_u_`, `${u}[x](https://evil.example)`, `${u}|a|`, `${u}~~s~~`, `${u}${BS}`, `${u}${BS}<b>x</b>`,
  ]),
  // backslashes
  BS, `${BS}<b>x</b>`, `${BS}${BS}<b>x</b>`, `${BS}${TICK}`, `${BS}[x](https://evil.example)`, `trailing ${BS}`, `${BS}${BS}${BS}*x`,
  // link and image syntax, forged citations
  '[x](https://evil.example)', '![i](https://evil.example/i.png)', '[x][ref]', '[ref]: https://evil.example', '[E1]', '[E1](https://evil.example)', '[^1]', '<https://evil.example>[E1]',
  // line-start block markers
  '# H', '###### H', '> quote', '- item', '+ item', '* item', '1. item', '1) item', '---', '===', '***', '    indented', '| a | b |', '|---|---|',
  // entities
  '&amp;', '&#60;script&#62;', '&lt;b&gt;', '&copy;', '&#x26;',
  // unmatched delimiters
  '*a', '_a', '**', '__', '[a', 'a]', '(', ')', `${TICK}a`, `a${TICK}`, '~~a', '<', '>', '<<', 'a <b c',
];
const MULTI_LINE = [
  ...indents.map((i) => `a\n${i}${TICK.repeat(3)}\n<script>alert(1)</script><img src=x onerror=alert(2)>\n[x](https://evil.example)\n# Injected heading`),
  ...indents.map((i) => `a\n${i}~~~\n<b>x</b>\n# h`),
  `${TICK.repeat(3)}\nx\n${TICK.repeat(3)}`, `${TICK.repeat(5)}\n  ${TICK.repeat(7)}\n`, '<!doctype html>\n<html>', `line\n\n# after blank\n> q\n- l`,
  `\t${TICK.repeat(3)}\n x`, `${TICK.repeat(3)} info\n`,
];

// ---- insertion points -----------------------------------------------------------
// [name, setter(report, value), maxChars, multiline]
function points(report) {
  const S = report.sections;
  const findings = S[0].blocks.filter((b) => b.type === 'finding');
  const table = S[1].blocks.find((b) => b.type === 'table');
  const code = S[1].blocks.find((b) => b.type === 'code');
  const diff = S[1].blocks.find((b) => b.type === 'diff');
  const diagram = S[1].blocks.find((b) => b.type === 'diagram');
  const chart = S[2].blocks.find((b) => b.type === 'chart');
  const decision = S[3].blocks.find((b) => b.type === 'decision');
  const risk = S[4].blocks.find((b) => b.type === 'risk');
  return [
    ['title', (v) => { report.title = v; }, 160],
    ['subtitle', (v) => { report.subtitle = v; }, 300],
    ['metadata.classification', (v) => { report.metadata.classification = v; }, 80],
    ['metadata.reviewRequest', (v) => { report.metadata.reviewRequest = v; }, 300],
    ['metadata.authors', (v) => { report.metadata.authors = [v]; }, 120],
    ['summary.paragraph', (v) => { report.summary.paragraphs[0] = v; }, 20000],
    ['summary.inline-text-with-cite', (v) => { report.summary.paragraphs[1] = [v, { cite: 'ev-cache-probe' }, v, { code: 'x' }, v]; }, 20000],
    ['summary.em-strong', (v) => { report.summary.paragraphs[2] = ['x ', { em: v }, ' y ', { strong: v }, ' z']; }, 20000],
    ['summary.link-label', (v) => { report.summary.verdict.text = [{ link: { text: v, href: 'https://example.com/ok' } }, ' ', { cite: 'ev-determinism' }]; }, 500],
    ['metrics.label', (v) => { report.summary.metrics.items[0].label = v; }, 80],
    ['metrics.value', (v) => { report.summary.metrics.items[1].value = v; }, 40],
    ['section.title', (v) => { S[0].title = v; }, 120],
    ['section.lede', (v) => { S[0].lede = v; }, 600],
    ['finding.title', (v) => { findings[0].title = v; }, 200],
    ['finding.claim', (v) => { findings[0].claim = v; }, 20000],
    ['finding.detail', (v) => { findings[0].detail = [{ type: 'paragraph', text: v }]; }, 20000],
    ['table.caption', (v) => { table.caption = v; }, 300],
    ['table.column-label', (v) => { table.columns[1].label = v; }, 80],
    ['table.cell', (v) => { table.rows[0].role = v; }, 20000],
    ['table.cell-inline', (v) => { table.rows[1].role = [v, { code: 'c' }, v]; }, 20000],
    ['code.title', (v) => { code.title = v; }, 200],
    ['code.caption', (v) => { code.caption = v; }, 20000],
    ['diagram.caption', (v) => { diagram.caption = v; }, 20000],
    ['diagram.step-label', (v) => { diagram.steps[0].label = v; }, 80],
    ['diagram.step-detail', (v) => { diagram.steps[1].detail = v; }, 240],
    ['chart.title', (v) => { chart.title = v; }, 200],
    ['chart.label', (v) => { chart.series[0].label = v; }, 80],
    ['chart.caption', (v) => { chart.caption = v; }, 20000],
    ['decision.question', (v) => { decision.question = v; }, 500],
    ['decision.alternative-label', (v) => { decision.alternatives[0].label = v; }, 120],
    ['decision.alternative-summary', (v) => { decision.alternatives[1].summary = v; }, 20000],
    ['decision.owner', (v) => { decision.owner = v; }, 120],
    ['risk.title', (v) => { risk.title = v; }, 200],
    ['risk.mitigation', (v) => { risk.mitigation = v; }, 20000],
    ['evidence.title', (v) => { report.evidence[0].title = v; }, 200],
    ['evidence.redacted-reason', (v) => { report.evidence[3].reason = v; }, 500],
    ['appendix.list-item', (v) => { report.appendices[0].blocks[0].items[0] = v; }, 20000],
    ['provenance.label', (v) => { report.provenance.sources[0].label = v; }, 160],
    ['provenance.reference', (v) => { report.provenance.sources[0].reference = v; }, 400],
    ['provenance.notes', (v) => { report.provenance.notes = v; }, 20000],
    ['code.source', (v) => { code.source = v; delete code.highlight; }, 200000, true],
    ['diff.patch', (v) => { diff.patch = v; }, 200000, true],
  ];
}

// ---- rendering and parsing --------------------------------------------------------
let fixtureText;
async function render(t, value, { multiline }) {
  const root = await tempDir(t, 'canon-md-prop');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const report = JSON.parse(fixtureText);
  const code = report.sections[1].blocks.find((b) => b.type === 'code');
  delete code.highlight;
  const applied = [];
  for (const [name, set, max, isMulti] of points(report)) {
    // Single-line attacks go into every point they fit; multi-line attacks only
    // into code and diff sources (the only multi-line authored fields).
    const eligible = multiline ? Boolean(isMulti) : true;
    const v = eligible && value.length <= max ? value : BENIGN;
    set(v);
    if (v === value) applied.push(name);
  }
  const path = join(src, 'phase1-review.report.json');
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'packet') });
  return { markdown: await readFile(join(built.outDir, 'report.md'), 'utf8'), report, applied };
}

const LITERAL_CODE = /^(?:<(?:sha256|content-id|name|id|packet-directory)>|&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);)$/i;

function commonmarkView(md) {
  const sig = [];
  const html = [];
  const links = [];
  const images = [];
  const codeBlocks = [];
  const walker = new commonmark.Parser().parse(md).walker();
  let e;
  while ((e = walker.next())) {
    const n = e.node;
    if (!e.entering) { if (n.isContainer) sig.push(`/${n.type}`); continue; }
    if (n.type === 'html_block' || n.type === 'html_inline') html.push(n.literal);
    if (n.type === 'link') links.push(n.destination);
    if (n.type === 'image') images.push(n.destination);
    if (n.type === 'code_block') codeBlocks.push(n.literal);
    let type = n.type;
    // Whitespace-only text carries no structure (authored edge whitespace is kept
    // as text next to generated emphasis); it is not part of the signature.
    if (type === 'text' && n.literal.trim() === '') continue;
    if (type === 'code' && LITERAL_CODE.test(n.literal)) type = 'text';
    if (type === 'softbreak') type = 'text';
    if (type === 'heading') type = `heading${n.level}`;
    if (type === 'text' && sig[sig.length - 1] === 'text') continue;
    sig.push(type);
  }
  return { sig, html, links, images, codeBlocks };
}

let pandocPath = null;
function pandocView(md, authored) {
  // --preserve-tabs: pandoc otherwise expands tabs, which is reader normalization,
  // not a change in what the Markdown means.
  const r = spawnSync(pandocPath, ['-f', 'gfm', '-t', 'json', '--preserve-tabs'], { input: md, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`pandoc failed: ${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  const sig = [];
  const raw = [];
  const links = [];
  const residualAutolinks = [];
  const images = [];
  const codeBlocks = [];
  const strText = (inl) => inl.map((x) => (x.t === 'Str' ? x.c : x.t === 'Space' ? ' ' : x.t === 'Code' ? x.c[1] : Array.isArray(x.c) ? strText(x.c.filter(Array.isArray).flat().filter((y) => y && y.t)) : '')).join('');
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !node.t) return;
    let type = node.t;
    if (type === 'RawInline' || type === 'RawBlock') raw.push(node.c[1]);
    if (type === 'Image') images.push(node.c[2][0]);
    if (type === 'CodeBlock') codeBlocks.push(node.c[1]);
    if (type === 'Link') {
      const target = node.c[2][0];
      const text = strText(node.c[1]);
      const bare = [text, `http://${text}`, `https://${text}`, `mailto:${text}`].includes(target);
      if (bare && authored.some((a) => a.includes(text))) {
        residualAutolinks.push(target);
        type = 'Str';
      } else {
        links.push(target);
      }
    }
    if (type === 'Code' && LITERAL_CODE.test(node.c[1])) type = 'Str';
    if (type === 'Space' || type === 'SoftBreak' || (node.t === 'Str' && node.c.trim() === '')) return;
    if (type === 'Str') type = 'text';
    if (type === 'Header') type = `Header${node.c[0]}`;
    if (type === 'Table') type = `Table${JSON.stringify(node.c[3]?.length ?? '')}`;
    if (!(type === 'text' && sig[sig.length - 1] === 'text')) sig.push(type);
    if (node.t === 'Link' && type === 'Str') return; // residual autolink contents are text
    if (node.c !== undefined) walk(node.c);
  };
  walk(doc.blocks);
  return { sig, raw, links, residualAutolinks, images, codeBlocks };
}

const STRUCTURED_LINKS = ['https://example.com/ok', 'https://www.w3.org/TR/CSP3/'];

test.before(async () => {
  fixtureText = await readFile(join(REPO, 'fixtures/report/phase1-review.report.json'), 'utf8');
  const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
  pandocPath = which.status === 0 ? which.stdout.trim() : null;
});

async function property(t, attacks, multiline) {
  const base = await render(t, BENIGN, { multiline });
  const cmBase = commonmarkView(base.markdown);
  const gfmBase = pandocPath ? pandocView(base.markdown, [BENIGN]) : null;
  let checked = 0;
  let placements = 0;
  for (const attack of attacks) {
    const { markdown, report, applied } = await render(t, attack, { multiline });
    placements += applied.length;
    const where = `${JSON.stringify(attack)} in [${applied.join(', ')}]`;
    const cm = commonmarkView(markdown);
    assert.deepEqual(cm.html, [], `CommonMark raw HTML from ${where}`);
    assert.deepEqual(cm.images, [], `CommonMark image from ${where}`);
    assert.deepEqual([...new Set(cm.links)].sort(), [...new Set(cmBase.links)].sort(), `CommonMark link from ${where}`);
    assert.ok(cm.links.every((l) => STRUCTURED_LINKS.includes(l)));
    assert.deepEqual(cm.sig, cmBase.sig, `CommonMark structure changed by ${where}`);
    const codeBlock = report.sections[1].blocks.find((b) => b.type === 'code');
    const diffBlock = report.sections[1].blocks.find((b) => b.type === 'diff');
    assert.ok(cm.codeBlocks.includes(`${codeBlock.source}\n`), `code block not intact for ${where}`);
    assert.ok(cm.codeBlocks.includes(`${diffBlock.patch}\n`), `diff block not intact for ${where}`);
    if (pandocPath) {
      const gfm = pandocView(markdown, [attack]);
      assert.deepEqual(gfm.raw, [], `GFM raw HTML from ${where}`);
      assert.deepEqual(gfm.images, [], `GFM image from ${where}`);
      assert.ok(gfm.links.every((l) => STRUCTURED_LINKS.includes(l)), `GFM non-residual link ${gfm.links} from ${where}`);
      assert.deepEqual(gfm.sig, gfmBase.sig, `GFM structure changed by ${where}`);
      assert.ok(gfm.codeBlocks.includes(codeBlock.source) && gfm.codeBlocks.includes(diffBlock.patch), `GFM code/diff block not intact for ${where}`);
    }
    checked += 1;
  }
  return { checked, placements };
}

// property() checks both readers whenever pandoc is installed, so the GFM test below asks for the
// very runs the two CommonMark tests make. Each corpus is run once per process and its outcome,
// pass or failure, is shared by every test that asks for it (PERF-1: the file ran every build and
// every pandoc process twice). A test selected alone still makes its own run.
const corpusRuns = new Map();
function propertyOnce(t, attacks, multiline) {
  if (!corpusRuns.has(multiline)) corpusRuns.set(multiline, property(t, attacks, multiline));
  return corpusRuns.get(multiline);
}

test('[E2] property: single-line adversarial corpus in every authored-text insertion point keeps report.md structure (CommonMark)', async (t) => {
  const r = await propertyOnce(t, SINGLE_LINE, false);
  t.diagnostic(`attacks=${r.checked} placements=${r.placements} insertionPoints=${points(JSON.parse(fixtureText)).length}`);
  assert.ok(r.checked >= 100);
});

test('[E2] property: multi-line adversarial code/diff sources stay single intact code blocks (CommonMark)', async (t) => {
  const r = await propertyOnce(t, MULTI_LINE, true);
  t.diagnostic(`attacks=${r.checked} placements=${r.placements}`);
});

test('[E2] property holds under GFM (pandoc -f gfm; equivalence approximation of cmark-gfm)', async (t) => {
  if (!pandocPath) {
    t.skip('pandoc not installed: GFM half NOT_EXECUTED');
    return;
  }
  const version = spawnSync(pandocPath, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  const r1 = await propertyOnce(t, SINGLE_LINE, false);
  const r2 = await propertyOnce(t, MULTI_LINE, true);
  t.diagnostic(`pandoc=${pandocPath} ${version} attacks=${r1.checked + r2.checked}`);
});

// ---- QA reproducers (469c60ae) -----------------------------------------------------
async function reproducer(t, mutate) {
  const root = await tempDir(t, 'canon-md-repro');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const report = JSON.parse(fixtureText);
  mutate(report);
  const path = join(src, 'phase1-review.report.json');
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'packet') });
  return readFile(join(built.outDir, 'report.md'), 'utf8');
}

test('[E2] QA D-E1: code and diff fences indented 1-3 spaces cannot close the fence', async (t) => {
  const cases = {
    'code-fence-indent2': (r) => { const c = r.sections[1].blocks.find((b) => b.type === 'code'); c.source = 'a\n  ```\n<script>alert(1)</script><img src=x onerror=alert(2)>\n[x](https://evil.example)\n# Injected heading'; delete c.highlight; },
    'code-fence-indent3': (r) => { const c = r.sections[1].blocks.find((b) => b.type === 'code'); c.source = 'a\n   ```\n<script>alert(1)</script>'; delete c.highlight; },
    'diff-fence-indent1': (r) => { r.sections[1].blocks.find((b) => b.type === 'diff').patch = '+a\n ```\n<script>alert(1)</script>'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const cm = commonmarkView(await reproducer(t, mutate));
    assert.deepEqual(cm.html, [], name);
    assert.ok(!cm.links.includes('https://evil.example'), name);
    assert.equal(cm.sig.filter((x) => x === 'heading1').length, 1, `${name}: only the document title is a level-1 heading`);
  }
});

test('[E2] QA D-E2: lowercase declarations and processing instructions stay text', async (t) => {
  const md = await reproducer(t, (r) => { r.summary.paragraphs[0] = 'x <!doctype html> y <!x-y z> <?pi x?> <![CDATA[c]]>'; });
  assert.deepEqual(commonmarkView(md).html, []);
});

test('[E2] QA D-E3: an unmatched authored backtick cannot swallow a generated citation or code span', async (t) => {
  const md = await reproducer(t, (r) => { r.summary.paragraphs[1] = ['open ` tick ', { code: 'x' }, ' and ', { cite: 'ev-determinism' }, ' tail ` end']; });
  const nodes = [];
  const w = new commonmark.Parser().parse(md).walker();
  let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'code') nodes.push(e.node.literal);
  assert.ok(nodes.includes('x'), 'the authored code segment stays a code span');
  assert.ok(!nodes.some((n) => n.includes('[E1]') || n.includes('tick')), `generated citation swallowed into code: ${JSON.stringify(nodes)}`);
  assert.ok(md.includes('open \\` tick `x` and [E1] tail \\` end'));
});
