// Fixture for test/unit/temp-cleanup.test.mjs; not part of `npm test`. It creates temporary
// directories through the shared tempDir helper and then ends abnormally, as selected by
// CANON_TEST_ABORT: 'exit' calls process.exit mid-test (after-hooks never run), 'throw'
// fails the test, anything else passes. No directory it created may be left behind.
import test from 'node:test';
import { tempDir } from '../helpers.mjs';

test('tempdir fixture', async (t) => {
  await tempDir(t, 'canon-fixture-a');
  await tempDir(t, 'canon-fixture-b');
  if (process.env.CANON_TEST_ABORT === 'exit') process.exit(3);
  if (process.env.CANON_TEST_ABORT === 'throw') throw new Error('fixture failure');
});
