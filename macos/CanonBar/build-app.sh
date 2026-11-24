#!/bin/sh
# Builds Canon.app using the system Swift compiler (no Xcode project required).
#
# Dev mode (default):
#   ./macos/CanonBar/build-app.sh [output-app-path] [canon-cli-mjs-path]
#   arm64 only, ad hoc signed. Info.plist points CanonFallbackCliScript at this checkout's
#   src/cli.mjs and has no update feed, so the app does not check for updates.
#
# Release mode:
#   ./macos/CanonBar/build-app.sh --release <output-app-path>
#   Universal (arm64 + x86_64), Sparkle embedded, signed inside-out with hardened runtime.
#   <output-app-path> MUST NOT exist yet. Required env:
#     CANON_SIGN_IDENTITY  codesign identity ("Developer ID Application: …", or "-" for ad hoc)
#     SPARKLE_PUBLIC_KEY   base64 EdDSA public key, written to SUPublicEDKey
#   Optional env, for test builds only (docs/app/release.md):
#     SPARKLE_FEED_URL     default https://oncanon.dev/appcast.xml (https, or loopback http)
#     CANON_VERSION        default: package.json version
#     CANON_BUNDLE_ID      default: dev.oncanon.Canon
#
# Both modes: CANON_SPARKLE_DIR is where fetch-sparkle.sh keeps Sparkle
# (default <repo>/.build/sparkle, gitignored).
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

MODE=dev
if [ "${1:-}" = "--release" ]; then
  MODE=release
  shift
fi

fail() {
  printf 'build-app: %s\n' "$*" >&2
  exit 1
}

if [ "$MODE" = release ]; then
  [ "$#" -eq 1 ] || fail "usage: $0 --release <output-app-path>"
  OUT_APP="$1"
  [ ! -e "$OUT_APP" ] || fail "$OUT_APP exists; release builds write a new bundle only"
  SIGN_IDENTITY="${CANON_SIGN_IDENTITY:-}"
  [ -n "$SIGN_IDENTITY" ] || fail "CANON_SIGN_IDENTITY is not set"
  PUBLIC_KEY="${SPARKLE_PUBLIC_KEY:-}"
  [ -n "$PUBLIC_KEY" ] || fail "SPARKLE_PUBLIC_KEY is not set"
  KEY_BYTES="$(printf '%s' "$PUBLIC_KEY" | base64 -D 2>/dev/null | wc -c | tr -d ' ')"
  [ "$KEY_BYTES" = 32 ] || fail "SPARKLE_PUBLIC_KEY is not a base64 32-byte EdDSA public key"
  FEED_URL="${SPARKLE_FEED_URL:-https://oncanon.dev/appcast.xml}"
  # Sparkle needs HTTPS. A loopback http feed is allowed for local update tests only.
  case "$FEED_URL" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) fail "SPARKLE_FEED_URL '$FEED_URL' is not https (or a loopback test feed)" ;;
  esac
  ARCHS="arm64 x86_64"
else
  OUT_APP="${1:-$HOME/Applications/Canon.app}"
  CANON_CLI_SCRIPT="${2:-$REPO_ROOT/src/cli.mjs}"
  ARCHS="arm64"
fi

# The app ships from the same repo as the CLI, so it carries the same version (package.json).
PACKAGE_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -1)"
CANON_VERSION="${CANON_VERSION:-$PACKAGE_VERSION}"
if [ "$MODE" = release ]; then
  printf '%s\n' "$CANON_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "version '$CANON_VERSION' is not MAJOR.MINOR.PATCH"
fi
CANON_VERSION="${CANON_VERSION:-0.0.0}"

SPARKLE_DIR="$("$SCRIPT_DIR/fetch-sparkle.sh" "${CANON_SPARKLE_DIR:-$REPO_ROOT/.build/sparkle}")"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canon-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

# A dev build writes into the output bundle, as before. A release build is put together and
# signed in BUILD_DIR, and moves to the output path only when it is complete, so a failed
# release build leaves nothing behind.
if [ "$MODE" = release ]; then
  APP="$BUILD_DIR/Canon.app"
else
  APP="$OUT_APP"
fi
CONTENTS_DIR="$APP/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/Fonts" "$FRAMEWORKS_DIR"

# Info.plist: the template, then the per-mode keys.
PLIST="$CONTENTS_DIR/Info.plist"
cp "$SCRIPT_DIR/Info.plist" "$PLIST"
# plutil, not sed: the value is stored as given, whatever characters it has.
plutil -replace CFBundleShortVersionString -string "$CANON_VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$CANON_VERSION" "$PLIST"
if [ -n "${CANON_BUNDLE_ID:-}" ]; then
  plutil -replace CFBundleIdentifier -string "$CANON_BUNDLE_ID" "$PLIST"
fi
if [ "$MODE" = release ]; then
  # No path of the build machine goes into a release: the app finds `canon` on PATH,
  # /opt/homebrew/bin and /usr/local/bin.
  plutil -insert SUFeedURL -string "$FEED_URL" "$PLIST"
  plutil -insert SUPublicEDKey -string "$PUBLIC_KEY" "$PLIST"
else
  plutil -insert CanonFallbackCliScript -string "$CANON_CLI_SCRIPT" "$PLIST"
fi

cp "$SCRIPT_DIR"/Resources/Fonts/*.otf "$SCRIPT_DIR"/Resources/Fonts/*.ttf "$SCRIPT_DIR"/Resources/Fonts/*.txt "$RESOURCES_DIR/Fonts/"

rm -rf "$FRAMEWORKS_DIR/Sparkle.framework"
ditto "$SPARKLE_DIR/Sparkle.framework" "$FRAMEWORKS_DIR/Sparkle.framework"

SOURCES="$(find "$SCRIPT_DIR/Sources" -name '*.swift' | sort)"

SLICES=""
for ARCH in $ARCHS; do
  # shellcheck disable=SC2086 # SOURCES is a list of paths without spaces
  swiftc \
    -O \
    -parse-as-library \
    -module-cache-path /tmp/canon-swift-module-cache \
    -target "$ARCH-apple-macosx14.0" \
    -F "$SPARKLE_DIR" \
    -framework SwiftUI \
    -framework AppKit \
    -framework ServiceManagement \
    -framework Sparkle \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    $SOURCES \
    -o "$BUILD_DIR/Canon-$ARCH"
  SLICES="$SLICES $BUILD_DIR/Canon-$ARCH"
done
# shellcheck disable=SC2086
lipo -create $SLICES -output "$MACOS_DIR/Canon"

if [ "$MODE" = dev ]; then
  codesign --force --deep --sign - "$OUT_APP"
  printf 'Built %s\n' "$OUT_APP"
  exit 0
fi

# Release signing, inside-out, no --deep: each nested code item gets its own signature, then the
# framework, then the app. An identity signs with the hardened runtime and a secure timestamp,
# as notarization requires. Ad hoc ("-") gets neither: ad hoc code has no Team ID, so the
# hardened runtime's library validation would stop dyld loading Sparkle.framework, and an ad hoc
# build can never be notarized anyway.
if [ "$SIGN_IDENTITY" = "-" ]; then
  SIGN_FLAGS="--timestamp=none"
else
  SIGN_FLAGS="--options runtime --timestamp"
fi
sign_with() {
  # shellcheck disable=SC2086 # SIGN_FLAGS holds flags without spaces
  codesign --force --sign "$SIGN_IDENTITY" $SIGN_FLAGS "$@"
}
FW="$FRAMEWORKS_DIR/Sparkle.framework"
sign_with "$FW/Versions/B/XPCServices/Installer.xpc"
sign_with --preserve-metadata=entitlements "$FW/Versions/B/XPCServices/Downloader.xpc"
sign_with "$FW/Versions/B/Autoupdate"
sign_with "$FW/Versions/B/Updater.app"
sign_with "$FW"
sign_with "$APP"

# Check before the move, so a bundle that fails never reaches the output path.
# --deep here only verifies; without it a tampered nested item (Updater.app) still passes.
codesign --verify --strict --deep --verbose=2 "$APP" || fail "the signed bundle does not pass codesign --verify"
ACTUAL_ARCHS="$(lipo -archs "$MACOS_DIR/Canon")"
[ "$ACTUAL_ARCHS" = "x86_64 arm64" ] || [ "$ACTUAL_ARCHS" = "arm64 x86_64" ] \
  || fail "Canon is '$ACTUAL_ARCHS', not universal"

mkdir -p "$(dirname -- "$OUT_APP")"
mv "$APP" "$OUT_APP"

printf 'Built %s (release %s, %s, signed by %s)\n' "$OUT_APP" "$CANON_VERSION" "$ACTUAL_ARCHS" "$SIGN_IDENTITY"
