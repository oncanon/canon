// Homebrew's `test do` block runs `canon --version`; the Homebrew formula install
// (npm pack tarball, no git checkout) still needs this to work, so it reads
// package.json relative to the installed script, not the repo.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runCli } from '../helpers.mjs';

test('[BREW-1] canon --version prints exactly the package.json version and exits 0', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const r = runCli(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${pkg.version}\n`);
  assert.equal(r.stderr, '');
});

test('[BREW-1] canon -v is the same as canon --version', () => {
  const a = runCli(['--version']);
  const b = runCli(['-v']);
  assert.equal(b.status, 0);
  assert.equal(b.stdout, a.stdout);
});

test('[BREW-1] canon --help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^usage:\n/);
  assert.equal(r.stderr, '');
});

test('[BREW-1] canon -h is the same as canon --help', () => {
  const a = runCli(['--help']);
  const b = runCli(['-h']);
  assert.equal(b.status, 0);
  assert.equal(b.stdout, a.stdout);
});

test('[BREW-2] canon --help lists --version and --help in the usage text', () => {
  const r = runCli(['--help']);
  assert.match(r.stdout, /--version/);
  assert.match(r.stdout, /--help/);
});

for (const args of [['-v', 'build'], ['--version', '--json'], ['--help', 'build'], ['-h', '--json']]) {
  test(`[BREW-2] canon ${args.join(' ')} is a usage error, not silent success`, () => {
    const r = runCli(args);
    assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /\n {4}at /, 'must not print a stack trace');
  });
}

for (const args of [['build', '--help'], ['serve', '--help'], ['verify', 'o1', '--version']]) {
  test(`[BREW-2] canon ${args.join(' ')} after a subcommand fails clean, no stack trace`, () => {
    const r = runCli(args);
    assert.notEqual(r.status, 0, `expected a non-zero exit, got stdout=${r.stdout}`);
    assert.doesNotMatch(r.stderr, /\n {4}at /, 'must not print a stack trace');
    assert.doesNotMatch(r.stderr, /TypeError|ERR_PARSE_ARGS/, 'must not surface the raw parseArgs error type');
  });
}

test('[BREW-2] canon build --bogus-opt prints a one-line error naming the option and exits 2', () => {
  const r = runCli(['build', '--bogus-opt']);
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /--bogus-opt/);
  assert.doesNotMatch(r.stderr, /\n {4}at /, 'must not print a stack trace');
});
