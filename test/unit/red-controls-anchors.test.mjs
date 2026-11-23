// N-V21-4 (V2.1-QA-1 remediation): every red control's find string occurs exactly once in its file.
// This check reads every control's file, so it lives in its own test file: a control that names it
// needs the whole tree in its scratch copy, while the harness tests other controls use do not.
// The check itself is anchorProblems in scripts/red-controls.mjs: main (V2.1) and the AP.8 S3
// follow-ups each wrote this guard, and the integration branch keeps one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { anchorProblems, CONTROLS } from '../../scripts/red-controls.mjs';

test('[V2.1-04] every control\'s find string occurs exactly once in its file, and a planted duplicate is refused', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { REPO } = await import('../helpers.mjs');
  assert.ok(CONTROLS.length > 300, 'the table was read');
  assert.deepEqual(anchorProblems(CONTROLS, (f) => readFileSync(join(REPO, f), 'utf8')), []);
  assert.deepEqual(anchorProblems(), [], 'and by its own defaults, as the runner calls it');
  const planted = [{ id: 'X0', file: 'a.md', find: 'once' }, { id: 'X1', file: 'a.md', find: 'row' }, { id: 'X2', file: 'b.md', find: 'gone' }, { id: 'X3', file: 'c.md', find: 'row' }];
  const files = { 'a.md': 'once\nrow\nrow\n', 'b.md': 'nothing' };
  assert.deepEqual(anchorProblems(planted, (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; }), ['X1: its find occurs 2 times in a.md', 'X2: its find occurs 0 times in b.md', 'X3: its find occurs nowhere (file missing) in c.md']);
});
