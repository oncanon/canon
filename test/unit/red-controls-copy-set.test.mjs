// H-QA-2: a control whose scratch copy lacks a file its
// tests read has a red baseline, so its own "red" proves nothing. Two guards:
// - STATIC: for every control, each top-level repository entry named as a path literal in its test
//   files (and in the test/ modules they import) must be in the control's copy set, which is
//   derived from the harness itself (copyEntries). It is lexical. Exactly what it sees, and what it does
//   not (QA's CS1-CS10, and CS11 from the AP.8 integration), is enumerated in docs/operations/red-controls-copy-set.md, rendered from
//   COPYSET_CLAIMS and COPYSET_LIMITS below and checked by the last test here.
// - The harness verdict names a red baseline ("baseline is not green") instead of only "not red".
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { CONTROLS, COPY_ALWAYS, copyEntries, runVerdict } from '../../scripts/red-controls.mjs';
import { REPO } from '../helpers.mjs';
import { importsOf } from '../support/import-graph.mjs';

const TOP = readdirSync(REPO).filter((e) => !['node_modules', '.git'].includes(e));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A READ of a top-level entry: a path literal passed straight to a file-system call, to join(REPO,
// …), or to the tests' read/disk/at helpers (`readFileSync('infra/…')`, `join(REPO, 'docs/…')`,
// or a read of the root .gitignore by name). A bare mention (a packet path "evidence/…" inside fixture data, a value) is
// not a read. A directory must be named as a path ('infra/…'), a file by its exact name.
const isDir = (e) => { try { return readdirSync(join(REPO, e)) && true; } catch { return false; } };
// The read calls, exported so docs/operations/red-controls-copy-set.md renders them (the pattern is
// built from these lists; it is byte-identical to the one H-QA-2 shipped).
export const FS_CALLS = ['readFileSync', 'readdirSync', 'existsSync', 'statSync'];
export const HELPER_CALLS = ['read', 'disk', 'at', 'blocks'];
const callOf = (helpers) => `(?:(?:${[...FS_CALLS, ...helpers.map((h) => `\\b${h}`)].join('|')})\\(|join\\(REPO,)\\s*`;
const CALL = callOf(HELPER_CALLS);
const literalOf = (call, e) => new RegExp(`${call}(['"\`])(?:\\./)?${esc(e)}${isDir(e) ? '/[^\'"\`]*' : ''}\\1`);
const NAMED = new Map(TOP.map((e) => [e, literalOf(CALL, e)]));
// A file's own read helpers (K8): a function defined on one line, `const f = (…) => …` or
// `function f(…) { … }`, whose body calls one of FS_CALLS. A call of it reads, like a call of read(.
const FS_CALL = new RegExp(`\\b(?:${FS_CALLS.join('|')})\\(`);
export const localHelpers = (src) => [...src.matchAll(/^[ \t]*(?:export\s+)?(?:const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(?:async\s+)?function\s+(\w+)\s*\()(.*)$/gm)].filter((m) => FS_CALL.test(m[3])).map((m) => m[1] ?? m[2]);
// A file's path constants (K9): `const X = '<path>'`, a plain string. Passed to a read call, X reads that path.
export const pathConstants = (src) => [...src.matchAll(/^[ \t]*(?:export\s+)?const\s+(\w+)\s*=\s*(['"`])([^'"`$\\\n]*)\2\s*;/gm)].map((m) => [m[1], m[3]]);
const entryOf = (path) => TOP.find((e) => (isDir(e) ? new RegExp(`^(?:\\./)?${esc(e)}/`) : new RegExp(`^(?:\\./)?${esc(e)}$`)).test(path));
// The top-level entries one source reads: path literals at a read call, and path constants passed to one.
const readsBySource = new Map();
export function entriesRead(src) {
  if (readsBySource.has(src)) return readsBySource.get(src);
  const call = callOf([...HELPER_CALLS, ...localHelpers(src)]);
  const found = new Set(TOP.filter((e) => reads(src, literalOf(call, e))));
  for (const [name, path] of pathConstants(src)) {
    const e = entryOf(path);
    if (e && reads(src, new RegExp(`${call}${name}\\b`))) found.add(e);
  }
  readsBySource.set(src, found);
  return found;
}

// A test file and the test/ modules it imports, transitively: every relative .mjs import the import
// graph's lexer reads (test/support/import-graph.mjs), so an import named inside a string, comment,
// template or regex is never followed (QA notes on 3a983df).
export function testSources(file, read = (f) => readFileSync(join(REPO, f), 'utf8'), seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const e of importsOf(read(file)).edges) {
    const spec = e.spec.split('?')[0];
    if (!/^\.{1,2}\//.test(spec) || !spec.endsWith('.mjs')) continue;
    const dep = relative(REPO, join(REPO, dirname(file), spec));
    if (dep.startsWith('test/')) testSources(dep, read, seen);
  }
  return seen;
}

// Every read is a dependency. A read guarded by existsSync is still a read: there is no optional read.
const reads = (src, re) => src.split('\n').some((line) => re.test(line));

export function copySetProblems(controls = CONTROLS, read = (f) => readFileSync(join(REPO, f), 'utf8')) {
  const problems = [];
  for (const c of controls) {
    const copied = new Set(copyEntries(c.extra ?? []));
    for (const t of c.tests) {
      for (const f of testSources(t, read)) {
        for (const entry of entriesRead(read(f))) if (!copied.has(entry)) problems.push(`${c.id}: ${f} names ${entry}, which the control's copy lacks (extra: ${JSON.stringify(c.extra ?? [])})`);
      }
    }
  }
  return problems;
}

test('[H-2] every control copies every top-level entry its tests name as a path', () => {
  assert.ok(COPY_ALWAYS.every((e) => TOP.includes(e)), 'the always-copied entries exist');
  assert.ok(TOP.includes('infra') && TOP.includes('docs'), 'the check sees infra/ and docs/');
  assert.deepEqual(copySetProblems(), []);
});

test('[H-2] the copy-set check catches a test that reads infra/ under a docs-only control (the e559653 defect)', () => {
  const planted = [{ id: 'P1', extra: ['docs'], tests: ['test/unit/v21-public-target.test.mjs'] }];
  const read = (f) => (f === 'test/unit/v21-public-target.test.mjs' ? `${readFileSync(join(REPO, f), 'utf8')}\nreaddirSync(join(REPO, 'infra/cloudflare'));\n` : readFileSync(join(REPO, f), 'utf8'));
  assert.deepEqual(copySetProblems(planted, read), ['P1: test/unit/v21-public-target.test.mjs names infra, which the control\'s copy lacks (extra: ["docs"])']);
  assert.deepEqual(copySetProblems([{ ...planted[0], extra: ['docs', 'infra'] }], read), [], 'and accepts it once the control copies infra');
  // There is no optional-read exemption: a path held in a const is a read, with or without an existsSync guard.
  const unguarded = (f) => (f === 'test/unit/v21-public-target.test.mjs' ? `${readFileSync(join(REPO, f), 'utf8')}\nconst tierDir = join(REPO, 'infra/cloudflare');\nreaddirSync(tierDir);\n` : readFileSync(join(REPO, f), 'utf8'));
  assert.equal(copySetProblems(planted, unguarded).length, 1, 'an unguarded const path read is caught');
  const guarded = (f) => (f === 'test/unit/v21-public-target.test.mjs' ? `${readFileSync(join(REPO, f), 'utf8')}\nconst tierDir = join(REPO, 'infra/cloudflare');\nif (existsSync(tierDir)) readdirSync(tierDir);\n` : readFileSync(join(REPO, f), 'utf8'));
  assert.equal(copySetProblems(planted, guarded).length, 1, 'a read guarded by existsSync is still caught');
});

test('[H-2] the harness verdict names a red baseline', () => {
  const base = { id: 'X', wentRed: false, broken: { exitCode: 1 }, intendedFailed: ['t'], warnings: [], baseline: { exitCode: 1, firstFailure: 'some test' } };
  const v = runVerdict([base]);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.startsWith('X: baseline is not green (exit 1, first failure: some test)')), JSON.stringify(v.problems));
  assert.ok(!runVerdict([{ ...base, wentRed: true, baseline: { exitCode: 0 } }]).problems.some((p) => p.includes('baseline')), 'a green baseline is not reported');
});

// ---- what the check sees, exactly (hardening follow-up to 79ca042; QA §3, CS1-CS10) -------------------
// Each case appends one infra/ read to the docs-only ADR test (as QA's attacks did), through a
// virtual reader, and runs the check for one docs-only control.
const ADR = 'test/unit/v21-public-target.test.mjs';
const HELPER = 'test/unit/cs-helper.mjs';
const caseProblems = (append, helper = null) => copySetProblems([{ id: 'P', extra: ['docs'], tests: [ADR] }], (f) => {
  if (f === ADR) return `${readFileSync(join(REPO, f), 'utf8')}\n${append}\n`;
  if (f === HELPER && helper !== null) return helper;
  return readFileSync(join(REPO, f), 'utf8');
});
// The plant snippets are assembled from pieces, so this file's own source never contains a call or an
// import the scanner would read (it scans this file too, for the controls that test it).
const call = (fn, arg) => `${fn}(${arg})`;
const TIER = "'infra/cloudflare'";
const helperImport = (q) => `import { x } ${'from'} ${q}./cs-helper.mjs${q};`;
const helperBody = `export const x = ${call('readdirSync', TIER)};\n`;
export const COPYSET_CAUGHT = [
  ['CS1', "a cwd-relative read, `readdirSync('infra/…')` (the e559653 shape)", `${call('readdirSync', TIER)};`],
  ['CS2', "`join(REPO, 'infra/…')`", `${call('readdirSync', call('join', `REPO, ${TIER}`))};`],
  ['CS9', 'a read in a test/ helper imported with single quotes', helperImport("'"), helperBody],
  ['CS8', 'a read in a test/ helper imported with double quotes', helperImport('"'), helperBody],
  ['CS4', 'a path held in a const string and passed to the call', `const tierPath = ${TIER};\n${call('readdirSync', 'tierPath')};`],
  ['CS5', 'a const path read after an `existsSync` guard on it (once a known limit, while guarded reads were exempt)', `const tierDir = ${call('join', `REPO, ${TIER}`)};\nif (${call('existsSync', 'tierDir')}) {}\n${call('readdirSync', 'tierDir')};`],
  ['CS11', 'a path held in a const string and read through a helper the file defines on one line (the I-1 inert controls)', `const tierFile = ${TIER};\nconst onDiskX = (f) => ${call('readFileSync', "join(REPO, f), 'utf8'")};\n${call('onDiskX', 'tierFile')};`],
];
export const COPYSET_LIMITS = [
  ['CS3', "a path built from pieces (`'in' + 'fra/…'`)", `${call('readdirSync', "'in' + 'fra/cloudflare'")};`],
  ['CS6', "`fs/promises` `readFile('infra/…')`", `await ${call('readFile', TIER)};`],
  ['CS7', "`new URL('../../infra/…', import.meta.url)`", `${call('readdirSync', `new URL('../../infra/cloudflare', import.meta.url)`)};`],
  ['CS10', "`statSync(resolve(REPO, 'infra/…'))`", `${call('statSync', call('resolve', `REPO, ${TIER}`))};`],
];
export const COPYSET_UNEXERCISED = [
  ['U1', 'a read made by a module outside test/ (src/, scripts/), even one a test imports: imports are followed only under test/.'],
];
export const COPYSET_CLAIMS = [
  ['K1', 'A top-level directory is seen only when named as a path (`infra/…` or `./infra/…`), and a top-level file only by its exact name, in single, double or back quotes.', () => {
    assert.ok(NAMED.get('infra').test(call('readdirSync', "'./infra/x'")) && !NAMED.get('infra').test(call('readdirSync', "'infra'")), 'a directory is a path');
  }],
  ['K2', `Such a literal is a read only as the first argument of one of: ${FS_CALLS.map((c) => `\`${c}(\``).join(', ')}; the test helpers ${HELPER_CALLS.map((c) => `\`${c}(\``).join(', ')}; a read helper the file defines (K8); or \`join(REPO, …)\`.`, () => {
    for (const c of [...FS_CALLS, ...HELPER_CALLS]) assert.ok(NAMED.get('infra').test(`${c}('infra/x')`), `${c}( is a read`);
    assert.ok(NAMED.get('infra').test(call('join', "REPO, 'infra/x'")), 'join(REPO, is a read');
  }],
  ['K3', 'Test modules are followed through every relative `.mjs` import the import graph\'s lexer reads (static, side-effect, re-export, a plain-string dynamic import, require), in single or double quotes, that resolves under test/. An import named inside a string, comment, template or regex is not followed.', () => {
    assert.ok(testSources('test/unit/red-controls-copy-set.test.mjs').has('test/helpers.mjs'), 'a test/ import is followed');
    const fake = (src) => (f) => (f === 'test/unit/k3.test.mjs' ? src : '');
    assert.ok(testSources('test/unit/k3.test.mjs', fake(`import { x } ${'from'} "./k3-helper.mjs";`)).has('test/unit/k3-helper.mjs'), 'a double-quoted import is followed');
    assert.ok(!testSources('test/unit/k3.test.mjs', fake(`const s = "import { x } ${'from'} './k3-helper.mjs'";`)).has('test/unit/k3-helper.mjs'), 'an import inside a string is not followed');
  }],
  ['K4', 'There is no optional read: a path read only inside an `if (existsSync(X))` guard is still a dependency.', () => {
    assert.equal(caseProblems(`const tierDir = ${call('join', `REPO, ${TIER}`)};\nif (${call('existsSync', 'tierDir')}) ${call('readdirSync', 'tierDir')};`).length, 1, 'a guarded read is a dependency');
  }],
  ['K5', `The caught cases (${COPYSET_CAUGHT.map(([id]) => id).join(', ')}) are reported.`, () => {
    for (const [id, , append, helper = null] of COPYSET_CAUGHT) assert.equal(caseProblems(append, helper).length, 1, `${id} is caught`);
  }],
  ['K6', `Each known limit (${COPYSET_LIMITS.map(([id]) => id).join(', ')}) is NOT reported, and is listed below as a known limit.`, () => {
    for (const [id, , append, helper = null] of COPYSET_LIMITS) assert.deepEqual(caseProblems(append, helper), [], `${id} is NOT caught: a known limit`);
  }],
  ['K8', `A function the file defines on one line (\`const f = (…) => …\` or \`function f(…) { … }\`) whose body calls one of ${FS_CALLS.map((c) => `\`${c}(\``).join(', ')} is a read call in that file, like the test helpers.`, () => {
    assert.deepEqual(localHelpers(`const onDiskX = (f) => ${call('readFileSync', 'f')};\nconst other = (f) => f;`), ['onDiskX']);
  }],
  ['K9', "A plain string constant (`const X = 'infra/…'`) passed as the first argument of a read call reads that path; a constant that is never passed to one is not a read.", () => {
    assert.equal(caseProblems(`const tierPath = ${TIER};\n${call('readdirSync', 'tierPath')};`).length, 1, 'a constant passed to a read');
    assert.deepEqual(caseProblems(`const tierPath = ${TIER};\nconsole.log(tierPath);`), [], 'a constant that is only mentioned');
  }],
  ['K7', 'The backstop: a control whose copy lacks what its tests read has a red baseline, and the harness verdict names it ("baseline is not green"), in any run that includes the control.', () => {
    const v = runVerdict([{ id: 'X', wentRed: false, broken: { exitCode: 1 }, intendedFailed: [], warnings: [], baseline: { exitCode: 1, firstFailure: 't' } }]);
    assert.ok(v.problems.some((p) => p.startsWith('X: baseline is not green')), 'the verdict names a red baseline');
  }],
];
const renderClaims = (rows) => rows.map(([id, text]) => `- (${id}) ${text}`).join('\n');

test('[H-2] the copy-set check claims exactly what it sees: docs/operations/red-controls-copy-set.md enumerates its rules, its exercised limits and its backstop', () => {
  const doc = readFileSync(join(REPO, 'docs/operations/red-controls-copy-set.md'), 'utf8');
  const list = (heading) => { const i = doc.indexOf(heading); assert.ok(i >= 0, `the doc has ${heading}`); const body = doc.slice(i + heading.length).replace(/^\n+/, ''); const end = body.search(/\n\n(?!- )/); return (end < 0 ? body : body.slice(0, end)).trim(); };
  assert.equal(list('## What the check sees (rendered from `COPYSET_CLAIMS`)'), renderClaims(COPYSET_CLAIMS));
  assert.equal(list('## Known limits, exercised and not caught (rendered from `COPYSET_LIMITS`)'), renderClaims(COPYSET_LIMITS));
  assert.equal(list('## Not seen and not exercised (rendered from `COPYSET_UNEXERCISED`)'), renderClaims(COPYSET_UNEXERCISED));
  for (const [, , run] of COPYSET_CLAIMS) run();
});

// AP.8 integration (lead 17:27Z): four controls once had no infra/ in their copy, so their baselines
// were red and their "red" proved nothing. Their test read an infra/ file through a path constant and
// a helper of its own; the check saw neither (CS4). Both shapes are caught now.
test('[H-8.I1] the copy-set check sees a path read through a constant or a helper the test file defines', () => {
  assert.equal(caseProblems(`const tierPath = ${TIER};\n${call('readdirSync', 'tierPath')};`).length, 1, 'a constant passed to a read call');
  assert.equal(caseProblems(`const tierFile = ${TIER};\nconst onDiskX = (f) => ${call('readFileSync', "join(REPO, f), 'utf8'")};\n${call('onDiskX', 'tierFile')};`).length, 1, 'a constant read through the file\'s own helper');
});
