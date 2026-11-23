# Page-5 fidelity audit (pass 3, variance pass 4, hero pass 5, search pass 6, root move + SEO)

This pass answers the maintainer's review of pass 2 ("the designs have not been faithfully implemented"). Every value below was read from the design's own CSS (its inline styles, rendered in Chromium), not estimated from a screenshot.

## Sources

| Short name | What it is | Authority |
|---|---|---|
| **page05** | Identity & Surfaces export "Canon docs v2.1 — home and CLI reference" (a self-unpacking HTML bundle with its own fonts) | Layout, spacing, type, colour of every surface on the home page and the CLI section |
| **Plate 1 UI** | identity-v2 page01, "UI lockup, no rule" | The nav lockup |
| **Docs preview** | identity-v2 "In place · Docs" board | Names (Guide · CLI · Schemas · Canon.app), the nav lockup size |

## Evidence

Run from `web/` under Node 22.23.4:

```
npm run build                                        # exit 0
npm run screenshot -- --design <path>/page05.html    # exit 0
```

`npm run screenshot` is `scripts/screenshot.mjs` (Playwright, a devDependency). It does three things:
- It serves `dist/` on 127.0.0.1 itself.
- It captures every built page at 1280 and 390 in light and dark, at real viewports with DPR 1. The output goes to `web/.fidelity/shots/`.
- It renders page05 in Chromium with its own fonts and writes design | built composites at the same CSS-pixel scale. These go to `web/.fidelity/composite/`:
  - `home-1280-light.png`
  - `home-390-light.png`
  - `cli-1280-light.png`: page05's "02 · CLI surface" section beside `/docs/cli/`
  - `cli-390-light.png`

The run fails if a built page requests anything off 127.0.0.1. The last run printed: `8 pages × 2 widths × 2 schemes; no off-host requests`.

`web/.fidelity/` is gitignored. The screenshots are evidence, regenerated on demand, and this file is the committed record. No PNG from this audit is in the branch history: an index filter over `main..web/p1` took out every earlier commit of `web/docs/fidelity/`, and the branch was local and unpushed.

The run also fails if a built page hides text: either the page scrolls sideways, or an element with `overflow: hidden/clip` holds content wider than its box. Boxes that scroll on purpose (`overflow-x: auto`) are listed rather than failed. Last run: `8 pages × 2 widths × 2 schemes; no off-host requests; no clipped text`, with no scrolling box on `/docs/cli/`.

## The eight review items

| # | Item | Design value (CSS source) | Built value | Status |
|---|---|---|---|---|
| 1 | Section titles 01 and 03 sit left, right after the number | page05 head row: `display:flex; align-items:baseline; gap:18px; border-top:2px solid #0f172a; padding-top:14px`. Only the 02 head, which carries the exit pills, adds `justify-content:space-between; gap:12px; padding-bottom:8px` | `SectionHead.astro`: the base row is exactly the first rule. The split variant is applied only when there is slot content (the exit pills). Cause: the old `.section__head--solo` inherited `space-between` | **fixed** |
| 2 | Nav links centred as in page05, names from identity-v2 | page05 nav row: `display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px 28px; padding:10px 20px; border-bottom:1px solid #293548`. Links: `gap:2px 24px; 14px/500; padding:12px 0`. Search: `220×36` | Same values in `Nav.astro`. The links no longer take `flex:1` and search no longer takes `margin-left:auto`, so the links sit centred between brand and search. Names: Guide · CLI · Schemas · Canon.app | **fixed** |
| 3 | Eyebrow blue sans semibold | page05 hero eyebrow: `font-size:14px; font-weight:600; color:#93c5fd`, in the UI sans | `.hero__eyebrow`: 14px / 600 / `#93c5fd`, Inter (inherited from body, see pass 4) | **fixed** |
| 4a | Hero headline (was: rule under the lockup) | page05 h1: "Sealed editions for agent work." on two lines ("Sealed editions" / "for agent work."); Libron 700; `font-size:clamp(2.8rem, 6.4vw, 5.25rem)` (81.92px at 1280); `line-height:0.98`; `letter-spacing:-0.02em` | the maintainer chose page05's hero over the identity-v2 display lockup (2026-11-18), then decided the serif question the same day: **keep Libron, and keep page05's two-line composition by scaling the headline, not by widening the column.** The whole clamp is scaled by 77/84: `clamp(2.5667rem, 5.8667vw, 4.8125rem)` (max 77px; 75.09px at 1280). Line-height 0.98 and letter-spacing −0.02em stay as ratios. `text-wrap: balance` picks the even break where the stacked hero is narrow. Measured lines, see "Hero headline wraps" in pass 5 | **fixed** |
| 4b | Hero vertical rhythm, size, and terminal centred | page05 hero: band `#1b2434` with border-bottom `#293548`; row `padding:72px 20px 64px; flex-wrap:wrap; gap:44px`; copy `flex:1 1 480px; gap:20px`; terminal `flex:1 1 500px`. Measured band height at 1280: **542px**. page05's own `align-items` is `flex-end` | Same padding, gap and flex bases. The pass-3 `min-height:541px` floor is removed: page05's own content sets the height. Measured band at 1280: **527px** against 542 (the scaled headline is 2 × 73.6px lines against the plate's 2 × 80.3px). At 390: **863px** against 829 (the terminal's blank line before `exit 0` is +22px; the rest is the Libron headline and pitch). The terminal uses `align-items:center`, as the maintainer asked; this overrides page05's `flex-end` | **fixed** (−15px at 1280, from the scale) |
| 4c | Hero paragraph verbatim | page05: "Canon compiles structured JSON and bundled evidence into an immutable pair: a calm HTML publication for people and a byte-verified Markdown file for agents — fingerprinted, content-addressed, re-hashed on every read." 1.1875rem / 1.6, `#e2e8f0`, `max-width:54ch` | Same string (one constant, `PITCH`, also the page's meta description), same size, colour and measure. cmp: no difference | **fixed** |
| 5 | Every section margin from the CSS | page05 sections: `padding:56px 20px 0; display:flex; flex-direction:column`. Gaps: 01 → 18px, 02 → 6px, 03 → 12px. The last section ends with `padding-bottom:72px`. The Plate's ID pill hangs inside the plate's `padding:40px 36px 56px`, and the figcaption sits inside the figure (`gap:12px`) | `.sec { padding-top:56px }` with the same per-section gaps and a 72px bottom on 03. The plate padding and figcaption are as in the design. Cause: the old sections had 56px top *and* bottom (112px between sections), plus a 52px figcaption margin | **fixed** |
| 6 | Logo is real outlined SVG from the bundled Libron | Identity rule 02: "The logo is artwork, never typed text. Ship the SVG lockups." Layout from Plate 1 A (symbol 86, gap 20, word 84, letter-spacing −0.01em, line-height 0.9) and Plate 1 UI (35 / 8 / 34) | `scripts/brand/measure-lockup.mjs` lays out the identity CSS in Chromium with the bundled `Libron-Bold.woff2` and records the baseline and each glyph's x. `scripts/brand/outline-lockup.py` (fonttools `SVGPathPen`) draws those glyphs as paths. Output: `src/components/brand/svg/lockup-{display,ui}-{paper,chrome}.svg`, with no `<text>`, no font dependency and `role="img" aria-label="Canon"`. A pixel diff against the CSS render differs only in edge antialiasing | **fixed** |
| 7 | Footer: keep the layout, replace only the false parts | page05 footer: `background:#0f172a; color:#9ca3af`; row `padding:28px 20px; flex-wrap:wrap; gap:14px 28px; align-items:center; 13px`; fingerprint 44px; text `flex:1 1 300px`; mono 700 `#93c5fd` ID on the right | Same layout and values. See the table below for exactly what changed | **fixed** |
| 8 | Screenshot script committed | — | `web/scripts/screenshot.mjs`, `npm run screenshot`, Playwright `^1.65.1` in devDependencies. It replaces the uncommitted-dependency `capture-fidelity.mjs` and `capture-design-ref.mjs` | **fixed** |

### Footer: exactly what changed

| Part | page05 | Built | Why |
|---|---|---|---|
| Mark | Fingerprint, 44px | Fingerprint, 44px (was 32) | unchanged from design |
| Text | "These docs are a Canon edition, verified on every read." | "Canon is open source. These docs are a static site built from its repository: GitHub · License & open source" | False: the docs are an Astro build, and nothing re-verifies them on read. The standing brief drops this line |
| Right-hand ID | `sha256-0ce5d7a0` | `commit <sha7>`: the git commit the site was built from (`CF_PAGES_COMMIT_SHA` → `GITHUB_SHA` → `git rev-parse --short=7 HEAD`) | The digest was made up. A real commit ID keeps the design's mono ID slot, and the "commit" label stops anyone reading it as a Canon content ID |
| Spacing above | — | The old `margin-top:4rem` is removed | page05 has none; section 03's 72px bottom padding supplies it |

## Other corrections found while comparing the composites

| Element | Design value (page05 CSS) | Built | Status |
|---|---|---|---|
| Line height | page05's root sets none, so `normal` applies | `line-height:normal` scoped to `.p05`, the nav, the footer and the CLI rows (the docs body keeps its 1.6) | fixed |
| Container | `max-width:82rem; padding:0 20px` | `.u-container { width:min(calc(82rem - 40px), calc(100% - 40px)) }` | fixed |
| CLI rows (2.1–2.6) | `gap:8px 24px; padding:18px 0`; number `flex:0 0 52px` 22px; label `flex:1 1 220px; gap:12px`; title 17/600; summary 13; body `flex:2 1 420px; overflow-x:auto; white-space:nowrap`, 13px / 1.85; arguments muted | Same. The arguments split out muted after the subcommand. Routes (starting with `/`) are not split | fixed |
| CLI rows at 390 | No media query; the row wraps (number + label, then code that scrolls sideways) | The invented ≤760px stacking override is removed, so the rows wrap as in page05 | fixed |
| Long usage lines | page05: `overflow-x:auto; white-space:nowrap`. Its own lines are short, so nothing scrolls at 1280 | **Deviation:** lines wrap at argument boundaries with a hanging indent, in the same 13px mono at line-height 1.85. The command words keep their own column, and continuation lines start under the first argument. A unit is one argument: a `[...]` or `<...>` group, or a flag with its value (`--targets <file>`); a lone `·` stays with the token before it. When fewer than 28ch remain beside the command (phones), the arguments drop to the next line, indented 2ch. Only a group wider than the whole column breaks inside, and only at its spaces: on phones that is `[--expect-tailscale-address <ipv4> --expect-tailscale-name <dns-name>]`. Checked in Chromium on `/docs/cli/` (160 words) and `/docs/` (70 words) at 1280, 390 and 360: no word crosses its column edge, and no page scrolls sideways. At 1280 no line on the home page wraps, as in page05 | fixed |
| Nav at 390 | No media query; the row wraps to brand / links / search (148px tall) | The invented "Menu" drawer is removed and the row wraps the same way (141px tall) | fixed |
| Exit pills | 12px, `padding:3px 8px`, radius 3.5px, success / failure / neutral palettes | `ExitCodes.astro` with the `proven` / `defect` / `sev-low` tokens, which equal those light values | fixed |
| Plate leaves | head 48px; heading `0 18px`, 64px; agent leaf `## ` muted; the connector dot is the accent colour | same | fixed |
| Routes table | 14.5px; th `8px 16px`, td `12px 16px` (0 at outer edges); pills `2px 7px` (no-store), `3px 7px` `#fff` on `#0f172a` (immutable) | same | fixed |
| Buttons | 44px tall, `padding:0 18px`, radius 6.4px | same | fixed |

## Deliberate deviations and inventions (for the maintainer's review)

1. **Hero is page05's, by the maintainer's choice (2026-11-18).** Eyebrow, serif headline, paragraph and both buttons ("Write your first Brief" stays page05 blue) are page05's own. The identity-v2 display lockup and pitch are no longer used on the home page. The nav keeps the UI lockup.
2. **Terminal centred** (`align-items:center`), as the maintainer asked. page05's CSS says `flex-end`.
3. **Blank line before `exit 0`.** page05's *source* has `\n\n` between the `serving` line and `exit 0`. Its exported *render* drops that whitespace-only text node (checked in the plate DOM: `textContent` ends `…/alias-promotion/exit 0`), so the plate shows `exit 0` glued to the URL at x=1058. The build follows the source; `0` keeps its #a7f3d0 700 style.
4. *(removed: the hero min-height floor is gone; see 4b.)*
5. **Nav names** follow identity-v2 (Schemas for Formats; no Routes link). Routes & caching stays as section 03.
6. **The nav lockup is 22px.** That is the docs-preview size; Plate 1 UI is drawn at 34px.
7. **The "See the complete, CLI-checked reference →" link is removed.** It was my own invention in pass 2 and is not in page05. The "CLI reference" hero button covers it.
8. **`/cli/` page** (no design exists): page05's 02 section with "CLI reference" as the h1, the exit pills, a 15px muted lede, the rows with full real usage lines, and a closing "2.5 · Remote targets are gated" head with a note that absorbs the exit-1 meaning.
9. **Footer text and commit ID**, as in the footer table above.
10. **Dark mode** comes from the token system; page05 shows light content only.
11. **Guide, Install, Quick start, Schemas, Canon.app, Open source & license** have no design. They are built from the same tokens and the same section head.

## Known differences that remain

- **Hero headline is 77px max, not page05's 84px** (the maintainer's call, see 4a). page05's export never loaded Libron; its render used the narrower Iowan Old Style fallback. At page05's own size Libron needed three lines. Band at 1280: 527px vs 542.
- **Hero headline at 320px wraps to three lines** ("Sealed" / "editions for" / "agent work."). At the 41px clamp minimum "Sealed editions" is ~309px against a 280px column. 360px and up are two lines.
- **Hero at 390**: 863px against page05's 829px. +22px is the blank line before `exit 0`.
- **`→` in UI text (the 2.6 summary "Mutable aliases → immutable editions.") is painted by the system sans.** The vendored Inter is page05's exact file, whose range has ↑ and ↓ but no →, so the plate falls back identically. Fixing it means either a wider Inter subset (no longer the plate's bytes) or setting that arrow in mono. All mono and serif arrows now use bundled fonts (pass 5).
- **JetBrains Mono's `-<` ligature** draws `/p/sha256-<hex>/` with a joined stroke. page05 shows the same ligature, so the build matches the plate. If the literal characters matter more in a route, `font-variant-ligatures: none` on code turns it off.
- **Install page agent-skill command reads `npx skills@latest add OWNER/canon`**, copied from the repo README, while the clone line uses `oncanon/canon`. It is a CLI/README fact for the CLI owner to settle, so it is left as is.
- **No 390 design exists.** The 390 composites compare against page05's own CSS reflowing at that width, which is the only design evidence there is.
- **Real usage lines are longer** than page05's abbreviated ones. On `/docs/cli/` they wrap (see "Long usage lines"), so rows 2.4 and 2.5 are taller than any row in page05.
- **On the home page at 390**, the terminal and the routes table still scroll sideways inside their own boxes, as page05's do. The guide pages' code blocks do the same. None of these clips: the script lists them as scroll boxes.

## Variance pass 4 (plate vs live at 1280, computed styles)

Method: `styles.mjs` dumps every text element's computed style and box on the page05 export and on `/docs/`; `cmp.mjs` diffs them by text; `fonts.mjs` asks Chromium (CDP `CSS.getPlatformFontsForNode`) which font actually painted each node.

| Item | page05 | Before (6450902) | Now | Status |
|---|---|---|---|---|
| UI / body font | Inter, variable 400–700, latin subset | System stack (`.SF NS`); Inter not bundled | `public/fonts/inter/Inter-latin-wght.woff2`: byte-for-byte the woff2 embedded in the page05 export, with the same `unicode-range`. OFL 1.1 and provenance alongside. `--font-body: var(--sans)`; Pagefind's `--pagefind-ui-font` is set to it too. CDP reports **Inter (web)** for nav, eyebrow, buttons, captions, exit chips, table cells, footer and search | **fixed** |
| Nav / button / table geometry | Route col 487; Audience x=507 w=563 | 492; 512 / 556 (system font metrics) | 487; 507 / 563. Buttons 193 / 142 wide, as page05 | **fixed** (follows from Inter) |
| 2.5 "Remote targets" description | `color:#1e293b` (the gated group is deliberately darker) | `#475569` | `var(--ink-secondary)`: #1e293b light, #e2e8f0 dark. The other five stay `--muted` #475569 | **fixed** |
| Terminal | Blank line before `exit 0` in the source | none | added (see deviation 3) | **fixed** |
| Hero text | eyebrow, h1, paragraph, buttons | lockup + identity pitch | page05's own; cmp shows no font, size, weight, colour or letter-spacing difference on eyebrow, paragraph or buttons | **fixed** |

Remaining cmp differences, each explained:

| cmp line | Why it is not a defect |
|---|---|
| `"canon"` y16: Libron 21px → JetBrains Mono 13px, x 62 → 507 | The plate's nav wordmark is typed text; the build ships it as SVG artwork (identity rule 02), so cmp matches a terminal token instead |
| `"docs"` badge x 134 → 127 (−7) | Follows from the outlined UI lockup being 7px narrower than the plate's typed "canon" in the fallback serif |
| Guide 442 → 470, CLI 505 → 533, Canon.app 699 → 665 | Agreed nav names: four links (Schemas, no Routes) centred by `space-between` instead of five. Removing Routes (46 + 24 gap) and Schemas vs Formats (+8) plus the −7 brand width accounts for the shift |
| `CLI` colour #fff → #e2e8f0 | page05 marks CLI `aria-current` because its plate is home + CLI reference in one. On `/docs/cli/` the build gives CLI exactly #fff + `inset 0 -2px 0 #60a5fa`; on `/docs/` no link is current |
| Hero h1 height 161 → 241 | Pass 4 value (Libron at page05's size, 3 lines). Pass 5: 2 lines, 147px, by scaling to 77px max (see 4a) |
| Terminal font monospace → JetBrains Mono; height 185 → 229 | Mono stays JetBrains Mono, as agreed. Height = the blank line after `serving` (+22) and the plate's render dropping its line break before `exit` (+22) |
| `"exit"` x 1058 → 669 | The plate's render glues `exit 0` to the URL line (deviation 3) |
| Section titles wider (One source 442 → 461, Proposed flow, CLI surface, Routes & caching, Plate 1.) | Libron vs the plate's Iowan fallback. Serif left as is, by instruction |
| Command lines w 753 → 86–187; `<name>` x 686 → 772 | CLI tokens are split into spans (agreed). Probed directly, `canon alias list · get <name>` puts `<name>` at x=686 in both; cmp matched a different `<name>` token |
| `/a/<alias>/report.md`, `/a/<alias>.json` table rows | Key collision: on the build these strings first appear as split tokens in row 2.6. The table cells themselves match (487 wide, 12px 16px 12px 0 padding) |

Screenshot script after the fixes: `8 pages × 2 widths × 2 schemes; no off-host requests; no clipped text`.

## Hero pass 5 (the maintainer's serif decision, arrows, eye check)

**Headline.** `clamp(2.5667rem, 5.8667vw, 4.8125rem)` = page05's clamp × 77/84, with `text-wrap: balance`. Measured in Chromium (lines as rendered):

| Viewport | Size | Column | Lines | Band |
|---|---|---|---|---|
| 320 | 41.07px | 280 | Sealed / editions for / agent work. | |
| 360–600 | 41–44px | full | Sealed editions / for agent work. | 390: 863 |
| 768–1062 | 45–62px | stacked, ~984 max | one line | |
| 1064–1600 | 62.4–77px | 480–588 | Sealed editions / for agent work. | 1280: **527**; 1366, 1440: 530 |

"Sealed editions" is on one line at every width from 1024 to 1440. There is no single-word orphan at 390 (balance also fixed "work." alone at 600 and "Sealed editions for / agent work." at 430).

**Arrows.** Libron has no arrow glyphs, and the old JetBrains Mono files (Google's latin subset of v2.211) had none either, so every `→` fell back to a system font. The fix:
- `public/fonts/jetbrains-mono/JetBrainsMono-{400,700}.woff2` are rebuilt from the official JetBrains Mono **2.304** release TTFs with fonttools `pyftsubset`. They keep latin plus the whole Arrows block (U+2190–21FF), 262 glyphs. Provenance (URL, archive sha256, ranges, features) is in `SOURCE.txt`; the OFL licence file is unchanged.
- The `→` in the Schemas page's two h2s ("report/v1 → packet/v1", "site-input/v1 → site-bundle/v1") is set in mono (`u-mono`).
- CDP `getPlatformFontsForNode` now reports **JetBrains Mono (web)** for every terminal arrow. A sweep over all 8 pages finds no mono or serif arrow on a local font; only the Inter `→` above remains.

**Eye check (390 and dark, all 8 pages; 1280 dark).** Found and fixed:
- **Missing spaces before and after inline links and code** on 7 pages ("SeeInstall", "plus`manifest.json`", "so`report.md#f-F-1`", ~20 places). The cause is Astro 7.4's `compressHTML`, which drops whitespace that contains a newline between text and an inline element. It is now `compressHTML: false` in `astro.config.mjs`, with the reason commented. Home is pixel-identical before and after; the other pages change only where the spaces return. A scan of `dist/` finds 0 glued text/inline boundaries.
- **Pagefind's magnifier icon overlapped "Search docs"** at every width (its `::before` is placed for Pagefind's own pill padding). page05 has no icon, so it is hidden. (Superseded in the search pass: the Pagefind UI is gone.)
- **The nav's bottom rule stopped 20px short of each edge** (it sat on `.u-container`'s inset width). page05 puts it on a row with `max-width:82rem; padding:10px 20px`; the row now does the same, so the rule spans the bar.
- **Open source → Fonts said "Libron and JetBrains Mono"**; Inter has been vendored since pass 4. It now names all three.

Nothing else looked wrong in dark mode; the 390 sideways scroll boxes are the intentional ones listed above.

## Search (no plate; designed from page05 tokens)

The maintainer's review of f7f5c7d: the search looked weak, and after typing there was no way to move through results with ↑/↓. No plate designs search, so this is designed here from page05's own tokens. Everything in this section is **invented** and listed for the maintainer's review.

**Engine.** Pagefind's default UI (`pagefind-ui.js/.css`) is gone. `src/components/Search.astro` is a combobox on Pagefind's JS API: it lazy-loads `pagefind/pagefind.js` under the site base on first focus (`/pagefind/pagefind.js` since the root move), with `baseUrl` set to the base and `excerptLength: 24`. Every request stays on this host (Playwright: 0 off-host requests, 0 page errors).

**Panel.**
- **Placement.** Anchored 8px under the input, aligned to its right edge, 480px wide, `max-height: min(70vh, 560px)`, with internal scroll. The panel follows the page's light or dark scheme; the nav bar itself is always dark.
- **Frame.** A `--card` background, a 1px `--line` border and a 12px radius. The shadow is the plate's card shadow, `0 22px 48px rgba(15,23,42,.22)`; in dark mode the alpha goes up to `rgba(0,0,0,.5)` so the shadow still reads against `#0b0f17`.
- **Header.** A quiet header ("6 pages for “brief”") in Inter 12/600 `--muted` over a `--line-subtle` hairline.
- **Page rows.** Each page shows its title in Libron 700 17px, with the path in JetBrains Mono 11px on the right. At ≤600px the path moves under the title. The page-level excerpt is clamped to 2 lines.
- **Section rows.** The headings a query matched, up to 3 per page, are listed under their page and link to the heading anchor. Each row shows a mono `#` and the heading in Inter 13.5/600 `--ink-secondary`, then a 2-line excerpt. A 1px `--line` hairline on the left ties the rows to their page. Excerpts drop the leading copy of the heading the row already shows.
- **Matches.** Matched terms are set in ink at weight 600, with no marker colour; this replaces the yellow `#ff0`.
- **Active row.** The palette's selected style: an `--accent-wash` background, a 2px `--accent` bar on the left, and the title or heading in `--accent-ink`. Row radius is 3.5px.
- **Paging.** The top 8 pages are shown, then a quiet "Show N more pages" button.
- **Empty state.** "No results for “…”", plus "Try a command such as verify or alias, or a schema such as report/v1." (invented copy).
- **Hint row.** "↑ ↓ to move · ↵ to open · esc to close" on a `--surface-subtle` footer, with the keys in JetBrains Mono `kbd` chips. It is hidden on touch-only devices.
- **Phone (≤600px).** The panel spans the header width, 8px in from each edge, directly under the wrapped nav.
- **Input focus.** The input's focus ring is a `#60a5fa` border plus a 1px ring. page05 shows no focus state, so this is invented.

**Keyboard and ARIA.** The input is `role="combobox"` with `aria-controls`, `aria-expanded` and `aria-activedescendant`. The results are a `role="listbox"`, with one `role="group"` per page labelled by its title, and options carry `aria-selected`.
- `/` focuses search from anywhere outside a text field.
- Typing searches after a 120ms debounce.
- ↓ and ↑ move the active row and scroll it into view. They **wrap** at the ends, as DocSearch does; ↓ on the last row first loads the next batch if there is one.
- Enter opens the active row, or the first row if none is active. ⌘/Ctrl+Enter opens it in a new tab.
- The first Esc closes the panel and keeps focus in the input. A second Esc clears the query; a third returns focus to where `/` was pressed.
- Tab behaves normally: options are not tab stops, Tab moves to "Show more" when it's shown and then out, and the panel closes when focus leaves.
- Hovering with the mouse sets the active row.

**Index clean-up.**
- `data-pagefind-ignore` on the hero terminal (its "zsh / proposed output style" chrome was the excerpt junk the maintainer saw), the hero buttons, the Plate 1 artwork (the caption stays indexed), the routes-table header ("RouteAudienceCaching") and the docs eyebrow ("Guide.").
- The exit pills index as "0 Success", not "0Success": there is a space in the source, which the flex layout drops visually.
- Nav and footer were already outside `data-pagefind-body`.
- All 8 pages' indexed text was dumped from the fragments and checked: no glued words remain. Indexed words went from 690 to 646.

**Heading anchors.** Pagefind can only return section results for headings that have an `id`, and almost none did. Every h2 and h3 now has one:
- `src/lib/slug.ts`: lowercase ASCII words joined by `-`, apostrophes dropped.
- New `id` prop on `SectionHead` and `anchor` prop on `GroupCard`.
- Explicit ids on the docs pages' h2s.
- On home, `cli-surface` and `routes` moved from the `<section>` to its heading. Nothing linked to them.

The sticky nav is 62px tall on one row but 141px when it wraps at 390, so `--nav-h` (used by `scroll-padding-top`) is now set from the nav's real height with a ResizeObserver. A search jump lands 16px below the nav at 1280 and at 390.

**Rendering.** The 32 page screenshots (8 pages × 2 widths × 2 schemes) are pixel-identical to f7f5c7d, apart from 21 antialiasing pixels in one paragraph on quick-start at 390 light, which look identical by eye. CDP: titles render in Libron (web), paths and `kbd` in JetBrains Mono (web), and everything else in Inter (web).

## Root move + SEO

The maintainer's decision (2026-11-18 09:48 CT): the docs are the site, at the root of oncanon.com. Paths in the passes above that say `/docs/…` are historical; the same pages now live at `/…`.

**Root move.**
- `astro.config.mjs`: `base: "/"`, `site: "https://oncanon.com"`. Every hand-written href, the preloads, the favicon, the font URLs and the search bundle go through `BASE`, so none needed a separate change. `scripts/screenshot.mjs` serves `dist/` at the root and serves `404.html` for missing paths.
- `public/_redirects` (Cloudflare Pages): `/docs`, `/docs/` → `/` and `/docs/*` → `/:splat`, all 301. It does nothing until the site is deployed: locally `/docs/` is a 404.
- Built output: no `/docs` string anywhere in `dist/` except `_redirects`.

**SEO** (all in `BaseLayout.astro`, from `src/lib/site.ts`):
- A canonical URL on every indexable page, from `site` + path.
- `<title>` is "{page} · Canon"; home is "Canon — sealed editions for agent work". Every page has its own meta description.
- Open Graph (`og:type` article on docs pages, website on home) and Twitter `summary_large_image`, pointing at `/og/canon.png`.
- `/sitemap.xml` and `/robots.txt`. robots allows `*` and also names the main AI crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Google-Extended, Applebot-Extended, CCBot) with `Allow: /`, so the intent is explicit. It points at the sitemap.
- `public/_headers` serves the llms files as `text/plain; charset=utf-8` on Cloudflare.
- 404: `src/pages/404.astro` → `dist/404.html`, noindex, kept out of search and the sitemap.

**Invented for this pass (no plate; for the maintainer's review).** Superseded for the tile and the 404 title size; see "Plates pass" below.
- The social card, `public/og/canon.png` (1200×630, `npm run og`). It has the nav bar with the UI lockup SVG and `oncanon.com`, then page05's hero eyebrow and headline (Libron 700, lh .98, −0.02em, 104px), then one terminal line in page05's terminal palette ("verified sha256 · md parity · anchors 1:1 exit 0", taken from the hero's "proposed output style" terminal). It uses only vendored fonts and page05 hex values.
- The logo tile, `public/og/canon-tile-512.png` (Organization.logo). It was Plate 2's 128px tile values scaled ×4 and rendered at ×1, which moved the C by a subpixel (0.839% of pixels off). It is now Plate 2's own 128px markup rendered at device scale 4; see "Plates pass".
- The 404 page uses page05's hero band: #1b2434, the 14px #93c5fd eyebrow "404 · not found", the Libron title "This page isn't here." at page05's line-height and tracking, a smaller clamp (max 56px; now the home hero's size, see "Plates pass"), body copy in #e2e8f0, and three buttons (Guide primary, CLI reference and Home as ghosts). The band fills the viewport (404 page only).

**AEO/GEO.**
- JSON-LD on home: `Organization` (name, url, logo, `sameAs` the GitHub repo the footer already links) and `SoftwareApplication` (name, description, url, `applicationCategory` DeveloperApplication, `softwareRequirements` "Node.js 22 or newer", image, publisher).
- JSON-LD on every docs page: `TechArticle` (headline, description, url, inLanguage, image, `about` and `publisher` pointing at the home page's nodes) and `BreadcrumbList` (Canon › Guide › Install).
- Deliberately absent: rating, offers or price, version (package.json says 0.1.0, private), dates. The licence was undecided here; it is now Apache-2.0 and SoftwareApplication carries it (see "Plates pass"). That means home is not eligible for Google's software rich result, which requires offers plus rating or review.
- Validated with `scripts/check-jsonld.mjs` against the schema.org vocabulary file. It checks types, properties, domains, ranges and @id references. A negative test with four planted errors fails with all four.

**One-sentence answers.** Each page now opens with one plain sentence saying what the page is. On docs pages it is the lede, which is also the meta description. Copy changes:

| Page | Before | After |
|---|---|---|
| Home | — | Unchanged. page05's hero paragraph ("Canon compiles structured JSON…") is already the answer, and the maintainer chose that hero |
| Guide | Install Canon, then publish and read back your first sealed edition. | The Canon guide takes you from installing the CLI to building, verifying and serving your first sealed edition on your own machine. |
| Install | Canon is a Node.js CLI. No cloud account, no database, no build step for the runtime. | Canon runs as a Node.js 22+ command-line tool straight from its Git repository, with no cloud account, no database and no runtime dependencies. |
| Quick start | Build, verify, publish, alias and serve one report/v1 brief, end to end, on 127.0.0.1. | This quick start takes one report/v1 brief through build, verify, publish, alias and serve, end to end on 127.0.0.1. |
| Schemas | The two source schemas Canon accepts, and the two immutable schemas it produces. | Canon accepts two JSON source schemas, report/v1 and site-input/v1, and builds each into an immutable output, packet/v1 or site-bundle/v1; this page describes all four. |
| CLI (page05 section; the lede was already an addition) | Generated from `node src/cli.mjs`'s own usage text and checked against it on every build: … | This is every `canon` subcommand and its arguments, generated from `node src/cli.mjs`'s own usage text: `npm run check:cli` fails the build if the two disagree. … |
| Canon.app | A menu-bar app for the workstation server — status, aliases, and Tailscale, without the terminal. | Canon.app is a planned macOS menu-bar app that will show the local Canon server's status and aliases without the terminal; it is not built yet. |
| Open source | Canon is going public as an open-source utility. The license is not finalized yet. | Canon is going public as open-source software; this page says what is open, what comes later, and that the license is not decided yet. (Now: "Canon is open-source software under the Apache License 2.0; …", see "Plates pass".) |

No styles changed. Home is pixel-identical before and after at 1280 and 390, light and dark. On the other pages only the lede rows differ, plus the page height where the lede gained a line.

**Agent-facing.**
- `scripts/agent-text.mjs` runs in `npm run build` after `astro build` and writes `dist/sitemap.xml`, `dist/llms.txt` and `dist/llms-full.txt` from the built pages.
- `llms.txt` follows the llmstxt.org shape: an H1, a blockquote summary, then a "Docs" and an "Optional" section with one line per page (title, link, the page's one-sentence answer).
- `llms-full.txt` is every page's `<main>` as Markdown, in reading order, each page headed by its URL.
- The Markdown comes from a swappable *source*. Today that's `html`: `scripts/lib/html-to-md.mjs` converts `<main>`, honouring the same `data-pagefind-ignore` marks as search, except that table headers are kept. When Canon produces the per-page Markdown twins, they become a second source with the same signature (page in, Markdown out), selected with `--source`. No per-page `.md` files are built now, per the maintainer.
- Angle brackets in text are left raw ("/a/<alias>/") so the files read cleanly as plain text.

## Canon doc/v1 integration (Install, Quick start)

Install and Quick start are now Canon editions. Their source is `content/canon/` (doc-set/v1 plus two doc/v1 files). `canon build-docs` seals them, and Astro wraps each HTML fragment byte for byte, with no remark, rehype or sanitiser. Home, 404, search, CLI, Schemas, Guide, Canon.app and Open source stay Astro-only.

**Build** (`npm run build`, needs `CANON_CLI` until core/doc-v1 is on main):
1. `CANON_DOCS_STAGE=anchors astro build --outDir .canon/anchors-pass` is a first pass without the Canon pages' content.
2. `canon-docs.mjs input` fills each external page's `anchors` from the ids in its rendered `<main>` (/cli/, /schemas/). The committed doc-set must keep `anchors: []`, and a typed anchor fails the build.
3. `canon-docs.mjs build` runs `canon build-docs` → `.canon/docs/`, then `canon verify-docs`.
4. The real `astro build`. `src/layouts/CanonDocLayout.astro` puts the fragment inside `<div class="u-container canon-doc" data-canon-fragment="ID">`.
5. `canon-docs.mjs publish` serves `/.well-known/canon/manifest.json` and the sealed `index.md` twins, with `_headers` content types.
6. `agent-text.mjs --source canon` builds llms.txt and llms-full.txt from the manifest's order, titles and descriptions. The sealed Markdown goes in verbatim, and the other pages are converted from HTML as before.
7. Pagefind, with `--exclude-selectors .doc-eyebrow`. The fragment's eyebrow can't carry `data-pagefind-ignore`.
8. `canon-docs.mjs check` confirms:
   - each fragment sits verbatim in its built page, followed by `</div>`;
   - each served `.md` and the manifest equal Canon's;
   - the external anchors didn't drift between passes;
   - verify-docs passes.

**Edits to the doc/v1 input** (copied from Core's `fixtures/doc/`):
- `provenance` removed from both files. Its note was spike text.
- Quick start: `seeAlso` replaced with a closing "Next: …" paragraph that matches the Astro sentence, and the `--tailscale` ref given `anchor: "workstation-server"`.
- Quick start's sample `report.json` is now a complete, valid report/v1 brief (id, metadata, summary, one `unavailable` evidence item, one section, provenance). The old sample had a top-level `blocks` array, which isn't report/v1, and `canon build` rejected it. The new one builds and verifies with exit 0, and the guide's own publish and alias steps also exit 0 on it.

**Invented for this pass (for the maintainer's review):**
- The footer edition line: "edition sha256-XXXXXXXX · commit abc1234". The edition links to the manifest, and its title attribute shows the full edition.
- `src/styles/doc.css` maps Canon's fragment classes (`.doc-header`, `.doc-eyebrow`, `.doc-description`, sections) onto the existing docs styles. Canon's code-token classes (`t-*`) take the inherited colour, so code looks as it did before (uncoloured).

**Visual result against 44f2f65:**
- Same page heights at 1280 and 390, light and dark.
- Install differs only in the footer row.
- Quick start differs in the footer row, plus anti-aliasing at glyph edges in its code blocks: about 950 px, largest channel change 60/255, text identical. Canon wraps each code line in a `.ln` span and tokens in `t-*` spans, so Chromium rasterises the runs separately.

## Schemas page against the validators

The page's report/v1 and site-input/v1 sketches didn't match Core's validators (`src/report/validate.mjs`, `src/site/validate.mjs`).
- **report/v1:** the sketch had a top-level `blocks` array. The real shape requires `id`, `metadata`, `summary`, `sections` and `provenance`.
- **site-input/v1:** the sketch left out the required `decisions`, `evidence`, `gaps` and each item's `age`.

Each section now lists the members, required and optional, from the validator, and shows a complete example. The examples live in `content/examples/` and are imported raw, so the page shows the exact files that are tested. `scripts/check-examples.mjs` runs at the start of `npm run build`. It runs both examples, plus Quick start's sample, through the repository CLI (`build`+`verify` or `build-site`+`verify-site`) in a temp folder, and fails the build on any non-zero exit. Headings and their ids are unchanged, so the external `schemas` anchors are unchanged too.

Invented for this pass: the example content (a cache-review brief and a "Weekly status" site input, with made-up digests).

## Plates pass (social card, 404, logo tile; Apache-2.0)

Brief from the lead, 2026-11-18, relaying the maintainer ("I agree with all others"). Item 6 was open at that time and was not touched; the maintainer decided it later the same day (decision 6 below).

**Decisions recorded (no change made):**
1. The footer edition link stays.
2. The code-block styling stays.
3. Long code lines scroll sideways; they do not wrap.
4. The made-up Schemas examples stay. `check-examples.mjs` checks them on every build.

**Decision 6 (recorded later the same day, no change made):** the "Remote targets are gated" note in section 2.5 (Remote targets) of the /cli/ page stays as it is (the maintainer, 2026-11-18, relayed by the lead: "Sounds good, agree.").

**Licence: Apache-2.0.** Files on `web/p1` that state a licence:
- `src/pages/open-source/index.astro`: the description and the License section. "TBD" is gone. The section links the Apache License 2.0, gives SPDX `Apache-2.0` and points at the root `LICENSE`.
- `src/lib/site.ts`: `SITE.license` = `https://www.apache.org/licenses/LICENSE-2.0`.
- `src/lib/jsonld.ts` and `src/layouts/BaseLayout.astro`: `SoftwareApplication.license` on home (`check-jsonld` passes).
- `web/package.json` states no licence and is unchanged. The root `package.json` and the root `LICENSE` belong to the CLI. Both now state Apache-2.0 on main. They are not changed here.

**Plates.** The design-v2 exports are the authority. There is no design-v2 plate for a 404 page or a social card. Both derive from page05's hero, as the maintainer chose page05's hero on 2026-11-18. The logo tile derives from Identity Plate 2's 128px tile (no dot; the "no white grid" rule is for the fingerprint tile, which this tile is not).
- Tile: `scripts/og-image.mjs` renders Plate 2's 128px markup at device scale 4. Result: 0 pixels differ from the plate markup rendered with Libron. The plate export does not embed Libron, so its own render falls back to a system serif. The composite shows that render, the Libron reference, the built tile and the diff.
- 404: the title uses `--hero-title-size`, the home hero's size (75.09px at 1280, not 56px), with `text-wrap: balance`.
- Social card: unchanged and byte-identical to the previous render.

**`npm run fidelity:plates -- --identity <Identity.html> --surfaces <Identity & Surfaces.html>`** (`scripts/fidelity-plates.mjs`) needs `dist/`. It exits 1 on any failure and checks:
- that `public/og/*.png` equal a fresh render byte for byte;
- the tile pixel diff (limit: ≤0.5% of pixels off by >32/255, mean ≤1);
- the card's computed styles against the page05 hero (band, nav bar, eyebrow, h1, terminal frame and body);
- `dist/` served with Cloudflare Pages' static rules: an unknown path gives HTTP 404 with `dist/404.html`, and there are no off-host requests at 1280 and 390;
- the 404's computed styles against the page05 hero (band, row padding and gap, eyebrow, title, body, both buttons), and its title size against the home hero;
- that the page05 hero crop is not blank;
- `og:image` and `twitter:image` = `https://oncanon.com/og/canon.png` on every built page.

It writes `tile-sbs.png`, `card-sbs.png`, `404-sbs.png`, `404-1280.png` and `404-390.png` to `.fidelity/plates/`. Negative tests: a removed `twitter:image`, a changed eyebrow colour and the old tile gave 5 failures. A blank hero crop gave 1 failure.

**Invented or interpretive (for the maintainer's review):**
- The 404 and the card take page05's hero as their plate, because no plate draws them.
- `SoftwareApplication.license` in JSON-LD is new.
- The check serves `dist/` with its own Pages-rule server, because `astro preview` allows one instance and the maintainer's preview holds it. Cloudflare's real 404 handling is emulated, not observed.

## Tooling worth keeping beyond Canon

- `scripts/screenshot.mjs` captures every page × width × scheme against a self-served `dist/`, writes design | built composites, and fails on off-host requests or clipped text. It is general visual-regression evidence for any static site.
- A wrap probe (headline lines per viewport, via `Range.getClientRects` per character) and a font sweep (CDP `CSS.getPlatformFontsForNode` on every element with non-ASCII text, flagging local fallbacks) caught the 3-line headline and the arrow fallbacks. Both are small, site-agnostic Playwright scripts. They live in task scratch, not the repo; worth promoting if fidelity work continues.
- `scripts/brand/measure-lockup.mjs` + `outline-lockup.py` turn a CSS-laid-out wordmark into outlined SVG at exactly the browser's glyph positions (Chromium for layout, fonttools for paths). This works for any logo that is specified as CSS and a font.
- A Pagefind fragment dump (gunzip each `dist/pagefind/fragment/*.pf_fragment`, print the indexed text and anchors) shows exactly what search will excerpt. It caught the terminal chrome and the glued table and pill text, and works on any Pagefind site. It lives in task scratch.
- `scripts/lib/html-to-md.mjs` and `scripts/agent-text.mjs`: a dependency-free HTML → Markdown converter for generator output, plus an llms.txt / llms-full.txt / sitemap generator. The site-specific parts are one CONFIG block (page order, ignore and code-block rules, a tree transform), and the Markdown source is swappable.
- `src/lib/jsonld.ts`: pure schema.org builders (Organization, SoftwareApplication, TechArticle, BreadcrumbList, `graph()` with `<` escaping) with no Astro imports.
- `scripts/check-jsonld.mjs`: an offline JSON-LD validator for any built site against the schema.org vocabulary (types, properties, domain and range, cross-page @id references, BreadcrumbList positions).
- `scripts/canon-docs.mjs`: generates external anchors from a first-pass render, and checks byte for byte that a generator embeds sealed fragments unchanged. The pattern (pass 1 → scan ids → seal → pass 2 → prove embedding) suits any site that wraps externally produced HTML.
- `scripts/check-examples.mjs`: every code example a docs page shows is fed to the real tool on every build, so the examples can't drift from the validator. The pattern suits any docs site with schema examples.
- `scripts/fidelity-plates.mjs`: checks generated brand assets and a page against design plates exported as self-unpacking HTML. It renders plate markup verbatim, diffs pixels, compares computed styles, and emulates static-host 404 rules. The plate selectors are Canon-specific; the method is general.
