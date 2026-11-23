import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as commonmark from 'commonmark';
import { buildPacket } from '../../src/packet/build.mjs';
import { verifyPacket } from '../../src/packet/verify.mjs';
import { FIXTURE, REPO, tempDir } from '../helpers.mjs';

const REQUIRED = [
  '# Local immutable review packets: Phase 1 design review',
  'Representative fixture exercising every report/v1 component. Measurements and evidence files are illustrative fixture data, not claims about any real system.',
  '- Report ID: `phase1-local-packet-review`',
  '## Executive summary',
  '### Finding F-1:',
  'content-addressed packets with separate alias records.',
  '`assets/<sha256>.css`',
  'packets/`<content-id>`/; read back.',
  '**Claim.**',
  '**Evidence.** [E1]',
  '| Path | Role | Media type | Served cache policy | In content ID |',
  '| `aliases/<name>.json` | Mutable alias (outside packet) | application/json | no-store | No |',
  '```typescript',
  '### Diagram: Build, verify, publish, alias',
  '1. **report/v1 source**',
  '## Evidence',
  '## Provenance and packet verification',
];

function parsedNodes(markdown) {
  const reader = new commonmark.Parser();
  const nodes = [];
  const walker = reader.parse(markdown).walker();
  let event;
  while ((event = walker.next())) if (event.entering) nodes.push(event.node);
  return nodes;
}

test('[P17] report.md is clean, deterministic semantic packet content included in identity and checksums', async (t) => {
  const root = await tempDir(t, 'canon-p17');
  const a = await buildPacket({ reportPath: FIXTURE, outDir: join(root, 'a') });
  const b = await buildPacket({ reportPath: FIXTURE, outDir: join(root, 'b') });
  const markdownA = await readFile(join(root, 'a/report.md'), 'utf8');
  const markdownB = await readFile(join(root, 'b/report.md'), 'utf8');
  assert.equal(markdownA, markdownB);
  assert.equal(a.contentId, b.contentId);
  for (const expected of REQUIRED) assert.ok(markdownA.includes(expected), expected);
  assert.doesNotMatch(markdownA, /&(?:amp|lt|gt|quot|#39);/);
  assert.doesNotMatch(markdownA, /\\[.()!-]/, 'ordinary punctuation is not blanket escaped');
  const file = a.manifest.files.find((entry) => entry.path === 'report.md');
  assert.deepEqual({ role: file.role, mediaType: file.mediaType }, { role: 'report', mediaType: 'text/markdown; charset=utf-8' });
  assert.equal(a.checksums.files['report.md'], file.sha256);
  const html = await readFile(join(root, 'a/index.html'), 'utf8');
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="report\.md"/);
  assert.match(html, /<a href="report\.md" type="text\/markdown">agent-readable Markdown<\/a>/);
  assert.equal((await verifyPacket(join(root, 'a'))).ok, true);
});

test('[P17] context-aware Markdown keeps hostile authored strings inert under CommonMark', async (t) => {
  const root = await tempDir(t, 'canon-p17-hostile');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.subtitle = '# injected <script>alert(1)</script> [x](https://evil.invalid)';
  report.summary.paragraphs[0] = '| forged | table | <img src=x onerror=alert(1)> and <sha256>';
  report.summary.paragraphs[1] = [
    { code: 'a`b``c' },
    ' then ',
    { link: { text: 'safe [label]', href: 'https://example.com/a_(b)?x=1&y=2' } },
  ];
  const table = report.sections[1].blocks.find((block) => block.type === 'table');
  table.rows[0].role = 'literal | cell <svg onload=alert(1)> (plain)';
  const code = report.sections[1].blocks.find((block) => block.type === 'code');
  code.source = '```` hostile fence\n<script>inside code is inert</script>';
  delete code.highlight;
  await writeFile(path, JSON.stringify(report));
  const out = join(root, 'packet');
  await buildPacket({ reportPath: path, outDir: out });
  const markdown = await readFile(join(out, 'report.md'), 'utf8');

  // E2E fix2: a bare URL in authored text has its scheme colon written as &#58; so
  // GFM readers that scan raw source cannot autolink it (and swallow escapes).
  assert.ok(markdown.includes('\\# injected \\<script>alert(1)\\</script> \\[x\\](https&#58;//evil.invalid)'));
  assert.ok(markdown.includes('| forged | table | \\<img src=x onerror=alert(1)> and `<sha256>`'));
  assert.ok(markdown.includes('```a`b``c``` then [safe \\[label\\]](https://example.com/a_\\(b\\)?x=1&y=2)'));
  assert.ok(markdown.includes('literal \\| cell \\<svg onload=alert(1)> (plain)'));
  assert.ok(markdown.includes('`````typescript\n```` hostile fence\n<script>inside code is inert</script>\n`````'));
  assert.doesNotMatch(markdown, /&(?:amp|lt|gt|quot|#39);/);

  const nodes = parsedNodes(markdown);
  const rawHtml = nodes.filter((node) => node.type === 'html_inline' || node.type === 'html_block');
  assert.equal(rawHtml.some((node) => /script|img|svg|onload|onerror/i.test(node.literal)), false, 'authored strings never become executable/raw HTML nodes');
  const links = nodes.filter((node) => node.type === 'link');
  assert.equal(links.some((node) => node.destination === 'https://evil.invalid'), false, 'authored Markdown-like text does not become a link');
  assert.equal(links.some((node) => node.destination === 'https://example.com/a_(b)?x=1&y=2'), true, 'typed https link remains a link');
  assert.equal(nodes.filter((node) => node.type === 'code').some((node) => node.literal === 'a`b``c'), true);
  assert.equal(nodes.filter((node) => node.type === 'code_block').some((node) => node.literal.includes('<script>inside code is inert</script>')), true);
  assert.equal((await verifyPacket(out)).ok, true);
});

test('[P17] independent adversarial corpus produces only intended links and no authored raw HTML', async (t) => {
  const root = await tempDir(t, 'canon-p17-adversarial');
  const src = join(root, 'src');
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.subtitle = '<!--> <!---> <!-- ok --> <!----> <!-- foo -- bar -->';
  report.summary.paragraphs[0] = '<https://auto.invalid> <qa@example.invalid> <mailto:qa@example.invalid> <sha256> <content-id> <name> <id> <packet-directory> &amp; &#38; &#x26;';
  report.summary.paragraphs[1] = [
    'Authored <b>markup</b> and ',
    { link: { text: 'structured link', href: 'https://example.com/a_(b)?x=1&y=2' } },
  ];
  const code = report.sections[1].blocks.find((block) => block.type === 'code');
  code.source = '<!-- code-block contents are inert -->\n<a href="https://not-a-node.invalid">literal</a>';
  delete code.highlight;
  await writeFile(path, JSON.stringify(report));
  const out = join(root, 'packet');
  await buildPacket({ reportPath: path, outDir: out });
  const markdown = await readFile(join(out, 'report.md'), 'utf8');
  const nodes = parsedNodes(markdown);

  assert.equal(nodes.filter((node) => node.type === 'html_inline' || node.type === 'html_block').length, 0);
  const structuredDestinations = ['https://example.com/a_(b)?x=1&y=2', 'https://www.w3.org/TR/CSP3/'];
  assert.deepEqual(nodes.filter((node) => node.type === 'link').map((node) => node.destination), structuredDestinations);
  for (const token of ['<sha256>', '<content-id>', '<name>', '<id>', '<packet-directory>', '&amp;', '&#38;', '&#x26;']) {
    assert.ok(nodes.some((node) => node.type === 'code' && node.literal === token), token);
  }
  assert.ok(nodes.some((node) => node.type === 'code_block' && node.literal.includes('<a href="https://not-a-node.invalid">literal</a>')));
  assert.equal((await verifyPacket(out)).ok, true);
});
