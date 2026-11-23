// report/v1 -> index.html under render-policy/2 (the Canon 2.1 edition,
// docs/decisions/render-policy-2.md R3, R5, R9). Presentation belongs to this module and
// src/presentation/edition-2.1.css; the report supplies meaning only.
//
// Every authored string passes through escapeHtml/escapeAttr, exactly as policy/1 does:
// prose goes through the policy/1 inline() (imported, not copied) or its exact escaping,
// with cites grouped into unbreakable runs (inlineV2), and the diagram,
// chart, highlighter and evidence-preview renderers are reused unchanged, so their
// output (including every SVG byte) is identical to policy/1.
import { CSP_META, RENDER_POLICY_2, TOOL } from '../policy.mjs';
import { anchor as ANCHOR } from './anchors.mjs';
import { assignBlockNumbers } from './block-numbers.mjs';
import { escapeAttr, escapeHtml } from './escape.mjs';
import { renderEvidencePreview } from './evidence-preview.mjs';
import { classifyDiffLine, highlightLines } from './highlight.mjs';
import { inline, RenderContext } from './html.mjs';
import { renderBarChartBody, renderComparisonChartBody, renderQuantilesChartBody } from './svg-chart.mjs';
import { renderFlowDiagram, renderSequenceDiagram, renderTopologyDiagram } from './svg-diagram.mjs';

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
// Severity is a shape: pips out of four (BRIEF §3). Info has none.
const SEVERITY_PIPS = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const LEVEL_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
const LEVEL_PIPS = { low: 1, medium: 2, high: 3 };
// Confidence is a glyph plus a word, never colour alone.
const CONFIDENCE = {
  proven: { glyph: '✓', word: 'Proven' },
  recommended: { glyph: '→', word: 'Recommended' },
  defect: { glyph: '✕', word: 'Defect' },
  open: { glyph: '?', word: 'Open' },
};
const VERIFICATION_LABEL = { code: 'Code check', judgment: 'Judgment', review: 'Human review', 'needs-review': 'Needs review' };
const EARS_LABEL = { ubiquitous: 'Ubiquitous', event: 'Event-driven', state: 'State-driven', unwanted: 'Unwanted behavior', optional: 'Optional feature' };
const LANGUAGE_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', shell: 'Shell', yaml: 'YAML', text: 'Text' };
const STATUS_LABEL = { draft: 'Draft', proposed: 'Proposed', final: 'Final' };

// The same normative-keyword set policy/1 marks (html.mjs), plus the EARS keywords,
// which are marked only inside requirement statements.
const RFC2119_RE = /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|REQUIRED|SHALL|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/g;
const EARS_KW_RE = /\b(WHEN|IF|THEN)\b/g;

function earsProse(text) {
  return escapeHtml(text)
    .replace(EARS_KW_RE, '<b class="ears-kw">$1</b>')
    .replace(RFC2119_RE, '<span class="rfc2119">$1</span>');
}

// The policy/1 prose escaping (html.mjs escapeProseHtml): escapeHtml plus RFC 2119 marking.
function prose(text) {
  return escapeHtml(text).replace(RFC2119_RE, '<span class="rfc2119">$1</span>');
}

// Prose, string, text, em and strong segments as { raw, tag }; null for every other kind.
function proseSegment(seg) {
  if (typeof seg === 'string') return { raw: seg, tag: null };
  if (Object.hasOwn(seg, 'text')) return { raw: seg.text, tag: null };
  if (Object.hasOwn(seg, 'em')) return { raw: seg.em, tag: 'em' };
  if (Object.hasOwn(seg, 'strong')) return { raw: seg.strong, tag: 'strong' };
  return null;
}

const isCite = (seg) => seg !== null && typeof seg === 'object' && Object.hasOwn(seg, 'cite');
const isBlank = (seg) => typeof seg === 'string' ? /^\s+$/.test(seg) : (seg !== null && typeof seg === 'object' && Object.hasOwn(seg, 'text') && /^\s+$/.test(seg.text));
const wrapTag = (tag, html) => (tag && html ? `<${tag}>${html}</${tag}>` : html);
// Closing punctuation a cite keeps on its line: Unicode Po (. , ; : ! ? …), Pe ( ) ] } )
// and Pf (closing quotes). Opening punctuation (Ps, Pi) and dashes (Pd) are not taken.
const LEAD_PUNCT_RE = /^[\p{Po}\p{Pe}\p{Pf}]+/u;

// Split rendered prose HTML before its last word: [head, tail]. The split falls only on
// whitespace outside every tag and element (the RFC 2119 and EARS marks), so "MUST NOT"
// stays one element, and head + tail is exactly the input.
function splitLastWord(html) {
  const ws = [];
  let depth = 0;
  for (let i = 0; i < html.length; i += 1) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      depth += html[i + 1] === '/' ? -1 : 1;
      i = end;
    } else if (depth === 0 && /\s/.test(html[i])) ws.push(i);
  }
  let end = html.length;
  while (ws.length && ws.at(-1) === end - 1) end = ws.pop();
  return ws.length ? [html.slice(0, ws.at(-1) + 1), html.slice(ws.at(-1) + 1)] : ['', html];
}

// inline() for policy/2. Segments render exactly as the policy/1 inline() renders them
// (code, link and cite through it; prose through `proseFn`, prose() by default), and every
// run of cites, consecutive or separated only by whitespace, becomes one span.cite-run
// (an inline-block, so it moves to a new line whole) holding the last word of the prose
// segment before it (never whitespace alone, so a run never starts with a space), the cites, and the
// closing punctuation (LEAD_PUNCT_RE) that starts the plain prose segment after it. Only
// where the markup splits changes; the text of every segment is emitted once, in order.
function inlineV2(ctx, value, from, proseFn = prose) {
  if (typeof value === 'string') return proseFn(value);
  const parts = []; // { html, inner?, tag? }: inner/tag kept on prose parts so a run can split them
  const prosePart = (p) => ({ html: wrapTag(p.tag, proseFn(p.raw)), inner: proseFn(p.raw), tag: p.tag });
  // A blank prose segment belongs to a cite run when the next non-blank segment is a cite.
  const joinsRun = (k) => isBlank(value[k]) && isCite(value.slice(k + 1).find((s) => !isBlank(s)) ?? null);
  let i = 0;
  while (i < value.length) {
    if (!isCite(value[i])) {
      const p = proseSegment(value[i]);
      parts.push(p ? prosePart(p) : { html: inline(ctx, [value[i]], from) });
      i += 1;
      continue;
    }
    let run = '';
    const prev = parts.at(-1);
    // A whitespace-only tail stays outside: the run is an inline-block, which would drop
    // whitespace at its start.
    const [head, tail] = prev?.inner !== undefined ? splitLastWord(prev.inner) : ['', ''];
    if (tail.trim()) {
      parts.pop();
      if (head) parts.push({ html: wrapTag(prev.tag, head) });
      run += wrapTag(prev.tag, tail);
    }
    while (i < value.length && (isCite(value[i]) || joinsRun(i))) {
      run += isCite(value[i]) ? inline(ctx, [value[i]], from) : proseFn(proseSegment(value[i]).raw);
      i += 1;
    }
    let rest = null;
    const next = i < value.length ? proseSegment(value[i]) : null;
    if (next && next.tag === null) {
      const punct = next.raw.match(LEAD_PUNCT_RE)?.[0] ?? '';
      run += escapeHtml(punct);
      rest = next.raw.slice(punct.length);
      i += 1;
    }
    parts.push({ html: `<span class="cite-run">${run}</span>` });
    if (rest) parts.push(prosePart({ raw: rest, tag: null }));
  }
  return parts.map((p) => p.html).join('');
}

function inlineCiteIds(value) {
  if (typeof value === 'string') return new Set();
  return new Set(value.filter((s) => s && typeof s === 'object' && Object.hasOwn(s, 'cite')).map((s) => s.cite));
}

// A value plus the evidence a block lists but does not cite inline, appended as inline
// cites so dropping the policy/1 evidence chip row never drops an evidence relation.
// Placement rule: when the value's last segment is a plain prose segment (a string or
// { text }) whose last whitespace-delimited word ends in ".", and that "." is the only
// "." in the word, the cites go immediately before that full stop, after a space: "…
// word [E1]." Otherwise (the text ends in "...", "e.g.", "v1.2.", "?", a quote, a cite,
// code, em or strong, or trailing whitespace) they go at the end, after a space. No
// authored character is added, removed or reordered; inlineV2 then glues the cites.
function withEvidence(ctx, value, ids, from, proseFn = prose) {
  const cited = inlineCiteIds(value);
  const extra = (ids ?? []).filter((id) => !cited.has(id)).map((id) => ({ cite: id }));
  if (!extra.length) return inlineV2(ctx, value, from, proseFn);
  const segs = typeof value === 'string' ? [value] : [...value];
  const last = segs.length ? proseSegment(segs.at(-1)) : null;
  const lastWord = last && last.tag === null ? last.raw.match(/\S+$/)?.[0] ?? '' : '';
  if (lastWord.endsWith('.') && lastWord.indexOf('.') === lastWord.length - 1) {
    segs.splice(-1, 1, `${last.raw.slice(0, -1)} `, ...extra, '.');
  } else if (last && last.tag === null) {
    segs.splice(-1, 1, `${last.raw} `, ...extra);
  } else {
    segs.push(' ', ...extra);
  }
  return inlineV2(ctx, segs, from, proseFn);
}

// Plain text of an inline value, for an aria-label.
function plainText(ctx, value) {
  if (typeof value === 'string') return value;
  return value.map((seg) => {
    if (typeof seg === 'string') return seg;
    if (Object.hasOwn(seg, 'text')) return seg.text;
    if (Object.hasOwn(seg, 'code')) return seg.code;
    if (Object.hasOwn(seg, 'em')) return seg.em;
    if (Object.hasOwn(seg, 'strong')) return seg.strong;
    if (Object.hasOwn(seg, 'cite')) return `[${ctx.evidence.get(seg.cite).label}]`;
    if (Object.hasOwn(seg, 'link')) return seg.link.text;
    throw new Error('unreachable: validated inline segment');
  }).join('');
}

function pips(on, { critical = false } = {}) {
  const cells = [0, 1, 2, 3].map((i) => `<span class="pip${i < on ? (critical ? ' pip--critical' : ' pip--on') : ''}"></span>`).join('');
  return `<span class="pips" aria-hidden="true">${cells}</span>`;
}

function severitySignal(severity) {
  const n = SEVERITY_PIPS[severity];
  return `<span class="sev sev--${severity}">${n ? pips(n, { critical: severity === 'critical' }) : ''}<span class="sev__word">${SEVERITY_LABEL[severity]}</span></span>`;
}

function levelSignal(level) {
  return `<span class="lvl lvl--${level}">${pips(LEVEL_PIPS[level])}<span class="lvl__word">${LEVEL_LABEL[level]}</span></span>`;
}

function confidenceChip(confidence) {
  const c = CONFIDENCE[confidence];
  return `<span class="conf conf--${confidence}"><span class="conf__glyph" aria-hidden="true">${c.glyph}</span> ${c.word}</span>`;
}

function metaLine(id, verification) {
  const parts = [escapeHtml(id)];
  if (verification) {
    parts.push(escapeHtml(VERIFICATION_LABEL[verification.band]));
    if (verification.detail) parts.push(escapeHtml(verification.detail));
  }
  return `<p class="meta-line">${parts.join(' · ')}</p>`;
}

function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

const sectionNumber = (i) => String(i + 1).padStart(2, '0');
const appendixLetter = (i) => String.fromCharCode(65 + i);

// The diagram and chart renderers return `<div class="diagram-canvas">…</div>\n<ledger>`
// (bar charts have no canvas). The canvas goes inside the plate frame and the ledger
// below the caption; the bytes of both are used exactly as returned.
function splitCanvas(body) {
  const open = '<div class="diagram-canvas">';
  if (!body.startsWith(open)) return { canvas: '', ledger: body };
  const close = '</svg>\n</div>';
  const at = body.indexOf(close);
  if (at === -1) throw new Error('unreachable: diagram canvas without a closing </svg></div>');
  const end = at + close.length;
  return { canvas: body.slice(0, end), ledger: body.slice(end).replace(/^\n/, '') };
}

class Edition {
  constructor(report, evidenceIndex) {
    this.report = report;
    this.ctx = new RenderContext(report, evidenceIndex);
    this.numbers = assignBlockNumbers(report);
    this.findingIndex = new Map();
    this.decisionIndex = new Map();
    this.riskIndex = new Map();
    this.plateIndex = new Map();
    const all = [...report.sections, ...(report.appendices ?? [])].flatMap((s) => s.blocks);
    for (const b of all) {
      if (b.type === 'finding') this.findingIndex.set(b.id, this.findingIndex.size + 1);
      else if (b.type === 'decision') this.decisionIndex.set(b.id, this.decisionIndex.size + 1);
      else if (b.type === 'risk') this.riskIndex.set(b.id, this.riskIndex.size + 1);
      else if (b.type === 'diagram') this.plateIndex.set(b.id, this.plateIndex.size + 1);
    }
  }

  // --- blocks -------------------------------------------------------------------------

  list(block, from) {
    const tag = block.ordered ? 'ol' : 'ul';
    return `<${tag} class="list${block.ordered ? ' list--ordered' : ''}">${block.items.map((item) => `<li>${inlineV2(this.ctx, item, from)}</li>`).join('')}</${tag}>`;
  }

  finding(block) {
    const a = ANCHOR.finding(block);
    const n = this.findingIndex.get(block.id);
    const from = { anchor: a, label: `F${n}` };
    const claim = withEvidence(this.ctx, block.claim, block.evidence, from);
    const detail = (block.detail ?? []).length
      ? `<div class="finding__detail">${block.detail.map((b) => this.inner(b, from)).join('\n')}</div>`
      : '';
    return `<article class="finding finding--${block.severity}" id="${escapeAttr(a)}" aria-labelledby="${escapeAttr(a)}-t">
<header class="finding__head">
<h3 class="finding__title" id="${escapeAttr(a)}-t"><span class="idx">F${n}</span> ${escapeHtml(block.title)}</h3>
<p class="signals">${severitySignal(block.severity)}${confidenceChip(block.confidence)}</p>
</header>
<p class="finding__claim">${claim}</p>
${metaLine(block.id, block.verification)}${detail}
</article>`;
  }

  decision(block) {
    const a = ANCHOR.decision(block);
    const n = this.decisionIndex.get(block.id);
    const from = { anchor: a, label: `D${n}` };
    const status = block.status === 'decided'
      ? '<span class="stamp">Decided</span>'
      : '<span class="open-tag">Decision needed</span>';
    const context = block.context ? `<p class="decision__context">${inlineV2(this.ctx, block.context, from)}</p>` : '';
    const consequences = block.consequences?.length
      ? `<p class="decision__label" id="${escapeAttr(a)}-cons">Consequences</p><ul class="consequences" aria-labelledby="${escapeAttr(a)}-cons">${block.consequences.map((c) => `<li>${inlineV2(this.ctx, c, from)}</li>`).join('')}</ul>`
      : '';
    const options = block.alternatives.map((alt, i) => {
      const cls = ['option', alt.recommended ? 'option--recommended' : '', alt.chosen ? 'option--chosen' : ''].filter(Boolean).join(' ');
      const arrow = alt.recommended ? '<span class="option__arrow" aria-hidden="true">→</span><span class="visually-hidden">Recommended:</span> ' : '';
      const chosen = alt.chosen ? ' <span class="stamp">Chosen</span>' : '';
      return `<li class="${cls}"><span class="option__key" aria-hidden="true">${appendixLetter(i)}</span><div class="option__body"><p class="option__label">${arrow}<strong>${escapeHtml(alt.label)}</strong>${chosen}</p><p class="option__summary">${inlineV2(this.ctx, alt.summary, from)}</p></div></li>`;
    }).join('');
    const owner = block.owner ? ` · Owner: ${escapeHtml(block.owner)}` : '';
    return `<article class="decision decision--${block.status}" id="${escapeAttr(a)}" aria-labelledby="${escapeAttr(a)}-t">
<div class="decision__main">
<h3 class="decision__question" id="${escapeAttr(a)}-t"><span class="idx">D${n}</span> ${escapeHtml(block.question)}</h3>
<p class="decision__status">${status}</p>
${context}<p class="decision__rec">${confidenceChip('recommended')} ${inlineV2(this.ctx, block.recommendation, from)}</p>
${consequences}<p class="meta-line">${escapeHtml(block.id)}${owner}</p>
</div>
<div class="decision__options">
<p class="decision__label" id="${escapeAttr(a)}-alts">Options</p>
<ol class="options" aria-labelledby="${escapeAttr(a)}-alts">${options}</ol>
</div>
</article>`;
  }

  // A run of consecutive risks: one ruled table, sorted by likelihood × impact
  // (descending, stable). Each row keeps its r- id; the R index follows report order.
  riskTable(blocks) {
    const score = (b) => LEVEL_PIPS[b.likelihood] * LEVEL_PIPS[b.impact];
    const sorted = blocks.map((b, i) => ({ b, i })).sort((x, y) => (score(y.b) - score(x.b)) || (x.i - y.i)).map((x) => x.b);
    const rows = sorted.map((block) => {
      const a = ANCHOR.risk(block);
      const n = this.riskIndex.get(block.id);
      const from = { anchor: a, label: `R${n}` };
      return `<tr id="${escapeAttr(a)}"><th scope="row"><span class="idx">R${n}</span> <span id="${escapeAttr(a)}-t">${escapeHtml(block.title)}</span></th><td>${levelSignal(block.likelihood)}</td><td>${levelSignal(block.impact)}</td><td>${inlineV2(this.ctx, block.mitigation, from)}</td></tr>`;
    }).join('\n');
    return `<div class="table table--risks"><div class="table__scroll" tabindex="0" role="region" aria-label="Risks, ordered by likelihood × impact"><table class="risk-table">
<thead><tr><th scope="col">Risk</th><th scope="col">Likelihood</th><th scope="col">Impact</th><th scope="col">Mitigation</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div></div>`;
  }

  requirement(block) {
    const a = ANCHOR.requirement(block);
    const from = { anchor: a, label: block.id };
    const statement = withEvidence(this.ctx, block.statement, block.evidence, from, earsProse);
    const scenarios = block.scenarios?.length
      ? `<div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(a)}-sc">
<table class="scenario-table">
<caption id="${escapeAttr(a)}-sc" class="visually-hidden">Acceptance scenarios for ${escapeHtml(block.title)}</caption>
<thead><tr><th scope="col">Scenario</th><th scope="col">Given</th><th scope="col">When</th><th scope="col">Then</th></tr></thead>
<tbody>
${block.scenarios.map((sc) => `<tr><th scope="row">${escapeHtml(sc.name)}</th><td>${escapeHtml(sc.given)}</td><td>${escapeHtml(sc.when)}</td><td>${escapeHtml(sc.then)}</td></tr>`).join('\n')}
</tbody>
</table>
</div>
`
      : '';
    return `<article class="requirement" id="${escapeAttr(a)}" aria-labelledby="${escapeAttr(a)}-t">
<header class="requirement__head"><h3 class="requirement__title" id="${escapeAttr(a)}-t">${escapeHtml(block.title)}</h3><span class="ears-tag">${escapeHtml(EARS_LABEL[block.pattern])}</span></header>
<p class="requirement__spec">${statement}</p>
${scenarios}${metaLine(block.id, block.verification)}
</article>`;
  }

  comparisonSide(side, sideKey, figId, from) {
    const tone = side.tone ?? 'neutral';
    const items = side.items?.length
      ? `<ul class="cmp-side__list">${side.items.map((it) => `<li>${inlineV2(this.ctx, it, from)}</li>`).join('')}</ul>`
      : '';
    let code = '';
    if (side.code) {
      const labelId = `${figId}-${sideKey}-code`;
      const lines = highlightLines(side.code.source, side.code.language).map((l) => `<span class="ln">${l}</span>`).join('\n');
      code = `<p class="visually-hidden" id="${escapeAttr(labelId)}">${escapeHtml(side.label)} (${escapeHtml(LANGUAGE_LABEL[side.code.language])})</p>
<div class="code__scroll cmp-side__code" tabindex="0" role="region" aria-labelledby="${escapeAttr(labelId)}"><pre><code>${lines}</code></pre></div>`;
    }
    return `<div class="cmp-side cmp-side--${escapeAttr(tone)}">
<p class="cmp-side__tag">${escapeHtml(side.label)}</p>
<p class="cmp-side__summary">${inlineV2(this.ctx, side.summary, from)}</p>
${items}${code}
</div>`;
  }

  comparison(block) {
    const figId = ANCHOR.comparison(block);
    const from = { anchor: figId, label: block.title };
    const cap = block.caption
      ? ` <span class="comparison__caption">${withEvidence(this.ctx, block.caption, block.evidence, from)}</span>`
      : withEvidence(this.ctx, [], block.evidence, from);
    return `<figure class="comparison" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
<figcaption class="comparison__head"><strong id="${escapeAttr(figId)}-t">${escapeHtml(block.title)}</strong>${cap}</figcaption>
<div class="cmp-grid">
${this.comparisonSide(block.left, 'left', figId, from)}
${this.comparisonSide(block.right, 'right', figId, from)}
</div>
</figure>`;
  }

  codeFigure({ id, title, language, caption, lines, lineClasses, kind }, from) {
    const figId = ANCHOR.code({ id });
    const titleId = `${figId}-title`;
    const body = lines.map((html, i) => {
      const cls = ['ln', ...(lineClasses[i] ?? [])].join(' ');
      return `<span class="${cls}" id="${figId}-L${i + 1}">${html}</span>`;
    }).join('\n');
    const captionHtml = caption ? ` ${inlineV2(this.ctx, caption, from)}` : '';
    return `<figure class="code code--${kind}" id="${figId}" aria-labelledby="${titleId}">
<div class="code__frame">
<p class="code__head"><span class="code__lang">${escapeHtml(LANGUAGE_LABEL[language])}${kind === 'diff' ? ' diff' : ''}</span><span class="code__lines">${lines.length} line${lines.length === 1 ? '' : 's'} · <a href="#${figId}-L1">#${figId}-L1</a></span></p>
<div class="code__scroll" tabindex="0" role="region" aria-labelledby="${titleId}"><pre><code>${body}</code></pre></div>
</div>
<figcaption class="code__caption"><strong id="${titleId}">${escapeHtml(title)}.</strong>${captionHtml}</figcaption>
</figure>`;
  }

  code(block, from) {
    const lines = highlightLines(block.source, block.language);
    const lineClasses = lines.map(() => []);
    for (const [a, b] of block.highlight ?? []) {
      for (let n = a; n <= b; n += 1) if (!lineClasses[n - 1].includes('hl')) lineClasses[n - 1].push('hl');
    }
    return this.codeFigure({ ...block, lines, lineClasses, kind: 'code' }, from);
  }

  diff(block, from) {
    const lineClasses = [];
    const lines = block.patch.split('\n').map((line) => {
      const kind = classifyDiffLine(line);
      lineClasses.push([kind]);
      if (kind === 'add' || kind === 'del' || (kind === 'ctx' && line.startsWith(' '))) {
        return `<span class="t-mark">${escapeHtml(line[0])}</span>${highlightLines(line.slice(1), block.language).join('')}`;
      }
      return escapeHtml(line);
    });
    return this.codeFigure({ ...block, lines, lineClasses, kind: 'diff' }, from);
  }

  table(block, from) {
    const capId = `${ANCHOR.table(block)}-cap`;
    const colCls = (c) => [c.numeric ? 'num' : '', c.key === 'id' ? 'col-id' : ''].filter(Boolean).join(' ');
    const attr = (c) => (colCls(c) ? ` class="${colCls(c)}"` : '');
    const head = block.columns.map((c) => `<th scope="col"${attr(c)}>${escapeHtml(c.label)}</th>`).join('');
    const rows = block.rows.map((row) => `<tr>${block.columns.map((c, i) => {
      const cell = inlineV2(this.ctx, row[c.key], from);
      return i === 0 ? `<th scope="row"${attr(c)}>${cell}</th>` : `<td${attr(c)}>${cell}</td>`;
    }).join('')}</tr>`).join('\n');
    return `<div class="table" id="${escapeAttr(ANCHOR.table(block))}"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="${capId}"><table>
<caption id="${capId}">${escapeHtml(block.caption)}</caption>
<thead><tr>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div></div>`;
  }

  chart(block) {
    const figId = ANCHOR.chart(block);
    const from = { anchor: figId, label: block.title };
    const body = block.kind === 'comparison'
      ? renderComparisonChartBody(block, figId)
      : block.kind === 'quantiles'
        ? renderQuantilesChartBody(block, figId)
        : renderBarChartBody(block, figId);
    const { canvas, ledger } = splitCanvas(body);
    const caption = withEvidence(this.ctx, block.caption, block.evidence, from);
    const frame = canvas ? `<div class="plate__frame">${canvas}</div>\n` : '';
    return `<figure class="plate plate--chart chart--${escapeAttr(block.kind)}" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
${frame}<div class="plate__ledger">${ledger}</div>
<figcaption class="plate__caption"><span class="plate__text"><strong id="${escapeAttr(figId)}-t">${escapeHtml(block.title)}.</strong> ${caption}</span></figcaption>
</figure>`;
  }

  diagram(block) {
    const figId = ANCHOR.diagram(block);
    const n = this.plateIndex.get(block.id);
    const from = { anchor: figId, label: `Plate ${n}` };
    const body = block.kind === 'topology'
      ? renderTopologyDiagram(block)
      : block.kind === 'sequence'
        ? renderSequenceDiagram(block)
        : renderFlowDiagram(block);
    const { canvas, ledger } = splitCanvas(body);
    const claim = `Plate ${n}: ${block.title}. ${plainText(this.ctx, block.caption)}`;
    const caption = withEvidence(this.ctx, block.caption, block.evidence, from);
    return `<figure class="plate plate--${escapeAttr(block.kind)}" id="${escapeAttr(figId)}" aria-labelledby="${escapeAttr(figId)}-t">
<div class="plate__frame" role="img" aria-label="${escapeAttr(claim)}">${canvas}</div>
<figcaption class="plate__caption"><span class="plate__text"><strong id="${escapeAttr(figId)}-t">Plate ${n}.</strong> <span class="plate__title">${escapeHtml(block.title)}.</span> ${caption}</span><a class="plate__ref" href="#${escapeAttr(figId)}">#${escapeHtml(figId)}</a></figcaption>
</figure>
<div class="plate__ledger">${ledger}</div>`;
  }

  figures(items, from) {
    const cells = items.map((m) => {
      const label = m.evidence ? [`${m.label} `, ...m.evidence.map((id) => ({ cite: id }))] : [m.label];
      return `<div class="figures__cell"><dt>${inlineV2(this.ctx, label, from, escapeHtml)}</dt><dd><span class="figures__value">${escapeHtml(m.value)}</span>${m.unit ? ` <span class="figures__unit">${escapeHtml(m.unit)}</span>` : ''}</dd></div>`;
    }).join('');
    return `<dl class="figures">${cells}</dl>`;
  }

  // Blocks nested in a finding's detail: paragraph, list or code; never numbered.
  inner(block, from) {
    switch (block.type) {
      case 'paragraph': return `<p class="prose-para">${inlineV2(this.ctx, block.text, from)}</p>`;
      case 'list': return this.list(block, from);
      case 'code': return this.code(block, from);
      default: throw new Error(`unreachable: validated detail block type ${block.type}`);
    }
  }

  block(block, from) {
    switch (block.type) {
      case 'paragraph': return `<p class="prose-para">${inlineV2(this.ctx, block.text, from)}</p>`;
      case 'list': return this.list(block, from);
      case 'finding': return this.finding(block);
      case 'decision': return this.decision(block);
      case 'risk': return this.riskTable([block]);
      case 'requirement': return this.requirement(block);
      case 'comparison': return this.comparison(block);
      case 'code': return this.code(block, from);
      case 'diff': return this.diff(block, from);
      case 'table': return this.table(block, from);
      case 'chart': return this.chart(block);
      case 'diagram': return this.diagram(block);
      case 'metrics': return this.figures(block.items, from);
      default: throw new Error(`unreachable: validated block type ${block.type}`);
    }
  }

  // --- numbered block wrappers ---------------------------------------------------------

  static bAnchor(label) {
    return `<a class="b-anchor" id="${label}" href="#${label}" aria-label="Block ${label}">${label}</a>`;
  }

  numberedBlocks(blocks, labels, from) {
    const out = [];
    let i = 0;
    while (i < blocks.length) {
      if (blocks[i].type === 'risk') {
        // A run of risks is one table; its block anchors stay in report order ahead of
        // the sorted table, so b-nn order is never permuted by the sort (R3, R5).
        const start = i;
        while (i < blocks.length && blocks[i].type === 'risk') i += 1;
        const run = blocks.slice(start, i);
        const anchors = labels.slice(start, i).map(Edition.bAnchor).join('');
        out.push(`<div class="block block--risks"><p class="b-anchors">${anchors}</p>${this.riskTable(run)}</div>`);
      } else {
        out.push(`<div class="block block--${blocks[i].type}">${Edition.bAnchor(labels[i])}${this.block(blocks[i], from)}</div>`);
        i += 1;
      }
    }
    return out.join('\n');
  }

  section(section, index, { appendix = false } = {}) {
    const a = ANCHOR.section(section, appendix);
    const from = { anchor: a, label: section.title };
    const num = appendix ? appendixLetter(index) : sectionNumber(index);
    const labels = appendix ? this.numbers.appendices[index] : this.numbers.sections[index];
    const lede = section.lede ? `<p class="lede">${escapeHtml(section.lede)}</p>\n` : '';
    return `<section class="section${appendix ? ' section--appendix' : ''}" id="${escapeAttr(a)}" aria-labelledby="${escapeAttr(a)}-h">
<h2 class="section__head" id="${escapeAttr(a)}-h"><span class="sec-num" aria-hidden="true">${num}</span> <span class="section__title">${appendix ? `Appendix ${num}: ` : ''}${escapeHtml(section.title)}</span></h2>
${lede}${this.numberedBlocks(section.blocks, labels, from)}
</section>`;
  }

  summary() {
    const { report, ctx } = this;
    const from = { anchor: 'summary', label: 'Summary' };
    const v = report.summary.verdict;
    const verdict = `<div class="verdict">
<p class="verdict__label"><span>Verdict</span> ${confidenceChip(v.confidence)}</p>
<p class="verdict__text">${inlineV2(ctx, v.text, from)}</p>
<p class="verdict__ask"><span class="verdict__ask-label">Asked of the reviewer</span> ${escapeHtml(report.metadata.reviewRequest)}</p>
</div>`;
    const figures = report.summary.metrics ? `\n${this.figures(report.summary.metrics.items, from)}` : '';
    const paras = report.summary.paragraphs.map((p, i) => `<div class="block block--paragraph">${Edition.bAnchor(this.numbers.summary[i])}<p class="prose-para">${inlineV2(ctx, p, from)}</p></div>`).join('\n');
    return `<section class="section section--summary" id="summary" aria-labelledby="summary-h">
<h2 class="section__head" id="summary-h"><span class="sec-num" aria-hidden="true">§</span> <span class="section__title">Summary</span></h2>
${verdict}${figures}
${paras}
</section>`;
  }

  evidence() {
    const { report, ctx } = this;
    const items = report.evidence.map((item) => {
      const ev = ctx.evidence.get(item.id);
      const cited = ctx.citedBy.get(item.id) ?? [];
      const citedHtml = cited.length
        ? `Cited by ${cited.map((c) => `<a href="#${escapeAttr(c.anchor)}">${escapeHtml(c.label)}</a>`).join(' · ')}`
        : 'Not cited';
      let body;
      if (item.kind === 'file') {
        const preview = renderEvidencePreview(item.id, ev);
        body = `<p class="ev__meta">${escapeHtml(item.mediaType)} · ${formatBytes(ev.bytes)}</p>
<p class="ev__file"><a href="${escapeAttr(ev.href)}" type="${escapeAttr(item.mediaType)}">${escapeHtml(ev.href)}</a></p>
<p class="ev__digest">SHA-256 <code>${ev.sha256}</code></p>
<p class="ev__cited">${citedHtml}</p>${preview ? `\n<details class="ev__excerpt"><summary>Excerpt</summary>${preview}</details>` : ''}`;
      } else {
        const label = item.kind === 'redacted' ? 'Redacted' : 'Unavailable';
        body = `<p class="ev__withheld"><strong>${label}.</strong> ${escapeHtml(item.reason)} No bytes are included in this packet.</p>
<p class="ev__cited">${citedHtml}</p>`;
      }
      return `<li class="ev ev--${item.kind}" id="${escapeAttr(ANCHOR.evidenceItem(item.id))}"><span class="idx ev__label">${escapeHtml(ev.label)}</span><div class="ev__body">
<p class="ev__title"><strong>${escapeHtml(item.title)}</strong> <span class="ev__id">${escapeHtml(item.id)}</span></p>
${body}
</div></li>`;
    }).join('\n');
    return `<section class="section section--evidence" id="evidence" aria-labelledby="evidence-h">
<h2 class="section__head" id="evidence-h"><span class="sec-num" aria-hidden="true">Ev</span> <span class="section__title">Evidence</span></h2>
<p class="lede">Every claim above resolves to an entry below. Bundled files are content-addressed by SHA-256; withheld items state their reason explicitly.</p>
<ol class="evidence-list">${items}</ol>
</section>`;
  }

  rail() {
    const { report, ctx } = this;
    const entries = [['summary', '§', 'Summary']];
    report.sections.forEach((s, i) => entries.push([ANCHOR.section(s), sectionNumber(i), s.title]));
    entries.push(['evidence', 'Ev', 'Evidence']);
    (report.appendices ?? []).forEach((s, i) => entries.push([ANCHOR.section(s, true), appendixLetter(i), `Appendix ${appendixLetter(i)}: ${s.title}`]));
    const toc = entries.map(([id, num, title]) => `<li><a href="#${escapeAttr(id)}"><span class="rail__num" aria-hidden="true">${escapeHtml(num)}</span> <span>${escapeHtml(title)}</span></a></li>`).join('');
    const ev = report.evidence.map((item) => {
      const e = ctx.evidence.get(item.id);
      const size = item.kind === 'file' ? `<span class="rail__size">${formatBytes(e.bytes)}</span>` : `<span class="rail__size">${item.kind === 'redacted' ? 'Redacted' : 'Unavailable'}</span>`;
      return `<li><a href="#${escapeAttr(ANCHOR.evidenceItem(item.id))}"><span class="idx">${escapeHtml(e.label)}</span> <span class="rail__ev-title">${escapeHtml(item.title)}</span></a>${size}</li>`;
    }).join('');
    return `<aside class="rail" aria-label="On this page">
<nav class="rail__toc" aria-label="Sections"><p class="rail__label" aria-hidden="true">On this page</p><ol>${toc}</ol></nav>
<div class="rail__evidence"><p class="rail__label">Evidence</p><ol>${ev}</ol></div>
</aside>`;
  }

  colophon(sourceSha256, lockups, tool = TOOL) {
    const { report, ctx } = this;
    const prov = report.provenance;
    const sources = prov.sources.map((s) => `<li><strong>${escapeHtml(s.label)}</strong> <span class="colophon__ref">${escapeHtml(s.reference)}</span>${s.revision ? ` <code>${escapeHtml(s.revision)}</code>` : ''}${s.sha256 ? ` <code class="digest">${escapeHtml(s.sha256)}</code>` : ''}</li>`).join('');
    const notes = prov.notes ? `<p class="colophon__notes">${inlineV2(ctx, prov.notes, { anchor: 'provenance', label: 'Colophon' })}</p>` : '';
    return `<footer class="colophon">
<div class="colophon__inner">
<div class="colophon__seal">
<p class="colophon__title">Sealed by Canon</p>
<p class="colophon__label">Report source digest · canonical report/v1 JSON</p>
<p class="colophon__digest" id="source-digest"><code><b>${sourceSha256.slice(0, 8)}</b>${sourceSha256.slice(8)}</code></p>
<p class="colophon__text">This page can’t carry its own content ID. It’s in the address, and in <a href="manifest.json">manifest.json</a> with every file’s length and digest; <a href="checksums.json">checksums.json</a> repeats them. <a href="report.md" type="text/markdown">report.md</a> is generated from the same model and covered by the same ID.</p>
<div class="colophon__provenance" id="provenance">
<p class="colophon__label">Derived from</p>
<ul class="colophon__sources">${sources}</ul>
${notes}</div>
</div>
<div class="colophon__verify">
<p class="colophon__label">Verify this packet</p>
<p class="colophon__cmd"><code>canon verify &lt;packet-dir&gt;</code></p>
<p class="colophon__text">Recomputes every digest and the content ID; exits non-zero on any mismatch, missing or extra file.</p>
</div>
</div>
<div class="colophon__foot">
<p class="colophon__mark${lockups.display ? ' colophon__mark--ruled' : ''}">${lockups.display ?? ''}<span class="visually-hidden">Canon</span></p>
<p class="colophon__gen">${escapeHtml(tool.name)} ${escapeHtml(tool.version)} · ${RENDER_POLICY_2} · ${escapeHtml(tool.securityPolicy)} · zero scripts, zero external requests</p>
</div>
</footer>`;
  }
}

function countBlocks(report, type) {
  return [...report.sections, ...(report.appendices ?? [])].reduce((n, s) => n + s.blocks.filter((b) => b.type === type).length, 0);
}

// `tool` defaults to this build's TOOL; reproduction (src/packet/reproduce.mjs) passes the
// packet's recorded manifest.build values so the generator meta and colophon line match.
export function renderIndexHtmlV2(report, { evidenceIndex, stylesheetHref, sourceSha256, lockups = { ui: null, display: null }, tool = TOOL }) {
  const ed = new Edition(report, evidenceIndex);
  const meta = report.metadata;
  // Summary and sections render first so citations are collected before the evidence
  // list (which shows back-references) and the colophon are rendered.
  const summary = ed.summary();
  const sections = report.sections.map((s, i) => ed.section(s, i)).join('\n');
  const appendices = (report.appendices ?? []).map((s, i) => ed.section(s, i, { appendix: true })).join('\n');
  const colophon = ed.colophon(sourceSha256, lockups, tool);
  const evidence = ed.evidence();
  const counts = [['Findings', countBlocks(report, 'finding')], ['Decisions', countBlocks(report, 'decision')], ['Risks', countBlocks(report, 'risk')], ['Evidence', report.evidence.length]];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CSP_META)}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="${escapeAttr(`${tool.name} ${tool.version}; ${RENDER_POLICY_2}; ${tool.securityPolicy}`)}">
<title>${escapeHtml(report.title)}</title>
<link rel="stylesheet" href="${escapeAttr(stylesheetHref)}">
<link rel="alternate" type="text/markdown" href="report.md" title="Agent-readable report">
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="masthead">
<span class="masthead__brand">${lockups.ui ?? ''}<span class="visually-hidden">Canon</span></span>
<span class="masthead__slug">${escapeHtml(report.id)}</span>
<nav class="formats" aria-label="Edition formats"><a href="index.html" aria-current="page">index.html</a><a href="report.md" type="text/markdown">report.md</a><a href="manifest.json" type="application/json">manifest.json</a></nav>
</header>
<div class="layout">
<main id="content" class="document">
<header class="title-block">
<p class="kicker"><span class="kicker__kind">${escapeHtml(meta.classification)}</span> <span class="stamp">${STATUS_LABEL[meta.status]}</span></p>
<h1>${escapeHtml(report.title)}</h1>
${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>\n` : ''}</header>
<dl class="meta-strip">
<div class="meta-strip__cell"><dt>Prepared by</dt><dd>${meta.authors.map(escapeHtml).join(', ')}</dd></div>
<div class="meta-strip__cell"><dt>Review date</dt><dd class="mono">${escapeHtml(meta.reviewDate)} · ${escapeHtml(report.schema)}</dd></div>
<div class="meta-strip__cell"><dt>Source digest</dt><dd class="mono"><a href="#source-digest">${sourceSha256.slice(0, 8)}</a></dd></div>
${counts.map(([label, n]) => `<div class="meta-strip__count"><dt>${label}</dt><dd>${n}</dd></div>`).join('\n')}
</dl>
${summary}
${sections}
${evidence}
${appendices}
</main>
${ed.rail()}
</div>
${colophon}
</body>
</html>
`;
}
