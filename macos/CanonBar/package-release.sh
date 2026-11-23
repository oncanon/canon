#!/bin/sh
# Notarizes a release Canon.app and packages it as a stapled zip.
# Usage: ./macos/CanonBar/package-release.sh <Canon.app> <out.zip>
#
# <Canon.app> is a `build-app.sh --release` bundle signed with a Developer ID Application
# identity. It is not changed: the script staples a copy. <out.zip> MUST NOT exist yet.
# Required env (App Store Connect API key):
#   ASC_KEY_ID     key id
#   ASC_ISSUER_ID  issuer id
#   ASC_KEY_PATH   path to the AuthKey_<id>.p8 file
#
# Steps: verify the signature, check offline that it is Developer ID with the hardened runtime,
# ditto zip, notarytool submit --wait (fails unless the status is Accepted), staple, then
# codesign --verify --strict --deep and spctl --assess --type execute, and zip the stapled app.
# Any failure exits non-zero and writes no <out.zip>.
set -eu

fail() {
  printf 'package-release: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 2 ] || { echo "usage: $0 <Canon.app> <out.zip>" >&2; exit 2; }
IN_APP="$1"
OUT_ZIP="$2"
[ -d "$IN_APP/Contents" ] || fail "$IN_APP is not an app bundle"
[ ! -e "$OUT_ZIP" ] || fail "$OUT_ZIP exists"
[ -n "${ASC_KEY_ID:-}" ] || fail "ASC_KEY_ID is not set"
[ -n "${ASC_ISSUER_ID:-}" ] || fail "ASC_ISSUER_ID is not set"
[ -n "${ASC_KEY_PATH:-}" ] || fail "ASC_KEY_PATH is not set"
[ -f "$ASC_KEY_PATH" ] || fail "ASC_KEY_PATH does not name a file"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/canon-package.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP_NAME="$(basename -- "$IN_APP")"
APP="$WORK/stage/$APP_NAME"

mkdir -p "$WORK/stage"
ditto "$IN_APP" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP" || fail "$IN_APP does not pass codesign --verify"
# Notarization takes only Developer ID code with the hardened runtime. Check offline, so an ad hoc
# or Apple Development build fails here and is never uploaded.
SIGNATURE="$(codesign -dvv "$APP" 2>&1)" || fail "cannot read the signature of $IN_APP"
printf '%s\n' "$SIGNATURE" | grep -q '^Authority=Developer ID Application: ' \
  || fail "$IN_APP is not signed with a Developer ID Application identity"
printf '%s\n' "$SIGNATURE" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime.*\)' \
  || fail "$IN_APP is not signed with the hardened runtime"

ditto -c -k --keepParent "$APP" "$WORK/submit.zip"

xcrun notarytool submit "$WORK/submit.zip" \
  --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
  --wait --output-format json > "$WORK/notary.json" \
  || { cat "$WORK/notary.json" >&2 2>/dev/null || true; fail "notarytool submit failed"; }
STATUS="$(plutil -extract status raw "$WORK/notary.json" 2>/dev/null || echo unknown)"
SUBMISSION="$(plutil -extract id raw "$WORK/notary.json" 2>/dev/null || echo unknown)"
if [ "$STATUS" != "Accepted" ]; then
  # The log says which file failed and why.
  xcrun notarytool log "$SUBMISSION" \
    --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2 || true
  fail "notarization status is '$STATUS' (submission $SUBMISSION)"
fi

xcrun stapler staple "$APP" || fail "stapler staple failed"
xcrun stapler validate "$APP" || fail "stapler validate failed"

codesign --verify --strict --deep --verbose=2 "$APP" || fail "stapled app does not pass codesign --verify"
spctl --assess --type execute --verbose=2 "$APP" || fail "spctl rejects the stapled app"

ditto -c -k --keepParent "$APP" "$WORK/out.zip"
mkdir -p "$(dirname -- "$OUT_ZIP")"
mv "$WORK/out.zip" "$OUT_ZIP"
printf 'Packaged %s (notarization %s, submission %s)\n' "$OUT_ZIP" "$STATUS" "$SUBMISSION"
