// The one place a Cloudflare endpoint is judged (pure: no network). The publisher
// talks only to its test Worker on workers.dev: no custom domain, DNS, route or
// public hostname has a code path (docs/v2/architecture.md §1; directive:
// "workers.dev only"). An endpoint is the bare origin https://<worker>.workers.dev.
import { CODES, PublicationError } from '../errors.mjs';

const WORKERS_DEV_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.workers\.dev$/;

export function workersDevOrigin(value) {
  const refuse = (why) => new PublicationError(CODES.INVALID, `Cloudflare endpoint must be the bare origin https://<worker>.workers.dev (workers.dev only): ${why}`);
  if (typeof value !== 'string' || !value) throw refuse('none given');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw refuse('not a URL');
  }
  if (url.protocol !== 'https:') throw refuse(`scheme ${url.protocol} is not https`);
  if (url.username || url.password) throw refuse('it carries user information');
  if (url.port) throw refuse(`port ${url.port} is not allowed`);
  if (!WORKERS_DEV_HOST.test(url.hostname)) throw refuse(`host ${url.hostname} is not a workers.dev host`);
  if (url.pathname !== '/' || url.search || url.hash) throw refuse('it has a path, query or fragment');
  return url.origin;
}

// SH-2: the same shape checks as workersDevOrigin, without the workers.dev suffix test, for
// a target file that has explicitly set allowCustomDomain: true.
export function customHttpsOrigin(value) {
  const refuse = (why) => new PublicationError(CODES.INVALID, `Cloudflare endpoint must be a plain https origin (allowCustomDomain: true): ${why}`);
  if (typeof value !== 'string' || !value) throw refuse('none given');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw refuse('not a URL');
  }
  if (url.protocol !== 'https:') throw refuse(`scheme ${url.protocol} is not https`);
  if (url.username || url.password) throw refuse('it carries user information');
  if (url.port) throw refuse(`port ${url.port} is not allowed`);
  if (url.pathname !== '/' || url.search || url.hash) throw refuse('it has a path, query or fragment');
  return url.origin;
}

// Tests only: the loopback origin a transport may connect to instead of the configured
// workers.dev origin. Never read from a target file (the schema has no such field).
export function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublicationError(CODES.INVALID, 'loopback connect target is not a URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username) {
    throw new PublicationError(CODES.INVALID, `connect target ${url.origin} is not a loopback http://127.0.0.1:<port> origin`);
  }
  return url.origin;
}
