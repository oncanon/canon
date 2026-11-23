# Cloudflare public target: runbook for the maintainer (V2.1 slice 04, mode (c))

**PREPARED, NOT EXECUTED.** Nothing here has been run. **Every step below that touches Cloudflare is an external action and needs your explicit confirmation at that step.** Approving this runbook does not authorize any of them. The private deployment's runbook is `runbook.md`; nothing here changes it.

- **What the steps build:** a **structurally separate public target**:
  - its own Worker, `rp-public-test`, on `workers.dev`, running the same Worker source with `MODE = "public"`;
  - its own R2 bucket, `rp-public-test-<run>`, and its own D1 database, `rp-public-aliases-test-<run>`;
  - its own deploy token, `rp-public-deploy-<run>`;
  - **no Cloudflare Access of any kind.**
  It is for **synthetic data only**, with a **$5/month** ceiling.
- **Who may read:** anyone with the URL. Only packets classified `public` are ever published to it. The publisher refuses `private-review`, `confidential` and unclassified packets before any request, and again on promote and rollback.
- **Who may write:** only the holder of the publisher signing key. Every `/_admin/` request is signed (Ed25519 over a versioned message naming this target), and the Worker holds only the public half.
- **Coverage and sources:** `coverage.md`, *The public target*.

**Conventions:** `<run>` is `<yyyymmdd>-<runid>`, for example `20260930-a1`. **Evidence:** capture what each step lists, and nothing secret. Never capture the signing key, the API token, or any request's `x-canon-signature`.

**Credentials on disk:** exactly one. Step P1 writes the publisher signing key to a new file with mode 0600, outside the repository; the teardown deletes it. The deploy token lives only in `CLOUDFLARE_API_TOKEN`, never in a file. **No credential reaches the evidence.**

## Before you start (decisions)

| # | Decision | Needed for |
| --- | --- | --- |
| P-a | Approve downloading the Cloudflare provider for this directory (`tofu init` in `infra/cloudflare/terraform-public`) | step P4 |
| P-b | Publishing public is irreversible in practice (see *Caching and deletion*): confirm that only synthetic, public-classified packets go here | step P8 |
| P-c | Cost ceiling $5/month (target file `costCeilingUsdPerMonth: 5`) | the publisher target |

## Steps

| # | Where | Do | Expected result | Evidence to capture |
| --- | --- | --- | --- | --- |
| P0 | The private runbook (`runbook.md`), steps 1 and 2 | **Prerequisites, once per account.** Do the private runbook's step 1 (copy the **Account ID**) and step 2 (set the account's `workers.dev` subdomain, and **enable R2 once for the account**). If they were already done for the private deployment on this account, only confirm them. No deploy-token scope can enable R2: without it the first apply fails with HTTP 403, code 10042. | The Account ID and `<sub>` are known, and R2 is enabled. | As in the private runbook's steps 1 and 2 (or a note that they were already done, with that run's evidence). |
| P1 | Terminal (repo root) | Generate the publisher signing key: `node scripts/public-target-keygen.mjs --out <operator path outside the repo>`. The script writes the credential to a new file with mode 0600, refuses a path inside the repository or an existing file, and prints only the public half: `publisher_public_key = "canon-ed25519-pk:…"`. | A new 0600 key file; one `publisher_public_key` line. | The `publisher_public_key` line (not a secret). Never the key file. |
| P2 | **Manage Account** → **Account API Tokens** → **Create Token** → **Custom token** | Name `rp-public-deploy-<run>`: a **new token**, never the private deployment's. Permissions: **grant only the Granted: yes rows of the generated *Public deploy token scopes* table below**, nothing else, on this account only. **The table is the authority.** TTL end date: tomorrow. | The token is shown once. Put it only in `CLOUDFLARE_API_TOKEN` for steps P4 to P6. | The token's name, ID and expiry (never the token). |
| P3 | Terminal, `infra/cloudflare/terraform-public` | Copy `test.tfvars.example` to `test.tfvars`. Fill in `account_id`, `run_id`, and step P1's `publisher_public_key`. All are identifiers or a public key. | The tfvars file has three values and no secret. | The file (it holds no secret). |
| P4 | Terminal, `infra/cloudflare/terraform-public` (after P-a) | **Pre-flight first**, from the repo root with step P2's token: `node scripts/cf-preflight.mjs --account <account_id> --live`. It must print `OK r2-enabled`; if it reports R2 not enabled (exit 3), go back to step P0, wait a few minutes for the enablement to propagate, and re-run it. Then `tofu init`: it must leave this directory's committed `.terraform.lock.hcl` unchanged (`git diff --exit-code .terraform.lock.hcl` must exit 0). Then `tofu plan -var-file=test.tfvars` (review: exactly four resources, no Access), then `tofu apply -var-file=test.tfvars`. This directory is its own root module with its **own state**, so it never plans the private deployment. | `OK r2-enabled`; the lockfile unchanged; four resources created: the bucket, the database, the Worker and its `workers.dev` route. | The pre-flight output and the `git diff --exit-code` result; the plan's resource list, the apply summary, and the outputs (`public_worker_name`, `public_target_id`, `public_d1_database_id`, `public_bucket_name`). |
| P5 | Terminal (repo root) | Apply the D1 schema to the **public** database: `node scripts/d1-schema.mjs --account <account_id> --database $(tofu -chdir=infra/cloudflare/terraform-public output -raw public_d1_database_id)` (dry run: review), then the same with `--live`. | Tables `alias` and `alias_history` exist in the public database. | The script's output. |
| P6 | **Manage Account** → **Account API Tokens** | **Revoke `rp-public-deploy-<run>`** as soon as P5 succeeds. Publishing never uses it (step P8 signs with the key). | The token is revoked. | The token list showing it revoked. |
| P7 | Terminal (repo root) | `node scripts/cf-capture.mjs --out <evidence>/public --name unsigned-admin --url https://rp-public-test.<sub>.workers.dev/_admin/aliases`. No credentials. | **403** `public: no signature timestamp`: the public Worker refuses an unsigned admin request. There is no Access redirect, because the public target has no Access. | `unsigned-admin.request`, `.headers` and `.body`. |
| P8 | Terminal (publisher repo) | Create the target file entry: `{"name":"cf-public","kind":"cloudflare","accessMode":"public","targetId":"<public_target_id>","endpoint":"https://rp-public-test.<sub>.workers.dev","credentialEnv":"RP_CF_PUBLIC","costCeilingUsdPerMonth":5,"ledgerDir":"dist/cf-public-ledger"}`. It must share no endpoint, credential variable, state or ledger with any private target, or the file is refused. Then `export RP_CF_PUBLIC="$(cat <P1 key file>)"`. **Stop here.** The first `--grant upload` and the first `--grant promote` to this target are each a separate confirmation (P-b). | The target file loads. | The target file (it holds no secret). |

## Evidence capture: receipt read-back (V2.1-QA-1)

After **every** upload and promote to the public target (each a separate confirmation, P-b), read its receipts back into the run's evidence, during the run:

`node scripts/cf-receipts.mjs --targets <targets.cf.json> --target cf-public --out <evidence> --ids-from <the publisher's output> --live`

- **The mode comes from the target.** `cf-public` is `public`, so every receipt GET (`/_admin/receipts/<id>.json`) is a **signed admin request** made with the key in `$RP_CF_PUBLIC`. No Access header is sent: the public Worker refuses them.
- **Checks:** each receipt is checked as `receipt/v2`, with a matching ID, free of the signing key, and passing the secret gate. Only then is it saved.
- **Without `--live`** it is a dry run. It shows the requests and their authentication header names, and contacts nothing.
- **Evidence:** `<evidence>/receipts/<id>.json` for every receipt, and the command's JSON output. A capture of a signed request (`scripts/cf-capture.mjs`) records `x-canon-signature` as `<stripped: N bytes>`.

## Public deploy token scopes

This table is generated from `infra/cloudflare/deploy-token-scopes-public.json` and checked by a test. It is the only authority for the public deploy token: step P2 grants exactly its **Granted: yes** rows. It is a different token, with different scopes, from the private deployment's: the public module has no Access, so the token holds no Access scope.

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

## Caching and deletion

**Publishing to the public target is irreversible in practice.** Read `docs/v2/threat-model.md` T5 before step P-b.

- **What anyone may keep:**
  - Packet objects are served `public, max-age=31536000, immutable`, with no Access in front.
  - Any browser, proxy, crawler or archive that fetched a packet may keep it for a year or forever.
  - No provider action can recall a copy fetched by a third party.
- **What the target itself holds:** the Worker's responses are not cached by the CDN (the same as the private target). Deleting an object from the bucket therefore stops the origin serving it. It does not reach copies already taken.
- **Aliases** are `no-store` redirects, so moving or removing an alias takes effect at once for new readers. The content IDs it pointed to stay valid URLs for anyone who kept them.
- **The publisher has no delete, purge or invalidation path.** Deletion is the maintainer's, in the dashboard, and is listed under *Teardown*.
- **Consequence:** only packets that may be public forever are classified `public`. The publisher refuses any other classification for this target, and the classification is in the content-addressed manifest, so it cannot be changed after the fact without changing the content ID.

## Teardown (listed for confirmation; NOT authorized by this runbook)

1. Create a new 1-day `rp-public-deploy-<run>` token exactly as in step P2. Empty the public bucket in the dashboard (**R2** → `rp-public-test-<run>` → select all → **Delete**). Emptying it is deletion, and it does not recall copies already fetched (*Caching and deletion*).
2. `tofu destroy -var-file=test.tfvars` in `infra/cloudflare/terraform-public`. It removes only the public target's resources, because this directory's state holds nothing else.
3. **Prove absence with the same token, before revoking it** (`cf-absence --live` reads the account with `$CLOUDFLARE_API_TOKEN`): `node scripts/cf-absence.mjs --account <account_id> --worker rp-public-test --bucket rp-public-test-<run> --database rp-public-aliases-test-<run> --endpoint https://rp-public-test.<sub>.workers.dev --live --out <evidence>/public-absence.json`. It must exit 0 (every listing is unfiltered and fully paged, and the endpoint answers 404).
4. **Then revoke the teardown token** immediately, and capture the token list after revocation. Then delete the signing key file from step P1, the only copy of the private half. After that, nobody can sign for this target again.

## Safety notes

- **Separate by construction.** The public module has its own directory and state, its own names, its own token and its own key. `test/unit/v21-public-iac.test.mjs` fails if it shares a resource, variable, name prefix, directory or state with the private module, and if the private module ever admits a `public` access mode.
- **The public Worker fails closed.** Without its public key or target ID, or with any Access setting present, it refuses every request, serving included.
- **Signed admin requests only.** It refuses unsigned, wrongly signed, other-target, stale or future (beyond ±60 s) and tampered requests, as well as any Access token presented as authentication. A replay inside the window changes nothing: puts are create-if-absent, alias moves are compare-and-swap, and receipts are append-only.
- **No step here creates a custom domain, DNS record, route, public R2 access or bucket lock.** The Worker serves, and the bucket is never public.
