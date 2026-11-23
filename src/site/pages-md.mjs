// site-input/v1 -> multi-page deterministic CommonMark (docs/projects/interactive-sitrep-contract.md, revision 4).
// Every page emits [id]: #id link reference definitions for the exact siteAnchors(input)
// entries on that page, in reading order, and passes relaxEscapes over the final Markdown.
import { anchor as ANCHOR, siteAnchor } from '../render/anchors.mjs';
import {
  anchorDef,
  assertAnchors,
  atLineStart,
  blocksMarkdown,
  emphasize,
  heading,
  inline,
  inlineCode,
  prose,
} from '../render/markdown.mjs';
import { relaxEscapes } from '../render/relax.mjs';
import { UNASSIGNED_TITLE, pageFiles, pageId, relativeHref, siteAnchors, sitePages } from './manifest.mjs';
import { UNASSIGNED_AREA } from './validate.mjs';

function formatCount(value, coverage) {
  if (value === null) return 'not recorded';
  return coverage === 'partial' ? `${value} (partial)` : String(value);
}

function makeMdLookups(input, anchors, evidenceIndex, currentFile, currentPageId) {
  const anchorPage = new Map(anchors.map((a) => [a.anchor, a.page]));
  const gapByRef = new Map(input.gaps.map((g) => [g.gapRef, g]));
  const hrefToAnchor = (targetAnchor) => {
    const ownerPage = anchorPage.get(targetAnchor) ?? pageId.portfolio();
    if (ownerPage === currentPageId) return `#${targetAnchor}`;
    return `${relativeHref(currentFile, pageFiles(ownerPage).markdown)}#${targetAnchor}`;
  };
  const gapLink = (gapRef) => `[${prose(gapRef)}](${hrefToAnchor(siteAnchor.gap(gapRef))})`;
  const pageMdHref = (targetPageId) => relativeHref(currentFile, pageFiles(targetPageId).markdown);
  const ownedGaps = anchors
    .filter((a) => a.page === currentPageId && a.kind === 'gap')
    .map((a) => gapByRef.get(a.anchor.slice(2)));
  const ownedEvidence = anchors
    .filter((a) => a.page === currentPageId && a.kind === 'evidence')
    .map((a) => input.evidence.find((e) => ANCHOR.evidenceItem(e.id) === a.anchor));
  return { gapLink, pageMdHref, hrefToAnchor, ownedGaps, ownedEvidence, evidenceIndex };
}

// Emit [E<n>]: <href>#ev-<id> link reference definitions for every evidence entry in the
// edition so shortcut citations [E1] resolve whether the evidence is owned by this page
// or by another page. These targets start with #ev- or ../ (never #<label>), so they do
// not match the page anchor pattern /^\[([^\]\n]+)\]: #\1$/gm.
function renderCitationDefinitionsMd(input, { hrefToAnchor, evidenceIndex }) {
  if (!input.evidence.length) return '';
  const defs = input.evidence.map((item) => {
    const entry = evidenceIndex.get(item.id);
    return `[${entry.label}]: ${hrefToAnchor(ANCHOR.evidenceItem(item.id))}`;
  }).join('\n');
  return `\n${defs}\n`;
}

function renderCountsMd(counts, { gapLink }) {
  const { waiting, moved, blocked, coverage, gapRefs, unit } = counts;
  const gapsText = gapRefs.length ? ` (gaps: ${gapRefs.map(gapLink).join(', ')})` : '';
  const covLine = coverage === 'unavailable'
    ? `\n**Coverage unavailable.** Counts were not recorded for this area${gapsText}.\n`
    : coverage === 'partial'
      ? `\n**Partial coverage.** Recorded numbers reflect only partial reading${gapsText}.\n`
      : '';
  return `- **Waiting:** ${prose(formatCount(waiting, coverage))}
- **Moved:** ${prose(formatCount(moved, coverage))}
- **Blocked:** ${prose(formatCount(blocked, coverage))}
- **Coverage:** ${prose(coverage)}
- **Unit:** ${prose(unit)}
${covLine}`;
}

function renderGapsMd(ownedGaps) {
  if (!ownedGaps.length) return '';
  const items = ownedGaps.map((gap) => `### Gap ${heading(gap.gapRef)} (${heading(gap.kind)})${anchorDef(siteAnchor.gap(gap.gapRef))}\n\n${atLineStart(prose(gap.text))}\n`).join('\n');
  return `\n## Explicit gaps\n\n${items}`;
}

function renderEvidenceMd(ownedEvidence, evidenceIndex) {
  if (!ownedEvidence.length) return '';
  const items = ownedEvidence.map((item) => {
    const entry = evidenceIndex.get(item.id);
    if (item.kind === 'file') {
      return `### ${entry.label}: ${heading(item.title)}${anchorDef(ANCHOR.evidenceItem(item.id))}\n\n- ID: ${inlineCode(item.id)}\n- File: ${inlineCode(entry.href)}\n- Media type: ${inlineCode(item.mediaType)}\n- Bytes: ${entry.bytes}\n- SHA-256: ${inlineCode(entry.sha256)}\n`;
    }
    return `### ${entry.label}: ${heading(item.title)}${anchorDef(ANCHOR.evidenceItem(item.id))}\n\n- ID: ${inlineCode(item.id)}\n- Status: ${prose(item.kind)}\n- Reason: ${prose(item.reason)}\n`;
  }).join('\n');
  return `\n## Evidence\n\n${items}`;
}

function renderQuestionMd(question, evidenceIndex) {
  const options = question.options.map((opt) => {
    const isRec = question.recommendation.optionRef === opt.optionRef;
    const prefix = isRec ? emphasize('**', `${prose(opt.label)} (recommended)`) : atLineStart(prose(opt.label));
    return `- ${prefix} (${inlineCode(opt.optionRef)}): ${inline(opt.summary, evidenceIndex)}`;
  }).join('\n');
  const freeText = question.freeText.allowed
    ? `Allowed (up to ${question.freeText.maxChars} characters).`
    : 'Not allowed.';
  const recOpt = question.recommendation.optionRef ? ` (${inlineCode(question.recommendation.optionRef)})` : '';
  const evLine = (question.evidence ?? []).length
    ? `\n**Supporting evidence.** ${question.evidence.map((id) => `[${evidenceIndex.get(id).label}]`).join(', ')}\n`
    : '';
  return `#### Question ${heading(question.questionRef)}: ${heading(question.text)}${anchorDef(siteAnchor.question(question.questionRef))}

**Options.**
${options}

**Free-text response.** ${freeText}

**Recommendation${recOpt}.** ${inline(question.recommendation.text, evidenceIndex)}
${evLine}`;
}

function renderDecisionMd(decision, evidenceIndex) {
  const questions = decision.questions.map((q) => renderQuestionMd(q, evidenceIndex)).join('\n');
  return `### Decision ${heading(decision.decisionRef)}: ${heading(decision.label)}${anchorDef(siteAnchor.decision(decision.decisionRef))}

- **Kind:** ${prose(decision.kind)}

${questions}`;
}

function renderPortfolioMd(input, lookups) {
  const { pageMdHref, gapLink, ownedGaps, ownedEvidence, evidenceIndex } = lookups;
  const areasMd = input.areas.map((area) => {
    const items = input.items.filter((i) => i.areaRef === area.areaRef);
    const itemLines = items.length
      ? items.map((item) => `- [${prose(item.title)}](${pageMdHref(pageId.item(item.itemRef))}) (${prose(item.age)})`).join('\n')
      : '- No items in this area.';
    return `### [${heading(area.title)}](${pageMdHref(pageId.area(area.areaRef))}) (${inlineCode(area.areaRef)})\n\n${renderCountsMd(area.counts, { gapLink })}\n${itemLines}\n`;
  }).join('\n');

  const unassignedItems = input.items.filter((i) => i.areaRef === null);
  const unassignedMd = unassignedItems.length
    ? `\n### [${heading(UNASSIGNED_TITLE)}](${pageMdHref(pageId.area(UNASSIGNED_AREA))})\n\n${unassignedItems.map((item) => `- [${prose(item.title)}](${pageMdHref(pageId.item(item.itemRef))}) (${prose(item.age)})`).join('\n')}\n`
    : '';

  const decisionsMd = input.decisions.length
    ? `\n## Open decisions\n\n${input.decisions.map((d) => `- [${prose(d.label)}](${pageMdHref(pageId.item(d.itemRef))}#${siteAnchor.decision(d.decisionRef)}) (${inlineCode(d.decisionRef)}, ${prose(d.kind)})`).join('\n')}\n`
    : '';

  const historyMd = input.history?.length
    ? `\n## Prior editions\n\n${input.history.map((h) => `- [${prose(h.editionId)}](../${h.contentId}/index.md) — observed ${prose(h.observedAt)} (${inlineCode(h.contentId)})`).join('\n')}\n`
    : '';

  return `## Areas\n\n${areasMd}${unassignedMd}${decisionsMd}${historyMd}${renderGapsMd(ownedGaps)}${renderEvidenceMd(ownedEvidence, evidenceIndex)}`;
}

function renderAreaMd(area, input, lookups) {
  const { pageMdHref, gapLink, ownedGaps, ownedEvidence, evidenceIndex } = lookups;
  const projectsMd = area.projects.length
    ? `\n### Projects\n\n${area.projects.map((p) => `- [${prose(p.title)}](${pageMdHref(pageId.project(area.areaRef, p.projectRef))}) (${inlineCode(p.projectRef)})`).join('\n')}\n`
    : '';
  const items = input.items.filter((i) => i.areaRef === area.areaRef);
  const itemsMd = `\n### Items\n\n${items.length ? items.map((item) => `- [${prose(item.title)}](${pageMdHref(pageId.item(item.itemRef))}) (${prose(item.age)})`).join('\n') : 'No items recorded in this area.'}\n`;

  return `## Area: ${heading(area.title)}${anchorDef(siteAnchor.area(area.areaRef))}

${renderCountsMd(area.counts, { gapLink })}${projectsMd}${itemsMd}${renderGapsMd(ownedGaps)}${renderEvidenceMd(ownedEvidence, evidenceIndex)}`;
}

function renderUnassignedAreaMd(input, lookups) {
  const { pageMdHref, ownedGaps, ownedEvidence, evidenceIndex } = lookups;
  const items = input.items.filter((i) => i.areaRef === null);
  return `## ${heading(UNASSIGNED_TITLE)}${anchorDef(siteAnchor.area(UNASSIGNED_AREA))}

These items name no area in the registry and remain visible until mapped.

${items.map((item) => `- [${prose(item.title)}](${pageMdHref(pageId.item(item.itemRef))}) (${prose(item.age)})`).join('\n')}
${renderGapsMd(ownedGaps)}${renderEvidenceMd(ownedEvidence, evidenceIndex)}`;
}

function renderProjectMd(area, project, input, lookups) {
  const { pageMdHref, ownedGaps, ownedEvidence, evidenceIndex } = lookups;
  const items = input.items.filter((i) => i.areaRef === area.areaRef && i.projectRef === project.projectRef);
  return `## Project: ${heading(project.title)}

- **Area:** [${prose(area.title)}](${pageMdHref(pageId.area(area.areaRef))}) (${inlineCode(area.areaRef)})
- **Project:** ${inlineCode(project.projectRef)}

### Items

${items.length ? items.map((item) => `- [${prose(item.title)}](${pageMdHref(pageId.item(item.itemRef))}) (${prose(item.age)})`).join('\n') : 'No items in this project.'}
${renderGapsMd(ownedGaps)}${renderEvidenceMd(ownedEvidence, evidenceIndex)}`;
}

function renderItemMd(item, input, lookups) {
  const { gapLink, ownedGaps, ownedEvidence, evidenceIndex } = lookups;
  const gapsLine = (item.gapRefs ?? []).length
    ? `- **Gaps:** ${(item.gapRefs ?? []).map(gapLink).join(', ')}\n`
    : '';
  const blocksMd = item.blocks.length ? `\n${blocksMarkdown(item.blocks, evidenceIndex, 3, '-')}` : '';
  const decisions = input.decisions.filter((d) => d.itemRef === item.itemRef);
  const decisionsMd = decisions.length
    ? `\n## Decisions\n\n${decisions.map((d) => renderDecisionMd(d, evidenceIndex)).join('\n')}`
    : '';

  return `## Item: ${heading(item.title)}${anchorDef(siteAnchor.item(item.itemRef))}

- **Item:** ${inlineCode(item.itemRef)}
- **Age:** ${prose(item.age)}
${gapsLine}${blocksMd}${decisionsMd}${renderGapsMd(ownedGaps)}${renderEvidenceMd(ownedEvidence, evidenceIndex)}`;
}

function renderPageHeaderMd(page, input, sourceSha256) {
  return `# ${heading(page.title)}

- **Site:** ${prose(input.title)}
- **Edition:** ${inlineCode(input.edition.editionId)}
- **Edition digest:** ${inlineCode(input.edition.editionDigest)}
- **Observed at:** ${prose(input.edition.observedAt)}
- **Coverage window:** ${prose(input.edition.coverage.from)} to ${prose(input.edition.coverage.to)}
- **Registry:** ${prose(input.registry.version)} (${inlineCode(input.registry.sha256)})
- **Source digest:** ${inlineCode(sourceSha256)}

`;
}

export function renderSiteMarkdownPages(input, { evidenceIndex, sourceSha256 }) {
  const pages = sitePages(input);
  const anchors = siteAnchors(input);
  const rendered = new Map();

  for (const page of pages) {
    const lookups = makeMdLookups(input, anchors, evidenceIndex, page.markdown, page.id);
    let bodyMd;
    if (page.id === '') {
      bodyMd = renderPortfolioMd(input, lookups);
    } else if (page.id === pageId.area(UNASSIGNED_AREA)) {
      bodyMd = renderUnassignedAreaMd(input, lookups);
    } else if (page.id.startsWith('area/') && !page.id.includes('/project/')) {
      const areaRef = page.id.slice('area/'.length);
      const area = input.areas.find((a) => a.areaRef === areaRef);
      bodyMd = renderAreaMd(area, input, lookups);
    } else if (page.id.includes('/project/')) {
      const [, areaRef, , projectRef] = page.id.split('/');
      const area = input.areas.find((a) => a.areaRef === areaRef);
      const project = area.projects.find((p) => p.projectRef === projectRef);
      bodyMd = renderProjectMd(area, project, input, lookups);
    } else if (page.id.startsWith('item/')) {
      const itemRef = page.id.slice('item/'.length);
      const item = input.items.find((i) => i.itemRef === itemRef);
      bodyMd = renderItemMd(item, input, lookups);
    } else {
      throw new Error(`unreachable: unknown page id ${JSON.stringify(page.id)}`);
    }
    const strictMd = `${renderPageHeaderMd(page, input, sourceSha256)}${bodyMd}${renderCitationDefinitionsMd(input, lookups)}`;
    rendered.set(page.markdown, relaxEscapes(assertAnchors(strictMd, evidenceIndex)));
  }
  return rendered;
}
