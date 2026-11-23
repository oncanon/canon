import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { CASES } from '../corpus/cases.mjs';
import { exists, FIXTURE, REPO, tempDir } from '../helpers.mjs';

// Local escaping oracle (independent of src/render/escape.mjs).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const results = [];
test.after(async () => {
  if (!process.env.CANON_EVIDENCE_DIR) return;
  await mkdir(process.env.CANON_EVIDENCE_DIR, { recursive: true });
  await writeFile(join(process.env.CANON_EVIDENCE_DIR, 'p8-corpus-results.json'), `${JSON.stringify(results, null, 2)}\n`);
});

function errorCodes(err) {
  if (err.errors) return err.errors.map((e) => e.code);
  if (err.code) return [err.code];
  return [String(err.message)];
}

for (const c of CASES) {
  test(`[P8] ${c.category}: ${c.name}`, async (t) => {
    const dir = await tempDir(t, 'canon-p8');
    const src = join(dir, 'src');
    await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
    const reportPath = join(src, 'phase1-review.report.json');
    const baseText = await readFile(FIXTURE, 'utf8');
    if (c.rawText) {
      await writeFile(reportPath, c.rawText(baseText));
    } else {
      const report = JSON.parse(baseText);
      await c.mutate(report, src);
      await writeFile(reportPath, JSON.stringify(report));
    }
    const started = process.hrtime.bigint();
    let built;
    let failure;
    try {
      built = await buildPacket({ reportPath, outDir: join(dir, 'out') });
    } catch (err) {
      failure = err;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const record = { category: c.category, name: c.name, expected: c.expect.reject ? `reject:${c.expect.reject}` : 'safe-render', ms: Math.round(ms) };
    try {
      if (c.expect.reject) {
        assert.ok(failure, 'expected the build to be rejected');
        const codes = errorCodes(failure);
        record.observed = `reject:${[...new Set(codes)].join(',')}`;
        assert.ok(codes.includes(c.expect.reject), `expected ${c.expect.reject}, got ${codes}`);
        assert.equal(await exists(join(dir, 'out')), false, 'no packet output on rejection');
        if (c.expect.notPolluted) assert.equal(({}).polluted, undefined);
      } else {
        assert.ifError(failure);
        const v = await verifyPacket(built.outDir);
        assert.equal(v.ok, true, JSON.stringify(v.errors));
        const html = await readFile(join(built.outDir, 'index.html'), 'utf8');
        for (const s of c.expect.render) assert.ok(html.includes(esc(s)), `escaped form of ${s} missing`);
        assert.ok(!/<script\b/i.test(html) && !/<iframe\b/i.test(html) && !/<img\b/i.test(html) && !/<style\b/i.test(html));
        if (c.expect.maxMs) assert.ok(ms < c.expect.maxMs, `took ${ms}ms`);
        if (c.expect.markerAbsent) assert.equal(await exists(join(src, c.expect.markerAbsent)), false, 'payload executed');
        if (c.expect.evidenceExtension) {
          const exts = built.manifest.files.filter((f) => f.role === 'evidence').map((f) => f.path.split('.').pop());
          assert.ok(!exts.includes('svg') && exts.includes(c.expect.evidenceExtension));
        }
        record.observed = `safe-render:verified:${built.contentId}`;
      }
      record.result = 'PASS';
    } catch (err) {
      record.result = 'FAIL';
      record.observed ??= failure ? `unexpected-failure:${errorCodes(failure)}` : 'unexpected-success';
      throw err;
    } finally {
      results.push(record);
    }
  });
}
