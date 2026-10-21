# TASK — Implement Git Push on Ignis (Obsidian Git)

>Read `./GOAL.md` and `./structure.md` first, then the current local code and this task. Implement the Push phase end to end. Generate AND RUN locally executable tests that do not require a deployed Ignis/Obsidian environment. The user will perform deployment and real Ignis integration testing separately.
>
> **Authoritative implementation:** The working fork in this checkout, **not** upstream documentation. The existing Ignis-side server integration is at `/integrations/ignis/obsidian-git` and already supports Pull, Staging, Commit, and merge/conflict handling. **Extend it; do not replace it or create another Git service.**

The code for Ignis platform can be found in `./ignis` folder. Use it as a read-only, reference-only resource. No changes are permitted there.

## 1. Context and desired outcome

The long-term goal, defined in `GOAL.md`, is to run the existing Obsidian Git plugin naturally in Ignis while Git runs on the Ignis server. The first four implementation phases are reported complete:

1. Ignis runtime detection, `IgnisGitManager`, browser-to-server API, repository status, and Pull.
2. Stage/unstage files, directories, and all changes.
3. Commit staged changes, commit-all/Smart Commit, and existing commit UI flows.
4. Git diffs, pull-time merge conflicts, resolution, and merge lifecycle.

**This task adds Push only, using those established foundations.** A user working in Ignis should be able to use the **same Obsidian Git interface and commands they see in local desktop Obsidian**, especially the existing **Push** action, and publish already-committed changes to the repository's configured remote branch. Once its dependencies work, the existing **Commit-and-sync** command should compose the already-implemented Commit, Pull, and new Push operations, rather than require a different UI.

Do not build a second source-control view, custom push dialog, alternative plugin, separate sync process, or host-side scheduler. Do not change UI labels, commands, icons, or workflows merely because the Git implementation is remote. Adapt only Ignis-specific unsupported-feature gating and capability checks where necessary.

**Two mandatory implementation parts:**

- **Frontend** (Obsidian Git fork): enable `IgnisGitManager.push()` and needed push-readiness methods, send typed requests through the existing Ignis transport, integrate with the existing `GitActions`, command palette, Source Control view, settings and refresh/notice mechanisms.
- **Server** (`/integrations/ignis/obsidian-git`): add narrowly scoped push handling using native Git and the integration's existing routing, validation, vault resolution, execution, authentication, error handling, and per-repository locking.

## 2. Source references and required inspection

Begin by examining actual local sources and recent modifications before making changes. Do not assume that the public upstream or older task documents match this fork.

### Frontend — locate and trace

- `src/gitManager/gitManager.ts`: `push()`, `canPush()`, `getUnpushedCommits()`, `branchInfo()`, associated operation lifecycle.
- `src/gitManager/ignisGit.ts` and existing Ignis transport/client/error modules.
- `src/gitManager/simpleGit.ts`: reference implementation, push destination selection, `canPush`, push result and file-count semantics.
- `src/gitManager/isomorphicGit.ts`: identify only relevant compatibility constraints; do not modify mobile behavior.
- `src/gitActions.ts`: `push()`, `performPush()`, `reportPushResult()`, `isPushRemoteSet()`, `commitAndSync()`, existing Pull/Commit/conflict guards.
- `src/commands.ts`: **Push** and **Commit-and-sync** command paths; inspect stable IDs. In public upstream, the standalone Push command uses `id: "push2"` while `id: "push"` refers to Commit-and-sync; verify this in the fork and **do not accidentally swap them**.
- Source Control view, status bar, toolbar buttons, menu actions and any other entry points invoking Push.
- `src/automaticsManager.ts`, `src/setting/settings.ts`, `src/constants.ts`, `src/types.ts`: `autoPushInterval`, `differentIntervalCommitAndPush`, `disablePush`, `pullBeforePush`, `squashCommitsBeforePush`, update-submodules behavior, result types, readiness logic, timer behavior.
- Existing tests, mocks, helpers, package scripts, compiler/linter configuration and documented local workflows.

### Server — locate and trace

Inspect **all of `/integrations/ignis/obsidian-git`**, including:

- Extension lifecycle/registration and the active HTTP router.
- Existing Pull, staging, commit, diff and merge endpoints and request/response patterns.
- Auth/CSRF/origin checks, authorized vault ID → on-disk repository resolution.
- Git executable wrapper, subprocess timeout, environment and error normalization.
- Per-repository locking and interaction between Pull, staging, commit, conflict resolution and the new Push.
- Existing read-only status/branch/upstream/ahead-behind helper code.
- Git credential handling (SSH deploy key, HTTPS credential helper if supported) and Docker UID/GID assumptions.
- Existing server tests and any local fixtures.

**Write a short implementation note** (in task documentation or final report) listing the actual code paths, reusable helpers, currently disabled Push UI paths, and any compatibility differences from upstream. Then implement; do not stop at analysis.

### Current upstream references (verify against local fork)

- `GitManager.push(): Promise<PushResult>` and `canPush(): Promise<boolean>`.
- `PushResult` in `src/types.ts` currently includes `pushed` with `files: number | null`, `up-to-date`, `blocked` (no-branch/conflicts/merge-in-progress), and `skipped` (no-upstream/not-ready).
- `GitActions.performPush()` already checks upstream, conflicts and ongoing merges, then calls `gitManager.push()` and refreshes status.
- Upstream `SimpleGit` examines a configurable push target rather than assuming the upstream is always the effective push destination.

Avoid changing shared interfaces unless clearly required by the working fork. If the local `PushResult` differs, honor the local contract and update all relevant tests.

## 3. Scope and non-goals

### Required functionality

1. **Manual Push** from every already-existing Obsidian Git Push UI entry point and command.
2. Real `IgnisGitManager.push()` request/response handling and meaningful `canPush()` behavior.
3. Native, authenticated, vault-scoped, non-force **push of the intended current branch to its configured destination**.
4. Accurate no-op, success, rejection and error handling with the existing Obsidian Git notices and state refresh.
5. Safety checks for unresolved merges/conflicts, detached HEAD, missing/ambiguous push destination, permission/auth errors and remote-side divergence.
6. Integration of the existing **Commit-and-sync** flow through its existing code path when all constituent operations are supported, preserving current `disablePush`, `pullBeforePush` and related semantics.
7. Appropriate enablement of existing browser-session automatic Push (if the fork supports it and user settings enable it); avoid silently scheduling operations not requested by settings.
8. Unit, contract and local Git integration tests, **created and executed locally** without a running Ignis/Obsidian server or network Git provider.

### Explicitly out of scope

- Force-push, `--force-with-lease`, deleting remote branches, pushing arbitrary refspecs entered from the browser, force-updating tags, mass/mirror push, remote repository creation.
- Editing/creating remotes or upstream configuration, unless already supported and required to preserve existing UI; do not silently set or change upstream during Push.
- A new UI for choosing target repositories/branches.
- Browser-side `child_process`, shell bridging or access to SSH private keys.
- Modifying Pull, staging, commit or conflict algorithms except for small integration fixes needed for composing operations or accurate status.
- Introducing server-side cron, systemd timers, background workers, Docker startup sync, or **guaranteed unattended** 60-minute/300-minute scheduling. This will be a later task; browser timers are not reliable with closed/suspended tabs.
- Recursive submodule pushing and automatic squash-on-push, unless already proven safe and supported in this Ignis integration. Preserve desktop behavior; for Ignis clearly document or safely decline unsupported advanced options. Do not pretend those settings took effect.
- Running tests against the user's actual vault, real GitHub repository, deployed Ignis, or actual SSH key.

## 4. UI fidelity and command integration

**Keep Obsidian Git's UI as it is on local desktop Obsidian.** Reuse its existing Push command, source control actions, status indicators, notices, and settings. Avoid an extra "Ignis Push" button or parallel workflow.

- Find Ignis-only "future feature" stubs added in earlier phases. Remove/relax them **for Push only**, without enabling unrelated unsupported Git commands.
- Wire `IgnisGitManager.push()` into the existing `GitActions.push()` pathway, not directly into a brand-new UI action.
- Preserve existing promise queue, `withGitOperation(GitOperation.push, ...)` where applicable, loading/busy state, race prevention, notification conventions, log surfaces, and `obsidian-git:refresh` events.
- Ensure the command palette **Push** is distinct from **Commit-and-sync**, preserving exact command IDs and behavior from the actual fork.
- The Source Control view and toolbar should reflect real ahead/unpushed commit state after a successful Push. Do not display stale badge counts or a false success notice.
- Use existing error/notice handling to distinguish "no commits to push", "remote has changes; pull first", "no push target configured", "merge unresolved", network failure, authentication failure and other failures.
- Avoid duplicate user-visible error notices when both manager and action layer catch the same rejection. The UI must stop showing an in-progress push after failure or cancellation.
- **Do not auto-stage or auto-commit** when the user clicks the standalone Push command. Push publishes commits, not worktree/index changes.
- Honor `disablePush` semantics in composite/automatic operations. Inspect whether the manual Push command is intentionally allowed with that setting on desktop; match actual existing behavior and cover it with tests.
- Respect existing Pull/Commit/merge guard behavior. Never use a Push attempt to auto-abort, auto-resolve or auto-reset a merge.

### Existing Commit-and-sync

If the fork has a functioning desktop **Commit-and-sync** action, enable its Ignis path by composing **existing** Commit, Pull and Push logic. Do not reimplement those operations in the push endpoint.

- If commit fails or is skipped, do not proceed to Push as if successful.
- If configured Pull fails, is blocked, or has unresolved conflicts, **do not push** as part of Commit-and-sync.
- If a user-disabled Push setting is active, preserve existing "commit-only" behavior and notices.
- Do not treat a skipped/no-upstream Push as successful full synchronization.
- Keep existing commit message selection, Smart Commit, staged-only behavior and merge-resolution commit flow unchanged.
- Preserve optional `pullBeforePush` ordering, and avoid hidden Pull or Commit in a standalone Push operation.

### Automatic Push within an open browser

Inspect the existing timer implementation and settings behavior:

- If the fork provides auto-push and separate interval settings, allow them to invoke the new Push backend **only if those features are deliberately enabled** and their prerequisites are satisfied.
- Retain the existing local desktop settings/UI; do not create a new settings tab or force-enable browser timers.
- Prevent overlapping auto/manual Push and concurrent Pull/Commit/merge changes through the existing frontend queue **and** backend repository lock.
- Handle `canPush()`-driven no-op cases without unnecessary network writes; final server decision remains authoritative.
- Ensure disabled/paused routines stay disabled/paused and plugin unload cancels timers.
- Explain in documentation that open-browser timers are best-effort, not a server background scheduler. The long-term goal of 60-minute commit/pull and 300-minute push **without a browser open** is explicitly out of scope.

## 5. Frontend: `IgnisGitManager` and transport changes

Implement or complete the following against the **actual current** abstract manager interface:

- `push(): Promise<PushResult>`: call the existing authenticated same-origin Ignis transport with an authorized vault identifier, decode the typed response, integrate operation state, and return the same result type expected by desktop `GitActions`.
- `canPush(): Promise<boolean>`: rely on the server-side push-target/readiness helper (or a safe existing status endpoint) so that ahead state and a missing remote branch are correctly understood; do not hardcode `false` or assume upstream always equals push target.
- `getUnpushedCommits(): Promise<number>` and/or other read-only branch/status helpers **only where needed** for existing UI, counts, and auto-Push gating. Return truthful values, not fabricated zeros.
- Map server errors through **existing** Ignis error types and notice handling; do not expose internal filesystem paths, credentials or entire subprocess output to the user.
- Avoid redundant network requests or a second client transport class if the existing implementation can be extended cleanly.

An illustrative API (adapt to existing routing and contract):

```http
POST /api/ext/obsidian-git/push
Content-Type: application/json

{"vaultId":"<active authorized vault>"}
```

**Do not let the browser select a `remote`, refspec, executable, flags, working directory, private key or arbitrary CLI arguments.** Push destination comes from validated server-side Git configuration and allowed repository policy. If the existing API uses a different route or envelope, extend it consistently.

Illustrative successful transport responses (adapt to local types):

```json
{"status":"pushed","files":3}
```

```json
{"status":"up-to-date"}
```

```json
{"status":"blocked","reason":"merge-in-progress"}
```

The value of `files` is a **file-change count**, not the number of commits. If an accurate file count cannot be determined, return `null` where the existing `PushResult` permits it; never fabricate a number.

Use error responses for rejected/non-fast-forward remote updates, access denied, connection errors and unsupported push configurations, unless the existing typed result contract already has matching non-success variants. Do not disguise a failure as `{status:"pushed"}` or `{status:"up-to-date"}`.

## 6. Server: extend `/integrations/ignis/obsidian-git`

Add Push handling to the **existing** server integration. Follow its current plugin lifecycle, router, handler/service structure, response conventions, and security controls, modeled originally after Ignis's `headless-sync` plugin.

### 6.1 Request authorization and repository selection

- Authenticate request using existing Ignis-integrated authentication/session controls and validate origin/CSRF protection for the mutating endpoint.
- Resolve the **authorized vault ID** using the established trusted server resolver; do not use a supplied absolute filesystem path.
- Verify the existing vault is a recognized Git worktree and matches the intended configured root.
- Reject malformed bodies, unsupported fields, unexpected parameter types, unknown/unowned vault IDs, path traversal or symlink escape, and remote/refspec/flag injection.
- For these Push requests, **no filename/pathspec is required**. Do not design a generic argument or path API just for pushing.
- Acquire the existing **per-repository lock** across final state checks and the actual remote operation. Ensure cleanup of locks on every exit path.
- Use the vault-owning runtime user; do not globally disable Git safe-directory checks or require Git as root.

### 6.2 Push destination and Git configuration

Correct push destination selection is crucial. Do not assume `origin/main` is always the push target.

- Inspect the server repository's current branch; reject detached HEAD or unusable branch states.
- Identify the effective configured push destination, taking relevant Git behavior into account (`branch.<name>.pushRemote`, `remote.pushDefault`, upstream/tracking configuration, `push.default`, explicitly configured push refspecs) **without accepting a destination from the browser**.
- Prefer a safe, deterministic single-branch push of the current branch. When Git config would push multiple branches, tags or ambiguous destinations, either implement an explicitly validated safe policy or report a clear unsupported-configuration error; **never accidentally push extra refs**.
- Do not silently create a new upstream or change `branch.*`/`remote.*` configuration. If the destination branch does not exist yet but the configured target is unambiguous, permit ordinary first publication without force; report accurate status. Otherwise stop and explain the missing configuration.
- Reuse the already working Pull/upstream helper only if its semantics match Push. A Pull upstream is **not necessarily** Git's effective Push target.
- Validate remote protocol and any Git configuration that could cause unexpected command execution. Never accept `ext::`/remote helpers, arbitrary shell commands or user-controlled Git execution configuration through the API. Preserve approved existing SSH/HTTPS credentials server-side.
- Explicitly document limitations for uncommon configurations (mirror pushes, wildcards, custom remote push mappings, detached HEAD, bare repos, submodules, tags).

### 6.3 Preconditions and safe Push operation

Under the repository lock:

1. Verify Git/repository availability, branch, destination and authentication prerequisites.
2. Detect unresolved merge, rebase, cherry-pick, revert or unmerged index state. **Block Push** until the existing conflict-resolution workflow is finished; do not bypass it.
3. Determine whether the local branch has commits to publish; account for a new destination branch and stale tracking refs.
4. Reconcile any required read-only remote state to know whether the update is already published, can be fast-forwarded, or would be rejected. Do **not** modify or checkout local files.
5. Execute only a normal, **non-force**, single-target push with native Git. Use a trusted argument array, `shell: false`, timeout, output bounds, and safe environment. Never use `--force`, `--force-with-lease`, `--mirror`, remote deletion, `--all`, or an implicit multi-ref push.
6. Verify the reported outcome. Do not claim success merely because a background command started or because local tracking refs appear updated.
7. Return the existing `PushResult`/structured error contract, refresh post-push status and record useful sanitized server logs.

**Important:** Push publishes committed history only. Unstaged/untracked/staged-but-uncommitted changes must not be included or discarded. Such local changes **do not by themselves prohibit publishing already-existing commits** if repository state otherwise permits it. Tests must prove this distinction.

**Non-fast-forward behavior:** If another device advances the remote, the push must fail safely with an actionable "Pull/merge remote changes first" message. Do not automatically run Pull, merge, rebase, reset or retry with force from the standalone Push endpoint. The existing Pull+merge UI is responsible for resolving divergence.

**Remote race behavior:** The remote may change between preflight and Push. The native non-force push is authoritative and must safely reject a stale/non-fast-forward update. Classify the resulting error correctly.

**No-op behavior:** An already-published local HEAD should yield `{status:"up-to-date"}` (or the working fork's equivalent), even if there are uncommitted working-tree changes. Avoid a fake push success.

**Return count:** When supported by the existing Git manager semantics, compute the number of changed files over the published range, accounting for paths with spaces, newlines and non-ASCII bytes, and for renames/deletions. If accurate reporting is not feasible (especially a new destination branch), return `files: null`; do not count commits as files or parse newline-delimited filenames unsafely.

### 6.4 Git process security and errors

- Execute only specifically allowed operations with fixed Git subcommands and validated refs/remotes. Never expose a generic Git command endpoint or allow arbitrary shell strings.
- Limit operation duration and output sizes; kill or clean up hung child processes correctly and leave the lock available afterward.
- Preserve server-only SSH keys/tokens. No authentication secrets, credential-helper output, raw private key paths or sensitive environment variables may appear in client responses or log entries.
- Consider the dangers of repository-level Git config, remote helper URLs, and executable hooks in an untrusted vault; adopt existing safe server execution policy and explicitly guard Push. Do not run arbitrary repository-provided hooks or commands via an unsafe configuration.
- Reuse existing error classes/envelope. Distinguish: missing repository, no current branch, no usable push target, merge/conflict in progress, nothing to push, remote advanced/non-fast-forward, protected branch/permission denial, SSH/auth failure, DNS/network timeout, read-only filesystem, hook/server rejection, invalid config and server/internal error.
- Error messages must be actionable without revealing internal host paths or credentials.
- Network failure and non-fast-forward errors must not create `git_conflict.md` automatically: that file belongs to the existing Pull/merge-conflict workflow unless the integration already has a clearly defined reason to update it. Do not overwrite or clear existing reports.

### 6.5 Concurrent operations and idempotency

- Use the existing repo lock for **Push, Pull, staging, commit, merge start/resolve/abort**. Server operations must not overlap on one repository, even from separate browser tabs or independent automation requests.
- If another operation holds the lock, use the established waiting/queue policy or return the existing operation-in-progress response. Do not create two overlapping pushes.
- Repeated Push requests after success must be safe: once the remote matches local HEAD, the next request reports up-to-date.
- If the client times out or disconnects after a push is accepted, a retry must not rewrite history or push unwanted refs; explain the possibility of an uncertain outcome when verification cannot complete.
- Different authorized vault repositories may operate independently.

## 7. Integration with existing phases (regression contract)

### Pull

- Preserve current Pull semantics, including safe handling of dirty working trees, upstream, divergence and merge conflicts.
- A rejected Push should direct the user to the **existing** Pull/merge flow, not execute hidden merge recovery.
- Don't overwrite files as a side effect of Push.

### Staging

- Preserve index/worktree separation and all existing file/folder/all stage/unstage actions.
- Push cannot stage or unstage anything; the set of staged changes must be identical before and after Push.

### Commit

- Preserve staged-only, commit-all, Smart Commit, commit messages, amend rules and existing results.
- Push must not silently commit outstanding index changes.
- Compose with the existing Commit-and-sync action; if Commit/Pull fails, Push must not run.

### Conflicts and diffs

- Preserve the Conflicts section, diff results, merge-resolve controls, merge-completion commit behavior and `git_conflict.md` handling.
- Block when unresolved merge/index conflicts are present. Allow a normal Push **after** a merge is fully resolved and committed.
- Remote-side non-fast-forward rejection is not by itself a local merge conflict; don't mark files conflicted.

### Desktop/mobile

- Only modify Ignis-specific selection, capability gating and transport where possible.
- All unaffected `SimpleGit` and `IsomorphicGit` code paths and settings must behave exactly as before.

## 8. Local test requirements — GENERATE AND RUN

This instruction **differs from earlier task files**. For this phase, Codex must **write and execute** tests which can run in a normal development environment **without running Ignis, Obsidian, Docker, GitHub, or any live remote server**.

A local Git binary, Node.js, the repository's normal test runner and temporary filesystem directories **are allowed**. Use temporary bare Git repositories as stand-ins for remotes. Mock the Obsidian runtime and the HTTP transport for frontend tests; exercise pure server handlers/services directly or through an isolated local in-process test router as appropriate.

Tests must be deterministic, automated, isolated, and safe for repeated execution. Never reference real vault paths, `~/.ssh`, a personal home repository, or the user's actual remote.

### 8.1 Frontend unit/contract tests (mock HTTP and Obsidian APIs)

Generate and run tests verifying:

1. Ignis runtime selects `IgnisGitManager`; desktop/mobile manager selection is unchanged.
2. Manual Push uses the current real `GitActions`/command pathway and calls `IgnisGitManager.push()` once.
3. The standalone **Push** command and **Commit-and-sync** command remain correctly distinguished by command ID and semantics.
4. Source Control Push action calls the same existing pathway (test at the nearest feasible component/action boundary without a full Obsidian app).
5. Push request uses the existing API transport and authorized active vault ID, and contains no arbitrary remote/refspec/CLI args.
6. `PushResult` maps `pushed`, `up-to-date`, `blocked` and `skipped` correctly; `files: null` is preserved.
7. `canPush()` and pending-commit/read-only helpers reflect meaningful server state, including a new remote branch, ahead, behind and no configured destination.
8. No-op Push displays the established "No commits to push" result; success displays established Push notices; rejected Push gives actionable failure feedback, without duplicate notices.
9. Busy state and refresh are correctly released/updated after success, rejection, network error, timeout and cancellation.
10. Standalone Push never stages/commits/pulls automatically.
11. Composite Commit-and-sync respects `disablePush`, `pullBeforePush`, a blocked Pull, failed/skipped Commit, no-upstream, and Push success/failure.
12. Existing browser automatic Push settings/paused state follow the current code behavior; no extra timer is created; no unexpected Push after unload.
13. Ignis no longer displays a "future feature" notice for Push but still does for unrelated unsupported features.
14. Desktop/mobile `SimpleGit`/`IsomorphicGit` paths do not use the Ignis HTTP client.

### 8.2 Server/API validation and security tests

Using mocked Git execution or an isolated local test router, generate and run tests covering:

1. Valid authorized Push request; invalid/malformed body; extra forbidden destination fields.
2. Unauthenticated/unauthorized vault, inaccessible vault, wrong vault ID, demo/read-only restrictions where applicable.
3. CSRF/origin requirements for mutating endpoints.
4. Vault root/path traversal/symlink escape defenses.
5. Request cannot alter remote, branch refspec, force flag, Git executable, command, environment or SSH credential path.
6. Invalid or dangerous Git config/push destination (including multiple wildcard refs, `ext::` transport or shell-invoking helpers) is rejected or handled by the established safe policy.
7. Merge/rebase/conflicted index prevents execution.
8. Nonzero exit, timeout, killed process, network/auth rejection, protected remote branch and sanitized error mapping.
9. Per-repository lock holds through the remote operation; concurrent Push and Push/Pull/Commit do not overlap; locks release after all outcomes.
10. No user secrets or absolute host paths leak in error responses.

### 8.3 Real Git integration tests — temporary bare remote only

Create fixture helpers that initialize a **temporary bare remote** and one or two **temporary working clones** with local Git identity set inside the fixtures. Use only local file URLs or filesystem paths internally in this test harness; production remote-protocol policy may legitimately differ. Never connect to GitHub.

Generate and **run** tests covering at minimum:

1. Local branch ahead by one commit → remote branch advances successfully.
2. Local branch ahead by multiple commits → remote receives correct history, no squashing unless explicitly supported elsewhere.
3. Push again without new commits → up-to-date, no new ref update.
4. Local tracked edit/staged change/untracked file left uncommitted → previously committed history publishes, local worktree and index remain unchanged.
5. Detached HEAD → safe blocked result, remote unchanged.
6. No usable remote/upstream/push target → no accidental push to guessed `origin/main`.
7. Missing target branch with **unambiguous configured destination** → supported first publish, or clear documented unsupported error if policy intentionally disallows it.
8. Configured non-default branch name (`trunk` or `notes`) and non-default remote → correct remote/ref only.
9. Local and remote identical while worktree dirty → up-to-date, no worktree mutation.
10. Another clone advances remote → non-fast-forward rejection, no forced update, no local history changes.
11. Local and remote diverge → rejection and guidance to Pull/merge, but no automatic pull/merge/reset.
12. Merge in progress, or unmerged index entries → blocked before any network write.
13. Fully resolved merge committed → subsequent ordinary Push succeeds.
14. Simulated remote denial/rejection (bare repo hook or fixture permissions) → rejected, never reported as pushed.
15. Simulated transport failure/timeout (mocked subprocess or controlled local fixture) → bounded exit, meaningful error, no lock leak.
16. Simultaneous requests against same repository → serialized or rejected per existing lock semantics; no corrupted state.
17. Separate temporary repositories → do not mix refs/vault data; independent behavior where supported.
18. A push attempt never stages, commits, rewrites commits, deletes tags/branches, resets files, or modifies merge state.
19. File-count result, when supplied, matches published changed-file semantics (not number of commits); strange filenames and renames do not corrupt parsing.
20. Explicitly configured advanced/unsafe push modes (multi-ref, mirror, force) are rejected rather than executed implicitly.

Use correct cleanup in `finally`/test teardown, create no persistent external resources, and avoid sleeps/racy network assertions where possible.

### 8.4 Regression tests

Generate and **run** locally executable focused tests for previously working Pull, Staging, Commit and Conflicts services/transport at their existing unit/contract level. Reuse rather than duplicate current tests. If any of these depend on a deployed environment, **do not run that portion**; report it as deployment-only.

### 8.5 What to execute, and what not to execute

**Must run locally:**

- Push frontend and server unit/contract tests.
- Temporary-local-Git-repository integration tests.
- Relevant pre-existing local regression tests.
- Project typecheck, lint/build checks when provided and reasonably executable offline without full Ignis deployment.

**Must not run locally:**

- Real deployed Ignis + browser end-to-end tests.
- GitHub/real external remote operations.
- Real deploy-key or production vault tests.
- Docker deployment/restart or production permissions/credential tests.

Inspect package scripts and use the project's actual commands; do not invent `pnpm test` or any exact test command without verifying it exists. If tools/dependencies are missing, install from the repository's normal lockfile where possible, then run what can be run. Clearly distinguish tests that passed, tests that failed, and tests that could not execute due to environmental constraints. **Do not claim tests were run unless they actually ran.**

## 9. Suggested development sequence

1. Inspect source and record Push call path, result types, current gatekeeping and server integration points.
2. Add/extend server-side branch/push target readiness and typed Push endpoint under `/integrations/ignis/obsidian-git`.
3. Implement safe single-branch non-force Git Push with existing per-repository locks, credential usage, result normalization and error handling.
4. Add `IgnisGitManager.push()`, `canPush()` and supporting read-only client methods through existing HTTP transport.
5. Remove Ignis-only unsupported gating for Push; wire the established UI/command and composite Commit-and-sync flow without redesigning them.
6. Restore or confirm existing browser-session automatic Push setting behavior without adding a new scheduler.
7. Add unit, API/security, temporary-repo integration and relevant regression tests.
8. **Run all locally executable tests** and applicable typecheck/lint/build checks; fix failures; rerun until passing or report a genuine blocker.
9. Update project documentation to describe Push behavior, no-force safety, configured target requirements, browser timers, expected remote rejection errors and deployment validation.

Do not spend this phase refactoring unrelated commands or implementing later roadmap items.

## 10. Acceptance criteria

- [ ] Existing Obsidian Git **Push** command and Source Control controls work in Ignis without altered UI or new buttons.
- [ ] Existing **Commit-and-sync** action composes previously working Commit/Pull/new Push where permitted and preserves configuration semantics.
- [ ] `IgnisGitManager.push()` returns an accurate local `PushResult`; `canPush()` and UI state do not lie.
- [ ] The browser sends typed, authenticated, vault-scoped requests and never executes native Git.
- [ ] `/integrations/ignis/obsidian-git` handles Push; there is no duplicate server integration.
- [ ] The remote receives **only intended committed history on the configured target branch**; no force, reset, silent upstream change or extra ref push.
- [ ] Worktree, uncommitted changes and index are preserved across Push success, no-op and failure.
- [ ] Remote ahead/diverged and other rejections are handled safely with useful notices.
- [ ] Unresolved merges/conflicts block Push; resolved-and-committed merges can be pushed.
- [ ] Proper authorization, anti-CSRF/origin checks, command restrictions, vault isolation and repo locks are preserved.
- [ ] Correct notifications and refresh states are shown; no falsely successful results.
- [ ] Desktop and mobile plugin behavior remains unchanged.
- [ ] Locally runnable frontend, server and temporary-repo tests are **generated and run**, with actual results documented.
- [ ] No deployment, real Ignis-integration or actual GitHub tests are run locally.
- [ ] Documentation includes setup assumptions, configured target behavior, troubleshooting and deployment-only test steps.

## 11. Required final Codex report

Provide:

1. **Summary:** Functionality completed and any scoped limitations.
2. **Actual architecture/call path:** UI → GitActions → IgnisGitManager → existing Ignis integration → native Git → remote.
3. **Changes by file:** frontend and server separately; explain any shared type/interface changes.
4. **Push semantics:** Effective destination handling, first push, no-op, non-fast-forward rejection, merge/conflict guard, untouched index/worktree.
5. **UI fidelity:** Confirm same existing Obsidian Git buttons/command IDs/settings remain; describe any necessary Ignis-only gate removal.
6. **Security:** Vault authorization, mutation endpoint checks, subprocess restrictions, secret handling and per-repo locks.
7. **Tests actually run locally:** exact commands, number passed/failed/skipped and reason for any failures; include temp-repo coverage and typecheck/lint/build output summaries.
8. **Deployment-only checks for user:** concise manual checklist for Ignis/Docker, SSH deploy key, permissions, remote branch/protected branch and UI Push/Commit-and-sync (do not run them yourself).
9. **Known limitations:** Especially unusual Git push config, submodules, automatic browser scheduling or unavailable local test infrastructure.
10. **Future work:** Unattended scheduling and advanced Push features, without implementing them now.

Do not declare the task complete if the code has not been implemented or locally executable tests have not been attempted. Do not imply that passing local tests proves deployment compatibility.

## Final direction

**Implement Push as the next capability of the existing Obsidian Git ↔ Ignis integration.** Keep the original Obsidian Git UI and shared GitActions orchestration. Execute only narrowly authorized Git operations on the server, using the working integration at `/integrations/ignis/obsidian-git`. Preserve Pull, Staging, Commit and conflict handling. Generate **and run local tests**, leaving real Ignis/GitHub deployment and integration testing to the user.
