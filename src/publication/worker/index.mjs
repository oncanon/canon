// The deployable Publisher V2 Cloudflare Worker (module syntax), for the test
// deployment on workers.dev behind Cloudflare Access (docs/v2/research/cloudflare-adapter.md
// §1, §3). It is the real counterpart of mocks/cloudflare-worker.mjs and serves the
// same ingest API the adapter speaks (docs/v2/publication-protocol.md §3, §8.1):
//
//   /_admin/* (Access service token only, Client ID allowlisted):
//     PUT  /_admin/objects/p/<id>/<path>   create-if-absent into R2, SHA-256 checked
//     GET|HEAD /_admin/objects/p/<id>/<path>
//     GET  /_admin/aliases                  alias names
//     GET  /_admin/aliases/<name>[/history]
//     POST /_admin/aliases/<name>           D1 compare-and-swap, history in the same batch
//     PUT  /_admin/receipts/<id>.json       append-only receipt
//     GET  /_admin/receipts/<id>.json       read a stored receipt back (evidence; V2.1)
//   GET|HEAD /p/<id>/<path>, /a/<name>/[report.md]   serving (any Access identity)
//
// Every request must carry a valid Access JWT (Cf-Access-Jwt-Assertion, RS256,
// issuer = TEAM_DOMAIN, audience = POLICY_AUD). The Worker has no delete route and
// issues no delete; its only outbound request is fetching its own team's Access
// signing keys. Bindings: PACKETS (R2), ALIASES (D1). Vars: TEAM_DOMAIN, POLICY_AUD,
// SERVICE_TOKEN_CLIENT_IDS (comma-separated Access service-token Client IDs).
//
// MODE=public (V2.1 slice 04, mode (c)): the structurally separate public target. There
// is no Access anywhere: serving needs no identity, and /_admin/* needs a signed admin
// request (Ed25519 over canonicalAdminMessage, below) verified with PUBLISHER_PUBLIC_KEY,
// a plain var that is not a secret. TARGET_ID names this target inside every signed
// message, so a signature made for another target never verifies here. The Worker
// refuses every request, serving included, when its public key or target ID is missing
// or any Access setting is present. An Access token or service-token header on an admin
// request is refused, never accepted as authentication. With MODE unset the Worker is
// the private Worker above, unchanged: it never accepts a signature.

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CONTENT_ID = /^sha256-[0-9a-f]{64}$/;
const PACKET_KEY = /^p\/sha256-[0-9a-f]{64}\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RECEIPT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 60 * 60 * 1000;

// ---- signed admin requests (MODE=public) ---------------------------------------------
// v2 (N-V21-1): the request's content-type is signed too, so a replay cannot store an
// attacker-chosen type for an object it wins the create-if-absent race with.
export const ADMIN_SIG_VERSION = 'canon-admin-sig/v1';
export const ADMIN_SIG_WINDOW_S = 60;
export const PUBLIC_KEY_FORMAT = /^canon-ed25519-pk:([A-Za-z0-9_-]{43})$/;
export const TARGET_ID_FORMAT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SIGNATURE_FORMAT = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP_FORMAT = /^[0-9]{1,12}$/;
const ACCESS_AUTH_HEADERS = ['cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret'];

// The exact bytes a publisher signs, one field per line. `target` is the request's path
// and query exactly as sent: it is never decoded or normalized, so what is verified is
// what arrived. `contentType` is the content-type header exactly as sent ('' when absent).
// No field may contain a line break, so the fields cannot be shifted.
export function canonicalAdminMessage({ targetId, method, target, contentType = '', bodySha256, timestamp }) {
  const fields = [ADMIN_SIG_VERSION, targetId, method, target, contentType, bodySha256, String(timestamp)];
  if (!TARGET_ID_FORMAT.test(targetId) || !/^[A-Z]{3,7}$/.test(method) || typeof target !== 'string' || !target.startsWith('/') || /[\s#]/.test(target)
    || typeof contentType !== 'string' || !/^[\x20-\x7e]{0,200}$/.test(contentType)
    || !/^[0-9a-f]{64}$/.test(bodySha256) || !TIMESTAMP_FORMAT.test(String(timestamp))) {
    throw new Error('canonicalAdminMessage: a field is malformed');
  }
  return fields.join('\n');
}

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const text = (status, body, headers = {}) => new Response(body, { status, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// The team's Access signing keys, fetched from its certs URL and cached; a key ID
// not in the cache triggers one refetch (Access rotates keys every 6 weeks and keeps
// the previous key valid for 7 days).
async function defaultFetchCerts(certsUrl) {
  const res = await globalThis.fetch(certsUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  return res.json();
}

export function createWorker({ fetchCerts = defaultFetchCerts, now = () => Date.now() } = {}) {
  const keyCache = new Map(); // team domain -> { at, keys: Map(kid -> CryptoKey) }

  async function signingKey(teamDomain, kid, refresh = false) {
    let entry = keyCache.get(teamDomain);
    if (refresh || !entry || now() - entry.at > KEYS_TTL_MS) {
      const jwks = await fetchCerts(`${teamDomain}/cdn-cgi/access/certs`);
      const keys = new Map();
      for (const jwk of jwks?.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        keys.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
      }
      entry = { at: now(), keys };
      keyCache.set(teamDomain, entry);
    }
    const key = entry.keys.get(kid);
    if (!key && !refresh) return signingKey(teamDomain, kid, true);
    return key ?? null;
  }

  // Returns the verified identity, or a refusal message. Never throws on bad input.
  async function accessIdentity(request, env) {
    if (!TEAM_DOMAIN.test(env.TEAM_DOMAIN ?? '') || !env.POLICY_AUD) return { refused: 'access: Worker not configured (TEAM_DOMAIN, POLICY_AUD)' };
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) return { refused: 'access: no Access token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { refused: 'access: malformed token' };
    let header;
    let payload;
    try {
      header = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch {
      return { refused: 'access: malformed token' };
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { refused: 'access: unexpected token algorithm' };
    let key;
    try {
      key = await signingKey(env.TEAM_DOMAIN, header.kid);
    } catch {
      return { refused: 'access: signing keys unavailable' };
    }
    if (!key) return { refused: 'access: unknown signing key' };
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    let valid = false;
    try {
      valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed);
    } catch {
      valid = false;
    }
    if (!valid) return { refused: 'access: bad token signature' };
    const t = Math.floor(now() / 1000);
    if (payload.iss !== env.TEAM_DOMAIN) return { refused: 'access: wrong token issuer' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.POLICY_AUD)) return { refused: 'access: wrong token audience' };
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < t) return { refused: 'access: token expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > t) return { refused: 'access: token not yet valid' };
    // A service token has a common_name (its Client ID) and no email.
    const serviceToken = typeof payload.common_name === 'string' && payload.common_name !== '' && !payload.email;
    return { serviceToken, clientId: serviceToken ? payload.common_name : null };
  }

  // ---- serving ------------------------------------------------------------------------
  function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start;
    let end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return null;
    return { offset: start, length: end - start + 1 };
  }

  async function servePacket(request, env, key) {
    const meta = await env.PACKETS.head(key);
    if (!meta) return text(404, 'not found\n');
    const sha256 = meta.customMetadata?.sha256;
    const headers = { ...SECURITY_HEADERS, 'content-type': meta.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': CACHE_IMMUTABLE, etag: `"${sha256}"`, 'accept-ranges': 'bytes' };
    if (request.headers.get('if-none-match') === `"${sha256}"`) return new Response(null, { status: 304, headers });
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const range = parseRange(rangeHeader, meta.size);
      if (!range) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${meta.size}` } });
      const part = request.method === 'HEAD' ? null : await env.PACKETS.get(key, { range });
      return new Response(part ? part.body : null, { status: 206, headers: { ...headers, 'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`, 'content-length': String(range.length) } });
    }
    const obj = request.method === 'HEAD' ? null : await env.PACKETS.get(key);
    return new Response(obj ? obj.body : null, { status: 200, headers: { ...headers, 'content-length': String(meta.size) } });
  }

  async function serve(request, env, path) {
    let m = /^\/a\/([^/]+)\/(report\.md|index\.md)?$/.exec(path);
    if (m && ALIAS.test(m[1])) {
      const row = await env.ALIASES.prepare('SELECT content_id FROM alias WHERE name = ?').bind(m[1]).first();
      if (!row) return text(404, 'not found\n');
      return new Response(null, { status: 307, headers: { ...SECURITY_HEADERS, location: `/p/${row.content_id}/${m[2] ?? ''}`, 'cache-control': 'no-store' } });
    }
    m = /^\/p\/(sha256-[0-9a-f]{64})\/(.*)$/.exec(path);
    if (!m) return text(404, 'not found\n');
    const key = `p/${m[1]}/${m[2] || 'index.html'}`;
    if (!PACKET_KEY.test(key)) return text(404, 'not found\n');
    return servePacket(request, env, key);
  }

  // ---- ingest ---------------------------------------------------------------------------
  async function aliasRecord(env, name) {
    const row = await env.ALIASES.prepare('SELECT name, content_id, generation FROM alias WHERE name = ?').bind(name).first();
    if (!row) return null;
    const prev = await env.ALIASES.prepare('SELECT content_id FROM alias_history WHERE name = ? AND generation = ?').bind(name, row.generation - 1).first();
    return { schema: 'alias/v1', name, contentId: row.content_id, generation: row.generation, previousContentId: prev ? prev.content_id : null };
  }

  async function putObject(request, env, key) {
    if (!PACKET_KEY.test(key) || key.includes('..')) return json(400, { error: 'bad key' });
    if (request.headers.get('if-none-match') !== '*') return json(428, { error: 'object puts must be create-if-absent' });
    const declared = request.headers.get('x-rp-sha256') ?? '';
    if (!/^[0-9a-f]{64}$/.test(declared)) return json(400, { error: 'x-rp-sha256 required' });
    const body = await request.arrayBuffer();
    if ((await sha256Hex(body)) !== declared) return json(400, { error: 'bad-digest' });
    let stored;
    try {
      stored = await env.PACKETS.put(key, body, {
        onlyIf: new Headers({ 'if-none-match': '*' }),
        sha256: declared,
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream', cacheControl: CACHE_IMMUTABLE },
        customMetadata: { sha256: declared },
      });
    } catch {
      return json(400, { error: 'bad-digest' }); // R2 rejected the checksum
    }
    if (stored) return json(201, { outcome: 'created' });
    const existing = await env.PACKETS.head(key);
    const existingSha256 = existing?.customMetadata?.sha256 ?? null;
    return existingSha256 === declared ? json(200, { outcome: 'identical' }) : json(409, { outcome: 'conflict', existingSha256 });
  }

  async function getObject(request, env, key) {
    if (!PACKET_KEY.test(key)) return json(404, { error: 'not found' });
    const obj = request.method === 'HEAD' ? await env.PACKETS.head(key) : await env.PACKETS.get(key);
    if (!obj) return json(404, { error: 'not found' });
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': obj.httpMetadata?.cacheControl ?? CACHE_IMMUTABLE, 'x-rp-sha256': obj.customMetadata?.sha256 ?? '', 'content-length': String(obj.size) } });
  }

  async function casAlias(request, env, name) {
    let input;
    try {
      input = await request.json();
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    const { expectGeneration, contentId } = input ?? {};
    const opId = typeof input?.opId === 'string' && input.opId ? input.opId : crypto.randomUUID();
    if (!Number.isSafeInteger(expectGeneration) || expectGeneration < 0 || !CONTENT_ID.test(contentId ?? '')) return json(400, { error: 'expectGeneration and contentId required' });
    if (!(await env.PACKETS.head(`p/${contentId}/manifest.json`))) return json(412, { error: 'target manifest not present' });
    // A retry of an operation whose earlier attempt committed (response lost) is that move.
    const mine = await env.ALIASES.prepare('SELECT generation FROM alias WHERE name = ? AND op_id = ? AND content_id = ?').bind(name, opId, contentId).first();
    if (mine && mine.generation === expectGeneration + 1) return json(200, await aliasRecord(env, name));
    const stamp = new Date(now()).toISOString();
    const next = expectGeneration + 1;
    const move = expectGeneration === 0
      ? env.ALIASES.prepare('INSERT INTO alias (name, content_id, generation, op_id, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(name) DO NOTHING').bind(name, contentId, opId, stamp)
      : env.ALIASES.prepare('UPDATE alias SET content_id = ?, generation = generation + 1, op_id = ?, updated_at = ? WHERE name = ? AND generation = ?').bind(contentId, opId, stamp, name, expectGeneration);
    // History rides in the same transaction and is written only if this move won.
    const history = env.ALIASES.prepare('INSERT INTO alias_history (name, generation, content_id, op_id, updated_at) SELECT name, generation, content_id, op_id, updated_at FROM alias WHERE name = ? AND op_id = ? AND generation = ?').bind(name, opId, next);
    const [moved] = await env.ALIASES.batch([move, history]);
    if (moved.meta.changes === 1) return json(200, await aliasRecord(env, name));
    const current = await env.ALIASES.prepare('SELECT generation FROM alias WHERE name = ?').bind(name).first();
    return json(409, { error: 'cas lost', currentGeneration: current ? current.generation : 0 });
  }

  async function putReceipt(request, env, id) {
    if (!RECEIPT_ID.test(id)) return json(400, { error: 'bad receipt id' });
    const body = await request.arrayBuffer();
    let receipt;
    try {
      receipt = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: 'receipt must be JSON' });
    }
    if (receipt?.receiptId !== id || receipt?.schema !== 'receipt/v2') return json(400, { error: 'receipt does not match its path or schema' });
    const stored = await env.PACKETS.put(`receipts/${id}.json`, body, { onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' } });
    return stored ? json(201, { stored: true }) : json(409, { error: 'receipt exists' });
  }

  // V2.1: receipts are read back into the live run's evidence (admin-only, like every
  // /_admin/ route; the receipt is returned byte for byte, never cached).
  async function getReceipt(env, id) {
    if (!RECEIPT_ID.test(id)) return json(400, { error: 'bad receipt id' });
    const obj = await env.PACKETS.get(`receipts/${id}.json`);
    if (!obj) return json(404, { error: 'no such receipt' });
    return new Response(obj.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  async function admin(request, env, path) {
    const method = request.method;
    let m = /^\/_admin\/objects\/(p\/.+)$/.exec(path);
    if (m) {
      const key = decodeURIComponent(m[1]);
      if (method === 'PUT') return putObject(request, env, key);
      if (method === 'GET' || method === 'HEAD') return getObject(request, env, key);
      return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD, PUT' });
    }
    if (path === '/_admin/aliases' && method === 'GET') {
      const { results } = await env.ALIASES.prepare('SELECT name FROM alias ORDER BY name').all();
      return json(200, results.map((r) => r.name));
    }
    m = /^\/_admin\/aliases\/([^/]+)(\/history)?$/.exec(path);
    if (m && ALIAS.test(m[1])) {
      const name = m[1];
      if (m[2] && method === 'GET') {
        const { results } = await env.ALIASES.prepare('SELECT generation, content_id FROM alias_history WHERE name = ? ORDER BY generation').bind(name).all();
        return json(200, results.map((r, i, a) => ({ schema: 'alias/v1', name, contentId: r.content_id, generation: r.generation, previousContentId: i > 0 ? a[i - 1].content_id : null })));
      }
      if (!m[2] && method === 'GET') {
        const record = await aliasRecord(env, name);
        return record ? json(200, record) : json(404, { error: 'no such alias' });
      }
      if (!m[2] && method === 'POST') return casAlias(request, env, name);
      return json(405, { error: 'method not allowed' });
    }
    m = /^\/_admin\/receipts\/([^/]+)\.json$/.exec(path);
    if (m && method === 'PUT') return putReceipt(request, env, m[1]);
    if (m && method === 'GET') return getReceipt(env, m[1]);
    if (m) return json(405, { error: 'method not allowed' }, { allow: 'GET, PUT' });
    return json(404, { error: 'no such route' });
  }

  // ---- public mode ----------------------------------------------------------------------
  // Why a public Worker must refuse to run: any missing key or target ID, or any Access
  // setting (a public target is never a private one with its mode switched).
  function publicConfigProblem(env) {
    if (!PUBLIC_KEY_FORMAT.test(env.PUBLISHER_PUBLIC_KEY ?? '')) return 'no valid PUBLISHER_PUBLIC_KEY';
    if (!TARGET_ID_FORMAT.test(env.TARGET_ID ?? '')) return 'no valid TARGET_ID';
    const access = ['TEAM_DOMAIN', 'POLICY_AUD', 'SERVICE_TOKEN_CLIENT_IDS'].filter((k) => env[k] !== undefined && env[k] !== '');
    if (access.length) return `Access configuration present (${access.join(', ')})`;
    return null;
  }

  const verifyKeys = new Map(); // public key text -> CryptoKey
  async function verifyKey(text) {
    if (!verifyKeys.has(text)) verifyKeys.set(text, await crypto.subtle.importKey('raw', b64urlBytes(PUBLIC_KEY_FORMAT.exec(text)[1]), { name: 'Ed25519' }, false, ['verify']));
    return verifyKeys.get(text);
  }

  // Verifies a signed admin request. Returns { request } (with the body already read,
  // so the handlers see exactly the verified bytes) or { refused }. Never throws on bad input.
  async function signedAdmin(request, env, url) {
    const present = ACCESS_AUTH_HEADERS.filter((h) => request.headers.has(h));
    if (present.length) return { refused: `public: Access credentials are not accepted (${present.join(', ')})` };
    // The path and query exactly as received. The routes act on the parsed path, so the
    // two must be the same string, or what was verified would not be what is served.
    const target = request.url.slice(url.origin.length);
    if (target !== `${url.pathname}${url.search}`) return { refused: 'public: request target is not in canonical form' };
    const timestamp = request.headers.get('x-canon-timestamp') ?? '';
    if (!TIMESTAMP_FORMAT.test(timestamp)) return { refused: 'public: no signature timestamp' };
    if (Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > ADMIN_SIG_WINDOW_S) return { refused: 'public: signature timestamp outside the window' };
    const signature = request.headers.get('x-canon-signature') ?? '';
    if (!SIGNATURE_FORMAT.test(signature)) return { refused: 'public: no signature' };
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
    let message;
    try {
      message = canonicalAdminMessage({ targetId: env.TARGET_ID, method: request.method, target, contentType: request.headers.get('content-type') ?? '', bodySha256: await sha256Hex(body), timestamp });
    } catch {
      return { refused: 'public: request cannot be signed' };
    }
    let valid = false;
    try {
      valid = await crypto.subtle.verify({ name: 'Ed25519' }, await verifyKey(env.PUBLISHER_PUBLIC_KEY), b64urlBytes(signature), new TextEncoder().encode(message));
    } catch {
      valid = false;
    }
    if (!valid) return { refused: 'public: bad signature' };
    return { request: hasBody ? new Request(request.url, { method: request.method, headers: request.headers, body }) : request };
  }

  async function publicFetch(request, env) {
    const problem = publicConfigProblem(env);
    if (problem) return json(403, { error: `public: Worker not configured: ${problem}` });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/_admin/')) {
      const verified = await signedAdmin(request, env, url);
      if (verified.refused) return json(403, { error: verified.refused });
      return admin(verified.request, env, path);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed\n', { allow: 'GET, HEAD' });
    return serve(request, env, path);
  }

  return {
    async fetch(request, env) {
      if (env.MODE === 'public') return publicFetch(request, env);
      if (env.MODE !== undefined && env.MODE !== '' && env.MODE !== 'private') return json(403, { error: 'worker: unknown MODE' });
      const url = new URL(request.url);
      const path = url.pathname;
      const identity = await accessIdentity(request, env);
      if (identity.refused) return json(403, { error: identity.refused });
      if (path.startsWith('/_admin/')) {
        const allowed = String(env.SERVICE_TOKEN_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!identity.serviceToken || !allowed.includes(identity.clientId)) return json(403, { error: 'access: the ingest API needs an allowlisted service token' });
        return admin(request, env, path);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed\n', { allow: 'GET, HEAD' });
      return serve(request, env, path);
    },
  };
}

export default createWorker();
