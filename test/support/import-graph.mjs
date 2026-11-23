// The import graph of the test tree, for the test-imports guard (QA notes on 3a983df, T1–T3).
// A small JavaScript lexer (no parser is installed and none may be fetched) skips comments, string
// literals, template text and regular-expression literals, so an import named inside text is never
// an edge, and an import written as code always is. From the tokens it reads:
//   static      import … from 'x'          side-effect  import 'x'
//   re-export   export … from 'x'          dynamic      import('x')   (a plain string literal only)
//   require     require('x')
// A dynamic import whose specifier is anything but a plain string literal (a template literal, a
// variable, a concatenation) is reported as NON-LITERAL: its target cannot be known statically.
// Cycle 4 (QA on a8f5296): a static import after a line with no semicolon (ASI) is a statement start;
// string literals are DECODED (\xHH, \uHHHH, \u{…}, single-character escapes, line continuations)
// before a specifier is resolved; a require made through a createRequire alias (`const r =
// createRequire(…); r('…')`) is an edge, and a non-literal argument to it is NON-LITERAL.
// AP.8 (2026-10-05): a require is read wherever its call stands, not only as a statement: assigned
// (`const x = r('…')`), as an argument, chained, or called on createRequire's result at once
// (`createRequire(…)('…')`). createRequire under another name (`createRequire as c`, `{ createRequire:
// c }`), and an alias of an alias (`const r2 = r`), are followed. What cannot be followed is REPORTED
// as NON-LITERAL with what it is, never skipped: a computed argument, a require function passed on
// as a value or called through call/apply/bind, and a createRequire result that is not bound to a
// name. QA LX-1 (2026-10-05): require itself goes through the same rules as an alias: require?.(x)
// is an edge; (require)(x), (0, require)(x), require.call/apply/bind and require passed on (for
// example to Reflect.apply) are reported; require.resolve, require.cache and typeof require pass.
// RESIDUAL: a name built at run time (`module['create' + 'Require']`) is not seen by any lexer.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
// The value of a string literal's body (between its quotes), as JavaScript decodes it.
export function decodeString(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const d = body[i + 1];
    if (d === 'x') { out += String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16)); i += 3; continue; }
    if (d === 'u' && body[i + 2] === '{') { const end = body.indexOf('}', i + 3); out += String.fromCodePoint(parseInt(body.slice(i + 3, end), 16)); i = end; continue; }
    if (d === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16)); i += 5; continue; }
    if (d === '\r' && body[i + 2] === '\n') { i += 2; continue; }
    if (d === '\n' || d === '\r' || d === '\u2028' || d === '\u2029') { i += 1; continue; }
    out += SIMPLE_ESCAPES[d] ?? d;
    i += 1;
  }
  return out;
}

const KEYWORDS_BEFORE_REGEX = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

export function tokenize(src) {
  const toks = [];
  let nl = false; // a line break since the last token (for ASI)
  const push = (tok) => { toks.push({ ...tok, nl }); nl = false; };
  const templateDepths = []; // brace depth at each open ${
  let depth = 0;
  let i = 0;
  const n = src.length;
  const regexAllowed = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.type === 'punct') return !/^[)\]}]$/.test(t.value);
    if (t.type === 'name') return KEYWORDS_BEFORE_REGEX.test(t.value);
    return false;
  };
  // Template text from i (just after ` or a closing }) to the closing ` or the next ${.
  const templateText = (start) => {
    let j = start;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { push({ type: 'template', pos: start }); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { push({ type: 'template', pos: start }); templateDepths.push(depth); return j + 2; }
      j += 1;
    }
    push({ type: 'template', pos: start });
    return n;
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') nl = true; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (src.slice(i, e < 0 ? n : e).includes('\n')) nl = true; i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      push({ type: 'string', value: decodeString(src.slice(i + 1, j)), pos: i });
      i = j + 1;
      continue;
    }
    if (c === '`') { i = templateText(i + 1); continue; }
    if (c === '}' && templateDepths.length && templateDepths[templateDepths.length - 1] === depth) { templateDepths.pop(); i = templateText(i + 1); continue; }
    if (c === '{') { depth += 1; push({ type: 'punct', value: c, pos: i }); i += 1; continue; }
    if (c === '}') { depth -= 1; push({ type: 'punct', value: c, pos: i }); i += 1; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(src[j])) j += 1;
      push({ type: 'regex', pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j += 1; push({ type: 'name', value: src.slice(i, j), pos: i }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < n && /[\w.]/.test(src[j])) j += 1; push({ type: 'num', pos: i }); i = j; continue; }
    push({ type: 'punct', value: c, pos: i });
    i += 1;
  }
  return toks;
}

const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;
const isPunct = (t, v) => t?.type === 'punct' && t.value === v;

export function importsOf(src) {
  const t = tokenize(src);
  const edges = [];
  const nonLiteral = [];
  // Names bound to createRequire(…): `const r = createRequire(…)` or `= module.createRequire(…)`.
  const requireAliases = new Set(['require']);
  // createRequire's own names in this file: itself, `createRequire as c` and `{ createRequire: c }`.
  const creators = new Set(['createRequire']);
  for (let k = 0; k + 2 < t.length; k += 1) {
    if (t[k].type === 'name' && t[k].value === 'createRequire' && t[k + 2]?.type === 'name' && ((t[k + 1].type === 'name' && t[k + 1].value === 'as') || isPunct(t[k + 1], ':'))) creators.add(t[k + 2].value);
  }
  // The index of the ) that closes the ( at `open`, or -1.
  const closing = (open) => {
    let depth = 0;
    for (let m = open; m < t.length; m += 1) {
      if (isPunct(t[m], '(')) depth += 1;
      else if (isPunct(t[m], ')')) { depth -= 1; if (depth === 0) return m; }
    }
    return -1;
  };
  // Token indexes that are a definition, not a use: an alias being bound, and the createRequire call that binds it.
  const defined = new Set();
  for (let pass = 0, grew = true; grew && pass < 20; pass += 1) {
    grew = false;
    for (let k = 0; k + 2 < t.length; k += 1) {
      if (t[k].type !== 'name' || !isPunct(t[k + 1], '=') || isPunct(t[k + 2], '=') || isPunct(t[k + 2], '>') || isPunct(t[k - 1], '.')) continue;
      let m = k + 2;
      if (t[m]?.type === 'name' && isPunct(t[m + 1], '.') && t[m + 2]?.type === 'name' && creators.has(t[m + 2].value)) m += 2;
      const end = t[m]?.type === 'name' && creators.has(t[m].value) && isPunct(t[m + 1], '(') ? closing(m + 1) : -1;
      const bindsCreator = end > 0 && !isPunct(t[end + 1], '(');
      // `const r2 = r`: another name for a require function already known.
      // Only a plain `name = r` that ends there: `x = require?.(…)` or `x = r ? … : …` is a use, not a new name.
      const ends = (n) => !n || isPunct(n, ';') || isPunct(n, ',') || isPunct(n, ')') || isPunct(n, '}') || n.nl;
      const bindsAlias = t[m]?.type === 'name' && m === k + 2 && requireAliases.has(t[m].value) && ends(t[m + 1]);
      if (!bindsCreator && !bindsAlias) continue;
      if (!defined.has(k)) { defined.add(k); defined.add(m); grew = true; }
      if (!requireAliases.has(t[k].value)) { requireAliases.add(t[k].value); grew = true; }
    }
  }
  const unfollowed = (pos, what) => nonLiteral.push({ line: lineOf(src, pos), what });
  // A call of a require function at token k (the name) with its ( at `open`.
  const requireCall = (pos, open) => {
    const arg = t[open + 1];
    if (arg?.type === 'string' && isPunct(t[open + 2], ')')) edges.push({ spec: arg.value, kind: 'require', line: lineOf(src, pos) });
    else unfollowed(pos, 'a require whose argument is not a plain string literal');
  };
  for (let k = 0; k < t.length; k += 1) {
    const x = t[k];
    if (x.type === 'name' && creators.has(x.value)) {
      // createRequire, wherever it stands (also after a dot: module.createRequire).
      const after = t[k + 1];
      if (isPunct(after, '(')) {
        const end = closing(k + 1);
        if (end > 0 && isPunct(t[end + 1], '(')) requireCall(x.pos, end + 1);
        else if (!defined.has(k)) unfollowed(x.pos, 'a createRequire result that is not bound to a name, so its calls cannot be followed');
      } else {
        const before = t[k - 1];
        const declared = (isPunct(before, '{') || isPunct(before, ',') || isPunct(before, ':') || (before?.type === 'name' && before.value === 'as'))
          && (isPunct(after, '}') || isPunct(after, ',') || isPunct(after, ':') || (after?.type === 'name' && after.value === 'as'));
        if (!declared) unfollowed(x.pos, 'createRequire passed on as a value, so what it loads cannot be followed');
      }
      continue;
    }
    if (x.type === 'name' && requireAliases.has(x.value) && !defined.has(k) && (x.value === 'require' || !isPunct(t[k - 1], '.'))) {
      // Every require function, require itself included (QA LX-1): a call is an edge; anything that
      // could call it unseen is reported; a read that loads nothing passes.
      const after = t[k + 1];
      const before = t[k - 1];
      if (isPunct(after, '(')) { requireCall(x.pos, k + 1); continue; }
      // require?.('x'): an optional call is a call.
      if (isPunct(after, '?') && isPunct(t[k + 2], '.') && isPunct(t[k + 3], '(')) { requireCall(x.pos, k + 3); continue; }
      // obj.require is another object's property, not the loader.
      if (isPunct(before, '.')) continue;
      if (isPunct(after, '.')) {
        // require.resolve and require.cache load nothing; call, apply and bind run the loader unseen.
        if (['call', 'apply', 'bind'].includes(t[k + 2]?.value)) unfollowed(x.pos, 'a require function called through call, apply or bind');
        continue;
      }
      // (require)('x') and (0, require)('x'): held in parentheses or a comma expression and called.
      if ((isPunct(before, '(') || isPunct(before, ',')) && isPunct(after, ')') && isPunct(t[k + 2], '(')) { unfollowed(x.pos, 'a require held in parentheses or a comma expression and called'); continue; }
      // Assigned to, an object key, or typeof: no load.
      if (isPunct(after, '=') || isPunct(after, ':') || (before?.type === 'name' && before.value === 'typeof')) continue;
      // Anything else hands the loader on (Reflect.apply(require, ...), [require], f(require)).
      unfollowed(x.pos, 'a require function passed on as a value');
      continue;
    }
    if (x.type !== 'name' || isPunct(t[k - 1], '.')) continue;
    const next = t[k + 1];
    if (x.value === 'import') {
      if (isPunct(next, '(')) {
        const arg = t[k + 2];
        if (arg?.type === 'string' && (isPunct(t[k + 3], ')') || isPunct(t[k + 3], ','))) edges.push({ spec: arg.value, kind: 'dynamic', line: lineOf(src, x.pos) });
        else nonLiteral.push({ line: lineOf(src, x.pos) });
        continue;
      }
      if (isPunct(next, '.')) continue; // import.meta
      if (next?.type === 'string') { edges.push({ spec: next.value, kind: 'side-effect', line: lineOf(src, x.pos) }); continue; }
      const prev = t[k - 1];
      if (prev && !isPunct(prev, ';') && !isPunct(prev, '}') && !x.nl) continue; // not a statement start (ASI: a line break counts)
      for (let m = k + 1; m < t.length; m += 1) {
        if (t[m].type === 'name' && t[m].value === 'from' && t[m + 1]?.type === 'string') { edges.push({ spec: t[m + 1].value, kind: 'static', line: lineOf(src, x.pos) }); break; }
        if (isPunct(t[m], ';') || t[m].type === 'string') break;
      }
    } else if (x.value === 'export') {
      for (let m = k + 1; m < t.length; m += 1) {
        const y = t[m];
        if (y.type === 'name' && y.value === 'from' && t[m + 1]?.type === 'string') { edges.push({ spec: t[m + 1].value, kind: 're-export', line: lineOf(src, x.pos) }); break; }
        if (isPunct(y, ';') || isPunct(y, '=') || isPunct(y, '(') || y.type === 'string') break;
        if (y.type === 'name' && /^(function|class|const|let|var|default|async)$/.test(y.value)) break;
      }
    }
  }
  return { edges, nonLiteral };
}

function resolveSpec(from, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // node:, packages
  const base = resolve(dirname(from), spec.split('?')[0]);
  for (const p of [base, `${base}.mjs`, `${base}.js`]) if (existsSync(p) && statSync(p).isFile()) return p;
  return null;
}

export function mjsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : mjsFiles(p);
    return /\.(mjs|js)$/.test(e.name) ? [p] : [];
  });
}

// Problems over a repository's test tree:
//   - a test file that reaches another *.test.mjs through ANY chain of relative imports (direct, a
//     helper relay, a re-export, a literal dynamic import or a require);
//   - a dynamic import under test/ whose specifier is not a plain string literal, unless its file is
//     in `allowNonLiteral` with a reason of at least 20 characters.
export function testImportProblems(repo, { allowNonLiteral = {} } = {}) {
  const problems = [];
  const testDir = join(repo, 'test');
  const files = mjsFiles(testDir);
  const cache = new Map();
  const parsed = (f) => { if (!cache.has(f)) cache.set(f, importsOf(readFileSync(f, 'utf8'))); return cache.get(f); };
  for (const start of files.filter((f) => f.endsWith('.test.mjs'))) {
    const seen = new Set([start]);
    const queue = [[start, [relative(repo, start)]]];
    while (queue.length) {
      const [f, chain] = queue.shift();
      for (const e of parsed(f).edges) {
        const to = resolveSpec(f, e.spec);
        if (!to || seen.has(to) || !to.startsWith(repo)) continue;
        seen.add(to);
        const path = [...chain, `${relative(repo, to)} (${e.kind}, line ${e.line})`];
        if (to.endsWith('.test.mjs')) problems.push(`${path.join(' -> ')}: a test file reaches another test file`);
        else queue.push([to, path]);
      }
    }
  }
  for (const [file, reason] of Object.entries(allowNonLiteral)) if (typeof reason !== 'string' || reason.trim().length < 20) problems.push(`${file}: an allowlisted non-literal import needs a reason`);
  for (const f of files) {
    const rel = relative(repo, f);
    for (const d of parsed(f).nonLiteral) if (!allowNonLiteral[rel]) problems.push(`${rel}:${d.line}: ${d.what ?? 'a dynamic import whose specifier is not a plain string literal'}`);
  }
  return problems;
}
