// HTTP constants and the request-path parser shared by the local packet server
// (src/server/server.mjs) and the packet origin (src/origin/, ADR 0002). Kept in a module of
// their own, with no file or verify code, so the origin's import closure (and its container
// image) holds no packet verifier, builder or renderer: the origin never verifies.
import { CSP } from '../policy.mjs';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const NO_STORE = 'no-store';

// The packet origin (src/origin/) sets the same headers itself (ADR 0002).
export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

// Returns decoded path segments, or null if the request path is ambiguous or
// unsafe (encoded separators, NUL, backslash, dot segments, empty segments).
export function parseRequestPath(rawUrl) {
  const pathPart = rawUrl.split('?')[0].split('#')[0];
  if (!pathPart.startsWith('/')) return null;
  if (/%(?:2f|5c|00)/i.test(pathPart) || pathPart.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/') return { segments: [], trailingSlash: true };
  const trailingSlash = decoded.length > 1 && decoded.endsWith('/');
  const segments = decoded.split('/').slice(1);
  if (trailingSlash) segments.pop();
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return { segments, trailingSlash };
}
