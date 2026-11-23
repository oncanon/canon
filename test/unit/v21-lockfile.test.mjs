// V2.1 slice 06: the provider lockfile from the live fire is committed and pinned. It is the
// file `tofu init` wrote on 2026-09-28 (its SHA-256 equals the live fire's own record), it
// pins exactly one provider at one version with the constraint versions.tf declares, and any
// change to it, a drifted hash included, fails until the pin is updated in review.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { scanHcl } from '../../scripts/hcl-scan.mjs';
import { REPO } from '../helpers.mjs';

const PIN = JSON.parse(readFileSync(join(REPO, 'infra/cloudflare/provider-lock.json'), 'utf8'));
const LOCK = readFileSync(join(REPO, PIN.file), 'utf8');

test('[V2.1-06] the committed lockfile is byte-for-byte the pinned one (no hash drift)', () => {
  assert.equal(createHash('sha256').update(LOCK).digest('hex'), PIN.sha256);
});

test('[V2.1-06] the lockfile pins exactly one provider, at the pinned version, with versions.tf\'s constraint', () => {
  const lock = scanHcl(LOCK);
  assert.deepEqual(lock.blocks.map((b) => [b.type, b.labels]), [['provider', [PIN.provider]]]);
  const attr = (n) => lock.attributes.find((a) => a.path === `provider.${PIN.provider}` && a.name === n);
  assert.deepEqual(lock.attributes.filter((a) => a.path === `provider.${PIN.provider}`).map((a) => a.name).sort(), ['constraints', 'hashes', 'version']);
  assert.equal(attr('version').value.literal, PIN.version);
  assert.equal(attr('constraints').value.literal, PIN.constraints);
  const hashes = attr('hashes').value.items.map((i) => i.literal);
  assert.equal(hashes.length, PIN.hashCount);
  assert.equal(new Set(hashes).size, hashes.length, 'no duplicate hashes');
  for (const h of hashes) assert.match(h, /^(h1:[A-Za-z0-9+/]{43}=|zh:[0-9a-f]{64})$/, h);
  const versions = scanHcl(readFileSync(join(REPO, 'infra/cloudflare/terraform/versions.tf'), 'utf8'));
  const cf = versions.attributes.find((a) => a.name === 'cloudflare' && a.path === 'terraform/required_providers');
  const src = cf.value.items.find((i) => i.key === 'source').value.literal;
  const ver = cf.value.items.find((i) => i.key === 'version').value.literal;
  assert.equal(ver, PIN.constraints, 'versions.tf declares the lockfile\'s constraint');
  assert.equal(PIN.provider, `registry.opentofu.org/${src}`, 'the locked provider is the declared source');
});
