// doc/v1 -> deterministic CommonMark, the Markdown twin of render-html.mjs's HTML
// fragment (Canon guarantees the two carry the same content). Reuses report/v1's
// character-level escaping primitives (src/render/markdown.mjs) — the same proof that
// authored text can never reopen Markdown or HTML syntax applies unchanged to doc/v1 —
// but writes its own inline()/anchor-definition logic because doc/v1 differs from
// report/v1 in two ways a shared function can't absorb:
//   - `ref` replaces `cite`, and a ref's destination is a same-site path, not a
//     validated https:// URL (report/v1's linkUrl() rejects anything else);
//   - a doc/v1 id may start with a digit (SLUG_PATTERN), which report/v1's
//     anchorDefinition() rejects outright (ANCHOR_ID requires a leading letter).
import {
  atLineStart, emphasisPieces, escapeBlockMarkersAtLineStarts, fencedCode, heading,
  inlineCode, joinPieces, LANGUAGE, linkLabel, prose, tableText,
} from '../render/markdown.mjs';
import { relaxEscapes } from '../render/relax.mjs';
import { SLUG_PATTERN } from './validate.mjs';

// report/v1's anchorDefinition() requires a leading letter; doc/v1 ids may start with
// a digit ("1-write-a-report-v1-brief"), which is a valid CommonMark link label and a
// valid HTML5 id, so this is a deliberately separate check, not a relaxed copy of it.
//
// The destination is this page's own absolute site-relative path plus the fragment
// (e.g. "/guide/install/#step-2"), never a bare "#id": llms-full.txt concatenates every
// page's sealed Markdown into one document, and a bare fragment is only unambiguous
// while a page's Markdown is read on its own — doc/v1 ids are unique only within one
// page (src/doc/validate.mjs's ctx.claimId is per-page), so two pages can define the
// same id, and a bare "#id" definition from the first page would silently shadow the
// second's once joined. Qualifying the destination with pagePath matches refHref's own
// cross-page hrefs (always `${target.path}#${anchor}`), so a page's anchor definitions
// are exactly as valid read alone as they are inside the joined document.
function docAnchorDef(id, pagePath) {
  if (!SLUG_PATTERN.test(id)) throw new Error(`unreachable: unsafe anchor id ${JSON.stringify(id)}`);
  return `\n\n[${id}]: ${pagePath}#${id}`;
}

// A same-site path (e.g. "/guide/quick-start/" or "/schemas/#ref-object"), not an
// external https:// URL: only the characters that would otherwise reopen Markdown link
// syntax are escaped.
function refUrl(value, table = false) {
  const dest = String(value).replace(/([()\\])/g, '\\$1');
  return table ? dest.replace(/\|/g, '\\|') : dest;
}

function docInlinePieces(ctx, segment, table) {
  const renderText = table ? tableText : prose;
  if (typeof segment === 'string') return [{ kind: 'text', md: renderText(segment) }];
  if (Object.hasOwn(segment, 'text')) return [{ kind: 'text', md: renderText(segment.text) }];
  if (Object.hasOwn(segment, 'code')) return [{ kind: 'code', md: table ? inlineCode(segment.code).replace(/\|/g, '\\|') : inlineCode(segment.code) }];
  if (Object.hasOwn(segment, 'em')) return emphasisPieces('*', renderText(segment.em), 'em');
  if (Object.hasOwn(segment, 'strong')) return emphasisPieces('**', renderText(segment.strong), 'strong');
  if (Object.hasOwn(segment, 'link')) return [{ kind: 'link', md: `[${linkLabel(segment.link.text, table)}](${refUrl(segment.link.href, table)})` }];
  if (Object.hasOwn(segment, 'ref')) return [{ kind: 'link', md: `[${linkLabel(segment.ref.text, table)}](${refUrl(ctx.refHref(segment.ref), table)})` }];
  throw new Error('unreachable: validated inline segment');
}

export function docInline(ctx, value, { table = false } = {}) {
  const segments = typeof value === 'string' ? [value] : value;
  const pieces = segments.flatMap((segment) => docInlinePieces(ctx, segment, table));
  const firstIdx = pieces.findIndex((p) => p.md.length > 0);
  if (firstIdx >= 0) pieces[firstIdx] = { ...pieces[firstIdx], md: atLineStart(pieces[firstIdx].md) };
  const joined = joinPieces(pieces);
  return table ? joined : escapeBlockMarkersAtLineStarts(joined);
}

function docRefLink(ctx, refSpec) {
  return `[${prose(refSpec.text)}](${refUrl(ctx.refHref(refSpec))})`;
}

function docBlockMarkdown(ctx, block) {
  switch (block.type) {
    case 'paragraph': return `${docInline(ctx, block.text)}\n`;
    case 'list': return `${block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${docInline(ctx, item)}`).join('\n')}\n`;
    case 'code': {
      const captionMd = block.caption ? `${docInline(ctx, block.caption)}\n\n` : '';
      return `${captionMd}${fencedCode(block.source, LANGUAGE[block.language])}\n`;
    }
    case 'table': {
      const headings = block.columns.map((c) => tableText(c.label));
      const divider = block.columns.map((c) => (c.numeric ? '---:' : '---'));
      const rows = block.rows.map((row) => `| ${block.columns.map((c) => docInline(ctx, row[c.key], { table: true })).join(' | ')} |`);
      return `| ${headings.join(' | ')} |\n| ${divider.join(' | ')} |\n${rows.join('\n')}\n`;
    }
    default: throw new Error(`unreachable: validated block type ${block.type}`);
  }
}

function docSectionMarkdown(ctx, section) {
  return `## ${heading(section.title)}${docAnchorDef(section.id, ctx.pagePath)}\n\n${section.blocks.map((b) => docBlockMarkdown(ctx, b)).join('\n')}`;
}

function docProvenanceMarkdown(ctx, provenance) {
  const sources = provenance.sources.map((s) => {
    const revision = s.revision ? `; revision ${inlineCode(s.revision)}` : '';
    const sha256 = s.sha256 ? `; SHA-256 ${inlineCode(s.sha256)}` : '';
    return `- **${prose(s.label).trim()}:** ${prose(s.reference)}${revision}${sha256}`;
  }).join('\n');
  const notes = provenance.notes ? `${docInline(ctx, provenance.notes)}\n\n` : '';
  return `## Sources${docAnchorDef('provenance', ctx.pagePath)}\n\n${notes}${sources}\n`;
}

// Produces the Markdown twin of render-html.mjs's HTML fragment for one doc/v1 page.
// doc must already have passed validateDocPage; this function does not re-validate.
// refHref(ref) resolves a {page, anchor?, text} ref the same way the HTML renderer's
// does — pass the same callback to both so the two artifacts agree. pagePath is this
// page's own absolute site-relative path (e.g. "/guide/install/"), the same path
// refHref uses for a ref targeting this page — needed so this page's own anchor
// definitions use that same absolute scheme (see docAnchorDef).
export function renderDocMarkdown(doc, { refHref, pagePath }) {
  const ctx = { refHref, pagePath };
  const sections = doc.sections.map((s) => docSectionMarkdown(ctx, s)).join('\n');
  const nav = doc.nav?.next ? `Next: ${docRefLink(ctx, doc.nav.next.ref)}.\n\n` : '';
  const seeAlso = doc.seeAlso
    ? `## See also\n\n${doc.seeAlso.map((entry) => `- ${docRefLink(ctx, entry.ref)}`).join('\n')}\n\n`
    : '';
  const provenance = doc.provenance ? docProvenanceMarkdown(ctx, doc.provenance) : '';
  const strict = `# ${heading(doc.title)}\n\n${atLineStart(prose(doc.description))}\n\n${sections}\n${nav}${seeAlso}${provenance}`;
  return relaxEscapes(strict);
}
