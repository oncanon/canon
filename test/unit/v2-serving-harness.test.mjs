// Local loopback harness for the provider serving logic (slices 03 and 04): the mock
// Cloudflare Worker answers real HTTP requests on 127.0.0.1 with an ephemeral port. Checks
// the V1 serving contract (content types, security headers, HEAD, Range, 304, alias 307 +
// no-store). Loopback only; no provider is contacted.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { CACHE_IMMUTABLE, objectKey, promote, publish } from '../../src/publication/protocol.mjs';
import { sha256Hex } from '../../src/hash.mjs';
import { harness, syntheticPacket } from '../v2/harness.mjs';

async function serve(t, endpoint, prefix = '') {
  const server = createServer((req, res) => {
    endpoint.handle({ method: req.method, path: `${prefix}${req.url}`, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: null }).then((r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body ?? '');
    }, (err) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });
  await new Promise((r) => server.listen({ host: '127.0.0.1', port: 0 }, r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();
  return (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const kind of ['mock-cloudflare']) {
  test(`[V2-7] ${kind}: serving contract over loopback HTTP (types, security headers, HEAD, Range, 304, alias 307)`, async (t) => {
    const h = await harness(kind, t);
    const p = await syntheticPacket(h.dir);
    await publish({ ...h.opts(), packetDir: p.dir });
    await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
    const http = await serve(t, h.endpoint, '');
    const expectTypes = { 'index.html': 'text/html; charset=utf-8', 'report.md': 'text/markdown; charset=utf-8', 'manifest.json': 'application/json' };
    for (const [path, type] of Object.entries(expectTypes)) {
      const res = await http('GET', `/p/${p.contentId}/${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers['content-type'], type, path);
      assert.match(res.headers['content-security-policy'], /default-src 'none'.*script-src 'none'.*frame-ancestors 'none'/, path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', path);
      assert.equal(res.headers['x-frame-options'], 'DENY', path);
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', path);
    }
    const md = await http('GET', `/p/${p.contentId}/report.md`);
    const sha = sha256Hex(md.body);
    // Node's HTTP server never sends a HEAD body, so the empty body is asserted in the
    // in-process contract suite (V2-7); over HTTP the status and length are what count.
    const head = await http('HEAD', `/p/${p.contentId}/report.md`);
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), md.body.length);
    const range = await http('GET', `/p/${p.contentId}/report.md`, { range: 'bytes=0-15' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], `bytes 0-15/${md.body.length}`);
    assert.deepEqual(range.body, md.body.subarray(0, 16));
    const unsatisfiable = await http('GET', `/p/${p.contentId}/report.md`, { range: `bytes=${md.body.length + 10}-` });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers['content-range'], `bytes */${md.body.length}`);
    assert.equal((await http('GET', `/p/${p.contentId}/report.md`, { 'if-none-match': md.headers.etag })).status, 304);
    for (const [path, target] of [['/a/review/', `/p/${p.contentId}/`], ['/a/review/report.md', `/p/${p.contentId}/report.md`]]) {
      const a = await http('GET', path);
      assert.equal(a.status, 307, path);
      assert.equal(a.headers.location, target, path);
      assert.equal(a.headers['cache-control'], 'no-store', path);
    }
    assert.equal((await http('GET', '/a/missing/')).status, 404);
    assert.equal(md.headers.etag, `"${sha}"`, 'Worker ETag is the SHA-256');
    assert.equal((await http('DELETE', `/p/${p.contentId}/report.md`)).status, 405, 'the Worker serves no DELETE');
    t.diagnostic(`v2-harness ${JSON.stringify({ kind, contentId: p.contentId, loopback: '127.0.0.1', checks: ['types', 'csp', 'nosniff', 'referrer', 'frame', 'cache', 'head', 'range-206', 'range-416', 'etag-304', 'alias-307', 'alias-404'] })}`);
  });
}

// N-V2-1 (QA c21b471): the served content type is the manifest's mediaType, stored with
// the object at upload, never a guess from the file extension (protocol §1). The object
// here has a `.txt` name, but its manifest entry says Markdown.
for (const kind of ['mock-cloudflare']) {
  test(`[V2-7] ${kind}: the served content type is the manifest mediaType, not the extension's`, async (t) => {
    const h = await harness(kind, t);
    const key = objectKey(`sha256-${'a'.repeat(64)}`, 'notes.txt');
    const bytes = Buffer.from('# notes\n');
    const mediaType = 'text/markdown; charset=utf-8';
    assert.equal((await h.adapter.putIfAbsent({ key, sha256: sha256Hex(bytes), bytes: bytes.length, contentType: mediaType, cacheControl: CACHE_IMMUTABLE }, bytes)).outcome, 'created');
    const http = await serve(t, h.endpoint, '');
    for (const method of ['GET', 'HEAD']) {
      const res = await http(method, `/${key}`);
      assert.equal(res.status, 200, method);
      assert.equal(res.headers['content-type'], mediaType, `${method}: served as the manifest says, not as text/plain`);
    }
    assert.equal((await http('GET', `/${key}`, { range: 'bytes=0-1' })).headers['content-type'], mediaType, 'ranged responses too');
  });
}
