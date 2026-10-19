# TASK — Implement Commit Functionality on Ignis

**Read `GOAL.md` first.** The Pull and Staging phases have already been implemented. **Implement this Commit phase only** and extend the existing integration; do not rebuild Pull/Staging or implement Push, Commit-and-sync, or unattended Git scheduling.

> **Execution constraint:** Generate meaningful automated tests and document exactly how to run them, but **do not run tests locally**. The user will execute them manually on the deployment server. Do not claim any tests passed, and do not present unexecuted checks as verified.

## 1. Context and desired result

This project contains a fork of Obsidian Git that is integrated with the Ignis platform. It selects `IgnisGitManager` in the browser-hosted [Ignis](./ignis) platform. `IgnisGitManager` sends typed HTTP requests to an existing server integration at **`/integrations/ignis/obsidian-git`**, whose architecture follows Ignis's `headless-sync` integration. The server owns native Git execution against the user's selected, authorized vault.

Both **Pull** and **Stage/Unstage** already exist. **Preserve their code, behavior, routes, security boundary, repository locks, and status reporting.** Reuse the same HTTP transport, authentication, vault resolution, backend Git executor, error envelope, and frontend event/queue conventions. Do not create a duplicate service or a second server integration just because upstream Ignis has a different plugin directory layout.

**Result:** In Ignis's existing Obsidian Git Source Control view, a user can type a message and commit the intended changes. Browser commands delegate through `IgnisGitManager`; native Git runs on the Ignis server; actual commits are created in the current vault's repository; staged/unstaged state, HEAD and UI refresh accurately; no Pull or Push is implicitly performed.

### Distinguish the two mandatory commit modes

1. **Commit staged**: Commit **exactly the currently staged index snapshot**. Leave unstaged edits, new untracked files, and other unselected work untouched. If a file has staged content plus newer unstaged edits, the commit contains only the staged version.
2. **Stage all and commit**: Stage all *eligible, authorized* changes, then commit in one serialized server-side operation. Include new files, modifications and deletions under the currently supported vault scope. Do not stage ignored files or `git_conflict.md`.

Also preserve the plugin's **Smart Commit** mode: if staged changes exist, commit staged changes; if none exist, only fall back to stage-all-and-commit when the existing `autoStageOnEmptyIndex` setting permits it. Otherwise report *nothing staged* without creating a commit. Read authoritative Git state on the server inside the lock before choosing/performing the operation; do not trust a browser-supplied status snapshot.

The UI must distinguish these modes. Never relabel “Commit all” as “Commit staged,” or silently commit unstaged changes via the staged-only path. UI in general must stay the same as in the existing Obsidian Git plugin.

## 2. Precisely in scope

Implement end to end:

- `IgnisGitManager.commit({ message, amend? })` for **staged-only** commits.
- `IgnisGitManager.commitAll({ message, status?, unstagedFiles?, amend? })` for **stage-all-then-commit**, respecting the existing abstract method signature and the current vault scope.
- Standard **Smart Commit** behavior through `GitActions`, with the existing setting controlling fallback.
- Existing Source Control commit textarea, primary Commit button, Commit dropdown's **Commit staged** and **Stage all and commit**, and relevant command-palette actions with their current message semantics.
- Valid manual commit messages, including multiline messages and supported existing template tokens, formatted **exactly once**.
- Git author/committer identity and actual HEAD/commit-object creation in the trusted server repository.
- Correct number of committed files (or the current `GitManager` return contract), accurate success/no-op/error UI, refreshed staged/changed lists, latest commit and outgoing-commit indicators.
- Explicit **Amend staged** only if it can be implemented safely under the policy in §7. If that policy is not feasible with existing architecture, leave Amend staged explicitly unsupported in Ignis, with a clear notice and a documented reason. Do not weaken the safeguards to obtain a green UI state.
- Generate automated tests for both frontend and backend, including real temporary Git repositories. **Do not execute them locally.**

### Strictly out of scope

- Push, Commit-and-sync, automatic Pull/Push after Commit, fetch, remote/branch changes, force-push, reset, rebase, cherry-pick, merge-conflict resolution, clone/init, and cleanup of untracked files.
- Background/automatic commits, timers, systemd, cron, browser-triggered periodic workflows and the eventual 60-minute commit/pull / 300-minute push schedule. **Manual Commit only in this task.**
- Commit-message **scripts** executed from a browser or server; these remain unsupported on Ignis. Do not introduce a generic process-execution endpoint.
- GPG/SSH commit signing, user-configurable server hooks, submodule commits, editing past commits beyond the specifically guarded Amend staged case, interactive/hunk staging, discard/revert, commit-by-file without respecting the established index.
- Reworking previously implemented Pull or Staging, or changing desktop/mobile behavior. Fix only demonstrated integration issues needed for Commit.

## 3. Inspect the actual local fork before editing

The user's **current local fork** is authoritative. Public upstream code is useful for contracts but may have changed, while Pull/Staging may have added new files and utilities.

### Frontend paths / call sites

Inspect at minimum (adapt paths if different):

- `src/gitManager/gitManager.ts` — abstract `commit`, `commitAll`, `formatCommitMessage`, `getStagedForMessage`, Git operation lifecycle.
- `src/gitManager/ignisGit.ts` and its actual transport/error/capability helpers.
- `src/gitManager/simpleGit.ts` and `isomorphicGit.ts` — expected return semantics, not an instruction to invoke native Git in the browser.
- `src/gitActions.ts` — `commit()`, `performCommit()`, `resolveCommitMode()`, message modal/template logic, `reportCommitResult()`, error handling and any `instanceof SimpleGit` behavior.
- `src/commands.ts` — `commit`, `commit-specified-message`, `commit-smart`, `commit-smart-specified-message`, `commit-staged`, `commit-staged-specified-message`, `commit-amend-staged-specified-message`, and names of any other commit commands.
- `src/ui/sourceControl/sourceControl.svelte` — message field, primary Commit action, menu actions, busy state, tooltips, `triggerRefresh()`, staged status and unpushed count.
- `src/automaticsManager.ts`, relevant settings and existing “future feature” guards, to ensure manual Commit is enabled without accidentally enabling automation or Commit-and-sync.
- `src/types.ts` — `CommitOptions`, `CommitMode`, `CommitResult`, `Status`, and `GitOperation` as they exist **now**.

Reference from upstream: `GitManager.commit({message, amend?}): Promise<number>` and `commitAll({message, status?, unstagedFiles?, amend?}): Promise<number>`; `GitActions.performCommit()` routes staged-only versus all through these methods. **Retain current local signatures if they differ.**

### Server paths / call sites

Inspect **`/integrations/ignis/obsidian-git`** and locate:

- Existing registration, route conventions and HTTP request/response contracts.
- Pull and Staging handlers, Git subprocess abstraction, request validation, command timeouts and max output sizes.
- Auth/session and CSRF/origin protections; vault ID-to-root resolution and authorization.
- The **existing per-repository lock** shared by Pull and Staging, plus any locking for status.
- Identity/UID/GID handling, Git environment configuration and local commit author policy.
- Staging scope, `limitToVault`, `basePath`, ignore rules, handling of `git_conflict.md`, and any existing merge/unmerged state checks.
- Test infrastructure and fixture pattern; docs and deployment config.

**First deliverable:** A concise investigation note in the PR/task report that identifies actual frontend command paths, `IgnisGitManager` stubs, existing API prefix, backend Git executor, lock, error schema, and unresolved design constraints. **Do not stop there; implement the changes.**

## 4. Frontend: enable commit methods through IgnisGitManager

Implement the two existing manager operations with their current interfaces:

```typescript
commit(options: { message: string; amend?: boolean }): Promise<number>;
commitAll(options: {
  message: string;
  status?: Status;
  unstagedFiles?: UnstagedFile[];
  amend?: boolean;
}): Promise<number>;
```

The frontend must:

1. Use the **existing same-origin, authenticated HTTP client** and active vault identifier, not `spawn`, `simple-git`, local `fs`, or a new arbitrary command bridge.
2. Call explicit, allowlisted commit endpoint(s) with a typed body including **commit mode**, final message and explicit amend flag (when supported). Do not send arbitrary CLI flags, local paths, repository location or server identity.
3. Invoke `formatCommitMessage` **once** at the proper layer (follow existing Obsidian Git semantics). This may substitute `{{date}}`, `{{numFiles}}`, `{{files}}`, `{{hostname}}` and affected-file body text; check real implementation, respect existing configured date/message formats, and avoid browser Node hostname calls. Do not recursively expand template text or format again on the server.
4. Preserve **newline characters**, punctuation, Unicode and leading-hyphen text in commit messages; show a clear error for an empty/whitespace-only final message. Do not silently replace with a default.
5. Preserve existing custom-message modal behavior, cancellation handling, Source Control textarea, queue, `withGitOperation(GitOperation.commit, ...)` lifecycle, and notices. Do not clear the typed message on failure/cancel; clear/reset it only after confirmed success when the current plugin UX does so.
6. Map backend success to the existing `Promise<number>` API and `GitActions`' `CommitResult` expectations. Number of committed files must be **actual** (including a correct result for an initial commit), not an arbitrary `1` or `status.changed.length`.
7. Surface “nothing to commit” as an ordinary no-op/no-commit result, not an invented successful commit. Ensure frontend `performCommit()` correctly distinguishes this from a real commit.
8. Refresh `obsidian-git:head-change`, `obsidian-git:refresh`, cached status, Source Control list, last-commit time and unpushed-commit count as appropriate, only after the backend confirms HEAD changed. Restore idle/loading state on failures and cancellations.
9. Remove only **Commit-related** future-feature stubs/notices. Leave Push, Commit-and-sync, raw commands, history editing, and other unsupported features unavailable with the expected notice.
10. Test all entry points, including Source Control buttons/menu (which can call different action paths) and command palette. Avoid duplicating the commit workflow inside a new UI.

### Smart Commit and commitAll

Existing upstream `resolveCommitMode()` behaves conceptually as follows:

```text
mode = staged  -> commit staged if nonempty; otherwise no-op
mode = all     -> stage allowed changes and commit
mode = smart   -> staged changes? commit staged
                  : autoStageOnEmptyIndex enabled? stage all and commit
                  : no-op
```

Maintain this behavior in Ignis, while rechecking authoritative status under the server lock. In particular, a stale browser snapshot must not cause the server to commit an unexpected change or falsely say it committed.

For `commitAll()`, **do not implement it in the browser as a separate Stage all HTTP call followed by Commit HTTP call**. That introduces a race between those requests. Instead send one `commit-all` action and perform stage+commit within **one server-side repository lock**.

If the existing `GitActions` layer uses cached status/`unstagedFiles` to decide whether to offer a button, treat those values as UI hints only, never as authoritative server authorization or an exact file list.

### Proposed HTTP contract (illustrative only)

Follow the existing Pull/Staging namespace and error envelope. For example:

```http
POST /api/ext/obsidian-git/commit
Content-Type: application/json

{
  "vaultId": "<active-vault-id>",
  "mode": "staged",
  "message": "Update project notes",
  "amend": false
}
```

```http
POST /api/ext/obsidian-git/commit
Content-Type: application/json

{
  "vaultId": "<active-vault-id>",
  "mode": "all",
  "message": "Update project notes",
  "amend": false
}
```

Example success payload (adapt to existing wrapper):

```json
{
  "status": "committed",
  "commit": {
    "hash": "<full new HEAD hash>",
    "shortHash": "<short hash>",
    "files": 3,
    "branch": "main"
  }
}
```

Example no-op payload:

```json
{ "status": "nothing-to-commit", "reason": "nothing-staged" }
```

Never return HTTP success with a fake `committed` result if native Git failed. Design a specific frontend conversion that fits the current manager's numeric return type while retaining the no-op distinction at the `GitActions` layer.

## 5. Server: extend `/integrations/ignis/obsidian-git`

Implement or extend **allowlisted commit handler(s)** in the already-deployed integration. Do not create new routes elsewhere or port the integration to another architecture. Reuse its authentication, vault lookup, per-repository lock, Git executor, logging and error normalization.

### Server validation, inside the repository lock

- Authorize the requesting session for exactly the selected vault, resolve its trusted repository root and validate that it is a valid repository.
- Do not accept an arbitrary filesystem path, shell, binary, Git option list, commit author, committer email, hook path or environment variables from the browser.
- Verify no unresolved merge/rebase/cherry-pick/revert, no unmerged index entries, and no other repository state in which an ordinary commit could accidentally complete a merge or manipulate history. **For this phase, refuse such commits with an actionable error**, even when conflicts appear to have been resolved in the index.
- Validate `mode` against exact supported values; validate `amend` as a boolean; reject unsupported combinations; never infer amend from a commit message.
- Validate final message type/length, reject empty/whitespace-only and excessively large input (choose and document a reasonable bound, e.g. 16 KiB UTF-8). Preserve newlines and Unicode. No shell interpolation.
- Ensure repo scope matches the authorized vault. If the repo is outside/above the vault or `basePath`/`limitToVault` would allow other owners' files, **explicitly reject unsupported layouts**. Avoid silently committing staged changes outside the authorized scope.
- Exclude `git_conflict.md` consistently with Pull/Staging; refuse commit if it is tracked/staged and must be protected. Do not remove, overwrite or automatically mark it resolved.
- Check actual index state **after** any allowed stage-all operation and immediately before native commit. Handle repository with no staged changes without creating an empty commit.
- Run Git under the configured non-root vault-owning identity; fix no ownership recursively during request processing.
- Enforce one lock for Pull, Stage/Unstage and Commit so concurrent operations on a repo cannot interleave; operations on different vaults can proceed independently.

### Native Git semantics

**Staged-only (`commit`)**:

```text
Check staged index state -> ensure nonempty ->
create commit from current index snapshot -> leave unstaged/untracked data untouched
```

Illustrative command: `git commit -F -` (message supplied over stdin). The backend should use a native `spawn("git", argv, { cwd: trustedRepo, shell: false, ... })` helper or existing equivalent. Pass the message as stdin rather than concatenating a shell command. For **staged-only**, do not call `git add` first. Do not use `git commit -a`.

**Stage-all-and-commit (`commitAll`)**:

```text
Acquire repository lock -> validate auth/scoping ->
git add -A within the allowed vault scope -> check staged delta ->
git commit -F - -> verify new HEAD -> respond
```

Use the same proven stage-all semantics developed in the Staging task, including deleted files, ignored files, symlinks, `.gitignore`, scoped vault subtree and pathspec safety. Do not stage files outside the vault or staged conflict reports. If unrelated outside-vault entries are already staged, **reject rather than commit them**; do not discard or unstage them automatically.

**Git identity:** The commit must be attributed to a clearly configured, server-side Git author/committer. Reuse the deployment's trusted repository-local `user.name` and `user.email` or established server config. Report missing identity clearly; do not silently invent a browser user's email or accept arbitrary identity fields from the client. Document how to configure identity in Docker.

**Hooks and signing:** Do not let a browser-triggered commit execute arbitrary unreviewed server hook scripts or interactive GPG signing. For the MVP, explicitly disable/reject hook execution and interactive signing in the server Git invocation (or prove deployment hooks are intentionally trusted and controlled). Document the policy. Git must not block indefinitely prompting for an editor, passphrase or signing input. Set noninteractive execution behavior, timeout and bounded stdout/stderr.

**Commit verification:** Under the lock, capture previous `HEAD` (allow unborn branch), run the operation, capture current `HEAD`, and confirm a genuinely new commit object was created with the expected index changes. Report the actual full hash, branch/detached status, and correct count of files changed. Handle an initial commit, additions, deletions, renames and binary files; consider `git diff-tree --root --no-commit-id --name-only -r -z HEAD` or equivalent to count distinct changed paths correctly. Never use a fabricated count or stale UI status.

**Failure semantics:** A native commit can fail after `commitAll` has staged files. **Do not reset/stash/discard the index to “roll back”**. Return a clear failure indicating that changes may remain staged; include a fresh status where practical. If the backend times out after Git successfully created a commit, avoid blindly retrying a potentially non-idempotent operation: verify HEAD/status and report an *outcome uncertain* state when necessary.

No fetch/pull/push, remote modification, reset, merge or rebase may be performed as part of committing.

## 6. Commit-message behavior

Preserve existing Obsidian Git message UX:

- The Source Control commit textarea passes its typed message to `GitActions` and then `IgnisGitManager`.
- Command-palette actions that request a custom message continue to open the existing modal; cancellation makes no API call.
- Existing default commit-message templates and replacements should work as they do on desktop for supported tokens. For `{{numFiles}}`/`{{files}}`, use the **intended commit scope** (staged-only versus stage-all) and document any limitation where browser status is stale or files lie outside the allowed vault.
- Don't execute `commitMessageScript` in the browser or server. If this setting is configured on the MacBook and synchronized to Ignis, show a specific unsupported-setting notice or use the supported non-script template path according to current UI patterns; never invoke shell scripts.
- Reject whitespace-only messages after formatting. Permit multiline messages without losing body content, preserve UTF-8, and do not permit a leading hyphen in the message to become a CLI option.
- Avoid accidental double formatting: `formatCommitMessage` should not run once in `GitActions`, again in `IgnisGitManager`, and again in the server.
- No commit-message text, credentials or sensitive file contents should appear in verbose server logs by default.

## 7. Amend staged: explicit safety policy

Upstream has an **Amend staged** action and `commit({ message, amend: true })`. Because amend rewrites history, it requires safeguards.

Preferred implementation, **only if existing infrastructure supports a reliable guard**:

1. Only a deliberate **Amend staged** UI/command action may set `amend: true`.
2. Allow only staged-only amend; reject `commitAll + amend` for this phase.
3. Require existing `HEAD`, an attached branch, a nonempty staged index and no unfinished Git operation.
4. Reject amending a commit already contained in any known remote-tracking branch, or when publication state cannot be assessed safely. Do not fetch solely to determine publication state as part of commit. Clearly note that remote-tracking references may be stale.
5. Never force-push or implicitly push an amended commit. Use the new HEAD hash/updated count to refresh the UI.
6. Where a safe check cannot be made, **leave Amend staged unsupported** in Ignis with an explanatory future-feature notice and test that it does not mutate history.

Prefer a secure, explicitly unavailable Amend over accidentally rewriting a pushed commit. Whether enabled or deferred, document the current behavior; do not silently ignore `amend: true` and create a normal commit.

## 8. Edge cases and correctness requirements

- **No staged changes:** staged-only returns a true no-op with no new HEAD; stage-all may stage eligible changes, otherwise no-op. No empty commits.
- **Partially staged file:** staged-only commit records the index version, not newer unstaged bytes; remaining edits stay in the working tree and the Changes list.
- **Untracked files:** staged-only never includes them; stage-all respects ignore rules and vault scoping.
- **Staged deletion/rename:** commit includes correct index tree without deleting unrelated files.
- **Initial/unborn branch:** allow first normal commit if appropriate; do not depend on `HEAD^` existing.
- **Detached HEAD:** choose explicit safe policy (prefer refuse with an actionable warning for Ignis) instead of silently committing onto a detached tip.
- **Active merge or unresolved conflict:** refuse (see §5) and preserve the prior `git_conflict.md` behavior; Commit does not resolve conflicts automatically.
- **Commit report file:** refuse to commit a tracked/staged `git_conflict.md`; never overwrite/delete it.
- **Two simultaneous browser tabs:** serialize using the shared backend lock. Duplicate action must not silently create two identical commits.
- **Stage/commit race:** single-lock `commitAll` ensures atomic sequence with respect to other integration operations. Detect and document any unrelated external processes editing the worktree during a commit; do not promise full filesystem isolation without one.
- **Unsaved editor buffer:** establish whether Ignis has flushed note edits before stage-all; explicitly save/wait or document that commit uses persisted bytes. Never tell the user their unsaved note has been committed.
- **Concurrent existing file change:** a file edited after staging should remain unstaged after staged-only commit, and status should reflect that.
- **No network:** committing is local and must not depend on GitHub, an SSH key, or upstream availability (unless the deliberate amend safety policy requires publication information, in which case fail safely).
- **Large/binary file:** follow existing size protections and explain when a commit is blocked; do not use browser-side status as authoritative authorization.
- **Credentials/environment:** repo owner can write `.git/objects`, `.git/refs`, `.git/index`; missing config/signing requirements return actionable errors, never partially rewritten history.

## 9. Response types, errors, and notices

Prefer existing Pull/Staging typed result/error envelopes. Introduce only the minimum new stable codes, for example:

- `NOTHING_TO_COMMIT`
- `INVALID_COMMIT_MESSAGE`
- `GIT_IDENTITY_MISSING`
- `UNMERGED_INDEX`
- `GIT_OPERATION_IN_PROGRESS`
- `DETACHED_HEAD`
- `OUTSIDE_VAULT_STAGED`
- `CONFLICT_REPORT_STAGED`
- `AMEND_UNSUPPORTED` / `AMEND_PUBLISHED_COMMIT`
- `GIT_OPERATION_BUSY`
- `REPOSITORY_NOT_FOUND`
- `NOT_AUTHORIZED`
- `GIT_COMMIT_FAILED`
- `GIT_COMMIT_OUTCOME_UNCERTAIN`

Reuse existing naming where available; don't invent two error dialects. Send precise user-friendly messages, not raw process stack traces, absolute server paths, tokens, or SSH secrets. A successful commit notice can show shortened hash and actual number of changed files, but **only** after verifying the server result. An uncommitted/no-op result must not say “Committed 0 files” as success.

## 10. Tests to generate — **do not run locally**

**Write real test files**, fixtures/helpers and a short `TESTING_commit.md` (or an appropriate existing testing-documentation section) with prerequisites and exact commands for the user to run on the deployment server. Follow the current repository's test runner and structure. **Do not invoke tests, `npm test`, `pnpm test`, pytest, coverage, or test containers locally.** Do not claim pass/fail results. Static review and preparing test commands are sufficient; if a build/typecheck is not executed, state this clearly too.

### Frontend tests (mock existing Ignis API)

1. `commit({message})` sends active vault ID, exact formatted message, `mode: staged`, and no arbitrary Git flags/paths.
2. `commitAll({message,...})` sends `mode: all` as **one** request, not `stageAll()` then `commit()`.
3. The manager maps success to the expected count/result and no-op to the correct `GitActions` state.
4. The correct mode is chosen for `smart` with staged changes, with empty index + `autoStageOnEmptyIndex=true`, and with that setting disabled.
5. Custom message modal submits once; cancelling submits nothing. The Source Control textarea preserves multiline UTF-8 and leading-hyphen content.
6. Message templates are formatted exactly once; no `spawn()`/commit-message script runs in Ignis.
7. Success triggers expected HEAD/status refresh, clears busy state, updates outgoing count; error preserves message and staged state and clears busy state.
8. Source Control main Commit button, dropdown Commit staged/Stage all and commit, and supported command-palette commit actions all hit the new manager methods.
9. Push, Commit-and-sync, scheduled automatic commits and unsupported Amend (if deferred) still show the existing future-feature notice and send no backend mutation request.
10. Desktop and mobile selections, and their existing commit paths, remain unchanged.

### Server integration tests using temporary repositories (no real vault or GitHub)

1. Initial commit on unborn branch with a staged file: real commit hash, correct author, count and clean index.
2. Commit staged new/modified/deleted/renamed/binary files; compare commit tree and actual changed-file count.
3. Stage one file and leave another unstaged/untracked: staged-only commits only the selected index snapshot.
4. Stage part of a file, modify it again, commit staged: committed blob equals staged blob and newer edits remain unstaged.
5. Commit-all stages eligible untracked, changed and deleted paths; respects `.gitignore` and scope; does not stage `git_conflict.md`.
6. No staged delta: no commit/HEAD movement; return no-op with correct code.
7. Smart Commit with an empty/nonempty index respects the setting and creates exactly one expected commit or no-op.
8. Multiline/Unicode/whitespace/leading-`-`/very long commit messages: correct preservation or validation; no argument injection.
9. Missing Git user identity, permission errors, no writable `.git`, disabled hooks/signing, Git timeout: clear errors; no fabricated success.
10. Simulated failure after commit-all staging preserves index/working-tree data and reports staged state.
11. Merge/rebase/cherry-pick/revert/unmerged index: ordinary commits refused; no automatic completion of in-progress Git operation.
12. Detached HEAD and outside-authorized-vault staged changes: fail according to documented policy.
13. A tracked or staged `git_conflict.md` cannot be committed; existing conflict report is preserved.
14. Confirm no fetch, pull, push, remote change, hard reset, stash, file deletion or forced update occurs during Commit.
15. Commit after Pull and after Staging still functions; previous routes and status checks remain compatible.
16. Concurrent commits from two tabs and concurrent Commit/Stage/Pull serialize using the same lock; no double-commit.
17. Cross-vault attempts, invalid vault IDs, unauthenticated requests, CSRF/origin failures, unsupported mode/flags all rejected before Git execution.
18. Verify actual commit graph and index with `git rev-parse HEAD`, `git cat-file -p`, `git show --format= --name-status -z`, `git diff --cached`, `git status --porcelain=v1 -z`, and `git ls-files --stage` or equivalents; **do not assert only on HTTP responses**.
19. Amend staged: if implemented, verify refusal for published/unknown refs and successful explicit local-only amend with correct HEAD parent; if unsupported, verify request fails safely without history changes.
20. End-to-end (where existing harness allows): interact with Source Control message input and Commit; verify the resulting commit and refreshed view.

All tests must create their own temporary local repositories and identities; never access the deployment vault, production remotes or actual deploy keys. Test hooks should use harmless fixtures and should not execute unreviewed commands.

### Test-delivery report

State **“Tests generated but not executed (as requested)”**, list created test files and exact manual server commands and required environment. If tests require provisioning mocks or Docker fixtures, explain how to start and clean them up. Do not state that acceptance criteria passed without evidence.

## 11. Implementation steps for Codex

1. **Inspect** `GOAL.md`, current local Git integration, existing stage/pull routes, GitManager methods, commit action/UI entry points and test conventions; record findings.
2. **Server first:** extend `/integrations/ignis/obsidian-git` with allowlisted, authenticated, vault-scoped commit endpoint(s), single-lock stage+commit, identity validation, native Git execution, outcome verification, structured no-op/errors.
3. **Frontend:** implement `IgnisGitManager.commit` and `commitAll`, connect to existing transport, preserve message formatting, queue and operation lifecycle.
4. **Commands/UI:** enable manual commit modes and explicit staged/all menus; preserve the Smart Commit setting, notices and Source Control refresh. Keep Push/Commit-and-sync/automatics unsupported.
5. **Safety:** enforce the policy on `git_conflict.md`, out-of-scope staged paths, unfinished operations, hooks/signing, and deliberate amend behavior.
6. **Tests:** **write** frontend/server/repository tests and manual execution guide; **do not run them locally**.
7. **Docs:** document endpoints, supported commit modes, author configuration, deployment requirements, scope, safety decisions and errors. Avoid unrelated refactoring.
8. **Report:** provide a concise list of modified files, feature behavior, tests generated (not run), installation/reload steps and known limitations.

## 12. Definition of done (implementation, not local execution)

- [ ] `IgnisGitManager.commit` and `commitAll` use the existing browser-to-server transport and correctly implement staged/all modes.
- [ ] Smart Commit chooses the right mode according to staged state and `autoStageOnEmptyIndex`.
- [ ] The existing `/integrations/ignis/obsidian-git` routes execute commits on the authorized vault through native Git, with the shared repository lock.
- [ ] Staged-only commits preserve unstaged/untracked data; commit-all stages eligible authorized files as one serialized operation.
- [ ] Commit message, author/committer identity, correct changed-file count and actual HEAD hash are handled correctly.
- [ ] Command palette, Source Control message field/buttons/menu and notices are wired to the working operations.
- [ ] UI status, HEAD state, staged/changed lists and unpushed count refresh correctly; busy states always clear.
- [ ] Ordinary no-op, invalid message, blocked operation and native Git failures cannot appear as success.
- [ ] Merge/rebase/conflict report and vault-scope safeguards are enforced; no remote operation is performed.
- [ ] Amend is either safely implemented per §7 or explicitly unavailable with a tested notice; it is never silently downgraded to a normal commit.
- [ ] Existing Pull and Staging functionality, and desktop/mobile behavior, are preserved.
- [ ] Automated frontend/backend/integration tests are **created** and manual deployment-server test commands are documented.
- [ ] **Tests are intentionally not run locally**; the final report explicitly states verification remains pending on the deployment server.

## 13. Final Codex report

Provide:

1. **Discovery:** What the existing Pull/Staging frontend/backend already did and exactly how Commit reuses it.
2. **Frontend changes:** Manager methods, UI/command-palette paths, message processing and refresh behavior.
3. **Backend changes:** Files under `/integrations/ignis/obsidian-git`, endpoints, validation, identity policy, locks, Git invocation and response semantics.
4. **Commit modes:** Staged-only, all, Smart, and supported/deferred amend behavior.
5. **Safety:** What prevents cross-vault commits, accidental inclusion of unstaged/out-of-scope files, hooks/script execution and history rewriting.
6. **Tests:** Files added and manual run instructions, explicitly **not executed locally**.
7. **Deployment:** Exact steps to rebuild/reload the modified Obsidian Git fork and server integration, and configure `user.name`/`user.email` on the server.
8. **Limitations:** Remaining unsupported features and any unverified assumptions.
9. **Next phase:** Push integration, **not** part of this change.

**Implement this phase in the available workspace; do not stop at a plan. Generate tests but do not run them locally. If a dependent repository or server integration is unavailable, say exactly what could not be changed and never claim verification that did not occur.**
