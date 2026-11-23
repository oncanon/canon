// doc/v1 rendering. Every case starts from a committed fixture (the converted spike
// pages) or a minimal inline doc object, renders through both the HTML fragment and
// its Markdown twin, and checks the one thing Canon guarantees they agree on.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { validateDocPage, DOC_SCHEMA } from '../../src/doc/validate.mjs';
import { renderDocHtml } from '../../src/doc/render-html.mjs';
import { renderDocMarkdown } from '../../src/doc/render-markdown.mjs';
import { REPO } from '../helpers.mjs';

const INSTALL_FIXTURE = join(REPO, 'fixtures/doc/guide-install.doc.json');
const QUICK_START_FIXTURE = join(REPO, 'fixtures/doc/guide-quick-start.doc.json');

let installText;
let quickStartText;
const install = () => JSON.parse(installText);
const quickStart = () => JSON.parse(quickStartText);

test.before(async () => {
  installText = await readFile(INSTALL_FIXTURE, 'utf8');
  quickStartText = await readFile(QUICK_START_FIXTURE, 'utf8');
});

const PATHS = { 'guide-install': '/guide/install/', 'guide-quick-start': '/guide/quick-start/', cli: '/cli/', schemas: '/schemas/' };
const refHref = (ref) => `${PATHS[ref.page] ?? `/${ref.page}/`}${ref.anchor ? `#${ref.anchor}` : ''}`;

function render(doc, pagePath) {
  validateDocPage(doc);
  return { html: renderDocHtml(doc, { refHref }), md: renderDocMarkdown(doc, { refHref, pagePath: pagePath ?? PATHS[doc.id] }) };
}

test('[DOC-V1] a section heading id is the page author\'s own slug, not a "sec-" prefixed one', () => {
  const { html, md } = render(install());
  assert.match(html, /<h2 id="requirements">Requirements<\/h2>/);
  assert.doesNotMatch(html, /id="sec-requirements"/);
  // Absolute (site-relative, this page's own path), not a bare "#id": llms-full.txt
  // concatenates every page's sealed Markdown into one document, where a bare fragment
  // would be ambiguous between any two pages that happen to share a section id (ids are
  // only unique within one page). See render-markdown.mjs's docAnchorDef.
  assert.match(md, /^\[requirements\]: \/guide\/install\/#requirements$/m);
});

test('[DOC-V1] a section id may start with a digit; report/v1\'s anchor rule would reject it', () => {
  const { html, md } = render(quickStart());
  assert.match(html, /<h2 id="1-write-a-report-v1-brief">/);
  assert.match(md, /^\[1-write-a-report-v1-brief\]: \/guide\/quick-start\/#1-write-a-report-v1-brief$/m);
});

test('[DOC-V1] an inline ref resolves through the caller\'s refHref in both artifacts', () => {
  const { html, md } = render(quickStart());
  assert.match(html, /<a class="ref" href="\/schemas\/">Schemas<\/a>/);
  assert.match(md, /\[Schemas\]\(\/schemas\/\)/);
});

test('[DOC-V1] nav.next renders as a "Next: ..." sentence in both artifacts', () => {
  const { html, md } = render(install());
  assert.match(html, /<p class="doc-next">Next: <a class="ref" href="\/guide\/quick-start\/">Quick start: your first Brief<\/a>\.<\/p>/);
  assert.match(md, /Next: \[Quick start: your first Brief\]\(\/guide\/quick-start\/\)\.\n\n/);
});

test('[DOC-V1] seeAlso renders every entry as a ref link in both artifacts', () => {
  const { html, md } = render(quickStart());
  assert.match(html, /<nav class="doc-see-also"[^>]*>[\s\S]*<li><a class="ref" href="\/cli\/">the complete CLI reference<\/a><\/li>[\s\S]*<\/nav>/);
  assert.match(md, /## See also\n\n- \[the complete CLI reference\]\(\/cli\/\)\n- \[the report\/v1 and site-input\/v1 schemas\]\(\/schemas\/\)/);
});

test('[DOC-V1] provenance renders a Sources section with its sources table and notes in both artifacts', () => {
  const { html, md } = render(install());
  assert.match(html, /<h2 id="provenance-h">Sources<\/h2>/);
  assert.match(html, /<th scope="row">Hand-transcribed from the Astro source<\/th><td>web\/src\/pages\/guide\/install\/index\.astro<\/td><td><code>44f2f65<\/code><\/td><td>—<\/td>/);
  assert.match(html, /DocsLayout\/BaseLayout chrome/);
  assert.match(md, /^## Sources$/m);
  assert.match(md, /^\[provenance\]: \/guide\/install\/#provenance$/m);
  assert.match(md, /- \*\*Hand-transcribed from the Astro source:\*\* web\/src\/pages\/guide\/install\/index\.astro; revision `44f2f65`/);
  assert.match(md, /DocsLayout\/BaseLayout chrome/);
});

test('[DOC-V1] a code block carries no id and no title: it is a plain snippet, not an evidence figure', () => {
  const { html, md } = render(install());
  assert.doesNotMatch(html, /id="code-/);
  assert.match(html, /<figure class="code">/);
  assert.match(md, /```shell\ngit clone/);
});

test('[DOC-V1] a table block keeps its own raw id (no "tbl-" prefix) as the element id in HTML', () => {
  const doc = {
    schema: DOC_SCHEMA,
    id: 'reference-page',
    title: 'Reference',
    description: 'A page with one table.',
    sections: [{
      id: 'limits',
      title: 'Limits',
      blocks: [{
        type: 'table',
        id: 'limits-table',
        caption: 'Known limits',
        columns: [{ key: 'name', label: 'Name' }, { key: 'value', label: 'Value', numeric: true }],
        rows: [{ name: 'Sections', value: '64' }],
      }],
    }],
  };
  const { html, md } = render(doc);
  assert.match(html, /<div class="table" id="limits-table">/);
  assert.doesNotMatch(html, /id="tbl-limits-table"/);
  assert.match(md, /\| Name \| Value \|\n\| --- \| ---: \|\n\| Sections \| 64 \|/);
});

test('[DOC-V1] rendering throws if the page has not been validated first (an invalid block type is unreachable)', () => {
  const doc = install();
  doc.sections[0].blocks[0] = { type: 'chart' };
  assert.throws(() => renderDocHtml(doc, { refHref }), /unreachable: validated block type chart/);
});
