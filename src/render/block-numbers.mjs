// Block numbers (b-nn): the report/v1 numbering rule (docs/decisions/phase1-contract.md
// D4, render-policy/2 R3). One sequence for the whole document: every entry of
// summary.paragraphs, then every top-level block of each section in order, then every
// top-level block of each appendix in order. Nested finding detail blocks, the verdict,
// summary metrics, ledes, evidence items and provenance do not count.

export function blockNumberLabel(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`block number must be a positive integer, got ${n}`);
  return `b-${String(n).padStart(2, '0')}`;
}

// Labels in numbering order, grouped the way the renderer walks the report.
export function assignBlockNumbers(report) {
  let n = 0;
  const next = () => blockNumberLabel(++n);
  const summary = report.summary.paragraphs.map(next);
  const sections = report.sections.map((section) => section.blocks.map(next));
  const appendices = (report.appendices ?? []).map((section) => section.blocks.map(next));
  return { summary, sections, appendices, total: n };
}
