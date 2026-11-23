#!/usr/bin/env node
// V2-QA-7: the deploy-token scope tables are MACHINE-ONLY. infra/cloudflare/deploy-token-scopes.json
// is the single source; the block between the `deploy-token-scopes:begin` and `:end` markers
// in each target file is generated from it by this script, and
// test/unit/pv-deploy-token-scopes.test.mjs requires each block to be byte-identical to the
// generated output. Nobody writes a scope row by hand.
//
//   node scripts/scope-tables.mjs           check: exit 1 if any block differs
//   node scripts/scope-tables.mjs --write   regenerate every block in place
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CANONICAL_FILE = 'infra/cloudflare/deploy-token-scopes.json';
export const TARGETS = [
  { file: 'docs/v2/cloudflare/coverage.md', style: 'table', indent: '' },
  { file: 'docs/v2/cloudflare/runbook.md', style: 'table', indent: '' },
  { file: 'infra/cloudflare/terraform/versions.tf', style: 'hcl-comment', indent: '' },
];
// V2.1 slice 04: the public target's own deploy token (rp-public-deploy-<run>), a separate
// canonical list with its own marked blocks (deploy-token-scopes-public:begin/end).
export const PUBLIC_CANONICAL_FILE = 'infra/cloudflare/deploy-token-scopes-public.json';
export const PUBLIC_TARGETS = [
  { file: 'docs/v2/cloudflare/coverage.md', style: 'table', indent: '' },
  { file: 'docs/v2/cloudflare/runbook-public.md', style: 'table', indent: '' },
  { file: 'infra/cloudflare/terraform-public/versions.tf', style: 'hcl-comment', indent: '' },
];
// The site deploy token (CLOUDFLARE_API_TOKEN of .github/workflows/site.yml), its own list and blocks.
export const SITE_CANONICAL_FILE = 'infra/cloudflare/deploy-token-scopes-site.json';
export const SITE_TARGETS = [
  { file: 'docs/operations/release.md', style: 'table', indent: '' },
];
export const TOKENS = [
  { canonical: CANONICAL_FILE, marker: 'deploy-token-scopes', targets: TARGETS },
  { canonical: PUBLIC_CANONICAL_FILE, marker: 'deploy-token-scopes-public', targets: PUBLIC_TARGETS },
  { canonical: SITE_CANONICAL_FILE, marker: 'deploy-token-scopes-site', targets: SITE_TARGETS },
];

const cell = (s) => String(s).replace(/\|/g, '\\|');

// The lines between the markers, for one target.
export function render(canonical, { style, indent }) {
  if (style === 'hcl-comment') {
    return [`#   granted: ${canonical.granted.map((g) => g.permission + (g.necessity === 'verified' ? '' : ' (unverified)')).join(' | ')}`];
  }
  const row = (cells) => `${indent}| ${cells.map(cell).join(' | ')} |`;
  return [
    row(['Permission', 'Granted', 'Needed for', 'Source', 'Necessity']),
    `${indent}| --- | --- | --- | --- | --- |`,
    ...canonical.granted.map((g) => row([g.permission, 'yes', g.neededFor, g.source, g.necessity])),
    ...canonical.notGranted.map((n) => row([n.permission, 'no', n.reason, '—', '—'])),
  ];
}

// The file's one marked block for `marker`: { before, inside, after } (the marker lines stay in
// before/after).
export function markedBlock(text, marker = 'deploy-token-scopes') {
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l.includes(`${marker}:begin`) ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.includes(`${marker}:end`) ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0]) return null;
  return { before: lines.slice(0, begins[0] + 1), inside: lines.slice(begins[0] + 1, ends[0]), after: lines.slice(ends[0]) };
}

// Problems for every target whose block is missing or differs from the generated output.
export function tableProblems(read) {
  const problems = [];
  for (const { canonical: file, marker, targets } of TOKENS) problems.push(...tokenTableProblems(read, file, marker, targets));
  return problems;
}

function tokenTableProblems(read, canonicalFile, marker, targets) {
  const canonical = JSON.parse(read(canonicalFile));
  const problems = [];
  for (const t of targets) {
    const b = markedBlock(read(t.file), marker);
    if (!b) {
      problems.push(`${t.file}: not exactly one ${marker} block`);
      continue;
    }
    const want = render(canonical, t);
    if (b.inside.join('\n') !== want.join('\n')) {
      const i = want.findIndex((l, k) => b.inside[k] !== l);
      problems.push(`${t.file}: the marked block is not the generated output (first difference at block line ${i < 0 ? want.length + 1 : i + 1})`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = (f) => readFileSync(join(REPO, f), 'utf8');
  if (process.argv.includes('--write')) {
    for (const { canonical: file, marker, targets } of TOKENS) {
      const canonical = JSON.parse(read(file));
      for (const t of targets) {
        const b = markedBlock(read(t.file), marker);
        if (!b) throw new Error(`${t.file}: not exactly one ${marker} block`);
        writeFileSync(join(REPO, t.file), [...b.before, ...render(canonical, t), ...b.after].join('\n'));
      }
    }
  }
  const problems = tableProblems(read);
  for (const p of problems) process.stderr.write(`scope-tables: ${p}\n`);
  process.exit(problems.length ? 1 : 0);
}
