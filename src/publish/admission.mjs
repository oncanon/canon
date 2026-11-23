// Store admission gate (docs/decisions/render-policy-2.md R12; Captain's ruling on review 2
// MAJOR B: "New ones must be policy/2").
//
// Admission is the one moment a packet enters a store: the filesystem publish
// (publishPacket, so `canon publish` and `canon brief`), the publication protocol's publish
// and the fs adapter's commit. Once DEFAULT_RENDER_POLICY is render-policy/2, each of them
// refuses a render-policy/1 packet unless the operator passes --allow-render-policy-1, and
// the override is recorded in the receipt. While the default is render-policy/1 the gate is
// dormant: it admits everything and records nothing, so behaviour is unchanged.
//
// Nothing else is gated: alias set, promote and rollback point at packets already in the
// store (so already admitted), and serving, verifying and archiving never admit anything.
// site-bundle/v1 is not a report/v1 packet and has its own store path.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RENDER_POLICY, PACKET_SCHEMA, RENDER_POLICY_1 } from '../policy.mjs';

// The CLI flag, spelled the same on `canon publish`, `canon brief` and `canon publish --target`.
export const ALLOW_RENDER_POLICY_1 = 'allow-render-policy-1';

export const ADMISSION_REFUSED = 'render-policy-refused';

// Decide admission for a verified packet whose manifest names `renderPolicy`.
// Returns { admit: true, override: null } (admitted, nothing to record),
// { admit: true, override } (admitted only because of the flag: record `override`), or
// { admit: false, message } (refused).
export function admissionDecision(renderPolicy, { allowRenderPolicy1 = false } = {}) {
  if (DEFAULT_RENDER_POLICY === RENDER_POLICY_1 || renderPolicy !== RENDER_POLICY_1) return { admit: true, override: null };
  if (allowRenderPolicy1 === true) {
    return { admit: true, override: { flag: ALLOW_RENDER_POLICY_1, renderPolicy, defaultRenderPolicy: DEFAULT_RENDER_POLICY } };
  }
  return {
    admit: false,
    message: `refusing to admit a ${RENDER_POLICY_1} packet: new packets must be ${DEFAULT_RENDER_POLICY}; pass --${ALLOW_RENDER_POLICY_1} to admit it anyway (the override is recorded in the receipt)`,
  };
}

// The render policy a verified artifact is admitted under: its manifest's
// build.renderPolicy for a packet/v1 packet, and null for anything else. A site-bundle/v1
// manifest also names render-policy/1 (site bundles stay on it, R1), but site bundles are
// not gated, so they answer null. Call it only on an artifact that has already passed
// verification, so the manifest parses.
export async function admittedRenderPolicy(dir) {
  return manifestRenderPolicy(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
}

export function manifestRenderPolicy(manifest) {
  return manifest?.schema === PACKET_SCHEMA ? manifest.build?.renderPolicy ?? null : null;
}
