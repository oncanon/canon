// receipt/v2 (docs/v2/publication-protocol.md §7): built from structured fields
// only, schema-validated, and scanned for secrets before it is written. A receipt
// that would carry a secret is never written: the operation fails as receipt-failed.
import { randomBytes } from 'node:crypto';
import { TOOL } from '../policy.mjs';
import { CODES, PublicationError } from './errors.mjs';
import { assertValid } from './schemas.mjs';

// Header names and token shapes that must never appear in a receipt, in addition to
// the live secret values the adapter reports for the scan.
const SECRET_MARKERS = [
  /cf-access-client-secret/i,
  /cf-access-jwt-assertion/i,
  /x-amz-security-token/i,
  /\bauthorization\b/i,
  /\bsignature=/i,
  /cloudfront-signature/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
];

// A receipt ID, defined once: the time of the operation with its colons and dot as hyphens, the
// operation, and a random part. receiptId() fills the three parts in. receiptIdPattern() is the
// same definition as a regular expression source with the time and the random part left open (a
// dry run names its receipts with it, since their IDs do not exist until the operation runs):
// its time is the stamp of an instant with each digit opened, its random part the same length.
const RANDOM_BYTES = 4;
const stamp = (iso) => iso.replace(/[:.]/g, '-');
const idOf = (time, operation, random) => `${time}-${operation}-${random}`;

export function receiptId(operation, clock) {
  return idOf(stamp(clock()), operation, randomBytes(RANDOM_BYTES).toString('hex'));
}

export const receiptIdPattern = (operation) => idOf(stamp(new Date(0).toISOString()).replace(/[0-9]/g, '[0-9]'), operation, `[0-9a-f]{${RANDOM_BYTES * 2}}`);

export function buildReceipt(fields) {
  const receipt = {
    schema: 'receipt/v2',
    toolVersion: `${TOOL.name}@${TOOL.version}`,
    transitions: [],
    objects: [],
    readBack: { verified: false, mismatches: [] },
    requestCount: 0,
    bytesUploaded: 0,
    estimatedCostUsd: 0,
    ...fields,
  };
  for (const k of Object.keys(receipt)) if (receipt[k] === undefined) delete receipt[k];
  return assertValid('receipt/v2', receipt, 'receipt');
}

export function secretProblems(receipt, liveSecrets = []) {
  const text = JSON.stringify(receipt);
  const problems = [];
  for (const marker of SECRET_MARKERS) if (marker.test(text)) problems.push(`matches ${marker}`);
  for (const secret of liveSecrets.filter((s) => typeof s === 'string' && s.length >= 8)) if (text.includes(secret)) problems.push('contains a live credential value');
  return problems;
}

export function assertSecretFree(receipt, liveSecrets = []) {
  const problems = secretProblems(receipt, liveSecrets);
  if (problems.length) throw new PublicationError(CODES.RECEIPT_FAILED, `receipt would carry secret material (${problems.join('; ')}); it was not written`);
  return receipt;
}
