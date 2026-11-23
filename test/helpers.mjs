import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
