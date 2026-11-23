#!/usr/bin/env node
// Points the Homebrew tap (oncanon/homebrew-tap) at a new release.
// The release workflow runs this inside a checkout of the tap; see docs/operations/release.md.
//
//   node scripts/release/tap-bump.mjs --tap <dir> --version 0.2.0 \
//     --formula-sha256 <sha of canon-0.2.0.tgz> --cask-sha256 <sha of Canon-0.2.0.zip> [--check]
// --check computes the change and fails on a bad or older version, without writing.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const FORMULA_URL = (version) => `https://github.com/oncanon/canon/releases/download/v${version}/canon-${version}.tgz`;

function check({ version, sha256 }) {
  if (!SEMVER.test(version)) throw new Error(`version is not SemVer: ${version}`);
  if (!SHA256.test(sha256)) throw new Error(`sha256 must be 64 lowercase hex characters: ${sha256}`);
}

// Release versions are vX.Y.Z (release.yml checks the tag), so numeric fields decide order.
function compareVersions(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function refuseOlder(current, next, what) {
  if (current && compareVersions(next, current) < 0) throw new Error(`${what} is at ${current}; refusing to move it to the older ${next}`);
}

function replaceOnce(text, pattern, replacement, what) {
  const hits = text.match(new RegExp(pattern.source, 'gm')) ?? [];
  if (hits.length !== 1) throw new Error(`expected exactly one ${what} line, found ${hits.length}`);
  return text.replace(new RegExp(pattern.source, 'm'), replacement);
}

/** Formula/canon.rb: the version lives in the url, which Homebrew parses. */
export function bumpFormula(text, release) {
  check(release);
  refuseOlder(/^  url ".*\/canon-(\d+\.\d+\.\d+[^"]*)\.tgz"$/m.exec(text)?.[1], release.version, 'Formula/canon.rb');
  let out = replaceOnce(text, /^  url ".*"$/, `  url "${FORMULA_URL(release.version)}"`, 'url');
  out = replaceOnce(out, /^  sha256 ".*"$/, `  sha256 "${release.sha256}"`, 'sha256');
  return out;
}

/** Casks/canon-app.rb: the url interpolates #{version}. */
export function bumpCask(text, release) {
  check(release);
  refuseOlder(/^  version "(.*)"$/m.exec(text)?.[1], release.version, 'Casks/canon-app.rb');
  let out = replaceOnce(text, /^  version ".*"$/, `  version "${release.version}"`, 'version');
  out = replaceOnce(out, /^  sha256 ".*"$/, `  sha256 "${release.sha256}"`, 'sha256');
  return out;
}

async function rewrite(path, bump, release, write) {
  const before = await readFile(path, 'utf8');
  const after = bump(before, release);
  if (write && after !== before) await writeFile(path, after);
  return after !== before;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tap: { type: 'string' },
      version: { type: 'string' },
      'formula-sha256': { type: 'string' },
      'cask-sha256': { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  for (const key of ['tap', 'version', 'formula-sha256', 'cask-sha256']) {
    if (!values[key]) throw new Error(`missing --${key}`);
  }
  const write = !values.check;
  const formula = await rewrite(join(values.tap, 'Formula/canon.rb'), bumpFormula, { version: values.version, sha256: values['formula-sha256'] }, write);
  const cask = await rewrite(join(values.tap, 'Casks/canon-app.rb'), bumpCask, { version: values.version, sha256: values['cask-sha256'] }, write);
  const verb = (changed) => (changed ? (write ? 'updated' : 'would update') : 'unchanged');
  process.stdout.write(`tap: formula ${verb(formula)}, cask ${verb(cask)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
