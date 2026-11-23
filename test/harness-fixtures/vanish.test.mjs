// Fixture for the red-control harness's phase tests (test/unit/red-controls-harness.test.mjs);
// not part of `npm test`. Its control's mutation (pristine -> MUTATED) is inert: this test
// passes either way, so the control must never read red. When CANON_TEST_VANISH_PHASE names
// the current phase, it signals an external watcher (via .canon-vanish-now) and waits for the
// watcher to delete this scratch copy; reading the target then fails, which is exactly the
// wrong-reason failure the harness must not count as red.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

test('harness fixture: an inert check that only a vanished copy can fail', async () => {
  const phase = readFileSync('test/harness-fixtures/target.txt', 'utf8').includes('MUTATED') ? 'mutated' : 'baseline';
  if (process.env.CANON_TEST_VANISH_PHASE === phase) {
    writeFileSync('.canon-vanish-now', phase);
    // Wait for the watcher's act (it removes the signal, or the whole copy), not for a fixed
    // time (R152). The caller starts the watcher and waits for its "ready" before this run,
    // so it is already polling. The ceiling only turns a dead watcher into a loud failure,
    // never into a silent pass.
    const limit = Date.now() + 300_000;
    while (existsSync('.canon-vanish-now')) {
      if (Date.now() > limit) throw new Error('the watcher never acted on .canon-vanish-now (waited 300 s)');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.match(readFileSync('test/harness-fixtures/target.txt', 'utf8'), /pristine|MUTATED/);
});
