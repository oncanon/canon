// publication/v1 state machine (docs/v2/publication-protocol.md §4):
//
//   PLANNED -> UPLOADING (sorted files, checksums.json, manifest.json last) -> UPLOADED
//   -> READBACK_VERIFIED --(separate promote grant)--> PROMOTING -> PROMOTED
//
// A DRY RUN (dryRun: true) of publish, promote or rollback stops at PLANNED: it makes every local
// check the operation makes, returns the writes the operation would send, and sends nothing. It
// calls no adapter method, so it needs no adapter, grant or credential.
//
// Invariants: no alias ever moves to a content ID that is not verified on that same
// target at that moment; no failure changes a content ID or overwrites an object;
// every operation writes a receipt, and an alias never moves unless its intent
// receipt was written first. There is no delete anywhere in this module.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../hash.mjs';
// Full verify: independent rules plus, for render-policy/2, reproduction (R11).
import { verifyPacketFull as verifyPacket } from '../packet/reproduce.mjs';
import { verifySiteBundle } from '../site/verify.mjs';
import { admissionDecision, admittedRenderPolicy } from '../publish/admission.mjs';
import { CODES, PublicationError, RETRYABLE } from './errors.mjs';
import { assertClassification, assertGrant, assertSyntheticForProvider, assertTargetAvailable, assertWithinCeiling, estimateCost, productionAcknowledged, recordCost, requiredGrant } from './policy.mjs';
import { assertSecretFree, buildReceipt, receiptId, receiptIdPattern } from './receipts.mjs';
import { assertValid } from './schemas.mjs';

const STATE_OF_CODE = {
  [CODES.CONFLICT]: 'CONFLICT',
  [CODES.BAD_DIGEST]: 'READBACK_MISMATCH',
  [CODES.READBACK_MISMATCH]: 'READBACK_MISMATCH',
  [CODES.ALIAS_CONFLICT]: 'ALIAS_CONFLICT',
  [CODES.THROTTLED]: 'THROTTLED',
  [CODES.TIMEOUT]: 'TIMEOUT',
  [CODES.CREDENTIAL_EXPIRED]: 'CREDENTIAL_EXPIRED',
  [CODES.TARGET_NOT_VERIFIED]: 'TARGET_NOT_VERIFIED',
  [CODES.RECEIPT_FAILED]: 'RECEIPT_FAILED',
  [CODES.HISTORY_INCOMPLETE]: 'HISTORY_INCOMPLETE',
};
// A failure with no state of its own (a 5xx, a broken contract) is FAILED.
const stateOf = (code) => STATE_OF_CODE[code] ?? 'FAILED';


export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const objectKey = (contentId, path) => `p/${contentId}/${path}`;

const defaultClock = () => new Date().toISOString();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded retry with exponential backoff, for throttling and timeouts only.
// An error marked details.outcomeUnknown (the call may have been carried out) is never retried
// unless the caller declares the call idempotent: `idempotent: true` says a second attempt after
// a first that succeeded unseen changes nothing. The default is that it is not.
export async function withRetry(fn, { attempts = 4, baseMs = 20, sleep = defaultSleep, onRetry = () => {}, idempotent = false } = {}) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof PublicationError) || !RETRYABLE.has(err.code) || i >= attempts) throw err;
      if (err.details?.outcomeUnknown === true && idempotent !== true) throw err;
      onRetry(err, i);
      await sleep(baseMs * 2 ** (i - 1));
    }
  }
}

// Upload order: every inventory file sorted by path, then checksums.json, then
// manifest.json, which is the commit marker.
export function uploadOrder(manifest) {
  return [...manifest.files.map((f) => f.path).sort(), 'checksums.json', 'manifest.json'];
}

// Is `contentId` complete and intact on this target right now? The manifest read
// from the target must hash to the content ID, and every file must read back with
// the manifest's SHA-256, size and media type.
// The keys verifyOnTarget reads for a packet: its manifest, every file, and checksums.json.
export const verifyKeys = (contentId, manifest) => [objectKey(contentId, 'manifest.json'), ...(manifest.files ?? []).map((f) => objectKey(contentId, f.path)), objectKey(contentId, 'checksums.json')];

export async function verifyOnTarget(adapter, contentId, { retry } = {}) {
  const mismatches = [];
  const manifestBytes = await withRetry(() => adapter.getObject(objectKey(contentId, 'manifest.json')), retry);
  if (!manifestBytes) return { verified: false, mismatches: ['manifest.json: missing on the target'], manifest: null };
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { verified: false, mismatches: ['manifest.json: not JSON'], manifest: null };
  }
  const { contentId: declared, ...identity } = manifest;
  if (declared !== contentId || contentIdFromIdentityBytes(canonicalBytes(identity)) !== contentId) mismatches.push('manifest.json: does not hash to the content ID');
  for (const file of manifest.files ?? []) {
    const key = objectKey(contentId, file.path);
    const bytes = await withRetry(() => adapter.getObject(key), retry);
    if (!bytes) { mismatches.push(`${file.path}: missing`); continue; }
    if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256) mismatches.push(`${file.path}: bytes differ from the manifest`);
    const head = await withRetry(() => adapter.headObject(key), retry);
    if (head.contentType !== undefined && head.contentType !== file.mediaType) mismatches.push(`${file.path}: served as ${head.contentType}, manifest says ${file.mediaType}`);
  }
  const checksums = await withRetry(() => adapter.getObject(objectKey(contentId, 'checksums.json')), retry);
  if (!checksums) mismatches.push('checksums.json: missing');
  return { verified: mismatches.length === 0, mismatches, manifest };
}

// What a dry run can say of receipts it does not write: an anchored pattern over the receipt ID
// of each.
function receiptPatterns(operation, phases) {
  return phases.map((phase) => `^${receiptIdPattern(operation)}${phase}$`);
}
// A dry run does not ask for the grant, so its plan says the real run will.
const grantLine = (operation, target) => { const need = requiredGrant(operation, target); return need ? [`grant ${need} is given (--grant ${need})`] : []; };

async function writeReceiptOrFail(adapter, receipt) {
  assertSecretFree(receipt, adapter.liveSecrets());
  try {
    await adapter.writeReceipt(receipt);
  } catch (err) {
    throw new PublicationError(CODES.RECEIPT_FAILED, `receipt ${receipt.receiptId} could not be written: ${err.code ?? err.message}`, { cause: err.code ?? null });
  }
}

function context(adapter, target, operation, clock) {
  const d = adapter.describe();
  return {
    receiptId: receiptId(operation, clock),
    operation,
    target: target.name,
    targetKind: target.kind,
    credentialClass: d.credentialClass,
    startedAt: clock(),
  };
}

// ---- publish ---------------------------------------------------------------------------
// Shared by publish (a packet, verified with verifyPacket) and publishSite (a site
// bundle, verified with verifySiteBundle): same state machine, same upload order,
// read-back and receipt code (docs/projects/review-packet-publisher.md SH-3). The two
// manifest shapes already carry different `schema` values (packet/v1, site-bundle/v1),
// so no new receipt field is needed to tell them apart on the target.
async function publishArtifact(verify, { adapter, target, artifactDir, grants = new Set(), clock = defaultClock, retry = {}, dryRun = false, checkAdmission = async () => ({ admit: true, override: undefined }) }) {
  assertTargetAvailable(target);
  if (!dryRun) assertGrant('publish', target, grants);
  const local = await verify(artifactDir);
  if (!local.ok) throw new PublicationError(CODES.INVALID, `${artifactDir} is not a verified packet`, { errors: local.errors });
  const manifestBytes = await readFile(join(artifactDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertClassification(manifest, target);
  assertSyntheticForProvider(manifest, target);
  // Store admission (render-policy-2.md R12): refused before any provider request, like
  // classification. Dormant while DEFAULT_RENDER_POLICY is render-policy/1. publishSite
  // supplies no check: site-bundle/v1 is not gated.
  const admission = await checkAdmission();
  if (!admission.admit) throw new PublicationError(CODES.RENDER_POLICY_REFUSED, admission.message);
  const contentId = local.contentId;
  const order = uploadOrder(manifest);
  const media = new Map([...manifest.files.map((f) => [f.path, f.mediaType]), ['checksums.json', 'application/json'], ['manifest.json', 'application/json']]);
  const files = [];
  for (const path of order) {
    const bytes = await readFile(join(artifactDir, path));
    files.push({ path, key: objectKey(contentId, path), bytes, sha256: sha256Hex(bytes) });
  }
  const totalBytes = files.reduce((n, f) => n + f.bytes.length, 0);
  const projected = estimateCost(target.kind, { writes: files.length + 1, reads: files.length * 2 + 2, bytes: totalBytes });
  await assertWithinCeiling(target, projected, clock());
  const putRequest = (f) => assertValid('adapter-put-request/v1', { key: f.key, sha256: f.sha256, bytes: f.bytes.length, contentType: media.get(f.path), cacheControl: CACHE_IMMUTABLE }, 'put request');
  if (dryRun) {
    // The puts in the order they would be sent (manifest.json last), then what is read back.
    return {
      state: 'PLANNED', dryRun: true, operation: 'publish', target: target.name, contentId,
      requests: files.map((f) => ({ op: 'putIfAbsent', ...putRequest(f) })),
      readBack: verifyKeys(contentId, manifest),
      receipts: 1, receiptPatterns: receiptPatterns('publish', ['']), bytes: totalBytes, estimatedCostUsd: projected,
      checkedOnlyAtRun: [...grantLine('publish', target), `no object under ${contentId} is already stored with other bytes`],
    };
  }

  const ctx = context(adapter, target, 'publish', clock);
  const startRequests = adapter.requestCount();
  const transitions = ['PLANNED', 'UPLOADING'];
  const objects = files.map((f) => ({ key: f.key, sha256: f.sha256, bytes: f.bytes.length, outcome: 'not-attempted' }));
  let bytesUploaded = 0;
  const finish = async (state, extra = {}) => {
    const receipt = buildReceipt({
      ...ctx, contentId, finishedAt: clock(), state, transitions: [...transitions, state].filter((s, i, a) => a.indexOf(s) === i), objects,
      requestCount: adapter.requestCount() - startRequests, bytesUploaded, admissionOverride: admission.override ?? undefined,
      estimatedCostUsd: estimateCost(target.kind, { writes: objects.filter((o) => o.outcome === 'created').length + 1, reads: adapter.requestCount() - startRequests, bytes: bytesUploaded }),
      productionAcknowledged: productionAcknowledged(manifest),
      ...extra,
    });
    await writeReceiptOrFail(adapter, receipt);
    await recordCost(target, receipt);
    return receipt;
  };

  try {
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const request = putRequest(f);
      const result = assertValid('adapter-put-result/v1', await withRetry(() => adapter.putIfAbsent(request, f.bytes), retry), 'put result');
      objects[i].outcome = result.outcome;
      if (result.outcome === 'created') bytesUploaded += f.bytes.length;
      if (result.outcome === 'conflict') throw new PublicationError(CODES.CONFLICT, `${f.key} already holds different bytes (sha256 ${result.existingSha256 ?? 'unknown'}); nothing was overwritten`);
    }
  } catch (err) {
    if (!(err instanceof PublicationError)) throw err;
    const state = err.code === CODES.CONFLICT ? 'CONFLICT' : objects.some((o) => o.outcome !== 'not-attempted') ? 'PARTIAL' : (STATE_OF_CODE[err.code] ?? 'PARTIAL');
    if (state === 'PARTIAL') transitions.push(STATE_OF_CODE[err.code] ?? 'PARTIAL');
    const receipt = await finish(state, { errorClass: err.code }).catch((e) => ({ receiptError: e }));
    err.details = { ...err.details, state, receipt };
    throw err;
  }
  transitions.push('UPLOADED');
  const check = await verifyOnTarget(adapter, contentId, { retry });
  const readBack = { verified: check.verified, mismatches: check.mismatches };
  if (!check.verified) {
    const receipt = await finish('READBACK_MISMATCH', { readBack, errorClass: CODES.READBACK_MISMATCH }).catch((e) => ({ receiptError: e }));
    throw new PublicationError(CODES.READBACK_MISMATCH, `read-back of ${contentId} failed: ${check.mismatches.join('; ')}`, { state: 'READBACK_MISMATCH', receipt });
  }
  const receipt = await finish('READBACK_VERIFIED', { readBack });
  return { state: 'READBACK_VERIFIED', contentId, receipt };
}

export const publish = ({ packetDir, allowRenderPolicy1 = false, ...opts }) => publishArtifact(verifyPacket, { ...opts, artifactDir: packetDir, checkAdmission: async () => admissionDecision(await admittedRenderPolicy(packetDir), { allowRenderPolicy1 }) });
export const publishSite = ({ bundleDir, ...opts }) => publishArtifact(verifySiteBundle, { ...opts, artifactDir: bundleDir });

// ---- promote / rollback ----------------------------------------------------------------
// Where an alias's history stands against its record. Complete: the history runs
// 1..g and ends at the current generation. The only repairable gap is the entry for
// the current generation itself, which the current record reproduces exactly.
//
// The alias and its history are two reads. A move committed between them would pair
// the old record with the new history, so the alias is read again after the history
// and the snapshot is used only if it did not move (bounded retries; if it keeps
// moving, the last reads are used and the CAS decides).
async function historyState(adapter, alias, retry) {
  let record;
  let history;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    record = await withRetry(() => adapter.readAlias(alias), retry);
    history = await withRetry(() => adapter.readHistory(alias), retry);
    const again = await withRetry(() => adapter.readAlias(alias), retry);
    const stable = (again?.generation ?? 0) === (record?.generation ?? 0);
    record = again;
    if (stable) break;
  }
  const gens = history.map((r) => r.generation);
  const dense = gens.every((g, i) => g === i + 1);
  const generation = record?.generation ?? 0;
  const historyGeneration = gens.at(-1) ?? 0;
  const complete = dense && historyGeneration === generation;
  return { record, history, generation, historyGeneration, complete, repairable: !complete && dense && record !== null && historyGeneration === generation - 1 };
}

// Alias moves (docs/v2/publication-protocol.md §4, §4.1). Before the CAS commits,
// every failure is reported as what it is and the alias has not moved. After the CAS
// commits, the move stands: nothing afterwards is reported as a conflict or a
// pre-commit failure. A failed history append is HISTORY_INCOMPLETE, which reconcile
// repairs.
async function moveAlias(operation, { adapter, target, alias, contentId, expectGeneration, grants = new Set(), clock = defaultClock, retry = {}, dryRun = false }) {
  assertTargetAvailable(target);
  if (!dryRun) assertGrant(operation, target, grants);
  if (!Number.isSafeInteger(expectGeneration) || expectGeneration < 0) throw new PublicationError(CODES.INVALID, 'expectGeneration must be a non-negative integer');
  // The ceiling is checked before any provider request; the projection is fixed.
  const projected = estimateCost(target.kind, { aliasWrites: 1, reads: 4 });
  await assertWithinCeiling(target, projected, clock());
  if (dryRun) {
    assertValid('alias/v1', { schema: 'alias/v1', name: alias, contentId, generation: expectGeneration + 1, previousContentId: null }, 'planned alias record');
    const toGeneration = expectGeneration + 1;
    // The two writes of a move, named by operation. What the target holds is not read, so the
    // checks that depend on it are named, not made.
    return {
      state: 'PLANNED', dryRun: true, operation, target: target.name, alias, contentId, expectGeneration, toGeneration,
      requests: [
        { op: 'casAlias', alias, expectGeneration, contentId, toGeneration },
        { op: 'appendHistory', alias, generation: toGeneration, contentId },
      ],
      receipts: 2, receiptPatterns: receiptPatterns(operation, ['-intent', '-result']), estimatedCostUsd: projected,
      checkedOnlyAtRun: [
        ...grantLine(operation, target),
        `${contentId} is complete and verified on the target`,
        `alias ${alias} is at generation ${expectGeneration}`,
        `the history of alias ${alias} is complete`,
        ...(operation === 'rollback' ? [`${contentId} was an earlier generation of alias ${alias}`] : []),
      ],
    };
  }
  const ctx = context(adapter, target, operation, clock);
  const startRequests = adapter.requestCount();
  const base = { ...ctx, contentId, aliasName: alias, fromGeneration: expectGeneration };
  const MOVED = new Set(['PROMOTED', 'HISTORY_INCOMPLETE']);
  // SH-1: set once the manifest on the target is read (verifyOnTarget, below); absent for a
  // receipt built before that (e.g. TARGET_NOT_VERIFIED), since there is no manifest yet to ask.
  let dataAck;
  // The intent and result receipts of one operation are separate append-only records.
  const receiptFor = (state, extra = {}) => buildReceipt({ ...base, receiptId: `${ctx.receiptId}-${extra.phase ?? 'result'}`, finishedAt: clock(), state, requestCount: adapter.requestCount() - startRequests, estimatedCostUsd: estimateCost(target.kind, { reads: adapter.requestCount() - startRequests, aliasWrites: MOVED.has(state) ? 1 : 0 }), ...(dataAck !== undefined ? { productionAcknowledged: dataAck } : {}), ...extra });
  // Once a request has reached the target, a failure still leaves a result receipt and a
  // ledger line for what it spent. The error thrown is the operation's own, whether or
  // not that receipt could be written; it is marked so it is receipted only once.
  const fail = async (state, err, extra = {}) => {
    const receipt = receiptFor(state, { phase: 'result', errorClass: err instanceof PublicationError ? err.code : CODES.PROTOCOL, ...extra });
    const written = await writeReceiptOrFail(adapter, receipt).then(() => true, () => false);
    if (written) await recordCost(target, receipt);
    err.receipted = true;
    throw err;
  };

  let readBack = { verified: false, mismatches: [] };
  let cas;
  try {
    // Verify on this target now: a missing or unverified ID is never promoted.
    const check = await verifyOnTarget(adapter, contentId, { retry });
    if (!check.verified) {
      await fail('TARGET_NOT_VERIFIED', new PublicationError(CODES.TARGET_NOT_VERIFIED, `${contentId} is not complete and verified on ${target.name}: ${check.mismatches.join('; ')}`), { readBack: { verified: false, mismatches: check.mismatches }, transitions: ['TARGET_NOT_VERIFIED'] });
    }
    readBack = { verified: true, mismatches: [] };
    dataAck = productionAcknowledged(check.manifest);
    // Classification and data origin come from the manifest on the target, so they are
    // checked after read-only verification and before any write.
    try {
      assertClassification(check.manifest, target);
      assertSyntheticForProvider(check.manifest, target);
    } catch (err) {
      await fail('REFUSED', err, { readBack, transitions: ['READBACK_VERIFIED', 'REFUSED'] });
    }
    // The alias does not move while its history is incomplete: a move would turn the
    // one repairable gap into a permanent one. This comes before the rollback check,
    // so a refused rollback states the real reason.
    // Only a move from the current generation is refused: a caller expecting another
    // generation has already lost, and the CAS reports that conflict truthfully.
    const hs = await historyState(adapter, alias, retry);
    if (!hs.complete && hs.generation === expectGeneration) {
      await fail('HISTORY_INCOMPLETE', new PublicationError(CODES.HISTORY_INCOMPLETE, `alias ${alias} is at generation ${hs.generation}, but its history ends at generation ${hs.historyGeneration}: the history append after an earlier move failed. Run reconcile to repair the history; the alias does not move until then`, { generation: hs.generation, historyGeneration: hs.historyGeneration }), { readBack, transitions: ['READBACK_VERIFIED', 'HISTORY_INCOMPLETE'] });
    }
    if (operation === 'rollback' && !hs.history.some((r) => r.contentId === contentId)) {
      await fail('TARGET_NOT_VERIFIED', new PublicationError(CODES.TARGET_NOT_VERIFIED, `${contentId} was never a generation of alias ${alias}; rollback only returns to an earlier target`), { readBack, transitions: ['READBACK_VERIFIED', 'TARGET_NOT_VERIFIED'] });
    }

    // The intent receipt comes first: without it the alias does not move.
    await writeReceiptOrFail(adapter, receiptFor('PROMOTING', { phase: 'intent', readBack, transitions: ['READBACK_VERIFIED', 'PROMOTING'] }));
    // The CAS is retried only while it cannot have committed; the operation ID lets a
    // retry recognise its own committed write when only the response was lost.
    cas = assertValid('adapter-cas-result/v1', await withRetry(() => adapter.casAlias(alias, expectGeneration, contentId, { opId: ctx.receiptId }), retry), 'CAS result');
    if (!cas.ok) {
      await fail('ALIAS_CONFLICT', new PublicationError(CODES.ALIAS_CONFLICT, `alias ${alias} is at generation ${cas.currentGeneration}, not ${expectGeneration}; re-read and re-decide`, { currentGeneration: cas.currentGeneration }), { readBack, transitions: ['READBACK_VERIFIED', 'PROMOTING', 'ALIAS_CONFLICT'] });
    }
  } catch (err) {
    if (err.receipted) throw err;
    // Every other exit before the commit (a throttle or timeout that outlasted its
    // retries, a 5xx, an expired credential) still leaves a result receipt.
    await fail(stateOf(err.code), err, { readBack, transitions: [stateOf(err.code)] });
  }

  // ---- committed: the alias is at cas.record.generation ------------------------------
  const moved = { toGeneration: cas.record.generation };
  const transitions = ['READBACK_VERIFIED', 'PROMOTING', 'PROMOTED'];
  const finishMoved = async (state, extra = {}) => {
    const receipt = receiptFor(state, { phase: 'result', readBack, ...moved, transitions, ...extra });
    try {
      await writeReceiptOrFail(adapter, receipt);
    } catch (err) {
      err.details = { ...err.details, state, record: cas.record, moved: true };
      err.message = `${err.message} (the alias did move, to generation ${cas.record.generation})`;
      err.receipted = true;
      throw err;
    }
    await recordCost(target, receipt);
    return receipt;
  };
  // History: appended by generation, idempotently, with bounded retry. Where the store
  // writes it with the CAS, this confirms it is there.
  try {
    await withRetry(() => adapter.appendHistory(alias, cas.record), retry);
  } catch (err) {
    const errorClass = err instanceof PublicationError ? err.code : CODES.PROTOCOL;
    transitions.push('HISTORY_INCOMPLETE');
    const receipt = await finishMoved('HISTORY_INCOMPLETE', { errorClass });
    const incomplete = new PublicationError(CODES.HISTORY_INCOMPLETE, `alias ${alias} moved to generation ${cas.record.generation} (${contentId}), but its history append failed (${errorClass}: ${err.message}). The move stands; run reconcile to repair the history before the next move`, { state: 'HISTORY_INCOMPLETE', record: cas.record, receipt, cause: errorClass });
    incomplete.receipted = true;
    throw incomplete;
  }
  const state = 'PROMOTED';
  const receipt = await finishMoved(state);
  return { state, record: cas.record, receipt };
}

export const promote = (opts) => moveAlias('promote', opts);
// Rollback is a promotion to an earlier generation's content ID: the generation
// increases and nothing is deleted.
export const rollback = ({ to, ...opts }) => moveAlias('rollback', { ...opts, contentId: to });

// ---- reconcile -------------------------------------------------------------------------
// Repairs what a committed move can leave behind: an alias history missing the entry
// for the current generation (appended from the current record, idempotently). It never
// moves an alias and never lowers a generation.
export async function reconcile({ adapter, target, grants = new Set(), clock = defaultClock, retry = {} }) {
  assertTargetAvailable(target);
  assertGrant('reconcile', target, grants);
  const ctx = context(adapter, target, 'reconcile', clock);
  const startRequests = adapter.requestCount();
  const results = [];
  const receiptFor = (state, extra = {}) => buildReceipt({ ...ctx, contentId: null, finishedAt: clock(), state, transitions: [state], readBack: { verified: true, mismatches: [] }, requestCount: adapter.requestCount() - startRequests, estimatedCostUsd: estimateCost(target.kind, { writes: results.filter((r) => r.historyRepaired).length, aliasWrites: results.filter((r) => r.wrote).length, reads: adapter.requestCount() - startRequests }), ...extra });
  try {
    for (const name of await withRetry(() => adapter.listAliases(), retry)) {
      const result = { alias: name };
      results.push(result);
      const hs = await historyState(adapter, name, retry);
      if (!hs.complete) {
        if (!hs.repairable) throw new PublicationError(CODES.HISTORY_INCOMPLETE, `alias ${name} is at generation ${hs.generation} and its history ends at ${hs.historyGeneration}; only the current generation's entry can be rebuilt`);
        await withRetry(() => adapter.appendHistory(name, hs.record), retry);
        result.historyRepaired = hs.generation;
      }
    }
  } catch (err) {
    // Every exit after the first request leaves a result receipt.
    const receipt = receiptFor(stateOf(err.code), { errorClass: err instanceof PublicationError ? err.code : CODES.PROTOCOL });
    if (await writeReceiptOrFail(adapter, receipt).then(() => true, () => false)) await recordCost(target, receipt);
    throw err;
  }
  const receipt = receiptFor('RECONCILED');
  await writeReceiptOrFail(adapter, receipt);
  await recordCost(target, receipt);
  return { state: 'RECONCILED', results, receipt };
}
