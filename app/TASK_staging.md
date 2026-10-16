# TASK — Implement Staging and Unstaging on Ignis

**Read `GOAL.md` first.** Implement this phase only. Do not start Commit, Push, hunk staging or broader Git synchronization work.

## 1. Context and baseline

The Obsidian Git (in this folder) already has (at least partially) an `IgnisGitManager` and a working or partially working integration. The server-side component was previously added at **`/integrations/ignis/obsidian-git`**, following an architecture similar to Ignis's `headless-sync` plugin. **Extend those existing components**. Do not replace them, introduce a parallel HTTP service, re-implement functionality, or migrate the integration just to match another directory convention.

Checkout `./structure.md` for a high-level overview of the codebase.

**Outcome:** A user opens Ignis's Obsidian Git Source Control view and can stage/unstage files, directories or all changes. The browser sends typed requests to the existing Ignis integration; the server changes the native Git **index** in the authorized vault; the updated Staged Changes and Changes lists are immediately accurate. No Commit or Push occurs.

## 2. Exact scope

### Implement end to end

Below are possible implementation steps. Make sure to verify if such functionality already exists in Obsidian Git's desktop implementation, before implementing it to work with Ignis.

1. **Stage one file** — modified, new/untracked, deleted, and rename cases where supported by Git; preserve repository-relative vs vault-relative path semantics.
2. **Stage all changes** — including deletions, but scoped to the authorized vault when applicable.
3. **Stage a directory/subtree** — support the Source Control tree's folder action; do not stage unrelated paths.
4. **Unstage one file** — remove the selected staged change from the index, retaining the working-tree file and its contents.
5. **Unstage all** — return all in-scope staged changes to the unstaged state without discarding the worktree.
6. **Unstage a directory/subtree** — support the Source Control tree folder action without touching siblings or paths outside the allowed scope.
7. **Refresh status** — real `changed`, `staged`, `all`, `conflicted`, and outside-vault counts as defined by the current shared `Status` type; maintain correct UI lists and counts after each operation.
8. **Meaningful feedback** — show success only after the server confirms success; show actionable errors otherwise. Prevent stale busy/loading state.
9. **Regression safety** — preserve already implemented Pull, repository detection, read-only status, other Ignis functionality, and existing desktop/mobile staging behavior.

**Clarification:** Unstaging is part of this phase because users must be able to correct the index before a later Commit phase. It is *not* a request to implement Commit.

### Explicitly out of scope

- Commit, amend, auto-commit, commit-and-sync, Push, force-push, rebase, clone/init, checkout, remote/branch configuration, arbitrary Git commands.
- Interactive/partial **hunk** staging or patch application (`applyPatch`, `git apply --cached`, `stage-hunk`); keep these unsupported and clearly reported for future work.
- Discard/reset working-tree content or `git clean` (unstaging is **not** discarding).
- Rewriting the current Pull strategy or conflict-reporting system; only make compatibility fixes demonstrated necessary by staging.
- Cron, systemd, browser timers or unattended scheduling.
- Adding a brand-new status UI when existing Source Control components can be reused.

## 3. Investigate actual call sites before editing

Review the current local folder, at minimum:

**Frontend:**

- `src/gitManager/gitManager.ts` — abstract `stage(path, relativeToVault)`, `stageAll({ dir?, status? })`, `unstage(path, relativeToVault)`, `unstageAll({ dir?, status? })`, `status()` and path helpers.
- `src/gitManager/ignisGit.ts` (or actual Ignis manager filename) and its existing HTTP transport/client/error types.
- `src/gitManager/simpleGit.ts` and `isomorphicGit.ts` for expected semantics, **not** as code to execute in the browser.
- `src/gitActions.ts` — `stage`, `stageFile`, `stageAll`, `unstage`, `unstageFile`, `unstageAll`, `runFileStateMutation` and its refresh event.
- `src/commands.ts` — `stage-current-file`, `unstage-current-file` and any other staging entry points.
- `src/ui/sourceControl/sourceControl.svelte` — stage-all/unstage-all toolbar and section buttons. Some components call `gitManager` **directly**, bypassing `GitActions`; cover both paths.
- `src/ui/sourceControl/components/fileComponent.svelte`, `stagedFileComponent.svelte`, `treeComponent.svelte` — row actions and directory actions.
- Any file context-menu handlers, status polling/cache code, readiness checks, unsupported-feature notices, and `limitToVault`/`basePath` settings.

**Server:**

- **`/integrations/ignis/obsidian-git`** (actual current directory): registration/manifest, existing route(s), Pull handler, Git subprocess wrapper, vault resolution, authorization, locking, error mapping and tests.
- The existing Ignis `headless-sync` plugin only to understand the integration pattern; do not rebuild the partial integration.
- How the active vault ID is obtained and validated, and which server event or cache invalidation follows a filesystem operation.

**Before code changes:** write a short discovery note in the task's working log/PR description naming the actual existing staging stubs, URL conventions, response envelope and status refresh path. Follow the existing conventions instead of assuming this task's example endpoint names are already present.

## 4. Frontend — `IgnisGitManager`

Implement the **existing** abstract methods, retaining the precise current signatures and return types:

```typescript
stage(filepath: string, relativeToVault: boolean): Promise<void>;
unstage(filepath: string, relativeToVault: boolean): Promise<void>;
stageAll(options: { dir?: string; status?: Status }): Promise<void>;
unstageAll(options: { dir?: string; status?: Status }): Promise<void>;
```

The `status` options object, if present, is a cached browser-side optimization; do not trust it as authorization or as a complete authoritative list of files. Determine how it is used by the current implementations.

### Transport

- Send requests using the **already implemented** authenticated, same-origin Ignis HTTP client and existing active-vault ID resolution.
- Extend the server integration's current API namespace, rather than creating a second client/protocol.
- Proposed route shape **only if it fits existing conventions**:

```http
POST /api/ext/obsidian-git/stage
Content-Type: application/json

{ "vaultId": "<active vault ID>", "path": "Notes/a.md" }

POST /api/ext/obsidian-git/unstage
Content-Type: application/json

{ "vaultId": "<active vault ID>", "path": "Notes/a.md" }

POST /api/ext/obsidian-git/stage-all
Content-Type: application/json

{ "vaultId": "<active vault ID>", "dir": "Projects" }

POST /api/ext/obsidian-git/unstage-all
Content-Type: application/json

{ "vaultId": "<active vault ID>", "dir": "Projects" }
```

- Optional `dir` omitted means **all changes within the allowed scope**, not necessarily the entire repository when `limitToVault` is active.
- Convert `relativeToVault` into a single canonical repository-relative path using existing helper methods; ensure the conversion is done **exactly once**. The server independently validates it.
- Do not send an arbitrary absolute filesystem path, shell command, Git flags, or an array of arbitrary arguments from the browser.
- Use structured errors and existing error handling. If the server returns a non-success response, do not return normally as if staging succeeded.
- Map any old “future feature” staging notice/stub to functional staging, while leaving all **other** unsupported operations unchanged.
- Avoid introducing any browser-side dependency on `child_process`, `fs`, native Git or `simple-git` execution.

### UI wiring and feedback

Reuse existing Source Control components and command registrations. Verify these paths all reach the new methods:

- Command palette: Stage current file / Unstage current file.
- Source Control: Stage/Unstage on individual file rows.
- Source Control: Stage all / Unstage all on toolbar or section header.
- Folder-tree controls: Stage directory / Unstage directory.
- Any current context-menu stage/unstage action.

Use the existing queue and `obsidian-git:refresh`/status events. Avoid adding duplicate competing refresh loops. Wait for the server operation before showing success or moving files between lists; do not optimistically reclassify rows on an unsuccessful request. A successful operation must refresh the staged/changed lists and counts, including the case where a file has **both** staged and unstaged modifications.

If the editor has unsaved or still-debounced content, determine the existing Obsidian/Ignis save behavior. Ensure staging either waits for the relevant save to finish or clearly stages the last persisted content without misleading the user. Do not race an in-flight note write silently.

If an operation is unsupported in the current state (for example a conflicted path requiring a separate resolution workflow), display a specific actionable message rather than pretending it succeeded.

## 5. Backend — extend `/integrations/ignis/obsidian-git`

Add native index-operation handlers to the **existing** integration. Reuse its existing route registration, trusted vault resolution, process execution helper, auth/CSRF protection, error envelope, and operation lock. If one of those protections is missing, strengthen the existing shared implementation rather than installing a second independent subsystem.

### Required server behavior

| Request | Git index semantics | Working tree | Commit/remote |
|---|---|---|---|
| Stage file | Record the current persisted version of that path in the index; include deletions | Never rewrite | No |
| Stage all | Record all in-scope adds/modifications/deletions | Never rewrite | No |
| Stage directory | Same, restricted to requested subtree | Never rewrite | No |
| Unstage file | Restore index entry/entries to baseline, or remove if newly added | Never rewrite | No |
| Unstage all | Remove all in-scope staged changes, leave other staged paths alone | Never rewrite | No |
| Unstage directory | Same, restricted to requested subtree | Never rewrite | No |

For a normal repository with `HEAD`, preferred native Git equivalents (adapt to the current Git wrapper):

```bash
# File, directory or explicit all-vault scope:
git add -A -- <validated-literal-pathspec>

# Repository-wide stage-all only when repo root = authorized vault:
git add -A

# Unstage (index only; worktree left intact):
git restore --staged -- <validated-literal-pathspec>

# Repository-wide unstage only when permitted:
git restore --staged -- :/
```

These are illustrative native commands, **not** permission to interpolate browser-controlled strings into a shell. Use `spawn("git", args, { cwd: trustedRepo, shell: false, ... })` or the integration's equivalent established safe executor, with bounded runtime/output. Use Git literal pathspec handling (for example `:(literal)<path>` or a verified equivalent) and a `--` separator where needed; Git wildcards/pathspec magic must not turn a single file operation into “stage everything.”

### Initial/unborn branch

`git restore --staged` may fail when `HEAD` does not yet exist. Handle a newly initialized repository safely, e.g. by removing newly staged entries from the index with the appropriate `git rm --cached` behavior, without deleting working files. Add a dedicated test for staging/unstaging before the first commit. Do not use `git reset --hard` or `git clean`.

### Path validation and scope

1. Resolve `vaultId` through the server's trusted vault map; authorize the caller for **that exact vault**.
2. Ensure the Git repository belongs to the selected vault, respecting any supported `basePath` and `limitToVault` semantics. If only vault-as-repository-root is currently supported, reject all others explicitly rather than stage outside the vault.
3. Normalize/validate path as a relative repository path. Reject absolute paths, empty/special paths where disallowed, `..` traversal, NUL bytes, unsafe separators, Git metadata, and paths outside the authorized subtree. Treat filenames beginning with `-`, spaces, Unicode, quotes, glob characters and Git pathspec metacharacters as **literal filenames**, not options or patterns.
4. For a directory, stage/unstage only that subtree. Validate that it exists in worktree and/or Git index (to allow deleted directories); don't rely only on `fs.existsSync`.
5. For deleted tracked files, allow staging deletion even though the file is no longer on disk.
6. Avoid following symlinks to an outside path when resolving the requested target. Respect Git's ordinary handling of a symlink *entry* without allowing traversal through symlinked directories outside the vault.
7. Respect `.gitignore`, Git's ignore rules, and the Pull integration's `git_conflict.md` exclusion. Do not add ignored files with `-f`.
8. Validate paths and re-check relevant preconditions **inside the operation lock**, not only before acquiring it.

### Serialization and consistency

- Stage/unstage must use the **same per-repository lock** as Pull and any currently implemented status-changing operation. Two requests against the same index must not interleave.
- If the integration already supports `BUSY` / HTTP 409, reuse it. Otherwise implement an equivalent bounded-wait or conflict response.
- Handle repository-not-found, insufficient permissions, index lock held, invalid path, ignored file, merge/unmerged index entry, detached or unborn branch, filesystem errors, unexpected Git exit and request cancellation consistently.
- Never automatically resolve conflicts or clear `git_conflict.md` during staging. If staging a previously unmerged path would mark it resolved, require an explicit safe rule and tests; otherwise block it for this phase.
- Persist successful index changes in the repository's `.git/index`, not browser memory or an auxiliary list.
- Return confirmed operation results; optionally return a fresh `Status` from within the same lock to avoid a second race, **if compatible with the current frontend contract**. The client should refresh either way.

### API response and errors

Fit the existing Pull API's JSON envelope. A possible result is:

```json
{
  "status": "updated",
  "operation": "stage",
  "path": "Notes/a.md"
}
```

Possible stable errors include `INVALID_PATH`, `OUTSIDE_VAULT`, `REPOSITORY_NOT_FOUND`, `NOT_AUTHORIZED`, `GIT_OPERATION_BUSY`, `GIT_INDEX_LOCKED`, `UNMERGED_PATH`, `FILESYSTEM_ERROR`, and `GIT_OPERATION_FAILED`. Use the project's real error naming convention where it exists. The frontend should show actionable messages but not raw stack traces, environment data, internal host paths or secrets.

### Security invariants

- No arbitrary command execution endpoint.
- No user-supplied absolute host paths or flags.
- Require the same authentication, authorization and cross-site request protection as Pull.
- Never trust browser-supplied status lists to choose authorized paths.
- Never modify a different vault, the remote repository, `HEAD`, or the working tree.
- Execute Git as the configured vault-owning user rather than root where the deployment supports that model.

## 6. Status correctness — required, not optional

The current `Status` contract has `all`, `changed`, `staged`, `stagedOutsideVault`, `conflicted`, `conflictedOutsideVault`; file items include repository-relative `path`, vault-relative `vaultPath`, `index`, `workingDir`, and possibly `from` for renames. Do not replace it with a simplified, inaccurate array.

Test these distinctions:

- A newly added/untracked file becomes staged (`A`) after Stage.
- A tracked modified file can have a staged version while **further unstaged edits remain**; it may correctly appear in both staged and changed sections.
- A staged deletion appears as a deletion in the index.
- Unstaging a staged new file makes it untracked again without deleting it.
- Unstaging a modified tracked file clears the index difference while keeping the working-tree modification.
- Renames, filenames with spaces/unicode and directory-scope actions are represented accurately.
- Ignored files are not silently force-added.
- Status refresh must work in list mode, tree mode and command-palette flow.

If the existing Ignis status implementation has a gap, fix only what is necessary for staging to be accurately observable. Do not fake status to pass UI tests.

## 7. Tests — automate both layers

### Frontend unit/integration tests

- `IgnisGitManager.stage()` sends the correct vault, canonical path and endpoint; verifies `relativeToVault` true/false conversion.
- `stageAll`, `unstage`, `unstageAll` map to the right payloads, including omitted `dir` and scoped directory.
- Each operation returns/resolves only after a successful server response; failures produce notices and preserve the status display.
- Browser uses no `child_process.spawn()`/native Git for stage/unstage.
- Existing `GitActions` and direct Source Control manager calls both reach the backend.
- `obsidian-git:refresh` updates the correct lists and clears loading indicators on success and error.
- Other unsupported commands (Commit, Push, raw commands, patch/hunk staging, discard) still show future-feature notices and do not mutate anything.
- Desktop and mobile managers still use their original implementations.

### Server integration tests (temporary repositories only)

Create a temporary bare/local repo and multiple worktrees or clones as needed; **never** use the user's real vault or GitHub credentials for tests. Test:

1. Stage a new file; status and `git diff --cached` match expectations.
2. Stage a modification; stage a deletion.
3. Stage one of two changes; verify the second is untouched.
4. Stage a directory; verify only its subtree is staged.
5. Stage all; include tracked deletions and untracked additions; respect ignored files.
6. Unstage one staged new/modified/deleted file; working-tree content is untouched.
7. Unstage a directory; verify staged files outside remain staged.
8. Unstage all; verify index/worktree difference is preserved as unstaged content.
9. Stage a file, edit it again, and ensure it is correctly reported both staged and changed.
10. Filenames with spaces, Unicode, leading hyphen and Git wildcard/pathspec-special characters are treated literally.
11. Valid stage of a deleted file and staged rename; verify status correctness.
12. On an unborn branch, stage then unstage without losing worktree files.
13. Invalid/missing/ignored targets yield clear errors with no unrelated index changes.
14. Attempted `../` traversal, absolute paths, symlink escape, cross-vault stage, `.git` paths and raw flags are rejected.
15. Concurrent stage requests, and stage concurrent with Pull, serialize using the same lock.
16. Authentication/authorization and cross-site request protection cover all new POST routes.
17. Simulated index lock, Git error or permission error leaves repository/working tree intact and returns a meaningful failure.
18. Stage/unstage does not change `HEAD`, create commits, push/fetch, or delete files.
19. Staging does not overwrite `git_conflict.md` or remove an existing conflict report.
20. A full Source Control UI test exercises Stage file, Stage all, Stage folder, Unstage file, Unstage all and Unstage folder.

Use `git status --porcelain=v1 -z`, `git diff --cached`, `git diff`, `git ls-files --stage` or equivalent assertions to verify **actual Git index state**, not merely HTTP success codes.

## 8. Implementation sequence

1. **Discover:** Inspect current Pull/HTTP integration and all staging call sites; identify code already available and the precise missing pieces.
2. **Server:** Add the minimum stage/unstage routes to `/integrations/ignis/obsidian-git`, backed by safe native Git index operations and existing auth/vault/lock/error infrastructure.
3. **Manager:** Implement the four existing abstract staging methods in `IgnisGitManager`, reusing the existing HTTP client and path conversion.
4. **UI:** Enable staging entry points without enabling unrelated commands. Ensure direct `gitManager` calls and `GitActions` calls both work.
5. **Status:** Ensure correct post-operation refresh and representation of staged/unstaged dual-state files, deletions and directory-scoped changes.
6. **Tests:** Implement and execute frontend/server/repository integration tests; fix any failures.
7. **Docs:** Update the existing Ignis integration documentation or add a focused section that covers new endpoints, supported staging actions, security, troubleshooting and out-of-scope features. Update `GOAL.md` roadmap status only if appropriate.

Prefer a minimal focused change set. Do not perform speculative refactoring or build features from later phases.

## 9. Definition of done

- [ ] `stage`, `stageAll`, `unstage`, and `unstageAll` are implemented in the Ignis manager with the current interface signatures.
- [ ] The existing `/integrations/ignis/obsidian-git` backend handles those requests through native Git, using established middleware, vault resolution and locks.
- [ ] Existing file, folder, whole-vault and command-palette UI entry points all work.
- [ ] Actual Git index and worktree semantics are correct; no unwanted commits, pushes, resets or deletions occur.
- [ ] `changed` and `staged` status sections refresh accurately after every operation.
- [ ] Paths are validated and confined to the authorized repository/vault; literal filenames cannot become Git options or pathspec patterns.
- [ ] Cross-vault requests, unauthorized requests, and concurrent unsafe mutations are blocked.
- [ ] Unsaved/in-flight editor content cannot silently produce a misleading staged snapshot.
- [ ] Hunk staging/patches and every other unsupported operation remain explicitly unavailable.
- [ ] Pull behavior and existing `git_conflict.md` reporting are unchanged.
- [ ] Desktop/mobile behavior does not regress.
- [ ] Build, typecheck and relevant automated tests pass; remaining limitations are documented.

## 10. Codex final report

When finished, report:

1. Existing architecture discovered and what was already implemented.
2. Exact frontend files changed and the staging entry points now supported.
3. Exact changes made under **`/integrations/ignis/obsidian-git`** (routes, handlers, auth/vault/locking reuse).
4. Final API request/response shapes and index-operation semantics.
5. Tests run, commands used, pass/fail results, and any limitations in verification.
6. How to build/deploy/reload the plugin and Ignis server integration.
7. Remaining staging limitations (especially hunk staging) and next recommended task.

**Do not stop at design or pseudocode. Implement this staging phase in the available workspace, test it, and clearly report anything that could not be verified.** If part of the integration is unavailable in the checkout, identify precisely what is missing and do not claim it was edited.

## Working log

Discovery (2026-10-16): `IgnisGitManager` has four unsupported staging stubs.
The existing client uses same-origin `/api/ext/obsidian-git/{health,state,pull}`,
`X-Obsidian-Git: 1`, JSON POST bodies and `{ error: { code, message,
reportFile? } }` failures; success bodies are operation-specific JSON. Server
`GitService.locked` validates root-only vault repositories and shares a per-repo
BUSY/409 lock with Pull/status. Existing file rows, folder controls, context menus
and toolbar all use queued GitActions in this checkout; toolbar has additional
Ignis guards. Successful GitActions request `obsidian-git:refresh`, which updates
cached status and emits `obsidian-git:status-changed`. Command/action guards must
allow only staging. Ignis exposes delayed `writes.listPending()`, but no public editor save/freeze
API. Although the internal write-durability module has per-path tracking, the
public loader does not expose it; do not require that unavailable method.
Explicitly announce last-persisted snapshot semantics for very recent writes.
Staging
will require confirmed writes and reading/closed Markdown panes; unstaging does
not read working content. Existing root-only and no-symlink layout restrictions
remain in force. User changes to unrelated task/report files predate this work.
