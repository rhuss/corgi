# Integration branch

Personal daily-driver build of corgi: `upstream/main` plus the branches below, each merged with `--no-ff`.
It is rebuilt by the `integration-rebase` skill (`corgi-dev-rebase`) and never proposed upstream.

## Active

Merged in this order. `rebuild.sh` reads the branch and PR columns of this table.
Keep `|` out of the cells.

| Branch | PR | Issues | Description | Added |
|---|---|---|---|---|
| `001-voice-dictation` | [#36](https://github.com/tals/corgi/pull/36) | | Dictate into the focused pane with a local Whisper model, locally or over SSH (`corgi voice --ssh HOST`) | 2026-10-28 |
| `002-pane-click-selection` | [#43](https://github.com/tals/corgi/pull/43) | [#21](https://github.com/tals/corgi/issues/21) | Double-click copies a word, triple-click a line | 2026-10-28 |
| `003-inline-sidebar-rename` | [#1](https://github.com/rhuss/corgi/pull/1) | [#42](https://github.com/tals/corgi/issues/42) | Rename workspace and agent rows in place | 2026-10-30 |

## Retired

Branches that left the integration branch, because their PR was merged upstream or they were dropped.

| Branch | PR | Issues | Description | Added | Retired | Reason |
|---|---|---|---|---|---|---|
