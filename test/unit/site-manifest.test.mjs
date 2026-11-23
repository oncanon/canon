// Pages, anchors and decisions of a site-bundle/v1 manifest
// (docs/projects/interactive-sitrep-contract.md, revision 4; slice S2).
// Links are judged by resolving them the way a browser does (the URL class), not by
// repeating the rule that builds them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { siteAnchor } from '../../src/render/anchors.mjs';
import { anchorDefinition } from '../../src/render/markdown.mjs';
import * as manifestModule from '../../src/site/manifest.mjs';
import {
  UNASSIGNED_TITLE, pageFiles, relativeHref, siteAnchors, siteDecisions, siteManifestParts, sitePages,
} from '../../src/site/manifest.mjs';
import { validateSiteInput } from '../../src/site/validate.mjs';
import { REPO } from '../helpers.mjs';

const SITE_FIXTURE = join(REPO, 'fixtures/site/first-slice.site-input.json');
const BUNDLE_URL = `http://site.test/p/sha256-${'ab'.repeat(32)}/`;

let fixtureText;
test.before(async () => { fixtureText = await readFile(SITE_FIXTURE, 'utf8'); });

// A fresh fixture with one change, validated, so every case is an input the builder could get.
function input(mutate = () => {}) {
  const value = JSON.parse(fixtureText);
  mutate(value);
  return validateSiteInput(value);
}

const question = (r) => r.decisions[0].questions[0];
const pageOf = (anchors, anchor) => anchors.find((entry) => entry.anchor === anchor)?.page;
// Where a link written in one bundle file lands, as a path inside the bundle.
const landsOn = (fromFile, href) => new URL(href, new URL(fromFile, BUNDLE_URL)).href.slice(BUNDLE_URL.length);

test('[SITE-S2] site anchors are a fixed prefix plus the ref, one prefix for each kind', () => {
  assert.deepEqual(
    [siteAnchor.area('x'), siteAnchor.item('x'), siteAnchor.decision('x'), siteAnchor.question('x'), siteAnchor.gap('x')],
    ['a-x', 'i-x', 'd-x', 'q-x', 'g-x'],
  );
});

test('[SITE-S2] pages follow the input: portfolio, each area with its projects, unassigned, then items', () => {
  const site = input();
  assert.deepEqual(sitePages(site), [
    { id: '', html: 'index.html', markdown: 'index.md', title: site.title, parent: null },
    { id: 'area/platform', html: 'area/platform/index.html', markdown: 'area/platform/index.md', title: 'Platform', parent: '' },
    { id: 'area/platform/project/packets', html: 'area/platform/project/packets/index.html', markdown: 'area/platform/project/packets/index.md', title: 'Review packets', parent: 'area/platform' },
    { id: 'area/research', html: 'area/research/index.html', markdown: 'area/research/index.md', title: 'Research', parent: '' },
    { id: 'area/unassigned', html: 'area/unassigned/index.html', markdown: 'area/unassigned/index.md', title: UNASSIGNED_TITLE, parent: '' },
    { id: 'item/retention-window', html: 'item/retention-window/index.html', markdown: 'item/retention-window/index.md', title: 'Retention window for published packets', parent: 'area/platform/project/packets' },
    { id: 'item/orphan-request', html: 'item/orphan-request/index.html', markdown: 'item/orphan-request/index.md', title: 'A request with no mapped area', parent: 'area/unassigned' },
  ]);

  const reversed = input((r) => { r.areas.reverse(); r.items.reverse(); });
  assert.deepEqual(sitePages(reversed).map((page) => page.id), [
    '', 'area/research', 'area/platform', 'area/platform/project/packets', 'area/unassigned', 'item/orphan-request', 'item/retention-window',
  ]);
});

test('[SITE-S2] an item with an area and no project hangs under its area, and the unassigned page exists only when needed', () => {
  const site = input((r) => { r.items[0].projectRef = null; r.items.pop(); });
  const pages = sitePages(site);
  assert.equal(pages.find((page) => page.id === 'item/retention-window').parent, 'area/platform');
  assert.ok(!pages.some((page) => page.id === 'area/unassigned'));
  assert.ok(!siteAnchors(site).some((entry) => entry.anchor === 'a-unassigned'));
});

test('[SITE-S2] every page parent is itself a page, and every anchor sits on a page', () => {
  const site = input();
  const ids = new Set(sitePages(site).map((page) => page.id));
  for (const page of sitePages(site)) assert.ok(page.parent === null || ids.has(page.parent), `parent of ${page.id}`);
  for (const entry of siteAnchors(site)) assert.ok(ids.has(entry.page), `page of ${entry.anchor}`);
});

test('[SITE-S2] the fixture anchors, in reading order, each on one page', () => {
  assert.deepEqual(siteAnchors(input()), [
    { anchor: 'ev-owner-thread', page: '', kind: 'evidence' },
    { anchor: 'a-platform', page: 'area/platform', kind: 'area' },
    { anchor: 'a-research', page: 'area/research', kind: 'area' },
    { anchor: 'g-research-unread', page: 'area/research', kind: 'gap' },
    { anchor: 'a-unassigned', page: 'area/unassigned', kind: 'area' },
    { anchor: 'i-retention-window', page: 'item/retention-window', kind: 'item' },
    { anchor: 'r-store-growth', page: 'item/retention-window', kind: 'risk' },
    { anchor: 'd-retention-choice', page: 'item/retention-window', kind: 'decision' },
    { anchor: 'q-retention-length', page: 'item/retention-window', kind: 'question' },
    { anchor: 'ev-queue-snapshot', page: 'item/retention-window', kind: 'evidence' },
    { anchor: 'i-orphan-request', page: 'item/orphan-request', kind: 'item' },
    { anchor: 'g-orphan-unmapped', page: 'item/orphan-request', kind: 'gap' },
  ]);
});

test('[SITE-S2] a gap or evidence entry is shown where it is first referred to, and on the portfolio when nothing refers to it', () => {
  const cite = (id) => ({ type: 'paragraph', text: [{ cite: id }] });
  const cases = [
    ['a gap named by an area and by an item stays with the area', (r) => { r.items[0].gapRefs = ['research-unread']; }, 'g-research-unread', 'area/research'],
    ['a gap named by two items goes to the first', (r) => { r.items[0].gapRefs = ['orphan-unmapped']; }, 'g-orphan-unmapped', 'item/retention-window'],
    ['a gap nothing names', (r) => { r.gaps.push({ gapRef: 'loose', kind: 'coverage', text: 'Nothing refers to this.' }); }, 'g-loose', ''],
    ['evidence cited by two items goes to the first', (r) => { r.items[1].blocks.push(cite('queue-snapshot')); }, 'ev-queue-snapshot', 'item/retention-window'],
    ['the first is the first in input order', (r) => { r.items[1].blocks.push(cite('queue-snapshot')); r.items.reverse(); }, 'ev-queue-snapshot', 'item/orphan-request'],
    ['evidence cited only in an option summary', (r) => { question(r).options[0].summary = ['See ', { cite: 'owner-thread' }]; }, 'ev-owner-thread', 'item/retention-window'],
    ['evidence cited only in a recommendation', (r) => { question(r).recommendation.text = [{ cite: 'owner-thread' }]; }, 'ev-owner-thread', 'item/retention-window'],
    ['a table column keyed "cite" is a cell, not a citation', (r) => { r.items[1].blocks.push({ type: 'table', id: 't1', caption: 'c', columns: [{ key: 'cite', label: 'Cite' }], rows: [{ cite: 'owner-thread' }] }); }, 'ev-owner-thread', ''],
  ];
  for (const [what, mutate, anchor, page] of cases) {
    assert.equal(pageOf(siteAnchors(input(mutate)), anchor), page, what);
  }
});

test('[SITE-S2] display blocks keep their report anchors, nested ones included, on the item page', () => {
  const site = input((r) => {
    r.items[1].blocks.push({
      type: 'finding', id: 'f1', title: 't', severity: 'low', confidence: 'open', claim: 'x', evidence: ['owner-thread'],
      detail: [{ type: 'code', id: 'c1', title: 't', language: 'text', source: 'x' }],
    });
    r.items[1].blocks.push({ type: 'diff', id: 'p1', title: 't', language: 'text', patch: '-a' });
  });
  const onItem = siteAnchors(site).filter((entry) => entry.page === 'item/orphan-request').map((entry) => `${entry.kind} ${entry.anchor}`);
  assert.deepEqual(onItem, ['item i-orphan-request', 'finding f-f1', 'code code-c1', 'diff code-p1', 'gap g-orphan-unmapped', 'evidence ev-owner-thread']);
});

test('[SITE-S2] an anchor names one place in the bundle and is a valid Markdown anchor', () => {
  const anchors = siteAnchors(input());
  const folded = anchors.map((entry) => entry.anchor.toLowerCase());
  assert.equal(new Set(folded).size, folded.length);
  for (const entry of anchors) assert.equal(anchorDefinition(entry.anchor), `[${entry.anchor}]: #${entry.anchor}`);

  // Input that skipped validation: two items whose refs differ only in case.
  const colliding = JSON.parse(fixtureText);
  colliding.items[1].itemRef = 'Retention-Window';
  assert.throws(() => siteAnchors(colliding), /unreachable: anchor "i-Retention-Window"/);
});

test('[SITE-S2] a link between any two bundle files resolves to the target at every page depth', () => {
  const pages = sitePages(input());
  assert.deepEqual([...new Set(pages.map((page) => page.html.split('/').length - 1))].sort(), [0, 2, 4], 'the fixture has a page at every depth');
  const files = pages.flatMap((page) => [page.html, page.markdown]);
  for (const from of files) {
    for (const to of files) assert.equal(landsOn(from, relativeHref(from, to)), to, `${from} -> ${to}`);
  }
  assert.deepEqual(pageFiles(''), { html: 'index.html', markdown: 'index.md' });
});

test('[SITE-S2] a decision entry carries its page, anchor and questions with their anchors, option refs and free-text bounds, with no action route', () => {
  assert.equal('ACTION_PREFIX' in manifestModule, false);
  assert.equal('actionHref' in manifestModule, false);
  assert.equal('siteActions' in manifestModule, false);
  assert.deepEqual(siteDecisions(input()), [{
    decisionRef: 'retention-choice',
    kind: 'choice',
    page: 'item/retention-window',
    anchor: 'd-retention-choice',
    questions: [{
      questionRef: 'retention-length',
      anchor: 'q-retention-length',
      optionRefs: ['days-30', 'days-90', 'keep-all'],
      freeText: { allowed: true, maxChars: 500 },
    }],
  }]);

  const changed = siteDecisions(input((r) => {
    question(r).options.reverse();
    question(r).freeText = { allowed: false };
    const second = JSON.parse(JSON.stringify(question(r)));
    second.questionRef = 'retention-scope';
    r.decisions[0].questions.push(second);
  }));
  assert.deepEqual(changed[0].questions.map((q) => q.questionRef), ['retention-length', 'retention-scope'], 'every question of the decision, in order');
  assert.deepEqual(changed[0].questions.map((q) => q.anchor), ['q-retention-length', 'q-retention-scope'], 'every question anchor, in order');
  assert.deepEqual(changed[0].questions[0].optionRefs, ['keep-all', 'days-90', 'days-30'], 'options in the order given');
  assert.deepEqual(changed[0].questions[0].freeText, { allowed: false, maxChars: null });

  const site = input();
  const anchors = siteAnchors(site);
  for (const decision of siteDecisions(site)) {
    assert.equal(pageOf(anchors, decision.anchor), decision.page);
    for (const q of decision.questions) assert.equal(pageOf(anchors, q.anchor), decision.page);
  }
});

test('[SITE-S2] the manifest parts copy the edition exactly, are stable, and leave the input alone', () => {
  const site = input();
  const before = JSON.parse(JSON.stringify(site));
  const parts = siteManifestParts(site);
  assert.deepEqual(Object.keys(parts), ['edition', 'pages', 'anchors', 'decisions']);
  assert.deepEqual(parts.edition, site.edition);
  assert.notEqual(parts.edition, site.edition, 'a copy, not the input object');
  assert.deepEqual(siteManifestParts(site), parts);
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), parts, 'plain data');
  assert.deepEqual(site, before);
});
