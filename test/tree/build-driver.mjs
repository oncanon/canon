// Build one packet with the tree this file sits in, then run that tree's full verify on it.
// test/tree/shipped-tree.mjs copies src/ into a temporary tree, installs files the shipped
// tree does not have yet (brand lockups in src/presentation/marks/), and runs this driver
// there; its imports are relative, so they reach the copy's src/. Prints one JSON line.
//
// usage: node build-driver.mjs <report.json> <out-dir> <render-policy> [<marks-dir>]
import { resolve } from 'node:path';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacketFull } from '../../src/packet/reproduce.mjs';

const [report, out, renderPolicy, marksDir] = process.argv.slice(2);
try {
  const built = await buildPacket({ reportPath: resolve(report), outDir: resolve(out), renderPolicy, ...(marksDir ? { marksDir: resolve(marksDir) } : {}) });
  const full = await verifyPacketFull(resolve(out));
  console.log(JSON.stringify({ contentId: built.contentId, full: { ok: full.ok, errors: full.errors } }));
} catch (err) {
  console.log(JSON.stringify({ error: { code: err.code ?? null, message: err.message } }));
}
