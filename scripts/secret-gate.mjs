#!/usr/bin/env node
// V2.1 slice 05: the secret gate. It runs over an evidence tree before ANY packet is built
// from it (scripts/evidence-packet.mjs refuses to build otherwise). It exists because the live
// fire's capture stored live Access session cookies in evidence (F-LF-1).
//
// It scans every file, and every member of a ZIP file (an OpenTofu .tfplan is a ZIP), for the
// credential families below and prints file, line, family and LENGTH only, never a value.
// Before scanning, it proves itself: a planted sample of every family, built at run time,
// must be detected, or the gate fails as an instrument failure (a blind gate never passes).
// A file it cannot scan (too large, a ZIP it cannot read) fails the gate too.
//
//   node scripts/secret-gate.mjs <evidence-dir>
// Exit: 0 clean, 1 credentials found, 3 instrument failure or unscannable file, 2 usage.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const EXIT = { clean: 0, found: 1, usage: 2, instrument: 3 };
const MAX_FILE = 64 * 1024 * 1024;
const NOT_REDACTED = '(?!<REDACTED|<stripped|REDACTED|\\*\\*\\*)';

export const FAMILIES = {
  jwt: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  'access-cookie': new RegExp(`\\b(?:CF_Authorization|CF_AppSession|CF_Binding|CF_Session)=${NOT_REDACTED}[^;\\s"']{8,}`, 'i'),
  bearer: new RegExp(`\\bbearer\\s+${NOT_REDACTED}[A-Za-z0-9._~+/=-]{20,}`, 'i'),
  'access-client-secret': new RegExp(`(?:cf-access-client-secret|clientSecret|client_secret)["']?\\s*[:=]\\s*["']?${NOT_REDACTED}[A-Za-z0-9._~+/=-]{24,}`, 'i'),
  'cloudflare-api-token': new RegExp(`(?:CLOUDFLARE_API_TOKEN|api_token|apiToken)["']?\\s*[:=]\\s*["']?${NOT_REDACTED}[A-Za-z0-9_-]{40}\\b`),
  'aws-access-key': /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  'access-login-query': /cloudflareaccess\.com\/cdn-cgi\/access\/login\/[^\s?"']*\?[^\s"']{16,}/,
  // V2.1 slice 04: the public target's publisher signing key (scripts/public-target-keygen.mjs),
  // and any Ed25519 PKCS#8 key in base64 or base64url (its DER header is fixed, so an RPK-era
  // `rpk-ed25519-sk:` key file is still caught).
  'publisher-signing-key': /canon-ed25519-sk:[A-Za-z0-9_-]{40,}|MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/_-]{20,}/,
};

// Planted samples, built at run time so no credential-shaped literal sits in the repository.
export function plants() {
  const r = (n, c = 'x') => c.repeat(n);
  return {
    jwt: `eyJ${r(12, 'a')}.eyJ${r(12, 'b')}.${r(16, 'c')}`,
    'access-cookie': `set-cookie: CF_Authorization=${r(24, 'q')}; Path=/`,
    bearer: `authorization: Bearer ${r(32, 'z')}`,
    'access-client-secret': `cf-access-client-secret: ${r(40, 'k')}`,
    'cloudflare-api-token': `CLOUDFLARE_API_TOKEN=${r(40, 't')}`,
    'aws-access-key': `AKIA${r(16, 'Q')}`,
    'private-key': `-----BEGIN ${'PRIVATE'} KEY-----`,
    'access-login-query': `location: https://team.cloudflareaccess.com/cdn-cgi/access/login/app?kid=${r(20, 'm')}`,
    'publisher-signing-key': `{"privateKey":"${'canon-ed25519-'}sk:${r(64, 's')}"}`,
  };
}

// The instrument check: every family must catch its own plant.
export function instrumentCheck() {
  const p = plants();
  return Object.keys(FAMILIES).filter((f) => !FAMILIES[f].test(p[f]));
}

export function scanText(text) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const [family, re] of Object.entries(FAMILIES)) {
      const m = re.exec(line);
      if (m) findings.push({ line: i + 1, family, length: m[0].length });
    }
  });
  return findings;
}

// Minimal ZIP reader (stored and deflated members, no ZIP64): enough for .tfplan files.
export function zipMembers(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no ZIP end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 is not supported');
  const members = [];
  for (let k = 0; k < count; k += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) members.push({ name, data: raw });
    else if (method === 8) members.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`member ${name}: compression method ${method} is not supported`);
  }
  return members;
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

// Scan a directory tree. Returns { exit, scanned, members, findings, unscannable, instrument }.
export function scanTree(root) {
  const instrument = instrumentCheck();
  if (instrument.length) return { exit: EXIT.instrument, instrument, scanned: 0, members: 0, findings: [], unscannable: [] };
  const findings = [];
  const unscannable = [];
  let scanned = 0;
  let members = 0;
  for (const path of files(root).sort()) {
    const rel = relative(root, path);
    if (statSync(path).size > MAX_FILE) { unscannable.push({ file: rel, why: 'larger than 64 MiB' }); continue; }
    const buf = readFileSync(path);
    scanned += 1;
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
      try {
        for (const m of zipMembers(buf)) {
          members += 1;
          for (const f of scanText(m.data.toString('utf8'))) findings.push({ file: rel, member: m.name, ...f });
        }
      } catch (err) {
        unscannable.push({ file: rel, why: `ZIP: ${err.message}` });
      }
      continue;
    }
    for (const f of scanText(buf.toString('utf8'))) findings.push({ file: rel, ...f });
  }
  const exit = findings.length ? EXIT.found : unscannable.length ? EXIT.instrument : EXIT.clean;
  return { exit, scanned, members, findings, unscannable, instrument };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root || process.argv.length > 3) {
    process.stderr.write('usage: secret-gate.mjs <evidence-dir>\n');
    process.exit(EXIT.usage);
  }
  const r = scanTree(root);
  process.stdout.write(`${JSON.stringify({ verdict: ['clean', 'CREDENTIALS FOUND', 'usage', 'INSTRUMENT FAILURE'][r.exit], ...r }, null, 2)}\n`);
  process.exit(r.exit);
}
