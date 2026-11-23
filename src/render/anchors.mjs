// Block anchors shared by index.html (element ids) and report.md ("[id]: #id"
// definitions under headings), so the same summary, section, finding, decision,
// risk, figure and evidence item is addressable by the same id in both artifacts
// (docs/decisions/phase1-contract.md D10).
export const anchor = {
  summary: () => 'summary',
  section: (section, appendix = false) => `${appendix ? 'app' : 'sec'}-${section.id}`,
  finding: (block) => `f-${block.id}`,
  decision: (block) => `d-${block.id}`,
  risk: (block) => `r-${block.id}`,
  table: (block) => `tbl-${block.id}`,
  chart: (block) => `chart-${block.id}`,
  diagram: (block) => `diagram-${block.id}`,
  comparison: (block) => `cmp-${block.id}`,
  requirement: (block) => `req-${block.id}`,
  code: (block) => `code-${block.id}`,
  evidence: () => 'evidence',
  evidenceItem: (id) => `ev-${id}`,
  provenance: () => 'provenance',
};

// Site anchors (site-bundle/v1, docs/projects/interactive-sitrep-contract.md section 1):
// a fixed prefix plus the ref the site input supplies. Display blocks on a site page keep
// the block anchors above. A report decision block is not allowed in a site input, so
// "d-" names one thing in each schema.
export const siteAnchor = {
  area: (areaRef) => `a-${areaRef}`,
  item: (itemRef) => `i-${itemRef}`,
  decision: (decisionRef) => `d-${decisionRef}`,
  question: (questionRef) => `q-${questionRef}`,
  gap: (gapRef) => `g-${gapRef}`,
};
