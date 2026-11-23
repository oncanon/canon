// Seeded boundary property for report.md (E2E fix cycle 3, QA D-F1..D-F5).
//
// The fix2 property inserted attacks inside single strings; QA D-F1 came from two
// segments meeting ("Look here!" + generated link = image). Here a seeded generator
// builds sequences of typed segments (authored text with adversarial boundary
// characters, code, emphasis, strong, citations, links) in paragraphs, list items,
// GFM table cells and heading titles. Each case must parse to exactly the structure
// its segments describe, under commonmark 0.31.2 and pandoc -f gfm (pandoc's gfm
// reader approximates GitHub's cmark-gfm): no raw HTML, no images, no extra or lost
// emphasis, code, links or headings, the literal authored text, and (GFM) the table
// cell count and cell contents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { buildPacket } from '../../src/packet/build.mjs';
import { REPO, tempDir } from '../helpers.mjs';

export const SEEDS = [20260926, 1, 42, 9001, 314159];
const PER_SEED = { paragraphs: 180, lists: 12, itemsPerList: 5, tables: 3, rowsPerTable: 20, headings: 40 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Boundary characters from QA D-F1 plus every inline/block Markdown sigil.
const EDGE = ['!', '[', ']', '(', ')', '*', '_', '`', '~', '<', '>', '&', '\\', '#', '|', ':', '^', '$', '=', '-', '+', '.', '"', "'", '@', '%', '{', '}'];
const WORDS = ['look', 'here', 'chart', 'x', 'AT', 'T', 'amp;', '#60;', 'lt;', 'smile', 'https://x.example', 'www.x.example', 'a@b.example', '2019.', '3)', 'E1', '<sha256>', '&amp;', 'ÄÖ', '日本', '42'];
const HREFS = ['https://example.com/i.png', 'https://example.com/a_(b)?x=1&y=2', 'https://example.org/p', 'https://example.net/q#frag'];
const CITES = [['ev-determinism', 'E1'], ['ev-cache-probe', 'E2'], ['ev-latency', 'E3']];

function makeGen(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const text = ({ allowEdgeSpace = true } = {}) => {
    const parts = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i += 1) parts.push(pick(WORDS));
    let s = parts.join(chance(0.3) ? '' : ' ');
    if (chance(0.7)) s = pick(EDGE) + (chance(0.3) ? pick(EDGE) : '') + s;
    if (chance(0.7)) s += pick(EDGE) + (chance(0.3) ? pick(EDGE) : '');
    if (allowEdgeSpace && chance(0.15)) s = ` ${s}`;
    if (allowEdgeSpace && chance(0.15)) s = `${s} `;
    return s;
  };
  const segment = () => {
    const r = rnd();
    if (r < 0.4) return text();
    if (r < 0.52) return { code: chance(0.5) ? `${pick(EDGE)}${pick(WORDS)}${pick(EDGE)}` : pick(['a|b', '`x`', ' y ', 'z']) };
    if (r < 0.64) return { em: text({ allowEdgeSpace: false }) };
    if (r < 0.76) return { strong: text({ allowEdgeSpace: false }) };
    if (r < 0.88) return { cite: pick(CITES)[0] };
    return { link: { text: chance(0.2) ? `^${text({ allowEdgeSpace: false })}` : text({ allowEdgeSpace: false }), href: pick(HREFS) } };
  };
  const sequence = () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, segment);
  return { sequence, text };
}

// ---- expected structure -----------------------------------------------------------
const LITERAL_CODE = /^(?:<(?:sha256|content-id|name|id|packet-directory)>|&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);)+$/i;
const CITE_LABEL = Object.fromEntries(CITES);

function expected(seq) {
  const tokens = [];
  for (const s of seq) {
    if (typeof s === 'string') tokens.push({ t: 'text', s });
    else if (s.code !== undefined) tokens.push(LITERAL_CODE.test(s.code) ? { t: 'text', s: s.code } : { t: 'code', s: s.code });
    else if (s.em !== undefined) tokens.push({ t: 'em', kids: [{ t: 'text', s: s.em }] });
    else if (s.strong !== undefined) tokens.push({ t: 'strong', kids: [{ t: 'text', s: s.strong }] });
    else if (s.cite !== undefined) tokens.push({ t: 'text', s: `[${CITE_LABEL[s.cite]}]` });
    else if (s.link !== undefined) tokens.push({ t: 'link', dest: s.link.href, kids: [{ t: 'text', s: s.link.text }] });
  }
  return normalize(tokens);
}

// Merge adjacent text, strip the zero-width separator, collapse whitespace runs (pandoc
// represents any run as one Space), and trim the outer edges of the sequence.
function normalize(tokens, outer = true) {
  const out = [];
  for (const tok of tokens) {
    const t = tok.t === 'text' ? { t: 'text', s: tok.s.replace(/\u200B/g, '') } : { ...tok, kids: tok.kids ? normalize(tok.kids, false) : undefined };
    if (t.t === 'text' && out.length && out[out.length - 1].t === 'text') out[out.length - 1].s += t.s;
    else out.push(t);
  }
  // Collapse whitespace only after merging adjacent text tokens.
  for (const t of out) if (t.t === 'text') t.s = t.s.replace(/\s+/g, ' ');
  if (outer) {
    if (out[0]?.t === 'text') out[0].s = out[0].s.replace(/^ /, '');
    if (out.at(-1)?.t === 'text') out.at(-1).s = out.at(-1).s.replace(/ $/, '');
  }
  return out.filter((t) => !(t.t === 'text' && t.s === '')).map((t) => (t.kids ? { ...t, kids: t.kids.filter((k) => !(k.t === 'text' && k.s === '')) } : t));
}

// ---- parsed structure --------------------------------------------------------------
function cmInline(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.next) {
    if (c.type === 'text') out.push({ t: 'text', s: c.literal });
    else if (c.type === 'softbreak' || c.type === 'linebreak') out.push({ t: 'text', s: ' ' });
    else if (c.type === 'code') out.push(LITERAL_CODE.test(c.literal) ? { t: 'text', s: c.literal } : { t: 'code', s: c.literal });
    else if (c.type === 'emph') out.push({ t: 'em', kids: cmInline(c) });
    else if (c.type === 'strong') out.push({ t: 'strong', kids: cmInline(c) });
    else if (c.type === 'link') out.push({ t: 'link', dest: c.destination, kids: cmInline(c) });
    else out.push({ t: `UNEXPECTED:${c.type}`, s: c.literal ?? '' });
  }
  return out;
}

function pdInline(list) {
  const out = [];
  for (const x of list) {
    if (x.t === 'Str') out.push({ t: 'text', s: x.c });
    else if (x.t === 'Space' || x.t === 'SoftBreak' || x.t === 'LineBreak') out.push({ t: 'text', s: ' ' });
    else if (x.t === 'Code') out.push(LITERAL_CODE.test(x.c[1]) ? { t: 'text', s: x.c[1] } : { t: 'code', s: x.c[1] });
    else if (x.t === 'Emph') out.push({ t: 'em', kids: pdInline(x.c) });
    else if (x.t === 'Strong') out.push({ t: 'strong', kids: pdInline(x.c) });
    else if (x.t === 'Link') out.push({ t: 'link', dest: x.c[2][0], kids: pdInline(x.c[1]) });
    else out.push({ t: `UNEXPECTED:${x.t}`, s: JSON.stringify(x.c).slice(0, 80) });
  }
  return out;
}

const pdHeadingText = (inl) => normalize(pdInline(inl));
let pandoc = null;

// ---- report construction -----------------------------------------------------------
function buildCases(seed) {
  const g = makeGen(seed);
  const cases = { paragraphs: [], lists: [], tables: [], headings: [] };
  for (let i = 0; i < PER_SEED.paragraphs; i += 1) cases.paragraphs.push(g.sequence());
  for (let i = 0; i < PER_SEED.lists; i += 1) cases.lists.push(Array.from({ length: PER_SEED.itemsPerList }, () => g.sequence()));
  for (let i = 0; i < PER_SEED.tables; i += 1) cases.tables.push(Array.from({ length: PER_SEED.rowsPerTable }, () => [g.sequence(), g.sequence()]));
  for (let i = 0; i < PER_SEED.headings; i += 1) cases.headings.push(g.text({ allowEdgeSpace: false }));
  return cases;
}

function sectionsFor(seed, cases) {
  return [
    { id: `bp-${seed}`, title: `Boundary paragraphs ${seed}`, blocks: cases.paragraphs.map((text) => ({ type: 'paragraph', text })) },
    { id: `bl-${seed}`, title: `Boundary lists ${seed}`, blocks: cases.lists.map((items) => ({ type: 'list', items })) },
    { id: `bt-${seed}`, title: `Boundary tables ${seed}`, blocks: cases.tables.map((rows, i) => ({ type: 'table', id: `bt-${seed}-${i}`, caption: `Boundary table ${i}`, columns: [{ key: 'ca', label: 'A' }, { key: 'cb', label: 'B' }], rows: rows.map(([a, b]) => ({ ca: a, cb: b })) })) },
    { id: `bh-${seed}`, title: `Boundary headings ${seed}`, blocks: cases.headings.map((title, i) => ({ type: 'finding', id: `BF-${seed}-${i}`, title, severity: 'info', confidence: 'open', claim: 'c', evidence: ['ev-determinism'] })) },
  ];
}

async function render(t, seed) {
  const root = await tempDir(t, 'canon-boundary');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  const cases = buildCases(seed);
  report.sections = sectionsFor(seed, cases);
  delete report.appendices;
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'packet') });
  return { cases, markdown: await readFile(join(built.outDir, 'report.md'), 'utf8') };
}

// Top-level blocks between the "## n. <title>" heading and the next level-2 heading.
function cmSection(doc, title) {
  const blocks = [];
  let inSection = false;
  for (let b = doc.firstChild; b; b = b.next) {
    if (b.type === 'heading' && b.level === 2) {
      const text = cmInline(b).map((x) => x.s ?? '').join('');
      if (inSection) break;
      inSection = text.endsWith(title);
      continue;
    }
    if (inSection) blocks.push(b);
  }
  return blocks;
}

function pdSection(blocks, title) {
  const out = [];
  let inSection = false;
  for (const b of blocks) {
    if (b.t === 'Header' && b.c[0] === 2) {
      const text = normalize(pdInline(b.c[2])).map((x) => x.s ?? '').join('');
      if (inSection) break;
      inSection = text.endsWith(title);
      continue;
    }
    if (inSection) out.push(b);
  }
  return out;
}

function forbiddenCounts(md) {
  const cm = { html: 0, image: 0 };
  const w = new commonmark.Parser().parse(md).walker();
  let e;
  while ((e = w.next())) if (e.entering) { if (/html/.test(e.node.type)) cm.html += 1; if (e.node.type === 'image') cm.image += 1; }
  return cm;
}

test.before(() => {
  const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
  pandoc = which.status === 0 ? which.stdout.trim() : null;
});


for (const seed of SEEDS) {
  test(`[E2] boundary property, seed ${seed}: paragraphs, list items and headings parse to exactly the generated structure (CommonMark)`, async (t) => {
    const { cases, markdown } = await render(t, seed);
    const doc = new commonmark.Parser().parse(markdown);
    assert.deepEqual(forbiddenCounts(markdown), { html: 0, image: 0 });
    const paras = cmSection(doc, `Boundary paragraphs ${seed}`);
    assert.equal(paras.length, cases.paragraphs.length, 'one paragraph per case (no case split or merged blocks)');
    cases.paragraphs.forEach((seq, i) => {
      assert.equal(paras[i].type, 'paragraph', `case ${i} is a paragraph`);
      assert.deepEqual(normalize(cmInline(paras[i])), expected(seq), `seed ${seed} paragraph ${i}: ${JSON.stringify(seq)}`);
    });
    const lists = cmSection(doc, `Boundary lists ${seed}`);
    assert.equal(lists.length, cases.lists.length);
    cases.lists.forEach((items, i) => {
      const got = [];
      for (let item = lists[i].firstChild; item; item = item.next) got.push(item);
      assert.equal(got.length, items.length, `seed ${seed} list ${i} item count`);
      items.forEach((seq, j) => {
        assert.equal(got[j].firstChild?.type, 'paragraph');
        assert.equal(got[j].firstChild.next, null, `list ${i} item ${j} has a single paragraph`);
        assert.deepEqual(normalize(cmInline(got[j].firstChild)), expected(seq), `seed ${seed} list ${i} item ${j}: ${JSON.stringify(seq)}`);
      });
    });
    const heads = cmSection(doc, `Boundary headings ${seed}`).filter((b) => b.type === 'heading');
    assert.equal(heads.length, cases.headings.length);
    cases.headings.forEach((title, i) => {
      assert.equal(heads[i].level, 3);
      assert.deepEqual(normalize(cmInline(heads[i])), normalize([{ t: 'text', s: `Finding BF-${seed}-${i}: ${title}` }]), `seed ${seed} heading ${i}: ${JSON.stringify(title)}`);
    });
    const n = cases.paragraphs.length + cases.lists.length * PER_SEED.itemsPerList + cases.headings.length;
    t.diagnostic(`boundary-seed ${JSON.stringify({ seed, reader: 'commonmark 0.31.2', paragraphs: cases.paragraphs.length, listItems: cases.lists.length * PER_SEED.itemsPerList, headings: cases.headings.length, tableCells: 'NOT_EXECUTED: tables are a GFM extension CommonMark does not parse; covered by the pandoc half', checked: n })}`);
  });

  test(`[E2] boundary property, seed ${seed}: the same cases plus GFM table rows and cells under pandoc -f gfm`, async (t) => {
    if (!pandoc) {
      t.skip('pandoc not installed: GFM half NOT_EXECUTED');
      return;
    }
    const { cases, markdown } = await render(t, seed);
    const r = spawnSync(pandoc, ['-f', 'gfm', '-t', 'json', '--preserve-tabs'], { input: markdown, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.equal(r.status, 0, r.stderr);
    const blocks = JSON.parse(r.stdout).blocks;
    const all = JSON.stringify(blocks);
    assert.ok(!/"t":"(?:RawInline|RawBlock|Image)"/.test(all), 'no raw HTML or images under GFM');
    const paras = pdSection(blocks, `Boundary paragraphs ${seed}`);
    assert.equal(paras.length, cases.paragraphs.length);
    cases.paragraphs.forEach((seq, i) => {
      assert.equal(paras[i].t, 'Para');
      assert.deepEqual(normalize(pdInline(paras[i].c)), expected(seq), `seed ${seed} GFM paragraph ${i}: ${JSON.stringify(seq)}`);
    });
    const lists = pdSection(blocks, `Boundary lists ${seed}`);
    assert.equal(lists.length, cases.lists.length);
    cases.lists.forEach((items, i) => {
      assert.equal(lists[i].t, 'BulletList');
      assert.equal(lists[i].c.length, items.length);
      items.forEach((seq, j) => {
        const item = lists[i].c[j];
        assert.equal(item.length, 1, `GFM list ${i} item ${j} is one block`);
        assert.ok(item[0].t === 'Plain' || item[0].t === 'Para');
        assert.deepEqual(normalize(pdInline(item[0].c)), expected(seq), `seed ${seed} GFM list ${i} item ${j}: ${JSON.stringify(seq)}`);
      });
    });
    const tables = pdSection(blocks, `Boundary tables ${seed}`).filter((b) => b.t === 'Table');
    assert.equal(tables.length, cases.tables.length, 'every generated table parses as a GFM table');
    cases.tables.forEach((rows, i) => {
      const bodyRows = tables[i].c[4][0][3];
      assert.equal(bodyRows.length, rows.length, `table ${i} row count`);
      rows.forEach((cells, j) => {
        const got = bodyRows[j][1];
        assert.equal(got.length, 2, `seed ${seed} table ${i} row ${j} has exactly 2 cells`);
        cells.forEach((seq, k) => {
          const blocksInCell = got[k][4];
          const inl = blocksInCell.flatMap((b) => b.c);
          assert.deepEqual(normalize(pdInline(inl)), expected(seq), `seed ${seed} GFM table ${i} row ${j} cell ${k}: ${JSON.stringify(seq)}`);
        });
      });
    });
    const heads = pdSection(blocks, `Boundary headings ${seed}`).filter((b) => b.t === 'Header');
    assert.equal(heads.length, cases.headings.length);
    cases.headings.forEach((title, i) => {
      assert.equal(heads[i].c[0], 3);
      assert.deepEqual(pdHeadingText(heads[i].c[2]), normalize([{ t: 'text', s: `Finding BF-${seed}-${i}: ${title}` }]), `seed ${seed} GFM heading ${i}: ${JSON.stringify(title)}`);
    });
    const version = spawnSync(pandoc, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
    const binary = await realpath(pandoc);
    const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    t.diagnostic(`boundary-seed ${JSON.stringify({ seed, reader: `${pandoc} ${version} -f gfm`, pandoc: { path: pandoc, binary, version, sha256 }, paragraphs: cases.paragraphs.length, listItems: cases.lists.length * PER_SEED.itemsPerList, headings: cases.headings.length, tableCells: cases.tables.length * PER_SEED.rowsPerTable * 2, checked: cases.paragraphs.length + cases.lists.length * PER_SEED.itemsPerList + cases.headings.length + cases.tables.length * PER_SEED.rowsPerTable * 2 })}`);
  });
}


// ---- QA reproducers (906e60d6) --------------------------------------------------------
test('[E2] QA D-F1: authored "!" before a generated link stays text, never an image', async (t) => {
  const root = await tempDir(t, 'canon-df1');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.summary.paragraphs[0] = ['Look here!', { link: { text: 'chart', href: 'https://example.com/i.png' } }];
  report.title = 'Report closes ###';
  report.summary.paragraphs[1] = '2019. was a year';
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'p') });
  const md = await readFile(join(built.outDir, 'report.md'), 'utf8');
  const html = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  assert.ok(!html.includes('<img'), 'D-F1: no image');
  assert.ok(html.includes('Look here!<a href="https://example.com/i.png">chart</a>'), 'D-F1: text then link');
  assert.ok(html.includes('<h1>Report closes ###</h1>'), 'D-F4: trailing ### kept');
  assert.ok(html.includes('<p>2019. was a year</p>'), 'D-F3: no visible backslash');
});

// The seeded generator rarely puts a text segment ending in "&" before one starting
// with a reference name, so the "&" boundary rule is pinned here: joined unescaped,
// "AT&" + "amp; T" is "AT&amp; T" and decodes to "AT& T".
test('[E2] QA D-F1 class: "&" ending one text segment never forms a character reference with the next', async (t) => {
  const root = await tempDir(t, 'canon-df1-amp');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.summary.paragraphs.push(['AT&', 'amp; T and x &', '#60;y and &', 'lt;b'], ['R&', { code: 'D' }]);
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'p') });
  const md = await readFile(join(built.outDir, 'report.md'), 'utf8');
  const html = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md));
  assert.ok(html.includes('<p>AT&amp;amp; T and x &amp;#60;y and &amp;lt;b</p>'), 'CommonMark keeps every authored "&" literal');
  assert.ok(html.includes('<p>R&amp;<code>D</code></p>'), '"&" before a code span is untouched');
  if (!pandoc) {
    t.diagnostic('pandoc not installed: GFM half NOT_EXECUTED');
    return;
  }
  const r = spawnSync(pandoc, ['-f', 'gfm', '-t', 'plain', '--wrap=none'], { input: md, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^AT&amp; T and x &#60;y and &lt;b$/m, 'pandoc GFM keeps every authored "&" literal');
});
