// Publishes <packet> into <root> and prints the outcome; used for race tests.
import { publishPacket } from '../../src/publish/filesystem.mjs';

const [packetDir, root] = process.argv.slice(2);
try {
  const r = await publishPacket({ packetDir, root });
  process.stdout.write(`${JSON.stringify({ outcome: r.outcome, contentId: r.contentId })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err.code ?? err.message })}\n`);
  process.exit(1);
}
