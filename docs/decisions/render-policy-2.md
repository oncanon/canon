# render-policy/2: the Canon 2.1 edition

Status: approved for implementation 2026-11-17 (Ivan's rulings). It refines the brief
`canon-edition-2.1-handoff/BRIEF.md`, and where the two disagree, this document wins. Both the renderer
and the verifier are built to it. The verifier never imports the renderer: it derives every value below
from the packet itself.

## R1. Versioning and scope

- `report/v1` packets built with this policy record `manifest.build.renderPolicy = "render-policy/2"`.
  `render-policy/1` is frozen. Its renderer (`src/render/html.mjs`, `variant-a.css`) and verifier rules do
  not change, so every packet sealed under it, including those already in the store, verifies exactly
  as it does today.
- The verifier picks its index.html and stylesheet rules from `manifest.build.renderPolicy`. Any value
  other than `render-policy/1` or `render-policy/2` is an error.
- SitRep site bundles (`site-bundle/v1`) stay on render-policy/1, and their verifier behaviour does not
  change.
- `canon build` / `canon brief` take `--render-policy 1|2`. The default moves to 2 only when acceptance
  (R10) passes. Until then the default is 1. The default is the one constant `DEFAULT_RENDER_POLICY`
  (`src/policy.mjs`), and moving it also arms the store admission gate (R12).
- `security-policy/1` is unchanged: the same CSP, zero scripts and no external requests.

## R2. Packet layout additions (policy/2 only)

- **`report.json`**: the canonical `report/v1` source bytes, with role `source` and media type
  `application/json`. Its SHA-256 must equal `manifest.report.sourceSha256`, and its bytes must equal the
  canonical JSON re-serialisation of their own parse. A policy/2 packet without it fails. A policy/1 packet
  that has it fails, because the inventory rules are per policy.
- **Fonts stay embedded**, as `assets/<sha256>.woff2`, referenced from the stylesheet as
  `url("./<sha256>.woff2")`. Policy/2 embeds six faces: Libron 400, 400 italic, 700 and 700 italic, and
  JetBrains Mono 400 and 700 (OFL, licence kept under `src/presentation/fonts/jetbrains-mono/`). There is
  no shared font store. The sans face is the system UI stack, which is not embedded.
- Everything else is as in policy/1: `index.html`, `report.md`, one `assets/<sha>.css` and the evidence
  files.

## R3. Block numbers (`b-nn`)

The numbering rule is part of the `report/v1` spec (phase1-contract D4).

- **One sequence for the whole document**, in this order: every entry of `summary.paragraphs`, then every
  entry of `sections[i].blocks` for each section in order, then every entry of `appendices[i].blocks` for
  each appendix in order.
- **Every top-level block counts, whatever its type.** These do not count: blocks nested inside a
  finding's `detail`, the verdict, `summary.metrics`, section ledes, evidence items and provenance.
- The n-th counted block is `b-` followed by n zero-padded to two digits: `b-01` … `b-99`, then `b-100`.
- In index.html each counted block carries exactly one margin anchor:
  `<a class="b-anchor" id="b-NN" href="#b-NN" aria-label="Block b-NN">b-NN</a>`. The anchors appear in
  document order. No other element may have an id matching `^b-[0-9]+$`.
- report.md does not carry b-nn. It stays byte-identical to what policy/1 emits for the same source.
- The verifier parses `report.json` and counts the blocks itself, with its own code. It then requires the
  index.html anchors to be exactly `b-01 … b-N` in order, with N equal to its own count.

## R4. `report/v1` additive field

`decision.alternatives[i].recommended` is an optional boolean. At most one alternative per decision may
set it. It is the "→ Recommended" option in policy/2. When it is absent, no option shows the arrow. The
field is ignored by policy/1 and by report.md, so report.md bytes do not change. Validation rejects
`recommended: false` (leave the field out instead) and more than one recommended alternative.

## R5. Page structure (policy/2 index.html)

Order inside `body`:

1. `a.skip-link` → `#content`.
2. `header.masthead` (slate band): the UI lockup (outlined inline SVG, `aria-hidden`, followed by the
   visually hidden text "Canon"), `span.masthead__slug` containing the report id, and
   `nav.formats[aria-label="Edition formats"]` with exactly three links: `index.html`
   (`aria-current="page"`), `report.md` and `manifest.json`.
3. `div.layout` → `main#content.document` and then `aside.rail`. The rail comes **after** main in source
   order, so CSS never has to reorder it.
   - `main` holds:
     - `header.title-block`: the kicker, `h1`, the subtitle;
     - `dl.meta-strip`;
     - `section#summary`;
     - `section.section` for each report section;
     - `section#evidence`;
     - the appendix sections.
   - `aside.rail[aria-label="On this page"]` holds `nav.rail__toc` with an `ol` whose entries mirror
     every `main > section[id]` in order, and `div.rail__evidence` with an `ol` of the evidence items.
4. `footer.colophon` (slate band):
   - "Sealed by Canon";
   - the report source digest in full, with its first 8 hex digits wrapped in `b`;
   - the sentence saying the content ID is in the address and in `manifest.json`;
   - links to `report.md`, `manifest.json` and `checksums.json`;
   - the provenance sources and notes;
   - `canon verify <packet-dir>`;
   - the display lockup on a 2 px rule;
   - the generator line
     `canon <ver> · render-policy/2 · security-policy/1 · zero scripts, zero external requests`.
   There is no `section#provenance` in policy/2: its content lives in the colophon.

Components follow BRIEF §2 and §3:

- **Findings:** severity pips and the word; exactly one confidence chip (✓ Proven, → Recommended,
  ✕ Defect, ? Open); the meta line `<id> · <verification band> · <detail>`.
- **Risks:** a run of consecutive risk blocks renders as one ruled `table.risk-table`, sorted by
  likelihood × impact (descending, stable). Each row keeps the risk's `r-` id.
- **Decisions:** ruled rows, with `→` on the `recommended` alternative and an ink stamp "Chosen" on the
  `chosen` one.
- **Requirements:** a neutral EARS tag, `WHEN`/`IF`/`THEN` in bold mono, and `MUST`/`MUST NOT`/`SHOULD`
  as ink outline chips.
- **Today / Proposed:** ink 1 px versus cobalt 2 px.
- **Plates:** the existing SVG renderer, byte-identical geometry. Only the frame, caption and CSS palette
  change.
- **Code figures:** the same highlighter, a new frame and a caption below the box.
- **Evidence entries:** ruled rows with the excerpt in a closed `details`.
- No "Epistemic & severity legend".
- No "Decision requested" card, because report/v1 has no field for it (BRIEF §6).
- No margin note, for the same reason.
- Verifier refinements:
  - Hiding markers are accepted only where html-v2 emits them (`HIDING_PLACEMENT_2` in
    `src/packet/verify.mjs`). These are `aria-hidden` (only `"true"`), `visually-hidden`, `skip-link`,
    `stamp` and `svg.lockup`. `svg.lockup` and its presentation attributes belong in
    `span.masthead__brand` and `p.colophon__mark` only. A marker anywhere else could hide report content.
  - `<meta name="generator">` reads exactly `<tool> <version>; render-policy/2; <securityPolicy>`, taken
    from `manifest.build`.

## R6. Stylesheet (policy/2)

- **Tokens:** the v2 base tokens plus BRIEF §4 and `canon-2.1-signals.css`, including
  `--chrome-band`, `--chrome-band-ink` and `--chrome-band-line`. Every new token has a dark value or
  follows a token that flips.
- **Retired:** `--sev-high-*`, `--sev-med-*`, `--sev-info-bar`, `--open-*`, `--vband-review-*` and
  `--rfc-*` are absent from the policy/2 stylesheet. The retired hex values `#c2410c`, `#ca8a04`,
  `#9a3412`, `#854d0e`, `#7e22ce`, `#6b21a8` and `#3730a3` do not appear in it. `--open-*` means the
  policy/1 open-question family (`--open`, `--open-bar`, `--open-bd`, `--open-bg`, `--open-ink`);
  `--open-bd-style` is the BRIEF §4 token that replaces it and is not retired. The verifier scans the
  stylesheet text, comments included.
- **Dark bands:** a dark background (`var(--chrome-band)`) is allowed only on `.masthead` and
  `.colophon` and their descendants. Every text colour used on those bands must reach at least 4.5:1
  against `--chrome-band`, in both schemes. Elsewhere the policy/1 contrast rules apply. Body text tokens
  must reach at least 4.5:1 against the document backgrounds in both schemes, including the 11 px meta
  lines.
  - Verifier refinement: on band selectors `color` must be a band ink (`--chrome-band-ink`, `-muted`,
    `-accent`) and `background` a band surface (`--chrome-band`, `-current`) or none, and every band
    ink must reach 4.5:1 against both band surfaces. In the markup, only band classes may sit inside
    `header.masthead` and `footer.colophon` (plus the RFC 2119 chip and cite of authored provenance
    notes in the colophon, which the stylesheet must recolour with `.colophon .rfc2119` and
    `.colophon a.cite`), and band classes may not leave their band.
  - Every document text ink (including the code and syntax inks) reaches 4.5:1 against every document
    and code surface, the gate ink against the gate surface and the stamp ink against the stamp, in
    the light, dark and print schemes. This is stricter than policy/1's 3:1.
  - Non-text contrast (WCAG 1.4.11): `--pip-on` and `--pip-critical` reach 3:1 against `--pip-off` and
    `--card`, and `--sev-bar-critical`, `--sev-bar-high` and `--sev-bar-medium` reach 3:1 against
    `--card`, in the light, dark and print schemes. `--sev-bar-low` is exempt (Captain's ruling,
    review MINOR 6): the brief makes the low bar a deliberate hairline (`#cbd5e1`), and the
    severity word and pips carry the meaning. Tampering with it in a sealed packet is caught by the
    reproduction step, which byte-compares the stylesheet.
- **Amber** (`--svg-gate`, `--svg-gate-bg`) only on gate selectors: `.svg-node--role-gate`, the
  `--gate` edge and pill classes, and `.badge--gate`.
- **Plate palette:** `.svg-node--role-store` and the other layer accents use ink, never purple. Only
  `role-gate` nodes are amber.
- Layout uses flex: `.document { flex: 999 1 600px }` and `.rail { flex: 1 1 250px }`. At narrow widths
  the rail wraps under the column. There is no `.toc` in policy/2.
- The policy/2 verifier holds its own strict allowlists (elements, attributes, selector parts,
  properties, custom properties, media preludes) for exactly this markup and stylesheet. It is no looser
  than policy/1 in any rule that isn't named in this section.
- Cite runs, part of the phone-width overflow fix (2ca03ac; review 4 MINOR 1), are pinned exactly:
  - `.cite-run { display: inline-block; max-width: 100% }`;
  - `.table__scroll .cite-run { white-space: nowrap }`.
  - Any other rule whose selector names `.cite-run` is refused by the independent rules alone. That
    covers another selector, another at-rule context, another property and another value.

## R7. Compile-time lint (`canon build` warnings)

- **Reserved display prefixes:** `F` (findings), `D` (decisions), `R` (risks), `E` (evidence) and `b-`
  (blocks). Authored prose that uses `<prefix><digits>` as its own identifier gets a warning that names the
  prefix and the first few occurrences. Citations (`{cite}` segments) are excluded. Authored IDs are never
  renamed.
- Warnings are printed to stderr, and are listed in the build receipt under `warnings`. They never fail a
  build.

## R8. `reissueOf`

- A re-typeset of an existing edition from the same source: `canon build <report.json> --reissue-of
  <packet-dir>` (and the same on `canon brief`). The build first verifies the old packet. It then assembles
  the new packet and refuses, before writing anything, unless the new packet holds every relation
  `canon verify --reissue-of` checks (below): equal source digests, byte-identical `report.md` and the
  same evidence inventory. So a sealed `reissueOf` never fails its own verify. It records
  `manifest.report.reissueOf = <old contentId>`.
- `reissueOf` is a policy/2 manifest field: `--reissue-of` needs `--render-policy 2` (otherwise a usage
  error), the verifier accepts it only in a render-policy/2 manifest and only as a content ID other than
  the packet's own, and a render-policy/1 manifest that carries it fails as an unknown key. The old
  packet may be of either policy; re-typesetting a policy/1 edition as policy/2 is the expected case.
- `canon verify <new> --reissue-of <old-dir>` verifies both packets and then checks:
  - the content ID relation;
  - equal source digests;
  - byte-identical `report.md`;
  - the same evidence inventory (paths and digests).
  It exits non-zero on any mismatch.
- `reissueOf` is distinct from `supersedes` (v3, content changed). A reissue claims "same words, new
  type".

## R9. Constraints that hold throughout

- The sealed page never contains its own content ID: there is no `/p/sha256-…`, no fingerprint and no
  "Verified" stamp.
- URLs (Captain's ruling, review MAJOR 4):
  - `http(s)://` URLs may appear as text, in code, prose and tables, as in policy/1.
  - In an attribute, an `http(s)://` URL is accepted only as the `https:` href of an authored `ext`
    link whose `rel` contains `noopener` and `noreferrer` (as in policy/1). Any other attribute that
    carries a URL fails verification.
- Verifier refinements:
  - Attribute values are checked decoded.
  - The page may use no character reference other than the five the renderer emits (`&amp;` `&lt;`
    `&gt;` `&quot;` `&#39;`).
  - The page's own content ID cannot appear by construction (the ID digests the manifest, which digests
    `index.html`), so the verifier needs no check for it. An authored mention of a `/p/sha256-…` route
    (say, in a code sample) is content, not the page's address.

## R11. Verify = independent rules + reproduction (Captain's ruling, review MAJOR 1/2)

- The independent rules (`src/packet/verify.mjs`, which imports nothing from the builder or renderer)
  cannot tie the page's words to `report.json`. So for a render-policy/2 packet, verification has two
  parts, and both must pass:
  1. the independent rules;
  2. reproduction (`src/packet/reproduce.mjs`).
- Reproduction works as follows:
  - It parses `report.json` and validates it as report/v1. A schema-invalid source fails.
  - It rebuilds `index.html`, `report.md` and the stylesheet from that source. Evidence bytes come from
    the packet's own evidence files, and renderer inputs come from the shipped defaults (stylesheet,
    fonts, lockups).
  - It renders with the packet's recorded `manifest.build` values (tool, version, security policy), so
    the generator meta and colophon line match.
  - It requires byte equality for every file and for the manifest identity (everything except
    `contentId`), and for `checksums.json`.
  - Any difference is a `reproduction` finding that names the first differing file.
- Every place a packet is verified runs both parts:
  - `canon verify`;
  - `canon brief`;
  - publication: the filesystem publish, staged and read-back checks, and the publication protocol and
    its filesystem adapter;
  - alias set;
  - the local server's read path. The packet origin (`src/origin/`, ADR 0002) serves stored bytes and never
    verifies: its import closure holds no verifier, builder or renderer (`test/unit/aws-origin-image.test.mjs`);
  - archiving;
  - the old packet of a `--reissue-of` build.
- `canon verify <new> --reissue-of <old>`: both packets pass their full verify. The new packet's
  rebuilt `report.md` must be byte-identical to the old packet's `report.md`, and the evidence
  inventories must be equal. The build runs the same relation checks before it seals.
- Build metadata (Captain's ruling, review 2 MAJOR A): reproduction renders whatever `manifest.build` claims, so the
  independent rules constrain it for render-policy/2, and the builder refuses the same values:
  - `build.tool` is exactly `canon`;
  - `build.securityPolicy` is a known security policy (`SECURITY_POLICIES` in `src/policy.mjs`, today
    `security-policy/1`);
  - `build.version` is a strict semver 2.0.0 core `MAJOR.MINOR.PATCH`: decimal numbers with no leading
    zero (a lone `0` is allowed), and no pre-release or build suffix
    (`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$`). It is not pinned to the current release, so
    packets from older releases keep verifying. The builder imports the verifier's pattern.
- Renderer inputs (review 3 MINOR 2): reproduction rebuilds from `reproductionRenderInputs()` in
  `src/packet/build.mjs`, which reads the shipped stylesheet, fonts and marks directory. For
  render-policy/2, `assemblePacket`, and so `buildPacket`, compares its stylesheet, fonts and lockups
  by value with that same object. It refuses any difference with `render-inputs`. The set compared is
  that object's keys. The refused cases include a `stylesheetBytes` override, a `marksDir` holding
  other lockups, and missing or changed fonts. So the builder never seals a policy/2 packet that its
  own verify rejects. `test/unit/rp2-build-reproduces.test.mjs` crosses every option and requires each
  accepted build to pass `verifyPacketFull`. A lockup packet that verifies can come only from a tree
  that ships the lockups (`test/tree/shipped-tree.mjs`). The tool values are not refused beyond the
  build-metadata rules, because reproduction renders with the recorded ones, so any value those rules
  accept reproduces.
  - **Known limit:** render-policy/1 is frozen, so a policy/1 manifest's `build` keeps its old laxity. The
    verifier checks only its keys there.
- **Consequence:** once released, render-policy/2's output for a given source is frozen. Any rendering
  change, including the stylesheet and the brand lockups, needs render-policy/3, exactly as for
  policy/1.

## R12. Store admission: new packets must be policy/2 (Captain's ruling, review 2 MAJOR B)

- **The ruling.** "New ones must be policy/2". Packets and aliases that already exist keep working as
  they are. Once the default switches, publishing a newly built render-policy/1 packet into a store is
  refused unless the operator gives an explicit override.
- **One constant.** `DEFAULT_RENDER_POLICY` in `src/policy.mjs` is both the build default (`canon build`,
  `canon brief`, `buildPacket`, `assemblePacket`) and the switch that arms the gate
  (`src/publish/admission.mjs`). Today it is `render-policy/1`, so the gate is dormant: it admits
  everything and records nothing, and every receipt keeps its closed field set. When R10 acceptance
  moves the constant to `render-policy/2`, the gate goes live in the same change.
  `TOOL.renderPolicy` is not the default. It is the value the frozen policy/1 renderer and site-bundle/v1
  print, and it never moves.
- **What is gated: store admission only.** Admission is the moment a packet enters a store:
  - `publishPacket`, which covers `canon publish` and the publish step of `canon brief`;
  - the publication protocol's `publish` (`canon publish --target`), checked from the local manifest
    before any store or provider request, and in a dry run too;
  - the fs adapter's commit. Its `putIfAbsent` of `manifest.json` is what triggers the commit, so the
    check runs there, on the manifest bytes, before they are staged. A refused packet stays uncommitted,
    and a rerun with the override commits it.
  - The gate refuses a verified `packet/v1` whose `manifest.build.renderPolicy` is `render-policy/1`.
    The error code is `render-policy-refused` (a V1 `PublishError` and a V2 `PublicationError` alike).
- **The override.** `--allow-render-policy-1` has the same name on `canon publish`, `canon brief` and
  `canon publish --target`. In the libraries it is the `allowRenderPolicy1` option: of `publishPacket`,
  of the protocol's `publish`, and of `fsAdapter` / `adapterFor`. The fs store's gate is its own, so a
  library caller that allows the protocol but builds the adapter without the option is still refused at
  the commit. The CLI passes the one flag to both.
  - A publish admitted only because of the override records it. In the receipt/v1 of `canon publish`
    and `canon brief`, and in the protocol's receipt/v2, it is
    `admissionOverride: { flag: "allow-render-policy-1", renderPolicy: "render-policy/1",
    defaultRenderPolicy: "render-policy/2" }`.
  - The key appears only then. While the gate is dormant, the flag is accepted, changes nothing and
    records nothing.
- **What is not gated, and why.**
  - Alias set, `promote` and `rollback` point an alias at a packet that is already in the store. Every
    packet in a store was admitted, either before the switch or with the override. Gating aliases
    would therefore buy nothing against new policy/1 packets, and would break the rollback to an older
    policy/1 generation that the ruling keeps. So rollback, the 66 packets in the store and their
    aliases all keep working.
  - Serving, verifying and archiving admit nothing. The packet origin (ADR 0002) neither verifies nor
    admits.
  - `site-bundle/v1` is not a report/v1 packet. Its manifest also names render-policy/1 (R1), and
    `admittedRenderPolicy` answers `null` for it, so SitRep publishing is unchanged.
  - `canon build --render-policy 1` still builds. Building is not admission.
- **Known limits.**
  - **Forgery stays possible.** A render-policy/1 packet does not carry its source (`report.json`), so
    its words are not tied to anything by reproduction (R11). render-policy/1 is frozen, so its
    verifier rules cannot be tightened. Every policy/1 packet admitted before the switch, or later
    with the override, therefore keeps that weakness, and an alias may still point at it. The gate
    stops new policy/1 packets from entering a store silently; it does not make old ones trustworthy.
  - The gate is a guardrail for the operator, not a boundary against the operator. Anyone who can run
    the CLI can pass the override, and the receipt records that they did.
  - Provider stores (the Cloudflare worker, AWS) do not verify, so the protocol's check is their only
    gate. A client that writes to them without the protocol was never bound by any verifier.
  - **SitRep forgery stays possible.** The Captain ruled on review 3 MINOR 3: "Document now, fix later".
    A site-bundle/v1 SitRep has no reproduction. A bundle resealed with changed words passes
    `canon verify-site` and publish, needs no flag, and can take an alias (the reviewer's `sf2` repro).
    The admission gate exempts site bundles by design. SitRep reproduction will come as a separate
    follow-up change after the 2.1 renderer ships. This work leaves the SitRep verifier
    (`src/site/verify.mjs`) untouched.
- **Binding tests.**
  - `test/unit/rp2-admission.test.mjs` runs `test/admission/gate-driver.mjs` twice: on this tree, where
    the gate must be dormant, and on a copy with only the constant flipped to render-policy/2, where
    the gate must be live. The copy run also proves that the constant moves every build default.
  - Red controls RV83 onward.
- **Checklist for the flip.** This is the change that moves `DEFAULT_RENDER_POLICY` to render-policy/2
  after R10 acceptance. The list comes from a full `npm test` run on a copy of edition-2.1 with
  only the constant flipped, taken after the review 3 fixes, on 2026-11-18. That run had 1107
  tests: 1067 pass, 39 fail, 1 skipped. The failures fall into six causes. The flip change must
  clear every item below, and none needs a ruling. Re-run the flipped suite at that time, because
  later changes move this list.
  1. **The constant's own tests (3).**
     - `rp2-admission`: the dormant and live tests. At the flip their roles swap: this tree is
       live, and the copy tree is the dormant one.
     - `red-controls-anchors`: RV107's find is the constant's declaration.
  2. **Tests that take the default build to be render-policy/1 (12).** Each one pins a policy/1
     content ID, policy/1 markup or policy/1 file counts. Pass `renderPolicy: 'render-policy/1'`
     where the test is about policy/1, or re-pin it where it is about the default.
     - `rp2-build`: both `[R1-DEFAULT]` tests, `[R2-MD]` and `[R4-RECOMMENDED]`;
     - `site-build`: `[SITE-S3]`;
     - `v2-schemas`: `[V2-1]`;
     - `p16-receipts`: `[P16]`;
     - `p17-markdown`: `[P17]`;
     - `p9-fingerprint`: the `[P9]` Libron fonts test;
     - `canon-v2-sitrep`: `[R16-DEFECTS-NEG]`, `[R17-DEFECTS-NEG]` and `[R18-DEFECTS-NEG]`. Their
       mutations target policy/1 markup in a packet built with the default.
  3. **Knock-on from `[V2-1]` (11).** These are in `red-controls-harness`: five `[V2-QA-5]` and six
     `[PERF-1]` tests. They use control R90, whose test file is `v2-schemas`, so its baseline is
     red. They clear when `[V2-1]` does.
  4. **render-policy/2 builds from renderer inputs that are not shipped, refused since review 3
     MINOR 2 (7).**
     - `p6-alias`: five `[P6]` tests. They build with a `stylesheetBytes` override.
     - `p9-fingerprint`: the asset-mutation test.
     - `p1-source-boundary`: `[P1]` markup. It calls `assemblePacket` with `body{}` and no fonts.
     - Before MINOR 2, the six P6 and P9 tests sealed a packet that verify rejected. Now the build
       refuses it with `render-inputs`. They do not clear by themselves. Their subject (the store,
       fingerprinting, escaping) does not depend on the render policy, so they should pin
       render-policy/1.
  5. **render-policy/1 assumptions in tests (5).** Each of these tests takes policy/1 behaviour to be
     the default.
     - Two of them build a packet they mean as policy/1 with the default. Pass render-policy/1
       explicitly.
       - `rp2-lint-lockup`: `[G-LOCKUP]`, for "policy/1 never reads lockups";
       - `rp2-verify`: `[RV-R8]`, for "the old packet … is not policy/2".
     - The other three use the shared anchor gate, `anchorProblems` in `test/agent-md-gates.mjs`:
       - `e8-agent-md`: two `[E8]` item 2 tests;
       - `canon-v2-design`: `[Canon-v2] builds, seals, verifies…`.
     - That gate accepts block ids only on policy/1's elements: `section`, `article`, `figure`,
       `div.table` and `li.ev`. The policy/2 page has every anchor. Built as policy/2, the fixture
       and the v2 specimen have each `report.md` definition as an HTML id (29 of 29 and 39 of 39).
       The extra element kinds are `tr` (the rows of the risk table, `r-R-n`) and
       `div.colophon__provenance` (`provenance`).
     - Fix: make the gate's element set depend on the render policy, derived from the renderer, and
       keep the anchor-parity check itself.
  6. **Phone-width layout (1): cleared.** `canon-v2-design` `[Canon-v2 Adv-6]`: the page was 1116 px
     wide in a 390 px viewport on the max-schema stress input. r2-renderer's overflow fix (2ca03ac)
     clears it: a flipped copy at review 4 passes Adv-6. The three cause-5 anchor-gate tests in
     that copy still fail as listed.

## R10. Acceptance (on a large real report)

1. Policy/2 rebuild:
   - the source digest is `89de4fc6…`;
   - `report.md` and all seven evidence files are byte-identical to generation 3 (`0aecb41b`);
   - only index.html and the assets differ, and `report.json` is added;
   - the content ID is new.
2. The page does not contain its own content ID. No attribute carries an `http(s)://` URL except an
   authored `ext` link's href (URLs as text are allowed, per R9). The CSP is unchanged.
3. Lint:
   - no retired hex values;
   - the b-nn anchors match the verifier's count;
   - every finding has exactly one confidence chip;
   - amber appears only on gate selectors;
   - the reserved-prefix warnings fire for the collisions that are actually present, and are reported
     as found.
4. Visual parity per component with `comp/what-changes.html`, in both schemes, at 390 px and 1280 px.
   Plates match the live geometry exactly.
5. All 61 stored packets and every SitRep still verify exactly as before.
