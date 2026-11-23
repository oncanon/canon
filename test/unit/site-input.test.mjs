// site-input/v1 validation (docs/projects/interactive-sitrep-contract.md, section 2; slice S1).
// Every case starts from the committed synthetic fixture and changes one thing, so a
// failure names the one rule that stopped holding.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ReportValidationError, parseReportText, validateReport } from '../../src/report/validate.mjs';
import {
  SITE_INPUT_SCHEMA, SITE_LIMITS, SiteInputValidationError, parseSiteInputText, validateSiteInput,
} from '../../src/site/validate.mjs';
import { FIXTURE, REPO } from '../helpers.mjs';

const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');

let fixtureText;
let reportText;
const fixture = () => JSON.parse(fixtureText);

test.before(async () => {
  fixtureText = await readFile(SITE_FIXTURE, 'utf8');
  reportText = await readFile(FIXTURE, 'utf8');
});

function errorsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SiteInputValidationError, `expected SiteInputValidationError, got ${err}`);
    return err.errors;
  }
  return assert.fail('expected validation to fail');
}

// Runs one change against a fresh fixture and returns "code path" for every error.
function codes(mutate) {
  const input = fixture();
  mutate(input);
  return errorsOf(() => validateSiteInput(input)).map((e) => `${e.code} ${e.path}`);
}

function accepts(mutate) {
  const input = fixture();
  mutate(input);
  assert.doesNotThrow(() => validateSiteInput(input));
}

// Each row: what is changed, the change, and the one error it must produce.
function refuses(rows) {
  for (const [what, mutate, expected] of rows) {
    const found = codes(mutate);
    assert.ok(found.includes(expected), `${what}: expected "${expected}" in [${found.join(' | ')}]`);
  }
}

const Q = '/decisions/0/questions/0';
const question = (r) => r.decisions[0].questions[0];
const clone = (value) => JSON.parse(JSON.stringify(value));

test('[SITE-S1] the first-slice fixture is site-input/v1 and validates', () => {
  const input = fixture();
  assert.equal(input.schema, SITE_INPUT_SCHEMA);
  assert.equal(validateSiteInput(input), input);
});

test('[SITE-S1] validation changes nothing and keeps the order the input arrives in', () => {
  const input = fixture();
  input.areas.reverse();
  input.items.reverse();
  input.gaps.reverse();
  question(input).options.reverse();
  const before = clone(input);
  validateSiteInput(input);
  assert.deepEqual(input, before);
  assert.deepEqual(input.areas.map((a) => a.areaRef), ['research', 'platform']);
});

test('[SITE-S1] the shape is closed at every level, and a markup escape hatch is named as one', () => {
  refuses([
    ['root', (r) => { r.extra = 1; }, 'unknown-member /extra'],
    ['edition', (r) => { r.edition.extra = 1; }, 'unknown-member /edition/extra'],
    ['coverage window', (r) => { r.edition.coverage.extra = 1; }, 'unknown-member /edition/coverage/extra'],
    ['registry', (r) => { r.registry.extra = 1; }, 'unknown-member /registry/extra'],
    ['area', (r) => { r.areas[0].extra = 1; }, 'unknown-member /areas/0/extra'],
    ['counts', (r) => { r.areas[0].counts.extra = 1; }, 'unknown-member /areas/0/counts/extra'],
    ['project', (r) => { r.areas[0].projects[0].extra = 1; }, 'unknown-member /areas/0/projects/0/extra'],
    ['item', (r) => { r.items[0].extra = 1; }, 'unknown-member /items/0/extra'],
    ['decision', (r) => { r.decisions[0].extra = 1; }, 'unknown-member /decisions/0/extra'],
    ['question', (r) => { question(r).extra = 1; }, `unknown-member ${Q}/extra`],
    ['option', (r) => { question(r).options[0].extra = 1; }, `unknown-member ${Q}/options/0/extra`],
    ['recommendation', (r) => { question(r).recommendation.extra = 1; }, `unknown-member ${Q}/recommendation/extra`],
    ['free text', (r) => { question(r).freeText.extra = 1; }, `unknown-member ${Q}/freeText/extra`],
    ['gap', (r) => { r.gaps[0].extra = 1; }, 'unknown-member /gaps/0/extra'],
    ['item markup', (r) => { r.items[0].html = '<b>x</b>'; }, 'escape-hatch /items/0/html'],
    ['option styling', (r) => { question(r).options[0].className = 'wide'; }, `escape-hatch ${Q}/options/0/className`],
    ['schema version', (r) => { r.schema = 'site-input/v2'; }, 'schema-version /schema'],
    ['missing member', (r) => { delete r.gaps; }, 'required /gaps'],
  ]);
  for (const notAnObject of [null, [], 'site']) {
    assert.deepEqual(errorsOf(() => validateSiteInput(notAnObject)).map((e) => e.code), ['type']);
  }
});

test('[SITE-S1] an error names the schema it belongs to, for the site input and for a report alike', () => {
  const site = fixture();
  site.items[0].html = '<b>x</b>';
  const siteMessage = errorsOf(() => validateSiteInput(site)).find((e) => e.code === 'escape-hatch').message;
  assert.ok(siteMessage.includes('site-input/v1') && !siteMessage.includes('report/v1'), siteMessage);

  const report = JSON.parse(reportText);
  report.html = '<b>x</b>';
  assert.throws(() => validateReport(report), (err) => {
    assert.ok(err instanceof ReportValidationError);
    const message = err.errors.find((e) => e.code === 'escape-hatch').message;
    assert.ok(message.includes('report/v1') && !message.includes('site-input'), message);
    return true;
  });
});

test('[SITE-S1] a ref fits the id rule and is unique ignoring case within its kind', () => {
  const secondDecision = (r, decisionRef, questionRef) => {
    const copy = clone(r.decisions[0]);
    copy.decisionRef = decisionRef;
    copy.questions[0].questionRef = questionRef;
    r.decisions.push(copy);
  };
  refuses([
    ['a digit first', (r) => { r.areas[0].areaRef = '1bad'; }, 'pattern /areas/0/areaRef'],
    ['an underscore', (r) => { r.items[0].itemRef = 'retention_window'; }, 'pattern /items/0/itemRef'],
    ['65 characters', (r) => { r.gaps[0].gapRef = `g${'a'.repeat(64)}`; }, 'limit /gaps/0/gapRef'],
    ['area, case only', (r) => { r.areas[1].areaRef = 'Platform'; }, 'duplicate-id /areas/1/areaRef'],
    ['project, case only', (r) => { r.areas[0].projects.push({ projectRef: 'Packets', title: 'Again' }); }, 'duplicate-id /areas/0/projects/1/projectRef'],
    ['item, case only', (r) => { r.items[1].itemRef = 'Retention-Window'; }, 'duplicate-id /items/1/itemRef'],
    ['gap, case only', (r) => { r.gaps[1].gapRef = 'RESEARCH-UNREAD'; }, 'duplicate-id /gaps/1/gapRef'],
    ['decision, case only', (r) => secondDecision(r, 'Retention-Choice', 'another-question'), 'duplicate-id /decisions/1/decisionRef'],
    ['question, across decisions', (r) => secondDecision(r, 'another-decision', 'Retention-Length'), 'duplicate-id /decisions/1/questions/0/questionRef'],
    ['option, within its question', (r) => { question(r).options[0].optionRef = 'KEEP-ALL'; }, `duplicate-id ${Q}/options/2/optionRef`],
    ['the reserved area', (r) => { r.areas[1].areaRef = 'Unassigned'; }, 'reserved-ref /areas/1/areaRef'],
    ['a ref that is not text', (r) => { r.decisions[0].decisionRef = 7; }, 'type /decisions/0/decisionRef'],
  ]);
});

test('[SITE-S1] option refs are scoped to their question and project refs to their area', () => {
  accepts((r) => {
    const second = clone(question(r));
    second.questionRef = 'retention-scope';
    r.decisions[0].questions.push(second);
  });
  accepts((r) => { r.areas[1].projects.push({ projectRef: 'packets', title: 'Research packets' }); });
});

test('[SITE-S1] every reference resolves to a declared ref, by exact match', () => {
  refuses([
    ['item area', (r) => { r.items[0].areaRef = 'nowhere'; }, 'unknown-ref /items/0/areaRef'],
    ['item area, case differs', (r) => { r.items[0].areaRef = 'Platform'; }, 'unknown-ref /items/0/areaRef'],
    ['item project', (r) => { r.items[0].projectRef = 'nowhere'; }, 'unknown-ref /items/0/projectRef'],
    ['a project of another area', (r) => { r.areas[1].projects.push({ projectRef: 'papers', title: 'Papers' }); r.items[0].projectRef = 'papers'; }, 'unknown-ref /items/0/projectRef'],
    ['decision item', (r) => { r.decisions[0].itemRef = 'nowhere'; }, 'unknown-ref /decisions/0/itemRef'],
    ['count gap', (r) => { r.areas[0].counts.gapRefs = ['nowhere']; }, 'unknown-ref /areas/0/counts/gapRefs/0'],
    ['item gap', (r) => { r.items[1].gapRefs = ['nowhere']; }, 'unknown-ref /items/1/gapRefs/0'],
    ['recommended option', (r) => { question(r).recommendation.optionRef = 'nowhere'; }, `unknown-ref ${Q}/recommendation/optionRef`],
    ['question evidence', (r) => { question(r).evidence = ['nowhere']; }, `unknown-evidence ${Q}/evidence/0`],
    ['a gap listed twice', (r) => { r.areas[1].counts.gapRefs = ['research-unread', 'research-unread']; }, 'duplicate-reference /areas/1/counts/gapRefs/1'],
    ['a reference that is not text', (r) => { r.decisions[0].itemRef = 7; }, 'type /decisions/0/itemRef'],
  ]);
});

test('[SITE-S1] a count is a measured number or null, and coverage agrees with what is recorded', () => {
  const first = (r) => r.areas[0].counts; // complete: 3, 1, 0
  const second = (r) => r.areas[1].counts; // unavailable: null, null, null, one gap
  refuses([
    ['negative', (r) => { first(r).waiting = -1; }, 'type /areas/0/counts/waiting'],
    ['fraction', (r) => { first(r).moved = 1.5; }, 'type /areas/0/counts/moved'],
    ['text', (r) => { first(r).blocked = '0'; }, 'type /areas/0/counts/blocked'],
    ['missing', (r) => { delete first(r).waiting; }, 'required /areas/0/counts/waiting'],
    ['unit missing', (r) => { delete first(r).unit; }, 'required /areas/0/counts/unit'],
    ['coverage word', (r) => { first(r).coverage = 'most'; }, 'enum /areas/0/counts/coverage'],
    ['complete with a count not recorded', (r) => { first(r).waiting = null; }, 'consistency /areas/0/counts/coverage'],
    ['unavailable with a count', (r) => { second(r).waiting = 2; }, 'consistency /areas/1/counts/coverage'],
    ['unavailable with no gap', (r) => { second(r).gapRefs = []; }, 'consistency /areas/1/counts/gapRefs'],
    ['partial with no gap', (r) => { first(r).coverage = 'partial'; }, 'consistency /areas/0/counts/gapRefs'],
  ]);
  // A measured zero is a number, and partial coverage may carry some numbers and not others.
  accepts((r) => { Object.assign(first(r), { waiting: 0, moved: 0, blocked: 0 }); });
  accepts((r) => { Object.assign(second(r), { waiting: 2, coverage: 'partial' }); });
});

test('[SITE-S1] an item with no area names its gap and cannot name a project', () => {
  refuses([
    ['no gap named', (r) => { delete r.items[1].gapRefs; }, 'consistency /items/1/gapRefs'],
    ['an empty gap list', (r) => { r.items[1].gapRefs = []; }, 'length /items/1/gapRefs'],
    ['a project without an area', (r) => { r.items[1].projectRef = 'packets'; }, 'consistency /items/1/projectRef'],
  ]);
});

test('[SITE-S1] a question can be answered: two options or free text, and free text has its limit', () => {
  refuses([
    ['one option, no free text', (r) => { question(r).options = [question(r).options[1]]; question(r).freeText = { allowed: false }; }, `consistency ${Q}/options`],
    ['free text with no limit', (r) => { question(r).freeText = { allowed: true }; }, `required ${Q}/freeText/maxChars`],
    ['a limit with no free text', (r) => { question(r).freeText = { allowed: false, maxChars: 10 }; }, `consistency ${Q}/freeText/maxChars`],
    ['a zero limit', (r) => { question(r).freeText.maxChars = 0; }, `type ${Q}/freeText/maxChars`],
    ['a limit over the bound', (r) => { question(r).freeText.maxChars = SITE_LIMITS.freeTextChars + 1; }, `type ${Q}/freeText/maxChars`],
    ['allowed is not a boolean', (r) => { question(r).freeText.allowed = 'yes'; }, `type ${Q}/freeText/allowed`],
    ['no questions', (r) => { r.decisions[0].questions = []; }, 'length /decisions/0/questions'],
    ['too many options', (r) => { question(r).options = Array.from({ length: SITE_LIMITS.optionsPerQuestion + 1 }, (_, i) => ({ optionRef: `o${i}`, label: 'x', summary: 'x' })); }, `limit ${Q}/options`],
  ]);
  // Free text alone is an answerable question; so are two options with no free text.
  accepts((r) => { question(r).options = []; delete question(r).recommendation.optionRef; });
  accepts((r) => { question(r).options.pop(); question(r).freeText = { allowed: false }; });
});

test('[SITE-S1] item blocks follow the report block grammar, share one id space, and hold no decision block', () => {
  const risk = (id) => ({ type: 'risk', id, title: 'x', likelihood: 'low', impact: 'low', mitigation: 'x' });
  const oldDecision = { type: 'decision', id: 'old-style', question: 'x', status: 'needed', recommendation: 'x', alternatives: [{ label: 'a', summary: 'a' }, { label: 'b', summary: 'b' }] };
  refuses([
    ['a report decision block', (r) => { r.items[0].blocks.push(oldDecision); }, 'enum /items/0/blocks/2/type'],
    ['an unknown block', (r) => { r.items[0].blocks.push({ type: 'carousel' }); }, 'unknown-block /items/0/blocks/2/type'],
    ['a block id repeated on another item', (r) => { r.items[1].blocks.push(risk('Store-Growth')); }, 'duplicate-id /items/1/blocks/0/id'],
    ['a block id equal to an evidence id', (r) => { r.items[1].blocks.push(risk('queue-snapshot')); }, 'duplicate-id /items/1/blocks/0/id'],
    ['a block id colliding with another block sub-element id (-t/-ev/-cap/-title/-L1)', (r) => { r.items[0].blocks.push(risk('store-growth-t')); }, 'duplicate-id /items/0/blocks/2/id'],
    ['a citation of unknown evidence', (r) => { r.items[0].blocks[0].text = [{ cite: 'nowhere' }]; }, 'unknown-evidence /items/0/blocks/0/text/0/cite'],
  ]);
});

test('[SITE-S1] edition times, digests and the optional history are checked for shape', () => {
  const earlier = (hex) => ({ editionId: 'synthetic-edition-0000', contentId: `sha256-${hex.repeat(32)}`, observedAt: '2026-10-11T09:00:00Z' });
  refuses([
    ['a time with no zone', (r) => { r.edition.observedAt = '2026-10-12 09:00:00'; }, 'pattern /edition/observedAt'],
    ['month 13', (r) => { r.edition.coverage.from = '2026-13-01T00:00:00Z'; }, 'pattern /edition/coverage/from'],
    ['a window that ends first', (r) => { r.edition.coverage.to = '2026-10-10T09:00:00Z'; }, 'range /edition/coverage'],
    ['an upper-case digest', (r) => { r.edition.editionDigest = r.edition.editionDigest.toUpperCase(); }, 'pattern /edition/editionDigest'],
    ['a short registry hash', (r) => { r.registry.sha256 = 'abc'; }, 'pattern /registry/sha256'],
    ['an empty history', (r) => { r.history = []; }, 'length /history'],
    ['a history content ID of the wrong form', (r) => { r.history = [{ ...earlier('ab'), contentId: 'sha256-xyz' }]; }, 'pattern /history/0/contentId'],
    ['the same bundle twice', (r) => { r.history = [earlier('ab'), earlier('ab')]; }, 'duplicate-reference /history/1/contentId'],
  ]);
  accepts((r) => { r.history = [earlier('ab'), earlier('cd')]; });
});

test('[SITE-S1] site input text is bounded before it is parsed, by its own size limit', () => {
  const refusal = (text) => {
    try {
      parseSiteInputText(text);
    } catch (err) {
      assert.ok(err instanceof SiteInputValidationError, `expected SiteInputValidationError, got ${err}`);
      return err.errors[0];
    }
    return assert.fail('expected the parse to be refused');
  };
  const pad = (bytes) => JSON.stringify({ pad: 'a'.repeat(bytes) });

  const tooBig = refusal(pad(SITE_LIMITS.inputBytes));
  assert.equal(tooBig.code, 'limit');
  assert.ok(tooBig.message.startsWith('site input is '), tooBig.message);
  assert.equal(refusal(`${'['.repeat(17)}${']'.repeat(17)}`).code, 'limit');
  assert.equal(refusal('{').code, 'json');

  // Larger than a report may be, smaller than a site input may be: the site parser takes
  // it, and the report parser still refuses it under its own name.
  const between = pad(2 * 1024 * 1024);
  assert.equal(parseSiteInputText(between).pad.length, 2 * 1024 * 1024);
  assert.throws(() => parseReportText(between), (err) => err instanceof ReportValidationError && err.errors[0].message.startsWith('report is '));
  assert.deepEqual(parseSiteInputText(fixtureText), fixture());
});
