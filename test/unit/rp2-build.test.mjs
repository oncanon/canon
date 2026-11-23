// render-policy/2 builder and renderer (docs/decisions/render-policy-2.md R1-R5, R9).
// These exercise the builder and renderer directly; the policy/2 verifier rulebook is a
// separate piece of work, so nothing here calls verifyPacket on a policy/2 packet.
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { BuildError, buildPacket } from '../../src/packet/build.mjs';
import { blockNumberLabel, assignBlockNumbers } from '../../src/render/block-numbers.mjs';
import { renderReportMarkdown } from '../../src/render/markdown.mjs';
import { ReportValidationError, validateReport } from '../../src/report/validate.mjs';
import { FIXTURE, REPO, runCli, sha256, tempDir } from '../helpers.mjs';

const SPECIMEN = join(REPO, 'fixtures/specimen-v2/canon-specimen-v2.report.json');
const P2 = 'render-policy/2';
// The policy/1 content ID of the golden fixture before render-policy/2 existed. It must
// never move: policy/1 output is frozen.
const FIXTURE_POLICY1_ID = 'sha256-3632c33a430f5fafd6a4f7f42971a3d3fbcaf3efd60858b1918aada908d51231';

const html = (packet) => packet.output.get('index.html').toString('utf8');
const report = async (path) => JSON.parse(await readFile(path, 'utf8'));

// The block count, computed here from the report with the D4 rule, not with the renderer's module.
function countBlocks(r) {
  return r.summary.paragraphs.length
    + r.sections.reduce((n, s) => n + s.blocks.length, 0)
    + (r.appendices ?? []).reduce((n, s) => n + s.blocks.length, 0);
}

async function withReport(t, source, mutate) {
  const dir = await tempDir(t, 'canon-rp2');
  const base = join(source, '..');
  await cp(base, dir, { recursive: true });
  const name = source.split('/').pop();
  const r = await report(source);
  mutate(r);
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
}

test('[R1-DEFAULT] the default build is still render-policy/1 and the golden fixture keeps its content ID', async () => {
  const dflt = await buildPacket({ reportPath: FIXTURE });
  const explicit = await buildPacket({ reportPath: FIXTURE, renderPolicy: 'render-policy/1' });
  assert.equal(dflt.contentId, FIXTURE_POLICY1_ID);
  assert.equal(explicit.contentId, FIXTURE_POLICY1_ID);
  assert.equal(dflt.manifest.build.renderPolicy, 'render-policy/1');
  assert.ok(!dflt.output.has('report.json'), 'policy/1 packets carry no report.json');
  assert.ok(!dflt.manifest.files.some((f) => f.path.endsWith('.woff2') && f.bytes === 21168), 'policy/1 embeds no JetBrains Mono');
});


test('[R1-SELECT] render-policy/2 is selected by option and by CLI flag; anything else is refused', async (t) => {
  const p2 = await buildPacket({ reportPath: FIXTURE, renderPolicy: P2 });
  assert.equal(p2.manifest.build.renderPolicy, P2);
  assert.notEqual(p2.contentId, FIXTURE_POLICY1_ID);
  await assert.rejects(buildPacket({ reportPath: FIXTURE, renderPolicy: 'render-policy/3' }), (err) => err instanceof BuildError && err.code === 'render-policy');
  const dir = await tempDir(t, 'canon-rp2-cli');
  const ok = runCli(['build', FIXTURE, '--out', join(dir, 'p2'), '--receipt', join(dir, 'p2.json'), '--render-policy', '2']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(await readFile(join(dir, 'p2', 'manifest.json'), 'utf8')).build.renderPolicy, P2);
  const bad = runCli(['build', FIXTURE, '--out', join(dir, 'p3'), '--render-policy', '3']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--render-policy must be 1 or 2/);
});

test('[R2-REPORT-JSON] a policy/2 packet carries report.json: canonical source bytes whose digest is the source digest', async () => {
  const p2 = await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 });
  const bytes = p2.output.get('report.json');
  assert.ok(bytes, 'report.json present');
  const entry = p2.manifest.files.find((f) => f.path === 'report.json');
  assert.equal(entry.role, 'source');
  assert.equal(entry.mediaType, 'application/json');
  assert.equal(sha256(bytes), p2.manifest.report.sourceSha256);
  assert.equal(entry.sha256, p2.manifest.report.sourceSha256);
  assert.ok(Buffer.from(canonicalBytes(JSON.parse(bytes.toString('utf8')))).equals(bytes), 'bytes are their own canonical re-serialisation');
});

test('[R2-FONTS] policy/2 embeds exactly six faces (Libron x4, JetBrains Mono 400/700), each referenced by digest from the stylesheet', async () => {
  const p2 = await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 });
  const fonts = p2.manifest.files.filter((f) => f.path.endsWith('.woff2'));
  assert.equal(fonts.length, 6);
  const cssEntry = p2.manifest.files.filter((f) => f.path.endsWith('.css'));
  assert.equal(cssEntry.length, 1);
  const css = p2.output.get(cssEntry[0].path).toString('utf8');
  for (const f of fonts) {
    assert.equal(f.path, `assets/${f.sha256}.woff2`);
    assert.ok(css.includes(`url("./${f.sha256}.woff2")`), `stylesheet references ${f.path}`);
  }
  const mono = [...css.matchAll(/@font-face\{font-family:"JetBrains Mono";src:url\("\.\/([0-9a-f]{64})\.woff2"\) format\("woff2"\);font-style:normal;font-weight:(\d+);/g)].map((m) => m[2]);
  assert.deepEqual(mono, ['400', '700']);
  assert.ok(css.includes('Canon 2.1 edition stylesheet'), 'the policy/2 stylesheet is edition-2.1.css');
});

test('[R2-MD] for the same source, policy/2 report.md and evidence bytes are identical to policy/1; only index.html and assets differ and report.json is added', async () => {
  for (const source of [FIXTURE, SPECIMEN]) {
    const p1 = await buildPacket({ reportPath: source });
    const p2 = await buildPacket({ reportPath: source, renderPolicy: P2 });
    assert.ok(p1.output.get('report.md').equals(p2.output.get('report.md')), `${source}: report.md identical`);
    assert.equal(p1.manifest.report.sourceSha256, p2.manifest.report.sourceSha256);
    const ev1 = p1.manifest.files.filter((f) => f.role === 'evidence');
    const ev2 = p2.manifest.files.filter((f) => f.role === 'evidence');
    assert.deepEqual(ev2, ev1, `${source}: evidence inventory identical`);
    const only1 = p1.manifest.files.filter((a) => !p2.manifest.files.some((b) => b.path === a.path && b.sha256 === a.sha256)).map((f) => f.path);
    const only2 = p2.manifest.files.filter((a) => !p1.manifest.files.some((b) => b.path === a.path && b.sha256 === a.sha256)).map((f) => f.path);
    for (const p of [...only1, ...only2]) assert.ok(p === 'index.html' || p === 'report.json' || p.startsWith('assets/'), `${source}: unexpected difference ${p}`);
    assert.ok(only2.includes('report.json'));
  }
});

test('[R3-BNN] block numbers: one sequence, two-digit minimum, b-100 after b-99', () => {
  assert.equal(blockNumberLabel(1), 'b-01');
  assert.equal(blockNumberLabel(99), 'b-99');
  assert.equal(blockNumberLabel(100), 'b-100');
  assert.throws(() => blockNumberLabel(0));
  const r = { summary: { paragraphs: ['a', 'b'] }, sections: [{ blocks: [{}, {}, {}] }, { blocks: [{}] }], appendices: [{ blocks: [{}] }] };
  assert.deepEqual(assignBlockNumbers(r), { summary: ['b-01', 'b-02'], sections: [['b-03', 'b-04', 'b-05'], ['b-06']], appendices: [['b-07']], total: 7 });
});

test('[R3-BNN] index.html carries exactly one anchor per counted block, b-01..b-N in document order, and no other b-nn id', async () => {
  for (const source of [FIXTURE, SPECIMEN]) {
    const r = await report(source);
    const page = html(await buildPacket({ reportPath: source, renderPolicy: P2 }));
    const n = countBlocks(r);
    const anchors = [...page.matchAll(/<a class="b-anchor" id="(b-\d+)" href="#\1" aria-label="Block \1">\1<\/a>/g)].map((m) => m[1]);
    const expected = Array.from({ length: n }, (_, i) => `b-${String(i + 1).padStart(2, '0')}`);
    assert.deepEqual(anchors, expected, source);
    const ids = [...page.matchAll(/\sid="(b-[0-9]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, expected, `${source}: no other element has a b-nn id`);
  }
});

test('[R4-RECOMMENDED] decision.alternatives[].recommended: true accepted, false and a second one rejected, report.md unchanged', async () => {
  const base = await report(SPECIMEN);
  const decision = base.sections.flatMap((s) => s.blocks).find((b) => b.type === 'decision');
  assert.ok(decision);
  const withField = structuredClone(base);
  const dec = withField.sections.flatMap((s) => s.blocks).find((b) => b.type === 'decision');
  dec.alternatives[0].recommended = true;
  validateReport(structuredClone(withField));

  const asFalse = structuredClone(base);
  asFalse.sections.flatMap((s) => s.blocks).find((b) => b.type === 'decision').alternatives[0].recommended = false;
  assert.throws(() => validateReport(asFalse), (e) => e instanceof ReportValidationError && e.errors.some((x) => x.path.endsWith('/alternatives/0/recommended')));

  const two = structuredClone(withField);
  two.sections.flatMap((s) => s.blocks).find((b) => b.type === 'decision').alternatives[1].recommended = true;
  assert.throws(() => validateReport(two), (e) => e instanceof ReportValidationError && e.errors.some((x) => /at most one alternative may be recommended/.test(x.message)));

  // report.md ignores the field: the same source digest yields the same bytes.
  const evidenceIndex = new Map(base.evidence.map((e, i) => [e.id, { label: `E${i + 1}`, title: e.title, kind: e.kind, href: `evidence/${e.id}.txt`, sha256: '0'.repeat(64), bytes: 1, mediaType: e.mediaType }]));
  const digest = 'f'.repeat(64);
  assert.equal(renderReportMarkdown(validateReport(structuredClone(withField)), { evidenceIndex, sourceSha256: digest }), renderReportMarkdown(validateReport(structuredClone(base)), { evidenceIndex, sourceSha256: digest }));
});

test('[R4-RECOMMENDED] policy/2 shows the arrow only on the recommended alternative; policy/1 ignores the field', async (t) => {
  const path = await withReport(t, SPECIMEN, (r) => {
    r.sections.flatMap((s) => s.blocks).find((b) => b.type === 'decision').alternatives[1].recommended = true;
  });
  const page = html(await buildPacket({ reportPath: path, renderPolicy: P2 }));
  assert.equal((page.match(/class="option__arrow"/g) ?? []).length, 1);
  assert.match(page, /<li class="option option--recommended[^"]*"><span class="option__key" aria-hidden="true">B<\/span>/);
  const plain = html(await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 }));
  assert.equal((plain.match(/class="option__arrow"/g) ?? []).length, 0, 'absent field: no arrow');
  // policy/1 ignores the field: apart from the source digest (the source did change),
  // the page is byte-identical.
  const p1With = await buildPacket({ reportPath: path });
  const p1Without = await buildPacket({ reportPath: SPECIMEN });
  const norm = (p) => html(p).replaceAll(p.manifest.report.sourceSha256, 'DIGEST').replaceAll(p.manifest.report.sourceSha256.slice(0, 12), 'DIGEST12');
  assert.equal(norm(p1With), norm(p1Without), 'policy/1 index.html ignores the field');
});

test('[R5-STRUCTURE] body order, masthead formats, rail mirroring main sections, colophon contents', async () => {
  const p2 = await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 });
  const page = html(p2);
  const order = ['<a class="skip-link" href="#content">', '<header class="masthead">', '<div class="layout">', '<main id="content" class="document">', '<aside class="rail" aria-label="On this page">', '<footer class="colophon">', '</body>'];
  const at = order.map((s) => page.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'rail after main, colophon after layout');
  assert.equal(page.indexOf('<a class="skip-link"'), page.indexOf('<body>') + '<body>\n'.length);

  const nav = page.match(/<nav class="formats" aria-label="Edition formats">([\s\S]*?)<\/nav>/)[1];
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ['index.html', 'report.md', 'manifest.json']);
  assert.match(nav, /<a href="index.html" aria-current="page">index.html<\/a>/);
  const r0 = await report(SPECIMEN);
  assert.ok(page.includes(`<span class="masthead__slug">${r0.id}</span>`));

  const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
  const sections = [...main.matchAll(/<section class="[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  const toc = page.match(/<nav class="rail__toc"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...toc.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]), sections);
  assert.deepEqual(sections.slice(0, 1), ['summary']);
  assert.ok(!/id="provenance"[^>]*>\s*<h2/.test(page) && !/<section[^>]+id="provenance"/.test(page), 'no section#provenance');
  const r = await report(SPECIMEN);
  const railEv = page.match(/<div class="rail__evidence">[\s\S]*?<\/div>/)[0];
  assert.equal((railEv.match(/<li>/g) ?? []).length, r.evidence.length);

  const colophon = page.slice(page.indexOf('<footer class="colophon">'));
  const digest = p2.manifest.report.sourceSha256;
  assert.ok(colophon.includes('<p class="colophon__title">Sealed by Canon</p>'));
  assert.ok(colophon.includes(`<code><b>${digest.slice(0, 8)}</b>${digest.slice(8)}</code>`));
  for (const href of ['report.md', 'manifest.json', 'checksums.json']) assert.ok(colophon.includes(`href="${href}"`), href);
  assert.ok(colophon.includes('canon verify &lt;packet-dir&gt;'));
  assert.ok(colophon.includes('canon 0.1.0 · render-policy/2 · security-policy/1 · zero scripts, zero external requests'));
  for (const s of r.provenance.sources) assert.ok(colophon.includes(s.label.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
  assert.ok(!page.includes('Epistemic &amp; severity legend'));
});

test('[R5-FINDING] every finding has exactly one confidence chip, severity pips and the meta line', async () => {
  for (const source of [FIXTURE, SPECIMEN]) {
    const r = await report(source);
    const page = html(await buildPacket({ reportPath: source, renderPolicy: P2 }));
    const findings = [...page.matchAll(/<article class="finding finding--[a-z]+"[\s\S]*?<\/article>/g)].map((m) => m[0]);
    const expected = [...r.sections, ...(r.appendices ?? [])].flatMap((s) => s.blocks).filter((b) => b.type === 'finding');
    assert.equal(findings.length, expected.length, source);
    findings.forEach((f, i) => {
      assert.equal((f.match(/<span class="conf conf--/g) ?? []).length, 1, `${source} finding ${i + 1}: one confidence chip`);
      assert.ok(f.includes(`<span class="idx">F${i + 1}</span>`));
      assert.ok(f.includes(`<p class="meta-line">${expected[i].id}`), `${source} finding ${i + 1}: meta line starts with id`);
      const pipsOn = (f.match(/pip pip--(on|critical)/g) ?? []).length;
      assert.equal(pipsOn, { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[expected[i].severity]);
      for (const id of expected[i].evidence) {
        const label = `E${r.evidence.findIndex((e) => e.id === id) + 1}`;
        assert.ok(f.includes(`>[${label}]</a>`), `${source} finding ${i + 1}: evidence ${id} still cited`);
      }
    });
  }
});

test('[R5-RISK] a run of risks is one table sorted by likelihood x impact (stable), rows keep r- ids, anchors keep report order', async () => {
  const level = { low: 1, medium: 2, high: 3 };
  for (const source of [FIXTURE, SPECIMEN]) {
    const r = await report(source);
    const page = html(await buildPacket({ reportPath: source, renderPolicy: P2 }));
    const risks = [...r.sections, ...(r.appendices ?? [])].flatMap((s) => s.blocks).filter((b) => b.type === 'risk');
    const sorted = risks.map((b, i) => ({ b, i })).sort((x, y) => (level[y.b.likelihood] * level[y.b.impact] - level[x.b.likelihood] * level[x.b.impact]) || (x.i - y.i)).map((x) => `r-${x.b.id}`);
    const tables = [...page.matchAll(/<table class="risk-table">[\s\S]*?<\/table>/g)].map((m) => m[0]);
    assert.equal(tables.length, 1, `${source}: one consecutive run, one table`);
    assert.deepEqual([...tables[0].matchAll(/<tr id="([^"]+)">/g)].map((m) => m[1]), sorted, source);
    assert.ok(!page.includes('<article class="risk'), 'risks are not cards');
    const run = page.match(/<p class="b-anchors">([\s\S]*?)<\/p>/)[1];
    const nums = [...run.matchAll(/id="b-(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(nums.length, risks.length);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  }
});

test('[R5-PLATES] plate and chart SVG bytes are identical between policy/1 and policy/2', async () => {
  for (const source of [FIXTURE, SPECIMEN]) {
    const svgs = (page) => [...page.matchAll(/<svg class="(?:svg-graphic|bar)[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    const a = svgs(html(await buildPacket({ reportPath: source })));
    const b = svgs(html(await buildPacket({ reportPath: source, renderPolicy: P2 })));
    assert.ok(a.length > 0, source);
    assert.deepEqual(b, a, source);
  }
});

test('[R5-PLATES] each diagram is a numbered plate with role=img, a caption below the frame, and its ledger', async () => {
  const r = await report(SPECIMEN);
  const page = html(await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 }));
  const diagrams = r.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'diagram');
  diagrams.forEach((d, i) => {
    const fig = page.match(new RegExp(`<figure class="plate plate--${d.kind}" id="diagram-${d.id}"[\\s\\S]*?</figure>`))[0];
    assert.match(fig, /<div class="plate__frame" role="img" aria-label="[^"]+"><div class="diagram-canvas">/);
    assert.ok(fig.indexOf('<figcaption') > fig.indexOf('</svg>'), 'caption below the frame');
    assert.ok(fig.includes(`<strong id="diagram-${d.id}-t">Plate ${i + 1}.</strong>`));
  });
});

test('[R9-SEALED] the page holds no content ID of its own, no http(s) URL outside authored ext links, no script, style attribute or img', async () => {
  for (const source of [FIXTURE, SPECIMEN]) {
    const p2 = await buildPacket({ reportPath: source, renderPolicy: P2 });
    const page = html(p2);
    assert.ok(!page.includes(p2.contentId) && !page.includes(p2.contentId.slice(7)), `${source}: own content ID absent`);
    for (const m of page.matchAll(/https?:\/\//g)) {
      const before = page.slice(page.lastIndexOf('<', m.index), m.index);
      assert.match(before, /^<a class="ext" href="$/, `${source}: URL outside an authored ext link`);
    }
    for (const m of page.matchAll(/<a class="ext"[^>]*>/g)) assert.match(m[0], /rel="noopener noreferrer external"/);
    for (const tag of page.match(/<[a-zA-Z][^>]*>/g)) {
      assert.ok(!/^<(script|img|iframe|object|embed|style)\b/i.test(tag), `${source}: ${tag}`);
      assert.ok(!/\s(style|on[a-z]+)=/i.test(tag), `${source}: ${tag}`);
    }
    assert.ok(page.includes('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;;') || page.includes("content=\"default-src 'none';"), 'CSP meta present');
  }
});

test('[R9-SEALED] the CSP meta is byte-identical to policy/1', async () => {
  const csp = (page) => page.match(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/)[0];
  assert.equal(csp(html(await buildPacket({ reportPath: SPECIMEN, renderPolicy: P2 }))), csp(html(await buildPacket({ reportPath: SPECIMEN }))));
});

test('[R5-ESCAPE] authored strings are escaped everywhere in policy/2', async (t) => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const path = await withReport(t, SPECIMEN, (r) => {
    r.title = `T ${evil}`;
    r.id = r.id; // ids are pattern-checked and cannot carry markup
    r.metadata.classification = `C ${evil}`;
    r.metadata.reviewRequest = `Q ${evil}`;
    r.metadata.authors = [`A ${evil}`];
    r.summary.paragraphs[0] = `P ${evil}`;
    const blocks = r.sections.flatMap((s) => s.blocks);
    blocks.find((b) => b.type === 'finding').title = `F ${evil}`;
    blocks.find((b) => b.type === 'risk').title = `R ${evil}`;
    blocks.find((b) => b.type === 'decision').alternatives[0].label = `D ${evil}`;
    blocks.find((b) => b.type === 'requirement').statement = `WHEN ${evil} THEN it MUST`;
    blocks.find((b) => b.type === 'diagram').title = `G ${evil}`;
    r.sections[0].title = `S ${evil}`;
    r.sections[0].lede = `L ${evil}`;
    r.evidence[0].title = `E ${evil}`;
    r.provenance.sources[0].label = `V ${evil}`;
  });
  const page = html(await buildPacket({ reportPath: path, renderPolicy: P2 }));
  assert.ok(!page.includes('<img'), 'no raw markup');
  assert.ok((page.match(/&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/g) ?? []).length >= 15);
  assert.match(page, /<b class="ears-kw">WHEN<\/b> &lt;img/);
  assert.match(page, /aria-label="Plate 1: G &lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;\./);
});

// A cite chip is an inline-block, so a browser may break on either side of it. A cite
// must stay on one line with the word before it and the punctuation right after it, and
// the cites policy/2 appends for listed-but-uncited evidence go before a final full stop.
test('[R5-CITE-GLUE] cites are glued to the preceding word and following punctuation; appended cites precede a final full stop', async (t) => {
  const path = await withReport(t, FIXTURE, (r) => {
    const f = Object.fromEntries(r.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'finding').map((b) => [b.id, b]));
    // F-1: inline cite followed by punctuation, with an RFC 2119 keyword pair before it.
    f['F-1'].claim = ['It MUST NOT drift over the hills or back ', { cite: 'ev-cache-probe' }, '. Then it holds.'];
    // F-3: the final word is an abbreviation, so the appended cites stay after it.
    f['F-3'].claim = 'Touch scrolling needs a device check, e.g.';
  });
  const p1 = await buildPacket({ reportPath: path });
  const p2 = await buildPacket({ reportPath: path, renderPolicy: P2 });
  const page = html(p2);
  const claimOf = (id, src) => {
    const m = src.match(new RegExp(`id="${id}"[\\s\\S]*?<p class="(?:finding__claim|claim)">([\\s\\S]*?)</p>`));
    assert.ok(m, `claim of ${id} found`);
    return m[1];
  };
  const CITE = '<a class="cite" href="#[^"]+" title="[^"]*">\\[[^\\]]+\\]</a>';
  const textOf = (h) => h.replace(/<[^>]+>/g, '');

  // Inline cite: the word before, the cite and the full stop after share one no-wrap run.
  const c1 = claimOf('f-F-1', page);
  assert.match(c1, new RegExp(`<span class="cite-run">back ${CITE}\\.</span> Then it holds\\.$`), 'F-1 run');
  assert.match(c1, /<span class="rfc2119">MUST NOT<\/span>/, 'keyword markup unchanged by the split');
  // The span only holds the run together if the stylesheet forbids wrapping inside it.
  const css = await readFile(join(REPO, 'src/presentation/edition-2.1.css'), 'utf8');
  assert.match(css, /\.cite-run\s*\{\s*white-space:\s*nowrap;\s*\}/, 'edition-2.1.css keeps .cite-run on one line');
  // Every authored character survives, in order: the text equals policy/1's claim text.
  assert.equal(textOf(c1), textOf(claimOf('f-F-1', html(p1)).replace(/^<span class="field-label">Claim<\/span> /, '')));

  // Appended cites (deviation 7): F-2 ends "content ID." and cites none of its evidence inline.
  const c2 = claimOf('f-F-2', page);
  assert.match(c2, new RegExp(`<span class="cite-run">ID ${CITE}${CITE}\\.</span>$`), 'F-2 cites before the final full stop');
  assert.equal(textOf(c2).replace(/ \[[^\]]+\]\[[^\]]+\]/, ''), 'Three builds from different directories, time zones, and environment orderings produced byte-identical inventories and the same content ID.');
  // "e.g." is not a lone final full stop: the cites follow it, still glued to the word.
  const c3 = claimOf('f-F-3', page);
  assert.match(c3, new RegExp(`<span class="cite-run">e\\.g\\. ${CITE}${CITE}</span>$`), 'F-3 cites after the abbreviation');
});
