// In-process fakes for running the real Worker (src/publication/worker/index.mjs)
// under Node: R2 and D1 bindings, and a fake Access edge that turns the service-token
// headers into a signed JWT, as Cloudflare Access does in front of the Worker. No
// workerd or miniflare is used (neither is installed; a real workerd run is a
// provider-evidence cell, NOT_EXECUTED).
//
// R2 follows the documented binding semantics (developers.cloudflare.com/r2/api/
// workers/workers-api-reference/, read 2026-09-27): put returns null when an onlyIf
// precondition fails; get/head return null for an absent key; get takes a range. The
// error R2 raises on a sha256 mismatch is not documented (unverified), so the fake
// throws a plain Error. There is deliberately no delete method.
//
// D1 runs the Worker's real SQL on node:sqlite. batch() is one transaction, rolled
// back on any failure, as documented ("Batched statements are SQL transactions",
// developers.cloudflare.com/d1/worker-api/d1-database/, read 2026-09-27).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { REPO } from '../helpers.mjs';

const toBytes = (v) => (v == null ? Buffer.alloc(0) : typeof v === 'string' ? Buffer.from(v) : Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v));

export function fakeR2() {
  const objects = new Map();
  const meta = (key, o) => ({ key, size: o.bytes.length, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded, httpMetadata: { ...o.httpMetadata }, customMetadata: { ...o.customMetadata }, checksums: { sha256: createHash('sha256').update(o.bytes).digest().buffer } });
  const withBody = (key, o, bytes) => ({ ...meta(key, o), body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => bytes.toString('utf8') });
  return {
    objects,
    async put(key, value, options = {}) {
      const bytes = toBytes(value);
      const onlyIf = options.onlyIf instanceof Headers ? options.onlyIf : null;
      if (onlyIf?.get('if-none-match') === '*' && objects.has(key)) return null;
      if (options.sha256 && createHash('sha256').update(bytes).digest('hex') !== options.sha256) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
      const o = { bytes, etag: createHash('md5').update(bytes).digest('hex'), uploaded: new Date(), httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} };
      objects.set(key, o);
      return meta(key, o);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async get(key, options = {}) {
      const o = objects.get(key);
      if (!o) return null;
      let bytes = o.bytes;
      if (options.range) {
        const { offset = 0, length, suffix } = options.range;
        bytes = suffix !== undefined ? bytes.subarray(Math.max(0, bytes.length - suffix)) : bytes.subarray(offset, length === undefined ? undefined : offset + length);
      }
      return withBody(key, o, bytes);
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => meta(k, objects.get(k))), truncated: false, delimitedPrefixes: [] };
    },
  };
}

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(REPO, 'src/publication/worker/schema.sql'), 'utf8'));
  const exec = (sql, args) => {
    const stmt = db.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { success: true, results: stmt.all(...args).map((r) => ({ ...r })), meta: { changes: 0 } };
    const r = stmt.run(...args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => statement(sql, a),
    first: async (col) => { const row = db.prepare(sql).get(...args); return row === undefined ? null : col ? row[col] : { ...row }; },
    all: async () => exec(sql, args),
    run: async () => exec(sql, args),
  });
  return {
    db,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// A fake Access: an RS256 signing key, its JWKS, and token minting.
export async function fakeAccess({ team = 'rp-test', aud = 'aud-test-0123456789' } = {}) {
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const kid = 'kid-test-1';
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const teamDomain = `https://${team}.cloudflareaccess.com`;
  const jwks = { keys: [{ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }] };
  async function token(claims = {}, { signWith = pair.privateKey, header = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
    const p = b64url(JSON.stringify({ aud: [aud], iss: teamDomain, iat: now, nbf: now, exp: now + 3600, type: 'app', ...claims }));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  const serviceClaims = (clientId) => ({ common_name: clientId, sub: '' });
  const userClaims = (email) => ({ email, sub: 'user-sub-1' });
  return { teamDomain, aud, jwks, kid, token, serviceClaims, userClaims, otherKey: (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])).privateKey };
}

// A deployed-Worker stand-in: the real Worker, fake bindings, and a fake Access edge
// that accepts one service token (client id + secret) and mints its JWT.
export async function workerDeployment({ now } = {}) {
  const { createWorker } = await import('../../src/publication/worker/index.mjs');
  const access = await fakeAccess();
  const certsFetched = [];
  const worker = createWorker({ fetchCerts: async (url) => { certsFetched.push(url); return access.jwks; }, ...(now ? { now } : {}) });
  const credentials = { clientId: 'svc-client-id.access', clientSecret: 'svc-client-secret-synthetic' };
  const env = { PACKETS: fakeR2(), ALIASES: fakeD1(), TEAM_DOMAIN: access.teamDomain, POLICY_AUD: access.aud, SERVICE_TOKEN_CLIENT_IDS: credentials.clientId };
  const origin = 'https://rp-publisher-test.example.workers.dev';
  // The Access edge: a request with the right service-token headers reaches the Worker
  // with a signed JWT; anything else is refused at the edge.
  async function edge({ method, path, headers = {}, body = null }) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (lower['cf-access-client-id'] !== credentials.clientId || lower['cf-access-client-secret'] !== credentials.clientSecret) {
      return { status: 403, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: 'access: service token not accepted at the edge' })) };
    }
    delete lower['cf-access-client-id'];
    delete lower['cf-access-client-secret'];
    lower['cf-access-jwt-assertion'] = await access.token(access.serviceClaims(credentials.clientId));
    const res = await worker.fetch(new Request(`${origin}${path}`, { method, headers: lower, body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined }), env);
    return { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(await res.arrayBuffer()) };
  }
  return { worker, env, access, credentials, origin, certsFetched, edge, transport: { requests: 0, async request(req) { this.requests += 1; return edge(req); } } };
}
