// doc-set/v1: cross-page ref resolution and the build it gates. Every case starts from
// a doc set on disk (a committed fixture, or one written to a temp directory for the
// cases a committed fixture can't express without being broken on purpose) and goes
// through loadDocSet/buildDocSet exactly as the CLI will.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assembleDocSet, buildDocSet, DocSetError, loadDocSet } from '../../src/doc/docset.mjs';
import { REPO, tempDir } from '../helpers.mjs';

const MINIMAL_MANIFEST = join(REPO, 'fixtures/doc-set/minimal/manifest.doc-set.json');
const GUIDE_MANIFEST = join(REPO, 'fixtures/doc/guide.doc-set.json');

test('[DOCSET] a fully-resolving doc set loads with no errors and every ref resolves to the manifest\'s own path', async () => {
  const { pages, refHref } = await loadDocSet(MINIMAL_MANIFEST);
  assert.deepEqual([...pages.keys()], ['a', 'b']);
  assert.equal(refHref({ page: 'b', text: 'Page B' }), '/b/');
  assert.equal(refHref({ page: 'b', anchor: 'details', text: 'Page B' }), '/b/#details');
});

test('[DOCSET] the real Install + Quick start fixtures build cleanly once "cli" and "schemas" are declared external pages', async () => {
  const { pages, external, refHref } = await loadDocSet(GUIDE_MANIFEST);
  assert.deepEqual([...pages.keys()], ['guide-install', 'guide-quick-start']);
  assert.deepEqual([...external.keys()], ['cli', 'schemas']);
  assert.equal(refHref({ page: 'cli', text: 'CLI reference' }), '/cli/');
  assert.equal(refHref({ page: 'schemas', text: 'Schemas' }), '/schemas/');
});

test('[DOCSET] a ref to a page that is neither built nor declared external still fails the build', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }],
    external: [{ id: 'cli', path: '/cli/', anchors: [] }],
  }));
  await writeFile(join(dir, 'a.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'a', title: 'A', description: 'Page A.',
    sections: [{ id: 'intro', title: 'Intro', blocks: [{ type: 'paragraph', text: [{ ref: { page: 'ghost', text: 'Ghost' } }] }] }],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.equal(err.errors.length, 1);
      assert.equal(err.errors[0].code, 'unknown-page');
      assert.match(err.errors[0].message, /"ghost"/);
      return true;
    },
  );
});

test('[DOCSET] a ref to a declared external page resolves, but a ref to an anchor that page does not declare fails the build', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }],
    external: [{ id: 'cli', path: '/cli/', anchors: ['build', 'verify'] }],
  }));
  await writeFile(join(dir, 'a.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'a', title: 'A', description: 'Page A.',
    sections: [{
      id: 'intro', title: 'Intro', blocks: [{
        type: 'paragraph',
        text: [
          { ref: { page: 'cli', anchor: 'build', text: 'the build command' } },
          ' and ',
          { ref: { page: 'cli', anchor: 'sync', text: 'the sync command' } },
        ],
      }],
    }],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.equal(err.errors.length, 1);
      assert.equal(err.errors[0].code, 'unknown-anchor');
      assert.match(err.errors[0].message, /"sync".*"cli"/);
      return true;
    },
  );
});

test('[DOCSET] "external" shares its id/path namespace with "pages": claiming the same id or path in either list is a duplicate', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }],
    external: [{ id: 'a', path: '/elsewhere/', anchors: [] }, { id: 'b', path: '/a/', anchors: [] }],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.ok(err.errors.some((e) => e.code === 'duplicate-id'));
      assert.ok(err.errors.some((e) => e.code === 'duplicate-path'));
      return true;
    },
  );
});

test('[DOCSET] a ref to a real page but a made-up anchor fails the build, naming the anchor and the page', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }, { id: 'b', path: '/b/', source: 'b.doc.json' }],
  }));
  await writeFile(join(dir, 'a.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'a', title: 'A', description: 'Page A.',
    sections: [{ id: 'intro', title: 'Intro', blocks: [{ type: 'paragraph', text: [{ ref: { page: 'b', anchor: 'nope', text: 'B' } }] }] }],
  }));
  await writeFile(join(dir, 'b.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'b', title: 'B', description: 'Page B.',
    sections: [{ id: 'real', title: 'Real', blocks: [{ type: 'paragraph', text: 'Text.' }] }],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.equal(err.errors.length, 1);
      assert.equal(err.errors[0].code, 'unknown-anchor');
      assert.match(err.errors[0].message, /"nope".*"b"/);
      return true;
    },
  );
});

test('[DOCSET] a manifest entry whose file declares a different id fails the build before ref resolution runs', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [{ id: 'a', path: '/a/', source: 'a.doc.json' }],
  }));
  await writeFile(join(dir, 'a.doc.json'), JSON.stringify({
    schema: 'doc/v1', id: 'not-a', title: 'A', description: 'Page A.',
    sections: [{ id: 'intro', title: 'Intro', blocks: [{ type: 'paragraph', text: 'Text.' }] }],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.equal(err.errors[0].code, 'id-mismatch');
      return true;
    },
  );
});

test('[DOCSET] a manifest cannot claim the same page id or the same path twice', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [
      { id: 'a', path: '/a/', source: 'a.doc.json' },
      { id: 'a', path: '/a-again/', source: 'a.doc.json' },
      { id: 'c', path: '/a/', source: 'a.doc.json' },
    ],
  }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.ok(err.errors.some((e) => e.code === 'duplicate-id'));
      assert.ok(err.errors.some((e) => e.code === 'duplicate-path'));
      return true;
    },
  );
});

test('[DOCSET] a wrong-shaped manifest fails before any page is read', async (t) => {
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({ schema: 'doc-set/v2', pages: [] }));
  await assert.rejects(
    () => loadDocSet(join(dir, 'manifest.doc-set.json')),
    (err) => {
      assert.ok(err instanceof DocSetError);
      assert.ok(err.errors.some((e) => e.code === 'schema-version'));
      return true;
    },
  );
});

test('[DOCSET] buildDocSet writes each page\'s HTML fragment and Markdown twin at its manifest path, and a manifest.json Canon Web can publish as-is', async (t) => {
  const outDir = join(await tempDir(t, 'canon-docset'), 'out');
  const result = await buildDocSet({ manifestPath: MINIMAL_MANIFEST, outDir });
  assert.match(result.edition, /^sha256-[0-9a-f]{64}$/);
  assert.equal(result.edition, result.contentId);

  const html = await readFile(join(outDir, 'a/index.html'), 'utf8');
  assert.match(html, /<a class="ref" href="\/b\/#details">Page B&#39;s details<\/a>/);
  const md = await readFile(join(outDir, 'a/index.md'), 'utf8');
  assert.match(md, /\[Page B's details\]\(\/b\/#details\)/);

  const manifest = JSON.parse(await readFile(join(outDir, '.well-known/canon/manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'canon-doc-manifest/v1');
  assert.equal(manifest.edition, result.edition);
  assert.deepEqual(manifest.pages.map((p) => p.id), ['a', 'b']);
  assert.equal(manifest.pages[0].path, '/a/');
  assert.equal(manifest.pages[0].title, 'Page A');
  assert.equal(manifest.pages[0].description, 'The first page in a minimal, fully-resolving doc set.');
  assert.equal(manifest.pages[0].files.html, 'a/index.html');
  assert.match(manifest.pages[0].sha256.html, /^[0-9a-f]{64}$/);
});

test('[DOCSET] two pages that each declare the same local section id get distinct, page-qualified anchor definitions — unambiguous once their Markdown is joined, e.g. into llms-full.txt', async (t) => {
  // doc/v1 only claims a section id unique within its own page (src/doc/validate.mjs's
  // ctx.claimId is per-page), so two pages legitimately sharing an id, like "overview",
  // is not a build error. Canon Web is the one who concatenates every page's sealed
  // Markdown into llms-full.txt; this proves canon's own per-page output is already safe
  // for that join, without needing Canon Web itself to disambiguate anything.
  const dir = await tempDir(t, 'canon-docset');
  await writeFile(join(dir, 'manifest.doc-set.json'), JSON.stringify({
    schema: 'doc-set/v1',
    pages: [
      { id: 'one', path: '/one/', source: 'one.doc.json' },
      { id: 'two', path: '/two/', source: 'two.doc.json' },
    ],
  }));
  for (const id of ['one', 'two']) {
    await writeFile(join(dir, `${id}.doc.json`), JSON.stringify({
      schema: 'doc/v1', id, title: `Page ${id}`, description: `Page ${id}.`,
      sections: [{ id: 'overview', title: 'Overview', blocks: [{ type: 'paragraph', text: 'Shared section id, different page.' }] }],
    }));
  }

  const outDir = join(dir, 'out');
  await buildDocSet({ manifestPath: join(dir, 'manifest.doc-set.json'), outDir });
  const mdOne = await readFile(join(outDir, 'one/index.md'), 'utf8');
  const mdTwo = await readFile(join(outDir, 'two/index.md'), 'utf8');
  assert.match(mdOne, /^\[overview\]: \/one\/#overview$/m);
  assert.match(mdTwo, /^\[overview\]: \/two\/#overview$/m);

  // The actual claim: concatenated as llms-full.txt would, the second page's definition
  // does not shadow the first's (CommonMark honors only the first same-label reference
  // definition) — each resolves to its own page because the destinations differ.
  const joined = `${mdOne}\n${mdTwo}`;
  const defs = [...joined.matchAll(/^\[overview\]: (\S+)$/gm)];
  assert.equal(defs.length, 2);
  assert.notEqual(defs[0][1], defs[1][1]);
  assert.equal(defs[0][1], '/one/#overview');
  assert.equal(defs[1][1], '/two/#overview');
});

test('[DOCSET] the edition id is deterministic: the same doc set assembles to the same content id every time', async () => {
  const { pages, refHref } = await loadDocSet(MINIMAL_MANIFEST);
  const first = assembleDocSet({ pages, refHref });
  const second = assembleDocSet({ pages, refHref });
  assert.equal(first.edition, second.edition);
});
