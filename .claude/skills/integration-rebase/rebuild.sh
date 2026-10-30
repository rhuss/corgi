#!/bin/sh
# Rebuild the `integration` branch: upstream/main + tooling commits + in-flight branches.
#
#   rebuild.sh start   fetch, back up to integration-prev, reset onto upstream/main,
#                      re-apply the tooling commits (non-merge first-parent commits)
#   rebuild.sh merge   merge every manifest branch not yet in HEAD; exit 2 on conflict
#                      (resolve, commit, run merge again)
#   rebuild.sh status  summarize integration against upstream/main and integration-prev
set -eu

UPSTREAM_REPO=tals/corgi
BRANCH=integration
dir=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$dir" rev-parse --show-toplevel)"
manifest=INTEGRATION.md

say() { printf 'integration: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

# "<branch> [<PR number>]" for each row of the "## Active" table in INTEGRATION.md.
entries() {
  awk -F'|' '
    /^## / { active = ($0 ~ /^## Active/) }
    active && /^\| *`/ {
      branch = $2; gsub(/[ `]/, "", branch)
      pr = ""; if (match($3, /#[0-9]+/)) pr = substr($3, RSTART + 1, RLENGTH - 1)
      print branch, pr
    }' "$manifest"
}

require_branch() {
  [ "$(git symbolic-ref --short HEAD 2>/dev/null)" = "$BRANCH" ] || die "check out '$BRANCH' first"
}

require_clean() {
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
}

start() {
  require_branch
  require_clean
  git fetch --quiet --multiple upstream origin
  base=$(git merge-base "$BRANCH" upstream/main)
  tooling=$(git rev-list --reverse --first-parent --no-merges "$base..$BRANCH")
  git branch -f "$BRANCH-prev" "$BRANCH"
  say "backup: $BRANCH-prev -> $(git rev-parse --short "$BRANCH-prev")"
  say "upstream: $(git rev-list --count "$base..upstream/main") new commit(s) on upstream/main"
  git reset --quiet --hard upstream/main
  for c in $tooling; do
    say "tooling: $(git log -1 --format='%h %s' "$c")"
    git cherry-pick --allow-empty "$c" >/dev/null || die "tooling commit $c did not apply; resolve and 'git cherry-pick --continue'"
  done
}

merge() {
  require_branch
  [ ! -f "$(git rev-parse --git-path MERGE_HEAD)" ] || die "a merge is in progress; resolve and commit it first"
  require_clean
  entries | while read -r branch pr _; do
    pr=${pr#\#}
    if [ -n "$pr" ]; then
      state=$(gh pr view "$pr" --repo "$UPSTREAM_REPO" --json state -q .state 2>/dev/null || echo UNKNOWN)
      if [ "$state" = MERGED ]; then
        say "skip $branch: #$pr is merged upstream (drop it from the manifest)"
        continue
      fi
    fi
    if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      ref=$branch
      if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null &&
         [ "$(git rev-parse "$branch")" != "$(git rev-parse "origin/$branch")" ]; then
        if git merge-base --is-ancestor "$branch" "origin/$branch"; then
          # Pushed from elsewhere (another checkout, a review fix on GitHub)
          ref=origin/$branch
          say "note $branch: local is behind origin/$branch, using origin"
        elif git merge-base --is-ancestor "origin/$branch" "$branch"; then
          say "note $branch: local has unpushed commits, using local"
        else
          say "warn $branch: local and origin/$branch have diverged, using local"
        fi
      fi
    elif git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
      ref=origin/$branch
    else
      die "branch '$branch' not found locally or on origin"
    fi
    if git merge-base --is-ancestor "$ref" HEAD; then
      say "ok   $branch: already merged"
      continue
    fi
    if git merge --no-ff --no-edit -m "integration: merge $branch${pr:+ (#$pr)}" "$ref" >/dev/null 2>&1; then
      say "ok   $branch: merged"
    elif [ -z "$(git diff --name-only --diff-filter=U)" ]; then
      # rerere resolved every conflict and staged the result
      git commit --no-edit --quiet
      say "ok   $branch: merged (conflicts replayed by rerere)"
    else
      say "CONFLICT $branch:"
      git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
      exit 2
    fi
  done
}

status() {
  say "upstream/main: $(git log -1 --format='%h %s' upstream/main)"
  git log --first-parent --format='  %h %s' upstream/main.."$BRANCH" >&2
  if git rev-parse --verify --quiet "$BRANCH-prev" >/dev/null; then
    if git diff --quiet "$BRANCH-prev" "$BRANCH"; then
      say "tree unchanged since $BRANCH-prev"
    else
      say "changed since $BRANCH-prev: $(git diff --shortstat "$BRANCH-prev" "$BRANCH")"
    fi
  fi
}

case "${1:-}" in
  start) start ;;
  merge) merge ;;
  status) status ;;
  *) die "usage: rebuild.sh start|merge|status" ;;
esac
