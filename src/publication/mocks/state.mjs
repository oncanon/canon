// Mock endpoint state: in memory, or persisted as one JSON file in a local state
// directory so that separate CLI invocations (publish, then promote) see the same
// mock provider. Local files only; never a network location.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mockState({ stateDir = null, init }) {
  const file = stateDir ? join(stateDir, 'mock-state.json') : null;
  let state;
  if (file) {
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      state = init();
    }
  } else {
    state = init();
  }
  return {
    state,
    save() {
      if (!file) return;
      mkdirSync(stateDir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, file);
    },
  };
}

// Headers the V1 server sets on every response (docs/v2/publication-protocol.md §2).
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export const json = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(value)) });

// Range: a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range, as the V2 serving
// contract requires (206 with Content-Range, 416 when unsatisfiable).
export function applyRange(rangeHeader, bytes) {
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return { status: 416 };
  let start;
  let end;
  if (m[1] === '') { start = Math.max(0, bytes.length - Number(m[2])); end = bytes.length - 1; } else { start = Number(m[1]); end = m[2] === '' ? bytes.length - 1 : Math.min(Number(m[2]), bytes.length - 1); }
  if (start > end || start >= bytes.length) return { status: 416 };
  return { status: 206, body: bytes.subarray(start, end + 1), contentRange: `bytes ${start}-${end}/${bytes.length}` };
}
