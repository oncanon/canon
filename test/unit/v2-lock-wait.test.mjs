// The concurrent-promoter lock wait (test/v2/lock-wait.mjs; the lead's ruling 2026-10-04 08:56Z). The earlier
// waits gave up after 5000 event-loop turns, which is about 70 ms, so a winner holding the lock longer (under
// load) made an UNMUTATED tree fail V2-4 and V2-6. This is that reproduction, deterministic: a lock held well
// past the old bound must be waited for, and the wait must still fail loudly at its failsafe.
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockReleased } from '../v2/lock-wait.mjs';

test('[V2-4] the lock wait resolves on the release itself, however long the holder takes: a lock held 1.5 s (past the old 5000-turn bound) is waited for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rp-lockwait-'));
  try {
    const lock = join(dir, 'review.lock');
    await writeFile(lock, `${process.pid}\n`);
    const t0 = Date.now();
    const release = new Promise((r) => setTimeout(() => unlink(lock).then(r), 1500));
    await lockReleased(lock);
    const waited = Date.now() - t0;
    assert.ok(waited >= 1400, `resolved only after the release (${waited} ms)`);
    await release;
    assert.equal(await access(lock).then(() => true, () => false), false, 'the lock is gone when the wait resolves');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[V2-4] the lock wait fails loudly at its failsafe, never silently, when the lock is never released', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rp-lockwait-'));
  try {
    const lock = join(dir, 'review.lock');
    await writeFile(lock, `${process.pid}\n`);
    await assert.rejects(lockReleased(lock, { failsafeMs: 300 }), /was not released within 300 ms \(failsafe\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
