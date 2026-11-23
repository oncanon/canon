// No test file reaches another test file. Importing a node:test module re-runs its top-level test()
// registrations in the importer's process, so its tests are registered twice and the engine
// comparator (scripts/compare-engines.mjs) refuses the duplicate names: that failed the supervised
// run on aws-design 5eb66fe. The guard walks the whole import graph (test/support/import-graph.mjs):
// direct imports (T1), relays through helper modules and re-exports (T2), and literal dynamic
// imports; a dynamic import whose specifier is not a plain string literal (T3) is refused unless
// allowlisted below with a reason (QA notes on 3a983df).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { testImportProblems } from '../support/import-graph.mjs';
import { REPO } from '../helpers.mjs';

// Files under test/ allowed a non-literal dynamic import, each with its reason. None today.
export const ALLOW_NON_LITERAL = {};

test('[H-7.4] no test file imports another test file (an imported node:test module registers its tests twice)', () => {
  assert.deepEqual(testImportProblems(REPO, { allowNonLiteral: ALLOW_NON_LITERAL }), []);
});

test('[H-7.4] the import guard refuses a direct import (T1), a helper relay or re-export (T2) a non-literal dynamic import (T3), an import after ASI, a createRequire alias and an escaped specifier, and ignores imports named in comments, strings, templates and regexes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'canon-imports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (p, src) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), src); };
  const EXT = ['.test', '.mjs'].join(''); // assembled, so this file's own source names no test import
  write(`test/unit/b${EXT}`, "import test from 'node:test';\ntest('b', () => {});\n");
  const clean = testImportProblems(root);
  assert.deepEqual(clean, [], 'a lone test file is clean');
  const cases = [
    ['T1 a direct import', `test/unit/t1${EXT}`, `import { x } from './b${EXT}';\n`, /t1\.test\.mjs -> test\/unit\/b\.test\.mjs \(static, line 1\): a test file reaches another test file/],
    ['T2 a helper relay (re-export)', `test/unit/t2${EXT}`, "import { x } from '../support/relay.mjs';\n", /t2\.test\.mjs -> test\/support\/relay\.mjs \(static, line 1\) -> test\/unit\/b\.test\.mjs \(re-export, line 1\)/],
    ['T2 a helper relay (import)', `test/unit/t2b${EXT}`, "import '../support/relay2.mjs';\n", /t2b\.test\.mjs -> test\/support\/relay2\.mjs \(side-effect, line 1\) -> test\/unit\/b\.test\.mjs \(static, line 1\)/],
    ['a literal dynamic import', `test/unit/t4${EXT}`, `const m = await import('./b${EXT}');\n`, /t4\.test\.mjs -> test\/unit\/b\.test\.mjs \(dynamic, line 1\)/],
    ['T3 a template-literal dynamic import', `test/unit/t3${EXT}`, 'const m = await import(`./b' + EXT + '`);\n', /test\/unit\/t3\.test\.mjs:1: a dynamic import whose specifier is not a plain string literal/],
    ['ASI: a static import after a line with no semicolon', `test/unit/t6${EXT}`, `const a = 1\nimport { x } from './b${EXT}'\n`, /t6\.test\.mjs -> test\/unit\/b\.test\.mjs \(static, line 2\)/],
    ['a createRequire alias', `test/unit/t7${EXT}`, `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('./b${EXT}');\n`, /t7\.test\.mjs -> test\/unit\/b\.test\.mjs \(require, line 3\)/],
    ['a createRequire alias with a computed argument', `test/unit/t8${EXT}`, "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst n = 'b';\nload('./' + n);\n", /test\/unit\/t8\.test\.mjs:4: a require whose argument is not a plain string literal/],
    ['a hex-escaped specifier', `test/unit/t9${EXT}`, "import './b\\x2etest\\x2emjs';\n", /t9\.test\.mjs -> test\/unit\/b\.test\.mjs \(side-effect, line 1\)/],
    ['a unicode-escaped specifier', `test/unit/t10${EXT}`, "import './b\\u{2e}test\\u002emjs';\n", /t10\.test\.mjs -> test\/unit\/b\.test\.mjs \(side-effect, line 1\)/],
    ['a computed dynamic import', `test/unit/t5${EXT}`, "const name = 'b';\nconst m = await import('./' + name);\n", /test\/unit\/t5\.test\.mjs:2: a dynamic import whose specifier is not a plain string literal/],
  ];
  write('test/support/relay.mjs', `export * from '../unit/b${EXT}';\n`);
  write('test/support/relay2.mjs', `import { x } from '../unit/b${EXT}';\n`);
  for (const [name, file, src, expected] of cases) {
    write(file, src);
    const problems = testImportProblems(root);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: expected ${expected}, got ${JSON.stringify(problems)}`);
    rmSync(join(root, file));
  }
  write(`test/unit/decoys${EXT}`, [
    `// import { x } from './b${EXT}';`,
    `/* await import('./b${EXT}') */`,
    `const s = "import { x } from './b${EXT}'";`,
    `const t = \`await import('./b${EXT}') \${1 + 1}\`;`,
    'const r = /import(x)/g;',
    '',
  ].join('\n'));
  assert.deepEqual(testImportProblems(root), [], 'imports named in comments, strings, templates and regexes are not imports');
  write(`test/unit/t3${EXT}`, 'const m = await import(`./b' + EXT + '`);\n');
  assert.deepEqual(testImportProblems(root, { allowNonLiteral: { [`test/unit/t3${EXT}`]: 'a reviewed fixture that must name its module at run time' } }), [], 'an allowlisted non-literal import with a reason passes');
  assert.ok(testImportProblems(root, { allowNonLiteral: { [`test/unit/t3${EXT}`]: 'ok' } }).some((p) => /needs a reason/.test(p)), 'an allowlist entry without a real reason is refused');
});

test('[H-7.4] the import guard reads a require wherever its call stands, follows createRequire under another name and an alias of an alias, and reports what it cannot follow instead of skipping it', (t) => {
  // Found 2026-10-05: `const x = load('./b…')` gave no edge (only a require standing as a statement
  // did), so a test could reach another test file, and every derived control set built on this
  // lexer could miss a helper, through an assigned require. Every case is run and the failures are
  // compared at the end, so one run names each case that fails.
  const root = mkdtempSync(join(tmpdir(), 'canon-imports-require-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (p, src) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), src); };
  const EXT = ['.test', '.mjs'].join(''); // assembled, so this file's own source names no test import
  const B = `./b${EXT}`;
  write(`test/unit/b${EXT}`, "import test from 'node:test';\ntest('b', () => {});\n");
  const MAKE = "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\n";
  const reaches = (line) => new RegExp(`case\\.test\\.mjs -> test/unit/b\\.test\\.mjs \\(require, line ${line}\\)`);
  const refuses = (line, what) => new RegExp(`^test/unit/case\\.test\\.mjs:${line}: ${what}$`);
  const CLEAN = null;
  const cases = [
    // Read as an edge.
    ['a require standing as a statement (read before too: the control)', `${MAKE}load('${B}');\n`, reaches(3)],
    ['a require whose value is assigned', `${MAKE}const x = load('${B}');\n`, reaches(3)],
    ['a bare require whose value is assigned', `const x = require('${B}');\n`, reaches(1)],
    ['a require whose value is used at once', `${MAKE}const x = load('${B}').default;\n`, reaches(3)],
    ['a require as an argument', `${MAKE}console.log(1, load('${B}'));\n`, reaches(3)],
    ['createRequire called and its result called at once', `import { createRequire } from 'node:module';\nconst x = createRequire(import.meta.url)('${B}');\n`, reaches(2)],
    ['createRequire reached through the module namespace', `import * as m from 'node:module';\nm.createRequire(import.meta.url)('${B}');\n`, reaches(2)],
    ['createRequire imported under another name', `import { createRequire as make } from 'node:module';\nconst load = make(import.meta.url);\nconst x = load('${B}');\n`, reaches(3)],
    ['createRequire destructured under another name', `const { createRequire: make } = await import('node:module');\nconst load = make(import.meta.url);\nload('${B}');\n`, reaches(3)],
    ['an alias of an alias', `${MAKE}const again = load;\nconst x = again('${B}');\n`, reaches(4)],
    // Reported, never skipped.
    ['a computed argument whose value is assigned', `${MAKE}const n = 'b';\nconst x = load('./' + n);\n`, refuses(4, 'a require whose argument is not a plain string literal')],
    ['a bare require of a literal joined to something', `const ext = '.mjs';\nconst x = require('./b.test' + ext);\n`, refuses(2, 'a require whose argument is not a plain string literal')],
    ['a require function passed on as a value', `${MAKE}const use = (f) => f('${B}');\nuse(load);\n`, refuses(4, 'a require function passed on as a value')],
    ['a require function called through call', `${MAKE}load.call(null, '${B}');\n`, refuses(3, 'a require function called through call, apply or bind')],
    ['a createRequire result that is not bound to a name', `import { createRequire } from 'node:module';\nconst use = (f) => f('${B}');\nuse(createRequire(import.meta.url));\n`, refuses(3, 'a createRequire result that is not bound to a name, so its calls cannot be followed')],
    ['createRequire itself passed on as a value', `import { createRequire } from 'node:module';\nconst make = [createRequire][0];\nmake(import.meta.url)('${B}');\n`, refuses(2, 'createRequire passed on as a value, so what it loads cannot be followed')],
    // QA LX-1 on 6266f23: require itself, called in ways that are not a plain call.
    ['an optional call of require', `const x = require?.('${B}');\n`, reaches(1)],
    ['require held in parentheses and called', `const x = (require)('${B}');\n`, refuses(1, 'a require held in parentheses or a comma expression and called')],
    ['require held in a comma expression and called', `const x = (0, require)('${B}');\n`, refuses(1, 'a require held in parentheses or a comma expression and called')],
    ['require called through call', `const x = require.call(null, '${B}');\n`, refuses(1, 'a require function called through call, apply or bind')],
    ['require called through apply', `const x = require.apply(null, ['${B}']);\n`, refuses(1, 'a require function called through call, apply or bind')],
    ['require handed to Reflect.apply', `const x = Reflect.apply(require, null, ['${B}']);\n`, refuses(1, 'a require function passed on as a value')],
    // Not a load: nothing is reported (controls).
    ['require.resolve and require.cache load nothing', "const where = require.resolve('node:fs');\nconst c = require.cache;\n", CLEAN],
    ['typeof require and a key named require load nothing', "const has = typeof require === 'function';\nconst o = { require: 1 };\nconst p = o.require;\n", CLEAN],
    ['resolve on a require function loads nothing', `${MAKE}const where = load.resolve('node:fs');\n`, CLEAN],
    ['createRequire imported and never used', "import { createRequire } from 'node:module';\n", CLEAN],
    ['the words in a comment and a string', `// const x = load('${B}');\nconst s = "createRequire(import.meta.url)('${B}')";\n`, CLEAN],
  ];
  const failed = {};
  for (const [name, src, expected] of cases) {
    write(`test/unit/case${EXT}`, src);
    const problems = testImportProblems(root);
    const ok = expected === CLEAN ? problems.length === 0 : problems.some((p) => expected.test(p));
    if (!ok) failed[name] = `wanted ${expected === CLEAN ? 'no problem' : expected}, got ${JSON.stringify(problems)}`;
    rmSync(join(root, `test/unit/case${EXT}`));
  }
  assert.deepEqual(failed, {}, 'every case, each named with what the guard said');
});
