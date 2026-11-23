# Canon.app P1 — design fidelity passes 3 to 13

> **Pass 13: the overlay follows the design plates; Settings follows native macOS.** The
> maintainer decided this on 2026-11-20. The overlay (the status-item panel, `StatusPanel` and
> `PopoverView`), the right-click menu, the status icon and the fingerprint tile are unchanged
> from pass 12 and keep their plate fidelity below. The Settings window is no longer drawn to
> page10. It is the standard SwiftUI `Settings` scene: a `TabView` with five tabs and SF Symbol
> icons, a grouped `Form` per tab, and stock `Toggle`, `Button` and `LabeledContent` controls in
> system colours and system fonts. It uses no Theme colour, no bundled font and no custom-drawn
> control. Items 9 to 15 below describe the pass-12 Settings window and are superseded; item 16
> (no "Not settings" in the window) still holds.
>
> - **Opening Settings.** One path. The app menu's "Settings…" item (⌘,) is the app's own
>   command (`CommandGroup(replacing: .appSettings)` in `CanonBarApp.swift`): it closes the
>   panel, activates the app (an agent app is not active by default) and calls SwiftUI's
>   `openSettings`. The panel's "Settings…" row and the right-click menu's "Settings…" perform
>   that same menu item (`AppDelegate.openSettings()`). `SettingsWindowController` is removed.
> - **Badge toggle.** "Show visibility badge" now redraws the status icon at once. In pass 12 the
>   icon changed only at the next status refresh.
> - **Wording.** The Location row's button is "Reveal in Finder" (was "Reveal"). The badge row
>   is the toggle "Show visibility badge" with the caption "On the menu-bar icon." (was a
>   "Menu-bar icon" label). The CLI path is shown with `~` for the home folder. The CLI row has
>   no check box; its caption carries the state.
> - **Window title.** The title follows the tab label, so the fifth tab reads "About" (page10
>   said "About Canon"). The stock `Settings` scene sets the title from the tab.
> - **Evidence.** `settings-native-light.png` and `settings-native-dark.png` in
>   `docs/app/fidelity/`: the real Settings window, captured with `screencapture -l` from
>   `Canon --export-settings` against a synthetic sample store in a temporary `CANON_HOME`.
>   Light and Dark are set on the app process only. There are no Increase Contrast images:
>   AppKit has no per-process Increase Contrast (`NSAppearance(named:
>   .accessibilityHighContrastAqua)` returns plain Aqua), and the system setting was not changed.
>   Two earlier Increase Contrast images were removed before they left the machine: they were
>   plain Light and Dark under another name (the dark one was byte-identical to
>   `settings-native-dark.png`). The export now adds "-increase-contrast" to a file name only
>   when the system setting is on. Each image was swept with OCR for private data, with a
>   planted positive. The older
>   `settings-light.png`, `settings-dark.png` and `settings-live-dark.png` are the pass-12 window
>   and stay as history.

Pass 4 (the maintainer's review of pass 3) changed items 7 and 9 and added items 21 and 22. Pass 5 added item
23: the popover is now an arrowless panel. Pass 6 (the maintainer's live review of pass 5) changed items 8
and 23 and added item 24: no light rim, and the panel has no dark mode. Pass 7 added item 25:
every shortcut the panel shows works. Pass 8 wired Core's verify and activity data: item 6 is now
the live pill, item 25's Activity row is enabled, and items 26 to 28 are new (drift card, Activity
drill-in, read-only data path). Pass 9 tested the pass-8 untested list live, fixed two verify
bugs and the older-day titles, and added item 29: the fingerprint tile has no gaps (a
deliberate deviation from page06). Pass 10 added item 30: a refused edition shows Drift and
the plate's refusal card, from Core's `refused-to-serve`. Pass 11 updated item 30: the card names
the refused file, and a fix plus a service restart clears the Drift. Every other row is unchanged from pass 3.

> **Dependency (pass 8): local and unmerged.** The pill, the drift card and Activity read Core's
> status/v1 `verify` fields, `canon alias verify --json` and `canon activity --json`. These exist
> only on the local branch `core/app-status` (tip `320c8e6`, from edition-2.1 `5eace39`; schema in
> `docs/core/app-status-v1.md` there). That branch is not merged or pushed. Against a CLI without
> them, the pill slot stays empty, no drift card shows, and Activity shows the CLI's error.
>
> **Dependency (pass 10):** the per-alias `refusedToServe` account and the `refused-to-serve`
> drift reason need `core/app-status` at **`7cb5d7a`** (local, unmerged). Older CLIs omit both:
> a refused edition then reads Verified at manifest depth, as in pass 8.
>
> **Dependency (pass 11):** `refusedToServe.lastPath` and the restart anchor for `since` need
> `core/app-status` at **`f5dc2df`** (local, unmerged). With `7cb5d7a` the card falls back to the
> pass-10 sentence with no file name, and the Drift stays until the alias moves.
>
> **Pass 12** was run against `core/app-status` at **`aca1103`**, which also records a refusal
> when a file is still broken after a restart. No app code changed in pass 12.

Every value below comes from the design HTML/CSS, not the PNGs. The sources are the bundler
templates of `design-v2/surfaces/dbc89149…` (page06 popover), `7f924294…` (page10 settings),
`d79b11e8…` (page07 icons), `a431c780…` (page09 long list) and `identity/86bde59a…` (identity
Plate 3). 1 CSS px is 1 pt.

**Composites** (`docs/app/fidelity/`, design crop | build at the same 2× scale). The design crops
come from rendering the original HTML in headless Chrome at deviceScaleFactor 2 with all network
blocked. The build images come from `Canon --export-*` on the scratch build
`/tmp/canon-app-p1-build/Canon.app`.
- `popover-light.png` (live Tailnet state), `popover-light-loopback.png` (the same store rendered
  in the Loopback state, which is the plate's state): the popover inside page06's card (radius
  12, ink hairline, see item 24).
- `panel-live-over-dark.png`, `panel-live-over-light.png`: the panel opened from the real
  menu-bar item with the system in dark mode, over a plain dark (#1e1e1e) and a plain light
  (#ffffff) window. `panel-edges-over-dark.png` and `panel-edges-over-light.png` are 12×
  nearest-neighbour zooms of the top corners, both edges of the dark band, and a bottom corner.
- `settings-live-dark.png`: the pass-12 Settings window on screen in dark mode, opened with ⌘,
  from the panel. Superseded by the pass-13 native Settings images.
- `settings-light.png`, `settings-dark.png`: the pass-12 `NSWindow` with its native titlebar and
  five-tab `NSToolbar`, captured from the window's frame view. Superseded by the pass-13 native
  Settings images.
- `icon-states.png`: the plate grid. Per state there are Light 2×, Dark 2×, 1× and 1× tiles, set
  beside the Plate 1 crop. The 1× columns show the true 18-pixel raster, upscaled without
  smoothing.
- `menu.txt`: the right-click menu dump, from `Canon --export-menu` on the live (Tailnet) state.

**Redacted for the public release.** The live captures came from a private store and machine.
Before publication, these regions were filled with the colour of the surrounding surface. Nothing
else in the images changed:
- `popover-light.png`, `popover-light-loopback.png`, `panel-live-over-dark.png`,
  `panel-live-over-light.png`: the eight alias names in the build's list. The fingerprints, the
  kind, digest and generation lines, and all chrome are unchanged.
- `popover-light.png`, `panel-live-over-*.png`: the tailnet URL in the address field, and the
  address and hostname after "Pinned to".
- `panel-live-over-*.png`: the menu-bar strip to the right of the Canon status item (other apps'
  icons).
- `settings-light.png`, `settings-dark.png`, `settings-live-dark.png`: the user name in the CLI
  path (`/Users/…/.local/bin/canon`).
- `menu.txt`: the eight packet titles are replaced by `[redacted: private packet title]`; the
  generations, counts and menu structure are as exported.

**No plate:** the deck draws only a light list for the popover and only a light settings window.
The popover has no dark appearance at all (item 8). The dark settings window is this app's
extrapolation onto the deck's dark tokens, and its composite says "NO PLATE".

**Data differences, not drift:** the design is mocked with 3 aliases on Loopback. The build
renders the live store: 31 aliases, Tailnet, 68 editions, CLI 0.1.0. So the build shows 8 rows
plus "23 more →", and its pill slots are empty (see item 6).

| # | Item | Design value (CSS source) | Built value | Status |
|---|---|---|---|---|
| 1 | Popover type scale; row title | Row name is the **alias name**, Inter 14/600; meta JetBrains Mono 11.5 #475569, ID 700 #1e40af; "Live aliases" Libron 700 17; count JBM 12; header "canon" Libron 700 20, "Workstation" 12 #9ca3af; actions Inter 14, shortcuts JBM 12; footer JBM 11. Card width 392. (`dbc89149…html` (page06)) | `PopoverView`: `alias.name` in `Theme.sans(14,.semibold)`, with every size passed verbatim from the CSS; width 392 | Fixed |
| 2 | Highlighted first row indented | Row `<a>`: padding 11px 8px; **margin 0 -8px**; first row bg #f4f6f9. All content sits on the list's 16px edge and only the background bleeds 8px. (`dbc89149…html` (page06)) | Every row gets `.padding(.horizontal, 8)` then `.padding(.horizontal, -8)`, so the highlight no longer moves content | Fixed |
| 3 | Segmented selected state; Cloud… colour | Loopback on: bg #f1f5f9, fg #0f172a, 600. Tailnet on: bg #60a5fa, fg #0b0f17. Cloud on: #b45309 / #fff. Off: transparent, **#e2e8f0**, 500. h32, radius 4.5, 13px; track #0b0f17, 1px #293548, radius 6.4, pad 3, gap 3. (`dbc89149…html` (page06)) | Per-option on-colours exactly as listed. The light/white selection applies when Loopback is on, as on the plate. The live store is on Tailnet, so the build shows Tailnet's own #60a5fa from the same CSS. Cloud… uses #e2e8f0 at 500, is not dimmed, and does nothing (P4 gate). | Fixed |
| 4 | Healthy badge | inline-flex, gap 5, 12/600, #a7f3d0 on #0d2920, **1px #065f46 border, radius 3.5**, padding 2 8; 10×10 check `M1.5 5.5 L4 8 L8.5 2` stroke 1.8 (`dbc89149…html` (page06)) | `StatusBadge` and `CheckGlyph` match exactly | Fixed |
| 5 | URL copy button | 44×32, radius 5, **border 1px #475569**, bg #111827; 14px glyph (viewBox 16: rect 5,5,9,9 rx1.5 plus a back-sheet path), stroke #f1f5f9 1.4. URL row: #0b0f17, 1px #293548, radius 6.4, pad 5 5 5 12, gap 8; URL JBM 12.5 #f1f5f9 with ellipsis. (`dbc89149…html` (page06)) | Bordered square button with `CopyGlyph` drawn from the SVG path | Fixed |
| 6 | Verified/Drift pill | Pill on the right: 11/600, gap 4, radius 3.5, pad 1 6, border 1, 9×9 glyph. Verified #065f46/#ecfdf5/#6ee7b7 with check `M1.5 5.5 L4 8 L8.5 2`; Drift #991b1b/#fef2f2/#fca5a5 with cross `M2 2 L8 8 M8 2 L2 8`, stroke 1.8. (`dbc89149…html` (page06)) | `VerifyPill` in the fixed 72pt slot, from status/v1 `verify` per alias. No `verify` field: the slot stays empty (never a guessed state). The words stay the plate's "Verified"/"Drift"; because status/v1 checks only to `verifyDepth: "manifest"`, the tooltip and accessibility label say "Manifest verified: the content ID and manifest digest match. File bodies were not re-hashed by this check." Live: `p8-home-pill-drift.png`. | Fixed (pass 8) |
| 7 | Sentence case; Quit; overflow | Actions: "Activity ⌘2", "Open store in Finder ⌘O", "Restart service ⌘R", "Stop service ⇧⌘S", "Settings… ⌘," (page06). Identity page01 (`identity/86bde59a…`, newer than page06) ends the popover with a **Quit Canon ⌘Q** row: border-top 1px #e2e8f0, padding 8 18, 14px, ⌘Q in JBM 12 #475569. Overflow on page09 (`a431c780…`): "N more →", Inter 12.5/600, #1d4ed8, padding 8 0 2, shown past 8 rows. | The five rows, then a hairline and "Quit Canon ⌘Q" as the last row, which quits the app. Activity is inert until Core #2 exists. The list caps at 8 rows, then shows "23 more →" in page09 styling, which opens the store. | Fixed (pass 4: Quit restored) |
| 8 | No dark popover | The page06 list is drawn light only, and the plate has no dark variant | The maintainer's decision (pass 6): the panel always renders exactly as page06, with a light body and a dark band, whatever the system appearance. It is pinned at the root, not by special-casing colours: `StatusPanel.appearance = .aqua` (so native controls and menus inside it are light too), `.environment(\.colorScheme, .light)` on `PopoverView`, and `.aqua` on the `--window` preview. `ListPalette.dark` is removed. The Settings window still follows the system (`settings-live-dark.png`). | Fixed (pass 6) |
| 9 | Standard settings window, 5 tabs; selected tab | 760×660; titlebar #f6f6f8, title 13/600 #3a3a3c, one per tab (General, Server, Visibility, Notifications, About Canon). Tabs are `<button role=tab>` 84×50, radius 6, column gap 2, 22px stroke-1.5 SVG icon over an 11px label, both **#3a3a3c**; selected tab **background rgba(0,0,0,0.08)**, others transparent (`7f924294…`) | `SettingsWindowController` keeps the real `NSWindow`, native title and traffic lights, and an `NSToolbar`. The toolbar has no natively selectable items, so AppKit draws no accent. Each item's view is `SettingsTabButton`: 84×50, radius 6, black 8% pill when selected, icon and label in #3a3a3c. Dark (no plate): white 10% pill, ink #e5e5e7. The title follows the tab. General is built; the other four show "Not built yet". | Superseded (pass 13: native Settings); was Fixed (pass 4: grey pill) |
| 10 | Section headings and dividers | Header: Libron 700 17, padding-bottom 6, **border-bottom 2px #0f172a across the content width**. Rows: border-bottom 1px #e2e8f0 except a section's last row. Sections gap 22. Content padding 26 40 28. (`7f924294…`) | The rule runs the full width (`.frame(maxWidth:.infinity)` before the overlay), with hairline dividers between rows and none after the last row | Superseded (pass 13: native Settings); was Fixed |
| 11 | Settings sizes ~1.4× too big | Labels 13 (right-aligned, padding-top 4) on a 190px label column, gap 18, row padding 9 0. Value lines gap 8, min-height 26. Captions 12 with line-height 1.45, #475569. Buttons h26, pad 0 10, 13px. Switch 34×20 with 16px knob. Shortcut chip 70×26, JBM 12.5. | The same values, at 1pt per CSS px with fixed-size Inter and JBM. The composite has the same scale on both sides, and the rows line up to within the data differences. | Superseded (pass 13: native Settings); was Fixed |
| 12 | "Show visibility badge" label | Menu-bar icon row: switch, then `<span 13px>Show visibility badge</span>` | `CSSSwitch` plus the label at Inter 13 | Superseded (pass 13: native Settings); was Fixed |
| 13 | Location row | `~/.canon` in JBM 12.5, then [Change…] [Reveal] buttons | `StoreFacts.tildePath(canonHome)` gives "~/.canon". `.fixedSize()` buttons can't clip. Change… is inert (store relocation, Core #6). Reveal opens the folder. | Superseded (pass 13: native Settings); was Fixed |
| 14 | Contents row | "Contents" label; "3 aliases · 9 editions" at 13px; caption "Editions are never deleted by Canon." | "31 aliases · 68 editions" plus the caption. The edition count is a read-only `store/packets/sha256-*` listing, a stopgap for Core #5. | Superseded (pass 13: native Settings); was Fixed (stopgap logged) |
| 15 | CLI row | Label "canon"; 16×16 radius-3.5 #0f172a box with a 9px white check; "2.1.0 · /usr/local/bin/canon" JBM 12.5; [Reinstall…]; caption "Same version as the app." | The same layout. The version comes from the CLI's package.json (Core #4 stopgap), and the app is stamped from the same package.json, so the caption is a real check that reads "Same version as the app." with 0.1.0 == 0.1.0. Dark mode inverts the box to #f1f5f9 with a #0f172a check so it stays visible. | Superseded (pass 13: native Settings); was Fixed |
| 16 | "Not settings" | A `<section>` in the board's second grid column (`grid-template-columns: 832px 1fr`), **outside** the 760×660 window, so it annotates the board and is not window content | Removed from the app. The argument is below. | Fixed |
| 17 | Serif C, identity Plate 3 | Identity Plate 3 and page07 Plate 1 use the **same** SVG: tile `rect 2,2 14×14 rx2.3`, C `M11.34 6.62 A3.2 3.2 0 1 0 11.34 11.38`, stroke 1.9. Plate 2 says: "At 16 px the C is drawn as one stroke, not set in type." | `StatusIconRenderer` already draws exactly this: an arc centred at 9.2,9.0, r3.2, from 48.07° to 311.93°, stroke 1.9, knocked out of the tile. A typeset serif C would contradict Plate 2. The new grid shows the build matching the plate. | Justified (already equal); evidence redone |
| 18 | Badges oversized / cut into the tile | Loopback: knockout r3.6 and dot r2.1 at 14.6,14.6. Tailnet: knockout r4.3, dot r1.4, ring r3.1 stroke 1 at 14.4. Cloud: knockout r4.4, dot r1.5, ticks `M14.4 10.5 V12 M14.4 16.8 V18 M10.5 14.4 H12 M16.8 14.4 H18` stroke 1.1. Needs you: plus knockout r3.7 and dot r2.4 at 15,3. Stopped: hollow rect, stroke 1.4. (`d79b11e8…` Plate 1) | Coordinates are identical. The badges really do cut into the tile corner, because the plate's SVG does: the knockout circle overlaps the tile. The earlier impression came from a 288pt render with no tile beside it; at plate scale the shapes coincide (`icon-states.png`). | Justified (already equal); evidence redone |
| 19 | Icon evidence as the plate grid | Columns 96 96 52 52 1fr, gap 14. Light 2× tile 88×52 #E4E4E6 r8 with icon 36 ink #1D1D1F; Dark 2× #2A2A2D, ink #F5F5F7; 1× tiles 44×26 r5, icon 18. Header 12 #475569 with a 1px #94a3b8 rule; rows pad 10 0 with #e2e8f0 dividers; container #eaedf2, pad 22 26, 752 wide. | The `IconPlateGrid` view reproduces this using the shipping template image, tinted with the plate inks. Composited beside the Chrome crop of Plate 1. | Fixed |
| 20 | Embed Inter and JetBrains Mono | Plates set `font-family: Inter` at weights 400/500/600/700 and `'JetBrains Mono'` at 400/700 (the @font-face ranges are 400–700) | Inter 4.001 Regular, Medium, SemiBold and Bold plus JetBrains Mono 2.304 Regular and Bold are vendored as OFL TTFs with their licences. Sources and SHA-256s are in `Resources/Fonts/SOURCE.md`. They are registered at process scope, and `Theme.sans` and `Theme.mono` use the PostScript names. | Fixed |
| 21 | Right-click menu in sentence case | Same verbs as the popover actions: "Open store in Finder", "Restart service", "Stop service" | `MenuBuilder` uses sentence case for all three, including the overflow item "+N more — Open store in Finder". `menu.txt` re-exported. | Fixed (pass 4) |
| 22 | Tailnet caption never splits the hostname | page06 caption: "Pinned to" 12px #9ca3af, then address and host in JBM #e2e8f0 on one line | "Pinned to " and "100.64.0.10 · " are fixed-size. The hostname is one `Text` with `lineLimit(1)` and `.truncationMode(.middle)`, so a long name reads `my-mac.exa…tailnet.ts.net` and never wraps mid-name. | Fixed (pass 4) |
| 23 | Popover opens as a plain card, no arrow | page06: the card is a 392px box, `margin: 6px 12px 0 0`, `border: 1px solid #94a3b8`, `border-radius: 12px`, `box-shadow: 0 22px 48px rgba(15,23,42,.22)`, with no arrow | `NSPopover` (which always draws an arrow) is replaced by `StatusPanel`, a borderless, non-activating `NSPanel` at status-bar level hosting the same SwiftUI content. `PopoverCard` (shared with `--export-popover`) draws the radius, edge (item 24) and the plate's shadow (sigma 24, y 22, 22% #0f172a) in a transparent margin, and the window shadow is off. The card sits 6pt below the menu bar, left-aligned to the status item, and is clamped 12pt inside the `visibleFrame` of the screen that holds the item, so each display uses its own menu bar. Dismisses on Esc, on focus loss, and on clicks outside the card (global and local event monitors). The status item toggles it and stays highlighted while it's open, and right-click closes it before showing the system menu. Settings… closes it. ⌃⌥C, which before was only displayed, is now a registered Carbon hot key and toggles it. An accessibility press on the status item (VoiceOver) used to do nothing because `NSApp.currentEvent` is nil; it now opens the panel. Live captures: `panel-live-over-dark.png`, `panel-live-over-light.png`. | Fixed (pass 5) |
| 24 | No light rim around the panel | page06 `border: 1px solid #94a3b8`. On the plate's pale backdrop it's invisible; on a dark desktop, and beside the dark band, it reads as a white outline | The edge is a 1px hairline of rgba(15,23,42,0.24) drawn inside the card. It still separates the card from light windows and disappears on dark ones. The card is flattened (`compositingGroup`) and then clipped once, and the stroke uses the same shape: clipping the layers separately had left a pale antialiased ring of the white body at the band's top corners (seen in the first pass-6 capture, gone after). Over a #1e1e1e window, no pixel within the top corner arcs is brighter than the window itself. | Fixed (pass 6) |
| 25 | A shortcut that's shown works | page06 lists Activity ⌘2, Open store in Finder ⌘O, Restart service ⌘R, Stop service ⇧⌘S and Settings… ⌘, | Each row binds the shortcut it displays to its own button (`actionRow(key:)`), so while the panel is key the shortcut runs exactly the row's action, with the same enabled state. Neither row has a confirmation step, so neither shortcut does. ⌘, is the app's Settings command (item 23 pass 6) and ⌘Q was already bound. Activity is disabled until P2: its row is dimmed to 0.45 (page06 draws no disabled row; this is the deck's treatment for unavailable content on page09), it reports itself as disabled to Accessibility, and ⌘2 does nothing. A disabled Restart or Stop row (busy, or service stopped) is dimmed the same way and its shortcut is off. Live: `panel-actions-live.png`. **Pass 8:** Activity is enabled and ⌘2 opens it (item 27); the dim is gone. | Fixed (pass 7, 8) |
| 26 | Drift card | page06: margin 6 16 0; #fff; border 1 #cbd5e1, left 4 #b91c1c; radius 6.4; pad 12 14; gap 6. Title 13/600 + mono 11 #475569 "exit 1" on the right; body 12.5/1.5 #1e293b with paths in mono 11.5; link 12.5/600 #1d4ed8 pad 4 0 | `DriftCard` under the alias list for the first alias in drift (plus "+N more in drift"). Title "<name> failed its manifest check"; right label "manifest" until Verify now runs, then "exit N"; one sentence per `driftReasons` code, then "Nothing was repaired." The link is "Verify now →" and runs `canon alias verify <name> --json` (full re-hash); the card then lists every error (path · code, message), or "Full re-hash passed…" on exit 0, or the CLI's stderr. Live: `p8-home-pill-drift.png`, `p8-drift-verify-now.png`. | Fixed (pass 8) |
| 27 | Activity drill-in (⌘2) | page08 "Activity · header · ⌘2": dark header with back button, "Today" stats band (editions stored, alias moved, refused to serve), day groups, four row styles, "Open full log ⌘L", footer path + "append-only" | `ActivityView`, from `canon activity --json --limit 200` (newest first) and status/v1 `service.refusedToServe`. Row and ⌘2 enabled, 0.45 dim removed. Plate metrics as listed in the code comments. The third stat is labelled by `refusedToServe.since` ("refused, since start" / "refused, all time"), never as a today figure. Live: `p8-activity.png`. | Fixed (pass 8) |
| 28 | Every pass-8 read works under `--read-only` | brief: all read-only CLI calls | `canon status`, `canon activity` and `canon alias verify` go through one read helper that logs each call in read-only runs. None writes. See "Pass 8 test" below. | Verified (pass 8) |
| 29 | Fingerprint tile without seams | page06: 8×8 cells, 7 units on an 8-unit step in a 63-unit viewBox (a 1/63 gap), cell rx=1. At 28pt the gap is 0.44pt, under one device pixel, so it rendered as uneven white seams (the maintainer saw "a white grid") | **A deliberate deviation from page06 (gap 1/63 dropped, the maintainer's call 2026-11-18).** `FingerprintRaster` draws the 8×8 as one bitmap at the backing scale: cell edges at `round(i·px/8)`, antialiasing off between cells, so cells touch on whole pixels. Inner cells are square; only the outer tile corners are rounded, radius side/14 (2pt at 28pt), in the spirit of the plate's rx=1. Palette and `digit % 5` mapping unchanged. `FingerprintView` (panel rows) and the right-click menu thumbnails (`MenuBuilder`, 14pt, 1x and 2x bitmaps) use the same raster | Fixed (deviation) |
| 30 | Refused edition: pill and card | page06 card: "auth-audit failed re-hash on read", right label "exit 1", body "‹path› no longer matches its manifest digest. Refused to serve; nothing auto-repaired.", link "Open verify report →" | Core (`7cb5d7a`) folds a refusal against the current content ID into `verify: "drift"` with `refused-to-serve`, so the pill shows Drift with no app logic. When `refused-to-serve` is the only reason the card uses the plate's title "‹alias› failed re-hash on read". Its body (pass 11) is "‹lastPath› failed its re-hash on read. The service refused to serve it once, at 12:25." or "…N times, last at HH:mm.", from `refusedToServe.lastPath`, `count` and `lastAt`; without `lastPath` the file clause is left out. The right label reads "on read" before Verify now and "exit N" after. With other reasons as well, the title stays "failed its manifest check" and the refusal sentence is added. Pill tooltip: "Drift: the service refused to serve this edition once, after a file failed its re-hash on read." After a passed full re-hash the card adds "The files match again. Restart the service to clear the recorded refusal.", because Core counts refusals since the later of the generation going live and the service start | Fixed (pass 10, pass 11) |

### Pass 8: invented without a plate

Each of these has no plate behind it. They are the smallest choices that kept the surfaces honest;
each is open to change.

1. **Pill tooltip and accessibility text** (wording above). The plate has no tooltip.
2. **Drift card wording.** The plate's card reports a failed read re-hash ("failed re-hash on
   read", "Refused to serve"). status/v1's drift is a manifest-level finding, not a refusal, so the
   title says "failed its manifest check" and the body maps each reason code to a sentence. The
   right label "manifest" before a run is invented; "exit N" after it is the plate's.
3. **Verify now** replaces the plate's "Open verify report →" link (the report drill-in is P2).
   Its result list inside the card (rule, summary line, path · code, message) has no plate; it
   borrows the Activity rows' text metrics. "Verifying…" and "Verify again →" are invented.
4. **One card at most**, for the first drifted alias, with "+N more in drift". The plate shows one
   card and no multi-drift case.
5. **Header badge stays "Healthy" with drift present**, as page06 draws it; the menu-bar icon's
   needs-you dot (page07 "Needs you: Drift…") lights instead. `needsAttention` now includes drift.
6. **Activity back key ⌘[** (the macOS Back key). The plate draws only the button. The panel
   returns to home whenever it closes.
7. **Activity "Today" counts:** "editions stored" counts today's publish items with outcome
   `created` and no error; "alias(es) moved" counts today's alias items. If the 200-item read is
   truncated and its oldest item is still today, both get a "+".
8. **Day groups older than yesterday** are titled with the weekday name; the plate shows only
   Today and Yesterday. Times are local, HH:mm.
9. **Row titles and details per kind** (the plate draws examples, not a mapping):
   verify-failure "Refused to serve <alias or sha256-short>" + path chip "failed re-hash on read.";
   alias "<name> g(n-1) → gn" with old → new short IDs, or "<name> → g1" + "New alias · <id>";
   publish "Stored sha256-<short>" + "New edition in the store." ("Already stored…" for
   `already-present`; an ink ✗ and the error class on failure); service titles mapped from the
   event name (start, ready, stop, restart, start-refused, start-failed, recovered-stale-state,
   clean), detail host:port · pid, URL, or pid.
10. **Truncation, skipped-line, loading, empty and error notes** in the list. The list scrolls past
    470pt.
11. **Footer path** is the service's `events.jsonl` (the plate shows `~/.canon/log/activity.jsonl`,
    which does not exist). Publish and alias rows come from store receipts, not that file.
    "Open full log ⌘L" opens `events.jsonl` in Console, read-only.

### Pass 8: notes for Core

- **Manifest depth can say "Verified" for an edition the server refuses.** In the test,
  `week-46`'s `index.html` was edited after the server had primed it: the server returned 500 and
  logged `integrity-failure`, `refusedToServe.count` became 1, and status/v1 still reported
  `week-46` `verified` at manifest depth. The pill does not infer refusals (no server logic in
  Swift). Suggestion for Core: reflect a per-alias refusal, or a "last full verify" result, in
  status/v1.
- Core's note stands: `events.jsonl` is never rotated, so the Activity read cost grows with it.

### Pass 8 test

- Build: `./macos/CanonBar/build-app.sh /tmp/canon-app-status-build/Canon.app`, exit 0, no
  warnings printed. `/tmp/canon-app-p1-build/Canon.app` was not rebuilt, because the maintainer's review copy
  is running from it.
- Temp store `/tmp/canon-app-status-test` (own `profile.json`, port 18793, own service), filled
  with the core/app-status CLI: three `canon brief` publishes, `alias-promotion` moved g1 → g2,
  then `auth-audit`'s `manifest.json` given a trailing space (drift: `manifest-hash-mismatch`) and
  `week-46`'s `index.html` edited after priming (one refusal). `~/.canon` and the live service
  were not used.
- The app found that CLI through the new **`CANON_CLI`** environment override (a `.mjs`/`.js` path
  runs under node; anything else runs directly) and that home through `CANON_HOME`:
  `open -n --env CANON_HOME=/tmp/canon-app-status-test --env CANON_CLI=…/core-app-status/src/cli.mjs
  /tmp/canon-app-status-build/Canon.app --args --read-only`. No user config was changed.
- The panel was opened with an Accessibility press on the status item; Verify now was an
  Accessibility press; ⌘2, ⌘[ and Esc were posted to the test process only (`CGEvent postToPid`).
  ⌘2 opened Activity and ⌘[ returned home.
- **No writes:** size + mtime of all 4,585 files under the temp home and `~/.canon`, and SHA-256 of
  the temp service files and `~/.canon/profile.json`, before and after the run. The only changes
  were the two services' own `server.log` request lines (`GET /healthz`: the test copy's on the
  temp service, the maintainer's running copy's on the live one). The app's log shows 22 `ran canon status`,
  one `ran canon alias verify auth-audit --json --root …` and one `ran canon activity --json
  --limit 200 --root … --state-dir …`; nothing else.

### Pass 8: unverified

Superseded by pass 9 below: every item in this list except the outside click and right-click
was produced live in pass 9.

- The pill tooltip was not seen on screen: the panel is non-activating, and hover was not driven.
  The accessibility label carries the same text.
- "Open full log ⌘L" was not pressed (it would open Console).
- Day groups other than Today, the truncated/skipped notes, a failed publish row, and the
  "Full re-hash passed" result were not produced live; they are in code only.
- The first Accessibility read of the panel after launch returned no window; a second opening
  did. Mouse events posted to the process were dropped and closed the panel through the
  outside-click monitor. Neither affects a real user; both are test-harness notes.

### Pass 9 test: the pass-8 untested list, live

- Builds: `./macos/CanonBar/build-app.sh /tmp/canon-pass9-build/Canon.app` (testing fixes) and
  `/tmp/canon-pass9-fp-build/Canon.app` (with item 29). Both exited 0 with no warnings.
  `/tmp/canon-app-p1-build`, where the maintainer's review copy runs, was not rebuilt.
- Temp home `/tmp/canon-pass9-test` (port 18794, own service). It was filled with a frozen copy of
  the core/app-status CLI (`git archive 320c8e6`), run through `CANON_CLI`, with `--read-only`.
- **How the past-dated events were made:** a Node preload (`--import` of a 6-line clock shim)
  shifted `Date` back by a set amount for each setup command only. The real CLI then wrote real
  receipts and events with past timestamps: publishes and alias moves 9 days ago (Mon 9 Nov),
  3 days ago and yesterday, and 200 `churn-test` alias moves 4 days ago. Nothing was hand-written,
  except two deliberately malformed lines appended to `events.jsonl`.
- **The failed publish** is a real one: yesterday, a build whose file was tampered with after
  building gave `source-invalid`, exit 1.
- Presses were Accessibility actions on the test process. Keys were posted to the test process only.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Pill tooltip | The pill is one AX element (role AXUnknown) whose description is the tooltip text: "Manifest verified: the content ID and manifest digest match. File bodies were not re-hashed by this check." / "Drift found by the manifest check: manifest-hash-mismatch." There is no separate AXHelp. The on-screen tooltip balloon needs a real hover and was not seen | AX dump |
| 2 | ⌘L | Console opened `/private/tmp/canon-pass9-test/service/events.jsonl` (checked with `lsof`). The panel closed when Console took focus. Console was quit afterwards; it was not running before | `p9-cmdL-console.png` |
| 3 | Older-day groups | Today, Yesterday, Sunday and the 9 Nov group showed live. The 9 Nov group was titled "Monday", which read as this week: **bug, fixed** (below) | `p9-activity-older-days.png` |
| 4 | Truncated note | "Showing the newest 200. Older entries are in the full log." (the CLI returned 200 items, `truncated: true`) | `p9-activity-truncated.png` |
| 5 | Skipped note | "2 unreadable lines were skipped." | `p9-activity-skipped.png` |
| 6 | Failed publish row | "Publish failed", reason `source-invalid`, ink cross (crimson stays reserved for refusals) | `p9-activity-older-days.png` |
| 7 | "Full re-hash passed" | Shown live: "exit 0", "Full re-hash passed: 12 files match the manifest." It exposed two bugs, both fixed (below). After the fix a pass closes the card and the pill reads Verified | `p9-rehash-passed-before-fix.png`, `p9-rehash-after-fix.png` |
| 8 | Outside click, right-click | Not done: both need real mouse events in other apps or on the status item, which take the maintainer's pointer. An AX press arrives as a left click. **Needs the maintainer** | — |

**Bugs found and fixed in pass 9:**

- **Verify result contradicted the status.** After the file was restored and the re-hash passed,
  the card still said "auth-audit failed its manifest check" with the Drift pill, until the next
  6 s poll. If the same edition drifted again, the old "passed" result came back on the new drift
  card. Fix (`PublisherController`): Verify now re-reads status at once after the run, and a
  stored run is dropped when the alias's status says `verified` (as well as when its content ID
  changes). Retested live: Verify now → exit 1, "Full re-hash: 2 problems in 12 files"; restore
  and Verify again → card gone within 2 s, all pills Verified; drift again → a fresh "manifest"
  card with "Verify now →". Consequence: "Full re-hash passed" no longer stays on screen. The
  pass shows as the card closing and the pill turning Verified.
- **Older days were titled by weekday name only.** Activity now uses Today, Yesterday, the weekday
  for 2–6 days ago, and "9 November" (`d MMMM`) for older days. After the 200 churn moves the
  9 Nov group falls outside the newest 200, so the fix was checked by running the shipped
  `dayGroups` code as a script: 0 → Today, 1 → Yesterday, 3 → Sunday, 6 → Thursday,
  7 → "11 November", 9 → "9 November".

**Item 29 evidence:** `p9-fingerprint-export-4x.png` (popover export at 2×, zoomed 4×),
`p9-fingerprint-live-8x.png` (the live panel on a 1× display, zoomed 8×) and
`p9-fingerprint-tile-10x.png` (one tile at 2×, zoomed 10×). Each shows before on the left and
after on the right. Before has light seams between cells; after has none. In the menu's 14pt and
28pt bitmaps (`--export-menu` now writes them; `p9-menu-fingerprint-28px.png`), every pixel
outside the four corners is one of the five palette colours: 0 off-palette pixels in all 8
bitmaps.

**No writes:** size and mtime of every file under `~/.canon` and the temp home, plus SHA-256 of
the temp service files and `~/.canon/profile.json`, before and after. The only changes are the
test's own setup writes (`auth-audit`'s `manifest.json` drifted and restored, 200 churn receipts
and their alias record), and the two services' `server.log` request lines. The app's log shows
only `canon status`, `canon alias verify auth-audit --json --root …` and `canon activity --json
--limit 200 …` calls.

### Pass 9: unverified

- Item 8: the outside-click dismissal and the right-click system menu, driven with a real mouse.
- The pill tooltip balloon on screen (it needs a hover). Its text is verified through AX.
- The fingerprint at 3× scale: there is no 3× display here. The raster is built at whatever
  `displayScale` reports, so it should hold.

### Pass 10 test: a refused edition, live

- Build: `./macos/CanonBar/build-app.sh /tmp/canon-pass10-build/Canon.app`, exit 0, no warnings.
- Core: a frozen copy of `core/app-status` at `7cb5d7a` (`git archive`), through `CANON_CLI`.
  Temp home `/tmp/canon-pass10-test`, port 18795, its own service. The app ran with `--read-only`.
- Steps: publish `auth-audit` and `week-46` with `canon brief`, start the service, read
  `report.md` (200: the edition is primed), append a line to `report.md` in the store, read it
  again (500, one `integrity-failure` event). `canon status` then gave `auth-audit`
  `verify: "drift"`, `driftReasons: ["refused-to-serve"]`, `refusedToServe.count: 1`.
- `p10-refused-card.png`: `week-46` Verified, `auth-audit` Drift; card "auth-audit failed
  re-hash on read", "on read", "The service refused to serve it once, at 11:38. Nothing was
  repaired.", "Verify now →".
- `p10-refused-verify-now.png`: Verify now gives "exit 1", "Full re-hash: 2 problems in 12
  files.": `report.md · byte-length` and `report.md · checksum`. This is the plate's state, and
  Verify now names the file the card itself cannot.
- `p10-refused-after-restore.png`: after `report.md` was restored, Verify again gives "exit 0",
  "Full re-hash passed: 12 files match the manifest." and "The refusals already recorded stay
  counted until the alias moves." The pill stays Drift and the card stays, because Core counts
  refusals since the generation went live. A read of `report.md` then returned 200.
- The app ran only `canon status` (15) and `canon alias verify auth-audit --json --root …` (2).
  `~/.canon/profile.json` has the same SHA-256 as before. The test copy is quit and the temp
  service stopped.

### Pass 11 test: the refused file named, and cleared by a restart

- Build: `./macos/CanonBar/build-app.sh /tmp/canon-pass11-build/Canon.app`, exit 0, no warnings.
- Core: a frozen copy of `core/app-status` at `f5dc2df` (`git archive`), through `CANON_CLI`.
  Temp home `/tmp/canon-pass11-test`, port 18796, its own service.
- The test copy ran **without** `--read-only`, because read-only skips Restart. `CANON_HOME`
  pointed it at the temp home, so its profile and every service command (`--state-dir
  /tmp/canon-pass11-test/service`) were the temp ones. `~/.canon` file sizes and mtimes were
  recorded before and after: the only change is the live `server.log`, from `/healthz` polls by
  the maintainer's running copy. The live `events.jsonl` is unchanged, so the live service was not restarted.
- Steps: publish `auth-audit` and `week-46`, start the service, read `report.md` (200), append a
  line to it in the store, read it again (500). `canon status`: `auth-audit` drift,
  `refused-to-serve`, `{count: 1, lastPath: "report.md"}`.
- `p11-refused-names-file.png`: card "auth-audit failed re-hash on read", "on read",
  "report.md failed its re-hash on read. The service refused to serve it once, at 12:25. Nothing
  was repaired."
- `p11-restored-verify-passed.png`: after `report.md` was restored, Verify now gives "exit 0",
  "Full re-hash passed: 12 files match the manifest." and "The files match again. Restart the
  service to clear the recorded refusal." The pill stays Drift.
- `p11-after-restart-verified.png`: an Accessibility press on the panel's Restart service row
  stopped the temp service (pid 4869) and started a new one (pid 5493, new `start` event).
  `canon status` then gave both aliases `verified`, `count: 0`, `since` = the new start. The pill
  reads Verified and the card is gone. A read of `report.md` returned 200.
- The test copy is quit and the temp service stopped.

### Pass 12 test: Drift survives a restart while the file is still broken

- Build: `./macos/CanonBar/build-app.sh /tmp/canon-pass12-build/Canon.app` from `c1c1a1f`,
  exit 0, no warnings. No app code changed in this pass.
- Core: a frozen copy of `core/app-status` at `aca1103` (`git archive`), through `CANON_CLI`.
  Temp home `/tmp/canon-pass12-test`, port 18797. As in pass 11, the test copy ran without
  `--read-only`, with `CANON_HOME` set to the temp home, so Restart drove the temp service only.
- Steps and `canon status` for `auth-audit` at each step:
  1. Read `report.md` (200), tamper, read again (500): drift, `count: 1`, `lastPath: "report.md"`.
  2. Restart service from the panel (temp serve pid 75236 → 77823), file still broken. Before
     any read: `verified`, `count: 0`. The new `since` is the restart, and nothing has
     re-verified the file yet.
  3. Read `report.md`: **404**, and one new `integrity-failure` event with `path: "report.md"`.
     Status: drift, `count: 1`, `lastPath: "report.md"`. Two more reads (404, 404) added nothing:
     `count` stays 1.
  4. Restore `report.md`, Restart service again (pid 77823 → 78984), read it (200): both aliases
     `verified`, `count: 0`.
- `p12-drift-survives-restart.png`: after step 3, Drift with "report.md failed its re-hash on
  read. The service refused to serve it once, at 12:43. Nothing was repaired."
- `p12-restored-restart-verified.png`: after step 4, both pills Verified, no card.
- **Not produced:** the "N times, last at HH:mm" sentence. Each restart resets `since`, and after
  the first refusal later reads return 404 without a new event, so `count` never passed 1.
- **Gap for Core:** between a restart and the first read of a still-broken file, status reports
  the edition Verified (step 2). The Drift only comes back when someone reads the file.
- `~/.canon`: the only change is the live `server.log` (`/healthz` polls from the maintainer's running
  copy); `profile.json` has the same SHA-256. The live service (pid 45339) and the maintainer's copy
  (pid 32495) kept running. The test copy is quit, the temp service stopped, and no listener or
  temp `serve` process is left on ports 18795–18797.

### Pass 13 test: native Settings, live

Run on 2026-11-20 against a synthetic store: a temporary `CANON_HOME` with four aliases
(`sample-report`, `sample-site`, `demo-a`, `demo-b`) published from the repository fixtures, a
loopback service on a free port, and `CANON_CLI` pointing at `core/app-status` `693f4f8`. The
scratch build ran with `--read-only --window`, beside the installed app. Actions went through
Accessibility, in the background. The live bullets below ran on the first pass-13 build
(`1c985ce` code). The final build changed how Settings opens and how the tab is kept; on it,
the export run and the live checks in "Pass 13 test: final build, live" happened.

- The panel content's "Settings…" row opens the Settings window ("General", 520 pt wide).
- ⌘W closes it. ⌘, sent to the panel-content window opens it again. (In that build ⌘, was
  SwiftUI's stock item.)
- The Server tab shows "Not built yet", and the window title changes to "Server".
- "Show visibility badge": off, then on. The default changes in the scratch app's own domain,
  and the scratch status icon gains and loses its badge at once (menu-bar captures before and
  after).
- "Launch at login" was not pressed: it registers a login item.
- `--export-settings` on the single-path build opens Settings through `openSettings()` and
  captures it in Light and Dark.
- OCR sweep (Vision, accurate) of the two images against a deny list of the user name,
  `/Users/`, tailnet names, 100.x addresses, this Mac's names and every alias name in the real
  store: 0 hits in 53 recognized lines. The same sweep on a copy of the Light image with one real
  alias name drawn in: 1 hit, exit 1. OCR read `/tmp/canon-native-test` and
  `~/.local/bin/canon` in both images, so path text is read.

### Pass 13 test: final build, live

Run on 2026-11-20 from 19:36 to 19:39 Central (UTC-06:00) on a build of `6f5d1cd`
(build-app.sh exit 0, 0 warnings). The store, `CANON_CLI` and service are the same as above:
synthetic, on `127.0.0.1:18798`. The app ran without `--read-only` and without `--window`, so the
real status item and the real panel were tested. Another app with the same bundle id was running;
it got no input, and the scratch app was found by its pid. Actions went through Accessibility on
the scratch pid, in the background. Window state comes from `CGWindowListCopyWindowInfo`
(`kCGWindowIsOnscreen`). Focus comes from `NSWorkspace.frontmostApplication` and the app's
`AXFocusedWindow`.

| Check | Result | Evidence |
|---|---|---|
| Settings from the real panel | Pass | `AXPress` on the scratch status item opened the panel (layer 25, on screen). `AXPress` on its "Settings…, ⌘," row then gave: panel not on screen, "General" on screen, the scratch app frontmost, and "General" as its focused and main window. |
| ⌘, closes the panel and brings Settings forward | Not verified | ⌘, posted to the scratch pid (`CGEventPostToPid`) opened "General". But the panel had already closed before the key arrived, and another app was frontmost after it. The test then stopped, because the maintainer was using the Mac (input idle time below 0.5 s for 30 s). |
| Right-click "Settings…" | Not run | It needs a menu open on the shared screen, and the test stopped first. |
| Accessibility labels, General tab | Pass | Read from the tree, VoiceOver off. Both switches are `AXCheckBox`/`AXSwitch` with `AXTitleUIElement` set to their label text: "Launch at login" and "Show visibility badge". The buttons have their own names: "Change…", "Reveal in Finder", "Reinstall…". The toolbar tabs are named "General", "Server", "Visibility", "Notifications" and "About". The section headings are "Canon", "Store" and "Command-line tool". |

The panel's on-screen reading was checked against a known positive: after a second status-item
press it read `onscreen true`, and after the closes it read `false`. The app's defaults domain
was the same after the run as before it (`defaults export`, `diff` exit 0). A copy with one value
changed gave `diff` exit 1. The installed `~/Applications/CanonBar.app` and the other running app were
not changed or relaunched. The scratch app was quit and the service stopped; port 18798 is free.

### Pass 13 test: accessibility labels on the other four tabs

Run on 2026-11-20 at 19:43 Central (UTC-06:00). In the app, every way into Settings activates
the app (`AppDelegate.prepareForSettings()` and the panel path both call `NSApp.activate`).
Opening the real Settings window again would therefore take focus. Instead, a harness outside the
repository hosted the real view in a process that never activates. The harness was built from the
`app/native` sources, without `CanonBarApp.swift`, with a copy of `SettingsView.swift` that differs
in one line: `@State private var tab` became `@State var tab`, so the harness can choose the
selected tab. It put one `SettingsView` window per tab on screen with alpha 0. The windows
ignored the mouse, could not become key, and used the same synthetic store and service. The
frontmost app stayed another app for the whole run, and the harness had no focused window.

- Positive control: the harness's General tree has the same labels as the tree read from the
  real Settings window (above). Two values differ, because the harness is not the signed bundle:
  "Launch at login" reads 0, and the version line reads "App is ?.". The tab parameter takes
  effect: the Server window shows other content than General.
- Server, Visibility, Notifications and About: each tree is the same (md5 `00d182bd…` for all
  four). It has two `AXStaticText` elements, "Not built yet" and "This tab arrives in a later
  phase.". It has no controls, so no control can lack a label.
- The tab buttons themselves ("General" to "About") were read from the real window's toolbar (above).
  In the harness window the toolbar collapses into one "more toolbar items" pop-up, so it is not
  evidence for the tab buttons.
- No label was missing, so `SettingsView.swift` is unchanged, and nothing was rebuilt.

The harness quit, the service stopped, the app's defaults domain compared equal before and after
(`cmp` exit 0), and the harness left no defaults domain of its own.

### Pass 13 review: checks by the maintainer, by hand

Ivan ran these two checks by hand on 2026-11-21 on the scratch build of `app/native`, with the
steps from the pass 13 report. His words, 2026-11-21 07:52 Central (UTC-06:00): "tested, works
well". They cover these two checks only.

| Check | Result | Evidence |
|---|---|---|
| 1. ⌘, closes the panel and opens Settings in front | Pass | Verified by Ivan by hand, 2026-11-21: "tested, works well". |
| 2. Right-click "Settings…" opens Settings | Pass | Verified by Ivan by hand, 2026-11-21: "tested, works well". |

Increase Contrast, VoiceOver and ⌃⌥C were not part of this review. They stay unverified (below).

### Pass 13: unverified

- ⌘, on the final build: verified by Ivan by hand on 2026-11-21 (see the review above). The
  agent's own test did not see the panel close or the app come to the front.
- Increase Contrast was not captured. It needs the system setting on, and the system setting
  was not changed. A forced appearance cannot stand in for it. Measured on 2026-11-20: under
  `NSAppearance(named: .accessibilityHighContrastAqua)` the appearance's name is
  `NSAppearanceNameAqua`, and `separatorColor`, `secondaryLabelColor` and
  `controlBackgroundColor` resolve to the same values as under `.aqua`. The same holds for
  `.accessibilityHighContrastDarkAqua` and `.darkAqua`. The same probe tells `.aqua` from
  `.darkAqua`, so it can see a difference.
- With Increase Contrast on, the export still forces plain Light and Dark on the process. It is
  not seen whether AppKit then draws the high-contrast variant, so an "-increase-contrast"
  image would need a look before it counts as evidence.
- The selected tab is in memory (`@State`), as in pass 12. Whether the scene keeps it across a
  window close in one launch was not seen live.
- The stock `Settings` window saves its frame in the app's own defaults
  (`NSWindow Frame com_apple_SwiftUI_Settings_window`), as any AppKit window with an autosave
  name does. An export run writes it too.
- The right-click menu's "Settings…": verified by Ivan by hand on 2026-11-21 (see the review
  above). The agent did not press it live.
- ⌃⌥C was not tested: the other running app also holds it. The real panel was opened from the
  status item (see above).
- VoiceOver itself was not run. The labels of all five tabs were read from the accessibility tree.
  General was read in the real Settings window; the other four were read in the harness above,
  not in the scratch app's own Settings window.

### Pass 10: notes for Core (answered in `f5dc2df`)

The first and third notes are answered: `since` now moves at a service restart, and the account
carries `lastPath`. The second still holds: only the first bad read is counted.


- **Drift outlives the fault.** After the file is restored and the full re-hash passes, the
  service serves the file again (200), but status keeps `auth-audit` in Drift until the alias
  moves. Is that intended? If not, a passed `canon alias verify` (or a successful read after
  the last refusal) could end the episode.
- **Only the first bad read counts.** After the 500, later reads of the tampered file returned
  404 and added no `integrity-failure` event, so `count` stays at 1 however often it is read.
- **No path in the account.** The event has `path`; `refusedToServe` does not. A `lastPath`
  would let the card say "‹path› no longer matches its manifest digest", as page06 does.

### Item 16: why "Not settings" stays out of the window

On page10 the four promises (Verify on read, Saved grants, Repair, Delete) sit in a separate
column of the *board*, beside the window frame. They explain why there are no switches; they are
not UI. Inside the window, the design shows promises as **locked rows**: the Server tab's
"Verify on read · Always [switch, disabled] [lock]" with the caption "Fail-closed. Every read
re-hashes; this isn't a setting." That is how they should appear in the app once the Server tab
is built (P2). A free-floating "Not settings" panel in General would put the board's commentary
into the product. The rule itself is still honoured: there is no switch for verify-on-read, no
saved grants, no repair and no delete anywhere in the app.

### Unverified in this pass

- Pass 6 repeated the live run with the system in dark mode, after the rim and appearance
  changes: toggle, Esc, ⌃⌥C open and close, focus loss to Finder, and ⌘, all passed. ⌘, had been
  answered by the placeholder SwiftUI `Settings` scene with an empty window. Pass 12 made it
  open the themed Settings window; pass 13 makes it the native Settings scene (see the top of
  this file).
- Pass 7, on a `--read-only` copy with the panel open: ⌘R and a press on the Restart service row
  each logged `skipped restartServer`; ⇧⌘S and a press on Stop service each logged
  `skipped setExposure(stopped)`; ⌘O opened Finder on `~/.canon/store`; ⌘2 did nothing and the
  Activity row reports `enabled: false`. Keys were posted to the test process only (`CGEvent`
  `postToPid`). `~/.canon/profile.json` had the same SHA-1 before and after.
  Before pass 7, `--read-only` only skipped the startup reconcile: Restart, Stop, the visibility
  segments, Tailscale re-pin and launch at login would still have written `~/.canon` or driven
  the real service. Read-only now skips and logs each of those at the controller's entry points,
  with backstops in `saveProfile` and `reconcileServiceToProfile`. No earlier pass pressed those
  rows. The disabled state of Restart and Stop (busy, or service stopped) was not driven live.
- Pass 5 tested the panel live, using a test copy launched with `--read-only`. That flag makes an
  interactive run that never writes `~/.canon` and never touches the service. The status item was
  pressed through Accessibility, Esc and ⌃⌥C were sent as key events, and window geometry was
  read with CGWindowList (panel layer 25). All of these were confirmed: open with no arrow, the second press toggles it closed, Esc, focus loss to another app, ⌃⌥C open and
  close, Settings… opens General and closes the panel, the highlighted status item while open,
  `--window`, and `--export-popover`.
  **Not exercised with a real mouse:** the outside-click path through the global monitor, and the
  right-click system menu (it needs a real right-mouse event). Both are in code but were not
  driven, so the user's pointer wasn't taken over. Focus loss covers clicks into other apps.
- Toolbar tab clicks in Settings were not screenshotted live. The settings image is a real
  window drawn off screen.
- The selected-tab pill is drawn by the app inside native toolbar item views. In both captures
  (macOS 26) it shows no system bezel or glass, but other macOS versions were not checked. The
  titlebar plus toolbar is about 5pt shorter than the mock's 91px, which is native metrics.
- The dark settings window and its pill are extrapolation: the plate has no dark window.
- In the light composite, text widths and rule positions match the design (for example, "Launch
  at login" is 118pt wide on both sides). Rows run 1–4pt shorter than Chrome's, from CSS
  line-height versus Core Text leading.
- The 1× column of the icon grid is rasterized by AppKit, not by the menu bar itself.

---

# Earlier pass (kept for history)

# Canon.app P1 — design fidelity pass

Follow-up to the initial P1 cut (`f4b9070`, `b39e099`). This pass closes the gap between the
first working build and the "Canon — Identity & Surfaces" plates (pages 06–10) and the gap
analysis, across fonts, icon geometry, the brand mark, popover chrome, Settings/General, and the
app's identity (name, bundle id, binary).

Evidence: `docs/app/fidelity/` — `popover-light.png`, `popover-dark.png` (removed in pass 6), `settings-light.png`,
`settings-dark.png` and `icon-states.png` are side-by-side composites (design plate | this
build's render, same scale), plus the real right-click `menu.txt`. Renders are from
`--export-popover` / `--export-settings` / `--export-icons` / `--export-menu` against a scratch
build at `/tmp/canon-app-p1-build/Canon.app` (`./macos/CanonBar/build-app.sh
/tmp/canon-app-p1-build/Canon.app`, exit 0). The installed `~/Applications/CanonBar.app` was
never touched.

Design-plate sources: `identity-surfaces/page06.png` (popover), `page07.png` Plate 1 (menu-bar
icon states), `page10.png` (Settings/General + "Not settings"), cross-referenced against
`design-v2/identity/page01.png`/`page02.png` for the brand mark and wordmark case. Each plate is
a full annotated board; the committed composites crop just the relevant panel before pairing it
with the implementation render. The popover and Settings plates only show a single (light-chrome
or light-content) variant — no separate dark-mode plate exists in the deck — so both the light
and dark composites pair the same design crop against the corresponding light/dark
implementation render; that is a limitation of the source deck, not of this comparison.

## Per-surface table

> Pass 13: the Settings rows in this earlier table describe the themed window of passes 1 and 2.
> Settings now follows native macOS (see the top of this file).

| Surface | Design | Implemented | Status |
|---|---|---|---|
| Wordmark / headers font | Libron serif, weight 700 | `Libron-Bold.otf` bundled, registered at launch (`FontRegistrar`, `CTFontManagerRegisterFontsForURL`, `.process` scope — never pollutes Font Book), `Theme.serifBold(_:)` | Fixed |
| Wordmark size | 20 | `Theme.serifBold(20)` | Fixed |
| "Live aliases" header | serif 17 + rule | `Theme.serifBold(17)` + 2px `Rectangle` rule | Fixed |
| Settings section headers | serif 17 + rule | same | Fixed |
| "Not settings" heading | serif, smaller | `Theme.serifBold(15)`, family swapped only | Fixed |
| Body / mono fonts | JetBrains Mono / Inter implied by plates | still system San Francisco + system monospace | **Not done** — only Libron was bundled this pass; JetBrains Mono/Inter aren't in `Resources/Fonts/` and weren't sourced. Spacing/sizes were matched by hand; the actual typeface is a system fallback. |
| Status tile "C" + 5 badge states | exact SVG geometry (18-unit space) | `StatusIconRenderer` rewritten to the plate's literal coordinates (tile, C-arc, loopback dot, tailnet ring, cloud ticks, needs-you corner dot, hollow Stopped tile) | Fixed — see note below |
| Brand mark (popover) | hand-drawn two-leaf mark, fixed colors | `CanonMark.swift`, literal `0x0f172a`/`0xf1f5f9`/`0x60a5fa`, not adaptive (correct: it only sits on the permanently-dark chrome band) | Fixed |
| Popover chrome band / visibility / endpoint | permanently dark regardless of system appearance | was wrongly adaptive; now pinned to `Theme.dark` via a dedicated `chrome` token set in `PopoverView` | Fixed (real bug) |
| Segmented visibility control colors/caption | design tokens, no italic | matched; removed stray `.italic()` | Fixed |
| Fingerprint palette | 5-color categorical | `#1d4ed8 #475569 #94a3b8 #e2e8f0 #0f172a`, `digit % 5`, applied to both `FingerprintView` and `MenuBuilder.fingerprintThumbnail` | Fixed — simplest faithful reading of "categorical by digit"; no per-digit mapping spec was available, documented as an interpretation in `FingerprintView.swift`'s header comment |
| Alias row "most recent" highlight | visible highlight | was `theme.paper` (identical to the page background → invisible); now `theme.surfaceSubtle` | Fixed (real bug) |
| Action list | reconciled against real right-click menu | added disabled `Activity ⌘2` (P2, not built — shown disabled rather than omitted) and `Quit Canon ⌘Q`, both absent from the original popover | Fixed |
| Verified/Drift pill | shown on alias rows in the plate | left out | **Blocked by Core** — confirmed via grep of `PublisherController.swift`/`Core.swift`: `AliasSummary` has no `verified`/`drift` field; a comment there notes "We don't have drift/join-request data yet (P2)" |
| Settings label column | fixed-width right-aligned grid | `row()` helper, fixed 190pt column | Fixed |
| Settings tab icon | slider/filter glyph | `slider.horizontal.3` (was a mismatched `switch.2`) | Fixed |
| Shortcut chip | fixed-size bordered chip | `70×26`, `theme.card` fill, `theme.lineStrong` border | Fixed |
| Settings buttons | flat bordered chip, no native blue bezel | custom `ThemeButtonStyle` (26pt height, radius 5, bordered) | Fixed |
| CLI installed checkmark | hand-drawn rounded-square badge | `CheckBadge` — **first pass filled it with `theme.ink`, which is a light color in dark mode and rendered a near-invisible white-on-white check; fixed to a fixed dark fill (`0x0f172a`) so the white check stays legible in both modes** (caught and fixed in this pass, see `evidence-final`/`docs/app/fidelity/settings-dark.png`) | Fixed |
| Switch control | 34×20, inset knob with shadow, correct off-color | `ThemeSwitchToggleStyle` dimensions and `theme.line` off-color corrected, knob shadow added | Fixed |
| "Not settings" body copy | `inkSecondary`, ~1.55 line-height, dividers between (not after last) item | matched; `lineSpacing(11 * 0.55)`, `padding(.vertical, 12)`, `Divider()` between items only | Fixed |
| App name / bundle id | "Canon" | `Info.plist`: `CFBundleExecutable`/binary → `Canon`, `CFBundleIdentifier` → `dev.oncanon.Canon`; `build-app.sh` default install path → `Canon.app` | Fixed. Swift source filenames (`CanonBarApp`, the `macos/CanonBar/` directory) were left unchanged — out of scope for this pass, called out explicitly in the directive |
| Reviewability without a visible status item | — | added `--window` launch flag: opens the popover content in a normal 380×560 `NSWindow` titled "Canon" | Added |

## Icon-overflow diagnosis (time-boxed, ~10 min)

Launched the scratch build and queried the live status item via Accessibility
(`System Events` → process `Canon` → `menu bar 2`): exactly one menu-bar-extra item is present,
`size = 24×24`, `position = (5382, 3)` on a `6144×2560` screen — on-screen, unclipped, with
~760px of room to its right for other extras/Control Center/clock. This is evidence the icon is
**not** hidden in macOS's overflow chevron under the current (single-display, not especially
crowded) menu-bar occupancy. It does not prove the icon is never pushed into overflow on a
narrower or more crowded bar — that would need a deliberately crowded menu bar to reproduce,
which was out of scope for the time box. The scratch instance was quit after the check;
`~/Applications/CanonBar.app` was not touched.

## Remaining documented gaps

- JetBrains Mono / Inter are not embedded — body/mono text uses the system fallback fonts.
- Fingerprint "5-color categorical" mapping is this pass's own reading (`digit % 5` over the
  given hex list); no per-digit mapping spec exists to verify against.
- Icon-overflow is evidenced, not proven, under crowded menu-bar conditions.
- Verified/Drift pill is correctly absent — blocked by Core, not a P1 oversight.
- The popover/Settings design-plate comparisons pair one light-mode plate against both light
  and dark implementation renders, since the deck doesn't plate a dark-mode variant of either
  surface (see "Design-plate sources" above).

## Commits (branch `app/p1`, no push)

- `3981de8` fonts, icon geometry, app rename, `--window` flag
- `71c3bdd` popover chrome-deck pinned to the design's permanently-dark palette
- `f5e0b07` Settings/General row layout, serif headers, custom buttons, checkmark badge fix
- `6ef4080` fidelity report and (at the time) implementation-only evidence images
- real design-plate side-by-side composites, replacing the implementation-only images above
