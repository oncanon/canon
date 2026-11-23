// Child-process build used by determinism tests: builds <report> into <out> and
// prints the content ID. Run with differing cwd, TZ, env order, TMPDIR and clock.
import { buildPacket } from '../../src/packet/build.mjs';

const [reportPath, outDir] = process.argv.slice(2);
const result = await buildPacket({ reportPath, outDir });
process.stdout.write(`${JSON.stringify({ contentId: result.contentId, now: Date.now(), cwd: process.cwd(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}\n`);
