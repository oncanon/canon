// The site-bundle/v1 manifest members that describe structure: pages, anchors and decisions
// (docs/projects/interactive-sitrep-contract.md, revision 4). Everything here is
// derived from a validated site-input/v1 (src/site/validate.mjs), in the order the input
// gives. Nothing is sorted, and nothing is taken from a title.
//
// A page ID is the page's directory inside the bundle: "" for the portfolio,
// "area/<areaRef>", "area/<areaRef>/project/<projectRef>" and "item/<itemRef>". Its two
// files are index.html and index.md in that directory, so one relative link serves both.
import { anchor, siteAnchor } from '../render/anchors.mjs';
import { UNASSIGNED_AREA } from './validate.mjs';

export const SITE_BUNDLE_SCHEMA = 'site-bundle/v1';
export const UNASSIGNED_TITLE = 'Unassigned: mapping needed';

export const pageId = Object.freeze({
  portfolio: () => '',
  area: (areaRef) => `area/${areaRef}`,
  project: (areaRef, projectRef) => `area/${areaRef}/project/${projectRef}`,
  item: (itemRef) => `item/${itemRef}`,
});

const fileIn = (page, name) => (page === '' ? name : `${page}/${name}`);
export const pageFiles = (page) => ({ html: fileIn(page, 'index.html'), markdown: fileIn(page, 'index.md') });

// "../" once for each directory in the linking file's bundle path.
const toRoot = (fromFile) => '../'.repeat(fromFile.split('/').length - 1);

// A link from one bundle file to another, both given as bundle paths.
export function relativeHref(fromFile, toFile) {
  return `${toRoot(fromFile)}${toFile}`;
}

function parentOf(item) {
  if (item.areaRef === null) return pageId.area(UNASSIGNED_AREA);
  return item.projectRef === null ? pageId.area(item.areaRef) : pageId.project(item.areaRef, item.projectRef);
}

// Pages in reading order: the portfolio; each area followed by its projects; the page for
// unmapped items, only when there is one; then every item.
export function sitePages(input) {
  const page = (id, title, parent) => ({ id, ...pageFiles(id), title, parent });
  const pages = [page(pageId.portfolio(), input.title, null)];
  for (const area of input.areas) {
    pages.push(page(pageId.area(area.areaRef), area.title, pageId.portfolio()));
    for (const project of area.projects) pages.push(page(pageId.project(area.areaRef, project.projectRef), project.title, pageId.area(area.areaRef)));
  }
  if (input.items.some((item) => item.areaRef === null)) pages.push(page(pageId.area(UNASSIGNED_AREA), UNASSIGNED_TITLE, pageId.portfolio()));
  for (const item of input.items) pages.push(page(pageId.item(item.itemRef), item.title, parentOf(item)));
  return pages;
}

const BLOCK_ANCHOR = Object.freeze({
  finding: anchor.finding,
  risk: anchor.risk,
  table: anchor.table,
  chart: anchor.chart,
  diagram: anchor.diagram,
  comparison: anchor.comparison,
  requirement: anchor.requirement,
  code: anchor.code,
  diff: anchor.code,
});

function blockAnchors(blocks) {
  const found = [];
  for (const block of blocks) {
    const make = BLOCK_ANCHOR[block.type];
    if (make) found.push({ anchor: make(block), kind: block.type });
    if (Array.isArray(block.detail)) found.push(...blockAnchors(block.detail));
  }
  return found;
}

// Evidence ids cited, in the order met. The validated grammar cites evidence in two ways
// only: an inline { cite } segment, and an "evidence" list. The walk follows the grammar
// member by member, so a table column that happens to be keyed "cite" is never mistaken
// for a citation.
function inlineCites(value, into) {
  if (!Array.isArray(value)) return;
  for (const segment of value) {
    if (segment !== null && typeof segment === 'object' && typeof segment.cite === 'string') into.push(segment.cite);
  }
}

function blockCites(block, into) {
  switch (block.type) {
    case 'paragraph': inlineCites(block.text, into); return;
    case 'list': for (const item of block.items) inlineCites(item, into); return;
    case 'finding':
      inlineCites(block.claim, into);
      into.push(...block.evidence);
      for (const detail of block.detail ?? []) blockCites(detail, into);
      return;
    case 'risk': inlineCites(block.mitigation, into); return;
    case 'code':
    case 'diff': inlineCites(block.caption, into); return;
    case 'table':
      for (const row of block.rows) for (const column of block.columns) inlineCites(row[column.key], into);
      return;
    case 'chart':
      inlineCites(block.caption, into);
      into.push(...(block.evidence ?? []));
      return;
    case 'diagram':
      inlineCites(block.caption, into);
      into.push(...(block.evidence ?? []));
      return;
    case 'comparison':
      inlineCites(block.caption, into);
      for (const side of [block.left, block.right]) {
        inlineCites(side.summary, into);
        for (const item of side.items ?? []) inlineCites(item, into);
      }
      into.push(...(block.evidence ?? []));
      return;
    case 'requirement':
      inlineCites(block.statement, into);
      into.push(...(block.evidence ?? []));
      return;
    case 'metrics': for (const item of block.items) into.push(...(item.evidence ?? [])); return;
    default: throw new Error(`unreachable: no citation rule for block type ${JSON.stringify(block.type)}`);
  }
}

function citedBy(item, decisions) {
  const into = [];
  for (const block of item.blocks) blockCites(block, into);
  for (const decision of decisions) {
    for (const question of decision.questions) {
      for (const option of question.options) inlineCites(option.summary, into);
      inlineCites(question.recommendation.text, into);
      into.push(...(question.evidence ?? []));
    }
  }
  return into;
}

// Every anchor is on exactly one page. A gap or an evidence entry that several pages
// refer to is shown where it is first referred to, and the other pages link there:
//   gap:      the first area whose counts name it, else the first item that names it;
//   evidence: the first item that cites it, in its blocks or in its decisions.
// One that nothing refers to is shown on the portfolio page, so it never disappears.
export function siteAnchors(input) {
  const decisionsOf = (item) => input.decisions.filter((decision) => decision.itemRef === item.itemRef);
  const owner = new Map();
  const claim = (key, page) => { if (!owner.has(key)) owner.set(key, page); };
  for (const area of input.areas) for (const gapRef of area.counts.gapRefs) claim(`gap ${gapRef}`, pageId.area(area.areaRef));
  for (const item of input.items) {
    const page = pageId.item(item.itemRef);
    for (const gapRef of item.gapRefs ?? []) claim(`gap ${gapRef}`, page);
    for (const id of citedBy(item, decisionsOf(item))) claim(`evidence ${id}`, page);
  }
  const shared = (page) => [
    ...input.gaps.filter((gap) => (owner.get(`gap ${gap.gapRef}`) ?? pageId.portfolio()) === page).map((gap) => ({ anchor: siteAnchor.gap(gap.gapRef), page, kind: 'gap' })),
    ...input.evidence.filter((item) => (owner.get(`evidence ${item.id}`) ?? pageId.portfolio()) === page).map((item) => ({ anchor: anchor.evidenceItem(item.id), page, kind: 'evidence' })),
  ];

  const anchors = [...shared(pageId.portfolio())];
  for (const area of input.areas) {
    const page = pageId.area(area.areaRef);
    anchors.push({ anchor: siteAnchor.area(area.areaRef), page, kind: 'area' }, ...shared(page));
  }
  if (input.items.some((item) => item.areaRef === null)) {
    anchors.push({ anchor: siteAnchor.area(UNASSIGNED_AREA), page: pageId.area(UNASSIGNED_AREA), kind: 'area' });
  }
  for (const item of input.items) {
    const page = pageId.item(item.itemRef);
    anchors.push({ anchor: siteAnchor.item(item.itemRef), page, kind: 'item' });
    for (const found of blockAnchors(item.blocks)) anchors.push({ anchor: found.anchor, page, kind: found.kind });
    for (const decision of decisionsOf(item)) {
      anchors.push({ anchor: siteAnchor.decision(decision.decisionRef), page, kind: 'decision' });
      for (const question of decision.questions) anchors.push({ anchor: siteAnchor.question(question.questionRef), page, kind: 'question' });
    }
    anchors.push(...shared(page));
  }

  // An element target is an anchor with no page, so an anchor names one place in the whole
  // bundle. Validated input cannot collide: each prefix belongs to one kind of ref.
  const seen = new Map();
  for (const entry of anchors) {
    const key = entry.anchor.toLowerCase();
    if (seen.has(key)) throw new Error(`unreachable: anchor ${JSON.stringify(entry.anchor)} on ${JSON.stringify(entry.page)} collides with ${JSON.stringify(seen.get(key))}`);
    seen.set(key, entry.page);
  }
  return anchors;
}

// One entry per decision: the page and anchor where it lives, and each question with its
// anchor, option refs and free-text bounds, so an external conversational runtime can
// address any decision or question directly from the verified manifest.
export function siteDecisions(input) {
  return input.decisions.map((decision) => {
    const page = pageId.item(decision.itemRef);
    return {
      decisionRef: decision.decisionRef,
      kind: decision.kind,
      page,
      anchor: siteAnchor.decision(decision.decisionRef),
      questions: decision.questions.map((question) => ({
        questionRef: question.questionRef,
        anchor: siteAnchor.question(question.questionRef),
        optionRefs: question.options.map((option) => option.optionRef),
        freeText: { allowed: question.freeText.allowed, maxChars: question.freeText.allowed ? question.freeText.maxChars : null },
      })),
    };
  });
}

// The structural members of a site-bundle/v1 manifest, for a validated site input.
export function siteManifestParts(input) {
  const { editionId, editionDigest, observedAt, coverage } = input.edition;
  return {
    edition: { editionId, editionDigest, observedAt, coverage: { from: coverage.from, to: coverage.to } },
    pages: sitePages(input),
    anchors: siteAnchors(input),
    decisions: siteDecisions(input),
  };
}
