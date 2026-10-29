# TASK — Complete Remaining Obsidian Git Features on Ignis

> **Codex implementation brief.** Read `GOAL.md`, `TASK_staging.md`, `TASK_commit.md`, `TASK_conflicts.md`, and `TASK_pushing.md` before editing. Work against the **current local fork**, not against assumptions from public upstream. Generate **and run** tests that work locally without a deployed Ignis instance. The user will run deployment and real Ignis integration tests separately.

## 1. Outcome and existing baseline

The long-term goal is to run the existing [Vinzent03/obsidian-git](https://github.com/Vinzent03/obsidian-git) community plugin on the [Nystik-gh/ignis](https://github.com/Nystik-gh/ignis) browser platform with substantially the same UI and functionality as local desktop Obsidian. Maintain the already implemented `IgnisGitManager` and **extend** its backend at **`/integrations/ignis/obsidian-git`**, which follows Ignis's headless-sync server-plugin architecture.

**Assume the previous phases are already implemented and working:** Pull, status, staging/unstaging, commit, diffs, merging/conflict resolution, and Push (including integration with Commit-and-sync). Validate that assumption against the fork; do not duplicate routes, managers, storage, views or tests. Preserve all prior behavior, semantics, security controls, reporting and regression coverage.

**Historical document clarification:** Any sentence in `GOAL.md` or an earlier `TASK_*.md` calling staging, committing, merging or pushing the “current task” is historical context. **`TASK_leftovers.md` is the current implementation task.**

**This task is the remaining-feature inventory and implementation plan.** Implement all reasonably adaptable upstream Obsidian Git functionality listed below, using the existing UI wherever possible. A feature already complete should be marked **existing/verified**, not reimplemented. If an upstream feature is inherently unsafe or nonsensical in a browser/server environment, preserve the original UI's sensible behavior, restrict or disable it in Ignis, and document the reason. Do not silently claim parity.

### Non-negotiable architecture

```text
Local desktop Obsidian -> Obsidian Git -> SimpleGit -> local Git
Mobile Obsidian        -> Obsidian Git -> IsomorphicGit

Ignis browser -> existing Obsidian Git UI and GitActions
              -> IgnisGitManager (typed HTTP client)
              -> existing authenticated, vault-scoped integration
                 /integrations/ignis/obsidian-git
              -> native Git against the resolved server vault
```

- **Frontend:** Integrate every supported operation into the *existing* Obsidian Git commands, modals, menus, settings, views, promise queue, progress reporting, notifications and refresh lifecycle. Do not build a competing Git UI.
- **Backend:** Extend the existing routes/controllers, vault resolution, Git execution abstraction, authentication, concurrency locks and error model. Do not create another Git daemon/service or expose a generic shell/Git-command executor.
- Keep desktop and mobile managers, code paths and functionality unchanged unless making a compatible upstream-wide improvement.
- When a feature modifies the worktree or index, update Ignis's vault file reconciliation/watchers and Obsidian Git's status/cache; prevent overwriting unsaved browser-editor content.
- Avoid guessing current API paths or names; use the actual code in this checkout.

## 2. Required source scan and parity audit — perform FIRST

The upstream code scanned when this task was drafted includes these features, but **local fork source is authoritative**. Survey the *entire* upstream-facing feature surface and mark its status before changing code.

### Inspect Obsidian Git

- `src/gitManager/gitManager.ts` — abstract interface, return types, path transformations.
- `src/gitManager/simpleGit.ts` — native behavior and desktop-only helpers (e.g. patch application, squash, submodules).
- `src/gitManager/isomorphicGit.ts` — alternative behavior and platform guards.
- Existing `IgnisGitManager`, HTTP client, errors/capabilities added during earlier phases.
- `src/main.ts`, `src/gitActions.ts`, `src/commands.ts`, `src/automaticsManager.ts`, `src/autoCommitGlobs.ts`.
- `src/setting/settings.ts`, settings types/defaults, localStorage and migrations.
- `src/ui/sourceControl/`, `src/ui/history/`, `src/ui/diff/`, `src/ui/modals/`.
- `src/editor/` (hunks, change signs, line author/blame and conflict decorations).
- Status bar, file explorer context menus, ribbon, GitHub links, notification and logging utilities.
- `tests/`, `package.json`, build/test scripts, current docs and command registry.

### Inspect existing Ignis integration

- Everything under `/integrations/ignis/obsidian-git` including the current route registration, controllers, Git service, shared locks, error codes, auth/origin checks, helper methods and tests.
- Existing Pull/Stage/Commit/Conflict/Push API contracts and their local frontend callers.
- Ignis's actual vault ID-to-path resolution and per-vault authorization model, file reconciliation and server-process identity.
- Any existing server-side timers/background jobs, host scheduler hooks and plugin lifecycle.

### Produce a committed feature inventory

Create or update a concise `docs/ignis-feature-parity.md` (or a suitable existing doc) with a table containing **feature, upstream UI/command, manager/server method, current Ignis state, planned work, tests, limitations**. Use these states: `already working`, `partially working`, `not implemented`, `intentionally restricted`, `blocked (reason)`.

The inventory must cover at minimum **every upstream registered command, relevant UI button/context-menu action, manager abstract method, desktop-specific helper, automatic routine and exposed setting**. Search for `instanceof SimpleGit`, `Platform.isDesktopApp`, `child_process`, `spawn`, `exec`, `fs`, and unsafe browser assumptions. Do not mistake UI rendering for implemented functionality. Record the version/commit IDs of the local fork and the upstream reference used.

The feature groups below are the **required baseline**, not an excuse to skip something else found during the audit.

## 3. Feature map and implementation priorities

| Priority | Remaining feature family | Frontend responsibilities | Server responsibilities |
|---|---|---|---|
| P0 | Full History View / per-file history | Restore original view, filters, file selection, badges, navigation | Paginated `log`, changed-file data, commit metadata, historical diffs/blobs |
| P0 | Discard/reset and ignore | Original Source Control controls, warnings, status updates | Safe per-file/all discard, untracked deletion policy, `.gitignore` behavior |
| P0 | Fetch/branch/upstream/remotes | Original commands/modals and settings | Allowed native Git read/mutate operations, guarded branch/remote config |
| P1 | Hunk-level operations/editor signs | Existing diff and editor controls | Validate/apply/reverse exact patches or equivalent safe index/worktree changes |
| P1 | Line authoring/blame | Original line decorations, settings, navigation | Efficient blame retrieval and optional copy/move-follow analysis |
| P1 | Automation and scheduling | Existing controls and accurate status, settings handshake | Reliable background jobs with durable schedule and per-vault state |
| P1 | Repository setup/management | Existing init/clone workflows, guided warnings | Restricted vault-scoped init/clone; dangerous deletion separately gated |
| P2 | Advanced Git behavior | GitHub links, optional amend/squash and other upstream settings | Safe read-only links and narrowly allowed history rewriting where appropriate |
| P2 | Optional submodule behavior | Opt-in UI and clear warnings | Constrained submodule discovery/update/checkout with authorization |
| Restricted | Raw shell/Git CLI, custom executable/env, OS close | Explain unavailable equivalent | **Do not** expose arbitrary execution or host-level settings |

Priorities indicate **delivery and testing order**, not permission to leave tasks unimplemented without reporting them. A large task may be completed in self-contained commits/milestones. Preserve the existing regression suite after each milestone.

## 4. History View, commit inspection and file history (P0)

### Frontend

- Reuse **Open history view**, the existing history list, commit expansion, author/date/message display, changed-file list, and links to historical file diffs.
- Support repository history and file-scoped history, within the actual limits of the current UI. Preserve filters, display options, pagination/limits, current branch/ref selection and refresh behavior if upstream offers them.
- Wire `IgnisGitManager.log(file, relativeToVault, limit, ref)`, `show(commitHash, file, relativeToVault)`, `getLastCommitTime()` and other required *read-only* methods to the existing typed client.
- Ensure history entries and changed-file metadata match the shapes expected by current components. Never synthesize empty history when the backend fails.
- Handle root/unborn branches, deleted/renamed files, binary content, non-UTF-8 files and commits without parents. Show a clear UI state rather than throwing.
- Preserve existing History View styles and command IDs. History navigation should not mutate the Git working tree.

### Backend

- Extend existing read-only routes/service to retrieve `git log` in stable, **machine-parseable** form (use NUL delimiters or equivalent robust parsing; not fragile human-readable delimiters), with bounded page size, output, memory, time and history traversal.
- Return hash, parents, author, author email (if original view needs it), authored/committed dates, message and changed paths/status. Preserve rename/copy semantics and parent-dependent diff meaning.
- Provide historical blob and diff retrieval from **validated immutable commit OIDs** or securely resolved refs; never allow arbitrary `git show` format syntax or `rev:path` injection.
- Use Git path separators literally, handle filenames with spaces/newlines/unicode/leading dashes/pathspec magic, and avoid running a diff against a wrong or unauthorized vault.
- For large binary blobs, enforce limits and return metadata/unsupported preview rather than dumping bytes into JSON.
- Add caching where useful, keyed by vault and commit/ref, with invalidation when refs change; preserve correct history after Pull/Commit/Push/Checkout.

## 5. Discard, reset and ignored files (P0; destructive)

### Frontend

- Restore existing file/folder discard controls and **CAUTION: Discard all changes**, plus confirmation dialogs and expected status refresh. Match original Obsidian Git semantics and explicit scope; never swap staging/unstaging for discard.
- Show exactly which staged, unstaged and untracked paths will be affected before execution. Require an intentional confirmation for destructive actions, with stronger confirmation for discard-all/untracked deletion.
- Support the existing **Add file to `.gitignore`** command in editor, file explorer and applicable views. Preserve Obsidian's file access model and upstream rule formatting.
- Prevent silent removal of an open file with unsaved edits; have an explicit guard/refresh strategy for editors and Ignis watchers.

### Backend

- Implement `discard(filepath)`, `discardAll({dir,status})`, and `getUntrackedPaths()` semantics as actually defined upstream. Distinguish: restore tracked worktree, restore staged/index changes, discard both (if UI explicitly requests), and delete untracked files. A request must state its mode clearly.
- Never implicitly execute `git clean -fdx`, delete ignored files, reset the entire repository to another commit, remove `.git`, or affect paths outside the authorized vault.
- Use a two-phase preview/confirmation model for bulk destructive actions where feasible: server supplies affected paths and a short-lived snapshot/version token; mutation refuses if status changed. Always recheck under the per-repository lock.
- Resolve paths server-side and reject symlink traversal, absolute paths, `../`, nested-repo ambiguity or paths outside policy. Reject actual option injection; **do not reject legitimate filenames beginning with `-`**. Treat paths literally with `--` and literal pathspec handling, or use Git's NUL-delimited path APIs.
- Exclude the local `git_conflict.md` report and application-managed files from automatic cleanup; preserve conflict resolution state and refuse unsafe discard during unfinished merges unless that action is explicitly a separately reviewed Abort Merge action.
- Handle root commits, new files with no HEAD entry, staged deletions, renames, type changes, nested directories, filenames with special characters and race conditions.
- For `.gitignore` changes, use the existing trusted vault adapter or a scoped backend action (whichever is safe in the fork), do not blindly append duplicate or broad wildcard rules, and avoid writing to another vault's ignore file.

## 6. Fetch, branch and upstream management (P0)

### Frontend

- Enable existing **Fetch**, **Switch branch**, **Switch to remote branch**, **Create new branch**, **Delete branch** commands and related Source Control/setting UI.
- Preserve the original branch selection/creation/deletion dialogs and confirmation flows. Display current branch, upstream/tracking status, local branches and remote branches accurately. Add refresh handling after ref changes.
- Enable and correctly map `fetch(remote?)`, `branchInfo()`, `getRemoteBranches(remote)`, `checkout(branch, remote?)`, `createBranch(branch)`, `deleteBranch(branch, force)` and `branchIsMerged(branch)`.
- For `force` branch deletion, require a separate explicit danger confirmation and deny if a protected/current branch would be affected. If upstream provides weak confirmation, strengthen it only for Ignis.

### Backend

- Implement **fetch-only** (do not merge worktree), branch listings, tracking info, checkout, create, delete and branch merge-status with narrow, typed API commands.
- Branch changes must guard dirty worktree, staged changes, unresolved merges/rebases, unsaved editor content, untracked-file collisions, submodules and parallel sessions; no automatic stash, hard reset or discard.
- Validate branch and remote names with `git check-ref-format` and additional policies. Prevent `-` option injection, raw revision expressions, ambiguous names, remote-branch spoofing and path escapes.
- Use a strict checked server-authorized remote target and existing credentials. For fetch, restrict remote names to configured allowlisted remotes; no arbitrary URL in a fetch request.
- Enforce per-vault lock and filesystem refresh after checkout. Handle detached HEAD and branch selection in an explicit, non-silent way.
- Restrict force deletion of merged/unmerged and default/current branches; never delete remote branches as a side effect of local branch deletion.

## 7. Remote management and repository Git config (P0)

### Frontend

- Enable the upstream **Edit remotes**, **Remove remote**, **Set upstream branch** dialogs and repository author `user.name` / `user.email` settings where appropriate.
- Reuse `getRemotes()`, `getRemoteUrl()`, `setRemote()`, `removeRemote()`, `updateUpstreamBranch()`, `getConfig()` and `setConfig()` through the existing client.
- Reflect current values and expected validation errors, not fake success. Show masked/sanitized remote URLs if credentials appear in them; never echo passwords/tokens.
- Make explicit that browser device-specific settings are distinct from server Git identity/environment. Do not allow shared settings to override other vaults' server credentials.

### Backend

- Use narrowly-scoped, authenticated configuration APIs. **Do not implement arbitrary `git config` keys** supplied from the browser. Define an allowlist (`user.name`, `user.email`, approved branch upstream/tracking keys, and other explicitly reviewed settings); keep system/global config read-only or inaccessible.
- Validate author length/line endings/control characters; enforce reasonable commit identity rules without modifying unrelated repositories.
- For add/update/remove remote, require explicit authorization/confirmation and a **server-side remote URL policy**: approved schemes/hosts, no local filesystem remotes, no `ext::`, credential-bearing URLs, SSRF destinations or URL tricks. Honor existing deployed remote restrictions; do not silently broaden them.
- Validate remote names/branch choices, prevent deletion of an in-use upstream without confirmation, and avoid changing the remote of an in-flight Pull/Push.
- Never expose private key material, ask the browser to supply an SSH key, or enable generic credential helpers at user request.

## 8. Hunk staging, hunk reset, Diff View advanced actions and editor change signs (P1)

> Earlier conflict/diff work may already cover parts of this. Verify before implementing.

### Frontend

- Reuse the existing **Diff View** (split/unified where supported), **Stage hunk**, **Reset hunk**, **Preview hunk**, **Next/previous hunk**, editor change signs and hunk status-bar controls.
- Replace `instanceof SimpleGit` feature gates only where equivalent capabilities are genuinely available on Ignis. Prefer explicit capability checks rather than changing every desktop guard to true.
- Enable patch/hunk UI actions through an Ignis-specific backend method, preserving original visible labels, keyboard commands, selection behavior and status refresh. Keep purely client-side navigation/preview local.
- Support a stale-diff UX: if file, index or `HEAD` changed since the hunk was displayed, show "Refresh diff and try again" rather than applying to an unintended region.

### Backend

- Implement typed operations for **stage exact hunk**, **reverse/reset exact unstaged hunk**, optionally **unstage exact staged hunk** only where upstream UI explicitly supports it. The API must distinguish index vs worktree target.
- Prefer server-generated patch IDs or a validated patch+expected-blob-hash contract over arbitrary attacker-controlled `git apply` text. Recompute/verify patch context under the repository lock; require matching `HEAD`/index/worktree version and a clean applicable patch.
- Use `git apply --check` (with correct `--cached`, `--reverse`, and relevant context options) before application where applicable. Avoid untrusted patch paths and filesystem escape. Do not permit patch headers targeting `.git`, another vault, absolute paths or symlink escapes.
- Preserve untouched hunks, staged changes, CRLF vs LF, trailing newlines, mixed edits, empty/renamed files and binary handling. Do not apply partial patches silently.
- Maintain consistent result/status/cache/UI refresh semantics already used by staging and merging.

## 9. Line authoring and Git blame (P1)

### Frontend

- Restore upstream **Toggle line author information**, line author gutter/decorations, age coloring, hash/author/date display, timezone formatting and related settings where supported by Ignis's CodeMirror environment.
- Enable line-level author info when editing an appropriate Markdown file. Preserve settings for following moved/copied lines (if server implementation supports them) and UI navigation to commits/history.
- Avoid blocking the browser on large files. Debounce/cancel requests, cache results and invalidate after commits/checkout/pull; clear stale decorations on editor/file changes.
- Preserve desktop behavior; if Ignis's editor API cannot render a particular decoration, document that limitation instead of claiming it works.

### Backend

- Add a **read-only, file-scoped Git blame** API using native Git (`git blame --line-porcelain` or other structured method), returning commit IDs, author metadata, timestamps/timezones and line ranges in a typed format.
- Authorize file paths and reject unsafe revisions. Restrict expensive follow-movement/copy options with bounded line counts, commit traversal, CPU and response size. Handle uncommitted edits and synthetic/not-yet-committed lines accurately.
- Avoid leaking data from files outside the authorized vault or from arbitrary revisions. Cache only when the file/ref version matches.

## 10. Automatic routines and unattended operation (P1)

Upstream supports auto commit-and-sync, independent auto commit/pull/push intervals, pull on startup, automatic backup after file change, pause/resume, auto-commit file globs and commit message templates. `GOAL.md` also defines the target server schedule: **commit + pull every 60 minutes; push every 300 minutes**.

### Frontend

- Keep the familiar Obsidian Git **automatic routines** settings, interval controls, **Pause/Resume automatic routines** command, status indicators, error notices and commit-message preview/templates.
- Distinguish **browser session** actions (e.g., "pull on opening Ignis") from **server unattended jobs** that continue when no browser is open. Never pretend browser timers are reliable in closed/suspended tabs.
- Make it obvious where timing is managed. For Ignis, server schedule should be authoritative; do not run both browser and server timers independently and inadvertently double-commit/push.
- Sync allowed settings to the backend with validation. Device-only settings must not leak from desktop Obsidian into the server or override server scheduling unintentionally.
- Preserve per-vault Pause/Resume behavior, provide last/next run, last error and operation status. Existing dropdowns and UI should remain visually consistent.

### Backend

- Add a persistent scheduler **through an approved existing Ignis background-job mechanism or documented host integration**, not by spinning an untracked Bash loop in the HTTP request process. Investigate Ignis architecture before choosing the final approach; if scheduling is external systemd/cron, define clear idempotent one-shot commands and configuration, without requiring systemd inside a Docker container.
- Store schedule state and per-vault enabled/paused/last-success/last-error/next-due state durably. Work correctly across restart/redeploy and multiple server processes; serialize with the same repository locks used by HTTP operations.
- Preserve exact intended semantics of commit only, pull only, push only and commit-and-sync. Honor the 60/300-minute target without push on every hourly commit. Push must still enforce the existing safe push preconditions; no force push.
- Stop/retry appropriately on network failure, auth failure, conflicts, dirty tree, unfinished merge and backoff conditions. Do not launch overlapping jobs. Surface conflicts through existing `git_conflict.md` handling without destroying reports.
- For auto-commit selection, reuse `selectAutoCommitFiles`/auto-commit globs and the repository scope limits. Do not blindly stage all, commit ignored files or bypass manual staging when user configured exclusions.
- Support commit message templates/placeholders (time/date/device/vault as upstream supports) with correct source of server identity; use existing identity policy. No arbitrary executable commit-message script from browser settings.
- If upstream's **squash before push** is supported, implement it as a separate guarded option in section 13, not implicitly as part of scheduling.

### Behavioral test examples

- Browser tab closed: scheduled operation still executes; browser reopening shows truthful state.
- Restart during interval: persisted due-time behavior is deterministic (document catch-up policy); missed pushes are not silently duplicated.
- Two tabs and scheduler simultaneously: one serialized operation, not duplicate commits.
- Paused vault: no scheduled mutating actions; other vaults continue.
- 60-minute commit/pull does not push; 300-minute push follows already implemented safe Pull/Push contract.

## 11. Repository initialization, cloning and deletion (P1; opt-in)

### Frontend

- Adapt upstream **Initialize a new repo** and **Clone an existing remote repo** commands/modals to *server-owned vaults*, rather than filesystem paths on the browser's device.
- Show existing vault/repository state; request only a trusted vault ID and validated remote choice. Preserve UI where semantics match; add explicit descriptions if server behavior differs.
- **CAUTION: Delete repository** must be disabled by default in Ignis. If made possible at all, require a separate administrative capability, double confirmation and recovery instructions; never automatically delete the user's vault files.

### Backend

- Init only an **authorized, existing vault** that has no `.git`; do not adopt a nested repo inadvertently or overwrite a preexisting Git directory.
- Clone to a controlled temporary directory under the approved vault storage area (or follow Ignis's existing vault provisioner), verify clone, then atomically finalize only if destination is safe and still available. Do not clone over user notes or replace an open/loaded vault without a supported migration workflow.
- Clone URL must satisfy the server-side remote URL/host policy; limit size/time/pack objects, disable untrusted Git protocol helpers, honor server SSH/credentials, refuse path traversal, symlinks and submodule execution by default.
- A server-side `.git` deletion, if explicitly authorized, must delete **only Git metadata** for the exact authorized vault, require an administration-level policy/confirmation, avoid arbitrary path deletion and never erase the vault's notes. Reject if merge/rebase/active jobs or uncertain repository layout. Prefer a backup/export path over irreversible deletion.

## 12. GitHub integration and read-only utilities (P2)

### Frontend

- Enable upstream **Open file on GitHub** and **Open file history on GitHub** actions, preserving branch/line/path encoding and handling non-GitHub remotes gracefully.
- Restore **List changed files**, changed-file tree/list toggles, status bar counts, unpushed-commit indicators, Git operation progress, offline/error state and notices where not already working.
- Support useful read-only Git status utilities required by settings and views without exposing generic commands.

### Backend

- Return sanitized remote URL identity, current branch, SHA and tracking metadata; never expose embedded credentials. Client should construct GitHub URLs only for verified GitHub-compatible remotes, with correctly encoded repository/file/path/ref components; no open-redirect or JavaScript URL injection.
- Avoid a server endpoint that opens browsers. Opening external web URLs is a **frontend** action.
- Keep changed-file metadata and progress consistent with existing status API; handle renames, deletions, staged/unstaged splits, untracked, conflict state, unpushed counts and refresh after Git mutations.

## 13. Advanced history behaviors (P2; guarded)

Include these only with precise parity semantics and opt-in protections; do **not** substitute unsafe shortcuts.

### Amend previous commit

- Inspect the existing desktop-only amend UI and whether the prior Commit task already implemented amend. If not, implement it through the existing modal/action and a typed server option.
- Require explicit amend intent, verify commit/index state, protect merge commits and **never rewrite already-published or remotely reachable commits** without a distinctly documented, reviewed workflow. No automatic force push.
- Preserve staged-vs-unstaged behavior and new author/message intent. Return correct updated OID and refresh history/status.

### Squash local unpushed commits before Push

- Upstream `SimpleGit.squashAllUnpushedCommits()` is an optional desktop feature; implement on Ignis **only when explicitly enabled**, with equivalent safety checks.
- Determine the actual push target; require multiple **unpushed** commits; skip on staged changes, merge commits, missing upstream/push target or uncertain reachability. Protect already-published history. Do not force push or rewrite a commit visible on the configured remote.
- Serialize against Pull/Commit/Push; preserve worktree/index; report why skipped vs completed; add real Git integration tests for history invariants.

### Optional submodule support

- Upstream offers opt-in desktop submodule update and checkout recursion. Treat this as an **explicitly gated capability**, disabled by default.
- Inspect `.gitmodules` and configured URLs server-side; restrict nested remote hosts and paths, recursive depth, network and filesystem access. Never allow arbitrary submodule commands or access to sibling vaults.
- Implement only operations that can be safely authorized, with separate per-repository/submodule locks, correct status and error reporting. No hooks or external command execution; if safe isolation cannot be demonstrated, document it as intentionally restricted rather than shipping an insecure approximation.

## 14. Explicitly restricted / nonportable features

These must be included in the parity audit, but **must not** become unauthenticated server execution or host administration features:

- **Raw Git command** text field: do **not** send arbitrary commands/arguments to the server. Leave unavailable in Ignis; provide only typed, allowlisted equivalents from this task. Do not expose a general `spawn`, `exec` or shell bridge.
- **Commit message script** run via `child_process.spawn`, arbitrary Git hooks/scripts or user-controlled environment variables: no client-provided executable paths or shell, no executable automation driven by synced settings. A future administrator-configured server hook mechanism is a separate security-reviewed feature.
- **Custom Git executable path**, custom `PATH`, global environment editor, OS hostname and other desktop-specific controls: map to **server deployment configuration** when relevant; do not expose host configuration to browser clients.
- **Commit-and-sync and close Obsidian** / `window.close()`: do not attempt to close or navigate away from the user’s browser tab unless browser semantics and user gesture are explicitly safe. Preserve commit-and-sync itself; show a clear unavailable/alternate behavior for the close-only part.
- Unrestricted `.git` deletion, `git clean -fdx`, reset to arbitrary revision, force push, recursive submodule updates, arbitrary remotes and force branch rewriting: not general browser actions. Add only specifically approved, typed, audited subsets described above.

Every restricted feature should have a consistent explanatory Obsidian notice or be disabled with a reason. It must not silently succeed or damage data. The normal desktop/mobile feature remains unchanged.

## 15. Shared frontend integration checklist

For each feasible feature:

1. Locate **all** upstream entry points: command palette, Source Control view, History View, Diff View, editor gutter, context menus, ribbon, status bar, settings tab and keyboard bindings.
2. Follow existing `GitActions` and `GitManager` abstractions. Prefer implementing methods in `IgnisGitManager`; use capability flags where the upstream code gates on `SimpleGit` or `Platform.isDesktopApp`.
3. Extend the existing typed Ignis HTTP transport, with stable request/response/error structures and explicit operation names. No invented parallel client.
4. Keep original labels, menus, history/diff view designs, prompts, settings persistence and notifications; make only necessary adjustments for browser/server differences.
5. Prevent unsupported commands from calling placeholder stubs or accidentally triggering native Node APIs in the browser. Expected unsupported behavior is a clear notice, not a stack trace.
6. On mutation: reflect progress, use the existing queue, refresh caches/views/editor safely, re-check current vault, and accurately display success/failure. On read: bound loading state, cancellation and retries.
7. Do not mix repositories when tabs switch vaults. A response for a now-inactive vault must not update the wrong view.
8. Keep desktop/macOS/Windows/Linux and mobile selection, operations and settings behavior intact.

## 16. Shared server/API security and correctness checklist

Apply these to **every** new route and service operation:

- Reuse existing authenticated session and **per-vault authorization**, origin/CSRF defenses, trusted vault ID resolution, locking, Git process lifecycle, timeouts, output limits, logging and structured errors.
- Resolve paths/realpaths within the authorized vault. Reject traversal, absolute/out-of-scope paths, symlink escapes and malformed identifiers; avoid affecting `.git` internals through file APIs.
- **Treat filenames literally**, even if they begin with `-` or look like `:(exclude)foo`. Prevent CLI-option and Git pathspec injection using `--`, `--literal-pathspecs`/literal pathspec environment or robust NUL-delimited APIs as appropriate; never reject a filename *solely* for starting with a dash.
- Validate Git refs/OIDs, remote and branch names, revision kinds, path counts, request bodies, bounded text sizes, limits and operation-specific policies. Never concatenate untrusted values into shell strings; invoke Git with argument arrays and `shell: false`.
- Beware of Git config/aliases/hooks, credential helpers, protocol helpers, SSH commands, alternate object directories, environment overrides and untrusted repository content enabling execution/network access. Use constrained server environment/configuration and remote policies; audit any new dangerous Git invocation.
- Execute under the vault-owning non-root identity; do not solve dubious ownership by globally trusting all repositories. Preserve Git metadata/SSH secrets across deployment without embedding secrets in the image.
- Serialize mutating actions with the same lock as existing Pull/Stage/Commit/Conflict/Push. Read-only operations must see consistent state or return a retryable stale-snapshot result.
- Return typed results and categorized errors, without leaking secrets, untrusted HTML, command strings, arbitrary server paths or environment variables.
- Protect dirty worktree, staged files, untracked files, local commits, unsaved editor buffers, merges/rebases and `git_conflict.md`. No hidden stash/reset/force recovery.
- Support multiple vaults independently. No repository path supplied by browser clients; no side-effects outside an approved vault.

## 17. Tests — GENERATE **AND RUN LOCALLY**

The agent **must implement and execute** tests that can run on a developer/CI machine **without an Ignis deployment, live GitHub credentials or a browser integrated with Ignis**. Use project-provided tests and local temporary Git repositories. Do not run deployment/manual end-to-end integration tests; the user will do those separately.

### A. Frontend unit/contract tests (mocked Obsidian and transport)

- Cover every new `IgnisGitManager` method: correct route, vault, request payload, response mapping, failures, timeouts, cancellation and error notices.
- Cover existing UI command/action bindings and capability guards for History/Fetch/Branch/Remote/Discard/Ignore/Hunk/Blame/Repository setup/Automation; original controls fire the correct operation and don't call unsupported browser APIs.
- Verify status refresh, promise queue behavior, stale-vault cancellation, visibility of disabled settings, loading indicators, unsupported-operation notices and desktop/mobile fallback.
- Test unsafe operations require confirmation and stale-snapshot prevention; no mutation request before consent.
- Test no secrets are exposed in rendered remote URLs/errors, and HTML/Markdown rendering is escaped correctly.

### B. Server API/authorization/validation tests

- Valid operations execute for an authorized vault; missing auth, wrong vault, CSRF/origin failure, wrong content type and malformed input fail safely.
- Path boundary tests: `../`, absolute paths, symlink escape, `.git` internals, nested repository boundaries, cross-vault ID, paths with spaces, unicode, newlines, **leading dashes**, Git pathspec magic, case-sensitive paths and NUL bytes.
- CLI-option injection and revision/ref injection attempts are rejected or treated as **literal path data** as appropriate.
- Validate branch and remote names, URL schemes/hosts/protocol helpers, configuration-key allowlist, untrusted OID, output/time limits, large responses and overlong commit messages.
- Multiple simultaneous requests use existing lock correctly; failures release the lock and preserve existing repository data.

### C. Real native Git local integration tests (no network services)

Create fresh temporary worktrees and a **local bare `origin`** inside test temp directories. Never mutate a developer vault, a real GitHub repo or the deployment server.

**History:** root and merge commits, author/time/message, file-specific history, file renames/deletions, pagination, historical diffs, nonexistent refs and binary content.

**Discard/ignore:** stage vs unstaged distinctions, untracked deletion guards, empty files/dirs, large directory preview, conflicting merge state, ignore-rule specificity and all special filename cases; verify unaffected paths retain byte-identical content.

**Fetch/branch:** fast fetch without updating worktree; create, checkout, remote branch switch, delete merged/unmerged branch, detached HEAD, missing upstream, dirty/staged/untracked collision, denied force deletion and unchanged remote state.

**Remote/config:** list/add/update/remove only authorized remotes, allowed author settings, forbidden arbitrary config keys, invalid URL schemes and arbitrary remote URLs, no accidental credential exposure.

**Hunks:** stage exact hunk, stage one of multiple hunks, reset selected hunk without affecting others, stale patch fails, newline/CRLF, adjacent hunks, binary, path injection attempts, unstaged vs staged correctness.

**Blame:** correct last-commit attribution per line, uncommitted lines, file rename/copy-follow options, correct timestamps, unicode and large-file limit handling.

**Automation:** 60/300-minute schedules using an injected/fake clock, restart/catch-up policy, pause/resume, double-run protection, conflict stop, failed push/retry, non-overlap with HTTP requests, per-vault isolation and auto-commit globs. Tests must not actually wait hours.

**Repository lifecycle:** init empty authorized vault, reject overwrite, safe clone from local bare remote, verify temp cleanup after failure, deny unauthorized deletion, notes survive any explicitly allowed removal of `.git`.

**Advanced:** amend constraints, optional squash only unpushed commits (no force push, merge/staged guards), safe submodule restrictions if implemented, GitHub link sanitization.

### D. Existing regressions — mandatory

Run the local suites for the already working **Pull, Stage/Unstage, Commit, Diff/Conflict/Merge and Push**, and the desktop/mobile compatibility/unit tests. The new feature work may not make them fail.

### E. Commands and execution policy

- Inspect `package.json` and the existing test runner(s). Generate focused tests using established project conventions, then **run all new locally runnable tests**, static typing, lint and applicable builds. Run regressions for touched modules.
- If a command is unavailable due to missing tooling, install dependencies **only if permitted and feasible**; otherwise report exact missing prerequisites and results honestly. Do not invent passing tests.
- Never access live GitHub remotes, real SSH deploy keys, production repositories or a deployed Ignis instance in automated tests. Use mocks and local bare repositories.
- Do **not** run Docker deployment, live Ignis browser end-to-end, real user vault migration, production push/clone, real OAuth/SSH credential or integration-server tests. The user will test those manually.

## 18. Implementation and verification sequence

1. Read `GOAL.md` and previous task specs. Inspect actual fork and upstream surfaces; generate the **feature parity matrix** including unknown upstream features.
2. Confirm working baseline, API contracts and existing tests. Do not disturb earlier phases.
3. Add reusable, typed server read-only primitives for history and refs, then wire History View/file history. Test locally.
4. Implement guarded discard/ignore operations and previews. Test safety/rollback conditions.
5. Implement Fetch/branch/upstream/remotes/config with strict policies and existing UI. Test locally.
6. Implement hunk patch/reset and Git blame/editor signs. Test locally, retaining previous conflict/diff behavior.
7. Implement server-appropriate automatic routines and the durable 60/300 schedule, using existing scheduler infrastructure or a documented supported host timer interface. Test using a fake clock and temporary repositories.
8. Implement opt-in repo setup and advanced features only within explicit security gates. Test locally.
9. Audit all remaining command IDs, context menus, settings, editor commands, UI actions and abstract Git methods; no silent unsupported gaps. Update docs and feature matrix.
10. Run all local checks/regressions and fix failures. Leave deployment and real Ignis integration testing to the user.

Use small, reviewable commits; keep frontend and backend changes coordinated within each milestone. If the local fork differs substantially from the public upstream, adjust implementation to real code and explain deviations. Do not invent APIs just to satisfy this document's examples.

## 19. Final acceptance checklist

- [ ] Upstream feature inventory is complete and each command/setting/UI entry is marked with a real implementation state.
- [ ] Existing Pull, Staging, Commit, Conflicts/Diffs and Push continue to work without changed semantics.
- [ ] History View, commit/file history and historical diffs work with accurate backend data.
- [ ] Discard/restore and `.gitignore` flows are safe, confirmed and reflected correctly in status.
- [ ] Fetch, branches, remotes, upstream and allowed Git config are supported through original UI and scoped backend routes.
- [ ] Hunk-level actions and line-authoring work where Ignis's editor APIs support them, or are explicitly documented as limited.
- [ ] Automatic routines have truthful settings and server-side reliability; commit/pull every 60 minutes and push every 300 minutes without doubled jobs.
- [ ] Supported init/clone and advanced operations obey policy, with risky/unsupported actions clearly restricted.
- [ ] No arbitrary browser process spawn, generic Git/shell execution route or bypass of vault authorization exists.
- [ ] Paths, refs, remotes and Git operations are validated, serialized and safe against injection and data loss.
- [ ] Original Obsidian Git UI/commands/settings remain familiar; no second Git frontend is created.
- [ ] Desktop/mobile remain compatible.
- [ ] New frontend, server, native-Git, security and regression tests are **generated and run locally**; results are reported accurately.
- [ ] Deployment and live Ignis integration tests are **not run**; exact manual test instructions are supplied to the user.

If a requirement is not feasible safely, preserve the existing implementation, **mark it as restricted/blocked**, document a concrete explanation and a safe alternative. Do not fake successful completion or silently drop a feature.

## 20. Required final Codex report

Deliver:

1. **Feature matrix** — every upstream feature and its final Ignis status; identify existing vs newly added vs limited/restricted.
2. **Implementation summary by feature family**, with frontend and backend paths changed.
3. **API contract** — new routes/operations and their request/response/errors and authorization rules.
4. **Security and data-loss protections**, especially hunk changes, checkout, discard, remote handling and automation.
5. **Local verification** — commands actually run, passed/failed/skipped tests and lint/typecheck/build results. Be explicit about anything not run.
6. **Regression results** for Pull, Stage, Commit, Conflict/Merge and Push.
7. **Config/migration/deployment notes** and commands for *the user's* eventual real Ignis deployment/integration validation (do not execute those tests yourself).
8. **Known limitations / intentionally disabled commands** and reasons.
9. **Follow-up proposals** only for features that cannot safely be implemented in the current architecture.

## Reference links (review current checked-out sources)

- [Upstream README and feature overview](https://github.com/Vinzent03/obsidian-git)
- [Upstream `GitManager` contract](https://github.com/Vinzent03/obsidian-git/blob/master/src/gitManager/gitManager.ts)
- [Upstream desktop Git implementation](https://github.com/Vinzent03/obsidian-git/blob/master/src/gitManager/simpleGit.ts)
- [Upstream Git actions](https://github.com/Vinzent03/obsidian-git/blob/master/src/gitActions.ts)
- [Upstream command registry](https://github.com/Vinzent03/obsidian-git/blob/master/src/commands.ts)
- [Upstream automatic routines](https://github.com/Vinzent03/obsidian-git/blob/master/src/automaticsManager.ts)
- [Upstream settings](https://github.com/Vinzent03/obsidian-git/blob/master/src/setting/settings.ts)
- [Upstream feature documentation](https://github.com/Vinzent03/obsidian-git/blob/master/docs/Features.md)
- [Ignis project](https://github.com/Nystik-gh/ignis)

**Final direction:** Extend Obsidian Git on Ignis toward *feature parity*, not a separate synchronization product. Audit first; keep existing working features; implement every safe, relevant remaining feature via the established browser→`IgnisGitManager`→`/integrations/ignis/obsidian-git` path; provide and **run local tests**, leaving production and real Ignis integration tests to the user.
