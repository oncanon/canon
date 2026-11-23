// doc/v1 validation. Every case starts from a committed fixture (the converted spike
// pages) and changes one thing, so a failure names the one rule that stopped holding.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  DOC_SCHEMA, DocValidationError, parseDocText, validateDocPage,
} from '../../src/doc/validate.mjs';
import { REPO } from '../helpers.mjs';

const INSTALL_FIXTURE = join(REPO, 'fixtures/doc/guide-install.doc.json');
const QUICK_START_FIXTURE = join(REPO, 'fixtures/doc/guide-quick-start.doc.json');

let installText;
let quickStartText;
const install = () => JSON.parse(installText);
const quickStart = () => JSON.parse(quickStartText);

test.before(async () => {
  installText = await readFile(INSTALL_FIXTURE, 'utf8');
  quickStartText = await readFile(QUICK_START_FIXTURE, 'utf8');
});

function errorsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DocValidationError, `expected DocValidationError, got ${err}`);
    return err.errors;
  }
  return assert.fail('expected validation to fail');
}

function codes(doc, mutate) {
  mutate(doc);
  return errorsOf(() => validateDocPage(doc)).map((e) => `${e.code} ${e.path}`);
}

test('[DOC-V1] the two converted fixtures validate as-is and carry their refs on ctx.pageRefs', () => {
  const { ctx: installCtx } = validateDocPage(install());
  assert.deepEqual(installCtx.pageRefs, [{ path: '/nav/next/ref', page: 'guide-quick-start', anchor: null }]);

  const { ctx: qsCtx } = validateDocPage(quickStart());
  const pages = qsCtx.pageRefs.map((r) => r.page).sort();
  assert.deepEqual(pages, ['cli', 'cli', 'schemas', 'schemas']);
});

test('[DOC-V1] the schema member must be exactly "doc/v1"', () => {
  assert.equal(codes(install(), (d) => { d.schema = 'doc/v2'; }).join(','), 'schema-version /schema');
});

test('[DOC-V1] page id, section id, and ref targets share one lowercase-kebab slug pattern', () => {
  assert.deepEqual(codes(install(), (d) => { d.id = 'Guide-Install'; }), ['pattern /id']);
  assert.deepEqual(codes(install(), (d) => { d.sections[0].id = 'Requirements'; }), ['pattern /sections/0/id']);
  assert.deepEqual(codes(install(), (d) => { d.nav.next.ref.page = 'Guide Quick Start'; }), ['pattern /nav/next/ref/page']);
});

test('[DOC-V1] a doc page has no verdict and no evidence: the top-level schema is closed to those members', () => {
  assert.deepEqual(
    codes(install(), (d) => { d.evidence = []; }),
    ['unknown-member /evidence'],
  );
  assert.deepEqual(
    codes(install(), (d) => { d.summary = { verdict: { confidence: 'proven', text: 'x' }, paragraphs: ['x'] }; }),
    ['unknown-member /summary'],
  );
});

test('[DOC-V1] an inline segment may be a ref, but never a cite: doc pages cite other pages, not evidence', () => {
  const doc = install();
  assert.equal(doc.sections[0].blocks[1].type, 'paragraph', 'sections[0].blocks[1] is a paragraph block');
  doc.sections[0].blocks[1].text = [{ cite: 'ev-1' }];
  assert.deepEqual(
    codes(doc, () => {}),
    [
      'unknown-member /sections/0/blocks/1/text/0/cite',
      'required /sections/0/blocks/1/text/0/text',
      'length /sections/0/blocks/1/text',
    ],
  );
});

test('[DOC-V1] a ref needs page and text; anchor is optional but must be a slug', () => {
  const doc = quickStart();
  const [sectionIdx, blockIdx, segIdx] = [0, 0, 3];
  assert.equal(doc.sections[sectionIdx].blocks[blockIdx].text[segIdx].ref.page, 'schemas');
  assert.deepEqual(
    codes(doc, (d) => { delete d.sections[sectionIdx].blocks[blockIdx].text[segIdx].ref.text; }),
    ['required /sections/0/blocks/0/text/3/ref/text'],
  );
  const doc2 = quickStart();
  doc2.sections[sectionIdx].blocks[blockIdx].text[segIdx].ref.anchor = 'Not A Slug';
  assert.deepEqual(codes(doc2, () => {}), ['pattern /sections/0/blocks/0/text/3/ref/anchor']);
});

test('[DOC-V1] a code block carries language and source but no id or title; an unknown field is rejected', () => {
  const doc = install();
  assert.equal(doc.sections[1].blocks[0].type, 'code', 'sections[1].blocks[0] is the "Get the CLI" code block');
  assert.deepEqual(codes(doc, (d) => { d.sections[1].blocks[0].id = 'c1'; }), ['unknown-member /sections/1/blocks/0/id']);
});

test('[DOC-V1] a code block language must be one of the closed CODE_LANGUAGES set', () => {
  const doc = install();
  assert.deepEqual(
    codes(doc, (d) => { d.sections[1].blocks[0].language = 'cobol'; }),
    ['enum /sections/1/blocks/0/language'],
  );
});

test('[DOC-V1] nav.next and a seeAlso entry both validate through the same ref shape', () => {
  const doc = quickStart();
  doc.seeAlso.push({ ref: { page: 'cli' } });
  assert.deepEqual(codes(doc, () => {}), ['required /seeAlso/2/ref/text']);
});

test('[DOC-V1] section ids are unique ignoring case, same as report/v1 block ids', () => {
  const doc = install();
  assert.deepEqual(
    codes(doc, (d) => { d.sections[1].id = d.sections[0].id.toUpperCase(); }),
    ['pattern /sections/1/id', 'duplicate-id /sections/1/id'],
  );
});

test('[DOC-V1] doc text is bounded before it is parsed, by its own size limit', () => {
  const huge = JSON.stringify({ schema: DOC_SCHEMA, pad: 'x'.repeat(300 * 1024) });
  assert.throws(
    () => parseDocText(huge),
    (err) => err instanceof DocValidationError && err.errors[0].message.startsWith('doc is '),
  );
});

test('[DOC-V1] doc JSON nesting is bounded before it is parsed', () => {
  let nested = '0';
  for (let i = 0; i < 20; i += 1) nested = `[${nested}]`;
  assert.throws(
    () => parseDocText(nested),
    (err) => err instanceof DocValidationError && err.errors[0].message.includes('nesting exceeds depth'),
  );
});
