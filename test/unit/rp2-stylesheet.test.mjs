// render-policy/2 stylesheet rules (docs/decisions/render-policy-2.md R6).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

const CSS_PATH = join(REPO, 'src/presentation/edition-2.1.css');
const css = (await readFile(CSS_PATH, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

// Flattens nested at-rules into [{ at: ['@layer x', '@media y'], selector, body }].
function rules(text) {
  const out = [];
  const stack = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const prelude = stack.pop();
      if (buf.trim() && !prelude.startsWith('@')) out.push({ at: [...stack], selector: prelude, body: buf.trim() });
      buf = '';
    } else if (ch === ';' && stack.length && stack[stack.length - 1].startsWith('@layer') && !buf.includes(':')) {
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

const RULES = rules(css);
const decls = (body) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
const rootRules = RULES.filter((r) => r.selector === ':root');
const lightRoot = decls(rootRules.find((r) => !r.at.some((a) => a.includes('prefers-color-scheme')) && !r.at.some((a) => a.includes('print'))).body);
const darkRoot = decls(rootRules.find((r) => r.at.some((a) => a.includes('prefers-color-scheme: dark'))).body);

test('[R6-RETIRED] no retired token or retired hex value appears in the policy/2 stylesheet', () => {
  const retiredTokens = /--sev-high-|--sev-med-|--sev-info-bar|--open-(?!bd-style\b)|--vband-review-|--rfc-/;
  assert.ok(!retiredTokens.test(css), css.match(retiredTokens)?.[0]);
  for (const hex of ['#c2410c', '#ca8a04', '#9a3412', '#854d0e', '#7e22ce', '#6b21a8', '#3730a3']) {
    assert.ok(!css.toLowerCase().includes(hex), hex);
  }
  // The signal tokens of canon-2.1-signals.css are all present.
  for (const t of ['--sev-bar-critical', '--sev-bar-high', '--sev-bar-medium', '--sev-bar-low', '--pip-on', '--pip-off', '--pip-critical', '--stamp-bg', '--stamp-ink', '--rule-chip-bd', '--open-bd-style', '--chrome-band', '--chrome-band-ink', '--chrome-band-line']) {
    assert.ok(Object.hasOwn(lightRoot, t), t);
  }
});

test('[R6-AMBER] amber (--svg-gate, --svg-gate-bg and their values) is used only on gate selectors', () => {
  const amberHex = [lightRoot['--svg-gate'], lightRoot['--svg-gate-bg'], darkRoot['--svg-gate'], darkRoot['--svg-gate-bg']].map((v) => v.toLowerCase());
  let uses = 0;
  for (const r of RULES) {
    if (r.selector === ':root') continue;
    const body = r.body.toLowerCase();
    const amber = /var\(--svg-gate(-bg)?\)/.test(body) || amberHex.some((h) => body.includes(h));
    if (!amber) continue;
    uses += 1;
    for (const sel of r.selector.split(',')) {
      assert.match(sel.trim(), /(--gate|role-gate)\b/, `amber on a non-gate selector: ${sel.trim()}`);
    }
  }
  assert.ok(uses >= 6, 'gate selectors do use amber');
  for (const r of rootRules) {
    for (const [k, v] of Object.entries(decls(r.body))) {
      if (amberHex.includes(v.toLowerCase())) assert.match(k, /^--svg-gate(-bg)?$/, `${k} carries an amber value`);
    }
  }
});

test('[R6-PLATE] layer accents are ink, never purple; only gate nodes are amber', () => {
  const accent = RULES.find((r) => r.selector.includes('.svg-node--role-store .svg-node__accent'));
  assert.ok(accent);
  assert.equal(decls(accent.body).fill, 'var(--ink)');
  assert.ok(accent.selector.includes('.svg-node--role-entry') && accent.selector.includes('.svg-node--role-external'));
  const gate = RULES.find((r) => r.selector.includes('.svg-node--role-gate .svg-node__accent'));
  assert.equal(decls(gate.body).fill, 'var(--svg-gate)');
});

test('[R6-DARK] every token has a dark value or follows a token that flips', () => {
  const invariant = new Set(['--serif', '--sans', '--mono', '--page', '--margin-col', '--measure', '--touch', '--code-font-size', '--code-line-height', '--open-bd-style']);
  const flips = (name, seen = new Set()) => {
    if (Object.hasOwn(darkRoot, name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const refs = [...(lightRoot[name] ?? '').matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    return refs.length > 0 && refs.every((r) => flips(r, seen));
  };
  for (const name of Object.keys(lightRoot)) {
    if (invariant.has(name)) continue;
    assert.ok(flips(name), `${name} has no dark value and follows no token that flips`);
  }
});

function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function resolve(scheme, name) {
  const v = (scheme === 'dark' && Object.hasOwn(darkRoot, name) ? darkRoot : lightRoot)[name];
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? resolve(scheme, ref[1]) : v;
}

test('[R6-CONTRAST] band text reaches 4.5:1 on the band; body text reaches 4.5:1 on the document backgrounds, in both schemes', () => {
  for (const scheme of ['light', 'dark']) {
    for (const fg of ['--chrome-band-ink', '--chrome-band-muted', '--chrome-band-accent']) {
      const c = contrast(resolve(scheme, fg), resolve(scheme, '--chrome-band'));
      assert.ok(c >= 4.5, `${scheme} ${fg} on --chrome-band: ${c.toFixed(2)}`);
    }
    const tab = contrast(resolve(scheme, '--chrome-band-accent'), resolve(scheme, '--chrome-band-current'));
    assert.ok(tab >= 4.5, `${scheme} current format tab: ${tab.toFixed(2)}`);
    for (const fg of ['--ink', '--ink-secondary', '--muted', '--accent-ink', '--proven-ink', '--rec-ink', '--defect-ink']) {
      for (const bg of ['--paper', '--card']) {
        const c = contrast(resolve(scheme, fg), resolve(scheme, bg));
        assert.ok(c >= 4.5, `${scheme} ${fg} on ${bg}: ${c.toFixed(2)}`);
      }
    }
    for (const [fg, bg] of [['--proven-ink', '--proven-bg'], ['--rec-ink', '--rec-bg'], ['--defect-ink', '--defect-bg'], ['--accent-ink', '--accent-wash'], ['--svg-gate', '--svg-gate-bg'], ['--stamp-ink', '--stamp-bg'], ['--code-muted', '--code-chrome']]) {
      const c = contrast(resolve(scheme, fg), resolve(scheme, bg));
      assert.ok(c >= 4.5, `${scheme} ${fg} on ${bg}: ${c.toFixed(2)}`);
    }
  }
});

test('[R6-BANDS] the dark band background is used only on .masthead and .colophon and their descendants', () => {
  for (const r of RULES) {
    if (r.selector === ':root') continue;
    if (!/var\(--chrome-band\)/.test(r.body)) continue;
    for (const sel of r.selector.split(',')) assert.match(sel.trim(), /^\.(masthead|colophon)\b/, sel);
  }
});

test('[R6-LAYOUT] flex column and rail, no .toc, no external URL, no @import', () => {
  const doc = RULES.find((r) => r.selector === '.document');
  const rail = RULES.find((r) => r.selector === '.rail');
  assert.equal(decls(doc.body).flex, '999 1 600px');
  assert.equal(decls(rail.body).flex, '1 1 250px');
  assert.ok(!/\.toc\b/.test(css));
  assert.ok(!/https?:|@import|url\(/i.test(css), 'the source stylesheet loads nothing; fonts are prepended by the builder');
  assert.ok(/@media \(prefers-color-scheme: dark\)/.test(css) && /@media print/.test(css) && /@media \(prefers-reduced-motion: reduce\)/.test(css));
});

test('[R6-BAND-INLINE] keyword chips and cites inside colophon notes take band colours that reach 4.5:1 in both schemes', () => {
  // provenance.notes render on the band through the inline renderer, so its chips need band overrides.
  const tok = (v) => /^var\((--[a-z0-9-]+)\)$/.exec(v ?? '')?.[1];
  for (const [selector, bgDefault] of [['.colophon .rfc2119', '--chrome-band'], ['.colophon a.cite', null]]) {
    const rule = RULES.find((r) => r.selector === selector);
    assert.ok(rule, `${selector} override exists`);
    const d = decls(rule.body);
    const fg = tok(d.color);
    const bg = tok(d.background) ?? bgDefault;
    assert.ok(fg && bg, `${selector} sets band colour tokens (color ${d.color}, background ${d.background})`);
    for (const scheme of ['light', 'dark']) {
      const c = contrast(resolve(scheme, fg), resolve(scheme, bg));
      assert.ok(c >= 4.5, `${scheme} ${selector}: ${fg} on ${bg} = ${c.toFixed(2)}`);
    }
  }
});
