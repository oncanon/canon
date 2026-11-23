// Deterministic, zero-JS, zero-inline-style SVG chart renderers for Canon v2.
// Supports single-series bar charts, grouped baseline-vs-candidate comparisons with
// derived speedup/delta badges, and p50/p95/p99 quantile range whisker plots.
import { escapeAttr, escapeHtml } from './escape.mjs';

function niceCeiling(maxVal) {
  if (maxVal <= 0) return 1;
  const exp = Math.floor(Math.log10(maxVal));
  const base = 10 ** exp;
  const norm = maxVal / base;
  if (norm <= 1) return 1 * base;
  if (norm <= 2) return 2 * base;
  if (norm <= 2.5) return 2.5 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

function formatNum(value) {
  if (Number.isInteger(value)) return String(value);
  return value >= 100 ? value.toFixed(1) : Number(value.toFixed(2)).toString();
}

export function computeComparisonDelta(baseline, value, higherIsBetter = false) {
  if (baseline <= 0 || value <= 0) {
    const diff = value - baseline;
    return { text: diff === 0 ? '0%' : `${diff > 0 ? '+' : ''}${formatNum(diff)}`, favorable: higherIsBetter ? diff > 0 : diff < 0 };
  }
  if (!higherIsBetter) {
    if (value < baseline) {
      const ratio = baseline / value;
      const pct = ((value - baseline) / baseline) * 100;
      return {
        text: ratio >= 2 ? `${ratio.toFixed(1)}× faster (${pct.toFixed(1)}%)` : `${pct.toFixed(1)}%`,
        favorable: true,
      };
    }
    if (value > baseline) {
      const pct = ((value - baseline) / baseline) * 100;
      return { text: `+${pct.toFixed(1)}% slower`, favorable: false };
    }
    return { text: '0.0%', favorable: true };
  }
  if (value > baseline) {
    const ratio = value / baseline;
    const pct = ((value - baseline) / baseline) * 100;
    return {
      text: ratio >= 2 ? `${ratio.toFixed(1)}× (+${pct.toFixed(0)}%)` : `+${pct.toFixed(1)}%`,
      favorable: true,
    };
  }
  if (value < baseline) {
    const pct = ((value - baseline) / baseline) * 100;
    return { text: `${pct.toFixed(1)}%`, favorable: false };
  }
  return { text: '0.0%', favorable: true };
}

export function renderBarChartBody(block, figId = `chart-${block.id}`) {
  const capId = `cap-${figId}`;
  const max = Math.max(...block.series.map((p) => p.value), 1);
  const rows = block.series.map((point) => {
    const width = Math.max(point.value === 0 ? 0 : 2, Math.round((point.value / max) * 240));
    return `<tr>
<th scope="row">${escapeHtml(point.label)}</th>
<td class="chart__bar"><svg class="bar" viewBox="0 0 240 14" aria-hidden="true" focusable="false"><rect class="bar__track" width="240" height="14" rx="3" /><rect class="bar__fill" width="${width}" height="14" rx="3" /></svg></td>
<td class="num">${escapeHtml(String(point.value))} <span class="unit">${escapeHtml(block.unit)}</span></td>
</tr>`;
  }).join('\n');
  return `<div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(capId)}"><table class="chart-table">
<caption id="${escapeAttr(capId)}" class="visually-hidden">${escapeHtml(block.title)} (${escapeHtml(block.unit)})</caption>
<thead><tr><th scope="col">Series</th><th scope="col">Relative</th><th scope="col" class="num">Value</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

export function estSvgPx(text, fontSize = 11.5, { mono = false } = {}) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) w += fontSize * 1.05;
    else if (mono) w += fontSize * 0.64;
    else if (ch === 'W' || ch === 'M' || ch === '@' || ch === '%') w += fontSize * 1.02;
    else if (/[A-Z&GHOQDU_]/.test(ch)) w += fontSize * 0.82;
    else if (ch === ' ') w += fontSize * 0.34;
    else w += fontSize * 0.62;
  }
  return Math.ceil(w);
}

export function clampSvgPx(text, maxWidthPx, fontSize = 11.5, opts = {}) {
  const raw = String(text);
  if (estSvgPx(raw, fontSize, opts) <= maxWidthPx) return raw;
  const chars = [...raw];
  let end = chars.length;
  while (end > 2 && estSvgPx(`${chars.slice(0, end).join('')}…`, fontSize, opts) > maxWidthPx) {
    end -= 1;
  }
  return `${chars.slice(0, end).join('')}…`;
}

export function renderComparisonChartBody(block, figId = `chart-${block.id}`) {
  const capId = `cap-${figId}`;
  const higherIsBetter = Boolean(block.higherIsBetter);
  const rawMax = Math.max(...block.series.flatMap((p) => [p.baseline, p.value]), 1);
  const scaleMax = niceCeiling(rawMax);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Number((scaleMax * t).toFixed(2)));

  const leftPad = 190;
  const plotW = 420;
  const deltas = block.series.map((p) => computeComparisonDelta(p.baseline, p.value, higherIsBetter));
  const deltaLabels = deltas.map((d) => clampSvgPx(d.text, 220, 10.5, { mono: true }));
  const maxDeltaW = Math.max(...deltaLabels.map((t) => estSvgPx(t, 10.5, { mono: true })), 110);
  const rightPad = Math.max(148, maxDeltaW + 24);
  const rowH = 50;
  const width = leftPad + plotW + rightPad;
  const baseEstW = estSvgPx(block.baselineLabel, 10, { mono: true });
  const candEstW = estSvgPx(block.candidateLabel, 10, { mono: true });
  const singleRowFits = (18 + baseEstW + 26 + 18 + candEstW) <= (width - leftPad - 12);
  const topPad = singleRowFits ? 36 : 54;
  const inlineTickUnit = estSvgPx(`${formatNum(scaleMax)} ${block.unit}`, 10, { mono: true }) <= (plotW / 4 - 16);
  const bottomPad = inlineTickUnit ? 26 : 42;
  const height = topPad + block.series.length * rowH + bottomPad;
  const gridBottomY = height - (inlineTickUnit ? 22 : 38);

  const gridSvg = ticks.map((val) => {
    const x = leftPad + (val / scaleMax) * plotW;
    const tickLabel = inlineTickUnit ? `${formatNum(val)} ${block.unit}` : formatNum(val);
    return `<line class="svg-grid" x1="${x.toFixed(1)}" y1="${topPad - 6}" x2="${x.toFixed(1)}" y2="${gridBottomY}" />
<text class="svg-axis-label" x="${x.toFixed(1)}" y="${gridBottomY + 15}" text-anchor="middle">${escapeHtml(tickLabel)}</text>`;
  }).join('\n');
  const axisUnitSvg = inlineTickUnit
    ? ''
    : `\n<text class="svg-axis-label" x="${(leftPad + plotW / 2).toFixed(1)}" y="${height - 7}" text-anchor="middle">Unit: ${escapeHtml(clampSvgPx(block.unit, plotW, 10, { mono: true }))}</text>`;

  const rowsSvg = block.series.map((point, idx) => {
    const y = topPad + idx * rowH;
    const baseW = Math.max(point.baseline === 0 ? 0 : 2, (point.baseline / scaleMax) * plotW);
    const candW = Math.max(point.value === 0 ? 0 : 2, (point.value / scaleMax) * plotW);
    const delta = deltas[idx];
    const labelStr = clampSvgPx(point.label, leftPad - 22, 11.5);
    return `<g class="svg-cmp-row">
  <text class="svg-row-label" x="${leftPad - 12}" y="${y + 20}" text-anchor="end">${escapeHtml(labelStr)}</text>
  <rect class="bar__baseline" x="${leftPad}" y="${y + 4}" width="${baseW.toFixed(1)}" height="12" rx="3" />
  <rect class="bar__candidate" x="${leftPad}" y="${y + 20}" width="${candW.toFixed(1)}" height="12" rx="3" />
  <text class="svg-delta ${delta.favorable ? 'svg-delta--good' : 'svg-delta--warn'}" x="${leftPad + plotW + 12}" y="${y + 22}">${escapeHtml(deltaLabels[idx])}</text>
</g>`;
  }).join('\n');

  let legendSvg;
  if (singleRowFits) {
    const candSwatchX = Math.max(leftPad + 195, leftPad + 18 + baseEstW + 26);
    legendSvg = `<g class="svg-legend">
  <rect class="bar__baseline" x="${leftPad}" y="8" width="12" height="10" rx="2" />
  <text class="svg-axis-label" x="${leftPad + 18}" y="17">${escapeHtml(block.baselineLabel)}</text>
  <rect class="bar__candidate" x="${candSwatchX}" y="8" width="12" height="10" rx="2" />
  <text class="svg-axis-label" x="${candSwatchX + 18}" y="17">${escapeHtml(block.candidateLabel)}</text>
</g>`;
  } else {
    const maxRowTextW = width - 48;
    const baseSvgLabel = clampSvgPx(block.baselineLabel, maxRowTextW, 10, { mono: true });
    const candSvgLabel = clampSvgPx(block.candidateLabel, maxRowTextW, 10, { mono: true });
    legendSvg = `<g class="svg-legend">
  <rect class="bar__baseline" x="16" y="8" width="12" height="10" rx="2" />
  <text class="svg-axis-label" x="34" y="17">${escapeHtml(baseSvgLabel)}</text>
  <rect class="bar__candidate" x="16" y="26" width="12" height="10" rx="2" />
  <text class="svg-axis-label" x="34" y="35">${escapeHtml(candSvgLabel)}</text>
</g>`;
  }

  const svg = `<div class="diagram-canvas">
<svg class="svg-graphic svg-graphic--chart" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
${legendSvg}
${gridSvg}${axisUnitSvg}
${rowsSvg}
</svg>
</div>`;

  const tableRows = block.series.map((point) => {
    const delta = computeComparisonDelta(point.baseline, point.value, higherIsBetter);
    return `<tr>
<th scope="row">${escapeHtml(point.label)}</th>
<td class="num">${escapeHtml(String(point.baseline))} <span class="unit">${escapeHtml(block.unit)}</span></td>
<td class="num"><strong>${escapeHtml(String(point.value))}</strong> <span class="unit">${escapeHtml(block.unit)}</span></td>
<td class="num"><span class="delta-pill ${delta.favorable ? 'delta-pill--good' : 'delta-pill--warn'}">${escapeHtml(delta.text)}</span></td>
</tr>`;
  }).join('\n');

  const table = `<div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(capId)}"><table class="chart-table">
<caption id="${escapeAttr(capId)}" class="visually-hidden">${escapeHtml(block.title)} (${escapeHtml(block.unit)})</caption>
<thead><tr><th scope="col">Series</th><th scope="col" class="num">${escapeHtml(block.baselineLabel)}</th><th scope="col" class="num">${escapeHtml(block.candidateLabel)}</th><th scope="col" class="num">Delta</th></tr></thead>
<tbody>
${tableRows}
</tbody>
</table></div>`;

  return `${svg}\n${table}`;
}

export function renderQuantilesChartBody(block, figId = `chart-${block.id}`) {
  const capId = `cap-${figId}`;
  const hasMax = block.series.some((p) => Object.hasOwn(p, 'max'));
  const rawMax = Math.max(
    block.budget ?? 0,
    ...block.series.map((p) => p.max ?? p.p99),
    1,
  );
  const scaleMax = niceCeiling(rawMax * 1.05);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Number((scaleMax * t).toFixed(2)));

  const leftPad = 195;
  const plotW = 460;
  const inlineTickUnit = estSvgPx(`${formatNum(scaleMax)} ${block.unit}`, 10, { mono: true }) <= (plotW / 4 - 16);
  const p99Callouts = block.series.map((p) => clampSvgPx(`p99 ${formatNum(p.p99)} ${block.unit}`, 195, 10, { mono: true }));
  const maxCalloutW = Math.max(...p99Callouts.map((t) => estSvgPx(t, 10, { mono: true })), 75);
  const rightPad = Math.max(95, maxCalloutW + 22);
  const topPad = Object.hasOwn(block, 'budget') ? 52 : 34;
  const rowH = 44;
  const bottomPad = inlineTickUnit ? 26 : 42;
  const width = leftPad + plotW + rightPad;
  const height = topPad + block.series.length * rowH + bottomPad;
  const gridBottomY = height - (inlineTickUnit ? 22 : 38);

  const gridSvg = ticks.map((val) => {
    const x = leftPad + (val / scaleMax) * plotW;
    const tickLabel = inlineTickUnit ? `${formatNum(val)} ${block.unit}` : formatNum(val);
    return `<line class="svg-grid" x1="${x.toFixed(1)}" y1="${topPad - 6}" x2="${x.toFixed(1)}" y2="${gridBottomY}" />
<text class="svg-axis-label" x="${x.toFixed(1)}" y="${gridBottomY + 15}" text-anchor="middle">${escapeHtml(tickLabel)}</text>`;
  }).join('\n');
  const axisUnitSvg = inlineTickUnit
    ? ''
    : `\n<text class="svg-axis-label" x="${(leftPad + plotW / 2).toFixed(1)}" y="${height - 7}" text-anchor="middle">Unit: ${escapeHtml(clampSvgPx(block.unit, plotW, 10, { mono: true }))}</text>`;

  const budgetSvg = Object.hasOwn(block, 'budget')
    ? (() => {
      const bx = leftPad + (block.budget / scaleMax) * plotW;
      const slaText = clampSvgPx(`SLA ${formatNum(block.budget)} ${block.unit}`, 260, 10, { mono: true });
      const slaHalfW = estSvgPx(slaText, 10, { mono: true }) / 2;
      const slaTextX = Math.max(slaHalfW + 8, Math.min(width - slaHalfW - 8, bx));
      return `<line class="svg-budget-line" x1="${bx.toFixed(1)}" y1="${topPad - 10}" x2="${bx.toFixed(1)}" y2="${gridBottomY}" />
<text class="svg-budget-label" x="${slaTextX.toFixed(1)}" y="${topPad - 15}" text-anchor="middle">${escapeHtml(slaText)}</text>`;
    })()
    : '';

  const rowsSvg = block.series.map((point, idx) => {
    const cy = topPad + idx * rowH + 16;
    const x50 = leftPad + (point.p50 / scaleMax) * plotW;
    const x95 = leftPad + (point.p95 / scaleMax) * plotW;
    const x99 = leftPad + (point.p99 / scaleMax) * plotW;
    const labelStr = clampSvgPx(point.label, leftPad - 22, 11.5);
    const whiskerEnd = Object.hasOwn(point, 'max') ? leftPad + (point.max / scaleMax) * plotW : x99;
    return `<g class="svg-quant-row">
  <text class="svg-row-label" x="${leftPad - 12}" y="${cy + 4}" text-anchor="end">${escapeHtml(labelStr)}</text>
  <line class="svg-quant-track" x1="${leftPad}" y1="${cy}" x2="${leftPad + plotW}" y2="${cy}" />
  ${Object.hasOwn(point, 'max') ? `<line class="svg-quant-whisker" x1="${x99.toFixed(1)}" y1="${cy}" x2="${whiskerEnd.toFixed(1)}" y2="${cy}" />` : ''}
  <rect class="svg-quant-band" x="${x50.toFixed(1)}" y="${cy - 6}" width="${Math.max(3, x99 - x50).toFixed(1)}" height="12" rx="3" />
  <rect class="svg-quant-iqr" x="${x50.toFixed(1)}" y="${cy - 6}" width="${Math.max(2, x95 - x50).toFixed(1)}" height="12" rx="3" />
  <circle class="svg-quant-p50" cx="${x50.toFixed(1)}" cy="${cy}" r="4.5" />
  <line class="svg-quant-p95" x1="${x95.toFixed(1)}" y1="${cy - 8}" x2="${x95.toFixed(1)}" y2="${cy + 8}" />
  <polygon class="svg-quant-p99" points="${x99.toFixed(1)},${cy - 5.5} ${(x99 + 5.5).toFixed(1)},${cy} ${x99.toFixed(1)},${cy + 5.5} ${(x99 - 5.5).toFixed(1)},${cy}" />
  <text class="svg-axis-label" x="${leftPad + plotW + 10}" y="${cy + 4}">${escapeHtml(p99Callouts[idx])}</text>
</g>`;
  }).join('\n');

  const legendSvg = `<g class="svg-legend">
  <circle class="svg-quant-p50" cx="${leftPad + 5}" cy="13" r="4" />
  <text class="svg-axis-label" x="${leftPad + 14}" y="17">p50 median</text>
  <line class="svg-quant-p95" x1="${leftPad + 105}" y1="7" x2="${leftPad + 105}" y2="19" />
  <text class="svg-axis-label" x="${leftPad + 113}" y="17">p95</text>
  <polygon class="svg-quant-p99" points="${leftPad + 158},8 ${leftPad + 163},13 ${leftPad + 158},18 ${leftPad + 153},13" />
  <text class="svg-axis-label" x="${leftPad + 169}" y="17">p99 tail</text>
</g>`;

  const svg = `<div class="diagram-canvas">
<svg class="svg-graphic svg-graphic--quantiles" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
${legendSvg}
${gridSvg}${axisUnitSvg}
${budgetSvg}
${rowsSvg}
</svg>
</div>`;

  const tableRows = block.series.map((point) => `<tr>
<th scope="row">${escapeHtml(point.label)}</th>
<td class="num">${escapeHtml(String(point.p50))} <span class="unit">${escapeHtml(block.unit)}</span></td>
<td class="num">${escapeHtml(String(point.p95))} <span class="unit">${escapeHtml(block.unit)}</span></td>
<td class="num"><strong>${escapeHtml(String(point.p99))}</strong> <span class="unit">${escapeHtml(block.unit)}</span></td>
${hasMax ? `<td class="num">${Object.hasOwn(point, 'max') ? `${escapeHtml(String(point.max))} <span class="unit">${escapeHtml(block.unit)}</span>` : '—'}</td>` : ''}
</tr>`).join('\n');

  const table = `<div class="table__scroll" tabindex="0" role="region" aria-labelledby="${escapeAttr(capId)}"><table class="chart-table">
<caption id="${escapeAttr(capId)}" class="visually-hidden">${escapeHtml(block.title)} (${escapeHtml(block.unit)})</caption>
<thead><tr><th scope="col">Series</th><th scope="col" class="num">p50</th><th scope="col" class="num">p95</th><th scope="col" class="num">p99</th>${hasMax ? '<th scope="col" class="num">Max</th>' : ''}</tr></thead>
<tbody>
${tableRows}
</tbody>
</table></div>`;

  return `${svg}\n${table}`;
}
