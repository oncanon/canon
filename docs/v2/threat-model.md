# Publisher V2: threat model

- **Scope:** the `publication/v1` client (`src/publication/`), its two adapters (`fs` and Cloudflare), and the provider stack the Cloudflare adapter models: a Cloudflare Worker + R2 + D1 behind Access.
- **Phase:** local only. Every "mitigated" below is enforced in code and held by a named test or red control, but only against the in-process mocks. The provider-side half of each control (Access policy, bucket settings) is **designed, not executed**. The provider-evidence cells in [architecture.md](architecture.md) §3 stay NOT_EXECUTED until a separately authorized validation phase.
- **Sources:** research `docs/v2/research/cloudflare-adapter.md` (CF §n).

## Assets

| Asset | Why it matters |
| --- | --- |
| Packet bytes under `p/<content-id>/` | They are the review. A changed byte must never be served under an existing ID. |
| Alias records and history | An alias decides what a reviewer sees. Moving it is the publisher's most powerful act. |
| Publish credentials | An Access service token (Cloudflare) |
| Confidential client data inside packets | Acme and Globex reports |
| Receipts and the cost ledger | The audit trail, and the brake on spend |

## T1. Credential exposure

**Threat.** A token is leaked through a target file, a receipt, logs, or a long-lived key.

**Mitigations:**

- **Target files hold no secrets.**
  - `publication-targets/v1` is a closed schema, so a field such as `apiToken` cannot be added.
  - Any string value shaped like a credential is refused on load (`loadTargets`; R85).
  - Credentials are read only from the environment variable named by `credentialEnv`, and never printed or written.
- **Receipts are scanned before they are written.** The scan covers header-name patterns (`cf-access-client-secret`, `cf-access-jwt-assertion`, `authorization`, …), token shapes, and every live secret value the adapter holds. A failing receipt is not written, and the operation fails `receipt-failed` (R75).
- **The credential class is narrow by design.** The publisher holds only an Access service token. The Worker's bindings do the privileged work, so the publisher holds no Cloudflare API token and no R2 key (CF §3.7 B).
- **The mocks model expiry.** An expired token gives `credential-expired`, with PARTIAL state and an idempotent resume (V2-6).

**Residual risk:**

- A secret in a process environment is readable by that user's other processes.
- The deploy credential (a Cloudflare deploy token) is outside the publisher and must be human-held with a TTL (CF §3.7 A). It is not used in this phase.

## T2. Alias hijack or rollback abuse

**Threat.** An alias is moved to unverified or foreign content, a concurrent writer clobbers it, or rollback is used as an unconstrained promote.

**Mitigations:**
- **The Worker verifies Access itself** (defence in depth behind the edge). Every request needs a valid RS256 Access JWT for this team and audience. The ingest API needs an allowlisted service-token identity, so a reviewer's login cannot move an alias (protocol §8.2; R129–R133).

- **Promotion needs the separate `promote` grant** (R79).
- **Every move re-verifies the target content on that target first** (R71).
- **Every move is a compare-and-swap on `generation`,** with history written in the same step (R74). On Cloudflare it is D1 `UPDATE … WHERE generation = ?`.
- **An intent receipt precedes every move** (R83).
- **A committed move is never misreported, and history stays repairable.** A retry recognises its own committed write by operation ID. A history append that fails after the commit is a truthful `HISTORY_INCOMPLETE`, and no alias moves again until `reconcile` repairs the entry (protocol §4.1; R107–R115).
- **Rollback is restricted.** It may target only a content ID that was a past generation of that alias and still verifies (deviation 9; R73).

**Residual risk.** A holder of the promote grant plus a valid credential can move an alias to any verified packet the target holds. That is authority by design, and the receipt records it.

## T3. Stale alias

**Threat.** Readers see an old alias after a move, or a reconcile lowers an alias generation.

**Mitigations:**

- **There is no edge mirror.** No target keeps a second copy of an alias, so no copy can lag the authoritative one.
- **`reconcile` never lowers a generation.** It repairs only the history entry of the current generation.
- **Packets are content-addressed and immutable,** so a stale alias still points at complete, verified bytes.
- **The Cloudflare Worker reads D1 directly.** Stale reads there are fault-injected only as a robustness check (deviation 13).

**Residual risk.** None today: no target has an edge mirror.

## T4. Confidential-data leakage

**Threat.** A confidential packet is served publicly, or production data reaches a provider during validation.

**Mitigations:**

- **`public` exists only as the structurally separate public Cloudflare target** (V2.1 slice 04, mode (c); T9). Every mock target refuses it (`not-available`), and a private target never becomes public: the private module's `access_mode` admits only `exact-person` and `idp-domain`, and a public target sharing any setting with a private one is refused when the targets file loads.
- **The classification guard is the live guard for the public target.** A non-public class requires an access-controlled mode (R76; policy test). On the public target, `private-review`, `confidential` and unclassified packets are refused before any request is sent, and a promote or rollback re-checks the classification in the manifest held on the target (`test/unit/v21-public-target.test.mjs`).
- **Absent classification means `private-review`.**
- **Provider targets accept only `dataOrigin: synthetic`,** and absent means `production` (R80).
- **The real `cloudflare` kind is refused by default** (protocol §8.1).
- **The serving contract carries the V1 security headers** (a CSP with `script-src 'none'`, nosniff, `no-referrer`, `DENY`), checked over loopback HTTP (V2-7; R91).

**Residual risk.** Access enforcement is not exercised until provider validation. Whether an Access path Bypass combines as intended is unverified (CF §3.6).

**Access reviewer modes (V2.1).** Access is managed as code with two reviewer modes (`infra/cloudflare/terraform/access.tf`):

- **(a) exact-person** (the default): only the listed addresses. Each reviewer is audited individually and removed by removing one address.
- **(b) idp-domain:** anyone the named identity provider authenticates with an address in the configured domain. **This adds the IdP's trust:** whoever controls accounts in that domain at that IdP (its administrators, its account-recovery process and its MFA policy) decides who can read packets. A compromised or misconfigured IdP, or a domain shared more widely than intended, widens access with no change here. Use (b) only for an organisation's own IdP and domain, with MFA enforced there. The application restricts login to that one IdP (`allowed_idps`), so another IdP asserting the same domain is not accepted.

## T5. Cache retention after deletion

**Threat.** A packet that must be removed (a client request, contract end) is still served from caches.

**Position this phase:**

- **The publisher has no delete, purge or invalidation path.** The static gate enforces this, and so does the adapter interface (`publication-protocol.md` §3). Deletion is a separate `DeletionAdapter` under a separate grant and role, and it is **not built**.

**How retention differs by provider:**

- **Cloudflare:** the Worker's responses are not cached by the CDN (CF §1, §3.3), and alias redirects are `no-store` (V2-7 over loopback). A deletion therefore stops serving at the origin, except for browser caches holding `immutable` responses for up to one year.
- **Browsers:** no provider can recall a response already cached as `immutable`. This is inherent to V1's caching contract, and it is accepted for private-review data under access control.
- **The public target (V2.1 slice 04):** the same `public, max-age=31536000, immutable` objects are served with **no Access in front**, so any browser, proxy, crawler or archive may fetch and keep them. Deleting from the public bucket stops the origin, and alias moves take effect at once (`no-store`), but **nothing recalls a copy already taken: publishing public is irreversible in practice.** That is why only `public`-classified packets reach it. The classification sits in the content-addressed manifest, so it cannot be changed without changing the content ID. `docs/v2/cloudflare/runbook-public.md` *Caching and deletion* makes this a named decision (P-b) before the first upload.

**Residual risk.**

- R2 bucket lock would make deletion slower or impossible (CF §3.8). Retention is maintainer decision 4.

## T6. Tenant crossover

*Removed.* This threat applied only to the per-tenant AWS tier. An AWS tier was explored and retired; it is not part of the public release.

## T7. Supply chain

**Threat.** A dependency, SDK or build tool introduces network access or exfiltration.

**Mitigations:**

- **No provider SDK dependencies,** and no new packages this phase (`npm ci --offline`).
- **Static gate.** No module under `src/` may import a network or SDK module (`@aws-sdk/*`, `cloudflare`, `wrangler`, `miniflare`, `undici`, …). The only exceptions are the named V1 loopback uses (R77). The one network client is the real Cloudflare transport, named in the gate: only it may use `fetch`, and only the adapter factory may construct it, behind the default refusal (protocol §8.1; R120–R128).
- **Runtime guard.** The contract suite replaces every outbound network entry point and asserts zero attempts. The guard is itself tested against a deliberate connect and fetch.
- **Deployment tools stay out of the publisher.** `wrangler` is not installed. Whether provider validation may download it is maintainer decision 6.

**Residual risk.**

- `node_modules` holds the existing test-only browser tooling.
- The Worker source will need its own review when it is deployed.

## T8. Deploy-token scope drift in documents (V2-QA-8: accepted residual)

**Threat.** A document grants, or claims, a deploy-token scope that the canonical list does not. The maintainer could then create the token from the prose instead of the table.

**Mitigations:**

- **One source, generated copies.** `infra/cloudflare/deploy-token-scopes.json` is the only list. Every scope table is generated from it by `scripts/scope-tables.mjs` and checked byte for byte.
- **A lexical gate.** Outside those tables, `scripts/scope-mentions.mjs` refuses Cloudflare permission-group names (Cloudflare's own list, `infra/cloudflare/permission-vocabulary.json`), distinctive resource nouns, and "resource plus level" shapes. It is case- and separator-insensitive. A permanent in-suite regression re-runs every case ever planted against it.
- **The table is the authority.** Runbook step 3 has the maintainer grant only the table's **Granted: yes** rows, and check the token summary against the table row by row.

**Residual risk: accepted** (maintainer decision, 2026-09-28, V2-QA-8). The gate is lexical and does not understand free prose. QA showed these classes pass it:

- a verb before the resource ("can …", "may manage …", "write to …", "full access to …");
- an inflected level ("…ing", "…s") or an informal one ("… admin");
- the resource and its level in separate table cells;
- a link around the resource name, or the level in parentheses;
- a name wrapped across two lines;
- all-scope credentials described in prose ("all permissions"). The account-wide key and the account's all-scope role are named in the vocabulary, so naming them fails the gate.

These are covered by review and by the table's authority at token creation, not by the gate. The gate also flags some ordinary sentences that happen to share a permission's words; those are rephrased or listed as allowed phrases, each with its reason.

## T9. The public target's write path (V2.1 slice 04)

**Threat.** With no Access anywhere, the only barrier to writing the public target is the signed admin request. An attacker forges, replays, redirects or tampers with one; a misconfiguration turns the public Worker into an open one; or a private target is switched to public.

**Mitigations** (each with a test in `test/unit/v21-public-target.test.mjs` and a red control):

- **Ed25519 over a canonical message:**
  - The message holds the version tag `canon-admin-sig/v1`, the Worker's own `TARGET_ID`, the method, the path and query **exactly as received** (never normalized), the `content-type` as sent, the body's SHA-256 and a timestamp.
  - Binding the `content-type` (N-V21-1) stops a replay that wins the create-if-absent race from storing an attacker-chosen type. A signature over the old v1 message is refused.
  - A missing, malformed, wrong-key or other-target signature is refused, and so is a substituted body, path, query or method.
  - A timestamp more than 60 s away is refused.
- **The target ID binds a signature to one deployment.** A signature made for any other public target never verifies here.
- **The Worker holds only the public key,** a plain var: nothing secret is in Worker config or Terraform state. The private half is made by `scripts/public-target-keygen.mjs`:
  - it is written only to a new 0600 file outside the repository, or printed once;
  - the secret gate knows its format, so it cannot enter evidence.
- **Replay inside the window changes nothing,** shown by replaying every write:
  - object puts are create-if-absent (identical or conflict);
  - alias moves are compare-and-swap on the generation (a stale move loses, and the committed move is recognised by its operation ID);
  - receipts are append-only.
- **Fail closed.** The public Worker refuses every request, serving included, if:
  - its public key or target ID is missing or malformed;
  - any Access setting is present;
  - `MODE` is unknown.
  An Access token or service-token header on an admin request is refused, never taken as authentication.
- **Private mode never accepts a signature,** even with a public key configured.
- **Structural separation:** its own root module, state, names, deploy token and key (`test/unit/v21-public-iac.test.mjs`, 14 planted cases).

**Residual risk:**

- A holder of the private signing key can publish any public-classified packet and move public aliases until the key is deleted. It is the publisher's credential, like the private target's service token. It cannot delete, and every write leaves an append-only receipt. Rotation is a new key and a re-apply with the new public half.
- Signature verification on the real Workers runtime (WebCrypto Ed25519) is exercised here under Node only. It is a provider-evidence cell until the first authorized public deployment (runbook-public step P7 and the first signed upload).

## Out of scope this phase

- DNS, domains, TLS and ACM.
- Access and IdP configuration beyond the two reviewer modes (T4) and the public target's absence of Access (T9).
- WAF.

Each needs separately authorized provider work (CF §3.10).
