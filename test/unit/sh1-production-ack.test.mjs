// SH-1: an explicit operator acknowledgement, `allowProductionData: true` in the
// target file, lets real (non-synthetic) data reach a provider target; absent, the
// default refusal (synthetic-only) is unchanged (P0-4, the regression proof).
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSyntheticForProvider } from '../../src/publication/policy.mjs';
import { promote, publish } from '../../src/publication/protocol.mjs';
import { harness, syntheticPacket } from '../v2/harness.mjs';

const manifest = (publication) => ({ report: publication ? { publication } : {} });
const target = (kind, extra = {}) => ({ name: 't', kind, accessMode: 'access-private', ...extra });
const production = { classification: 'private-review', dataOrigin: 'production' };

// ---- policy unit: the guard itself -------------------------------------------------------

test('[SH-1] assertSyntheticForProvider: production data needs allowProductionData: true; synthetic never needs it', () => {
  assert.throws(() => assertSyntheticForProvider(manifest(production), target('mock-cloudflare')), { code: 'synthetic-only' }, 'absent: refused, as today');
  assert.throws(() => assertSyntheticForProvider(manifest(production), target('mock-cloudflare', { allowProductionData: false })), { code: 'synthetic-only' }, 'explicitly false: still refused');
  assert.doesNotThrow(() => assertSyntheticForProvider(manifest(production), target('mock-cloudflare', { allowProductionData: true })), 'explicit true: accepted');
  assert.doesNotThrow(() => assertSyntheticForProvider(manifest({ dataOrigin: 'synthetic' }), target('mock-cloudflare')), 'synthetic data never needs the switch');
  assert.doesNotThrow(() => assertSyntheticForProvider(manifest(production), target('fs', { allowProductionData: undefined })), 'the fs (V1) target kind is outside this guard entirely');
});

// ---- end to end: P0-1 and P0-4 -----------------------------------------------------------

test('[P0-1] a production packet with allowProductionData: true reaches READBACK_VERIFIED, and the receipt records the acknowledgement', async (t) => {
  const h = await harness('mock-cloudflare', t);
  h.target.allowProductionData = true;
  const p = await syntheticPacket(h.dir, 'a', production);
  const result = await publish({ ...h.opts(), packetDir: p.dir });
  assert.equal(result.state, 'READBACK_VERIFIED');
  assert.equal(result.receipt.productionAcknowledged, true, 'the receipt states the acknowledgement that let this publish through');
});

test('[P0-4] without allowProductionData, a production packet is refused exactly as today (synthetic-only)', async (t) => {
  const h = await harness('mock-cloudflare', t);
  const p = await syntheticPacket(h.dir, 'a', production);
  await assert.rejects(publish({ ...h.opts(), packetDir: p.dir }), { code: 'synthetic-only' });
});

test('[SH-1] a synthetic packet still needs no acknowledgement, and its receipt says so', async (t) => {
  const h = await harness('mock-cloudflare', t);
  const p = await syntheticPacket(h.dir);
  const result = await publish({ ...h.opts(), packetDir: p.dir });
  assert.equal(result.state, 'READBACK_VERIFIED');
  assert.equal(result.receipt.productionAcknowledged, false);
});

test('[SH-1] promote re-checks the manifest on the target and records the acknowledgement on its receipts too', async (t) => {
  const h = await harness('mock-cloudflare', t);
  h.target.allowProductionData = true;
  const p = await syntheticPacket(h.dir, 'a', production);
  await publish({ ...h.opts(), packetDir: p.dir });
  const moved = await promote({ ...h.opts(), alias: 'review', contentId: p.contentId, expectGeneration: 0 });
  assert.equal(moved.record.generation, 1);
  assert.equal(moved.receipt.productionAcknowledged, true);
});
