import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { REPO, tempDir, treeDigest } from '../helpers.mjs';

const CHILD = join(REPO, 'test/support/build-child.mjs');
const SKEW = join(REPO, 'test/support/skew-clock.mjs');

function shuffledEnv(base, order, extra) {
  const entries = Object.entries({ ...base, ...extra });
  if (order === 'reversed') entries.reverse();
  if (order === 'rotated') entries.push(...entries.splice(0, Math.floor(entries.length / 2)));
  return Object.fromEntries(entries);
}

test('[P2] clean builds under different cwd, source path, TZ, locale, env order, temp dir and clock are byte-identical', async (t) => {
  const root = await tempDir(t, 'canon-p2');
  const variants = [
    { name: 'a', tz: 'UTC', lang: 'C', order: 'forward', skew: false },
    { name: 'b', tz: 'America/Chicago', lang: 'de_DE.UTF-8', order: 'reversed', skew: true },
    { name: 'c', tz: 'Asia/Kolkata', lang: 'ja_JP.UTF-8', order: 'rotated', skew: false },
  ];
  const results = [];
  for (const v of variants) {
    // Each build reads its own copy of the source from a different machine path.
    const src = join(root, `source-${v.name}`, 'deep', 'nested');
    await mkdir(src, { recursive: true });
    await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
    const cwd = join(root, `cwd-${v.name}`);
    const tmp = join(root, `tmp-${v.name}`);
    await mkdir(cwd); await mkdir(tmp);
    const out = join(root, `out-${v.name}`);
    const env = shuffledEnv(process.env, v.order, { TZ: v.tz, LANG: v.lang, LC_ALL: v.lang, TMPDIR: tmp, CANON_VARIANT: v.name });
    const args = [...(v.skew ? ['--import', SKEW] : []), CHILD, join(src, 'phase1-review.report.json'), out];
    const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const info = JSON.parse(r.stdout);
    results.push({ ...info, tree: await treeDigest(out) });
  }
  assert.ok(results[1].now - results[0].now > 10 * 365 * 24 * 3600 * 1000, 'clock skew preload took effect');
  assert.notEqual(results[0].tz, results[1].tz, 'time zone varied');
  assert.equal(new Set(results.map((r) => r.cwd)).size, 3, 'cwd varied');
  assert.equal(new Set(results.map((r) => r.contentId)).size, 1, `content IDs differ: ${results.map((r) => r.contentId)}`);
  assert.deepEqual(results[1].tree, results[0].tree);
  assert.deepEqual(results[2].tree, results[0].tree);
  t.diagnostic(`contentId=${results[0].contentId}`);
});

test('[P2] a changed input changes the content ID (the identity check is live)', async (t) => {
  const root = await tempDir(t, 'canon-p2b');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const { readFile, writeFile } = await import('node:fs/promises');
  const run = (out) => JSON.parse(spawnSync(process.execPath, [CHILD, join(src, 'phase1-review.report.json'), out], { encoding: 'utf8' }).stdout).contentId;
  const before = run(join(root, 'o1'));
  const logPath = join(src, 'evidence/build-determinism.txt');
  await writeFile(logPath, `${await readFile(logPath, 'utf8')}one more byte\n`);
  const after = run(join(root, 'o2'));
  assert.notEqual(before, after);
});
