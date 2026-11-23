// Expanded seeded boundary property for report.md (agent-Markdown requirement; lead
// ruling 2026-09-26 13:43Z/13:46Z/13:56Z).
//
// Same model as the fix3 run (test/unit/e2-markdown-boundary-property.test.mjs, kept
// unchanged), with new seeds, more cases per seed and a wider alphabet:
//   - realistic tokens that the escape-relaxation pass un-escapes (snake_case, a*b,
//     $5, array[0], c < d, 3:2, C:\x, ~50, __init__ ...), placed next to generated
//     syntax so relaxation is exercised at segment edges;
//   - authored bracket pairs whose content equals an anchor definition label in the
//     same document, in other letter cases and with inner spaces (the authored-label
//     collision rule): they must stay literal text, never links to "#<id>".
// Each case must parse to exactly its expected structure under commonmark 0.31.2 and
// pandoc -f gfm. The test also re-renders the strict serialization, checks that
// relaxing it reproduces the packet's report.md byte for byte, and records how many
// escapes relaxation removed and how many of those sit at a segment edge.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { relaxEscapes } from '../../src/render/relax.mjs';
import { strictMarkdownFor } from '../md-corpus.mjs';
import { buildCases, cmInline, cmSection, EDGE, expected, forbiddenCounts, makeGen, normalize, pdHeadingText, pdInline, pdSection, render, WORDS } from '../md-boundary-model.mjs';

export const SEEDS = [7, 13, 101, 2718, 16180, 27182, 31337, 65537, 99991, 123457, 424242, 20260927, 8675309, 1618033, 5772156, 1414213];
// report/v1 allows at most 200 blocks per section.
const PER_SEED = { paragraphs: 190, lists: 16, itemsPerList: 5, tables: 4, rowsPerTable: 20, headings: 50 };
const REALISTIC = ['snake_case_name', 'NODE_ENV', 'x_1', '__init__.py', 'a*b', '2 * 3', '*.log', '$5', '$1,200', 'array[0]', 'map[key]', '[--verbose]', 'c < d', '<= 100', '3:2', '10:30', 'C:\\Users', '~/.config', '~50', '#42', 'Note: x', 'v1.2.3', 'Q&A', '50%', 'ops@example.com', 'www.', '1.', '- x', '+ y'];
const anchorLabels = (seed) => [`[summary]`, `[Evidence]`, `[ PROVENANCE ]`, `[sec-bp-${seed}]`, `[SEC-BH-${seed}]`, `[f-BF-${seed}-0]`, `[F-bf-${seed}-1]`, `[ev-ev-determinism]`, `[tbl-bt-${seed}-0]`];

let pandoc = null;
test.before(() => {
  const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
  pandoc = which.status === 0 ? which.stdout.trim() : null;
});

function genFor(seed) {
  return makeGen(seed, { edge: EDGE, words: [...WORDS, ...REALISTIC, ...anchorLabels(seed)] });
}

function internalLinks(md) {
  const w = new commonmark.Parser().parse(md).walker();
  const out = [];
  let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'link' && e.node.destination.startsWith('#')) out.push(e.node.destination);
  return out;
}

for (const seed of SEEDS) {
  test(`[E8] expanded boundary property, seed ${seed}: CommonMark structure, relaxation at segment edges, no anchor-label links`, async (t) => {
    const cases = buildCases(genFor(seed), PER_SEED);
    const { report, built, markdown } = await render(t, seed, cases);
    const removals = [];
    const strict = await strictMarkdownFor(built.outDir, report);
    assert.equal(relaxEscapes(strict, { onRemove: (r) => removals.push(r) }), markdown, 'relaxing the strict serialization reproduces report.md');
    assert.deepEqual(forbiddenCounts(markdown), { html: 0, image: 0 });
    assert.deepEqual(internalLinks(markdown), [], 'no authored bracket pair became a link to an anchor');
    const doc = new commonmark.Parser().parse(markdown);
    const paras = cmSection(doc, `Boundary paragraphs ${seed}`);
    assert.equal(paras.length, cases.paragraphs.length);
    cases.paragraphs.forEach((seq, i) => {
      assert.equal(paras[i].type, 'paragraph', `case ${i} is a paragraph`);
      assert.deepEqual(normalize(cmInline(paras[i])), expected(seq), `seed ${seed} paragraph ${i}: ${JSON.stringify(seq)}`);
    });
    const lists = cmSection(doc, `Boundary lists ${seed}`);
    assert.equal(lists.length, cases.lists.length);
    cases.lists.forEach((items, i) => {
      const got = [];
      for (let item = lists[i].firstChild; item; item = item.next) got.push(item);
      assert.equal(got.length, items.length, `seed ${seed} list ${i} item count`);
      items.forEach((seq, j) => {
        assert.equal(got[j].firstChild?.type, 'paragraph');
        assert.equal(got[j].firstChild.next, null);
        assert.deepEqual(normalize(cmInline(got[j].firstChild)), expected(seq), `seed ${seed} list ${i} item ${j}: ${JSON.stringify(seq)}`);
      });
    });
    const heads = cmSection(doc, `Boundary headings ${seed}`).filter((b) => b.type === 'heading');
    assert.equal(heads.length, cases.headings.length);
    cases.headings.forEach((title, i) => {
      assert.deepEqual(normalize(cmInline(heads[i])), normalize([{ t: 'text', s: `Finding BF-${seed}-${i}: ${title}` }]), `seed ${seed} heading ${i}: ${JSON.stringify(title)}`);
    });
    const atEdge = removals.filter((r) => r.left !== 'text' || r.right !== 'text');
    assert.ok(removals.length > 0 && atEdge.length > 0, 'relaxation removed escapes, some at segment edges');
    const byEdge = {};
    for (const r of atEdge) for (const side of [r.left, r.right]) if (side !== 'text') byEdge[side] = (byEdge[side] ?? 0) + 1;
    t.diagnostic(`boundary-seed ${JSON.stringify({ seed, run: 'expanded', reader: 'commonmark 0.31.2', paragraphs: cases.paragraphs.length, listItems: cases.lists.length * PER_SEED.itemsPerList, headings: cases.headings.length, tableCells: 'NOT_EXECUTED: tables are a GFM extension CommonMark does not parse; covered by the pandoc half', checked: cases.paragraphs.length + cases.lists.length * PER_SEED.itemsPerList + cases.headings.length, relaxRemovals: removals.length, relaxRemovalsAtSegmentEdge: atEdge.length, edgeNeighbours: byEdge })}`);
  });

  test(`[E8] expanded boundary property, seed ${seed}: the same cases plus GFM table cells under pandoc -f gfm`, async (t) => {
    if (!pandoc) {
      t.skip('pandoc not installed: GFM half NOT_EXECUTED');
      return;
    }
    const cases = buildCases(genFor(seed), PER_SEED);
    const { markdown } = await render(t, seed, cases);
    const r = spawnSync(pandoc, ['-f', 'gfm', '-t', 'json', '--preserve-tabs'], { input: markdown, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.equal(r.status, 0, r.stderr);
    const blocks = JSON.parse(r.stdout).blocks;
    const all = JSON.stringify(blocks);
    assert.ok(!/"t":"(?:RawInline|RawBlock|Image|Math|Note)"/.test(all), 'no raw HTML, images, math or footnotes under GFM');
    assert.ok(!/\["#[^"]*",""\]/.test(all), 'no link to an in-document anchor under GFM');
    const paras = pdSection(blocks, `Boundary paragraphs ${seed}`);
    assert.equal(paras.length, cases.paragraphs.length);
    cases.paragraphs.forEach((seq, i) => {
      assert.equal(paras[i].t, 'Para');
      assert.deepEqual(normalize(pdInline(paras[i].c)), expected(seq), `seed ${seed} GFM paragraph ${i}: ${JSON.stringify(seq)}`);
    });
    const lists = pdSection(blocks, `Boundary lists ${seed}`);
    assert.equal(lists.length, cases.lists.length);
    cases.lists.forEach((items, i) => {
      assert.equal(lists[i].t, 'BulletList');
      assert.equal(lists[i].c.length, items.length);
      items.forEach((seq, j) => {
        const item = lists[i].c[j];
        assert.equal(item.length, 1);
        assert.deepEqual(normalize(pdInline(item[0].c)), expected(seq), `seed ${seed} GFM list ${i} item ${j}: ${JSON.stringify(seq)}`);
      });
    });
    const tables = pdSection(blocks, `Boundary tables ${seed}`).filter((b) => b.t === 'Table');
    assert.equal(tables.length, cases.tables.length);
    cases.tables.forEach((rows, i) => {
      const bodyRows = tables[i].c[4][0][3];
      assert.equal(bodyRows.length, rows.length);
      rows.forEach((cells, j) => {
        const got = bodyRows[j][1];
        assert.equal(got.length, 2, `seed ${seed} table ${i} row ${j} has exactly 2 cells`);
        cells.forEach((seq, k) => {
          assert.deepEqual(normalize(pdInline(got[k][4].flatMap((b) => b.c))), expected(seq), `seed ${seed} GFM table ${i} row ${j} cell ${k}: ${JSON.stringify(seq)}`);
        });
      });
    });
    const heads = pdSection(blocks, `Boundary headings ${seed}`).filter((b) => b.t === 'Header');
    assert.equal(heads.length, cases.headings.length);
    cases.headings.forEach((title, i) => {
      assert.deepEqual(pdHeadingText(heads[i].c[2]), normalize([{ t: 'text', s: `Finding BF-${seed}-${i}: ${title}` }]), `seed ${seed} GFM heading ${i}: ${JSON.stringify(title)}`);
    });
    const version = spawnSync(pandoc, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
    const binary = await realpath(pandoc);
    const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    const checked = cases.paragraphs.length + cases.lists.length * PER_SEED.itemsPerList + cases.headings.length + cases.tables.length * PER_SEED.rowsPerTable * 2;
    t.diagnostic(`boundary-seed ${JSON.stringify({ seed, run: 'expanded', reader: `${pandoc} ${version} -f gfm`, pandoc: { path: pandoc, binary, version, sha256 }, paragraphs: cases.paragraphs.length, listItems: cases.lists.length * PER_SEED.itemsPerList, headings: cases.headings.length, tableCells: cases.tables.length * PER_SEED.rowsPerTable * 2, checked })}`);
  });
}
