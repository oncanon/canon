# Canon.app → Core contract requests (from P1)

Written while building the menu-bar app's P1 scope (popover home, right-click menu, icon
states, Settings/General) against what `canon status`, `canon alias get/list`, `/healthz`, and
`canon service start/stop` already return today. Everything below is a real gap hit while
implementing that UI, not a wish list — each one maps to a specific place the design wants data
the CLI/server don't expose yet. Per the brief, the app shows honest current state or omits the
affected element rather than faking it; this list is what would let it stop omitting.

## Missing today

1. **Drift / verify-on-read state.** The design's "Verified" pill and drift banner need to know
   whether a served alias still matches its recorded content ID. `canon status` doesn't carry
   this; it would need either a cheap per-alias hash check on `status`, or a separate
   `canon alias verify <name>` the app can poll. Omitted in P1 (no pill, no drift banner).

2. **Activity feed.** The design's "Activity ⌘2" drill-in needs a reverse-chronological event
   log (publishes, restarts, visibility changes, verify failures). Nothing today exposes this;
   `service/events.jsonl` exists on disk but is undocumented as a stable interface and isn't
   something the app should parse directly. Pass 3 lists "Activity ⌘2" as page06 does, but inert,
   until this exists.

3. **Per-alias generation history.** The alias detail drill-in (P2) wants prior generations with
   their content IDs and timestamps, not just the current `generation` integer `canon status`
   returns. Needs something like `canon alias history <name>`.

4. **`canon --version` / `canon version`.** Doesn't exist. Settings' Command-line tool row shows
   only the resolved executable path, not a version string. A trivial, low-risk addition.
   *Stopgap (fidelity pass 3):* the app reads `version` from the `package.json` (name `canon`)
   beside the symlink-resolved CLI script, and the build stamps the app with the repo's
   `package.json` version, so "Same version as the app." is a real comparison. Replace with
   `canon --version --json` when it exists.

5. **Total edition count across the store.** The design's Settings mockup shows "`N` aliases ·
   `M` editions"; `canon status` only gives per-alias `generation`, not a store-wide total. The
   app currently shows only the alias count.
   *Stopgap (fidelity pass 3):* the app counts `store/packets/sha256-*` entries, a read-only
   directory listing, so the row reads "31 aliases · 68 editions". That ties the app to the
   store's on-disk layout. Please expose `editions` on `canon status --json`.

6. **Store relocation.** Settings' "Change…" button (store location) is disabled — there's no
   CLI operation to move `storeRoot` and reconcile the running service to it safely. P2/P3 per
   the brief; flagging so Core knows the Settings affordance is already in the UI, wired to
   nothing.

7. **CLI installer / self-repair.** Settings' "Reinstall…" button is disabled for the same
   reason — no supported way for the app to (re)install or repair the `canon` CLI itself. Needed
   for P3 per the phase plan.

8. **Cloud gate metadata.** The Visibility control's "Cloud…" segment is shown-but-disabled per
   the design's own P4 gate; there's currently no profile field or CLI surface for a Cloud target
   at all, so there's nothing to request yet beyond confirming the gate stays off until the maintainer
   authorizes a public target (per SOUL.md P4 note).

9. **Verified/Drift pill (follow-on to #1).** Pass 3 reserves a fixed 72pt slot on the right of
   each popover row so the pill can arrive without the layout moving. The slot stays empty until
   #1 supplies a per-alias `verify: "verified" | "drift"`. The drift card stays absent until then
   too.

## Already sufficient for P1

- `canon status` (service state, visibility, urls, aliases with name/generation/contentId/
  updatedAt/artifactSchema/title/entry/agentEntry) — drives the popover, menu, and icon state.
- `canon alias get/list`, `/healthz` — read-only, used as-is.
- `canon service start/stop` — used only by the app's own Restart/Stop/visibility actions, never
  invoked during the app's own evidence/debug export path (see `DebugExport.swift`'s
  `readOnly` controller mode).
