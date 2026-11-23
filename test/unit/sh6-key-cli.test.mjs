// SH-6: `canon key generate` exposes the publisher signing keygen (today only
// scripts/public-target-keygen.mjs) through the CLI, with the same refusals.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { REPO, runCli, tempDir } from '../helpers.mjs';

test('[SH6-1] canon key generate writes the public key pair, printing only the public key', async (t) => {
  const dir = await tempDir(t, 'canon-sh6-key');
  const out = join(dir, 'publisher.key.json');
  const r = runCli(['key', 'generate', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout with --out');
  assert.match(r.stderr, /^publisher_public_key = "[^"\n]+"\s*$/, 'only the public key is printed');
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  const cred = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(Object.keys(cred), ['privateKey']);
  assert.ok(!r.stderr.includes(cred.privateKey), 'the private key is never echoed');
});

test('[SH6-1] canon key generate refuses a path inside the repository or an existing git worktree', async () => {
  const inRepo = join(REPO, 'test', 'sh6-key-cli-refused.key.json');
  const r = runCli(['key', 'generate', '--out', inRepo]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside the repository/);
});
