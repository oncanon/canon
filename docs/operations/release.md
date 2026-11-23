# Releasing Canon

Canon ships as one SemVer version for the `canon` CLI and Canon.app. Three workflows do the work:

| Workflow | Runs on | Does |
|---|---|---|
| `.github/workflows/release-please.yml` | push to `main` | Keeps one open release PR (`chore(release): vX.Y.Z`) with the next version and `CHANGELOG.md`. Merging it tags `vX.Y.Z`, creates the GitHub Release as a draft and calls `release.yml`. |
| `.github/workflows/release.yml` | called by release-please, or run by hand with a tag | Tests; packs the CLI; builds, signs, notarizes and staples Canon.app; signs the zip for Sparkle; checks every write it is about to make; attaches both files and publishes the draft; adds the appcast item; updates the Homebrew tap; redeploys the site. |
| `.github/workflows/site.yml` | push to `main`, pull requests, called by `release.yml` | Builds `web/` and uploads `web/dist` to the Cloudflare project `oncanon` with wrangler (production on `main`, previews on PRs). |

## How versions are chosen

release-please reads Conventional Commits since the last release tag:

| Commit | Before 1.0.0 | From 1.0.0 |
|---|---|---|
| `fix:` | patch | patch |
| `feat:` | minor | minor |
| `feat!:` or `BREAKING CHANGE:` | minor (`bump-minor-pre-major`) | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `merge:` | no release | no release |

`.release-please-manifest.json` holds the last released version. It is `0.0.0` until the first
release. For that first release, `initial-version` in `release-please-config.json` sets the
version to `0.1.0` (without it, release-please starts at `1.0.0`). Any `feat:` or `fix:` commit
starts it, so at go-live the single fresh commit MUST have one of those types, for example
`feat: Canon 0.1.0, first public release`.

The release PR is opened by `GITHUB_TOKEN`, so GitHub runs no workflows on it: it gets no CI
checks. A branch rule that requires checks on `main` blocks that PR unless release-please gets a
GitHub App token or a fine-grained token instead (`token:` input in `release-please.yml`).

## What a release publishes

- `canon-X.Y.Z.tgz` (output of `npm pack`) on the GitHub Release. The formula `oncanon/tap/canon` installs it with Homebrew's `node`.
- `Canon-X.Y.Z.zip` on the GitHub Release: universal, Developer ID signed, hardened runtime, notarized and stapled. The cask `oncanon/tap/canon-app` installs it and depends on the formula.
- One new item at the top of `web/public/appcast.xml`, committed to `main` as `chore(release): appcast vX.Y.Z`, then deployed to `https://oncanon.com/appcast.xml`. Canon.app reads this feed with Sparkle 2 and checks each update's EdDSA signature against `SUPublicEDKey` in its `Info.plist`.
- A commit on `oncanon/homebrew-tap` that sets the new version and both `sha256` values.

If tests, the version check, signing, notarization or the Gatekeeper check fail, the `publish` job does not run: the Release stays a draft, nothing is uploaded, and neither the tap nor the appcast changes.

`publish` makes its writes in this order, and checks all of them before the first one:

1. **Check, no writes.** A fully uploaded file already on the Release MUST be byte-identical to this run's file; a rebuilt zip differs, and replacing it would break the Sparkle signature in the live appcast. `appcast.mjs --check` fails on an item for this version with other contents. `tap-bump.mjs --check` fails on an older version than the tap has. A dry-run push fails if `TAP_TOKEN` cannot write to the tap.
2. Upload the missing files (a partial upload from an earlier run is replaced) and publish the draft as the latest release.
3. Add the appcast item and push it to `main`.
4. Update the tap and push it. This is last, so `brew upgrade` never offers a version that Sparkle and livecheck cannot see.

Steps 3 and 4 use `scripts/release/commit-and-push.sh`. Each of its three attempts starts from a fresh fetch of the remote branch. It exits 0 only after a successful push, or when the change is already on the remote branch. A failed fetch, edit or commit stops the job.

A re-run of `publish` after a failure at step 2, 3 or 4 is safe: done steps change nothing. A re-run of the whole workflow is not, because it rebuilds and re-notarizes the zip; step 1 then stops it. In that case delete the draft's files by hand, or cut a new patch release.

`publish` runs the release scripts from the tag, not from `main`, so a later edit on `main` cannot change how an old release is published.

## Secrets and variables

**Precondition.** GitHub offers environments for a private repository only on a paid plan (GitHub Team for an organization). `oncanon` is on the Free plan and `oncanon/canon` is private, so the `release` environment can exist only after the repository is public, or after an upgrade. Until then the `app` and `publish` jobs get empty secrets and fail at the Developer ID check. A missing secret is an empty string, not an error.

Signing and publishing secrets live in the GitHub environment `release`, which only `main` may use (Settings → Environments → `release` → Deployment branches: `main`; required reviewers are optional). The `app` and `publish` jobs declare it. The Cloudflare secrets stay at repository level, because `site.yml` also deploys previews for pull requests. The branch limit protects the secrets only while `main` itself needs a reviewed pull request (a branch rule). The cost of the repository-level Cloudflare secrets: a workflow change in a pull request from a branch of this repository can read the Cloudflare token. Pull requests from forks get no secrets.

| Name | Where | Value |
|---|---|---|
| `DEVELOPER_ID_P12` | `release` secret | base64 of the exported "Developer ID Application" certificate and key (`base64 -i DeveloperID.p12`) |
| `DEVELOPER_ID_P12_PASSWORD` | `release` secret | password chosen at export |
| `ASC_KEY_ID` | `release` secret | App Store Connect API key ID |
| `ASC_ISSUER_ID` | `release` secret | App Store Connect issuer ID |
| `ASC_KEY_P8` | `release` secret | contents of `AuthKey_<KEY_ID>.p8` |
| `SPARKLE_ED_PRIVATE_KEY` | `release` secret | Sparkle EdDSA private key (base64 seed, see below) |
| `SPARKLE_PUBLIC_KEY` | repository variable | matching public key; written into `Info.plist` as `SUPublicEDKey` |
| `CLOUDFLARE_API_TOKEN` | repository secret | the site deploy token; its scopes are in [Site deploy token](#site-deploy-token) |
| `CLOUDFLARE_ACCOUNT_ID` | repository secret | Cloudflare account ID |
| `TAP_TOKEN` | `release` secret | fine-grained token with Contents: read and write on `oncanon/homebrew-tap` only |

On the runner, under `umask 077`:

- Every secret is in the environment of the processes of the step that uses it.
- The `.p12` is decoded to a file, imported into a temporary keychain, and deleted right after the import (or by the `always()` step, if the import fails). Its password, and the random password of the temporary keychain, are arguments of `security`, so other processes on the same runner can see them while that command runs. The keychain is deleted in the `always()` step.
- The `.p8` is a file until the same `always()` step deletes it.
- The Sparkle key reaches `sign_update` through a pipe. It is never written to a file or put in an argument.

GitHub-hosted runners are single-use virtual machines, so these files do not outlive the job.

## One-time setup

1. **Developer ID certificate.** The Apple Developer account holder creates a "Developer ID Application" certificate (Xcode → Settings → Accounts → Manage Certificates → +), exports it from Keychain Access as `.p12`, and stores it and its password in the secrets above.
2. **Notarization key.** App Store Connect → Users and Access → Integrations → Team Keys: a key with the Developer role. Store ID, issuer ID and the `.p8`.
3. **Sparkle keys.** Generate the pair without the login keychain. The private key is the base64 32-byte Ed25519 seed that `sign_update --ed-key-file -` accepts:

   ```sh
   node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ed25519");
   const s=k.privateKey.export({format:"der",type:"pkcs8"}).subarray(-32).toString("base64");
   const p=k.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
   console.log("private:",s);console.log("public: ",p)'
   ```

   Store the private key in 1Password and in `SPARKLE_ED_PRIVATE_KEY`; set `SPARKLE_PUBLIC_KEY`. Losing the private key means installed apps can no longer accept updates, so keep the 1Password copy.
4. **Cloudflare site project.** Create the project `oncanon` once, with `main` as its production branch, then add the custom domain `oncanon.com` to it in the dashboard. The DNS change is the account owner's step.
5. **Tap repository.** `oncanon/homebrew-tap`, public, containing `Formula/canon.rb`, `Casks/canon-app.rb` and its own `tests.yml` (style, strict audit, install). Its CI stays red until the first release: the formula and cask point at `v0.1.0` files that do not exist before then.
6. **Environment.** Create `release` as described in [Secrets and variables](#secrets-and-variables).
7. **Branch rules.** The `publish` job pushes the appcast commit to `main` as `github-actions[bot]`. A branch rule on `main` MUST allow that actor, or the job fails after the Release is published and before the tap changes; re-run `publish` after the rule is fixed.
8. **Order.** `core/doc-v1` MUST be on `main` before `site.yml` can pass: the site build runs `canon build-docs`, which only that branch adds. `web/public/appcast.xml` MUST be on `main` before the first release; the `check` job fails without it.

## Site deploy token

`CLOUDFLARE_API_TOKEN` is used only by `site.yml`. Its scopes are generated from
`infra/cloudflare/deploy-token-scopes-site.json`; do not edit the table by hand.

<!-- deploy-token-scopes-site:begin (generated from infra/cloudflare/deploy-token-scopes-site.json; checked by test/unit/pv-deploy-token-scopes.test.mjs) -->
| Permission | Granted | Needed for | Source | Necessity |
| --- | --- | --- | --- | --- |
| Cloudflare Pages Edit | yes | wrangler pages deploy web/dist --project-name=oncanon (production on main, previews on pull requests) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (read 2026-11-21): "Grants access to create, edit and delete Cloudflare Pages projects." | verified |
| Workers Scripts Edit | no | the site is static; the publisher Worker is deployed with its own token | — | — |
| Workers R2 Storage Edit | no | the site deploy writes no bucket | — | — |
| D1 Edit | no | the site deploy writes no database | — | — |
| Account Settings Read | no | wrangler gets the account from CLOUDFLARE_ACCOUNT_ID, so it needs no account discovery | — | — |
<!-- deploy-token-scopes-site:end -->

## Dry run

Actions → release → Run workflow, with an existing tag and `dry_run` on. The run tests, packs, builds, signs, notarizes, staples and Gatekeeper-checks, then keeps `Canon-X.Y.Z.zip`, `canon-X.Y.Z.tgz` and `sparkle-signature.txt` as workflow artifacts. It publishes nothing.

Homebrew installs only from public release files, so end users can install once `oncanon/canon` and `oncanon/homebrew-tap` are public.
