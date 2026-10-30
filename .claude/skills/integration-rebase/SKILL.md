---
name: integration-rebase
description: Rebuild the personal `integration` branch of corgi on the latest upstream/main, re-merge all in-flight PR branches, rebuild and test, then hot-reload the running corgi runtime. Also adds or removes branches and keeps INTEGRATION.md (what is integrated, why, and its upstream PRs/issues) current. Use when asked to rebase, refresh or update the integration branch, to add/remove a branch from it, or what it contains.
argument-hint: "[--push] | add <branch> [#PR] [description] | remove <branch> [reason] | link <branch> #PR"
---

# Rebuild the integration branch

The `integration` branch is `upstream/main` + tooling commits + a `--no-ff` merge of every branch in the **Active** table of `INTEGRATION.md` (repository root). It lives in the worktree `~/Development/context-engineering/corgi-integration` and runs as the main corgi runtime via `corgi-dev` (`dist/corgi dev`).

Tooling commits are the non-merge commits on the first-parent chain above upstream (this skill and `INTEGRATION.md`). `rebuild.sh start` re-applies them, so commit skill or manifest changes directly on `integration`, never in a merge.

## INTEGRATION.md

The manifest and the record of what is and was integrated. `rebuild.sh` reads only the Branch and PR columns of the Active table, in row order; the rest is for people.

- **Active** columns: Branch (in backticks), PR, Issues, Description, Added (YYYY-MM-DD).
- **Retired** columns: the same plus Retired (YYYY-MM-DD) and Reason (`merged upstream as <short sha>`, or the user's reason for dropping it).
- Links are full Markdown links: PR `[#N](https://github.com/tals/corgi/pull/N)`, issue `[#N](https://github.com/tals/corgi/issues/N)`. Several issues are separated by spaces. No `|` inside cells.
- The PR and Issues cells may be empty for a branch without a PR yet.

Rules:
- Never rebase, amend or push PR branches. Conflicts are resolved only in the integration merge commit.
- Never push to `upstream`. Only push `integration` to `origin`, and only with `--push`.
- `rerere` is enabled; resolutions you commit are replayed on the next rebuild.

## Arguments

- none: rebuild.
- `--push`: rebuild, then `git push --force-with-lease origin integration`.
- `add <branch> [#PR] [description]`: append a row to the Active table, then commit it as `integration: add <branch>` and rebuild.
  - With a PR: take the issues from `gh pr view N --repo tals/corgi --json title,closingIssuesReferences,body` (closing issues plus `#N` references in the body that are issues), and the description from the argument or else the PR title without its `area:` prefix.
  - Without a PR: ask the user for a one-line description and any related issues.
  - Added is today's date.
- `remove <branch> [reason]`: move its row from Active to Retired with today's date and the reason (ask if none was given), commit it as `integration: remove <branch>`, then rebuild.
- `link <branch> #PR`: when a branch gets its PR later, fill in its PR and Issues cells the same way and commit it as `integration: link <branch> to #PR`. No rebuild needed.

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
4. For every `skip <branch>: #N is merged upstream` line, move that row to Retired with reason `merged upstream as <short sha>` (the PR's merge commit, `gh pr view N --repo tals/corgi --json mergeCommit -q .mergeCommit.oid`). Commit only; no extra rebuild is needed since the branch was skipped.
5. Verify, in order, stopping at the first failure:
   - `bun install` if `bun.lock` or `package.json` changed relative to `integration-prev`.
   - `bun typecheck.ts`
   - `bun test src`
   - `bun build.ts`

   On failure, decide whether it comes from upstream, a branch, or the combination, and report it. Do not fix code in PR branches here; the user can roll back with `git reset --hard integration-prev`.
6. If the build succeeded, hot-swap the running main runtime. Inside corgi (`CORGI_PANE` is set) run `./dist/corgi dev </dev/null`: it reloads the daemon and relaunches the viewer showing this pane on the new build. Outside corgi run `./dist/corgi reload` (daemon only) and tell the user to reattach with `corgi-dev`, since viewer changes need a new viewer. Either way, a running `corgi voice` keeps its old code until restarted; say so. Panes survive; on failure the old daemon keeps running. `UnsupportedStateVersion` means the new build cannot take over live state; report it and tell the user to restart cold from outside corgi (`corgi-dev checkpoint && corgi-dev shutdown && corgi-dev`). If no daemon is running, the next `corgi-dev` starts the new build.
7. With `--push`: `git push --force-with-lease origin integration`.
8. `sh $S status`, then report briefly:
   - new upstream commits pulled in (count + notable subjects),
   - branches merged (with their description and PR link from INTEGRATION.md), skipped (merged upstream) or retired,
   - conflicts resolved and which PR branches need an upstream rebase,
   - every `note`/`warn` line from `merge` about local vs. `origin`: a local branch behind `origin` was merged from `origin` (suggest `git merge --ff-only` in its worktree); unpushed or diverged local commits mean the PR does not show what was integrated,
   - typecheck/test/build result and whether the runtime was reloaded.
