// Deterministic bounded inline previews for bundled packet evidence files (.csv, .json, .txt).
// Uses accessible region ids on <p> sub-elements so block-anchor invariants and P12/P13
// print + keyboard-region checks hold without JavaScript or <details> toggles.
import { escapeAttr, escapeHtml } from './escape.mjs';
import { highlightLines } from './highlight.mjs';

const MAX_CSV_ROWS = 6;
const MAX_CSV_COLS = 7;
const MAX_CODE_LINES = 10;
const MAX_LINE_CHARS = 120;

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_CSV_ROWS + 2) break;
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

export function renderEvidencePreview(itemId, ev) {
  if (!ev || typeof ev.previewText !== 'string' || !ev.previewText.trim()) return '';
  const labelId = `pv-${itemId}`;
  const mediaType = ev.mediaType ?? 'text/plain';

  if (mediaType === 'text/csv') {
    const parsed = parseCsvRows(ev.previewText);
    if (parsed.length < 2) return '';
    const header = parsed[0].slice(0, MAX_CSV_COLS);
    const dataRows = parsed.slice(1, 1 + MAX_CSV_ROWS);
    const totalLines = ev.previewText.trim().split(/\r?\n/).length - 1;
    const truncated = totalLines > dataRows.length ? ` · showing ${dataRows.length} of ${totalLines} rows` : '';
    return `<div class="ev-preview">
<p class="ev-preview__bar" id="${escapeAttr(labelId)}">Inline CSV excerpt (${escapeHtml(ev.label)})${escapeHtml(truncated)}</p>
<div class="table__scroll" role="region" tabindex="0" aria-labelledby="${escapeAttr(labelId)}">
<table class="ev-preview__table">
<caption class="visually-hidden">CSV preview for ${escapeHtml(ev.label)}</caption>
<thead><tr>${header.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead>
<tbody>
${dataRows.map((r) => `<tr>${header.map((_, ci) => `<td>${escapeHtml(r[ci] ?? '')}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table>
</div>
</div>`;
  }

  const rawLines = ev.previewText.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const slice = rawLines.slice(0, MAX_CODE_LINES);
  const lang = mediaType === 'application/json' ? 'json' : 'text';
  const truncated = rawLines.length > slice.length ? ` · lines 1–${slice.length} of ${rawLines.length}` : '';
  const renderedLines = slice.map((line) => {
    const cps = Array.from(line);
    const clipped = cps.length > MAX_LINE_CHARS ? `${cps.slice(0, MAX_LINE_CHARS - 1).join('')}…` : line;
    return `<span class="ln">${highlightLines(clipped, lang)[0] ?? ''}</span>`;
  }).join('\n');

  return `<div class="ev-preview">
<p class="ev-preview__bar" id="${escapeAttr(labelId)}">Inline ${mediaType === 'application/json' ? 'JSON' : 'text'} excerpt (${escapeHtml(ev.label)})${escapeHtml(truncated)}</p>
<div class="code__scroll" role="region" tabindex="0" aria-labelledby="${escapeAttr(labelId)}"><pre><code>${renderedLines}</code></pre></div>
</div>`;
}
