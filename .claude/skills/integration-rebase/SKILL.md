---
name: integration-rebase
description: Rebuild the personal `integration` branch of corgi on the latest upstream/main, re-merge all in-flight PR branches, rebuild and test, then hot-reload the running `integration` environment. Also adds or removes branches from the integration manifest. Use when asked to rebase, refresh or update the integration branch, or to add/remove a branch from it.
argument-hint: "[--push] | add <branch> [#PR] | remove <branch>"
---

# Rebuild the integration branch

The `integration` branch is `upstream/main` + tooling commits + a `--no-ff` merge of every branch listed in `.claude/skills/integration-rebase/branches`. It lives in the worktree `~/Development/context-engineering/corgi-integration` and runs as the main corgi runtime via `corgi-dev` (`dist/corgi dev`).

Tooling commits are the non-merge commits on the first-parent chain above upstream (this skill and its manifest). `rebuild.sh start` re-applies them, so commit skill or manifest changes directly on `integration`, never in a merge.

Rules:
- Never rebase, amend or push PR branches. Conflicts are resolved only in the integration merge commit.
- Never push to `upstream`. Only push `integration` to `origin`, and only with `--push`.
- `rerere` is enabled; resolutions you commit are replayed on the next rebuild.

## Arguments

- none: rebuild.
- `--push`: rebuild, then `git push --force-with-lease origin integration`.
- `add <branch> [#PR]`: append `<branch> [#PR]` to `branches`, commit it as `integration: add <branch>`, then rebuild.
- `remove <branch>`: delete its line from `branches`, commit it as `integration: remove <branch>`, then rebuild.

Manifest commits are plain commits on `integration` (not amendments) with the trailer `Assisted-By: 🤖 Claude Code`.

## Steps

Run from the repository root of the integration worktree. `S=.claude/skills/integration-rebase/rebuild.sh`.

1. `git status`: if there are uncommitted changes, stop and ask the user what to do with them.
2. `sh $S start`. If a tooling commit fails to apply, resolve it, `git cherry-pick --continue`, and continue.
3. `sh $S merge`. On exit code 2 it prints the conflicting branch and files:
   - Read both sides, resolve the conflict keeping the intent of both upstream and the branch.
   - `git add` the files, `git commit --no-edit`, then run `sh $S merge` again.
   - Remember the branch: its PR needs a rebase onto upstream/main (report it, do not do it).
   - If a resolution is unclear, stop and ask the user.
4. For every `skip <branch>: #N is merged upstream` line, run the `remove` flow for that branch (commit only, no extra rebuild needed since it was skipped).
5. Verify, in order, stopping at the first failure:
   - `bun install` if `bun.lock` or `package.json` changed relative to `integration-prev`.
   - `bun typecheck.ts`
   - `bun test src`
   - `bun build.ts`

   On failure, decide whether it comes from upstream, a branch, or the combination, and report it. Do not fix code in PR branches here; the user can roll back with `git reset --hard integration-prev`.
6. If the build succeeded, hot-swap the running main runtime: `./dist/corgi reload`. Panes survive; on failure the old daemon keeps running. `UnsupportedStateVersion` means the new build cannot take over live state; report it and tell the user to restart cold from outside corgi (`corgi-dev checkpoint && corgi-dev shutdown && corgi-dev`). If no daemon is running, the next `corgi-dev` starts the new build.
7. With `--push`: `git push --force-with-lease origin integration`.
8. `sh $S status`, then report briefly:
   - new upstream commits pulled in (count + notable subjects),
   - branches merged, skipped (merged upstream) or removed,
   - conflicts resolved and which PR branches need an upstream rebase,
   - typecheck/test/build result and whether the runtime was reloaded.
