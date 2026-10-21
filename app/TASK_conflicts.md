# TASK — Git Diffs, Pull Merge Conflicts, and Resolution on Ignis

**Read `GOAL.md` first, then inspect the current working directory and `./structure.md`.** Pull, Staging/Unstaging, and Commit already work on Ignis. The server integration already exists at `/integrations/ignis/obsidian-git`, modeled after Ignis's `headless-sync` server-plugin architecture.

> **Execution constraint:** Implement the requested functionality and generate automated tests which you can run without integration with ignis. The user will run integration tests manually on the deployment server. Do not require deployment-server access to complete implementation.

## 1. Scope and intended user experience

This phase adds the missing functionality for viewing diffs and resolving conflicts caused by Pull/merge, using the existing Obsidian Git UI inside the Ignis browser and native Git only on the Ignis server.

A successful user journey:

1. Open Source Control in Ignis and inspect **unstaged**, **staged**, and (when applicable) **conflicted** changes through real Git diffs.
2. For a straightforward fast-forward, Pull succeeds with the existing behavior.
3. If local and upstream histories have diverged, the user is explicitly offered a safe Merge option. The system must never silently overwrite local changes or automatically select one side.
4. If the user elects to merge, the server performs a normal, non-destructive Git merge. A merge with unresolved conflicts remains **in progress**, preserving Git's unmerged index entries and working-tree conflict content.
5. Source Control lists actual conflicting paths; the user can review ours/base/theirs, resolve text conflicts with the existing editor controls (or edit manually), and mark files resolved using the existing Stage integration. There should be no difference between the ways Obsidian Git handles this part on local obsidian and Ignis.
6. Once all paths are resolved and marked, the existing Commit functionality can **finish the merge commit**. The UI accurately displays when a merge remains in progress and when it is finished.
7. Alternatively, the user can **Abort merge**, with an explicit confirmation and server safety checks. Aborting must not be conflated with resetting the branch or discarding arbitrary notes.
9. The prior `git_conflict.md` report remains meaningful, and the user's vault remains usable even after a failed request. New conflict reports should be appended to it.

**Both halves must be implemented:**

- **Frontend:** extend `IgnisGitManager` and the Obsidian Git command/Source Control/Diff/merge flows to send authenticated, vault-scoped requests and show their results.
- **Server:** extend **the existing** `/integrations/ignis/obsidian-git` endpoints and native Git service to return diffs, detect/perform safe merges, expose conflict stages, validate resolutions, support abort, and finalize through the existing Commit handler.

Do not invent a separate sync application or unrelated front end.

## 2. Findings from the public upstream code (important distinctions)

Inspect the **current local fork**, which is authoritative. The following public sources were examined when writing this task:

**Ignis:**

Ignis can be found in `./ignis`. Do not change anything in that folder. The `./ignis` checkout is read-only reference material for understanding Ignis interfaces.

**Obsidian Git:**

This is a fork of the Obsidian Git plugin. We are trying to make it work seamlessly in Ignis platform. Its general structure is in `./structure.md`. Note that the staging, pulling and committing functionality already works in Ignis. 

## 3. Explicit implementation scope

### Required

1. Real **unstaged worktree diff** (index ↔ working tree) for a selected file.
2. Real **staged diff** (`HEAD` ↔ index) for a selected file.
3. Accurate **per-file diff** rendering through the existing Diff View and Split Diff View where their existing functionality applies; avoid blank/fake results for ordinary changed files.
4. **Conflict-aware status** that reports unmerged paths and merge/rebase/cherry-pick states accurately, including after reload or container restart.
5. Read-only **merge conflict details**, including available Git index stages: **base (`:1:`), ours (`:2:`), theirs (`:3:`)**. Missing stages must be represented correctly, not fabricated.
6. A safe, **explicitly authorized** merge attempt for histories diverged during Pull; preserve existing fast-forward Pull behavior.
7. Successful merge without textual conflicts may prepare a merge commit for user review rather than committing automatically; user must see and finish it deliberately.
8. Conflicted merge remains on disk as real Git merge/index state; user can open/edit file, choose ours/theirs/both where appropriate, and mark it resolved via staging.
9. Complete merge via **existing Commit** only after validation that no unmerged paths remain. Never auto-stage all arbitrary worktree files to finish a merge.
10. An explicit, confirmed **Abort merge** operation with correct preconditions, no hard reset, and clear feedback.
11. Preserve and update **`git_conflict.md`** as a diagnostic report without treating it as the source of truth or automatically committing it.
12. Browser UI must refresh real status/diffs after Pull, merge attempt, file write, stage, commit, abort, and reconnect.
13. Frontend/server security, path isolation, and concurrency safeguards; meaningful typed errors.
14. Generated tests for development purposes, make sure they pass. Do not generate deployment or integration tests, they will be done separately on the deployment server.

### Not part of this phase

- Interactive hunk staging/applying patch to the index, patch discard/reset, history browser/blame, new branch/remotes management, arbitrary Git commands.
- Automatic rebase or interactive rebase; cherry-pick continuation; dangerous reset modes; force checkout; `git clean`; mass resolution favoring ours/theirs without explicit per-file confirmation.
- Automatic merge commits, automatic selection of conflict winners, AI-generated resolutions, auto-stash or silently discarding dirty changes.

If unsupported merge operation types (rebase/cherry-pick) are already detected, show their real state with a helpful explanation; **do not pretend they can be finished or aborted by the merge-specific endpoints**.

## 4. Inspect current code and trace all call paths

Before implementing:

**Frontend:**

- Find `IgnisGitManager` and the existing API client, vault ID discovery, common error response mapping and capability/unsupported-operation flags.
- Inspect `GitManager` declarations for `getDiffString`, `diff`, `show`, `status`, `isMergeInProgress`, `pull`, `stage`, `commit`, and any merge-specific methods added in the fork.
- Trace `GitActions.pullChangesFromRemote`, its error/result reporting, `GitConflictError` mapping, queueing, state/status refresh, and automatic Pull routines.
- Trace Source Control `Conflicts` list, conflict file component, current icon actions, conflict-count tracking, diff buttons, command palette entries, context menus and merge-help modal.
- Trace `src/editor/conflicts/{view,model,actions}` and find how CodeMirror changes are saved through Ignis's file adapter. Check for unsaved/debounced edits.
- Trace `diffView` and `splitDiffView`: discover exact `aRef`, `bRef`, `aFile`, `bFile` meaning; identify direct casts to `SimpleGit`, `instanceof SimpleGit` gates, and how staged/untracked/deleted files are represented.
- Trace current staging API: can it stage a previously unmerged file with intentional content, handle conflict-only deletes, and refuse unresolved markers or allow explicit acknowledgement?
- Trace current Commit API: does it allow a merge commit while `MERGE_HEAD` exists, and can it accidentally include unstaged edits or call `--amend`? Record necessary compatibility fixes.

**Server:**

- Inspect `/integrations/ignis/obsidian-git` completely, including route registration, service(s), Git spawn helper, vault resolution/authorization, pathspec validation, locks, tests, error classes, and `git_conflict.md` writer.
- Identify the Pull implementation (fast-forward-only or otherwise) and exactly where it classifies `REMOTE_DIVERGED`, dirty worktrees, existing MERGE_HEAD, fetch errors and conflict responses.
- Identify the existing Commit implementation and whether it can create a merge commit, handle unmerged paths, or accidentally stage unrelated files.
- Identify the existing Stage implementation and whether it can stage a resolved file, handle deletion conflicts, or accidentally stage unrelated files.
- Identify the existing index status reporting and whether it already exposes unmerged entries / XY porcelain codes.
- Identify filesystem cache invalidation / WebSocket watcher behavior when the backend Git process changes notes.

**Discovery deliverable:** A short table of existing methods/routes and which are being reused, amended, or added, with explicit statements about current Pull strategy and current Commit behavior during merges.

## 5. Merge semantics and safety — non-negotiable

Git state, not marker text or `git_conflict.md`, is authoritative.

### Before the merge

- Continue using the configured current branch's **actual upstream**; no hardcoded `origin/main`.
- Preserve successful fast-forward behavior.
- If branches are **diverged**, show a clear **Merge incoming changes** action and require a deliberate user interaction before creating a merge state. Do not silently change the default to an auto-merge during startup/automatic Pull.
- Re-fetch or verify the fetched upstream reference under the same repository lock before merging; show the target commit to the user where feasible. Detect stale frontend requests.
- Require a clean/safe worktree before starting the merge (staged, unstaged, and untracked collision cases evaluated). A conservative clean-worktree requirement is acceptable; never auto-commit, stash or reset to make it clean.
- Reject detached HEAD, missing upstream, another in-progress merge/rebase/cherry-pick, and requests that do not match the authorized vault.
- Use safe native Git arguments (e.g., a **non-automatic-commit** merge with `--no-commit --no-ff` on the validated upstream for divergence); verify exact flags against the local Git version. **Never use `-X ours`, `-X theirs`, `--strategy=ours`, or `reset --hard` automatically.**

### During the merge

- If Git reports merge conflicts, preserve the index's stage 1/2/3 blobs and working-tree conflict content and leave the merge **in progress** (`MERGE_HEAD` where Git uses it). Do not report it as a generic failed Pull with no recoverable state.
- Distinguish **merged with conflicts**, **merged and awaiting commit**, **updated by fast-forward**, **up to date**, **blocked by dirty worktree**, and **merge command failed before starting**.
- If the merge applies cleanly, leave the merge pending for an explicit review/Commit; ensure UI shows `mergeInProgress=true` and does not falsely say the merge is finished.
- Never auto-stage all working-tree changes on entry to conflict resolution; cleanly auto-merged paths might already be staged by Git.
- Do not conflate an unrelated `git_conflict.md` report with actual Git unmerged entries.
- If Git exits non-zero, interrogate `MERGE_HEAD` and `git ls-files -u` under the lock before deciding whether this is an expected conflict or an ordinary error.

### After the merge

- Marking a file resolved means updating its Git **index**, not making a merge commit.
- Require all unmerged paths to be resolved and staged (including deletion conflicts) before finalizing.
- Existing Commit flow should finish the merge using the intended staged resolution set. Do not run commit-all unconditionally or accept `--amend` for the merge completion.
- Return actual post-commit `HEAD`, status and merge state. Confirm merge is complete only when Git state confirms it.
- Abort only when a merge is actually in progress and after the user confirms. If there are new edits made **after** the merge started, warn and avoid silently discarding them. Prefer `git merge --abort` only under validated safe conditions; Git may refuse if edits cannot be preserved. Do not substitute a hard reset if it fails.
- On abort, reconcile caches and report that the index/worktree/branch state was restored **only after verifying it**. Preserve unrelated untracked files and any prior local commits.

### Automatic operations

While merge state or unmerged entries exist, block automatic Pull, automatic Commit, unattended sync/Push, branch-changing operations, and any unsafe automatic action. Preserve manual editing, status, diffs, staging of resolved files, manual merge completion, and safe abort. Do not break existing queue/lock semantics.

## 6. Frontend — `IgnisGitManager` and typed API transport

Reuse the existing same-origin, authenticated vault-aware HTTP client and response envelope. **Do not create a second client**, nor send a host path or free-form CLI arguments.

### Extend working methods

- `getDiffString(filePath, stagedChanges, hash?)`: return real unified diffs with semantics exactly matching existing `GitManager`/UI expectations.
- `diff(file, commit1, commit2)` if the current interface/UI uses it for supported diff views; keep operation strictly read-only.
- `show(commitHash, file, relativeToVault?)` if needed by the existing split view or conflict-stage view, with a safe **server-defined enum of allowed content sources**, not arbitrary `git show` revisions from the browser.
- `status()` and `isMergeInProgress()`: handle active conflict status accurately after Pull/merge/resolve/abort/reload.
- `pull()`: preserve fast-forward behavior and return a typed diverged/merge-possible result (or existing typed error) that the UI can use to offer the explicit Merge action.
- Add narrowly scoped `getMergeState`, `getConflictDetails`, `startMerge`, and `abortMerge` operations **where they fit the current manager/client design**. They need not become new abstract methods for every platform if only Ignis needs them; prefer capabilities/adapter interfaces over `instanceof` checks everywhere.
- Continue using the already implemented `stage(path, ...)` to mark a file resolved **only after appropriate checks**, or extend the existing staging handler with a typed `markResolved` action where necessary to distinguish intent and validate selected conflict paths.

### Proposed request shapes (examples only)

Keep existing route conventions. Suggested extensions:

```http
GET /api/ext/obsidian-git/diff?vaultId=<id>&path=Notes/a.md&kind=unstaged
GET /api/ext/obsidian-git/diff?vaultId=<id>&path=Notes/a.md&kind=staged
GET /api/ext/obsidian-git/merge-state?vaultId=<id>
GET /api/ext/obsidian-git/conflicts/<encoded-path>?vaultId=<id>
POST /api/ext/obsidian-git/merge
Content-Type: application/json
{"vaultId":"<id>","expectedHead":"<oid>","expectedUpstream":"<oid>"}
POST /api/ext/obsidian-git/merge/abort
Content-Type: application/json
{"vaultId":"<id>","expectedMergeHead":"<oid>","confirmed":true}
```

If an existing API action route is already used for Pull/Stage/Commit, **extend it instead of introducing parallel route families**. GET requests must remain read-only; mutating requests must use authenticated/CSRF-protected POST routes.

Suggested structured merge state (adapt to existing types):

```typescript
interface IgnisMergeState {
  operation: "none" | "merge" | "rebase" | "cherry-pick" | "other";
  head: string;
  upstream?: { ref: string; oid: string };
  mergeHead?: string;
  unresolvedPaths: Array<{
    path: string;
    kind: "content" | "modify-delete" | "add-add" |
          "rename" | "binary" | "other";
    availableStages: Array<1 | 2 | 3>;
  }>;
  canCommitMerge: boolean;
  canAbortMerge: boolean;
}
```

These are illustrative models; match the current fork and avoid changing unrelated public interfaces.

### Error mapping and UI

- Distinguish `DIVERGED_REQUIRES_CONFIRMATION`, `MERGE_CONFLICTS`, `MERGE_AWAITING_COMMIT`, `MERGE_IN_PROGRESS`, `CONFLICT_NOT_RESOLVED`, `STALE_MERGE_STATE`, `WORKTREE_DIRTY`, `MERGE_ABORT_UNSAFE`, `UNSUPPORTED_OPERATION`, and transport/auth/network errors.
- Do not turn a valid conflict state into a generic unhandled rejection or falsely show “Pull successful.”
- Keep the Git busy state/`withGitOperation`/existing promise queue correct even on timeout or failure.
- Refresh `obsidian-git:refresh`, `obsidian-git:head-change`, `obsidian-git:status-changed` (as appropriate) and the Ignis vault content cache after server confirmation. Avoid redundant refresh loops.
- Expose which conflict files remain unresolved and what the user should do next.
- Ensure notices and confirmations clearly separate **Merge**, **Mark resolved**, **Finish merge**, and **Abort merge**.

## 7. Frontend — actual diff views

Use the existing Diff View and Split Diff View rather than creating a new generic diff application.

**Support at minimum:**

- Tracked modified file: unstaged worktree diff and staged index diff, including a file with both staged and unstaged edits; distinguish those two results.
- Added/new file: correct content vs empty state in the relevant comparison (and appropriate handling before it is tracked/staged).
- Deleted file: correct deleted-file diff even when the file no longer exists in the Obsidian vault.
- Rename: display paths and rename headers accurately when detected; do not follow symlinks or read outside the vault.
- Files whose diffs are empty: explain the correct no-difference state, not silently fall back to misleading whole-file-added content.
- Binary / oversized files: show a clear non-text or truncated-diff notice; do not render binary bytes as Markdown or dump large content into a DOM node.
- Conflict paths: open a comparison for ours/theirs/base (when available), and the working-tree resolution text. Preserve the correct meaning of stage selectors; stage 2/3 meanings differ during rebase, so document/limit merge-only controls accordingly.
- Ensure the browser does **not** use `SimpleGit` via unsafe typecasts in `SplitDiffView` or infer support based solely on `instanceof SimpleGit`.

Reuse the current `diff2html` and CodeMirror-based rendering, or a small extension of them. Avoid new rich diff dependencies without need. Read-only diffs should never edit or stage changes simply by opening a view.

**Consistency and races:** if open notes have unsaved/debounced edits, save/flush before a mutation or refuse with an actionable notice. For a read-only diff, show what is on disk (or explicitly identify the working-tree snapshot). Never overwrite an unsaved editor buffer after a Pull/merge/abort watcher event.

## 8. Frontend — conflict view and resolving files

The existing Obsidian Git editor already recognizes conventional conflict markers and offers **Keep ours**, **Keep theirs**, **Keep both**, and optional **Keep base** controls. Investigate and reuse those implementations in Ignis.

- Source Control **Conflicts** section must populate from `git ls-files -u`/true Git status, not from filename-pattern searches or the Markdown report.
- Clicking a conflicted text file opens the editor with highlighted conflict sections and existing per-section action buttons, as long as the editor extension is compatible with Ignis.
- Manual edits and choice buttons must update the file through the normal Obsidian/Ignis save path, preserving CodeMirror undo/redo behavior where possible.
- **Mark resolved** must wait for pending saves to reach the server and validate the specific file; a naive `countConflictSections === 0` check is insufficient by itself, especially for modify/delete and binary conflicts.
- For ordinary textual conflicts, refuse “Mark resolved” while real unresolved Git marker regions remain unless the user explicitly acknowledges a deliberate literal marker text. Provide a clear message.
- A stage operation that resolves an unmerged path must remove its stage 1/2/3 entries from the index, leaving the chosen stage-0 resolution. File deletion resolutions must be handled explicitly, not by an unintended `git add` of a nonexistent path.
- After staging a resolved path, refresh counts and move it from Conflicts into the correct staged state. If staged resolution is edited again, represent both index and unstaged changes correctly.
- For modify/delete, add/add, rename/delete, file/directory, symlink, and binary conflicts, show a safe explanation and available **explicit file-level choices** or a manual-resolution workflow. Do not force text-only conflict-marker actions where they do not apply.
- If implementing whole-file **Use ours / Use theirs**, require confirmation per file, apply only the verified stage blob, and never silently choose a side. Consider leaving this as a documented deferred feature for complex conflicts rather than implementing it unsafely.
- If conflicts were resolved outside the browser or the server restarted, recover UI state from the Git index and worktree, rather than from browser memory.

**Important:** the existing status list might not show a file already staged as resolved until the next status update. Avoid relying on previously cached `Status` values as proof of current Git state.

## 9. Server — extend `/integrations/ignis/obsidian-git`

**Reuse** the existing server integration's registration/manifest, common router, trusted vault resolver, authentication/CSRF checks, Git execution utility, repository lock, error normalization, audit logging and filesystem-watch signaling. If any is missing, strengthen the existing shared implementation, not a second service.

### Read-only Git operations

Return data from native Git, with bounded stdout/stderr and timeout:

- `git status --porcelain=v1 -z` or `--porcelain=v2 -z` for exact index/worktree state, including rename/unmerged classification. Use NUL-safe parsing for filenames.
- `git ls-files -u -z` for **unmerged index stages**, their blob hashes/modes, and path status; stage entries are the source of truth for unresolved files.
- `git rev-parse --git-path MERGE_HEAD`, `REBASE_HEAD`, sequencer state, etc. Resolve Git paths via Git (`rev-parse --git-path`), not by assuming `.git` is always a directory.
- `git diff --no-ext-diff --no-color -- ...` for unstaged paths; `git diff --cached --no-ext-diff --no-color -- ...` for staged paths (use explicit literal pathspec protection and no command injection).
- For conflict stages, read Git blobs by **internally constructed and validated** stage references (`:1:path`, `:2:path`, `:3:path`) or validated object IDs from `ls-files -u`. Return an explicit `stageMissing` state rather than coercing it to an empty file.
- For conflict display, generate safe textual diffs or return stage content with text/binary detection, sizes, modes and optional conflict hunks. Use Git's actual stages, not solely the `<<<<<<<` markers in the working tree.
- If the current frontend uses `getDiffString(file, staged, hash)` or `show(...)`, preserve its exact semantics; do not reinterpret an arbitrary browser string as a shell command or an unrestricted Git revision expression.

Avoid emitting credentials, `.git/config` secrets, SSH environment values, or absolute server paths in responses.

### Mutating Git operations

All mutations use the same per-repo **exclusive lock** as Pull, Stage, and Commit. Hold the lock through validation, Git subprocess completion, result inspection, report update and any required index changes.

**Start merge:**

- Resolve and authorize vault; check repo, current branch, upstream and expected OIDs; inspect dirty worktree and existing operation state.
- For divergence explicitly accepted by the user, run a safe, non-auto-committing normal merge. Do not reset, rebase, stash, cherry-pick or force check out.
- Inspect Git state after running, even if Git returned non-zero. A normal content conflict is not the same as an infrastructure failure.
- Return structured `awaiting-resolution` or `awaiting-commit` result with actual affected paths, state and OIDs.

**Mark resolved:**

- Reuse stage API for a confirmed conflict resolution when possible. Require a verified repo-relative path, actual unmerged entry, file save completion, and explicit user intent; handle deletion resolution if the worktree path is removed.
- Serialize with other Git mutations and revalidate to avoid staging content that changed after the client inspected it. Use expected file state/version, mtime or content hash where practical to prevent time-of-check/time-of-use loss.
- Do not stage unrelated notes. Return fresh status and remaining conflict count.

**Finalize merge:**

- Prefer to reuse existing Commit handler and frontend commit flow.
- When `MERGE_HEAD` exists, verify no unmerged index stages remain; disallow `--amend` and auto-commit paths; preserve normal commit identity/message validation. Make Git create the intended merge commit with both parents. Don't synthesize a single-parent ordinary commit.
- Do not rewrite the staging policy globally or auto-stage unstaged files to finish the merge.

**Abort merge:**

- Require explicitly confirmed merge operation, expected merge state token/OID, and rejection of rebase/cherry-pick or stale state.
- Warn about modifications made while resolving conflicts that `git merge --abort` may not preserve. Implement a conservative safety policy (block when unsafe and show recovery instructions; consider backups if required by the existing codebase).
- Run `git merge --abort` only for an actual merge. Do not use `git reset --hard` fallback.
- Verify post-abort HEAD/index/worktree and report success/failure truthfully. Do not destroy unrelated untracked files.

### Path and trust boundaries

- Never accept arbitrary filesystem paths, Git flags, shell scripts, environment-variable settings, or unrestricted revisions from the browser.
- Normalize and constrain repo-relative paths; reject `..`, absolute paths, NUL bytes, noncanonical separators, symlink escapes, file paths inside `.git` and paths outside an authorized vault or `limitToVault` root.
- Support filenames containing spaces, quotes, newlines, leading dashes, Unicode and rename pairs. Pass arguments as arrays, `shell: false`, use `--` where appropriate, and NUL-delimited parsers.
- Enforce active vault authorization and per-vault feature enablement on **every** endpoint; preserve existing same-origin authentication/CSRF policy.
- Distinguish multiple independent vaults correctly; locks must span competing requests from different browser tabs and any already-existing automated Git jobs.
- Git execution must run with the vault-owning UID/GID; avoid broad `safe.directory '*'`, root-owned index files, or embedded credentials.

## 10. `git_conflict.md` reporting

The Pull phase already introduced `/vaults/<vaultId>/git_conflict.md`. **Preserve that user-facing feature** while integrating real merge state.

- On a diverged (not yet merged) Pull, report **“merge required / histories diverged”**, not “unresolved file conflict.”
- On a dirty-tree block, report **“unsafe to merge due to local changes”**, not “merge started.”
- On an actual conflicted merge, include timestamp, branch/upstream, HEAD/upstream/MERGE_HEAD OIDs, operation status, accurate conflicted paths and conflict types, and recovery instructions.
- When all files are staged but `MERGE_HEAD` persists, report **“all paths resolved; finish merge commit”**, not success.
- On abort/commit, update report state without silently erasing historical information. If a report is untracked/local-only, keep it excluded (`.git/info/exclude`) and do not stage it as part of Stage All or Commit All.
- Never overwrite an existing user-owned/tracked `git_conflict.md`. If this is already handled, preserve the existing mechanism; otherwise create a safe alternative/explicit error.
- The Git index remains authoritative even if the report is missing, stale or edited manually. Never resume/abort/commit solely because the report text changed.

## 11. State machine and response contract

Define/test a small explicit state machine so UI and backend agree:

| State | Git reality | UI/action allowed |
|---|---|---|
| `clean` | no active merge/unmerged entries | Pull, status, diffs, existing stage/commit |
| `diverged` | local and upstream have distinct commits; no merge underway | review difference, explicitly **Start merge** |
| `merge-conflicted` | merge in progress, unmerged index entries exist | inspect 1/2/3, edit, mark file resolved, **Abort merge** |
| `merge-awaiting-commit` | merge in progress, no unmerged paths | review staged diff, **Finish merge (Commit)**, **Abort merge** if safe |
| `merge-complete` | no MERGE_HEAD and final merge commit confirmed | normal operations again |
| `merge-abort-blocked` | abort would be unsafe or Git refused | retain state and user edits; show recovery steps |
| `rebase-or-other` | non-merge operation state exists | read-only status/diffs; merge-only actions disabled |

The server must derive states from native Git. No local storage or in-browser boolean is sufficient by itself.

Example response envelope (only if compatible with existing API):

```json
{
  "success": true,
  "data": {
    "kind": "merge-conflicted",
    "mergeInProgress": true,
    "head": "<oid>",
    "mergeHead": "<oid>",
    "conflicts": [
      {"path": "Notes/Example.md", "kind": "content", "availableStages": [1,2,3]}
    ]
  }
}
```

Avoid breaking existing Pull success and error result types or consumers. If adding a typed variant to `PullResult`, adjust every exhaustive switch/consumer explicitly. No false “up to date” result when Git has an unresolved merge.

## 12. Integration with already working Pull, Staging and Commit

### Pull regressions to prevent

- Existing fast-forward Pull remains functional, with the same remote/auth behavior.
- Missing upstream, network errors, and dirty working-tree blocks stay accurate.
- Divergence now offers an explicit merge path, rather than requiring manual shell access; do not silently merge on the next automatic Pull.
- Refresh of outside-vault counts, pulled files, and events remains compatible with existing status types.

### Staging regressions to prevent

- Stage/unstage an ordinary file, subtree, or all changes as before.
- Both staged and unstaged changes in a file are represented correctly in status/diffs.
- An unmerged path marked resolved is handled intentionally; indiscriminate Stage All must not accidentally choose a resolution for unresolved files.
- Unstage of a merge resolution must not arbitrarily destroy the conflict/index states or lose worktree content; if unsupported safely, block with a specific notice.

### Commit regressions to prevent

- Normal staged-only Commit and Smart Commit behavior remain unchanged outside a merge.
- A merge in progress is **not** treated as “nothing to commit” just because Git already staged auto-merged paths.
- If all conflicts resolved, existing Commit produces a real merge commit; do not require Push.
- No Commit while unresolved paths remain, and no Commit All auto-staging unrelated changes during a merge.
- No Commit Amend during an active merge. Conflict reporting remains intact if the commit fails.

### Ignis filesystem behavior

- Git mutation is an external filesystem change from Ignis's viewpoint. Confirm that the watcher/transport/coalescer invalidates stale metadata/content caches; hook into the existing refresh if not.
- Prevent an open Obsidian editor with unsaved content from rewriting freshly merged/resolved files.
- A browser reload, second tab or server restart must reconstruct the UI from repository state, not assume merging finished because an earlier HTTP request completed.

## 13. Tests

Create only the ones that can be run in the local development environment. Deployment-server tests will be done separately.

### A. Frontend unit/contract tests

- `IgnisGitManager.getDiffString` correctly distinguishes staged vs unstaged paths and sends active vault ID and expected request params.
- `show`/`diff`/conflict-details methods, if added, handle missing stages, deleted files, textual/binary output, timeout and structured HTTP errors.
- Pull divergence shows Merge option but does not begin a merge automatically.
- Start Merge requires explicit confirmation, sends expected HEAD/upstream OIDs and updates busy state without false success.
- Conflict resolution controls invoke normal editor save + mark-resolved stage request in correct order.
- Mark resolved failure, network outage, race/stale state and forbidden vault display actionable errors.
- Abort action requires confirmation; in-progress state remains if abort fails.
- Conflict view, Diff View, Split Diff View refresh on status-change and head-change events.
- Existing desktop/mobile manager selection remains unchanged and never routes desktop Git through Ignis API.
- Merge state disables only unsafe automatic routines; manual editing/status/diff remain usable.

### B. Server API tests

- Auth/CSRF/authorization for every new endpoint; reject cross-vault and disabled-vault requests.
- Treat every validated filename as literal path data, including names beginning with - or resembling Git pathspec magic. Reject CLI-option injection, not valid leading-dash filenames.
- Output size caps, timeouts, binary/non-UTF8, filenames with Unicode/spaces/newlines/leading hyphen.
- Verify repo lock serializes concurrent Pull/Stage/Commit/Merge/Abort from two clients.
- Verify expectedHead/expectedUpstream/expectedMergeHead preconditions reject stale actions.
- Structured error codes do not leak tokens, host paths, SSH keys or server stack traces.
- Read-only diff requests do not modify HEAD, index or worktree.

### C. Diff correctness tests

- Worktree-only change, staged-only change, both staged-and-unstaged, added, deleted, rename, untracked and binary.
- Unicode/newlines/leading-dash filenames and literal path semantics.
- Unified diff formatting compatible with current `diff2html` renderer; no Git ANSI escapes.
- Large diff truncation is explicit, not silent corruption.
- Stage 1/2/3 content and modes match the fixture; missing-stage cases correctly represented.
- Diffs reflect latest on-disk state after mark-resolved/abort/merge commit.
- A read-only diff has no side effects on worktree/index/HEAD.

### D. Manual deployment-server test plan

Write a simple checklist or fixture helper the user can run on the deployment server **after** deploying the modified plugin and Ignis integration. Include exact commands for the repository's test runner and fixture preparation. Clearly identify what manual UI checks are still required, including:

- Open two browser tabs; trigger diverged Pull and inspect stale-state handling.
- Open Conflicts section, compare base/ours/theirs, choose sides in the CodeMirror editor, save, mark resolved.
- Review staged diff, finish merge with current Commit button, confirm updated status.
- Repeat and abort a safe merge; verify vault data and previously untracked note remain.
- Reload browser or restart container during an unresolved merge and verify reconstruction.

No test should require modifying the user's production vault; test against temporary/test vaults only.

## 14. Documentation and safety notes

Extend the existing Ignis integration documentation rather than replacing it. Cover:

- Which Git states are supported: fast-forward, divergence, merge with/without text conflicts, manual resolutions, abort.
- Meaning of ours/base/theirs; note that Git's `ours` means the **current branch** during a normal merge, and `theirs` means the **incoming merge head**, not simply “the current editor text” or “the newest file.”
- Difference between **diff**, **stage**, **mark resolved**, **commit merge**, and **push**.
- How `git_conflict.md` relates to actual Git state and how to recover if out of sync.
- Safety policy for unsaved browser editor changes and aborting after resolution edits.
- Non-text conflicts and intentionally unsupported operations (including rebase/cherry-pick resolution).
- Docker prerequisites, Git permissions, and where to look for logs.

## 15. Implementation order

1. **Discovery:** inspect the local fork and record current Pull/Stage/Commit/API assumptions.
2. **Read-only diff and state:** add server diff/status/stage inspection, frontend manager methods, and existing diff view wiring.
3. **Merge initiation:** add explicit user-confirmed diverged merge and trustworthy typed states; do not break fast-forward Pull.
4. **Conflict resolution:** wire existing Conflicts UI and CodeMirror marker controls to file save + validated stage/mark-resolved.
5. **Merge finalization and abort:** integrate with existing Commit; add confirmed safe abort; audit `git_conflict.md` updates.
6. **Regression/security:** account for multiple vaults, stale requests, locking, auth and filesystem cache invalidation.
7. **Tests and docs:** write all requested tests that can be run locally without needing integration with ignis on a deployment server.

Do not stop after planning; implement all feasible scoped changes in the accessible codebase. If a repository/component is missing, implement what is available and precisely report the unavailable dependency—do not fabricate edits or test results.

## 16. Acceptance criteria

- [ ] Both browser and `/integrations/ignis/obsidian-git` server changes are implemented in the existing architecture.
- [ ] Existing Pull, Stage/Unstage and Commit still work outside merge state.
- [ ] Staged and unstaged diffs display accurate Git output in existing views.
- [ ] Conflict details accurately expose index stages and non-text/missing-stage cases.
- [ ] Explicitly confirmed merge can be started after divergence, without resetting/losing local work.
- [ ] Clean non-fast-forward merge remains pending for an intentional merge commit.
- [ ] Conflicted merge retains real Git index/merge state and the Conflicts UI shows the right files.
- [ ] Editor allows textual conflict resolution; saving and marking resolved work end-to-end.
- [ ] Remaining unresolved paths prevent merge completion; no accidental auto-stage/commit of other notes.
- [ ] Existing Commit finalizes resolved merge into a true two-parent commit.
- [ ] Explicit abort has confirmations, safe validation, and no destructive fallback.
- [ ] `git_conflict.md` contains accurate report state without being committed or used as authority.
- [ ] Browser reload / multi-tab / container restart recover Git state correctly.
- [ ] No arbitrary browser command execution; all routes are vault-authorized and mutation-locked.
- [ ] Desktop/mobile existing behavior is preserved.
- [ ] Automated tests are **created** for all critical scenarios.
- [ ] All the tests that can be run locally without requireing integration with ignis server are passed.

## 17. Required final Codex report

Report these items clearly:

1. **What changed:** feature behavior and architecture overview.
2. **Discovery:** actual local frontend/backend files, endpoints and pre-existing behavior found.
3. **Files changed:** frontend and `/integrations/ignis/obsidian-git` server separately.
4. **API contracts:** actual routes, request/response types and error codes.
5. **Merge strategy:** how explicit opt-in, Git state, conflict stages, commit and abort work.
6. **UI:** Diff View, Split Diff View, Conflicts list, editor controls, notices and refreshes.
7. **Safety/security:** authorization, locks, path validation, dirty-worktree policy, stale requests, abort handling.
8. **Tests generated:** filenames and coverage. 
9. **Deployment-server commands:** how to build/deploy and run tests manually against test vaults.
10. **Known limitations:** unsupported conflict kinds/operations and any unfinished edge cases.

**Final principle:** Git truth lives in the authorized server repository. Obsidian Git in the Ignis browser is the interface for viewing differences and explicitly resolving Pull/merge conflicts. Never infer a resolved Git merge from marker counts, a successful HTTP status, or `git_conflict.md` alone.
