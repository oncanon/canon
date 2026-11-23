# Cloudflare automation coverage (provider-validation slice 06)

**Status.** PREPARED, NOT EXECUTED. Everything here was assessed from public documentation. No provider CLI was installed or downloaded, no `terraform`/`tofu init`, `validate` or `plan` was run, no API was called, and no account was touched.

**Scope.** The Cloudflare test deployment for Publisher V2 (Access-private, `workers.dev` only, synthetic data, $5/month ceiling):

- one Worker, `src/publication/worker/index.mjs` (slice 05);
- one R2 bucket and one D1 database;
- Cloudflare Access on the Worker's `workers.dev` hostname, with a reviewer policy and a Service Auth policy;
- one Access service token for the publisher.

## Coverage matrix

**Legend:** **yes** = documented as supported; **no** = documented or evident as unsupported; **unverified** = not settled by the sources read.

| Item | Wrangler | Terraform / OpenTofu (`cloudflare/cloudflare` v5) | Dashboard | Chosen |
| --- | --- | --- | --- | --- |
| Account, billing | no | no | yes | **manual** (the maintainer) |
| Account `workers.dev` subdomain | unverified | unverified | yes: Workers & Pages → "Change" next to the subdomain [U12] | **manual** |
| Deploy API token (1-day TTL) | no | yes (`cloudflare_api_token` / `cloudflare_account_token` exist [U17]), but that needs a token to create a token | yes [S33] | **manual**: credential creation is the maintainer's |
| R2 bucket | yes (`wrangler r2 bucket create`; unverified) | yes: `cloudflare_r2_bucket` (`account_id`, `name`, `storage_class`) [U7] | yes | **Terraform** |
| D1 database | yes (unverified) | yes: `cloudflare_d1_database` (`account_id`, `name`, `read_replication.mode`; exports `id`/`uuid`). **It does not apply schema** [U8] | yes | **Terraform** |
| D1 schema (`schema.sql`) | yes: `wrangler d1 migrations apply <DATABASE> --remote`; `wrangler d1 execute <DATABASE> --file … --remote` [U19][U18]. **Failed live** with code 9106 on `/memberships` (scopes the token does not hold) | **no** [U8] | yes: D1 console (unverified exact labels) | **The D1 query API** (V2.1): `scripts/d1-schema.mjs` sends each idempotent statement to `POST /accounts/{id}/d1/database/{id}/query` with the deploy token, then verifies against `sqlite_master` (runbook step 7). Wrangler is not used |
| Read replication off, on the D1 database | n/a | yes: `read_replication = { mode = "disabled" }` [U8]. Without the Sessions API, queries go to the primary anyway [U20] | yes | **Terraform** |
| Worker script and bindings (R2, D1, plain-text vars) | yes: `wrangler deploy` with `r2_buckets`, `d1_databases`, `vars` [U13] | yes: `cloudflare_workers_script` with `content_file` + `content_sha256`, `main_module` (required for ES modules), and `bindings` of type `r2_bucket` (`bucket_name`), `d1` (`id`) and `plain_text` (`text`) [U5] | yes | **Terraform**, so one tool owns the Worker. Wrangler is not used to deploy |
| Worker on `workers.dev` (no custom domain) | yes: `workers_dev = true`, `preview_urls = false` [U13][U12] | yes: `cloudflare_workers_script_subdomain` (`enabled = true`, `previews_enabled = false`) [U6] | yes [U12] | **Terraform** |
| Access application on the `workers.dev` hostname | no | a `cloudflare_zero_trust_access_application` exists (`domain`, `type = "self_hosted"`, exports `aud`) [U10], but whether `domain` accepts a `workers.dev` hostname is **unverified** | **yes, one click:** Workers & Pages → the Worker → Settings → Domains & Routes → `workers.dev` → **Enable Cloudflare Access**. The modal shows `POLICY_AUD` and `TEAM_DOMAIN` [U14] | **Terraform** (V2.1, `access.tf`): a `self_hosted` application for `<worker>.<sub>.workers.dev`, whose `aud` feeds the Worker. Whether the provider accepts the `workers.dev` hostname is **NOT_EXECUTED** until the first live apply (the live fire used the one-click path) |
| Access policy: reviewers (allow, emails) | no | yes: `cloudflare_zero_trust_access_policy` with `decision = "allow"` and `include = [{ email = { email = … } }]` [U11] | yes: **Manage Cloudflare Access** "change the email addresses you want to authorize" [U14] | **Terraform** (V2.1): mode by `access_mode`: exact-person (`email` rules) or idp-domain (`email_domain` through a named IdP) |
| Access policy: publisher (Service Auth) | no | yes: `decision = "non_identity"` ("Service Authentication") with `include = [{ service_token = { token_id = … } }]` [U11] | yes: Action **Service Auth**, include the service token [U15] | **Terraform** (V2.1): `non_identity` with the service token's ID |
| Access service token | no | yes: `cloudflare_zero_trust_access_service_token`. But **"client_secret … is sensitive and stored in Terraform state"** [U9] | yes: Zero Trust → Access controls → Service credentials → Service Tokens → **Create Service Token**. "This is the only time Cloudflare Access will display the Client Secret" [U15] | **manual** (runbook step 4), so the secret never enters any state file; IaC gets only its ID and Client ID |
| Worker vars `TEAM_DOMAIN`, `POLICY_AUD`, `SERVICE_TOKEN_CLIENT_IDS` | yes (`vars`) [U13] | yes (`plain_text` bindings) [U5] | yes | **Terraform**, in the one apply (runbook step 6); `POLICY_AUD` is the Access application's `aud`. Without them the Worker refuses every request (it fails closed) |
| Custom domain, DNS, routes, public R2 | — | — | — | **never** (not authorized; no code path) |
| Deletion or teardown | — | — | — | **not in this configuration.** The runbook lists teardown for the maintainer as a separate, unauthorized step |

**The irreducible manual steps** are:

1. the account, its `workers.dev` subdomain and the one-time R2 enablement;
2. the deploy API token;
3. the service token (kept out of IaC so its secret never lands in state);
4. for idp-domain mode only, the identity provider (configured once in the dashboard: runbook step 5, which also records the `identity_provider_id` it supplies).

Access itself (the application and its policies) and the D1 schema are no longer manual (V2.1).

The runbook (`runbook.md`) gives each step exactly.

## Deploy-token permissions for this configuration

The display names come from [U16]. One list serves every document for this (private) deploy token: `infra/cloudflare/deploy-token-scopes.json`. The public target's separate token has its own list (*The public target* below). The test `test/unit/pv-deploy-token-scopes.test.mjs` fails if any document disagrees with it.

**What the gate covers, and what it does not.** Every copy of this table is generated from the canonical list and checked byte for byte. Outside the tables, a lexical gate refuses Cloudflare permission-group names and "resource plus level" shapes. It does not understand free prose, so a scope described in other words is not detected. That is an accepted residual (`docs/v2/threat-model.md` T8, maintainer decision 2026-09-28). Prose is covered by review, and by the maintainer granting only this table's rows at token creation (runbook step 3). **The table is the authority over any prose.**

<!-- deploy-token-scopes:begin (generated from infra/cloudflare/deploy-token-scopes.json; checked by test/unit/pv-deploy-token-scopes.test.mjs) -->
| Permission | Granted | Needed for | Source | Necessity |
| --- | --- | --- | --- | --- |
| Workers Scripts Edit | yes | cloudflare_workers_script (the Worker) and cloudflare_workers_script_subdomain (its workers.dev route) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to Cloudflare Workers scripts." | verified |
| Workers R2 Storage Edit | yes | cloudflare_r2_bucket (Terraform creates the test bucket) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to Cloudflare R2 Storage." | verified |
| D1 Edit | yes | cloudflare_d1_database, and the schema over the D1 query API (scripts/d1-schema.mjs, runbook step 7; V2.1 replaces wrangler); held for the token's whole 1-day life, not only during migrations (architecture.md deviation 18) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to D1." | verified |
| Account Settings Read | yes | account discovery by the provider (wrangler is no longer used; the Scope proof settles whether it is needed) | docs/v2/research/cloudflare-adapter.md §3.7 [S34] (Workers Builds default token; workers-sdk issue #9129); https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants read access to Account resources, account membership, and account level features." | unverified; drop if apply succeeds without it |
| Access: Apps and Policies Edit | yes | cloudflare_zero_trust_access_application and cloudflare_zero_trust_access_policy (V2.1 Access as code; runbook step 6) | https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/v5.26.0/docs/resources/zero_trust_access_policy.md (read 2026-09-29): "Accepted Permissions: Access: Apps and Policies Read, Access: Apps and Policies Write"; https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-28) lists it as "Access: Apps and Policies Edit" | verified |
| Access: Service Tokens Edit | no | the service token is created in the dashboard (runbook step 4), so its secret never enters Terraform state | — | — |
| Zone · Workers Routes Edit | no | no zone and no route: workers.dev only | — | — |
| User Details Read / Memberships Read | no | an account-owned token needs no user permissions | — | — |
<!-- deploy-token-scopes:end -->

## The public target (V2.1 slice 04, mode (c))

A **structurally separate** deployment for packets classified `public`. It lives in its own root module, `infra/cloudflare/terraform-public`, with its own state, and its runbook is `runbook-public.md`. It shares no resource, variable, name prefix, state or credential with the private deployment above. `test/unit/v21-public-iac.test.mjs` derives that from both modules as parsed, and 14 planted cases prove the check refuses sharing.

| Item | Terraform / OpenTofu | Dashboard | Chosen |
| --- | --- | --- | --- |
| Public R2 bucket `rp-public-test-<run>` | yes: `cloudflare_r2_bucket` [U7] | yes | **Terraform** (public module) |
| Public D1 database `rp-public-aliases-test-<run>` | yes: `cloudflare_d1_database`; no schema [U8] | yes | **Terraform**, schema by `scripts/d1-schema.mjs` against the public database |
| Public Worker `rp-public-test` (the same source, `MODE = "public"`) | yes: `cloudflare_workers_script`; bindings `PACKETS`, `ALIASES`, and plain-text `MODE`, `TARGET_ID`, `PUBLISHER_PUBLIC_KEY` [U5] | yes | **Terraform** (public module) |
| Public Worker on `workers.dev` (previews off) | yes: `cloudflare_workers_script_subdomain` [U6] | yes | **Terraform** (public module) |
| Cloudflare Access for the public target | — | — | **never**: no application, policy or service token, for readers or for `/_admin/` |
| Publisher authentication for writes | n/a | n/a | **signed admin requests**: Ed25519 over a versioned message naming the target, verified by the Worker with the public half of a key made by `scripts/public-target-keygen.mjs`. The private half never enters IaC, state or evidence |
| Public deploy token `rp-public-deploy-<run>` | no | yes | **manual** (`runbook-public.md` step P2): a separate token from the private one, with no Access scope |
| Receipt read-back (evidence) | n/a | n/a | **`scripts/cf-receipts.mjs --targets … --target cf-public --live`**: every receipt GET is a signed admin request (the mode comes from the target); dry run by default (`runbook-public.md` *Evidence capture*) |
| Captured signed requests | n/a | n/a | `scripts/cf-capture.mjs` strips `x-canon-signature` at the source |
| Caching and deletion | — | — | objects are `public, max-age=31536000, immutable`: copies already fetched by third parties cannot be recalled. See `runbook-public.md` *Caching and deletion* and `docs/v2/threat-model.md` T5 |

### Public deploy-token permissions

Generated from `infra/cloudflare/deploy-token-scopes-public.json`. It is a separate list from the private deploy token's, and the same test checks every copy.

<!-- deploy-token-scopes-public:begin (generated from infra/cloudflare/deploy-token-scopes-public.json; checked by test/unit/pv-deploy-token-scopes.test.mjs) -->
| Permission | Granted | Needed for | Source | Necessity |
| --- | --- | --- | --- | --- |
| Workers Scripts Edit | yes | cloudflare_workers_script.public_publisher (the public Worker) and cloudflare_workers_script_subdomain.public_publisher (its workers.dev route) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to Cloudflare Workers scripts." | verified |
| Workers R2 Storage Edit | yes | cloudflare_r2_bucket.public_packets (Terraform creates the public bucket) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to Cloudflare R2 Storage." | verified |
| D1 Edit | yes | cloudflare_d1_database.public_aliases, and the schema over the D1 query API (scripts/d1-schema.mjs against the public database); held for the token's whole 1-day life | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants write access to D1." | verified |
| Account Settings Read | yes | account discovery by the provider for the public module (unverified here as for the private token: drop it if the public apply succeeds without it) | docs/v2/research/cloudflare-adapter.md §3.7 [S34] (Workers Builds default token; workers-sdk issue #9129); https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-09-27): "Grants read access to Account resources, account membership, and account level features." | unverified; drop if apply succeeds without it |
| Access: Apps and Policies Edit | no | the public target has no Access application or policy (mode (c): no Access anywhere) | — | — |
| Access: Service Tokens Edit | no | the public target has no Access service token; its publisher signs requests with its own key | — | — |
| Zone · Workers Routes Edit | no | no zone and no route: workers.dev only | — | — |
| User Details Read / Memberships Read | no | an account-owned token needs no user permissions | — | — |
<!-- deploy-token-scopes-public:end -->

## Runbook guards: what they catch

Two tests in `test/unit/v21-acceptance-fixes.test.mjs` guard the runbooks. **Both are lexical.** They catch exactly what is quoted below, and nothing else: anything else is a **known limit**, not a guarantee.

**What the self-check enforces** (one line per assertion, rendered from `CLAIMS` in the test):

- (C1) Each regex of `TOKEN_GUARD` and `STEP_GUARD` is quoted as `/source/flags`, byte for byte, among its own guard's catches.
- (C2) The line quoting each regex says "in any case" if its flags include `i`, and "case-sensitive" if they do not.
- (C3) The script alternation inside the token guard's use regex is exactly the derived list of scripts that import `scripts/lib/cf-api.mjs` compared exactly as regex source, with every dot escaped (so nothing hides behind `<cf-api script>`, and no dot matches any character), and the token block names each of them.
- (C4) QA's caught token cases (V1, V9, W5) are caught by the token guard.
- (C5) Each token known limit (V2, V3, V4, W2, W3, W4, V7, V8) is not caught, is listed under the token guard's known limits, and is not among its catches.
- (C6) The caught step-reference cases (X1, X6, X8) are caught by the step guard: a step its runbook lacks (X1, X6), and a step number past the last step of the private runbook (X8).
- (C8) The step-references line names exactly the file extensions the step guard reads (`STEP_EXTENSIONS`).
- (C7) Each step-reference known limit (X2, X3, X4, X5) is not caught, is listed under the step guard's known limits, and is not among its catches.

The self-check is test `[V2.1-01] the runbook guards claim exactly what they catch …` (QA V2.1-QA-3, V2.1-QA-4). Its body only runs `CLAIMS` and compares both lists here with the test's own, so a list and the assertions cannot diverge.

**NOT enforced** (rendered from `NOT_ENFORCED` in the test):

- (N1) What the token guard walks: which runbooks, and which of their sections (*Steps* rows, *Teardown* items). Changing that set is not detected here.
- (N2) The step guard's walk: which directories it reads, and its skip list (the two runbooks, the control table, this test). Changing either is not detected here. (Its file extensions are enforced: C8.)
- (N3) The step guard's topic words (`TOPICS`): they are listed in the test and not quoted here.
- (N4) Any phrasing not listed as caught or as a known limit: it is neither promised caught nor pinned as missed.

**Token order**, test `[V2.1-05] lexical token-order guard …`. It reads the *Steps* table rows, then the *Teardown* items, of both runbooks, in order:

- **A revocation** is a match of `` /\brevoke\b/gi ``, in any case: the whole word "revoke".
- **A new token** is a match of `` /Create Token|create a new 1-day/gi ``, in any case.
- **A use of the deploy token** is a match of `` /node scripts\/(?:<cf-api script>)[^`]*--live|tofu (?:plan|apply|destroy) -var-file/g ``, case-sensitive.
  - `<cf-api script>` is any script that imports `scripts/lib/cf-api.mjs`. The list is derived; today it is cf-absence, cf-preflight, cf-token-verify and d1-schema.
  - So a script use needs `--live` later in the same code span, and a Terraform use needs its `-var-file`.
- **It fails** on any use after a revocation with no new token in between.
- **Known limits (not caught):**
  - a revocation phrased as "is revoked" (V2), "delete the teardown token" (V3) or "roll the token" (V4);
  - a use written as `terraform destroy -var-file` (W2), `tofu destroy -auto-approve` (W3), `tofu apply <planfile>` (W4), `npx wrangler … --remote` (V7), or `curl … Bearer $CLOUDFLARE_API_TOKEN` (V8).

**Step references**, test `[V2.1-01] lexical step-reference guard …`. It reads the files ending `.md`, `.mjs`, `.tf`, `.json` or `.example` under `docs`, `infra`, `scripts`, `src` and `test`, except the two runbooks, the control table and the test itself:

- **A reference to the private runbook** is a match of `` /\brunbook(?:\.md`)? step (\d+)\b/g ``, case-sensitive.
- **A reference to the public runbook** is a match of `` /runbook-public(?:\.md`)? step (P\d+)\b/g ``, case-sensitive.
- **It fails** in three cases: the cited step does not exist; no known topic word is on the reference's line or the line before (a reference whose topic is further away therefore fails; it is not missed); or the cited step's row does not do that topic.
- **Known limits (not caught):**
  - "Runbook step N" with a capital R (X2);
  - "step N of the runbook" (X3);
  - any other word order, such as "the runbook's step N" (X4);
  - "Runbook-public step PN" with a capital R (X5).

## Offline validation performed

| Check | Result |
| --- | --- |
| `terraform fmt -check -recursive` (Terraform v1.12.0) | exit 0 |
| `tofu fmt -check -recursive` (OpenTofu v1.12.3) | exit 0 |
| Instrument check | a misformatted copy exits 3, a syntax error exits 2 |
| Public module `infra/cloudflare/terraform-public`: `terraform fmt -check` and `tofu fmt -check`, sandboxed, `CHECKPOINT_DISABLE=1` | exit 0 (a misformatted copy exits 3); every planted public case is valid HCL under both (`scripts/hcl-fmt-acceptance.mjs`) |
| `terraform validate` / `tofu validate` | **NOT_EXECUTED**: needs `init`, which downloads the provider (not authorized) |
| `plan` / `apply` | **NOT_EXECUTED**: needs the provider and the API |
| Deploy-token scope sufficiency for `apply` | **NOT_EXECUTED**: whether these scopes together suffice for `apply` is shown only by the first authorized apply. 'verified' says only that a scope's documented description covers its resource. (QA N-PV-5; the canonical list's `sufficiencyForApply`) |
| Schema check against the provider | **NOT_EXECUTED**: no provider schema is cached, and none may be downloaded. Attribute names come from the provider docs above |
| `wrangler.jsonc` | parses as JSON after removing comments; holds no secret-like value |
| `migrations/0001_init.sql` | byte-identical to `src/publication/worker/schema.sql` (checked by `test/unit/pv-iac-allowlist.test.mjs`) |
| wrangler dry-run (`wrangler deploy --dry-run`) | **NOT_EXECUTED**: wrangler is not installed (decision 6) |

**Dependency.** `content_file` and the wrangler `main` point at `src/publication/worker/index.mjs`, which exists on slice 05's branch (`v2/cf-transport`). They resolve once slice 05 is integrated.

## Sources (all read 2026-09-27; public documentation only)

- [U5] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/workers_script.md
- [U6] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/workers_script_subdomain.md
- [U7] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/r2_bucket.md
- [U8] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/d1_database.md
- [U9] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/zero_trust_access_service_token.md
- [U10] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/zero_trust_access_application.md
- [U11] https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/zero_trust_access_policy.md
- [U12] https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- [U13] https://developers.cloudflare.com/workers/wrangler/configuration/
- [U14] https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/
- [U15] https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- [U16] https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [U17] https://github.com/cloudflare/terraform-provider-cloudflare/tree/main/docs/resources (the listing was truncated by the page; `api_token.md` and `account_token.md` were seen)
- [U18] https://developers.cloudflare.com/d1/reference/migrations/
- [U19] https://developers.cloudflare.com/workers/wrangler/commands/d1/
- [U20] https://developers.cloudflare.com/d1/best-practices/read-replication/
- [S33] and research §3.7: `docs/v2/research/cloudflare-adapter.md` (`854b496a…d7ee`), read 2026-09-26 by the maintainer

**Also read for slice 05's Worker:** https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/ and https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ (JWT claims; RS256; certs URL; keys rotate every 6 weeks, and the previous key stays valid for 7 days). Also https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ and https://developers.cloudflare.com/d1/worker-api/d1-database/.

**Not verified by any source read:**

- the exact error R2 raises on a sha256 mismatch;
- whether a Terraform Access application accepts a `workers.dev` domain;
- the D1 console's exact labels;
- the identity-provider screens' exact labels, and where an identity provider's ID is displayed (runbook step 5 says to stop rather than guess);
- whether switching `access_mode` updates the Access application and the reviewers policy in place (runbook step 11 says to stop if the plan destroys or replaces anything);
- whether the scope the deploy-token table marks unverified is needed at all;
- the `~> 5.0` provider pin (choose the exact version at the first authorized `init`, and commit the lock file).
