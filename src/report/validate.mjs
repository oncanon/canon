// report/v1 validation. The source schema is closed: unknown members are errors,
// and layout escape hatches (raw HTML, styles, classes, templates, scripts) get a
// dedicated error code so authors learn that presentation is not theirs to supply.
import { LIMITS, REPORT_SCHEMA } from '../policy.mjs';

export class ReportValidationError extends Error {
  constructor(errors) {
    super(`report/v1 validation failed:\n${errors.map((e) => `  ${e.code} ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'ReportValidationError';
    this.errors = errors;
  }
}

const ESCAPE_HATCHES = new Set([
  'html', 'rawHtml', 'raw', 'innerHTML', 'dangerouslySetInnerHTML', 'style', 'styles', 'css',
  'class', 'className', 'classes', 'script', 'scripts', 'template', 'layout', 'attributes',
  'attrs', 'markup', 'svg', 'iframe', 'embed',
]);

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
export const PUBLICATION_CLASSES = ['public', 'private-review', 'confidential'];
export const DATA_ORIGINS = ['synthetic', 'production'];
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const LANGUAGE_PATTERN = /^[a-z][a-z0-9+-]{0,23}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// C0 controls other than TAB/LF, DEL, C1 controls, bidi embedding/override/isolate
// controls (Trojan Source), and the BOM/zero-width no-break space.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/u;

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const CONFIDENCE = ['proven', 'recommended', 'defect', 'open'];
export const VERIFICATION_BANDS = ['code', 'judgment', 'review', 'needs-review'];
export const EARS_PATTERNS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional'];
export const DIAGRAM_ROLES = ['entry', 'core', 'store', 'gate', 'external'];
export const EDGE_STYLES = ['solid', 'dashed', 'gate'];
export const ACTOR_KINDS = ['actor', 'service', 'store', 'verifier'];
export const MESSAGE_KINDS = ['sync', 'async', 'reply', 'self'];
export const COMPARISON_TONES = ['legacy', 'proposed', 'neutral'];
export const STATUSES = ['draft', 'proposed', 'final'];
export const LEVELS = ['low', 'medium', 'high'];
export const CODE_LANGUAGES = ['typescript', 'javascript', 'json', 'shell', 'yaml', 'text'];

export class Context {
  constructor(schema = REPORT_SCHEMA) {
    this.errors = []; this.schema = schema;
    this.ids = new Map();
    this.evidenceIds = new Set();
    this.citations = [];
    this.blocks = 0;
    this.codeBytes = 0;
  }

  error(path, code, message) {
    this.errors.push({ path, code, message });
  }

  // Ids are unique ignoring ASCII case: report.md anchors are CommonMark reference
  // labels, which match case-insensitively (docs/decisions/phase1-contract.md D10).
  claimId(path, id) {
    const key = id.toLowerCase();
    if (this.ids.has(key)) {
      const { path: first, id: prior } = this.ids.get(key);
      this.error(path, 'duplicate-id', prior === id ? `id "${id}" already used at ${first}` : `id "${id}" differs only in case from "${prior}" at ${first}`);
    } else {
      this.ids.set(key, { path, id });
    }
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkObject(ctx, path, value, required, optional = []) {
  if (!isPlainObject(value)) {
    ctx.error(path, 'type', 'expected object');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (ESCAPE_HATCHES.has(key)) {
      ctx.error(`${path}/${key}`, 'escape-hatch', `layout/markup escape hatch "${key}" is not part of ${ctx.schema}`);
    } else {
      ctx.error(`${path}/${key}`, 'unknown-member', `unknown member "${key}"`);
    }
  }
  let ok = true;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      ctx.error(`${path}/${key}`, 'required', 'missing required member');
      ok = false;
    }
  }
  return ok;
}

const UNICODE_BLANK_FILLER_RE = /[\u115F\u1160\u180E\u2800\u3164\uFFA0]/g;

export function hasVisibleText(str) {
  return str
    .replace(UNICODE_BLANK_FILLER_RE, '')
    .replace(/[\s\p{Z}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '')
    .length > 0;
}

export function checkString(ctx, path, value, { min = 1, max = LIMITS.stringChars, pattern, multiline = false, allowWhitespaceOnly = false } = {}) {
  if (typeof value !== 'string') {
    ctx.error(path, 'type', 'expected string');
    return false;
  }
  if (value.length < min) ctx.error(path, 'length', `must be at least ${min} characters`);
  else if (min >= 1 && !allowWhitespaceOnly && !hasVisibleText(value)) ctx.error(path, 'length', 'must contain at least one non-whitespace character');
  if (value.length > max) ctx.error(path, 'limit', `exceeds ${max} characters`);
  if (FORBIDDEN_CHARS.test(value)) ctx.error(path, 'forbidden-character', 'contains a control, bidi-override, or BOM character');
  if (!multiline && /[\n\t]/.test(value)) ctx.error(path, 'forbidden-character', 'line breaks and tabs are not allowed here');
  if (value.normalize('NFC') !== value) ctx.error(path, 'unicode-normalization', 'string must be NFC-normalized');
  if (pattern && !pattern.test(value)) ctx.error(path, 'pattern', `does not match ${pattern}`);
  return true;
}

export function checkEnum(ctx, path, value, allowed) {
  if (!allowed.includes(value)) ctx.error(path, 'enum', `must be one of ${allowed.join(', ')}`);
}

export function checkArray(ctx, path, value, { min = 0, max }) {
  if (!Array.isArray(value)) {
    ctx.error(path, 'type', 'expected array');
    return false;
  }
  if (value.length < min) ctx.error(path, 'length', `must contain at least ${min} item(s)`);
  if (value.length > max) ctx.error(path, 'limit', `exceeds ${max} items`);
  return true;
}

function checkId(ctx, path, value) {
  if (checkString(ctx, path, value, { pattern: ID_PATTERN, max: 64 })) ctx.claimId(path, value);
}

export function checkHttpsUrl(ctx, path, value) {
  if (!checkString(ctx, path, value, { max: LIMITS.urlChars })) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    ctx.error(path, 'unsafe-url', 'not an absolute URL');
    return;
  }
  if (url.protocol !== 'https:') {
    ctx.error(path, 'unsafe-url', `scheme "${url.protocol}" is not allowed; only https: links are permitted`);
    return;
  }
  if (url.username || url.password) ctx.error(path, 'unsafe-url', 'credentials in URLs are not allowed');
  if (url.href !== value) ctx.error(path, 'unsafe-url', 'URL must be in normalized form');
}

// Inline text: a plain string, or an array of typed segments. No markup is ever
// interpreted; every segment is escaped at render time.
export function checkInline(ctx, path, value) {
  if (typeof value === 'string') {
    checkString(ctx, path, value);
    return;
  }
  if (!checkArray(ctx, path, value, { min: 1, max: 200 })) return;
  let hasVisibleSegment = false;
  value.forEach((segment, i) => {
    const p = `${path}/${i}`;
    if (typeof segment === 'string') {
      checkString(ctx, p, segment, { allowWhitespaceOnly: value.length > 1 });
      if (hasVisibleText(segment)) hasVisibleSegment = true;
      return;
    }
    if (!isPlainObject(segment)) {
      ctx.error(p, 'type', 'expected string or segment object');
      return;
    }
    const keys = Object.keys(segment);
    const kinds = ['text', 'code', 'em', 'strong', 'cite', 'link'];
    const kind = keys.find((k) => kinds.includes(k));
    if (!kind) {
      checkObject(ctx, p, segment, ['text']);
      return;
    }
    if (kind === 'link') {
      checkObject(ctx, p, segment, ['link']);
      if (checkObject(ctx, `${p}/link`, segment.link, ['href', 'text'])) {
        checkHttpsUrl(ctx, `${p}/link/href`, segment.link.href);
        checkString(ctx, `${p}/link/text`, segment.link.text, { max: 500 });
        if (typeof segment.link?.text === 'string' && hasVisibleText(segment.link.text)) hasVisibleSegment = true;
      }
      return;
    }
    checkObject(ctx, p, segment, [kind]);
    if (kind === 'cite') {
      if (checkString(ctx, `${p}/cite`, segment.cite, { pattern: ID_PATTERN, max: 64 })) {
        ctx.citations.push({ path: `${p}/cite`, id: segment.cite, from: null });
        hasVisibleSegment = true;
      }
    } else {
      checkString(ctx, `${p}/${kind}`, segment[kind], { allowWhitespaceOnly: kind === 'text' && value.length > 1 });
      if (typeof segment[kind] === 'string' && hasVisibleText(segment[kind])) hasVisibleSegment = true;
    }
  });
  if (value.length > 0 && !hasVisibleSegment) {
    ctx.error(path, 'length', 'inline text must contain at least one non-whitespace character');
  }
}

export function checkEvidenceRefs(ctx, path, value, from) {
  if (!checkArray(ctx, path, value, { min: 1, max: 32 })) return;
  const seen = new Set();
  value.forEach((ref, i) => {
    const p = `${path}/${i}`;
    if (!checkString(ctx, p, ref, { pattern: ID_PATTERN, max: 64 })) return;
    if (seen.has(ref)) ctx.error(p, 'duplicate-reference', `evidence "${ref}" cited twice`);
    seen.add(ref);
    ctx.citations.push({ path: p, id: ref, from });
  });
}

export function checkCodeSource(ctx, path, source) {
  if (!checkString(ctx, path, source, { max: LIMITS.codeBytesPerBlock, multiline: true })) return;
  const bytes = Buffer.byteLength(source, 'utf8');
  ctx.codeBytes += bytes;
  if (bytes > LIMITS.codeBytesPerBlock) ctx.error(path, 'limit', `exceeds ${LIMITS.codeBytesPerBlock} bytes`);
  const lines = source.split('\n');
  if (lines.length > LIMITS.codeLinesPerBlock) ctx.error(path, 'limit', `exceeds ${LIMITS.codeLinesPerBlock} lines`);
  const longest = lines.findIndex((line) => line.length > LIMITS.codeLineChars);
  if (longest !== -1) ctx.error(path, 'limit', `line ${longest + 1} exceeds ${LIMITS.codeLineChars} characters`);
}

function checkLineRanges(ctx, path, value, lineCount) {
  if (!checkArray(ctx, path, value, { min: 1, max: 64 })) return;
  value.forEach((range, i) => {
    const p = `${path}/${i}`;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)) {
      ctx.error(p, 'type', 'expected [firstLine, lastLine] integers');
      return;
    }
    const [a, b] = range;
    if (a < 1 || b < a || b > lineCount) ctx.error(p, 'range', `range must satisfy 1 <= first <= last <= ${lineCount}`);
  });
}

const DETAIL_BLOCKS = new Set(['paragraph', 'list', 'code']);

function checkFiniteNumber(ctx, path, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) {
    ctx.error(path, 'type', 'expected a finite number between 0 and 1e12');
    return false;
  }
  return true;
}

function checkVerification(ctx, path, value) {
  if (!checkObject(ctx, path, value, ['band'], ['detail'])) return;
  checkEnum(ctx, `${path}/band`, value.band, VERIFICATION_BANDS);
  if (Object.hasOwn(value, 'detail')) checkString(ctx, `${path}/detail`, value.detail, { max: 200 });
}

function checkComparisonSide(ctx, path, side) {
  if (!checkObject(ctx, path, side, ['label', 'summary'], ['tone', 'items', 'code'])) return;
  checkString(ctx, `${path}/label`, side.label, { max: 120 });
  if (Object.hasOwn(side, 'tone')) checkEnum(ctx, `${path}/tone`, side.tone, COMPARISON_TONES);
  checkInline(ctx, `${path}/summary`, side.summary);
  if (Object.hasOwn(side, 'items') && checkArray(ctx, `${path}/items`, side.items, { min: 1, max: 12 })) {
    side.items.forEach((item, i) => checkInline(ctx, `${path}/items/${i}`, item));
  }
  if (Object.hasOwn(side, 'code') && checkObject(ctx, `${path}/code`, side.code, ['language', 'source'])) {
    checkEnum(ctx, `${path}/code/language`, side.code.language, CODE_LANGUAGES);
    checkCodeSource(ctx, `${path}/code/source`, side.code.source);
  }
}

export function checkBlock(ctx, path, block, { detail = false } = {}) {
  ctx.blocks += 1;
  if (!isPlainObject(block)) {
    ctx.error(path, 'type', 'expected block object');
    return;
  }
  const type = block.type;
  if (detail && !DETAIL_BLOCKS.has(type)) {
    ctx.error(`${path}/type`, 'enum', 'finding detail may only contain paragraph, list, or code blocks');
    return;
  }
  switch (type) {
    case 'paragraph':
      checkObject(ctx, path, block, ['type', 'text']);
      checkInline(ctx, `${path}/text`, block.text);
      return;
    case 'list':
      checkObject(ctx, path, block, ['type', 'items'], ['ordered']);
      if (Object.hasOwn(block, 'ordered') && typeof block.ordered !== 'boolean') ctx.error(`${path}/ordered`, 'type', 'expected boolean');
      if (checkArray(ctx, `${path}/items`, block.items, { min: 1, max: LIMITS.listItems })) {
        block.items.forEach((item, i) => checkInline(ctx, `${path}/items/${i}`, item));
      }
      return;
    case 'finding':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'severity', 'confidence', 'claim', 'evidence'], ['detail', 'verification']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/severity`, block.severity, SEVERITIES);
      checkEnum(ctx, `${path}/confidence`, block.confidence, CONFIDENCE);
      checkInline(ctx, `${path}/claim`, block.claim);
      checkEvidenceRefs(ctx, `${path}/evidence`, block.evidence, block.id);
      if (Object.hasOwn(block, 'verification')) checkVerification(ctx, `${path}/verification`, block.verification);
      if (Object.hasOwn(block, 'detail') && checkArray(ctx, `${path}/detail`, block.detail, { min: 1, max: 20 })) {
        block.detail.forEach((b, i) => checkBlock(ctx, `${path}/detail/${i}`, b, { detail: true }));
      }
      return;
    case 'decision':
      checkObject(ctx, path, block, ['type', 'id', 'question', 'status', 'recommendation', 'alternatives'], ['owner', 'context', 'consequences']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/question`, block.question, { max: 500 });
      checkEnum(ctx, `${path}/status`, block.status, ['needed', 'decided']);
      checkInline(ctx, `${path}/recommendation`, block.recommendation);
      if (Object.hasOwn(block, 'owner')) checkString(ctx, `${path}/owner`, block.owner, { max: 120 });
      if (Object.hasOwn(block, 'context')) checkInline(ctx, `${path}/context`, block.context);
      if (Object.hasOwn(block, 'consequences') && checkArray(ctx, `${path}/consequences`, block.consequences, { min: 1, max: 8 })) {
        block.consequences.forEach((item, i) => checkInline(ctx, `${path}/consequences/${i}`, item));
      }
      if (checkArray(ctx, `${path}/alternatives`, block.alternatives, { min: 2, max: 8 })) {
        let chosen = 0;
        let recommended = 0;
        block.alternatives.forEach((alt, i) => {
          const p = `${path}/alternatives/${i}`;
          checkObject(ctx, p, alt, ['label', 'summary'], ['chosen', 'recommended']);
          checkString(ctx, `${p}/label`, alt?.label, { max: 120 });
          checkInline(ctx, `${p}/summary`, alt?.summary);
          if (alt && Object.hasOwn(alt, 'chosen')) {
            if (typeof alt.chosen !== 'boolean') ctx.error(`${p}/chosen`, 'type', 'expected boolean');
            else if (alt.chosen) chosen += 1;
          }
          // Additive (render-policy-2.md R4): optional, `true` only; leave it out instead of false.
          if (alt && Object.hasOwn(alt, 'recommended')) {
            if (alt.recommended !== true) ctx.error(`${p}/recommended`, 'type', 'expected true (omit the member instead of false)');
            else recommended += 1;
          }
        });
        if (recommended > 1) ctx.error(`${path}/alternatives`, 'consistency', 'at most one alternative may be recommended');
        if (block.status === 'decided' && chosen !== 1) ctx.error(`${path}/alternatives`, 'consistency', 'a decided decision needs exactly one chosen alternative');
        if (block.status === 'needed' && chosen !== 0) ctx.error(`${path}/alternatives`, 'consistency', 'an open decision may not mark a chosen alternative');
      }
      return;
    case 'risk':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'likelihood', 'impact', 'mitigation']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/likelihood`, block.likelihood, LEVELS);
      checkEnum(ctx, `${path}/impact`, block.impact, LEVELS);
      checkInline(ctx, `${path}/mitigation`, block.mitigation);
      return;
    case 'code':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'language', 'source'], ['highlight', 'caption']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkString(ctx, `${path}/language`, block.language, { pattern: LANGUAGE_PATTERN, max: 24 });
      if (typeof block.language === 'string' && !CODE_LANGUAGES.includes(block.language)) {
        ctx.error(`${path}/language`, 'enum', `must be one of ${CODE_LANGUAGES.join(', ')}`);
      }
      checkCodeSource(ctx, `${path}/source`, block.source);
      if (Object.hasOwn(block, 'caption')) checkInline(ctx, `${path}/caption`, block.caption);
      if (Object.hasOwn(block, 'highlight') && typeof block.source === 'string') {
        checkLineRanges(ctx, `${path}/highlight`, block.highlight, block.source.split('\n').length);
      }
      return;
    case 'diff':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'language', 'patch'], ['caption']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/language`, block.language, CODE_LANGUAGES);
      checkCodeSource(ctx, `${path}/patch`, block.patch);
      if (Object.hasOwn(block, 'caption')) checkInline(ctx, `${path}/caption`, block.caption);
      return;
    case 'table':
      checkObject(ctx, path, block, ['type', 'id', 'caption', 'columns', 'rows']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/caption`, block.caption, { max: 300 });
      if (checkArray(ctx, `${path}/columns`, block.columns, { min: 1, max: LIMITS.tableColumns })) {
        const keys = new Set();
        block.columns.forEach((col, i) => {
          const p = `${path}/columns/${i}`;
          checkObject(ctx, p, col, ['key', 'label'], ['numeric']);
          if (checkString(ctx, `${p}/key`, col?.key, { pattern: ID_PATTERN, max: 64 })) {
            if (keys.has(col.key)) ctx.error(`${p}/key`, 'duplicate-id', `column key "${col.key}" repeated`);
            keys.add(col.key);
          }
          checkString(ctx, `${p}/label`, col?.label, { max: 80 });
          if (col && Object.hasOwn(col, 'numeric') && typeof col.numeric !== 'boolean') ctx.error(`${p}/numeric`, 'type', 'expected boolean');
        });
        if (checkArray(ctx, `${path}/rows`, block.rows, { min: 1, max: LIMITS.tableRows })) {
          block.rows.forEach((row, r) => {
            const p = `${path}/rows/${r}`;
            if (checkObject(ctx, p, row, [...keys])) {
              for (const key of keys) checkInline(ctx, `${p}/${key}`, row[key]);
            }
          });
        }
      }
      return;
    case 'chart': {
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/kind`, block.kind, ['bar', 'comparison', 'quantiles']);
      checkString(ctx, `${path}/unit`, block.unit, { max: 24 });
      checkInline(ctx, `${path}/caption`, block.caption);
      if (Object.hasOwn(block, 'evidence')) checkEvidenceRefs(ctx, `${path}/evidence`, block.evidence, block.id);
      if (block.kind === 'comparison') {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'baselineLabel', 'candidateLabel', 'unit', 'series', 'caption'], ['higherIsBetter', 'evidence']);
        checkString(ctx, `${path}/baselineLabel`, block.baselineLabel, { max: 80 });
        checkString(ctx, `${path}/candidateLabel`, block.candidateLabel, { max: 80 });
        if (Object.hasOwn(block, 'higherIsBetter') && typeof block.higherIsBetter !== 'boolean') ctx.error(`${path}/higherIsBetter`, 'type', 'expected boolean');
        if (checkArray(ctx, `${path}/series`, block.series, { min: 1, max: LIMITS.chartSeries })) {
          block.series.forEach((point, i) => {
            const p = `${path}/series/${i}`;
            checkObject(ctx, p, point, ['label', 'baseline', 'value']);
            checkString(ctx, `${p}/label`, point?.label, { max: 80 });
            checkFiniteNumber(ctx, `${p}/baseline`, point?.baseline);
            checkFiniteNumber(ctx, `${p}/value`, point?.value);
          });
        }
      } else if (block.kind === 'quantiles') {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'unit', 'series', 'caption'], ['budget', 'evidence']);
        if (Object.hasOwn(block, 'budget')) checkFiniteNumber(ctx, `${path}/budget`, block.budget);
        if (checkArray(ctx, `${path}/series`, block.series, { min: 1, max: LIMITS.chartSeries })) {
          block.series.forEach((point, i) => {
            const p = `${path}/series/${i}`;
            checkObject(ctx, p, point, ['label', 'p50', 'p95', 'p99'], ['max']);
            checkString(ctx, `${p}/label`, point?.label, { max: 80 });
            const ok50 = checkFiniteNumber(ctx, `${p}/p50`, point?.p50);
            const ok95 = checkFiniteNumber(ctx, `${p}/p95`, point?.p95);
            const ok99 = checkFiniteNumber(ctx, `${p}/p99`, point?.p99);
            const okMax = point && Object.hasOwn(point, 'max') ? checkFiniteNumber(ctx, `${p}/max`, point.max) : true;
            if (ok50 && ok95 && ok99 && (point.p50 > point.p95 || point.p95 > point.p99)) {
              ctx.error(p, 'range', 'quantile series must satisfy p50 <= p95 <= p99');
            }
            if (ok99 && okMax && point && Object.hasOwn(point, 'max') && point.p99 > point.max) {
              ctx.error(`${p}/max`, 'range', 'quantile max must be >= p99');
            }
          });
        }
      } else {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'unit', 'series', 'caption'], ['evidence']);
        if (checkArray(ctx, `${path}/series`, block.series, { min: 1, max: LIMITS.chartSeries })) {
          block.series.forEach((point, i) => {
            const p = `${path}/series/${i}`;
            checkObject(ctx, p, point, ['label', 'value']);
            checkString(ctx, `${p}/label`, point?.label, { max: 80 });
            checkFiniteNumber(ctx, `${p}/value`, point?.value);
          });
        }
      }
      return;
    }
    case 'diagram': {
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/kind`, block.kind, ['flow', 'topology', 'sequence']);
      checkInline(ctx, `${path}/caption`, block.caption);
      if (Object.hasOwn(block, 'evidence')) checkEvidenceRefs(ctx, `${path}/evidence`, block.evidence, block.id);
      if (block.kind === 'topology') {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'groups', 'edges', 'caption'], ['evidence']);
        const nodeIds = new Set();
        let totalNodes = 0;
        if (checkArray(ctx, `${path}/groups`, block.groups, { min: 1, max: 8 })) {
          const groupIds = new Set();
          block.groups.forEach((group, gi) => {
            const gp = `${path}/groups/${gi}`;
            if (!checkObject(ctx, gp, group, ['id', 'label', 'nodes'])) return;
            if (checkString(ctx, `${gp}/id`, group.id, { pattern: ID_PATTERN, max: 64 })) {
              const gKey = group.id.toLowerCase();
              if (groupIds.has(gKey)) ctx.error(`${gp}/id`, 'duplicate-id', `group id "${group.id}" repeated`);
              groupIds.add(gKey);
            }
            checkString(ctx, `${gp}/label`, group.label, { max: 80 });
            if (checkArray(ctx, `${gp}/nodes`, group.nodes, { min: 1, max: 12 })) {
              group.nodes.forEach((node, ni) => {
                const np = `${gp}/nodes/${ni}`;
                totalNodes += 1;
                if (!checkObject(ctx, np, node, ['id', 'label'], ['sublabel', 'role'])) return;
                if (checkString(ctx, `${np}/id`, node.id, { pattern: ID_PATTERN, max: 64 })) {
                  if (nodeIds.has(node.id)) ctx.error(`${np}/id`, 'duplicate-id', `node id "${node.id}" repeated`);
                  nodeIds.add(node.id);
                }
                checkString(ctx, `${np}/label`, node.label, { max: 80 });
                if (Object.hasOwn(node, 'sublabel')) checkString(ctx, `${np}/sublabel`, node.sublabel, { max: 120 });
                if (Object.hasOwn(node, 'role')) checkEnum(ctx, `${np}/role`, node.role, DIAGRAM_ROLES);
              });
            }
          });
        }
        if (totalNodes > LIMITS.diagramNodes) ctx.error(`${path}/groups`, 'limit', `exceeds ${LIMITS.diagramNodes} total nodes`);
        if (checkArray(ctx, `${path}/edges`, block.edges, { min: 1, max: 48 })) {
          block.edges.forEach((edge, ei) => {
            const ep = `${path}/edges/${ei}`;
            if (!checkObject(ctx, ep, edge, ['from', 'to'], ['label', 'style'])) return;
            if (checkString(ctx, `${ep}/from`, edge.from, { pattern: ID_PATTERN, max: 64 }) && !nodeIds.has(edge.from)) {
              ctx.error(`${ep}/from`, 'unknown-ref', `unknown topology node "${edge.from}"`);
            }
            if (checkString(ctx, `${ep}/to`, edge.to, { pattern: ID_PATTERN, max: 64 }) && !nodeIds.has(edge.to)) {
              ctx.error(`${ep}/to`, 'unknown-ref', `unknown topology node "${edge.to}"`);
            }
            if (Object.hasOwn(edge, 'label')) checkString(ctx, `${ep}/label`, edge.label, { max: 80 });
            if (Object.hasOwn(edge, 'style')) checkEnum(ctx, `${ep}/style`, edge.style, EDGE_STYLES);
          });
        }
      } else if (block.kind === 'sequence') {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'actors', 'messages', 'caption'], ['evidence']);
        const actorIds = new Set();
        const declaredActors = [];
        if (checkArray(ctx, `${path}/actors`, block.actors, { min: 2, max: 8 })) {
          block.actors.forEach((actor, ai) => {
            const ap = `${path}/actors/${ai}`;
            if (!checkObject(ctx, ap, actor, ['id', 'label'], ['kind'])) return;
            if (checkString(ctx, `${ap}/id`, actor.id, { pattern: ID_PATTERN, max: 64 })) {
              if (actorIds.has(actor.id)) ctx.error(`${ap}/id`, 'duplicate-id', `actor id "${actor.id}" repeated`);
              else declaredActors.push({ id: actor.id, path: `${ap}/id` });
              actorIds.add(actor.id);
            }
            checkString(ctx, `${ap}/label`, actor.label, { max: 80 });
            if (Object.hasOwn(actor, 'kind')) checkEnum(ctx, `${ap}/kind`, actor.kind, ACTOR_KINDS);
          });
        }
        const referencedActorIds = new Set();
        if (checkArray(ctx, `${path}/messages`, block.messages, { min: 1, max: 32 })) {
          block.messages.forEach((msg, mi) => {
            const mp = `${path}/messages/${mi}`;
            if (!checkObject(ctx, mp, msg, ['from', 'to', 'label'], ['kind', 'gate', 'note'])) return;
            if (checkString(ctx, `${mp}/from`, msg.from, { pattern: ID_PATTERN, max: 64 })) {
              if (!actorIds.has(msg.from)) ctx.error(`${mp}/from`, 'unknown-ref', `unknown sequence actor "${msg.from}"`);
              else referencedActorIds.add(msg.from);
            }
            if (checkString(ctx, `${mp}/to`, msg.to, { pattern: ID_PATTERN, max: 64 })) {
              if (!actorIds.has(msg.to)) ctx.error(`${mp}/to`, 'unknown-ref', `unknown sequence actor "${msg.to}"`);
              else referencedActorIds.add(msg.to);
            }
            checkString(ctx, `${mp}/label`, msg.label, { max: 120 });
            if (Object.hasOwn(msg, 'kind')) checkEnum(ctx, `${mp}/kind`, msg.kind, MESSAGE_KINDS);
            if (Object.hasOwn(msg, 'gate') && typeof msg.gate !== 'boolean') ctx.error(`${mp}/gate`, 'type', 'expected boolean');
            if (Object.hasOwn(msg, 'note')) checkString(ctx, `${mp}/note`, msg.note, { max: 160 });
          });
          for (const actor of declaredActors) {
            if (!referencedActorIds.has(actor.id)) {
              ctx.error(actor.path, 'unreferenced-actor', `sequence actor "${actor.id}" is not referenced by any message`);
            }
          }
        }
      } else {
        checkObject(ctx, path, block, ['type', 'id', 'title', 'kind', 'steps', 'caption'], ['evidence']);
        if (checkArray(ctx, `${path}/steps`, block.steps, { min: 2, max: LIMITS.diagramNodes })) {
          block.steps.forEach((step, i) => {
            const p = `${path}/steps/${i}`;
            checkObject(ctx, p, step, ['label', 'detail'], ['gate']);
            checkString(ctx, `${p}/label`, step?.label, { max: 80 });
            checkString(ctx, `${p}/detail`, step?.detail, { max: 240 });
            if (step && Object.hasOwn(step, 'gate') && typeof step.gate !== 'boolean') ctx.error(`${p}/gate`, 'type', 'expected boolean');
          });
        }
      }
      return;
    }
    case 'comparison':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'left', 'right'], ['caption', 'evidence']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      if (Object.hasOwn(block, 'caption')) checkInline(ctx, `${path}/caption`, block.caption);
      checkComparisonSide(ctx, `${path}/left`, block.left);
      checkComparisonSide(ctx, `${path}/right`, block.right);
      if (Object.hasOwn(block, 'evidence')) checkEvidenceRefs(ctx, `${path}/evidence`, block.evidence, block.id);
      return;
    case 'requirement':
      checkObject(ctx, path, block, ['type', 'id', 'title', 'pattern', 'statement', 'verification'], ['scenarios', 'evidence']);
      checkId(ctx, `${path}/id`, block.id);
      checkString(ctx, `${path}/title`, block.title, { max: 200 });
      checkEnum(ctx, `${path}/pattern`, block.pattern, EARS_PATTERNS);
      checkInline(ctx, `${path}/statement`, block.statement);
      checkVerification(ctx, `${path}/verification`, block.verification);
      if (Object.hasOwn(block, 'scenarios') && checkArray(ctx, `${path}/scenarios`, block.scenarios, { min: 1, max: 12 })) {
        block.scenarios.forEach((sc, si) => {
          const sp = `${path}/scenarios/${si}`;
          if (!checkObject(ctx, sp, sc, ['name', 'given', 'when', 'then'])) return;
          checkString(ctx, `${sp}/name`, sc.name, { max: 120 });
          checkString(ctx, `${sp}/given`, sc.given, { max: 240 });
          checkString(ctx, `${sp}/when`, sc.when, { max: 240 });
          checkString(ctx, `${sp}/then`, sc.then, { max: 240 });
        });
      }
      if (Object.hasOwn(block, 'evidence')) checkEvidenceRefs(ctx, `${path}/evidence`, block.evidence, block.id);
      return;
    case 'metrics':
      checkObject(ctx, path, block, ['type', 'items']);
      if (checkArray(ctx, `${path}/items`, block.items, { min: 1, max: 12 })) {
        block.items.forEach((item, i) => {
          const p = `${path}/items/${i}`;
          checkObject(ctx, p, item, ['label', 'value'], ['unit', 'evidence']);
          checkString(ctx, `${p}/label`, item?.label, { max: 80 });
          checkString(ctx, `${p}/value`, item?.value, { max: 40 });
          if (item && Object.hasOwn(item, 'unit')) checkString(ctx, `${p}/unit`, item.unit, { max: 24 });
          if (item && Object.hasOwn(item, 'evidence')) checkEvidenceRefs(ctx, `${p}/evidence`, item.evidence, null);
        });
      }
      return;
    default:
      if (typeof type === 'string' && ESCAPE_HATCHES.has(type)) {
        ctx.error(`${path}/type`, 'escape-hatch', `block type "${type}" is a markup escape hatch and is not part of ${ctx.schema}`);
      } else {
        ctx.error(`${path}/type`, 'unknown-block', `unknown block type ${JSON.stringify(type)}`);
      }
  }
}

// Evidence source paths are untrusted filenames. They must be relative, POSIX,
// NFC, made of safe segments, and must not collide under case folding or
// Unicode normalization with another evidence path.
export function evidencePathProblems(value) {
  const problems = [];
  if (typeof value !== 'string' || value.length === 0) return ['empty path'];
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) problems.push('absolute path');
  if (value.includes('\\')) problems.push('backslash separator');
  if (value.includes('\0')) problems.push('NUL byte');
  if (value.normalize('NFC') !== value) problems.push('not NFC-normalized');
  const segments = value.split('/');
  if (segments.some((s) => s === '..' || s === '.')) problems.push('dot segment (path traversal)');
  if (segments.some((s) => s === '')) problems.push('empty segment');
  if (segments.length > 8) problems.push('too many segments');
  if (segments.some((s) => s !== '..' && s !== '.' && s !== '' && !SEGMENT_PATTERN.test(s))) problems.push('segment has disallowed characters');
  return problems;
}

export function collisionKey(path) {
  return path.normalize('NFKC').toLowerCase().normalize('NFKC');
}

export function checkEvidence(ctx, path, value) {
  if (!checkArray(ctx, path, value, { min: 1, max: LIMITS.evidenceFiles })) return;
  const collisions = new Map();
  value.forEach((item, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(item)) {
      ctx.error(p, 'type', 'expected evidence object');
      return;
    }
    const kind = item.kind;
    if (kind === 'file') {
      checkObject(ctx, p, item, ['id', 'title', 'kind', 'path', 'mediaType']);
    } else if (kind === 'redacted' || kind === 'unavailable') {
      checkObject(ctx, p, item, ['id', 'title', 'kind', 'reason']);
      checkString(ctx, `${p}/reason`, item.reason, { max: 500 });
    } else {
      checkObject(ctx, p, item, ['id', 'title', 'kind']);
      ctx.error(`${p}/kind`, 'enum', 'must be one of file, redacted, unavailable');
    }
    if (checkString(ctx, `${p}/id`, item.id, { pattern: ID_PATTERN, max: 64 })) {
      ctx.claimId(`${p}/id`, item.id);
      ctx.evidenceIds.add(item.id);
    }
    checkString(ctx, `${p}/title`, item.title, { max: 200 });
    if (kind === 'file') {
      if (typeof item.path !== 'string') {
        ctx.error(`${p}/path`, 'type', 'expected string');
      } else {
        for (const problem of evidencePathProblems(item.path)) ctx.error(`${p}/path`, 'unsafe-path', problem);
        const key = collisionKey(item.path);
        if (collisions.has(key)) {
          ctx.error(`${p}/path`, 'path-collision', `collides with ${collisions.get(key)} under case/Unicode folding`);
        } else {
          collisions.set(key, `${p}/path`);
        }
      }
      if (typeof item.mediaType !== 'string' || !['text/plain', 'text/csv', 'application/json'].includes(item.mediaType)) {
        ctx.error(`${p}/mediaType`, 'unsupported-media', 'evidence media type must be text/plain, text/csv, or application/json');
      }
    }
  });
}

function checkSections(ctx, path, value, { min }) {
  if (!checkArray(ctx, path, value, { min, max: LIMITS.sections })) return;
  value.forEach((section, i) => {
    const p = `${path}/${i}`;
    if (!checkObject(ctx, p, section, ['id', 'title', 'blocks'], ['lede'])) return;
    checkId(ctx, `${p}/id`, section.id);
    checkString(ctx, `${p}/title`, section.title, { max: 120 });
    if (Object.hasOwn(section, 'lede')) checkString(ctx, `${p}/lede`, section.lede, { max: 600 });
    if (checkArray(ctx, `${p}/blocks`, section.blocks, { min: 1, max: 200 })) {
      section.blocks.forEach((block, j) => checkBlock(ctx, `${p}/blocks/${j}`, block));
    }
  });
}

// Exhaustive HTML id attributes emitted by renderBlock for a block (excluding recursive
// finding.detail blocks unless recurse=true), shared by report/v1 and site-input/v1 so
// distinct block/evidence IDs cannot collide on generated sub-element DOM IDs.
export function blockHtmlIds(block, { recurse = true } = {}) {
  if (!isPlainObject(block) || typeof block.id !== 'string') return [];
  switch (block.type) {
    case 'finding':
      return [
        `f-${block.id}`, `f-${block.id}-t`, `f-${block.id}-ev`,
        ...(recurse ? (block.detail ?? []).flatMap((b) => blockHtmlIds(b)) : []),
      ];
    case 'decision':
      return [`d-${block.id}`, `d-${block.id}-t`, `d-${block.id}-alts`, `d-${block.id}-cons`];
    case 'risk':
      return [`r-${block.id}`, `r-${block.id}-t`];
    case 'chart':
      return [`chart-${block.id}`, `chart-${block.id}-t`, `chart-${block.id}-cap`, `cap-chart-${block.id}`, `chart-${block.id}-ev`];
    case 'diagram':
      return [`diagram-${block.id}`, `diagram-${block.id}-t`, `diagram-${block.id}-ev`];
    case 'comparison':
      return [`cmp-${block.id}`, `cmp-${block.id}-t`, `cmp-${block.id}-ev`, `cmp-${block.id}-left-code`, `cmp-${block.id}-right-code`];
    case 'requirement':
      return [`req-${block.id}`, `req-${block.id}-t`, `req-${block.id}-sc`, `req-${block.id}-ev`];
    case 'table':
      return [`tbl-${block.id}`, `tbl-${block.id}-cap`];
    case 'code': {
      const lines = typeof block.source === 'string' ? block.source.split('\n').length : 0;
      return [`code-${block.id}`, `code-${block.id}-title`, ...Array.from({ length: lines }, (_, i) => `code-${block.id}-L${i + 1}`)];
    }
    case 'diff': {
      const lines = typeof block.patch === 'string' ? block.patch.split('\n').length : 0;
      return [`code-${block.id}`, `code-${block.id}-title`, ...Array.from({ length: lines }, (_, i) => `code-${block.id}-L${i + 1}`)];
    }
    default:
      return [];
  }
}

function checkReportHtmlIdCollisions(ctx, report) {
  const seen = new Map([
    ['content', 'document'],
    ['summary', 'document'],
    ['summary-h', 'document'],
    ['evidence', 'document'],
    ['evidence-h', 'document'],
    ['provenance', 'document'],
    ['provenance-h', 'document'],
    ['prov-cap', 'document'],
    ['verify-h', 'document'],
  ]);
  const claimAll = (idPath, rawId, htmlIds) => {
    const keys = htmlIds.map((id) => id.toLowerCase());
    const hit = keys.find((k) => seen.has(k));
    if (hit && !ctx.errors.some((e) => e.path === idPath && e.code === 'duplicate-id')) {
      ctx.error(idPath, 'duplicate-id', `id "${rawId}" collides on generated HTML id "${hit}" with ${seen.get(hit)}`);
    }
    for (const k of keys) if (!seen.has(k)) seen.set(k, idPath);
  };
  if (Array.isArray(report.evidence)) {
    report.evidence.forEach((item, i) => {
      if (isPlainObject(item) && typeof item.id === 'string') {
        claimAll(`/evidence/${i}/id`, item.id, [`ev-${item.id}`, `ev-${item.id}-pv`, `pv-${item.id}`]);
      }
    });
  }
  const visitBlocks = (blocks, basePath) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, j) => {
      if (!isPlainObject(block)) return;
      const bp = `${basePath}/${j}`;
      const ids = blockHtmlIds(block, { recurse: false });
      if (ids.length) claimAll(`${bp}/id`, block.id, ids);
      if (Array.isArray(block.detail)) visitBlocks(block.detail, `${bp}/detail`);
    });
  };
  const visitSections = (sections, basePath, prefix) => {
    if (!Array.isArray(sections)) return;
    sections.forEach((section, i) => {
      if (!isPlainObject(section)) return;
      const sp = `${basePath}/${i}`;
      if (typeof section.id === 'string') {
        claimAll(`${sp}/id`, section.id, [`${prefix}-${section.id}`, `${prefix}-${section.id}-h`]);
      }
      visitBlocks(section.blocks, `${sp}/blocks`);
    });
  };
  visitSections(report.sections, '/sections', 'sec');
  if (Object.hasOwn(report, 'appendices')) visitSections(report.appendices, '/appendices', 'app');
}

export function validateReport(report) {
  const ctx = new Context();
  if (!checkObject(ctx, '', report, ['schema', 'id', 'title', 'metadata', 'summary', 'evidence', 'sections', 'provenance'], ['subtitle', 'appendices', 'publication'])) {
    if (!isPlainObject(report)) throw new ReportValidationError(ctx.errors);
  }
  if (report.schema !== REPORT_SCHEMA) ctx.error('/schema', 'schema-version', `expected "${REPORT_SCHEMA}"`);
  checkString(ctx, '/id', report.id, { pattern: /^[a-z0-9][a-z0-9-]{0,63}$/, max: 64 });
  checkString(ctx, '/title', report.title, { max: 160 });
  if (Object.hasOwn(report, 'subtitle')) checkString(ctx, '/subtitle', report.subtitle, { max: 300 });

  // Optional V2 publication extension (docs/v2/publication-protocol.md §6). Absent,
  // a report is exactly a V1 report and its packet bytes are unchanged.
  if (Object.hasOwn(report, 'publication') && checkObject(ctx, '/publication', report.publication, [], ['classification', 'dataOrigin'])) {
    if (Object.hasOwn(report.publication, 'classification')) checkEnum(ctx, '/publication/classification', report.publication.classification, PUBLICATION_CLASSES);
    if (Object.hasOwn(report.publication, 'dataOrigin')) checkEnum(ctx, '/publication/dataOrigin', report.publication.dataOrigin, DATA_ORIGINS);
  }
  const meta = report.metadata;
  if (checkObject(ctx, '/metadata', meta, ['status', 'classification', 'reviewDate', 'authors', 'reviewRequest'])) {
    checkEnum(ctx, '/metadata/status', meta.status, STATUSES);
    checkString(ctx, '/metadata/classification', meta.classification, { max: 80 });
    checkString(ctx, '/metadata/reviewDate', meta.reviewDate, { pattern: DATE_PATTERN, max: 10 });
    checkString(ctx, '/metadata/reviewRequest', meta.reviewRequest, { max: 300 });
    if (checkArray(ctx, '/metadata/authors', meta.authors, { min: 1, max: 12 })) {
      meta.authors.forEach((a, i) => checkString(ctx, `/metadata/authors/${i}`, a, { max: 120 }));
    }
  }

  const summary = report.summary;
  if (checkObject(ctx, '/summary', summary, ['verdict', 'paragraphs'], ['metrics'])) {
    if (checkObject(ctx, '/summary/verdict', summary.verdict, ['confidence', 'text'])) {
      checkEnum(ctx, '/summary/verdict/confidence', summary.verdict.confidence, CONFIDENCE);
      checkInline(ctx, '/summary/verdict/text', summary.verdict.text);
    }
    if (checkArray(ctx, '/summary/paragraphs', summary.paragraphs, { min: 1, max: 12 })) {
      summary.paragraphs.forEach((para, i) => checkInline(ctx, `/summary/paragraphs/${i}`, para));
    }
    if (Object.hasOwn(summary, 'metrics')) checkBlock(ctx, '/summary/metrics', { type: 'metrics', ...summary.metrics });
  }

  checkEvidence(ctx, '/evidence', report.evidence);
  checkSections(ctx, '/sections', report.sections, { min: 1 });
  if (Object.hasOwn(report, 'appendices')) checkSections(ctx, '/appendices', report.appendices, { min: 1 });
  checkReportHtmlIdCollisions(ctx, report);

  const prov = report.provenance;
  if (checkObject(ctx, '/provenance', prov, ['sources'], ['notes'])) {
    if (checkArray(ctx, '/provenance/sources', prov.sources, { min: 1, max: 32 })) {
      prov.sources.forEach((src, i) => {
        const p = `/provenance/sources/${i}`;
        checkObject(ctx, p, src, ['label', 'reference'], ['sha256', 'revision']);
        checkString(ctx, `${p}/label`, src?.label, { max: 160 });
        checkString(ctx, `${p}/reference`, src?.reference, { max: 400 });
        if (src && Object.hasOwn(src, 'sha256')) checkString(ctx, `${p}/sha256`, src.sha256, { pattern: /^[0-9a-f]{64}$/, max: 64 });
        if (src && Object.hasOwn(src, 'revision')) checkString(ctx, `${p}/revision`, src.revision, { pattern: /^[0-9a-f]{7,64}$/, max: 64 });
      });
    }
    if (Object.hasOwn(prov, 'notes')) checkInline(ctx, '/provenance/notes', prov.notes);
  }

  if (ctx.blocks > LIMITS.blocksTotal) ctx.error('/sections', 'limit', `more than ${LIMITS.blocksTotal} blocks`);
  if (ctx.codeBytes > LIMITS.codeBytesTotal) ctx.error('/sections', 'limit', `more than ${LIMITS.codeBytesTotal} bytes of code`);
  for (const citation of ctx.citations) {
    if (!ctx.evidenceIds.has(citation.id)) ctx.error(citation.path, 'unknown-evidence', `cites unknown evidence "${citation.id}"`);
  }

  if (ctx.errors.length > 0) throw new ReportValidationError(ctx.errors);
  return report;
}

// Bounded JSON parsing: size and nesting depth are checked on the raw text
// before JSON.parse runs, so hostile input cannot exhaust the parser's stack.
// Schema-neutral so other schemas (doc/v1) can reuse the same guard with their
// own error class, instead of re-deriving this loop.
export function parseBoundedJsonText(text, { maxBytes, maxDepth, label, makeError }) {
  const errors = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    errors.push({ path: '', code: 'limit', message: `${label} is ${bytes} bytes; limit is ${maxBytes}` });
    throw makeError(errors);
  }
  let depth = 0;
  let maxSeenDepth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > maxSeenDepth) maxSeenDepth = depth;
      if (depth > maxDepth) {
        errors.push({ path: '', code: 'limit', message: `JSON nesting exceeds depth ${maxDepth}` });
        throw makeError(errors);
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    errors.push({ path: '', code: 'json', message: err.message });
    throw makeError(errors);
  }
}

export function parseReportText(text, { maxBytes = LIMITS.reportBytes, label = 'report' } = {}) {
  return parseBoundedJsonText(text, { maxBytes, maxDepth: LIMITS.jsonDepth, label, makeError: (errors) => new ReportValidationError(errors) });
}
