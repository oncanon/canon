# doc/v1 spike: Install + Quick start as hand-written fixtures

Two pages hand-transcribed from `web/src/pages/guide/{install,quick-start}/index.astro`
(web-p1 worktree, commit `44f2f65`) into draft `doc/v1` JSON, reusing report/v1's
`paragraph`/`list`/`code`/`table` blocks and `Inline` grammar, plus a new
`{ "ref": { "page", "anchor"? } }` inline span (mirrors `link`'s shape — I added an
optional `text` field alongside `page`/`anchor` so the span carries its own display
text, the same way `link` carries `href` + `text` together). No validator or renderer
exists yet; this is content shape only. Files: `guide-install.doc.json`,
`guide-quick-start.doc.json`.

## What moved into the fixture

- `title`, `eyebrow`, `description` — were Astro props (`DocsLayout`'s `title`/
  `eyebrow`/`description`), now top-level doc/v1 fields.
- Every `<h2 id="…">` → a `sections[].id`/`.title`. Both pages are flat — no page
  actually nests an `<h3>` under an `<h2>`, so the "sections nest one level
  (h2/h3)" capability goes unexercised by this pair; I didn't fabricate a
  nested example to avoid mixing invented content with transcription.
- Every `<p>`, `<ul>`, `<pre><code>` → `paragraph`/`list`/`code` blocks,
  `<code>`/`<a>` inline spans → `code`/`link`/`ref` spans. Clean 1:1 mapping,
  no loss — this matches the "docs prose is already report/v1-shaped" finding
  from the earlier consultation.
- Internal links (`${BASE}guide/quick-start/`, `${BASE}schemas/`, `${BASE}cli/`)
  → `ref` spans. Install's trailing "Next: …" is a single linear link, so it
  became `nav.next`. Quick start's trailing line links to *two* unrelated
  pages (CLI reference, Schemas) with no ordering between them, so it became
  `seeAlso` instead — confirms `nav.next` (one, sequential) and `seeAlso`
  (many, non-sequential) are genuinely different shapes, not one field with
  two names.
- Provenance: source file path + worktree revision, with a note that no
  validator/renderer exists. No `metadata` block (status/classification/
  reviewDate/authors/reviewRequest) — that vocabulary is review-specific and
  doesn't fit a docs page; omitted rather than stubbed.

## What didn't fit / open questions

- Neither page's internal links target a specific in-page anchor — every
  real `${BASE}<page>/` link points at a whole page. So `ref.anchor` is
  speculative: the grammar supports it, but nothing in this corpus exercises
  it. Worth deliberately testing against a page that *does* deep-link
  (e.g. the CLI reference's per-group anchors) before calling the field done.
- `doc/v1` has no `metadata`/`verdict`/`evidence` (per the brief), which also
  means no closed-schema analogue for `reviewDate`/`authors` — fine for now,
  but if docs ever want a "last reviewed" or "author" byline, that's new
  surface, not reuse.
- Everything DocsLayout/BaseLayout render around the slotted content — site
  nav bar with active-tab state, hero/eyebrow band styling, footer (incl. the
  content-ID fingerprint), `<head>`/meta, fonts/CSS — stays Astro-owned.
  `doc/v1` only ever supplies the slotted body; it doesn't model the shell.

## GroupCard: stay Astro-only, no generic `component` block

The CLI reference page's `GroupCard` isn't hand-authored content — it's driven
by `cli-groups.generated.json`, itself generated from the CLI's own `--help`
usage text (`npm run check:cli` fails the build on drift), and rendered
through bespoke per-row logic: icon glyph paths, a highlight/last state, and a
hand-built argument-tokenizing/hanging-indent algorithm tuned to page05's
pixel spec. A generic `component` block would mean either (a) baking that
specific layout/tokenizer into doc/v1 — coupling a content schema to one
page's bespoke CSS — or (b) an open escape hatch that re-admits exactly the
kind of arbitrary markup `report/v1` already refuses (`html`/`style`/`class`/
`script`/`svg` all fail closed). Neither is right. If Canon ever wants to own
this content formally, the precedent is `chart`/`diagram`: a specific,
fully-specified block type with deterministic rendering rules — not a generic
component escape hatch. Out of scope for this spike.

## Integration shape: fragment approach (Canon seals HTML fragment + MD; Astro wraps byte-for-byte)

Reversing my earlier recommendation ("Astro renders HTML from doc/v1; Canon
seals only the MD") after actually writing these fixtures:

1. The two fixtures came out as plain nested block/Inline trees with **no
   page05-specific decisions in them** — no CSS, no layout, nothing Astro
   couldn't render identically from a sealed fragment. The chrome/content
   split is already clean (see above), so "Astro renders HTML from doc/v1"
   buys nothing an HTML-fragment approach doesn't also get for free.
2. "Astro renders HTML, Canon seals only MD" has a real gap I undersold last
   time: HTML and MD being built from the *same JSON source* only proves
   parity if the two renderers (Astro's JSX, Canon's `src/render/*.mjs`) stay
   in lockstep by convention — a parity *process*, not a parity *guarantee*.
   The fragment approach makes Canon the single renderer of record for both
   artifacts; Astro's job shrinks to template interpolation of an opaque,
   already-sealed string, which is mechanically byte-identical by
   construction, not by two implementations agreeing.
3. The cost this pays: Astro loses the ability to post-process fragment HTML
   per-component (no React-style hydration, no page05 CSS hooks reaching
   *inside* the fragment) — fine for prose pages like these two, since
   nothing here needs it; the CLI reference (GroupCard) is explicitly staying
   Astro-only anyway, so it's outside this contract either way.
4. Net: for prose pages, fragment-sealing is both simpler to verify and
   closer to what Canon already guarantees for packets (one sealed artifact,
   independently checksummed) than a shared-source convention across two
   renderers.

## Revised estimate

Still core-only, excludes Astro/CSS migration work:

- `doc/v1` schema + validator (closed schema, `Inline`+`ref`, one-level
  section nesting, `nav`/`seeAlso`, no verdict/evidence/metadata): **~1–1.5d**
  (unchanged — schema shape is confirmed by these two fixtures, no surprises).
- HTML-fragment + MD-twin renderer sharing `src/render/*.mjs`'s block/Inline
  logic, sealed together with one content ID (fragment is now a build output
  Canon owns, not a full-page render): **~1.5–2d** (was ~1d for "Canon emits
  MD only" — the fragment renderer and its own fixture/snapshot tests are new
  work, not a trim of the existing full-page HTML renderer).
- Site-level index/nav (`ref` resolution across pages, `nav.next`/`seeAlso`
  wiring, anchor-parity check extended to fragments): **~1–2d** (unchanged).
- Tests + CLI wiring (`canon build --doc`, fixtures/red-controls for the new
  block, `ref` resolution failures): **~1–1.5d** (slightly up from ~1d to
  cover `ref`-to-missing-page and `ref`-to-missing-anchor failure cases).

**~5–7 days** for a minimal sealed `doc/v1` with the fragment-integration
contract, before any Astro-side wiring to consume the fragment (that's Canon
Web's side). This is ~1 day more than the prior ~4–6d estimate — the fragment
renderer is genuinely new surface, not a swap of "who renders HTML."
