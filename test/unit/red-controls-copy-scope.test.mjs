// A control's scratch copy must hold what its tests read, or its BASELINE fails and the control can never go red.
// The copy is a curated list (scripts/red-controls.mjs copyEntries: the product tree plus each control's extras), so
// it can drift from the tests: the 093ab1c merge run (2026-10-04) found R61-R68 and R311 NOT red for exactly that.
// README.md had gained a link into skills/ (c680dce) that no E9 control copied, and R326/R327 anchor in .gitignore,
// which R311's anchor check reads but its copy lacked. These checks derive the need from the sources themselves,
// so a new link or a new control file fails here, in the ordinary suite, not only in a red-controls run.
// The README paths come from the E9 test's own extraction (test/readme-paths.mjs), every form it reads from the tree:
// links, locations-table paths, file references, script commands and its fixed inputs (QA CS-1 and L-1 on 3a78169).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CONTROLS, copyEntries } from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';
import { readmePaths } from '../readme-paths.mjs';

const E9 = 'test/unit/e9-readme.test.mjs';
const norm = (p) => p.replace(/^\.\//, '').replace(/\/$/, '');
// A copy holds a path when one of its entries is the path or an ancestor of it, or lies beneath it (the directory then
// exists, which is all the gate checks of a directory).
export const holds = (entries, p) => entries.some((e) => norm(p) === e || norm(p).startsWith(`${e}/`) || e.startsWith(`${norm(p)}/`));
// Problems: a control whose tests include `testFile` and whose copy does not hold a needed path.
export function copyScopeProblems(controls, testFile, needed, entriesOf = copyEntries) {
  const problems = [];
  for (const c of controls.filter((x) => (x.tests ?? []).includes(testFile))) {
    const entries = entriesOf(c.extra ?? []);
    for (const p of [...new Set(needed.map(norm))]) if (!holds(entries, p)) problems.push(`${c.id}: its copy lacks ${p}, which ${testFile} reads`);
  }
  return problems;
}
// Every path the E9 test reads from the tree, all forms together.
export const e9Needs = (readme, pkg) => Object.values(readmePaths(readme, pkg)).flat();

test('[V2.1-04] every control that runs the E9 README tests copies every path the E9 test reads: links, locations-table paths, file references, script commands and fixed inputs', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  for (const [form, paths] of Object.entries(readmePaths(readme, pkg))) assert.ok(paths.length > 0, `the README yields ${form} paths (the instrument)`);
  assert.ok(CONTROLS.some((c) => (c.tests ?? []).includes(E9)), 'there are E9 controls (the instrument)');
  assert.deepEqual(copyScopeProblems(CONTROLS, E9, e9Needs(readme, pkg)), []);
});

test('[V2.1-04] every control that runs the anchor check copies the file of every control', () => {
  assert.ok(CONTROLS.some((c) => (c.tests ?? []).includes('test/unit/red-controls-anchors.test.mjs')), 'there is an anchor control (the instrument)');
  assert.deepEqual(copyScopeProblems(CONTROLS, 'test/unit/red-controls-anchors.test.mjs', CONTROLS.map((c) => c.file)), []);
});

// A planted README: a link and a locations-table path into uncopied directories, a produced path, a script command,
// and links the gate does not read from the tree (external, same-file anchor, image).
const PLANT = [
  '## Quick start (five minutes)', '', '```sh', 'mkdir -p out', 'node scripts/plant.mjs --x', '```', '',
  'See [a](plant/x.md#h), [b](https://example.invalid), [c](#local), ![i](img.png) and [d](./docs/y.md).', '',
  '| Path | Contents |', '| --- | --- |', '| `out/packet/` | produced by the quick start |', '| `table-plant/` | in the tree |', '',
].join('\n');

test('[V2.1-04] the copy-scope checks see a planted gap: a README link or a locations-table path into an uncopied directory, and a control file in an uncopied entry', () => {
  const p = readmePaths(PLANT, { scripts: {} });
  assert.deepEqual([p.links, p.locations, p.scripts], [['plant/x.md', './docs/y.md'], ['table-plant'], ['scripts/plant.mjs']]);
  const e9 = { id: 'P1', tests: [E9], extra: ['README.md', 'docs', 'package-lock.json', 'evidence/e2e-agent-md'] };
  assert.deepEqual(copyScopeProblems([e9], E9, e9Needs(PLANT, { scripts: {} })), [`P1: its copy lacks plant/x.md, which ${E9} reads`, `P1: its copy lacks table-plant, which ${E9} reads`]);
  assert.deepEqual(copyScopeProblems([{ ...e9, extra: [...e9.extra, 'plant', 'table-plant'] }], E9, e9Needs(PLANT, { scripts: {} })), [], 'and none once both are copied');
  assert.deepEqual(copyScopeProblems([{ ...e9, extra: ['README.md', 'docs'] }], E9, ['evidence']), [`P1: its copy lacks evidence, which ${E9} reads`], 'a nested entry holds its parent directory, and only then');
  assert.equal(holds(['evidence/e2e-agent-md'], 'evidence/'), true);
  const anchors = { id: 'P2', tests: ['test/unit/red-controls-anchors.test.mjs'], extra: ['docs'] };
  assert.deepEqual(copyScopeProblems([anchors], 'test/unit/red-controls-anchors.test.mjs', ['.gitignore', 'src/x.mjs']), ['P2: its copy lacks .gitignore, which test/unit/red-controls-anchors.test.mjs reads']);
  assert.deepEqual(copyScopeProblems([{ ...anchors, extra: ['docs', '.gitignore'] }], 'test/unit/red-controls-anchors.test.mjs', ['.gitignore', 'src/x.mjs']), [], 'and none once the entry is copied');
});

// L-1: the README link pattern is written once. A second copy (the E9 test and this guard each had one) can drift, and
// the guard would then derive different links from the ones the gate checks.
const LINK_PATTERN = '(?<!!)\\[([^\\]]*)\\]\\(';
export const linkPatternCopies = (files) => files.filter(([, text]) => text.includes(LINK_PATTERN)).map(([name]) => name);
const testFiles = (dir) => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? testFiles(`${dir}/${d.name}`) : /\.m?js$/.test(d.name) ? [`${dir}/${d.name}`] : []));

test('[V2.1-04] the README link pattern is written once, in test/readme-paths.mjs, and a planted second copy is seen', () => {
  const files = [...testFiles('test'), ...testFiles('scripts')].map((f) => [f, readFileSync(join(REPO, f), 'utf8')]);
  assert.deepEqual(linkPatternCopies(files), ['test/readme-paths.mjs']);
  assert.deepEqual(linkPatternCopies([['a.mjs', 'const x = /(?<!!)\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g;'], ['b.mjs', 'none']]), ['a.mjs'], 'the scan sees a planted copy');
});
