// A loopback fake of the Cloudflare v4 API for the V2.1 script tests: http://127.0.0.1:<port>,
// never anything else. `routes` maps "METHOD /path" to a handler (req, body) -> { status, json }.
// Every request is recorded, with its Authorization header value, so tests can prove what
// was (and was not) sent. Not a test file itself.
import { createServer } from 'node:http';

export async function fakeCfApi(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null, body });
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key] ?? routes['*'];
      const out = handler ? await handler({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body }) : { status: 404, json: { success: false, errors: [{ code: 7003, message: 'no route' }] } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((r) => server.close(r)) };
}
