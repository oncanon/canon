// render-policy/2 verifier rulebook (docs/decisions/render-policy-2.md R1-R3, R5, R6, R8,
// R9). Every rule is watched failing: a valid policy/2 packet gets ONE targeted defect, the
// packet is resealed (inventory, content ID, checksums) so only that rule can object, and
// the test requires that rule's finding and nothing else. The red controls in
// scripts/red-controls.mjs disable each rule and require these tests to go red.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { contentIdFromIdentityBytes } from '../../src/hash.mjs';
import { assemblePacket, BuildError, buildPacket, loadEvidence, loadRenderInputs, loadReport } from '../../src/packet/build.mjs';
import { SECURITY_POLICIES, TOOL } from '../../src/policy.mjs';
import { archivePacket } from '../../src/archive/tar.mjs';
import { readAlias, setAlias } from '../../src/alias/alias.mjs';
import { fsAdapter } from '../../src/publication/adapters/fs.mjs';
import { CODES, PublicationError } from '../../src/publication/errors.mjs';
import { publish } from '../../src/publication/protocol.mjs';
import { packetPath } from '../../src/publish/filesystem.mjs';
import { createPacketServer } from '../../src/server/server.mjs';
import { harness } from '../v2/harness.mjs';
import { reproducePacket, verifyPacketFull, verifyReissue } from '../../src/packet/reproduce.mjs';
import { BUILD_TOOL_2, scanCssPolicy, SECURITY_POLICIES_2, verifyPacket } from '../../src/packet/verify.mjs';
import { FIXTURE, REPO, runCli, sha256, tempDir } from '../helpers.mjs';
import { buildInTree, treeWithMarks } from '../tree/shipped-tree.mjs';

const SPECIMEN = join(REPO, 'fixtures/specimen-v2/canon-specimen-v2.report.json');
const P2 = 'render-policy/2';

// One valid build of each input, shared read-only by every test in this file and removed
// after the last one.
const BASES = await mkdtemp(join(tmpdir(), 'canon-rv-bases-'));
after(() => rm(BASES, { recursive: true, force: true }));
const bases = new Map();
async function base(t, source = FIXTURE, options = {}) {
  const key = `${source}|${options.renderPolicy ?? P2}|${options.marksDir ?? ''}`;
  if (!bases.has(key)) {
    bases.set(key, (async () => {
      const out = join(BASES, String(bases.size));
      await buildPacket({ reportPath: source, outDir: out, renderPolicy: options.renderPolicy ?? P2, ...(options.marksDir ? { marksDir: options.marksDir } : {}) });
      return out;
    })());
  }
  return bases.get(key);
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

// Copy a packet, apply one defect, and reseal it so the manifest, content ID and checksums
// are consistent again. css() renames the fingerprinted stylesheet and relinks it; a
// report.json edit carries the source digest through the manifest and the page's digest
// display unless keepSourceDigest is set.
async function mutant(t, from, { html, css, reportJson, keepSourceDigest = false, files, manifest } = {}) {
  const dir = join(await tempDir(t, 'canon-rv'), 'p');
  await cp(from, dir, { recursive: true });
  const m = await readJson(join(dir, 'manifest.json'));
  let page = await readFile(join(dir, 'index.html'), 'utf8');
  if (css) {
    const entry = m.files.find((f) => f.path.endsWith('.css'));
    const text = css(await readFile(join(dir, entry.path), 'utf8'));
    assert.notEqual(text, await readFile(join(dir, entry.path), 'utf8'), 'the CSS defect must change the stylesheet');
    const next = `assets/${sha256(Buffer.from(text))}.css`;
    await rm(join(dir, entry.path));
    await writeFile(join(dir, next), text);
    page = page.replace(entry.path, next);
    entry.path = next;
  }
  if (reportJson) {
    const before = await readFile(join(dir, 'report.json'));
    const out = reportJson(JSON.parse(before.toString('utf8')));
    const bytes = typeof out === 'string' ? Buffer.from(out) : canonicalBytes(out);
    await writeFile(join(dir, 'report.json'), bytes);
    if (!keepSourceDigest) {
      const old = m.report.sourceSha256;
      const now = sha256(bytes);
      m.report.sourceSha256 = now;
      page = page.replace(`<b>${old.slice(0, 8)}</b>${old.slice(8)}`, `<b>${now.slice(0, 8)}</b>${now.slice(8)}`).replace(`>${old.slice(0, 8)}</a>`, `>${now.slice(0, 8)}</a>`);
    }
  }
  if (html) {
    const next = html(page);
    assert.notEqual(next, page, 'the HTML defect must change the page');
    page = next;
  }
  await writeFile(join(dir, 'index.html'), page);
  if (files) await files(dir, m);
  if (manifest) manifest(m);
  for (const f of m.files) {
    const bytes = await readFile(join(dir, f.path));
    f.bytes = bytes.length;
    f.sha256 = sha256(bytes);
  }
  m.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const { contentId: _old, ...identity } = m;
  const next = { ...identity, contentId: contentIdFromIdentityBytes(canonicalBytes(identity)) };
  const manifestBytes = canonicalBytes(next);
  await writeFile(join(dir, 'manifest.json'), manifestBytes);
  await writeFile(join(dir, 'checksums.json'), canonicalBytes({
    schema: 'checksums/v1', algorithm: 'sha256', contentId: next.contentId, manifestSha256: sha256(manifestBytes),
    files: Object.fromEntries(next.files.map((f) => [f.path, f.sha256])),
  }));
  return dir;
}

const fmt = (errors) => JSON.stringify(errors.map((e) => `${e.code} ${e.path}: ${e.message}`), null, 1);

// The packet fails, every finding is the targeted rule's (matched by code and message),
// and, when `must` is given, the targeted rule's own finding is among them.
async function onlyFinding(dir, code, re, must = null) {
  const r = await verifyPacket(dir);
  assert.equal(r.ok, false, `the defect must fail verification: ${fmt(r.errors)}`);
  const stray = r.errors.filter((e) => e.code !== code || !re.test(e.message));
  assert.deepEqual(stray, [], `only ${code} ${re} may object; all findings: ${fmt(r.errors)}`);
  if (must) assert.ok(r.errors.some((e) => must.test(e.message)), `expected a finding matching ${must}: ${fmt(r.errors)}`);
  return r.errors;
}

const ok = async (dir) => {
  const r = await verifyPacket(dir);
  assert.equal(r.ok, true, fmt(r.errors));
  return r;
};

// --- R1 -------------------------------------------------------------------------------

test('[RV-R1] valid policy/2 builds verify: golden fixture, v2 specimen, and lockup artwork in both brand slots', async (t) => {
  await ok(await base(t, FIXTURE));
  await ok(await base(t, SPECIMEN));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24" width="120" height="24"><g fill="currentColor" stroke-miterlimit="4"><path d="M14 2 L30 2 L30 22 Z" fill-rule="evenodd" clip-rule="evenodd"/><text x="40" y="18" font-size="16" font-family="Libron" letter-spacing="0.5">Canon</text></g></svg>';
  // Lockups are reproduced only from the shipped marks directory (R11), so the lockup
  // packet comes from a tree that ships them, and passes that tree's full verify.
  const tree = await treeWithMarks(t, { 'lockup-ui.svg': svg, 'lockup-display.svg': svg });
  const withMarks = join(await tempDir(t, 'canon-rv-marks'), 'p');
  const built = buildInTree(tree, { reportPath: SPECIMEN, outDir: withMarks });
  assert.equal(built.full?.ok, true, JSON.stringify(built));
  assert.match(await readFile(join(withMarks, 'index.html'), 'utf8'), /class="colophon__mark colophon__mark--ruled"><svg class="lockup lockup--display"/);
  await ok(withMarks);
});


test('[RV-R1] a renderPolicy other than render-policy/1 or /2 is an error', async (t) => {
  const dir = await mutant(t, await base(t, FIXTURE, { renderPolicy: 'render-policy/1' }), { manifest: (m) => { m.build.renderPolicy = 'render-policy/3'; } });
  const r = await verifyPacket(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'render-policy' && /render-policy\/3/.test(e.message)), fmt(r.errors));
});

test('[RV-R1] policy/1 rules still apply to policy/1 packets: the golden fixture verifies, a policy/2 page under a policy/1 manifest does not', async (t) => {
  await ok(await base(t, FIXTURE, { renderPolicy: 'render-policy/1' }));
  const dir = await mutant(t, await base(t, FIXTURE), { manifest: (m) => { m.build.renderPolicy = 'render-policy/1'; } });
  const r = await verifyPacket(dir);
  assert.ok(r.errors.some((e) => /report\.json" is not a canonical packet path/.test(e.message)), fmt(r.errors));
  assert.ok(r.errors.some((e) => /nav class="toc"/.test(e.message)), fmt(r.errors));
});

// --- R2 -------------------------------------------------------------------------------

test('[RV-R2] a policy/2 packet without report.json fails', async (t) => {
  const dir = await mutant(t, await base(t), {
    files: async (d, m) => { await rm(join(d, 'report.json')); m.files = m.files.filter((f) => f.path !== 'report.json'); },
  });
  const r = await verifyPacket(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'source' && /no report\.json source/.test(e.message)), fmt(r.errors));
  assert.deepEqual(r.errors.filter((e) => e.code !== 'source' && !/report\.json is missing or unreadable/.test(e.message)), [], fmt(r.errors));
});

test('[RV-R2] report.json bytes must be the canonical serialisation of their own parse', async (t) => {
  const dir = await mutant(t, await base(t), { reportJson: (r) => `${JSON.stringify(r, null, 1)}` });
  await onlyFinding(dir, 'source', /not the canonical JSON serialization/);
});

test('[RV-R2] report.json must digest to manifest.report.sourceSha256', async (t) => {
  const dir = await mutant(t, await base(t), { reportJson: (r) => { r.summary.paragraphs[0] = 'A different first paragraph.'; return r; }, keepSourceDigest: true });
  await onlyFinding(dir, 'source', /does not equal manifest\.report\.sourceSha256/);
});

test('[RV-R2] report.json metadata must agree with manifest.report', async (t) => {
  const dir = await mutant(t, await base(t), { reportJson: (r) => { r.metadata.reviewDate = '2026-01-01'; return r; } });
  await onlyFinding(dir, 'source', /metadata disagrees with manifest\.report/);
});

// Review 2 MINOR C: a malformed value at every place the policy/2 checks later read from
// report.json is a `source` finding, never an exception (the server answered 500 on these).
const TRAP = { toString: 1 };
const MALFORMED_SOURCES = [
  ['the whole source is null', () => null],
  ['metadata is a string', (r) => { r.metadata = 'x'; }],
  ['summary is null', (r) => { r.summary = null; }],
  ['summary.paragraphs is an object', (r) => { r.summary.paragraphs = {}; }],
  ['sections is not an array', (r) => { r.sections = 'x'; }],
  ['a section is null', (r) => { r.sections[0] = null; }],
  ['a section id is an object that cannot become text', (r) => { r.sections[0].id = TRAP; }],
  ['a section title is a number', (r) => { r.sections[0].title = 7; }],
  ['a section blocks is not an array', (r) => { r.sections[0].blocks = {}; }],
  ['a block is null', (r) => { r.sections[0].blocks[0] = null; }],
  ['a finding id is an object that cannot become text', (r) => { r.sections.flatMap((x) => x.blocks).find((b) => b.type === 'finding').id = TRAP; }],
  ['a finding severity is an object that cannot become text', (r) => { r.sections.flatMap((x) => x.blocks).find((b) => b.type === 'finding').severity = TRAP; }],
  ['a finding confidence is an array', (r) => { r.sections.flatMap((x) => x.blocks).find((b) => b.type === 'finding').confidence = ['proven']; }],
  ['appendices is null', (r) => { r.appendices = null; }],
  ['an appendix is a string', (r) => { r.appendices = ['x']; }],
  ['evidence is not an array', (r) => { r.evidence = {}; }],
  ['an evidence entry is null (ev6744)', (r) => { r.evidence.push(null); }],
  ['an evidence id is an object that cannot become text', (r) => { r.evidence[0].id = TRAP; }],
  ['provenance is null', (r) => { r.provenance = null; }],
  ['provenance.sources is a string', (r) => { r.provenance.sources = 'x'; }],
];
for (const [what, edit] of MALFORMED_SOURCES) {
  test(`[RV-R2] malformed report.json is a finding, never an exception: ${what}`, async (t) => {
    const dir = await mutant(t, await base(t), { reportJson: (r) => { const out = edit(r); return out === undefined ? r : out; } });
    let result;
    await assert.doesNotReject(async () => { result = await verifyPacketFull(dir); }, 'verify threw');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'source' && e.path === 'report.json'), fmt(result.errors));
  });
}

test('[RV-R2] fonts: exactly the six embedded faces, each backed by its own inventoried WOFF2', async (t) => {
  const dir = await mutant(t, await base(t), { css: (c) => c.replace(/@font-face\{font-family:"JetBrains Mono";[^}]*font-weight:700;[^}]*\}\n/, '') });
  const errors = await onlyFinding(dir, 'fonts', /JetBrains Mono 400\/700|every embedded WOFF2/);
  assert.equal(errors.length, 2, fmt(errors));
});

// --- R3 -------------------------------------------------------------------------------

test('[RV-R3] the verifier recounts blocks from report.json: one more source paragraph than anchors fails', async (t) => {
  const dir = await mutant(t, await base(t), { reportJson: (r) => { r.summary.paragraphs.push('An extra paragraph the page never numbered.'); return r; } });
  await onlyFinding(dir, 'unsafe-content', /report\.json counts \d+ numbered blocks|section#summary has \d+ b-anchors/, /report\.json counts \d+ numbered blocks/);
});

test('[RV-R3] anchors must run b-01 … b-N in document order', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('id="b-02" href="#b-02" aria-label="Block b-02">b-02', 'id="b-TMP" href="#b-02" aria-label="Block b-02">b-02').replace('id="b-03" href="#b-03" aria-label="Block b-03">b-03', 'id="b-02" href="#b-03" aria-label="Block b-03">b-03').replace('id="b-TMP"', 'id="b-03"') });
  await onlyFinding(dir, 'unsafe-content', /b-nn anchor [23] must be/);
});

test('[RV-R3] no other element may carry a b-nn id', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="lede">', '<p class="lede" id="b-7">') });
  await onlyFinding(dir, 'unsafe-content', /numbered blocks; the page has|b-nn anchor \d+ must be/);
});

// --- R5 -------------------------------------------------------------------------------

test('[RV-R5] nav.formats carries exactly the index.html, report.md and manifest.json links', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<a href="manifest.json" type="application/json">manifest.json</a></nav>', '</nav>') });
  await onlyFinding(dir, 'unsafe-content', /nav\.formats/);
});

test('[RV-R5] the rail comes after main inside div.layout', async (t) => {
  const dir = await mutant(t, await base(t), {
    html: (h) => {
      const rail = h.slice(h.indexOf('<aside class="rail"'), h.indexOf('</aside>') + '</aside>'.length);
      return h.replace(`\n${rail}`, '').replace('<div class="layout">\n', `<div class="layout">\n${rail}\n`);
    },
  });
  await onlyFinding(dir, 'unsafe-content', /div\.layout must hold main#content\.document first|aside\.rail\[aria-label="On this page"\] must follow main/);
});

test('[RV-R5] rail toc entries mirror every main > section[id] in order', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace(/<li><a href="#sec-findings">.*?<\/a><\/li>/, '') });
  await onlyFinding(dir, 'unsafe-content', /rail__toc entries must mirror/);
});

test('[RV-R5] main holds the report.json sections in order, with their numbers and titles', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<span class="sec-num" aria-hidden="true">01</span>', '<span class="sec-num" aria-hidden="true">1</span>') });
  await onlyFinding(dir, 'unsafe-content', /section#sec-findings must open with h2\.section__head "01"/);
});

test('[RV-R5] there is no section#provenance in policy/2', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<div class="colophon__provenance" id="provenance">', '<div class="colophon__provenance" id="prov">').replace('<section class="section section--evidence" id="evidence"', '<section class="section section--evidence" id="provenance"') });
  const r = await verifyPacket(dir);
  assert.ok(r.errors.some((e) => /no section#provenance/.test(e.message)), fmt(r.errors));
});

test('[RV-R5] the masthead slug is the report id', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<span class="masthead__slug">phase1-local-packet-review</span>', '<span class="masthead__slug">another-report</span>') });
  await onlyFinding(dir, 'unsafe-content', /masthead__slug must carry exactly the report id/);
});

test('[RV-R5] the colophon shows the full source digest with its first 8 hex digits in <b>', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace(/(<p class="colophon__digest" id="source-digest"><code><b>[0-9a-f]{8}<\/b>)[0-9a-f]/, '$10') });
  await onlyFinding(dir, 'unsafe-content', /p#source-digest must show the full report source digest/);
});

test('[RV-R5] the colophon generator line names the build tool, version and both policies', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('· render-policy/2 · security-policy/1 · zero scripts', '· render-policy/1 · security-policy/1 · zero scripts') });
  await onlyFinding(dir, 'unsafe-content', /colophon generator line must read/);
});

// Review NIT 8: the generator meta is checked exactly, not just its shape.
test('[RV-R5] the generator meta names exactly this build: tool, version, render-policy/2 and the security policy', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace(/(<meta name="generator" content="[^";]+; )render-policy\/2;/, '$1render-policy/1;') });
  await onlyFinding(dir, 'unsafe-content', /<meta name="generator"> must read "canon [^"]+; render-policy\/2; security-policy\/1", found \["canon [^"]+; render-policy\/1; security-policy\/1"\]/);
  const other = await mutant(t, await base(t), { html: (h) => h.replace(/<meta name="generator" content="[^"]*">/, '<meta name="generator" content="evil generator">') });
  await onlyFinding(other, 'unsafe-content', /<meta name="generator"> must read .*found \["evil generator"\]/);
});

test('[RV-R5] the page opens with the skip link to #content', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<a class="skip-link" href="#content">Skip to content</a>\n', '') });
  await onlyFinding(dir, 'unsafe-content', /body must open with one a\.skip-link to #content|body must hold exactly a\.skip-link, header\.masthead, div\.layout and footer\.colophon, in that order/, /in that order/);
});

test('[RV-R5] every finding carries exactly one confidence chip naming its confidence', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<span class="conf conf--defect"><span class="conf__glyph" aria-hidden="true">✕</span> Defect</span></p>', '<span class="conf conf--defect"><span class="conf__glyph" aria-hidden="true">✕</span> Defect</span><span class="conf conf--proven"><span class="conf__glyph" aria-hidden="true">✓</span> Proven</span></p>') });
  await onlyFinding(dir, 'unsafe-content', /finding f-F-1 must carry exactly one Defect confidence chip/);
});

// Review "inert tests" K1-K14: each structural check below had no test that went red when
// that check alone was disabled. One targeted defect each; red controls RV5x disable them.
const kCase = (name, edit, re, opts = {}) => test(`[RV-R5] ${name}`, async (t) => {
  const from = opts.marks ? await marksBase(t) : await base(t);
  const dir = await mutant(t, from, { html: edit });
  await onlyFinding(dir, 'unsafe-content', re);
});
async function marksBase(t) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24" width="120" height="24"><g fill="currentColor"><path d="M14 2 L30 2 L30 22 Z" fill-rule="evenodd"/></g></svg>';
  const tree = await treeWithMarks(t, { 'lockup-ui.svg': svg, 'lockup-display.svg': svg });
  const out = join(await tempDir(t, 'canon-rv-marks-k'), 'p');
  const built = buildInTree(tree, { reportPath: FIXTURE, outDir: out });
  assert.equal(built.full?.ok, true, JSON.stringify(built));
  return out;
}
kCase('K1: the masthead lockup is aria-hidden', (h) => h.replace('<svg class="lockup lockup--ui" aria-hidden="true"', '<svg class="lockup lockup--ui"'), /span\.masthead__brand lockup must be <svg class="lockup lockup--ui" aria-hidden="true">/, { marks: true });
kCase('K3: each section holds exactly its own blocks\' b-anchors', (h) => {
  const a = '<a class="b-anchor" id="b-06" href="#b-06" aria-label="Block b-06">b-06</a>';
  const head = '<span class="section__title">Packet layout and publication flow</span></h2>\n';
  return h.replace(a, '').replace(head, `${head}${a}`);
}, /section#sec-findings has 3 b-anchors; report\.json has 4 numbered blocks there|section#sec-design has 6 b-anchors; report\.json has 5 numbered blocks there/);
kCase('K4: each finding article carries its own id and severity', (h) => h.replace('<article class="finding finding--high" id="f-F-1"', '<article class="finding finding--low" id="f-F-1"'), /finding 1 must be article#f-F-1\.finding--high/);
kCase('K5: section#evidence lists the evidence entries in an ol.evidence-list', (h) => {
  const i = h.indexOf('<ol class="evidence-list">');
  const j = h.indexOf('</ol>', i);
  return `${h.slice(0, i)}<ul class="evidence-list">${h.slice(i + 26, j)}</ul>${h.slice(j + 5)}`;
}, /section#evidence must list every report\.json evidence entry in order/);
kCase('K6: the rail evidence list gives every entry its link and size', (h) => h.replace('<span class="rail__size">477 B</span>', ''), /div\.rail__evidence must list every evidence entry in order/);
kCase('K7: the colophon lists every report.json provenance source', (h) => h.replace(/(<ul class="colophon__sources">)<li>[\s\S]*?<\/li>/, '$1'), /div#provenance\.colophon__provenance must list every report\.json provenance source/);
kCase('K12: the skip link targets #content', (h) => h.replace('<a class="skip-link" href="#content">', '<a class="skip-link" href="#summary">'), /body must open with one a\.skip-link to #content/);
kCase('K13: the colophon title reads "Sealed by Canon"', (h) => h.replace('<p class="colophon__title">Sealed by Canon', '<p class="colophon__title">Verified and approved by Canon'), /colophon title must read "Sealed by Canon"/);
kCase('K14: the colophon shows the plain verify command', (h) => h.replace('<p class="colophon__cmd"><code>canon verify &lt;packet-dir&gt;', '<p class="colophon__cmd"><code>canon verify --skip &lt;packet-dir&gt;'), /colophon must show `canon verify <packet-dir>`/);

// --- R6 (markup side) -------------------------------------------------------------------

test('[RV-R6] only band-coloured classes may sit on the masthead and colophon bands', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="colophon__text">This page', '<p class="colophon__text"><span class="idx">E9</span> This page') });
  await onlyFinding(dir, 'unsafe-content', /class "idx" inside the colophon band has no band colour/);
});

// Repro of the colophon-notes contrast defect (fixed in the renderer by 6badc7f): an
// authored provenance note with an RFC 2119 keyword and a cite puts span.rfc2119 and a.cite
// on the dark colophon band. With the band overrides the packet verifies; without them the
// verifier refuses it.
async function notesSource(t) {
  const dir = await tempDir(t, 'canon-rv-notes-');
  await cp(join(REPO, 'fixtures/report'), dir, { recursive: true });
  const path = join(dir, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.provenance.notes = ['Built from the brief; the packet MUST verify ', { cite: 'ev-determinism' }, '.'];
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

test('[RV-R6] a colophon note with an RFC 2119 keyword and a cite verifies (band overrides present)', async (t) => {
  const out = join(await tempDir(t, 'canon-rv-notes-out-'), 'p');
  await buildPacket({ reportPath: await notesSource(t), outDir: out, renderPolicy: P2 });
  const html = await readFile(join(out, 'index.html'), 'utf8');
  const colophon = html.slice(html.indexOf('<footer class="colophon"'));
  assert.match(colophon, /<span class="rfc2119">MUST<\/span>/, 'the repro must put a keyword chip on the colophon band');
  assert.match(colophon, /<span class="cite-run">[^<]*<a class="cite" href="#ev-ev-determinism"/, 'the repro must put a cite on the colophon band');
  const r = await verifyPacket(out);
  assert.equal(r.ok, true, fmt(r.errors));
});

test('[RV-R6] a colophon note with an RFC 2119 keyword and a cite fails without the band overrides', async (t) => {
  const out = join(await tempDir(t, 'canon-rv-notes-out-'), 'p');
  await buildPacket({ reportPath: await notesSource(t), outDir: out, renderPolicy: P2 });
  const dir = await mutant(t, out, { css: (c) => c.replace(/  \.colophon \.rfc2119 \{[^}]*\}\n/, '').replace(/  \.colophon a\.cite \{[^}]*\}\n/, '') });
  const errors = await onlyFinding(dir, 'unsafe-content', /must set top-level (?:color|background|border-color)[^ ]* .* on \.colophon (?:\.rfc2119|a\.cite)|selector \.colophon (?:\.rfc2119|a\.cite)/, /\.colophon \.rfc2119/);
  assert.ok(errors.some((e) => /\.colophon a\.cite/.test(e.message)), fmt(errors));
});

test('[RV-R6] band classes may not leave their band', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="lede">', '<p class="lede"><span class="colophon__ref">x</span>') });
  await onlyFinding(dir, 'unsafe-content', /\.colophon__ref is outside its band/);
});

// Review finding MINOR 5: hiding markers only where html-v2 emits them.
const hideCase = (name, edit, re, must = null) => test(`[RV-R6] ${name}`, async (t) => {
  const dir = await mutant(t, await base(t), { html: edit });
  await onlyFinding(dir, 'unsafe-content', re, must);
});
hideCase('visually-hidden only on the captions, comparison labels and brand/option spans html-v2 hides', (h) => h.replace('<p class="finding__claim">When', '<p class="finding__claim visually-hidden">When'), /visually-hidden on <p class="finding__claim visually-hidden"> inside <article\.finding\.finding--high> is not a place render-policy\/2 puts it/);
hideCase('aria-hidden only on the decorative glyphs, numbers, pips and graphics html-v2 marks', (h) => h.replace('<p class="finding__claim">When', '<p class="finding__claim" aria-hidden="true">When'), /aria-hidden on <p class="finding__claim"> inside <article\.finding\.finding--high> is not a place render-policy\/2 puts it/);
hideCase('aria-hidden is only ever "true"', (h) => h.replace('<span class="sec-num" aria-hidden="true">01</span>', '<span class="sec-num" aria-hidden="false">01</span>'), /aria-hidden="false" on <span> is not emitted by render-policy\/2|section#sec-findings must open with h2\.section__head "01" "Findings"/, /aria-hidden="false" on <span> is not emitted/);
hideCase('stamp only in the kicker, decision status and chosen option', (h) => h.replace('<p class="prose-para">A packet is', '<p class="prose-para stamp">A packet is'), /stamp on <p class="prose-para stamp"> inside <div\.block[^>]*> is not a place render-policy\/2 puts it/);
hideCase('skip-link only on the first link in body', (h) => h.replace('<p class="prose-para">A packet is', '<p class="prose-para skip-link">A packet is'), /skip-link on <p class="prose-para skip-link"> inside <div\.block[^>]*> is not a place render-policy\/2 puts it/);
// The placement rule refuses the element, and the inspector refuses the lockup-only
// attributes inside it (they are accepted only in the two brand slots).
test('[RV-R6] svg.lockup only in the masthead brand and colophon mark (review NIT 7)', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="prose-para">A packet is', '<p class="prose-para"><svg class="lockup lockup--ui" aria-hidden="true"><text font-family="x">x</text></svg>A packet is') });
  const errors = await onlyFinding(dir, 'unsafe-content', /(?:lockup|aria-hidden) on <svg class="lockup lockup--ui"> inside <p\.prose-para> is not a place render-policy\/2 puts it|disallowed attribute font-family on <text>/, /lockup on <svg class="lockup lockup--ui"> inside <p\.prose-para> is not a place/);
  assert.ok(errors.some((e) => /disallowed attribute font-family on <text>/.test(e.message)), fmt(errors));
});

test('[RV-R6] the recommended-option arrow and its visually hidden label verify', async (t) => {
  const src = await tempDir(t, 'canon-rv-rec-');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.sections[3].blocks[0].alternatives[0].recommended = true;
  await writeFile(path, JSON.stringify(report, null, 2));
  const out = join(await tempDir(t, 'canon-rv-rec-out-'), 'p');
  await buildPacket({ reportPath: path, outDir: out, renderPolicy: P2 });
  assert.match(await readFile(join(out, 'index.html'), 'utf8'), /<span class="option__arrow" aria-hidden="true">→<\/span><span class="visually-hidden">Recommended:<\/span>/);
  const r = await verifyPacket(out);
  assert.equal(r.ok, true, fmt(r.errors));
});

test('[RV-R6] lockup presentation attributes are accepted only inside svg.lockup, never on plates', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace(/(<div class="diagram-canvas">[\s\S]*?<rect )/, '$1fill-rule="evenodd" ') });
  await onlyFinding(dir, 'unsafe-content', /disallowed attribute fill-rule on <rect>/);
});

// --- R6 (stylesheet) --------------------------------------------------------------------

const cssCase = (name, edit, re, must = null) => test(`[RV-R6] ${name}`, async (t) => {
  const dir = await mutant(t, await base(t), { css: edit });
  await onlyFinding(dir, 'unsafe-content', re, must);
});

// Phone-width overflow fix (r2-renderer 2ca03ac; review 4 MINOR 1): a cite run is an
// inline-block capped at the line, and unbreakable only inside a scrolling data table. Those
// three declarations are pinned exactly; every widening is refused by the independent rules
// alone, with no help from reproduction.
const CITE_RUN_SHIPPED = ['  .cite-run { display: inline-block; max-width: 100%; }', '  .table__scroll .cite-run { white-space: nowrap; }'];
const CITE_RUN_WIDENED = [
  // The reviewer's al1-al10.
  '.cite-run { white-space: nowrap; }',
  '.table__scroll .cite-run { overflow-wrap: normal; }',
  '.cite-run { max-width: none; }',
  '.cite-run { max-width: 200%; }',
  '.cite-run { white-space: pre; }',
  '.table__scroll .cite-run { display: inline-block; }',
  '.table__scroll .prose-para { white-space: nowrap; }',
  '.cite-run a.cite { white-space: nowrap; }',
  '.cite-run { min-width: 40rem; }',
  '.cite-run { width: 2000px; }',
  // A broader selector, an extra property, a looser value, another context.
  '.cite-run, .idx { display: inline-block; }',
  '.document .cite-run { display: inline-block; }',
  '.table__scroll .cite-run, .cite-run { white-space: nowrap; }',
  '.cite-run { display: block; }',
  '.cite-run { max-width: 40rem; }',
  '.cite-run { overflow-wrap: anywhere; }',
  '.table__scroll .cite-run { white-space: normal; }',
  '.cite-run:hover { display: inline-block; }',
];
test('[RV-R6] a cite run may be an inline-block, and nowrap only inside .table__scroll', async (t) => {
  const from = await base(t);
  const css = await readFile(join(from, (await readJson(join(from, 'manifest.json'))).files.find((f) => f.path.endsWith('.css')).path), 'utf8');
  for (const rule of CITE_RUN_SHIPPED) assert.ok(css.includes(`${rule}\n`), `the shipped stylesheet has ${rule.trim()}`);
  await ok(from);
  const anchor = `${CITE_RUN_SHIPPED[1]}\n`;
  for (const rule of CITE_RUN_WIDENED) {
    const dir = await mutant(t, from, { css: (c) => c.replace(anchor, `${anchor}  ${rule}\n`) });
    const r = await verifyPacket(dir);
    assert.equal(r.ok, false, `the independent rules must refuse ${rule}`);
    assert.ok(r.errors.every((e) => e.code === 'unsafe-content' && /cite-run|prose-para/.test(e.message)), `${rule}: ${fmt(r.errors)}`);
  }
  for (const rule of ['@media print { .cite-run { display: inline-block; } }']) {
    const dir = await mutant(t, from, { css: (c) => `${c}${rule}\n` });
    assert.equal((await verifyPacket(dir)).ok, false, `the independent rules must refuse ${rule}`);
  }
});

cssCase('retired hex values are absent, comments included', (c) => c.replace('/*\n * Canon 2.1 edition stylesheet', '/* #7e22ce\n * Canon 2.1 edition stylesheet'), /retired colour #7e22ce/);
cssCase('retired tokens are absent', (c) => c.replace('--open-bd-style: dashed;', '--open-bd-style: dashed;\n    --open-ink: #0f172a;'), /retired render-policy\/1 token --open-ink in|custom property --open-ink is not in the allowed Canon token set/, /retired render-policy\/1 token --open-ink in/);
cssCase('the dark band surface is allowed only on the masthead and colophon', (c) => c.replace('  .verdict {\n    margin-top: 1.5rem;\n    background: var(--card);', '  .verdict {\n    margin-top: 1.5rem;\n    background: var(--chrome-band);'), /var\(--chrome-band\) is only allowed on the masthead or colophon band/);
cssCase('text on a band must use a band ink', (c) => c.replace('.colophon__gen { font-family: var(--mono); font-size: 0.75rem; color: var(--chrome-band-muted);', '.colophon__gen { font-family: var(--mono); font-size: 0.75rem; color: var(--muted);'), /on the band selector \.colophon__gen must be a band ink/);
cssCase('band text reaches 4.5:1 against --chrome-band (light)', (c) => c.replace('    --chrome-band-muted: #a3adbd;\n    --chrome-band-accent: #93c5fd;\n    --chrome-band-current: #172554;\n\n    --code-inline-ink: #1e3a8a;', '    --chrome-band-muted: #334155;\n    --chrome-band-accent: #93c5fd;\n    --chrome-band-current: #172554;\n\n    --code-inline-ink: #1e3a8a;'), /^CSS :root band text --chrome-band-muted \(#334155\) vs --chrome-band(?:-current)? \(#[0-9a-f]+\) is below 4\.5:1$/);
cssCase('body text, including the 11px meta lines, reaches 4.5:1 in the dark scheme', (c) => c.replace('      --muted: #a3adbd;', '      --muted: #475569;'), /^CSS @media \(prefers-color-scheme: dark\) :root document text --muted \(#475569\) vs --[a-z-]+ \(#[0-9a-f]+\) is below 4\.5:1$/);
// Review MINOR 6: pips and severity bars keep 3:1 non-text contrast in light, dark and print.
cssCase('pips keep 3:1 against unlit pips and the card (no --pip-on: var(--paper))', (c) => c.replace('    --pip-on: var(--ink);', '    --pip-on: var(--paper);'), /(?::root|@media \(prefers-color-scheme: dark\) :root|@media print :root) pip --pip-on \(#[0-9a-f]+\) vs --(?:pip-off|card) \([^)]*\) is below 3:1 non-text contrast/, /^CSS :root pip --pip-on \(#f4f6f9\) vs --card/);
cssCase('severity bars keep 3:1 against the card (no --sev-bar-critical: #f4f6f9)', (c) => c.replace('    --sev-bar-critical: #b91c1c;', '    --sev-bar-critical: #f4f6f9;'), /:root (?:severity bar --sev-bar-critical|pip --pip-critical) \(#f4f6f9\) vs --(?:card|pip-off) \([^)]*\) is below 3:1 non-text contrast/, /severity bar --sev-bar-critical \(#f4f6f9\) vs --card/);
cssCase('a lit critical pip keeps 3:1 against unlit pips in print', (c) => c.replace('      --pip-off: #e2e8f0;', '      --pip-off: #94a3b8;'), /@media print :root pip --pip-critical \(#b91c1c\) vs --pip-off \(#94a3b8\) is below 3:1 non-text contrast/);
cssCase('every colour token has a dark value or follows a token that flips', (c) => c.replace('      --svg-budget: #f87171;\n', ''), /colour token --svg-budget has no @media \(prefers-color-scheme: dark\) value/);
cssCase('a token alias must follow a colour token', (c) => c.replace('--pip-on: var(--ink);', '--pip-on: var(--page);'), /:root alias --pip-on must follow a colour token|var\(--pip-on\) references a custom property not defined|pip non-text contrast pair --pip-on \/ --(?:pip-off|card) is not defined/, /:root alias --pip-on must follow a colour token/);
cssCase('amber is used only on gate selectors', (c) => c.replace('.svg-msg__origin { fill: var(--accent); }', '.svg-msg__origin { fill: var(--svg-gate); }'), /var\(--svg-gate\) is only allowed on a gate selector/);
cssCase('plate layer accents are ink, never another colour', (c) => c.replace('  .svg-node--role-external .svg-node__accent { fill: var(--ink); }', '  .svg-node--role-external .svg-node__accent { fill: var(--accent); }'), /plate layer accent var\(--accent\) must be var\(--ink\)|must set top-level fill: var\(--ink\) on \.svg-node--role-(?:entry|store|external) \.svg-node__accent/, /plate layer accent var\(--accent\) must be var\(--ink\)/);
cssCase('the column and rail flex values are exactly R6\'s', (c) => c.replace('.document { flex: 999 1 600px;', '.document { flex: 3 1 600px;'), /flex shorthand 3 1 600px not allowed on \.document/);
cssCase('there is no .toc (nor any selector policy/2 does not emit)', (c) => c.replace('  .rail ol { padding: 0; list-style: none; }', '  .rail ol { padding: 0; list-style: none; }\n  .toc { display: none; }'), /selector "\.toc" not allowed|display: none not allowed on \.toc/);
cssCase('generated content is pinned per selector, so no text can be injected through CSS', (c) => c.replace('.colophon__cmd::before { content: "$ ";', '.colophon__cmd::before { content: "Verified ";'), /generated content "Verified " not allowed on \.colophon__cmd::before/);
cssCase('a declaration outside the shared grammar is allowed only exactly as pinned', (c) => c.replace('text-overflow: ellipsis;', 'text-overflow: clip;'), /CSS property text-overflow not allowed/);
cssCase('the stamp ink is scoped to .stamp', (c) => c.replace('  .open-tag {\n    display: inline-block;\n    font-size: 0.75rem;\n    font-weight: 600;\n    color: var(--ink);', '  .open-tag {\n    display: inline-block;\n    font-size: 0.75rem;\n    font-weight: 600;\n    color: var(--stamp-ink);'), /var\(--stamp-ink\) is only allowed on \.stamp/);

test('[RV-R6] the policy/2 rulebook is not applied to policy/1 stylesheets, and site bundles keep the policy/1 default', async () => {
  const css = await readFile(join(REPO, 'src/presentation/edition-2.1.css'), 'utf8');
  assert.deepEqual(scanCssPolicy(css, new Set(), { renderPolicy: P2 }).filter((p) => !/inventoried fingerprinted WOFF2/.test(p)), []);
  assert.ok(scanCssPolicy(css, new Set()).length > 0, 'the default (policy/1) rules reject the policy/2 stylesheet');
});

// --- R9 -------------------------------------------------------------------------------

// Captain's ruling on review MAJOR 4: URLs are fine as text (code, prose, tables); in an
// attribute only an authored ext link's https href may carry one.
test('[RV-R9] http(s) URLs as text in code samples, prose and evidence verify (the reviewer\'s fu source)', async (t) => {
  const src = await tempDir(t, 'canon-rv-fu-');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  let codes = 0;
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (typeof o.source === 'string' && typeof o.language === 'string') { o.source = `curl https://api.example.com/v1/health\n${o.source}`; codes += 1; }
    Object.values(o).forEach(walk);
  };
  walk(report);
  assert.ok(codes >= 2, `the source needs code samples to carry URLs (found ${codes})`);
  report.summary.paragraphs[0] = [`${typeof report.summary.paragraphs[0][0] === 'string' ? report.summary.paragraphs[0][0] : ''} The probe calls http://localhost:8080/health first.`];
  await writeFile(path, JSON.stringify(report, null, 2));
  const out = join(await tempDir(t, 'canon-rv-fu-out-'), 'p');
  await buildPacket({ reportPath: path, outDir: out, renderPolicy: P2 });
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.ok((html.match(/https:\/\/api\.example\.com\/v1\/health/g) ?? []).length >= 2 && html.includes('http://localhost:8080/health'), 'the URLs must reach the page as text');
  const r = await verifyPacket(out);
  assert.equal(r.ok, true, fmt(r.errors));
});

test('[RV-R9] an http(s) URL in any attribute other than an authored ext link href fails', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="lede">', '<p class="lede" title="https://example.com/">') });
  await onlyFinding(dir, 'unsafe-content', /http\(s\) URL in the title attribute of <p>: only an authored ext link's https href may carry one/);
  const cite = await mutant(t, await base(t), { html: (h) => h.replace(/<a class="cite" href="#ev-ev-determinism" title="[^"]*">/, '<a class="cite" href="#ev-ev-determinism" title="see https://example.com/">') });
  await onlyFinding(cite, 'unsafe-content', /http\(s\) URL in the title attribute of <a>: only an authored ext link's https href may carry one/);
});

test('[RV-R9] only the renderer\'s five character references are accepted (no &colon; or numeric spelling of a URL)', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<p class="lede">', '<p class="lede">https&colon;//example.com ') });
  await onlyFinding(dir, 'unsafe-content', /character references other than/);
});

// --- R8 -------------------------------------------------------------------------------

test('[RV-R8] a policy/2 reissue of a policy/1 edition: build records reissueOf, verify --reissue-of passes', async (t) => {
  const old = await base(t, FIXTURE, { renderPolicy: 'render-policy/1' });
  const out = join(await tempDir(t, 'canon-rv-reissue'), 'p');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: out, renderPolicy: P2, reissueOfDir: old });
  const oldId = (await readJson(join(old, 'manifest.json'))).contentId;
  assert.equal(built.manifest.report.reissueOf, oldId);
  await ok(out);
  const r = await verifyReissue(out, old);
  assert.equal(r.ok, true, fmt(r.errors));
  const cli = runCli(['verify', out, '--reissue-of', old]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`is a reissue of ${oldId}`));
});

test('[RV-R8] the build refuses a reissue whose old packet has another source, does not verify, or is not policy/2', async (t) => {
  const old = await base(t, FIXTURE, { renderPolicy: 'render-policy/1' });
  await assert.rejects(buildPacket({ reportPath: SPECIMEN, renderPolicy: P2, reissueOfDir: old }), (e) => e instanceof BuildError && e.code === 'reissue-of' && /not a reissue/.test(e.message));
  const broken = join(await tempDir(t, 'canon-rv-broken'), 'p');
  await cp(old, broken, { recursive: true });
  await writeFile(join(broken, 'report.md'), 'tampered\n');
  await assert.rejects(buildPacket({ reportPath: FIXTURE, renderPolicy: P2, reissueOfDir: broken }), (e) => e instanceof BuildError && e.code === 'reissue-of' && /does not verify/.test(e.message));
  await assert.rejects(buildPacket({ reportPath: FIXTURE, reissueOfDir: old }), (e) => e instanceof BuildError && e.code === 'reissue-of');
  const cli = runCli(['build', FIXTURE, '--out', join(await tempDir(t, 'canon-rv-cli'), 'p'), '--reissue-of', old]);
  assert.equal(cli.status, 2, 'a policy/1 build with --reissue-of is a usage error');
});

// Review finding MAJOR 3: the same source with different evidence bytes (the report names
// evidence by path, so its digest does not move) used to seal a reissueOf that
// `verify --reissue-of` then rejected. The build now runs the same relation checks first.
test('[RV-R8] the build refuses a reissue whose evidence differs from the old packet, and writes nothing', async (t) => {
  const src = await tempDir(t, 'canon-rv-ev-src-');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const report = join(src, 'phase1-review.report.json');
  const old = join(await tempDir(t, 'canon-rv-ev-old-'), 'p');
  await buildPacket({ reportPath: report, outDir: old, renderPolicy: 'render-policy/1' });
  const item = JSON.parse(await readFile(report, 'utf8')).evidence.find((e) => e.kind === 'file' && e.path.endsWith('.txt'));
  const evPath = join(src, item.path);
  await writeFile(evPath, `${await readFile(evPath, 'utf8')}appended line\n`);
  const out = join(await tempDir(t, 'canon-rv-ev-new-'), 'p');
  await assert.rejects(buildPacket({ reportPath: report, outDir: out, renderPolicy: P2, reissueOfDir: old }), (e) => e instanceof BuildError && e.code === 'reissue-of' && /^reissue-of: not a reissue: .*manifest\.json#\/files: evidence inventories \(paths and digests\) differ/.test(e.message));
  await assert.rejects(access(out), 'a refused reissue writes no packet');
  const cli = runCli(['build', report, '--out', out, '--render-policy', '2', '--reissue-of', old]);
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /evidence inventories \(paths and digests\) differ/);
});

test('[RV-R8] verify --reissue-of fails on a missing reissueOf, a different source, a changed report.md, or a changed evidence inventory', async (t) => {
  const old = await base(t, FIXTURE, { renderPolicy: 'render-policy/1' });
  const plain = await base(t, FIXTURE);
  const missing = await verifyReissue(plain, old);
  assert.deepEqual(missing.errors.map((e) => e.path), ['new:manifest.json#/report/reissueOf'], fmt(missing.errors));

  const out = join(await tempDir(t, 'canon-rv-reissue2'), 'p');
  await buildPacket({ reportPath: FIXTURE, outDir: out, renderPolicy: P2, reissueOfDir: old });
  const other = await base(t, SPECIMEN, { renderPolicy: 'render-policy/1' });
  const wrong = await verifyReissue(out, other);
  assert.ok(wrong.errors.some((e) => /source digests differ/.test(e.message)), fmt(wrong.errors));

  // A changed report.md on the new (policy/2) side is caught by its reproduction; on the old
  // (policy/1, independently verified) side by the byte comparison with the new rebuild.
  const md = await mutant(t, out, { files: async (d) => { await writeFile(join(d, 'report.md'), `${await readFile(join(d, 'report.md'), 'utf8')}\n`); } });
  const mdResult = await verifyReissue(md, old);
  assert.deepEqual(mdResult.errors.map((e) => `${e.code} ${e.path}`), ['reproduction new:report.md'], fmt(mdResult.errors));
  const oldMd = await mutant(t, old, { files: async (d) => { await writeFile(join(d, 'report.md'), `${await readFile(join(d, 'report.md'), 'utf8')}\n`); } });
  const outMd = join(await tempDir(t, 'canon-rv-reissue-md'), 'p');
  await buildPacket({ reportPath: FIXTURE, outDir: outMd, renderPolicy: P2, reissueOfDir: old });
  const oldMdResult = await verifyReissue(outMd, oldMd);
  assert.ok(oldMdResult.errors.some((e) => e.message === 'report.md is not byte-identical'), fmt(oldMdResult.errors));

  const ev = await mutant(t, out, {
    files: async (d, m) => {
      const f = m.files.find((x) => x.role === 'evidence' && x.path.endsWith('.txt'));
      const bytes = Buffer.from(`${await readFile(join(d, f.path), 'utf8')}one more line\n`);
      const next = `evidence/${sha256(bytes)}.txt`;
      await rm(join(d, f.path));
      await writeFile(join(d, next), bytes);
      const rel = m.evidence.find((e) => e.path === f.path);
      rel.path = next;
      rel.sha256 = sha256(bytes);
      f.path = next;
    },
  });
  const evResult = await verifyReissue(ev, old);
  assert.ok(evResult.errors.some((e) => /evidence inventories/.test(e.message)), fmt(evResult.errors));
  const cli = runCli(['verify', ev, '--reissue-of', old]);
  assert.equal(cli.status, 1);
});

// --- R11: verify = independent rules + reproduction (review MAJOR 1/2) -------------------
// Each defect below is resealed so the independent rules (verifyPacket) pass; only the
// reproduction step, which rebuilds the packet from report.json, can object.
async function reproductionOnly(dir, path, re) {
  const independent = await verifyPacket(dir);
  assert.equal(independent.ok, true, `the independent rules must not see this defect: ${fmt(independent.errors)}`);
  const full = await verifyPacketFull(dir);
  assert.equal(full.ok, false, 'reproduction must refuse the packet');
  assert.deepEqual(full.errors.map((e) => `${e.code} ${e.path}`), [`reproduction ${path}`], fmt(full.errors));
  assert.match(full.errors[0].message, re);
  const cli = runCli(['verify', dir]);
  assert.equal(cli.status, 1, `canon verify must exit 1: ${cli.stdout}${cli.stderr}`);
}
const carryDigest = (from, to) => async (d) => {
  const md = join(d, 'report.md');
  await writeFile(md, (await readFile(md, 'utf8')).split(from).join(to));
};

test('[RV-R11] valid policy/2 packets reproduce byte for byte (fixture, specimen, a reissue)', async (t) => {
  for (const dir of [await base(t), await base(t, SPECIMEN)]) {
    const r = await reproducePacket(dir);
    assert.equal(r.ok, true, fmt(r.errors));
    assert.equal((await verifyPacketFull(dir)).ok, true);
  }
  const out = join(await tempDir(t, 'canon-rv-repro-reissue'), 'p');
  await buildPacket({ reportPath: FIXTURE, outDir: out, renderPolicy: P2, reissueOfDir: await base(t, FIXTURE, { renderPolicy: 'render-policy/1' }) });
  assert.equal((await reproducePacket(out)).ok, true);
});

test('[RV-R11] m1: a report.md that is not the rebuild of report.json fails', async (t) => {
  const dir = await mutant(t, await base(t), { files: async (d) => { await writeFile(join(d, 'report.md'), '# Totally different report\n\nAll is well. Ship it.\n'); } });
  await reproductionOnly(dir, 'report.md', /report\.md differs from the rebuild of report\.json/);
});

test('[RV-R11] m2: page words that are not report.json\'s words fail', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('Adopt content-addressed packets with separate alias records.', 'Reject this design entirely; it is unsafe.').replace('A packet is an immutable directory', 'Nothing here is true; a packet is a mutable blob') });
  await reproductionOnly(dir, 'index.html', /index\.html differs from the rebuild of report\.json/);
});

test('[RV-R11] m3: a changed status stamp and title fail', async (t) => {
  const dir = await mutant(t, await base(t), { html: (h) => h.replace('<span class="stamp">Proposed</span>', '<span class="stamp">Approved</span>').replace('<h1>Local immutable review packets: Phase 1 design review</h1>', '<h1>Something else entirely</h1>') });
  await reproductionOnly(dir, 'index.html', /index\.html differs from the rebuild of report\.json/);
});

test('[RV-R11] m4: a changed report.json (digests carried through) that the page does not render fails', async (t) => {
  const from = await base(t);
  const old = (await readJson(join(from, 'manifest.json'))).report.sourceSha256;
  let now = null;
  const dir = await mutant(t, from, {
    reportJson: (r) => { r.summary.paragraphs[0] = ['Report.json says the design is UNSAFE and must not ship.']; now = sha256(canonicalBytes(r)); return r; },
    files: async (d) => carryDigest(old, now)(d),
  });
  await reproductionOnly(dir, 'index.html', /index\.html differs from the rebuild of report\.json/);
});

test('[RV-R11] m5: a schema-invalid report.json fails', async (t) => {
  const from = await base(t);
  const old = (await readJson(join(from, 'manifest.json'))).report.sourceSha256;
  let now = null;
  const dir = await mutant(t, from, {
    reportJson: (r) => {
      const f = r.sections.flatMap((x) => x.blocks).find((b) => b.type === 'finding');
      f.severity = 'informational-only';
      f.injected = { anything: ['goes'] };
      now = sha256(canonicalBytes(r));
      return r;
    },
    html: (h) => h.replace('finding finding--high" id="f-F-1"', 'finding finding--informational-only" id="f-F-1"'),
    files: async (d) => carryDigest(old, now)(d),
  });
  // The independent rules may also object to the unknown severity class; reproduction must
  // refuse the source itself.
  const full = await verifyPacketFull(dir);
  assert.equal(full.ok, false);
  const repro = await reproducePacket(dir);
  assert.deepEqual(repro.errors.map((e) => `${e.code} ${e.path}`), ['reproduction report.json'], fmt(repro.errors));
  assert.match(repro.errors[0].message, /report\.json is not a valid report\/v1 source/);
});

test('[RV-R11] a packet sealed by another canon version reproduces with its recorded manifest.build values', async (t) => {
  const from = await base(t);
  const m = await readJson(join(from, 'manifest.json'));
  const was = `${m.build.tool} ${m.build.version}`;
  const dir = await mutant(t, from, {
    html: (h) => h.split(`${was};`).join(`${m.build.tool} 9.9.9;`).split(`${was} ·`).join(`${m.build.tool} 9.9.9 ·`),
    manifest: (x) => { x.build.version = '9.9.9'; },
  });
  const r = await verifyPacketFull(dir);
  assert.equal(r.ok, true, fmt(r.errors));
});

test('[RV-R11] the manifest identity must be the rebuild\'s, not only the files', async (t) => {
  const dir = await mutant(t, await base(t), { manifest: (m) => { const rel = m.evidence.find((e) => e.citedBy.length > 0); rel.citedBy = []; } });
  await reproductionOnly(dir, 'manifest.json', /the manifest identity differs from the rebuild of report\.json/);
});

test('[RV-R11] rlie: a reissue whose page says other words than its source fails verify --reissue-of', async (t) => {
  const old = await base(t, FIXTURE, { renderPolicy: 'render-policy/1' });
  const out = join(await tempDir(t, 'canon-rv-rlie'), 'p');
  await buildPacket({ reportPath: FIXTURE, outDir: out, renderPolicy: P2, reissueOfDir: old });
  assert.equal((await verifyReissue(out, old)).ok, true);
  const lie = await mutant(t, out, { html: (h) => h.replace('Adopt content-addressed packets with separate alias records.', 'Reject this design entirely; it is unsafe.').replace('A packet is an immutable directory', 'Nothing here is true; a packet is a mutable blob') });
  assert.equal((await verifyPacket(lie)).ok, true, 'the independent rules alone accept the lie');
  const r = await verifyReissue(lie, old);
  assert.deepEqual(r.errors.map((e) => `${e.code} ${e.path}`), ['reproduction new:index.html'], fmt(r.errors));
  const cli = runCli(['verify', lie, '--reissue-of', old]);
  assert.equal(cli.status, 1);
  // ... and the build refuses to reissue from a policy/2 packet that does not reproduce.
  await assert.rejects(buildPacket({ reportPath: FIXTURE, renderPolicy: P2, reissueOfDir: lie }), (e) => e instanceof BuildError && /does not verify \(1 error\(s\); first: reproduction index\.html/.test(e.message));
});

test('[RV-R11] publish and archive refuse a policy/2 packet that does not reproduce', async (t) => {
  const lie = await mutant(t, await base(t), { html: (h) => h.replace('Adopt content-addressed packets with separate alias records.', 'Reject this design entirely; it is unsafe.') });
  assert.equal((await verifyPacket(lie)).ok, true, 'the independent rules alone accept the lie');
  const store = join(await tempDir(t, 'canon-rv-store'), 'store');
  const pub = runCli(['publish', lie, '--root', store]);
  assert.equal(pub.status, 1, `publish must refuse: ${pub.stdout}${pub.stderr}`);
  assert.match(`${pub.stdout}${pub.stderr}`, /reproduction/);
  const good = runCli(['publish', await base(t), '--root', store]);
  assert.equal(good.status, 0, `a reproducible packet publishes: ${good.stdout}${good.stderr}`);
  await assert.rejects(archivePacket(lie), /refusing to archive a packet that does not verify: reproduction/);
});

// --- R11 build metadata (review 2 MAJOR A) ----------------------------------------------
// A policy/2 manifest.build names exactly canon, a known security policy and a strict semver
// version; the independent rules hold it (no reproduction needed) and the builder refuses it.
const forgeBuild = (fields) => async (t) => {
  const from = await base(t);
  const b = (await readJson(join(from, 'manifest.json'))).build;
  const next = { ...b, ...fields };
  const meta = (x) => `${x.tool} ${x.version}; render-policy/2; ${x.securityPolicy}`;
  const gen = (x) => `${x.tool} ${x.version} · render-policy/2 · ${x.securityPolicy} · zero scripts`;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return mutant(t, from, {
    html: (h) => h.replace(`content="${esc(meta(b))}"`, `content="${esc(meta(next))}"`).replace(esc(gen(b)), esc(gen(next))),
    manifest: (m) => { Object.assign(m.build, fields); },
  });
};
test('[RV-R11] build.tool must be exactly "canon" (f2: "Canon Certified")', async (t) => {
  const dir = await forgeBuild({ tool: 'Canon Certified' })(t);
  await onlyFinding(dir, 'build', /^expected "canon", found "Canon Certified"$/);
});
test('[RV-R11] build.securityPolicy must be a known security policy (f1: "security-policy/0 (scripts allowed)")', async (t) => {
  const dir = await forgeBuild({ securityPolicy: 'security-policy/0 (scripts allowed)' })(t);
  await onlyFinding(dir, 'build', /^expected one of security-policy\/1, found "security-policy\/0 \(scripts allowed\)"$/);
});
test('[RV-R11] build.version must be a strict semver string (f2: "9.9.9-audited"; f5: null)', async (t) => {
  const dir = await forgeBuild({ version: '9.9.9-audited' })(t);
  await onlyFinding(dir, 'build', /^expected a semver version \(major\.minor\.patch\), found "9\.9\.9-audited"$/);
  const nul = await forgeBuild({ version: null })(t);
  await onlyFinding(nul, 'build', /^expected a semver version \(major\.minor\.patch\), found null$/);
  const older = await forgeBuild({ version: '0.0.1' })(t);
  assert.equal((await verifyPacket(older)).ok, true, 'a packet from an older release keeps verifying');
  // Strict semver 2.0.0: no leading zeros, except a lone 0 (review 3 f8).
  for (const version of ['00.01.000', '01.0.0', '0.01.0', '0.0.00']) {
    const lead = await forgeBuild({ version })(t);
    await onlyFinding(lead, 'build', /^expected a semver version \(major\.minor\.patch\), found "/);
  }
  assert.equal((await verifyPacket(await forgeBuild({ version: '10.0.100' })(t))).ok, true, 'multi-digit numbers without a leading zero verify');
});
test('[RV-R11] the verifier\'s build-metadata constants equal src/policy.mjs, and the builder refuses the same values', async () => {
  assert.equal(BUILD_TOOL_2, TOOL.name);
  assert.deepEqual([...SECURITY_POLICIES_2], [...SECURITY_POLICIES]);
  const { report, baseDir } = await loadReport(FIXTURE);
  const evidenceBytes = await loadEvidence(report, baseDir);
  const inputs = await loadRenderInputs(P2);
  const assemble = (tool) => assemblePacket(report, { evidenceBytes, stylesheetBytes: inputs.stylesheetBytes, fontAssets: inputs.fontAssets, lockups: inputs.lockups, renderPolicy: P2, tool });
  for (const tool of [
    { name: 'Canon Certified', version: TOOL.version, securityPolicy: TOOL.securityPolicy },
    { name: TOOL.name, version: TOOL.version, securityPolicy: 'security-policy/0 (scripts allowed)' },
    { name: TOOL.name, version: '9.9.9-audited', securityPolicy: TOOL.securityPolicy },
    { name: TOOL.name, version: '00.01.000', securityPolicy: TOOL.securityPolicy },
    { name: TOOL.name, version: '1.02.3', securityPolicy: TOOL.securityPolicy },
    { name: 5, version: null, securityPolicy: true },
  ]) {
    assert.throws(() => assemble(tool), (e) => e instanceof BuildError && e.code === 'build-metadata', JSON.stringify(tool));
  }
  assert.doesNotThrow(() => assemble({ name: TOOL.name, version: '0.0.1', securityPolicy: TOOL.securityPolicy }));
});

// Review 2 item 5: every place a packet is verified refuses a policy/2 packet that passes the
// independent rules and fails reproduction (the reviewer's fw: one sentence of the page
// changed), and accepts the honest packet it was made from.
async function honestAndForged(t) {
  const src = await tempDir(t, 'canon-rv-cs-src-');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.publication = { classification: 'private-review', dataOrigin: 'synthetic' };
  await writeFile(path, JSON.stringify(report));
  const honest = join(await tempDir(t, 'canon-rv-cs-honest-'), 'p');
  await buildPacket({ reportPath: path, outDir: honest, renderPolicy: P2 });
  const forged = await mutant(t, honest, { html: (h) => h.replace('Adopt content-addressed packets with separate alias records.', 'Reject this design entirely; it is unsafe.') });
  assert.equal((await verifyPacket(forged)).ok, true, 'the forgery passes the independent rules');
  assert.equal((await verifyPacketFull(forged)).ok, false, 'and fails reproduction');
  const id = async (dir) => (await readJson(join(dir, 'manifest.json'))).contentId;
  return { honest, forged, honestId: await id(honest), forgedId: await id(forged) };
}
async function storeHolding(t, dir, contentId) {
  const root = join(await tempDir(t, 'canon-rv-cs-store-'), 'store');
  await cp(dir, packetPath(root, contentId), { recursive: true });
  return root;
}

test('[RV-R11] call site: alias set refuses a packet that does not reproduce', async (t) => {
  const { honest, forged, honestId, forgedId } = await honestAndForged(t);
  const root = await storeHolding(t, forged, forgedId);
  await assert.rejects(setAlias({ root, name: 'review', contentId: forgedId, expectGeneration: 0 }));
  assert.equal(await readAlias(root, 'review'), null, 'no alias record is written');
  const ok = await storeHolding(t, honest, honestId);
  await setAlias({ root: ok, name: 'review', contentId: honestId, expectGeneration: 0 });
  assert.equal((await readAlias(ok, 'review')).contentId, honestId);
});

test('[RV-R11] call site: the local server does not serve a packet that does not reproduce', async (t) => {
  const { honest, forged, honestId, forgedId } = await honestAndForged(t);
  const root = await storeHolding(t, forged, forgedId);
  await cp(honest, packetPath(root, honestId), { recursive: true });
  const srv = createPacketServer({ root });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const get = async (id) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/p/${id}/index.html`); return { status: res.status, body: await res.text() }; };
  const bad = await get(forgedId);
  assert.equal(bad.status, 404);
  assert.ok(!bad.body.includes('Reject this design entirely'), 'the forged words are not served');
  assert.equal((await get(honestId)).status, 200);
});

test('[RV-R11] call site: protocol publish refuses a packet that does not reproduce', async (t) => {
  const { honest, forged } = await honestAndForged(t);
  const h = await harness('fs', t);
  await assert.rejects(publish({ ...h.opts(), packetDir: forged }), (e) => e instanceof PublicationError && e.code === CODES.INVALID && e.details?.errors?.some((x) => x.code === 'reproduction'));
  const r = await publish({ ...h.opts(), packetDir: honest });
  assert.equal(r.contentId, (await readJson(join(honest, 'manifest.json'))).contentId);
});

test('[RV-R11] call site: the fs publication adapter does not commit a packet that does not reproduce', async (t) => {
  const { honest, forged, honestId, forgedId } = await honestAndForged(t);
  const upload = async (dir, id) => {
    const root = join(await tempDir(t, 'canon-rv-cs-fs-'), 'store');
    const ad = fsAdapter({ root });
    const m = await readJson(join(dir, 'manifest.json'));
    for (const path of [...m.files.map((f) => f.path), 'checksums.json', 'manifest.json']) {
      const bytes = await readFile(join(dir, path));
      await ad.putIfAbsent({ key: `p/${id}/${path}`, sha256: sha256(bytes) }, bytes);
    }
    return access(join(root, 'packets', id)).then(() => true, () => false);
  };
  assert.equal(await upload(forged, forgedId), false, 'the forged packet is left staged, never committed');
  assert.equal(await upload(honest, honestId), true, 'the honest packet commits');
});

test('[RV-R8] reissueOf is a policy/2 manifest field: a policy/1 manifest that carries it fails, and a malformed one fails', async (t) => {
  const p1 = await mutant(t, await base(t, FIXTURE, { renderPolicy: 'render-policy/1' }), { manifest: (m) => { m.report.reissueOf = `sha256-${'0'.repeat(64)}`; } });
  const r1 = await verifyPacket(p1);
  assert.ok(r1.errors.some((e) => e.code === 'schema' && e.path === 'manifest.json#/report'), fmt(r1.errors));
  const p2 = await mutant(t, await base(t), { manifest: (m) => { m.report.reissueOf = 'sha256-nope'; } });
  await onlyFinding(p2, 'reissue-of', /reissueOf must be the content ID of another packet/);
});
