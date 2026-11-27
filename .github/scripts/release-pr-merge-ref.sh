#!/usr/bin/env bash
# Finds the open release-please PR and prints the commit that merging it into BASE_SHA would ship.
#
# GitHub computes the PR's merge commit (refs/pull/N/merge) after each push, without a fixed delay.
# This script accepts that commit only when its parents are exactly BASE_SHA and the PR's current
# head, so a stale merge commit is never tested in place of the real one.
#
# Environment:
#   GH_TOKEN   token that can read pull requests (required)
#   REPO       owner/name (required)
#   BASE_SHA   the main commit the release PR must merge onto (required)
#   LABEL      release PR label (default: "autorelease: pending")
#   PR_NUMBER  use this PR instead of searching by label (for local checks)
#   ATTEMPTS   polls before giving up (default: 24); INTERVAL seconds between polls (default: 5)
# Output (to $GITHUB_OUTPUT when set, else stdout): found=true|false, number=N, sha=<merge commit>
# Exit status: 0 when no release PR is open or a valid merge commit was found; 1 otherwise.
set -euo pipefail

: "${REPO:?REPO is required}" "${BASE_SHA:?BASE_SHA is required}"
LABEL="${LABEL:-autorelease: pending}"
ATTEMPTS="${ATTEMPTS:-24}"
INTERVAL="${INTERVAL:-5}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

if [[ -n "${PR_NUMBER:-}" ]]; then
  numbers="$PR_NUMBER"
else
  numbers="$(gh pr list --repo "$REPO" --state open --base main --label "$LABEL" --json number --jq '.[].number')"
fi
count="$(printf '%s' "$numbers" | grep -c . || true)"
if [[ "$count" -eq 0 ]]; then
  echo "No open PR with label \"$LABEL\"; nothing to test."
  echo "found=false" >> "$out"
  exit 0
fi
if [[ "$count" -gt 1 ]]; then
  echo "::error::More than one open PR has label \"$LABEL\": $(tr '\n' ' ' <<<"$numbers"). Expected one."
  exit 1
fi
number="$numbers"

for ((i = 1; i <= ATTEMPTS; i++)); do
  pr="$(gh api "repos/$REPO/pulls/$number")"
  state="$(jq -r .state <<<"$pr")"
  mergeable="$(jq -r .mergeable <<<"$pr")"
  head="$(jq -r .head.sha <<<"$pr")"
  merge="$(jq -r '.merge_commit_sha // ""' <<<"$pr")"
  if [[ "$state" != "open" ]]; then
    echo "::error::PR #$number is $state, not open."
    exit 1
  fi
  if [[ "$mergeable" == "false" ]]; then
    echo "::error::PR #$number does not merge cleanly onto main. Resolve it before release."
    exit 1
  fi
  if [[ "$mergeable" == "true" && -n "$merge" ]]; then
    parents="$(gh api "repos/$REPO/commits/$merge" --jq '[.parents[].sha] | join(" ")')"
    if [[ "$parents" == "$BASE_SHA $head" ]]; then
      echo "PR #$number (head $head) merged onto $BASE_SHA is $merge."
      { echo "found=true"; echo "number=$number"; echo "sha=$merge"; } >> "$out"
      exit 0
    fi
    echo "Attempt $i: merge commit $merge has parents [$parents], expected [$BASE_SHA $head]."
  else
    echo "Attempt $i: GitHub has not computed the merge commit yet (mergeable=$mergeable)."
  fi
  sleep "$INTERVAL"
done

echo "::error::No merge commit of PR #$number onto $BASE_SHA after $ATTEMPTS attempts."
exit 1
