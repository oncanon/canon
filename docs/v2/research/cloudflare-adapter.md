# Cloudflare adapter for Artifact Publisher V2: evaluation

- Status: research only. No Cloudflare account, token, API, `wrangler` account command, DNS, or upload was used or created.
- Evidence basis: public Cloudflare documentation, all read on **2026-09-26**. Citations appear inline as `[S#]`; see *Sources*.
- Anything not confirmed in the docs is marked **unverified**.

---

## 1. Recommendation

**Use one Worker with an R2 binding for packet bytes and a D1 table for alias records.** Do not use a public R2 custom domain, KV, Pages, or Workers Static Assets for packets.

| Concern | Decision |
|---|---|
| Packet bytes | One R2 bucket. Key layout: `p/<content-id>/<relative-path>`. Written once, with create-if-absent (`onlyIf` / `If-None-Match: *`) and a `sha256` integrity value on every put [S2][S3][S4]. |
| Server-side immutability | Optional R2 **bucket lock** rule on prefix `p/`, with indefinite retention, in the production bucket only [S5]. It stops deletes and overwrites even by the Worker. It does not stop a person holding an admin token from removing the rule. |
| Aliases | D1 table `alias(name PK, content_id, generation)`. Promotion is one conditional `UPDATE … WHERE name=? AND generation=?`. `meta.changes = 0` means the CAS lost. Leave D1 read replication **off**, so every read goes to the primary [S12][S13]. |
| Serving | The Worker serves `/p/<id>/…` from the R2 binding and sets every header itself. It serves `/a/<name>/…` as a `307` with `Cache-Control: no-store`, after reading the alias from D1. |
| Caching | No CDN or Cache API caching of Worker responses in V1 remote. The browser gets `immutable` + `ETag: <sha256>`, and the Worker answers `If-None-Match` with `304` without touching R2. Purge is never needed (see §3). |
| Ingest | **Preferred: Worker-mediated ingest.** A `POST /_admin/…` API sits behind Cloudflare Access and is called with an Access **service token**. The Worker performs the conditional put, the sha256 check and the alias CAS, so the local publisher holds **no Cloudflare API token and no R2 key**. Fallback: a bucket-scoped R2 S3 token (Object Read & Write) plus the same admin API for aliases only [S10]. |
| Private vs public | Start private. Put a Cloudflare Access app on the whole hostname, with humans via OTP or GitHub/Google/OIDC and agents via service tokens [S16][S17][S18]. Public review is a later policy change, not an architecture change. |
| Domain | Attach the Worker as a **Custom Domain** on a zone in the same account. Cloudflare then creates the DNS record and the certificate [S21]. **This is a separately authorized DNS action.** Until then, the Worker can run on `*.workers.dev` with one-click Access [S22]. |
| Cost | **$0/month** at the stated scale and at 10× (§9). Optional $5/month Workers Paid buys CPU headroom [S6]. |

Why not the others, in one line each:

- **Pages / Static Assets:** every publish is a whole-site deploy. Aliases would live in `_redirects` or in code with no CAS. The deploy credential is broader than the R2 object credential. There is a 20k-file-per-version cap on Free [S9][S14].
- **KV:** eventually consistent, with changes visible elsewhere after 60 s or more. No atomic operations [S8].
- **Public R2 custom domain:** it bypasses the Worker, so there is no CSP control. Cloudflare caches 404 responses. Consistency is relaxed under the cache [S7][S19].

---

## 2. Option comparison

| Criterion | **R2 + Worker (+ D1)** | **Pages (static + Functions)** | **Workers Static Assets** | **R2 public custom domain (no Worker)** |
|---|---|---|---|---|
| Publish unit | One object at a time, append-only | Whole-site deployment | Whole Worker version | One object |
| Create-if-absent | Yes: `onlyIf` / `If-None-Match` [S2][S3] | No (deploy replaces the site) | No | Via S3 API `If-None-Match` [S3] |
| SHA-256 check on write | Yes, binding `sha256` option [S2] | No (unverified) | No (unverified) | S3 API: partial, see §3.1 |
| Scales with packet count | Unbounded (storage-billed) | 20k files Free / 100k paid per site [S9] | 20k / 100k files per version [S14] | Unbounded |
| Alias CAS | D1 or Durable Object | `_redirects` (2,000 static) — no CAS [S9] | Worker code + D1 | Not possible |
| Full header control | Yes (Worker sets everything) | `_headers`, 100 rules, 2,000 chars/line; not applied to Functions responses [S15] | `_headers` same limits; not applied to Worker responses [S20] | Limited (object metadata + zone rules) |
| Content-type / nosniff / CSP | Worker | `_headers` | `_headers` | Transform rules (unverified) |
| Access-protectable | Yes | Yes | Yes | Yes, via Zero Trust [S19] |
| Least-privilege publish credential | Access service token only (Worker-mediated), or R2 bucket-scoped S3 token | Pages deploy permission (project/account-wide) | Workers Scripts Edit (account-wide) [S11] | Bucket-scoped S3 token |
| Rollback | Alias CAS back | Redeploy previous deployment (whole site) | Redeploy previous version (whole site) | None (no aliases) |
| Verdict | **Recommended** | Rejected | Rejected for packets (acceptable only for a static shell) | Rejected |

---

## 3. Numbered evaluation

### 3.1 Immutable object storage

**Conditional create (Worker binding).**
- `R2Bucket.put(key, value, { onlyIf })` accepts either an `R2Conditional` (`etagMatches`, `etagDoesNotMatch`, `uploadedBefore`, `uploadedAfter`) or a `Headers` object carrying conditional headers [S2].
- On a failed precondition, "`put()` returns `null`, and the object will not be stored" [S2].
- The R2 release notes (2022-07-30) state that `If-Match`/`If-None-Match` support the wildcard `*` "as per the HTTP standard" [S4].
- **Planned idiom:** `put(key, body, { onlyIf: new Headers({'If-None-Match': '*'}), sha256, httpMetadata })`. A `null` result means "already present". Then `head(key)` and compare `checksums.sha256` with the expected value. If equal, the write was idempotent. If different, that is an integrity alarm; it should be impossible with content-addressed keys.
- **Unverified:** the docs do not show `If-None-Match: *` passed through the *binding's* `Headers` form, as opposed to the S3 API. It must be proven against real R2 in a separately authorized test (§3.10).

**Conditional create (S3 API).**
- The PutObject row lists `If-Match`, `If-None-Match`, `If-Modified-Since` and `If-Unmodified-Since` as supported [S3].
- `x-amz-object-lock` is **not** supported [S3].

**Is the check atomic under concurrent writers?**
- The docs do not say.
- R2's documented concurrent-write rule is "the last writer to complete wins" [S7].
- A Cloudflare Community thread asks exactly this question ("Are R2 conditional PutObject predicates atomic for concurrent writers?"). It returned 403 to the fetcher, so its answer is **unverified**.
- **Mitigation:** content addressing makes a racing writer's bytes identical by construction. Integrity therefore does not depend on atomicity.

**SHA-256 on PUT.**
- The binding's `R2PutOptions.sha256` is "A SHA-256 hash to use to check the received object's integrity". `md5`, `sha1`, `sha384` and `sha512` are also accepted, but only one algorithm per put [S2].
- Stored checksums are exposed as `R2Object.checksums`. MD5 is included by default for non-multipart objects [S2].
- The docs do not state the exact error raised on mismatch (**unverified**). The Miniflare simulator computes the requested digests and validates them via its `Validator.hash()` [S24].
- **S3 API:** the release notes say "S3 putObject now supports sha256 and sha1 checksums" (2023-06-16) [S4]. The S3 compatibility table, however, does not list `x-amz-checksum-sha256` for PutObject, and describes SHA-256 only as a *composite* multipart checksum [S3]. The docs conflict, so this is **unverified**. This is one reason to prefer Worker-mediated ingest.

**ETag.**
- R2's native ETag is MD5-based, not SHA-256 (release note 2023-06-21 on multipart ETags; default MD5 checksum [S2][S4]).
- **The Worker must emit `ETag: "<sha256>"` from the key or manifest, not `object.httpEtag`.** This preserves V1 parity.

**Immutability options.**
1. Keys are content-addressed, and every write is create-if-absent. This is enforced in code.
2. **Bucket locks** "prevent the deletion and overwriting of objects … for a specified period — or indefinitely" [S5].
   - Rules are prefix-scoped (up to 1,000 per bucket) and apply to new and existing objects.
   - The strictest rule wins, and locks override lifecycle rules.
   - "A bucket cannot be emptied while any bucket lock rules are configured" [S5].
   - **Use them on production `p/` only, never on test buckets.**
   - Rules can be removed by an admin through wrangler or the API [S5], so a lock guards against the publish path, not against the account owner.
3. S3 Object Lock (`x-amz-object-lock`) is not supported [S3].

**Read-after-write.**
- R2 is strongly consistent: "readers will immediately see the latest object globally". Metadata updates, deletes and lists are also strongly consistent [S7].
- Caching through a custom domain relaxes this: 404s are cached, and overwritten objects are served stale. "These caching limitations don't apply to Worker API bindings or S3 API access" [S7]. This is another reason to serve through the binding.

### 3.2 Alias resolution at the edge

| Store | Consistency | CAS | Fit |
|---|---|---|---|
| **KV** | Eventual. "may take up to 60 seconds or more to be visible in other global network locations". Negative lookups are cached too [S8]. | None: "not ideal for applications where you need support for atomic operations" [S8] | Reject. A promoted alias could redirect to the old packet for 60 s or more, and could be absent at some locations after creation. |
| **R2 object per alias** | Strong read-after-write [S7] | `onlyIf: {etagMatches}` exists, but atomicity for concurrent writers is **unverified** (§3.1); last-writer-wins is documented [S7] | Possible, but its CAS race semantics are unproven. |
| **D1** | Writes go to a single primary. With read replication **off** (it is opt-in [S13]), reads also go to the primary. With replication on, reads need the Sessions API for sequential consistency [S13]. | A single `UPDATE … WHERE generation=?` is atomic under SQLite single-writer semantics (inferred from SQLite; the D1 docs do not state it for single statements). `batch()` statements "are SQL transactions … rolls back the entire sequence" [S12]. | **Recommended.** |
| **Durable Object (SQLite)** | Strongly consistent. Execution is serialized per object via input/output gates. "Each method is implicitly wrapped inside a transaction" [S23]. | Build it in code (read the generation, compare, write, with no intervening `await`) [S23] | Equally correct. More code, and harder to inspect than D1. Keep as the alternative. |

**Recommended alias schema and race semantics (D1).**

```sql
CREATE TABLE alias (
  name       TEXT PRIMARY KEY,
  content_id TEXT NOT NULL CHECK (content_id GLOB 'sha256-*'),
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE alias_history (
  name TEXT, generation INTEGER, content_id TEXT, updated_at TEXT,
  PRIMARY KEY (name, generation)
);
```

- **Create:** `INSERT INTO alias … generation=1`. A primary-key conflict means the alias already exists, and the caller gets `409`.
- **Promote:** in a single `batch()`, run `UPDATE alias SET content_id=?, generation=generation+1, updated_at=? WHERE name=? AND generation=?`, then `INSERT INTO alias_history SELECT … WHERE name=? AND generation=?+1`.
  - `meta.changes == 0` on the UPDATE means **CAS lost**, and the caller gets `409` with the current generation. There is no retry inside the Worker; the caller decides.
  - The history insert is a no-op when the UPDATE did not apply, because its `WHERE` targets `generation = expected+1`.
- **Guarantee:** exactly one of N concurrent promoters with the same `expected` generation succeeds. Generations are dense and monotonic.
- **Precondition:** the Worker must also `head()` the target packet's `manifest.json` in R2 *before* the CAS, so an alias can never point at a missing packet. R2's strong read-after-write makes that check meaningful [S7].
- **Reads:** a reader sees either the old or the new record, never a torn one. With replication off, a read issued after a successful promote sees the new record (**unverified** for global read latency; there is one primary).

### 3.3 Cache behaviour

- **Workers run before the cache**, so Worker responses are not CDN-cached automatically [S25].
- The **Cache API** is per data center, does not replicate, does not work with tiered cache, and cannot be purged by single-file purge [S25][S26].
- The Cache API also **does not work for Workers behind Cloudflare Access** [S26]. The recommended private deployment would therefore get no edge cache from it anyway.
- **Recommendation: no edge cache.** At this scale, every hit is one Class B R2 read, well inside 10 M/month free (§9).
  - Browsers get `Cache-Control: public, max-age=31536000, immutable` and a SHA-256 `ETag`.
  - The Worker answers `If-None-Match` with `304` by comparing against the id in the key. It needs no R2 call for that, which saves a Class B operation.
- For a **private** deployment, consider `private, max-age=31536000, immutable` so shared caches never retain Access-gated content. This is a policy decision for the maintainer.
- **Purge is not needed.**
  - Immutable URLs never change content.
  - Aliases are `307` + `no-store`, so no layer may store them.
  - The one purge hazard documented for R2 is negative-caching of 404s on a custom-domain bucket [S7]. That does not arise because the bucket is not publicly exposed.
- A Worker's own 404 for a not-yet-published packet id is not CDN-cached (Workers run before cache [S25]). Set `Cache-Control: no-store` on 404s anyway.
- **Tiered cache:** Smart Tiered Cache is free on all plans [S27]. It is irrelevant to this design because nothing is CDN-cached, and the Cache API is incompatible with it [S26].
- If edge caching is ever wanted for public review, the documented path is `fetch()` subrequests with `cf.cacheTtl`/`cacheEverything` to a cacheable origin [S25]. That would be a V3 concern.

### 3.4 Headers

**Set everything from the Worker.** `_headers` does not apply to Worker- or Functions-generated responses [S15][S20].

Every `/p/` response carries:

- `Content-Type`, from a Worker-side allowlist keyed by extension and cross-checked against the manifest:
  - `text/html; charset=utf-8`
  - `text/markdown; charset=utf-8`
  - `text/css; charset=utf-8`
  - `application/json`
  - evidence types
- `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control` and `ETag`, as in §3.3

Also store `httpMetadata.contentType` at put time [S2]. It is defense in depth, but the Worker's allowlist is authoritative. Do not blindly call `writeHttpMetadata()`: stored metadata must never override the security headers.

**Range requests.**
- `get(key, { range: request.headers })` is supported [S2][S28].
- The Worker must return `206` with `Content-Range`, computed from `object.range` and `object.size`.
- Reply `416` for unsatisfiable ranges. The exact error behaviour of the binding for bad ranges is **unverified**.
- Advertise `Accept-Ranges: bytes`.

**HEAD.**
- `bucket.head(key)` returns metadata only, or `null` [S2].
- The Worker returns the same headers with no body.
- The usage guide's sample handles GET/PUT/DELETE only [S28]. HEAD must be written explicitly and tested.

**Conditional GET.**
- The docs' sample returns `412` when `onlyIf` fails on GET [S28]. That is wrong for `If-None-Match` on GET/HEAD, which must be `304`.
- Handle `If-None-Match` in the Worker before calling R2. Do not forward it as `onlyIf`.

**Pages `_headers` limits**, in case Pages is ever reconsidered: 100 rules, 2,000 characters per line, not applied to Functions responses [S9][S15]. Workers Static Assets has the same limits, and its default for assets is `public, max-age=0, must-revalidate` [S20].

### 3.5 Custom domain and TLS boundary

**What is needed:**
1. A zone active on Cloudflare in the same account [S21].
2. A **Workers Custom Domain** on a hostname such as `review.<zone>`. "Cloudflare will create DNS records and issue necessary certificates on your behalf". You cannot use a hostname with an existing CNAME [S21].
3. A Custom Domain Worker "is treated as an origin" [S21].

TLS terminates at Cloudflare's edge, and no origin server exists. The R2 bucket gets **no** public custom domain and **no** `r2.dev` access. Leave `r2.dev` disabled: a bucket protected elsewhere "will remain publicly available through your r2.dev subdomain" if r2.dev is on [S19].

**Later DNS step (separately authorized, NOT performed here):**
- **If the zone is not yet on Cloudflare:** add the zone, change the registrar's nameservers, or use a partial CNAME setup [S19].
- **Then:** attach the Custom Domain to the Worker. This creates a proxied DNS record for the hostname plus an edge certificate [S21].
- **Credentials:** the token permission for attaching a Workers Custom Domain is not listed on the permissions page (**unverified**; probably `Workers Scripts Edit` plus zone-level permissions). Do this step in the dashboard, as a human with maintainer authorization, rather than through the publish or deploy token.
- **Before a domain exists:** `<worker>.<subdomain>.workers.dev` works. Access can be enabled on workers.dev and preview URLs with one click [S22].

### 3.6 Private versus public review

**Cloudflare Access in front of the Worker hostname.**
- **Identity providers:** Cloudflare's own default provider, One-time PIN (codes expire after 10 minutes), Microsoft Entra ID, any generic OIDC or SAML provider, and "the majority of OAuth providers" [S16][S17].
  - GitHub and Google as pre-built integrations are not enumerated on the page read. They are **unverified by citation**, although OIDC covers Google.
- **Agents:** a **service token** sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and the policy action must be **Service Auth** [S18].
  - The duration is configurable, "from hours to years".
  - The secret is shown once.
  - A single-header mode (e.g. `Authorization`) exists [S18].
  - Service tokens **do not consume seats** [S29].
- **Seats:** "A user consumes a seat when they perform an authentication event" [S29].
  - The **Free plan user count and the per-seat price are unverified** from primary docs today: the pricing page returned no numbers to the fetcher.
  - Search snippets and the historical Cloudflare blog say "free for up to 50 users", and standalone Access at $3 per user [S30]. Treat both as **unverified**.
  - For a personal deployment with a handful of reviewers, the expected cost is $0.
- **Defense in depth:** the Worker should validate `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, with the application `aud` [S31]. The `/_admin/*` routes must require a service-token identity in the JWT, not just "authenticated".
- **Path scoping:** Access applications can be scoped to paths [S32]. One policy set can therefore be public for `/p/*` and `/a/*` while `/_admin/*` stays service-token-only. Whether a Bypass on some paths combines with protection on others as intended is **unverified** in the page read.
- **Side effect:** the Cache API is not available behind Access [S26]. That is irrelevant under §3.3.

**Public review.**
- Anyone with a URL can read a packet. Content ids are unguessable, but alias names are guessable.
- No seats are consumed. The admin API still sits behind a service token.
- The risk is leaked evidence content. The maintainer should decide per packet or per alias; that is a future "visibility" field, not needed now.
- **Recommendation:** whole hostname private except `/_admin/*`, which requires the service token. Revisit public review later.

### 3.7 Least-privilege API token scopes

Permission names are from [S11]. There are three separate credentials. None of them is used in this research.

**A. Deploy token.** A human runs this, rarely. Use an account-owned API token with a **TTL end date**, e.g. 1 day, plus optional client IP filtering [S33].

| Permission | Scope | Why |
|---|---|---|
| Account · **Workers Scripts · Edit** | the one account | Upload the Worker, bindings and versions [S11] |
| Account · **Account Settings · Read** | the one account | wrangler account discovery (per the Workers Builds default token and a workers-sdk issue [S34]; exact necessity **unverified**) |
| Account · **D1 · Edit** | the one account | Apply alias-table migrations [S11]. Can be dropped once migrations are done. |
| Account · **Workers R2 Storage · Edit** | the one account | Only if wrangler must create the bucket or bucket-lock rules. Otherwise omit, and do it once in the dashboard. |
| Zone · **Workers Routes · Edit** | the one zone | Only if using Routes instead of a Custom Domain [S11]. Omit with Custom Domains. |
| User · User Details Read / Memberships Read | — | Only for *user* tokens, for `wrangler whoami`. Not needed with account tokens (**unverified**) [S34]. |

**B. Publish credential (routine use), preferred: an Access service token only.** It has no Cloudflare API permissions at all. The Worker's bindings (R2, D1) do the privileged work, and the Worker enforces the invariants. It gets a duration of weeks to months, with rotation [S18].

**C. Fallback direct-to-R2 publish.** An R2 API token with **Object Read & Write**, **restricted to the single bucket** [S10].
- Bucket scoping is "only supported by the S3-compatible API, not the Cloudflare REST API" [S10].
- The S3 access key id is the token `id`, and the secret is the SHA-256 of the token `value` [S10].
- The permission-group names used by the API are `Workers R2 Storage Bucket Item Write` / `…Read` [S10].
- Object Read & Write also allows **delete** of objects in that bucket (**inferred**: the permission is described as "read, write, and list"). The production bucket lock is what prevents deletion [S5].
- **Alias updates still go through the Worker admin API.** D1 Edit is account-wide [S11], and whether it can be restricted to a single database is **unverified**, so do not hand it to the publisher.

**TTL/expiry:** API tokens support TTL (start and end time) and client IP filtering [S33]. Access service tokens have a configurable duration [S18]. Whether R2 S3 credentials inherit the parent token's TTL is **unverified**. Assume they die with the token.

### 3.8 Test/preview naming, teardown, retention, rollback

**Naming.** Use one account, with names suffixed by environment:
- R2 bucket: `rp-packets-prod`, `rp-packets-test-<yyyymmdd>-<runid>`
- D1: `rp-aliases-prod`, `rp-aliases-test-<…>`
- Worker: `rp-publisher` (prod) / `rp-publisher-test` via a wrangler environment
- Test Worker served only on `workers.dev` with Access enabled [S22]. It never gets a Custom Domain.

**Isolation.** Test and prod share no bindings, and each environment's bindings are declared explicitly in wrangler config. Test uses no bucket locks, so that a test bucket can be emptied [S5].

**Teardown.** Delete the test Worker, the test D1 and the test bucket. R2 `DeleteObject` is free [S1].
- Under AGENTS.md, deletion of artifacts needs separate maintainer authority. The teardown script must list what it will delete and require an explicit confirmation flag.
- An R2 lifecycle rule on test buckets, e.g. expire after 7 days, is an alternative (lifecycle is mentioned in [S5]; config details are **unverified** here).

**Retention.** Production packets are kept forever. Optionally, apply a bucket lock rule on `p/` with indefinite retention [S5]. Storage growth is cheap (§9). Deletion of production packets is out of scope, and would require removing the lock by a human.

**Rollback.** Rollback moves the alias only. It is a CAS promotion to a previous `content_id` read from `alias_history`, with generation `n+1`, never a decrement. Objects are never deleted.
- Worker code rollback uses Worker versions/deployments (**unverified** detail). It is independent of packet data because data is not bundled in the Worker, which is an advantage over Pages and Static Assets.

### 3.9 Monthly cost model

**Free-tier limits.**

| Item | Free | Paid rate beyond included | Source |
|---|---|---|---|
| R2 storage (Standard) | 10 GB-month/month | $0.015/GB-month | [S1] |
| R2 Class A (Put, List, Copy…) | 1 M/month | $4.50/M | [S1] |
| R2 Class B (Get, Head) | 10 M/month | $0.36/M | [S1] |
| R2 egress | Free | Free | [S1] |
| R2 Delete | Free | Free | [S1] |
| Workers requests | 100,000/day (Free) | Paid $5/month includes 10 M/month, then $0.30/M | [S6] |
| Workers CPU | 10 ms per invocation (Free) | Paid includes 30 M CPU-ms, then $0.02/M CPU-ms; up to 5 min per request | [S6][S14] |
| Workers request body | 100 MB (Free plan) | — | [S14] |
| KV (not used) | 100k reads/day, 1k writes/day, 1 GB | — | [S6] |
| D1 | 5 M rows read/day, 100k rows written/day, 5 GB | 25 B reads/month, 50 M writes/month included on Paid | [S6] |
| Durable Objects (alternative) | 100k requests/day, 13,000 GB-s/day, SQLite backend only | 1 M requests, then $0.15/M | [S6] |
| Access seats | Free plan: "up to 50 users" (**unverified**, secondary source) | ~$3 per user standalone (**unverified**, historical) | [S29][S30] |

**Workload assumptions.** A packet is about 10 files and ~3 MB. Each publish costs:
- about 12 R2 Class A operations: roughly 10–12 object puts; the manifest `head` before promotion is Class B; alias writes go to D1, not R2;
- about 3 Worker requests on the admin API (ingest can be batched per packet — a design choice).

Each review view is about 5 requests (HTML, CSS, report, a few evidence files), each a Worker request plus one Class B read. 304s save the R2 read.

| | Stated scale | 10× |
|---|---|---|
| Packets/month | 30 | 300 |
| New storage/month | ~90 MB | ~900 MB |
| Storage after 12 months | ~1.1 GB | ~10.8 GB |
| Class A/month | ~360 | ~3,600 |
| Views/month | ~1,000 | ~10,000 |
| Worker requests/month | ~5,100 (~170/day) | ~51,000 (~1,700/day) |
| Class B/month | ~5,000 | ~50,000 |
| D1 rows written/month | ~100 | ~1,000 |
| **R2 cost** | **$0** | **$0 in year 1.** In year 2, storage above 10 GB is billed at ~$0.015/GB. At ~21.6 GB by month 24 that is about **$0.17/month** at the peak. |
| **Workers / D1 / Access** | **$0** | **$0** |
| **Total** | **$0/month** | **≈ $0–0.20/month** |

**CPU caveat.** The Free plan's 10 ms CPU per invocation [S6] should suffice for streaming a put while R2 computes and verifies the SHA-256 server-side. It would **not** be safe if the Worker itself hashed multi-MB bodies or canonicalised manifests.
- If ingest verification in the Worker grows, take **Workers Paid at $5/month** [S6].
- Budget ceiling for the recommendation: **$5/month**. Expected cost: **$0/month**.
- Domain registration, if a new domain is bought, is excluded (**unverified** price).

### 3.10 Emulator (Miniflare / workerd)

**Can test offline:**
- `wrangler dev` / Miniflare run the Worker on local `workerd`, and simulate KV, R2, D1 and Durable Objects bindings locally by default. Resources start empty [S35].
- Miniflare's R2 simulator implements `onlyIf` preconditions on put and get, and computes and validates the md5/sha1/sha256 digests supplied to put [S24]. Offline tests can therefore cover:
  - create-if-absent;
  - idempotent re-publish;
  - checksum-mismatch rejection;
  - header construction: CSP, nosniff, content-type allowlist, ETag = sha256, `304` handling;
  - range/`206` and HEAD code paths;
  - D1 alias CAS logic, including concurrent promotions via parallel requests to one local D1;
  - 307 + `no-store` alias redirects;
  - admin-API authorization logic, with a stubbed Access JWT.

**Cannot prove (need a separately authorized real-account test):**
- That production R2 honours `If-None-Match: *` passed as `Headers` through the binding, and its **atomicity under concurrent writers** (§3.1). The simulator is a SQLite-backed reimplementation [S24], not R2.
- The exact production error type and message on a sha256 mismatch.
- KV eventual consistency. Local KV is effectively immediately consistent, so the simulator would *hide* the hazard. This is a reason not to use KV.
- D1 read-replication behaviour and primary latency.
- Durable Object placement.
- Access enforcement, service-token auth and JWT signing keys.
- Custom Domain, TLS, DNS.
- CDN / Cache API / tiered-cache behaviour.
- Free-plan CPU and subrequest limits and billing.
- Bucket-lock enforcement: whether Miniflare simulates it is **unverified**.
- Real latency [S35].

Cloudflare itself says to report any undocumented local/production difference as a bug [S36]. Fidelity is best-effort, not guaranteed.

---

## 4. Open questions / unverified

1. **R2 binding with `If-None-Match: *` via `Headers`**, and whether conditional puts are atomic among concurrent writers [S2][S4][S7]. Community thread inaccessible (403).
2. **S3 API SHA-256 on PutObject:** the release notes say yes [S4]; the compatibility table suggests only CRC64NVME full-object checksums [S3].
3. **Error surfaced by the binding on a sha256 mismatch** (exception type or message).
4. **Access Free plan seat count and paid per-seat price today.** Only secondary or historical sources say 50 users and $3/user [S30].
5. **Pre-built Access IdP list** (GitHub, Google). Only Entra ID, OTP and generic OIDC/SAML were confirmed on the pages read [S16][S17].
6. **Mixed Bypass and protected paths** on a single Access hostname [S32].
7. **Minimum wrangler deploy permissions** with an account-owned token: is Account Settings Read strictly required? [S34]
8. **Token permission needed to attach a Workers Custom Domain** (not on the permissions page read) [S11][S21].
9. **Whether D1 Edit can be restricted to a single database** [S11].
10. **Whether R2 S3 credentials inherit the parent API token's TTL** [S10][S33].
11. **Whether Miniflare simulates bucket locks.**
12. **Workers script size limit:** the limits page read reported 64 MiB uncompressed for both plans [S14]. This differs from older compressed limits, and is irrelevant for a small Worker.
13. **What R2 `get()` does with an unsatisfiable range**, which the Worker needs to know in order to map it to `416`.
14. **Policy question for the maintainer:** `public` vs `private` in `Cache-Control` for Access-gated immutable responses.

---

## 5. Sources (all read 2026-09-26)

- [S1] R2 pricing — https://developers.cloudflare.com/r2/pricing/
- [S2] R2 Workers API reference — https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- [S3] R2 S3 API compatibility — https://developers.cloudflare.com/r2/api/s3/api/ ; S3 extensions — https://developers.cloudflare.com/r2/api/s3/extensions/
- [S4] R2 release notes — https://developers.cloudflare.com/r2/platform/release-notes/
- [S5] R2 bucket locks — https://developers.cloudflare.com/r2/buckets/bucket-locks/
- [S6] Workers pricing (incl. KV, D1, Durable Objects) — https://developers.cloudflare.com/workers/platform/pricing/
- [S7] R2 consistency model — https://developers.cloudflare.com/r2/reference/consistency/
- [S8] How KV works — https://developers.cloudflare.com/kv/concepts/how-kv-works/
- [S9] Pages limits — https://developers.cloudflare.com/pages/platform/limits/
- [S10] R2 API tokens — https://developers.cloudflare.com/r2/api/tokens/
- [S11] API token permissions reference — https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [S12] D1 Worker API (`batch()` transactions, `meta.changes`) — https://developers.cloudflare.com/d1/worker-api/d1-database/
- [S13] D1 read replication — https://developers.cloudflare.com/d1/best-practices/read-replication/
- [S14] Workers limits — https://developers.cloudflare.com/workers/platform/limits/ ; Workers Static Assets — https://developers.cloudflare.com/workers/static-assets/
- [S15] Pages `_headers` — https://developers.cloudflare.com/pages/configuration/headers/
- [S16] Access identity provider integration — https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/
- [S17] One-time PIN — https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/
- [S18] Access service tokens — https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- [S19] R2 public buckets / custom domains — https://developers.cloudflare.com/r2/data-access/public-buckets/
- [S20] Workers Static Assets `_headers` — https://developers.cloudflare.com/workers/static-assets/headers/
- [S21] Workers Custom Domains — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- [S22] One-click Access for Workers (changelog 2025-10-03) — https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/ ; reusable policies (2025-12-03) — https://developers.cloudflare.com/changelog/post/2025-12-03-reusable-access-policies/
- [S23] Durable Objects Storage API — https://developers.cloudflare.com/durable-objects/api/storage-api/
- [S24] Miniflare R2 simulator source — https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/workers/r2/bucket.worker.ts
- [S25] How the cache works with Workers — https://developers.cloudflare.com/workers/reference/how-the-cache-works/
- [S26] Workers Cache API — https://developers.cloudflare.com/workers/runtime-apis/cache/
- [S27] Tiered Cache — https://developers.cloudflare.com/cache/how-to/tiered-cache/
- [S28] Use R2 from Workers — https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
- [S29] Zero Trust seat management — https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/
- [S30] (secondary/historical; unverified) Zero Trust plans — https://www.cloudflare.com/plans/zero-trust-services/ ; "Zero Trust for everyone" blog — https://blog.cloudflare.com/teams-plans/
- [S31] Validating Access JWTs — https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- [S32] Access application paths — https://developers.cloudflare.com/cloudflare-one/policies/access/app-paths/
- [S33] Create API token (TTL, IP filtering, account tokens) — https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- [S34] Workers Builds token configuration — https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ ; workers-sdk issue #9129 — https://github.com/cloudflare/workers-sdk/issues/9129
- [S35] Workers local development — https://developers.cloudflare.com/workers/development-testing/
- [S36] Miniflare overview — https://developers.cloudflare.com/workers/testing/miniflare/
