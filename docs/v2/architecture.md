# Artifact Publisher V2: architecture (reconciled)

- **Status:** builder reconciliation of the lead draft `ARCHITECTURE-RECOMMENDATION.md` (SHA-256 `42f891b5…938a`) against code and tests on branch `v2/architecture`. This is a local-only phase: no provider access was requested or used. **Nothing here is merged to `main`.**
- **Inputs:**
  - brief `publisher-v2-cloud-architecture-brief.md` (`44f75729…ad9e`);
  - research `docs/v2/research/cloudflare-adapter.md` (`854b496a…d7ee`).
- **Companion documents:**
  - [publication-protocol.md](publication-protocol.md) (normative `publication/v1`);
  - [threat-model.md](threat-model.md);
  - [cost-model.md](cost-model.md);
  - [emulator-policy.md](emulator-policy.md);
  - [cloudflare/coverage.md](cloudflare/coverage.md) and [cloudflare/runbook.md](cloudflare/runbook.md): Cloudflare IaC coverage and the manual runbook (PREPARED, NOT EXECUTED; provider-validation slice 06).

## 1. Recommendation

The draft's recommendation stands. V1 stays unchanged and independently operable. One provider-neutral protocol, `publication/v1`, governs immutable upload, read-back verification, alias promotion, rollback and receipts. Two adapters implement it:

| Adapter | Target | Stack modelled | Credential the publisher holds |
| --- | --- | --- | --- |
| `fs` | Local V1 store | `packets/<id>/`, `aliases/<name>.json` (V1 layout, V1 `setAlias`) | none |
| `mock-cloudflare` | The maintainer (personal) | One Worker over R2 (bytes) and D1 (aliases), behind Access | Access service token only |

**In this phase, provider adapters talk only to in-process mock endpoints** through `InProcessTransport`. There is no network transport, and a static gate fails the build if one appears.

## 2. What the code implements

| Area | Module |
| --- | --- |
| Protocol and state machine | `src/publication/protocol.mjs` |
| Error taxonomy | `src/publication/errors.mjs` |
| Grants, classification, synthetic-only, cost ledger | `src/publication/policy.mjs` |
| `receipt/v2` and secret scan | `src/publication/receipts.mjs` |
| JSON Schemas and validator | `src/publication/schemas.mjs` |
| Target config, adapter factory | `src/publication/targets.mjs` |
| Transport | `src/publication/transport.mjs` |
| Adapters | `src/publication/adapters/{fs,cloudflare}.mjs` |
| Real Cloudflare transport and Worker | `src/publication/transports/{cloudflare-http,endpoint}.mjs`, `src/publication/worker/{index.mjs,schema.sql}` (protocol §8.1, §8.2) |
| Mock providers | `src/publication/mocks/{cloudflare-worker,state}.mjs` |
| CLI | `src/publication/cli-v2.mjs`, wired into `src/cli.mjs` |
| `report/v1` extension | `src/report/validate.mjs`, `src/packet/build.mjs`, `src/packet/verify.mjs` |

**Tests:**

| File | What it covers |
| --- | --- |
| `test/unit/v2-contract.test.mjs` | Proof-matrix rows V2-1 to V2-12 (V2-11 retired), for both adapters, plus the runtime no-network guard |
| `test/unit/v2-static-gate.test.mjs` | No network or SDK import; no delete path |
| `test/unit/v2-cli.test.mjs` | CLI authority gates |
| `test/unit/v2-policy.test.mjs` | Policy units |
| `test/unit/v2-schemas.test.mjs` | Extension proof, schemas |
| `test/unit/v2-serving-harness.test.mjs` | V2-7 over real HTTP on 127.0.0.1 (ephemeral port): the mock Worker |
| `test/unit/v2-promote-failures.test.mjs` | Promote ceiling before any request; receipts and ledger lines for failed and refused promotes |
| `test/unit/v2-fault-matrix.test.mjs` | Slice 05: every fault class × every adapter as its own cell (14 classes, including the post-commit history, lost-response and alias-write failures of deviation 16), each followed by the no-overwrite, no-deletion, verified-alias and dense-history invariants |

Red controls R69–R117 are in `scripts/red-controls.mjs`. R66–R68 are the README gate's controls on `main`, which this branch does not carry.

## 3. Proof matrix

The local-evidence cells are graded by tests. **Every provider-evidence cell is NOT_EXECUTED (provider evidence required)** until a separately authorized provider-validation phase. It is never PASS.

| ID | Claim | Local evidence | Provider evidence |
| --- | --- | --- | --- |
| V2-1 | The fs adapter conforms to `publication/v1`, with no V1 regression | contract suite, full V1 suite and red controls; the extension leaves the V1 golden content ID unchanged | n/a |
| V2-2 | `putIfAbsent` returns created, identical or conflict, and never overwrites | contract suite; R69 | R2 binding `onlyIf` under real concurrency |
| V2-3 | Read-back blocks promotion on mismatch | contract suite; R71, R72 | real checksum-mismatch errors |
| V2-4 | Alias CAS races: exactly one winner, complete history | contract suite; R74 | D1 UPDATE-WHERE under contention |
| V2-5 | Rollback never deletes and targets only verified, earlier IDs | contract suite, static gate; R73 | real stores |
| V2-6 | Every draft §2.7 fault gives its specified state and recovery | fault matrix (26 cells), contract suite; R83, R100–R115 | real throttling, timeouts, expiry |
| V2-7 | Headers and content types match V1 (text/markdown, CSP, nosniff); HEAD, Range, 304 | loopback HTTP serving harness (Worker), including a manifest-type-over-extension check; contract suite in-process; R91, R92, R116; fs through the V1 route tests | real Worker |
| V2-8 | Classification and access-mode refusal; the synthetic-only guard | contract suite, policy, CLI, promote failures; R76, R80, R99 | real Access |
| V2-9 | Receipts are complete, secret-free and append-only | contract suite and secret scan, schemas; R75 | receipts from real runs |
| V2-10 | The cost ledger refuses above the ceiling, before any request, and records failed operations | contract suite, CLI, promote failures; R81, R97, R98 | real billing |
| V2-11 | *Retired with the AWS tier* (edge-mirror lag). No target has an edge mirror: fs serves its store and the Cloudflare Worker reads the D1 primary. | none | n/a |
| V2-12 | No provider call without a grant; no delete, DNS or public-exposure path | contract suite, CLI, policy, static gate, runtime guard; R77, R79, R85 | n/a |
| V2.1-04 | The public target (mode (c)) is structurally separate, has no Access, takes only `public` packets, and admits writes only by signed admin requests | `test/unit/v21-public-target.test.mjs` (every signature attack, fail-closed, private-never-signs, classification, replay), `test/unit/v21-public-iac.test.mjs` (allowlist and cross-module separation, 14 planted cases), public deploy-token list; red controls | the Workers runtime's Ed25519 verification and the first public deployment (runbook-public) |

## 4. Deviations from the lead draft

Each item was forced by the code, the tests or the phase boundaries.

1. **Classification field.** The draft put a top-level `classification` on `report/v1`, but `report/v1` already has `metadata.classification` (display text), and the manifest already carries `report.classification`. The extension is therefore an optional object, `publication: { classification, dataOrigin }`, copied into `manifest.report.publication` only when present. A report without it builds byte-identical V1 packets: the test pins the golden content ID `sha256-d1b62957…6727`, and R86 goes red if this breaks.
2. **Synthetic marker.** The draft's "synthetic-only" guard needs a marker, so `publication.dataOrigin` (`synthetic` or `production`) is added. Absent means `production`, which fails closed for provider targets.
3. **History is written with the CAS where the store allows it, and appended by generation where it does not** (amended by deviation 16):
   - Cloudflare: in the CAS's own D1 batch; `appendHistory` confirms the entry;
   - fs: the V1 history log, appended by `setAlias`, repaired under the V1 lock by `appendAliasHistory` if that append failed.

   The interface also adds `readHistory`, `listAliases`, `describe`, `liveSecrets` and `requestCount`.
4. **Receipts per operation, not per transition.** Each operation writes one result receipt carrying its `transitions[]`. Before an alias moves, an **intent** receipt is written; if that fails, the alias does not move. This is the draft's "receipt write failure: report it and do not promote", made enforceable (R83).
5. **Public access mode has no code path this phase.** The draft allowed it with an extra flag. This phase's packet says public exposure has no code path, so a `public` target is refused as `not-available`, and the classification guard stays as defence in depth (tested directly; R76). **Superseded in V2.1 slice 04** (maintainer decisions D1-D8, lead decision E, 2026-09-30): public exists only as a structurally separate real Cloudflare target, with no Access and signed admin requests (`docs/v2/threat-model.md` T9; `docs/v2/cloudflare/runbook-public.md`). Mocks still refuse it, and the classification guard is its live guard.
6. **Real provider kinds are refused by default.** `cloudflare` has a real HTTPS transport (provider-validation slice 05; `publication-protocol.md` §8.1). It is used only when all of these are present: an explicit `workers.dev` endpoint in the target file, the credential in its environment variable, and a grant for the operation. It is tested only against a loopback fake. Using it against the real Worker needs the maintainer's separate confirmation.
7. **`--target fs`** publishes through the fs adapter into the V1 layout: objects are staged, then committed atomically on `manifest.json`, then verified by the V1 verifier. V1 `publish --root` is unchanged. The bytes and layout are the same as V1's; the code path is new. V1 readers (server, aliases) never see a partial packet.
8. *Removed (AWS only).* An AWS tier was explored and retired; it is not part of the public release.
9. **Rollback also requires the target to have been a generation of that alias,** in addition to "earlier, still present, verified". This stops rollback being used as an unconstrained promote.
10. *Removed (AWS only; see 8).*
11. **Cost estimates ignore free tiers,** so they are upper bounds. The ledger is a local JSONL per target (see cost-model.md).
12. **Mock conventions:**
    - a client-side timeout is simulated as status 599;
    - Access is modelled as a credential check with expiry, not JWT.
13. **Stale reads on Cloudflare are fault-injected,** although D1 with read replication off reads the primary (research §3.2). The protocol must survive a misbehaving read regardless.
14. **Promote-time classification and synthetic checks read the target.** The draft refuses policy failures before any provider call. For `promote` and `rollback`, the classification and data origin are in the manifest on the target, so they are checked after read-only verification and before any write, and they leave a `REFUSED` receipt (`receipt/v2` gains that state). The grant, availability and cost-ceiling checks still come before any request.
15. *Removed (AWS only; see 8).*
16. **Alias committed, history append failed (V2-QA-1).** The draft's CAS assumed a store that writes an alias and its history together. V1's `setAlias` does not. The normative rule is `publication-protocol.md` §4.1:
    - the CAS is the commit point, and nothing after it is reported as a conflict;
    - alias writes carry the operation ID, so a retry recognises its own committed write;
    - the history append is idempotent by generation and retried alone;
    - a lasting failure is a truthful `HISTORY_INCOMPLETE` receipt;
    - moves are refused until `reconcile` repairs the entry;
    - every exit from a move or a reconcile leaves a result receipt (`receipt/v2` gains `HISTORY_INCOMPLETE` and `FAILED`).

    V1 gains one additive export, `appendAliasHistory`; `setAlias` is unchanged. Red controls R107–R115.
17. **The history guard reads a consistent snapshot, and guards only a move from the incomplete generation** (found while testing the Worker, 1 in 20 under load). The guard's alias and history reads could straddle a concurrent commit and report a false `history-incomplete` to a caller that had simply lost. It now re-reads the alias and retries if it moved, and a caller expecting another generation gets the CAS's `alias-conflict` (protocol §4.1; R144, R145).
18. **The deploy token's database write scope is held for the token's whole life** (QA N-PV-7; lead decision, 2026-09-28). The placed access request limited it to "only while applying alias-table migrations, then revoke". It now stays on the single 1-day deploy token. Rationale: one apply session by the maintainer, a 1-day expiry, and one fewer token to handle. The runbook revokes the deploy token immediately after the last successful apply (`docs/v2/cloudflare/runbook.md` step 13), and its scope table cites this deviation.
19. **Access is managed as code** (V2.1, maintainer decisions of 2026-09-29). The Access application and its two policies (reviewers, in exact-person or IdP-domain mode, and the publisher's Service Auth) are Terraform resources, so the deploy token gains the Access application-and-policy scope shown in the generated table. The service token stays a dashboard step (runbook step 4): its client secret would otherwise be stored in state. The Worker's `POLICY_AUD` binding is the application's own `aud`.

## 5. Migration from V1

- V1 is untouched. Its CLI defaults, `publish --root`, alias records, service and routes are unchanged. The full V1 suite and red controls R1–R65 must run green on this branch; the slice 02 proof records the run.
- Remote targets are additive: `--target`, a target file, new receipts under `receipts/v2/`.
- V2 stays on `v2/architecture` until the maintainer decides. It is not merged to `main`.

## 6. Decisions needed from the maintainer

Unchanged from the draft §9:

1. Cloudflare: Access-private by default?
2. *Removed (AWS only).*
3. *Removed (AWS only).*
4. Retention and object lock?
5. Custom domains?

Also new:

6. **Whether provider validation may later download `wrangler`** (not installed; no downloads this phase).
