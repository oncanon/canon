// Attempts one compare-and-swap alias update, retrying only while another writer
// holds the lock (as a real client would), so races are decided by the
// generation check rather than by lock contention. Prints the final result.
import { setAlias } from '../../src/alias/alias.mjs';

const [root, name, contentId, expect] = process.argv.slice(2);
let lockedRetries = 0;
for (;;) {
  try {
    const r = await setAlias({ root, name, contentId, expectGeneration: Number(expect) });
    process.stdout.write(`${JSON.stringify({ ok: true, generation: r.generation, contentId: r.contentId, lockedRetries })}\n`);
    break;
  } catch (err) {
    if (err.code === 'alias-locked' && lockedRetries < 500) {
      lockedRetries += 1;
      await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 5)));
      continue;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? err.message, lockedRetries })}\n`);
    break;
  }
}
