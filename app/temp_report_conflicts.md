# Ignis conflict handling progress report — 2026-10-21

Reviewed `GOAL.md`, `TASK_conflicts.md`, the current frontend/server code,
implementation inventory and verification guide. **The agreed conflict workflow
is implemented; the user has confirmed conflict handling is done.** Remaining
items are documentation alignment and broader deployment verification.

## Done

| Area | Implemented behavior |
| --- | --- |
| Diffs | Real staged and unstaged Git diffs in the existing unified/split views; fixed content sources, accurate missing stages and explicit non-text/size limits. |
| Pull | Manual Pull fetches and starts a normal merge on divergence. Fast-forward behavior remains; startup/automatic Pull stays fast-forward-only. Dirty work prompts the user to stage and commit before pulling. |
| Git state | Conflicts and merge/rebase/cherry-pick state come from native Git metadata/index, including after reload or restart. Clean divergent merges await manual Commit. |
| Resolution UI | Clicking a conflicting filename opens the editor with existing Keep ours/theirs/both/base controls. Mark resolved stages the saved file or deletion directly, without a popup. |
| Resolution checks | Clean browser write state, reading view, browser/server content hashes, expected Git state and server revalidation protect staging. Remaining conflict markers block resolution. |
| Merge Commit | Existing Commit records the resolved index as a real two-parent merge commit. Unresolved paths and Amend are refused; unrelated edits are not automatically staged. |
| Reports and refresh | Integration-owned `git_conflict.md` reports append diagnostic transitions; user-owned/tracked/edited reports are preserved. Mutations, file events and reconnects refresh status/diffs and reconcile Ignis caches. |
| Safety | Existing vault scoping, path restrictions, bounded native execution, shared repository locks, stale-state checks and typed errors are reused. Unsafe automatic operations are blocked during unfinished Git operations. |

Frontend work is in `IgnisGitManager`, its transport/capability, GitActions,
Source Control, diff views and editor integrations. Server work extends the
existing `integrations/ignis/obsidian-git/` routes/service with `merge.js` and
merge-aware `commit.js`. The `ignis/` reference checkout was not changed.

## Changes from the original task — intentional

- **Abort merge:** removed from UI, commands, frontend capability and server
  implementation at the user's request. It is not outstanding implementation.
- **Separate Merge action:** removed to match local Obsidian Git. The manual
  Pull click authorizes merging; automatic Pull never starts a divergent merge.
- **Resolution confirmation:** removed. Mark resolved itself authorizes staging;
  unresolved marker text produces an error rather than an acknowledgement popup.

## Verification

- Latest implementation checks passed: `pnpm run all` — TypeScript, Svelte,
  formatting, lint, **254 Vitest tests and 95 server tests**.
- `pnpm run test:ignis-bundle` passed the production build and bundle smoke checks.
- Coverage includes rendered sidebar clicks, diff transport, real temporary Git
  repositories, stages, deletions, resolution races, two-parent commits, reports,
  locks and route restrictions. The user confirmed the deployed conflict workflow.
- This report-only review did not rerun checks or independently access deployment.

## Left / limitations

- Align the older requirements/checklists in `TASK_conflicts.md` and historical
  inventory wording with the three intentional workflow changes above.
- Complete any unverified disposable-vault scenarios in
  [TESTING_conflicts.md](TESTING_conflicts.md): multi-tab races, reconnect/cache
  propagation, container restart, uncommon conflict kinds and platform regressions.
  User confirmation covers the exercised workflow, not this entire matrix.
- Browser save/flush has no atomic Ignis API; conservative reading-view/write
  checks remain. Independent editors/external filesystem writers are not locked.
- Binary, oversized and complex conflicts require manual resolution outside the
  browser. Rebase/cherry-pick continuation, hunk operations, Push/sync and branch
  management remain outside this phase.
- Session authentication/per-user vault ACLs depend on the deployment's existing
  authenticated single-owner proxy. Origin/header and enabled-vault checks do not
  independently provide authentication.
