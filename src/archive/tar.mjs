// Deterministic POSIX ustar archive of a verified packet (docs/decisions/phase1-contract.md D3).
// Entries: the packet's own files and its two directories, sorted by path bytes,
// at the archive root; mode 0644/0755, uid/gid 0, empty owner names, mtime 0,
// no compression. The same packet always yields the same archive bytes.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Full verify: independent rules plus, for render-policy/2, reproduction (R11).
import { verifyPacketFull as verifyPacket } from '../packet/reproduce.mjs';

const BLOCK = 512;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name, { size, type }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

export async function archivePacket(packetDir) {
  const check = await verifyPacket(packetDir);
  if (!check.ok) throw new Error(`refusing to archive a packet that does not verify: ${check.errors.map((e) => e.code).join(', ')}`);
  const manifest = JSON.parse(await readFile(join(packetDir, 'manifest.json'), 'utf8'));
  const files = [...manifest.files.map((f) => f.path), 'manifest.json', 'checksums.json'];
  const dirs = new Set(files.filter((p) => p.includes('/')).map((p) => `${p.slice(0, p.indexOf('/'))}/`));
  const entries = [...dirs, ...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const chunks = [];
  for (const name of entries) {
    if (name.endsWith('/')) {
      chunks.push(header(name, { size: 0, type: '5' }));
      continue;
    }
    const data = await readFile(join(packetDir, name));
    chunks.push(header(name, { size: data.length, type: '0' }), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return { contentId: check.contentId, bytes: Buffer.concat(chunks) };
}
