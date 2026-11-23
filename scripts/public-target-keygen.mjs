#!/usr/bin/env node
// V2.1 slice 04: the publisher signing key for the public target (mode (c)).
//
//   node scripts/public-target-keygen.mjs --out <path>   write the credential to <path>
//   node scripts/public-target-keygen.mjs --print-once   print the credential once, to stdout
//
// The credential is the JSON the public target's credentialEnv holds:
// {"privateKey":"canon-ed25519-sk:…"}. It goes only where the operator says:
// - with --out, to a new file (never an existing one) with mode 0600, outside this repository and
//   outside any git worktree, both judged on canonical paths (N-V21-7);
// - with --print-once, to stdout and nowhere else.
// It is never written to the repository, to Terraform state or to evidence. The secret gate
// knows its format (scripts/secret-gate.mjs, family publisher-signing-key). The public key,
// which is not a secret, is printed on stderr for the public module's publisher_public_key.
//
// Exit: 0 written, 1 refused, 2 usage.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalPath, existingAncestor } from '../src/publication/paths.mjs';
import { generateSigningKey } from '../src/publication/signing.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// True when `path` is inside `root`, both compared canonically (symlinks followed, the filesystem's
// own case: paths.mjs), never by string prefix (N-V21-7).
export function insideRoot(path, root = REPO) {
  const rel = relative(canonicalPath(root), canonicalPath(path));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// The top level of the git worktree containing `path` (asked of git from its nearest existing
// directory, with no inherited GIT_* setting), or null outside any worktree.
export function gitWorktreeOf(path) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['-C', existingAncestor(path), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, root = REPO } = {}) {
  const [flag, out, ...rest] = argv;
  if (rest.length || !['--out', '--print-once'].includes(flag) || (flag === '--out' && !out) || (flag === '--print-once' && out)) {
    stderr.write('usage: public-target-keygen.mjs --out <path> | --print-once\n');
    return 2;
  }
  const key = generateSigningKey();
  const credential = `${JSON.stringify({ privateKey: key.privateKey })}\n`;
  if (flag === '--out') {
    if (insideRoot(out, root)) {
      stderr.write('public-target-keygen: refused: the key would be inside the repository; choose an operator path outside it\n');
      return 1;
    }
    const worktree = gitWorktreeOf(out);
    if (worktree) {
      stderr.write(`public-target-keygen: refused: the key would be inside a git worktree (${worktree}); choose an operator path outside any repository\n`);
      return 1;
    }
    let fd;
    try {
      fd = openSync(out, 'wx', 0o600); // exclusive: never overwrite a key
    } catch (err) {
      stderr.write(`public-target-keygen: refused: cannot create ${out} (${err.code})\n`);
      return 1;
    }
    try {
      writeSync(fd, credential);
    } finally {
      closeSync(fd);
    }
  } else {
    stdout.write(credential);
  }
  stderr.write(`publisher_public_key = "${key.publicKey}"\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
