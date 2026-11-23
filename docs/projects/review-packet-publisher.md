# Technical review-packet publisher

Status: historical project brief (2026-09-24). Phase 1 is implemented. What is authorized now, including remote work, is set by [`AGENTS.md`](../../AGENTS.md), which wins where this brief disagrees.

## Maintainer intent

Create a reusable, beautiful publisher for technical review packets based on the bespoke Eleventy exploration. It must support local phone/iPad review and provider-swappable publication. The first cloud experiment should test a personal Cloudflare capability-link path. An AWS tier was explored and retired; it is not part of the public release. The work remains exploratory: resolve consequential product, security, lifecycle, and ownership decisions before implementation.

## Project spec

This document is the canonical project/design brief. It separates observed facts, recommendations, proposed experiments, open decisions, and authority boundaries. It does **not** authorize implementation of the publisher, infrastructure changes, publication, DNS, credentials, identity-provider registration, or deployment. (2026-11-19: authorization now comes from [`AGENTS.md`](../../AGENTS.md), not from this brief.)

The eventual system must produce a provider-neutral immutable `packet/v1` artifact; separate source from presentation; define builder, storage, access, verification, alias, revocation, and receipt interfaces; provide a filesystem/local adapter; and evaluate Cloudflare publication. It must be validated against the proof matrix below, and each phase requires separate maintainer approval.

## Product goal and visual direction

The product is a repeatable way to turn structured technical findings and their evidence into a polished but information-dense review surface that works on phone, iPad, and laptop. A packet must be usable from a local port, archived or opened offline as static files, and published without rebuilding for a provider. Local, archive, and cloud views should represent the same immutable packet bytes.

The baseline is **Variant A**: restrained code presentation, bounded title and heading scale, compact evidence-oriented layout, legible long-form prose, tables that reflow or scroll intentionally, and code that prioritizes review over spectacle. Avoid fancy-blog or magazine excess: no oversized hero typography, decorative editorial whitespace, gratuitous cards, or diagrams/charts used merely to make the document look designed. Use diagrams or charts only when they communicate topology, sequence, comparison, or measured evidence more efficiently than text or a table. Print must remain useful rather than becoming a screenshot of the screen layout.

Success means a reviewer can rapidly answer: what is claimed, what exact evidence supports it, what is proven versus proposed, what changed, what needs a decision, and how to verify the packet itself.

## Evidence and confidence labels

### Proven or directly observed facts

- The repository contract requires explicit, non-transitive authority, isolated worktrees for mutating work, evidence-backed status, and independent verification. See [`AGENTS.md`](../../AGENTS.md).
- The design input says a bespoke Eleventy exploration produced the useful visual direction, including Variant A, but those prototype bytes are not present on this base branch. Treat implementation details from that exploration as unverified until the prototype branch/worktree is inspected in a separately authorized phase.

### Recommendations

- Keep packet identity immutable and content-addressed. Treat aliases, access grants, and revocation as mutable control-plane records that never alter packet bytes.
- Render all authored content and code locally at build time. Runtime packet viewing should need no third-party script, font, analytics, diagram, syntax-highlighting, or CDN request.
- Start with a filesystem adapter and local proof packet before any cloud work. Use that artifact unchanged in portability experiments.

### Proposed experiments

1. A local/filesystem publication adapter proving deterministic packet creation, local-port viewing, archive extraction, and verification.
2. A personal Cloudflare R2 + Worker capability-link publication experiment, explicitly classified as weak access control/security through obscurity, with Cloudflare Access left as a later option.

## `packet/v1`: provider-neutral immutable artifact

### Identity and layout

A packet is a directory/archive whose identity is a cryptographic digest of a canonical manifest and every addressed file. The exact canonicalization and digest algorithm remain an open decision; SHA-256 over canonical JSON plus per-file SHA-256 is the starting recommendation. Publication providers must not inject, rewrite, optimize, or re-encode packet contents.

Recommended logical layout:

```text
packet/
  index.html
  assets/<content-hash>.<ext>
  evidence/<content-hash>.<ext>
  manifest.json
  checksums.json
```

`manifest.json` should declare at least schema version, packet content ID, report metadata, entry point, file inventory, MIME types, byte lengths, content hashes, evidence relations, build-tool version, and security/rendering policy version. Timestamps, machine paths, random IDs, and provider URLs must not perturb content identity unless they are deliberate report content. `checksums.json` supports simple independent verification and must agree with the manifest.

Aliases such as `latest`, review names, or human-friendly slugs are separate mutable mappings from alias to immutable content ID. Local directories, archives, and R2 objects use the same packet bytes. A provider receipt records where an already-built content ID was stored and what was read back; it is not part of that packet's identity.

### Source/presentation boundary and report schema

Authored source must be distinct from generated presentation. The source model should be a versioned report schema, not arbitrary Eleventy templates. It should support metadata, executive summary, status/confidence labels, findings with severity, claims, evidence references, decisions, alternatives, risks, code excerpts, tables, measured charts, communicative diagrams, appendices, and provenance. Evidence is copied into the packet only when policy allows; otherwise use an explicit unavailable/redacted reference, never an accidental machine-local link.

Presentation consumes this schema through reusable components and a bounded visual grammar: title block, status banner, decision callout, finding, evidence citation, code block/diff, table, figure, metric, timeline/sequence, risk, and appendix. The grammar owns typography scale, spacing, colors, severity semantics, focus states, breakpoints, print behavior, and accessible labels. Report authors supply meaning, not layout escape hatches. Raw HTML and provider-specific URLs are prohibited by default.

Use local Shiki/Torchlight-equivalent build-time rendering for code and diffs. The decision is behavioral, not a mandate for a hosted Torchlight service: deterministic highlighted markup, line anchors, optional emphasized ranges, copyable source text, and no viewer-time dependency. Variant A is the first baseline to freeze and test.

### Untrusted content and browser security

Treat report text, code, SVG, diagrams, filenames, evidence, and metadata as untrusted even when produced internally.

- Escape text and code by construction; sanitize or rasterize/compile diagram formats under an allowlist.
- Reject executable HTML, inline event handlers, scriptable SVG, `javascript:`/unsafe data URLs, path traversal, absolute paths, symlinks, device files, duplicate canonical paths, and case/Unicode-normalization collisions.
- Default Content Security Policy should require no external origins and no arbitrary script execution. Any small first-party interaction script must be fingerprinted, locally bundled, nonce/hash-compatible, and unnecessary for reading core content.
- Prevent reverse-tabnabbing, unsafe embedding, MIME sniffing, and unintended referrer leakage; choose explicit CSP, `X-Content-Type-Options`, referrer, and frame policy in the implementation phase.
- Bound file count, individual size, aggregate size, parse depth, and rendering work. Never execute report-provided code.

Every asset filename should contain its content digest. HTML and manifests reference only fingerprinted assets; immutable packet paths may receive long immutable cache headers while alias documents/control responses must be short-lived or non-cacheable. This is required to avoid the observed class of Safari stale-cache failures where a stable asset path serves old bytes after a new packet is published.

## Provider-neutral interfaces

The contract should make these capabilities independent and testable:

| Interface | Responsibility | Must not do |
| --- | --- | --- |
| Packet builder | Validate report schema; render deterministic HTML/assets/evidence; emit manifest, checksums, content ID. | Publish, grant access, create aliases, or mutate cloud state. |
| Storage publisher | Put immutable packet bytes under a content ID; reject conflicting bytes; read back and return evidence. | Choose identity from an alias or silently transform content. |
| Access adapter | Place an access policy/gate in front of stored content and return an access reference. | Change packet bytes or claim stronger security than supplied. |
| Verifier | Verify schema, inventory, checksums, content ID, headers, and optional provider read-back. | Repair mismatches silently. |
| Alias service | Create/read/update a mutable alias to an immutable content ID with concurrency controls. | Overwrite immutable content or imply revocation. |
| Revocation service | Disable an access grant/capability or alias according to provider semantics and record outcome. | Claim content deletion unless independently verified. |
| Receipt store | Record build, publish, read-back, alias, access, and revoke outcomes with provider-neutral fields plus provider evidence. | Become packet identity or contain secrets/capability URLs in ordinary logs. |

The first adapter is filesystem/local: publish by exclusive creation under `<root>/packets/<content-id>/`, verify copied bytes, maintain aliases separately (for example `<root>/aliases/<name>.json`), and serve through a loopback-bound local HTTP server so phones/iPads on a trusted LAN can be tested only when the operator explicitly binds a non-loopback interface. Offline archive use must not require that server except for browser features that inherently require HTTP; those exceptions must be identified, not hidden.

## Cloudflare experiment

The personal experiment stores immutable packet objects in private R2 and serves them through a Worker. A high-entropy capability link maps to a packet or alias and can be revoked in a small control record. The Worker must avoid leaking tokens in logs/referrers, use constant-time token verification where applicable, apply correct MIME/security/cache headers, reject traversal, and preserve Range/HEAD behavior needed by packet assets.

This is deliberately **weak access control / security through obscurity**: anyone who obtains the capability can use it; forwarding, browser history, screenshots, referrers, endpoint logs, and accidental sharing can disclose it; it does not establish reviewer identity, MFA, per-user auditability, or reliable downstream revocation. Use only for content explicitly accepted for that threat model. Cloudflare Access is a later access-adapter option if identity, policy, or audit requirements justify it; do not describe the capability experiment as equivalent to Access authentication.

Experiment evidence must include capability creation/use, invalid-token denial, revocation behavior and propagation time, cache behavior across alias changes, packet read-back, no external packet requests, and byte identity against the local packet.

## AWS experiment

An AWS tier was explored and retired; it is not part of the public release.

## Proof matrix

No row is considered proven by design text alone.

| Area | Required proof |
| --- | --- |
| Packet integrity | Canonical rebuild determinism; manifest/inventory/checksum verification; tamper, missing-file, extra-file, and conflicting-byte rejection. |
| Local/archive parity | Filesystem, served local, and extracted archive resolve the same content ID and core content; documented exceptions only. |
| Responsive review | Real phone-width, iPad portrait/landscape, and laptop checks for navigation, tables, code, figures, touch targets, and density. |
| Browser/print/accessibility | Current Safari/WebKit and Chromium; print/PDF; keyboard navigation; semantic headings/landmarks; contrast; zoom/reflow; screen-reader spot checks. |
| External isolation | Browser/network trace proves no external request from a packet, including fonts, highlighting, diagrams, analytics, and source maps. |
| Malicious content | XSS/scriptable SVG/unsafe URL/path traversal/Unicode collision/oversize test corpus is rejected or safely rendered under CSP. |
| Immutable publication | Duplicate identical publish is idempotent; conflicting publish fails; provider read-back bytes and headers match receipt. |
| Range/media | HEAD, conditional GET, valid/invalid/suffix/open ranges, seeking, correct 206/416 and MIME/length behavior. |
| Alias/cache | Alias update does not stale immutable assets; Safari reproducer passes; alias caching and concurrency semantics are measured. |
| Revocation | Alias/access revocation behavior, residual cache/session windows, and immutable-object retention are measured and reported separately. |
| Cloudflare capability | Valid/invalid/revoked link behavior, leak surfaces, logs, cache propagation, and explicit weak-security labeling. |
| Provider portability | One already-built packet is published locally and to Cloudflare with byte-identical content and the same content ID. |

## Staged plan and gates

### Phase 0 — decisions and evidence closure

Inspect the Eleventy prototype; inventory security/data classes; choose canonicalization, digest, archive, schema, alias, and revocation semantics; define measurable acceptance thresholds. Produce decisions only. **Gate:** the maintainer approves this brief and the selected Phase 1 contract.

### Phase 1 — local immutable packet vertical slice (recommended first bounded phase)

Build one representative `packet/v1` fixture and the minimum builder, verifier, filesystem publisher, alias record, and local server. Freeze Variant A tokens/components only far enough to test phone/iPad/laptop, print, accessibility, untrusted content, deterministic builds, asset fingerprinting, and no-external-request behavior. Include source-to-presentation separation and build/publish receipts. No cloud SDK, credentials, DNS or publication. **Gate:** independent QA validates the matrix subset and the maintainer chooses whether to proceed.

### Phase 2 — Cloudflare personal experiment

Implement R2 storage and Worker capability access for explicitly low-sensitivity packets; measure upload/read-back, invalid/revoked access, cache propagation, latency, and monthly cost assumptions. Keep Access as a separate option. **Gate:** explicit maintainer publication and Cloudflare-mutation authority for a named test packet/account.

### Phases 3 and 4 — AWS

An AWS tier was explored and retired; it is not part of the public release.

### Phase 5 — portability and extraction decision

Compare provider receipts, byte identity, operations, cost, security strength, and failure recovery. Decide whether to productize adapters, use Cloudflare Access, retain capability links, or reject the provider path.

## Measurements, observability, and cost

Each adapter should emit a redacted receipt with content ID, operation, provider, destination identifier (non-secret), start/end time, byte/file counts, result, read-back verification, and error class. Cloud paths additionally need alias/cache outcomes, R2 operations, Worker errors, and revocation events. Logs and traces must never contain OIDC cookies, capability tokens, client secrets, signed URLs, raw unapproved evidence, or full sensitive query strings.

Measure rather than estimate away:

- build duration, artifact bytes/files, local first render, and client render/layout stability;
- publish and read-back latency, storage/requests/egress, Worker execution, logs/metrics, and Access costs if applicable;
- cache/revocation propagation.

Set thresholds before a cloud experiment.

## Failure modes to design explicitly

- Non-deterministic build, manifest/checksum disagreement, partial/corrupt upload, or provider rewrite.
- Alias races, stale Safari/edge cache, revoked alias with still-valid immutable URL, and capability leakage.
- Malicious content, MIME confusion, traversal, oversized evidence, missing local asset, and accidental external dependency.
- Provider denial/throttle/timeout and incorrect range response.
- Telemetry outage or null metrics. Default to refusing mutation rather than guessing.
- Provider outage, receipt publication failure, revocation ambiguity, and cost anomaly. Preserve the primary failure and expose reconciliation steps.

## Open decisions requiring maintainer or designated-owner resolution

1. Which exact Eleventy/Variant A prototype bytes are canonical input, and may styles/components be copied or only used as reference?
2. What report content classifications are permitted for local LAN, Cloudflare capability, and Cloudflare Access publication?
3. Canonical JSON rules, digest algorithm, archive format, deterministic timestamp policy, and whether signatures are required in addition to hashes.
4. Exact `report/v1` fields, evidence custody/redaction rules, maximum packet size, and supported media.
5. Alias concurrency and history semantics; whether revocation disables an alias/access grant only or also triggers separately authorized object deletion.
6. Whether local phone/iPad access may bind to a trusted LAN and what operator warning/firewall expectations apply.
7. Whether any packet JavaScript is allowed, and the exact CSP/frame/referrer policy.
8. Cloudflare capability entropy/storage/rotation/expiry and accepted leakage window; whether Access is required before any non-personal content.
9. *Removed (AWS only).*
10. *Removed (AWS only).*
11. *Removed (AWS only).*
12. Which ontology-specific agent roles exist or must be proposed, and who is accountable for packet ontology, presentation, security/access, provider infrastructure, and independent QA.

## Agent execution model

Recommend separate ontology-specific agents rather than one broad implementation agent:

- **Packet ontology agent (lead):** owns report schema, packet identity, evidence semantics, interfaces, and cross-provider acceptance. It coordinates but does not gain cloud authority.
- **Review presentation agent (worker):** owns Variant A visual grammar, responsive/print/accessibility behavior, and local rendering.
- **Publication/security agent (worker):** owns threat model, untrusted-content controls, access-adapter contracts, receipts, alias/revocation semantics, and provider conformance.
- **Independent QA agent:** receives exact artifact bytes and proof criteria independently, validates rather than fixes, and reports failures to the lead.

Workers return evidence through bounded handoffs: exact source revision/worktree, artifact content ID, changed-file manifest, command/outcome ledger, screenshots or browser traces where authorized, read-back receipts, cost/latency measurements, and unresolved uncertainty. Evidence egress must exclude secrets, capability URLs, cookies, identity tokens, and unapproved report content. The lead synthesizes; it does not downgrade failed proof. No agent implements a phase until the maintainer approves this project brief and that exact phase, and every repository mutation still follows the worktree and commit rules in [`AGENTS.md`](../../AGENTS.md).

## Authority boundaries

This brief grants documentation-edit authority only. The following remain distinct and ungranted:

- implementing the packet builder, Worker, adapters, verifier, or infrastructure;
- committing, pushing, opening a pull request, merging, releasing, or deploying;
- publishing any packet or sending any capability/access link;
- creating or changing DNS, certificates, R2, Workers, Cloudflare Access, logging, budgets, or other Cloudflare resources;
- reading or using credentials/secrets, changing identity policy, or granting reviewer access;
- deleting/revoking content or access, running destructive tests, or communicating outward.

Approval of one action does not imply another. In particular, implementation approval does not authorize publication; publication does not authorize DNS/cloud mutation; and successful validation does not authorize deployment or adoption.
