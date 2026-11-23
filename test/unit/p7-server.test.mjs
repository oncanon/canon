import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { appendFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { CSP } from '../../src/policy.mjs';
import { parseRequestPath, startServer } from '../../src/server/server.mjs';
import { CLI, FIXTURE, tempDir } from '../helpers.mjs';

async function served(t) {
  const dir = await tempDir(t, 'canon-p7');
  const store = join(dir, 'store');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'pkt') });
  await publishPacket({ packetDir: join(dir, 'pkt'), root: store });
  await setAlias({ root: store, name: 'review', contentId: built.contentId, expectGeneration: 0 });
  const srv = await startServer({ root: store });
  t.after(() => srv.server.close());
  return { ...srv, store, id: built.contentId, manifest: built.manifest };
}

// Raw request so the path reaches the server exactly as written (fetch would normalize it).
function raw(url, path, { method = 'GET', headers = {}, setHost = true } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers, setHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Exact bytes on the wire, for cases an HTTP client library would rewrite
// (missing or empty Host). Returns the status code from the response line.
function wire(url, lines) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = connect({ host: u.hostname, port: Number(u.port) }, () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(Number(data.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? NaN)));
    sock.on('error', reject);
  });
}

const EXPECTED_SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

test('[P7] server binds loopback by default and refuses non-loopback hosts', async (t) => {
  const { address, url } = await served(t);
  assert.equal(address.address, '127.0.0.1');
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'localhost', 'example.com']) {
    await assert.rejects(startServer({ root: '/nonexistent', host }), /refusing to bind/, host);
  }
  const v6 = await startServer({ root: '/nonexistent', host: '::1' }).catch((e) => e);
  if (v6 instanceof Error) t.diagnostic(`::1 unavailable on this host: ${v6.message}`);
  else { assert.equal(v6.address.address, '::1'); v6.server.close(); }
});

test('[P7] CLI serve listens only on 127.0.0.1 (observed with lsof)', async (t) => {
  const { store } = await served(t);
  const child = spawn(process.execPath, [CLI, 'serve', '--root', store, '--port', '0']);
  t.after(() => child.kill('SIGTERM'));
  const line = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(String(d)));
    child.once('exit', (c) => reject(new Error(`serve exited ${c}`)));
  });
  assert.match(line, /at http:\/\/127\.0\.0\.1:\d+\//);
  const lsof = spawnSync('lsof', ['-a', '-nP', '-iTCP', '-sTCP:LISTEN', '-p', String(child.pid)], { encoding: 'utf8' });
  assert.equal(lsof.status, 0, lsof.stderr);
  const listeners = lsof.stdout.trim().split('\n').slice(1).map((l) => l.split(/\s+/)[8]);
  assert.ok(listeners.length >= 1);
  assert.ok(listeners.every((a) => a.startsWith('127.0.0.1:')), `listeners: ${listeners}`);
  t.diagnostic(`lsof listeners=${listeners.join(',')}`);
});

test('[P7] packet files: correct MIME, length, ETag, immutable cache and security headers', async (t) => {
  const { url, id, manifest } = await served(t);
  for (const f of manifest.files) {
    const r = await raw(url, `/p/${id}/${f.path}`);
    assert.equal(r.status, 200, f.path);
    assert.equal(r.headers['content-type'], f.mediaType);
    assert.equal(Number(r.headers['content-length']), f.bytes);
    assert.equal(r.headers.etag, `"${f.sha256}"`);
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const [k, v] of Object.entries(EXPECTED_SECURITY)) assert.equal(r.headers[k], v, `${k} on ${f.path}`);
  }
  const idx = await raw(url, `/p/${id}/`);
  assert.equal(idx.headers['content-type'], 'text/html; charset=utf-8');
  const bare = await raw(url, `/p/${id}`);
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, `/p/${id}/`);
});

test('[P7] HEAD and conditional GET', async (t) => {
  const { url, id, manifest } = await served(t);
  const css = manifest.files.find((f) => f.role === 'asset');
  const head = await raw(url, `/p/${id}/${css.path}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), css.bytes);
  const cond = await raw(url, `/p/${id}/${css.path}`, { headers: { 'If-None-Match': `"${css.sha256}"` } });
  assert.equal(cond.status, 304);
  assert.equal(cond.body.length, 0);
  assert.equal(cond.headers.etag, `"${css.sha256}"`);
  const miss = await raw(url, `/p/${id}/${css.path}`, { headers: { 'If-None-Match': '"nope"' } });
  assert.equal(miss.status, 200);
  const post = await raw(url, `/p/${id}/`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('[P7] traversal, encoded separators and unknown paths fail without leaking files', async (t) => {
  const { url, id } = await served(t);
  const cases = {
    400: [`/p/${id}/../../aliases/review.json`, `/p/${id}/..%2f..%2faliases/review.json`, `/p/${id}/%2e%2e/%2e%2e/etc/passwd`, `/p/${id}/assets%5c..%5cmanifest.json`, `/p/${id}/index.html%00.css`, '/p//etc/passwd', `/p/${id}/./index.html`, '/a/%2e%2e/'],
    404: ['/', '/etc/passwd', `/p/${id}/nope.html`, `/p/${id}/assets/`, `/p/sha256-${'0'.repeat(64)}/`, '/p/not-an-id/', '/a/missing/', '/a/Bad_Name/', '/receipts/', '/aliases/review.json', '/packets/'],
  };
  for (const [status, paths] of Object.entries(cases)) {
    for (const p of paths) {
      const r = await raw(url, p);
      assert.equal(r.status, Number(status), `${p} -> ${r.status}`);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.ok(!r.body.toString().includes('"schema"'), `${p} leaked JSON`);
    }
  }
  assert.equal(parseRequestPath('/a/../b'), null);
});

test('[P7] a tampered stored file is refused with 500, never served', async (t) => {
  const { url, id, store } = await served(t);
  assert.equal((await raw(url, `/p/${id}/`)).status, 200);
  const file = join(store, 'packets', id, 'index.html');
  await chmod(file, 0o644);
  await appendFile(file, '<script>alert(1)</script>');
  const r = await raw(url, `/p/${id}/`);
  assert.equal(r.status, 500);
  assert.ok(!r.body.toString().includes('<script>'));
});

test('[P7] alias routes: redirect and record are no-store', async (t) => {
  const { url, id } = await served(t);
  const r = await raw(url, '/a/review/');
  assert.equal(r.status, 307);
  assert.equal(r.headers.location, `/p/${id}/`);
  assert.equal(r.headers['cache-control'], 'no-store');
  const j = await raw(url, '/a/review.json');
  assert.equal(j.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(j.body).contentId, id);
});

test('[P7] Host header: only the bound loopback authority and localhost:<port> are served (DNS-rebinding defense)', async (t) => {
  const { url, id, address } = await served(t);
  const port = address.port;
  const routes = [`/p/${id}/`, `/p/${id}/manifest.json`, '/a/review/', '/a/review.json', '/healthz'];
  // Surrounding whitespace is optional whitespace (RFC 9110 OWS) stripped by the HTTP
  // parser, so a padded value names the same authority and is correctly allowed.
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `LocalHost:${port}`, `127.0.0.1:${port} `, ` localhost:${port}`];
  const rejected = [
    'evil.example', `evil.example:${port}`, `attacker.test:${port}`,
    `127.0.0.1:${port + 1}`, `localhost:${port + 1}`, '127.0.0.1', 'localhost',
    `localhost.:${port}`, `127.0.0.1.:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.2:${port}`,
    `user@127.0.0.1:${port}`, `127.0.0.1:0${port}`, `127.0.0.1:${port}/`, `127.0.0.1:${port}, evil.example`,
  ];
  for (const route of routes) {
    for (const host of allowed) {
      const r = await raw(url, route, { headers: { Host: host } });
      assert.ok([200, 307].includes(r.status), `${host} ${route} -> ${r.status}`);
    }
    for (const host of rejected) {
      const r = await raw(url, route, { headers: { Host: host } });
      assert.equal(r.status, 421, `Host ${JSON.stringify(host)} ${route} -> ${r.status}`);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.ok(!r.body.toString().includes('<!doctype') && !r.body.toString().includes('"contentId"'), 'no packet or alias bytes on rejection');
      assert.equal(r.headers.location, undefined, 'no redirect leaks the alias target');
    }
    assert.equal(await wire(url, [`GET ${route} HTTP/1.1`, 'Connection: close']), 400, `missing Host (HTTP/1.1) ${route}: rejected by the HTTP parser`);
    assert.equal(await wire(url, [`GET ${route} HTTP/1.0`]), 421, `missing Host (HTTP/1.0) ${route}`);
    assert.equal(await wire(url, [`GET ${route} HTTP/1.1`, 'Host:', 'Connection: close']), 421, `empty Host ${route}`);
    assert.equal(await wire(url, [`GET ${route} HTTP/1.1`, `Host: evil.example`, 'Connection: close']), 421, `wire foreign Host ${route}`);
    const okStatus = await wire(url, [`GET ${route} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']);
    assert.ok([200, 307].includes(okStatus), `wire control: allowed Host ${route} -> ${okStatus}`);
  }
  const head = await raw(url, `/p/${id}/`, { method: 'HEAD', headers: { Host: 'evil.example' } });
  assert.equal(head.status, 421);
});

test('[P7] Host allowlist is derived from the IPv6 bound address when serving on ::1', async (t) => {
  const { store, id } = await served(t);
  const v6 = await startServer({ root: store, host: '::1' }).catch((e) => e);
  if (v6 instanceof Error) {
    t.diagnostic(`::1 unavailable on this host: ${v6.message}`);
    return;
  }
  t.after(() => v6.server.close());
  const port = v6.address.port;
  const get = (host) => new Promise((resolve, reject) => {
    const req = request({ host: '::1', family: 6, port, path: `/p/${id}/`, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await get(`[::1]:${port}`), 200);
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get(`127.0.0.1:${port}`), 421, 'IPv4 authority is not this IPv6-bound server');
  assert.equal(await get(`evil.example:${port}`), 421);
});
