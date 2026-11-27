// Escape inventory and necessity oracle for report.md (agent-Markdown requirement,
// item 5). An "escape" is a backslash before an ASCII punctuation character or a
// character reference (&name; &#N; &#xN;) outside code spans and fenced code.
// An escape is NECESSARY when replacing it by what it stands for (the literal
// character; nothing, for the zero-width separator &#8203;) changes the parse under
// CommonMark (commonmark 0.31.2) or GFM (pandoc -f gfm). Each escape is judged alone,
// against the whole document.
import * as commonmark from 'commonmark';
import { pandocRun } from './helpers.mjs';

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const REF = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;
export const SEP = '&#8203;';

// Positions of escapes outside fenced code blocks and code spans.
export function findEscapes(md) {
  const out = [];
  const lines = md.split('\n');
  const text = md;
  // Mark every character on a fenced-code line (fences included).
  const inFence = new Uint8Array(md.length + 1);
  let pos = 0;
  let fence = null;
  for (const line of lines) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    const mark = fence !== null || Boolean(open);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    } else if (open) {
      fence = open[1];
    }
    if (mark) inFence.fill(1, pos, pos + line.length + 1);
    pos += line.length + 1;
  }
  let i = 0;
  while (i < text.length) {
    if (inFence[i]) { i += 1; continue; }
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && ASCII_PUNCT.test(text[i + 1])) {
      out.push({ index: i, source: text.slice(i, i + 2), kind: 'backslash', stands: text[i + 1] });
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (text[i + n] === '`') n += 1;
      let j = i + n;
      let close = -1;
      while (j < text.length && !inFence[j]) {
        if (text[j] === '`') {
          let m = 1;
          while (text[j + m] === '`') m += 1;
          if (m === n) { close = j; break; }
          j += m;
        } else {
          j += 1;
        }
      }
      i = close >= 0 ? close + n : i + n;
      continue;
    }
    if (ch === '&') {
      const m = text.slice(i).match(REF);
      if (m) {
        const decoded = decodeRef(m[0]);
        out.push({ index: i, source: m[0], kind: m[0] === SEP ? 'separator' : 'reference', stands: m[0] === SEP ? '' : decoded });
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

function decodeRef(ref) {
  const num = ref.match(/^&#([xX]?)([0-9A-Fa-f]+);$/);
  if (num) return String.fromCodePoint(parseInt(num[2], num[1] ? 16 : 10));
  const named = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(ref));
  return named.replace(/^<p>|<\/p>\n$/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Normalized parse trees. U+200B is dropped from text so a separator's own decoded
// character does not count as a difference.
export function commonmarkTree(md) {
  const walker = new commonmark.Parser().parse(md).walker();
  const out = [];
  let e;
  while ((e = walker.next())) {
    const n = e.node;
    out.push([e.entering ? '+' : '-', n.type, n.literal?.replace(/​/g, '') ?? null, n.destination ?? null, n.level ?? null, n.info ?? null, n.listType ?? null, n.listDelimiter ?? null]);
  }
  return mergeText(out);
}

function mergeText(tree) {
  const out = [];
  for (const row of tree) {
    const prev = out.at(-1);
    if (row[1] === 'text' && prev && prev[1] === 'text' && prev[0] === row[0]) {
      prev[2] += row[2] ?? '';
    } else {
      out.push([...row]);
    }
  }
  return JSON.stringify(out);
}

export function pandocTree(md, pandoc = 'pandoc') {
  const r = pandocRun(['-f', 'gfm', '-t', 'json', '--preserve-tabs'], { input: md, maxBuffer: 1 << 27 }, pandoc);
  if (r.status !== 0) throw new Error(r.stderr);
  const blocks = JSON.parse(r.stdout).blocks;
  // Merge Str/Space runs into text so tokenization differences are not structure.
  const norm = (x) => {
    if (Array.isArray(x)) {
      const out = [];
      for (const item of x.map(norm)) {
        const prev = out.at(-1);
        if (item && item.t === 'Text' && prev && prev.t === 'Text') prev.c += item.c;
        else out.push(item);
      }
      return out;
    }
    if (x && typeof x === 'object') {
      if (x.t === 'Str') return { t: 'Text', c: x.c.replace(/​/g, '') };
      if (x.t === 'Space' || x.t === 'SoftBreak') return { t: 'Text', c: ' ' };
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, norm(v)]));
    }
    return x;
  };
  return JSON.stringify(norm(blocks));
}

// Judge each escape: replace it by what it stands for and compare both parses.
export function judgeEscapes(md, { pandoc = 'pandoc' } = {}) {
  const escapes = findEscapes(md);
  const base = { cm: commonmarkTree(md), gfm: pandoc ? pandocTree(md, pandoc) : null };
  return escapes.map((esc) => {
    const variant = md.slice(0, esc.index) + esc.stands + md.slice(esc.index + esc.source.length);
    const cmChanged = commonmarkTree(variant) !== base.cm;
    const gfmChanged = pandoc ? pandocTree(variant, pandoc) !== base.gfm : null;
    const line = md.slice(md.lastIndexOf('\n', esc.index) + 1, md.indexOf('\n', esc.index) === -1 ? md.length : md.indexOf('\n', esc.index));
    return { ...esc, line, cmChanged, gfmChanged, necessary: cmChanged || Boolean(gfmChanged) };
  });
}

// Characters of rendered text, for density: the document's text content under
// CommonMark (code spans and code blocks included), not its Markdown source.
export function proseLength(md) {
  const walker = new commonmark.Parser().parse(md).walker();
  let n = 0;
  let e;
  while ((e = walker.next())) if (e.entering && (e.node.type === 'text' || e.node.type === 'code')) n += e.node.literal.length;
  return n;
}
