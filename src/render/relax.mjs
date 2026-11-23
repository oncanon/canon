// Escape relaxation for report.md (agent-Markdown requirement, item 5;
// docs/decisions/phase1-contract.md D11).
//
// markdown.mjs escapes authored text strictly (fix cycles 1-3). This pass runs once
// over the FINAL, concatenated document and removes only the escapes whose context,
// with every neighbour present, cannot parse the character as syntax. It never adds
// an escape and never touches code spans, fenced code, link destinations, anchor
// definitions or generated (unescaped) syntax, so it can only make the strict output
// less escaped where that is provably inert.
//
// Decisions use the output characters around each escape. An escape token's
// neighbouring output character has the same class (whitespace, punctuation, other)
// whether that neighbour escape is kept or removed: a kept "\X" shows "\" or "X"
// and a kept "&#58;" shows "&" or ";", all punctuation, as do the characters they
// stand for. So each decision is independent of the order in which others are made.

const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const PUNCT = /^[\p{P}\p{S}]$/u;
const SPACE = /^[\s\p{Zs}]$/u;
const LETTER = /^[A-Za-z]$/;
const ESCAPE = /^\\[!-/:-@[-`{-~]/;
const REF = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;
const REMOVABLE_REFS = new Map([['&#58;', ':'], ['&#64;', '@'], ['&#46;', '.']]);

// Tokenize one line using container-resolved opaque intervals [start, end).
function tokenize(line, opaqueSpans = []) {
  const tokens = [];
  let i = 0;
  let sIdx = 0;
  while (i < line.length) {
    while (sIdx < opaqueSpans.length && opaqueSpans[sIdx].end <= i) sIdx += 1;
    if (sIdx < opaqueSpans.length && opaqueSpans[sIdx].start === i) {
      const end = opaqueSpans[sIdx].end;
      tokens.push({ type: 'opaque', src: line.slice(i, end) });
      i = end;
      sIdx += 1;
      continue;
    }
    const limit = sIdx < opaqueSpans.length ? opaqueSpans[sIdx].start : line.length;
    const rest = line.slice(i, limit);
    const esc = rest.match(ESCAPE);
    if (esc) {
      tokens.push({ type: 'esc', src: esc[0], ch: esc[0][1] });
      i += 2;
      continue;
    }
    if (line[i] === '&') {
      const ref = rest.match(REF);
      if (ref) {
        tokens.push({ type: 'ref', src: ref[0], ch: REMOVABLE_REFS.get(ref[0]) ?? null });
        i += ref[0].length;
        continue;
      }
    }
    const cp = String.fromCodePoint(line.codePointAt(i));
    tokens.push({ type: 'raw', src: cp, ch: cp });
    i += cp.length;
  }
  return tokens;
}

// Output character on each side of token t (null at the line edge). See the header:
// these classes do not depend on other tokens' keep/remove decisions.
const firstCpOf = (s) => (s ? String.fromCodePoint(s.codePointAt(0)) : null);
const lastCpOf = (s) => {
  if (!s) return null;
  const low = s.charCodeAt(s.length - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && s.length >= 2) {
    const high = s.charCodeAt(s.length - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return s.slice(-2);
  }
  return s.charAt(s.length - 1);
};
const leftChar = (tokens, t) => (t > 0 ? lastCpOf(tokens[t - 1].src) : null);
const rightChar = (tokens, t) => (t + 1 < tokens.length ? firstCpOf(tokens[t + 1].src) : null);
const leftUnit = (tokens, t) => (t > 0 ? tokens[t - 1].src.at(-1) : null);
const rightUnit = (tokens, t) => (t + 1 < tokens.length ? tokens[t + 1].src[0] : null);
const isSpace = (c) => c === null || SPACE.test(c);
const isCommonMarkSpace = (c) => c === null || /^[ \t\n\x0b\x0c\x0d\p{Zs}]$/u.test(c);

const FLANK_PROFILES = [
  // CommonMark 0.31.2 spec / cmark-gfm (Unicode code points)
  {
    unit: false,
    space: isCommonMarkSpace,
    punct: (c) => c !== null && PUNCT.test(c),
  },
  // Pandoc GFM / commonmark-hs (Unicode code points; C, Zl, Zp act as punctuation)
  {
    unit: false,
    space: isCommonMarkSpace,
    punct: (c) => c !== null && /^[\p{P}\p{S}\p{C}\p{Zl}\p{Zp}]$/u.test(c),
  },
  // commonmark.js 0.31.2 (UTF-16 code units + JS \s)
  {
    unit: true,
    space: isSpace,
    punct: (c) => c !== null && PUNCT.test(c),
  },
];

// Literal text (what the tokens stand for) from token t onward, for look-ahead.
function literalFrom(tokens, t) {
  return tokens.slice(t).map((k) => (k.type === 'esc' ? k.ch : k.type === 'ref' ? (k.ch ?? ' ') : k.type === 'opaque' ? '\u0000' : k.src)).join('');
}
function literalBefore(tokens, t) {
  return tokens.slice(0, t).map((k) => (k.type === 'esc' ? k.ch : k.type === 'ref' ? (k.ch ?? ' ') : k.type === 'opaque' ? '\u0000' : k.src)).join('');
}
function literalNoRefFrom(tokens, t) {
  return tokens.slice(t).map((k) => (k.type === 'esc' ? k.ch : k.type === 'ref' || k.type === 'opaque' ? '\u0000' : k.src)).join('');
}
function literalNoRefBefore(tokens, t) {
  return tokens.slice(0, t).map((k) => (k.type === 'esc' ? k.ch : k.type === 'ref' || k.type === 'opaque' ? '\u0000' : k.src)).join('');
}

// Conservative union across CommonMark spec, Pandoc GFM, and commonmark.js so an
// escape is kept whenever ANY target reader could parse the delimiter as syntax.
function delimCapabilities(tokens, first, last, ch) {
  let canOpen = false;
  let canClose = false;
  const beforeCp = leftChar(tokens, first);
  const afterCp = rightChar(tokens, last);
  const beforeU = leftUnit(tokens, first);
  const afterU = rightUnit(tokens, last);
  for (const prof of FLANK_PROFILES) {
    const b = prof.unit ? beforeU : beforeCp;
    const a = prof.unit ? afterU : afterCp;
    const bWs = prof.space(b);
    const aWs = prof.space(a);
    const bPt = prof.punct(b);
    const aPt = prof.punct(a);
    const left = !aWs && (!aPt || bWs || bPt);
    const right = !bWs && (!bPt || aWs || aPt);
    if (ch === '_') {
      if (left && (!right || bPt)) canOpen = true;
      if (right && (!left || aPt)) canClose = true;
    } else {
      if (left) canOpen = true;
      if (right) canClose = true;
    }
  }
  return { canOpen, canClose, afterCp };
}

// The run of escape tokens for the same delimiter character around token t.
function runBounds(tokens, t, ch) {
  let first = t;
  let last = t;
  while (first > 0 && tokens[first - 1].type === 'esc' && tokens[first - 1].ch === ch) first -= 1;
  while (last + 1 < tokens.length && tokens[last + 1].type === 'esc' && tokens[last + 1].ch === ch) last += 1;
  return [first, last];
}

const isBlankAscii = (s) => /^[ \t]*$/.test(s);

function splitGfmTableCells(rawLine) {
  const trimmed = rawLine.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^(?:[-+*]|\d{1,9}[.)])[ \t]/.test(trimmed)) return null;
  const pipes = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '|' && (i === 0 || trimmed[i - 1] !== '\\')) pipes.push(i);
  }
  if (pipes.length === 0) return null;
  const parts = [];
  let start = 0;
  for (const p of pipes) {
    parts.push(trimmed.slice(start, p));
    start = p + 1;
  }
  parts.push(trimmed.slice(start));
  if (pipes[0] === 0) parts.shift();
  if (pipes[pipes.length - 1] === trimmed.length - 1) parts.pop();
  return parts.length >= 1 ? parts : null;
}

function isGfmTablePair(hdrLine, delimLine) {
  const hCells = splitGfmTableCells(hdrLine);
  const dCells = splitGfmTableCells(delimLine);
  return Boolean(hCells && dCells && hCells.length === dCells.length && dCells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c)));
}

const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const HTML_BLOCK_6_TAGS_GFM_RE = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i;
const HTML_BLOCK_6_TAGS_CM_RE = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/i;
const HTML_BLOCK_7_TAG_GFM_RE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
const HTML_BLOCK_7_TAG_CM_RE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

function peekWsCols(rawLine, cur) {
  let cols = cur.vSpaces;
  let c = cur.col;
  let p = cur.idx;
  while (p < rawLine.length) {
    if (rawLine[p] === ' ') {
      cols += 1;
      c += 1;
      p += 1;
    } else if (rawLine[p] === '\t') {
      const w = 4 - (c % 4);
      cols += w;
      c += w;
      p += 1;
    } else {
      break;
    }
  }
  return { wsCols: cols, afterWsIdx: p, afterWsCol: c };
}

function consumeCols(rawLine, cur, nCols) {
  let rem = nCols;
  let { idx, col, vSpaces } = cur;
  if (vSpaces >= rem) {
    return { idx, col, vSpaces: vSpaces - rem };
  }
  rem -= vSpaces;
  vSpaces = 0;
  while (rem > 0 && idx < rawLine.length) {
    if (rawLine[idx] === ' ') {
      idx += 1;
      col += 1;
      rem -= 1;
    } else if (rawLine[idx] === '\t') {
      const w = 4 - (col % 4);
      idx += 1;
      col += w;
      if (w >= rem) {
        vSpaces = w - rem;
        rem = 0;
      } else {
        rem -= w;
      }
    } else {
      break;
    }
  }
  return { idx, col, vSpaces };
}

function expandTabsFrom(rawLine, cur) {
  let out = ' '.repeat(cur.vSpaces);
  let c = cur.col;
  for (let p = cur.idx; p < rawLine.length; p += 1) {
    if (rawLine[p] === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += rawLine[p];
      c += 1;
    }
  }
  return out;
}

function detectHtmlBlockOpen(effLine, canInterruptPara, isGfm = true) {
  if (isGfm
    ? /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/i.test(effLine)
    : /^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i.test(effLine)) {
    return { endRe: /<\/(?:pre|script|style|textarea)>/i };
  }
  if (/^ {0,3}<!--/.test(effLine)) return { endRe: /-->/ };
  if (/^ {0,3}<\?/.test(effLine)) return { endRe: /\?>/ };
  if (/^ {0,3}<![A-Za-z]/.test(effLine)) return { endRe: />/ };
  if (/^ {0,3}<!\[CDATA\[/.test(effLine)) return { endRe: /\]\]>/ };
  if ((isGfm ? HTML_BLOCK_6_TAGS_GFM_RE : HTML_BLOCK_6_TAGS_CM_RE).test(effLine)) return { endOnBlank: true };
  if (!canInterruptPara && (isGfm ? HTML_BLOCK_7_TAG_GFM_RE : HTML_BLOCK_7_TAG_CM_RE).test(effLine)) return { endOnBlank: true };
  return null;
}

function parseListMarkerAtCur(rawLine, cur, leafState) {
  const effLine = expandTabsFrom(rawLine, cur);
  if (THEMATIC_BREAK_RE.test(effLine)) return null;
  const { wsCols: leadCols, afterWsIdx, afterWsCol } = peekWsCols(rawLine, cur);
  if (leadCols > 3 || afterWsIdx >= rawLine.length) return null;
  const markerMatch = /^(?:([-+*])|(\d{1,9})[.)])/.exec(rawLine.slice(afterWsIdx));
  if (!markerMatch) return null;
  const markerStr = markerMatch[0];
  const afterMarkerIdx = afterWsIdx + markerStr.length;
  const afterMarkerCol = afterWsCol + markerStr.length;
  if (afterMarkerIdx < rawLine.length && rawLine[afterMarkerIdx] !== ' ' && rawLine[afterMarkerIdx] !== '\t') {
    return null;
  }
  const afterMarkerCur = { idx: afterMarkerIdx, col: afterMarkerCol, vSpaces: 0 };
  const { wsCols, afterWsIdx: contentIdx, afterWsCol: contentCol } = peekWsCols(rawLine, afterMarkerCur);
  const restAfterWs = rawLine.slice(contentIdx);
  const isBlankRest = isBlankAscii(restAfterWs);
  const canInterruptPara = !isBlankRest && (Boolean(markerMatch[1]) || Number.parseInt(markerMatch[2], 10) === 1);
  if (leafState === 'para' && !canInterruptPara) return null;
  if (isBlankRest) {
    return {
      afterCur: { idx: rawLine.length, col: contentCol, vSpaces: 0 },
      itemIndent: leadCols + markerStr.length + 1,
      isEmpty: true,
      startsIndentedCode: false,
      canInterruptPara: false,
    };
  }
  if (wsCols >= 5) {
    return {
      afterCur: consumeCols(rawLine, afterMarkerCur, 1),
      itemIndent: leadCols + markerStr.length + 1,
      isEmpty: false,
      startsIndentedCode: true,
      canInterruptPara,
    };
  }
  return {
    afterCur: { idx: contentIdx, col: contentCol, vSpaces: 0 },
    itemIndent: leadCols + markerStr.length + wsCols,
    isEmpty: false,
    startsIndentedCode: false,
    canInterruptPara,
  };
}

// Classify a line: kind and the raw UTF-16 offset where block-level content starts.
function lineKind(line, meta) {
  if (meta.inTable) return { kind: 'cell', start: meta.cmMergeCellWithPara ? meta.contentStartIdx : -1 };
  if (meta.isLeafBreak || meta.isHeading) return { kind: 'heading', start: meta.contentStartIdx };
  if (meta.openedList) return { kind: 'item', start: meta.contentStartIdx };
  return { kind: 'para', start: meta.contentStartIdx };
}

const GFM_EMOJI_NAME_EXACT_RE = /^(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*)$/;
const GFM_EMOJI_SHORTCODE_AFTER_RE = /^(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*):/;
const GFM_EMOJI_SHORTCODE_BEFORE_RE = /:(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*)$/;
const GFM_BARE_EMAIL_SCAN_RE = /[\p{L}\p{N}\p{M}._%+-]+@(?:[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]\.)+[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]/gu;
const GFM_BARE_EMAIL_END_RE = /(?:^|[^\p{L}\p{N}\p{M}._%+-])[\p{L}\p{N}\p{M}._%+-]+@(?:[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]\.)+[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]$/u;

function wouldFormRawEmail(bNoRef, ch, aNoRef) {
  if (!bNoRef.includes('@') && !aNoRef.includes('@')) return false;
  if ((ch === '_' || ch === '-') && GFM_BARE_EMAIL_END_RE.test(bNoRef)) return true;
  const cand = `${bNoRef}${ch}${aNoRef}`;
  const idx = bNoRef.length;
  GFM_BARE_EMAIL_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = GFM_BARE_EMAIL_SCAN_RE.exec(cand)) !== null) {
    if (m.index <= idx && idx < m.index + m[0].length) return true;
  }
  return false;
}

function wouldFormRawEmoji(bNoRef, ch, aNoRef) {
  const mL = /:([a-z0-9_+-]*)$/.exec(bNoRef);
  if (!mL) return false;
  const mR = /^([a-z0-9_+-]*):/.exec(aNoRef);
  if (!mR) return false;
  return GFM_EMOJI_NAME_EXACT_RE.test(`${mL[1]}${ch}${mR[1]}`);
}

function isPotentialTableDelimLine(rawCand) {
  if (!rawCand || !rawCand.includes('|')) return false;
  const cells = splitGfmTableCells(rawCand);
  return Boolean(cells && cells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c)));
}

function rawBlockCandidate(tokens, t, startToken, ch) {
  const from = Math.max(startToken, 0);
  return tokens.slice(from).map((k, off) => {
    const u = from + off;
    if (u === t) return ch;
    if (k.type === 'esc' && k.ch === '|') return '\\|';
    if (k.type === 'esc') return k.ch;
    if (k.type === 'ref') return k.ch ?? k.src;
    return k.src;
  }).join('');
}

function checkBareAutolinkCandidate(b, ch, a) {
  const cand = `${b}${ch}${a}`;
  if (!/(?:https?|ftp):\/\/|www\.|@/i.test(cand)) return false;
  const idx = b.length;
  const re = /(?:https?|ftp):\/\/|www\.|[\p{L}\p{N}\p{M}._%+-]+@/giu;
  let m;
  while ((m = re.exec(cand)) !== null) {
    if (m.index > idx) break;
    const end = matchGfmBareAutolinkEnd(cand, m.index);
    if (end > idx) return true;
  }
  return false;
}

function wouldFormGfmBareAutolink(tokens, t, ch) {
  if (checkBareAutolinkCandidate(literalNoRefBefore(tokens, t), ch, literalNoRefFrom(tokens, t + 1))) return true;
  const bRaw = tokens.slice(0, t).map((k) => (k.type === 'ref' || k.type === 'opaque' ? '\u0000' : k.src)).join('');
  const aRaw = tokens.slice(t + 1).map((k) => (k.type === 'ref' || k.type === 'opaque' ? '\u0000' : k.src)).join('');
  return checkBareAutolinkCandidate(bRaw, ch, aRaw);
}

function matchesThematicBreakAtAnyStep(tokens, t, tokOffsets, stepCursors, ch) {
  if (!stepCursors?.length || !tokOffsets) return false;
  const targetOff = tokOffsets[t];
  for (const sc of stepCursors) {
    if (sc.idx > targetOff) continue;
    let tail = '';
    for (let u = 0; u < tokens.length; u += 1) {
      const k = tokens[u];
      const off = tokOffsets[u];
      const end = off + k.src.length;
      if (end <= sc.idx) continue;
      let piece = u === t ? ch : k.type === 'esc' ? k.ch : k.type === 'ref' ? (k.ch ?? ' ') : k.type === 'opaque' ? '\u0000' : k.src;
      if (off < sc.idx) piece = k.src.slice(sc.idx - off);
      tail += piece;
    }
    if (THEMATIC_BREAK_RE.test(expandTabsFrom(tail, { idx: 0, col: sc.col, vSpaces: sc.vSpaces }))) return true;
  }
  return false;
}

// Decide whether escape token t must stay. ctx: { kind, startToken, prevLineText }.
function keep(tokens, t, ctx, labelDepth, pairKept) {
  const tok = tokens[t];
  const isParaLike = ctx.kind === 'para' || ctx.kind === 'item' || Boolean(ctx.cmParaCell);
  if (ctx.betweenLooseRawBrackets?.(t)) return true;
  if (tok.type === 'ref') {
    if (!tok.ch) return true; // leading-whitespace references, the separator, others
    if (ctx.betweenRawAngleBrackets?.(t)) return true;
    const before = literalBefore(tokens, t);
    const after = literalFrom(tokens, t + 1);
    if (tok.ch === ':' && before.endsWith(']')) return true;
    if (tok.ch === ':' && isParaLike && ctx.startToken >= 0 && t >= ctx.startToken && isPotentialTableDelimLine(rawBlockCandidate(tokens, t, ctx.startToken, ':'))) return true;
    if (tok.ch === ':' && (GFM_EMOJI_SHORTCODE_AFTER_RE.test(after) || GFM_EMOJI_SHORTCODE_BEFORE_RE.test(before))) return true;
    // A URI scheme: pandoc recognizes bare URIs whatever precedes the scheme, so any
    // text ending in a letter followed by one or more scheme characters counts.
    if (tok.ch === ':') return /[A-Za-z][A-Za-z0-9+.-]+$/.test(before) && /^\S/.test(after);
    // Email autolinks: local part before, a dotted domain after (Unicode letters,
    // combining marks, digits, and domain underscores/hyphens count: pandoc/GFM link them).
    if (tok.ch === '@') return /[\p{L}\p{N}\p{M}._%+-]$/u.test(before) && /^[\p{L}\p{N}\p{M}_-]+(?:\.[\p{L}\p{N}\p{M}_-]+)*\.[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]/u.test(after);
    if (tok.ch === '.' && isParaLike && ctx.startToken >= 0 && t >= ctx.startToken && /^\d{1,9}$/.test(before.slice(ctx.startCol)) && /^(?:[ \t]|$)/.test(after)) return true;
    if (tok.ch === '.' && ctx.startCol === 0 && /^\.\.\.[ \t]*$/.test(`${before}.${after}`)) return true;
    // "www." autolinks: anything but whitespace or the end may continue the domain.
    if (tok.ch === '.') return /^\S/.test(after);
    return true;
  }
  const atStart = t === ctx.startToken && isParaLike;
  const after = literalFrom(tokens, t + 1);
  const right = rightChar(tokens, t);
  const blockRest = isParaLike && ctx.startToken >= 0 && t >= ctx.startToken
    ? `${literalBefore(tokens, t).slice(ctx.startCol)}${tok.ch}${after}`
    : null;
  const stepThematicBreak = (tok.ch === '-' || tok.ch === '*' || tok.ch === '_')
    ? matchesThematicBreakAtAnyStep(tokens, t, ctx.tokOffsets, ctx.stepCursors, tok.ch)
    : false;
  switch (tok.ch) {
    case '`': return true;
    case '|': return true;
    case '(': case ':': case '&': return true; // segment-boundary escapes (joinPieces)
    case '\\': return right === null || ASCII_PUNCT.test(right);
    case '<': return /^[A-Za-z/!?]/.test(after) || /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/.test(after) || Boolean(ctx.isAfterPointyOpener?.(t)) || Boolean(ctx.betweenRawAngleBrackets?.(t));
    case '>': return atStart || Boolean(ctx.hasRawLtBefore?.(t));
    case '#':
      // "&" + "#" would start a character reference ("&\#60;" must not become "&#60;").
      if (tokens[t - 1]?.type === 'raw' && tokens[t - 1].ch === '&') return true;
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      if (ctx.kind === 'heading') {
        // An ATX closing sequence: a trailing run of "#" after a space or at the start.
        const rest = literalFrom(tokens, t);
        const prev = leftChar(tokens, t);
        const beforeHashes = ctx.startToken >= 0 && t >= ctx.startToken
          ? literalBefore(tokens, t).slice(ctx.startCol).replace(/#+$/, '')
          : null;
        return /^#+[ \t]*$/.test(rest) && (t === ctx.startToken || isSpace(prev) || (beforeHashes !== null && (beforeHashes.length === 0 || /[ \t]$/.test(beforeHashes))));
      }
      return blockRest !== null && /^#{1,6}(?:[ \t]|$)/.test(blockRest);
    case '-': case '+': {
      if (atStart) return true;
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      const bNoRef = literalNoRefBefore(tokens, t);
      const aNoRef = literalNoRefFrom(tokens, t + 1);
      if (tok.ch === '-') {
        if (stepThematicBreak) return true;
        if (blockRest !== null && ((ctx.prevLineText && /^-+[ \t]*$/.test(blockRest)) || /^(?:-[ \t]*){3,}$/.test(blockRest))) return true;
        if (isParaLike && ctx.startToken >= 0 && t >= ctx.startToken && isPotentialTableDelimLine(rawBlockCandidate(tokens, t, ctx.startToken, '-'))) return true;
        if (bNoRef.endsWith('<!-') || (bNoRef.endsWith('<!') && aNoRef.startsWith('-'))) return true;
      }
      return wouldFormRawEmail(bNoRef, tok.ch, aNoRef) || wouldFormRawEmoji(bNoRef, tok.ch, aNoRef) || wouldFormGfmBareAutolink(tokens, t, tok.ch);
    }
    case '=':
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      return Boolean(ctx.prevLineText) && blockRest !== null && /^=+[ \t]*$/.test(blockRest);
    case '.': case ')': {
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      if (tok.ch === '.') {
        if (ctx.startCol === 0 && /^\.\.\.[ \t]*$/.test(`${literalBefore(tokens, t)}.${after}`)) return true;
        const bNoRef = literalNoRefBefore(tokens, t);
        const aNoRef = literalNoRefFrom(tokens, t + 1);
        if (/(?:^|[^\p{L}\p{N}])www$/iu.test(bNoRef) && /^[\p{L}\p{N}\p{M}_-]/u.test(aNoRef)) return true;
        if (wouldFormRawEmail(bNoRef, '.', aNoRef) || wouldFormGfmBareAutolink(tokens, t, '.')) return true;
      } else if (ctx.hasRawOpenParenBefore?.(t)) {
        return true;
      }
      // An ordered-list marker: 1-9 digits from the start of block content.
      return isParaLike && ctx.startToken >= 0 && /^\d{1,9}$/.test(literalBefore(tokens, t).slice(ctx.startCol)) && /^(?:[ \t]|$)/.test(after);
    }
    case '!':
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      if (tokens[t - 1]?.type === 'raw' && tokens[t - 1].ch === '<') return true;
      if (blockRest !== null && /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]|$)/i.test(blockRest)) return true;
      return (tokens[t + 1]?.type === 'raw' && tokens[t + 1].ch === '[')
        || (tokens[t + 1]?.type === 'esc' && tokens[t + 1].ch === '[' && !keep(tokens, t + 1, ctx, labelDepth, pairKept));
    case '*': case '~': {
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      const [first, last] = runBounds(tokens, t, tok.ch);
      if ((tokens[first - 1]?.type === 'raw' && tokens[first - 1].ch === tok.ch) || (tokens[last + 1]?.type === 'raw' && tokens[last + 1].ch === tok.ch)) return true;
      const d = delimCapabilities(tokens, first, last, tok.ch);
      if (tok.ch === '*') {
        if (first === ctx.startToken && isParaLike && first === last && isSpace(d.afterCp)) return true; // bullet marker
        if (stepThematicBreak || (blockRest !== null && /^(?:\*[ \t]*){3,}$/.test(blockRest))) return true; // thematic break
      }
      if (tok.ch === '~' && first === ctx.startToken && (ctx.kind === 'para' || ctx.kind === 'item') && last - first >= 2) return true; // tilde code fence
      if (tok.ch === '~' && first === ctx.startToken && ctx.cmParaCell && last - first >= 2) return true;
      // A delimiter run pairs only with another run of the same character in the same
      // inline container (paragraph, list item, table cell or heading).
      return (d.canOpen || d.canClose) && ctx.hasPartner(tok.ch, first, last);
    }
    case '_': {
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      const bNoRef = literalNoRefBefore(tokens, t);
      const aNoRef = literalNoRefFrom(tokens, t + 1);
      if (wouldFormRawEmail(bNoRef, '_', aNoRef) || wouldFormRawEmoji(bNoRef, '_', aNoRef) || wouldFormGfmBareAutolink(tokens, t, '_')) return true;
      const [first, last] = runBounds(tokens, t, '_');
      if ((tokens[first - 1]?.type === 'raw' && tokens[first - 1].ch === '_') || (tokens[last + 1]?.type === 'raw' && tokens[last + 1].ch === '_')) return true;
      if (stepThematicBreak || (blockRest !== null && /^(?:_[ \t]*){3,}$/.test(blockRest))) return true;
      const d = delimCapabilities(tokens, first, last, '_');
      return (d.canOpen || d.canClose) && ctx.hasPartner('_', first, last);
    }
    case '$': {
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      // pandoc tex_math_dollars: a closing "$" has a non-space character on its left
      // and no digit on its right. Every math span needs one, so escaping every
      // closer-capable "$" is sufficient.
      // pandoc inline math: an opening "$" has a non-space character on its right and
      // a closing "$" one on its left. pandoc 3.5 scans for the closer across link
      // syntax and into code spans, and does not apply its documented "no digit after
      // the closer" rule, so a "$" stays escaped when it could open and any later "$"
      // in the container could close, or could close and any earlier "$" could open.
      return ctx.dollarPairs(t);
    }
    case ']':
      if (labelDepth > 0) return true;
      if (right === null) return true;
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      if (ctx.hasLooseRawOpenBracketBefore?.(t)) return true;
      return tokens[t + 1].type === 'raw' && '([:'.includes(tokens[t + 1].ch);
    case '[':
      if (labelDepth > 0) return true;
      if (atStart) return true; // definitions, task lists, footnote definitions
      if (ctx.betweenRawAngleBrackets?.(t)) return true;
      if (tokens[t - 1]?.type === 'raw' && tokens[t - 1].ch === ']') return true; // after a generated "]"
      if (tokens[t + 1]?.ch === '^') return true; // pandoc GFM +footnotes ([^label])
      if (literalNoRefBefore(tokens, t).endsWith('<![CDATA') || (literalNoRefBefore(tokens, t).endsWith('<!') && literalNoRefFrom(tokens, t + 1).startsWith('CDATA['))) return true;
      if (ctx.hasLooseRawCloseBracketAfter?.(t)) return true;
      return pairKept.has(t);
    default:
      return true;
  }
}

function parseLine(line, meta, opaqueSpans = [], frozenSet = null, linkLabelSet = null, matchedBracketSet = null, stepCursors = []) {
  const body = line;
  const { kind, start } = lineKind(body, meta);
  const tokens = tokenize(body, opaqueSpans);
  // Table cells are separate inline containers: GFM splits cells on unescaped "|"
  // before inline parsing.
  let cell = 0;
  const cellOf = tokens.map((k) => (k.type === 'raw' && k.ch === '|' ? (cell += 1, -1) : cell));
  const tokOffsets = [];
  let off = 0;
  for (const k of tokens) {
    tokOffsets.push(off);
    off += k.src.length;
  }
  return {
    line,
    body,
    kind,
    start,
    tokens,
    tokOffsets,
    cellOf,
    frozenSet,
    linkLabelSet,
    matchedBracketSet,
    stepCursors,
    rawContentStartIdx: meta.rawContentStartIdx,
    isHeading: meta.isHeading,
    isBlankInner: meta.isBlankInner,
    breakPara: meta.breakPara,
    cmMergeCellWithPara: Boolean(meta.cmMergeCellWithPara),
    inRefDef: meta.inRefDef,
  };
}

// CommonMark reference-label matching: case fold, trim, collapse whitespace.
const normalizeLabel = (s) => s.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();

// What sits next to an escape, for the optional removal report: generated syntax
// (code span, link destination, raw bracket or emphasis delimiter, separator) marks
// a segment edge.
function neighbour(k) {
  if (!k) return 'edge';
  if (k.type === 'opaque') return 'code-or-destination';
  if (k.type === 'raw' && '[]*_'.includes(k.ch)) return 'generated-syntax';
  if (k.type === 'ref' && k.src === '&#8203;') return 'separator';
  return 'text';
}

function computeKeptTokens(parsed, prevLineText, container, labels, forcedKeptOffsets = null) {
  const { body, kind, start, tokens, tokOffsets, frozenSet, linkLabelSet, inRefDef, cmMergeCellWithPara } = parsed;
  const kept = new Set();
  if (!/[\\&]/.test(body)) return kept;
  // Token index where block content starts (after a heading or list marker).
  let startToken = -1;
  let startCol = 0;
  if (start >= 0) {
    let col = 0;
    for (let t = 0; t < tokens.length; t += 1) {
      if (col === start) { startToken = t; break; }
      col += tokens[t].src.length;
    }
    startCol = literalBefore(tokens, Math.max(startToken, 0)).length;
  }
  const ctx = {
    kind,
    cmParaCell: cmMergeCellWithPara,
    startToken,
    startCol,
    prevLineText,
    tokOffsets,
    stepCursors: parsed.stepCursors,
    hasPartner: (ch, first, last) => container.hasPartner(parsed, ch, first, last),
    dollarPairs: (t) => container.dollarPairs(parsed, t),
    hasLooseRawOpenBracketBefore: (t) => container.hasLooseRawOpenBracketBefore(parsed, t),
    hasLooseRawCloseBracketAfter: (t) => container.hasLooseRawCloseBracketAfter(parsed, t),
    betweenLooseRawBrackets: (t) => container.betweenLooseRawBrackets(parsed, t),
    hasRawOpenParenBefore: (t) => container.hasRawOpenParenBefore(parsed, t),
    hasRawLtBefore: (t) => container.hasRawLtBefore(parsed, t),
    betweenRawAngleBrackets: (t) => container.betweenRawAngleBrackets(parsed, t),
    isAfterPointyOpener: (t) => container.isAfterPointyOpener(parsed, t),
  };
  // Generated link labels: resolved container-wide across single- and multi-line links.
  const labelDepthAt = [];
  const nonInlineRefSpan = new Array(tokens.length).fill(Boolean(inRefDef));
  let tabGuardBeforeOffset = /\t *$/.test(body) ? body.lastIndexOf('\t') : -1;
  if (body.includes('\t')) {
    for (let t = 0; t < tokens.length; t += 1) {
      if (tokens[t].type === 'opaque' && tokens[t].src.includes('\t')) {
        tabGuardBeforeOffset = Math.max(tabGuardBeforeOffset, tokOffsets[t] + 1);
      }
    }
  }
  for (let t = 0; t < tokens.length; t += 1) {
    const off = tokOffsets[t];
    if (frozenSet?.has(off) || off < tabGuardBeforeOffset) nonInlineRefSpan[t] = true;
    labelDepthAt.push(linkLabelSet?.has(off) ? 1 : 0);
  }
  // Authored bracket pairs: "[" is kept when its matching "]" is kept.
  const keepClose = new Set();
  for (let t = 0; t < tokens.length; t += 1) {
    if (tokens[t].type === 'esc' && tokens[t].ch === ']') {
      if (forcedKeptOffsets?.has(tokOffsets[t]) || keep(tokens, t, ctx, labelDepthAt[t], new Set())) keepClose.add(t);
    }
  }
  const pairKept = new Set();
  for (let t = 0; t < tokens.length; t += 1) {
    if (tokens[t].type === 'esc' && tokens[t].ch === '[') {
      if (forcedKeptOffsets?.has(tokOffsets[t]) || keep(tokens, t, ctx, labelDepthAt[t], new Set())) pairKept.add(t);
    }
  }
  // Atomic run closure for contiguous escaped delimiter runs (*, _, ~):
  // delimCapabilities evaluates flanking across [first, last] as an all-or-nothing unit.
  const runForcedKept = new Set();
  for (let t = 0; t < tokens.length; t += 1) {
    const k = tokens[t];
    if (k.type === 'esc' && DELIMS.has(k.ch)) {
      if (nonInlineRefSpan[t] || forcedKeptOffsets?.has(tokOffsets[t]) || keep(tokens, t, ctx, labelDepthAt[t], new Set())) {
        const [first, last] = runBounds(tokens, t, k.ch);
        for (let u = first; u <= last; u += 1) runForcedKept.add(u);
      }
    }
  }
  const stack = [];
  const multiLine = container.isMultiLine(parsed);
  for (let t = 0; t < tokens.length; t += 1) {
    const k = tokens[t];
    if (k.type !== 'esc' || labelDepthAt[t] > 0 || nonInlineRefSpan[t]) continue;
    if (k.ch === '[' && !pairKept.has(t) && !keep(tokens, t, ctx, labelDepthAt[t], new Set())) { stack.push(t); continue; }
    if (k.ch === ']' && stack.length) {
      const open = stack.pop();
      // A pair whose content matches a generated anchor definition label would be a
      // shortcut reference link: both brackets stay escaped.
      const inner = tokens.slice(open + 1, t).map((ik, off) => {
        const u = open + 1 + off;
        if (nonInlineRefSpan[u] || runForcedKept.has(u) || forcedKeptOffsets?.has(tokOffsets[u])) return ik.src;
        if (ik.type === 'esc' && ik.ch === ']' && labelDepthAt[u] === 0 && keepClose.has(u)) return ik.src;
        if (ik.type !== 'esc' && !(ik.type === 'ref' && ik.ch)) return ik.src;
        return keep(tokens, u, ctx, labelDepthAt[u], pairKept) ? ik.src : ik.ch;
      }).join('');
      const label = normalizeLabel(inner);
      if (keepClose.has(t) || labels.has(label)) { pairKept.add(open); keepClose.add(t); }
    } else if (k.ch === ']' && multiLine) {
      keepClose.add(t);
    }
  }
  if (multiLine) {
    for (const open of stack) pairKept.add(open);
  }
  const keepPairClose = (t) => keepClose.has(t);
  for (let t = 0; t < tokens.length; t += 1) {
    const k = tokens[t];
    if (nonInlineRefSpan[t] || runForcedKept.has(t) || forcedKeptOffsets?.has(tokOffsets[t])) { kept.add(t); continue; }
    if (k.type === 'esc' && k.ch === ']' && labelDepthAt[t] === 0 && keepPairClose(t)) { kept.add(t); continue; }
    if (k.type !== 'esc' && !(k.type === 'ref' && k.ch)) { kept.add(t); continue; }
    if (keep(tokens, t, ctx, labelDepthAt[t], pairKept)) kept.add(t);
  }
  for (let t = 0; t < tokens.length; t += 1) {
    const k = tokens[t];
    if (k.type === 'esc' && DELIMS.has(k.ch) && kept.has(t)) {
      const [first, last] = runBounds(tokens, t, k.ch);
      for (let u = first; u <= last; u += 1) kept.add(u);
    }
  }
  return kept;
}

const DELIMS = new Set(['*', '_', '~']);

// Can this delimiter token take part in syntax at all? Generated (unescaped)
// delimiters always count. An authored one counts only if its run could open or
// close (emphasis, strikethrough) or, for "$", open inline math (non-space on the
// right).
function capable(tokens, t) {
  const k = tokens[t];
  if (k.type !== 'esc') return true;
  const [first, last] = runBounds(tokens, t, k.ch);
  const d = delimCapabilities(tokens, first, last, k.ch);
  return d.canOpen || d.canClose;
}

const INLINE_AUTOLINK_OR_HTML_GFM_RE = /^(?:<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*>|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>|<!--(?:>|->|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Za-z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>)/;
const INLINE_AUTOLINK_OR_HTML_CM_RE = /^(?:<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*>|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>|<!--(?:>|->|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Za-z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)/;
const PANDOC_FN_DEF_RE = /^\[\^(?=[ \t]*\S)(?:[^\[\]\n\\]|\\.)+\]:/;

function parseMultilineLinkTailEnd(fullText, openParenPos, mode) {
  const skipSpnl = (p) => {
    const m = /^[ \t]*(?:\n[ \t]*)?/.exec(fullText.slice(p));
    return p + (m ? m[0].length : 0);
  };
  let p = skipSpnl(openParenPos + 1);
  if (p >= fullText.length) return -1;
  if (fullText[p] === ')') return p + 1;
  if (fullText[p] === '<') {
    const bm = /^<(?:[^<>\n\\]|\\.)*>/.exec(fullText.slice(p));
    if (!bm) return -1;
    p += bm[0].length;
  } else {
    const start = p;
    let parens = 0;
    while (p < fullText.length) {
      const ch = fullText[p];
      if (ch === '\\' && p + 1 < fullText.length && ASCII_PUNCT.test(fullText[p + 1])) {
        p += 2;
      } else if (ch === '(') {
        parens += 1;
        if (mode === 'gfm' && parens > 32) return -1;
        p += 1;
      } else if (ch === ')') {
        if (parens === 0) break;
        parens -= 1;
        p += 1;
      } else if (/[\x00-\x20\x7f]/.test(ch)) {
        break;
      } else {
        p += 1;
      }
    }
    if (p === start || parens !== 0) return -1;
  }
  const afterDest = p;
  const pAfterWs = skipSpnl(afterDest);
  if (pAfterWs < fullText.length && fullText[pAfterWs] === ')') return pAfterWs + 1;
  if (pAfterWs > afterDest && pAfterWs < fullText.length) {
    const tm = /^(?:"(?:\\.|[^"\\])*?"|'(?:\\.|[^'\\])*?'|\((?:\\.|[^()\\])*?\))/.exec(fullText.slice(pAfterWs));
    if (tm && !/\n[ \t]*\n/.test(tm[0])) {
      const pEnd = skipSpnl(pAfterWs + tm[0].length);
      if (pEnd < fullText.length && fullText[pEnd] === ')') return pEnd + 1;
    }
  }
  return -1;
}

function isValidLinkLabelBody(raw) {
  let cpCount = 0;
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === '[' || ch === ']') return false;
    if (ch === '\\') {
      if (i + 1 >= raw.length) return false;
      const cp = String.fromCodePoint(raw.codePointAt(i + 1));
      cpCount += 2;
      if (cpCount > 999) return false;
      i += 1 + cp.length;
      continue;
    }
    const cp = String.fromCodePoint(raw.codePointAt(i));
    cpCount += 1;
    if (cpCount > 999) return false;
    i += cp.length;
  }
  return true;
}

function scanRefLabelClose(fullText, openBracketPos) {
  let p = openBracketPos + 1;
  let cpCount = 0;
  while (p < fullText.length) {
    const ch = fullText[p];
    if (ch === ']') return p;
    if (ch === '[') return -1;
    if (ch === '\\') {
      if (p + 1 >= fullText.length) return -1;
      const cp = String.fromCodePoint(fullText.codePointAt(p + 1));
      cpCount += 2;
      if (cpCount > 999) return -1;
      p += 1 + cp.length;
      continue;
    }
    const cp = String.fromCodePoint(fullText.codePointAt(p));
    cpCount += 1;
    if (cpCount > 999) return -1;
    p += cp.length;
  }
  return -1;
}

function findGfmCellSliceRanges(line, startIdx) {
  const ranges = [];
  let segStart = startIdx;
  for (let r = startIdx; r < line.length; r += 1) {
    if (line[r] === '|') {
      let bs = 0;
      for (let b = r - 1; b >= startIdx && line[b] === '\\'; b -= 1) bs += 1;
      if (bs % 2 === 0) {
        if (r > segStart) ranges.push({ startIdx: segStart, endIdx: r });
        segStart = r + 1;
      }
    }
  }
  if (line.length > segStart) ranges.push({ startIdx: segStart, endIdx: line.length });
  return ranges;
}

const AUTOLINK_TRAIL_PUNCT_RE = /[?!"',.:;*_~]/;

function parsePandocAutolinkDomainLen(str, minSegments) {
  const first = /^[\p{L}\p{N}\p{M}_-]+/u.exec(str);
  if (!first || /[-_]$/.test(first[0])) return -1;
  let cur = first[0].length;
  let segs = 1;
  while (str[cur] === '.') {
    const next = /^[\p{L}\p{N}\p{M}_-]+/u.exec(str.slice(cur + 1));
    if (!next || /[-_]$/.test(next[0])) break;
    cur += 1 + next[0].length;
    segs += 1;
  }
  return segs >= minSegments ? cur : -1;
}

function matchGfmBareAutolinkEnd(fullText, pos) {
  let prevCp = null;
  if (pos > 0) {
    const prev = fullText.slice(Math.max(0, pos - 2), pos);
    prevCp = String.fromCodePoint(prev.codePointAt(prev.length >= 2 && prev.codePointAt(0) > 0xFFFF ? 0 : prev.length - 1));
  }
  const rest = fullText.slice(pos);

  // 1. Bare URL ((?:https?|ftp)://) or www. autolink (Autolink.hs wwwAutolink / urlAutolink — tried before emailAutolink at same pos)
  if (prevCp === null || !/[\p{L}\p{N}]/u.test(prevCp)) {
    let domEnd = -1;
    const schemeM = /^(?:https?|ftp):\/\//i.exec(rest);
    if (schemeM) {
      const domLen = parsePandocAutolinkDomainLen(rest.slice(schemeM[0].length), 2);
      if (domLen > 0) domEnd = pos + schemeM[0].length + domLen;
    } else if (/^www\./i.test(rest)) {
      const domLen = parsePandocAutolinkDomainLen(rest.slice(4), 1);
      if (domLen > 0) domEnd = pos + 4 + domLen;
    }
    if (domEnd > pos) {
      let p = domEnd;
      let openParens = 0;
      let prevRecStart = -1;
      let prevRecQ = -1;
      while (p < fullText.length) {
        const ch = fullText[p];
        if (/[\x00 \t\r\n<]/.test(ch)) break;
        if (ch === '(') {
          openParens += 1;
          p += 1;
          continue;
        }
        if (ch === ')') {
          if (openParens > 0) {
            openParens -= 1;
            p += 1;
            continue;
          }
          break;
        }
        if (AUTOLINK_TRAIL_PUNCT_RE.test(ch)) {
          let q = p + 1;
          while (q < fullText.length && (AUTOLINK_TRAIL_PUNCT_RE.test(fullText[q]) || fullText[q] === '<' || fullText[q] === ')')) {
            q += 1;
          }
          const nextCh = q < fullText.length ? fullText[q] : '';
          if (nextCh && !/[\x00 \t\r\n<)]/.test(nextCh) && !AUTOLINK_TRAIL_PUNCT_RE.test(nextCh)) {
            if (nextCh === '(') openParens += 1;
            prevRecStart = p;
            prevRecQ = q;
            p = q + 1;
            continue;
          }
          if (ch === ';') {
            const entM = /&[A-Za-z0-9]+$/.exec(fullText.slice(domEnd, p));
            if (entM) {
              p -= entM[0].length;
              if (p === prevRecQ) p = prevRecStart;
            }
          }
          break;
        }
        p += 1;
      }
      return p;
    }
  }

  // 2. Bare email autolink (CommonMark.Extensions.Autolink emailAutolink)
  if (prevCp === null || !/[\p{L}\p{N}\p{M}._%+-]/u.test(prevCp)) {
    const emailM = /^[\p{L}\p{N}\p{M}._%+-]+@/u.exec(rest);
    if (emailM) {
      const domLen = parsePandocAutolinkDomainLen(rest.slice(emailM[0].length), 2);
      if (domLen > 0) {
        const emailEnd = pos + emailM[0].length + domLen;
        if (!/^[-_]/.test(fullText.slice(emailEnd, emailEnd + 1))) return emailEnd;
      }
    }
  }

  return -1;
}

function scanInlineSliceOpaques(slices, opaqueIntervalsByLine, frozenSetsByLine, linkLabelSetsByLine, matchedBracketsByLine, mode, labels, fnLabels) {
  let fullText = '';
  const charMap = [];
  for (let sIdx = 0; sIdx < slices.length; sIdx += 1) {
    if (sIdx > 0) {
      fullText += '\n';
      charMap.push(null);
    }
    const { lineIdx, startIdx, endIdx, line } = slices[sIdx];
    for (let r = startIdx; r < endIdx; r += 1) {
      fullText += line[r];
      charMap.push({ lineIdx, rawIdx: r });
    }
  }
  const markSpan = (fromPos, toPos) => {
    let curLine = -1;
    let curStart = -1;
    let curEnd = -1;
    const flush = () => {
      if (curLine >= 0 && curEnd > curStart) {
        opaqueIntervalsByLine[curLine].push({ start: curStart, end: curEnd });
      }
      curLine = -1;
    };
    for (let u = fromPos; u < toPos; u += 1) {
      const loc = charMap[u];
      if (!loc) {
        flush();
        continue;
      }
      if (loc.lineIdx === curLine && loc.rawIdx === curEnd) {
        curEnd = loc.rawIdx + 1;
      } else {
        flush();
        curLine = loc.lineIdx;
        curStart = loc.rawIdx;
        curEnd = loc.rawIdx + 1;
      }
    }
    flush();
  };
  const markCharSet = (targetSets, fromPos, toPos) => {
    for (let u = fromPos; u < toPos; u += 1) {
      const loc = charMap[u];
      if (loc) targetSets[loc.lineIdx].add(loc.rawIdx);
    }
  };
  const bracketStack = [];
  let pos = 0;
  while (pos < fullText.length) {
    if (fullText[pos] === '\\' && pos + 1 < fullText.length && ASCII_PUNCT.test(fullText[pos + 1])) {
      pos += 2;
      continue;
    }
    if (mode === 'gfm' && fullText[pos] === '$') {
      if (fullText[pos + 1] === '$') {
        let j = pos + 2;
        let closePos = -1;
        while (j < fullText.length) {
          if (fullText[j] === '\\') { j += 2; continue; }
          if (fullText[j] === '$') {
            if (fullText[j + 1] === '$') closePos = j;
            break;
          }
          j += 1;
        }
        if (closePos >= 0) {
          markSpan(pos, closePos + 2);
          pos = closePos + 2;
          continue;
        }
      } else {
        if (pos + 1 < fullText.length && !/^[ \t\n$]$/.test(fullText[pos + 1])) {
          let j = pos + 1;
          let closePos = -1;
          while (j < fullText.length) {
            if (fullText[j] === '\\') { j += 2; continue; }
            if (fullText[j] === '$') {
              if (!/^[ \t\n]$/.test(fullText[j - 1])) closePos = j;
              break;
            }
            j += 1;
          }
          if (closePos >= 0) {
            markSpan(pos, closePos + 1);
            pos = closePos + 1;
            continue;
          }
        }
        if (fullText[pos + 1] === '`') {
          let runLen = 1;
          while (fullText[pos + 1 + runLen] === '`') runLen += 1;
          let j = pos + 1 + runLen;
          let closeBt = -1;
          while (j < fullText.length) {
            if (fullText[j] === '`') {
              let m = 1;
              while (fullText[j + m] === '`') m += 1;
              if (m === runLen) { closeBt = j; break; }
              j += m;
            } else {
              j += 1;
            }
          }
          if (closeBt >= 0 && fullText[closeBt + runLen] === '$') {
            markSpan(pos, closeBt + runLen + 1);
            pos = closeBt + runLen + 1;
            continue;
          }
        }
      }
    }
    if (fullText[pos] === '`') {
      let runLen = 1;
      while (fullText[pos + runLen] === '`') runLen += 1;
      let j = pos + runLen;
      let closePos = -1;
      while (j < fullText.length) {
        if (fullText[j] === '`') {
          let m = 1;
          while (fullText[j + m] === '`') m += 1;
          if (m === runLen) { closePos = j; break; }
          j += m;
        } else {
          j += 1;
        }
      }
      if (closePos >= 0) {
        markSpan(pos, closePos + runLen);
        pos = closePos + runLen;
      } else {
        pos += runLen;
      }
      continue;
    }
    if (fullText[pos] === '<') {
      const m = (mode === 'gfm' ? INLINE_AUTOLINK_OR_HTML_GFM_RE : INLINE_AUTOLINK_OR_HTML_CM_RE).exec(fullText.slice(pos));
      if (m) {
        markSpan(pos, pos + m[0].length);
        pos += m[0].length;
        continue;
      }
    }
    if (mode === 'gfm') {
      const bareEnd = matchGfmBareAutolinkEnd(fullText, pos);
      if (bareEnd > pos) {
        markSpan(pos, bareEnd);
        pos = bareEnd;
        continue;
      }
    }
    if (fullText[pos] === '!' && fullText[pos + 1] === '[') {
      bracketStack.push({ openPos: pos, labelStartPos: pos + 2, isImage: true, inactive: false });
      pos += 2;
      continue;
    }
    if (fullText[pos] === '[') {
      bracketStack.push({ openPos: pos, labelStartPos: pos + 1, isImage: false, inactive: false });
      pos += 1;
      continue;
    }
    if (fullText[pos] === ']') {
      if (!bracketStack.length) {
        pos += 1;
        continue;
      }
      const opener = bracketStack.pop();
      if (fullText[pos + 1] === ':') {
        markCharSet(frozenSetsByLine, opener.labelStartPos, pos);
      }
      if (opener.inactive) {
        pos += 1;
        continue;
      }
      if (mode === 'gfm' && !opener.isImage && fullText[opener.labelStartPos] === '^') {
        const fnRaw = fullText.slice(opener.labelStartPos + 1, pos);
        if (!/\n/.test(fnRaw) && isValidLinkLabelBody(fnRaw) && fnLabels?.has(normalizeLabel(fnRaw))) {
          markCharSet(frozenSetsByLine, opener.labelStartPos, pos);
          markCharSet(matchedBracketsByLine, opener.labelStartPos - 1, opener.labelStartPos);
          markCharSet(matchedBracketsByLine, pos, pos + 1);
          pos += 1;
          continue;
        }
      }
      let matched = false;
      let nextPos = pos + 1;
      if (fullText[pos + 1] === '(') {
        const tailEnd = parseMultilineLinkTailEnd(fullText, pos + 1, mode);
        if (tailEnd > pos + 1) {
          markSpan(pos + 1, tailEnd);
          markCharSet(linkLabelSetsByLine, opener.labelStartPos, pos);
          markCharSet(matchedBracketsByLine, opener.labelStartPos - 1, opener.labelStartPos);
          markCharSet(matchedBracketsByLine, pos, pos + 1);
          matched = true;
          nextPos = tailEnd;
        }
      }
      if (!matched && fullText[pos + 1] === '[') {
        const refClose = scanRefLabelClose(fullText, pos + 1);
        if (refClose === pos + 2) {
          const openerRaw = fullText.slice(opener.labelStartPos, pos);
          if (openerRaw.trim() !== '' && isValidLinkLabelBody(openerRaw) && labels.has(normalizeLabel(openerRaw))) {
            markCharSet(frozenSetsByLine, opener.labelStartPos, pos);
            markCharSet(linkLabelSetsByLine, opener.labelStartPos, pos);
            markCharSet(matchedBracketsByLine, opener.labelStartPos - 1, pos + 3);
            matched = true;
            nextPos = pos + 3;
          }
        } else if (refClose > pos + 2) {
          const refRaw = fullText.slice(pos + 2, refClose);
          if (refRaw.trim() !== '' && labels.has(normalizeLabel(refRaw))) {
            markCharSet(frozenSetsByLine, pos + 2, refClose);
            markCharSet(linkLabelSetsByLine, opener.labelStartPos, pos);
            markCharSet(matchedBracketsByLine, opener.labelStartPos - 1, opener.labelStartPos);
            markCharSet(matchedBracketsByLine, pos, pos + 2);
            markCharSet(matchedBracketsByLine, refClose, refClose + 1);
            matched = true;
            nextPos = refClose + 1;
          }
        }
      }
      if (!matched && !(fullText[pos + 1] === '[' && fullText[pos + 2] === ']')) {
        const openerRaw = fullText.slice(opener.labelStartPos, pos);
        if (openerRaw.trim() !== '' && isValidLinkLabelBody(openerRaw) && labels.has(normalizeLabel(openerRaw))) {
          markCharSet(frozenSetsByLine, opener.labelStartPos, pos);
          markCharSet(linkLabelSetsByLine, opener.labelStartPos, pos);
          markCharSet(matchedBracketsByLine, opener.labelStartPos - 1, opener.labelStartPos);
          markCharSet(matchedBracketsByLine, pos, pos + 1);
          matched = true;
          nextPos = pos + 1;
        }
      }
      if (matched && !opener.isImage) {
        for (const b of bracketStack) {
          if (!b.isImage) b.inactive = true;
        }
      }
      pos = nextPos;
      continue;
    }
    pos += 1;
  }
}

function normalizeOpaqueSpans(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      if (cur.end > prev.end) prev.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// Inline containers: consecutive paragraph lines form one; a heading and a list
// item are one each. Tables depend on the reader: GFM parses each cell alone, but a
// CommonMark reader sees the whole table as one paragraph, so "*" and "_" (emphasis
// in both) use the whole table while "~" and "$" (GFM strikethrough, pandoc math)
// use the cell. Every delimiter token (escaped or
// generated) is recorded with its container so partner checks see all of it.
function containers(parsedLines) {
  const members = new Map();
  const lineCounts = new Map();
  const baseKeys = new Map();
  const inlineTokensByKey = new Map();
  let paraKey = null;
  parsedLines.forEach((p, n) => {
    if (!p) { paraKey = null; return; }
    if (p.isBlankInner || p.inRefDef) { paraKey = null; p.keyOf = () => null; p.inlineKey = () => null; return; }
    let key;
    if (p.kind === 'item') {
      paraKey = `para${n}`;
      key = paraKey;
    } else if (p.kind === 'para' || p.kind === 'cell') {
      if (p.breakPara || !paraKey || (!p.cmMergeCellWithPara && !paraKey.startsWith(p.kind))) paraKey = `${p.cmMergeCellWithPara ? 'para' : p.kind}${n}`;
      key = paraKey;
    } else {
      paraKey = null;
      key = `l${n}`;
    }
    baseKeys.set(p, key);
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
    p.keyOf = (t, ch) => (p.kind === 'cell' && (ch === '~' || ch === '$') ? `${key}r${n}c${p.cellOf[t]}` : key);
    p.inlineKey = (t) => (p.kind === 'cell' && !p.cmMergeCellWithPara ? `${key}r${n}c${p.cellOf[t]}` : key);
    p.tokens.forEach((k, t) => {
      if (!(p.kind === 'cell' && !p.cmMergeCellWithPara && p.cellOf[t] < 0)) {
        const ik = p.inlineKey(t);
        if (!inlineTokensByKey.has(ik)) inlineTokensByKey.set(ik, []);
        const off = p.tokOffsets[t];
        const isLooseRaw = k.type === 'raw' && !p.inRefDef && !p.frozenSet?.has(off) && !p.linkLabelSet?.has(off) && !p.matchedBracketSet?.has(off);
        inlineTokensByKey.get(ik).push({ n, t, k, isLooseRaw });
      }
      const ck = p.keyOf(t, k.type === 'opaque' ? '$' : k.ch);
      if (!members.has(ck)) members.set(ck, []);
      // Every "$" counts, including those inside code spans (pandoc's math scanner
      // does not stop at them); opaque ones are treated as able to open and close.
      if (k.type === 'opaque') {
        if (k.src.includes('$')) members.get(ck).push({ n, t, ch: '$', open: true, close: true });
        return;
      }
      if (k.ch === '$') {
        const isMathEdgeWs = (c) => c === null || c === ' ' || c === '\t';
        members.get(ck).push({ n, t, ch: '$', open: !isMathEdgeWs(rightChar(p.tokens, t)), close: !isMathEdgeWs(leftChar(p.tokens, t)) });
        return;
      }
      if (!DELIMS.has(k.ch) || !capable(p.tokens, t)) return;
      members.get(ck).push({ n, t, ch: k.ch });
    });
  });

  const indexOf = new Map(parsedLines.map((p, n) => [p, n]));
  const inlineListAndPos = (p, t) => {
    const n = indexOf.get(p);
    const ik = p.inlineKey?.(t);
    const list = ik ? (inlineTokensByKey.get(ik) ?? []) : [];
    const idx = list.findIndex((e) => e.n === n && e.t === t);
    return { list, idx, n };
  };
  return {
    isMultiLine(p) {
      const key = baseKeys.get(p);
      return key ? (lineCounts.get(key) ?? 0) > 1 : false;
    },
    hasPartner(p, ch, first, last) {
      const n = indexOf.get(p);
      return (members.get(p.keyOf(first, ch)) ?? []).some((m) => m.ch === ch && !(m.n === n && m.t >= first && m.t <= last));
    },
    dollarPairs(p, t) {
      const n = indexOf.get(p);
      const all = (members.get(p.keyOf(t, '$')) ?? []).filter((m) => m.ch === '$');
      const self = all.find((m) => m.n === n && m.t === t);
      if (!self) return true;
      const before = (m) => m.n < n || (m.n === n && m.t < t);
      const later = (m) => m.n > n || (m.n === n && m.t > t);
      return (self.open && all.some((m) => later(m) && m.close)) || (self.close && all.some((m) => before(m) && m.open));
    },
    hasLooseRawOpenBracketBefore(p, t) {
      const { list, idx } = inlineListAndPos(p, t);
      if (idx < 0) return false;
      let depth = 0;
      for (let i = 0; i < idx; i += 1) {
        if (!list[i].isLooseRaw) continue;
        if (list[i].k.ch === '[') depth += 1;
        else if (list[i].k.ch === ']' && depth > 0) depth -= 1;
      }
      return depth > 0;
    },
    hasLooseRawCloseBracketAfter(p, t) {
      const { list, idx } = inlineListAndPos(p, t);
      if (idx < 0) return false;
      let depth = 0;
      for (let i = list.length - 1; i > idx; i -= 1) {
        if (!list[i].isLooseRaw) continue;
        if (list[i].k.ch === ']') depth += 1;
        else if (list[i].k.ch === '[' && depth > 0) depth -= 1;
      }
      return depth > 0;
    },
    betweenLooseRawBrackets(p, t) {
      return this.hasLooseRawOpenBracketBefore(p, t) && this.hasLooseRawCloseBracketAfter(p, t);
    },
    hasRawOpenParenBefore(p, t) {
      const { list, idx } = inlineListAndPos(p, t);
      for (let i = 0; i < idx; i += 1) {
        if (list[i].k.type === 'raw' && !p.inRefDef && list[i].k.ch === '(') return true;
      }
      return false;
    },
    hasRawLtBefore(p, t) {
      const { list, idx } = inlineListAndPos(p, t);
      for (let i = 0; i < idx; i += 1) {
        if (list[i].k.type === 'raw' && list[i].k.ch === '<') return true;
      }
      return false;
    },
    betweenRawAngleBrackets(p, t) {
      const { list, idx } = inlineListAndPos(p, t);
      if (idx < 0) return false;
      let hasLt = false;
      for (let i = 0; i < idx; i += 1) {
        if (list[i].k.type === 'raw' && list[i].k.ch === '<') { hasLt = true; break; }
      }
      if (!hasLt) return false;
      for (let i = idx; i < list.length; i += 1) {
        const lk = list[i].k;
        if (((lk.type === 'raw' || lk.type === 'esc') && lk.ch === '>') || (lk.type === 'opaque' && lk.src.includes('>'))) return true;
      }
      return false;
    },
    isAfterPointyOpener(p, t) {
      if (!p.tokens.slice(t + 1).some((k) => ((k.type === 'raw' || k.type === 'esc') && k.ch === '>') || (k.type === 'opaque' && k.src.includes('>')))) return false;
      const { list, idx, n } = inlineListAndPos(p, t);
      if (idx <= 0) return false;
      let i = idx - 1;
      while (i >= 0 && list[i].k.type === 'raw' && (list[i].k.ch === ' ' || list[i].k.ch === '\t') && n - list[i].n <= 1) {
        i -= 1;
      }
      if (i < 0 || n - list[i].n > 1) return false;
      const opener = list[i].k;
      if (opener.type === 'raw' && opener.ch === '(') return true;
      if ((opener.type === 'raw' || opener.type === 'ref') && opener.ch === ':' && i >= 1) {
        const prev = list[i - 1].k;
        if ((prev.type === 'raw' || prev.type === 'esc') && prev.ch === ']') return true;
      }
      return false;
    },
  };
}

function stripLeadingRefDefs(block, labels, isGfm = true) {
  const spnlRe = isGfm ? /^[ \t]*(?:\n[ \t]*)?/ : /^ *(?:\n *)?/;
  const trailWsRe = isGfm ? /^[ \t]*(?=\n|$)/ : /^ *(?=\n|$)/;
  const titleRe = isGfm
    ? /^(?:"(?:\\.|[^"\\])*?"|'(?:\\.|[^'\\])*?'|\((?:\\.|[^()\\])*?\))[ \t]*(?=\n|$)/
    : /^(?:"(?:\\.|[^"\\])*?"|'(?:\\.|[^'\\])*?'|\((?:\\.|[^()\\])*?\)) *(?=\n|$)/;
  let pos = 0;
  while (pos < block.length) {
    let p = pos;
    let sp = 0;
    while (p < block.length && block[p] === ' ' && sp < 3) { sp += 1; p += 1; }
    if (block[p] !== '[') break;
    p += 1;
    const labelStart = p;
    let cpCount = 0;
    let labelEnd = -1;
    while (p < block.length) {
      const ch = block[p];
      if (ch === ']') { labelEnd = p; p += 1; break; }
      if (ch === '[') break;
      if (ch === '\\') {
        if (p + 1 >= block.length) break;
        const nextCp = String.fromCodePoint(block.codePointAt(p + 1));
        cpCount += 2;
        if (cpCount > 999) break;
        p += 1 + nextCp.length;
        continue;
      }
      const cp = String.fromCodePoint(block.codePointAt(p));
      cpCount += 1;
      if (cpCount > 999) break;
      p += cp.length;
    }
    if (labelEnd < 0 || block[p] !== ':') break;
    const rawLabel = block.slice(labelStart, labelEnd);
    if (rawLabel.trim() === '') break;
    p += 1;
    const ws1 = spnlRe.exec(block.slice(p));
    p += ws1 ? ws1[0].length : 0;
    if (p >= block.length) break;
    if (block[p] === '<') {
      const bm = /^<(?:[^<>\n\\]|\\.)*>/.exec(block.slice(p));
      if (!bm) break;
      p += bm[0].length;
    } else {
      const destStart = p;
      let parens = 0;
      while (p < block.length) {
        const ch = block[p];
        if (ch === '\\' && p + 1 < block.length && ASCII_PUNCT.test(block[p + 1])) {
          p += 2;
        } else if (ch === '(') {
          parens += 1;
          if (parens > 32) break;
          p += 1;
        } else if (ch === ')') {
          if (parens === 0) break;
          parens -= 1;
          p += 1;
        } else if (/[\x00-\x20\x7f]/.test(ch)) {
          break;
        } else {
          p += 1;
        }
      }
      if (p === destStart || parens !== 0) break;
    }
    const afterDestPos = p;
    let finalEnd = -1;
    const trailEmpty = trailWsRe.exec(block.slice(afterDestPos));
    if (trailEmpty) {
      finalEnd = afterDestPos + trailEmpty[0].length;
    }
    const ws2 = spnlRe.exec(block.slice(afterDestPos));
    if (ws2 && ws2[0].length > 0) {
      const tp = afterDestPos + ws2[0].length;
      const tm = titleRe.exec(block.slice(tp));
      if (tm && !/\n[ \t]*\n/.test(tm[0])) {
        finalEnd = tp + tm[0].length;
      } else if (!ws2[0].includes('\n') && tp < block.length && block[tp] !== '\n') {
        finalEnd = -1;
      }
    }
    if (finalEnd < 0) break;
    labels.add(normalizeLabel(rawLabel));
    pos = finalEnd < block.length && block[finalEnd] === '\n' ? finalEnd + 1 : finalEnd;
  }
  return pos;
}

function matchBqAtCur(rawLine, cur) {
  const { wsCols, afterWsIdx, afterWsCol } = peekWsCols(rawLine, cur);
  if (wsCols > 3 || afterWsIdx >= rawLine.length || rawLine[afterWsIdx] !== '>') return null;
  let next = { idx: afterWsIdx + 1, col: afterWsCol + 1, vSpaces: 0 };
  if (next.idx < rawLine.length && (rawLine[next.idx] === ' ' || rawLine[next.idx] === '\t')) {
    next = consumeCols(rawLine, next, 1);
  }
  return next;
}

function isFenceOpenLine(eff) {
  const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(eff);
  return Boolean(fm && (fm[1][0] === '~' || !fm[2].includes('`')));
}

function peekNextTableDelimEff(rawLine, openContainers) {
  let cur = { idx: 0, col: 0, vSpaces: 0 };
  for (let k = 0; k < openContainers.length; k += 1) {
    const c = openContainers[k];
    if (c.type === 'bq') {
      const next = matchBqAtCur(rawLine, cur);
      if (!next) return null;
      cur = next;
    } else {
      if (isBlankAscii(rawLine.slice(cur.idx))) return null;
      const { wsCols } = peekWsCols(rawLine, cur);
      if (wsCols < c.indent) return null;
      cur = consumeCols(rawLine, cur, c.indent);
    }
  }
  const { wsCols } = peekWsCols(rawLine, cur);
  if (wsCols >= 4) return null;
  const eff = expandTabsFrom(rawLine, cur);
  if (isBlankAscii(eff)) return null;
  if (matchBqAtCur(rawLine, cur)) return null;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(eff)) return null;
  if (isFenceOpenLine(eff)) return null;
  if (detectHtmlBlockOpen(eff, true, true)) return null;
  if (THEMATIC_BREAK_RE.test(eff)) return null;
  if (parseListMarkerAtCur(rawLine, cur, 'none')) return null;
  if (PANDOC_FN_DEF_RE.test(eff.replace(/^[ \t]+/, ''))) return null;
  return eff;
}

function buildReaderModel(lines, mode, gfmTableSet = null) {
  const isGfm = mode === 'gfm';
  const isFenced = new Array(lines.length).fill(false);
  const prevLineTextArr = new Array(lines.length).fill(false);
  const metaArr = new Array(lines.length).fill(null);
  const stepCursorsByLine = lines.map(() => []);
  const labels = new Set();
  const fnLabels = new Set();
  const tableLineSet = new Set();

  const openContainers = [];
  let fence = null;
  let htmlBlock = null;
  let inIndentedCode = false;
  let leafState = 'none'; // 'none' | 'para' | 'table'
  let curParaLines = [];
  let startLineIdx = 0;

  // Pandoc GFM +yaml_metadata_block at line 0 ("---" ... "---"/"..." without blank lines)
  if (isGfm && lines.length >= 2 && /^---[ \t]*$/.test(lines[0])) {
    let closeIdx = -1;
    for (let k = 1; k < lines.length; k += 1) {
      if (isBlankAscii(lines[k])) break;
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[k])) { closeIdx = k; break; }
    }
    if (closeIdx >= 1) {
      for (let k = 0; k <= closeIdx; k += 1) isFenced[k] = true;
      startLineIdx = closeIdx + 1;
    }
  }

  const flushPara = () => {
    if (!curParaLines.length) return '';
    const block = curParaLines.map((e) => e.text).join('\n');
    const consumed = stripLeadingRefDefs(block, labels, isGfm);
    if (consumed > 0) {
      let offset = 0;
      let markedFirstAfterRefDef = false;
      for (const entry of curParaLines) {
        if (offset < consumed && metaArr[entry.lineIdx]) {
          metaArr[entry.lineIdx].inRefDef = true;
          prevLineTextArr[entry.lineIdx] = false;
        } else if (!markedFirstAfterRefDef && metaArr[entry.lineIdx]) {
          metaArr[entry.lineIdx].breakPara = true;
          prevLineTextArr[entry.lineIdx] = false;
          markedFirstAfterRefDef = true;
        }
        offset += entry.text.length + 1;
      }
    }
    curParaLines = [];
    return block.slice(consumed);
  };

  for (let i = startLineIdx; i < lines.length; i += 1) {
    const rawLine = lines[i];
    let cur = { idx: 0, col: 0, vSpaces: 0 };
    const stepCursors = [{ ...cur }];
    stepCursorsByLine[i] = stepCursors;
    let matchedDepth = 0;
    for (let k = 0; k < openContainers.length; k += 1) {
      const c = openContainers[k];
      if (c.type === 'bq') {
        const next = matchBqAtCur(rawLine, cur);
        if (!next) break;
        cur = next;
        stepCursors.push({ ...cur });
        matchedDepth += 1;
      } else {
        const isBlankRem = isBlankAscii(rawLine.slice(cur.idx));
        if (isBlankRem) {
          if (c.pendingEmpty) break;
          cur = { idx: rawLine.length, col: cur.col, vSpaces: 0 };
          stepCursors.push({ ...cur });
          matchedDepth += 1;
        } else {
          const { wsCols } = peekWsCols(rawLine, cur);
          if (wsCols < c.indent) break;
          c.pendingEmpty = false;
          cur = consumeCols(rawLine, cur, c.indent);
          stepCursors.push({ ...cur });
          matchedDepth += 1;
        }
      }
    }

    let allClosed = matchedDepth === openContainers.length;
    if (!allClosed) {
      fence = null;
      htmlBlock = null;
      inIndentedCode = false;
    }

    if (fence) {
      isFenced[i] = true;
      const eff = expandTabsFrom(rawLine, cur);
      const closeM = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(eff);
      if (closeM && closeM[1][0] === fence.ch && closeM[1].length >= fence.len) fence = null;
      leafState = 'none';
      continue;
    }

    if (htmlBlock) {
      const eff = expandTabsFrom(rawLine, cur);
      if (htmlBlock.endOnBlank && isBlankAscii(eff)) {
        htmlBlock = null;
        leafState = 'none';
        metaArr[i] = {
          inTable: false, isHeading: false, isLeafBreak: false, openedList: false,
          contentStartIdx: rawLine.length, rawContentStartIdx: rawLine.length,
          isBlankInner: true, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        continue;
      }
      isFenced[i] = true;
      if (htmlBlock.endRe && htmlBlock.endRe.test(eff)) htmlBlock = null;
      leafState = 'none';
      continue;
    }

    if (inIndentedCode) {
      const eff = expandTabsFrom(rawLine, cur);
      const { wsCols } = peekWsCols(rawLine, cur);
      if (isBlankAscii(eff) || wsCols >= 4) {
        isFenced[i] = true;
        continue;
      }
      inIndentedCode = false;
      leafState = 'none';
    }

    if (isGfm && leafState === 'table') {
      const eff0 = expandTabsFrom(rawLine, cur);
      const { afterWsIdx: rowStartIdx } = peekWsCols(rawLine, cur);
      const continuesTable = allClosed
        && !isBlankAscii(eff0)
        && !matchBqAtCur(rawLine, cur)
        && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(eff0)
        && !isFenceOpenLine(eff0)
        && !detectHtmlBlockOpen(eff0, true, true)
        && !THEMATIC_BREAK_RE.test(eff0)
        && !parseListMarkerAtCur(rawLine, cur, 'none')
        && !PANDOC_FN_DEF_RE.test(eff0.replace(/^ {0,3}/, ''))
        && splitGfmTableCells(eff0) !== null;
      if (continuesTable) {
        prevLineTextArr[i] = true;
        tableLineSet.add(i);
        metaArr[i] = {
          inTable: true, isHeading: false, isLeafBreak: false, openedList: false,
          contentStartIdx: -1, rawContentStartIdx: rowStartIdx,
          isBlankInner: false, breakPara: false, inRefDef: false, cmMergeCellWithPara: false,
        };
        continue;
      }
      leafState = 'none';
    }

    let prevLeafWasPara = leafState === 'para';
    let inParaAtMatched = allClosed && prevLeafWasPara;
    let closedUnmatched = false;
    let openedAnyContainer = false;
    let openedList = false;
    let justOpenedBq = false;
    let matchedLeaf = false;

    const closeUnmatched = () => {
      if (!closedUnmatched) {
        flushPara();
        openContainers.length = matchedDepth;
        allClosed = true;
        prevLeafWasPara = false;
        inParaAtMatched = false;
        closedUnmatched = true;
      }
    };

    while (!matchedLeaf) {
      const eff = expandTabsFrom(rawLine, cur);
      const { wsCols, afterWsIdx, afterWsCol } = peekWsCols(rawLine, cur);
      const isBlank = afterWsIdx >= rawLine.length;
      if (isBlank) {
        closeUnmatched();
        leafState = 'none';
        matchedLeaf = true;
        metaArr[i] = {
          inTable: false, isHeading: false, isLeafBreak: false, openedList: false,
          contentStartIdx: rawLine.length, rawContentStartIdx: rawLine.length,
          isBlankInner: true, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        break;
      }
      const indented = wsCols >= 4;

      if (isGfm && justOpenedBq && !indented && /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i.test(rawLine.slice(afterWsIdx))) {
        closeUnmatched();
        leafState = 'none';
        matchedLeaf = true;
        metaArr[i] = {
          inTable: false, isHeading: false, isLeafBreak: true, openedList: false,
          contentStartIdx: afterWsIdx, rawContentStartIdx: afterWsIdx,
          isBlankInner: false, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        break;
      }

      const bqNext = !indented ? matchBqAtCur(rawLine, cur) : null;
      if (bqNext) {
        closeUnmatched();
        openContainers.push({ type: 'bq' });
        matchedDepth = openContainers.length;
        openedAnyContainer = true;
        openedList = false;
        justOpenedBq = true;
        cur = bqNext;
        stepCursors.push({ ...cur });
        continue;
      }

      if (isGfm && !indented) {
        const fnM = PANDOC_FN_DEF_RE.exec(rawLine.slice(afterWsIdx));
        if (fnM) {
          closeUnmatched();
          fnLabels.add(normalizeLabel(fnM[0].slice(2, -2)));
          openContainers.push({ type: 'fn', indent: 4, pendingEmpty: false });
          matchedDepth = openContainers.length;
          openedAnyContainer = true;
          openedList = false;
          justOpenedBq = false;
          cur = { idx: afterWsIdx + fnM[0].length, col: afterWsCol + fnM[0].length, vSpaces: 0 };
          stepCursors.push({ ...cur });
          continue;
        }
      }

      const atxM = !indented ? /^(#{1,6})(?:[ \t]+|$)/.exec(rawLine.slice(afterWsIdx)) : null;
      if (atxM) {
        closeUnmatched();
        leafState = 'none';
        const afterHashCur = { idx: afterWsIdx + atxM[1].length, col: afterWsCol + atxM[1].length, vSpaces: 0 };
        const { afterWsIdx: hStartIdx } = peekWsCols(rawLine, afterHashCur);
        matchedLeaf = true;
        metaArr[i] = {
          inTable: false, isHeading: true, isLeafBreak: false, openedList: false,
          contentStartIdx: hStartIdx, rawContentStartIdx: hStartIdx,
          isBlankInner: false, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        break;
      }

      const fenceM = !indented ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(eff) : null;
      if (fenceM && (fenceM[1][0] === '~' || !fenceM[2].includes('`'))) {
        closeUnmatched();
        fence = { ch: fenceM[1][0], len: fenceM[1].length };
        leafState = 'none';
        isFenced[i] = true;
        matchedLeaf = true;
        break;
      }

      const hbCanInterrupt = isGfm ? inParaAtMatched : (inParaAtMatched || (!allClosed && prevLeafWasPara));
      const hb = !indented ? detectHtmlBlockOpen(eff, hbCanInterrupt, isGfm) : null;
      if (hb) {
        closeUnmatched();
        if (!(hb.endRe && hb.endRe.test(eff))) htmlBlock = { ...hb };
        leafState = 'none';
        isFenced[i] = true;
        matchedLeaf = true;
        break;
      }

      if (!indented && inParaAtMatched && /^ {0,3}(?:=+|-+)[ \t]*$/.test(eff)) {
        const rem = flushPara();
        if (!/^[ \t\n]*$/.test(rem)) {
          closeUnmatched();
          leafState = 'none';
          matchedLeaf = true;
          metaArr[i] = {
            inTable: false, isHeading: false, isLeafBreak: true, openedList: false,
            contentStartIdx: afterWsIdx, rawContentStartIdx: afterWsIdx,
            isBlankInner: false, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
          };
          break;
        }
        prevLeafWasPara = false;
        inParaAtMatched = false;
      }

      if (!indented && THEMATIC_BREAK_RE.test(eff)) {
        closeUnmatched();
        leafState = 'none';
        matchedLeaf = true;
        metaArr[i] = {
          inTable: false, isHeading: false, isLeafBreak: true, openedList: false,
          contentStartIdx: afterWsIdx, rawContentStartIdx: afterWsIdx,
          isBlankInner: false, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        break;
      }

      const lm = parseListMarkerAtCur(rawLine, cur, inParaAtMatched ? 'para' : 'none');
      if (lm) {
        closeUnmatched();
        openContainers.push({ type: 'list', indent: lm.itemIndent, pendingEmpty: lm.isEmpty });
        matchedDepth = openContainers.length;
        openedAnyContainer = true;
        openedList = true;
        justOpenedBq = false;
        cur = lm.afterCur;
        stepCursors.push({ ...cur });
        if (lm.isEmpty) {
          leafState = 'none';
          matchedLeaf = true;
          metaArr[i] = {
            inTable: false, isHeading: false, isLeafBreak: true, openedList: true,
            contentStartIdx: rawLine.length, rawContentStartIdx: rawLine.length,
            isBlankInner: true, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
          };
          break;
        }
        continue;
      }

      if (indented && !(inParaAtMatched || (!allClosed && prevLeafWasPara))) {
        closeUnmatched();
        inIndentedCode = true;
        leafState = 'none';
        isFenced[i] = true;
        matchedLeaf = true;
        break;
      }

      break;
    }

    if (matchedLeaf) continue;

    const eff = expandTabsFrom(rawLine, cur);
    const { wsCols, afterWsIdx } = peekWsCols(rawLine, cur);
    const cmMarkAsTableCell = Boolean(!isGfm && gfmTableSet?.has(i));

    const paraTextForRefDef = isGfm ? eff : rawLine.slice(afterWsIdx);

    if (!allClosed && prevLeafWasPara) {
      // Lazy paragraph continuation (CommonMark §5.3): openContainers stay open!
      curParaLines.push({ lineIdx: i, text: paraTextForRefDef });
      prevLineTextArr[i] = true;
      metaArr[i] = {
        inTable: cmMarkAsTableCell, isHeading: false, isLeafBreak: false, openedList: false,
        contentStartIdx: afterWsIdx, rawContentStartIdx: afterWsIdx,
        isBlankInner: false, breakPara: false, inRefDef: false, cmMergeCellWithPara: cmMarkAsTableCell,
      };
      continue;
    }

    if (!allClosed) closeUnmatched();

    if (isGfm && !prevLeafWasPara && wsCols < 4 && i + 1 < lines.length) {
      const nextEff = peekNextTableDelimEff(lines[i + 1], openContainers);
      if (nextEff !== null && isGfmTablePair(eff, nextEff)) {
        flushPara();
        prevLineTextArr[i] = false;
        prevLineTextArr[i + 1] = true;
        tableLineSet.add(i);
        tableLineSet.add(i + 1);
        metaArr[i] = {
          inTable: true, isHeading: false, isLeafBreak: false, openedList: false,
          contentStartIdx: -1, rawContentStartIdx: afterWsIdx,
          isBlankInner: false, breakPara: true, inRefDef: false, cmMergeCellWithPara: false,
        };
        metaArr[i + 1] = {
          inTable: true, isHeading: false, isLeafBreak: false, openedList: false,
          contentStartIdx: -1, rawContentStartIdx: 0,
          isBlankInner: false, breakPara: false, inRefDef: false, cmMergeCellWithPara: false,
        };
        leafState = 'table';
        i += 1;
        continue;
      }
    }

    const continuingPara = prevLeafWasPara;
    leafState = 'para';
    curParaLines.push({ lineIdx: i, text: paraTextForRefDef });
    prevLineTextArr[i] = continuingPara;
    metaArr[i] = {
      inTable: cmMarkAsTableCell,
      isHeading: false,
      isLeafBreak: false,
      openedList: cmMarkAsTableCell ? false : openedList,
      contentStartIdx: afterWsIdx,
      rawContentStartIdx: afterWsIdx,
      isBlankInner: false,
      breakPara: !continuingPara && (openedAnyContainer || closedUnmatched),
      inRefDef: false,
      cmMergeCellWithPara: cmMarkAsTableCell,
    };
  }

  flushPara();

  // Group non-fenced lines into inline containers first to resolve container-wide opaque spans
  const opaqueIntervalsByLine = lines.map(() => []);
  const frozenSetsByLine = lines.map(() => new Set());
  const linkLabelSetsByLine = lines.map(() => new Set());
  const matchedBracketsByLine = lines.map(() => new Set());
  const prelimGroups = new Map();
  let prelimKey = null;
  metaArr.forEach((m, n) => {
    if (isFenced[n] || !m || m.isBlankInner || m.inRefDef) { prelimKey = null; return; }
    const { kind } = lineKind(lines[n], m);
    let key;
    if (kind === 'item') {
      prelimKey = `para${n}`;
      key = prelimKey;
    } else if (kind === 'para' || kind === 'cell') {
      if (m.breakPara || !prelimKey || (!m.cmMergeCellWithPara && !prelimKey.startsWith(kind))) {
        prelimKey = `${m.cmMergeCellWithPara ? 'para' : kind}${n}`;
      }
      key = prelimKey;
    } else {
      prelimKey = null;
      key = `l${n}`;
    }
    if (!prelimGroups.has(key)) prelimGroups.set(key, []);
    prelimGroups.get(key).push({ m, kind, n });
  });

  for (const entries of prelimGroups.values()) {
    if (isGfm && entries[0].kind === 'cell' && !entries[0].m.cmMergeCellWithPara) {
      for (const { m, n } of entries) {
        const startIdx = Math.max(0, m.rawContentStartIdx ?? 0);
        for (const cellRange of findGfmCellSliceRanges(lines[n], startIdx)) {
          scanInlineSliceOpaques([{ lineIdx: n, startIdx: cellRange.startIdx, endIdx: cellRange.endIdx, line: lines[n] }], opaqueIntervalsByLine, frozenSetsByLine, linkLabelSetsByLine, matchedBracketsByLine, mode, labels, fnLabels);
        }
      }
    } else {
      const slices = entries.map(({ m, n }) => {
        const startIdx = Math.max(0, m.rawContentStartIdx ?? 0);
        let endIdx = lines[n].length;
        if (m.isHeading) {
          const rest = lines[n].slice(startIdx);
          const mAll = /^#+[ \t]*$/.exec(rest);
          if (mAll) endIdx = startIdx;
          else {
            const mTrail = /[ \t]+#+[ \t]*$/.exec(rest);
            if (mTrail) endIdx = startIdx + mTrail.index;
          }
        }
        return { lineIdx: n, startIdx, endIdx, line: lines[n] };
      });
      scanInlineSliceOpaques(slices, opaqueIntervalsByLine, frozenSetsByLine, linkLabelSetsByLine, matchedBracketsByLine, mode, labels, fnLabels);
    }
  }

  const parsed = lines.map((line, n) => (isFenced[n] || !metaArr[n]
    ? null
    : parseLine(line, metaArr[n], normalizeOpaqueSpans(opaqueIntervalsByLine[n]), frozenSetsByLine[n], linkLabelSetsByLine[n], matchedBracketsByLine[n], stepCursorsByLine[n])));
  const container = containers(parsed);
  return { parsed, prevLineTextArr, container, labels, tableLineSet };
}

function relaxableOffsetsOf(model, n, labelsOverride = null, forcedKeptOffsets = null) {
  const p = model.parsed[n];
  const kept = computeKeptTokens(p, model.prevLineTextArr[n], model.container, labelsOverride ?? model.labels, forcedKeptOffsets);
  const relaxable = new Set();
  for (let t = 0; t < p.tokens.length; t += 1) {
    if (!kept.has(t)) relaxable.add(p.tokOffsets[t]);
  }
  return relaxable;
}

// Contract guard. relaxEscapes is sound only over the Markdown subset that
// markdown.mjs / pages-md.mjs emit: authored text is escaped by literalText()/prose()
// (raw "<", "`", "[" never reach the output), validated input carries no C0/C1
// controls, tabs survive only mid-line in multiline prose, and code appears only as
// single-line code spans or column-0 backtick fences closed by the identical fence.
// Two full readers (commonmark.js 0.31.2 and pandoc -f gfm) disagree in many corners
// outside that subset (tab stops, Unicode whitespace classes, raw HTML, footnotes);
// reproducing both in this module is out of scope (Round 46 post-mortem). So any
// document containing a construct outside the subset is returned byte for byte: the
// strict serialization is always correct, relaxation is only cosmetic.
//
// The check is an allow-list over the text outside code: it rejects what the
// generator cannot produce rather than enumerating known divergences.
const FENCE_OPEN_RE = /^(`{3,})[a-z0-9+-]*$/;
// Tabs, C0/C1 controls (CR included), and every non-ASCII Unicode whitespace or
// line/paragraph separator.
// eslint-disable-next-line no-control-regex
const ESCAPABLE_RE = /[!-\/:-@\[-`{-~]/;
const OUT_OF_CONTRACT_CHAR_RE = /[\t\x00-\x09\x0b-\x1f\x7f-\x9f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

function lineWithinContract(line) {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    // A backslash escapes only ASCII punctuation; before anything else it is a literal
    // backslash and the next character is checked like any other (e.g. "\\" + CR).
    if (ch === '\\' && ESCAPABLE_RE.test(line[i + 1] ?? '')) { i += 1; continue; }
    if (ch === '`') {
      let n = 1;
      while (line[i + n] === '`') n += 1;
      // A generated code span closes on the same line with a run of exactly n.
      let j = i + n;
      let closed = -1;
      while (j < line.length) {
        if (line[j] !== '`') { j += 1; continue; }
        let m = 1;
        while (line[j + m] === '`') m += 1;
        if (m === n) { closed = j; break; }
        j += m;
      }
      if (closed < 0) return false;
      i = closed + n - 1;
      continue;
    }
    if (ch === '<') return false;
    // "[^" is generated (authored link text starting with "^": "[^x](url)"), but a
    // pandoc footnote definition "[^label]:" is not: the generator's first unescaped
    // "]" after a link-opening "[" is always followed by "(".
    if (ch === '[' && line[i + 1] === '^') {
      let j = i + 2;
      while (j < line.length && line[j] !== ']') j += line[j] === '\\' ? 2 : 1;
      if (line[j] === ']' && line[j + 1] === ':') return false;
    }
    if (OUT_OF_CONTRACT_CHAR_RE.test(ch)) return false;
  }
  return true;
}

export function withinRelaxContract(md) {
  const lines = md.split('\n');
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      if (line === fence) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) { fence = open[1]; continue; }
    if (!lineWithinContract(line)) return false;
  }
  return fence === null;
}

// onRemove, if given, is called for each removed escape (tests use it to show that
// removals at segment edges are exercised).
export function relaxEscapes(md, { onRemove } = {}) {
  if (!withinRelaxContract(md)) return md;
  const lines = md.split('\n');
  const gfm = buildReaderModel(lines, 'gfm', null);
  const cm = buildReaderModel(lines, 'cm', gfm.tableLineSet);
  const allLabels = new Set([...cm.labels, ...gfm.labels]);

  return lines.map((line, n) => {
    if (!cm.parsed[n] || !gfm.parsed[n]) return line;
    if (!/[\\&]/.test(line)) return line;
    const cmTokens = cm.parsed[n].tokens;
    const cmOffsets = cm.parsed[n].tokOffsets;
    let cmRelaxable = relaxableOffsetsOf(cm, n, allLabels, null);
    if (cmRelaxable.size === 0) return line;
    let gfmRelaxable = relaxableOffsetsOf(gfm, n, allLabels, null);
    if (gfmRelaxable.size === 0) return line;

    // Monotonic fixed-point pass so authored \[...\] / \!\[...\] shortcut-reference checks
    // see the exact joint set of interior escapes kept by (cm ∪ gfm).
    let jointSize = [...cmRelaxable].filter((off) => gfmRelaxable.has(off)).length;
    while (jointSize > 0) {
      const forcedKeptOffsets = new Set();
      for (let t = 0; t < cmTokens.length; t += 1) {
        const k = cmTokens[t];
        const off = cmOffsets[t];
        if ((k.type === 'esc' || (k.type === 'ref' && k.ch)) && !(k.type === 'esc' && k.ch === '!' && cmTokens[t + 1]?.type === 'esc' && cmTokens[t + 1].ch === '[')) {
          if (!cmRelaxable.has(off) || !gfmRelaxable.has(off)) forcedKeptOffsets.add(off);
        }
      }
      const nextCm = relaxableOffsetsOf(cm, n, allLabels, forcedKeptOffsets);
      const nextGfm = relaxableOffsetsOf(gfm, n, allLabels, forcedKeptOffsets);
      const nextJointSize = [...nextCm].filter((off) => nextGfm.has(off)).length;
      cmRelaxable = nextCm;
      gfmRelaxable = nextGfm;
      if (nextJointSize >= jointSize) break;
      jointSize = nextJointSize;
    }
    if (jointSize === 0) return line;

    return cmTokens.map((k, t) => {
      const off = cmOffsets[t];
      if (!cmRelaxable.has(off) || !gfmRelaxable.has(off)) return k.src;
      onRemove?.({ src: k.src, ch: k.ch, left: neighbour(cmTokens[t - 1]), right: neighbour(cmTokens[t + 1]), line: n + 1 });
      return k.ch;
    }).join('');
  }).join('\n');
}
