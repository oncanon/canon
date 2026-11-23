// Store admission gate (docs/decisions/render-policy-2.md R12; Captain's ruling on review 2
// MAJOR B: "New ones must be policy/2"). test/admission/gate-driver.mjs exercises every
// admission point (publishPacket, canon publish, canon brief, the publication protocol, the
// fs adapter's commit, canon publish --target) and every exempt path (alias set, promote,
// rollback, serving, site bundles). It runs twice: here, where DEFAULT_RENDER_POLICY is
// render-policy/1 and the gate must be dormant, and in a copy whose one constant is flipped
// to render-policy/2, where the gate must be live. Nothing else changes between the runs, so
// the copy also proves the build defaults and the gate are coupled through that constant.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_RENDER_POLICY, RENDER_POLICY_1 } from '../../src/policy.mjs';
import { validate } from '../../src/publication/schemas.mjs';
import { REPO, tempDir } from '../helpers.mjs';

const SITE_INPUT = join(REPO, 'fixtures/site/first-slice.site-input.json');
const CONSTANT_1 = 'export const DEFAULT_RENDER_POLICY = RENDER_POLICY_1;';
const CONSTANT_2 = 'export const DEFAULT_RENDER_POLICY = RENDER_POLICY_2;';
const OVERRIDE = { flag: 'allow-render-policy-1', renderPolicy: 'render-policy/1', defaultRenderPolicy: 'render-policy/2' };
// receipt/v1's closed field set (phase1-contract receipts; p16-receipts pins it too).
const RECEIPT_KEYS = ['alias', 'contentId', 'destination', 'durationMs', 'errorClass', 'fileCount', 'finishedAt', 'manifestSha256', 'operation', 'outcome', 'provider', 'readBack', 'result', 'schema', 'startedAt', 'tool', 'totalBytes', 'warnings'];

// The fixture report with a synthetic publication block, so a provider target accepts it.
async function syntheticReport(dir) {
  await cp(join(REPO, 'fixtures/report'), join(dir, 'report'), { recursive: true });
  const path = join(dir, 'report', 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.publication = { classification: 'private-review', dataOrigin: 'synthetic' };
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

function drive(root, dir, report) {
  const r = spawnSync(process.execPath, [join(root, 'test/admission/gate-driver.mjs'), join(dir, 'work'), report, SITE_INPUT], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, `the driver ran: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('[RV-R12] dormant at render-policy/1: every admission point admits a render-policy/1 packet without the flag and records no override', async (t) => {
  assert.equal(DEFAULT_RENDER_POLICY, RENDER_POLICY_1, 'this test describes the tree while the default is render-policy/1');
  const dir = await tempDir(t, 'canon-adm1');
  const o = drive(REPO, dir, await syntheticReport(dir));
  assert.equal(o.defaultRenderPolicy, 'render-policy/1');
  assert.deepEqual([o.builtDefaultPolicy, o.assembledDefaultPolicy, o.cliBuildDefaultPolicy, o.brief.defaultPolicy], Array(4).fill('render-policy/1'), 'every build default is render-policy/1');
  assert.equal(o.publishPacket.refusedCode, null);
  assert.equal(o.publishPacket.storedAfterRefusal, true);
  assert.equal(o.publishPacket.allowedOverride, null, 'the flag is accepted and records nothing while the gate is dormant');
  assert.deepEqual(o.publishPacket.truthyCodes, [null, null]);
  assert.equal(o.adapter.truthyCode, null);
  assert.equal(o.cliPublish.refusedStatus, 0);
  for (const k of ['refusedReceipt', 'allowedReceipt', 'defaultReceipt']) {
    assert.equal(o.cliPublish[k].result, 'success', k);
    assert.deepEqual(o.cliPublish[k].keys, RECEIPT_KEYS, `${k}: receipt/v1 keeps its closed field set`);
  }
  assert.deepEqual([o.brief.refusedStatus, o.brief.allowedStatus, o.brief.defaultStatus], [0, 0, 0]);
  assert.equal(o.brief.allowedOverride, null);
  assert.deepEqual([o.protocol.refusedCode, o.protocol.dryRunCode, o.protocol.adapterRefusedCode], [null, null, null]);
  assert.equal(o.protocol.allowedOverride, null);
  assert.equal(o.adapter.refusedCode, null);
  assert.equal(o.adapter.committedAfterRefusal, true);
  assert.deepEqual([o.cliPublishTarget.refusedStatus, o.cliPublishTarget.allowedStatus, o.cliPublishTarget.overrides], [0, 0, 0]);
  assert.equal(o.provider.refusedCode, null);
  assert.equal(o.provider.allowedOverride, null);
});

test('[RV-R12] live at render-policy/2 (a copy with the one constant flipped): new render-policy/1 admissions are refused without --allow-render-policy-1, admitted and recorded with it; aliases, promote, rollback, serving and site bundles are exempt', async (t) => {
  const dir = await tempDir(t, 'canon-adm2');
  const copy = join(dir, 'tree');
  await mkdir(join(copy, 'test'), { recursive: true });
  await cp(join(REPO, 'src'), join(copy, 'src'), { recursive: true });
  await cp(join(REPO, 'package.json'), join(copy, 'package.json'));
  await cp(join(REPO, 'test/admission'), join(copy, 'test/admission'), { recursive: true });
  await mkdir(join(copy, 'scripts'), { recursive: true });
  await cp(join(REPO, 'scripts/public-target-keygen.mjs'), join(copy, 'scripts/public-target-keygen.mjs'));
  await symlink(join(REPO, 'node_modules'), join(copy, 'node_modules'));
  const policyPath = join(copy, 'src/policy.mjs');
  const policy = await readFile(policyPath, 'utf8');
  assert.equal(policy.split(CONSTANT_1).length, 2, 'the one constant is declared exactly once, as render-policy/1');
  await writeFile(policyPath, policy.replace(CONSTANT_1, CONSTANT_2));
  const o = drive(copy, dir, await syntheticReport(dir));

  // The one constant moves every build default.
  assert.equal(o.defaultRenderPolicy, 'render-policy/2');
  assert.deepEqual([o.builtDefaultPolicy, o.assembledDefaultPolicy, o.cliBuildDefaultPolicy, o.brief.defaultPolicy], Array(4).fill('render-policy/2'), 'buildPacket, assemblePacket, canon build and canon brief all default to it');

  // publishPacket.
  assert.equal(o.publishPacket.refusedCode, 'render-policy-refused');
  assert.equal(o.publishPacket.storedAfterRefusal, false, 'a refused packet is not in the store');
  assert.deepEqual(o.publishPacket.truthyCodes, ['render-policy-refused', 'render-policy-refused'], 'only allowRenderPolicy1 === true overrides; a truthy stand-in does not (review 3)');
  assert.equal(o.publishPacket.allowedOutcome, 'created');
  assert.deepEqual(o.publishPacket.allowedOverride, OVERRIDE);
  assert.equal(o.publishPacket.defaultOutcome, 'created');
  assert.equal(o.publishPacket.defaultOverride, null, 'a render-policy/2 packet needs no flag and records nothing');

  // Exempt: alias set to the admitted policy/1 packet, away, and back; the CLI alias set; serving.
  assert.deepEqual(o.aliasSet, ['1:p1', '2:default', '3:p1']);
  assert.equal(o.cliAliasSet, 0);
  assert.deepEqual(o.served, { packet: 200, alias: 200 });
  // Not gated: site-bundle/v1.
  assert.deepEqual(o.siteBundle, { outcome: 'created', override: null });

  // canon publish.
  assert.equal(o.cliPublish.refusedStatus, 1);
  assert.equal(o.cliPublish.refusedStderr, true);
  assert.equal(o.cliPublish.refusedReceipts, 1, 'the refusal writes one failure receipt');
  assert.deepEqual({ ...o.cliPublish.refusedReceipt, keys: undefined }, { result: 'failure', errorClass: 'render-policy-refused', admissionOverride: null, keys: undefined });
  assert.deepEqual(o.cliPublish.refusedReceipt.keys, RECEIPT_KEYS);
  assert.equal(o.cliPublish.storedAfterRefusal, false);
  assert.equal(o.cliPublish.allowedStatus, 0);
  assert.deepEqual(o.cliPublish.allowedReceipt.admissionOverride, OVERRIDE, 'the override is recorded in the publish receipt');
  assert.deepEqual(o.cliPublish.allowedReceipt.keys, [...RECEIPT_KEYS, 'admissionOverride'].sort());
  assert.equal(o.cliPublish.defaultStatus, 0);
  assert.deepEqual(o.cliPublish.defaultReceipt.keys, RECEIPT_KEYS);

  // canon brief.
  assert.equal(o.brief.refusedStatus, 1);
  assert.equal(o.brief.refusedStderr, true);
  assert.equal(o.brief.refusedPublishReceipts, 0);
  assert.equal(o.brief.refusedAliased, false, 'a refused brief moves no alias');
  assert.equal(o.brief.allowedStatus, 0);
  assert.deepEqual(o.brief.allowedOverride, OVERRIDE);
  assert.equal(o.brief.defaultStatus, 0);
  assert.equal(o.brief.defaultOverride, null);

  // The publication protocol and the fs store's own gate.
  assert.equal(o.protocol.refusedCode, 'render-policy-refused');
  assert.equal(o.protocol.requestsAfterRefusal, 0, 'refused before any store request');
  assert.equal(o.protocol.dryRunCode, 'render-policy-refused', 'a dry run makes the same check');
  assert.equal(o.protocol.adapterRefusedCode, 'render-policy-refused', 'a protocol told to allow cannot commit through an fs store that was not');
  assert.equal(o.protocol.committedAfterAdapterRefusal, false);
  assert.equal(o.protocol.allowedState, 'READBACK_VERIFIED');
  assert.deepEqual(o.protocol.allowedOverride, OVERRIDE, 'the override is recorded in the receipt/v2');
  assert.equal(o.protocol.defaultState, 'READBACK_VERIFIED');
  assert.equal(o.protocol.defaultOverride, null);
  assert.deepEqual(o.protocol.aliasMoves, ['PROMOTED', 'PROMOTED', 'PROMOTED'], 'promote to, promote away from, and roll back to an admitted policy/1 packet');
  assert.deepEqual(o.adapter, { refusedCode: 'render-policy-refused', committedAfterRefusal: false, stagedManifestAfterRefusal: false, truthyCode: 'render-policy-refused', allowedOutcome: 'created', committedAfterAllow: true }, 'the fs adapter refuses at the manifest put, stages nothing for it, and commits on a rerun with the flag');

  // canon publish --target and a provider target.
  assert.deepEqual(o.cliPublishTarget, { refusedStatus: 1, refusedError: 'render-policy-refused', allowedStatus: 0, allowedState: 'READBACK_VERIFIED', overrides: 1 });
  assert.deepEqual(o.provider, { refusedCode: 'render-policy-refused', requestsAfterRefusal: 0, allowedState: 'READBACK_VERIFIED', allowedOverride: OVERRIDE });
});

test('[RV-R12] receipt/v2 admits only a well-formed admissionOverride', () => {
  const receipt = {
    schema: 'receipt/v2', receiptId: 'r-1', operation: 'publish', target: 'local', targetKind: 'fs', contentId: null,
    startedAt: '2026-11-18T00:00:00.000Z', finishedAt: '2026-11-18T00:00:01.000Z', state: 'READBACK_VERIFIED', transitions: [], objects: [],
    readBack: { verified: true, mismatches: [] }, requestCount: 0, bytesUploaded: 0, estimatedCostUsd: 0, credentialClass: 'none', toolVersion: 'canon@0.0.0',
  };
  assert.deepEqual(validate('receipt/v2', receipt), []);
  assert.deepEqual(validate('receipt/v2', { ...receipt, admissionOverride: OVERRIDE }), []);
  for (const bad of [{ ...OVERRIDE, flag: 'force' }, { ...OVERRIDE, renderPolicy: 'render-policy/2' }, { flag: OVERRIDE.flag, renderPolicy: OVERRIDE.renderPolicy }, { ...OVERRIDE, note: 'x' }]) {
    assert.notDeepEqual(validate('receipt/v2', { ...receipt, admissionOverride: bad }), [], JSON.stringify(bad));
  }
});
