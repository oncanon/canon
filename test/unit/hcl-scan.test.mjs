// V2-QA-6: the in-repo HCL scanner the IaC gate relies on. Each case is valid HCL (the
// evidence checks that `terraform fmt` accepts the gate's planted cases); the scanner must
// see exactly the blocks and attributes Terraform would, and fail closed on what it cannot
// parse.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HclParseError, scanHcl } from '../../scripts/hcl-scan.mjs';
import { HCL_INVALID, HCL_VALID } from '../iac-cases.mjs';

const paths = (src) => scanHcl(src).blocks.map((b) => b.blockPath);
const attrs = (src) => scanHcl(src).attributes.map((a) => `${a.path}:${a.name}`);

test('[V2-QA-6] hcl-scan: comments of every kind hide exactly what they contain, nothing more', () => {
  assert.deepEqual(paths(HCL_VALID.comments), ['locals']);
  assert.deepEqual(paths(HCL_VALID.blockCommentData), ['data.http.qa']);
  assert.deepEqual(paths(HCL_VALID.blockCommentModule), ['module.qa']);
  assert.deepEqual(paths(HCL_VALID.trailingComments), ['locals']);
  assert.deepEqual(attrs(HCL_VALID.trailingComments), ['locals:a', 'locals:b', 'locals:c']);
});

test('[V2-QA-6] hcl-scan: strings with escapes and templates are one token', () => {
  const src = HCL_VALID.strings;
  assert.deepEqual(paths(src), ['locals']);
  assert.deepEqual(attrs(src), ['locals:a', 'locals:b']);
  const b = scanHcl(src).attributes.find((x) => x.name === 'b');
  assert.deepEqual(b.value.refs, ['var.x', 'local.y'], 'references inside templates are visible');
});

test('[V2-QA-6] hcl-scan: heredocs are opaque until their marker', () => {
  const src = HCL_VALID.heredocs;
  assert.deepEqual(paths(src), ['locals']);
  assert.deepEqual(attrs(src), ['locals:a', 'locals:b', 'locals:c']);
});

test('[V2-QA-6] hcl-scan: every block at every depth, one-line blocks and object keys', () => {
  const src = HCL_VALID.nesting;
  assert.deepEqual(paths(src), ['terraform', 'terraform/cloud', 'terraform/backend.http', 'resource.t.n', 'resource.t.n/provisioner.local-exec', 'resource.t.n/provisioner.local-exec/connection', 'resource.t.n/lifecycle']);
  const a = attrs(src);
  for (const want of ['terraform/cloud:organization', 'terraform/backend.http:address', 'resource.t.n/provisioner.local-exec/connection:host', 'resource.t.n:o', 'resource.t.n/o:mode', 'resource.t.n/o:inner', 'resource.t.n/o.inner:k', 'resource.t.n/l[0]:name', 'resource.t.n/l[0]:type', 'resource.t.n/l[1]:name', 'resource.t.n/l[1]:type']) assert.ok(a.includes(want), `${want} in ${a.join(', ')}`);
});

test('[V2-QA-6] hcl-scan: input it cannot parse throws, never passes', () => {
  for (const bad of HCL_INVALID) {
    assert.throws(() => scanHcl(bad), HclParseError, JSON.stringify(bad));
  }
});
