import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

export const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const FIXTURE = join(REPO, 'fixtures/report/phase1-review.report.json');
export const CLI = join(REPO, 'src/cli.mjs');

// Every temporary directory this process created through tempDir, until it is removed.
// Tests remove only the directories they created themselves: each one in its test's
// after-hook and, if the process ends before those hooks run (process.exit, an uncaught
// error), synchronously on exit. Nothing else in the temporary directory is touched.
const createdTempDirs = new Set();
process.once('exit', () => {
  for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
});

export async function tempDir(t, label = 'canon') {
  const dir = await mkdtemp(join(tmpdir(), `${label}-`));
  createdTempDirs.add(dir);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    createdTempDirs.delete(dir);
  });
  return dir;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Rebuilds a packet in an isolated copy of src/ and fixtures/, with package.json's version
// patched to `version`, and returns the real contentId that build produces.
//
// render-policy/1 reads TOOL (name/version/securityPolicy) from policy.mjs at import time
// and bakes TOOL.version into index.html (the generator meta tag and the "Sealed by Canon"
// line); assemblePacket refuses any other `tool` for render-policy/1 (src/packet/build.mjs:
// "a recorded tool applies only to render-policy/2 reproduction"). So patching a built
// manifest's build.version field by hand is not enough to reproduce a past version's content
// ID: the rendered HTML bytes, not only the manifest, changed. The only faithful rebuild is
// to actually run the renderer under that version. The patch lives on a private temporary
// copy, never the shared tree (AGENTS.md: mutation experiments run on copies, run
// sequentially), and is torn down with the temp directory.
export async function contentIdBuiltAtVersion(t, version, { reportPath = FIXTURE, renderPolicy } = {}) {
  const dir = await tempDir(t, 'canon-golden-version');
  await cp(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
  await cp(join(REPO, 'fixtures'), join(dir, 'fixtures'), { recursive: true });
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  pkg.version = version;
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const runner = join(dir, 'run-build.mjs');
  await writeFile(runner, [
    "import { buildPacket } from './src/packet/build.mjs';",
    'const [, , reportPath, renderPolicy] = process.argv;',
    'const pkt = await buildPacket({ reportPath, renderPolicy: renderPolicy || undefined });',
    'process.stdout.write(pkt.contentId);',
    '',
  ].join('\n'));
  const reportPathInCopy = join(dir, relative(REPO, reportPath));
  const r = spawnSync(process.execPath, [runner, reportPathInCopy, renderPolicy ?? ''], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`rebuild at version ${version} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

// Map of relative path -> sha256 for every regular file under dir.
export async function treeDigest(dir) {
  const out = {};
  async function walk(d) {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out[relative(dir, abs)] = sha256(await readFile(abs));
      else out[relative(dir, abs)] = `special:${entry.isSymbolicLink() ? 'symlink' : 'other'}`;
    }
  }
  await walk(dir);
  return out;
}

export function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export async function copyPacket(src, dest) {
  await cp(src, dest, { recursive: true });
  // Published packets are read-only; working copies for tamper tests are made writable.
  const { chmod } = await import('node:fs/promises');
  async function walk(d) {
    await chmod(d, 0o755);
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile()) await chmod(join(d, e.name), 0o644);
    }
  }
  await walk(dest);
  return dest;
}

// Live tailnet binds are opt-in only (npm run test:tailnet sets CANON_LIVE_TAILNET=1).
export function liveTailnet() {
  return process.env.CANON_LIVE_TAILNET === '1';
}

export async function exists(p) {
  return Boolean(await stat(p).catch(() => null));
}
