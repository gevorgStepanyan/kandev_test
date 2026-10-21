# Diffs and merge resolution

Ignis uses the existing Source Control, unified Diff View, Split Diff View,
CodeMirror conflict buttons, Stage and Commit flows. Native Git runs only in this
server integration. Desktop and mobile retain their existing backends.

## Discovery and reused interfaces

| Existing interface                                                     | Current behavior / change                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitService.pull`, `POST /pull`                                        | Fetches the actual upstream; manual Pull opts into a normal pending merge on divergence. Automatic/default API Pull remains fast-forward-only and returns `DIVERGED`.                                                       |
| `GitService.state`, `GET /state`                                       | Includes porcelain status and authoritative merge state, including orphaned unmerged stages and unsupported operations.                                                                                                     |
| `mutateIndex`, `POST /stage`, `/stage-all`, `/unstage`, `/unstage-all` | Ordinary staging remains available. Bulk staging refuses scopes containing unresolved paths. A single-file Stage falls through to confirmed Mark resolved. Unstaging is blocked during an active operation.                 |
| `commit.js`, `POST /commit`                                            | Previously rejected every unfinished operation. Now allows a resolved normal merge, forces staged-only behavior for all/Smart modes, rejects Amend and unresolved stages, and verifies both parents and the committed tree. |
| `IgnisGitManager` and `ignisGitClient.ts`                              | Reuse the same authenticated, vault-scoped transport, timeout/error handling and operation wrapper. Diff/content requests are read-only.                                                                                    |
| Shared `GitManager.mergeWorkflow`                                      | Optional capability implemented by Ignis; desktop/mobile methods are unchanged.                                                                                                                                             |
| Source Control and `GitActions`                                        | Reuse the existing Pull, conflict list/editor, Mark resolved and Commit controls; no extra Ignis-only merge buttons or commands.                                                                                            |
| Unified/split diff and editor conflict controls                        | Reuse diff2html and CodeMirror; split diffs in Ignis are read-only, and resolution occurs in the ordinary note editor.                                                                                                      |

The implementation lives in `merge.js`, the existing Git service/router/Commit
handler, and the frontend manager/UI modules. No Ignis reference files are changed.

## HTTP contract

All routes below are relative to `/api/ext/obsidian-git`. GET query parameters
and POST JSON always include `vaultId`. Browser callers supply no host paths,
CLI arguments or unrestricted revisions. Unknown fields are rejected.

| Route                 | Additional input                                                                                                          | Result                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /diff`           | `path`, `kind: staged \| unstaged`                                                                                        | `{kind, diff}`; a unified native Git patch, or an explicit binary/oversized/unsupported result.                   |
| `GET /content`        | `path`, `source: head \| index \| worktree \| base \| ours \| theirs`                                                     | `{kind, text?, hash?, mode?, size?, stageMissing?}`. Missing stages are distinct from empty text.                 |
| `GET /merge-state`    | None                                                                                                                      | Current operation, state kind, HEAD/upstream/MERGE_HEAD OIDs, unresolved paths/stages, merge-commit availability. |
| `GET /conflicts`      | `path`                                                                                                                    | Path/type, available stages, merge state, base/ours/theirs/worktree snapshots.                                    |
| `POST /merge`         | `expectedHead`, `expectedUpstream`, `confirmed: true`                                                                     | Actual pending merge state: `merge-conflicted` or `merge-awaiting-commit`.                                        |
| `POST /mark-resolved` | `path`, `expectedHead`, `expectedMergeHead`, `expectedHash`, `confirmed: true`, optional boolean `delete`, `allowMarkers` | Updated merge state after staging only this verified resolution.                                                  |
| `POST /commit`        | Existing `mode`, `message`, `amend: false`, Smart option                                                                  | Existing commit result plus actual `merge` and `repositoryStatus`. A merge can commit with zero changed files.    |

Merge states are `clean`, `diverged`, `merge-conflicted`,
`merge-awaiting-commit`, and `rebase-or-other`. Completion is confirmed by
absence of Git operation metadata and unmerged stages; they are not persisted
browser states. No abort capability is exposed by this integration.

Errors retain the existing `{error: {code, message, reportFile?}}` envelope.
Automatic/default API divergence uses the existing `DIVERGED` code. Dirty Pull uses
`PULL_BLOCKED_DIRTY`; dirty merge uses `WORKTREE_DIRTY`. Other relevant codes are
`MERGE_IN_PROGRESS`, `UNFINISHED_OPERATION`, `UNMERGED_PATH`, `UNMERGED_INDEX`,
`CONFLICT_NOT_RESOLVED`, `STALE_MERGE_STATE`,
`UNSUPPORTED_OPERATION`, `BUSY`, `BROWSER_DIRTY`, `INVALID_PATH`,
`INVALID_ENCODING`, `OUTPUT_LIMIT`, `TIMEOUT`, `AUTH_OR_PERMISSION`, and `NETWORK`.
The browser uses `NON_TEXT_DIFF` for snapshots unavailable as text and rejects
invalid/inconsistent success payloads with `INVALID_RESPONSE`.

## User workflow and safety policy

1. Save notes, switch editable Markdown panes to reading view or close them,
   and wait for successful Ignis writes in **all tabs** before Pull/Merge.
2. Click **Pull** to fetch and integrate the actual upstream. A fast-forward
   proceeds normally; divergence starts a normal pending merge in the same server
   repository lock. This manual action authorizes the merge without a second
   confirmation. Automatic/startup Pull remains fast-forward-only; after its
   divergence notice, use manual Pull. No automatic commit, stash, reset or winner
   selection occurs.
3. The worktree, index and untracked set must be clean. Merge uses
   `--no-commit --no-ff --no-overwrite-ignore`, disables autostash/rerere,
   and never chooses a winner. Clean merges also await a deliberate Commit.
4. Resolve text through the existing conflict editor; deleted/non-text files
   open read-only stage inspection with manual-resolution guidance. Stage data
   comes from the real Git index, and existing diff views remain available.
   **Base** is the merge ancestor (stage 1); **ours** is the current branch
   (stage 2); **theirs** is the incoming merge head (stage 3). An absent stage
   means the file did not exist on that side. Ours/theirs do not mean current
   editor text/newest text. Rebase may give stages different meanings; its
   resolution controls are unavailable here.
5. Click the conflicted filename to open the normal editor in live preview.
   This enables the existing conflict controls even when reading view was the
   previous default. If the server file is absent from the browser cache, show
   stage review and an explicit Refresh vault from disk notice. Deleted, binary
   and oversized working files open stage review directly. Use the existing per-block Keep
   ours/theirs/both/base buttons or edit manually. Save, switch to reading view,
   wait for writes and choose **Mark resolved**. Browser and server content
   hashes must agree; the server rechecks the file and index when staging.
   Remaining marker lines require explicit acknowledgement as literal text.
   A deleted resolution requires a separate deletion confirmation.
6. Review the staged diff and use the existing **Commit** button/command.
   During a merge, Commit All and Smart record only the index; they never stage
   unrelated edits. Every unmerged path must be resolved. Git produces a real
   two-parent merge commit, whose tree, parents and final state are checked.
   Push remains a separate, currently unavailable Ignis feature.

Diff means inspect; Stage/Mark resolved updates the index; Commit records the
index and finishes a pending merge; Push publishes commits. Opening a diff
never edits or stages files. Text snapshots are limited to 1 MiB, and Git output
is capped at 8 MiB/60 seconds per command. Large diffs fail explicitly; patches
are not silently truncated. Binary/non-UTF8 bytes are not rendered as text.
Status and diff reads disable optional Git index writes.

The public Ignis API has no save/flush barrier. Reading-view and pending-write
checks are conservative safeguards, and Mark resolved additionally compares the
browser/server snapshot. They do not lock independent editors or external
filesystem writers. Do not concurrently edit a vault in another tab/program
during mutations. Locks serialize this backend's requests across tabs; no other
server Git job is introduced by this phase. Automatic Pull pauses during any
unfinished operation or orphaned unmerged state. Automatic commits/sync/Push
remain unavailable. Server schedules are outside this phase.

Status, diffs and controls refresh after mutations, vault changes and WebSocket
reconnect/focus/online events. Git-changing routes request Ignis's existing vault
reconciliation, including on merge failures that may already have changed files.
A reconciliation warning means inspect/refresh disk state before retrying.
Reload and server restart reconstruct operation state from native Git. Git
operation metadata and index stages remain authoritative.

## Reports, permissions and recovery

`git_conflict.md` is diagnostic history, never merge authority. The integration
appends timestamped state/OIDs/paths/instructions only to its own unchanged,
untracked report, verified by a digest in `.git`. A tracked, user-owned or edited
report is preserved; the UI and native Git status remain authoritative. Reports
are locally excluded, excluded from bulk staging and never automatically
committed. A missing/stale report does not authorize resolve/commit.

Reuse the existing installation, mounts, origins and vault enablement in
[README.md](README.md) and [COMMIT.md](COMMIT.md). Copy the **whole** integration
directory, including `merge.js`; no new service or dependency is required.
Git/OpenSSH must exist in the container. Run Ignis as the non-root vault-owning
UID/GID; do not broaden `safe.directory`. Repositories must remain at the vault
root with an internal `.git` directory. Symlink/worktree/submodule layouts are
still intentionally rejected. Binary, oversized and complex rename/file-directory
conflicts require manual resolution in an authorized Git environment; index
stages are preserved. Rebase/cherry-pick continuation, hunk operations,
history, branch management and discard are outside this phase.

Every route retains enabled-vault validation, configured Origin/custom-header
checks, JSON for mutations and the same repository lock. These are vault scoping
and CSRF protections. The reference Ignis server provides no per-user vault
authorization API: the deployment must retain its authenticated single-owner
proxy boundary. Origin headers alone are not authentication. Git errors returned
to the browser are normalized and omit raw stderr, credentials and server paths.
Inspect server/container logs, browser notices and the real test-vault Git state
when diagnosing failures. On timeout, inspect state before retrying: a request
may have taken effect. Never reset or discard notes to clear an error.

See [TESTING_conflicts.md](../../../TESTING_conflicts.md) for local automated
checks and a separate manual deployment checklist using disposable test vaults.

## Files and automated coverage

Frontend changes are grouped by responsibility:

- Manager/transport/capability: `src/gitManager/ignisGit.ts`,
  `ignisGitClient.ts`, `mergeWorkflow.ts` and the optional capability in
  `gitManager.ts`.
- Coordination/runtime: `src/main.ts`, `src/gitActions.ts`,
  `src/automaticsManager.ts`, `src/commands.ts`, `src/platform/ignis.ts`,
  `src/tools.ts`.
- Views/editor: `src/ui/diff/diffView.ts`, `splitDiffView.ts`,
  `src/ui/sourceControl/sourceControl.svelte`, its `conflictFileComponent.svelte`,
  `src/ui/modals/ignisConflictModal.ts`, `mergeConflictModal.ts`,
  `src/editor/conflicts/view.ts` and `src/editor/editorIntegration.ts`.

Server changes stay in this integration: `merge.js`, `git-service.js`,
`commit.js`, `routes.js` and `index.js`. Existing registration, vault resolver,
Git executor, error envelope, repository lock and Ignis reconciliation are reused.
The production `main.js` bundle is rebuilt. No dependencies or reference Ignis
files change.

New tests are `tests/gitManager/ignisConflicts.test.ts` (HTTP/state/confirmation,
write checks, hash validation, completion and zero-file merges),
`tests/editor/conflicts/view.test.ts` (state refresh without changing editor
text and desktop parsing), and `integrations/ignis/tests/conflicts.test.cjs`
(real Git merges/diffs/stages/resolution/security/regressions).
Existing tests in `tests/gitManager/ignisGit.test.ts`,
`tests/automaticsManager.test.ts`, `tests/ui/diff/splitDiffView.test.ts` and
`integrations/ignis/tests/commit.test.cjs` are updated for the expanded contract.
The full suite also covers ordinary desktop/mobile managers.

Documentation changes extend this README, `done.md`, `docs/ignis-integration.md`
and `structure.md`, with this contract and root `TESTING_conflicts.md` added.
Manual acceptance remains necessary for real CodeMirror save behavior, Ignis
cache/WebSocket propagation, simultaneous tabs and deployment/container restart.

## Manual Pull integration

`POST /pull` now accepts optional boolean `mergeOnDivergence`. The manual sidebar
and command-palette Pull actions send `true`; startup and scheduled Pull omit it.
Omitting it preserves the existing API behavior. Non-boolean values are rejected.
On divergence with the flag, the server calls the existing validated merge
implementation using the freshly fetched HEAD/upstream OIDs while retaining the
Pull lock. It returns `{status: "merge-pending", merge: <actual merge state>}`.
The shared frontend `PullResult` maps that to
`{status: "merge-pending", conflicts: string[]}`. Conflict and clean-awaiting-commit
notices remain distinct from fast-forward success and up-to-date notices.
The index and file markers are preserved for the existing resolution controls.
Pending merge results and post-mutation errors reconcile the Ignis vault cache.
Deploy both the browser bundle and server integration for this addition.

## UI parity with local Obsidian Git

The Ignis sidebar uses the existing Pull, conflict list/editor, Mark resolved and
Commit flow. The extra Abort merge and Merge incoming changes buttons/commands,
extra conflict-review icon, and standalone merge status text have been removed.
There is no `/merge/abort` endpoint, backend abort implementation, abort snapshot
creation or abort capability field. Cancelling a merge requires an authorized
Git environment outside the plugin. Existing pending merges remain resolvable
and committable; any legacy `.git/obsidian-git-merge.json` file is ignored and
left untouched. Removing these controls does not reset or alter repository state.
