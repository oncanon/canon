// A small structural scanner for HCL native syntax (the Terraform/OpenTofu language), so
// the IaC gate (test/unit/pv-iac-allowlist.test.mjs) judges what Terraform would read, not
// what a line-oriented regex happens to see (V2-QA-6). No dependency, no download.
//
// It tokenizes # and // line comments, /* */ block comments, quoted strings with escapes
// and ${ } / %{ } templates (which may nest strings and braces), heredocs (<<EOT and
// <<-EOT), numbers, identifiers and operators, then parses bodies into every block at every
// depth, as { path, type, labels, line }, and every attribute at every depth, as
// { path, name, text, value, line }. Object constructors inside attribute values are
// descended too: their keys are reported as attributes (path "…/attr" and name "key"), so a
// nested `mode = "disabled"` or a binding's `text = …` is visible to the allowlist.
//
// Anything it cannot parse throws HclParseError: the gate fails closed on input it does not
// understand, and never passes it.
export class HclParseError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'HclParseError';
    this.line = line;
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '=>', '...', '{', '}', '[', ']', '(', ')', '=', ',', ':', '?', '.', '!', '+', '-', '*', '/', '%', '<', '>'];

// Scan a template body ("…${ … }…") starting after its opening quote; returns the index
// just past the closing quote. Interpolations may contain nested strings and braces.
function scanQuoted(src, i, line) {
  const start = line.n;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (i + 1 >= src.length) break;
      if (src[i + 1] === '\n') throw new HclParseError('newline in a quoted string', line.n);
      i += 2;
      continue;
    }
    if (c === '\n') throw new HclParseError('newline in a quoted string', line.n);
    if (c === '"') return i + 1;
    if ((c === '$' || c === '%') && src[i + 1] === c && src[i + 2] === '{') {
      i += 3; // $${ and %%{ are literal
      continue;
    }
    if ((c === '$' || c === '%') && src[i + 1] === '{') {
      i = scanInterpolation(src, i + 2, line);
      continue;
    }
    i += 1;
  }
  throw new HclParseError('unterminated string', start);
}

// Inside ${ … }: an expression, which may contain strings (with their own templates),
// heredocs and balanced brackets. Returns the index just past the matching '}'.
function scanInterpolation(src, i, line) {
  let depth = 0;
  const start = line.n;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = scanQuoted(src, i + 1, line);
      continue;
    }
    if (c === '\n') line.n += 1;
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === '}') {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
    i += 1;
  }
  throw new HclParseError('unterminated template interpolation', start);
}

export function tokenize(src) {
  const tokens = [];
  const line = { n: 1 };
  let i = 0;
  const push = (type, value, text) => tokens.push({ type, value, text: text ?? value, line: line.n });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      push('NEWLINE', '\n');
      line.n += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue; // the newline that ends a line comment is still a token
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new HclParseError('unterminated block comment', line.n);
      const body = src.slice(i, end + 2);
      const newlines = (body.match(/\n/g) ?? []).length;
      line.n += newlines;
      // A block comment spanning lines separates items like a newline does.
      if (newlines) push('NEWLINE', '\n');
      i = end + 2;
      continue;
    }
    if (c === '"') {
      const startLine = line.n;
      const end = scanQuoted(src, i + 1, line);
      tokens.push({ type: 'STRING', value: src.slice(i + 1, end - 1), text: src.slice(i, end), line: startLine });
      i = end;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && /[-A-Za-z_]/.test(src[i + 2] ?? '')) {
      const m = src.slice(i).match(/^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\n/);
      if (!m) throw new HclParseError('malformed heredoc opener', line.n);
      const marker = m[2];
      const startLine = line.n;
      let j = i + m[0].length;
      line.n += 1;
      let closed = false;
      while (j <= src.length) {
        const nl = src.indexOf('\n', j);
        const lineText = src.slice(j, nl < 0 ? src.length : nl);
        if (lineText.trim() === marker) {
          j += lineText.length;
          closed = true;
          break;
        }
        if (nl < 0) break;
        j = nl + 1;
        line.n += 1;
      }
      if (!closed) throw new HclParseError(`unterminated heredoc ${marker}`, startLine);
      tokens.push({ type: 'HEREDOC', value: src.slice(i + m[0].length, j - marker.length), text: src.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = src.slice(i).match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/);
      push('NUMBER', m[0]);
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      push('IDENT', src.slice(i, j));
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new HclParseError(`unexpected character ${JSON.stringify(c)}`, line.n);
    push('PUNCT', op);
    i += op.length;
  }
  push('EOF', '');
  return tokens;
}

const OPEN = { '{': '}', '[': ']', '(': ')' };

// Parse a whole file into { blocks, attributes }.
export function scanHcl(src) {
  const tokens = tokenize(src);
  let p = 0;
  const blocks = [];
  const attributes = [];
  const peek = () => tokens[p];
  const skipNewlines = () => {
    while (peek().type === 'NEWLINE') p += 1;
  };

  // Collect an expression's tokens up to a NEWLINE, ',' or closer at depth 0.
  function expressionTokens(stopAtComma) {
    const out = [];
    const stack = [];
    for (;;) {
      const t = peek();
      if (t.type === 'EOF') {
        if (stack.length) throw new HclParseError('unbalanced brackets in an expression', t.line);
        break;
      }
      if (!stack.length && (t.type === 'NEWLINE' || (t.type === 'PUNCT' && ['}', ']', ')'].includes(t.value)) || (stopAtComma && t.type === 'PUNCT' && t.value === ','))) break;
      // A bare '=' outside brackets can only begin a second attribute on this line.
      if (!stack.length && t.type === 'PUNCT' && t.value === '=') throw new HclParseError('unexpected "=" in an expression', t.line);
      if (t.type === 'PUNCT' && OPEN[t.value]) stack.push(OPEN[t.value]);
      else if (t.type === 'PUNCT' && ['}', ']', ')'].includes(t.value)) {
        if (stack.pop() !== t.value) throw new HclParseError(`mismatched ${t.value}`, t.line);
      }
      out.push(t);
      p += 1;
    }
    if (!out.length) throw new HclParseError('missing expression', peek().line);
    return out;
  }

  // Canonical expression text, built token by token so string contents are never altered:
  // no space around '.', none inside brackets, one after ','.
  function text(ts) {
    let out = '';
    let prev = null;
    for (const t of ts) {
      if (t.type === 'NEWLINE') continue;
      const tight = prev && ((t.type === 'PUNCT' && ['.', ',', ')', ']'].includes(t.value)) || (prev.type === 'PUNCT' && ['.', '(', '['].includes(prev.value)) || (t.type === 'PUNCT' && t.value === '(' && prev.type === 'IDENT'));
      out += (prev && !tight ? ' ' : '') + t.text;
      prev = t;
    }
    return out;
  }

  // A structural view of an expression: tuple and object constructors are descended;
  // everything else is { kind: 'raw', text, refs } with its variable/resource traversals.
  function structure(ts) {
    const first = ts[0];
    const last = ts[ts.length - 1];
    const wrapped = first.type === 'PUNCT' && OPEN[first.value] && last.type === 'PUNCT' && last.value === OPEN[first.value] && closesAt(ts, 0) === ts.length - 1;
    if (wrapped && first.value === '[' && !(ts[1]?.type === 'IDENT' && ts[1].value === 'for')) {
      return { kind: 'tuple', items: splitItems(ts.slice(1, -1)).map(structure) };
    }
    if (wrapped && first.value === '{' && !(ts[1]?.type === 'IDENT' && ts[1].value === 'for')) {
      const items = [];
      for (const it of splitItems(ts.slice(1, -1))) {
        const k = it[0];
        const sep = it[1];
        if (!k || !sep || sep.type !== 'PUNCT' || (sep.value !== '=' && sep.value !== ':')) throw new HclParseError('malformed object item', (k ?? first).line);
        if (k.type !== 'IDENT' && k.type !== 'STRING') throw new HclParseError('unsupported object key expression', k.line);
        items.push({ key: k.type === 'STRING' ? k.value : k.value, line: k.line, value: structure(it.slice(2)), text: text(it.slice(2)) });
      }
      return { kind: 'object', items };
    }
    const refs = [];
    for (let k = 0; k < ts.length; k += 1) {
      if (ts[k].type === 'IDENT' && ts[k + 1]?.value === '.' && ts[k + 2]?.type === 'IDENT' && ts[k - 1]?.value !== '.') refs.push(`${ts[k].value}.${ts[k + 2].value}`);
      // References inside string and heredoc templates count too ("${var.x}").
      if (ts[k].type === 'STRING' || ts[k].type === 'HEREDOC') {
        for (const seg of ts[k].value.matchAll(/(?<![$%])[$%]\{([^}]*)\}/g)) for (const m of seg[1].matchAll(/\b([A-Za-z_][\w-]*)\s*\.\s*([A-Za-z_][\w-]*)/g)) refs.push(`${m[1]}.${m[2]}`);
      }
    }
    const literal = ts.length === 1 && ['STRING', 'NUMBER', 'IDENT', 'HEREDOC'].includes(first.type) ? (first.type === 'STRING' || first.type === 'HEREDOC' ? first.value : first.type === 'NUMBER' ? Number(first.value) : first.value === 'true' ? true : first.value === 'false' ? false : first.value === 'null' ? null : undefined) : undefined;
    return { kind: 'raw', text: text(ts), refs, literal, strings: ts.filter((t) => t.type === 'STRING' || t.type === 'HEREDOC').map((t) => t.value) };
  }
  function closesAt(ts, open) {
    let depth = 0;
    for (let k = open; k < ts.length; k += 1) {
      if (ts[k].type !== 'PUNCT') continue;
      if (OPEN[ts[k].value]) depth += 1;
      else if (['}', ']', ')'].includes(ts[k].value)) {
        depth -= 1;
        if (depth === 0) return k;
      }
    }
    return -1;
  }
  // Items of a tuple/object body, separated by ',' or newlines at depth 0.
  function splitItems(ts) {
    const items = [];
    let cur = [];
    let depth = 0;
    for (const t of ts) {
      if (t.type === 'PUNCT' && OPEN[t.value]) depth += 1;
      if (t.type === 'PUNCT' && ['}', ']', ')'].includes(t.value)) depth -= 1;
      if (depth === 0 && (t.type === 'NEWLINE' || (t.type === 'PUNCT' && t.value === ','))) {
        if (cur.length) items.push(cur);
        cur = [];
        continue;
      }
      // Newlines inside a nested constructor still separate ITS items: keep them.
      if (t.type === 'NEWLINE' && depth === 0) continue;
      cur.push(t);
    }
    if (cur.length) items.push(cur);
    return items;
  }

  // Report object keys nested in an attribute value as attributes of their own.
  function descend(path, value) {
    if (value.kind === 'object') {
      for (const it of value.items) {
        attributes.push({ path, name: it.key, text: it.text, value: it.value, line: it.line });
        descend(`${path}.${it.key}`, it.value);
      }
    } else if (value.kind === 'tuple') value.items.forEach((v, n) => descend(`${path}[${n}]`, v));
  }

  function body(path, closer) {
    for (;;) {
      skipNewlines();
      const t = peek();
      if (closer && t.type === 'PUNCT' && t.value === '}') {
        p += 1;
        return;
      }
      if (t.type === 'EOF') {
        if (closer) throw new HclParseError('unclosed block', t.line);
        return;
      }
      if (t.type !== 'IDENT') throw new HclParseError(`expected an attribute or block name, found ${JSON.stringify(t.text)}`, t.line);
      p += 1;
      const next = peek();
      if (next.type === 'PUNCT' && next.value === '=') {
        p += 1;
        const ts = expressionTokens(false);
        const value = structure(ts);
        attributes.push({ path, name: t.value, text: text(ts), value, line: t.line });
        descend(`${path}${path ? '/' : ''}${t.value}`, value);
        const end = peek();
        if (end.type === 'NEWLINE' || end.type === 'EOF') continue;
        if (closer && end.type === 'PUNCT' && end.value === '}') continue;
        throw new HclParseError(`unexpected ${JSON.stringify(end.text)} after attribute ${t.value}`, end.line);
      }
      const labels = [];
      while (peek().type === 'STRING' || peek().type === 'IDENT') {
        const l = peek();
        if (l.type === 'STRING' && /\$\{|%\{/.test(l.value)) throw new HclParseError('template in a block label', l.line);
        labels.push(l.value);
        p += 1;
      }
      const open = peek();
      if (!(open.type === 'PUNCT' && open.value === '{')) throw new HclParseError(`expected "{" after block ${t.value}`, open.line);
      p += 1;
      const blockPath = `${path}${path ? '/' : ''}${[t.value, ...labels].join('.')}`;
      blocks.push({ path, type: t.value, labels, line: t.line, blockPath });
      body(blockPath, true);
      const after = peek();
      if (!(after.type === 'NEWLINE' || after.type === 'EOF' || (closer && after.type === 'PUNCT' && after.value === '}'))) throw new HclParseError(`unexpected ${JSON.stringify(after.text)} after block ${t.value}`, after.line);
    }
  }

  body('', false);
  return { blocks, attributes };
}
