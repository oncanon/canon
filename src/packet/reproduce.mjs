// render-policy-2.md R11: verify = independent rules + reproduction.
//
// verify.mjs checks a packet against rules it derives on its own and imports nothing from
// the builder or renderer. It cannot tell whether the page's words are report.json's words.
// For a render-policy/2 packet this module closes that gap: it validates report.json as
// report/v1, rebuilds the packet from it (evidence bytes from the packet's own evidence
// files, renderer inputs from the shipped defaults, tool values from manifest.build) and
// requires every file and the manifest identity to be byte-identical. A packet verifies
// only when both pass. So, once released, render-policy/2's output for a given source is
// frozen: a rendering change needs render-policy/3.
//
// This module may import the builder and renderer; verify.mjs must not.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { RENDER_POLICY_2 } from '../policy.mjs';
import { parseReportText, validateReport } from '../report/validate.mjs';
import { verifySiteBundle } from '../site/verify.mjs';
import { assemblePacket, reproductionRenderInputs } from './build.mjs';
import { reissueRelationFindings, verifyPacket } from './verify.mjs';

const finding = (path, message) => ({ code: 'reproduction', path, message });

async function readJson(dir, name) {
  return JSON.parse(await readFile(join(dir, name), 'utf8'));
}

// Rebuild a render-policy/2 packet and compare. Returns { ok, errors, output } where
// output is the rebuilt path -> bytes map (null when the rebuild could not run). Reports
// the first differing file only: one difference already means the packet is not what its
// source renders to.
export async function reproducePacket(packetDir) {
  const fail = (path, message) => ({ ok: false, errors: [finding(path, message)], output: null });
  let manifest;
  try {
    manifest = await readJson(packetDir, 'manifest.json');
  } catch (err) {
    return fail('manifest.json', `manifest.json is unreadable: ${err.message}`);
  }
  const build = manifest.build ?? {};
  if (build.renderPolicy !== RENDER_POLICY_2) return fail('manifest.json#/build/renderPolicy', `reproduction applies to ${RENDER_POLICY_2} packets only`);

  let report;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(packetDir, 'report.json')));
    report = validateReport(parseReportText(text, { label: 'report.json' }));
  } catch (err) {
    return fail('report.json', `report.json is not a valid report/v1 source: ${err.message}`);
  }

  const relations = new Map((Array.isArray(manifest.evidence) ? manifest.evidence : []).map((r) => [r?.id, r]));
  const evidenceBytes = new Map();
  for (const item of report.evidence) {
    if (item.kind !== 'file') continue;
    const path = relations.get(item.id)?.path;
    if (typeof path !== 'string' || !/^evidence\/[0-9a-f]{64}\.(?:txt|csv|json)$/.test(path)) {
      return fail('manifest.json#/evidence', `no packet evidence file for report.json evidence ${JSON.stringify(item.id)}`);
    }
    try {
      evidenceBytes.set(item.id, await readFile(join(packetDir, path)));
    } catch (err) {
      return fail(path, `evidence file for ${JSON.stringify(item.id)} is unreadable: ${err.message}`);
    }
  }

  let rebuilt;
  try {
    const inputs = reproductionRenderInputs();
    rebuilt = assemblePacket(report, {
      evidenceBytes,
      stylesheetBytes: inputs.stylesheetBytes,
      fontAssets: inputs.fontAssets,
      lockups: inputs.lockups,
      renderPolicy: RENDER_POLICY_2,
      reissueOf: manifest.report?.reissueOf ?? null,
      tool: { name: build.tool, version: build.version, securityPolicy: build.securityPolicy },
    });
  } catch (err) {
    return fail('report.json', `report.json does not rebuild: ${err.message}`);
  }

  // Files in the packet's own inventory order, then any the rebuild adds, then the
  // manifest identity (everything but contentId) and checksums.json.
  const stored = (Array.isArray(manifest.files) ? manifest.files : []).map((f) => f?.path).filter((p) => typeof p === 'string');
  const paths = [...new Set([...stored, ...[...rebuilt.output.keys()].filter((p) => p !== 'manifest.json' && p !== 'checksums.json')])];
  for (const path of paths) {
    const want = rebuilt.output.get(path);
    if (!want) return { ok: false, errors: [finding(path, `${path} is not produced by rebuilding report.json`)], output: rebuilt.output };
    const have = await readFile(join(packetDir, path)).catch(() => null);
    if (!have || !have.equals(want)) {
      return { ok: false, errors: [finding(path, `${path} differs from the rebuild of report.json (first differing file)`)], output: rebuilt.output };
    }
  }
  const { contentId: _stored, ...storedIdentity } = manifest;
  const { contentId: _rebuilt, ...rebuiltIdentity } = rebuilt.manifest;
  if (!canonicalBytes(storedIdentity).equals(canonicalBytes(rebuiltIdentity))) {
    return { ok: false, errors: [finding('manifest.json', 'the manifest identity differs from the rebuild of report.json')], output: rebuilt.output };
  }
  const checksums = await readFile(join(packetDir, 'checksums.json')).catch(() => null);
  if (!checksums || !checksums.equals(rebuilt.output.get('checksums.json'))) {
    return { ok: false, errors: [finding('checksums.json', 'checksums.json differs from the rebuild of report.json')], output: rebuilt.output };
  }
  return { ok: true, errors: [], output: rebuilt.output };
}

// The full verify every caller uses: the independent rules, then, for a render-policy/2
// packet that passes them, reproduction. Same result shape as verifyPacket.
export async function verifyPacketFull(packetDir) {
  const result = await verifyPacket(packetDir);
  if (!result.ok) return result;
  const policy = await readJson(packetDir, 'manifest.json').then((m) => m?.build?.renderPolicy, () => null);
  if (policy !== RENDER_POLICY_2) return result;
  const repro = await reproducePacket(packetDir);
  return repro.ok ? result : { ...result, ok: false, errors: [...result.errors, ...repro.errors] };
}

// site/verify.mjs's verifyArtifact, with packets given the full verify. Site bundles are
// unchanged (verifySiteBundle).
export async function verifyArtifactFull(dir) {
  const schema = await readJson(dir, 'manifest.json').then((m) => m?.schema, () => null);
  if (schema === 'site-bundle/v1') return verifySiteBundle(dir);
  return verifyPacketFull(dir);
}

// R8: `canon verify <new> --reissue-of <old>`. Both packets pass their full verify
// (including reproduction for a policy/2 packet); the new packet's rebuilt report.md must
// equal the old packet's report.md byte for byte; reissueOf, source digests and evidence
// inventories must hold (reissueRelationFindings, shared with the build).
export async function verifyReissue(newDir, oldDir) {
  const errors = [];
  const next = await verifyPacketFull(newDir);
  const prev = await verifyPacketFull(oldDir);
  for (const e of next.errors) errors.push({ ...e, path: `new:${e.path}` });
  for (const e of prev.errors) errors.push({ ...e, path: `old:${e.path}` });
  const nm = await readJson(newDir, 'manifest.json').catch(() => null);
  const om = await readJson(oldDir, 'manifest.json').catch(() => null);
  if (!nm || !om) {
    errors.push({ code: 'reissue', path: 'manifest.json', message: 'both packets need a readable manifest.json' });
    return { ok: false, errors, contentId: nm?.contentId ?? null, reissueOf: om?.contentId ?? null };
  }
  let nmd = await readFile(join(newDir, 'report.md')).catch(() => null);
  if (nm.build?.renderPolicy === RENDER_POLICY_2) {
    const repro = await reproducePacket(newDir);
    nmd = repro.output?.get('report.md') ?? null;
  }
  const omd = await readFile(join(oldDir, 'report.md')).catch(() => null);
  errors.push(...reissueRelationFindings({ manifest: nm, reportMd: nmd }, { manifest: om, reportMd: omd }));
  return { ok: errors.length === 0, contentId: nm.contentId, reissueOf: om.contentId, errors };
}
