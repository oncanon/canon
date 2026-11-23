// report/v1 -> deterministic, agent-optimized CommonMark. Authored text stays
// readable while context-specific renderers neutralize Markdown structure and HTML.

import { anchor } from './anchors.mjs';
import { relaxEscapes } from './relax.mjs';

// Block anchors (docs/decisions/phase1-contract.md D10): a heading that introduces
// an addressable block is followed directly by the link reference definition
// "[id]: #id", where id is the same block's id in index.html (shared anchor
// functions). A definition is not rendered and adds no node to the document tree,
// so heading text and structure are unchanged; it names the anchor for agents and
// makes "[id]" an in-document reference.
const ANCHOR_ID = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
export function anchorDefinition(id) {
  if (!ANCHOR_ID.test(id)) throw new Error(`unreachable: unsafe anchor id ${JSON.stringify(id)}`);
  return `[${id}]: #${id}`;
}
const anchorDef = (id) => `\n\n${anchorDefinition(id)}`;

// Every anchor label must be unique under CommonMark label matching (case folded)
// and distinct from every citation label ("[E1]" is a shortcut reference).
function assertAnchors(md, evidenceIndex) {
  const seen = new Map();
  const cites = new Set([...evidenceIndex.values()].map((e) => e.label.toLowerCase()));
  for (const [, id] of md.matchAll(/^\[([^\]\n]+)\]: #\1$/gm)) {
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error(`unreachable: anchor ${JSON.stringify(id)} collides with ${JSON.stringify(seen.get(key))} under case folding`);
    if (cites.has(key)) throw new Error(`unreachable: anchor ${JSON.stringify(id)} collides with a citation label`);
    seen.set(key, id);
  }
  return md;
}

const SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const CONFIDENCE = { proven: 'Proven', recommended: 'Recommended', defect: 'Defect', open: 'Open' };
const VERIFICATION = { code: 'Code check', judgment: 'Judgment', review: 'Human review', 'needs-review': 'Needs review' };
const EARS = { ubiquitous: 'Ubiquitous', event: 'Event-driven', state: 'State-driven', unwanted: 'Unwanted behavior', optional: 'Optional feature' };
const LANGUAGE = { typescript: 'typescript', javascript: 'javascript', json: 'json', shell: 'shell', yaml: 'yaml', text: 'text' };

// CommonMark recognizes HTML comments/declarations/tags and angle-bracket
// autolinks before ordinary inline parsing. Escape the opening angle bracket for
// all authored forms. Render identifier placeholders and entity spellings as code
// spans so their literal spelling stays readable rather than being parsed as HTML
// or decoded character references.
const PLACEHOLDER = /<(?:sha256|content-id|name|id|packet-directory)>/gi;
const ENTITY = /&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g;

// Authored text is made literal by escaping, in this order:
// 1. every backslash, so an authored backslash can never cancel an escape this
//    renderer adds (authored "\\<script>" stays text);
// 2. every "<", case-insensitively covering every raw-HTML start (tags, closing
//    tags, comments, processing instructions, declarations such as "<!doctype",
//    CDATA) and every angle-bracket autolink. Escaping all of them is simpler to
//    prove than matching a subset (QA D-E2: lowercase declarations slipped through);
// 3. every backtick, "~" and "$", so an unmatched authored delimiter can never pair
//    with a code span, citation, GFM strikethrough or GFM math that the renderer
//    generates or that a GFM reader recognizes (QA D-E3: an authored backtick
//    swallowed a generated "[E1]"; pandoc/GitHub read "$...$" as inline math).
// "*", "_", "[" and "]" and line-start block markers are escaped in prose() below.
// 4. bare URLs and emails in authored text are made unrecognizable to GFM readers
//    that scan the raw source for them (pandoc): the ":" of a scheme (a ":"
//    between an ASCII letter or digit and a non-space character), an "@" between
//    non-space characters, and the "." after "www" are written as numeric
//    character references. Such a reader otherwise extends the bare URL across
//    following characters, including another segment's escape backslash, and
//    re-enabled the next "<" as raw HTML (authored "https://x.example<script>").
//    The references decode to the same literal text in every reader; ordinary
//    prose such as "Note: x" is unchanged. Readers that autolink after unescaping
//    (cmark-gfm) may still link a bare URL: the accepted, safe GFM residual.
function literalText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/[<`~$]/g, '\\$&')
    .replace(/:(?=(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*):)/g, '&#58;')
    .replace(/(?<=[A-Za-z0-9]):(?=\S)/g, '&#58;')
    .replace(/(?<=\S)@(?=\S)/g, '&#64;')
    // "www." after anything but a letter or digit (GFM also starts extended www
    // autolinks after "_", "*", "~" and "(", which a \b boundary misses for "_").
    .replace(/(?<![A-Za-z0-9])(www)\./gi, '$1&#46;');
}

function authoredText(value) {
  const source = String(value);
  let output = '';
  let cursor = 0;
  // A run of adjacent placeholder/entity spellings becomes one code span: two
  // separate spans side by side would form a double-backtick run and merge.
  const literal = new RegExp(`(?:${PLACEHOLDER.source}|${ENTITY.source})+`, 'gi');
  for (const match of source.matchAll(literal)) {
    output += literalText(source.slice(cursor, match.index)) + inlineCode(match[0]);
    cursor = match.index + match[0].length;
  }
  return output + literalText(source.slice(cursor));
}

// Inline delimiters are escaped first, then line-start block markers, so no
// character is escaped twice (a doubled escape reads as a literal backslash
// followed by a live delimiter: "* item" once became "\\\\* item").
function prose(value) {
  return authoredText(value)
    .replace(/([*_[\]])/g, '\\$1')
    .replace(/(^|\n)( {0,3})(?=(?:#{1,6}|>|[-+](?=\s)|[-+](?=\n|$)|(?:```|~~~))\s?)/g, '$1$2\\')
    // Ordered-list markers: escape the delimiter, not the digits ("2019\. was"); a
    // backslash before a digit is not an escape and would stay visible (QA D-F3).
    .replace(/(^|\n)( {0,3})(\d{1,9})([.)])(?=\s|$)/g, '$1$2$3\\$4')
    .replace(/(^|\n)( {0,3})(?=(?:=+|--+)[ \t]*(?=\n|$))/g, '$1$2\\')
    .replace(/\n([ \t])/g, (m, ws) => `\n&#${ws.codePointAt(0)};`);
}

// Authored text that begins a line, or directly follows a list marker, must not
// begin with whitespace: 4+ spaces or a tab would make it indented code. The first
// whitespace character becomes a character reference, so the line starts with a
// non-space character yet decodes to the same text. Applied only where authored
// text actually starts a line (not to every inline segment).
function atLineStart(rendered) {
  return rendered.replace(/^[ \t]/, (ws) => `&#${ws.codePointAt(0)};`);
}

// Generated emphasis around authored text. CommonMark cannot open or close a
// delimiter run next to whitespace, so authored edge whitespace would leave literal
// asterisks and drop the generated emphasis. Edge whitespace moves outside the
// delimiters; whitespace-only content cannot be emphasized and is emitted as is.
// Used where authored text directly follows a list marker, so the first piece gets
// the line-start whitespace rule (4+ spaces there would start indented code).
function emphasize(marker, rendered) {
  const pieces = emphasisPieces(marker, rendered);
  pieces[0] = { ...pieces[0], md: atLineStart(pieces[0].md) };
  return joinPieces(pieces);
}

function emphasisPieces(marker, rendered, kind = 'em') {
  const [, lead, core, trail] = rendered.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!core) return [{ kind: 'text', md: rendered }];
  return [
    ...(lead ? [{ kind: 'text', md: lead }] : []),
    { kind, md: `${marker}${core}${marker}`, core },
    ...(trail ? [{ kind: 'text', md: trail }] : []),
  ];
}

// ---- segment boundaries (QA D-F1; docs/decisions/phase1-contract.md "report.md
// serializer") -------------------------------------------------------------------
// Inline output is built from typed pieces. Joining two pieces must never let the
// end of one and the start of the next form syntax neither contains on its own.
// Only the combinations that change structure are neutralized, so ordinary
// punctuation stays unescaped:
//   - "!" + "[" would make an image: the "!" is escaped;
//   - a generated "]" (citation) + "(" / ":" / "[" would make a link, reference
//     definition or longer label: that first character is escaped;
//   - "&" + "#" / letter could form a character reference: the "&" is escaped;
//   - "`" + "`" would merge code spans: the separator SEP (below) goes between;
//   - emphasis delimiters that CommonMark cannot open or close at the boundary
//     (alphanumeric text touching emphasis whose content starts or ends with
//     punctuation, or two emphasis runs meeting) get the separator SEP, a zero-width
//     space written as a character reference: its source characters are
//     punctuation, so the delimiters flank correctly, and it renders invisibly.
const SEP = '&#8203;';
const INNER_PUNCT = /^[\p{P}\p{S}\p{C}\p{Zl}\p{Zp}]$/u;
const SAFE_OUTER = /^(?:[ \t\n\x0b\x0c\x0d\p{Zs}]|(?=[\u0000-\uFFFF])[\p{P}\p{S}])$/u;

function firstCp(str) {
  if (!str) return '';
  return String.fromCodePoint(str.codePointAt(0));
}

function lastCp(str) {
  if (!str) return '';
  const low = str.charCodeAt(str.length - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && str.length >= 2) {
    const high = str.charCodeAt(str.length - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return str.slice(-2);
  }
  return str.charAt(str.length - 1);
}

function unescapedAtEnd(md, ch) {
  if (!md.endsWith(ch)) return false;
  let slashes = 0;
  for (let i = md.length - 2; i >= 0 && md[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 0;
}

function escapeTrailingPartialEntity(out, nextMd) {
  const m = /(?:^|[^\\])(?:\\\\)*(&(?:[A-Za-z][A-Za-z0-9]{0,31}|#[xX][0-9A-Fa-f]{0,6}|#[0-9]{1,7}|#))$/.exec(out);
  if (!m) return out;
  const tail = m[1];
  let continues = false;
  if (tail === '&#') continues = /^[xX0-9]/.test(nextMd);
  else if (/^&#[xX]$/.test(tail)) continues = /^[0-9A-Fa-f]/.test(nextMd);
  else if (/^&#[xX][0-9A-Fa-f]{1,6}$/.test(tail)) continues = /^[0-9A-Fa-f;]/.test(nextMd);
  else if (/^&#[0-9]{1,7}$/.test(tail)) continues = /^[0-9;]/.test(nextMd);
  else continues = /^[A-Za-z0-9;]/.test(nextMd);
  if (!continues) return out;
  const ampIdx = out.length - tail.length;
  return `${out.slice(0, ampIdx)}\\&${out.slice(ampIdx + 1)}`;
}

function joinPieces(pieces) {
  let out = '';
  let prev = null;
  for (const raw of pieces) {
    if (raw.kind === 'text' && raw.md === '') continue;
    const piece = { ...raw };
    if (prev) {
      if (out.endsWith('\n') && piece.kind === 'text' && /^[ \t]/.test(piece.md)) piece.md = atLineStart(piece.md);
      if (piece.md.startsWith('[') && unescapedAtEnd(out, '!')) out = `${out.slice(0, -1)}\\!`;
      if (piece.kind === 'text' && /^[(:[]/.test(piece.md) && unescapedAtEnd(out, ']')) piece.md = `\\${piece.md}`;
      if (/^[#A-Za-z]/.test(piece.md) && unescapedAtEnd(out, '&')) out = `${out.slice(0, -1)}\\&`;
      out = escapeTrailingPartialEntity(out, piece.md);
      if (/^\S/.test(piece.md) && /[A-Za-z0-9]:$/.test(out) && unescapedAtEnd(out, ':')) out = `${out.slice(0, -1)}&#58;`;
      if (piece.kind === 'text' && piece.md.startsWith(':') && /[A-Za-z0-9]$/.test(out)) piece.md = `&#58;${piece.md.slice(1)}`;
      if (piece.kind === 'text') {
        const emojiLeft = /:(?:[A-Za-z0-9_+-]|\\[_+-])*$/.exec(out);
        const emojiRight = /^((?:[A-Za-z0-9_+-]|\\[_+-])*):/.exec(piece.md);
        if (emojiLeft && emojiRight && unescapedAtEnd(out.slice(0, emojiLeft.index + 1), ':')) {
          const candidate = (emojiLeft[0].slice(1) + emojiRight[1]).replace(/\\([_+-])/g, '$1');
          if (/^(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*)$/.test(candidate)) {
            piece.md = `${piece.md.slice(0, emojiRight[1].length)}&#58;${piece.md.slice(emojiRight[1].length + 1)}`;
          }
        }
      }
      if (/^\S/.test(piece.md) && /\S@$/.test(out) && unescapedAtEnd(out, '@')) out = `${out.slice(0, -1)}&#64;`;
      if (piece.kind === 'text' && piece.md.startsWith('@') && /\S$/.test(out)) piece.md = `&#64;${piece.md.slice(1)}`;
      if (piece.kind === 'text') {
        if (/(?<![A-Za-z0-9])www$/i.test(out) && piece.md.startsWith('.')) piece.md = `&#46;${piece.md.slice(1)}`;
        else if (/(?<![A-Za-z0-9])ww$/i.test(out) && /^w\./i.test(piece.md)) piece.md = `${piece.md[0]}&#46;${piece.md.slice(2)}`;
        else if (/(?<![A-Za-z0-9])w$/i.test(out) && /^ww\./i.test(piece.md)) piece.md = `${piece.md.slice(0, 2)}&#46;${piece.md.slice(3)}`;
      }
      if (out.endsWith('`') && piece.md.startsWith('`')) out += SEP;
      if ((piece.kind === 'cite' || piece.kind === 'link') && unescapedAtEnd(out, ']')) out += SEP;
      const isEmph = (k) => k === 'em' || k === 'strong';
      const prevLast = lastCp(out);
      const nextFirst = firstCp(piece.md);
      if (isEmph(piece.kind) && (prevLast === '*' || (prevLast !== '' && INNER_PUNCT.test(firstCp(piece.core)) && !SAFE_OUTER.test(prevLast)))) out += SEP;
      else if (isEmph(prev.kind) && (nextFirst === '*' || (nextFirst !== '' && INNER_PUNCT.test(lastCp(prev.core)) && !SAFE_OUTER.test(nextFirst)))) out += SEP;
    }
    out += piece.md;
    prev = piece;
  }
  return out;
}

// A trailing run of "#" after a space is an ATX closing sequence and would be
// dropped from the heading text (QA D-F4); its first "#" is escaped.
function heading(value) {
  return prose(value).replace(/\r?\n/g, ' ').replace(/(^|[ \t])(#+)([ \t]*)$/, '$1\\$2$3');
}

function tableText(value) {
  return prose(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function inlineCode(value) {
  const source = String(value).replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = '`'.repeat(longest + 1);
  const padded = source.startsWith('`') || source.endsWith('`') || (source.startsWith(' ') && source.endsWith(' ') && source.trim())
    ? ` ${source} ` : source;
  return `${delimiter}${padded}${delimiter}`;
}

// Fenced code must be impossible to close from inside. A closing fence is a line of
// at least the opening length of the same character, indented up to three spaces
// (QA D-E1: runs indented 1-3 spaces were not counted). The fence is therefore one
// longer than the longest backtick run anywhere in the content, at any position or
// indentation; the fence character is always a backtick, so tilde runs in the
// content can never close it, and the info string is an allowlisted language.
function fencedCode(source, language) {
  const longest = Math.max(0, ...[...String(source).matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

function linkLabel(value, table = false) {
  const label = prose(value);
  return table ? label.replace(/\|/g, '\\|') : label;
}

function linkUrl(value, table = false) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== value) throw new Error('unreachable: validated https URL');
  const dest = String(value)
    .replace(/&(?=#(?:[xX][0-9A-Fa-f]{1,6}|[0-9]{1,7});|[A-Za-z][A-Za-z0-9]{1,31};)/g, '&amp;')
    .replace(/([()\\])/g, '\\$1');
  return table ? dest.replace(/\|/g, '\\|') : dest;
}

function escapeBlockMarkersAtLineStarts(md) {
  return md
    .replace(/(^|\n)( {0,3})(?=(?:#{1,6}(?=[ \t\n]|$)|>|[-+](?=[ \t\n]|$)))/g, '$1$2\\')
    .replace(/(^|\n)( {0,3})(\d{1,9})([.)])(?=[ \t\n]|$)/g, (_, nl, pad, digits, delim) => `${nl}${pad}${digits}\\${delim}`)
    .replace(/(^|\n)( {0,3})(?=(?:=+|--+)[ \t]*(?=\n|$))/g, '$1$2\\');
}

function inline(value, evidence, { table = false } = {}) {
  const renderText = table ? tableText : prose;
  const segments = typeof value === 'string' ? [value] : value;
  const pieces = segments.flatMap((segment) => inlinePieces(segment, evidence, renderText, table));
  const firstIdx = pieces.findIndex((p) => p.md.length > 0);
  if (firstIdx >= 0) pieces[firstIdx] = { ...pieces[firstIdx], md: atLineStart(pieces[firstIdx].md) };
  const joined = joinPieces(pieces);
  return table ? joined : escapeBlockMarkersAtLineStarts(joined);
}

// In GFM tables an unescaped "|" ends the cell even inside code spans and link
// labels, so table context escapes it there too (QA D-F5); GFM table parsing
// removes that backslash inside code spans.
function inlinePieces(segment, evidence, renderText, table) {
  if (typeof segment === 'string') return [{ kind: 'text', md: renderText(segment) }];
  if (Object.hasOwn(segment, 'text')) return [{ kind: 'text', md: renderText(segment.text) }];
  if (Object.hasOwn(segment, 'code')) return [{ kind: 'code', md: table ? inlineCode(segment.code).replace(/\|/g, '\\|') : inlineCode(segment.code) }];
  if (Object.hasOwn(segment, 'em')) return emphasisPieces('*', renderText(segment.em), 'em');
  if (Object.hasOwn(segment, 'strong')) return emphasisPieces('**', renderText(segment.strong), 'strong');
  if (Object.hasOwn(segment, 'cite')) return [{ kind: 'cite', md: `[${evidence.get(segment.cite).label}]` }];
  if (Object.hasOwn(segment, 'link')) return [{ kind: 'link', md: `[${linkLabel(segment.link.text, table)}](${linkUrl(segment.link.href, table)})` }];
  throw new Error('unreachable: validated inline segment');
}

// Consecutive list-ending blocks with the same marker merge into one list in CommonMark
// and GFM, so each list-producing block whose default marker matches the immediately
// preceding block's trailing list marker switches marker ("-"/"+" for bullets, "."/")"
// for ordered lists); a changed marker always starts a new list.
const LISTISH = new Set(['list', 'metrics']);

function defaultListMarker(block) {
  if (!LISTISH.has(block.type)) return null;
  return block.type === 'list' && block.ordered ? '.' : '-';
}

function trailingListMarker(block, alternate = false) {
  switch (block.type) {
    case 'list': return block.ordered ? (alternate ? ')' : '.') : (alternate ? '+' : '-');
    case 'metrics': return alternate ? '+' : '-';
    case 'decision': return '-';
    case 'diagram': return '.';
    case 'comparison':
      return (!block.evidence && !block.right?.code && block.right?.items?.length) ? '-' : null;
    case 'finding': {
      if (!block.detail?.length) return null;
      let prev = null;
      for (const b of block.detail) {
        const def = defaultListMarker(b);
        const alt = def !== null && prev === def;
        prev = trailingListMarker(b, alt);
      }
      return prev;
    }
    default: return null;
  }
}

function blocksMarkdown(blocks, evidence, depth = 3, initialPrevMarker = null) {
  let prevMarker = initialPrevMarker;
  return blocks.map((block) => {
    const def = defaultListMarker(block);
    const run = def !== null && prevMarker === def ? 1 : 0;
    prevMarker = trailingListMarker(block, run % 2 === 1);
    return blockMarkdown(block, evidence, depth, run % 2 === 1);
  }).join('\n');
}

function blockMarkdown(block, evidence, depth = 3, alternate = false) {
  const bullet = alternate ? '+' : '-';
  switch (block.type) {
    case 'paragraph': return `${inline(block.text, evidence)}\n`;
    case 'list': return `${block.items.map((item, i) => `${block.ordered ? `${i + 1}${alternate ? ')' : '.'}` : bullet} ${inline(item, evidence)}`).join('\n')}\n`;
    case 'finding': {
      const refs = block.evidence.map((id) => `[${evidence.get(id).label}]`).join(', ');
      const verif = block.verification
        ? `  \n**Verification.** ${prose(VERIFICATION[block.verification.band])}${block.verification.detail ? ` — ${prose(block.verification.detail)}` : ''}`
        : '';
      const detail = blocksMarkdown(block.detail ?? [], evidence, depth + 1);
      return `${'#'.repeat(depth)} Finding ${heading(block.id)}: ${heading(block.title)}${anchorDef(anchor.finding(block))}\n\n**Severity.** ${SEVERITY[block.severity]}  \n**Confidence.** ${CONFIDENCE[block.confidence]}${verif}  \n**Claim.** ${inline(block.claim, evidence)}  \n**Evidence.** ${refs}\n${detail ? `\n${detail}` : ''}`;
    }
    case 'decision': {
      const owner = block.owner ? `  \n**Owner.** ${prose(block.owner)}` : '';
      const context = block.context ? `  \n**Context.** ${inline(block.context, evidence)}` : '';
      const alternatives = block.alternatives.map((alt) => `- ${alt.chosen ? emphasize('**', `Chosen — ${prose(alt.label)}`) : atLineStart(prose(alt.label))}: ${inline(alt.summary, evidence)}`).join('\n');
      const consequences = block.consequences?.length
        ? `\n**Consequences.**\n${block.consequences.map((c) => `- ${inline(c, evidence)}`).join('\n')}\n`
        : '';
      return `${'#'.repeat(depth)} Decision ${heading(block.id)}: ${heading(block.question)}${anchorDef(anchor.decision(block))}\n\n**Status.** ${block.status === 'needed' ? 'Decision needed' : 'Decided'}${owner}${context}  \n**Recommendation.** ${inline(block.recommendation, evidence)}\n\n**Alternatives.**\n${alternatives}\n${consequences}`;
    }
    case 'risk': return `${'#'.repeat(depth)} Risk ${heading(block.id)}: ${heading(block.title)}${anchorDef(anchor.risk(block))}\n\n**Likelihood.** ${prose(block.likelihood)}  \n**Impact.** ${prose(block.impact)}  \n**Mitigation.** ${inline(block.mitigation, evidence)}\n`;
    case 'requirement': {
      const refs = block.evidence ? `  \n**Evidence.** ${block.evidence.map((id) => `[${evidence.get(id).label}]`).join(', ')}` : '';
      const verif = `${prose(VERIFICATION[block.verification.band])}${block.verification.detail ? ` — ${prose(block.verification.detail)}` : ''}`;
      const scenarios = block.scenarios?.length
        ? `\n| Scenario | Given | When | Then |\n| --- | --- | --- | --- |\n${block.scenarios.map((sc) => `| ${tableText(sc.name)} | ${tableText(sc.given)} | ${tableText(sc.when)} | ${tableText(sc.then)} |`).join('\n')}\n`
        : '';
      return `${'#'.repeat(depth)} Requirement ${heading(block.id)}: ${heading(block.title)}${anchorDef(anchor.requirement(block))}\n\n**Pattern.** ${prose(EARS[block.pattern])}  \n**Verification.** ${verif}  \n**Specification.** ${inline(block.statement, evidence)}${refs}\n${scenarios}`;
    }
    case 'comparison': {
      const refs = block.evidence ? `\n**Evidence.** ${block.evidence.map((id) => `[${evidence.get(id).label}]`).join(', ')}\n` : '';
      const sideMd = (side) => {
        const items = side.items?.length ? `\n${side.items.map((it) => `- ${inline(it, evidence)}`).join('\n')}\n` : '';
        const code = side.code ? `\n${fencedCode(side.code.source, LANGUAGE[side.code.language])}\n` : '';
        return `${'#'.repeat(depth + 1)} ${heading(side.label)}\n\n${inline(side.summary, evidence)}\n${items}${code}`;
      };
      return `${'#'.repeat(depth)} Comparison: ${heading(block.title)}${anchorDef(anchor.comparison(block))}\n\n${block.caption ? `${inline(block.caption, evidence)}\n\n` : ''}${sideMd(block.left)}\n${sideMd(block.right)}${refs}`;
    }
    case 'code': return `${'#'.repeat(depth)} Code: ${heading(block.title)}${anchorDef(anchor.code(block))}\n\n${block.caption ? `${inline(block.caption, evidence)}\n\n` : ''}${fencedCode(block.source, LANGUAGE[block.language])}\n`;
    case 'diff': return `${'#'.repeat(depth)} Diff: ${heading(block.title)}${anchorDef(anchor.code(block))}\n\n${block.caption ? `${inline(block.caption, evidence)}\n\n` : ''}${fencedCode(block.patch, 'diff')}\n`;
    case 'table': {
      const headings = block.columns.map((column) => tableText(column.label));
      const divider = block.columns.map((column) => column.numeric ? '---:' : '---');
      const rows = block.rows.map((row) => `| ${block.columns.map((column) => inline(row[column.key], evidence, { table: true })).join(' | ')} |`);
      return `${'#'.repeat(depth)} Table: ${heading(block.caption)}${anchorDef(anchor.table(block))}\n\n| ${headings.join(' | ')} |\n| ${divider.join(' | ')} |\n${rows.join('\n')}\n`;
    }
    case 'chart': {
      const refs = block.evidence?.map((id) => `[${evidence.get(id).label}]`).join(', ');
      if (block.kind === 'comparison') {
        const rows = block.series.map((point) => `| ${tableText(point.label)} | ${point.baseline} ${tableText(block.unit)} | ${point.value} ${tableText(block.unit)} |`).join('\n');
        return `${'#'.repeat(depth)} Chart: ${heading(block.title)}${anchorDef(anchor.chart(block))}\n\n${inline(block.caption, evidence)}${refs ? ` Evidence: ${refs}.` : ''}\n\n| Series | ${tableText(block.baselineLabel)} | ${tableText(block.candidateLabel)} |\n| --- | ---: | ---: |\n${rows}\n`;
      }
      if (block.kind === 'quantiles') {
        const budgetNote = Object.hasOwn(block, 'budget') ? ` Budget: ${block.budget} ${prose(block.unit)}.` : '';
        const rows = block.series.map((point) => `| ${tableText(point.label)} | ${point.p50} ${tableText(block.unit)} | ${point.p95} ${tableText(block.unit)} | ${point.p99} ${tableText(block.unit)} |`).join('\n');
        return `${'#'.repeat(depth)} Chart: ${heading(block.title)}${anchorDef(anchor.chart(block))}\n\n${inline(block.caption, evidence)}${budgetNote}${refs ? ` Evidence: ${refs}.` : ''}\n\n| Series | p50 | p95 | p99 |\n| --- | ---: | ---: | ---: |\n${rows}\n`;
      }
      const rows = block.series.map((point) => `| ${tableText(point.label)} | ${point.value} ${tableText(block.unit)} |`).join('\n');
      return `${'#'.repeat(depth)} Chart: ${heading(block.title)}${anchorDef(anchor.chart(block))}\n\n${inline(block.caption, evidence)}${refs ? ` Evidence: ${refs}.` : ''}\n\n| Series | Value |\n| --- | ---: |\n${rows}\n`;
    }
    case 'diagram': {
      const refs = block.evidence?.map((id) => `[${evidence.get(id).label}]`).join(', ');
      const capLine = `${inline(block.caption, evidence)}${refs ? ` Evidence: ${refs}.` : ''}`;
      if (block.kind === 'topology') {
        const labelById = new Map(block.groups.flatMap((g) => g.nodes.map((n) => [n.id, n.label])));
        const groupsMd = block.groups.map((g) => `- ${emphasize('**', `${prose(g.label).trim()}:`)} ${g.nodes.map((n) => `${prose(n.label)}${n.sublabel ? ` (${prose(n.sublabel)})` : ''}`).join(', ')}`).join('\n');
        const edgesMd = block.edges.map((e, i) => `${i + 1}. ${emphasize('**', `${prose(labelById.get(e.from) ?? e.from)} -> ${prose(labelById.get(e.to) ?? e.to)}`)}${e.style === 'gate' ? ' (Gate)' : ''}${e.label ? ` — ${prose(e.label)}` : ''}`).join('\n');
        return `${'#'.repeat(depth)} Diagram: ${heading(block.title)}${anchorDef(anchor.diagram(block))}\n\n${capLine}\n\n${groupsMd}\n\n${edgesMd}\n`;
      }
      if (block.kind === 'sequence') {
        const labelById = new Map(block.actors.map((a) => [a.id, a.label]));
        const msgsMd = block.messages.map((m, i) => `${i + 1}. ${emphasize('**', `${prose(labelById.get(m.from) ?? m.from)} -> ${prose(labelById.get(m.to) ?? m.to)}`)}${m.gate ? ' (Gate)' : ''}: ${inlineCode(m.label)}${m.note ? ` — ${prose(m.note)}` : ''}`).join('\n');
        return `${'#'.repeat(depth)} Diagram: ${heading(block.title)}${anchorDef(anchor.diagram(block))}\n\n${capLine}\n\n${msgsMd}\n`;
      }
      const steps = block.steps.map((step, i) => `${i + 1}. ${emphasize('**', prose(step.label))}${step.gate ? ' (Gate)' : ''} — ${prose(step.detail)}`).join('\n');
      return `${'#'.repeat(depth)} Diagram: ${heading(block.title)}${anchorDef(anchor.diagram(block))}\n\n${capLine}\n\n${steps}\n`;
    }
    case 'metrics': return `${block.items.map((item) => `${bullet} ${emphasize('**', `${prose(item.label).trim()}:`)} ${prose(item.value)}${item.unit ? ` ${prose(item.unit)}` : ''}${item.evidence ? ` (${item.evidence.map((id) => `[${evidence.get(id).label}]`).join(', ')})` : ''}`).join('\n')}\n`;
    default: throw new Error(`unreachable: validated block type ${block.type}`);
  }
}

function sectionMarkdown(section, evidence, number, appendix = false) {
  const prefix = appendix ? `Appendix ${String.fromCharCode(64 + number)}.` : `${number}.`;
  return `## ${prefix} ${heading(section.title)}${anchorDef(anchor.section(section, appendix))}\n\n${section.lede ? `${atLineStart(prose(section.lede))}\n\n` : ''}${blocksMarkdown(section.blocks, evidence)}`;
}

// The strict serialization above, then relaxEscapes over the final document
// (docs/decisions/phase1-contract.md D11).
export function renderReportMarkdown(report, options) {
  return relaxEscapes(assertAnchors(renderStrictMarkdown(report, options), options.evidenceIndex));
}

// Exported for tests that compare the strict and relaxed serializations.
export function renderStrictMarkdown(report, { evidenceIndex, sourceSha256 }) {
  const meta = report.metadata;
  const evidence = report.evidence.map((item) => {
    const entry = evidenceIndex.get(item.id);
    if (item.kind === 'file') return `### ${entry.label}: ${heading(item.title)}${anchorDef(anchor.evidenceItem(item.id))}\n\n- ID: ${inlineCode(item.id)}\n- File: ${inlineCode(entry.href)}\n- Media type: ${inlineCode(item.mediaType)}\n- Bytes: ${entry.bytes}\n- SHA-256: ${inlineCode(entry.sha256)}\n`;
    return `### ${entry.label}: ${heading(item.title)}${anchorDef(anchor.evidenceItem(item.id))}\n\n- ID: ${inlineCode(item.id)}\n- Status: ${prose(item.kind)}\n- Reason: ${prose(item.reason)}\n`;
  }).join('\n');
  const sources = report.provenance.sources.map((source) => `- ${emphasize('**', `${prose(source.label).trim()}:`)} ${prose(source.reference)}${source.revision ? `; revision ${inlineCode(source.revision)}` : ''}${source.sha256 ? `; SHA-256 ${inlineCode(source.sha256)}` : ''}`).join('\n');
  return `# ${heading(report.title)}\n\n${report.subtitle ? `${atLineStart(prose(report.subtitle))}\n\n` : ''}- Report ID: ${inlineCode(report.id)}\n- Status: ${prose(meta.status)}\n- Classification: ${prose(meta.classification)}\n- Review date: ${prose(meta.reviewDate)}\n- Review request: ${prose(meta.reviewRequest)}\n- Authors: ${meta.authors.map(prose).join(', ')}\n\n## Executive summary${anchorDef(anchor.summary())}\n\n**Verdict (${CONFIDENCE[report.summary.verdict.confidence]}).** ${inline(report.summary.verdict.text, evidenceIndex)}\n\n${report.summary.paragraphs.map((paragraph) => inline(paragraph, evidenceIndex)).join('\n\n')}\n\n${report.summary.metrics ? `### Metrics\n\n${blockMarkdown({ type: 'metrics', ...report.summary.metrics }, evidenceIndex)}` : ''}${report.sections.map((section, i) => sectionMarkdown(section, evidenceIndex, i + 1)).join('\n')}\n## Evidence${anchorDef(anchor.evidence())}\n\n${evidence}\n${(report.appendices ?? []).map((section, i) => sectionMarkdown(section, evidenceIndex, i + 1, true)).join('\n')}\n## Provenance and packet verification${anchorDef(anchor.provenance())}\n\n${report.provenance.notes ? `${inline(report.provenance.notes, evidenceIndex)}\n\n` : ''}### Sources\n\n${sources}\n\n### Verification\n\n- This Markdown file is generated from the validated report model, not scraped from HTML.\n- Its bytes are listed in ${inlineCode('manifest.json')} and ${inlineCode('checksums.json')} and therefore contribute to the immutable content ID.\n- Run ${inlineCode('canon verify <packet-directory>')} to recompute every digest and the content ID.\n- Canonical source report SHA-256: ${inlineCode(sourceSha256)}.\n`;
}

export {
  anchorDef, assertAnchors, atLineStart, blocksMarkdown, emphasize, emphasisPieces,
  escapeBlockMarkersAtLineStarts, fencedCode, heading, inline, inlineCode, joinPieces,
  LANGUAGE, linkLabel, linkUrl, prose, tableText,
};
