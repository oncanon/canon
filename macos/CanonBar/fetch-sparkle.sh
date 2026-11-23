#!/bin/sh
# Downloads the pinned Sparkle 2 release, checks its SHA-256 and unpacks it.
# Usage: ./macos/CanonBar/fetch-sparkle.sh <dir>
# Prints the unpacked release directory (it holds Sparkle.framework and bin/sign_update,
# bin/generate_appcast, bin/generate_keys). <dir> MUST be outside the repo or gitignored.
# The tarball is kept in <dir> and checked again on every run, so a second run needs no network.
set -eu

SPARKLE_VERSION="2.10.1"
SPARKLE_SHA256="1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27"
SPARKLE_URL="https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <dir>" >&2
  exit 2
fi

mkdir -p "$1"
DIR="$(CDPATH= cd -- "$1" && pwd)"
TARBALL="$DIR/Sparkle-$SPARKLE_VERSION.tar.xz"
DEST="$DIR/Sparkle-$SPARKLE_VERSION"

sha256_of() {
  shasum -a 256 "$1" | cut -d ' ' -f 1
}

if [ ! -f "$TARBALL" ] || [ "$(sha256_of "$TARBALL")" != "$SPARKLE_SHA256" ]; then
  rm -f "$TARBALL.part"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$TARBALL.part" "$SPARKLE_URL"
  mv "$TARBALL.part" "$TARBALL"
fi

ACTUAL="$(sha256_of "$TARBALL")"
if [ "$ACTUAL" != "$SPARKLE_SHA256" ]; then
  echo "fetch-sparkle: SHA-256 mismatch for $TARBALL" >&2
  echo "  expected $SPARKLE_SHA256" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

# Unpack into a fresh directory each time, so a partial or edited earlier unpack is never used.
rm -rf "$DEST.part"
mkdir "$DEST.part"
tar -xJf "$TARBALL" -C "$DEST.part"
if [ ! -d "$DEST.part/Sparkle.framework" ] || [ ! -x "$DEST.part/bin/sign_update" ]; then
  echo "fetch-sparkle: $TARBALL does not hold Sparkle.framework and bin/sign_update" >&2
  rm -rf "$DEST.part"
  exit 1
fi
rm -rf "$DEST"
mv "$DEST.part" "$DEST"

printf '%s\n' "$DEST"
