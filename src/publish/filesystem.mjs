// Filesystem storage publisher: <root>/packets/<content-id>/.
//
// Publication never modifies a visible packet. Bytes are staged in a private
// directory, verified there, and renamed into place in one step; a directory
// rename onto an existing non-empty target fails, so two publishers racing on
// the same ID cannot interleave files. An existing packet is compared byte for
// byte: identical is idempotent, anything else is a conflict and fails closed.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONTENT_ID_PATTERN, sha256Hex } from '../hash.mjs';
// Full verify: site bundles via site/verify.mjs; packets with the independent rules plus,
// for render-policy/2, reproduction (R11).
import { verifyArtifactFull as verifyArtifact } from '../packet/reproduce.mjs';
import { ADMISSION_REFUSED, admissionDecision, admittedRenderPolicy } from './admission.mjs';

export class PublishError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PublishError';
    this.code = code;
    this.details = details;
  }
}

export function packetPath(root, contentId) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new PublishError('invalid-content-id', `malformed content ID ${JSON.stringify(contentId)}`);
  return join(resolve(root), 'packets', contentId);
}

async function inventoryDigests(dir, manifestBytes) {
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const files = [...manifest.files.map((f) => f.path), 'manifest.json', 'checksums.json'];
  const digests = {};
  let bytes = 0;
  for (const path of files) {
    const data = await readFile(join(dir, path));
    digests[path] = sha256Hex(data);
    bytes += data.length;
  }
  return { digests, bytes, fileCount: files.length };
}

function sameDigests(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// Verify an existing published packet and compare it with the source packet.
async function compareExisting(target, source, contentId) {
  const check = await verifyArtifact(target);
  if (!check.ok || check.contentId !== contentId) {
    throw new PublishError('conflict', `existing ${contentId} does not verify; refusing to overwrite or repair`, { errors: check.errors });
  }
  const existing = await inventoryDigests(target, await readFile(join(target, 'manifest.json')));
  if (!sameDigests(existing.digests, source.digests)) {
    throw new PublishError('conflict', `existing ${contentId} holds different bytes; immutable packets are never replaced`);
  }
  return existing;
}

export async function publishPacket({ packetDir, root, expectedBuild, allowRenderPolicy1 = false }) {
  const source = resolve(packetDir);
  const sourceCheck = await verifyArtifact(source);
  if (!sourceCheck.ok) throw new PublishError('source-invalid', 'source packet does not verify', { errors: sourceCheck.errors });
  const { contentId } = sourceCheck;
  if (expectedBuild && (expectedBuild.contentId !== contentId || expectedBuild.manifestSha256 !== sourceCheck.manifestSha256)) {
    throw new PublishError('receipt-mismatch', 'source packet does not match the build receipt');
  }
  // Store admission (render-policy-2.md R12): dormant while the default is render-policy/1.
  const admission = admissionDecision(await admittedRenderPolicy(source), { allowRenderPolicy1 });
  if (!admission.admit) throw new PublishError(ADMISSION_REFUSED, admission.message);
  const manifestBytes = await readFile(join(source, 'manifest.json'));
  const sourceInv = await inventoryDigests(source, manifestBytes);
  const target = packetPath(root, contentId);
  await mkdir(dirname(target), { recursive: true });

  let outcome;
  if (await lstat(target).catch(() => null)) {
    await compareExisting(target, sourceInv, contentId);
    outcome = 'already-present';
  } else {
    const staging = join(resolve(root), '.staging', `${contentId}.${process.pid}.${randomBytes(6).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    try {
      for (const path of Object.keys(sourceInv.digests)) {
        const data = await readFile(join(source, path));
        await mkdir(dirname(join(staging, path)), { recursive: true });
        await writeFile(join(staging, path), data, { flag: 'wx', mode: 0o444 });
      }
      const stagedCheck = await verifyArtifact(staging);
      if (!stagedCheck.ok || stagedCheck.contentId !== contentId) {
        throw new PublishError('staging-mismatch', 'staged copy does not verify', { errors: stagedCheck.errors });
      }
      try {
        await rename(staging, target);
        outcome = 'created';
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(err.code)) throw err;
        // Lost a race with another publisher of the same ID: fall through to comparison.
        await compareExisting(target, sourceInv, contentId);
        outcome = 'already-present';
      }
    } finally {
      // Remove only this call's own private staging directory (never a packet).
      await rm(staging, { recursive: true, force: true });
    }
  }

  const readBack = await verifyArtifact(target);
  const readBackInv = await inventoryDigests(target, await readFile(join(target, 'manifest.json')));
  const matchesSource = readBack.ok && readBack.contentId === contentId && sameDigests(readBackInv.digests, sourceInv.digests);
  const matchesBuildReceipt = expectedBuild
    ? readBack.contentId === expectedBuild.contentId && readBack.manifestSha256 === expectedBuild.manifestSha256
      && readBackInv.bytes === expectedBuild.totalBytes && readBackInv.fileCount === expectedBuild.fileCount
    : null;
  if (!matchesSource || matchesBuildReceipt === false) {
    throw new PublishError('read-back-mismatch', 'published bytes do not match the source packet or build receipt', { errors: readBack.errors });
  }
  return {
    contentId,
    outcome,
    target,
    fileCount: readBackInv.fileCount,
    totalBytes: readBackInv.bytes,
    readBack: { verified: readBack.ok, manifestSha256: readBack.manifestSha256, matchesSource, matchesBuildReceipt },
    ...(admission.override ? { admissionOverride: admission.override } : {}),
  };
}
