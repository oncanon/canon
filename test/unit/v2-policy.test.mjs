// V2 policy units (docs/v2/publication-protocol.md §6). The classification guard is
// tested directly here, where removing it is observable. It is also exercised end to end
// against the public Cloudflare target (test/unit/v21-public-target.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertClassification, assertGrant, assertSyntheticForProvider, packetPublication } from '../../src/publication/policy.mjs';

const manifest = (publication) => ({ report: publication ? { publication } : {} });
const target = (kind, accessMode) => ({ name: 't', kind, accessMode });

test('[V2-8] classification guard: confidential and private-review never reach a public access mode', () => {
  assert.throws(() => assertClassification(manifest({ classification: 'confidential' }), target('mock-cloudflare', 'public')), { code: 'classification-refused' });
  assert.throws(() => assertClassification(manifest({ classification: 'private-review' }), target('mock-cloudflare', 'public')), { code: 'classification-refused' });
  assert.throws(() => assertClassification(manifest(null), target('mock-cloudflare', 'public')), { code: 'classification-refused' }, 'absent means private-review');
  assert.doesNotThrow(() => assertClassification(manifest({ classification: 'public' }), target('mock-cloudflare', 'public')));
  for (const [kind, mode] of [['mock-cloudflare', 'access-private'], ['cloudflare', 'access-private'], ['fs', 'local']]) assert.doesNotThrow(() => assertClassification(manifest({ classification: 'confidential' }), target(kind, mode)));
  // A mode that is not on the access-controlled list is refused, not assumed private.
  assert.throws(() => assertClassification(manifest({ classification: 'confidential' }), target('mock-cloudflare', 'signed-cookie')), { code: 'classification-refused' });
});

test('[V2-8] synthetic-only guard and defaults', () => {
  assert.deepEqual(packetPublication(manifest(null)), { classification: 'private-review', dataOrigin: 'production' });
  assert.throws(() => assertSyntheticForProvider(manifest(null), target('mock-cloudflare', 'access-private')), { code: 'synthetic-only' });
  assert.doesNotThrow(() => assertSyntheticForProvider(manifest({ dataOrigin: 'synthetic' }), target('mock-cloudflare', 'access-private')));
  assert.doesNotThrow(() => assertSyntheticForProvider(manifest(null), target('fs', 'local')), 'local V1 target');
});

test('[V2-12] grants: upload and promote are separate; the local target needs none', () => {
  const cf = target('mock-cloudflare', 'access-private');
  assert.throws(() => assertGrant('publish', cf, new Set(['promote'])), { code: 'grant-missing' });
  assert.throws(() => assertGrant('promote', cf, new Set(['upload'])), { code: 'grant-missing' });
  assert.throws(() => assertGrant('rollback', cf, new Set()), { code: 'grant-missing' });
  assert.throws(() => assertGrant('delete', cf, new Set(['upload', 'promote'])), { code: 'not-available' });
  assert.doesNotThrow(() => assertGrant('publish', target('fs', 'local'), new Set()));
});
