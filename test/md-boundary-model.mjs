// Seeded boundary generator and expected-structure model for report.md.
//
// Copied from test/unit/e2-markdown-boundary-property.test.mjs (E2E fix3), which is
// kept byte-identical as an approved test; this copy adds options so the expanded
// agent-Markdown run (test/unit/e8-boundary-expanded.test.mjs) can widen the
// alphabet without changing the fix3 run.
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as commonmark from 'commonmark';
import { buildPacket } from '../src/packet/build.mjs';
import { REPO, tempDir } from './helpers.mjs';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const EDGE = ['!', '[', ']', '(', ')', '*', '_', '`', '~', '<', '>', '&', '\\', '#', '|', ':', '^', '$', '=', '-', '+', '.', '"', "'", '@', '%', '{', '}'];
export const WORDS = ['look', 'here', 'chart', 'x', 'AT', 'T', 'amp;', '#60;', 'lt;', 'smile', 'https://x.example', 'www.x.example', 'a@b.example', '2019.', '3)', 'E1', '<sha256>', '&amp;', 'ÄÖ', '日本', '42'];
export const HREFS = ['https://example.com/i.png', 'https://example.com/a_(b)?x=1&y=2', 'https://example.org/p', 'https://example.net/q#frag'];
export const CITES = [['ev-determinism', 'E1'], ['ev-cache-probe', 'E2'], ['ev-latency', 'E3']];

export function makeGen(seed, { edge = EDGE, words = WORDS } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const text = ({ allowEdgeSpace = true } = {}) => {
    const parts = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i += 1) parts.push(pick(words));
    let s = parts.join(chance(0.3) ? '' : ' ');
    if (chance(0.7)) s = pick(edge) + (chance(0.3) ? pick(edge) : '') + s;
    if (chance(0.7)) s += pick(edge) + (chance(0.3) ? pick(edge) : '');
    if (allowEdgeSpace && chance(0.15)) s = ` ${s}`;
    if (allowEdgeSpace && chance(0.15)) s = `${s} `;
    return s;
  };
  const segment = () => {
    const r = rnd();
    if (r < 0.4) return text();
    if (r < 0.52) return { code: chance(0.5) ? `${pick(edge)}${pick(words)}${pick(edge)}` : pick(['a|b', '`x`', ' y ', 'z']) };
    if (r < 0.64) return { em: text({ allowEdgeSpace: false }) };
    if (r < 0.76) return { strong: text({ allowEdgeSpace: false }) };
    if (r < 0.88) return { cite: pick(CITES)[0] };
    return { link: { text: chance(0.2) ? `^${text({ allowEdgeSpace: false })}` : text({ allowEdgeSpace: false }), href: pick(HREFS) } };
  };
  const sequence = () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, segment);
  return { sequence, text };
}

// ---- expected structure -------------------------------------------------------------
export const LITERAL_CODE = /^(?:<(?:sha256|content-id|name|id|packet-directory)>|&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);)+$/i;
const CITE_LABEL = Object.fromEntries(CITES);

export function expected(seq) {
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
export function normalize(tokens, outer = true) {
  const out = [];
  for (const tok of tokens) {
    const t = tok.t === 'text' ? { t: 'text', s: tok.s.replace(/​/g, '') } : { ...tok, kids: tok.kids ? normalize(tok.kids, false) : undefined };
    if (t.t === 'text' && out.length && out[out.length - 1].t === 'text') out[out.length - 1].s += t.s;
    else out.push(t);
  }
  for (const t of out) if (t.t === 'text') t.s = t.s.replace(/\s+/g, ' ');
  if (outer) {
    if (out[0]?.t === 'text') out[0].s = out[0].s.replace(/^ /, '');
    if (out.at(-1)?.t === 'text') out.at(-1).s = out.at(-1).s.replace(/ $/, '');
  }
  return out.filter((t) => !(t.t === 'text' && t.s === '')).map((t) => (t.kids ? { ...t, kids: t.kids.filter((k) => !(k.t === 'text' && k.s === '')) } : t));
}

// ---- parsed structure ---------------------------------------------------------------
export function cmInline(node) {
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

export function pdInline(list) {
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

export const pdHeadingText = (inl) => normalize(pdInline(inl));

// ---- report construction ------------------------------------------------------------
export function buildCases(gen, perSeed) {
  const cases = { paragraphs: [], lists: [], tables: [], headings: [] };
  for (let i = 0; i < perSeed.paragraphs; i += 1) cases.paragraphs.push(gen.sequence());
  for (let i = 0; i < perSeed.lists; i += 1) cases.lists.push(Array.from({ length: perSeed.itemsPerList }, () => gen.sequence()));
  for (let i = 0; i < perSeed.tables; i += 1) cases.tables.push(Array.from({ length: perSeed.rowsPerTable }, () => [gen.sequence(), gen.sequence()]));
  for (let i = 0; i < perSeed.headings; i += 1) cases.headings.push(gen.text({ allowEdgeSpace: false }));
  return cases;
}

export function sectionsFor(seed, cases) {
  return [
    { id: `bp-${seed}`, title: `Boundary paragraphs ${seed}`, blocks: cases.paragraphs.map((text) => ({ type: 'paragraph', text })) },
    { id: `bl-${seed}`, title: `Boundary lists ${seed}`, blocks: cases.lists.map((items) => ({ type: 'list', items })) },
    { id: `bt-${seed}`, title: `Boundary tables ${seed}`, blocks: cases.tables.map((rows, i) => ({ type: 'table', id: `bt-${seed}-${i}`, caption: `Boundary table ${i}`, columns: [{ key: 'ca', label: 'A' }, { key: 'cb', label: 'B' }], rows: rows.map(([a, b]) => ({ ca: a, cb: b })) })) },
    { id: `bh-${seed}`, title: `Boundary headings ${seed}`, blocks: cases.headings.map((title, i) => ({ type: 'finding', id: `BF-${seed}-${i}`, title, severity: 'info', confidence: 'open', claim: 'c', evidence: ['ev-determinism'] })) },
  ];
}

export async function render(t, seed, cases) {
  const root = await tempDir(t, 'canon-boundary');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.sections = sectionsFor(seed, cases);
  delete report.appendices;
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'packet') });
  return { report, built, markdown: await readFile(join(built.outDir, 'report.md'), 'utf8') };
}

// Top-level blocks between the "## n. <title>" heading and the next level-2 heading.
export function cmSection(doc, title) {
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

export function pdSection(blocks, title) {
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

export function forbiddenCounts(md) {
  const cm = { html: 0, image: 0 };
  const w = new commonmark.Parser().parse(md).walker();
  let e;
  while ((e = w.next())) if (e.entering) { if (/html/.test(e.node.type)) cm.html += 1; if (e.node.type === 'image') cm.image += 1; }
  return cm;
}
