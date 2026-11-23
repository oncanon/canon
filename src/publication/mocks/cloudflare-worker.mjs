// In-process mock of the recommended Cloudflare deployment: one Worker with an R2
// binding (packet bytes) and a D1 table (aliases), behind Cloudflare Access. It
// models only the behaviours listed here, each with its research citation
// (docs/v2/research/cloudflare-adapter.md, read 2026-09-26); everything else is out of
// scope and is a provider-evidence row (docs/v2/emulator-policy.md).
//
// Modelled:
//   R2 put with onlyIf If-None-Match:* returns null when the key exists; the Worker
//     then heads the object and compares checksums.sha256 (§3.1 [S2][S4])
//   R2 put with a sha256 option rejects a body that does not match (§3.1 [S2]; the
//     real error shape is unverified, so the mock returns 400 bad-digest)
//   R2 strong read-after-write for the binding (§3.1 [S7])
//   D1 alias CAS: UPDATE ... WHERE name=? AND generation=?, with the history insert
//     in the same batch; changes=0 means the CAS lost -> 409 (§3.2 [S12]); read
//     replication off, so reads go to the primary (§3.2 [S13])
//   Precondition: the Worker heads p/<id>/manifest.json before any alias CAS (§3.2)
//   Access service token on /_admin/*: CF-Access-Client-Id + CF-Access-Client-Secret,
//     with a configurable duration (§3.6 [S18])
//   Serving: the Worker sets every header itself; ETag = "<sha256>"; If-None-Match
//     -> 304; HEAD; Range -> 206/416; aliases -> 307 + no-store (§3.3, §3.4)
//   No delete route: the Worker exposes none (§3.7 B)
//   Alias CAS idempotency: the POST carries the publisher's operation ID, stored on
//     the D1 row; a retry of the same operation that finds its own committed move is
//     answered 200 with the record (a lost response is never a lost CAS)
// Fault rule `respond` (tests): answer the next request matching `when` (a regex on
//   "METHOD path") with `status`, instead of processing it or after committing it
//   (`afterCommit`)
// Not modelled: R2 atomicity under concurrent writers (§3.1: unverified), real
// Access/JWT enforcement, CDN caching, latency, billing.
import { createHash, randomBytes } from 'node:crypto';
import { applyRange, json, mockState, SECURITY_HEADERS } from './state.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createCloudflareWorker({ stateDir = null, now = () => Date.now(), tokenTtlMs = 3600_000 } = {}) {
  const store = mockState({
    stateDir,
    init: () => ({
      r2: {},
      d1: { alias: {}, history: [] },
      receipts: {},
      access: { clientId: `mock-${randomBytes(6).toString('hex')}.access`, clientSecret: randomBytes(24).toString('hex'), expiresAt: now() + tokenTtlMs },
      faults: {},
    }),
  });
  const s = store.state;
  const log = [];

  function takeFault(name) {
    if (!s.faults[name]) return false;
    s.faults[name] -= 1;
    return true;
  }

  function authorized(h) {
    if (h['cf-access-client-id'] !== s.access.clientId || h['cf-access-client-secret'] !== s.access.clientSecret) return { status: 403, reason: 'access denied' };
    if (now() >= s.access.expiresAt) return { status: 403, reason: 'service token expired' };
    return null;
  }

  function serve(method, path, h) {
    const m = path.match(/^\/p\/(sha256-[0-9a-f]{64})\/(.*)$/);
    if (!m) return { status: 404, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' }, body: Buffer.from('not found\n') };
    const key = `p/${m[1]}/${m[2] || 'index.html'}`;
    const obj = s.r2[key];
    if (!obj) return { status: 404, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' }, body: Buffer.from('not found\n') };
    // The content type is the one stored with the object at upload (R2 httpMetadata),
    // which is the manifest's mediaType; never a guess from the extension (§1).
    const headers = { ...SECURITY_HEADERS, 'content-type': obj.contentType, 'cache-control': obj.cacheControl, etag: `"${obj.sha256}"`, 'accept-ranges': 'bytes' };
    if (h['if-none-match'] === `"${obj.sha256}"`) return { status: 304, headers };
    let body = Buffer.from(obj.b64, 'base64');
    if (takeFault('corruptReads')) body = Buffer.concat([body, Buffer.from('x')]);
    if (h.range) {
      const r = applyRange(h.range, body);
      if (r.status === 416) return { status: 416, headers: { ...headers, 'content-range': `bytes */${body.length}` } };
      headers['content-range'] = r.contentRange;
      return { status: 206, headers: { ...headers, 'content-length': String(r.body.length) }, body: method === 'HEAD' ? Buffer.alloc(0) : r.body };
    }
    return { status: 200, headers: { ...headers, 'content-length': String(body.length) }, body: method === 'HEAD' ? Buffer.alloc(0) : body };
  }

  function aliasRecord(name) {
    const row = s.d1.alias[name];
    if (!row) return null;
    const prev = [...s.d1.history].reverse().find((h) => h.name === name && h.generation === row.generation - 1);
    return { schema: 'alias/v1', name, contentId: row.content_id, generation: row.generation, previousContentId: prev ? prev.content_id : null };
  }

  function scriptedResponse(status) {
    if (status === 599) return { status: 599, headers: {}, body: Buffer.alloc(0) };
    if (status === 403) return json(403, { error: 'service token expired' });
    return json(status, { error: `injected ${status}` });
  }
  function takeRule(method, path) {
    const rules = s.faults.respond ?? [];
    const i = rules.findIndex((r) => new RegExp(r.when).test(`${method} ${path}`));
    if (i < 0) return null;
    const [rule] = rules.splice(i, 1);
    store.save();
    return rule;
  }

  async function handle(req) {
    const rule = takeRule(req.method, req.path);
    if (rule && !rule.afterCommit) return scriptedResponse(rule.status);
    const res = await handleRequest(req);
    return rule ? scriptedResponse(rule.status) : res;
  }

  async function handleRequest(req) {
    const { method, path, headers: h, body } = req;
    log.push({ method, path });
    try {
      if (path.startsWith('/a/')) {
        const m = path.match(/^\/a\/([a-z0-9][a-z0-9-]{0,62})\/(report\.md)?$/);
        const rec = m && aliasRecord(m[1]);
        if (!rec) return { status: 404, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' }, body: Buffer.from('not found\n') };
        return { status: 307, headers: { ...SECURITY_HEADERS, location: `/p/${rec.contentId}/${m[2] ?? ''}`, 'cache-control': 'no-store' }, body: Buffer.alloc(0) };
      }
      if (path.startsWith('/p/')) {
        if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { ...SECURITY_HEADERS, allow: 'GET, HEAD' } };
        return serve(method, path, h);
      }
      if (!path.startsWith('/_admin/')) return { status: 404, headers: { 'cache-control': 'no-store' } };
      // Fault: the service token expires after N more admin requests.
      if (s.faults.expireAfterRequests !== undefined) {
        if (s.faults.expireAfterRequests === 0) { delete s.faults.expireAfterRequests; s.access.expiresAt = now() - 1; } else s.faults.expireAfterRequests -= 1;
      }
      const denied = authorized(h);
      if (denied) return json(denied.status, { error: denied.reason });
      if (takeFault('throttle')) return json(429, { error: 'throttled' });
      if (takeFault('timeout')) return { status: 599, headers: {}, body: Buffer.alloc(0) }; // client-side timeout (simulated)
      if (method === 'DELETE') return json(405, { error: 'the ingest API has no delete' });

      let m = path.match(/^\/_admin\/objects\/(p\/.+)$/);
      if (m && method === 'PUT') {
        const key = decodeURIComponent(m[1]);
        if (takeFault('failPuts')) return json(500, { error: 'internal error (injected)' });
        // Fault: a partial upload; the next object put after N successes fails.
        if (s.faults.failPutsAfter !== undefined) {
          if (s.faults.failPutsAfter === 0) { delete s.faults.failPutsAfter; return json(500, { error: 'internal error (injected, partial upload)' }); }
          s.faults.failPutsAfter -= 1;
        }
        if (h['if-none-match'] !== '*') return json(428, { error: 'object puts must be create-if-absent' });
        if (sha256(body) !== h['x-rp-sha256']) return json(400, { error: 'bad-digest' });
        const existing = s.r2[key];
        if (existing) return existing.sha256 === h['x-rp-sha256'] ? json(200, { outcome: 'identical' }) : json(409, { outcome: 'conflict', existingSha256: existing.sha256 });
        s.r2[key] = { b64: body.toString('base64'), sha256: h['x-rp-sha256'], contentType: h['content-type'], cacheControl: h['cache-control'] };
        return json(201, { outcome: 'created' });
      }
      m = path.match(/^\/_admin\/objects\/(p\/.+)$/);
      if (m && (method === 'GET' || method === 'HEAD')) {
        const obj = s.r2[decodeURIComponent(m[1])];
        if (!obj) return json(404, { error: 'not found' });
        let bytes = Buffer.from(obj.b64, 'base64');
        if (method === 'GET' && takeFault('corruptReads')) bytes = Buffer.concat([bytes, Buffer.from('x')]);
        return { status: 200, headers: { 'content-type': obj.contentType, 'cache-control': obj.cacheControl, 'x-rp-sha256': obj.sha256, 'content-length': String(bytes.length) }, body: method === 'HEAD' ? Buffer.alloc(0) : bytes };
      }
      if (path === '/_admin/aliases' && method === 'GET') return json(200, Object.keys(s.d1.alias).sort());
      m = path.match(/^\/_admin\/aliases\/([^/]+)(\/history)?$/);
      if (m && ALIAS.test(m[1])) {
        const name = m[1];
        if (m[2] && method === 'GET') return json(200, s.d1.history.filter((r) => r.name === name).map((r, i, a) => ({ schema: 'alias/v1', name, contentId: r.content_id, generation: r.generation, previousContentId: i > 0 ? a[i - 1].content_id : null })));
        if (method === 'GET') {
          if (s.faults.staleAliasReads && s.d1.stale?.[name]) { s.faults.staleAliasReads -= 1; return json(200, s.d1.stale[name]); }
          const rec = aliasRecord(name);
          return rec ? json(200, rec) : json(404, { error: 'no such alias' });
        }
        if (method === 'POST') {
          const { expectGeneration, contentId, opId = null } = JSON.parse(body.toString('utf8'));
          const mine = s.d1.alias[name];
          if (opId && mine && mine.op_id === opId && mine.generation === expectGeneration + 1 && mine.content_id === contentId) return json(200, aliasRecord(name));
          if (!s.r2[`p/${contentId}/manifest.json`]) return json(412, { error: 'target manifest not present' });
          const stamp = new Date(now()).toISOString();
          // Fault raceAliasWrite: another promoter's UPDATE commits first (re-promoting
          // the current content at the next generation), so this CAS must lose.
          if (s.d1.alias[name] && takeFault('raceAliasWrite')) {
            const cur = s.d1.alias[name];
            s.d1.alias[name] = { content_id: cur.content_id, generation: cur.generation + 1, updated_at: stamp };
            s.d1.history.push({ name, generation: cur.generation + 1, content_id: cur.content_id, updated_at: stamp });
          }
          const row = s.d1.alias[name];
          const before = aliasRecord(name);
          if (expectGeneration === 0) {
            if (row) return json(409, { error: 'cas lost', currentGeneration: row.generation });
            s.d1.alias[name] = { content_id: contentId, generation: 1, updated_at: stamp, op_id: opId };
          } else {
            // UPDATE alias SET ... WHERE name=? AND generation=? ; meta.changes === 0 -> lost
            if (!row || row.generation !== expectGeneration) return json(409, { error: 'cas lost', currentGeneration: row ? row.generation : 0 });
            s.d1.alias[name] = { content_id: contentId, generation: row.generation + 1, updated_at: stamp, op_id: opId };
          }
          s.d1.history.push({ name, generation: s.d1.alias[name].generation, content_id: contentId, updated_at: stamp });
          if (before) { s.d1.stale = s.d1.stale ?? {}; s.d1.stale[name] = before; }
          return json(200, aliasRecord(name));
        }
      }
      m = path.match(/^\/_admin\/receipts\/([A-Za-z0-9._-]+\.json)$/);
      if (m && method === 'PUT') {
        if (takeFault('failReceipts')) return json(500, { error: 'receipt store unavailable (injected)' });
        if (s.receipts[m[1]]) return json(409, { error: 'receipt exists' });
        s.receipts[m[1]] = body.toString('utf8');
        return json(201, { outcome: 'created' });
      }
      return json(404, { error: 'no such route' });
    } finally {
      store.save();
    }
  }

  return {
    handle,
    state: s,
    log,
    credentials: () => ({ clientId: s.access.clientId, clientSecret: s.access.clientSecret }),
    inject(faults) { Object.assign(s.faults, faults); store.save(); },
    expireToken() { s.access.expiresAt = now() - 1; store.save(); },
    renewToken(ttlMs = 3600_000) { s.access.expiresAt = now() + ttlMs; store.save(); return { clientId: s.access.clientId, clientSecret: s.access.clientSecret }; },
  };
}
