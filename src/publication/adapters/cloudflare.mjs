// Cloudflare adapter: talks to the Worker ingest API (docs/v2/research/cloudflare-adapter.md
// §1, §3.7 B) through a transport, holding only an Access service token, or, for a
// public target (V2.1 slice 04), only a publisher signing key: `signer` then signs every
// request (signing.mjs) and no Access header is sent. It never holds an R2 key or a
// Cloudflare API token, and it has no delete call.
import { CODES, PublicationError } from '../errors.mjs';

export function cloudflareAdapter({ transport, credentials, kind = 'mock-cloudflare', signer = null }) {
  const auth = (method, path, body, contentType) => (signer ? signer({ method, path, body, contentType }) : { 'cf-access-client-id': credentials.clientId, 'cf-access-client-secret': credentials.clientSecret });

  async function call(method, path, { headers = {}, body = null } = {}) {
    const res = await transport.request({ method, path, headers: { ...headers, ...auth(method, path, body, headers['content-type'] ?? '') }, body });
    if (res.status === 429 || res.status === 503) throw new PublicationError(CODES.THROTTLED, `${method} ${path}: ${res.status}`);
    if (res.status === 599) throw new PublicationError(CODES.TIMEOUT, `${method} ${path}: timed out`);
    if (res.status === 403) {
      const reason = safeJson(res.body)?.error ?? '';
      throw new PublicationError(/expired/.test(reason) ? CODES.CREDENTIAL_EXPIRED : CODES.PROTOCOL, `${method} ${path}: 403 ${reason}`);
    }
    return res;
  }

  const safeJson = (b) => { try { return JSON.parse(b.toString('utf8')); } catch { return null; } };
  const objPath = (key) => `/_admin/objects/${key.split('/').map(encodeURIComponent).join('/')}`;

  const adapter = {
    describe: () => ({ kind, credentialClass: signer ? 'publisher-signing-key' : 'access-service-token' }),
    liveSecrets: () => (signer ? [credentials.privateKey] : [credentials.clientSecret, credentials.clientId]),
    requestCount: () => transport.requests,

    async putIfAbsent({ key, sha256, contentType, cacheControl }, bytes) {
      const res = await call('PUT', objPath(key), { headers: { 'if-none-match': '*', 'x-rp-sha256': sha256, 'content-type': contentType, 'cache-control': cacheControl }, body: bytes });
      const payload = safeJson(res.body) ?? {};
      if (res.status === 201) return { outcome: 'created' };
      if (res.status === 200 && payload.outcome === 'identical') return { outcome: 'identical' };
      if (res.status === 409) return { outcome: 'conflict', ...(payload.existingSha256 ? { existingSha256: payload.existingSha256 } : {}) };
      if (res.status === 400 && payload.error === 'bad-digest') throw new PublicationError(CODES.BAD_DIGEST, `${key}: the Worker rejected the SHA-256`);
      throw new PublicationError(CODES.PROTOCOL, `PUT ${key}: unexpected ${res.status}`);
    },

    async headObject(key) {
      const res = await call('HEAD', objPath(key));
      if (res.status === 404) return { exists: false };
      if (res.status !== 200) throw new PublicationError(CODES.PROTOCOL, `HEAD ${key}: unexpected ${res.status}`);
      return { exists: true, bytes: Number(res.headers['content-length']), sha256: res.headers['x-rp-sha256'], contentType: res.headers['content-type'], cacheControl: res.headers['cache-control'] };
    },

    async getObject(key) {
      const res = await call('GET', objPath(key));
      if (res.status === 404) return null;
      if (res.status !== 200) throw new PublicationError(CODES.PROTOCOL, `GET ${key}: unexpected ${res.status}`);
      return res.body;
    },

    async readAlias(name) {
      const res = await call('GET', `/_admin/aliases/${name}`);
      if (res.status === 404) return null;
      return safeJson(res.body);
    },

    // The D1 batch writes the alias and its history atomically. The operation ID makes
    // a retry idempotent: if an earlier attempt committed and its response was lost,
    // the Worker answers 200 with that move rather than a lost CAS.
    async casAlias(name, expectGeneration, contentId, { opId = null } = {}) {
      const res = await call('POST', `/_admin/aliases/${name}`, { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ expectGeneration, contentId, opId })) });
      const payload = safeJson(res.body) ?? {};
      if (res.status === 200) return { ok: true, record: payload };
      if (res.status === 409) return { ok: false, currentGeneration: payload.currentGeneration };
      if (res.status === 412) throw new PublicationError(CODES.TARGET_NOT_VERIFIED, `alias ${name}: the Worker found no manifest for ${contentId}`);
      throw new PublicationError(CODES.PROTOCOL, `alias CAS ${name}: unexpected ${res.status}`);
    },

    // History is written in the CAS's own D1 batch, so there is nothing to append:
    // confirm the entry for this generation is present and matches.
    async appendHistory(name, record) {
      const entry = (await adapter.readHistory(name)).find((r) => r.generation === record.generation);
      if (entry && entry.contentId === record.contentId) return { written: false };
      throw new PublicationError(CODES.PROTOCOL, `alias history ${name}#${record.generation} is missing or different, although D1 writes it with the CAS`);
    },

    async readHistory(name) {
      // An unreadable history is an error, never an empty one.
      const res = await call('GET', `/_admin/aliases/${name}/history`);
      if (res.status !== 200) throw new PublicationError(CODES.PROTOCOL, `alias history ${name}: ${res.status}`);
      return safeJson(res.body);
    },

    async listAliases() {
      const res = await call('GET', '/_admin/aliases');
      return safeJson(res.body) ?? [];
    },

    async writeReceipt(receipt) {
      const res = await call('PUT', `/_admin/receipts/${receipt.receiptId}.json`, { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(receipt)) });
      if (res.status !== 201) throw new PublicationError(CODES.RECEIPT_FAILED, `receipt ${receipt.receiptId}: ${res.status}`);
    },
  };
  return adapter;
}
