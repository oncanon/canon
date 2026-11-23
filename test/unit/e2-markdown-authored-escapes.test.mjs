// Regression for the authored-backslash bypass found during E2E integration:
// an authored backslash directly before "<" escaped the renderer's own escape and
// turned authored text into raw HTML or an autolink in report.md.
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { XSS_STRINGS } from '../corpus/cases.mjs';
import { REPO, tempDir } from '../helpers.mjs';

const BS = '\\';

// The five strings reported to the lead (each carries one authored backslash).
export const BACKSLASH_BYPASS = [
  `A ${BS}<script>alert(1)</script> B`,
  `C ${BS}<img src=x onerror=alert(1)> D`,
  `G ${BS}<svg onload=alert(1)> H`,
  `E ${BS}<!-- comment --> F`,
  `I ${BS}<https://auto.invalid> J`,
];

// Every hostile form, plain and with one or two authored backslashes in front of
// each "<", so parity of the renderer's escapes is exercised both ways.
const HOSTILE = [...new Set([
  ...BACKSLASH_BYPASS,
  ...XSS_STRINGS,
  ...XSS_STRINGS.map((s) => s.replaceAll('<', `${BS}<`)),
  ...XSS_STRINGS.map((s) => s.replaceAll('<', `${BS}${BS}<`)),
  `${BS}${BS}${BS}<b>odd run</b>`,
  `trailing backslash ${BS}`,
  `${BS}*not emphasis${BS}* and ${BS}[not a link${BS}](https://evil.invalid)`,
])];

// Contexts: each receives the hostile string. `structured` lists the only link
// destinations the report legitimately defines.
function inject(report, s) {
  report.subtitle = s;
  report.summary.paragraphs = [s, [s, { link: { text: s, href: 'https://example.com/ok' } }]];
  const findings = report.sections[0].blocks.filter((b) => b.type === 'finding');
  findings[0].title = s;
  findings[0].claim = s;
  const table = report.sections[1].blocks.find((b) => b.type === 'table');
  table.rows[0].role = s;
  table.caption = s;
  report.sections[1].blocks.find((b) => b.type === 'diagram').steps[0].detail = s;
  report.sections[2].blocks.find((b) => b.type === 'chart').series[0].label = s;
  const decision = report.sections[3].blocks.find((b) => b.type === 'decision');
  decision.alternatives[0].label = s;
  decision.alternatives[0].summary = s;
  report.appendices[0].blocks[0].items[0] = s;
  report.summary.metrics.items[0].label = s;
}

const STRUCTURED_LINKS = ['https://example.com/ok', 'https://www.w3.org/TR/CSP3/'];

async function renderWith(t, s) {
  const root = await tempDir(t, 'canon-e2-md');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  inject(report, s);
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(root, 'packet') });
  return { built, markdown: await readFile(join(built.outDir, 'report.md'), 'utf8') };
}

function nodes(markdown) {
  const out = [];
  const walker = new commonmark.Parser().parse(markdown).walker();
  let e;
  while ((e = walker.next())) if (e.entering) out.push(e.node);
  return out;
}

// Concatenated literal text of a paragraph (text, code and softbreak nodes).
function paragraphTexts(markdown) {
  const texts = [];
  const walker = new commonmark.Parser().parse(markdown).walker();
  let e;
  let current = null;
  while ((e = walker.next())) {
    const n = e.node;
    if (n.type === 'paragraph') {
      if (e.entering) current = '';
      else { texts.push(current); current = null; }
    } else if (current !== null && e.entering && (n.type === 'text' || n.type === 'code')) {
      current += n.literal;
    } else if (current !== null && e.entering && n.type === 'softbreak') {
      current += '\n';
    }
  }
  return texts;
}

test('[E2] the five reported backslash-bypass strings stay inert and literal in report.md', async (t) => {
  for (const s of BACKSLASH_BYPASS) {
    const { built, markdown } = await renderWith(t, s);
    const all = nodes(markdown);
    assert.deepEqual(all.filter((n) => n.type === 'html_inline' || n.type === 'html_block').map((n) => n.literal), [], s);
    assert.deepEqual([...new Set(all.filter((n) => n.type === 'link').map((n) => n.destination))].sort(), [...STRUCTURED_LINKS].sort(), s);
    assert.ok(paragraphTexts(markdown).includes(s), `authored text round-trips literally: ${s}`);
    const html = new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(markdown));
    assert.doesNotMatch(html, /<(?:script|img|svg)\b/i, s);
    assert.equal((await verifyPacket(built.outDir)).ok, true);
  }
});

test('[E2] generic: no authored text in any context yields html_inline, html_block, or autolink nodes', async (t) => {
  let checked = 0;
  for (const s of HOSTILE) {
    const { markdown } = await renderWith(t, s);
    const all = nodes(markdown);
    const raw = all.filter((n) => n.type === 'html_inline' || n.type === 'html_block');
    assert.deepEqual(raw.map((n) => n.literal), [], `raw HTML from authored ${JSON.stringify(s)}`);
    const destinations = [...new Set(all.filter((n) => n.type === 'link').map((n) => n.destination))].sort();
    assert.deepEqual(destinations, [...STRUCTURED_LINKS].sort(), `unexpected link/autolink from authored ${JSON.stringify(s)}`);
    // Plain prose round-trips exactly unless the renderer deliberately turned a
    // placeholder or entity spelling into a code span (literal either way).
    assert.ok(paragraphTexts(markdown).includes(s), `authored prose not literal: ${JSON.stringify(s)}`);
    checked += 1;
  }
  t.diagnostic(`hostile strings checked=${checked} contexts per string=12`);
});
