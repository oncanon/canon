// Source/report/render parity: every authored fact in the report JSON must appear
// in the browser-rendered HTML and in the CommonMark reading of report.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { FIXTURE } from '../helpers.mjs';
import { ENGINES, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());

const plain = (value) => (typeof value === 'string' ? value : value.map((s) => (typeof s === 'string' ? s : s.text ?? s.code ?? s.em ?? s.strong ?? s.link?.text ?? '')).join(''));
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Facts that must survive into both representations, derived from the source.
function facts(report) {
  const out = [];
  // Code and diff lines are compared verbatim (leading and internal spaces matter).
  const add = (kind, value) => out.push({ kind, text: kind === 'code-line' || kind === 'diff-line' ? value : squash(value) });
  add('title', report.title);
  for (const e of report.evidence) add('evidence-title', e.title);
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'finding') { add('finding-title', b.title); add('claim', plain(b.claim)); }
      if (b.type === 'decision') { add('decision', b.question); for (const a of b.alternatives) add('alternative', a.label); }
      if (b.type === 'risk') add('risk', b.title);
      if (b.type === 'table') for (const row of b.rows) for (const c of b.columns) add('table-cell', plain(row[c.key]));
      if (b.type === 'code') for (const line of b.source.split('\n').filter((l) => l.trim())) add('code-line', line);
      if (b.type === 'diff') for (const line of b.patch.split('\n').filter((l) => l.trim())) add('diff-line', line);
      if (b.type === 'chart') for (const p of b.series) { add('chart-label', p.label); add('chart-value', String(p.value)); }
      if (b.type === 'diagram') for (const st of b.steps) { add('diagram-step', st.label); add('diagram-detail', st.detail); }
      if (b.detail) walk(b.detail);
    }
  };
  for (const s of report.sections) { add('section', s.title); walk(s.blocks); }
  for (const s of report.appendices ?? []) walk(s.blocks);
  return out;
}

function markdownText(md) {
  const parts = [];
  const walker = new commonmark.Parser().parse(md).walker();
  let e;
  while ((e = walker.next())) {
    if (!e.entering) { if (['paragraph', 'heading', 'item', 'code_block'].includes(e.node.type)) parts.push('\n'); continue; }
    if (['text', 'code', 'code_block'].includes(e.node.type)) parts.push(e.node.literal);
    if (e.node.type === 'softbreak' || e.node.type === 'linebreak') parts.push(' ');
  }
  return parts.join('');
}

const results = [];
test.after(() => saveJson('e6-parity.json', results));

for (const engine of ENGINES) {
  test(`[E6] ${engine.name}: every report fact appears in rendered HTML and in report.md (source/report/render parity)`, async () => {
    const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const expected = facts(report);
    const md = await (await fetch(`${env.packetUrl}report.md`)).text();
    const mdText = squash(markdownText(md));
    const mdLines = markdownText(md).split('\n');
    const browser = await engine.type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(env.packetUrl);
      const htmlText = squash(await page.evaluate(() => document.body.innerText));
      const codeLines = await page.evaluate(() => [...document.querySelectorAll('.code pre')].flatMap((pre) => pre.innerText.split('\n')));
      const missing = [];
      for (const f of expected) {
        const verbatim = f.kind === 'code-line' || f.kind === 'diff-line';
        const inHtml = verbatim ? codeLines.includes(f.text) : htmlText.includes(f.text);
        const inMd = verbatim ? mdLines.includes(f.text) : mdText.includes(f.text);
        if (!inHtml || !inMd) missing.push({ ...f, inHtml, inMd });
      }
      results.push({ engine: engine.name, version: browser.version(), contentId: env.contentId, facts: expected.length, missing });
      assert.deepEqual(missing, [], `facts missing from a representation: ${JSON.stringify(missing.slice(0, 5))}`);
      assert.ok(expected.length > 60, `parity covers ${expected.length} facts`);
    } finally {
      await browser.close();
    }
  });
}

test('[E6] report.md is served immutably with the Markdown media type and the HTML advertises it', async () => {
  const res = await fetch(`${env.packetUrl}report.md`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const manifest = await (await fetch(`${env.packetUrl}manifest.json`)).json();
  const entry = manifest.files.find((f) => f.path === 'report.md');
  assert.equal(res.headers.get('etag'), `"${entry.sha256}"`);
  const html = await (await fetch(env.packetUrl)).text();
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="report\.md"/);
});
