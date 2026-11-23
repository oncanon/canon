// The real transport to the Cloudflare test Worker's ingest API (docs/v2/research/
// cloudflare-adapter.md §1, §3.6, §3.7 B). It is the only module under src/ that may
// use a network client (the static gate names it), and only the adapter factory
// (targets.mjs) may construct it, after the default refusal has been passed: an
// explicit workers.dev endpoint, the credential in the environment, and a grant.
//
// It sends a request only to the configured origin and only under /_admin/; it never
// follows a redirect (an Access login redirect means the service token was not
// accepted); a timeout is reported as the retryable 599 the adapters already map to
// TIMEOUT; a response body is capped. It holds no credential itself: the adapter adds
// the Access service-token headers to each request.
import { CODES, PublicationError } from '../errors.mjs';
import { customHttpsOrigin, loopbackOrigin, workersDevOrigin } from './endpoint.mjs';

export class CloudflareHttpTransport {
  // connectTo: tests only, a loopback origin to connect to instead of the endpoint.
  // allowCustomDomain: SH-2, re-validated here independently of assertTargetAvailable
  // (policy.mjs:47), since this constructor is the transport's own point of truth.
  constructor({ endpoint, allowCustomDomain = false, connectTo = null, fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxResponseBytes = 32 * 1024 * 1024 }) {
    this.origin = allowCustomDomain ? customHttpsOrigin(endpoint) : workersDevOrigin(endpoint);
    this.connectOrigin = connectTo ? loopbackOrigin(connectTo) : this.origin;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.requests = 0;
  }

  async request({ method, path, headers = {}, body = null }) {
    if (typeof path !== 'string' || !path.startsWith('/_admin/') || path.includes('..') || /[\s#]/.test(path)) {
      throw new PublicationError(CODES.INVALID, `the Cloudflare transport only sends /_admin/ requests (refused ${JSON.stringify(String(path).slice(0, 80))})`);
    }
    const url = new URL(path, this.connectOrigin);
    if (url.origin !== this.connectOrigin) throw new PublicationError(CODES.INVALID, 'request would leave the configured origin');
    // The request line must carry the path exactly as given: a signed admin request
    // (public target) signs these bytes, so a path the URL parser would rewrite is refused.
    if (`${url.pathname}${url.search}` !== path) throw new PublicationError(CODES.INVALID, 'request path is not in canonical form');
    this.requests += 1;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let res;
    try {
      res = await this.fetchImpl(url, { method, headers: lower, body: body ? Buffer.from(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      // A timeout, reset or refused connection: retryable, reported like a timeout.
      return { status: 599, headers: {}, body: Buffer.from(JSON.stringify({ error: `transport: ${err.name === 'TimeoutError' ? 'timed out' : 'connection failed'}` })) };
    }
    if (res.status >= 300 && res.status < 400) {
      // Access redirects a request it does not accept to its login page. Never follow it.
      await res.body?.cancel();
      return { status: 403, headers: {}, body: Buffer.from(JSON.stringify({ error: 'service token expired or not accepted (Access redirected to login)' })) };
    }
    const out = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > this.maxResponseBytes) throw new PublicationError(CODES.PROTOCOL, `response to ${method} ${path} exceeds ${this.maxResponseBytes} bytes`);
      chunks.push(chunk);
    }
    return { status: res.status, headers: out, body: Buffer.concat(chunks) };
  }
}
