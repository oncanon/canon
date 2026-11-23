---
name: canon
description: Publishes rich, verifiable technical briefs (`report/v1`) and multi-page operational SitReps (`site-input/v1`) via the `canon` CLI so the user can review architecture proposals, audits, verification proofs, diffs, and status briefings in a clean typography-first web UI (over Tailscale or localhost) alongside coequal agent Markdown. Use whenever producing substantive technical documentation, design proposals, multi-finding reviews, verification reports, or SitReps for the user to consume, or when managing `canon` aliases and cloud publication tiers.
---

# Publishing Briefs & SitReps (`canon`)

Publish structured Canon editions whenever a deliverable benefits from scannable typography, tables, evidence citations, code/diff blocks, charts, flow diagrams, or multi-page navigation rather than a wall of chat Markdown.

## 1. When to Publish vs. Reply in Chat

| Situation | Format & Pathway | Command |
| --- | --- | --- |
| Quick answer, clarifying question, short status (< ~30 lines), trivial confirmation | **Inline chat reply only** | None |
| Architecture/design proposal, trade-off decision, code/security audit, root-cause analysis, verification proof with evidence/tables/diffs/charts | **Single-page Brief (`report/v1`)** | `canon brief <report.json> --alias <name>` |
| Multi-area operational SitRep, portfolio/project rollup, cross-workstream status with decision queue & left-rail navigation | **Multi-page SitRep (`site-input/v1`)** | `canon sitrep <site-input.json> --alias <name>` |


Keep your chat response concise once published: state the headline verdict, any open decisions needing user input, and the clickable Human + Agent URLs. Do **not** paste the entire report back into chat.

## 2. Authority & Exposure Boundary

Workstation exposure policy (`tailscale` | `local` | `stopped`) and server lifecycle are owned by the operator via `~/.canon/profile.json` and **`CanonBar.app`** — never by agents.

1. **Check status first:** Run `canon status` (`~/.local/bin/canon` or `/opt/homebrew/bin/canon` on `PATH`). It returns the active profile, live service state, `preferredBaseUrl`, and all published aliases.
2. **Respect active workstation exposure:**
   - If `canon status` shows `service.state === "running"` (e.g., standing `tailscale` or `local` mode), `canon brief` and `canon sitrep` publish into `~/.canon/store` and return live `urls` on that active listener automatically.
   - If `service.state === "stopped"`, `canon brief` / `canon sitrep` still build, verify, and publish into the store (`urls: null`), **without** starting a listener. Tell the user the edition is staged under `<alias>` and they can toggle the server on from `Canon` in the macOS menu bar (`CanonBar.app`) if they want a live link.
   - **Never** edit `~/.canon/profile.json` or run `canon service start|stop|restart` unless the user explicitly asks you to operate the daemon.
   - **Never** cross into **Cloudflare** tiers without explicit per-operation user authority.

| Tier | Reach | Authentication | Authority Rule |
| --- | --- | --- | --- |
| **Local / Tailscale workstation store** | Governed by `~/.canon/profile.json` (`127.0.0.1` or `<machine>.<tailnet>.ts.net`) | Loopback or tailnet membership/ACLs (no app login) | Agents may publish briefs/SitReps/aliases to the configured workstation store; operator controls exposure mode |
| **Cloudflare private** | Internet endpoint behind Cloudflare Access | Access identity policy; service token for ingest | Separate setup, deploy, upload, promote, link-sharing, and teardown grants |
| **Cloudflare public** | Public internet | Public reads; signed admin mutations only | Irreversible-in-practice; explicit public-publication grant for the exact edition |

## 3. Fast Workstation Workflow (Zero-Config Profile)

1. **Inspect active store & existing aliases:**
   ```sh
   canon status
   ```
   Check `aliases` so you reuse an existing alias when updating the same topic (incrementing its generation cleanly) or pick a clear `<project>-<topic>` slug (`^[a-z0-9][a-z0-9-]{0,62}$`, e.g., `billing-retry-policy` or `weekly-eng-sitrep`).
2. **Read the target schema reference before authoring JSON:**
   - Single-page brief (`report/v1`): [references/report-v1-schema.md](references/report-v1-schema.md)
   - Multi-page SitRep (`site-input/v1`): [references/site-input-v1-schema.md](references/site-input-v1-schema.md)
   - Workstation & Tailscale details: [references/local-tailscale.md](references/local-tailscale.md)
   - Cloud tiers (only when explicitly requested): [references/cloudflare.md](references/cloudflare.md)
3. **Author canonical JSON + real evidence files in a scratch directory** (e.g., `/tmp/canon-author-<slug>/`):
   - Every brief/SitRep requires at least one `evidence` item (`kind: "file"` with `mediaType` in `text/plain`, `text/csv`, `application/json`, or `kind: "redacted" | "unavailable"` with `reason`). Bundled `.csv`, `.json`, and `.txt` evidence files render bounded inline previews inside `#evidence` automatically.
   - **Follow House Rules (`HR-000` / `HR-004`) for technical prose & structure:**
     - **Concise, active claims (`ASD-STE100`):** Keep sentences crisp and single-topic (~20 words for procedural steps, ~25 words for explanatory claims). Avoid vague passive hedging.
     - **Normative precision (`RFC 2119` / `RFC 8174`):** Use uppercase `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY` only for true normative invariants (Canon highlights uppercase RFC 2119 keywords automatically).
     - **Verification bands (`HR-004`):** Tag findings and requirements with `verification: { "band": "code" | "judgment" | "review" | "needs-review", "detail"?: "..." }` so readers see at a glance whether a claim is machine-gated or awaiting human sign-off.
     - **Visual-first explanation:** Prefer `diagram` (`topology`, `sequence`, `flow`), `chart` (`comparison`, `quantiles`, `bar`), side-by-side `comparison` blocks (legacy vs. proposed concepts/code), `requirement` blocks (`EARS` + `Gherkin` scenarios), and MADR `decision` blocks (`context` + `consequences` in `report/v1`, or top-level `/decisions` in `site-input/v1` SitReps, where `items[].blocks` supports the full Canon v2 visual & House Rules grammar) over walls of paragraphs.
   - Do **not** hand-author HTML, CSS, or generated packet directories.
4. **Build, verify, publish, and update alias in one step:**
   ```sh
   # Single-page technical brief (report/v1):
   canon brief /tmp/canon-author-<slug>/report.json --alias <project>-<topic>

   # Multi-page SitRep bundle (site-input/v1):
   canon sitrep /tmp/canon-author-<slug>/site-input.json --alias <project>-sitrep
   ```
   Both commands automatically build into `~/.canon/builds/`, run cryptographic + schema verification, publish to `~/.canon/store`, compare-and-swap the alias generation, and print JSON containing `contentId`, `alias.generation`, and `urls`.
5. **Verify reader read-back before reporting the URL:**
   If `urls` is non-null (`service.state === "running"`), fetch both `urls.humanAlias` and `urls.agentAlias` (`curl -fsSL`) to confirm HTTP `200` before presenting links to the user.

## 4. Lower-Level Commands (Explicit Paths / Custom Stores)

When working without a profile or targeting an explicit `--root <store>`:

```sh
canon build <report.json> --out <packet-dir> [--receipt <build-receipt.json>] [--render-policy 1|2] [--reissue-of <old-packet-dir>]
canon verify <packet-dir> [--json] [--reissue-of <old-packet-dir>]
canon build-site <site-input.json> --out <bundle-dir> [--receipt <build-receipt.json>]
canon verify-site <bundle-dir> [--json]
canon publish <dir> [--root <store>] [--build-receipt <file>]
canon alias list [--root <store>]
canon alias get <name> [--root <store>]
canon alias set <name> <content-id> [--root <store>] --expect-generation <n>
```

`--render-policy 2` builds the Canon 2.1 edition (the default stays `1`). `--reissue-of` (policy/2 only,
also on `canon brief`) re-typesets an existing edition from the same source: the build verifies the old
packet, refuses unless its source digest matches, and records `manifest.report.reissueOf`. `canon verify
<new> --reissue-of <old>` then checks both packets, the relation, equal source digests, byte-identical
`report.md` and the same evidence; it exits non-zero on any mismatch.

## 5. Output Contract

Whenever you publish an edition, include a compact summary block in your response:

- **Edition:** `<alias>` (`v<generation>`, `<packet/v1 | site-bundle/v1>`, `<contentId>`)
- **Visibility:** exact active tier (`Tailscale (<machine>.<tailnet>.ts.net)`, `Local only (127.0.0.1)`, or `Staged in store (server stopped)`)
- **Human URL:** `<urls.humanAlias>` (and immutable `<urls.humanImmutable>` when useful)
- **Agent Markdown URL:** `<urls.agentAlias>` (`/a/<alias>/report.md` for briefs, `/a/<alias>/index.md` for SitReps)
- **Verification:** build + verify + HTTP read-back status

## Invariants

- Never escalate exposure automatically or mutate `~/.canon/profile.json`.
- Never execute external cloud publication, DNS, identity, deployment, push, or teardown without explicit per-operation authority.
- Tailscale is private network reachability (tailnet ACLs), not application-level authentication.
- Do not embed credentials, tokens, cookies, private keys, cloud account IDs, ARNs, UUIDs, or unredacted secrets in reports or evidence files.
- Completion requires verified HTTP read-back when serving is active, not CLI exit `0` alone.
