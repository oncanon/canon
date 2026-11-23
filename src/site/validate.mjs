// site-input/v1 validation (docs/projects/interactive-sitrep-contract.md, section 2).
//
// The site input is projected by the Producer from one edition. Publisher defines only what
// it needs to render, and the schema is closed: unknown members are errors. Value
// checks, the display block grammar and the evidence shape are the ones report/v1
// uses (src/report/validate.mjs), so one set of rules and limits governs both.
//
// What this validator guarantees to the builder:
//   - every ref fits the id rule and is unique ignoring ASCII case within its kind,
//     and every reference to a ref resolves to a declared one, by exact match;
//   - arrays keep the order they arrive in (nothing here sorts);
//   - a count is a measured number or null ("not recorded"), never a guess, and its
//     coverage agrees with which numbers are present;
//   - an item with no area names the gap that says why;
//   - a question can be answered: at least two options, or free text.
import { CONTENT_ID_PATTERN } from '../hash.mjs';
import { LIMITS } from '../policy.mjs';
import {
  Context, DATA_ORIGINS, ID_PATTERN, PUBLICATION_CLASSES, ReportValidationError, blockHtmlIds, checkArray, checkBlock,
  checkEnum, checkEvidence, checkEvidenceRefs, checkInline, checkObject, checkString, isPlainObject, parseReportText,
} from '../report/validate.mjs';

export const SITE_INPUT_SCHEMA = 'site-input/v1';

export const SITE_LIMITS = Object.freeze({
  inputBytes: 4 * 1024 * 1024,
  areas: 64,
  projectsPerArea: 64,
  items: 500,
  blocksPerItem: 200,
  decisions: 500,
  questionsPerDecision: 8,
  optionsPerQuestion: 12,
  freeTextChars: 4000,
  gaps: 500,
  gapRefs: 32,
  history: 64,
  countMax: 1_000_000_000,
});

// The page for items whose area is not mapped. No area may take this ref.
export const UNASSIGNED_AREA = 'unassigned';
export const COUNT_NAMES = Object.freeze(['waiting', 'moved', 'blocked']);
export const COVERAGE = Object.freeze(['complete', 'partial', 'unavailable']);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIME_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;
// A label the Producer owns (a decision kind, a gap kind). Publisher shows it and never interprets it.
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

const UNICODE_BLANK_FILLER_RE = /[\u115F\u1160\u180E\u2800\u3164\uFFA0]/g;
const NON_CALLOUT_PROSE_SRC = '[!"#%&\'*,/?@\\\\¡¿§¶†‡‰‱′″‴\\u02BC([{\\u2018\\u201C\\u2019\\u201D\\])}«‹+$£€¥¢°±×÷]';
const CALLOUT_STRICT_SEP_SRC = `(?!${NON_CALLOUT_PROSE_SRC})[\\p{P}\\p{S}\\p{M}\\p{Lm}]`;
const CALLOUT_TAIL_SRC = `(?:\\s+${CALLOUT_STRICT_SEP_SRC}|(?![-_\\u2010\\u2011](?![\\p{Lm}])[\\p{L}\\p{N}])${CALLOUT_STRICT_SEP_SRC})`;
const CALLOUT_PAREN_TAIL_SRC = `(?:\\s*\\([^)]*\\)\\s*${CALLOUT_STRICT_SEP_SRC}|${CALLOUT_TAIL_SRC})`;
const STANDALONE_CALLOUT_STRONG_RE = new RegExp(
  `^(?:recommendation${CALLOUT_PAREN_TAIL_SRC}|recommended\\s+(?:call|option|verdict)(?:${CALLOUT_TAIL_SRC}|$)|verdict${CALLOUT_PAREN_TAIL_SRC}|options${CALLOUT_TAIL_SRC}|free-text response${CALLOUT_TAIL_SRC}|supporting evidence${CALLOUT_TAIL_SRC})`,
  'iu',
);
const CALLOUT_BARE_LABEL_RE = /^(?:recommendation(?:\s*\([^)]*\))?|recommended\s+(?:call|option|verdict)|verdict(?:\s*\([^)]*\))?|options|free-text response|supporting evidence)$/iu;
const CALLOUT_LEAD_SEP_RE = new RegExp(`^[\\s\\p{Z}]*${CALLOUT_STRICT_SEP_SRC}`, 'u');

function inlineSegmentPlainText(seg) {
  if (typeof seg === 'string') return seg;
  if (!isPlainObject(seg)) return '';
  if (typeof seg.text === 'string') return seg.text;
  if (typeof seg.code === 'string') return seg.code;
  if (typeof seg.em === 'string') return seg.em;
  if (typeof seg.strong === 'string') return seg.strong;
  if (typeof seg.cite === 'string') return `[${seg.cite}]`;
  if (isPlainObject(seg.link) && typeof seg.link.text === 'string') return seg.link.text;
  return '';
}

function stripIgnorableChars(str) {
  return String(str ?? '')
    .replace(UNICODE_BLANK_FILLER_RE, ' ')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
}

function normCalloutLabel(str) {
  return stripIgnorableChars(str).normalize('NFKC').replace(/[\s\p{Z}]+/gu, ' ').trim();
}

function isCalloutWsOnly(str) {
  return /^[\s\p{Z}]*$/u.test(stripIgnorableChars(str));
}

function hasLeadingCalloutSep(str) {
  return CALLOUT_LEAD_SEP_RE.test(stripIgnorableChars(str).normalize('NFKC'));
}

function checkNoCalloutStrongString(ctx, path, value, { forbidBare = false } = {}) {
  if (typeof value !== 'string') return;
  const trimmed = normCalloutLabel(value);
  if (STANDALONE_CALLOUT_STRONG_RE.test(trimmed) || (forbidBare && CALLOUT_BARE_LABEL_RE.test(trimmed))) {
    ctx.error(path, 'callout-collision', `display label ${JSON.stringify(trimmed)} collides with reserved P14 decision/verdict callout label`);
  }
}

function inlinePlainText(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(inlineSegmentPlainText).join('');
  return '';
}

function checkNoFigureTitleCaptionCalloutCollision(ctx, bp, title, caption) {
  if (typeof title !== 'string') return;
  const trimmedTitle = normCalloutLabel(title);
  if (CALLOUT_BARE_LABEL_RE.test(trimmedTitle) && hasLeadingCalloutSep(inlinePlainText(caption))) {
    ctx.error(`${bp}/title`, 'callout-collision', `figure title ${JSON.stringify(trimmedTitle)} followed by punctuation-prefixed caption collides with reserved P14 callout label`);
  }
}

function checkNoInlineCalloutCollision(ctx, path, inlineVal, { standaloneLine = false } = {}) {
  if (!Array.isArray(inlineVal)) return;
  let atLineStart = standaloneLine;
  for (let i = 0; i < inlineVal.length; i += 1) {
    const seg = inlineVal[i];
    const segPlain = stripIgnorableChars(inlineSegmentPlainText(seg));
    if (!isPlainObject(seg) || typeof seg.strong !== 'string') {
      if (segPlain.includes('\n')) {
        const afterNl = segPlain.slice(segPlain.lastIndexOf('\n') + 1);
        atLineStart = isCalloutWsOnly(afterNl);
      } else if (!isCalloutWsOnly(segPlain)) {
        atLineStart = false;
      }
      continue;
    }

    let combined = stripIgnorableChars(seg.strong);
    let end = i;
    let reported = false;
    while (true) {
      const norm = normCalloutLabel(combined);
      if (STANDALONE_CALLOUT_STRONG_RE.test(norm)) {
        ctx.error(`${path}/${i}/strong`, 'callout-collision', `bold callout label ${JSON.stringify(norm)} is reserved for structured /decisions`);
        reported = true;
        break;
      }
      if (atLineStart && CALLOUT_BARE_LABEL_RE.test(norm)) {
        let rest = '';
        for (let k = end + 1; k < inlineVal.length; k += 1) rest += stripIgnorableChars(inlineSegmentPlainText(inlineVal[k]));
        if (hasLeadingCalloutSep(rest)) {
          ctx.error(`${path}/${i}/strong`, 'callout-collision', `leading bold callout label ${JSON.stringify(norm)} is reserved for structured /decisions`);
          reported = true;
          break;
        }
      }

      let probe = end + 1;
      let gapWs = '';
      while (probe < inlineVal.length) {
        const nxt = inlineVal[probe];
        if (isPlainObject(nxt) && typeof nxt.strong === 'string') break;
        const nxtPlain = stripIgnorableChars(inlineSegmentPlainText(nxt));
        if (isCalloutWsOnly(nxtPlain) && !nxtPlain.includes('\n')) {
          gapWs += nxtPlain;
          probe += 1;
        } else {
          probe = -1;
          break;
        }
      }
      if (probe > end && probe < inlineVal.length) {
        combined += gapWs + stripIgnorableChars(inlineVal[probe].strong);
        end = probe;
      } else {
        break;
      }
    }
    void reported;
    if (segPlain.includes('\n')) {
      const afterNl = segPlain.slice(segPlain.lastIndexOf('\n') + 1);
      atLineStart = isCalloutWsOnly(afterNl);
    } else if (!isCalloutWsOnly(segPlain)) {
      atLineStart = false;
    }
  }
}

function checkItemBlockCalloutCollisions(ctx, blocks, basePath) {
  if (!Array.isArray(blocks)) return;
  blocks.forEach((block, j) => {
    if (!isPlainObject(block)) return;
    const bp = `${basePath}/${j}`;
    switch (block.type) {
      case 'paragraph':
        checkNoInlineCalloutCollision(ctx, `${bp}/text`, block.text, { standaloneLine: true });
        break;
      case 'list':
        if (Array.isArray(block.items)) {
          block.items.forEach((it, k) => checkNoInlineCalloutCollision(ctx, `${bp}/items/${k}`, it, { standaloneLine: true }));
        }
        break;
      case 'finding':
        checkNoInlineCalloutCollision(ctx, `${bp}/claim`, block.claim, { standaloneLine: true });
        if (Array.isArray(block.detail)) checkItemBlockCalloutCollisions(ctx, block.detail, `${bp}/detail`);
        break;
      case 'risk':
        checkNoInlineCalloutCollision(ctx, `${bp}/mitigation`, block.mitigation, { standaloneLine: true });
        break;
      case 'requirement':
        checkNoInlineCalloutCollision(ctx, `${bp}/statement`, block.statement, { standaloneLine: true });
        if (Array.isArray(block.scenarios)) {
          block.scenarios.forEach((sc, k) => {
            if (isPlainObject(sc)) checkNoCalloutStrongString(ctx, `${bp}/scenarios/${k}/name`, sc.name, { forbidBare: true });
          });
        }
        break;
      case 'table': {
        const firstKey = Array.isArray(block.columns) && isPlainObject(block.columns[0]) && typeof block.columns[0].key === 'string'
          ? block.columns[0].key
          : null;
        if (Array.isArray(block.columns)) {
          block.columns.forEach((colObj, c) => {
            if (isPlainObject(colObj)) checkNoCalloutStrongString(ctx, `${bp}/columns/${c}/label`, colObj.label, { forbidBare: true });
          });
        }
        if (Array.isArray(block.rows)) {
          block.rows.forEach((row, r) => {
            if (!isPlainObject(row)) return;
            if (firstKey !== null && Object.hasOwn(row, firstKey)) {
              checkNoCalloutStrongString(ctx, `${bp}/rows/${r}/${firstKey}`, inlinePlainText(row[firstKey]), { forbidBare: true });
            }
            for (const [col, cell] of Object.entries(row)) {
              checkNoInlineCalloutCollision(ctx, `${bp}/rows/${r}/${col}`, cell, { standaloneLine: true });
            }
          });
        }
        break;
      }
      case 'comparison':
        checkNoCalloutStrongString(ctx, `${bp}/title`, block.title);
        checkNoFigureTitleCaptionCalloutCollision(ctx, bp, block.title, block.caption);
        checkNoInlineCalloutCollision(ctx, `${bp}/caption`, block.caption, { standaloneLine: true });
        for (const sideKey of ['left', 'right']) {
          const side = block[sideKey];
          if (!isPlainObject(side)) continue;
          checkNoCalloutStrongString(ctx, `${bp}/${sideKey}/label`, side.label, { forbidBare: true });
          checkNoInlineCalloutCollision(ctx, `${bp}/${sideKey}/summary`, side.summary, { standaloneLine: true });
          if (Array.isArray(side.items)) {
            side.items.forEach((it, k) => checkNoInlineCalloutCollision(ctx, `${bp}/${sideKey}/items/${k}`, it, { standaloneLine: true }));
          }
        }
        break;
      case 'code':
      case 'diff':
        checkNoCalloutStrongString(ctx, `${bp}/title`, block.title);
        checkNoFigureTitleCaptionCalloutCollision(ctx, bp, block.title, block.caption);
        checkNoInlineCalloutCollision(ctx, `${bp}/caption`, block.caption, { standaloneLine: true });
        break;
      case 'chart':
        checkNoCalloutStrongString(ctx, `${bp}/title`, block.title);
        checkNoFigureTitleCaptionCalloutCollision(ctx, bp, block.title, block.caption);
        checkNoInlineCalloutCollision(ctx, `${bp}/caption`, block.caption, { standaloneLine: true });
        checkNoCalloutStrongString(ctx, `${bp}/baselineLabel`, block.baselineLabel, { forbidBare: true });
        checkNoCalloutStrongString(ctx, `${bp}/candidateLabel`, block.candidateLabel, { forbidBare: true });
        if (Array.isArray(block.series)) {
          block.series.forEach((pt, k) => {
            if (isPlainObject(pt)) checkNoCalloutStrongString(ctx, `${bp}/series/${k}/label`, pt.label, { forbidBare: true });
          });
        }
        break;
      case 'metrics':
        if (Array.isArray(block.items)) {
          block.items.forEach((it, k) => {
            if (isPlainObject(it)) checkNoCalloutStrongString(ctx, `${bp}/items/${k}/label`, it.label);
          });
        }
        break;
      case 'diagram': {
        checkNoCalloutStrongString(ctx, `${bp}/title`, block.title);
        checkNoFigureTitleCaptionCalloutCollision(ctx, bp, block.title, block.caption);
        checkNoInlineCalloutCollision(ctx, `${bp}/caption`, block.caption, { standaloneLine: true });
        if (Array.isArray(block.nodes)) {
          block.nodes.forEach((nd, k) => {
            if (isPlainObject(nd)) checkNoCalloutStrongString(ctx, `${bp}/nodes/${k}/label`, nd.label);
          });
        }
        const topoLabelById = new Map();
        if (Array.isArray(block.groups)) {
          block.groups.forEach((grp, g) => {
            if (!isPlainObject(grp)) return;
            checkNoCalloutStrongString(ctx, `${bp}/groups/${g}/label`, grp.label);
            if (Array.isArray(grp.nodes)) {
              grp.nodes.forEach((nd, k) => {
                if (isPlainObject(nd)) {
                  checkNoCalloutStrongString(ctx, `${bp}/groups/${g}/nodes/${k}/label`, nd.label);
                  if (typeof nd.id === 'string' && typeof nd.label === 'string') topoLabelById.set(nd.id, nd.label);
                }
              });
            }
          });
        }
        if (Array.isArray(block.edges)) {
          block.edges.forEach((edge, ei) => {
            if (isPlainObject(edge) && typeof edge.from === 'string' && typeof edge.to === 'string') {
              const pair = `${topoLabelById.get(edge.from) ?? edge.from} -> ${topoLabelById.get(edge.to) ?? edge.to}`;
              checkNoCalloutStrongString(ctx, `${bp}/edges/${ei}`, pair, { forbidBare: true });
            }
          });
        }
        const actorLabelById = new Map();
        if (Array.isArray(block.actors)) {
          block.actors.forEach((ac, k) => {
            if (isPlainObject(ac)) {
              checkNoCalloutStrongString(ctx, `${bp}/actors/${k}/label`, ac.label, { forbidBare: true });
              if (typeof ac.id === 'string' && typeof ac.label === 'string') actorLabelById.set(ac.id, ac.label);
            }
          });
        }
        if (Array.isArray(block.messages)) {
          block.messages.forEach((msg, mi) => {
            if (isPlainObject(msg) && typeof msg.from === 'string' && typeof msg.to === 'string') {
              const fromLbl = actorLabelById.get(msg.from) ?? msg.from;
              const toLbl = actorLabelById.get(msg.to) ?? msg.to;
              checkNoCalloutStrongString(ctx, `${bp}/messages/${mi}`, `${fromLbl} → ${toLbl}`, { forbidBare: true });
              checkNoCalloutStrongString(ctx, `${bp}/messages/${mi}`, `${fromLbl} -> ${toLbl}`, { forbidBare: true });
            }
          });
        }
        if (Array.isArray(block.steps)) {
          block.steps.forEach((st, k) => {
            if (isPlainObject(st)) checkNoCalloutStrongString(ctx, `${bp}/steps/${k}/label`, st.label);
          });
        }
        break;
      }
      default:
        break;
    }
  });
}

export class SiteInputValidationError extends Error {
  constructor(errors) {
    super(`${SITE_INPUT_SCHEMA} validation failed:\n${errors.map((e) => `  ${e.code} ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'SiteInputValidationError';
    this.errors = errors;
  }
}

// One kind of ref. Declared refs are unique ignoring ASCII case, because an anchor is a
// CommonMark reference label and those match case-insensitively. A reference resolves by
// exact match only.
class Refs {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.byKey = new Map();
    this.exact = new Set();
  }

  declare(path, value) {
    if (!checkString(this.ctx, path, value, { pattern: ID_PATTERN, max: 64 }) || !ID_PATTERN.test(value)) return false;
    const key = value.toLowerCase();
    if (this.byKey.has(key)) {
      const prior = this.byKey.get(key);
      this.ctx.error(path, 'duplicate-id', prior.value === value ? `${this.kind} "${value}" already used at ${prior.path}` : `${this.kind} "${value}" differs only in case from "${prior.value}" at ${prior.path}`);
      return false;
    }
    this.byKey.set(key, { path, value });
    this.exact.add(value);
    return true;
  }

  resolve(path, value) {
    if (typeof value !== 'string') {
      this.ctx.error(path, 'type', 'expected string');
      return false;
    }
    if (!this.exact.has(value)) {
      this.ctx.error(path, 'unknown-ref', `no ${this.kind} "${value}" is declared`);
      return false;
    }
    return true;
  }
}

function checkRefList(ctx, path, value, refs, { min = 0 } = {}) {
  if (!checkArray(ctx, path, value, { min, max: SITE_LIMITS.gapRefs })) return;
  const seen = new Set();
  value.forEach((ref, i) => {
    const p = `${path}/${i}`;
    if (!refs.resolve(p, ref)) return;
    if (seen.has(ref)) ctx.error(p, 'duplicate-reference', `${refs.kind} "${ref}" listed twice`);
    seen.add(ref);
  });
}

function checkTime(ctx, path, value) {
  return checkString(ctx, path, value, { pattern: TIME_PATTERN, max: 20 }) && TIME_PATTERN.test(value);
}

function checkEdition(ctx, edition) {
  if (!checkObject(ctx, '/edition', edition, ['editionId', 'editionDigest', 'observedAt', 'coverage'])) return;
  checkString(ctx, '/edition/editionId', edition.editionId, { max: 200 });
  checkString(ctx, '/edition/editionDigest', edition.editionDigest, { pattern: SHA256_PATTERN, max: 64 });
  checkTime(ctx, '/edition/observedAt', edition.observedAt);
  if (checkObject(ctx, '/edition/coverage', edition.coverage, ['from', 'to'])) {
    const from = checkTime(ctx, '/edition/coverage/from', edition.coverage.from);
    const to = checkTime(ctx, '/edition/coverage/to', edition.coverage.to);
    // Fixed-width UTC text orders as time does.
    if (from && to && edition.coverage.from > edition.coverage.to) ctx.error('/edition/coverage', 'range', 'the coverage window ends before it starts');
  }
}

function checkGaps(ctx, gaps, refs) {
  if (!checkArray(ctx, '/gaps', gaps, { max: SITE_LIMITS.gaps })) return;
  gaps.forEach((gap, i) => {
    const p = `/gaps/${i}`;
    if (!checkObject(ctx, p, gap, ['gapRef', 'kind', 'text'])) return;
    refs.gap.declare(`${p}/gapRef`, gap.gapRef);
    checkNoCalloutStrongString(ctx, `${p}/gapRef`, gap.gapRef);
    checkString(ctx, `${p}/kind`, gap.kind, { pattern: KIND_PATTERN, max: 40 });
    checkString(ctx, `${p}/text`, gap.text, { max: 500 });
  });
}

// A count is a number the Producer measured, or null for "not recorded". Zero is a measured zero.
// Coverage must agree with what is present, so a card can never show a number it does not
// have or hide one it does.
function checkCounts(ctx, path, counts, refs) {
  if (!checkObject(ctx, path, counts, [...COUNT_NAMES, 'coverage', 'gapRefs', 'unit'])) return;
  let recorded = 0;
  let typed = true;
  for (const name of COUNT_NAMES) {
    const value = counts[name];
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > SITE_LIMITS.countMax) {
      ctx.error(`${path}/${name}`, 'type', `expected null or a whole number from 0 to ${SITE_LIMITS.countMax}`);
      typed = false;
      continue;
    }
    recorded += 1;
  }
  checkEnum(ctx, `${path}/coverage`, counts.coverage, COVERAGE);
  checkString(ctx, `${path}/unit`, counts.unit, { max: 80 });
  checkRefList(ctx, `${path}/gapRefs`, counts.gapRefs, refs.gap);
  if (!typed) return;
  if (counts.coverage === 'complete' && recorded !== COUNT_NAMES.length) ctx.error(`${path}/coverage`, 'consistency', 'complete coverage needs every count recorded');
  if (counts.coverage === 'unavailable' && recorded !== 0) ctx.error(`${path}/coverage`, 'consistency', 'unavailable coverage may not carry a recorded count');
  if ((counts.coverage === 'partial' || counts.coverage === 'unavailable') && Array.isArray(counts.gapRefs) && counts.gapRefs.length === 0) {
    ctx.error(`${path}/gapRefs`, 'consistency', `${counts.coverage} coverage must name the gap that explains it`);
  }
}

// Returns a map from each declared areaRef to the set of its projectRefs.
function checkAreas(ctx, areas, refs) {
  const projectsByArea = new Map();
  if (!checkArray(ctx, '/areas', areas, { max: SITE_LIMITS.areas })) return projectsByArea;
  areas.forEach((area, i) => {
    const p = `/areas/${i}`;
    if (!checkObject(ctx, p, area, ['areaRef', 'title', 'counts', 'projects'])) return;
    const declared = refs.area.declare(`${p}/areaRef`, area.areaRef);
    if (declared && area.areaRef.toLowerCase() === UNASSIGNED_AREA) {
      ctx.error(`${p}/areaRef`, 'reserved-ref', `"${UNASSIGNED_AREA}" is the page for items with no area`);
    }
    checkString(ctx, `${p}/title`, area.title, { max: 120 });
    checkCounts(ctx, `${p}/counts`, area.counts, refs);
    const projects = new Refs(ctx, 'projectRef');
    if (checkArray(ctx, `${p}/projects`, area.projects, { max: SITE_LIMITS.projectsPerArea })) {
      area.projects.forEach((project, j) => {
        const pp = `${p}/projects/${j}`;
        if (!checkObject(ctx, pp, project, ['projectRef', 'title'])) return;
        projects.declare(`${pp}/projectRef`, project.projectRef);
        checkString(ctx, `${pp}/title`, project.title, { max: 120 });
      });
    }
    if (declared) projectsByArea.set(area.areaRef, projects);
  });
  return projectsByArea;
}

function checkBlockHtmlIdCollisions(ctx, blocks, basePath, seenHtmlIds = new Set()) {
  if (!Array.isArray(blocks)) return;
  blocks.forEach((block, j) => {
    if (!isPlainObject(block)) return;
    const bp = `${basePath}/${j}`;
    const ids = blockHtmlIds(block, { recurse: false });
    if (ids.some((id) => seenHtmlIds.has(id.toLowerCase()))) {
      ctx.error(`${bp}/id`, 'duplicate-id', `block id "${block.id}" collides with a generated sub-element HTML id on the same item`);
    }
    for (const id of ids) seenHtmlIds.add(id.toLowerCase());
    if (Array.isArray(block.detail)) checkBlockHtmlIdCollisions(ctx, block.detail, `${bp}/detail`, seenHtmlIds);
  });
}

function checkItems(ctx, items, refs, projectsByArea) {
  if (!checkArray(ctx, '/items', items, { max: SITE_LIMITS.items })) return;
  items.forEach((item, i) => {
    const p = `/items/${i}`;
    if (!checkObject(ctx, p, item, ['itemRef', 'areaRef', 'projectRef', 'title', 'age', 'blocks'], ['gapRefs'])) return;
    refs.item.declare(`${p}/itemRef`, item.itemRef);
    checkString(ctx, `${p}/title`, item.title, { max: 200 });
    checkString(ctx, `${p}/age`, item.age, { max: 80 });
    checkNoCalloutStrongString(ctx, `${p}/age`, item.age);
    if (Object.hasOwn(item, 'gapRefs')) checkRefList(ctx, `${p}/gapRefs`, item.gapRefs, refs.gap, { min: 1 });

    // No derived mapping: an unmapped item says so with a named gap, and is never guessed
    // into an area from its name.
    const areaKnown = item.areaRef !== null && refs.area.resolve(`${p}/areaRef`, item.areaRef);
    if (item.areaRef === null) {
      if (!Object.hasOwn(item, 'gapRefs')) ctx.error(`${p}/gapRefs`, 'consistency', 'an item with no area must name the gap that says why');
      if (item.projectRef !== null) ctx.error(`${p}/projectRef`, 'consistency', 'an item with no area cannot name a project');
    } else if (item.projectRef !== null && areaKnown) {
      projectsByArea.get(item.areaRef).resolve(`${p}/projectRef`, item.projectRef);
    }

    if (checkArray(ctx, `${p}/blocks`, item.blocks, { max: SITE_LIMITS.blocksPerItem })) {
      item.blocks.forEach((block, j) => {
        const bp = `${p}/blocks/${j}`;
        // A report/v1 decision block would take the same "d-" anchor as a site decision
        // and carries no refs to answer against.
        if (isPlainObject(block) && block.type === 'decision') {
          ctx.error(`${bp}/type`, 'enum', 'a decision is declared in /decisions, not as a display block');
          return;
        }
        checkBlock(ctx, bp, block);
      });
      checkBlockHtmlIdCollisions(ctx, item.blocks, `${p}/blocks`);
      checkItemBlockCalloutCollisions(ctx, item.blocks, `${p}/blocks`);
    }
  });
}

function checkQuestion(ctx, path, question, refs) {
  if (!checkObject(ctx, path, question, ['questionRef', 'text', 'options', 'recommendation', 'freeText'], ['evidence'])) return;
  refs.question.declare(`${path}/questionRef`, question.questionRef);
  checkString(ctx, `${path}/text`, question.text, { max: 500 });

  // optionRef is the Producer's mapped ref, scoped to its question. The original option ids never
  // arrive here.
  const options = new Refs(ctx, 'optionRef');
  const optionsOk = checkArray(ctx, `${path}/options`, question.options, { max: SITE_LIMITS.optionsPerQuestion });
  if (optionsOk) {
    question.options.forEach((option, i) => {
      const p = `${path}/options/${i}`;
      if (!checkObject(ctx, p, option, ['optionRef', 'label', 'summary'])) return;
      options.declare(`${p}/optionRef`, option.optionRef);
      checkString(ctx, `${p}/label`, option.label, { max: 120 });
      checkNoCalloutStrongString(ctx, `${p}/label`, option.label, { forbidBare: true });
      checkInline(ctx, `${p}/summary`, option.summary);
      checkNoInlineCalloutCollision(ctx, `${p}/summary`, option.summary, { standaloneLine: true });
    });
  }

  if (checkObject(ctx, `${path}/recommendation`, question.recommendation, ['text'], ['optionRef'])) {
    checkInline(ctx, `${path}/recommendation/text`, question.recommendation.text);
    checkNoInlineCalloutCollision(ctx, `${path}/recommendation/text`, question.recommendation.text, { standaloneLine: true });
    if (Object.hasOwn(question.recommendation, 'optionRef')) options.resolve(`${path}/recommendation/optionRef`, question.recommendation.optionRef);
  }

  let freeTextAllowed = null;
  if (checkObject(ctx, `${path}/freeText`, question.freeText, ['allowed'], ['maxChars'])) {
    const { allowed } = question.freeText;
    const hasMax = Object.hasOwn(question.freeText, 'maxChars');
    if (typeof allowed !== 'boolean') {
      ctx.error(`${path}/freeText/allowed`, 'type', 'expected boolean');
    } else {
      freeTextAllowed = allowed;
      if (allowed && !hasMax) ctx.error(`${path}/freeText/maxChars`, 'required', 'free text needs its limit');
      if (!allowed && hasMax) ctx.error(`${path}/freeText/maxChars`, 'consistency', 'a limit without free text');
    }
    if (hasMax) {
      const max = question.freeText.maxChars;
      if (!Number.isSafeInteger(max) || max < 1 || max > SITE_LIMITS.freeTextChars) {
        ctx.error(`${path}/freeText/maxChars`, 'type', `expected a whole number from 1 to ${SITE_LIMITS.freeTextChars}`);
      }
    }
  }

  if (optionsOk && freeTextAllowed === false && question.options.length < 2) {
    ctx.error(`${path}/options`, 'consistency', 'a question needs at least two options, or free text');
  }
  if (Object.hasOwn(question, 'evidence')) checkEvidenceRefs(ctx, `${path}/evidence`, question.evidence, question.questionRef);
}

function checkDecisions(ctx, decisions, refs) {
  if (!checkArray(ctx, '/decisions', decisions, { max: SITE_LIMITS.decisions })) return;
  decisions.forEach((decision, i) => {
    const p = `/decisions/${i}`;
    if (!checkObject(ctx, p, decision, ['decisionRef', 'label', 'kind', 'itemRef', 'questions'])) return;
    refs.decision.declare(`${p}/decisionRef`, decision.decisionRef);
    checkString(ctx, `${p}/label`, decision.label, { max: 200 });
    checkString(ctx, `${p}/kind`, decision.kind, { pattern: KIND_PATTERN, max: 40 });
    refs.item.resolve(`${p}/itemRef`, decision.itemRef);
    if (checkArray(ctx, `${p}/questions`, decision.questions, { min: 1, max: SITE_LIMITS.questionsPerDecision })) {
      decision.questions.forEach((question, j) => checkQuestion(ctx, `${p}/questions/${j}`, question, refs));
    }
  });
}

// A history entry names an earlier bundle. Its contentId can only come from a verified
// binding record, which is the Producer's to hold; here it is checked for shape and repeats.
function checkHistory(ctx, history) {
  if (!checkArray(ctx, '/history', history, { min: 1, max: SITE_LIMITS.history })) return;
  const seen = new Set();
  history.forEach((entry, i) => {
    const p = `/history/${i}`;
    if (!checkObject(ctx, p, entry, ['editionId', 'contentId', 'observedAt'])) return;
    checkString(ctx, `${p}/editionId`, entry.editionId, { max: 200 });
    checkTime(ctx, `${p}/observedAt`, entry.observedAt);
    if (checkString(ctx, `${p}/contentId`, entry.contentId, { pattern: CONTENT_ID_PATTERN, max: 71 })) {
      if (seen.has(entry.contentId)) ctx.error(`${p}/contentId`, 'duplicate-reference', 'the same bundle is listed twice');
      seen.add(entry.contentId);
    }
  });
}

export function validateSiteInput(input) {
  const ctx = new Context(SITE_INPUT_SCHEMA);
  if (!checkObject(ctx, '', input, ['schema', 'title', 'edition', 'registry', 'areas', 'items', 'decisions', 'evidence', 'gaps'], ['history', 'publication'])) {
    if (!isPlainObject(input)) throw new SiteInputValidationError(ctx.errors);
  }
  if (input.schema !== SITE_INPUT_SCHEMA) ctx.error('/schema', 'schema-version', `expected "${SITE_INPUT_SCHEMA}"`);
  checkString(ctx, '/title', input.title, { max: 200 });
  checkNoCalloutStrongString(ctx, '/title', input.title, { forbidBare: true });
  checkEdition(ctx, input.edition);

  // Optional publication extension, the same as report/v1's (docs/v2/publication-protocol.md
  // §6). Absent, a site is exactly a V1 site and its bundle bytes are unchanged.
  if (Object.hasOwn(input, 'publication') && checkObject(ctx, '/publication', input.publication, [], ['classification', 'dataOrigin'])) {
    if (Object.hasOwn(input.publication, 'classification')) checkEnum(ctx, '/publication/classification', input.publication.classification, PUBLICATION_CLASSES);
    if (Object.hasOwn(input.publication, 'dataOrigin')) checkEnum(ctx, '/publication/dataOrigin', input.publication.dataOrigin, DATA_ORIGINS);
  }
  if (checkObject(ctx, '/registry', input.registry, ['version', 'sha256'])) {
    checkString(ctx, '/registry/version', input.registry.version, { max: 80 });
    checkString(ctx, '/registry/sha256', input.registry.sha256, { pattern: SHA256_PATTERN, max: 64 });
  }

  const refs = {
    gap: new Refs(ctx, 'gapRef'),
    area: new Refs(ctx, 'areaRef'),
    item: new Refs(ctx, 'itemRef'),
    decision: new Refs(ctx, 'decisionRef'),
    question: new Refs(ctx, 'questionRef'),
  };
  // Declarations before the references to them: gaps, then areas, items and decisions.
  checkGaps(ctx, input.gaps, refs);
  checkEvidence(ctx, '/evidence', input.evidence);
  if (Array.isArray(input.evidence)) {
    input.evidence.forEach((ev, i) => {
      if (isPlainObject(ev)) checkNoCalloutStrongString(ctx, `/evidence/${i}/title`, ev.title);
    });
  }
  const projectsByArea = checkAreas(ctx, input.areas, refs);
  checkItems(ctx, input.items, refs, projectsByArea);
  checkDecisions(ctx, input.decisions, refs);
  if (Object.hasOwn(input, 'history')) checkHistory(ctx, input.history);

  if (ctx.blocks > LIMITS.blocksTotal) ctx.error('/items', 'limit', `more than ${LIMITS.blocksTotal} blocks`);
  if (ctx.codeBytes > LIMITS.codeBytesTotal) ctx.error('/items', 'limit', `more than ${LIMITS.codeBytesTotal} bytes of code`);
  for (const citation of ctx.citations) {
    if (!ctx.evidenceIds.has(citation.id)) ctx.error(citation.path, 'unknown-evidence', `cites unknown evidence "${citation.id}"`);
  }

  if (ctx.errors.length > 0) throw new SiteInputValidationError(ctx.errors);
  return input;
}

// Bounded JSON parsing, as for report/v1: size and nesting depth are checked on the raw
// text before JSON.parse runs.
export function parseSiteInputText(text) {
  try {
    return parseReportText(text, { maxBytes: SITE_LIMITS.inputBytes, label: 'site input' });
  } catch (err) {
    if (err instanceof ReportValidationError) throw new SiteInputValidationError(err.errors);
    throw err;
  }
}
