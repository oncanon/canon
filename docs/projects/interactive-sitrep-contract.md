# Interactive SitRep: the Publisher half of the shared contract

Status: **Revision 4 (2026-10-25 maintainer rescope): static `site-bundle/v1` only; interactivity decoupled to an external conversational runtime.**
Base: `main` 67ca9e7.

**Revision 4 (2026-10-25, maintainer decision).** Interactivity is handled separately from SitRep generation via an external conversational runtime rather than a bespoke Publisher form shell (`shell/v1`) or `/p/<contentId>/act/<decisionRef>` action routes. Accordingly:
- Publisher's scope is **pure static multi-page `site-bundle/v1` generation and verification (slices S1–S4)**: `site-input/v1` validation, multi-page HTML + CommonMark/GFM parity, deterministic `contentId`, and `manifest.json` structural metadata (`edition`, `pages[]`, `anchors[]`, `decisions[]`).
- `shell/v1` (slice S6), reserved `act/<decisionRef>` routes, `data/decision/<decisionRef>.json` sidecar files, the shell-less card disclaimer sentences, and the server 404 action-route special case (slice S5) are **removed from scope**.
- Decisions and questions render as static, addressable blocks (`#d-<decisionRef>`, `#q-<questionRef>`) in HTML and Markdown, and `manifest.json` exports `decisions[]` descriptors (`decisionRef`, `kind`, `page`, `anchor`, `questions[]`) so external interactive runtimes can bind conversation and directives to exact `(contentId, editionId, page, anchor)` coordinates without mutating bundle bytes.

**Earlier history (revisions 1–3).** The Producer (the system that produces editions) agreed sections 1 to 5 and the shared semantics at revision 2,
commit 7200a12, on 2026-10-12 at 21:51Z, after a full read. The Publisher lead
recorded it at 21:52Z. Revision 3 recorded that agreement and the Producer's four remaining answers.

**The change rule.** Sections 1 to 5 change only with the agreement of both leads, the Publisher lead and the Producer
lead, recorded here as a new revision that names who agreed, when and at which commit. Sections 6 to 8 are Publisher's
plan and may be revised by the Publisher lead alone, as long as they stay inside sections 1 to 5.

History of this document: revision 1 (6bf2294) was the first draft. Revision 2 (7200a12) applied the Producer's review and
turned the fourteen open questions into contract text, each marked with who answered it.

Sources, cited and not restated:
- **[SEL]** The maintainer's selected design, 2026-10-11 17:16Z (`sitrep-site-selected-design-20261011.md`): option B, no application
  login on the protected network, decision-level answers first, element feedback planned.
- **[DES]** the design it amends (`sitrep-site-design.md`, sha256 prefix aef2d7ab).
- **[PROD]** The Producer's five inputs. They are merged here; this is the
  one document, and there is no parallel specification.
- **[REV]** The Producer's review of revision 1: answers 1 to 10 and its
  consistency edits. Cited as "Producer, answer N".
- **[DSO]** The site design owner's answers to questions 11 to 14 (relayed by the lead,
  2026-10-12 21:42Z). Cited as "design owner, answer N".
- **[AGR]** The Producer's agreement and its four remaining answers (2026-10-12 21:51Z; relayed by the lead,
  21:52Z). Cited as "Producer, agreement N".

Ownership is fixed by [SEL]. Publisher owns the reading views, anchors, HTML/Markdown parity, local assets and a
separately versioned interaction shell. The Producer owns the registry, the edition binding, eligibility, the submission adapter,
the journal, the worker, routing and receipts. **Every wire type that carries an answer, a receipt or a reason is the Producer's**
and is quoted from [PROD] as proposed; Publisher defines no second list of states or reasons.

## 1. Identities

| Identity | Owner | How it is derived |
|---|---|---|
| `contentId` | Publisher | `sha256-<64 hex>` of the canonical manifest without its `contentId` member, as today (`src/packet/build.mjs:207-228`, re-derived independently in `src/packet/verify.mjs`). It is **never inside** the content it names. |
| `editionId`, `editionDigest` | Producer | [PROD] §1: the report slot identity, and the 64-hex hash of the screened EditionRecord representation that admission uses. Publisher copies both from the site input into the bundle and shows them on every page. It never computes or interprets them. |
| page ID | Publisher | The page's directory path inside the bundle (section 2), built only from refs in the site input. Never from a title. |
| `decisionRef`, `questionRef`, `itemRef`, `areaRef`, `projectRef`, `gapRef` | Producer | [PROD] §1: edition-scoped, stable and opaque. The Producer generates each to fit Publisher's existing id rule, `^[A-Za-z][A-Za-z0-9-]{0,63}$`, unique ignoring ASCII case (`src/report/validate.mjs:20,51`), because Markdown anchors match case-insensitively. The Producer maps its domain keys to refs once, in the projection, and keeps the inverse mapping private. **A ref never encodes routing authority** (Producer, answer 1). |
| `optionRef` | Producer | A mapped ref, stable within its question, that the Producer resolves server-side to the exact original option ID. It follows the same id rule and is unique within its question. The original option IDs keep their own grammar (underscores and dots are allowed there), never enter the site input, and are never constrained by Publisher (Producer, answer 2). |
| element anchor ID | Publisher | A fixed prefix plus a ref, extending the one table both renderers already share (`src/render/anchors.mjs`): `d-<decisionRef>`, `q-<questionRef>`, `i-<itemRef>`, `a-<areaRef>`, `g-<gapRef>`, and the existing `f-`, `r-`, `tbl-`, `chart-`, `code-`, `ev-`. |

**Same anchors in HTML and Markdown.** HTML carries the anchor as an element `id`. Markdown carries it as a reference
definition `[id]: #id` under the heading (`src/render/markdown.mjs:16`, contract D10). The bundle manifest lists every
anchor with its page and kind, so a target can be checked without parsing a page.

**The binding.** [PROD] §1's record `{schemaVersion, contentId, editionId, editionDigest, decisions[]}` is a **sidecar
record made after the build**, not a builder input: it contains `contentId`, which does not exist until the bundle is
hashed. The builder receives `editionId`, `editionDigest` and `decisions[]` inside the site input, and never the final
`contentId` (Producer, answer 3).

The Producer writes the binding only when **both** of these hold (Producer, answer 4):

1. Publisher's `receipt/v1` for `operation: "publish"` (`src/receipts.mjs`) reports success. It carries `contentId`,
   `manifestSha256`, `fileCount`, `totalBytes` and the `readBack` result, and is written only after staged bytes verify
   and published bytes read back equal (`src/publish/filesystem.mjs`). The receipt allowlist is closed and gains no
   edition field.
2. `reader.openContent(contentId)` (section 4) succeeds, and the Producer has compared its result with its own projected input:
   the manifest hash, the edition fields and every action descriptor.

The receipt alone is not enough: the binding must rest on the same reader contract that serves the bundle. Each
`decisions[]` entry in the binding names **all** of that decision's original sources, and every source has its own
outcome in the receipt ([REV], consistency edits). The sources are the Producer's private data and never enter a bundle.

**The generic target descriptor** serves the first decision slice and later element feedback:

```text
{ schemaVersion: 1, contentId, editionId, kind: "decision" | "element", ref }
```

`ref` is a `decisionRef` for a decision and an element anchor ID for an element. For a decision it is exactly [PROD] §4's
`target: {contentId, editionId, decisionRef}`. The Producer owns this wire type. Publisher's guarantee is narrower: every `ref`
the shell can send is listed in the verified manifest of `contentId`. A CSS selector, selected text or a label is never
part of it ([SEL]).

## 2. Site input and bundle

**A new input schema beside `report/v1`, not an extension:** `site-input/v1`, projected by the Producer from EditionRecord
([PROD] §2). Why not extend `report/v1`: a report is one document, and `packet/v1` is fixed by its verifier to exactly
`index.html`, `report.md`, hashed assets and evidence (`PATH_RULES`, `src/packet/verify.mjs:13-18`). Extending either
would change what every existing packet may contain. A new schema leaves `packet/v1` and `security-policy/1` untouched.

Publisher defines only what it needs to render:

- `edition`: `editionId`, `editionDigest`, observation time, coverage window.
- `registry`: its version and sha256, shown in the footer.
- `areas[]`, each with `projects[]`: refs and titles, **in the order to show them**.
- `items[]`: `itemRef`, `areaRef` or null, `projectRef` or null, title, observed age, and display blocks in the existing
  `report/v1` block grammar, so the existing renderers and limits apply.
- `decisions[]`: `decisionRef`, `label`, `kind`, `itemRef`, and `questions[]` with `questionRef`, question text,
  `options[]` (`optionRef`, label, summary), the recommendation, whether free text is allowed and its limit, and evidence
  refs. A decision with several questions is **one indivisible unit**: one card, one form, one submission.
- `evidence[]`: screened display and link data in the existing evidence shape.
- `gaps[]`: `gapRef`, kind and text, including decision-coverage loss.
- `areas[].counts` (Producer, answer 10): `waiting`, `moved` and `blocked`, each `number | null`; `coverage`, one of
  `complete`, `partial`, `unavailable`; and `gapRefs[]`, a closed list of refs into `gaps[]`. The Producer computes every number
  and defines the counting unit in its projection, so original waiting items and grouped decisions are never mixed.
  Publisher adds, estimates and derives nothing: no totals, no utilisation figure.
- `areas[].counts.unit`: the counting unit's wording, **written and screened by the Producer**, which Publisher shows beside the
  numbers as text and never rewords (Producer, agreement 3).
- `history[]`, optional (design owner, answer 11): earlier editions as `{ editionId, contentId, observed time }`, in the
  order to show them. A `contentId` here comes **only from a verified prior binding record**. None exists yet, so the
  first slice **omits** history; it is never fabricated (Producer, agreement 4).

Rules:
- **Order is the input's.** Publisher renders arrays as given and never sorts by title, time or count.
- **No derived mapping.** An item with a null `areaRef` renders on the page `area/unassigned/`, titled "Unassigned:
  mapping needed", with its named gap. It never disappears and is never guessed from a name ([DES], [PROD] §2).
- **Unavailable is not zero.** `null` renders as "not recorded". `0` is a measured zero and renders as "0". Under
  `coverage: "partial"` every number is labelled "partial", and under `"unavailable"` the card says so and links its
  gaps.
- **One bundle per edition, immutable** (design owner, answer 11). History is a list of links to earlier bundles, each
  bundle unchanged. There is no merged history page in the first slice.
- **One reading order** (design owner, answer 13). On the item page, in HTML and in Markdown, a decision reads: question,
  options, recommendation, evidence, and only then the action link. The shell keeps the same order above its answer
  control, on a phone as on a laptop.

**What Publisher emits: `site-bundle/v1`.**

| Path | Content |
|---|---|
| `index.html`, `index.md` | Portfolio: one card per area. |
| `area/<areaRef>/index.html`, `.md` | Area: decisions waiting, movement, blocked, gaps. |
| `area/<areaRef>/project/<projectRef>/index.html`, `.md` | Project section, where the input records one. |
| `item/<itemRef>/index.html`, `.md` | Item: the exact question, options, recommendation and evidence. |
| `data/decision/<decisionRef>.json` | Canonical JSON of that decision's display data, for the shell. |
| `assets/<sha256>.css`, `.woff2`; `evidence/<sha256>.<ext>` | As in `packet/v1`. |
| `manifest.json`, `checksums.json` | The inventory, plus `edition`, `pages[]` (page ID, both files, title, parent), `anchors[]` (anchor, page, kind) and `actions[]`. |

No file may exist under `act/`: that prefix is reserved for the action route (section 3), and the bundle verifier
refuses a bundle that has one.

Navigation is plain relative links between pages of the same bundle, each naming the target's manifest path in full
(`item/<itemRef>/index.html`), because only manifest-listed paths are served and a directory URL below the bundle root
is not a page (`src/server/server.mjs:105-106`). A history link leaves the bundle for a sibling one, by the same
derivation: `../` once per directory of the linking page, once more, then `<contentId>/index.html` (or `index.md`).
That is the only link form allowed to leave a bundle. The store layout and alias code do not change: a
bundle lives at `packets/<contentId>/`, and "latest" is an `alias/v1` record moved by compare-and-swap
(`src/alias/alias.mjs`). Reading pages are served with today's headers and CSP, unchanged (`SECURITY_HEADERS`,
`src/server/server.mjs:28-36`).

## 3. Interaction shell

**Inert in the reading views.** A decision card is static markup: no `form`, `input`, `button` or script, exactly as
`packet/v1` forbids. What marks it actionable is data: an `actions[]` entry in the manifest (`decisionRef`, `kind`, page,
anchor, its questions and option refs, the free-text limit), and one relative link on the card.

**The action link** (Producer, answer 6; revision 1 had this wrong). There is one action route per decision, at the bundle
root: `act/<decisionRef>`, served as `/p/<contentId>/act/<decisionRef>`. It is **reserved and names no file**. A page
is not at the bundle root, so the bare text `act/<decisionRef>` on `item/<itemRef>/index.html` would resolve inside
that directory. Publisher therefore derives the link from the linking page's own manifest path: `../` once per
directory in that path, then `act/<decisionRef>`.

| Linking page | Link on the card |
|---|---|
| `index.html`, `index.md` | `act/<decisionRef>` |
| `area/<areaRef>/index.*`, `item/<itemRef>/index.*` | `../../act/<decisionRef>` |
| `area/<areaRef>/project/<projectRef>/index.*` | `../../../../act/<decisionRef>` |

A page's HTML and Markdown files share one directory, so the link text is **byte-identical in both**. The manifest's
`actions[]` entry records it for each page that shows the card. The bundle verifier resolves every action link against
its page's path and refuses one that does not land on the root route of a listed `decisionRef`.

**Where no shell is running, the view says so** (design owner, answer 12). A static or shell-less read must never present
a silently broken action, and nothing falls back to another way of writing. Both statements are plain text, with no
script:

- **On the card, in HTML and Markdown,** directly under the link: "Answering needs the SitRep service. In a copy read
  without it, this link does not work and nothing is sent."
- **From Publisher's own server,** which has no shell: a GET or HEAD of the action route of a listed `decisionRef`
  answers 404 with a `text/plain` body: "This is a read-only copy. Answers cannot be submitted here, and nothing was
  sent." It sends today's headers and `Cache-Control: no-store`. An unlisted ref gets the ordinary 404. The server
  stays GET and HEAD only; this body is its one change, made in slice S5.

**The shell is a second artifact: `shell/v1`, under `shell-security-policy/1`.** It is a small static bundle (one HTML
file, one script, one stylesheet, each content-addressed, with its own content ID), built from Publisher source and
independent of any edition. Bundle bytes never name a shell version, so a new shell changes no `contentId`.

Publisher publishes each `shell/v1` into the same store. **The Producer's composition configuration pins one shell content
ID**, and the sidecar serves that shell's files under `/shell/<shellContentId>/<file>` through the reader (Producer,
agreement 2). The reader verifies a `shell/v1` against `shell-security-policy/1` before serving any of it, and reports
each content's schema, so that **a script is never served under the reading policy** and a reading page is never
served under the shell's.

- **Its policy** allows what the reading policy forbids, and nothing more: `script-src 'self'`, `connect-src 'self'`,
  `style-src 'self'`, `font-src 'self'`; `default-src 'none'`, `form-action 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. No inline script or style, no `eval`, no third-party origin, no frame.
- **How it shows immutable content.** The sidecar serves the pinned shell at the action route. The shell takes
  `contentId` and `decisionRef` from its own URL, fetches `/p/<contentId>/manifest.json` and
  `/p/<contentId>/data/decision/<decisionRef>.json` from the same origin, and renders the card with text nodes only.
  It never frames a reading page (those stay `frame-ancestors 'none'`) and never requests an alias, so a moved "latest"
  cannot change an open form.
- **Verification is the server's** (Producer, answer 9). The read API re-hashes every body against the verified manifest
  before returning it (section 4), and that server rehash is authoritative. The approved trust model today is plain
  HTTP on the protected network, with no HTTPS implementation or date committed. WebCrypto cannot be assumed on this
  non-secure origin; the first slice does not depend on browser hashing. The shell does compare the response's content
  ID and ETag with the manifest entry, as a consistency check and not as proof of trust. A later HTTPS origin would be
  a separately placed improvement; it blocks nothing now.
- **Preparation** (Producer, answer 5). When the form opens, the shell makes one preparation request carrying only the
  target descriptor. The Producer answers with the submission ID and a request-origin protection token. The shell keeps both in
  memory and reuses them for retries of that form.
- **Draft against Submit.** Selecting an option or typing changes memory only and sends nothing. One explicit Submit
  sends one closed envelope: the target descriptor, the answers (every `questionRef` of the decision, each to an
  `optionRef` or text), the submission ID and the protection token from the preparation response. Nothing else: no
  owner, seat, source, attribution or identity field. The Producer binds the canonical payload to the submission ID atomically
  at that Submit. A retry resends the same envelope under the same ID. No draft edit ever submits.
- **Several questions, one answer set** ([REV], consistency edits). The shell shows every question of a decision in one
  form and sends them together. The Producer refuses an incomplete or ambiguous combination; neither side joins answers into
  one string or drops which answer belongs to which question. The shell may mark a question as unanswered, but the
  refusal is the Producer's.
- **Drafts are memory only** (design owner, answer 14). An unsent draft survives navigation inside the shell session and
  is lost on reload. The form says so before the user types ("A reload clears an unsent answer"), and the shell warns
  before leaving a form with unsent input. It uses no cookie, `localStorage`, `sessionStorage` or IndexedDB, and never
  submits on its own. A reload prepares a new submission ID; what becomes of the unused one is the Producer's.
- **Mutable status lives only in the shell** (Producer, answer 7). After Submit the shell reads the Producer's receipt ([PROD] §4)
  and renders the text it is given: `refusalText` at admission, and `statusText` on each outcome, one per original
  source. The Producer screens that text and derives it from its own enums, under its own schema; its pending text tells
  "queued" from "applied". Publisher keeps no map from a state or reason to words, interprets none, maps no state to
  another, never shows an aggregate "applied", and treats an HTTP failure as "not confirmed", never as a receipt. No
  status is ever written into a bundle.

## 4. Origin topology

| | A. Producer sidecar is the one listener (recommended) | B. Publisher listens and forwards | C. Two origins |
|---|---|---|---|
| Shape | The sidecar serves the shell, bundle reads and the Producer's submit and status adapter on one origin. It reads the store through Publisher's read API. | Publisher's server serves reads and the shell, and forwards one path prefix to the Producer's adapter. | Publisher serves reads; the sidecar serves shell and adapter on another port. |
| Same-origin and Host | Hold by construction: one listener, one allowlist. | Hold, but Publisher's server gains POST and a forwarder. | Fail: the shell would need cross-origin reads, which today's `Cross-Origin-Resource-Policy: same-origin` refuses. |
| Cost to Publisher | The read API below; the server refactored onto it, its only behaviour change the read-only notice of section 3. | Ends "GET and HEAD only" (`server.mjs:139`) and every control built on it. | Loosened read headers on every packet. |
| Cost to the Producer | Owns the listener, the bind, Host and request-origin checks, and static serving through the API. | Less serving code. | Two binds to place and prove. |

**Recommendation: A** (the lead's ruling, and [PROD] §3's preference). Publisher's existing server stays GET and HEAD
only and is not in the request path; its one change is the read-only notice of section 3.

**Routes on the one origin** (Producer, answer 6). The Producer proposed them and **owns their exact closed schemas**; Publisher
quotes them and defines none.

| Route | Method | Served by |
|---|---|---|
| `/p/<contentId>/<manifest-path>` | GET, HEAD | The sidecar, through `reader.readFile`: immutable bundle bytes. |
| `/p/<contentId>/act/<decisionRef>` | GET | The sidecar: the pinned shell, only after `reader.hasTarget` accepts the target. |
| `/shell/<shellContentId>/<file>` | GET, HEAD | The sidecar, through `reader.readFile`: the pinned shell's files, under the shell policy. |
| `/api/sitrep/v1/submissions/prepare` | POST | the Producer's adapter: issues the submission ID and the protection token. |
| `/api/sitrep/v1/submissions/<submissionId>` | POST | the Producer's adapter: the one explicit Submit. |
| `/api/sitrep/v1/submissions/<submissionId>` | GET | the Producer's adapter: the receipt. |

The read route and the action route refuse an unknown target and any path `parseRequestPath` rejects.

**The reusable read-only API.** One new module, `src/read/store-reader.mjs`, **imported as a library** from the Publisher
archive the Producer already pins by hash ([DES]). A library, not a local process, because: it adds no second listener, port or
process lifecycle; a refusal is a typed value, not an HTTP status to re-interpret; and Publisher's own server calls the
same module, so there is one implementation of the manifest and path rules. Version skew is what a process boundary
would buy, and the pin already controls it. The Producer confirms the sidecar is a Node 24 process that imports the pinned ES
module, so no process boundary is needed (Producer, answer 8); the module therefore uses nothing newer than Node 24. It
opens files for reading only: no lock, no receipt, no alias write, no directory listing.

| Export | Input | Returns | Refusals (`ok: false`, `reason`) |
|---|---|---|---|
| `STORE_READ_API` | none | `"store-read/1"` | none |
| `openStore({ root })` | absolute store path | a reader | `store-not-found` |
| `reader.resolveAlias(name)` | alias name | `{ record }`, the `alias/v1` record as stored | `invalid-alias-name`, `alias-not-found`, `alias-corrupt` |
| `reader.openContent(contentId)` | content ID | `{ contentId, schema, manifestSha256, edition, files, pages, anchors, actions }`; `files` maps path to `{ sha256, mediaType, bytes, role }` | `invalid-content-id`, `content-not-found`, `verification-failed` (with the verifier's findings) |
| `reader.readFile(contentId, path)` | content ID; a path as decoded segments | `{ bytes, sha256, mediaType, etag, cacheControl }` | the three above, `path-not-in-manifest`, `integrity-failure` |
| `reader.hasTarget(contentId, kind, ref)` | a target descriptor's parts | `{ page, anchor }` | the three above, `unknown-target` |
| `parseRequestPath(rawUrl)` | raw request URL | decoded segments, or null | null for an encoded separator, NUL, backslash, dot or empty segment (as `server.mjs:52-69`) |
| `READING_HEADERS`, `IMMUTABLE_CACHE` | none | today's `SECURITY_HEADERS` and cache value | none |
| `allowedHostsFor(address, names)` | the bound address and names | the Host allowlist (`src/server/bind.mjs`) | none |

Guarantees, each from current code:
- A content ID is verified in full once per reader before anything of it is served; only manifest-listed paths, plus
  `manifest.json` and `checksums.json`, are readable (`server.mjs:86-110`).
- **Every body is re-hashed against the manifest on every read**; a mismatch is `integrity-failure`, and that content
  ID's verification is dropped (`server.mjs:118-123`).
- `edition`, `pages`, `anchors` and `actions` are null for a `packet/v1` and for a `shell/v1`.
- `openContent` returns the content's `schema`, and `readFile` the headers that schema's policy requires: the reading
  headers for `packet/v1` and `site-bundle/v1`, the shell policy's for `shell/v1`. A caller never chooses the policy.
- These reasons are Publisher's read reasons only. They are not admission or outcome reasons and never appear in a
  receipt.

## 5. Publisher-side invariants and negative controls

| # | Invariant | The negative control that must fail |
|---|---|---|
| P1 | Reads and navigation never rewrite store bytes. | Hash the store before and after a full browse-and-submit session; any difference fails. The reader has no write call to mutate. |
| P2 | A reading view has no script, form control, connection or frame. | Plant each in a page; the bundle verifier refuses it. |
| P3 | The shell cannot dispatch from a draft. | Against a recording stand-in adapter: opening the form makes exactly one preparation request, carrying the target only. Selecting and typing make zero more. Submit makes exactly one. |
| P4 | An old edition or a moved alias cannot retarget an open form. | Move "latest" while a form is open, then Submit: the request still carries the first `contentId`. The shell makes no alias request. |
| P5 | All text renders escaped. | Markup, entities and control characters in every text field render as text in HTML, in Markdown and in the shell. |
| P6 | The shell renders only verified content. | Tamper a `data/decision` file: the read API refuses and the shell shows no controls. |
| P7 | HTML and Markdown carry the same anchors. | Drop one anchor from either artifact; the parity check fails. |
| P8 | The build is deterministic. | The same input built twice gives byte-identical bundles; changing one input byte changes `contentId`. |
| P9 | The submit envelope carries only the target, the answers, the submission ID and the request-origin protection token from the preparation response. | Add any other field to the shell's request, or drop the token; the shape check fails. |
| P10 | `packet/v1` is unchanged. | Every existing packet fixture builds to the same `contentId` as on ab88512. |
| P11 | Every action link lands on the bundle-root route and is the same in HTML and Markdown. | Plant the bare `act/<decisionRef>` on an item page, then a link that differs between the two files; the bundle verifier refuses each. |
| P12 | A shell-less view says that answering is unavailable. | Remove the sentence from a card: the verifier refuses the bundle. Request the action route from Publisher's server: the body is the read-only notice, and no method but GET and HEAD is accepted. |
| P13 | Drafts live in memory only. | After typing, cookies, `localStorage`, `sessionStorage` and IndexedDB are empty. A reload shows an empty form. Leaving a form with unsent input raises the warning. |
| P14 | One reading order. | Move the action link above the evidence in either file, or the answer control above the question in the shell; the order check fails. |
| P15 | The shell renders the text it is given. | Serve a receipt whose `statusText` matches no known wording: it appears verbatim, as text. The shell source holds no table of states or reasons. |

**The Producer's to prove** ([SEL], [PROD] §5): forged target or owner; stale edition or source; changed payload on the same
submission ID; replay; a missing screen; quarantine persistence failure; a lost effect acknowledgement with no
redispatch; Host, request-origin and body bounds on the adapter; the protection token; refusal of an incomplete or
ambiguous answer set; a per-source outcome for every original source; the exact listener bind. **Shared:** the Host allowlist
(Publisher's function, the Producer's listener), and that the displayed question, options and evidence are those of the admitted
edition (Publisher renders, the Producer binds).

## 6. Bounded implementation plan (Publisher side)

Sizes are rough source lines plus test lines. Each slice is one reviewable change, in this order.

| # | Slice | Files | Size |
|---|---|---|---|
| S1 | `site-input/v1` validator: closed shape, limits, refs (option refs per question), counts with coverage and gap refs, order kept. | `src/site/validate.mjs`, a fixture, a test | 290 + 290 |
| S2 | Anchors and manifest shape: the new prefixes; `pages`, `anchors`, `actions`; the action-link derivation from a page's path. | `src/render/anchors.mjs`, `src/site/manifest.mjs`, a test | 150 + 190 |
| S3 | Bundle builder: the four page kinds in HTML and Markdown, reusing the block renderers; the reading order; the shell-less sentence; `data/decision` files. | `src/site/build.mjs`, `src/site/pages-html.mjs`, `src/site/pages-md.mjs`, tests | 480 + 380 |
| S4 | Independent bundle verifier (reserved `act/`, every action link resolved, order and sentence present), and publish accepting a bundle. | `src/site/verify.mjs`, `src/publish/filesystem.mjs`, tests | 400 + 350 |
| S5 | The read API, within Node 24; the server moved onto it, with the read-only notice as its only behaviour change. | `src/read/store-reader.mjs`, `src/server/server.mjs`, tests | 210 + 260 |
| S6 | `shell/v1`: static files, its builder, its policy constants; preparation, the closed envelope, the several-question form, given text, memory-only drafts and the leave warning. | `src/shell/`, `src/policy.mjs`, tests | 430 + 400 |

The total grows from about 1,700 + 1,570 lines in revision 1 to about 1,960 + 1,870. The order and the count of slices
do not change.

**First vertical slice only:** S1 to S6 at their narrowest. One verified existing edition; the portfolio, one area and one
item page; one decision card with its question, options, recommendation and evidence; select or type; Submit; receipt
status. That is one authored area path; the wider area registry stays an explicit prerequisite for more (Producer, answer
10). Project pages, history links and counts beyond that one path wait. **Element feedback is contract only:** sections 1 and
4 already carry `kind: "element"` and `hasTarget`; no control, route or shell code for it is built.

## 7. Proof plan

All proof uses stand-ins: no live queue write, no live service, no owner store.

- **Static (no slot):** the identifier and scope gates on this document; reading the changed files against the standing
  pins; anchor checks on control rows.
- **Needs a test slot, build only:** S1 to S5 unit tests; P2, P5, P7, P8, P10, P11 and the bundle halves of P12 and
  P14; the read API's refusals, each for its own reason; the existing server tests after S5, unchanged but for the
  read-only notice.
- **Needs a test slot, browser:** P1, P3, P4, P6, P9, P13, P15 and the shell halves of P12 and P14, against a loopback
  stand-in adapter that records requests and serves canned preparation responses and receipts in the Producer's proposed
  shapes; phone, tablet and laptop layout and keyboard access with the existing `playwright-core` and `axe-core`.
  The stand-in is **explicitly provisional**: it is named so in its file and in every result that used it, until
  the Producer's owner schema is imported (section 8, item 1).
- **Joined proof** ([PROD] §5): The Producer's site input from a production-shaped edition, into Publisher's build and verify,
  into the sidecar binding, the browser, the Producer's adapter, a disposable admission store, the worker and a recording owner
  transport, to the receipt read. Publisher's exact part is the first three hops and the browser's rendering and request
  shape. The joined proof runs the read API on the sidecar's own Node 24.

**The first slot (the lead requests it; this document requests none):** on one named head, `node --test` on the
new `test/unit/site-*.test.mjs` and `test/unit/store-reader.test.mjs` files, then `node --test --test-concurrency=1` on
one new `test/browser/site-shell.test.mjs`, loopback only. About 6 minutes of build tests and about 12 of browser tests;
then one full suite before any merge, by the lead.

## 8. Still open

Everything else is answered and is contract text above. Two items remain, and neither blocks the first slices.

1. **The Producer's owner wire schema is not published.** The Producer will provide it as a schema module, with a
   published JSON schema and a type export; there is no commit or date yet (Producer, agreement 1). It covers the two
   submission routes, the preparation response, the submit envelope (including the name of the protection-token
   field), and the receipt with `statusText` and `refusalText`. Until Publisher imports it, every such name here is
   quoted as proposed, and Publisher's stand-in adapter is provisional. Importing it changes no agreed meaning; if it
   would, the change rule applies.
2. **The two sentences of section 3** (on the card, and from Publisher's server) are proposed wording, with the site
   design owner, and unanswered. They stand as written until the design owner rewords them. The rule that they
   must be present is frozen.
