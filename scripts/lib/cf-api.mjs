// The one Cloudflare API client for the V2.1 operator scripts (pre-flight, D1 schema, token
// verify, absence listings). It fails closed:
//
// - DRY-RUN BY DEFAULT. Without `live: true` nothing is sent; the caller gets the exact
//   request it would make (method, URL, body), which the scripts print for review.
// - LIVE only with `live: true` AND a token in the named environment variable (default
//   CLOUDFLARE_API_TOKEN). The token is never written, logged or echoed; responses are
//   returned, never the request's headers.
// - ONE ORIGIN: https://api.cloudflare.com/client/v4. Tests alone may redirect it to a
//   loopback origin (http://127.0.0.1:<port>) through `connectTo`; nothing else is accepted,
//   and no request may leave the chosen origin.
//
// Pure library: nothing runs on import. Running any script live is an external action that
// needs the maintainer's confirmation (runbook).
export const API_ORIGIN = 'https://api.cloudflare.com';
export const API_BASE = '/client/v4';

export class CfApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CfApiError';
    Object.assign(this, details);
  }
}

export function loopbackOnly(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CfApiError('connectTo is not a URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username || url.password) {
    throw new CfApiError(`connectTo ${url.origin} is not a loopback http://127.0.0.1:<port> origin`);
  }
  return url.origin;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
export function checkId(what, value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new CfApiError(`${what} must be an identifier ([A-Za-z0-9-], 1-64 characters)`);
  return value;
}

// A Cloudflare API client. `fetchImpl` is injectable for tests.
export function cfApi({ live = false, tokenEnv = 'CLOUDFLARE_API_TOKEN', env = process.env, connectTo = null, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const origin = connectTo ? loopbackOnly(connectTo) : API_ORIGIN;
  const token = live ? env[tokenEnv] : null;
  if (live && (typeof token !== 'string' || !token.trim())) throw new CfApiError(`live mode needs a token in $${tokenEnv}; none is set`, { code: 'credential-missing' });
  async function request(method, path, { body = null, query = null } = {}) {
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) throw new CfApiError(`bad API path ${path}`);
    const url = new URL(`${API_BASE}${path}`, origin);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    if (url.origin !== origin) throw new CfApiError('request would leave the API origin');
    // What is shown and recorded: the public API URL, never the loopback test origin or a token.
    const shown = `${API_ORIGIN}${url.pathname}${url.search}`;
    const planned = { method, url: shown, body };
    if (!live) return { dryRun: true, request: planned };
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CfApiError(`request failed: ${err.name}`, { request: planned });
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { dryRun: false, request: planned, status: res.status, json, text: json ? null : text.slice(0, 2000) };
  }
  return { request, live, origin };
}

// Cloudflare's error codes from a v4 response envelope.
export const errorCodes = (json) => (Array.isArray(json?.errors) ? json.errors.map((e) => e?.code).filter((c) => c !== undefined) : []);
