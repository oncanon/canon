// V2-QA-6 addendum (d): tests leave no temporary directories behind. Each case runs a test
// file in a fresh private TMPDIR (created and removed by this test) and requires that
// TMPDIR to be empty afterwards, apart from Node's own compile cache.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

function leftovers(file, env = {}, extra = []) {
  const priv = mkdtempSync(join(tmpdir(), 'canon-cleanup-test-'));
  try {
    const childEnv = { ...process.env, ...env, TMPDIR: priv, CANON_LOOPBACK_ONLY: '1' };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...extra, file], { cwd: REPO, encoding: 'utf8', env: childEnv, maxBuffer: 1 << 26 });
    return { status: r.status, left: readdirSync(priv).filter((n) => n !== 'node-compile-cache'), out: r.stdout };
  } finally {
    rmSync(priv, { recursive: true, force: true });
  }
}

test('[V2-QA-6] the markdown property tests leave no canon-md-prop directories', () => {
  const r = leftovers('test/unit/e2-markdown-safety-property.test.mjs', {}, ['--test-name-pattern', 'multi-line adversarial']);
  assert.equal(r.status, 0, r.out.slice(-2000));
  assert.match(r.out, /^# pass [1-9]/m, 'the selected tests ran');
  assert.deepEqual(r.left, []);
});

for (const mode of ['pass', 'throw', 'exit']) {
  test(`[V2-QA-6] tempDir leaves nothing behind when a test ${mode === 'pass' ? 'passes' : mode === 'throw' ? 'throws' : 'calls process.exit mid-test'}`, () => {
    const r = leftovers('test/harness-fixtures/tempdir-abort.test.mjs', { CANON_TEST_ABORT: mode });
    assert.equal(r.status === 0, mode === 'pass', `exit status ${r.status}`);
    assert.deepEqual(r.left, []);
  });
}
