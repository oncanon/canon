// report/v1 -> index.html. Presentation belongs to this module and the Canon v2
// stylesheet; the report supplies meaning only. All authored strings pass through
// escapeHtml/escapeAttr; no authored value is ever emitted raw.
import { CSP_META, TOOL } from '../policy.mjs';
import { anchor as ANCHOR } from './anchors.mjs';
import { escapeAttr, escapeHtml } from './escape.mjs';
import { renderEvidencePreview } from './evidence-preview.mjs';
import { classifyDiffLine, highlightLines } from './highlight.mjs';
import { renderBarChartBody, renderComparisonChartBody, renderQuantilesChartBody } from './svg-chart.mjs';
import { renderFlowDiagram, renderSequenceDiagram, renderTopologyDiagram } from './svg-diagram.mjs';

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const CONFIDENCE_LABEL = { proven: 'Proven', recommended: 'Recommended', defect: 'Defect', open: 'Open' };
const CONFIDENCE_MEANING = {
  proven: 'Measured or directly observed',
  recommended: 'Proposed adaptation, not yet proven',
  defect: 'Known problem; do not copy',
  open: 'Evidence or decision still required',
};
const VERIFICATION_LABEL = {
  code: 'Code check',
  judgment: 'Judgment',
  review: 'Human review',
  'needs-review': 'Needs review',
};
const EARS_LABEL = {
  ubiquitous: 'Ubiquitous',
  event: 'Event-driven',
  state: 'State-driven',
  unwanted: 'Unwanted behavior',
  optional: 'Optional feature',
};
const LANGUAGE_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', shell: 'Shell', yaml: 'YAML', text: 'Text' };
const STATUS_LABEL = { draft: 'Draft', proposed: 'Proposed', final: 'Final' };

const RFC2119_RE = /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|REQUIRED|SHALL|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/g;

function escapeProseHtml(text) {
  return escapeHtml(text).replace(RFC2119_RE, '<span class="rfc2119">$1</span>');
}

export class RenderContext {
  constructor(report, evidenceIndex, { evidenceHref } = {}) {
    this.report = report;
    this.evidence = evidenceIndex; // id -> { label, title, kind, href?, ... }
    this.citedBy = new Map(); // evidence id -> [{ anchor, label }]
    this.evidenceHref = evidenceHref ?? ((id) => `#${ANCHOR.evidenceItem(id)}`);
  }

  cite(evidenceId, from) {
    if (!from) return;
    const list = this.citedBy.get(evidenceId) ?? [];
    if (!list.some((c) => c.anchor === from.anchor)) list.push(from);
    this.citedBy.set(evidenceId, list);
  }
}

function citationLink(ctx, id) {
  const ev = ctx.evidence.get(id);
  return `<a class="cite" href="${escapeAttr(ctx.evidenceHref(id))}" title="${escapeAttr(ev.title)}">[${escapeHtml(ev.label)}]</a>`;
}

export function inline(ctx, value, from) {
  if (typeof value === 'string') return escapeProseHtml(value);
  return value.map((seg) => {
    if (typeof seg === 'string') return escapeProseHtml(seg);
    if (Object.hasOwn(seg, 'text')) return escapeProseHtml(seg.text);
    if (Object.hasOwn(seg, 'code')) return `<code>${escapeHtml(seg.code)}</code>`;
    if (Object.hasOwn(seg, 'em')) return `<em>${escapeProseHtml(seg.em)}</em>`;
    if (Object.hasOwn(seg, 'strong')) return `<strong>${escapeProseHtml(seg.strong)}</strong>`;
    if (Object.hasOwn(seg, 'cite')) {
      ctx.cite(seg.cite, from);
      return citationLink(ctx, seg.cite);
    }
    if (Object.hasOwn(seg, 'link')) {
      return `<a class="ext" href="${escapeAttr(seg.link.href)}" rel="noopener noreferrer external" referrerpolicy="no-referrer">${escapeHtml(seg.link.text)}</a>`;
    }
    throw new Error('unreachable: validated inline segment');
  }).join('');
}

function renderVerificationChip(verification) {
  if (!verification) return '';
  const label = VERIFICATION_LABEL[verification.band];
  return `<span class="vband vband--${escapeAttr(verification.band)}">${escapeHtml(label)}${verification.detail ? ` · ${escapeHtml(verification.detail)}` : ''}</span>`;
}

function renderCodeFigure({ id, title, language, caption, lines, lineClasses, kind }, ctx, from) {
  const figId = ANCHOR.code({ id });
  const titleId = `${figId}-title`;
  const body = lines.map((html, i) => {
    const n = i + 1;
    const cls = ['ln', ...(lineClasses[i] ?? [])].join(' ');
    return `<span class="${cls}" id="${figId}-L${n}">${html}</span>`;
  }).join('\n');
  const captionHtml = caption ? `<p class="code__caption">${inline(ctx, caption, from)}</p>` : '';
  return `<figure class="code code--${kind}" id="${figId}" aria-labelledby="${titleId}">
<figcaption class="code__head"><span class="code__lang">${escapeHtml(LANGUAGE_LABEL[language])}${kind === 'diff' ? ' diff' : ''}</span><strong id="${titleId}">${escapeHtml(title)}</strong><span class="code__lines">${lines.length} line${lines.length === 1 ? '' : 's'} · #${figId}-L1…</span></figcaption>
${captionHtml}<div class="code__scroll" tabindex="0" role="region" aria-labelledby="${titleId}"><pre><code>${body}</code></pre></div>
</figure>`;
}

function renderCode(block, ctx, from) {
  const lines = highlightLines(block.source, block.language);
  const lineClasses = lines.map(() => []);
  for (const [a, b] of block.highlight ?? []) {
    for (let n = a; n <= b; n += 1) if (!lineClasses[n - 1].includes('hl')) lineClasses[n - 1].push('hl');
  }
  return renderCodeFigure({ ...block, lines, lineClasses, kind: 'code' }, ctx, from);
}

function renderDiff(block, ctx, from) {
  const raw = block.patch.split('\n');
  const lineClasses = [];
  const lines = raw.map((line) => {
    const kind = classifyDiffLine(line);
    lineClasses.push([kind]);
    if (kind === 'add' || kind === 'del' || (kind === 'ctx' && line.startsWith(' '))) {
      const body = highlightLines(line.slice(1), block.language).join('');
      return `<span class="t-mark">${escapeHtml(line[0])}</span>${body}`;
    }
    return escapeHtml(line);
  });
  return renderCodeFigure({ ...block, lines, lineClasses, kind: 'diff' }, ctx, from);
}

export function evidenceRefs(ctx, ids, from) {
  return ids.map((id) => {
    ctx.cite(id, from);
    const ev = ctx.evidence.get(id);
    return `<li><a href="${escapeAttr(ctx.evidenceHref(id))}"><span class="ev-label">${escapeHtml(ev.label)}</span> <span class="ev-ref__title">${escapeHtml(ev.title)}</span></a></li>`;
  }).join('');
}

function renderFinding(block, ctx) {
  const anchor = ANCHOR.finding(block);
  const from = { anchor, label: `${block.id} — ${block.title}` };
  const detail = (block.detail ?? []).length
    ? `<div class="finding__detail">${block.detail.map((b) => renderBlock(b, ctx, from)).join('\n')}</div>`
    : '';
  return `<article class="finding sev-${block.severity}" id="${escapeAttr(anchor)}" aria-labelledby="${escapeAttr(anchor)}-t">
<header class="item__head">
  <div class="item__title-row">
    <span class="item__id">Finding ${escapeHtml(block.id)}</span>
    <h3 id="${escapeAttr(anchor)}-t">${escapeHtml(block.title)}</h3>
  </div>
  <p class="labels"><span class="sev sev-${block.severity}">${SEVERITY_LABEL[block.severity]} severity</span><span class="conf conf-${block.confidence}">${CONFIDENCE_LABEL[block.confidence]}</span>${renderVerificationChip(block.verification)}</p>
</header>
<p class="claim"><span class="field-label">Claim</span> ${inline(ctx, block.claim, from)}</p>
<div class="support"><span class="field-label" id="${escapeAttr(anchor)}-ev">Evidence</span><ul class="ev-refs" aria-labelledby="${escapeAttr(anchor)}-ev">${evidenceRefs(ctx, block.evidence, from)}</ul></div>
${detail}
</article>`;
}

function renderDecision(block, ctx) {
  const anchor = ANCHOR.decision(block);
  const from = { anchor, label: `${block.id} — ${block.question}` };
  const statusLabel = block.status === 'needed' ? 'Decision needed' : 'Decided';
  const alts = block.alternatives.map((alt) => `<li class="alt${alt.chosen ? ' alt--chosen' : ''}"><div class="alt__head"><strong>${escapeHtml(alt.label)}</strong>${alt.chosen ? ' <span class="chosen">Chosen</span>' : ''}</div><p class="alt__summary">${inline(ctx, alt.summary, from)}</p></li>`).join('');
  const owner = block.owner ? `<span class="item__meta">Owner: ${escapeHtml(block.owner)}</span>` : '';
  const contextHtml = block.context ? `<p class="claim"><span class="field-label">Context</span> ${inline(ctx, block.context, from)}</p>` : '';
  const consequencesHtml = block.consequences?.length
    ? `<div class="support"><span class="field-label" id="${escapeAttr(anchor)}-cons">Consequences</span><ul class="consequences" aria-labelledby="${escapeAttr(anchor)}-cons">${block.consequences.map((c) => `<li>${inline(ctx, c, from)}</li>`).join('')}</ul></div>`
    : '';
  return `<article class="decision decision--${block.status}" id="${escapeAttr(anchor)}" aria-labelledby="${escapeAttr(anchor)}-t">
<header class="item__head">
  <div class="item__title-row">
    <span class="item__id">Decision ${escapeHtml(block.id)}</span>
    <h3 id="${escapeAttr(anchor)}-t">${escapeHtml(block.question)}</h3>
  </div>
  <p class="labels"><span class="dec dec-${block.status}">${statusLabel}</span>${owner}</p>
</header>
${contextHtml}
<p class="claim"><span class="field-label">Recommendation</span> ${inline(ctx, block.recommendation, from)}</p>
<div class="support"><span class="field-label" id="${escapeAttr(anchor)}-alts">Alternatives</span><ul class="alternatives" aria-labelledby="${escapeAttr(anchor)}-alts">${alts}</ul></div>
${consequencesHtml}
</article>`;
}

function renderRisk(block, ctx) {
  const anchor = ANCHOR.risk(block);
  const from = { anchor, label: `${block.id} — ${block.title}` };
  return `<article class="risk" id="${escapeAttr(anchor)}" aria-labelledby="${escapeAttr(anchor)}-t">
<header class="item__head">
  <div class="item__title-row">
    <span class="item__id">Risk ${escapeHtml(block.id)}</span>
    <h3 id="${escapeAttr(anchor)}-t">${escapeHtml(block.title)}</h3>
  </div>
  <p class="labels"><span class="lvl lvl-${block.likelihood}">Likelihood ${block.likelihood}</span><span class="lvl lvl-${block.impact}">Impact ${block.impact}</span></p>
</header>
<p class="claim"><span class="field-label">Mitigation</span> ${inline(ctx, block.mitigation, from)}</p>
</article>`;
}

function renderRequirement(block, ctx) {
  const anchor = ANCHOR.requirement(block);
  const from = { anchor, label: `${block.id} — ${block.title}` };
  const scenariosHtml = block.scenarios?.length
    ? `<div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(anchor)}-sc">
<table class="scenario-table">
<caption id="${escapeAttr(anchor)}-sc" class="visually-hidden">Acceptance scenarios for ${escapeHtml(block.title)}</caption>
<thead><tr><th scope="col">Scenario</th><th scope="col">Given</th><th scope="col">When</th><th scope="col">Then</th></tr></thead>
<tbody>
${block.scenarios.map((sc) => `<tr><th scope="row">${escapeHtml(sc.name)}</th><td>${escapeHtml(sc.given)}</td><td>${escapeHtml(sc.when)}</td><td>${escapeHtml(sc.then)}</td></tr>`).join('\n')}
</tbody>
</table>
</div>`
    : '';
  const ev = block.evidence
    ? `<div class="support"><span class="field-label" id="${escapeAttr(anchor)}-ev">Evidence</span><ul class="ev-refs" aria-labelledby="${escapeAttr(anchor)}-ev">${evidenceRefs(ctx, block.evidence, from)}</ul></div>`
    : '';
  return `<article class="requirement" id="${escapeAttr(anchor)}" aria-labelledby="${escapeAttr(anchor)}-t">
<header class="item__head">
  <div class="item__title-row">
    <span class="item__id">Requirement ${escapeHtml(block.id)}</span>
    <h3 id="${escapeAttr(anchor)}-t">${escapeHtml(block.title)}</h3>
  </div>
  <p class="labels"><span class="ears-pill">${escapeHtml(EARS_LABEL[block.pattern])}</span>${renderVerificationChip(block.verification)}</p>
</header>
<p class="claim"><span class="field-label">Specification</span> ${inline(ctx, block.statement, from)}</p>
${scenariosHtml}
${ev}
</article>`;
}

function renderComparisonSide(side, sideKey, figId, ctx, from) {
  const tone = side.tone ?? 'neutral';
  const itemsHtml = side.items?.length
    ? `<ul class="cmp-side__list">${side.items.map((it) => `<li>${inline(ctx, it, from)}</li>`).join('')}</ul>`
    : '';
  let codeHtml = '';
  if (side.code) {
    const codeLabelId = `${figId}-${sideKey}-code`;
    const lines = highlightLines(side.code.source, side.code.language).map((l) => `<span class="ln">${l}</span>`).join('\n');
    codeHtml = `<p class="visually-hidden" id="${escapeAttr(codeLabelId)}">${escapeHtml(side.label)} (${escapeHtml(LANGUAGE_LABEL[side.code.language])})</p>
<div class="code__scroll cmp-side__code" tabindex="0" role="region" aria-labelledby="${escapeAttr(codeLabelId)}"><pre><code>${lines}</code></pre></div>`;
  }
  return `<div class="cmp-side cmp-side--${escapeAttr(tone)}">
<p class="cmp-side__head"><span class="cmp-side__tag">${escapeHtml(side.label)}</span></p>
<p class="cmp-side__summary">${inline(ctx, side.summary, from)}</p>
${itemsHtml}
${codeHtml}
</div>`;
}

function renderComparison(block, ctx, from) {
  const figId = ANCHOR.comparison(block);
  const blockFrom = { anchor: figId, label: block.title };
  const capHtml = block.caption ? `<span>${inline(ctx, block.caption, blockFrom)}</span>` : '';
  const ev = block.evidence
    ? `<div class="support"><span class="field-label" id="${escapeAttr(figId)}-ev">Evidence</span><ul class="ev-refs" aria-labelledby="${escapeAttr(figId)}-ev">${evidenceRefs(ctx, block.evidence, blockFrom)}</ul></div>`
    : '';
  return `<figure class="figure comparison" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
<figcaption><strong id="${escapeAttr(figId)}-t">${escapeHtml(block.title)}</strong>${capHtml}</figcaption>
<div class="cmp-grid">
${renderComparisonSide(block.left, 'left', figId, ctx, blockFrom)}
${renderComparisonSide(block.right, 'right', figId, ctx, blockFrom)}
</div>
${ev}
</figure>`;
}

function renderTable(block, ctx, from) {
  const capId = `${ANCHOR.table(block)}-cap`;
  const head = block.columns.map((c) => `<th scope="col"${c.numeric ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('');
  const rows = block.rows.map((row) => `<tr>${block.columns.map((c, i) => {
    const cell = inline(ctx, row[c.key], from);
    const cls = c.numeric ? ' class="num"' : '';
    return i === 0 ? `<th scope="row"${cls}>${cell}</th>` : `<td${cls}>${cell}</td>`;
  }).join('')}</tr>`).join('\n');
  return `<div class="table" id="${escapeAttr(ANCHOR.table(block))}"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="${capId}"><table>
<caption id="${capId}">${escapeHtml(block.caption)}</caption>
<thead><tr>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div></div>`;
}

function renderChart(block, ctx) {
  const figId = ANCHOR.chart(block);
  const blockFrom = { anchor: figId, label: block.title };
  const body = block.kind === 'comparison'
    ? renderComparisonChartBody(block, figId)
    : block.kind === 'quantiles'
      ? renderQuantilesChartBody(block, figId)
      : renderBarChartBody(block, figId);
  const ev = block.evidence
    ? `<div class="support"><span class="field-label" id="${escapeAttr(figId)}-ev">Measured in</span><ul class="ev-refs" aria-labelledby="${escapeAttr(figId)}-ev">${evidenceRefs(ctx, block.evidence, blockFrom)}</ul></div>`
    : '';
  return `<figure class="figure chart chart--${escapeAttr(block.kind)}" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
<figcaption><strong id="${escapeAttr(figId)}-t">${escapeHtml(block.title)}</strong><span>${inline(ctx, block.caption, blockFrom)}</span></figcaption>
${body}
${ev}
</figure>`;
}

function renderDiagram(block, ctx) {
  const figId = ANCHOR.diagram(block);
  const blockFrom = { anchor: figId, label: block.title };
  const body = block.kind === 'topology'
    ? renderTopologyDiagram(block)
    : block.kind === 'sequence'
      ? renderSequenceDiagram(block)
      : renderFlowDiagram(block);
  const ev = block.evidence
    ? `<div class="support"><span class="field-label" id="${escapeAttr(figId)}-ev">Evidence</span><ul class="ev-refs" aria-labelledby="${escapeAttr(figId)}-ev">${evidenceRefs(ctx, block.evidence, blockFrom)}</ul></div>`
    : '';
  return `<figure class="figure diagram diagram--${escapeAttr(block.kind)}" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
<figcaption><strong id="${escapeAttr(figId)}-t">${escapeHtml(block.title)}</strong><span>${inline(ctx, block.caption, blockFrom)}</span></figcaption>
${body}
${ev}
</figure>`;
}

function renderMetrics(block, ctx) {
  const items = block.items.map((m) => {
    const ev = m.evidence ? `<span class="metric__cites">${m.evidence.map((id) => { ctx.cite(id, { anchor: 'summary', label: 'Executive summary' }); return citationLink(ctx, id); }).join(' ')}</span>` : '';
    return `<div class="metric-card"><dt>${escapeHtml(m.label)}${ev}</dt><dd><span class="metric__value">${escapeHtml(m.value)}</span>${m.unit ? ` <span class="metric__unit">${escapeHtml(m.unit)}</span>` : ''}</dd></div>`;
  }).join('');
  return `<dl class="metrics">${items}</dl>`;
}

export function renderBlock(block, ctx, from) {
  switch (block.type) {
    case 'paragraph': return `<p class="prose-para">${inline(ctx, block.text, from)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} class="list">${block.items.map((item) => `<li>${inline(ctx, item, from)}</li>`).join('')}</${tag}>`;
    }
    case 'finding': return renderFinding(block, ctx);
    case 'decision': return renderDecision(block, ctx);
    case 'risk': return renderRisk(block, ctx);
    case 'requirement': return renderRequirement(block, ctx);
    case 'comparison': return renderComparison(block, ctx, from);
    case 'code': return renderCode(block, ctx, from);
    case 'diff': return renderDiff(block, ctx, from);
    case 'table': return renderTable(block, ctx, from);
    case 'chart': return renderChart(block, ctx);
    case 'diagram': return renderDiagram(block, ctx);
    case 'metrics': return renderMetrics(block, ctx);
    default: throw new Error(`unreachable: validated block type ${block.type}`);
  }
}

export function renderBlocksWithGrids(blocks, ctx, from) {
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === 'risk' && blocks[i + 1]?.type === 'risk') {
      const run = [];
      while (i < blocks.length && blocks[i].type === 'risk') {
        run.push(renderRisk(blocks[i], ctx));
        i += 1;
      }
      out.push(`<div class="risk-grid">\n${run.join('\n')}\n</div>`);
    } else {
      out.push(renderBlock(blocks[i], ctx, from));
      i += 1;
    }
  }
  return out.join('\n');
}

function renderSection(section, ctx, number, { appendix = false } = {}) {
  const anchor = ANCHOR.section(section, appendix);
  const from = { anchor, label: section.title };
  const lede = section.lede ? `<p class="lede">${escapeHtml(section.lede)}</p>` : '';
  const prefix = appendix ? `Appendix ${String.fromCharCode(64 + number)}` : `${number}`;
  return `<section class="section${appendix ? ' section--appendix' : ''}" id="${escapeAttr(anchor)}" aria-labelledby="${escapeAttr(anchor)}-h">
<h2 id="${escapeAttr(anchor)}-h"><span class="sec-num" aria-hidden="true">${prefix}</span> ${escapeHtml(section.title)}</h2>
${lede}${renderBlocksWithGrids(section.blocks, ctx, from)}
</section>`;
}

function renderEvidenceSection(ctx) {
  const items = ctx.report.evidence.map((item) => {
    const ev = ctx.evidence.get(item.id);
    const cited = ctx.citedBy.get(item.id) ?? [];
    const citedHtml = cited.length
      ? `<p class="ev__cited"><span class="field-label">Cited by</span> ${cited.map((c) => `<a href="#${escapeAttr(c.anchor)}">${escapeHtml(c.label)}</a>`).join(' · ')}</p>`
      : '<p class="ev__cited"><span class="field-label">Cited by</span> not cited</p>';
    let body;
    if (item.kind === 'file') {
      const preview = renderEvidencePreview(item.id, ev);
      body = `<div class="ev__meta-row"><p class="ev__file"><a href="${escapeAttr(ev.href)}" type="${escapeAttr(item.mediaType)}">${escapeHtml(ev.href)}</a> <span class="ev__meta">${escapeHtml(item.mediaType)} · ${ev.bytes} bytes</span></p>
<p class="ev__digest"><span class="field-label">SHA-256</span> <code>${ev.sha256}</code></p></div>${preview}`;
    } else {
      const label = item.kind === 'redacted' ? 'Redacted' : 'Unavailable';
      body = `<p class="ev__withheld"><strong>${label}.</strong> ${escapeHtml(item.reason)} No bytes are included in this packet.</p>`;
    }
    return `<li class="ev ev--${item.kind}" id="${escapeAttr(ANCHOR.evidenceItem(item.id))}"><div class="ev__head"><p class="ev__title"><span class="ev-label">${escapeHtml(ev.label)}</span> <strong>${escapeHtml(item.title)}</strong></p><span class="item__id">${escapeHtml(item.id)}</span></div>
${body}
${citedHtml}</li>`;
  }).join('\n');
  return `<section class="section" id="evidence" aria-labelledby="evidence-h">
<h2 id="evidence-h"><span class="sec-num" aria-hidden="true">Ev</span> Evidence</h2>
<p class="lede">Every claim above resolves to an entry below. Bundled files are content-addressed by SHA-256; withheld items state their reason explicitly.</p>
<ol class="evidence-list">${items}</ol>
</section>`;
}

function renderProvenance(ctx, sourceSha256) {
  const { provenance } = ctx.report;
  const sources = provenance.sources.map((s) => `<tr><th scope="row">${escapeHtml(s.label)}</th><td>${escapeHtml(s.reference)}</td><td>${s.revision ? `<code>${escapeHtml(s.revision)}</code>` : '—'}</td><td class="digest-cell">${s.sha256 ? `<code>${escapeHtml(s.sha256)}</code>` : '—'}</td></tr>`).join('\n');
  const notes = provenance.notes ? `<p class="prose-para">${inline(ctx, provenance.notes, { anchor: 'provenance', label: 'Provenance' })}</p>` : '';
  return `<section class="section" id="provenance" aria-labelledby="provenance-h">
<h2 id="provenance-h"><span class="sec-num" aria-hidden="true">Pr</span> Provenance and packet verification</h2>
${notes}<div class="table"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="prov-cap"><table>
<caption id="prov-cap">Sources this report was derived from</caption>
<thead><tr><th scope="col">Source</th><th scope="col">Reference</th><th scope="col">Revision</th><th scope="col">SHA-256</th></tr></thead>
<tbody>${sources}</tbody></table></div></div>
<h3 id="verify-h">Verify this packet</h3>
<ol class="list">
<li>This page cannot contain its own content ID. The ID, full file inventory, media types, byte lengths and per-file SHA-256 digests are in <a href="manifest.json">manifest.json</a>; <a href="checksums.json">checksums.json</a> repeats the digests for independent checking.</li>
<li>For deterministic machine reading, use <a href="report.md" type="text/markdown">agent-readable Markdown</a>. It is generated from the same validated report model and is covered by the packet identity and checksums.</li>
<li>Run <code>canon verify &lt;packet-directory&gt;</code>. It recomputes every digest and the content ID and exits non-zero on any mismatch, missing file, or extra file.</li>
<li>Report source digest (canonical <code>report/v1</code> JSON): <code class="digest">${sourceSha256}</code>.</li>
</ol>
</section>`;
}

function renderNav(report, { compact }) {
  const entries = [['summary', '§', 'Executive summary']];
  report.sections.forEach((s, i) => entries.push([`sec-${s.id}`, `${i + 1}`, s.title]));
  entries.push(['evidence', 'Ev', 'Evidence']);
  (report.appendices ?? []).forEach((s, i) => entries.push([`app-${s.id}`, String.fromCharCode(65 + i), `Appendix ${String.fromCharCode(65 + i)}: ${s.title}`]));
  entries.push(['provenance', 'Pr', 'Provenance & verification']);
  const list = `<ol>${entries.map(([id, badge, title]) => `<li><a href="#${escapeAttr(id)}"><span class="nav-badge" aria-hidden="true">${escapeHtml(badge)}</span><span>${escapeHtml(title)}</span></a></li>`).join('')}</ol>`;
  if (compact) {
    return `<nav class="toc" aria-label="Contents"><details><summary>Contents <span class="toc__count">${entries.length} sections</span></summary>${list}</details></nav>`;
  }
  return `<nav class="rail" aria-label="Contents"><p class="overline" aria-hidden="true">Contents</p>${list}</nav>`;
}

function renderLegend() {
  const items = Object.keys(CONFIDENCE_LABEL).map((k) => `<div><dt><span class="conf conf-${k}">${CONFIDENCE_LABEL[k]}</span></dt><dd>${CONFIDENCE_MEANING[k]}</dd></div>`).join('');
  return `<details class="legend"><summary>Epistemic &amp; severity legend</summary><dl>${items}</dl><p>Severity (critical, high, medium, low, info) ranks impact; the confidence label says how strongly the claim is established.</p></details>`;
}

export function renderIndexHtml(report, { evidenceIndex, stylesheetHref, sourceSha256 }) {
  const ctx = new RenderContext(report, evidenceIndex);
  const meta = report.metadata;
  // Sections and appendices render first so citations are collected before the
  // evidence list (which shows back-references) is rendered.
  const summaryFrom = { anchor: 'summary', label: 'Executive summary' };
  const verdict = `<div class="verdict conf-${report.summary.verdict.confidence}"><div class="verdict__bar"><span class="conf conf-${report.summary.verdict.confidence}">${CONFIDENCE_LABEL[report.summary.verdict.confidence]}</span> <span class="field-label">Executive Verdict</span></div><p class="verdict__text">${inline(ctx, report.summary.verdict.text, summaryFrom)}</p></div>`;
  const summaryParas = report.summary.paragraphs.map((p) => `<p class="prose-para">${inline(ctx, p, summaryFrom)}</p>`).join('\n');
  const metrics = report.summary.metrics ? renderMetrics({ type: 'metrics', ...report.summary.metrics }, ctx) : '';
  const sections = report.sections.map((s, i) => renderSection(s, ctx, i + 1)).join('\n');
  const appendices = (report.appendices ?? []).map((s, i) => renderSection(s, ctx, i + 1, { appendix: true })).join('\n');
  const provenance = renderProvenance(ctx, sourceSha256);
  const evidence = renderEvidenceSection(ctx);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CSP_META)}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="${escapeAttr(`${TOOL.name} ${TOOL.version}; ${TOOL.renderPolicy}; ${TOOL.securityPolicy}`)}">
<title>${escapeHtml(report.title)}</title>
<link rel="stylesheet" href="${escapeAttr(stylesheetHref)}">
<link rel="alternate" type="text/markdown" href="report.md" title="Agent-readable report">
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="masthead">
<p class="brand"><span class="brand__mark" aria-hidden="true">C</span><span><strong>Canon</strong><small>${escapeHtml(report.id)}</small></span></p>
<p class="masthead__status"><span class="status status--${meta.status}">${STATUS_LABEL[meta.status]}</span> <span class="classification">${escapeHtml(meta.classification)}</span> <span class="masthead__date">${escapeHtml(meta.reviewDate)}</span></p>
</header>
${renderNav(report, { compact: true })}
<div class="layout">
${renderNav(report, { compact: false })}
<main id="content" class="document">
<header class="title-block">
<h1>${escapeHtml(report.title)}</h1>
${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : ''}
<dl class="title-meta">
<div><dt>Review request</dt><dd>${escapeHtml(meta.reviewRequest)}</dd></div>
<div><dt>Authors</dt><dd>${meta.authors.map(escapeHtml).join(', ')}</dd></div>
<div><dt>Source digest</dt><dd><code title="${sourceSha256}">${sourceSha256.slice(0, 12)}…</code> <a href="#provenance">verify</a></dd></div>
</dl>
</header>
<section class="section section--summary" id="summary" aria-labelledby="summary-h">
<h2 id="summary-h"><span class="sec-num" aria-hidden="true">§</span> Executive summary</h2>
${verdict}
${metrics}
<div class="summary-prose">
${summaryParas}
</div>
${renderLegend()}
</section>
${sections}
${evidence}
${appendices}
${provenance}
</main>
</div>
<footer class="site-footer">
<p>Sealed by Canon (${escapeHtml(TOOL.name)} ${escapeHtml(TOOL.version)}) · ${escapeHtml(TOOL.renderPolicy)} · ${escapeHtml(TOOL.securityPolicy)}. Zero scripts, zero external runtime requests.</p>
<p><a href="#content">Back to top</a></p>
</footer>
</body>
</html>
`;
}
