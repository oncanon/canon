// Canon lockup artwork for the render-policy/2 masthead and colophon.
//
// The lockups are outlined SVG files shipped under src/presentation/marks/. They are
// optional: when a file is absent, the brand slot carries only the visually hidden text
// "Canon", and nothing is drawn or typed in its place. When a file is present it is
// parsed by the strict reader below and re-serialised from the parse, never copied
// through: only the elements and presentation attributes in the allowlists survive, and
// anything else (style, id, class, href, event handlers, comments, entities, CDATA,
// doctype, url(...) references, unknown elements or attributes) fails the build.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeAttr, escapeHtml } from './escape.mjs';

export const LOCKUP_MAX_BYTES = 64 * 1024;
export const LOCKUP_FILES = Object.freeze({ ui: 'lockup-ui.svg', display: 'lockup-display.svg' });
export const DEFAULT_MARKS_DIR = new URL('../presentation/marks/', import.meta.url);

export const LOCKUP_ELEMENTS = Object.freeze(['svg', 'g', 'rect', 'line', 'path', 'circle', 'polygon', 'polyline', 'ellipse', 'text', 'tspan']);
const ELEMENTS = new Set(LOCKUP_ELEMENTS);
const TEXT_ELEMENTS = new Set(['text', 'tspan']);
export const LOCKUP_ATTRIBUTES = Object.freeze([
  'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'dx', 'dy',
  'transform', 'opacity', 'fill', 'fill-rule', 'fill-opacity', 'clip-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline',
]);
const ATTRIBUTES = new Set(LOCKUP_ATTRIBUTES);
// The SVG namespace declaration is accepted on the root and dropped: inline SVG in HTML
// needs no namespace, and the sealed page carries no http(s) URL (R9).
const SVG_NS = 'http://www.w3.org/2000/svg';
const VALUE_RE = /^[A-Za-z0-9#.,% ()+\-'"_]*$/;
const FUNCTIONS = new Set(['rgb', 'rgba', 'matrix', 'translate', 'scale', 'rotate', 'skewx', 'skewy']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export class LockupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockupError';
    this.code = 'unsafe-lockup';
  }
}

function checkValue(name, value, where) {
  if (!VALUE_RE.test(value)) throw new LockupError(`${where}: attribute ${name} has a disallowed character`);
  for (const m of value.matchAll(/([A-Za-z-]+)\s*\(/g)) {
    if (!FUNCTIONS.has(m[1].toLowerCase())) throw new LockupError(`${where}: attribute ${name} uses function ${m[1]}()`);
  }
}

function decodeText(raw, where) {
  return raw.replace(/&([^;]*);?/g, (all, name) => {
    if (!all.endsWith(';') || !Object.hasOwn(ENTITIES, name)) throw new LockupError(`${where}: only &amp; &lt; &gt; &quot; &apos; are allowed in text`);
    return ENTITIES[name];
  });
}

// Parses and re-serialises one lockup. `kind` is 'ui' or 'display' and becomes a class.
export function sanitizeLockupSvg(text, kind, label = LOCKUP_FILES[kind]) {
  if (typeof text !== 'string') throw new LockupError(`${label}: not text`);
  if (Buffer.byteLength(text, 'utf8') > LOCKUP_MAX_BYTES) throw new LockupError(`${label}: exceeds ${LOCKUP_MAX_BYTES} bytes`);
  let src = text.replace(/^﻿/, '');
  src = src.replace(/^\s*<\?xml version="1\.0"(?: encoding="(?:UTF-8|utf-8)")?(?: standalone="(?:yes|no)")?\s*\?>/, '');
  let i = 0;
  const out = [];
  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  const nameRe = /[A-Za-z][A-Za-z0-9-]*/y;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i += 1; };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textChunk = lt === -1 ? src.slice(i) : src.slice(i, lt);
    if (textChunk.length) {
      const top = stack[stack.length - 1];
      if (textChunk.trim().length) {
        if (!top || !TEXT_ELEMENTS.has(top)) throw new LockupError(`${label}: text content outside <text>/<tspan>`);
        if (textChunk.includes('>')) throw new LockupError(`${label}: stray ">" in text`);
        out.push(escapeHtml(decodeText(textChunk, label)));
      } else if (top && TEXT_ELEMENTS.has(top)) {
        out.push(escapeHtml(textChunk));
      }
    }
    if (lt === -1) break;
    i = lt + 1;
    if (rootClosed) throw new LockupError(`${label}: content after the root element`);
    if (src[i] === '!' || src[i] === '?') throw new LockupError(`${label}: comments, doctype, CDATA and processing instructions are not allowed`);
    if (src[i] === '/') {
      i += 1;
      nameRe.lastIndex = i;
      const m = nameRe.exec(src);
      if (!m) throw new LockupError(`${label}: malformed end tag`);
      i += m[0].length;
      ws();
      if (src[i] !== '>') throw new LockupError(`${label}: malformed end tag </${m[0]}>`);
      i += 1;
      const open = stack.pop();
      if (open !== m[0]) throw new LockupError(`${label}: </${m[0]}> does not close <${open}>`);
      out.push(`</${m[0]}>`);
      if (!stack.length) rootClosed = true;
      continue;
    }
    nameRe.lastIndex = i;
    const m = nameRe.exec(src);
    if (!m) throw new LockupError(`${label}: malformed tag`);
    const name = m[0];
    i += name.length;
    if (!ELEMENTS.has(name)) throw new LockupError(`${label}: element <${name}> is not allowed`);
    if (!stack.length) {
      if (rootSeen || name !== 'svg') throw new LockupError(`${label}: the root element must be a single <svg>`);
      rootSeen = true;
    } else if (name === 'svg') {
      throw new LockupError(`${label}: nested <svg> is not allowed`);
    }
    const attrs = [];
    const seen = new Set();
    for (;;) {
      const before = i;
      ws();
      if (src[i] === '>' || (src[i] === '/' && src[i + 1] === '>')) break;
      if (i === before) throw new LockupError(`${label}: <${name}> attributes must be separated by whitespace`);
      const an = /[A-Za-z][A-Za-z0-9:-]*/y;
      an.lastIndex = i;
      const am = an.exec(src);
      if (!am) throw new LockupError(`${label}: malformed attribute in <${name}>`);
      const attr = am[0];
      i += attr.length;
      ws();
      if (src[i] !== '=') throw new LockupError(`${label}: attribute ${attr} in <${name}> has no value`);
      i += 1;
      ws();
      const q = src[i];
      if (q !== '"' && q !== "'") throw new LockupError(`${label}: attribute ${attr} in <${name}> is not quoted`);
      const end = src.indexOf(q, i + 1);
      if (end === -1) throw new LockupError(`${label}: unterminated attribute ${attr}`);
      const value = src.slice(i + 1, end);
      i = end + 1;
      if (seen.has(attr)) throw new LockupError(`${label}: duplicate attribute ${attr} in <${name}>`);
      seen.add(attr);
      if (attr === 'xmlns' && name === 'svg' && stack.length === 0) {
        if (value !== SVG_NS) throw new LockupError(`${label}: unexpected xmlns value`);
        continue;
      }
      if (!ATTRIBUTES.has(attr)) throw new LockupError(`${label}: attribute ${attr} is not allowed on <${name}>`);
      checkValue(attr, value, `${label} <${name}>`);
      attrs.push(` ${attr}="${escapeAttr(value)}"`);
    }
    const selfClosing = src[i] === '/';
    i += selfClosing ? 2 : 1;
    const isRoot = stack.length === 0;
    const extra = isRoot ? ` class="lockup lockup--${kind}" aria-hidden="true" focusable="false"` : '';
    if (selfClosing) {
      if (isRoot) throw new LockupError(`${label}: empty root <svg/>`);
      out.push(`<${name}${extra}${attrs.join('')}></${name}>`);
    } else {
      out.push(`<${name}${extra}${attrs.join('')}>`);
      stack.push(name);
    }
  }
  if (!rootSeen) throw new LockupError(`${label}: no <svg> root element`);
  if (stack.length) throw new LockupError(`${label}: <${stack[stack.length - 1]}> is not closed`);
  return out.join('');
}

// Reads both lockups from marksDir if present. Missing files yield null; any other read
// failure or a file that fails the allowlist throws.
export async function loadLockups(marksDir = DEFAULT_MARKS_DIR) {
  const result = { ui: null, display: null };
  for (const [kind, file] of Object.entries(LOCKUP_FILES)) {
    let text;
    try {
      text = await readFile(marksDir instanceof URL ? new URL(file, marksDir) : join(marksDir, file), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new LockupError(`${file}: ${err.code ?? err.message}`);
    }
    result[kind] = sanitizeLockupSvg(text, kind, file);
  }
  return result;
}
