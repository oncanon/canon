import { createHash } from 'node:crypto';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export const CONTENT_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function contentIdFromIdentityBytes(bytes) {
  return `sha256-${sha256Hex(bytes)}`;
}
