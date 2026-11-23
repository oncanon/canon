// report.md as the coequal agent artifact (agent-Markdown requirement items 1-5;
// docs/decisions/phase1-contract.md D10, D11). Gates run on the golden fixture and on
// the realistic prose corpus; the browser suite adds HTML parity and writes the
// evidence (escape inventory, anchor map, parity table, readability excerpt).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { setAlias } from '../../src/alias/alias.mjs';
import { canonicalBytes } from '../../src/canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../../src/hash.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { anchor } from '../../src/render/anchors.mjs';
import { anchorDefinition } from '../../src/render/markdown.mjs';
import { startServer } from '../../src/server/server.mjs';
import { anchorPandocProblems, anchorProblems, commonmarkOutline, escapeInventory, expectedAnchors, expectedOutline, pandocOutline } from '../agent-md-gates.mjs';
import { buildCorpusPacket, gateContext, strictMarkdownFor } from '../md-corpus.mjs';
import { findEscapes, proseLength } from '../md-escapes.mjs';
import { FIXTURE, REPO, sha256, tempDir } from '../helpers.mjs';

// Escape-density thresholds (escapes per 1,000 characters of rendered text), with
// the measurements they were set from (docs/decisions/phase1-contract.md D11):
//   golden fixture: 0 escapes            -> at most 1.0
//   realistic corpus: 2.96 (64 required, 7 conservative, 0 unjustified) -> at most 4.0
//   the same corpus with the fix3 strict serializer alone: see the corpus test,
//   which asserts it exceeds the corpus threshold, so the gate discriminates.
export const GOLDEN_MAX_PER_1000 = 1.0;
export const CORPUS_MAX_PER_1000 = 4.0;

let pandoc = null;
test.before(() => {
  const which = spawnSync('which', ['pandoc'], { encoding: 'utf8' });
  pandoc = which.status === 0 ? which.stdout.trim() : null;
});

async function golden(t) {
  const dir = await tempDir(t, 'canon-e8');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'packet') });
  const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
  return { dir, built, report, md: await readFile(join(built.outDir, 'report.md'), 'utf8'), html: await readFile(join(built.outDir, 'index.html'), 'utf8'), ctx: await gateContext(built.outDir) };
}

async function corpus(t) {
  const dir = await tempDir(t, 'canon-e8-corpus');
  const { built, report, markdown } = await buildCorpusPacket(dir);
  return { dir, built, report, md: markdown, html: await readFile(join(built.outDir, 'index.html'), 'utf8'), ctx: await gateContext(built.outDir) };
}

function assertStructure(name, { report, md, ctx }) {
  const exp = expectedOutline(report, ctx);
  const cm = commonmarkOutline(md);
  assert.deepEqual(cm.blocks, exp.blocks.filter((b) => b.t !== 'table'), `${name}: CommonMark blocks (headings, paragraphs, lists, fenced code with info strings) match the source`);
  assert.deepEqual(cm.marks, exp.marks, `${name}: CommonMark emphasis and strong nodes match the source`);
  if (!pandoc) return 'NOT_EXECUTED: pandoc absent';
  const pd = pandocOutline(md, pandoc);
  assert.deepEqual(pd.blocks, exp.blocks, `${name}: GFM blocks, including table rows, columns and cell text, match the source`);
  assert.deepEqual(pd.marks, exp.marks, `${name}: GFM emphasis and strong nodes match the source`);
  return { blocks: exp.blocks.length, tables: exp.blocks.filter((b) => b.t === 'table').length, codeBlocks: exp.blocks.filter((b) => b.t === 'code').length, marks: exp.marks.length };
}

test('[E8] item 1: golden report.md structure equals the report/v1 source under commonmark and pandoc gfm', async (t) => {
  const g = await golden(t);
  const r = assertStructure('golden', g);
  t.diagnostic(`structure-golden ${JSON.stringify(r)}`);
});

test('[E8] item 1: corpus report.md (authored em/strong/code/links, tables) structure equals its source', async (t) => {
  const c = await corpus(t);
  const r = assertStructure('corpus', c);
  t.diagnostic(`structure-corpus ${JSON.stringify(r)}`);
});

test('[E8] item 2: every summary, section, finding, decision, risk, figure and evidence block has one anchor, equal in HTML and report.md', async (t) => {
  for (const doc of [await golden(t), await corpus(t)]) {
    const expected = expectedAnchors(doc.report, doc.ctx, anchor);
    const { problems, definitions } = anchorProblems(doc.md, doc.html, expected);
    assert.deepEqual(problems, []);
    assert.equal(definitions.length, expected.length);
    for (const f of doc.report.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'finding')) assert.ok(definitions.some((d) => d.id === anchor.finding(f)), `finding ${f.id} anchored`);
    for (const e of doc.report.evidence) assert.ok(definitions.some((d) => d.id === anchor.evidenceItem(e.id)), `evidence ${e.id} anchored`);
    if (pandoc) assert.deepEqual(anchorPandocProblems(doc.md, pandoc), []);
  }
});

test('[E8] item 2: anchor ids are safe and unique under case folding; definition lines cannot be injected', async (t) => {
  for (const bad of ['x]: #evil', 'a b', '', '1a', 'a\n[x]: #y', 'ok#frag']) assert.throws(() => anchorDefinition(bad), /unsafe anchor id/, JSON.stringify(bad));
  assert.equal(anchorDefinition('f-F-1'), '[f-F-1]: #f-F-1');
  const dir = await tempDir(t, 'canon-e8-inject');
  const variant = async (name, mutate) => {
    await cp(join(REPO, 'fixtures/report'), join(dir, name), { recursive: true });
    const path = join(dir, name, 'phase1-review.report.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    mutate(report);
    await writeFile(path, JSON.stringify(report));
    return { path, report };
  };
  // Ids outside [A-Za-z][A-Za-z0-9-]* never reach a definition line.
  const unsafe = await variant('unsafe', (r) => { r.sections[0].blocks[0].id = 'F-1]: #evil'; });
  await assert.rejects(buildPacket({ reportPath: unsafe.path, outDir: join(dir, 'o1') }), (e) => e.errors?.some((x) => x.code === 'pattern'));
  // Ids differing only in case would share one reference label: refused.
  const folded = await variant('folded', (r) => { r.sections[0].blocks[1].id = r.sections[0].blocks[0].id.toLowerCase(); });
  await assert.rejects(buildPacket({ reportPath: folded.path, outDir: join(dir, 'o2') }), (e) => e.errors?.some((x) => x.code === 'duplicate-id' && /differs only in case/.test(x.message)));
  // Authored text shaped like a definition stays text: no new anchor, no link to it.
  const forged = await variant('forged', (r) => { r.summary.paragraphs.push('[f-F-1]: #evil', ['see ', { code: 'x' }, ' [F-1] and [f-f-1] and [ SUMMARY ]']); });
  const built = await buildPacket({ reportPath: forged.path, outDir: join(dir, 'o3') });
  const md = await readFile(join(built.outDir, 'report.md'), 'utf8');
  const html = await readFile(join(built.outDir, 'index.html'), 'utf8');
  assert.deepEqual(anchorProblems(md, html, expectedAnchors(forged.report, await gateContext(built.outDir), anchor)).problems, []);
  const w = new commonmark.Parser().parse(md).walker();
  let e;
  const links = [];
  while ((e = w.next())) if (e.entering && e.node.type === 'link') links.push(e.node.destination);
  assert.deepEqual(links.filter((d) => d.startsWith('#') || d === 'evil' || d === '#evil'), [], 'no authored text became a link to an anchor');
});

function assertEscapes(name, md, max) {
  const inv = escapeInventory(md, { pandoc });
  assert.deepEqual(inv.unjustified.map((x) => `${x.source} line ${x.line}: ${x.context}`), [], `${name}: every escape is required by the oracle or in a listed conservative class`);
  assert.ok(inv.per1000 <= max, `${name}: ${inv.per1000} escapes per 1,000 characters exceeds ${max}`);
  return inv;
}

test('[E8] item 5: golden escapes are all context-required and within the density threshold', async (t) => {
  const g = await golden(t);
  const inv = assertEscapes('golden', g.md, GOLDEN_MAX_PER_1000);
  t.diagnostic(`escapes-golden ${JSON.stringify({ ...inv, items: undefined, unjustified: inv.unjustified.length, threshold: GOLDEN_MAX_PER_1000 })}`);
});

test('[E8] item 5: corpus escapes are all context-required or conservative, within the threshold; the strict serializer alone is not', async (t) => {
  const c = await corpus(t);
  const inv = assertEscapes('corpus', c.md, CORPUS_MAX_PER_1000);
  const strict = await strictMarkdownFor(c.built.outDir, c.report);
  const strictPer1000 = Math.round((100000 * findEscapes(strict).length) / proseLength(strict)) / 100;
  assert.ok(strictPer1000 > CORPUS_MAX_PER_1000, `the gate discriminates: strict serialization measures ${strictPer1000} per 1,000`);
  t.diagnostic(`escapes-corpus ${JSON.stringify({ ...inv, items: undefined, unjustified: inv.unjustified.length, threshold: CORPUS_MAX_PER_1000, strictSerializerPer1000: strictPer1000, strictSerializerEscapes: findEscapes(strict).length })}`);
});

test('[E8] item 4: report.md is declared, checksummed, served as text/markdown byte-exact, and reachable by alias', async (t) => {
  const g = await golden(t);
  const manifest = JSON.parse(await readFile(join(g.built.outDir, 'manifest.json'), 'utf8'));
  const checksums = JSON.parse(await readFile(join(g.built.outDir, 'checksums.json'), 'utf8'));
  const bytes = await readFile(join(g.built.outDir, 'report.md'));
  assert.deepEqual(manifest.agentEntry, { path: 'report.md', anchors: 'reference-definitions/1' });
  const entry = manifest.files.find((f) => f.path === 'report.md');
  assert.deepEqual({ role: entry.role, mediaType: entry.mediaType, sha256: entry.sha256, bytes: entry.bytes }, { role: 'report', mediaType: 'text/markdown; charset=utf-8', sha256: sha256(bytes), bytes: bytes.length });
  assert.equal(JSON.stringify(checksums).includes(sha256(bytes)), true, 'checksums.json lists report.md');
  assert.match(g.html, /<link rel="alternate" type="text\/markdown" href="report\.md"/);
  assert.match(g.html, /<a href="report\.md" type="text\/markdown">/);
  const store = join(g.dir, 'store');
  await publishPacket({ packetDir: g.built.outDir, root: store });
  await setAlias({ root: store, name: 'agent-md', contentId: manifest.contentId, expectGeneration: 0 });
  const srv = await startServer({ root: store });
  t.after(() => srv.server.close());
  const immutable = await fetch(`${srv.url}/p/${manifest.contentId}/report.md`);
  assert.equal(immutable.status, 200);
  assert.equal(immutable.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(immutable.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await immutable.arrayBuffer()), bytes, 'byte-exact read-back');
  const alias = await fetch(`${srv.url}/a/agent-md/report.md`, { redirect: 'manual' });
  assert.equal(alias.status, 307);
  assert.equal(alias.headers.get('location'), `/p/${manifest.contentId}/report.md`);
  assert.equal(alias.headers.get('cache-control'), 'no-store');
  const followed = await fetch(`${srv.url}/a/agent-md/report.md`);
  assert.deepEqual(Buffer.from(await followed.arrayBuffer()), bytes, 'alias route reads back the same bytes');
  assert.equal((await fetch(`${srv.url}/a/agent-md/other.md`, { redirect: 'manual' })).status, 404, 'only report.md has an alias route');
  assert.equal((await fetch(`${srv.url}/a/Bad_Name/report.md`, { redirect: 'manual' })).status, 404);
  t.diagnostic(`identity ${JSON.stringify({ contentId: manifest.contentId, reportMdSha256: sha256(bytes), indexHtmlSha256: sha256(await readFile(join(g.built.outDir, 'index.html'))) })}`);
});

test('[E8] item 4: the verifier requires an exact agentEntry when present and still accepts older packets without it', async (t) => {
  const g = await golden(t);
  assert.equal((await verifyPacket(g.built.outDir)).ok, true);
  // An older packet: the same build with agentEntry left out of its identity, so its content
  // ID and checksums are those a builder from before agentEntry would have written.
  const olderDir = join(g.dir, 'older');
  await cp(g.built.outDir, olderDir, { recursive: true });
  const { contentId: _id, agentEntry: _entry, ...identity } = JSON.parse(await readFile(join(olderDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(_entry, { path: 'report.md', anchors: 'reference-definitions/1' }, 'the current build writes agentEntry');
  const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
  const manifestBytes = canonicalBytes({ ...identity, contentId });
  const checksums = JSON.parse(await readFile(join(olderDir, 'checksums.json'), 'utf8'));
  await writeFile(join(olderDir, 'manifest.json'), manifestBytes);
  await writeFile(join(olderDir, 'checksums.json'), canonicalBytes({ ...checksums, contentId, manifestSha256: sha256Hex(manifestBytes) }));
  const older = await verifyPacket(olderDir);
  assert.equal(older.ok, true, `a packet without agentEntry verifies: ${JSON.stringify(older.errors?.map((e) => e.code))}`);
  const path = join(g.built.outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.agentEntry = { path: 'index.html', anchors: 'reference-definitions/1' };
  await writeFile(path, JSON.stringify(manifest));
  const tampered = await verifyPacket(g.built.outDir);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.errors.some((f) => f.code === 'agent-entry'), JSON.stringify(tampered.errors.map((f) => f.code)));
});
