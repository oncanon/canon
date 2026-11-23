// V2.1 slice 05: safe capture and the secret gate. F-LF-1 reproduced: a loopback server
// answers like the live Worker behind Access (a CF_Authorization JWT cookie, a signed login
// redirect); a raw capture of it fails the gate, and cf-capture strips it at the source.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { capture, sanitizeHeaders } from '../../scripts/cf-capture.mjs';
import { EXIT, FAMILIES, instrumentCheck, plants, scanTree, zipMembers } from '../../scripts/secret-gate.mjs';
import { tempDir } from '../helpers.mjs';

// A JWT-shaped fake built at run time (never a real credential).
const FAKE_JWT = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`;
const FAKE_SECRET = 'k'.repeat(48);

async function accessLikeServer() {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/login-redirect')) {
      res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example?kid=${'m'.repeat(24)}&meta=${'n'.repeat(24)}`, 'set-cookie': `CF_AppSession=${'s'.repeat(24)}; Path=/` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', etag: '"sha256-x"', 'set-cookie': [`CF_Authorization=${FAKE_JWT}; Path=/; Expires=Wed, 30 Sep 2026 00:31:36 GMT; HttpOnly`, 'other=1'] });
    res.end('# report\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('[V2.1-05] the gate proves every family on a planted sample before it scans', () => {
  assert.deepEqual(instrumentCheck(), []);
  const p = plants();
  assert.deepEqual(Object.keys(p).sort(), Object.keys(FAMILIES).sort(), 'one plant per family');
});

test('[V2.1-05] F-LF-1 reproduced: a raw capture of an Access cookie fails the gate; cf-capture strips it at the source', async (t) => {
  const srv = await accessLikeServer();
  try {
    // The live fire's shape: the raw response headers written to evidence.
    const raw = await tempDir(t, 'canon-v21-raw');
    const res = await fetch(`${srv.origin}/a/live-fire/report.md`, { redirect: 'manual' });
    writeFileSync(join(raw, 'alias-md.headers'), `HTTP/1.1 ${res.status}\n${res.headers.getSetCookie().map((c) => `set-cookie: ${c}`).join('\n')}\n`);
    const before = scanTree(raw);
    assert.equal(before.exit, EXIT.found, 'the raw capture is refused');
    assert.ok(before.findings.some((f) => f.family === 'jwt') && before.findings.some((f) => f.family === 'access-cookie'));
    assert.ok(!JSON.stringify(before).includes(FAKE_JWT), 'the gate never prints the value');

    // The same cell through cf-capture, with the service token sent.
    const out = await tempDir(t, 'canon-v21-cap');
    const headers = [['cf-access-client-id', 'client-id.access'], ['cf-access-client-secret', FAKE_SECRET]];
    const r = await capture({ outDir: out, name: 'alias-md', url: 'https://rp-publisher-test.example.workers.dev/a/live-fire/report.md', headers, connectTo: srv.origin });
    assert.equal(r.status, 200);
    assert.equal(r.gate.exit, EXIT.clean, JSON.stringify(r.gate.findings));
    const all = readdirSync(out).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    assert.ok(!all.includes(FAKE_JWT) && !all.includes(FAKE_SECRET), 'no credential value on disk');
    assert.match(readFileSync(join(out, 'alias-md.headers'), 'utf8'), /^set-cookie: <stripped: \d+ bytes>$/m);
    assert.match(readFileSync(join(out, 'alias-md.headers'), 'utf8'), /^etag: "sha256-x"$/m, 'non-credential headers are kept');
    assert.match(readFileSync(join(out, 'alias-md.request'), 'utf8'), /^cf-access-client-secret: <stripped: 48 bytes>$/m, 'the request is recorded, stripped');
    assert.equal(readFileSync(join(out, 'alias-md.body'), 'utf8'), '# report\n', 'the body is kept');

    const redir = await capture({ outDir: out, name: 'unauth', url: 'https://rp-publisher-test.example.workers.dev/login-redirect', connectTo: srv.origin });
    assert.equal(redir.status, 302);
    assert.equal(redir.gate.exit, EXIT.clean);
    assert.match(readFileSync(join(out, 'unauth.headers'), 'utf8'), /^location: https:\/\/team\.cloudflareaccess\.com\/cdn-cgi\/access\/login\/app\.example\?<stripped query>$/m);
  } finally {
    await srv.close();
  }
});

test('[V2.1-05] sanitizeHeaders strips every credential header and nothing else', () => {
  const out = Object.fromEntries(sanitizeHeaders([['Set-Cookie', 'a=b'], ['Authorization', 'Bearer x'], ['CF-Access-Jwt-Assertion', 'y'], ['cookie', 'z'], ['content-type', 'text/html'], ['cf-ray', 'abc']]));
  assert.deepEqual(out, { 'Set-Cookie': '<stripped: 3 bytes>', Authorization: '<stripped: 8 bytes>', 'CF-Access-Jwt-Assertion': '<stripped: 1 bytes>', cookie: '<stripped: 1 bytes>', 'content-type': 'text/html', 'cf-ray': 'abc' });
});

test('[V2.1-05] the gate reads ZIP members (a .tfplan), and an unreadable file fails the gate', async (t) => {
  const dir = await tempDir(t, 'canon-v21-zip');
  // A one-member deflated ZIP, built here, holding a planted token assignment.
  const name = Buffer.from('tfplan');
  const data = Buffer.from(`x\n${plants()['cloudflare-api-token']}\n`);
  const comp = deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, comp, central, name, eocd]);
  assert.equal(zipMembers(zip)[0].data.toString(), data.toString());
  mkdirSync(join(dir, 'plan'));
  writeFileSync(join(dir, 'plan', 'plan.tfplan'), zip);
  const r = scanTree(dir);
  assert.equal(r.exit, EXIT.found);
  assert.deepEqual([r.findings[0].file, r.findings[0].member, r.findings[0].family], ['plan/plan.tfplan', 'tfplan', 'cloudflare-api-token']);
  writeFileSync(join(dir, 'plan', 'plan.tfplan'), Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(8)]));
  assert.equal(scanTree(dir).exit, EXIT.instrument, 'a ZIP it cannot read fails the gate');
});

test('[V2.1-05] redaction markers are not findings; a clean tree passes', async (t) => {
  const dir = await tempDir(t, 'canon-v21-clean');
  writeFileSync(join(dir, 'a.headers'), 'HTTP/1.1 200 OK\nset-cookie: CF_Authorization=<REDACTED ACCESS SESSION COOKIE>\nset-cookie: <stripped: 300 bytes>\n');
  assert.equal(scanTree(dir).exit, EXIT.clean);
});

test('[V2.1-05] a packet is built from evidence only after the secret gate passes; a planted cookie builds nothing', async (t) => {
  const { cp } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { gatedBuild } = await import('../../scripts/evidence-packet.mjs');
  const { REPO } = await import('../helpers.mjs');
  const src = await tempDir(t, 'canon-v21-src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const reportPath = join(src, 'phase1-review.report.json');
  const clean = await gatedBuild({ reportPath, outDir: join(await tempDir(t, 'canon-v21-out'), 'p') });
  assert.equal(clean.exit, 0);
  assert.equal(clean.built, true);
  writeFileSync(join(src, 'stray.headers'), `set-cookie: CF_Authorization=${FAKE_JWT}; Path=/\n`);
  const out = join(await tempDir(t, 'canon-v21-out'), 'p');
  const refused = await gatedBuild({ reportPath, outDir: out });
  assert.equal(refused.exit, EXIT.found);
  assert.equal(refused.built, false);
  assert.equal(existsSync(out), false, 'nothing was written');
});

// N-V21-3: a public target's signed admin request carries x-canon-signature (replayable for 60 s).
test('[V2.1-04] capture strips a signed admin request\'s x-canon-signature and keeps its timestamp', () => {
  const sig = 'A'.repeat(86);
  const out = Object.fromEntries(sanitizeHeaders([['X-Canon-Signature', sig], ['x-canon-timestamp', '1790000000'], ['content-type', 'application/json']]));
  assert.equal(out['X-Canon-Signature'], '<stripped: 86 bytes>');
  assert.equal(out['x-canon-timestamp'], '1790000000');
  assert.equal(out['content-type'], 'application/json');
});
