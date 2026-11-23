// Authority, classification, synthetic-data and cost policy for publication/v1
// (docs/v2/publication-protocol.md §6-§8). Every refusal is a PublicationError with a
// specific code, raised before any adapter call is made.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODES, PublicationError } from './errors.mjs';
import { customHttpsOrigin, workersDevOrigin } from './transports/endpoint.mjs';

export const PROVIDER_KINDS = new Set(['mock-cloudflare', 'cloudflare']);

// Which access modes a target kind may declare. `public` exists only as a real
// Cloudflare deployment (V2.1 slice 04, mode (c)): the structurally separate public
// target with signed admin requests. The mock models access-controlled deployments, so for
// it `public` is recognised and refused.
const ACCESS_MODES = {
  'fs': ['local'],
  'mock-cloudflare': ['access-private', 'public'],
  'cloudflare': ['access-private', 'public'],
};

// Operation -> the explicit grant it needs. Publishing to the local fs target is
// V1 behaviour and needs none; everything that reaches a provider target does.
export function requiredGrant(operation, target) {
  if (operation === 'publish') return target.kind === 'fs' ? null : 'upload';
  if (['promote', 'rollback', 'reconcile'].includes(operation)) return 'promote';
  throw new PublicationError(CODES.NOT_AVAILABLE, `operation ${operation} has no code path in this phase`);
}

export function assertGrant(operation, target, grants) {
  const need = requiredGrant(operation, target);
  if (need && !grants.has(need)) throw new PublicationError(CODES.GRANT_MISSING, `${operation} to ${target.name} needs the explicit grant --grant ${need}`, { need });
}

export function assertTargetAvailable(target) {
  // A real Cloudflare target is refused by default: only an explicit workers.dev
  // endpoint in the target file makes it eligible (the adapter factory then also
  // requires the credential in the environment and a grant).
  if (target.kind === 'cloudflare') {
    if (!target.endpoint) throw new PublicationError(CODES.NOT_AVAILABLE, `cloudflare target ${target.name} has no endpoint: the real transport stays refused until one is configured`);
    // SH-2: a target file may set `allowCustomDomain: true` to accept a non-workers.dev https
    // origin here; absent or false, the default refusal (workers.dev only) is unchanged.
    (target.allowCustomDomain === true ? customHttpsOrigin : workersDevOrigin)(target.endpoint);
  }
  if (!ACCESS_MODES[target.kind]?.includes(target.accessMode)) throw new PublicationError(CODES.INVALID, `access mode ${target.accessMode} is not valid for a ${target.kind} target`);
  if (target.accessMode === 'public') {
    if (target.kind !== 'cloudflare') throw new PublicationError(CODES.NOT_AVAILABLE, `public exposure exists only as a real Cloudflare target (V2.1 mode (c)), not ${target.kind}`);
    if (!target.targetId) throw new PublicationError(CODES.INVALID, `public target ${target.name} needs a targetId (its Worker's TARGET_ID)`);
  }
}

// The artifact's publication extension, with defaults (absent = V1 report or site). A
// site-bundle/v1 manifest carries its publication block under `site`, not `report` (SH-3b).
export function packetPublication(manifest) {
  const pub = (manifest.schema === 'site-bundle/v1' ? manifest.site?.publication : manifest.report?.publication) ?? {};
  return { classification: pub.classification ?? 'private-review', dataOrigin: pub.dataOrigin ?? 'production' };
}

// Classification vs access mode, as one rule: a packet that is not classified
// `public` reaches only an access-controlled mode. Every mode except `public` is
// access-controlled, so `confidential` and `private-review` never reach a public
// target. It is the live guard for the public Cloudflare target (V2.1 slice 04), checked
// on publish and again on promote and rollback against the manifest on the target.
const ACCESS_CONTROLLED = new Set(['local', 'access-private']);

export function assertClassification(manifest, target) {
  const { classification } = packetPublication(manifest);
  if (classification !== 'public' && !ACCESS_CONTROLLED.has(target.accessMode)) {
    throw new PublicationError(CODES.CLASSIFICATION_REFUSED, `a ${classification} packet cannot go to a ${target.accessMode} target`);
  }
}

// Provider validation takes synthetic packets only: a packet must say so
// explicitly (publication.dataOrigin = "synthetic"); absent means production.
// SH-1: a target file may set `allowProductionData: true` to acknowledge real data
// explicitly; the default refusal is unchanged when the field is absent or false.
export function assertSyntheticForProvider(manifest, target) {
  if (!PROVIDER_KINDS.has(target.kind)) return;
  const { dataOrigin } = packetPublication(manifest);
  if (dataOrigin === 'synthetic') return;
  if (target.allowProductionData === true) return;
  throw new PublicationError(CODES.SYNTHETIC_ONLY, `provider targets accept only packets declaring publication.dataOrigin "synthetic" during validation (this packet: ${dataOrigin})`);
}

// Whether this operation's manifest is production (non-synthetic) data. By the time a
// receipt is built, a provider target has already passed assertSyntheticForProvider, so
// true here is evidence the operator's allowProductionData switch was explicit, not
// inferred: the operation would have been refused before any receipt otherwise.
export function productionAcknowledged(manifest) {
  return packetPublication(manifest).dataOrigin !== 'synthetic';
}

// ---- cost ------------------------------------------------------------------------------
// List prices from docs/v2/cost-model.md (research read 2026-09-26). Free tiers are
// ignored, so estimates are upper bounds.
export const UNIT_PRICES = Object.freeze({
  'fs': { write: 0, read: 0, storageGbMonth: 0, aliasWrite: 0 },
  'mock-cloudflare': { write: 4.5 / 1e6, read: 0.36 / 1e6, storageGbMonth: 0.015, aliasWrite: 0 },
  'cloudflare': { write: 4.5 / 1e6, read: 0.36 / 1e6, storageGbMonth: 0.015, aliasWrite: 0 },
});

export function estimateCost(kind, { writes = 0, reads = 0, bytes = 0, aliasWrites = 0 }) {
  const p = UNIT_PRICES[kind];
  // A packet stored for one month is charged in the month it is written.
  const usd = writes * p.write + reads * p.read + (bytes / 1e9) * p.storageGbMonth + aliasWrites * p.aliasWrite;
  return Math.round(usd * 1e8) / 1e8;
}

const monthOf = (iso) => iso.slice(0, 7);

// The ledger is a local append-only JSONL per target: one line per receipt.
export function ledgerPath(target) {
  return join(target.ledgerDir ?? join(target.stateDir ?? target.root ?? '.', 'ledger'), `${target.name.replace(/:/g, '_')}.jsonl`);
}

export async function monthToDate(target, nowIso) {
  const text = await readFile(ledgerPath(target), 'utf8').catch((err) => (err.code === 'ENOENT' ? '' : Promise.reject(err)));
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => monthOf(e.at) === monthOf(nowIso)).reduce((n, e) => n + e.estimatedCostUsd, 0);
}

export async function assertWithinCeiling(target, projectedUsd, nowIso) {
  const spent = await monthToDate(target, nowIso);
  if (spent + projectedUsd > target.costCeilingUsdPerMonth) {
    throw new PublicationError(CODES.COST_CEILING, `projected ${(spent + projectedUsd).toFixed(6)} USD this month exceeds the ${target.costCeilingUsdPerMonth} USD ceiling for ${target.name}`, { spent, projectedUsd, ceiling: target.costCeilingUsdPerMonth });
  }
  return { spent, projectedUsd };
}

export async function recordCost(target, receipt) {
  const path = ledgerPath(target);
  await mkdir(join(path, '..'), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: receipt.finishedAt, receiptId: receipt.receiptId, operation: receipt.operation, requestCount: receipt.requestCount, bytesUploaded: receipt.bytesUploaded, estimatedCostUsd: receipt.estimatedCostUsd })}\n`);
}
