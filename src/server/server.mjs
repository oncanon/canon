// Loopback-only packet server (docs/decisions/phase1-contract.md D6).
//
// Routes:
//   /p/<content-id>/[path]   immutable packet bytes, long-lived cache
//   /a/<name>/               307 to /p/<id>/ with Cache-Control: no-store
//   /a/<name>/report.md      307 to /p/<id>/report.md with Cache-Control: no-store
//                            (the coequal agent entry point, D2/D10)
//   /a/<name>.json           the alias record, no-store
//   /healthz                 readiness, no-store
// Every route first requires an allowed Host header (421 otherwise).
// Only files named in a verified manifest are served, and every body is re-hashed
// against the manifest before it is sent: a tampered file is refused, not served.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAlias, ALIAS_NAME_PATTERN, AliasError } from '../alias/alias.mjs';
import { CONTENT_ID_PATTERN, sha256Hex } from '../hash.mjs';
import { packetPath } from '../publish/filesystem.mjs';
import { allowedHostsFor, assertBindAllowed, LOOPBACK, resolveBind } from './bind.mjs';
import { IMMUTABLE_CACHE, NO_STORE, parseRequestPath, SECURITY_HEADERS } from './http.mjs';
// Full verify: site bundles via site/verify.mjs; packets with the independent rules plus,
// for render-policy/2, reproduction (R11).
import { verifyArtifactFull as verifyArtifact } from '../packet/reproduce.mjs';

export const LOOPBACK_HOSTS = LOOPBACK;
export { IMMUTABLE_CACHE, NO_STORE, parseRequestPath, SECURITY_HEADERS };

function send(res, status, { body = '', type = 'text/plain; charset=utf-8', cache = NO_STORE, headers = {}, head = false } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': String(bytes.length),
    'Cache-Control': cache,
    ...headers,
  });
  res.end(head ? undefined : bytes);
}

// Host allowlist (docs/decisions/phase1-contract.md D6, DNS rebinding): derived
// from the address the server is actually bound to plus any names resolved with
// the bind (src/server/bind.mjs). A page on another origin that rebinds its
// hostname to this address is refused. Hostnames compare case-insensitively and
// nothing else is normalized (a trailing dot, missing port, or userinfo fails).
export { allowedHostsFor };

export function isAllowedHost(hostHeader, address, names = []) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  return allowedHostsFor(address, names).has(hostHeader.toLowerCase());
}

export function createPacketServer({ root, log = () => {}, names = [] }) {
  const verified = new Map(); // content ID -> Map(path -> { sha256, mediaType, bytes })

  async function inventoryFor(contentId) {
    if (verified.has(contentId)) return verified.get(contentId);
    const dir = packetPath(root, contentId);
    const check = await verifyArtifact(dir);
    if (!check.ok || check.contentId !== contentId) return null;
    const manifestBytes = await readFile(join(dir, 'manifest.json'));
    const checksumsBytes = await readFile(join(dir, 'checksums.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const inventory = new Map(manifest.files.map((f) => [f.path, { sha256: f.sha256, mediaType: f.mediaType, bytes: f.bytes }]));
    inventory.set('manifest.json', { sha256: sha256Hex(manifestBytes), mediaType: 'application/json', bytes: manifestBytes.length });
    inventory.set('checksums.json', { sha256: sha256Hex(checksumsBytes), mediaType: 'application/json', bytes: checksumsBytes.length });
    verified.set(contentId, inventory);
    return inventory;
  }

  async function servePacket(req, res, contentId, rest, trailingSlash, head) {
    if (rest.length === 0 && !trailingSlash) {
      return send(res, 308, { headers: { Location: `/p/${contentId}/` }, cache: IMMUTABLE_CACHE, head });
    }
    const relPath = rest.length === 0 ? 'index.html' : rest.join('/');
    if (trailingSlash && rest.length > 0) return send(res, 404, { body: 'not found\n', head });
    const inventory = await inventoryFor(contentId);
    if (!inventory) return send(res, 404, { body: 'packet not found\n', head });
    const entry = inventory.get(relPath);
    if (!entry) return send(res, 404, { body: 'not found\n', head });
    const etag = `"${entry.sha256}"`;
    const common = { 'ETag': etag, 'X-Content-Id': contentId };
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag)) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...common, 'Cache-Control': IMMUTABLE_CACHE });
      return res.end();
    }
    const bytes = await readFile(join(packetPath(root, contentId), relPath));
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      verified.delete(contentId);
      log({ event: 'integrity-failure', contentId, path: relPath });
      return send(res, 500, { body: 'integrity failure: packet bytes do not match manifest\n', head });
    }
    return send(res, 200, { body: bytes, type: entry.mediaType, cache: IMMUTABLE_CACHE, headers: common, head });
  }

  async function serveAlias(res, name, asJson, head, file = '') {
    const record = await readAlias(root, name);
    if (!record) return send(res, 404, { body: 'alias not found\n', head });
    if (asJson) return send(res, 200, { body: `${JSON.stringify(record)}\n`, type: 'application/json', cache: NO_STORE, head });
    return send(res, 307, { headers: { Location: `/p/${record.contentId}/${file}` }, cache: NO_STORE, head });
  }

  async function handle(req, res, address) {
    const head = req.method === 'HEAD';
    if (!isAllowedHost(req.headers.host, address, names)) {
      return send(res, 421, { body: 'misdirected request: Host is not this loopback server\n', head });
    }
    if (req.method !== 'GET' && !head) return send(res, 405, { body: 'method not allowed\n', headers: { Allow: 'GET, HEAD' } });
    const parsed = parseRequestPath(req.url ?? '');
    if (!parsed) return send(res, 400, { body: 'bad request path\n', head });
    const { segments, trailingSlash } = parsed;
    if (segments.length === 1 && segments[0] === 'healthz' && !trailingSlash) return send(res, 200, { body: 'ok\n', head });
    if (segments[0] === 'p' && segments.length >= 2) {
      if (!CONTENT_ID_PATTERN.test(segments[1])) return send(res, 404, { body: 'not found\n', head });
      return servePacket(req, res, segments[1], segments.slice(2), trailingSlash, head);
    }
    if (segments[0] === 'a' && segments.length === 2) {
      const raw = segments[1];
      const asJson = raw.endsWith('.json') && !trailingSlash;
      const name = asJson ? raw.slice(0, -5) : raw;
      if (!ALIAS_NAME_PATTERN.test(name)) return send(res, 404, { body: 'not found\n', head });
      return serveAlias(res, name, asJson, head);
    }
    if (segments[0] === 'a' && segments.length === 3 && segments[2] === 'report.md' && !trailingSlash) {
      if (!ALIAS_NAME_PATTERN.test(segments[1])) return send(res, 404, { body: 'not found\n', head });
      return serveAlias(res, segments[1], false, head, 'report.md');
    }
    if (segments[0] === 'a' && segments.length === 3 && segments[2] === 'index.md' && !trailingSlash) {
      if (!ALIAS_NAME_PATTERN.test(segments[1])) return send(res, 404, { body: 'not found\n', head });
      return serveAlias(res, segments[1], false, head, 'index.md');
    }
    return send(res, 404, { body: 'not found\n', head });
  }

  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    handle(req, res, server.address()).catch((err) => {
      log({ event: 'error', error: err instanceof AliasError ? err.code : 'internal' });
      if (!res.headersSent) send(res, 500, { body: 'internal error\n' });
      else res.destroy();
    }).finally(() => {
      const path = (req.url ?? '').split('?')[0];
      // A successful /healthz is the overwhelming majority of traffic (Canon.app polls it
      // every few seconds) and carries no information worth keeping; a failed one still does.
      if (req.method === 'GET' && path === '/healthz' && res.statusCode === 200) return;
      log({ event: 'request', method: req.method, path, status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    });
  });
  return server;
}

// Binds per src/server/bind.mjs: loopback by default; a non-loopback address only
// when explicitly named (host) or resolved from Tailscale (tailscale: true).
export async function startServer({ root, host, tailscale = false, allowHosts = [], expectTailscale, port = 0, log, interfaces, detect }) {
  const bind = assertBindAllowed(resolveBind({ host, tailscale, allowHosts, expectTailscale, ...(interfaces ? { interfaces } : {}), ...(detect ? { detect } : {}) }));
  const server = createPacketServer({ root, log, names: bind.names });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: bind.host, port, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (address.address !== bind.host) {
    server.close();
    throw new Error(`bound to ${address.address}, expected ${bind.host}; closed`);
  }
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const urls = [`http://${urlHost}:${address.port}`, ...bind.names.map((n) => `http://${n}:${address.port}`)];
  return { server, address, bind, url: urls[0], urls, allowedHosts: [...allowedHostsFor(address, bind.names)] };
}
