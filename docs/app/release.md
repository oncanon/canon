---
title: Canon.app release builds
description: How build-app.sh makes a universal, signed Canon.app with Sparkle 2 updates, and how package-release.sh notarizes it.
---

# Canon.app release builds

Canon.app is built with `swiftc` from `macos/CanonBar/build-app.sh`. There is no Xcode project
and no Swift package. Sparkle 2 comes in as a pinned binary release.

| Script | Does |
|---|---|
| `macos/CanonBar/fetch-sparkle.sh <dir>` | Downloads the pinned Sparkle release, checks its SHA-256, unpacks it and prints its path |
| `macos/CanonBar/build-app.sh` | Dev build (default) or release build (`--release`) |
| `macos/CanonBar/package-release.sh <Canon.app> <out.zip>` | Notarizes, staples and zips a release build |

## Versions

The app and the CLI have one version: `package.json` `version`. Both modes write it to
`CFBundleShortVersionString` and to `CFBundleVersion` (with `plutil`, so any characters are
stored as given). Sparkle compares `CFBundleVersion`, so
it MUST grow with each release. A release build refuses a version that is not
`MAJOR.MINOR.PATCH`.

## Sparkle

`fetch-sparkle.sh` pins one release (now 2.10.1) by version and SHA-256. When the hash of the
tarball does not match, it exits 1 and unpacks nothing. It keeps the tarball in `<dir>`, so a
second run needs no network. Both modes link Sparkle, so the first build in a new worktree
downloads it from GitHub; set `CANON_SPARKLE_DIR` to a shared folder to download it once.
`<dir>` MUST be outside the repo or gitignored; `build-app.sh`
uses `<repo>/.build/sparkle` (gitignored) unless `CANON_SPARKLE_DIR` names another folder.

To move to a newer Sparkle, change `SPARKLE_VERSION` and `SPARKLE_SHA256` together. Take the
hash from the release's asset list on GitHub and check it against the downloaded file.

The unpacked release also holds `bin/sign_update`, `bin/generate_appcast` and
`bin/generate_keys`, which the release workflow uses.

## Dev mode

```sh
./macos/CanonBar/build-app.sh [output-app-path] [canon-cli-mjs-path]
```

- arm64 only, ad hoc signed (`codesign --deep --sign -`).
- The default output is `~/Applications/Canon.app`. Pass a scratch path to leave an installed
  copy alone.
- Sparkle is embedded, but Info.plist has no `SUFeedURL` and no `SUPublicEDKey`. The app does
  not start the updater: "Check for Updates…" is disabled and the Settings toggle says
  "Not available in development builds."
- `CanonFallbackCliScript` points at this checkout's `src/cli.mjs`, so the app works without an
  installed `canon`.

## Release mode

```sh
CANON_SIGN_IDENTITY="Developer ID Application: …" \
SPARKLE_PUBLIC_KEY="<base64 EdDSA public key>" \
./macos/CanonBar/build-app.sh --release /path/to/new/Canon.app
```

The script:

1. Refuses an output path that exists. It assembles the bundle in a temporary folder and moves
   it to the output path only when signing is done, so a failed build leaves nothing.
2. Compiles for `arm64` and `x86_64` (macOS 14) and joins them with `lipo`.
3. Copies `Sparkle.framework` into `Contents/Frameworks`. The binary has the rpath
   `@executable_path/../Frameworks`.
4. Writes `SUFeedURL` (default `https://oncanon.dev/appcast.xml`) and `SUPublicEDKey`. The feed
   MUST be `https://`; only a loopback feed (`http://127.0.0.1:…`, `http://localhost:…`) may
   use http, for a local update test. It
   writes no `CanonFallbackCliScript`: a release build has no path of the build machine in it.
   It finds `canon` and `node` on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` (Homebrew on
   Apple silicon) and `/usr/local/bin` (Homebrew on Intel).
5. Signs inside-out, without `--deep`: `Installer.xpc`, `Downloader.xpc`, `Autoupdate`,
   `Updater.app`, `Sparkle.framework`, then `Canon.app`. With an identity it signs with
   `--options runtime --timestamp`, which notarization requires.
6. Checks the result before it moves it: `codesign --verify --strict --deep` MUST pass and
   `lipo -archs` MUST show both architectures, or the script exits 1.

`--deep` is used only to verify. Without it, `codesign --verify` passes a bundle whose nested
`Updater.app` was changed after signing.

### Ad hoc release builds

`CANON_SIGN_IDENTITY=-` makes an ad hoc release build, for a CI dry run or a machine with no
certificate. It is signed without the hardened runtime and without a timestamp. Ad hoc code has
no Team ID, so the hardened runtime's library validation would stop dyld loading
`Sparkle.framework` ("mapping process and mapped file (non-platform) have different Team IDs").
An ad hoc build cannot be notarized, so it MUST NOT be published.

### Environment

| Variable | Mode | Required | Meaning |
|---|---|---|---|
| `CANON_SIGN_IDENTITY` | release | yes | `codesign` identity, or `-` for ad hoc |
| `SPARKLE_PUBLIC_KEY` | release | yes | base64 EdDSA public key (32 bytes), written to `SUPublicEDKey` |
| `SPARKLE_FEED_URL` | release | no | Feed URL, https or loopback http. Default `https://oncanon.dev/appcast.xml`. Test builds only |
| `CANON_VERSION` | both | no | Version instead of `package.json`. Test builds only |
| `CANON_BUNDLE_ID` | both | no | Bundle id instead of `dev.oncanon.Canon`. Test builds only |
| `CANON_SPARKLE_DIR` | both | no | Where `fetch-sparkle.sh` keeps Sparkle. Default `<repo>/.build/sparkle` |

A published build MUST use none of the test-only variables.

## Notarize and package

```sh
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=/path/AuthKey_….p8 \
./macos/CanonBar/package-release.sh /path/to/Canon.app /path/to/Canon-X.Y.Z.zip
```

The input MUST be a release build signed with a Developer ID Application identity. The script
staples a copy and leaves the input as it is. It:

1. checks `codesign --verify --strict --deep`, and checks offline that the app is signed by a
   `Developer ID Application` identity with the hardened runtime, so an ad hoc or Apple
   Development build fails before anything goes to Apple;
2. zips the app with `ditto -c -k --keepParent`;
3. runs `xcrun notarytool submit --wait` with the App Store Connect API key, and fails unless
   the status is `Accepted` (on failure it prints the notary log);
4. runs `xcrun stapler staple` and `stapler validate`;
5. checks `codesign --verify --strict --deep` and `spctl --assess --type execute` on the
   stapled app;
6. zips the stapled app to `<out.zip>`.

Any failure exits non-zero and writes no `<out.zip>`. `<out.zip>` MUST NOT exist yet.

| Variable | Meaning |
|---|---|
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | API key issuer id |
| `ASC_KEY_PATH` | Path to the `.p8` key file |

## Update UI

- Right-click menu: "Check for Updates…", above "Settings…".
- App menu: "Check for Updates…", under "About". The app menu shows while Settings is in front.
  Sparkle's first-run question ("…check for updates manually from the Canon menu") points here.
- Settings › General: "Automatically check for updates". It reads and writes Sparkle's
  `automaticallyChecksForUpdates` (user default `SUEnableAutomaticChecks`).

All three use `SPUStandardUpdaterController` and Sparkle's standard windows. The overlay is not
changed.

## Sign an update

```sh
bin/sign_update --ed-key-file <private-key-file> Canon-X.Y.Z.zip
bin/generate_appcast --ed-key-file <private-key-file> --download-url-prefix <url>/ <dir>
```

Without `--ed-key-file` both tools read the key from the login keychain. In CI, pass the key
with `--ed-key-file -` on standard input from a secret. The private key MUST NOT be committed
or printed.

## Read-only test runs

`--read-only` (argument) and `CANON_APP_READ_ONLY=1` (environment) both start the app in
read-only mode: it never writes `~/.canon` and never starts or stops the service. The
environment variable survives a relaunch, so a test build that sets it in `LSEnvironment` stays
read-only after Sparkle installs an update and relaunches it.

## Proof record (2026-11-21, branch `app/sparkle`)

Checked on this Mac with the Apple Development identity and with ad hoc. Notarization,
stapling and `spctl` acceptance are not proven: no Developer ID Application certificate and no
App Store Connect API key exist yet.

| Check | Result |
|---|---|
| Release build, Apple Development | exit 0; `lipo -archs`: `x86_64 arm64`; `codesign --verify --strict` and `--strict --deep` exit 0; each nested item has its own signature, `flags=0x10000(runtime)`, a secure timestamp and Team ID |
| Release build, ad hoc | exit 0; universal; verify exit 0 |
| Both release builds launch | arm64 and x86_64 (Rosetta) slices, each exit 0 |
| Info.plist of a release build | `SUFeedURL`, `SUPublicEDKey`, both versions `0.1.0`; no build-machine path (the same check finds one in a dev build) |
| Tampered nested `Updater.app` | `codesign --verify --strict --deep` exit 1 |
| Release mode inputs | existing output, no identity, no key, a bad key, a bad version, an unknown identity: each exit 1; the failed build leaves no bundle |
| `fetch-sparkle.sh` | exit 0; a wrong pinned hash: exit 1, nothing unpacked |
| `package-release.sh` offline paths | wrong arguments exit 2; missing env, not an app, existing output, tampered app, Apple Development build, ad hoc build: each exit 1 before any call to Apple, no zip |
| Developer ID and runtime checks | the runtime pattern matches the Apple Development build and not the ad hoc build; the Developer ID pattern matches the same signature text with its authority renamed |
| Failed release check | a build whose universal check is made to fail exits 1 and leaves no bundle |
| Feed URL | `http://example.com/…` exit 1, no bundle; `http://127.0.0.1:8765/…` exit 0 |
| Version characters | dev `CANON_VERSION='1.0&x<y\|z'`: `plutil -lint` OK, value stored as given |
| `spctl` on the Apple Development build | `rejected`, exit 3 (expected without Developer ID) |
| Update 0.1.0 → 0.1.1, local appcast, throwaway EdDSA key | "Check for Updates…" offered 0.1.1; Install Update; the app relaunched as 0.1.1 (new pid, bundle version 0.1.1, signature valid, still read-only) |
| Appcast signature of another file | "The update is improperly signed and could not be validated."; 0.1.0 kept running |
| Settings toggle | `SUEnableAutomaticChecks` 0 → 1 → 0 |
| Dev build | exit 0, 0 warnings (the count finds a planted warning) |
