// V2-QA-7: the deploy-token scope gate's vocabulary and matcher. WHAT IT GUARANTEES
// (narrowed by the maintainer's V2-QA-8 decision, 2026-09-28): it detects Cloudflare
// permission-group NAMES, distinctive resource nouns, and "<noun> Edit|Read|Write|Revoke"-
// style SHAPES outside the generated scope tables. It does NOT understand free prose: a scope
// described in other words (a verb before the resource, an inflected level, a split table
// cell, a link, a wrapped line) is not detected. Free prose is covered by review, and by the maintainer
// granting at token creation only the scopes in the generated table, which is the authority
// (docs/v2/threat-model.md T8, an accepted residual). The vocabulary is Cloudflare's
// own list of permission-group names (infra/cloudflare/permission-vocabulary.json, read from
// the public docs page it cites), and the resource nouns DERIVED from those names by
// stripping the trailing verb. A line mentions a scope when, compared case-insensitively
// and ignoring the separators · : - / _ and whitespace (and markdown emphasis):
//   1. it contains a full permission-group name (in either its "Edit" or "Write" form);
//   2. it contains a distinctive (multi-word or prefixed) resource noun, even without a verb
//      ("Workers Routes");
//   3. it has the shape "<noun> Edit|Read|Write|Revoke" for ANY noun, including single-word
//      ones and the listed abbreviations ("DNS Edit", "R2 write"), "<noun> permissions|scope|
//      rights" ("without R2 Storage permissions"), or "<verb> access|permission|scope|
//      rights to|on|for|over <noun>" ("write access to D1").
// Pure library: nothing runs on import.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKENS } from './scope-tables.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const VOCABULARY_FILE = 'infra/cloudflare/permission-vocabulary.json';
export const CANONICAL_FILE = 'infra/cloudflare/deploy-token-scopes.json';

const TRAILING_VERB = /\s*(?:[-:]\s*)?(?:Read|Edit|Write|Revoke|Run|Report)(?:\s+PCAPs API)?$/;
export const VERBS = ['edit', 'read', 'write', 'revoke'];

// Lowercase; drop markdown emphasis; every run of the separators · : - / _ and whitespace
// becomes one space. Sentence punctuation (. , ; ! ? ( ) |) is kept, so it still separates.
export function normalize(text) {
  return String(text).toLowerCase().replace(/[*`]/g, '').replace(/[·:/_\s-]+/g, ' ').replace(/ ?, ?/g, ', ').trim();
}

// The nouns a permission-group name is about: the name without its trailing verb.
export function deriveNouns(names) {
  return [...new Set(names.map((n) => n.replace(TRAILING_VERB, '').trim()).filter(Boolean))].sort();
}

export function loadVocabulary(repo = REPO) {
  return JSON.parse(readFileSync(join(repo, VOCABULARY_FILE), 'utf8'));
}

// Tokens of normalized text: words, and the clause punctuation that separates them (so a
// phrase never matches across ". " or "; "). Phrases are matched token by token.
// Terraform resource-type identifiers (`cloudflare_zero_trust_access_policy`, ...) are code,
// not permission statements, and the IaC allowlist governs them structurally, so they are set
// aside before matching (V2.1: Access as code).
const RESOURCE_TYPE = /\bcloudflare_[a-z0-9_]+\b/gi;
const tokens = (text) => normalize(String(text).replace(RESOURCE_TYPE, ' ')).match(/[a-z0-9]+|[.,;!?()|]/g) ?? [];
const SHAPE_AFTER = new Set(['permission', 'permissions', 'scope', 'scopes', 'right', 'rights']);
const GRANT_WORDS = new Set(['access', ...SHAPE_AFTER]);
const PREPOSITIONS = new Set(['to', 'on', 'for', 'over']);

// A matcher over one vocabulary. Returns, for a line, why it mentions a scope ([] if not).
const matchers = new Map();
export function matcher(vocab) {
  const key = JSON.stringify([vocab.names, vocab.nouns, vocab.abbreviations]);
  if (!matchers.has(key)) matchers.set(key, buildMatcher(vocab));
  return matchers.get(key);
}

function buildMatcher(vocab) {
  const nouns = [...vocab.nouns, ...vocab.abbreviations.map((a) => a.noun)];
  const bare = new Set([...vocab.nouns.filter((n) => /\s|:/.test(n)), ...vocab.abbreviations.filter((a) => a.bare).map((a) => a.noun)]);
  // Phrases indexed by their first token: permission names, and nouns (bare or not).
  const index = new Map();
  const add = (label, kind, phrase) => {
    const toks = tokens(phrase);
    if (!toks.length) return;
    if (!index.has(toks[0])) index.set(toks[0], []);
    index.get(toks[0]).push({ label, kind, toks });
  };
  for (const n of vocab.names) add(n.name, 'name', n.name);
  for (const n of nouns) add(n, bare.has(n) ? 'bare-noun' : 'noun', n);
  const at = (t, i, toks) => toks.every((x, k) => t[i + k] === x);
  return (line) => {
    const t = tokens(line);
    const why = new Set();
    for (let i = 0; i < t.length; i += 1) {
      for (const p of index.get(t[i]) ?? []) {
        if (!at(t, i, p.toks)) continue;
        const next = t[i + p.toks.length];
        if (p.kind === 'name') why.add(`permission name "${p.label}"`);
        if (p.kind === 'bare-noun') why.add(`resource noun "${p.label}"`);
        if (p.kind !== 'name' && VERBS.includes(next)) why.add(`"${p.label} ${next}"`);
        if (p.kind !== 'name' && SHAPE_AFTER.has(next)) why.add(`"${p.label} ${next}"`);
        // "<verb> access|permission|scope|rights to|on|for|over [cloudflare] <noun>"
        if (p.kind !== 'name') {
          const back = t[i - 1] === 'cloudflare' ? i - 1 : i;
          if (PREPOSITIONS.has(t[back - 1]) && GRANT_WORDS.has(t[back - 2]) && VERBS.includes(t[back - 3])) why.add(`"${t[back - 3]} ${t[back - 2]} ${t[back - 1]} ${p.label}"`);
        }
      }
    }
    return [...why];
  };
}

// Every line in `files` (path -> text) that mentions a scope outside the marked tables, after
// removing the reviewed allowed phrases (dashboard labels); and every allowed phrase whose
// count of uses differs from its declared count (stale or duplicated exceptions fail too).
// The generated blocks: one marker per token in scope-tables.mjs TOKENS (the private deploy
// token, the public target's token, the site deploy token). A marker that is not registered
// there exempts nothing.
const MARKERS = TOKENS.map((t) => t.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
export const BLOCK_BEGIN = new RegExp(`(?:${MARKERS}):begin`);
export const BLOCK_END = new RegExp(`(?:${MARKERS}):end`);

export function scopeViolations(files, vocab) {
  const mentions = matcher(vocab);
  const problems = [];
  const uses = new Map(vocab.allowedPhrases.map((a) => [a, 0]));
  for (const [file, text] of files) {
    let inside = false;
    text.split('\n').forEach((line, i) => {
      if (BLOCK_BEGIN.test(line)) inside = true;
      if (!inside) {
        let rest = line;
        for (const a of vocab.allowedPhrases.filter((x) => x.file === file)) {
          while (rest.includes(a.phrase)) {
            rest = rest.replace(a.phrase, ' ');
            uses.set(a, uses.get(a) + 1);
          }
        }
        const why = mentions(rest);
        if (why.length) problems.push(`${file}:${i + 1}: ${why.join('; ')} :: ${line.trim().slice(0, 120)}`);
      }
      if (BLOCK_END.test(line)) inside = false;
    });
  }
  for (const [a, n] of uses) if (n !== a.count) problems.push(`allowed phrase ${JSON.stringify(a.phrase)} in ${a.file}: used ${n} time(s), declared ${a.count}`);
  return problems;
}
