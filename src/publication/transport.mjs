// The only boundary between a provider adapter and a provider (docs/v2/
// publication-protocol.md §3, §8). Two implementations exist: this in-process
// transport, which hands each request to a local mock endpoint object, and the real
// Cloudflare transport (transports/cloudflare-http.mjs), refused by default and built
// only by the adapter factory. The static gate (test/unit/v2-static-gate.test.mjs)
// fails the build if any other module under src/ reaches the network.
//
// Request:  { method, path, headers: { lower-case: string }, body?: Buffer }
// Response: { status, headers: { lower-case: string }, body: Buffer }
export class InProcessTransport {
  constructor(endpoint) {
    if (!endpoint || typeof endpoint.handle !== 'function') throw new TypeError('InProcessTransport needs an endpoint with handle()');
    this.endpoint = endpoint;
    this.requests = 0;
  }

  async request({ method, path, headers = {}, body = null }) {
    this.requests += 1;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const res = await this.endpoint.handle({ method, path, headers: lower, body: body ? Buffer.from(body) : null });
    return { status: res.status, headers: Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: Buffer.from(res.body ?? '') };
  }
}
