// publication/v1 error taxonomy (docs/v2/publication-protocol.md §5). Adapters map
// provider responses onto these codes; the protocol decides retry and stop.
export const CODES = Object.freeze({
  CONFLICT: 'conflict', // an immutable key holds different bytes: stop, human
  BAD_DIGEST: 'bad-digest', // the target rejected the upload's checksum
  READBACK_MISMATCH: 'readback-mismatch', // read-back bytes or hash differ: never promote
  ALIAS_CONFLICT: 'alias-conflict', // generation CAS lost: re-read, re-decide
  THROTTLED: 'throttled', // 429/503: bounded retry with backoff
  TIMEOUT: 'timeout', // bounded retry with backoff
  CREDENTIAL_EXPIRED: 'credential-expired', // stop; resume later from the receipt
  CREDENTIAL_MISSING: 'credential-missing', // the target's credential variable is absent: refused before any request
  TARGET_NOT_VERIFIED: 'target-not-verified', // promote/rollback to a missing or unverified ID
  RECEIPT_FAILED: 'receipt-failed', // report; never promote without a receipt
  HISTORY_INCOMPLETE: 'history-incomplete', // alias committed, its history append failed: reconcile repairs
  GRANT_MISSING: 'grant-missing', // the explicit CLI grant for this action is absent
  CLASSIFICATION_REFUSED: 'classification-refused', // packet class not allowed for the access mode
  RENDER_POLICY_REFUSED: 'render-policy-refused', // a render-policy/1 packet after the default moved, without --allow-render-policy-1 (render-policy-2.md R12)
  SYNTHETIC_ONLY: 'synthetic-only', // provider validation accepts synthetic packets only
  COST_CEILING: 'cost-ceiling', // projected spend would exceed the target's ceiling
  NOT_AVAILABLE: 'not-available', // no code path this phase (real providers, public exposure, delete)
  INVALID: 'invalid', // malformed request, config or packet
  PROTOCOL: 'protocol', // an adapter or endpoint broke the contract
});

export const RETRYABLE = new Set([CODES.THROTTLED, CODES.TIMEOUT]);

export class PublicationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PublicationError';
    this.code = code;
    this.details = details;
  }
}
