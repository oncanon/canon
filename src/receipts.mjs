// Provider-neutral receipts (docs/decisions/phase1-contract.md D7). A receipt
// records an operation on an already-built content ID. Receipts live outside the
// packet, never feed identity, and are written with exclusive create so an
// existing receipt is never overwritten. Fields are a closed allowlist; there is
// no free-form field through which a secret or capability could be recorded.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RECEIPT_SCHEMA, TOOL } from './policy.mjs';

const OPERATIONS = new Set(['build', 'publish', 'alias']);
const PROVIDERS = new Set(['local-builder', 'filesystem']);

export function makeReceipt({ operation, provider, contentId, destination, startedAt, finishedAt, fileCount = null, totalBytes = null, manifestSha256 = null, outcome = null, readBack = null, errorClass = null, warnings = null, alias = null, admissionOverride = null }) {
  if (!OPERATIONS.has(operation)) throw new Error(`unknown operation ${operation}`);
  if (!PROVIDERS.has(provider)) throw new Error(`unknown provider ${provider}`);
  return {
    schema: RECEIPT_SCHEMA,
    operation,
    provider,
    tool: { name: TOOL.name, version: TOOL.version },
    contentId: contentId ?? null,
    destination: { kind: destination.kind, path: destination.path },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    result: errorClass ? 'failure' : 'success',
    outcome,
    errorClass,
    fileCount,
    totalBytes,
    manifestSha256,
    readBack,
    // report/v1 build lint warnings (render-policy/2 R7): structured records with fixed
    // codes, reserved prefixes, matched tokens and JSON pointers, never free text. null
    // when no lint ran (publish, alias, site builds, failed builds).
    warnings: operation === 'build' && Array.isArray(warnings) ? warnings.map(receiptWarning) : null,
    // Store admission override (render-policy-2.md R12): present only on a publish that
    // admitted a render-policy/1 packet because --allow-render-policy-1 was given after the
    // default moved to render-policy/2. While the gate is dormant the key never appears.
    ...(operation === 'publish' && admissionOverride ? { admissionOverride: { flag: admissionOverride.flag, renderPolicy: admissionOverride.renderPolicy, defaultRenderPolicy: admissionOverride.defaultRenderPolicy } } : {}),
    alias,
  };
}

function receiptWarning(w) {
  return {
    code: w.code,
    prefix: w.prefix,
    reservedFor: w.reservedFor,
    count: w.count,
    occurrences: w.occurrences.map((o) => ({ token: o.token, path: o.path })),
  };
}

// overwrite is for a fixed, user-chosen local path (e.g. build-docs/build-site's
// <out>.build-receipt.json), where the receipt describes the most recent build attempt
// into that --out, not a store history entry — once the prior build's own output has been
// cleared, a stale receipt beside it must not block a rebuild. receiptPathInStore's own
// randomized, timestamped paths never pass this: a store receipt is history and is never
// overwritten.
export async function writeReceipt(receipt, path, { overwrite = false } = {}) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(receipt, null, 2)}\n`, { flag: overwrite ? 'w' : 'wx', mode: 0o644 });
  return abs;
}

export function receiptPathInStore(root, receipt) {
  const stamp = receipt.startedAt.replace(/[:.]/g, '-');
  const id = receipt.contentId ? receipt.contentId.slice(7, 19) : 'none';
  return join(resolve(root), 'receipts', `${stamp}-${receipt.operation}-${id}-${randomBytes(4).toString('hex')}.json`);
}
