import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assemblePacket } from '../../src/packet/build.mjs';
import { ReportValidationError, validateReport } from '../../src/report/validate.mjs';
import { FIXTURE, REPO } from '../helpers.mjs';

let fixtureText;
const fixture = () => JSON.parse(fixtureText);

test.before(async () => { fixtureText = await readFile(FIXTURE, 'utf8'); });

function codes(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ReportValidationError, `expected ReportValidationError, got ${err}`);
    return err.errors.map((e) => `${e.code} ${e.path}`);
  }
  assert.fail('expected validation to fail');
}

test('[P1] representative fixture is versioned report/v1 source and validates', () => {
  const report = fixture();
  assert.equal(report.schema, 'report/v1');
  assert.doesNotThrow(() => validateReport(report));
});

test('[P1] fixture exercises every required report/v1 component', () => {
  const report = fixture();
  const types = new Set();
  const walk = (blocks) => blocks.forEach((b) => { types.add(b.type); if (b.detail) walk(b.detail); });
  report.sections.forEach((s) => walk(s.blocks));
  (report.appendices ?? []).forEach((s) => walk(s.blocks));
  for (const t of ['finding', 'decision', 'risk', 'code', 'diff', 'table', 'chart', 'diagram', 'list', 'paragraph']) assert.ok(types.has(t), `missing ${t}`);
  assert.ok(report.metadata && report.summary.verdict && report.summary.paragraphs.length && report.provenance.sources.length);
  assert.ok(report.appendices.length > 0);
  const kinds = new Set(report.evidence.map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ['file', 'redacted', 'unavailable']);
  const confidences = new Set(report.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'finding').map((b) => b.confidence));
  assert.ok(confidences.size >= 3, 'status/confidence labels exercised');
  const decisions = report.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'decision');
  assert.ok(decisions.some((d) => d.status === 'needed') && decisions.some((d) => d.status === 'decided'));
});

test('[P1] source is distinct from presentation: fixture tree holds no templates or generated output', async () => {
  const files = await readdir(join(REPO, 'fixtures/report'), { recursive: true });
  const disallowed = files.filter((f) => /\.(html?|njk|liquid|hbs|css|js|mjs|svg)$/i.test(f));
  assert.deepEqual(disallowed, []);
  const renderer = await readFile(join(REPO, 'src/render/html.mjs'), 'utf8');
  assert.ok(!renderer.includes('phase1-local-packet-review'), 'renderer must not embed fixture content');
});

test('[P1] raw HTML and layout escape hatches are rejected by default', () => {
  const cases = [
    (r) => { r.html = '<b>x</b>'; },
    (r) => { r.sections[0].blocks.push({ type: 'html', html: '<script>alert(1)</script>' }); },
    (r) => { r.sections[0].blocks[0].style = 'color:red'; },
    (r) => { r.sections[0].blocks[0].className = 'wide'; },
    (r) => { r.sections[0].layout = 'two-column'; },
    (r) => { r.summary.paragraphs[0] = [{ html: '<i>x</i>' }]; },
    (r) => { r.sections[0].blocks.push({ type: 'template', template: '{{ x }}' }); },
  ];
  for (const mutate of cases) {
    const report = fixture();
    mutate(report);
    const found = codes(() => validateReport(report));
    assert.ok(found.some((c) => c.startsWith('escape-hatch')), `expected escape-hatch in ${found}`);
  }
});

test('[P1] unknown members, unknown block types and wrong schema versions are rejected', () => {
  const r1 = fixture(); r1.sections[0].blocks[0].extra = 1;
  assert.ok(codes(() => validateReport(r1)).some((c) => c.startsWith('unknown-member')));
  const r2 = fixture(); r2.sections[0].blocks.push({ type: 'carousel' });
  assert.ok(codes(() => validateReport(r2)).some((c) => c.startsWith('unknown-block')));
  const r3 = fixture(); r3.schema = 'report/v2';
  assert.ok(codes(() => validateReport(r3)).some((c) => c.startsWith('schema-version')));
});

test('[P1] markup-looking authored text is rendered as escaped text, never as markup', () => {
  const report = fixture();
  report.title = '<script>alert("t")</script>';
  report.sections[0].blocks[0].claim = '<img src=x onerror=alert(1)>';
  validateReport(report);
  const { output } = assemblePacket(report, { evidenceBytes: new Map(report.evidence.filter((e) => e.kind === 'file').map((e) => [e.id, Buffer.from('x')])), stylesheetBytes: Buffer.from('body{}') });
  const html = output.get('index.html').toString('utf8');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<script\b/i.test(html));
  assert.ok(!/<img\b/i.test(html));
});
