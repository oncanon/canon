// Deterministic build-time syntax highlighting. Output is class-based spans only
// (no inline styles, so the packet CSP can forbid them) and every token's text is
// HTML-escaped. Lexing is a single linear pass of sticky regular expressions with
// a one-character fallback, so work is bounded by source length.
import { escapeHtml } from './escape.mjs';

const JS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new',
  'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void',
  'while', 'yield',
];

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'in', 'return', 'export', 'local', 'readonly', 'set', 'exit',
];

const words = (list) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'y');

const LANGUAGES = {
  typescript: [
    ['com', /\/\/[^\n]*/y],
    ['com', /\/\*[\s\S]*?(?:\*\/|$)/y],
    ['str', /`(?:\\[\s\S]|[^`\\])*`?/y],
    ['str', /'(?:\\.|[^'\\\n])*'?/y],
    ['str', /"(?:\\.|[^"\\\n])*"?/y],
    ['num', /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b/y],
    ['kw', words(JS_KEYWORDS)],
    ['ty', /\b[A-Z][A-Za-z0-9_]*\b/y],
    ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/y],
    [null, /[A-Za-z_$][\w$]*/y],
  ],
  json: [
    ['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
    ['str', /"(?:\\.|[^"\\\n])*"?/y],
    ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ['kw', /\b(?:true|false|null)\b/y],
  ],
  shell: [
    ['com', /(?<![^\s;|&(])#[^\n]*/y],
    ['str', /'[^']*'?/y],
    ['str', /"(?:\\.|[^"\\])*"?/y],
    ['var', /\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/y],
    ['kw', words(SHELL_KEYWORDS)],
    ['attr', /(?<=\s)--?[A-Za-z0-9][\w-]*/y],
    [null, /[A-Za-z_][\w.-]*/y],
  ],
  yaml: [
    ['com', /(?<![^\s])#[^\n]*/y],
    ['prop', /(?<=^|\n)[ \t]*(?:- )?[A-Za-z_][\w.-]*(?=:(?:\s|$))/y],
    ['str', /'(?:''|[^'\n])*'?/y],
    ['str', /"(?:\\.|[^"\\\n])*"?/y],
    ['kw', /\b(?:true|false|null|yes|no|on|off)\b/y],
    ['num', /-?\b\d+(?:\.\d+)?\b/y],
    [null, /[A-Za-z_][\w.-]*/y],
  ],
  text: [],
};
LANGUAGES.javascript = LANGUAGES.typescript;

export function tokenize(source, language) {
  const rules = LANGUAGES[language];
  if (!rules) throw new Error(`unsupported language ${language}`);
  const tokens = [];
  let plain = '';
  let i = 0;
  outer: while (i < source.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(source);
      if (m && m[0].length > 0) {
        if (cls === null) {
          plain += m[0];
        } else {
          if (plain) tokens.push([null, plain]);
          plain = '';
          tokens.push([cls, m[0]]);
        }
        i += m[0].length;
        continue outer;
      }
    }
    plain += source[i];
    i += 1;
  }
  if (plain) tokens.push([null, plain]);
  return tokens;
}

// Split a token stream into per-line arrays of HTML fragments.
export function highlightLines(source, language) {
  const lines = [[]];
  for (const [cls, text] of tokenize(source, language)) {
    const parts = text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1].push(cls ? `<span class="t-${cls}">${escapeHtml(part)}</span>` : escapeHtml(part));
    });
  }
  return lines.map((frags) => frags.join(''));
}

export function classifyDiffLine(line) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
