// Wait for an fs alias writer's lock file to be RELEASED (src/alias/alias.mjs takes it O_CREAT|O_EXCL and
// unlinks it on release). Used as the retry backoff of concurrent promoters in V2-4 (v2-contract) and in the
// fault matrix's aliasRace (V2-6).
//
// The previous waits polled for the file's absence on setImmediate and GAVE UP after 5000 turns: a bound in
// event-loop turns (about 70 ms on this host), not in the lock's release. Under CPU load the winning writer's
// I/O outlasted it, the loser threw "alias lock was never released" instead of reaching ALIAS_CONFLICT, and an
// UNMUTATED tree failed (the R69, R81 and R112 baseline flakes; the lead's ruling 2026-10-04 08:56Z).
//
// This wait resolves on the release condition itself: the lock file is gone. It re-checks that condition on a
// short timer cadence and never gives up while the lock is legitimately held, however long the holder takes;
// the only bound is a failsafe deadline that fails loudly, and it is never the condition the wait relies on.
// (A directory watch was tried as the signal and rejected: on macOS a watch armed through a symbolic link gets
// no event at all, and under this host's load an event through the real path arrived about 14 s late.)
import { access } from 'node:fs/promises';
import { basename } from 'node:path';

export const LOCK_WAIT_FAILSAFE_MS = 60_000;
export const LOCK_WAIT_CADENCE_MS = 5;

export async function lockReleased(lockPath, { failsafeMs = LOCK_WAIT_FAILSAFE_MS, cadenceMs = LOCK_WAIT_CADENCE_MS } = {}) {
  const deadline = Date.now() + failsafeMs;
  for (;;) {
    if (await access(lockPath).then(() => false, () => true)) return;
    if (Date.now() >= deadline) throw new Error(`the alias lock ${basename(lockPath)} was not released within ${failsafeMs} ms (failsafe)`);
    await new Promise((r) => setTimeout(r, cadenceMs));
  }
}
