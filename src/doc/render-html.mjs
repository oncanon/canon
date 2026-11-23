// doc/v1 -> a sealed HTML fragment. Astro (Canon Web) wraps this fragment byte-for-byte;
// every heading keeps the page's own section id (no "sec-" prefix, unlike report/v1 —
// Pagefind and the live oncanon.com pages already use plain ids and must not move).
//
// A doc page has no evidence and no citations, so this module's inline() recognizes
// `ref` instead of `cite` and never highlights RFC2119 keywords (report/v1's
// escapeProseHtml is audit-report styling, not part of doc/v1's design). Resolving a
// ref's page (and optional anchor) to a concrete href is the caller's job, supplied as
// the refHref callback — this module has no notion of "the other pages" (src/doc/docset.mjs
// does).
import { escapeAttr, escapeHtml } from '../render/escape.mjs';
import { highlightLines } from '../render/highlight.mjs';

const LANGUAGE_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', shell: 'Shell', yaml: 'YAML', text: 'Text' };

export class DocRenderContext {
  constructor({ refHref }) {
    if (typeof refHref !== 'function') throw new Error('DocRenderContext requires a refHref(ref) callback');
    this.refHref = refHref;
  }

  ref(refSpec) {
    const href = this.refHref(refSpec);
    return `<a class="ref" href="${escapeAttr(href)}">${escapeHtml(refSpec.text)}</a>`;
  }
}

export function inline(ctx, value) {
  if (typeof value === 'string') return escapeHtml(value);
  return value.map((seg) => {
    if (typeof seg === 'string') return escapeHtml(seg);
    if (Object.hasOwn(seg, 'text')) return escapeHtml(seg.text);
    if (Object.hasOwn(seg, 'code')) return `<code>${escapeHtml(seg.code)}</code>`;
    if (Object.hasOwn(seg, 'em')) return `<em>${escapeHtml(seg.em)}</em>`;
    if (Object.hasOwn(seg, 'strong')) return `<strong>${escapeHtml(seg.strong)}</strong>`;
    if (Object.hasOwn(seg, 'link')) {
      return `<a class="ext" href="${escapeAttr(seg.link.href)}" rel="noopener noreferrer external" referrerpolicy="no-referrer">${escapeHtml(seg.link.text)}</a>`;
    }
    if (Object.hasOwn(seg, 'ref')) return ctx.ref(seg.ref);
    throw new Error('unreachable: validated inline segment');
  }).join('');
}

function renderCode(ctx, block) {
  const lines = highlightLines(block.source, block.language);
  const body = lines.map((html) => `<span class="ln">${html}</span>`).join('\n');
  const captionHtml = block.caption ? `<figcaption class="code__caption">${inline(ctx, block.caption)}</figcaption>` : '';
  return `<figure class="code">
<div class="code__scroll" tabindex="0" role="region" aria-label="${escapeAttr(LANGUAGE_LABEL[block.language])} code">
<pre><code>${body}</code></pre>
</div>
${captionHtml}</figure>`;
}

function renderTable(ctx, block) {
  const head = block.columns.map((c) => `<th scope="col"${c.numeric ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('');
  const rows = block.rows.map((row) => `<tr>${block.columns.map((c, i) => {
    const cell = inline(ctx, row[c.key]);
    const cls = c.numeric ? ' class="num"' : '';
    return i === 0 ? `<th scope="row"${cls}>${cell}</th>` : `<td${cls}>${cell}</td>`;
  }).join('')}</tr>`).join('\n');
  return `<div class="table" id="${escapeAttr(block.id)}"><div class="table__scroll" tabindex="0" role="region" aria-label="${escapeAttr(block.caption)}"><table>
<caption>${escapeHtml(block.caption)}</caption>
<thead><tr>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div></div>`;
}

export function renderBlock(ctx, block) {
  switch (block.type) {
    case 'paragraph': return `<p>${inline(ctx, block.text)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((item) => `<li>${inline(ctx, item)}</li>`).join('')}</${tag}>`;
    }
    case 'code': return renderCode(ctx, block);
    case 'table': return renderTable(ctx, block);
    default: throw new Error(`unreachable: validated block type ${block.type}`);
  }
}

function renderSection(ctx, section) {
  return `<section>
<h2 id="${escapeAttr(section.id)}">${escapeHtml(section.title)}</h2>
${section.blocks.map((b) => renderBlock(ctx, b)).join('\n')}
</section>`;
}

function renderProvenance(ctx, provenance) {
  const sources = provenance.sources.map((s) => `<tr><th scope="row">${escapeHtml(s.label)}</th><td>${escapeHtml(s.reference)}</td><td>${s.revision ? `<code>${escapeHtml(s.revision)}</code>` : '—'}</td><td>${s.sha256 ? `<code>${escapeHtml(s.sha256)}</code>` : '—'}</td></tr>`).join('\n');
  const notes = provenance.notes ? `<p>${inline(ctx, provenance.notes)}</p>` : '';
  return `<section class="doc-provenance" aria-labelledby="provenance-h">
<h2 id="provenance-h">Sources</h2>
${notes}<div class="table"><table>
<caption>Sources this page was derived from</caption>
<thead><tr><th scope="col">Source</th><th scope="col">Reference</th><th scope="col">Revision</th><th scope="col">SHA-256</th></tr></thead>
<tbody>${sources}</tbody>
</table></div>
</section>`;
}

// Produces the sealed HTML fragment for one doc/v1 page. doc must already have passed
// validateDocPage; this function does not re-validate. refHref(ref) resolves a
// {page, anchor?, text} ref to a concrete href — src/doc/docset.mjs supplies it once a
// doc set's pages and their paths are known.
export function renderDocHtml(doc, { refHref }) {
  const ctx = new DocRenderContext({ refHref });
  const header = `<header class="doc-header">
${doc.eyebrow ? `<p class="doc-eyebrow">${escapeHtml(doc.eyebrow)}</p>` : ''}
<h1>${escapeHtml(doc.title)}</h1>
<p class="doc-description">${escapeHtml(doc.description)}</p>
</header>`;
  const sections = doc.sections.map((s) => renderSection(ctx, s)).join('\n');
  const nav = doc.nav?.next ? `<p class="doc-next">Next: ${ctx.ref(doc.nav.next.ref)}.</p>` : '';
  const seeAlso = doc.seeAlso
    ? `<nav class="doc-see-also" aria-label="See also">
<h2>See also</h2>
<ul>${doc.seeAlso.map((entry) => `<li>${ctx.ref(entry.ref)}</li>`).join('')}</ul>
</nav>`
    : '';
  const provenance = doc.provenance ? renderProvenance(ctx, doc.provenance) : '';
  return `${header}
${sections}
${nav}${seeAlso}${provenance}`;
}
