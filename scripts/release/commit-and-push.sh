#!/usr/bin/env bash
# Applies one change to a fresh copy of a remote branch, commits it and pushes it, with retries.
#
#   commit-and-push.sh <repo dir> <branch> <commit message> -- <command that edits the checkout...>
#
# Each attempt starts from origin/<branch>, so a push that loses a race is redone on top of the
# newer branch. It exits 0 only when the change is on origin/<branch>: after a successful push,
# or when the command changes nothing on a fresh origin/<branch> (an earlier run pushed it).
# Any failed fetch, reset, edit or commit stops it with a non-zero exit.
set -euo pipefail

[ "$#" -ge 5 ] && [ "$4" = "--" ] || { echo "usage: $0 <repo dir> <branch> <message> -- <command...>" >&2; exit 2; }
repo="$1" branch="$2" message="$3"
shift 4

cd "$repo"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3; do
  git fetch -q origin "$branch"
  git reset -q --hard "origin/$branch"
  "$@"
  if git diff --quiet; then
    echo "origin/$branch already has the change"
    exit 0
  fi
  git commit -qam "$message"
  if git push -q origin "HEAD:$branch"; then
    echo "pushed to origin/$branch on attempt $attempt"
    exit 0
  fi
  echo "push to origin/$branch failed on attempt $attempt" >&2
done
echo "could not push to origin/$branch" >&2
exit 1
