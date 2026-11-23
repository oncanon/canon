// A temporary copy of the tree with files the shipped tree does not have yet, for tests of
// inputs that render-policy/2 reproduction reads only from their shipped place (R11): the
// brand lockups in src/presentation/marks/. A policy/2 build seals only the shipped renderer
// inputs, so a lockup packet that verifies can only come from a tree that ships the lockups.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, tempDir } from '../helpers.mjs';

// marks: { 'lockup-ui.svg': text, 'lockup-display.svg': text } installed as the shipped marks.
export async function treeWithMarks(t, marks) {
  const root = join(await tempDir(t, 'canon-tree'), 'tree');
  await mkdir(join(root, 'test'), { recursive: true });
  await cp(join(REPO, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(REPO, 'package.json'), join(root, 'package.json'));
  await cp(join(REPO, 'test/tree'), join(root, 'test/tree'), { recursive: true });
  await symlink(join(REPO, 'node_modules'), join(root, 'node_modules'));
  for (const [file, text] of Object.entries(marks)) await writeFile(join(root, 'src/presentation/marks', file), text);
  return root;
}

// Build reportPath into outDir with that tree, then run that tree's full verify.
// Returns { contentId, full: { ok, errors } } or { error: { code, message } }.
export function buildInTree(root, { reportPath, outDir, renderPolicy = 'render-policy/2', marksDir = null }) {
  const r = spawnSync(process.execPath, [join(root, 'test/tree/build-driver.mjs'), reportPath, outDir, renderPolicy, ...(marksDir ? [marksDir] : [])], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`build-driver exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
