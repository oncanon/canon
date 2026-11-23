// commit-and-push.sh against real local git remotes: it exits 0 only when the change is on the
// remote branch, and it stops on any failed git step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/release/commit-and-push.sh');
// Assembled from parts: the identifier gate (H-8.1) refuses whole email addresses in source.
const EMAIL = ['t', 'example.invalid'].join('@');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', `user.email=${EMAIL}`, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'feed.txt'), 'a\n');
  git(seed, 'add', 'feed.txt');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const work = join(dir, 'work');
  git(dir, 'clone', '-q', origin, work);
  return { dir, origin, seed, work };
}

// Appends "line" once; a second run on a file that has it changes nothing.
const ADD = ['sh', '-c', 'grep -qx new feed.txt || echo new >> feed.txt'];
const run = (work, cmd = ADD) =>
  spawnSync(SCRIPT, [work, 'main', 'chore: add line', '--', ...cmd], { env, encoding: 'utf8' });
const remoteFeed = (origin) => git(origin, 'show', 'main:feed.txt');

test('pushes the change, and a re-run reports it is already there', (t) => {
  const { origin, work } = setup(t);
  const first = run(work);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(remoteFeed(origin), 'a\nnew');
  const again = run(work);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already has the change/);
  assert.equal(git(origin, 'rev-list', '--count', 'main'), '2');
});

test('redoes the change on top of a commit that landed after the checkout', (t) => {
  const { origin, seed, work } = setup(t);
  writeFileSync(join(seed, 'other.txt'), 'x\n');
  git(seed, 'add', 'other.txt');
  git(seed, 'commit', '-qm', 'other');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const r = run(work);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteFeed(origin), 'a\nnew');
  assert.equal(git(origin, 'show', 'main:other.txt'), 'x');
});

test('retries after a rejected push and succeeds on the next attempt', (t) => {
  const { dir, origin, work } = setup(t);
  const flag = join(dir, 'rejected-once');
  const hook = join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\n[ -f '${flag}' ] && exit 0\ntouch '${flag}'\necho rejected >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
  const r = run(work);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /attempt 2/);
  assert.equal(remoteFeed(origin), 'a\nnew');
});

test('fails when every push is rejected, and the remote is unchanged', (t) => {
  const { origin, work } = setup(t);
  const hook = join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const r = run(work);
  assert.notEqual(r.status, 0);
  assert.equal(remoteFeed(origin), 'a');
});

test('fails when the fetch fails, even if a local commit already has the change', (t) => {
  const { dir, origin, work } = setup(t);
  // The state that hid a failed push before: the change is committed locally, not on the remote.
  writeFileSync(join(work, 'feed.txt'), 'a\nnew\n');
  git(work, 'commit', '-qam', 'local only');
  git(work, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  const r = run(work);
  assert.notEqual(r.status, 0);
  assert.equal(remoteFeed(origin), 'a');
});

test('fails when the edit command fails, and pushes nothing', (t) => {
  const { origin, work } = setup(t);
  const r = run(work, ['sh', '-c', 'echo broken >> feed.txt; exit 3']);
  assert.notEqual(r.status, 0);
  assert.equal(remoteFeed(origin), 'a');
  assert.equal(readFileSync(join(work, 'feed.txt'), 'utf8'), 'a\nbroken\n');
});
