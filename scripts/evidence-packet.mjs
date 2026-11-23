#!/usr/bin/env node
// V2.1 slice 05: the only way to build a review packet from live-run evidence. The secret gate
// (scripts/secret-gate.mjs) runs first, over the report's whole source directory (everything the
// packet could include) and over any evidence root named with --evidence; the packet is built
// only if every scan is clean. A gate finding or instrument failure builds nothing.
//
//   node scripts/evidence-packet.mjs --report <report.json> --out <packet-dir> [--evidence <dir>]...
// Exit: 0 built, 1 refused (credentials found), 3 refused (gate instrument failure), 2 usage.
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPacket } from '../src/packet/build.mjs';
import { EXIT as GATE, scanTree } from './secret-gate.mjs';

export async function gatedBuild({ reportPath, outDir, evidenceDirs = [] }) {
  const roots = [...new Set([dirname(resolve(reportPath)), ...evidenceDirs.map((d) => resolve(d))])];
  const scans = roots.map((root) => ({ root, ...scanTree(root) }));
  const blocked = scans.filter((s) => s.exit !== GATE.clean);
  if (blocked.length) {
    const exit = blocked.some((s) => s.exit === GATE.found) ? GATE.found : GATE.instrument;
    return { exit, built: false, scans };
  }
  const built = await buildPacket({ reportPath, outDir });
  return { exit: 0, built: true, contentId: built.contentId, outDir: built.outDir, scans };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const evidenceDirs = argv.flatMap((a, i) => (a === '--evidence' ? [argv[i + 1]] : []));
  if (!opt('--report') || !opt('--out')) {
    process.stderr.write('usage: evidence-packet.mjs --report <report.json> --out <packet-dir> [--evidence <dir>]...\n');
    process.exit(2);
  }
  const r = await gatedBuild({ reportPath: opt('--report'), outDir: opt('--out'), evidenceDirs });
  const summary = r.scans.map((s) => ({ root: s.root, scanned: s.scanned, members: s.members, findings: s.findings, unscannable: s.unscannable, instrument: s.instrument }));
  process.stdout.write(`${JSON.stringify({ built: r.built, contentId: r.contentId ?? null, gate: summary }, null, 2)}\n`);
  if (!r.built) process.stderr.write('evidence-packet: REFUSED: the secret gate did not pass; nothing was built\n');
  process.exit(r.exit);
}
