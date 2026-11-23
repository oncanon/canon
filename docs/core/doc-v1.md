# `doc/v1`: Canon's docs content format

Status: implemented on `core/doc-v1`, local only (no publication, deployment, or
oncanon.com wiring performed from Canon Core)

## What it is

`doc/v1` is a closed-schema, single-page JSON content format for narrative docs pages
(guides, reference pages, how-tos) — the kind of content oncanon.com needs that is
neither a review packet (`report/v1`, which carries a verdict and evidence) nor a
multi-page review site (`site-input/v1`/`site-bundle/v1`). A `doc/v1` document has a
title, a description, one or more sections of prose/list/code/table blocks, and no
verdict and no evidence: a docs page makes no claim that needs proving, so it carries
none of report/v1's evidence-custody machinery.

It deliberately reuses report/v1's block grammar rather than inventing a second one:
`paragraph`, `list`, `code`, and `table` blocks, and the same Inline text grammar
(string-or-segments, with `text`/`code`/`em`/`strong`/`link` segments), are validated by
the same schema-neutral primitives in `src/report/validate.mjs` (`checkObject`,
`checkString`, `checkArray`, `parseBoundedJsonText`, …). The one addition is an inline
`ref` segment, in place of report/v1's `cite`: a doc page links to another doc page, it
never cites evidence.

```json
{
  "schema": "doc/v1",
  "id": "quick-start",
  "title": "Quick start",
  "description": "Build and verify your first packet.",
  "sections": [
    {
      "id": "install",
      "title": "Install",
      "blocks": [
        { "type": "paragraph", "text": [
          "See the ", { "ref": { "page": "install", "anchor": "cli", "text": "install guide" } }, " first."
        ] }
      ]
    }
  ],
  "nav": { "next": { "ref": { "page": "cli", "text": "CLI reference" } } },
  "seeAlso": [ { "ref": { "page": "schemas", "text": "Schema reference" } } ],
  "provenance": { "sources": [ { "label": "AGENTS.md", "reference": "docs/core/doc-v1.md" } ] }
}
```

A page id and a section id are both lowercase kebab-case (`SLUG_PATTERN`,
`src/doc/validate.mjs`) and become literal HTML `id` attributes: a section id doubles as
its heading anchor, a page id doubles as the thing another page's `ref` names. A `ref` is
`{page, anchor?, text}` everywhere it appears — inline, in `nav.next`, and in each
`seeAlso` entry — so it is validated and resolved identically in all three places.
`provenance` is deliberately never a valid `ref` target: it records where the page's
content came from, not a place in the page a reader can jump to.

Validating one page (`validateDocPage`) only checks that page is well-formed and
collects every `ref` it contains (`ctx.pageRefs`); it has no notion of "the other
pages." Schema: `src/doc/validate.mjs`.

## `doc-set/v1`: the build input that makes a set of pages a site

A single page doesn't know its own URL or whether the pages it links to exist.
`doc-set/v1` is a small manifest that supplies both:

```json
{
  "schema": "doc-set/v1",
  "pages": [
    { "id": "quick-start", "path": "/quick-start/", "source": "quick-start.doc.json" }
  ]
}
```

`id` must equal the referenced page's own top-level `id` (an `id-mismatch` build error
otherwise); `path` is the page's site URL path; `source` is a flat filename — no
subdirectories — resolved relative to the manifest's own directory. Loading a doc set
(`loadDocSet`, `src/doc/docset.mjs`) validates every page, then resolves every collected
`ref` against the whole set: a `ref.page` naming a page outside the set fails with
`unknown-page`; a `ref.anchor` not among the target page's claimed ids fails with
`unknown-anchor`. Every problem is reported, not just the first. A page or anchor that
doesn't exist fails the build instead of shipping a dead link.

Resolution also produces the `refHref(ref)` callback both renderers need to turn a `ref`
into a concrete href (`{path}` or `{path}#{anchor}`) — which is how `nav.next` and
`seeAlso` get wired to real URLs: they are ordinary `ref`s, resolved and rendered exactly
like an inline one.

### `external`: linking to pages Canon doesn't build

Not every page a doc/v1 page links to is a doc/v1 page. The CLI reference, for one,
stays Astro-only by design (its `GroupCard` is driven by generated CLI-help data with
bespoke layout, not prose `doc/v1` could represent without adding a markup escape hatch).
`doc-set/v1`'s `external` list is how a manifest declares pages like that are still
legal `ref` targets, without asking Canon to build or even read them:

```json
{
  "schema": "doc-set/v1",
  "pages": [ { "id": "quick-start", "path": "/quick-start/", "source": "quick-start.doc.json" } ],
  "external": [
    { "id": "cli", "path": "/cli/", "anchors": ["build", "verify", "serve"] }
  ]
}
```

`id` and `path` follow the same rules as a `pages` entry, and the two lists share one
namespace: the same `id` or `path` claimed twice, in either list, is a duplicate
(`duplicate-id`/`duplicate-path`), because both are "a thing a `ref` can name." `anchors`
is the full set of in-page ids a `ref` may target on that page — the role `ctx.ids`
plays for a doc/v1 page (every section id and table-block id it claims), supplied
instead of derived, because `src/doc/docset.mjs` never parses an external page's own
source. A `ref` naming an external page resolves like any other: `ref.page` not in
`pages` or `external` is `unknown-page`; `ref.anchor` not in that external entry's
`anchors` is `unknown-anchor`. `refHref` produces the same `{path}` /`{path}#{anchor}`
shape either way, so a renderer never needs to know whether a `ref` landed on a built
page or an external one.

**The mechanism deliberately stops at "a list of strings in the manifest."** Who
produces that list, and how, is Canon Web's responsibility, not Canon Core's — Canon
Core only validates and resolves against whatever `anchors` the manifest hands it. The
list must come from Canon Web's own build (the heading/anchor ids actually present in
that page's rendered HTML), never hand-typed into the manifest JSON: a hand-typed list
silently goes stale the moment the external page's headings change, which is exactly the
dead-link failure this whole mechanism exists to catch. A reasonable implementation on
Canon Web's side is a small build step that scans each external page's final rendered
HTML for `id="..."` attributes and writes the result into the `doc-set/v1` manifest it
hands to `build-docs` — the same way it already owns assembling `pages` with the right
`path` for each doc/v1 source file.

## Build output: sealed HTML + Markdown, and a published manifest

Building a doc set (`buildDocSet`) renders each page to a sealed HTML fragment
(`renderDocHtml`) and its byte-for-byte-paired Markdown twin (`renderDocMarkdown`) —
Astro (Canon Web) wraps the HTML fragment unchanged; HTML/MD parity for a page is a
Canon guarantee, not Canon Web's job to maintain. Output layout, under the manifest's
own `path` for each page:

```text
<path>/index.html
<path>/index.md
.well-known/canon/manifest.json   # canon-doc-manifest/v1
.well-known/canon/checksums.json  # same CHECKSUMS_SCHEMA every Canon build writes
```

`manifest.json` (schema `canon-doc-manifest/v1`) lists every page's `id`, `path`,
`title`, `description`, per-file paths, and per-file sha256 — everything Canon Web needs
to publish the manifest as-is at `/.well-known/canon/manifest.json`, render a footer line
from `edition`, and assemble `llms.txt`/`llms-full.txt` by walking the page list in
manifest order and concatenating each page's already-sealed Markdown. Canon Core does
not generate those two files itself; it guarantees the manifest and the per-page
Markdown are sufficient to generate them mechanically. `edition` is a `sha256-<hex>`
content hash of the manifest's own identity (everything but `edition` itself), so the
same doc set always reduces to the same edition with no database.

## Verification

`verifyDocSet` (`src/doc/verify.mjs`) is an independent verifier: it imports nothing from
`docset.mjs` or either renderer, and re-derives everything from the built output
directory alone — the manifest's identity reduces to its own `edition`, `checksums.json`
matches the on-disk manifest bytes, every file `checksums.json` lists matches its
recorded hash, and every file or symlink actually present is accounted for. Its scope is
narrower than `src/packet/verify.mjs` or `src/site/verify.mjs`: it checks integrity and
self-consistency only, and does not re-scan rendered HTML for injected markup, because
`doc/v1`'s schema has no raw-HTML escape hatch (`ESCAPE_HATCHES`, `src/report/validate.mjs`)
for that class of defect to enter through. This is a deliberate scope decision, flagged
here for Ivan/Canon: if HTML/MD parity or injection-class checks ever need the same depth
of scrutiny `site/verify.mjs` gives report/v1 and site-bundle/v1, that is additional work,
not a gap in what's shipped.

## CLI

```
canon build-docs <manifest.doc-set.json> --out <dir> [--receipt <file>]
canon verify-docs <bundle-dir> [--json]
```

Same shape as `build-site`/`verify-site`: `build-docs` writes a build receipt
(`makeReceipt`/`writeReceipt`) on success or failure and exits 1 on a `DocSetError`
(a bad manifest, an unresolved ref, a bad page); `verify-docs` prints `{ok, errors,
contentId}` as JSON with `--json` or a one-line human summary, exiting 0/1 on
`result.ok`.

## Integration brief for Canon Web

This is the contract Canon Web builds against. Everything below is already implemented
and tested on `core/doc-v1`; nothing here has been published or deployed.

### Commands

```
canon build-docs <manifest.doc-set.json> --out <dir> [--receipt <file>]
canon verify-docs <bundle-dir> [--json]
```

Run from the Canon repo root (or anywhere, with an absolute `<manifest.doc-set.json>`
path — `source` and `external[].anchors` are resolved relative to wherever the manifest
file itself lives, not the current directory). Exit 0 on success, 1 on a validation or
resolution failure, with the specific errors on stderr (or in the build receipt / in
`verify-docs --json`'s `errors` array). A worked example, run against this repo's real
Install + Quick start pages:

```
$ node src/cli.mjs build-docs fixtures/doc/guide.doc-set.json --out dist/doc-build-guide
{
  "contentId": "sha256-9480b2916b78a9761ad02c7f9df1b5d5b8c81d17b11489ba2d8edbb26edf2816",
  "outDir": ".../dist/doc-build-guide",
  "manifestSha256": "c668e03df8781f5fb27105f0cf8a4cd3917aa90a26e758f6105e6c4eba182f78",
  "fileCount": 6,
  "totalBytes": 15511,
  "receipt": ".../dist/doc-build-guide.build-receipt.json"
}
$ node src/cli.mjs verify-docs dist/doc-build-guide
OK sha256-9480b2916b78a9761ad02c7f9df1b5d5b8c81d17b11489ba2d8edbb26edf2816
```

### Input layout (what Canon Web hands to `build-docs`)

A `doc-set/v1` manifest, plus one `.doc.json` file per page it lists, as flat files
beside the manifest (no subdirectories — `source` is validated against a filename-only
pattern):

```text
<manifest-dir>/
  manifest.doc-set.json   # {schema: "doc-set/v1", pages: [...], external?: [...]}
  quick-start.doc.json    # one doc/v1 page per "pages" entry's "source"
  install.doc.json
```

Canon Web owns assembling this manifest: picking each page's `id`/`path`, listing
`external` pages (the CLI reference, search, anything Astro-only) with their current
anchor ids (see "`external`" above — generated from Canon Web's own rendered HTML, not
hand-typed), and supplying the `.doc.json` source files themselves (hand-authored, or
generated from whatever the docs are migrated from).

### Output layout (what `build-docs` hands back to Canon Web)

```text
<out-dir>/
  <page.path>/index.html        # one per page, e.g. guide/quick-start/index.html
  <page.path>/index.md          # its byte-paired Markdown twin
  .well-known/canon/manifest.json    # canon-doc-manifest/v1 — publish as-is
  .well-known/canon/checksums.json   # integrity record for verify-docs
```

### Wrapping the HTML fragment

`<page.path>/index.html` is a sealed fragment: the rendered content only, no
`<html>`/`<head>`/`<body>`, no site nav, no `DocsLayout`/`BaseLayout` chrome. Astro's job
is to read that file's bytes and interpolate them, unmodified, into the page shell —
`set:html` on the raw string, not through any Markdown/HTML re-processing step (no
rehype/remark pass, no sanitizer, no pretty-printer). Re-processing the fragment is
exactly what would break the HTML/MD parity guarantee: the fragment and
`<page.path>/index.md` are two renderings of the same source, produced by the same
Canon renderer, and that guarantee only holds if Astro treats the HTML as opaque,
already-finished output.

### Manifest and footer fields

`.well-known/canon/manifest.json` (schema `canon-doc-manifest/v1`):

```json
{
  "schema": "canon-doc-manifest/v1",
  "build": { "tool": "canon", "version": "<semver>" },
  "pages": [
    {
      "id": "guide-quick-start",
      "path": "/guide/quick-start/",
      "title": "Quick start",
      "description": "...",
      "files": { "html": "guide/quick-start/index.html", "markdown": "guide/quick-start/index.md" },
      "sha256": { "html": "<hex>", "markdown": "<hex>" }
    }
  ],
  "edition": "sha256-<hex>"
}
```

Publish this file as-is at `/.well-known/canon/manifest.json` — it is already the exact
shape to serve, no reshaping needed. For a footer line ("Edition `sha256-9480b291…`" or
similar), use `manifest.edition` directly: it is a deterministic content hash of
everything else in the manifest, so the same built doc set always produces the same
edition string with no database lookup. Do not use `checksums.json`'s `contentId` for
the footer — it is the same value, but `manifest.edition` is the field meant for
display; `checksums.json` is `verify-docs`'s input, not a UI source.

### Assembling `llms.txt` / `llms-full.txt`

Canon Core does not generate these two files; it guarantees the inputs are sufficient to
assemble them mechanically:

1. Read `manifest.json`. Its `pages` array is already in the manifest's own reading
   order — walk it in that order, don't re-sort.
2. For `llms.txt` (a compact index): one line or short block per page, using `title`,
   `description`, and `path` (the canonical URL) directly from each page's manifest
   entry. No file reads needed beyond the manifest itself.
3. For `llms-full.txt` (the full corpus): for each page in the same order, read
   `files.markdown` (relative to the output directory root) and concatenate its
   contents, optionally prefixed with a `# {title}` heading and the page's `path` as a
   permalink comment. The Markdown is already sealed — concatenate it unmodified, the
   same "treat as opaque, finished output" rule as the HTML fragment.

Both files are therefore a pure function of one built output directory; regenerating
them after a rebuild is "re-run the same walk," not "re-derive page content."

**Why concatenation is safe without rewriting anything.** A section/table/provenance
heading's CommonMark anchor — the `[id]: <dest>` link reference definition a page's
Markdown carries right after `## {title}`, the twin of the HTML fragment's
`<h2 id="{id}">` — always points to an absolute, site-relative destination: the page's
own `path` plus the fragment (`[requirements]: /guide/install/#requirements`), never a
bare `[requirements]: #requirements`. doc/v1 only guarantees an id is unique *within one
page* (`src/doc/validate.mjs` claims ids per page, not doc-set-wide), so two pages can
legitimately define the same id; CommonMark only honors the *first* same-label
definition it sees, so a bare fragment from an earlier page in the walk would silently
shadow a later page's own anchor once every page's Markdown lands in one `llms-full.txt`
document. Because every definition already carries its own page's path, concatenation
in manifest order needs no id-collision check, no rewriting, and no deduplication —
Canon Core guarantees this for every page a build produces, not just the two spike
fixtures.

### What Canon Web must supply, and when

- The `doc-set/v1` manifest itself (page list + `external` list), regenerated whenever
  the docs' page set, their paths, or an external page's anchors change.
- Each page's `.doc.json` source.
- The `external[].anchors` lists, generated from Canon Web's own rendered output (see
  "`external`" above) — this is the one piece of build-input data that depends on
  Canon Web having already built the non-doc/v1 pages a doc/v1 page may deep-link into.

## What's out of scope here

No Cloudflare, DNS, deploy, or oncanon.com publication work was performed or authorized
from Canon Core (Phase 1 boundary, `AGENTS.md`). The home page, 404, search, and the CLI
GroupCard stay Astro-only — they are not `doc/v1` pages, and this format does not attempt
to describe them.
