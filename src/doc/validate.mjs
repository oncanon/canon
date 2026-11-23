// doc/v1 validation: Canon's docs content format. It reuses report/v1's paragraph,
// list, code and table blocks and its Inline grammar (src/report/validate.mjs) so the
// same escaping and resource-limit rules govern both schemas. It differs from report/v1
// in three ways: no verdict and no evidence (a doc page cites nothing), an inline `ref`
// span that names another doc page instead of a citation, and code blocks with no id or
// title (a plain fenced snippet, not an evidence figure).
//
// A single call here validates one page. Resolving a `ref` against the rest of a doc
// set, and failing the build on a broken page or anchor, is src/doc/docset.mjs's job —
// this module has no notion of "the other pages."
import {
  CODE_LANGUAGES, Context, checkArray, checkCodeSource, checkObject, checkString, checkEnum,
  hasVisibleText, isPlainObject, parseBoundedJsonText,
} from '../report/validate.mjs';
import { LIMITS } from '../policy.mjs';

export const DOC_SCHEMA = 'doc/v1';

export const DOC_LIMITS = Object.freeze({
  docBytes: 256 * 1024,
  jsonDepth: 16,
  sections: LIMITS.sections,
  blocksPerSection: 64,
  listItems: LIMITS.listItems,
  codeBytesPerBlock: LIMITS.codeBytesPerBlock,
  tableRows: LIMITS.tableRows,
  tableColumns: LIMITS.tableColumns,
  seeAlso: 12,
  provenanceSources: 32,
});

// Lowercase kebab-case: every doc/v1 id becomes a literal HTML `id` attribute (a page
// id doubles as a ref target; a section id doubles as its heading id), matching the
// convention already live on oncanon.com so Pagefind's existing section anchors do not
// move under it.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class DocValidationError extends Error {
  constructor(errors) {
    super(`doc/v1 validation failed:\n${errors.map((e) => `  ${e.code} ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'DocValidationError';
    this.errors = errors;
  }
}

// Context plus the one thing report/v1's Context has no notion of: refs to other doc
// pages, collected here and left for src/doc/docset.mjs to resolve or reject.
export class DocContext extends Context {
  constructor() {
    super(DOC_SCHEMA);
    this.pageRefs = [];
  }
}

function checkSlug(ctx, path, value, { max = 64 } = {}) {
  return checkString(ctx, path, value, { pattern: SLUG_PATTERN, max });
}

// {page, anchor?, text}: the one ref shape shared by an inline `ref` span, `nav.next`
// and a `seeAlso` entry. Every ref is recorded on ctx.pageRefs for cross-page resolution;
// this function only checks that the ref is shaped correctly and names something
// resolution could plausibly find.
function checkRefObject(ctx, path, value) {
  if (!checkObject(ctx, path, value, ['page', 'text'], ['anchor'])) return false;
  const pageOk = checkSlug(ctx, `${path}/page`, value.page);
  if (Object.hasOwn(value, 'anchor')) checkSlug(ctx, `${path}/anchor`, value.anchor);
  const textOk = checkString(ctx, `${path}/text`, value.text, { max: 500 });
  if (pageOk) {
    ctx.pageRefs.push({
      path,
      page: value.page,
      anchor: Object.hasOwn(value, 'anchor') && typeof value.anchor === 'string' ? value.anchor : null,
    });
  }
  return textOk && typeof value.text === 'string' && hasVisibleText(value.text);
}

// Inline text for doc/v1: the same string-or-segments shape report/v1 uses, with `ref`
// in place of `cite` (a doc page cites another page, never an evidence item).
export function checkDocInline(ctx, path, value) {
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
    const kinds = ['text', 'code', 'em', 'strong', 'link', 'ref'];
    const kind = keys.find((k) => kinds.includes(k));
    if (!kind) {
      checkObject(ctx, p, segment, ['text']);
      return;
    }
    if (kind === 'link') {
      checkObject(ctx, p, segment, ['link']);
      if (checkObject(ctx, `${p}/link`, segment.link, ['href', 'text'])) {
        checkString(ctx, `${p}/link/href`, segment.link.href, { max: LIMITS.urlChars });
        checkString(ctx, `${p}/link/text`, segment.link.text, { max: 500 });
        if (typeof segment.link?.text === 'string' && hasVisibleText(segment.link.text)) hasVisibleSegment = true;
      }
      return;
    }
    checkObject(ctx, p, segment, [kind]);
    if (kind === 'ref') {
      if (checkRefObject(ctx, `${p}/ref`, segment.ref)) hasVisibleSegment = true;
    } else {
      checkString(ctx, `${p}/${kind}`, segment[kind], { allowWhitespaceOnly: kind === 'text' && value.length > 1 });
      if (typeof segment[kind] === 'string' && hasVisibleText(segment[kind])) hasVisibleSegment = true;
    }
  });
  if (value.length > 0 && !hasVisibleSegment) {
    ctx.error(path, 'length', 'inline text must contain at least one non-whitespace character');
  }
}

function checkDocTable(ctx, path, block) {
  checkObject(ctx, path, block, ['type', 'id', 'caption', 'columns', 'rows']);
  checkSlug(ctx, `${path}/id`, block.id);
  if (typeof block.id === 'string' && SLUG_PATTERN.test(block.id)) ctx.claimId(`${path}/id`, block.id);
  checkString(ctx, `${path}/caption`, block.caption, { max: 300 });
  if (!checkArray(ctx, `${path}/columns`, block.columns, { min: 1, max: DOC_LIMITS.tableColumns })) return;
  const keys = new Set();
  block.columns.forEach((col, i) => {
    const p = `${path}/columns/${i}`;
    checkObject(ctx, p, col, ['key', 'label'], ['numeric']);
    if (checkSlug(ctx, `${p}/key`, col?.key)) {
      if (keys.has(col.key)) ctx.error(`${p}/key`, 'duplicate-id', `column key "${col.key}" repeated`);
      keys.add(col.key);
    }
    checkString(ctx, `${p}/label`, col?.label, { max: 80 });
    if (col && Object.hasOwn(col, 'numeric') && typeof col.numeric !== 'boolean') ctx.error(`${p}/numeric`, 'type', 'expected boolean');
  });
  if (!checkArray(ctx, `${path}/rows`, block.rows, { min: 1, max: DOC_LIMITS.tableRows })) return;
  block.rows.forEach((row, r) => {
    const p = `${path}/rows/${r}`;
    if (checkObject(ctx, p, row, [...keys])) {
      for (const key of keys) checkDocInline(ctx, `${p}/${key}`, row[key]);
    }
  });
}

// paragraph, list, code and table only: doc/v1 has no finding, decision, risk, chart,
// diagram, comparison, requirement or metrics block. A code block carries no id or
// title — it is a plain snippet, not an evidence figure, so it gets no anchor.
function checkDocBlock(ctx, path, block) {
  if (!isPlainObject(block)) {
    ctx.error(path, 'type', 'expected block object');
    return;
  }
  switch (block.type) {
    case 'paragraph':
      checkObject(ctx, path, block, ['type', 'text']);
      checkDocInline(ctx, `${path}/text`, block.text);
      return;
    case 'list':
      checkObject(ctx, path, block, ['type', 'items'], ['ordered']);
      if (Object.hasOwn(block, 'ordered') && typeof block.ordered !== 'boolean') ctx.error(`${path}/ordered`, 'type', 'expected boolean');
      if (checkArray(ctx, `${path}/items`, block.items, { min: 1, max: DOC_LIMITS.listItems })) {
        block.items.forEach((item, i) => checkDocInline(ctx, `${path}/items/${i}`, item));
      }
      return;
    case 'code':
      checkObject(ctx, path, block, ['type', 'language', 'source'], ['caption']);
      checkEnum(ctx, `${path}/language`, block.language, CODE_LANGUAGES);
      checkCodeSource(ctx, `${path}/source`, block.source);
      if (Object.hasOwn(block, 'caption')) checkDocInline(ctx, `${path}/caption`, block.caption);
      return;
    case 'table':
      checkDocTable(ctx, path, block);
      return;
    default:
      ctx.error(`${path}/type`, 'enum', 'must be one of paragraph, list, code, table');
  }
}

function checkSection(ctx, path, section) {
  if (!checkObject(ctx, path, section, ['id', 'title', 'blocks'])) return;
  if (checkSlug(ctx, `${path}/id`, section.id)) ctx.claimId(`${path}/id`, section.id);
  checkString(ctx, `${path}/title`, section.title, { max: 200 });
  if (checkArray(ctx, `${path}/blocks`, section.blocks, { min: 1, max: DOC_LIMITS.blocksPerSection })) {
    section.blocks.forEach((block, i) => checkDocBlock(ctx, `${path}/blocks/${i}`, block));
  }
}

function checkProvenance(ctx, path, prov) {
  if (!checkObject(ctx, path, prov, ['sources'], ['notes'])) return;
  if (checkArray(ctx, `${path}/sources`, prov.sources, { min: 1, max: DOC_LIMITS.provenanceSources })) {
    prov.sources.forEach((src, i) => {
      const p = `${path}/sources/${i}`;
      checkObject(ctx, p, src, ['label', 'reference'], ['sha256', 'revision']);
      checkString(ctx, `${p}/label`, src?.label, { max: 160 });
      checkString(ctx, `${p}/reference`, src?.reference, { max: 400 });
      if (src && Object.hasOwn(src, 'sha256')) checkString(ctx, `${p}/sha256`, src.sha256, { pattern: /^[0-9a-f]{64}$/, max: 64 });
      if (src && Object.hasOwn(src, 'revision')) checkString(ctx, `${p}/revision`, src.revision, { pattern: /^[0-9a-f]{7,64}$/, max: 64 });
    });
  }
  if (Object.hasOwn(prov, 'notes')) checkDocInline(ctx, `${path}/notes`, prov.notes);
}

// Validates one doc/v1 page. Throws DocValidationError; on success returns the page
// unchanged (never a copy, never defaulted) along with the DocContext, whose
// `pageRefs` a doc set build resolves against its other pages.
export function validateDocPage(doc) {
  const ctx = new DocContext();
  if (!checkObject(ctx, '', doc, ['schema', 'id', 'title', 'description', 'sections'], ['eyebrow', 'nav', 'seeAlso', 'provenance'])) {
    if (!isPlainObject(doc)) throw new DocValidationError(ctx.errors);
  }
  if (doc.schema !== DOC_SCHEMA) ctx.error('/schema', 'schema-version', `expected "${DOC_SCHEMA}"`);
  checkSlug(ctx, '/id', doc.id);
  checkString(ctx, '/title', doc.title, { max: 160 });
  if (Object.hasOwn(doc, 'eyebrow')) checkString(ctx, '/eyebrow', doc.eyebrow, { max: 80 });
  checkString(ctx, '/description', doc.description, { max: 500 });

  if (checkArray(ctx, '/sections', doc.sections, { min: 1, max: DOC_LIMITS.sections })) {
    doc.sections.forEach((section, i) => checkSection(ctx, `/sections/${i}`, section));
  }

  if (Object.hasOwn(doc, 'nav') && checkObject(ctx, '/nav', doc.nav, [], ['next'])) {
    if (Object.hasOwn(doc.nav, 'next') && checkObject(ctx, '/nav/next', doc.nav.next, ['ref'])) {
      checkRefObject(ctx, '/nav/next/ref', doc.nav.next.ref);
    }
  }
  if (Object.hasOwn(doc, 'seeAlso') && checkArray(ctx, '/seeAlso', doc.seeAlso, { min: 1, max: DOC_LIMITS.seeAlso })) {
    doc.seeAlso.forEach((entry, i) => {
      const p = `/seeAlso/${i}`;
      if (checkObject(ctx, p, entry, ['ref'])) checkRefObject(ctx, `${p}/ref`, entry.ref);
    });
  }
  if (Object.hasOwn(doc, 'provenance')) checkProvenance(ctx, '/provenance', doc.provenance);

  if (ctx.errors.length > 0) throw new DocValidationError(ctx.errors);
  return { doc, ctx };
}

export function parseDocText(text, { maxBytes = DOC_LIMITS.docBytes, label = 'doc' } = {}) {
  return parseBoundedJsonText(text, {
    maxBytes,
    maxDepth: DOC_LIMITS.jsonDepth,
    label,
    makeError: (errors) => new DocValidationError(errors),
  });
}
