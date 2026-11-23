// A deployed public-target stand-in (V2.1 slice 04): the real Worker in MODE=public, the
// fake R2/D1 bindings, and no Access anywhere. The Worker must never fetch Access keys,
// so its certs fetcher fails the test if called.
import { adminSigner, generateSigningKey } from '../../src/publication/signing.mjs';
import { fakeD1, fakeR2 } from '../v2/worker-bindings.mjs';

export const PUBLIC_TARGET_ID = 'rp-public-test-20260930-a1';

export async function publicDeployment({ now } = {}) {
  const { createWorker } = await import('../../src/publication/worker/index.mjs');
  const keys = generateSigningKey();
  const other = generateSigningKey();
  const certsFetched = [];
  const worker = createWorker({ fetchCerts: async (url) => { certsFetched.push(url); throw new Error('a public Worker fetches no Access keys'); }, ...(now ? { now } : {}) });
  const env = { PACKETS: fakeR2(), ALIASES: fakeD1(), MODE: 'public', TARGET_ID: PUBLIC_TARGET_ID, PUBLISHER_PUBLIC_KEY: keys.publicKey };
  const origin = 'https://rp-public-test.example.workers.dev';
  const hasBody = (method) => method !== 'GET' && method !== 'HEAD';

  // One request straight to the Worker; the result in the transport's shape.
  async function send({ method, path, headers = {}, body = null }, overrideEnv = env) {
    const res = await worker.fetch(new Request(`${origin}${path}`, { method, headers, body: body && hasBody(method) ? body : undefined }), overrideEnv);
    return { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(await res.arrayBuffer()) };
  }

  // Signature headers for a request, with every input overridable for the attacks.
  function sign({ method, path, body = null, contentType = '' }, { privateKey = keys.privateKey, targetId = PUBLIC_TARGET_ID, at = now ? now() : Date.now() } = {}) {
    return adminSigner({ targetId, privateKey, now: () => at })({ method, path, body, contentType });
  }

  const credentials = { privateKey: keys.privateKey };
  return { worker, env, keys, other, origin, certsFetched, credentials, send, sign, transport: { requests: 0, async request(req) { this.requests += 1; return send(req); } } };
}
