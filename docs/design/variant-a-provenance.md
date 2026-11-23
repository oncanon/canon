# Variant A provenance and derivation review (P15)

## Source and hash recheck

- **Prototype root (read-only reference):** a private prototype workspace (not published)
- **Worktree HEAD cited by the brief:** `48311d01a2a0be9a18911ad45a67f2f5639a6361`. The prototype tree is untracked, so this HEAD does not identify its bytes; only the file hashes below do.

Builder recheck at use time, 2026-09-25T02:49:51Z, with `shasum -a 256` run in the prototype root:

| Cited path | Cited SHA-256 | Observed | Result |
| --- | --- | --- | --- |
| `src/assets/editorial.css` | `08145485b118aa84aa673c6071e18dbf3a5c1f0a1746ca86ac419223debad930` | same | MATCH |
| `src/index.njk` | `93af715ad2e5ab83ac172d49bdd8d014769cfcc40859576f49c17a32a08787f2` | same | MATCH |
| `src/_includes/layouts/base.njk` | `005913a284de2839f11da623e4d29def4ce5b8974874f9ded1d7018d9b197ded` | same | MATCH |
| `_site-a/index.html` | `5c801eb7b2b632e0b68aa9206c5c0fc8ecf4c770d79e8f690a8efb6459ca361d` | **file does not exist** | **PATH MISMATCH** |

**Discrepancy, recorded as found and not corrected.** `_site-a/` contains only `assets/`, `code/` and `sources/`, with no `index.html`. The cited digest `5c801eb7…a361d` does match `_site/index.html`. The lead's independent recheck reported the same finding. The builder did not read or use `_site/index.html` or anything else under `_site*`, so this discrepancy has no effect on the derived bytes. It remains a spec-citation defect for the maintainer to resolve.

The proof script re-hashes all four cited paths and `_site/index.html` live on every run and records the result in the ledger, so the recheck is regenerated rather than transcribed.

### Prototype modified by another actor after the review

The prototype tree is untracked, and it changed after the builder's review. This builder only ever read those files, never wrote them. What was observed:

- The builder's review read of `editorial.css` finished at 2026-09-25T02:50:00.344Z.
- At **2026-09-25T02:52:07Z**, `src/assets/editorial.css`, plus the copies in `_site/`, `_site-a/` and `_site-b/assets/`, was rewritten. It is now 26,005 bytes with SHA-256 `696d2ecea6db7b2cedb118ca6db5bc3e956b69d2c28a43841a6b1b4f5a29ee4a`. The pinned version was 25,324 bytes, `08145485…d930`.
- At **2026-09-25T02:53:07Z**, `_site/index.html` was rewritten and now hashes to `d2706bace3c6c0ef0f48362a4d3a901dd0cb959da27a00d2d8232978ff501bd9`. The cited `5c801eb7…a361d` now matches no file in the tree.
- `src/index.njk` and `src/_includes/layouts/base.njk` are unchanged and still match their pins.

No copy of the pinned stylesheet bytes remains in the prototype. The bytes the builder actually reviewed are nevertheless provable. `scripts/reviewed-bytes.mjs` rebuilds them from the builder session transcript, which recorded the review read verbatim. It undoes the `NR: ` prefixes and `fold` wrapping, and the result hashes to exactly `08145485b118aa84aa673c6071e18dbf3a5c1f0a1746ca86ac419223debad930` (25,324 bytes). The script outputs digests only; no prototype bytes are written into this repository.

**Classification (maintainer decision 4, recorded at 2026-09-25T11:04Z):** the 02:52Z edit was made by the authorized publisher-design agent during the Context Analyst refinement. It is **expected authorized drift**, not tampering. The use-time pinned evidence is retained as the provenance of record. Nothing was re-hashed and replaced, and the prototype workspace was not modified.

### Further drift observed in fix cycle 2 (not classified by the builder)

At **2026-09-25T11:08:30Z**, `src/index.njk` was rewritten. It is now 3,228 bytes with SHA-256 `087bfcc503d301b66b31d32a8f8e5c8ce8efe008e5597c977c2cd390154493ff`; the pin was `93af715a…`, 3,134 bytes. That was after decision 4, so decision 4 does not cover it. The builder records it and has escalated it to the lead without classifying it.

The builder's review read of `index.njk` (`cat -n`, 2026-09-25T02:49:59Z) is also recoverable. `scripts/reviewed-bytes.mjs` rebuilds it from the transcript to exactly 3,134 bytes, `93af715ad2e5ab83ac172d49bdd8d014769cfcc40859576f49c17a32a08787f2`. Two cycle-1 observations fix the expected size and trailing newline independently: `ls` reported 3,134 bytes and `wc -l` counted 60 lines.

So the use-time recheck matched, and every derivation above comes from the pinned bytes. P15 in the ledger records both the live mismatch and this use-time evidence. The P15 copy check compares against the reviewed bytes, not the drifted live file.

## What was read

Only the three hash-matched source files were read, and only to review them:

- `editorial.css` (36 lines);
- `index.njk` (60 lines);
- `base.njk` (24 lines).

Nothing else in the prototype was read, executed, installed, or copied:

- scripts and client JS: `editorial.js`, `eleventy.config.js`, `scripts/`;
- other stylesheets: `historical-*.css`;
- other templates and data: `code.njk`, `history.njk`, `_data/`, `_includes/components/`, `content/`;
- packaging: `package*.json`, `node_modules/`;
- generated output: `_site*`.

## Licensing and provenance status

- **No license file** was found anywhere in the prototype tree. The check was `find . -iname 'LICENSE*' -not -path './node_modules/*'`, which returned nothing, matching the lead's observation.
- The prototype is internal exploration work in the maintainer's private prototype workspace, and the brief approves it as "design reference only".
- Because no license grants reuse of expression, this project copies **no prototype text or code**. It derives design *decisions*: palette values, scale relationships, and layout and component patterns. The stylesheet `src/presentation/variant-a.css` is newly written.
- Colour values are facts reused as tokens, and several were changed (see below).

## Derived (with source line)

`editorial.css` has long single-line rules, so derivations cite line numbers. Each item is marked `DERIVED` in a comment in `src/presentation/variant-a.css`.

| Derived element | Source | Notes |
| --- | --- | --- |
| Reset (box-sizing, margin reset, `max-width` on media) | `editorial.css:4` | Rewritten; `scroll-behavior:smooth` dropped. |
| Palette tokens: paper, ink, line, surface, accent, recommended, defect; code canvas/chrome/border/ink/highlight/add/remove | `editorial.css:7` | Values reused as design tokens. |
| Dark palette | `editorial.css:8-9` | Applied through `prefers-color-scheme` only. The script-driven `[data-theme]` toggle was rejected. |
| Font stacks (serif / sans / mono): system fonts only | `editorial.css:7` | `Inter` removed from the sans stack, because it would only be a local-font lookup; no webfonts are loaded. |
| Body scale, `:focus-visible` 3px accent outline, skip link, overline label style | `editorial.css:12` | Body clamp reduced from `1rem–1.125rem` to `.95rem–1.05rem` for density. |
| Masthead with brand mark; sticky contents rail with 44px link targets; document grid | `editorial.css:15, 19` | Rail width reduced, gap reduced. |
| Four confidence signals: proven, recommended, defect, open | `editorial.css:18`; `index.njk:25-33` | Kept as the confidence vocabulary and label colours, rendered as compact inline labels, not a hero legend grid. |
| Rule-over section heading (`border-top` + serif h2) | `editorial.css:22` | Border 5px→3px; size `2rem–3.5rem` → `1.2rem–1.6rem`. |
| Flow diagram steps with gate emphasis | `editorial.css:23`; `index.njk:37-42` | Kept for topology and sequence (the publish flow). Single-column at narrow widths, as in `editorial.css:30`. |
| Code frame: chrome figcaption, language label, focusable horizontal scroller, line gutter, highlighted/added/removed line styles | `editorial.css:25` | See changes below. |
| Compact contents drawer on narrow screens (`.toc` details, 44/52px targets) | `editorial.css:30` | Breakpoint moved to 1024px so iPad portrait gets the full-width reading column. |
| Print: paper palette, hide navigation, wrap code, avoid breaking figures, text labels for added/removed lines | `editorial.css:35` | Kept, and extended with printed external URLs and evidence paths. |
| Page semantics: `lang`, viewport, `color-scheme` meta, skip link to `#content`, `<main id="content">` | `base.njk:1-16` | Rewritten in `src/render/html.mjs`. |

## Changed for accessibility (WCAG 1.4.3, measured)

Light-mode text colours from the prototype were measured against paper and surface. These fell below 4.5:1:

| Token | Prototype | Measured contrast | Derived value |
| --- | --- | --- | --- |
| accent as text | `#d84f2a` | 3.57 | `--accent-ink: #a13816` (the accent stays for borders and focus rings) |
| muted | `#666960` | 4.41 on surface | `#5a5d55` |
| proven | `#237b70` | 4.00 on surface | `#1b6a60` |
| open | `#8b641d` | 4.21 on surface | `#75541a` |
| code-muted | `#716d63` | 4.45 on paper | `#5a5d55` |

The dark-mode comment token was brightened to `#b4b6ac` after axe-core found 3.97:1 on the dark highlighted-line background.

Labels below 0.68rem (the prototype used .52–.66rem) were raised to at least 0.68rem after the P11 browser check measured 9.92px text.

## Rejected, and why

| Prototype element | Source | Reason rejected |
| --- | --- | --- |
| Inline theme `<script>` reading `localStorage` | `base.njk:10` | Violates `script-src 'none'`; reading needs no script. The colour scheme follows `prefers-color-scheme`. |
| `editorial.js` (theme toggle, copy buttons) and `?v=` query cache-busting | `base.njk:9, 22` | No packet JavaScript (D6). Query-string versioning is the stale-cache failure class; assets are content-addressed instead. |
| Absolute `/assets/...` URLs | `base.njk:9, 22` | Break file:// and archive reading; packets use relative paths only. |
| `{{ content \| safe }}` and `{% canonicalDocument %}` markdown/HTML injection | `base.njk:16`; `index.njk:50` | Unescaped authored markup. `report/v1` has no raw HTML path; all text is escaped by construction. |
| Hero (h1 up to 6.8rem, `line-height:.88`, dek, kicker), premise number (7rem), closing block (7rem heading on inverted background) | `index.njk:5-23, 54-60`; `editorial.css:16-17, 19` | Brief: no oversized hero typography, decorative editorial whitespace, or gratuitous blocks. The title is bounded to 2.3rem. |
| Legend grid "Four signals. Zero ambiguity." | `index.njk:25-33`; `editorial.css:18` | Decorative scale; replaced by inline labels plus a collapsed "How to read the labels" disclosure. |
| Decorative `repeating-linear-gradient` worker fill; `box-shadow` on code frames | `editorial.css:23, 25` | Decoration without information. |
| `.prose > p strong:first-child` / `:has()` selector tricks that turn bold text into badges | `editorial.css:22` | Meaning must come from report structure (finding, decision, confidence), not from typographic accidents in prose. |
| `.prose > h1, .prose > p:first-of-type { display:none }` | `editorial.css:22` | Hides authored content. |
| Phone table-to-block reflow using `td::before { content: attr(data-label) }` | `editorial.css:31` | Loses table semantics in some screen readers. Tables scroll intentionally in a labelled, focusable region instead. |
| Shiki inline `style` colour output (`--shiki-light/dark`) | `editorial.css:25-27` | Needs `style-src 'unsafe-inline'`. The build-time highlighter emits class-only spans. |
| Code focus dimming via `:has(.is-focus)` + `filter` | `editorial.css:25` | Not needed by `report/v1`; the effect is visual only. |
| Copy button | `editorial.css:25` | Requires script. Plain text selection copies exactly the source (line numbers come from a CSS counter and are not copied), verified in Chromium and WebKit. |

## Statement

No file, directory, generated output (`_site*`), dependency (`node_modules`, `package*.json`), script, template, or content was copied from the prototype, recursively or otherwise.

The only inputs were the three hash-matched source files listed above, read for review. Every derived token and pattern was re-expressed in newly written code in `src/presentation/variant-a.css` and `src/render/html.mjs`, and each derivation is annotated with its source line.

The proof script checks this mechanically. It splits the three reviewed source files into CSS rules and template lines of 40 or more characters and requires that none appears verbatim in any tracked file of the candidate. Whitespace-normalized overlaps, such as a common `box-sizing` reset, are listed in the ledger for transparency. Two platform-standard HTML idioms are exempt from the gate: `<meta name="viewport" content="width=device-width, initial-scale=1">` and `<meta name="color-scheme" content="light dark">`. They were written independently and appear identically in any page, but they are still listed in the ledger as `allowlistedIdioms`. The exemption was added after the gate flagged exactly these two lines on candidate `684352d`. Running the proof script on that candidate reproduces the finding. A planted-copy control proves the detector works, and the result is recorded under P15.
