# Implemented Ignis Git functionality

## Server integration and repository status

- CommonJS server-plugin registration and shutdown are implemented in `index.js`.
- Vault authorization uses trusted Ignis configuration and per-vault plugin enablement. Clients select a `vaultId`; filesystem roots and Git arguments are server-controlled.
- `GET /api/ext/obsidian-git/health` checks Git and vault-root repository prerequisites.
- `GET /api/ext/obsidian-git/state` returns file/index status, branches and upstream, unfinished-operation state, last commit time, unpushed count, selected local Git configuration, and remote URLs with embedded URL credentials redacted.
- Requests require an allowed browser origin and the `X-Obsidian-Git` header; mutations require JSON. Routes validate request fields, return structured errors, and set no-store on accepted requests.
- Origin configuration reuses `WS_ORIGINS`, with optional `IGNIS_GIT_ORIGIN` and `IGNIS_GIT_ENABLED` overrides. Deployment instructions are in `README.md`.
- Repository validation requires a real vault directory directly inside the configured vault root and a working-tree repository with an in-vault `.git` directory. It rejects symlinks, linked worktrees, and external/shared Git directory layouts.
- Health, state, Pull, and index operations share a per-repository lock; competing requests receive `BUSY` (HTTP 409).
- Native Git execution uses argument arrays without a shell, disables interactive prompts and hooks, and bounds execution time and output. Shutdown terminates tracked Git processes and rejects further execution.

## Pull

- `POST /api/ext/obsidian-git/pull` fetches the configured upstream and applies fast-forward-only updates. Equal or locally ahead history returns `up-to-date`, preserving local commits.
- Pull blocks local changes (including staged and untracked files), unfinished operations, diverged history, and unsafe checkout. It rechecks status and HEAD after fetching, rejects incoming symlinks/submodules, and protects ignored files from overwrite.
- Blocked pulls for dirty state, unfinished operations, divergence, or unsafe checkout create `git_conflict.md` exclusively, preserving any existing file and adding a local Git exclude rule.
- Updated pulls return changed paths, with renames represented as deletion/addition. Updated pulls and newly created reports request Ignis cache reconciliation including ignored files; successful pulls include a refresh warning if reconciliation fails.

## Staging and unstaging

- `POST /api/ext/obsidian-git/stage` and `/unstage` accept `vaultId` and a repository-relative `path`.
- `POST /api/ext/obsidian-git/stage-all` and `/unstage-all` accept `vaultId` and an optional repository-relative `dir`; omitting `dir` selects the whole vault.
- Index operations validate paths and select changes from authoritative server-side status inside the repository lock. Absolute paths, traversal, empty path components, NUL bytes, backslashes, and Git metadata paths are rejected.
- Staging supports additions, modifications, deletions, and directory scopes using literal changed-file paths. Ignored files are not force-added, and `git_conflict.md` is excluded from bulk operations and rejected as a direct target.
- Unstaging preserves working files and works both with an existing HEAD and before the first commit. File actions on staged renames include both old and new paths; directory actions retain their subtree boundary.
- Bulk operations targeting unresolved index entries fail with `UNMERGED_PATH`; explicit per-file resolution is described below; native index-lock failures return `GIT_INDEX_LOCKED`. Ordinary index operations do not resolve conflicts; the confirmed Mark resolved handler stages one validated resolution. Reports remain diagnostic history.
- Successful operations, including valid no-ops, return `status: "updated"` and the operation/scope. They change the index without creating commits, updating HEAD, contacting remotes, or requesting vault filesystem reconciliation.

## Browser plugin

- Runtime detection selects `IgnisGitManager`, with same-origin HTTP transport, response validation, cached repository state, request timeouts, and cancellation on unload (`src/platform/ignis.ts`, `src/gitManager/ignisGit.ts`, and `src/gitManager/ignisGitClient.ts`).
- Manual and automatic Pull use the existing queued Git actions. Source Control, current-file commands, and file/folder context menus expose staging and unstaging; index requests invalidate cached state and request a status refresh.
- Pull and staging require the Ignis write-safety API, clean reported write state, and no editable Markdown source panes. Staging records content persisted on the server; the public Ignis API provides no save/flush barrier, so very recent saves may not be included. Unstaging does not require these browser-write restrictions.
- Unsupported commands, views, and manager operations display the future-feature notice. Push, sync, standalone Fetch, branch/repository/configuration mutations, history views, hunk staging/patches, and discard remain unavailable; automatic commit/sync and Push are disabled.

## Manual Commit

- `POST /api/ext/obsidian-git/commit` supports staged, all and Smart modes using the existing resolver, validation, error envelope, bounded executor and repository lock. Stage-all and commit are one locked operation; Smart reads authoritative index state inside that lock.
- Commit refuses root/non-owner execution, missing local identity, detached HEAD, unsupported unfinished operations, unmerged entries, unsafe index layouts, tracked/staged conflict reports and changed blobs at least 100 MB. Hooks and signing are disabled. The server pins author/committer to trusted local configuration and verifies the resulting HEAD, tree and parent.
- Actual distinct changed-path counts include initial commits; rename endpoints count separately. Native failures leave data staged, and ambiguous outcomes never auto-retry. Commit contacts no remote.
- `IgnisGitManager.commit`, `commitAll` and Ignis-only `commitSmart` use the same transport; message templates run once, scripts fall back with a notice, and successful commits emit HEAD/status refreshes. No-op returns zero and a no-commit result. Source Control and the six existing manual palette commands are enabled; failures/cancellation/no-op preserve the textarea.
- Stage-all and Smart with fallback enabled retain the existing browser staging safety guard and persisted-content limitations. Staged-only records the index without claiming editor buffers are saved.
- Amend remains explicitly unsupported because publication cannot be reliably established from cached refs. Push, sync, automatic commits and schedules remain unavailable.
- The reference server exposes no session/per-user vault authorization API. Existing enabled-vault/origin checks require the deployment's authenticated, single-owner proxy boundary; they are not authentication themselves. See `COMMIT.md`.
- Frontend/handler/command and real-repository backend tests run locally as part of `pnpm run all`. `TESTING_commit.md` and `TESTING_conflicts.md` list manual commands; deployment acceptance remains pending.

## Diffs and explicit merge resolution

- The existing service/router now expose `/diff`, `/content`, `/merge-state`, `/conflicts`, `/merge`, `/mark-resolved` and `/merge/abort`, using the same origin/header/vault validation and repository lock.
- Pull remains fetch plus fast-forward only. Divergence exposes an explicit confirmed Merge action pinned to the reviewed HEAD/upstream OIDs; dirty trees are rejected. Normal merge uses `--no-commit --no-ff`, preserves true stages and never auto-selects a winner.
- Status reconstructs merge/rebase/cherry-pick/other state and orphaned unmerged entries from native Git after reload/restart. Unsafe automatic operations remain blocked.
- Unified and read-only split diffs show actual staged/unstaged snapshots. Text/binary/oversized/missing content is explicit; content sources are a fixed server enum. Status and diff reads disable optional index writes.
- Existing CodeMirror per-block conflict controls edit through the normal adapter. Reading view, clean write state, browser/server hashes, explicit confirmation and server revalidation gate Mark resolved. Deletion and intentional literal markers require explicit acknowledgement. Complex/binary conflicts retain manual-resolution guidance.
- Existing Commit completes a resolved normal merge with its staged set, never automatically stages unrelated work, disallows Amend and verifies both parents/tree/final state. Identical resulting trees still create a real merge commit with zero changed files.
- Confirmed Abort uses a persisted post-merge fingerprint, refuses changed tracked files/index or missing snapshots, invokes only `git merge --abort`, and verifies restored tracked state/HEAD and unrelated untracked bytes. No destructive fallback exists.
- Reports append state transitions only to unchanged integration-owned untracked files; tracked, edited and user-owned reports are preserved. Git index/metadata remain authoritative.
- Refreshes cover mutations, file events, reconnect/focus/online and open diff views. Merge-route failures also request Ignis cache reconciliation because Git may already have changed files. Rebase/cherry-pick operations remain inspection-only.
- See `CONFLICTS.md` for discovery/contracts/limits and root `TESTING_conflicts.md` for local tests and manual deployment acceptance. The `ignis/` reference checkout remains unchanged.

## Local validation for the conflict phase

- `pnpm run all`: passed TypeScript, Svelte (zero errors/warnings), formatting,
  ESLint, 236 Vitest tests across 18 files, and 91 server tests.
- `pnpm run test:ignis-bundle`: passed production build and browser initialization
  smoke check with native process APIs unavailable.
- Extended integration JavaScript/Markdown formatting and source diff whitespace
  checks passed. No live deployment-server tests were run.
- Ready for the disposable-vault manual checklist in `TESTING_conflicts.md`;
  live editor saves, multi-tab behavior, cache propagation and container restart
  remain deployment acceptance checks.

## Sidebar wiring verification

- Rendered Svelte tests now click actual staged/conflicted filenames in flat and
  tree layouts through Tools, GitActions and IgnisGitManager. Unified and split
  staged comparisons reach the correct read-only endpoints; text conflicts open
  live preview. `happy-dom` is a development-only test dependency.
- Diff-pane opening failures are now reported. Unknown stored diff styles fall
  back to split; Ignis stage comparisons retain split routing on mobile.
- The generated-bundle smoke test exercises staged diffs and conflict opening,
  beyond backend initialization. Local validation passes 248 Vitest tests, 91
  server tests, TypeScript, Svelte, lint and formatting.
- The reported generic unsupported notice was not reproduced with the current
  source UI. `TESTING_conflicts.md` now documents checking the loaded browser
  capabilities, reconciling externally replaced plugin artifacts, and reloading
  the running plugin. A live-instance diagnostic is needed to distinguish stale
  code from a deployment-specific failure.

## Manual Pull now integrates diverged history

- Manual sidebar/command Pull sends `mergeOnDivergence: true` to the existing
  `/pull` endpoint. After fetch, divergence starts a normal pending merge under
  the same repository lock and existing clean-tree/write/ownership safeguards.
- Conflict stages/content survive; Source Control shows actual conflicts for
  editor resolution and Mark resolved. Clean divergence awaits manual Commit.
  Neither path auto-commits or silently chooses a side.
- Boot/scheduled Pull passes `fromAuto: true` and remains fast-forward-only.
  The default API/direct-manager Pull behavior remains compatible.
- A typed `merge-pending` result prevents false up-to-date/success notices and
  refreshes status/editor controls and Ignis caches, including partial failures.
- This replaces the earlier requirement for a second Merge click after manual
  Pull, per the updated user workflow. The separate confirmed Merge action is
  still available. Deploy browser and server changes together.
- Validation for this update: `pnpm run all` passed all checks, including 251
  Vitest tests and 95 server tests. The production bundle smoke test also
  exercised manual Pull's pending-merge result successfully. Live deployment
  verification remains in `TESTING_conflicts.md`.
