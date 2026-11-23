// site-input/v1 -> multi-page static HTML (docs/projects/interactive-sitrep-contract.md, revision 4).
// All authored strings pass through escapeHtml / escapeAttr; no scripts, forms, controls,
// inline styles, or external runtime requests are ever emitted.
import { CSP_META, TOOL } from '../policy.mjs';
import { anchor as ANCHOR, siteAnchor } from '../render/anchors.mjs';
import { escapeAttr, escapeHtml } from '../render/escape.mjs';
import { renderEvidencePreview } from '../render/evidence-preview.mjs';
import { RenderContext, evidenceRefs, inline, renderBlocksWithGrids } from '../render/html.mjs';
import { clampSvgPx, estSvgPx } from '../render/svg-chart.mjs';
import { UNASSIGNED_TITLE, pageFiles, pageId, relativeHref, siteAnchors, sitePages } from './manifest.mjs';
import { UNASSIGNED_AREA } from './validate.mjs';

function classifyAgeTone(age) {
  const s = String(age ?? '').trim().toLowerCase();
  if (/^(?:blocked|stalled|overdue)\b/.test(s)) return 'age-pill age-pill--blocked';
  if (/^(?:waiting|pending|queued)\b/.test(s)) return 'age-pill age-pill--waiting';
  if (/^(?:moved|shipped|done|resolved|merged|closed)\b/.test(s)) return 'age-pill age-pill--moved';
  return '';
}

function renderAgeBadge(age) {
  const tone = classifyAgeTone(age);
  return `<span class="item__id${tone ? ` ${tone}` : ''}">${escapeHtml(age)}</span>`;
}

function renderCoveragePill(coverage) {
  return `<span class="cov-pill cov-pill--${escapeAttr(coverage)}">${escapeHtml(coverage)}</span>`;
}

function renderMetricValue(value, coverage) {
  if (value === null) {
    return '<span class="metric__value metric__value--null">not recorded</span>';
  }
  const text = coverage === 'partial' ? `${value} (partial)` : String(value);
  const mod = coverage === 'partial' ? ' metric__value--partial' : '';
  return `<span class="metric__value${mod}">${escapeHtml(text)}</span>`;
}

function buildAnchorLabelMap(input) {
  const labels = new Map();
  const walkBlocks = (blocks) => {
    for (const b of blocks ?? []) {
      if (b.type === 'finding') labels.set(ANCHOR.finding(b), `Finding ${b.id}`);
      else if (b.type === 'risk') labels.set(ANCHOR.risk(b), `Risk ${b.id}`);
      else if (b.type === 'requirement') labels.set(ANCHOR.requirement(b), `Requirement ${b.id}`);
      else if (b.type === 'comparison') labels.set(ANCHOR.comparison(b), b.title);
      else if (b.type === 'chart') labels.set(ANCHOR.chart(b), b.title);
      else if (b.type === 'diagram') labels.set(ANCHOR.diagram(b), b.title);
      if (Array.isArray(b.detail)) walkBlocks(b.detail);
    }
  };
  for (const item of input.items) {
    labels.set(siteAnchor.item(item.itemRef), item.title);
    walkBlocks(item.blocks);
  }
  for (const dec of input.decisions) {
    labels.set(siteAnchor.decision(dec.decisionRef), `Decision ${dec.decisionRef}`);
    for (const q of dec.questions) {
      labels.set(siteAnchor.question(q.questionRef), `${dec.decisionRef}/${q.questionRef}`);
    }
  }
  return labels;
}

function makeLookups(input, anchors, evidenceIndex, currentFile, currentPageId) {
  const anchorPage = new Map(anchors.map((a) => [a.anchor, a.page]));
  const anchorLabels = buildAnchorLabelMap(input);
  const gapByRef = new Map(input.gaps.map((g) => [g.gapRef, g]));
  const hrefToAnchor = (targetAnchor) => {
    const ownerPage = anchorPage.get(targetAnchor) ?? pageId.portfolio();
    if (ownerPage === currentPageId) return `#${targetAnchor}`;
    return `${relativeHref(currentFile, pageFiles(ownerPage).html)}#${targetAnchor}`;
  };
  const ctx = new RenderContext(
    input,
    evidenceIndex,
    { evidenceHref: (id) => hrefToAnchor(ANCHOR.evidenceItem(id)) },
  );
  const gapHref = (gapRef) => hrefToAnchor(siteAnchor.gap(gapRef));
  const pageHref = (targetPageId) => relativeHref(currentFile, pageFiles(targetPageId).html);
  const ownedGaps = anchors
    .filter((a) => a.page === currentPageId && a.kind === 'gap')
    .map((a) => gapByRef.get(a.anchor.slice(2)));
  const ownedEvidence = anchors
    .filter((a) => a.page === currentPageId && a.kind === 'evidence')
    .map((a) => input.evidence.find((e) => ANCHOR.evidenceItem(e.id) === a.anchor));
  return { ctx, gapByRef, gapHref, pageHref, hrefToAnchor, anchorLabels, ownedGaps, ownedEvidence };
}

function renderCountsSummary(counts, { gapHref, gapByRef }) {
  const { waiting, moved, blocked, coverage, gapRefs, unit } = counts;
  const gapLinks = gapRefs.length
    ? ` (${gapRefs.map((ref) => `<a href="${escapeAttr(gapHref(ref))}">${escapeHtml(gapByRef.get(ref)?.gapRef ?? ref)}</a>`).join(', ')})`
    : '';
  const covNote = coverage === 'unavailable'
    ? `<p class="claim"><strong>Coverage unavailable.</strong> Counts were not recorded for this area${gapLinks}.</p>`
    : coverage === 'partial'
      ? `<p class="claim"><strong>Partial coverage.</strong> Recorded numbers reflect only partial reading${gapLinks}.</p>`
      : '';
  return `<dl class="metrics">
<div><dt>Waiting</dt><dd>${renderMetricValue(waiting, coverage)}</dd></div>
<div><dt>Moved</dt><dd>${renderMetricValue(moved, coverage)}</dd></div>
<div><dt>Blocked</dt><dd>${renderMetricValue(blocked, coverage)}</dd></div>
<div><dt>Coverage</dt><dd><span class="metric__value">${escapeHtml(coverage)}</span></dd></div>
<div><dt>Unit</dt><dd><span class="metric__unit">${escapeHtml(unit)}</span></dd></div>
</dl>${covNote}`;
}

function renderGapsSection(ownedGaps) {
  if (!ownedGaps.length) return '';
  const rows = ownedGaps.map((gap) => {
    const id = siteAnchor.gap(gap.gapRef);
    return `<li class="ev" id="${escapeAttr(id)}"><p class="ev__title"><span class="ev-label">${escapeHtml(gap.kind)}</span> <strong>${escapeHtml(gap.gapRef)}</strong></p>
<p>${escapeHtml(gap.text)}</p></li>`;
  }).join('\n');
  return `<section class="section" aria-label="Explicit gaps">
<h2><span class="sec-num" aria-hidden="true">Gp</span> Explicit gaps</h2>
<ol class="evidence-list">${rows}</ol>
</section>`;
}

function renderPageEvidenceSection(ownedEvidence, lookups, currentFile) {
  if (!ownedEvidence.length) return '';
  const { ctx, hrefToAnchor, anchorLabels } = lookups;
  const items = ownedEvidence.map((item) => {
    const ev = ctx.evidence.get(item.id);
    const citedAnchors = ev?.citedBy ?? [];
    const citedHtml = citedAnchors.length
      ? `<p class="ev__cited"><span class="field-label">Cited by</span> ${citedAnchors.map((a) => `<a href="${escapeAttr(hrefToAnchor(a))}">${escapeHtml(anchorLabels.get(a) ?? a)}</a>`).join(' · ')}</p>`
      : '<p class="ev__cited"><span class="field-label">Cited by</span> not cited</p>';
    let body;
    if (item.kind === 'file') {
      const fileHref = relativeHref(currentFile, ev.href);
      const preview = renderEvidencePreview(item.id, ev);
      body = `<div class="ev__meta-row"><p class="ev__file"><a href="${escapeAttr(fileHref)}" type="${escapeAttr(item.mediaType)}">${escapeHtml(ev.href)}</a> <span class="ev__meta">${escapeHtml(item.mediaType)} · ${ev.bytes} bytes</span></p>
<p class="ev__digest"><span class="field-label">SHA-256</span> <code>${ev.sha256}</code></p></div>${preview}`;
    } else {
      const label = item.kind === 'redacted' ? 'Redacted' : 'Unavailable';
      body = `<p class="ev__withheld"><strong>${label}.</strong> ${escapeHtml(item.reason)} No bytes are included in this bundle.</p>`;
    }
    return `<li class="ev ev--${item.kind}" id="${escapeAttr(ANCHOR.evidenceItem(item.id))}"><div class="ev__head"><p class="ev__title"><span class="ev-label">${escapeHtml(ev.label)}</span> <strong>${escapeHtml(item.title)}</strong></p><span class="item__id">${escapeHtml(item.id)}</span></div>
${body}
${citedHtml}</li>`;
  }).join('\n');
  return `<section class="section" aria-label="Evidence">
<h2><span class="sec-num" aria-hidden="true">Ev</span> Evidence</h2>
<ol class="evidence-list">${items}</ol>
</section>`;
}

function plainInlineString(val, input = null) {
  if (typeof val === 'string') return val.replace(/[\u200B\s]+/g, ' ');
  if (!Array.isArray(val)) return '';
  return val
    .map((seg) => {
      if (typeof seg === 'string') return seg;
      if (!seg || typeof seg !== 'object') return '';
      if (typeof seg.text === 'string') return seg.text;
      if (typeof seg.code === 'string') return seg.code;
      if (typeof seg.em === 'string') return seg.em;
      if (typeof seg.strong === 'string') return seg.strong;
      if (seg.link && typeof seg.link.text === 'string') return seg.link.text;
      if (typeof seg.cite === 'string' && Array.isArray(input?.evidence)) {
        const idx = input.evidence.findIndex((e) => e.id === seg.cite);
        return idx >= 0 ? `[E${idx + 1}]` : '';
      }
      return '';
    })
    .join('')
    .replace(/[\u200B\s]+/g, ' ');
}

function isRedundantOptionSummary(opt) {
  if (Array.isArray(opt.summary) && opt.summary.some((seg) => seg && typeof seg === 'object' && !Object.hasOwn(seg, 'text'))) {
    return false;
  }
  const s = plainInlineString(opt.summary).trim();
  if (!s) return true;
  if (/^response code:\s*\S+$/i.test(s)) return true;
  if (s.toLowerCase() === String(opt.label ?? '').trim().toLowerCase()) return true;
  return false;
}

function renderQuestion(question, decision, ctx, qIndex = 0, qTotal = 1, itemTitle = '') {
  const qAnchor = siteAnchor.question(question.questionRef);
  const from = { anchor: qAnchor, label: `${decision.decisionRef}/${question.questionRef}` };
  const options = question.options.map((opt) => {
    const isRec = question.recommendation.optionRef === opt.optionRef;
    const recBadge = isRec ? ' <span class="chosen">Recommended</span>' : '';
    const bodyHtml = isRedundantOptionSummary(opt)
      ? ''
      : `<div class="alt__body">${inline(ctx, opt.summary, from)}</div>`;
    return `<li class="alt${isRec ? ' alt--chosen' : ''}"><div class="alt__head"><code class="opt-key">${escapeHtml(opt.optionRef)}</code> <strong>${escapeHtml(opt.label)}</strong>${recBadge}</div>${bodyHtml}</li>`;
  }).join('\n');
  const freeTextNote = question.freeText.allowed
    ? `<p class="claim question__freetext"><span class="field-label">Free-text response</span> Allowed (up to ${question.freeText.maxChars} characters).</p>`
    : '<p class="claim question__freetext"><span class="field-label">Free-text response</span> Not allowed (select one of the named options).</p>';
  const recChoice = question.recommendation.optionRef
    ? ` (<code class="opt-key">${escapeHtml(question.recommendation.optionRef)}</code>)`
    : '';
  const hasExplicitRec = Boolean(question.recommendation.optionRef)
    || !/^no explicit recommendation/i.test(plainInlineString(question.recommendation.text).trim());
  const recAttr = hasExplicitRec ? '' : ' data-rec="none"';
  const evHtml = (question.evidence ?? []).length
    ? `<div class="support question__evidence"><span class="field-label">Supporting evidence</span> <ul class="ev-refs" aria-label="Supporting evidence">${evidenceRefs(ctx, question.evidence, from)}</ul></div>`
    : '';
  const qBadge = qTotal > 1 ? `Question ${qIndex + 1} of ${qTotal} · ${question.questionRef}` : question.questionRef;
  const echoesTitle = qTotal === 1
    && question.options.length === 0
    && itemTitle
    && normalizeTitleForCompare(question.text) === normalizeTitleForCompare(itemTitle);
  const promptHtml = echoesTitle
    ? `<span class="visually-hidden">${escapeHtml(question.text)} </span>${decision.kind === 'close-candidate' ? 'Confirm close disposition or override' : 'Confirm or override this item'}`
    : escapeHtml(question.text);
  return `<section class="question" id="${escapeAttr(qAnchor)}" aria-label="${escapeAttr(question.text)}">
<div class="question__bar"><h4 class="question__prompt">${promptHtml}</h4><span class="item__id question__ref">${escapeHtml(qBadge)}</span></div>
<div class="support question__options"><span class="field-label">Options</span>
<ul class="alternatives" aria-label="Options">${options}</ul>
${freeTextNote}</div>
<div class="question__footer">
<p class="claim question__recommendation"${recAttr}><span class="field-label">Recommendation${recChoice}</span> ${inline(ctx, question.recommendation.text, from)}</p>
${evHtml}
</div>
</section>`;
}

function normalizeTitleForCompare(str) {
  return String(str ?? '')
    .replace(/^(?:\[[^\]]+\]\s*(?:[DC]\d+:\s*)?|[A-Za-z0-9_-]+:\s*)/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function renderSiteDecision(decision, ctx, itemTitle = '') {
  const dAnchor = siteAnchor.decision(decision.decisionRef);
  const questions = decision.questions.map((q, idx) => renderQuestion(q, decision, ctx, idx, decision.questions.length, itemTitle)).join('\n');
  const isClose = decision.kind === 'close-candidate';
  const echoesPageTitle = itemTitle && normalizeTitleForCompare(decision.label) === normalizeTitleForCompare(itemTitle);
  const headingClass = echoesPageTitle ? ' class="visually-hidden"' : '';
  return `<article class="decision ${isClose ? 'decision--close' : 'decision--needed'}" id="${escapeAttr(dAnchor)}" aria-label="${escapeAttr(decision.label)}">
<header class="item__head"><p class="labels"><span class="dec ${isClose ? 'conf-open' : 'dec-needed'}">${escapeHtml(decision.kind)}</span><span class="item__id">Decision ${escapeHtml(decision.decisionRef)}</span></p>
<h3${headingClass}>${escapeHtml(decision.label)}</h3></header>
${questions}
</article>`;
}

function resolveItemScopeLabel(item, input) {
  if (!item || !input) return '';
  if (item.areaRef === null) return 'Unassigned';
  const area = input.areas.find((a) => a.areaRef === item.areaRef);
  if (!area) return item.areaRef;
  if (item.projectRef) {
    const proj = area.projects.find((p) => p.projectRef === item.projectRef);
    if (proj) return proj.title;
  }
  return area.title;
}

function renderItemLinksList(items, input, pageHref, emptyText = 'No items in this area.') {
  if (!items.length) return `<p>${escapeHtml(emptyText)}</p>`;
  const closeItemRefs = new Set(
    input.decisions.filter((d) => d.kind === 'close-candidate').map((d) => d.itemRef),
  );
  const activeItems = items.filter((i) => !closeItemRefs.has(i.itemRef));
  const closeItems = items.filter((i) => closeItemRefs.has(i.itemRef));
  const renderRows = (list) => `<ul class="list item-links">${list.map((item) => `<li><a href="${escapeAttr(pageHref(pageId.item(item.itemRef)))}">${escapeHtml(item.title)}</a> ${renderAgeBadge(item.age)}</li>`).join('')}</ul>`;

  const activeHtml = activeItems.length
    ? `<div class="support"><p class="field-label">Active decisions &amp; items (${activeItems.length})</p>${renderRows(activeItems)}</div>`
    : '';
  const closeHtml = closeItems.length
    ? `<details class="legend"><summary>Aged close candidates (${closeItems.length})</summary>${renderRows(closeItems)}</details>`
    : '';
  return [activeHtml, closeHtml].filter(Boolean).join('\n');
}

function renderAreaProjectsBreakdownTable(area, areaItems, input, pageHref) {
  if (!area.projects.length) return '';
  const closeItemRefs = new Set(
    input.decisions.filter((d) => d.kind === 'close-candidate').map((d) => d.itemRef),
  );
  const rows = area.projects.map((p) => {
    const pItems = areaItems.filter((i) => i.projectRef === p.projectRef);
    const activeCount = pItems.filter((i) => !closeItemRefs.has(i.itemRef)).length;
    const closeCount = pItems.filter((i) => closeItemRefs.has(i.itemRef)).length;
    const pHref = pageHref(pageId.project(area.areaRef, p.projectRef));
    const showRef = p.title.toLowerCase().replace(/[^a-z0-9]/g, '') !== p.projectRef.toLowerCase().replace(/[^a-z0-9]/g, '');
    const refSpan = showRef ? ` <span class="item__id">${escapeHtml(p.projectRef)}</span>` : '';
    return `<tr><th scope="row"><a href="${escapeAttr(pHref)}">${escapeHtml(p.title)}</a>${refSpan}</th><td class="num">${activeCount}</td><td class="num">${closeCount}</td><td class="num">${pItems.length}</td></tr>`;
  }).join('\n');
  const capId = `proj-cap-${area.areaRef}`;
  return `<div class="table"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(capId)}"><table class="table--counts">
<caption id="${escapeAttr(capId)}">Project breakdown (${area.projects.length})</caption>
<thead><tr><th scope="col">Project</th><th scope="col" class="num">Active</th><th scope="col" class="num">Aged close</th><th scope="col" class="num">Total</th></tr></thead>
<tbody>${rows}</tbody>
</table></div></div>`;
}

function renderDecisionTriageRow(d, itemByRef, pageHref, { input = null, showScope = false } = {}) {
  const item = itemByRef.get(d.itemRef);
  const itemHref = `${pageHref(pageId.item(d.itemRef))}#${siteAnchor.decision(d.decisionRef)}`;
  const ageText = item ? item.age : '';
  const scopeLabel = showScope ? resolveItemScopeLabel(item, input) : '';
  const scopeHtml = scopeLabel ? ` <span class="triage-scope">${escapeHtml(scopeLabel)}</span>` : '';
  const q0 = d.questions[0];
  let recBadge = '—';
  if (q0) {
    const chosenOpt = q0.options.find((o) => o.optionRef === q0.recommendation.optionRef);
    if (chosenOpt) {
      recBadge = `<code class="opt-key">${escapeHtml(chosenOpt.optionRef)}</code> ${escapeHtml(chosenOpt.label)}`;
    } else {
      const plainRec = plainInlineString(q0.recommendation?.text, input).trim();
      if (plainRec && !/^no explicit recommendation/i.test(plainRec)) {
        const recCps = Array.from(plainRec);
        recBadge = escapeHtml(recCps.length > 90 ? `${recCps.slice(0, 87).join('').trim()}…` : plainRec);
      } else if (q0.options.length >= 2) {
        const codes = q0.options.slice(0, 4).map((o) => `<code class="opt-key">${escapeHtml(o.optionRef)}</code>`).join(' / ');
        recBadge = `<span class="item__id">Choose ${codes}${d.questions.length > 1 ? ` (${d.questions.length} questions)` : ''}</span>`;
      } else if (q0.freeText?.allowed) {
        recBadge = `<span class="item__id">Free-text reply${d.questions.length > 1 ? ` (${d.questions.length} questions)` : ''}</span>`;
      }
    }
  }
  return `<tr><th scope="row"><a href="${escapeAttr(itemHref)}">${escapeHtml(d.label)}</a>${scopeHtml}</th><td>${recBadge}</td><td class="num">${renderAgeBadge(ageText)}</td></tr>`;
}

function renderPortfolioPulse(input) {
  const activeDecisions = input.decisions.filter((d) => d.kind !== 'close-candidate').length;
  const closeDecisions = input.decisions.filter((d) => d.kind === 'close-candidate').length;
  let moved = 0;
  let waiting = 0;
  let blocked = 0;
  let completeAreas = 0;
  let totalProjects = 0;
  for (const area of input.areas) {
    totalProjects += area.projects.length;
    if (area.counts.coverage === 'complete') completeAreas += 1;
    if (typeof area.counts.moved === 'number') moved += area.counts.moved;
    if (typeof area.counts.waiting === 'number') waiting += area.counts.waiting;
    if (typeof area.counts.blocked === 'number') blocked += area.counts.blocked;
  }
  const hasIncomplete = completeAreas < input.areas.length;
  const unassignedCount = input.items.filter((i) => i.areaRef === null).length;
  return `<div class="sitrep-pulse" role="region" aria-label="Portfolio executive pulse">
<div class="sitrep-pulse__cell">
  <span class="sitrep-pulse__label">Active decisions</span>
  <strong class="sitrep-pulse__value">${activeDecisions}</strong>
  <span class="sitrep-pulse__sub">${closeDecisions ? `${closeDecisions} aged close queued` : 'awaiting sign-off'}</span>
</div>
<div class="sitrep-pulse__cell">
  <span class="sitrep-pulse__label">Recorded velocity</span>
  <strong class="sitrep-pulse__value">${moved} moved</strong>
  <span class="sitrep-pulse__sub">${waiting} waiting · ${blocked} blocked${hasIncomplete ? ' (partial)' : ''}</span>
</div>
<div class="sitrep-pulse__cell">
  <span class="sitrep-pulse__label">Tracked surface</span>
  <strong class="sitrep-pulse__value">${input.items.length} items</strong>
  <span class="sitrep-pulse__sub">${input.areas.length} areas · ${totalProjects} projects${unassignedCount ? ` · ${unassignedCount} unmapped` : ''}</span>
</div>
<div class="sitrep-pulse__cell">
  <span class="sitrep-pulse__label">Telemetry &amp; gaps</span>
  <strong class="sitrep-pulse__value">${completeAreas}/${input.areas.length} complete</strong>
  <span class="sitrep-pulse__sub">${input.gaps.length} explicit gap${input.gaps.length === 1 ? '' : 's'} surfaced</span>
</div>
</div>`;
}

function computeSitrepBarSegments(m, w, b, maxTotal, plotW = 356) {
  const vals = [m, w, b];
  const raw = vals.map((v) => (v > 0 ? Number(((v / maxTotal) * plotW).toFixed(2)) : 0));
  const MIN_W = 2;
  if (vals.every((v, i) => v === 0 || raw[i] >= MIN_W)) {
    return raw;
  }
  const total = m + w + b;
  const targetBarW = Math.min(plotW, Math.max(
    vals.filter((v) => v > 0).length * MIN_W,
    Number(((total / maxTotal) * plotW).toFixed(2)),
  ));
  let fixedW = 0;
  let flexSum = 0;
  const clamped = [false, false, false];
  for (let pass = 0; pass < 3; pass += 1) {
    fixedW = 0;
    flexSum = 0;
    for (let i = 0; i < 3; i += 1) {
      if (vals[i] <= 0) continue;
      if (clamped[i]) fixedW += MIN_W;
      else flexSum += vals[i];
    }
    const remW = Math.max(0, targetBarW - fixedW);
    let changed = false;
    for (let i = 0; i < 3; i += 1) {
      if (vals[i] > 0 && !clamped[i] && flexSum > 0 && (vals[i] / flexSum) * remW < MIN_W) {
        clamped[i] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const remW = Math.max(0, targetBarW - fixedW);
  return vals.map((v, i) => {
    if (v <= 0) return 0;
    if (clamped[i] || flexSum <= 0) return MIN_W;
    return Math.max(MIN_W, Number(((v / flexSum) * remW).toFixed(2)));
  });
}

function renderPortfolioAreaChart(input) {
  if (!input.areas.length) return '';
  const leftPad = 204;
  const plotW = 356;
  const rowH = 34;
  const topPad = 40;
  const bottomPad = 14;

  const rowsData = input.areas.map((area) => {
    const c = area.counts;
    if (c.coverage === 'unavailable') {
      return { title: area.title, unavailable: true, m: 0, w: 0, b: 0, total: 0, summary: 'telemetry unavailable' };
    }
    const m = c.moved ?? 0;
    const w = c.waiting ?? 0;
    const b = c.blocked ?? 0;
    const bLabel = c.blocked === null ? '—B' : `${b}B`;
    const qual = c.coverage === 'partial' ? ' (partial)' : '';
    return {
      title: area.title,
      unavailable: false,
      m,
      w,
      b,
      total: m + w + b,
      summary: `${m}M · ${w}W · ${bLabel}${qual}`,
    };
  });

  const maxTotal = Math.max(1, ...rowsData.map((r) => r.total));
  const summaryTexts = rowsData.map((r) => clampSvgPx(r.summary, 210, 10.5, { mono: true }));
  const maxSummaryW = Math.max(140, ...summaryTexts.map((t) => estSvgPx(t, 10.5, { mono: true })));
  const rightPad = maxSummaryW + 28;
  const svgW = leftPad + plotW + rightPad;
  const svgH = topPad + rowsData.length * rowH + bottomPad;

  const svgRows = rowsData.map((r, idx) => {
    const y = topPad + idx * rowH;
    const barY = y + 7;
    const barH = 14;
    const textY = y + 18;
    const labelText = clampSvgPx(r.title, leftPad - 24, 11.5);
    const sumText = summaryTexts[idx];

    if (r.unavailable) {
      return `<g>
  <text x="12" y="${textY}" class="svg-row-label">${escapeHtml(labelText)}</text>
  <rect x="${leftPad}" y="${barY}" width="${plotW}" height="${barH}" rx="3" class="svg-area-unavail"/>
  <text x="${leftPad + plotW + 12}" y="${textY}" class="svg-axis-label">${escapeHtml(sumText)}</text>
</g>`;
    }

    const [wMoved, wWait, wBlock] = computeSitrepBarSegments(r.m, r.w, r.b, maxTotal, plotW);
    const xWait = Number((leftPad + wMoved).toFixed(2));
    const xBlock = Number((xWait + wWait).toFixed(2));

    const segs = [
      `<rect x="${leftPad}" y="${barY}" width="${plotW}" height="${barH}" rx="3" class="bar__track"/>`,
      wMoved > 0 ? `<rect x="${leftPad}" y="${barY}" width="${wMoved}" height="${barH}" rx="2" class="svg-seg-moved"/>` : '',
      wWait > 0 ? `<rect x="${xWait}" y="${barY}" width="${wWait}" height="${barH}" rx="2" class="bar__candidate"/>` : '',
      wBlock > 0 ? `<rect x="${xBlock}" y="${barY}" width="${wBlock}" height="${barH}" rx="2" class="svg-seg-blocked"/>` : '',
    ].filter(Boolean).join('');

    return `<g>
  <text x="12" y="${textY}" class="svg-row-label">${escapeHtml(labelText)}</text>
  ${segs}
  <text x="${leftPad + plotW + 12}" y="${textY}" class="svg-delta ${r.b > 0 ? 'svg-delta--warn' : 'svg-delta--good'}">${escapeHtml(sumText)}</text>
</g>`;
  }).join('\n');

  return `<figure class="figure sitrep-area-chart" aria-label="Cross-area workload breakdown">
<figcaption><strong>Cross-area workload &amp; telemetry balance</strong><span>Stacked workstream volume across areas (Moved, Waiting, Blocked) with explicit telemetry gaps.</span></figcaption>
<div class="diagram-canvas">
<svg class="svg-graphic" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="Cross-area workload breakdown">
  <rect x="12" y="10" width="10" height="10" rx="2" class="svg-seg-moved"/>
  <text x="27" y="19" class="svg-axis-label">Moved</text>
  <rect x="86" y="10" width="10" height="10" rx="2" class="bar__candidate"/>
  <text x="101" y="19" class="svg-axis-label">Waiting</text>
  <rect x="168" y="10" width="10" height="10" rx="2" class="svg-seg-blocked"/>
  <text x="183" y="19" class="svg-axis-label">Blocked</text>
  <rect x="252" y="10" width="14" height="10" rx="2" class="svg-area-unavail"/>
  <text x="272" y="19" class="svg-axis-label">Unavailable</text>
  ${svgRows}
</svg>
</div>
</figure>`;
}

function renderPortfolioTriageSection(input, pageHref) {
  if (!input.decisions.length) return '';
  const itemByRef = new Map(input.items.map((i) => [i.itemRef, i]));
  const activeDecisions = input.decisions.filter((d) => d.kind !== 'close-candidate');
  const closeCandidates = input.decisions.filter((d) => d.kind === 'close-candidate');

  const activeTable = activeDecisions.length
    ? `<div class="table"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="triage-active-cap"><table class="table--triage">
<caption id="triage-active-cap">Active decisions waiting on you (${activeDecisions.length})</caption>
<thead><tr><th scope="col">Decision</th><th scope="col">Recommended call</th><th scope="col" class="num">Age</th></tr></thead>
<tbody>${activeDecisions.map((d) => renderDecisionTriageRow(d, itemByRef, pageHref, { input, showScope: true })).join('\n')}</tbody>
</table></div></div>`
    : '<p>No active decisions waiting.</p>';

  const closeDrawer = closeCandidates.length
    ? `<details class="legend"><summary>Aged close candidates &amp; hygiene (${closeCandidates.length})</summary>
<ul class="list item-links">${closeCandidates.map((d) => {
  const itemHref = `${pageHref(pageId.item(d.itemRef))}#${siteAnchor.decision(d.decisionRef)}`;
  const item = itemByRef.get(d.itemRef);
  const scopeLabel = resolveItemScopeLabel(item, input);
  const scopeHtml = scopeLabel ? ` <span class="triage-scope">${escapeHtml(scopeLabel)}</span>` : '';
  return `<li><span><a href="${escapeAttr(itemHref)}">${escapeHtml(d.label)}</a>${scopeHtml}</span> ${item ? renderAgeBadge(item.age) : `<span class="item__id">${escapeHtml(d.decisionRef)}</span>`}</li>`;
}).join('')}</ul></details>`
    : '';

  return `<section class="section" aria-label="Open decisions">
<h2><span class="sec-num" aria-hidden="true">Dc</span> Decision triage queue</h2>
${activeTable}
${closeDrawer}
</section>`;
}

function renderPortfolioMain(input, lookups) {
  const { pageHref, gapHref, gapByRef, ownedGaps, ownedEvidence } = lookups;
  const areaCards = input.areas.map((area) => {
    const areaPageId = pageId.area(area.areaRef);
    const items = input.items.filter((i) => i.areaRef === area.areaRef);
    return `<article class="finding area-card area-card--${escapeAttr(area.counts.coverage)}">
<h3><span><a href="${escapeAttr(pageHref(areaPageId))}">${escapeHtml(area.title)}</a> <span class="item__id">${escapeHtml(area.areaRef)}</span></span> ${renderCoveragePill(area.counts.coverage)}</h3>
${renderCountsSummary(area.counts, { gapHref, gapByRef })}
${renderAreaProjectsBreakdownTable(area, items, input, pageHref)}
${renderItemLinksList(items, input, pageHref, 'No items in this area.')}
</article>`;
  }).join('\n');

  const unassignedItems = input.items.filter((i) => i.areaRef === null);
  const unassignedCard = unassignedItems.length
    ? `<article class="finding area-card area-card--partial">
<h3><a href="${escapeAttr(pageHref(pageId.area(UNASSIGNED_AREA)))}">${escapeHtml(UNASSIGNED_TITLE)}</a></h3>
${renderItemLinksList(unassignedItems, input, pageHref, 'No unassigned items.')}
</article>`
    : '';

  const pulseStrip = renderPortfolioPulse(input);
  const decisionQueue = renderPortfolioTriageSection(input, pageHref);
  const areaChart = renderPortfolioAreaChart(input);

  const historySection = input.history?.length
    ? `<section class="section" aria-label="Prior editions">
<h2><span class="sec-num" aria-hidden="true">Hi</span> Prior editions</h2>
<ul class="list">${input.history.map((h) => `<li><a href="${escapeAttr(`../${h.contentId}/index.html`)}">${escapeHtml(h.editionId)}</a> · observed ${escapeHtml(h.observedAt)} · <code>${escapeHtml(h.contentId)}</code></li>`).join('')}</ul>
</section>`
    : '';

  return `${pulseStrip}
${decisionQueue}
<section class="section" aria-label="Areas">
<h2><span class="sec-num" aria-hidden="true">01</span> Areas</h2>
${areaChart}
${areaCards}
${unassignedCard}
</section>
${historySection}
${renderGapsSection(ownedGaps)}
${renderPageEvidenceSection(ownedEvidence, lookups, 'index.html')}`;
}

function renderAreaMain(area, input, currentFile, lookups) {
  const { pageHref, gapHref, gapByRef, ownedGaps, ownedEvidence } = lookups;
  const aAnchor = siteAnchor.area(area.areaRef);
  const items = input.items.filter((i) => i.areaRef === area.areaRef);
  const projectsHtml = area.projects.length
    ? `<section class="section" aria-label="Projects">
<h2><span class="sec-num" aria-hidden="true">Pr</span> Projects</h2>
${renderAreaProjectsBreakdownTable(area, items, input, pageHref)}
</section>`
    : '';
  const itemsHtml = `<section class="section" aria-label="Items in this area">
<h2><span class="sec-num" aria-hidden="true">It</span> Items in this area</h2>
${renderItemLinksList(items, input, pageHref, 'No items recorded in this area.')}
</section>`;

  return `<section class="section" id="${escapeAttr(aAnchor)}" aria-label="${escapeAttr(area.title)}">
<h2><span class="sec-num" aria-hidden="true">Ar</span> Area summary</h2>
${renderCountsSummary(area.counts, { gapHref, gapByRef })}
</section>
${projectsHtml}
${itemsHtml}
${renderGapsSection(ownedGaps)}
${renderPageEvidenceSection(ownedEvidence, lookups, currentFile)}`;
}

function renderUnassignedAreaMain(input, currentFile, lookups) {
  const { pageHref, ownedGaps, ownedEvidence } = lookups;
  const aAnchor = siteAnchor.area(UNASSIGNED_AREA);
  const items = input.items.filter((i) => i.areaRef === null);
  return `<section class="section" id="${escapeAttr(aAnchor)}" aria-label="${escapeAttr(UNASSIGNED_TITLE)}">
<h2><span class="sec-num" aria-hidden="true">Ar</span> Unassigned items</h2>
<p class="lede">These items name no area in the registry and remain visible until mapped.</p>
${renderItemLinksList(items, input, pageHref)}
</section>
${renderGapsSection(ownedGaps)}
${renderPageEvidenceSection(ownedEvidence, lookups, currentFile)}`;
}

function renderProjectMain(area, project, input, currentFile, lookups) {
  const { pageHref, ownedGaps, ownedEvidence } = lookups;
  const items = input.items.filter((i) => i.areaRef === area.areaRef && i.projectRef === project.projectRef);
  const projectItemRefs = new Set(items.map((i) => i.itemRef));
  const projectDecisions = input.decisions.filter((d) => projectItemRefs.has(d.itemRef));
  const decisionItemRefs = new Set(projectDecisions.map((d) => d.itemRef));
  const nonDecisionItems = items.filter((i) => !decisionItemRefs.has(i.itemRef));
  const itemByRef = new Map(items.map((i) => [i.itemRef, i]));
  const activeDecisions = projectDecisions.filter((d) => d.kind !== 'close-candidate');
  const closeDecisions = projectDecisions.filter((d) => d.kind === 'close-candidate');

  const decisionsTable = activeDecisions.length
    ? `<div class="table"><div class="table__scroll" tabindex="0" role="region" aria-labelledby="proj-dec-cap"><table class="table--triage">
<caption id="proj-dec-cap">Active decisions in ${escapeHtml(project.title)} (${activeDecisions.length})</caption>
<thead><tr><th scope="col">Decision</th><th scope="col">Recommended call</th><th scope="col" class="num">Age</th></tr></thead>
<tbody>${activeDecisions.map((d) => renderDecisionTriageRow(d, itemByRef, pageHref, { input })).join('\n')}</tbody>
</table></div></div>`
    : '';
  const openAttr = items.length <= 8 ? ' open' : '';
  const closeDrawer = closeDecisions.length
    ? `<details class="legend"${openAttr}><summary>Aged close candidates (${closeDecisions.length})</summary>
<ul class="list item-links">${closeDecisions.map((d) => {
  const itemHref = `${pageHref(pageId.item(d.itemRef))}#${siteAnchor.decision(d.decisionRef)}`;
  const item = itemByRef.get(d.itemRef);
  return `<li><a href="${escapeAttr(itemHref)}">${escapeHtml(d.label)}</a> ${item ? renderAgeBadge(item.age) : `<span class="item__id">${escapeHtml(d.decisionRef)}</span>`}</li>`;
}).join('')}</ul></details>`
    : '';
  const extraItemsHtml = nonDecisionItems.length
    ? renderItemLinksList(nonDecisionItems, input, pageHref)
    : (!projectDecisions.length ? '<p>No items in this project.</p>' : '');

  return `<section class="section" aria-label="${escapeAttr(project.title)}">
<h2><span class="sec-num" aria-hidden="true">Pr</span> Project items</h2>
${decisionsTable}
${closeDrawer}
${extraItemsHtml}
</section>
${renderGapsSection(ownedGaps)}
${renderPageEvidenceSection(ownedEvidence, lookups, currentFile)}`;
}

function renderItemTriagePager(item, input, pageHref) {
  const itemDecision = input.decisions.find((d) => d.itemRef === item.itemRef);
  if (!itemDecision) return '';
  const isClose = itemDecision.kind === 'close-candidate';
  const cohort = input.decisions.filter((d) => (d.kind === 'close-candidate') === isClose);
  const idx = cohort.findIndex((d) => d.decisionRef === itemDecision.decisionRef);
  if (idx === -1 || cohort.length <= 1) return '';
  const prevDec = idx > 0 ? cohort[idx - 1] : null;
  const nextDec = idx < cohort.length - 1 ? cohort[idx + 1] : null;
  const shortTag = (dec) => dec.decisionRef.replace(/^dec-/i, '').toUpperCase();
  const prevHtml = prevDec
    ? `<a class="triage-pager__link" href="${escapeAttr(pageHref(pageId.item(prevDec.itemRef)))}">← Previous (${escapeHtml(shortTag(prevDec))})</a>`
    : '<span class="triage-pager__muted">← First in queue</span>';
  const nextHtml = nextDec
    ? `<a class="triage-pager__link" href="${escapeAttr(pageHref(pageId.item(nextDec.itemRef)))}">Next (${escapeHtml(shortTag(nextDec))}) →</a>`
    : '<span class="triage-pager__muted">Last in queue →</span>';
  const cohortLabel = isClose ? 'Close candidate' : 'Active decision';
  return `<nav class="triage-pager" aria-label="Decision sequence">
${prevHtml}
<span class="triage-pager__pos">${cohortLabel} ${idx + 1} of ${cohort.length} · <a href="${escapeAttr(pageHref(pageId.portfolio()))}">Triage queue</a></span>
${nextHtml}
</nav>`;
}

function renderItemMain(item, input, currentFile, lookups) {
  const { ctx, pageHref, gapHref, gapByRef, ownedGaps, ownedEvidence } = lookups;
  const iAnchor = siteAnchor.item(item.itemRef);
  const from = { anchor: iAnchor, label: item.title };
  const blocksHtml = renderBlocksWithGrids(item.blocks, ctx, from);
  const itemGapLinks = (item.gapRefs ?? []).length
    ? `<p class="claim"><span class="field-label">Gaps</span> ${(item.gapRefs ?? []).map((ref) => `<a href="${escapeAttr(gapHref(ref))}">${escapeHtml(gapByRef.get(ref)?.gapRef ?? ref)}</a>`).join(', ')}</p>`
    : '';
  const areaObj = item.areaRef ? input.areas.find((a) => a.areaRef === item.areaRef) : null;
  const projObj = (areaObj && item.projectRef) ? areaObj.projects.find((p) => p.projectRef === item.projectRef) : null;
  const scopePills = [
    `<span class="meta-kv"><span class="field-label">Age</span> ${renderAgeBadge(item.age)}</span>`,
    areaObj ? `<span class="meta-kv"><span class="field-label">Area</span> <a href="${escapeAttr(pageHref(pageId.area(areaObj.areaRef)))}">${escapeHtml(areaObj.title)}</a></span>` : '',
    projObj ? `<span class="meta-kv"><span class="field-label">Project</span> <a href="${escapeAttr(pageHref(pageId.project(areaObj.areaRef, projObj.projectRef)))}">${escapeHtml(projObj.title)}</a></span>` : '',
    `<span class="meta-kv"><span class="field-label">Item ref</span> <code>${escapeHtml(item.itemRef)}</code></span>`,
  ].filter(Boolean).join('');

  const decisions = input.decisions.filter((d) => d.itemRef === item.itemRef);
  const pagerHtml = renderItemTriagePager(item, input, pageHref);
  const decisionsHtml = decisions.length
    ? `<section class="section" aria-label="Decisions">
<h2><span class="sec-num" aria-hidden="true">Dc</span> Decisions</h2>
${pagerHtml}
${decisions.map((d) => renderSiteDecision(d, ctx, item.title)).join('\n')}
</section>`
    : '';

  return `${decisionsHtml}
<section class="section" id="${escapeAttr(iAnchor)}" aria-label="${escapeAttr(item.title)}">
<h2><span class="sec-num" aria-hidden="true">It</span> Supporting context &amp; item summary</h2>
<article class="prose-sheet">
<div class="prose-sheet__body">
${itemGapLinks}
${blocksHtml}
</div>
<aside class="prose-sheet__meta" aria-label="Item dossier">${scopePills}</aside>
</article>
</section>
${renderGapsSection(ownedGaps)}
${renderPageEvidenceSection(ownedEvidence, lookups, currentFile)}`;
}

function classifyNavLevel(page) {
  if (page.id === '') return 'portfolio';
  if (page.id.startsWith('item/')) return 'item';
  if (page.id.includes('/project/')) return 'project';
  return 'area';
}

function buildOrderedNavPages(currentPage, pages) {
  const structural = pages.filter((p) => !p.id.startsWith('item/'));
  if (!currentPage.id.startsWith('item/')) return structural;
  const result = [];
  let inserted = false;
  for (let i = 0; i < structural.length; i += 1) {
    const p = structural[i];
    result.push(p);
    if (p.id === currentPage.parent) {
      result.push(currentPage);
      inserted = true;
    }
  }
  if (!inserted) result.push(currentPage);
  return result;
}

function renderSiteNav(currentPage, pages, { compact }) {
  const navPages = buildOrderedNavPages(currentPage, pages);
  const listItems = navPages.map((p) => {
    const isCurrent = p.html === currentPage.html;
    const href = isCurrent ? '#content' : relativeHref(currentPage.html, p.html);
    const level = classifyNavLevel(p);
    const label = p.id === '' ? 'Portfolio overview' : p.title;
    return `<li class="nav-item nav-item--${level}"><a href="${escapeAttr(href)}" data-nav-level="${level}"${isCurrent ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a></li>`;
  }).join('');
  const list = `<ol>${listItems}</ol>`;
  if (compact) {
    return `<nav class="toc" aria-label="Contents"><details><summary>Navigation <span class="toc__count">${navPages.length} pages</span></summary>${list}</details></nav>`;
  }
  return `<nav class="rail" aria-label="Contents"><p class="overline" aria-hidden="true">Navigation</p>${list}</nav>`;
}

function renderBreadcrumb(page, pages) {
  if (page.parent === null) return '';
  const chain = [];
  let cur = pages.find((p) => p.id === page.parent);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent !== null ? pages.find((p) => p.id === cur.parent) : null;
  }
  if (!chain.length) return '';
  const links = chain.map((p) => {
    const href = relativeHref(page.html, p.html);
    const label = p.id === '' ? 'Portfolio' : p.title;
    return `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
  }).join(' <span aria-hidden="true">/</span> ');
  return `<p class="breadcrumb">${links}</p>`;
}

function renderShell(page, pages, input, { stylesheetHref, sourceSha256, bodyHtml }) {
  const cssRel = relativeHref(page.html, stylesheetHref);
  const rootHref = relativeHref(page.html, 'index.html');
  const parentLink = page.parent !== null
    ? `<a href="${escapeAttr(relativeHref(page.html, pageFiles(page.parent).html))}">Up</a> · `
    : '';
  const manifestHref = relativeHref(page.html, 'manifest.json');
  const checksumsHref = relativeHref(page.html, 'checksums.json');
  const isRoot = page.id === '';
  const breadcrumbHtml = renderBreadcrumb(page, pages);
  const overlineHtml = isRoot
    ? `<p class="overline">Edition ${escapeHtml(input.edition.editionId)} · Observed ${escapeHtml(input.edition.observedAt)}</p>`
    : breadcrumbHtml;
  const metaClass = isRoot ? 'title-meta' : 'title-meta title-meta--compact';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CSP_META)}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="${escapeAttr(`${TOOL.name} ${TOOL.version}; ${TOOL.renderPolicy}; ${TOOL.securityPolicy}`)}">
<title>${escapeHtml(page.title)} — ${escapeHtml(input.title)}</title>
<link rel="stylesheet" href="${escapeAttr(cssRel)}">
<link rel="alternate" type="text/markdown" href="index.md" title="Agent-readable report">
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="masthead">
<p class="brand"><span class="brand__mark" aria-hidden="true">C</span><span><strong><a href="${escapeAttr(rootHref)}">${escapeHtml(input.title)}</a></strong><small>${escapeHtml(input.edition.editionId)} · ${escapeHtml(input.edition.observedAt)}</small></span></p>
<p class="masthead__status"><span class="classification">SitRep</span> · ${parentLink}<a href="index.md" type="text/markdown">Markdown</a></p>
</header>
${renderSiteNav(page, pages, { compact: true })}
<div class="layout">
${renderSiteNav(page, pages, { compact: false })}
<main id="content" class="document">
<header class="title-block${isRoot ? '' : ' title-block--subpage'}">
${overlineHtml}
<h1>${escapeHtml(page.title)}</h1>
<dl class="${metaClass}">
<div><dt>Edition digest</dt><dd><code title="${escapeAttr(input.edition.editionDigest)}">${escapeHtml(input.edition.editionDigest.slice(0, 12))}…</code></dd></div>
<div><dt>Coverage window</dt><dd>${escapeHtml(input.edition.coverage.from)} to ${escapeHtml(input.edition.coverage.to)}</dd></div>
<div><dt>Source digest</dt><dd><code title="${sourceSha256}">${sourceSha256.slice(0, 12)}…</code> · <a href="${escapeAttr(manifestHref)}">manifest.json</a> · <a href="${escapeAttr(checksumsHref)}">checksums.json</a></dd></div>
</dl>
</header>
${bodyHtml}
</main>
</div>
<footer class="site-footer">
<p>Registry ${escapeHtml(input.registry.version)} (<code title="${escapeAttr(input.registry.sha256)}">${escapeHtml(input.registry.sha256.slice(0, 12))}…</code>) · Built by ${escapeHtml(TOOL.name)} ${escapeHtml(TOOL.version)} · ${escapeHtml(TOOL.renderPolicy)} · ${escapeHtml(TOOL.securityPolicy)}. Static site-bundle/v1: no scripts, no forms, no external requests.</p>
<p><a href="#content">Back to top</a></p>
</footer>
</body>
</html>
`;
}

export function renderSiteHtmlPages(input, { evidenceIndex, stylesheetHref, sourceSha256 }) {
  const pages = sitePages(input);
  const anchors = siteAnchors(input);
  const rendered = new Map();

  for (const page of pages) {
    const lookups = makeLookups(input, anchors, evidenceIndex, page.html, page.id);
    let bodyHtml;
    if (page.id === '') {
      bodyHtml = renderPortfolioMain(input, lookups);
    } else if (page.id === pageId.area(UNASSIGNED_AREA)) {
      bodyHtml = renderUnassignedAreaMain(input, page.html, lookups);
    } else if (page.id.startsWith('area/') && !page.id.includes('/project/')) {
      const areaRef = page.id.slice('area/'.length);
      const area = input.areas.find((a) => a.areaRef === areaRef);
      bodyHtml = renderAreaMain(area, input, page.html, lookups);
    } else if (page.id.includes('/project/')) {
      const [, areaRef, , projectRef] = page.id.split('/');
      const area = input.areas.find((a) => a.areaRef === areaRef);
      const project = area.projects.find((p) => p.projectRef === projectRef);
      bodyHtml = renderProjectMain(area, project, input, page.html, lookups);
    } else if (page.id.startsWith('item/')) {
      const itemRef = page.id.slice('item/'.length);
      const item = input.items.find((i) => i.itemRef === itemRef);
      bodyHtml = renderItemMain(item, input, page.html, lookups);
    } else {
      throw new Error(`unreachable: unknown page id ${JSON.stringify(page.id)}`);
    }
    rendered.set(page.html, renderShell(page, pages, input, { stylesheetHref, sourceSha256, bodyHtml }));
  }
  return rendered;
}
