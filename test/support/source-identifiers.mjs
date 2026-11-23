// Run the identifier gate (test/support/identifiers.mjs) over every source file under scripts/, src/ and
// test/ (the lead's ruling 2026-10-04 11:49Z): our own source must stay clean under the gate that protects real
// evidence. Each finding is { file, kind, sha256 of the matched text } (never the text itself).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { identifierProblems } from './identifiers.mjs';
import { REPO } from '../helpers.mjs';

export const SOURCE_DIRS = ['scripts', 'src', 'test'];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p]; });

export function findingsOf(text, file) {
  const lines = String(text).split('\n');
  return identifierProblems(text).map((p) => {
    const m = /^line (\d+): (.*?) \((\d+) characters at column (\d+)\)/.exec(p);
    if (!m) return { file, kind: p, sha256: createHash('sha256').update(p).digest('hex') };
    const matched = lines[Number(m[1]) - 1].substr(Number(m[4]) - 1, Number(m[3]));
    return { file, kind: m[2], sha256: createHash('sha256').update(matched).digest('hex') };
  });
}

export function sourceIdentifierFindings(repo = REPO) {
  const out = [];
  for (const dir of SOURCE_DIRS) for (const p of walk(join(repo, dir))) {
    const bytes = readFileSync(p);
    if (bytes.includes(0)) continue; // binary
    out.push(...findingsOf(bytes.toString('utf8'), relative(repo, p)));
  }
  return out;
}
