# `publication/v1`: normative specification

The keywords MUST, MUST NOT and SHOULD are normative. The reference implementation is `src/publication/`. Each normative statement names the test, and where relevant the red control, that holds it.

## 1. Object layout

Every target exposes the same logical keys.

| Key | Content | Mutability | Cache (served) |
| --- | --- | --- | --- |
| `p/<content-id>/<path>`, for every manifest file plus `checksums.json` and `manifest.json` | packet bytes | immutable, create-if-absent | `public, max-age=31536000, immutable` |
| `aliases/<name>.json` | an `alias/v1` record | compare-and-swap on `generation` | `no-store` (served as a 307) |
| alias history (the target's native form) | every `alias/v1` generation, in order | append-only | not served |
| `receipts/…` | `receipt/v2` records | append-only | not served |

**Keys, types and caching:**

- `<content-id>` is `sha256-<64 hex>`: the SHA-256 of the canonical manifest without its own ID (V1 `packet/v1`).
- The content type of each object MUST come from the manifest's `mediaType`, never from provider sniffing or the file extension. For example, `report.md` is `text/markdown; charset=utf-8`. It is stored with the object at upload and served as stored: the Worker from R2's `httpMetadata` (N-V2-1; `v2-serving-harness`; R116).
- Every object is written with the immutable `Cache-Control` above.

**Upload order and completeness:**

- `manifest.json` MUST be uploaded last; it is the commit marker. The order is every inventory file sorted by path, then `checksums.json`, then `manifest.json` (`uploadOrder`; R82).
- A packet is **complete and verified on a target** only if all of the following hold on that target:
  - `manifest.json` exists and hashes to the content ID;
  - every listed file reads back with the manifest's SHA-256 and size;
  - every file is served with the manifest's media type;
  - `checksums.json` is present.

**How each target stores history:**

- fs: the V1 `aliases/<name>.history.jsonl`.
- Cloudflare: a D1 `alias_history` table written in the same batch as the CAS.

## 2. Serving contract

Every packet response carries the V1 security headers:

- a CSP with `default-src 'none'`, `script-src 'none'` and `frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `X-Frame-Options: DENY`.

A server MUST support GET, HEAD, single `Range` requests (206 with `Content-Range`, 416 when unsatisfiable) and `If-None-Match` (304). Alias routes `/a/<name>/` and `/a/<name>/report.md` MUST answer 307 with `Cache-Control: no-store` (V2-7).

**ETag (a documented V1 difference):** the Cloudflare Worker MUST send `ETag: "<sha256>"`.

## 3. Adapter interface

An adapter is the only surface a target implements. It talks to its provider only through a transport (`request({method, path, headers, body}) → {status, headers, body}`). In this phase the only transport is in-process (§8).

| Method | Contract |
| --- | --- |
| `putIfAbsent(request, bytes)` | `request` is `adapter-put-request/v1`. The result is `adapter-put-result/v1` (`created` / `identical` / `conflict`). It MUST NOT overwrite an existing object (R69), and it MUST reject bytes whose SHA-256 differs from `request.sha256` (`bad-digest`). `identical` means the stored SHA-256 equals the request's, which makes retries idempotent. |
| `headObject(key)` | `adapter-head-result/v1`: existence, size, SHA-256, content type, cache control |
| `getObject(key)` | the bytes, or null |
| `readAlias(name)` | an `alias/v1` record, or null |
| `casAlias(name, expectGeneration, contentId, { opId })` | `adapter-cas-result/v1`. It succeeds only if the current generation equals `expectGeneration` (0 creates), and it writes generation `g+1` (R74). It MUST refuse a content ID whose `manifest.json` is absent on the target. The write carries the operation ID; a retry that finds its own committed write returns it as a success, never a conflict (§4.1; R108). |
| `appendHistory(name, record)` | Idempotent and keyed by generation: the history entry for `record` exists afterwards and equals it. Where the store writes history in the CAS itself (Cloudflare's D1 batch), it confirms the entry. It never changes the alias record (§4.1). |
| `readHistory(name)` | every generation, in order. An unreadable history is an error, never an empty one. |
| `listAliases()` | alias names |
| `writeReceipt(receipt)` | append-only; an existing receipt ID MUST fail |
| `describe()`, `liveSecrets()`, `requestCount()` | kind and credential class; the live secret values for the receipt scan; requests made |

**There is no delete, purge, invalidation, DNS or domain method.** The static gate (`v2-static-gate`) fails if any publication client module issues a DELETE, a provider delete or purge, or a filesystem removal. The one exception is the fs adapter's removal of its own temp file, which has a guard. Deletion is a separate `DeletionAdapter` under a separate grant, and it is **not built**.

## 4. State machine

```text
PLANNED -> UPLOADING (sorted files, checksums.json, manifest.json last) -> UPLOADED
UPLOADED --read back every file on the target--> READBACK_VERIFIED
READBACK_VERIFIED --(grant: promote; re-verify on target; intent receipt)--> PROMOTING -> PROMOTED
PROMOTED [history append failed after the commit] -> HISTORY_INCOMPLETE (moves refused; reconcile repairs; §4.1)
```

**Invariants:**

1. **No alias moves to an ID that is not verified on that target at that moment.** Promote and rollback re-run the full target verification first (R71).
2. **No failure changes a content ID or overwrites an object** (R69, R82).
3. **An alias never moves unless its intent receipt was written first** (R83).
4. **Rollback is a promotion to an earlier generation's content ID.** The generation increases, nothing is deleted (R73), and the target must be a past generation of that alias and verified.
5. **Every operation that reaches the target writes a result receipt and a ledger line,** including a failed or refused one (R97, R99, R110; `v2-promote-failures`, fault matrix `aliasWriteFailure`). A refusal made before any provider request writes neither. The one exception is a receipt store that refuses the write itself; the error then carries the unwritten receipt.

### 4.1 Alias committed, history append failed (deviation 16)

A move has two effects: the alias record at generation `g+1`, and the history entry for `g+1`. Cloudflare writes both in one D1 batch. V1's `setAlias` renames the record and then appends the history line. On fs the alias can commit and the history append can then fail. The rules:

1. **The CAS is the commit point.** Before it, a failure is reported as what it is (`THROTTLED`, `TIMEOUT`, `CREDENTIAL_EXPIRED`, `FAILED`, `ALIAS_CONFLICT`, …), with a result receipt, and the alias has not moved. After it, the move stands and **nothing is reported as a conflict or a pre-commit failure** (R109, R114).
2. **A retry never turns a committed move into a conflict.** Only the CAS is retried, never the history append with it. Each alias write carries the operation ID (a D1 column), so a retry after a lost response recognises its own committed write (R108). On fs, a non-V1 error from `setAlias` is followed by a re-read: a record at `g+1` with this content is this writer's move (R115).
3. **The history append follows the commit,** idempotently and keyed by generation, with the same bounded retry as other calls. A transient failure (503, timeout) is absorbed here: the move completes with dense history (R112).
4. **A failure that outlasts the append is `HISTORY_INCOMPLETE`.** The result receipt says so truthfully: `state: HISTORY_INCOMPLETE`, `toGeneration: g+1`, `transitions` including `PROMOTED`, and `errorClass` naming the append's failure (`protocol`, `credential-expired`, …). The operation fails with `history-incomplete`, and the error states that the move stands.
5. **No alias moves while its history is incomplete.** Promote and rollback check first and refuse with `history-incomplete` and "run reconcile" (R113). This keeps the gap to the single repairable entry, and a refused rollback states the real reason, not "never a generation".
   The guard reads the alias, then its history, then the alias again, and uses the snapshot only if the alias did not move in between (bounded retries), so a concurrent commit is never mistaken for a missing entry (R144). It refuses only a move **from** the incomplete generation: a caller expecting another generation has already lost, and its CAS reports `alias-conflict` (R145).
6. **`reconcile` repairs it.** The missing entry is always the current generation's, and the current alias record reproduces it exactly, so `reconcile` appends it (`historyRepaired: g+1`). It never moves an alias and never lowers a generation (R111). Rollback then works.
7. A history that is missing more than the current entry cannot be rebuilt from the record and is reported, never guessed.

## 5. Failure taxonomy and recovery

| Code | State | Recovery |
| --- | --- | --- |
| `conflict` | CONFLICT | Stop. A content-addressed key holds different bytes: an integrity alarm for a human. |
| `bad-digest` | READBACK_MISMATCH | Stop. The target rejected the checksum. |
| `readback-mismatch` | READBACK_MISMATCH | Stop; never promote (R72). |
| `alias-conflict` | ALIAS_CONFLICT | Re-read the alias and re-decide. Never a blind retry. |
| `throttled`, `timeout` | THROTTLED, TIMEOUT | Bounded retry with exponential backoff (4 attempts); the error surfaces when exhausted. |
| `credential-expired` | CREDENTIAL_EXPIRED (PARTIAL) | Stop. A rerun with a renewed credential resumes, and uploaded objects come back `identical`. |
| (any mid-upload stop) | PARTIAL | Rerun publish: idempotent. |
| `target-not-verified` | TARGET_NOT_VERIFIED | The promote or rollback target is missing, unverified, or (for rollback) never a generation of the alias. |
| `receipt-failed` | RECEIPT_FAILED | Reported. If it is the intent receipt, the alias did not move. |
| `history-incomplete` | HISTORY_INCOMPLETE | The alias moved; its history append failed (§4.1). Moves are refused until `reconcile` repairs the history. |
| `protocol` (a 5xx, a broken contract) | FAILED | Stop and report. Before the commit, the alias did not move. |
| `grant-missing`, `cost-ceiling`, `not-available` | (refused) | Refused before any provider request (§6, §7; R98 for promote). |
| `render-policy-refused` | (refused) | For `publish` only, once the default render policy is render-policy/2: a render-policy/1 packet without `--allow-render-policy-1`. Refused before any provider request, from the local manifest; the fs store also refuses it at the commit (render-policy-2 R12). Alias moves are never gated. |
| `classification-refused`, `synthetic-only` | (refused) / REFUSED | For `publish`, refused before any provider request, from the local manifest. For `promote` and `rollback`, they are checked against the manifest on the target, after read-only verification and before any write; the result receipt is `REFUSED` (R99). |

The fault matrix (`v2-fault-matrix`) drives every fault in the draft's §2.7 through both adapters, one cell each. After every cell it checks that nothing was overwritten or deleted, that every alias points at content verified on the target, and that alias history is dense (V2-6; R100–R106). The contract suite covers the same faults row by row (V2-3, V2-4, V2-5, V2-6).

## 6. Authority, classification and data policy

**Grants.** `upload` for `publish` to a provider target; `promote` for `promote`, `rollback` and `reconcile`. They are separate, explicit (`--grant`), and have no defaults (R79). Local `fs` publishing is V1 behaviour and needs none.

**Report extension (`report-publication/v1`).** Optional: `publication: { classification: public | private-review | confidential, dataOrigin: synthetic | production }`.

- Absent means `private-review` and `production`.
- It is copied to `manifest.report.publication` only when present, so V1 packets are byte-identical (R86; `v2-schemas`).

**Site extension (SH-3b).** `site-input/v1` takes the identical, optional `publication` block, with the same names, values and default. It is copied to `manifest.site.publication` only when present, so V1 sites are byte-identical; present, it is part of the content-addressed identity bytes, so changing it changes the bundle's content id. `packetPublication()` (`src/publication/policy.mjs`) reads `manifest.site.publication` for a `site-bundle/v1` manifest and `manifest.report.publication` for a `packet/v1` manifest, by the manifest's own `schema` field; every other rule in this section (classification, access modes, synthetic-only) applies identically to a site bundle reaching a provider target.

**Access modes.**

| Target | Modes |
| --- | --- |
| fs | `local` |
| Cloudflare | `access-private`, `public` |

- **`public` has no code path this phase:** it is refused as `not-available`.
- `confidential` requires an access-controlled mode, and a non-public packet never reaches a public mode (R76; defence in depth).

**Synthetic data only.** During provider validation, provider targets accept only packets that declare `dataOrigin: synthetic` (R80).

**Real providers.** A `cloudflare` target is **refused by default** and becomes eligible only as §8.1 describes.

## 7. Receipts (`receipt/v2`) and cost

**Receipt fields.** A receipt is a closed schema with:

- `schema`, `receiptId`, `operation`, `phase` (intent/result);
- `target`, `targetKind`, `contentId`, `aliasName?`, `from/toGeneration?`;
- `startedAt`, `finishedAt`, `state` (one of the §4 and §5 states, or `REFUSED`), `transitions[]`;
- `objects[{key, sha256, bytes, outcome}]`, `readBack{verified, mismatches[]}`, `errorClass?`;
- `requestCount`, `bytesUploaded`, `estimatedCostUsd`;
- `credentialClass` (`none` / `access-service-token` / `publisher-signing-key`), `toolVersion`.

**Receipt rules.**

- A receipt MUST NOT contain a secret, token, signed URL or cookie. Every receipt is scanned against header-name and token-shape patterns, and against the adapter's live secret values, before it is written. A receipt that fails the scan is not written, and the operation fails `receipt-failed` (R75).
- Receipts are append-only.

**Cost.** Each receipt carries an estimated cost, and a per-target local ledger (JSONL) sums the month to date. An operation is refused before its first provider request when month-to-date plus the operation's projected cost would exceed the target's `costCeilingUsdPerMonth` (R81; R98 for promote). A failed operation still records what it spent (R97). Prices and ledger rules are in [cost-model.md](cost-model.md).

## 8. Transport and network boundary

There are two transports behind one interface:

- **`InProcessTransport`** (`src/publication/transport.mjs`) hands each request to a local mock endpoint object. The mocks and the tests use it.
- **`CloudflareHttpTransport`** (`src/publication/transports/cloudflare-http.mjs`) is the real transport to the test Worker's ingest API. It is refused by default (§8.1).

**Static gate:**

- No module under `src/` may import a network or provider-SDK module, or use a network client global, except:
  - the named V1 loopback uses: the review server's `createServer`, the service's loopback health `request` and port check `createServer`, and the bind policy's `isIP`;
  - `fetch`, in `transports/cloudflare-http.mjs` only.
- Only `targets.mjs` may import that module.
- It imports nothing but the error taxonomy and the pure endpoint rule.

Adding a network import (R77), or a network client anywhere else (R128), fails the build.

### 8.1 The real Cloudflare transport (provider-validation slice 05)

**Default refusal.** Each of these must hold, and each refusal is named:

1. **The target file gives an `endpoint`.** Without one, the target is `not-available`, in the policy and so also in the protocol (R120).
2. **The endpoint is the bare origin `https://<worker>.workers.dev`:** https (R122), a `workers.dev` host (R121), no port, user information, path, query or fragment. Anything else is `invalid`, and says why. This is "workers.dev only": no custom domain, route or DNS has a code path.
3. **The operation carries `--grant upload` or `--grant promote`.** Otherwise it is `grant-missing` (R123).
4. **The target's `credentialEnv` variable is present** (otherwise `credential-missing`, R124), and it is JSON with a non-empty `clientId` and `clientSecret` (otherwise `invalid`). No message ever echoes a credential value.

**Behaviour:**

- It sends requests only to its origin and only under `/_admin/` (R127).
- It adds no credential itself: the adapter adds the Access service-token headers.
- It **never follows a redirect**. An Access login redirect is reported as a rejected credential (`credential-expired`) (R125).
- A timeout or a failed connection is the retryable 599 (`timeout`).
- Response bodies are capped.

**Tests** connect it to a loopback server through a programmatic, test-only `connectTo`, which must be `http://127.0.0.1:<port>` (R126). No target field can set it. The server wraps the mock Worker, so publish and promote run over real HTTP on loopback.
- **Runtime guard.** The contract suite runs with every outbound network entry point replaced by a blocker that records and throws. Its final test asserts zero attempts, after watching the guard block a deliberate connect and fetch.

### 8.2 The deployable Worker (provider-validation slice 05)

`src/publication/worker/index.mjs` is the real module Worker behind the transport. It uses `src/publication/worker/schema.sql` for D1. It serves exactly the ingest API the adapter speaks (§3) and the serving contract (§2):

- **Access, on every request.** The request must carry a valid `Cf-Access-Jwt-Assertion`: RS256, signed by the team's current key, with `iss` equal to `TEAM_DOMAIN`, `aud` including `POLICY_AUD`, and `exp`/`nbf` within 60 s. The keys are fetched from `<TEAM_DOMAIN>/cdn-cgi/access/certs` and cached, and an unknown `kid` refetches once (Access rotates keys every 6 weeks, and old keys stay valid for 7 days).
  - `/_admin/*` additionally needs a **service-token** identity (`common_name`, no `email`) whose Client ID is in `SERVICE_TOKEN_CLIENT_IDS`.
  - Sources: developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/ and …/validating-json/, read 2026-09-27.
- **Ingest:**
  - Object puts are create-if-absent. The Worker hashes the body itself, and the R2 `put` also gets `onlyIf: If-None-Match: *` and the `sha256` option. A losing put is compared by stored SHA-256: `identical` or `conflict`.
  - The alias CAS is one D1 batch (a transaction): the conditional `UPDATE`/`INSERT`, and a history row written only if the move won. An operation ID makes a retried, committed move answer as itself.
  - Receipts are create-if-absent, and must match their path and `receipt/v2`.
  - A stored receipt can be read back (`GET /_admin/receipts/<id>.json`, admin-only, `no-store`), so a live run saves its receipts into evidence during the run (V2.1; `scripts/cf-receipts.mjs`). The route is read-only.
- **Serving:** the stored manifest `mediaType`, the V1 security headers, `ETag` = sha256, HEAD, single Range (206/416), 304, and alias 307 with `no-store`.
- **No deletion.** There is no delete route, no binding delete call and no `DELETE FROM`. Its only outbound request is fetching its own team's Access certs. The static gate checks all of this.
- **Tested under Node** against in-process R2 and D1 fakes (D1 on `node:sqlite`) and a fake Access edge (`test/v2/worker-bindings.mjs`; `test/unit/v2-worker.test.mjs`; R129–R143). A run on real `workerd` is NOT_EXECUTED (provider evidence).

## 9. Target configuration (`publication-targets/v1`)

- **Closed schema.** Each target has `name`, `kind`, `accessMode` and `costCeilingUsdPerMonth`, plus optionally `root`, `stateDir`, `ledgerDir`, `credentialEnv` and `endpoint` (an `https://` URL; §8.1). Unknown fields are rejected (a field such as `apiToken` cannot be added), and so is any string value that looks like a credential (R85).
- **Credentials.** A credential is read only from the environment variable named by `credentialEnv`, and it is never printed or written.
