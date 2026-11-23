// Our own source stays clean under the identifier gate (the lead's ruling 2026-10-04 11:49Z). Every source file
// under scripts/, src/ and test/ is scanned; each finding must be listed, with a reason, in
// test/support/identifier-exceptions.json, keyed by file, kind and the sha256 of the matched text. Nothing is
// allowlisted silently: a NEW finding fails, and so does a listed one that is no longer there. New fakes are
// assembled from parts (e.g. ['1111', '2222', '3333'].join('')), never held whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { findingsOf, sourceIdentifierFindings } from '../support/source-identifiers.mjs';
import { REPO } from '../helpers.mjs';

const EXCEPTIONS = JSON.parse(readFileSync(join(REPO, 'test/support/identifier-exceptions.json'), 'utf8')).exceptions;
const key = (f) => `${f.file} | ${f.kind} | ${f.sha256}`;
const tally = (xs) => { const m = new Map(); for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1); return m; };

test('[H-8.1] every identifier-shaped match in scripts/, src/ and test/ is a listed exception with a reason: no new finding, no stale exception', () => {
  const found = tally(sourceIdentifierFindings());
  const listed = new Map(EXCEPTIONS.map((e) => [key(e), e.count]));
  const unlisted = [...found].filter(([k, n]) => listed.get(k) !== n).map(([k, n]) => `${k} x${n} (listed x${listed.get(k) ?? 0})`);
  const stale = [...listed].filter(([k]) => !found.has(k)).map(([k]) => k);
  assert.deepEqual(unlisted, [], 'a finding that is not listed exactly (assemble the value from parts, or list it with a reason)');
  assert.deepEqual(stale, [], 'an exception whose finding is gone (remove it)');
  for (const e of EXCEPTIONS) assert.ok(typeof e.reason === 'string' && e.reason.length >= 20, `${e.file}: an exception needs a real reason`);
});

test('[H-8.1] the source scan sees a planted whole account ID, ARN and email, and not the same values assembled from parts', () => {
  const account = ['4444', '5555', '6666'].join('');
  const planted = findingsOf(`const arn = 'arn:aws:iam::${account}:role/x'; // owner ${['ops', 'example.com'].join('@')}\n`, 'scripts/planted.mjs');
  assert.ok(planted.some((f) => f.kind === 'an AWS account ID'), 'a whole account ID is found');
  assert.ok(planted.some((f) => f.kind === 'an account-scoped ARN'));
  assert.ok(planted.some((f) => f.kind === 'an email address'));
  assert.deepEqual(findingsOf("const A = ['4444', '5555', '6666'].join('');\n", 'scripts/assembled.mjs'), [], 'assembled from parts: nothing found');
});

// Every identifier kind the gate knows has a planted value it must find. The kinds are named here, not
// read from IDENTIFIER_PATTERNS, so a pattern that is deleted or broken fails this test. Every value is
// assembled from parts, so this file holds none of them whole.
const PLANTS = [
  ['an AWS account ID', ['7777', '8888', '9999'].join('')],
  ['an account-scoped ARN', ['arn', 'aws', 'iam', '', ['7777', '8888', '9999'].join(''), 'role/x'].join(':')],
  ['a GUID (Entra tenant, client or resource ID)', ['0a1b2c3d', '4e5f', '6a7b', '8c9d', '0e1f2a3b4c5d'].join('-')],
  ['an AWS access key ID', ['AKIA', 'ZZZZ', 'YYYY', 'XXXX', 'WWWW'].join('')],
  ['an email address', ['ops', 'example.com'].join('@')],
  ['a private key', ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')],
  ['an Entra client secret value', ['abc', '8Q~', 'z'.repeat(32)].join('')],
  ['a secret assigned a value', ['token', ' = ', 'q'.repeat(16)].join('')],
];
test('[H-8.1] the source scan sees a planted value of every identifier kind, each on its own line', () => {
  for (const [kind, value] of PLANTS) {
    const kinds = findingsOf(`const x = '${value}';\n`, 'scripts/planted.mjs').map((f) => f.kind);
    assert.ok(kinds.includes(kind), `${kind} is found in a planted value`);
  }
});
