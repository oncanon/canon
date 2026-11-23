// N-PV-6 (QA s7): the research the V2 documents cite lives in docs/v2/research/, byte for
// byte. Each record's SHA-256 is pinned in SHA256SUMS; every cited research path resolves;
// and every hash quoted next to a citation (`854b496a…d7ee`) agrees with the pinned one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

const DIR = 'docs/v2/research';
const sha = (f) => createHash('sha256').update(readFileSync(join(REPO, f))).digest('hex');
export const PINNED = new Map(readFileSync(join(REPO, DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [`${DIR}/${f}`, h]; }));

function files(dir) {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}

test('[N-PV-6] every research record is pinned, and its bytes match the pin', () => {
  const records = readdirSync(join(REPO, DIR)).filter((f) => f !== 'README.md' && f !== 'SHA256SUMS').map((f) => `${DIR}/${f}`).sort();
  assert.deepEqual([...PINNED.keys()].sort(), records, 'SHA256SUMS lists exactly the records present');
  assert.deepEqual([...PINNED.keys()].sort(), [`${DIR}/cloudflare-adapter.md`]);
  for (const [f, h] of PINNED) assert.equal(sha(f), h, `${f} is byte-for-byte the pinned record`);
  // The cloudflare pin is the hash of the record as published (854b496a…d7ee).
  assert.match(PINNED.get(`${DIR}/cloudflare-adapter.md`), /^854b496a[0-9a-f]{52}d7ee$/);
});

test('[N-PV-6] every research citation resolves, and every quoted hash agrees with the pin', () => {
  const scanned = [...files('docs/v2'), ...files('infra'), ...files('src')].filter((f) => !f.startsWith(`${DIR}/`));
  const problems = [];
  let citations = 0;
  for (const file of scanned) {
    // Joined across comment line breaks ("docs/v2/research/\n// cloudflare-adapter.md").
    const text = readFileSync(join(REPO, file), 'utf8').replace(/\/\n\s*(?:\/\/|--|#)\s*/g, '/');
    for (const m of text.matchAll(/(?<![\w/.])(?:docs\/v2\/)?research\/([\w.-]+\.md)`?(?:\s*\(`([0-9a-f]{8})…([0-9a-f]{4})`\))?/g)) {
      citations += 1;
      const target = `${DIR}/${m[1]}`;
      if (!m[0].startsWith('docs/v2/')) problems.push(`${file}: "${m[0]}" is not repo-relative (docs/v2/research/…)`);
      if (!PINNED.has(target)) problems.push(`${file}: cites ${target}, which is not a pinned record`);
      else if (m[2] && !(PINNED.get(target).startsWith(m[2]) && PINNED.get(target).endsWith(m[3]))) problems.push(`${file}: quotes ${m[2]}…${m[3]} for ${target}`);
    }
    for (const m of text.matchAll(/(?<![\w/.-])`(cloudflare-adapter\.md)`/g)) problems.push(`${file}: bare citation ${m[1]}`);
  }
  assert.ok(citations >= 15, `the scan finds the citations (${citations})`);
  assert.deepEqual(problems, []);
});
