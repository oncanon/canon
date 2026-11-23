# Phase 1 local contract decisions

Status: decided for Phase 1 (local only). These decisions close canonical-brief open decisions 3, 4, 5 and 7 **for the local vertical slice only**. They do not pre-decide anything for Phase 2 or later (Cloudflare, access, revocation, publication).

Each decision names the code that implements it and the tests that bind it. A test is "binding" when changing the decision without changing the test makes the suite fail.

## D1. Canonical JSON, digest algorithm, and content ID

**Decision.**

- Canonical JSON is the RFC 8785 (JCS) ordering and number rules, applied to plain JSON values:
  - object members are sorted by UTF-16 code-unit order of their keys;
  - there is no insignificant whitespace;
  - strings use ECMAScript `JSON.stringify` escaping;
  - numbers must be finite and use ECMAScript `Number::toString`;
  - `-0` becomes `0`;
  - `undefined`, functions, symbols, bigint, and non-plain objects are errors, not silent drops.
- The output is UTF-8 with no BOM and no trailing newline.
- The digest algorithm is SHA-256, written as lowercase hex.
- The **content ID** is `sha256-` followed by the hex SHA-256 of the canonical JSON of the manifest *without its own `contentId` member*. The manifest covers the schema, entry point, report metadata, the full file inventory (path, role, media type, byte length, per-file SHA-256), evidence relations, and tool/policy versions. So the ID commits to every packet byte except `manifest.json` itself, which it describes, and `checksums.json`, which is derived.
- `manifest.json` is stored as exactly the canonical bytes of `{...identity, contentId}`. The verifier compares stored bytes with a re-canonicalization, so duplicate keys, reordering, whitespace, or number reformatting are all rejected.
- `checksums.json` (`checksums/v1`) repeats `contentId`, `manifestSha256`, and a path → SHA-256 map. It must agree with the manifest in every field.
- `manifest.build.renderPolicy` is `render-policy/1` or `render-policy/2`, and the verifier selects its `index.html` and stylesheet rules by it; any other value is an error (render-policy-2.md R1). `manifest.report` holds `schema`, `id`, `title`, `status`, `classification`, `reviewDate`, `sourceSha256`, optionally `publication`, and, on a render-policy/2 reissue only, `reissueOf`: the content ID of the edition this one re-typesets from the same source (R8). A render-policy/1 manifest that carries `reissueOf` fails as an unknown key.

**Identity inputs** are exactly:

- the canonical `report/v1` JSON, recorded as `report.sourceSha256`;
- the bytes of referenced evidence files;
- the stylesheet bytes;
- the tool name, version, and policy versions.

Machine paths, working directory, wall-clock time, time zone, locale, environment order, temp directory names, process IDs, and provider URLs are never read into packet bytes. Staging-directory names use a PID but never reach the packet.

**Rationale.** SHA-256 over canonical JSON was the brief's starting recommendation. It is available with no dependency in Node, Python (`json.dumps(sort_keys=True, separators=(',', ':'))`), and shell (`shasum -a 256`), so anyone can verify independently. Keeping `contentId` out of the hashed document avoids a fixed-point problem. `index.html` therefore cannot display its own content ID; the page points to `manifest.json` and to `rpk verify` instead (see the "Verify this packet" section).

**Implementation.** `src/canonical-json.mjs`, `src/packet/build.mjs` (`assemblePacket`), and `src/packet/verify.mjs`. The verifier has its own canonicalizer and imports nothing from the builder.

**Binding tests.** `test/unit/p2-determinism.test.mjs`, `test/unit/p3-manifest.test.mjs` (which includes an independent Python recomputation and `shasum` cross-check), and `test/unit/p4-integrity.test.mjs` (`not-canonical`, `content-id`).

## D2. Packet layout, paths, and media

**Decision.**

- A packet contains exactly:
  - `index.html`;
  - `report.md`, a deterministic agent-readable representation generated directly from the validated model;
  - `assets/<sha256>.css`, currently one stylesheet;
  - zero or more `evidence/<sha256>.<txt|csv|json>` files;
  - the embedded fonts, `assets/<sha256>.woff2`, each referenced by digest from the stylesheet;
  - render-policy/2 only: `report.json`, role `source`, `application/json`, the canonical `report/v1` bytes whose SHA-256 is `report.sourceSha256` (render-policy-2.md R2). A render-policy/2 packet without it fails, and a render-policy/1 packet with it fails;
  - `manifest.json`;
  - `checksums.json`.
- No other names, directories, symlinks, or special files are allowed.
- Every runtime asset and evidence filename is its own SHA-256.
- The inventory is sorted by path bytes. Duplicate paths and case-folding or NFKC collisions are rejected.
- Media types are fixed by extension: `text/html; charset=utf-8`, `text/markdown; charset=utf-8`, `text/css; charset=utf-8`, `text/plain; charset=utf-8`, `text/csv; charset=utf-8`, `application/json`.
- `report.md` preserves semantic order, headings, findings and claims, evidence labels, tables, source code/diffs, chart values, diagram step descriptions, provenance, and verification instructions while omitting navigation and decorative chrome. “Agent-readable” means clean, copyable text rather than punctuation noise: ordinary periods, in-word hyphens/IDs, parentheses, and authored placeholders such as `<sha256>` and `<content-id>` remain literal and visually readable as code spans. Rendering is context-specific: prose/headings escape only syntax that would change block or inline meaning; table cells additionally escape pipes and flatten line breaks; typed links use escaped labels and validated normalized `https:` destinations; inline-code delimiters grow beyond contained backtick runs and use Markdown-required padding; code fences grow beyond fence runs at line starts. Authored HTML comments/tags and angle-bracket URL or email autolinks are made inert with the minimum Markdown escape needed to prevent raw-HTML and link nodes. Entity-looking spellings use code spans only where needed to prevent decoding, never HTML-entity soup. Parser-backed tests require hostile authored text to produce no raw HTML nodes. HTML advertises Markdown with `rel="alternate"` and links it from the verification notes; the manifest inventories it. It is served at the immutable route `/p/<content-id>/report.md`, with immutable caching, strong ETag, MIME and Host/security handling identical to other packet files. Markdown consumers must verify packet integrity and treat authored content as untrusted text.
- **`report.md` is a coequal entry point (agent-Markdown check, 2026-09-26).**
  - **Manifest:** `agentEntry: {"path": "report.md", "anchors": "reference-definitions/1"}` sits beside `entry: "index.html"`, so an agent finds the Markdown and its anchor convention (D10) without parsing HTML. The field is part of the identity, so it contributes to the content ID. The verifier accepts a manifest without it (packets built before it existed) and requires exactly this value when it is present.
  - **Alias route:** `/a/<name>/report.md` answers `307` to `/p/<content-id>/report.md` with `Cache-Control: no-store`, like `/a/<name>/` does for the HTML. No other alias sub-path exists.
  - **Structure, anchors, escaping:** see D10 and D11.
- Evidence media allowlist: `text/plain`, `text/csv`, `application/json`. SVG, HTML, images, and anything scriptable are not accepted as evidence in Phase 1. Evidence must be valid UTF-8 without NUL bytes, and JSON evidence must parse within the depth limit.
- Evidence the author will not ship is declared as `redacted` or `unavailable`, with a reason. It is listed explicitly in the page and the manifest and contributes no bytes.

**Binding tests.** `p3-manifest`, `p4-integrity`, `p9-fingerprint`, `p8-malicious` (`unsupported-media`, `unsafe-evidence`).

## D3. Archive format and deterministic metadata (P10)

**Decision.** The archive is an uncompressed POSIX ustar (`.tar`) containing the packet's own files and its two directories at the archive root, with no wrapper directory. Every entry has:

- entries sorted by path bytes;
- mode `0644` for files and `0755` for directories;
- uid and gid `0`, with empty owner and group names;
- mtime `0` (1970-01-01T00:00:00Z);
- no extended headers.

Compression is deliberately omitted because gzip headers carry an mtime and an OS byte. The same packet always produces the same archive bytes. The writer refuses to archive a packet that does not verify. Extraction in tests uses the system `tar` (bsdtar/libarchive), not our writer.

**HTTP-only exceptions** (file:// or extracted-archive reading differs from served reading only in these ways):

- Response headers exist only over HTTP: `Content-Security-Policy` `frame-ancestors`, `X-Frame-Options`, `X-Content-Type-Options`, the `Referrer-Policy` header, `Cache-Control`/`ETag`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and `Permissions-Policy`.
- Offline, the `<meta http-equiv="Content-Security-Policy">` copy (without `frame-ancestors`, which browsers ignore in meta) and `<meta name="referrer" content="no-referrer">` apply instead.
- Reading content needs no server. The stylesheet loads from a relative path, and the browser parity test checks that the file:// rendered text and styling equal the served page in Chromium and WebKit.

**Binding tests.** `test/unit/p10-parity.test.mjs` (byte-identical archives across copies; exact `tar -tv` metadata; extracted bytes and ID equal), `test/browser/p10-file-parity.test.mjs`, `test/browser/p14-network.test.mjs` (`file-archive` route).

## D4. `report/v1` field set and limits

**Decision.** `report/v1` is a closed JSON schema, implemented in `src/report/validate.mjs`.

Top-level members:

- `schema`, `id`, `title`, and an optional `subtitle`;
- `metadata`: `status`, `classification`, `reviewDate`, `authors`, `reviewRequest`;
- `summary`: `verdict` (confidence plus text), `paragraphs`, and optional `metrics`;
- `evidence`: `file`, `redacted`, or `unavailable` entries;
- `sections[]` and optional `appendices[]`;
- `provenance`: `sources` plus optional `notes`.

Block types:

- `paragraph`, `list`;
- `finding`: severity `critical|high|medium|low|info`, confidence `proven|recommended|defect|open`, a claim, and at least one evidence reference;
- `decision`: `needed` or `decided`, with 2–8 alternatives and exactly one chosen when decided. An alternative may set `recommended: true` (optional, additive; at most one per decision; `false` is rejected, so the member is omitted instead). render-policy/1 and `report.md` ignore it;
- `risk`;
- `code`: languages `typescript|javascript|json|shell|yaml|text`, with highlight ranges;
- `diff`: a unified patch;
- `table`;
- `chart`: measured bars, values printed as text;
- `diagram`: flow steps with optional gates;
- `metrics`.

Inline text is a string or an array of `text`, `code`, `em`, `strong`, `cite` (evidence ID), and `link` (`https:` only) segments.

**Block numbers (`b-nn`).** The blocks of a report are numbered in one sequence for the whole document:

1. every entry of `summary.paragraphs`, in order;
2. then every entry of `sections[i].blocks`, section by section, in order;
3. then every entry of `appendices[i].blocks`, appendix by appendix, in order.

Every top-level block counts, whatever its type. Blocks nested in a finding's `detail`, the verdict, `summary.metrics`, section ledes, evidence items and provenance do not. The n-th counted block is numbered `b-` followed by n zero-padded to two digits (`b-01` … `b-99`, then `b-100`). The rule is computed from the report alone (`src/render/block-numbers.mjs`); render-policy/2 `index.html` carries one `b-nn` anchor per counted block, in this order, and `report.md` carries none.

Block, section, table and evidence ids match `[A-Za-z][A-Za-z0-9-]{0,63}` and are unique across the report **ignoring ASCII case** (tightened by the agent-Markdown check, because `report.md` anchors are case-insensitive reference labels; D10).

The schema is closed in four ways:

- Unknown members are `unknown-member` errors.
- Presentation escape hatches (`html`, `rawHtml`, `style`, `class`, `className`, `template`, `layout`, `script`, `svg`, …) are `escape-hatch` errors.
- Unknown block types are `unknown-block` errors.
- Strings must be NFC. C0/C1 controls, bidi embedding, override and isolate characters (Trojan Source), and BOM are rejected. Line breaks are allowed only in code and patch text.

Limits (`src/policy.mjs` `LIMITS`; source side):

| Limit | Value |
| --- | --- |
| Report JSON | 1 MiB, checked on raw bytes before parsing |
| JSON nesting depth | 16, checked by a pre-scan before `JSON.parse` |
| String length | 20,000 characters |
| Sections | 64 |
| Blocks (total) | 1,000 |
| List items | 200 |
| Code per block | 200 KiB, 4,000 lines, 2,000 characters per line |
| Code (total) | 1 MiB |
| Table | 400 rows, 12 columns |
| Chart series | 40 |
| Diagram steps | 24 |
| Evidence | 32 entries, 4 MiB per file, 16 MiB aggregate |
| URL length | 2,048 characters |
| Rendered `index.html` | 8 MiB |
| Rendered `report.md` | 8 MiB |

Packet-side limits enforced by the verifier (`PACKET_LIMITS`): 64 files, 8 MiB per file, 32 MiB total, 1 MiB for the manifest.

**Render work.** Highlighting is a single linear pass of sticky regular expressions with a one-character fallback, so work is O(source length) and bounded by the code limits. Pathological input is covered by a P8 case with a 2-second bound. Nothing report-provided is ever evaluated, and there is no template engine in the render path.

**Evidence file intake.**

- Each path segment is checked with `lstat`, and symlinks anywhere in the path are rejected.
- Only regular files are read. Devices, FIFOs, sockets, and directories are rejected.
- Files are opened with `O_NOFOLLOW | O_NONBLOCK`, and identity is rechecked with `fstat` to close the `lstat`→`open` race.
- Paths must be relative, POSIX, NFC, and made of safe ASCII segments, with no dot segments, and must not collide with each other under case or NFKC folding.

**Binding tests.** `p1-source-boundary` and `p8-malicious` (48 corpus cases).

## D5. Alias concurrency, history, and cache semantics

**Decision.** An alias is `<root>/aliases/<name>.json`: canonical JSON `{schema: "alias/v1", name, contentId, generation, previousContentId}`.

- **Compare-and-swap.** Every update states `expectGeneration`, where 0 means create. There is no unconditional overwrite.
- **Mutual exclusion.** Writers take `<name>.lock` with `O_CREAT|O_EXCL`, re-read the record under the lock, and fail with `generation-conflict` if the expectation is stale. The record is written to a private temp file, fsynced, and renamed, so readers see the old or the new record and never a partial one.
- **Stale locks fail closed.** A lock left by a crashed writer makes updates fail with `alias-locked`. It is never broken automatically; the operator confirms no writer is alive, then removes it. This is risk R-1 in the fixture.
- **Target check.** The target must be a verified, published packet in the same root.
- **History.** Each successful update appends one line to `<name>.history.jsonl`. History is informational; the alias record is authoritative.
- **Cache semantics.** `/a/<name>/` is a `307` redirect to `/p/<content-id>/` with `Cache-Control: no-store`, and `/a/<name>.json` is also `no-store`. Everything under `/p/<content-id>/` is `public, max-age=31536000, immutable` with a strong `ETag` equal to the file's SHA-256. An alias change therefore takes effect on the next navigation and can never pair new HTML with an old cached asset, because asset URLs change with content.
- Aliases never alter packet bytes and do not imply revocation. Phase 1 has no revocation or deletion.

**Binding tests.** `test/unit/p6-alias.test.mjs`, which includes 8 concurrent child-process writers with exactly one winner. `test/browser/p6-cache-reproducer.test.mjs` runs a naive stable-path control that goes stale, then the packet alias switch, which does not, in both Chromium and WebKit.

## D6. CSP, frame, referrer, and JavaScript policy (`security-policy/1`)

**Decision.**

- **No JavaScript in packets.** Every reading feature works without script: contents navigation uses `<details>`, and code copying uses plain text with CSS-counter line numbers that are never copied. Packet decision D-1 in the fixture remains open for the maintainer for later phases.
- **Content Security Policy** (HTTP header on every response, and a `<meta>` copy without `frame-ancestors`):
  `default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Font loading is limited to fingerprinted, inventoried WOFF2 assets in the immutable packet; external and data URLs remain forbidden.
  There is no `'unsafe-inline'`: the renderer never emits `style` attributes (chart bars are SVG presentation attributes) or `<style>` elements.
- **Other response headers:**
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`, plus `<meta name="referrer">` offline;
  - `X-Frame-Options: DENY`;
  - `Cross-Origin-Opener-Policy: same-origin`;
  - `Cross-Origin-Resource-Policy: same-origin`;
  - a restrictive `Permissions-Policy`.
- **External links.** Authors may only write `https:` links without credentials. They render with `rel="noopener noreferrer external"` and `referrerpolicy="no-referrer"`. They are user-initiated navigations and are never loaded by the packet.
- **Verifier policy scan.** As defense in depth, the verifier rejects packets whose markup contains:
  - script, style, iframe, img or other embedding elements;
  - inline handlers or `style` attributes;
  - `javascript:`, `vbscript:` or `data:` URL attributes;
  - unquoted URL attributes;
  - any `href` that is not a fragment, an inventory file, or an `https:` link with `noopener noreferrer`.
  It also rejects stylesheets with `@import`, `url(`, or `expression(`.
- **Server binding.** The server binds only `127.0.0.1` or `::1`. Other hosts are refused before listening, the bound address is checked after listening, and the CLI has no flag to override this.
- **Host header allowlist (DNS-rebinding defense; added in fix cycle 2, defect D3).** Binding to loopback does not stop a page on another origin from rebinding its own hostname to `127.0.0.1` and reading packets. The browser would send that page's hostname as `Host`, so every request's `Host` is checked before routing.
  - **Allowed:**
    - the exact bound loopback authority: `127.0.0.1:<port>` when bound to IPv4, or `[::1]:<port>` when bound to IPv6;
    - `localhost:<port>`, which browsers resolve to loopback, so it cannot be an attacker-controlled name and is convenient for reviewers;
    - the same values without a port only if the bound port is 80.
  - **Normalization:** the hostname is compared ASCII case-insensitively, because HTTP hostnames are case-insensitive. Surrounding whitespace is optional whitespace that the HTTP parser strips (RFC 9110). Nothing else is normalized.
  - **Rejected:** a trailing dot (`localhost.`, `127.0.0.1.`), a missing or wrong port, userinfo, lists, paths, other loopback addresses such as `127.0.0.2`, `0.0.0.0`, the other address family, and an empty or absent `Host`.
  - **Status:** 421 Misdirected Request, with `no-store`, the full security headers, a short text body and no `Location`. 421 says "this server is not authoritative for that authority", which describes a rebinding or misdirected request more precisely than 400 or 403. HTTP/1.1 requests with no `Host` at all are refused earlier by Node's parser with 400. An HTTP/1.0 request without `Host` reaches the check and gets 421.
  - **Scope:** the rule covers every route, including packet bytes, alias redirects, alias records, and `/healthz`.
  - **Binding tests:** `test/unit/p7-server.test.mjs` (Host tests, including raw-socket missing and empty `Host` and an IPv6-bound server) and red control R15.
- **Explicit non-loopback binds (E2E serving, `src/server/bind.mjs`; supersedes "the CLI has no flag" above).** Loopback remains the default. A non-loopback bind happens only when the operator names it:
  - `--tailscale`: the local Tailscale IPv4, verified against `tailscale status --json`, with the MagicDNS name added to the Host allowlist. Since 2026-10-12 it must name the node the caller expects (`--expect-tailscale-address`, `--expect-tailscale-name`), because a machine can run more than one Tailscale node; any other node is refused before listening;
  - `--host <ip>`: an IP literal on a local interface that is either the Tailscale address or a private LAN address on a non-tunnel interface.
  - **Wildcard binds stay refused.** `0.0.0.0` and `::` expose every current and future interface, including networks the operator never named. The review server has no authentication, so exposure must always be a deliberate choice of one address.
  - **Also refused:** public, link-local, unassigned and hostname binds; `100.64.0.0/10` addresses that are not the Tailscale address; and addresses on other tunnel interfaces. That last rule follows the 2026-09-26 incident, in which a CGNAT address belonging to a different network on `utun0` was accepted and briefly bound.
  - **Host allowlist:** the bound `address:port`; `localhost:<port>` only for loopback binds; named hosts (MagicDNS or `--allow-host`) only for non-loopback binds. Everything else gets 421.
  - **Binding tests:** `test/unit/e3-bind.test.mjs` (policy through an injected interface table; the only live non-loopback bind is the Tailscale address) and red controls R15 and R17. The operational use is in `docs/operations/review-service.md`.

**Binding tests.** `test/unit/p7-server.test.mjs`, `test/browser/p8-csp.test.mjs` (the CSP blocks an inline script, handler and style that execute in a no-CSP control), `test/browser/p14-network.test.mjs`, and `p4`/`p8` (policy scan).

## D7. Receipts

**Decision.** `receipt/v1` is a closed record with these fields:

- `operation`: `build`, `publish`, or `alias`;
- `provider`: `local-builder` or `filesystem`;
- `tool`, `contentId`;
- `destination`: kind and non-secret local path;
- `startedAt`, `finishedAt`, `durationMs`;
- `result`, `outcome`, `errorClass`;
- `fileCount`, `totalBytes`, `manifestSha256`;
- `readBack`: `verified`, `manifestSha256`, `matchesSource`, `matchesBuildReceipt`;
- `warnings`: on a `report/v1` build, the compile-time lint records (render-policy-2 R7), each `code`, `prefix`, `reservedFor`, `count` and up to five `occurrences` of `token` (the matched `<prefix><digits>`) and `path` (a JSON pointer into the report); `null` on every other receipt;
- `alias`;
- `admissionOverride`: present only on a `publish` receipt that admitted a render-policy/1 packet because `--allow-render-policy-1` was given after the default render policy moved to render-policy/2 (render-policy-2 R12), as `flag`, `renderPolicy` and `defaultRenderPolicy`; absent on every other receipt.

Receipts are written with exclusive create, outside the packet: build receipts go to the `--receipt` path, and publish and alias receipts go to `<root>/receipts/`. They never feed identity. There is no free-form field, so there is nowhere to put a secret, capability, cookie, or URL. Failed operations also write a receipt, with `result: "failure"` and `errorClass`.

**Binding tests.** `test/unit/p16-receipts.test.mjs` and `test/unit/p5-publish.test.mjs`.

## D8. `report.md` serializer: self-delimiting segments

**Problem (QA D-F1).** `report.md` is concatenated from pieces: authored text, generated code spans, citations, emphasis and links. Each piece was escaped on its own, so the end of one piece and the start of the next could form syntax that neither contained. The QA reproducer was an authored text segment ending in `!` followed by a citation `[E1]`, which rendered `![E1]`, an image, under CommonMark and pandoc GFM.

**Decision.** Inline output is a list of typed pieces (`text`, `code`, `cite`, `link`, `em`, `strong`), joined by one function (`joinPieces` in `src/render/markdown.mjs`) that inspects every boundary. Only combinations that change structure are neutralized, so ordinary punctuation stays unescaped and readable:

| Boundary | Would form | Neutralized by |
| --- | --- | --- |
| unescaped `!` + `[` | image | escaping the `!` |
| generated `]` + text starting `(`, `:` or `[` | inline link, reference definition, longer label | escaping that first character |
| unescaped `&` + `#` or a letter | character reference | escaping the `&` |
| `` ` `` + `` ` `` | one merged code span | the separator below |
| emphasis next to `*`, or alphanumeric text next to emphasis whose content starts/ends with punctuation | delimiters that cannot open or close (literal `*`) | the separator below |

The separator is `&#8203;`, a zero-width space written as a character reference. Its source characters are punctuation, so emphasis delimiters flank correctly beside it; it decodes to an invisible character, so the reader sees no added space. (Fix2 used a plain space between code spans, which was visible.)

**Why a boundary join rather than escaping more characters everywhere.** Escaping every `!`, `(`, `:` and `&` in authored text would also make the Markdown noisy for agents, contrary to D2 ("clean, copyable text"). The boundary rules are exhaustive for the inline constructs the serializer generates. The property test below checks them against real parsers rather than trusting the table.

**Block and context rules added in the same cycle:**

- **Ordered-list look-alikes (QA D-F3).** Escape the delimiter, not the digits (`2019\. was`). A backslash before a digit is not an escape and stayed visible.
- **Headings (QA D-F4).** A trailing run of `#` after a space is an ATX closing sequence, so its first `#` is escaped.
- **Table cells (QA D-F5).** `|` is escaped inside code spans and link labels as well as in text. GFM table parsing splits cells before inline parsing and removes that backslash again inside code spans.
- **Consecutive lists** (found by the boundary test). Two list-producing blocks in a row (lists and metrics) merged into one list. Each block in a run alternates its marker (`-`/`+` for bullets, `.`/`)` for ordered lists), because a changed marker always starts a new list.
- **GFM extensions** (found by the boundary test). Authored `$` is escaped, because pandoc GFM reads `$…$` as math. `www.` after `_` is neutralized, because a `\b` boundary missed it.
- **Not escaped: a link label starting `^`.** A GFM footnote reference needs a matching `[^label]:` definition. The serializer never emits one, and authored `[` is always escaped, so a `[^x](url)` label stays a link (the generator includes such labels). An escape added during development was removed, because its red control could not go red.

**Binding tests.**

- `test/unit/e2-markdown-boundary-property.test.mjs`: a seeded generator (mulberry32; seeds 20260926, 1, 42, 9001 and 314159) builds random sequences of adversarial segments in paragraphs, list items, table cells and headings. It compares the parsed structure with an expected-structure model: node kinds, inline text, list and item counts, and table cell count and contents. It does this under `commonmark` 0.31.2 and under system pandoc 3.5 (`-f gfm`). The seeds, case counts and pandoc identity are recorded in the E2E evidence.
- The pandoc reader approximates cmark-gfm. Constructs pandoc cannot represent are reported as NOT_EXECUTED with a reason, never as a pass.
- Red controls R33–R43 revert each rule. R27, R16 and R21–R24 were re-pointed at the new code for the same earlier defects.

## D9. Service state file

**Problem (QA D-F2).** `serve` created `state.json` and then wrote it (`writeFile` with `wx`). The `service start` ready poll could read it empty or half-written and crash with `SyntaxError: Unexpected end of JSON input`, which left the new child serving.

**Decision.**

- **Writer:** the state is written to a private temp file in the same directory, fsynced, then published with `link()`. That step is atomic, and it keeps the exclusive-create semantics: it fails with `EEXIST` when a state file already exists. The temp name is then removed. A reader sees either no file or the complete file. `config.json` uses the same write with an atomic `rename()`.
- **Reader:** defence in depth.
  - A missing file means not ready.
  - An unparseable read is retried. The ready poll keeps polling until its deadline.
  - Only a state that is still unparseable at the end fails, with `state-corrupt` (CLI exit 6) and a message that names the file. The spawned child is stopped, and the corrupt file is kept for inspection.

**Binding tests.** The `[E4] D-F2` tests in `test/unit/e4-lifecycle.test.mjs` cover:

- torn reads retried;
- a corrupt final state giving exit 6, not a `SyntaxError`;
- the target absent until complete, and exclusive;
- `start` becoming ready through injected torn reads;
- a corrupt state at the deadline stopping the child.

Red controls: R31 (the reader throws on a torn read) and R32 (the state is written in place).

## D10. `report.md` anchors (`reference-definitions/1`)

**Decision.** Every block that has an id in `index.html` has the same anchor in `report.md`: the summary, each section and appendix, finding, decision, risk, code or diff, table, chart, diagram, the evidence list and each evidence item, and the provenance section. The Markdown heading that introduces the block is followed by one blank line and then the CommonMark link reference definition `[<id>]: #<id>` on its own line. Both artifacts take the id from one module (`src/render/anchors.mjs`).

- **Resolving an anchor:**
  - The definition line directly after a heading names that heading's anchor. `report.md#<id>` and `index.html#<id>` address the same block.
  - Within `report.md`, `[<id>]` is a reference link to the anchor.
  - Every finding and evidence item is a heading, so each has an anchor.
- **Why a definition, not `{#id}` or HTML:**
  - A definition adds no node to the CommonMark or pandoc tree, so heading text and document structure are unchanged, and GitHub and other renderers show nothing extra.
  - `{#id}` (Pandoc/kramdown attributes) was approved first, but it adds visible text to the heading, which failed 12 unchanged fix3 tests that locate sections by heading text.
  - Raw HTML anchors (`<a id>`) would break the zero-raw-HTML gate.
- **Safety:**
  - Ids are `[A-Za-z][A-Za-z0-9-]*`. The renderer refuses any other anchor text, so an id can never break out of a definition line.
  - Report ids must be unique ignoring ASCII case (report/v1 validation, `duplicate-id`), because reference labels match case-insensitively. The renderer also refuses a collision under case folding, or with a citation label such as `[E1]`.
  - Authored text cannot create a definition: authored brackets stay escaped at the start of a paragraph or list item. An authored bracket pair whose content matches an anchor label, in any case or spacing, stays escaped (D11), so it never becomes a link.
- **Residual:** plain CommonMark and GitHub renderings do not give headings these ids, so a link such as `report.md#f-F-1` does not scroll to the heading there. The anchor is a documented convention for agents and tools, not a rendered HTML id.

**Binding tests.** `test/unit/e8-agent-md.test.mjs` (anchor contract; injection and case folding), `test/browser/e8-agent-md.test.mjs` (the anchor map), and `test/unit/e8-boundary-expanded.test.mjs` (authored labels colliding with anchors). Red controls: R48 (anchor differs from its HTML id), R54 (label collision), R55 (case folding).

## D11. `report.md` escaping: strict, then relaxed

**Requirement.** An escape appears only where the character would otherwise be parsed as syntax in its exact context. Ordinary prose, identifiers, paths, numbers and punctuation read cleanly. The fix cycle 1–3 safety properties still hold, and where safety and readability conflict, safety wins and the case is recorded.

**Decision.** The fix1–3 escaping in `src/render/markdown.mjs` is unchanged: every earlier test and red control applies to it as before. A second pass, `src/render/relax.mjs`:

- **Where it runs:** once over the final concatenated document, with every neighbour present.
- **What it may do:** only remove an escape whose context cannot parse the character as syntax. It never adds one.
- **What it never touches:** code spans, fenced code, link destinations, anchor definitions or generated syntax.

An escape is kept when:

| Character | Kept when |
| --- | --- |
| `\` | before ASCII punctuation or at the end of a line |
| `<` | before a letter, `/`, `!` or `?`, or starting an email-shaped run (raw HTML and autolink starts) |
| `` ` `` | always (conservative: an authored backtick can pair with a generated code span, QA D-E3) |
| `*`, `_`, `~` | the run can open or close (CommonMark flanking rules, and the `_` rules), and another capable run of the same character is in the same inline container. Containers are a paragraph, list item or heading. A table is one container for `*` and `_`, since a CommonMark reader sees one paragraph, and each cell is its own container for `~` |
| `$` | it could open with a later `$` that could close, or close with an earlier one that could open, anywhere in the container, including inside code spans. pandoc 3.5 scans math across link syntax and into code spans, and does not apply its documented "no digit after the closer" rule |
| `[`, `]` | inside a generated link label; at the start of paragraph or list-item content (definitions, task lists); after a generated `]`; a `]` before `(`, `[` or `:`, and its matching `[`; or a pair whose content matches an anchor label (D10) |
| `#`, `>`, `-`, `+`, `=`, `N.`/`N)`, `~~~`, `* `, thematic breaks | block syntax at the start of paragraph or list-item content. A heading's `#` stays escaped as an ATX closing sequence. A `#` after a raw `&` stays escaped, so no character reference forms |
| `!` | before a generated `[` (image) |
| `(`, `:`, `&` backslash-escaped | always: these come only from the fix3 segment-boundary rules |
| `&#58;` | after a scheme-shaped word, whatever precedes it (pandoc links bare URIs after `.`, `+` or `&`) |
| `&#64;` | between an email local part and a dotted domain (Unicode letters and digits count) |
| `&#46;` in `www.` | before any non-space character |

**Gate.** `test/agent-md-gates.mjs` `escapeInventory` runs a per-character oracle. It starts from the document with every escape replaced by what it stands for. An escape is required when restoring it alone changes the commonmark 0.31.2 or pandoc 3.5 `-f gfm` tree. Every other escape must fall in a listed conservative class (`CONSERVATIVE_CLASSES`: backtick, delimiter-with-partner, math-dollar, scheme-colon, autolink-domain, line-start-marker, bracket, segment-boundary, whitespace-or-separator, backslash), whose predicate the gate checks. Anything else fails.

**Density thresholds**, in escapes per 1,000 characters of rendered text:

| Document | Measured | Threshold |
| --- | --- | --- |
| Golden fixture | 0 escapes | at most 1.0 |
| Realistic, non-adversarial corpus (`fixtures/corpus/realistic-prose.json`, 40 engineering-report strings as paragraphs, list items, table cells, headings and inside emphasis, strong, code and links) | 2.96 (71 escapes: 64 required, 7 conservative) | at most 4.0 |
| The same corpus with the strict fix1–3 serializer alone | 9.54 | the test asserts it exceeds 4.0, so the gate discriminates |

The corpus threshold sits about 35% above the measurement and well below strict output. A regression toward blanket escaping fails; ordinary content growth does not.

**Found while building the relaxation.** The unchanged fix3 boundary test and the expanded run found relax-only defects, each fixed and each with a red control:

- a removal at a segment edge formed `&#60;` (R50);
- pandoc links bare URIs after `.` or `+` (R51);
- pandoc math crosses links and code spans and ignores the digit rule (R52);
- a line-start `~~~` is a tilde fence (R53);
- a table is one CommonMark paragraph (R56);
- `www.` before a non-ASCII domain (R57).

**Binding tests.**

- `test/unit/e8-agent-md.test.mjs` (gates and thresholds);
- `test/unit/e8-boundary-expanded.test.mjs`: 16 seeds and 12,800 cases under both readers. It shows relaxation of the strict output reproduces `report.md` byte for byte and records removals at segment edges.
- Every fix1–3 test, unchanged.

**Red controls.**

- R44: relaxation disabled.
- R45: every authored punctuation character escaped.
- R46: a table dropped.
- R47: a heading dropped.
- R49–R53, R56, R57 and R60: individual relax rules wrongly removing a needed escape.
- R58: no alias route.
- R59: the verifier accepts a wrong `agentEntry`.

## Dependencies (build/test time only)

| Package | Version | Why | Runtime? |
| --- | --- | --- | --- |
| `playwright-core` | 1.62.1 (exact, lockfile) | Drive real Chromium 151 and WebKit 26.5 for P6/P8/P10–P14 evidence | No |
| `axe-core` | 4.13.0 (exact, lockfile) | Automated WCAG 2.2 A/AA + best-practice audit (P13) | No; injected only into a CSP-bypassed audit context |

The packet builder, verifier, publisher, alias service, and server use only the Node.js standard library. A packet reader loads nothing third-party.

Browser binaries: Chromium build 1234 was already cached. WebKit build 2336, which matches `playwright-core` 1.62.1, was installed with Playwright's own installer. The cached `webkit-2259` pairs with a different Playwright version, and no single Playwright release matches both cached builds.
