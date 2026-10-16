# Codex Task: Implement IgnisGitManager for Obsidian Git — Pull-Only MVP

## 1. Objective

Extend the open-source **Obsidian Git** plugin to support running inside **Ignis**, the browser-based Obsidian environment.

Repositories:

- Obsidian Git: https://github.com/Vinzent03/obsidian-git
- Ignis: https://github.com/Nystik-gh/ignis

**Implement the functionality, not just a design or proof of concept.**

Create a new Git backend named `IgnisGitManager`, selected automatically when Obsidian Git runs inside Ignis.

Unlike the existing desktop `SimpleGit` manager, `IgnisGitManager` must communicate with an HTTP API hosted by the Ignis backend. The server will execute native Git operations against the vault directory.

### MVP scope

Only the following functionality must work:

1. Detect that Obsidian Git is running inside Ignis.
2. Select `IgnisGitManager`.
3. Check that the Git repository exists and is accessible.
4. Retrieve the necessary read-only Git state.
5. Execute **Pull** through the Ignis server.
6. Display accurate pull results and errors inside Obsidian.
7. Detect blocked pulls and conflicts without losing local changes.
8. Create `git_conflict.md` in the vault when a pull is blocked by a repository conflict or unsafe local changes.

**All other Git commands are out of scope.**

They should remain visible where practical, but instead of executing they must display an Obsidian notice:

> This Git feature is not available in Ignis yet. It will be implemented in a future version.

No placeholder method may silently succeed or accidentally execute a Git write operation.

The existing macOS, Windows, Linux, iOS, and Android implementations must remain unchanged in behavior.

---

## 2. Repository inspection — required before editing

Inspect the current checked-out code, treating it as authoritative if it differs from the references below.

### Obsidian Git

Review at least:

- `src/main.ts`
- `src/gitManager/gitManager.ts`
- `src/gitManager/simpleGit.ts`
- `src/gitManager/isomorphicGit.ts`
- `src/gitActions.ts`
- `src/commands.ts`
- `src/automaticsManager.ts`
- `src/types.ts`
- `src/setting/settings.ts`
- `src/ui/sourceControl/`
- `src/ui/statusBar/`
- `src/editor/`

Trace initialization, manager selection, requirements checking, branch detection, pull orchestration, status updates, and error handling.

Pay particular attention to code that directly uses `SimpleGit`, checks `instanceof SimpleGit`, or calls Node.js APIs outside the selected Git manager.

### Ignis

Review at least:

- `docs/ARCHITECTURE.md`
- `packages/shim/src/loader.js`
- `packages/shim/src/ignis-api.js`
- `apps/ignis-server/server/plugins/`
- `apps/ignis-server/server/plugins/headless-sync/`
- Server plugin registration and route mounting
- Vault ID resolution and filesystem access
- Existing authentication and security infrastructure
- Filesystem watchers and vault refresh/reconciliation
- Dockerfile and Docker Compose examples

Determine how a server-side Ignis plugin is registered, enabled for a vault, and exposed through the HTTP API.

Do not assume that an example or previously documented API is unchanged.

### Inspection deliverable

Before substantial changes, document:

- Which initialization methods require Git operations.
- The minimum methods needed to execute Pull successfully.
- Which UI components call unsupported Git operations.
- Which additional methods are necessary to prevent plugin initialization or UI failures.
- How the browser will identify its active Ignis vault.
- How the server can safely map the vault ID to a filesystem path.

Proceed with implementation after this inspection.

---

## 3. Architecture

Target design:

```text
Desktop Obsidian
    |
    +-- Obsidian Git
          |
          +-- SimpleGit
                |
                +-- Native Git


Mobile Obsidian
    |
    +-- Obsidian Git
          |
          +-- IsomorphicGit


Ignis Browser
    |
    +-- Obsidian Git
          |
          +-- IgnisGitManager
                |
                | HTTP request
                v
          Ignis Server
                |
                +-- Server-side Git integration
                        |
                        +-- Native Git executable
                        |
                        +-- /vaults/<active-vault>
                        |
                        +-- SSH authentication to GitHub
```

The Ignis browser must never attempt to invoke native Git itself.

Native Git commands must run only on the server.

Do not implement a generic browser-to-server shell execution mechanism.

Do not modify Ignis's global `child_process` shim to permit arbitrary process execution.

Use a dedicated Git-specific API.

---

## 4. Runtime detection

Ignis currently initializes a global runtime identifier:

```javascript
window.__ignis = {
    version: ...,
    build: ...
};
```

Use this to identify Ignis.

Create a small helper, for example:

`src/platform/ignis.ts`

With functionality equivalent to:

```typescript
export function isIgnis(): boolean {
    return typeof window !== "undefined"
        && typeof window.__ignis?.version === "string";
}
```

Add the required TypeScript global declarations.

The exact implementation should be compatible with the existing TypeScript configuration.

### Important requirements

- Do not rely on `Platform.isDesktopApp` to detect Ignis.
- Do not use user-agent detection.
- Do not require a manual backend-selection setting.
- Do not introduce a shared vault setting that would cause the MacBook to select the Ignis backend.
- Detect the runtime independently each time the plugin initializes.

A single installed fork should work correctly on both a normal Obsidian installation and Ignis.

---

## 5. Git manager selection

In `src/main.ts`, locate the existing manager selection inside the plugin initialization flow.

Currently the manager is selected approximately as follows:

```typescript
if (this.useSimpleGit) {
    this.gitManager = new SimpleGit(this);
    await this.gitManager.setGitInstance();
} else {
    this.gitManager = new IsomorphicGit(this);
}
```

Extend it to:

```typescript
if (isIgnis()) {
    this.gitManager = new IgnisGitManager(this);
} else if (this.useSimpleGit) {
    this.gitManager = new SimpleGit(this);
    await this.gitManager.setGitInstance();
} else {
    this.gitManager = new IsomorphicGit(this);
}
```

Adjust the actual code to match the current repository.

### Constraints

- Desktop behavior must remain unchanged.
- Mobile behavior must remain unchanged.
- Do not initialize `SimpleGit` before detecting Ignis.
- Avoid executing native Git initialization or spawning processes during module loading.
- Investigate eager imports that might execute unsupported Node.js APIs even when `SimpleGit` is not instantiated.
- Keep the new implementation isolated from existing implementations.

If necessary, use conditional loading to avoid evaluating native-only functionality in Ignis.

Do not restructure unrelated parts of the plugin.

---

## 6. Implement IgnisGitManager

Create:

`src/gitManager/ignisGit.ts`

Export:

```typescript
export class IgnisGitManager extends GitManager
```

The class must extend the existing `GitManager` abstraction.

Do not invent a replacement interface.

Implement every abstract method required by the current TypeScript interface, but divide implementation into three categories.

### Category A — Working methods

These methods must return real data or perform the intended operation.

**`checkRequirements()`**

Call the Ignis backend.

Verify:

- The active vault exists.
- The repository is valid.
- The Git executable is available.
- The backend integration is enabled.
- The repository can be read.
- The repository path is authorized.

Return the existing `GitManager` result type.

Do not return `"valid"` without checking the backend.

**`pull()`**

Call the server-side Pull endpoint.

Use the existing `withGitOperation(GitOperation.pull, ...)` lifecycle when appropriate.

Return a valid `PullResult`.

**`branchInfo()`**

Return the actual current branch, upstream tracking branch, and local branch information.

This is important because `GitActions.isPullRemoteSet()` checks `branchInfo().tracking` before pulling.

**`status()`**

Return the existing `Status` structure.

Include real staged, changed, untracked, and conflicted file information.

If `limitToVault` or other path-related settings affect the response, implement their semantics correctly for the supported layout or explicitly disable unsupported combinations.

Do not return fake empty arrays when changes exist.

**`isMergeInProgress()`**

Query the actual Git state on the server.

**Read-only support methods**

Implement any additional read-only methods that initialization and basic pull-related UI require, such as:

- `getLastCommitTime()`
- `getUnpushedCommits()`
- `getConfig()`
- `getRemotes()`
- `getRemoteUrl()`

Only implement what is actually needed.

If a read-only feature is not supported, make the UI unavailable instead of returning misleading information.

### Category B — Unsupported methods

Methods unrelated to Pull must be implemented as safe stubs to satisfy the abstract TypeScript interface.

Examples include:

- `commit()`
- `commitAll()`
- `push()`
- `stage()`
- `stageAll()`
- `unstage()`
- `unstageAll()`
- `discard()`
- `discardAll()`
- `checkout()`
- `createBranch()`
- `deleteBranch()`
- `init()`
- `clone()`
- `setConfig()`
- `setRemote()`
- `removeRemote()`
- `updateUpstreamBranch()`
- `updateGitPath()`

Review the remaining abstract methods and classify them appropriately.

Centralize unsupported behavior rather than duplicating logic.

For example:

```typescript
private unsupported(feature: string): never {
    throw new IgnisUnsupportedGitFeatureError(feature);
}
```

Create a dedicated error class and a centralized UI handler that displays the future-feature notice.

Avoid presenting unsupported functionality as a fatal Git error.

**Do not return fake successful results, `true`, or `void` merely to make TypeScript compile.**

### Category C — Utility methods

Reuse inherited path translation and utility functionality where appropriate.

Avoid unnecessary overrides.

The manager must work with an Obsidian vault whose filesystem root corresponds to the server's Git repository root.

For the MVP, support:

```text
/vaults/Main/
    .git/
    .obsidian/
    Notes/
```

Nested or parent-directory repositories can remain unsupported, but must fail with an understandable error rather than operating on the wrong directory.

---

## 7. HTTP transport

Implement a reusable private request method in `IgnisGitManager`.

Conceptual interface:

```typescript
private async request<T>(
    endpoint: string,
    options?: RequestInit
): Promise<T>
```

Use same-origin HTTP requests.

Proposed API namespace:

```text
/api/ext/obsidian-git/
```

Suggested endpoints:

```http
GET /api/ext/obsidian-git/health?vaultId=...

GET /api/ext/obsidian-git/status?vaultId=...

POST /api/ext/obsidian-git/pull
Content-Type: application/json

{
  "vaultId": "Main"
}
```

These endpoints are proposals, not existing Ignis APIs.

Follow Ignis's established server-plugin conventions when implementing them.

### Vault identification

Ignis currently exposes `window.__currentVaultId`.

Investigate whether this remains the correct source of the active vault ID.

If so, use it.

Do not infer the vault solely from the browser URL when a canonical active-vault identifier exists.

Do not hardcode `Main`.

The backend must resolve the vault ID through Ignis's trusted vault configuration.

Never accept an absolute filesystem path from the browser.

### HTTP errors

Define a structured error format, for example:

```json
{
  "error": {
    "code": "PULL_BLOCKED_DIRTY",
    "message": "Local changes prevent a safe pull.",
    "reportFile": "git_conflict.md"
  }
}
```

Handle at least:

- Backend unavailable
- Unauthorized request
- Repository missing
- Git executable missing
- SSH authentication failure
- Network failure
- Missing upstream branch
- Dirty working tree
- Divergent branches
- Existing unresolved merge/rebase
- Filesystem permission errors
- Operation already running
- Unexpected server error

The browser should display meaningful Obsidian notices.

Do not expose stack traces, SSH credentials, environment secrets, or sensitive filesystem details.

Use a bounded request timeout and handle invalid/non-JSON responses.

---

## 8. Implement the Ignis server-side plugin

Create a new Ignis server plugin, following the existing plugin registration conventions.

Suggested location:

```text
apps/ignis-server/server/plugins/obsidian-git/
    index.js
    routes.js
    git-service.js
```

Adapt the file structure to the current Ignis architecture.

The plugin should:

1. Register with the Ignis server plugin system.
2. Expose its API routes.
3. Resolve active vaults through trusted server configuration.
4. Execute native Git operations on the server.
5. Return typed JSON responses.
6. Handle errors consistently.
7. Keep state isolated between vaults.
8. Avoid interfering with Ignis startup or other plugins.

Use `child_process.spawn()` or an appropriate existing Git execution library **on the server only**.

Server-side `spawn()` is allowed. Browser-side `spawn()` is not.

Always execute the Git binary with argument arrays and `shell: false`.

Do not pass user-controlled shell command strings.

### Authentication and security

This is a filesystem-mutating API and must not become an unauthenticated remote Git control endpoint.

Inspect Ignis's existing authentication and reverse-proxy assumptions.

Requirements:

- Use the deployment's authenticated session or equivalent access control.
- Require authorization for the selected vault.
- Protect mutation routes against cross-site request forgery.
- Reject untrusted origins as appropriate.
- Restrict operations to allowlisted endpoints.
- Do not accept arbitrary Git arguments.
- Do not accept arbitrary repository paths.
- Never send SSH private keys or access tokens to the browser.
- Prevent path traversal and symlink-based escape from the configured vault root.
- Do not expose this functionality until the access-control requirements are satisfied.

Use a dedicated environment flag if useful to explicitly enable the integration.

If Ignis has no applicable authentication mechanism, document and implement a secure deployment requirement rather than silently exposing an unrestricted mutation endpoint.

---

## 9. Implement native Git Pull

This is the primary functionality.

### Expected behavior

The browser sends a Pull request for the currently selected vault.

The server resolves the vault's Git repository and downloads remote changes.

If the remote branch can be applied safely, the server updates the local vault files.

The server returns information describing the result.

Obsidian Git then updates its UI and reports the result.

### Pull strategy

For this MVP, prioritize data safety over sophisticated Git functionality.

Use **fast-forward-only integration**.

Equivalent conceptual workflow:

```text
1. Validate repository
2. Validate current branch and upstream
3. Check for unfinished Git operations
4. Check working-tree safety
5. Fetch upstream
6. Compare local and remote commits
7. Apply a fast-forward update if possible
8. Collect changed files
9. Return structured result
```

Do not use a reset-based synchronization strategy.

Do not automatically commit local changes.

Do not automatically stash local changes.

Do not automatically rebase.

Do not automatically create merge commits.

Do not force operations.

For this MVP, it is acceptable to require a clean working tree before applying updates.

If local changes prevent safe application, stop and report the condition.

### Detailed behavior

**Repository up to date**

If local and remote commits are identical, return:

```typescript
{ status: "up-to-date" }
```

**Remote is ahead**

If the remote commit is a descendant of local `HEAD`, apply a safe fast-forward update.

Equivalent behavior:

```bash
git fetch
git merge --ff-only <configured-upstream>
```

Use the actual configured upstream.

Do not construct arbitrary Git revisions from untrusted browser input.

Return a valid `PullResult`:

```typescript
{
    status: "updated",
    files: [...],
    outsideVault: 0
}
```

Each file entry must match the existing `FileStatusResult` type.

Identify changed paths using the commit range between the old and new `HEAD`, handling filenames safely.

Do not report remote files as applied if the checkout/fast-forward failed.

**Local is ahead**

If local contains commits absent from the remote, do not reset them.

If the remote has no new commits, report that no working-tree update was needed.

**Branches diverged**

If both local and remote have unique commits, stop.

Do not merge or rebase automatically.

Create a conflict report.

**Dirty working tree**

If local modifications, staged changes or untracked-file collisions might be overwritten, do not apply the pull.

A conservative policy requiring a clean working tree is acceptable for this MVP.

Do not delete, reset, commit or stash local files.

Provide a useful error and conflict report.

**Unfinished Git operation**

If a merge, rebase, cherry-pick or other incompatible Git operation is already in progress, refuse to pull.

Do not attempt automatic recovery.

### No-upstream behavior

If the repository has no configured upstream branch:

- Do not guess `origin/main`.
- Do not automatically configure the upstream.
- Explain that an upstream is missing.
- Do not invoke an unsupported branch-management action.

Investigate the existing `GitActions.isPullRemoteSet()` behavior and adjust it for Ignis so it does not open an unsupported remote-branch selection workflow.

### File changes and UI refresh

After a successful pull:

- Return accurate changed-file information.
- Trigger the existing Obsidian Git refresh mechanisms.
- Ensure Ignis's filesystem watcher/cache reconciles the files modified by Git.
- Preserve compatibility with open notes.
- Ensure that Ignis does not continue serving stale cached content.
- Verify that refresh events do not overwrite unsaved in-browser edits.

Investigate whether Ignis automatically detects filesystem changes from server-side Git operations.

If it already does, reuse that mechanism.

If an explicit refresh is necessary, integrate with the existing vault refresh/reconciliation mechanism rather than inventing a second filesystem cache.

---

## 10. Conflict reporting

When a pull is blocked by diverged history, unresolved Git operations, or unsafe local changes, create:

```text
/vaults/<vaultId>/git_conflict.md
```

This is an existing user requirement and must be included in the MVP.

Example report:

```markdown
# Git Pull Conflict / Blocked Pull

**Detected:** 2026-10-14 12:00:00 UTC
**Vault:** Main
**Branch:** main
**Upstream:** origin/main

## Reason

The local and remote branches have diverged.

## Local repository state

- Local HEAD: <commit>
- Remote HEAD: <commit>
- Local changes: Yes/No
- Unmerged files: <count>

## Affected files

- Notes/Example.md
- Projects/Research.md

## Git status

<Human-readable status summary>

## Recommended resolution

The automatic pull was stopped to protect local work.

Review local changes and reconcile the repository manually
using an authorized Git environment.

No automatic reset, rebase, force push, or discard was performed.
```

### Report requirements

- Report must accurately describe the detected condition.
- Distinguish actual merge conflicts from dirty-tree or divergent-history blocks.
- Include affected files when they can be determined.
- Include local and upstream commit identifiers where available.
- Never expose credentials.
- Exclude `git_conflict.md` from Git tracking.
- Prefer repository-local `.git/info/exclude`, rather than changing the user's tracked `.gitignore`.
- Do not overwrite an existing tracked or user-owned `git_conflict.md`.
- Do not automatically delete an existing unresolved report.
- A successful pull should not silently mark an earlier conflict as resolved.

Return an appropriate structured error so Obsidian can display a notice directing the user to `git_conflict.md`.

Do not leave the repository with partial Git modifications.

For fast-forward-only operations, divergence should be detected before attempting an integration that could create conflicts.

---

## 11. Unsupported Git commands

This is a critical part of the task.

When Obsidian Git runs inside Ignis, every unsupported Git operation must show a notice rather than executing.

### Required notice

Use a consistent message:

> This Git feature is not available in Ignis yet. It will be implemented in a future version.

Optionally include the operation name:

> Git Push is not available in Ignis yet. It will be implemented in a future version.

### Command handling

Inspect all command registrations in `src/commands.ts`.

Preserve the functional Pull command.

For unsupported commands, use a centralized handler.

Example:

```typescript
function futureFeature(feature: string): void {
    new Notice(
        `Git ${feature} is not available in Ignis yet. ` +
        `It will be implemented in a future version.`
    );
}
```

Do not duplicate the same implementation across dozens of commands.

Consider a common command-registration helper or wrapper where appropriate.

### Important cases

Explicitly handle:

- Commit
- Commit-and-sync
- Push
- Fetch as a standalone command
- Stage/unstage
- Discard/reset
- Branch checkout/switching
- Branch creation/deletion
- Repository initialization
- Repository cloning
- Remote configuration
- Upstream configuration
- History
- Diff viewing
- Raw Git commands
- File-level and hunk-level Git actions
- Any destructive repository operation

For unsupported commands, do not open a form or modal that attempts a partially implemented operation.

Show the future-feature notice immediately.

### Source-control UI

Inspect the source-control view and any toolbar actions.

Buttons that would execute unsupported functionality must either:

1. Display the future-feature notice, or
2. Be clearly disabled with an explanation.

Do not leave buttons that throw exceptions or silently fail.

Preserve the Pull button and its functionality.

For this MVP, read-only status display is desirable if it can be implemented accurately.

Advanced history and diff panels may remain disabled.

### Direct API protection

Command-level interception is not sufficient.

Unsupported methods in `IgnisGitManager` must also refuse execution if called by:

- Another plugin
- A status-bar action
- An editor integration
- An automatic routine
- A source-control component
- Programmatic plugin code

No unsupported Git mutation may reach the backend.

---

## 12. Automatic routines

Review `src/automaticsManager.ts`.

Obsidian Git currently supports automatic commit/sync, pull, and push scheduling.

For Ignis:

- Disable automatic commits.
- Disable automatic pushes.
- Disable automatic commit-and-sync.
- Disable any file-change debounce that triggers commits.
- Allow the existing automatic Pull feature to operate through `IgnisGitManager`, if enabled.
- Allow Pull on startup if enabled.
- Preserve the regular desktop/mobile scheduling behavior.

Do not let settings synchronized from a MacBook accidentally activate unsupported write operations in Ignis.

If the user's settings contain commit or push intervals, ignore those intervals while running in Ignis and clearly indicate that those operations are unsupported.

For testing, ensure the automatic Pull interval can be configured to 60 minutes.

**Important:** Browser-based timers only run while Ignis is open and active. Do not claim they provide reliable server-side background synchronization.

Do not implement systemd, cron, or a new background scheduler in this task.

That will be a separate feature.

---

## 13. Preserve GitManager and GitActions integration

Prefer using Obsidian Git's existing command and action flow.

The current code includes approximately this chain:

```text
Command: Pull
    |
    v
GitActions.pullChangesFromRemote()
    |
    v
GitActions.pull()
    |
    v
Check upstream branch
    |
    v
GitManager.pull()
    |
    v
Display result
    |
    v
Refresh Git status
```

Make `IgnisGitManager` compatible with this flow.

Do not duplicate the whole pull workflow in a new Obsidian command unless necessary.

Preserve the plugin's existing:

- Promise queue
- Git operation state
- Progress/status handling where supported
- Notice display
- Error handling
- Pull result reporting
- Workspace events

The goal is to introduce another backend implementation, not a separate replacement Obsidian Git plugin.

### Error handling

Use existing error conventions where appropriate.

If introducing Ignis-specific errors, translate them at the appropriate boundary.

Do not let expected unsupported-operation errors appear as unhandled exceptions in the browser console.

Do not display misleading success messages.

---

## 14. Docker integration

The existing deployment uses Ignis in Docker with a persistent vault mount.

Assume a layout similar to:

```text
/opt/ignis/
    docker-compose.yaml
    vaults/
        Main/
            .git/
            .obsidian/
            Notes/
```

The server-side Git integration must operate on the same vault directory Ignis opens.

### Requirements

- Git must be installed in the server container that executes the commands.
- The SSH client must be available when using SSH remotes.
- Do not embed SSH private keys into Docker images.
- Support mounted Git credentials.
- Support running Git under the same UID/GID that owns the vault, using Ignis's `PUID`/`PGID` configuration.
- Avoid requiring `safe.directory '*'`.
- Do not recursively change ownership of the vault at every startup.
- Do not change Ignis's original entrypoint unnecessarily.
- Do not run Git as root when the vault is owned by the configured non-root user.

Existing deployment authentication uses a GitHub SSH deploy key with write access.

The MVP itself only needs Pull, but it should work with that authentication mechanism.

### Deliverables

Provide:

1. Required Dockerfile changes.
2. Required Docker Compose changes or overrides.
3. Environment-variable documentation.
4. SSH mount configuration.
5. Commands for building and starting the modified Ignis image.
6. Commands for installing the forked Obsidian Git plugin into a vault.
7. Commands for verifying Git availability and ownership.

Prefer maintaining Ignis's existing entrypoint and startup behavior.

---

## 15. Multiple vaults

Avoid hardcoding one repository.

If Ignis has multiple vaults:

```text
/vaults/
    Main/
    Work/
    Research/
```

The HTTP integration must operate only on the active, authorized vault.

Each vault has independent:

- Git repository
- Branch/upstream configuration
- Working tree
- Conflict report
- Synchronization state

Prevent concurrent conflicting operations on the same repository.

Operations on separate vaults should remain independent.

Use a per-repository lock or another reliable serialization mechanism.

If Git integration is disabled for a vault, reject operations for that vault.

Do not let a request for vault `Main` execute commands inside `Work`.

---

## 16. Testing requirements

Add automated tests for the new implementation.

Reuse the project's existing test framework and conventions.

### A. Platform detection tests

Verify:

- In normal desktop Obsidian, `SimpleGit` is selected.
- In normal mobile Obsidian, `IsomorphicGit` is selected.
- In Ignis, `IgnisGitManager` is selected.
- Ignis detection takes priority over `Platform.isDesktopApp`.
- No native Git process is spawned by the browser in Ignis.

### B. GitManager tests

Mock the server API.

Verify:

- `checkRequirements()` reflects real backend responses.
- `branchInfo()` returns correctly mapped branch information.
- `status()` returns correctly shaped data.
- `isMergeInProgress()` reports actual server state.
- `pull()` sends the correct request.
- `pull()` returns correctly typed results.
- Network errors produce meaningful notices.
- HTTP errors are translated consistently.
- Unsupported methods cannot mutate anything.

### C. Server integration tests

Use temporary local Git repositories.

Create:

```text
Temporary bare remote repository
        |
        +-- Test client clone
        |
        +-- Test server vault clone
```

Do not use a real GitHub repository for tests.

Cover:

1. Pull when remote and local are identical.
2. Pull one new Markdown file.
3. Pull a modification to an existing Markdown file.
4. Pull a deletion.
5. Pull multiple changed files.
6. Pull when local is ahead.
7. Pull when branches have diverged.
8. Pull with uncommitted local modifications.
9. Pull with staged changes.
10. Pull when untracked files collide with remote files.
11. Pull during an unfinished merge.
12. Pull without an upstream.
13. Pull with an invalid remote.
14. Pull when Git authentication/network access fails.
15. Pull with incorrect filesystem permissions.
16. Two simultaneous Pull requests against the same vault.
17. Attempted access to another vault.
18. Rejection of path traversal and unsafe repository inputs.

### D. Conflict report tests

Verify:

- `git_conflict.md` is created for relevant blocked/conflicting pulls.
- The report describes the correct reason.
- Local files remain unchanged.
- Local commits remain intact.
- No force reset occurs.
- Existing reports are not silently destroyed.
- The report is excluded from Git tracking.
- Secrets are not included in the report.

### E. Unsupported-command tests

Verify every relevant command in Ignis:

- Shows the future-feature notice.
- Does not send a mutation request to the server.
- Does not invoke native Git in the browser.
- Does not modify the vault.
- Does not crash the plugin.

Also verify that unsupported automatic routines do not run.

### F. Ignis UI tests

Verify manually or through existing browser test infrastructure:

- The plugin loads without a `child_process.spawn()` error.
- The plugin's Pull command is available.
- Pull works from the command palette.
- Pull works from an existing UI button, if present.
- Pulled notes become visible.
- Existing open notes refresh correctly.
- Up-to-date pulls display the correct message.
- Conflicts display a notice.
- The conflict report can be opened inside Obsidian.
- Unsupported actions display their notices.
- The plugin unloads and reloads without errors.

---

## 17. Code quality requirements

Follow existing code conventions in both projects.

Prefer small, focused modules.

Avoid unnecessary new dependencies.

Do not make unrelated refactors.

Use strong TypeScript typing for:

- HTTP requests
- HTTP responses
- Errors
- Git state
- Pull results
- Unsupported operations

Avoid `any` wherever practical.

Implement predictable error handling.

Validate all server inputs.

Keep security-sensitive code on the server.

Use bounded execution timeouts and output sizes for native Git.

Avoid starting duplicate Git operations.

Make sure exceptions release operation locks.

Ensure failed operations do not leave the UI indefinitely showing "Pulling".

Do not alter the vault's Git configuration unless necessary for the supported operation.

---

## 18. Documentation

Add a document such as:

`docs/ignis-integration.md`

It should explain:

### Architecture

- How Ignis is detected.
- How the new manager is selected.
- How HTTP requests reach the server.
- How Git runs on the server.
- How the active vault is resolved.

### Installation

- How to build the Obsidian Git fork.
- How to install its `main.js`, `manifest.json`, and any required styles into Ignis.
- How to add the server-side Ignis integration.
- How to build and start the Docker image.
- How to configure Git and SSH.
- How to verify API connectivity.

### Features

Clearly identify:

**Supported**

- Git repository detection
- Read-only repository state required by Pull
- Manual Pull
- Automatic Pull while the browser is active
- Conflict/block reporting

**Not yet supported**

- Commit
- Push
- Fetch as a standalone command
- Stage/unstage
- History/diff tools
- Branch management
- Clone/init
- Repository configuration
- Server-side unattended scheduling

### Troubleshooting

Include instructions for investigating:

- Plugin initialization failures
- Unsupported Node.js API errors
- API authentication failures
- Invalid repository
- Dubious ownership errors
- SSH authentication errors
- Missing upstream
- Dirty working tree
- Diverged branches
- Missing filesystem updates after Pull

---

## 19. Expected implementation structure

Use this as an initial guide, not a rigid requirement.

### Obsidian Git fork

```text
src/
    platform/
        ignis.ts

    gitManager/
        gitManager.ts
        simpleGit.ts
        isomorphicGit.ts
        ignisGit.ts
        ignisGitClient.ts

    main.ts
    gitActions.ts
    commands.ts
    automaticsManager.ts

tests/
    ...
```

Possible additional modules:

```text
src/
    gitManager/
        ignisGitErrors.ts

    platform/
        gitCapabilities.ts
```

Introduce a capability abstraction if that is the cleanest way to prevent unsupported UI and Git operations.

### Ignis fork

```text
apps/ignis-server/server/plugins/
    obsidian-git/
        index.js
        routes.js
        git-service.js
```

Potential additional modules:

```text
        errors.js
        repository-lock.js
        conflict-report.js
```

Keep the server code modular and testable.

---

## 20. Acceptance criteria

The implementation is complete only when all of the following are true:

- [ ] Obsidian Git loads in Ignis without `child_process.spawn()` errors.
- [ ] `IgnisGitManager` is automatically selected.
- [ ] Normal desktop and mobile Git managers still work.
- [ ] The browser makes HTTP requests instead of executing native Git.
- [ ] Native Git executes on the Ignis server.
- [ ] The active vault is identified correctly.
- [ ] Git requirements and branch information are retrieved successfully.
- [ ] The existing Pull command works.
- [ ] An up-to-date repository is reported correctly.
- [ ] New remote changes are applied safely.
- [ ] Pulled files become visible in Ignis.
- [ ] Unsafe pulls do not discard local changes.
- [ ] Divergence and conflict conditions are reported correctly.
- [ ] `git_conflict.md` is generated when required.
- [ ] Unsupported Git commands display a future-feature notice.
- [ ] Unsupported commands never mutate repository state.
- [ ] Commit and Push automatic routines do not execute in Ignis.
- [ ] No arbitrary shell-command API is exposed.
- [ ] Server-side vault authorization is enforced.
- [ ] Docker installation instructions are provided.
- [ ] Relevant automated tests pass.
- [ ] The plugin can be installed and used without manual code modifications after building.

---

## 21. Implementation priorities

Work in this order:

**Phase 1 — Investigation**

Map the existing architecture and required interfaces.

**Phase 2 — Backend**

Implement the Ignis server plugin, repository inspection endpoints, and safe pull operation.

Test with temporary Git repositories.

**Phase 3 — Browser manager**

Implement runtime detection, `IgnisGitManager`, HTTP transport, and the required read-only methods.

**Phase 4 — Plugin integration**

Make the existing Pull command functional.

Ensure initialization, status, error reporting, and filesystem refresh work.

**Phase 5 — Unsupported-feature handling**

Intercept unsupported commands, disable unsupported automatic routines, and remove accidental native process execution paths.

**Phase 6 — Testing and documentation**

Run checks, resolve failures, document deployment, and verify that normal Obsidian platforms have not regressed.

Complete all feasible phases rather than stopping after the investigation.

---

## 22. Final Codex report

When finished, provide a structured report covering:

1. **Summary:** What was implemented.
2. **Architecture:** How browser-to-server Git communication works.
3. **Files changed:** Grouped by repository.
4. **Supported functionality:** Exactly what works in Ignis.
5. **Unsupported functionality:** What is intentionally deferred.
6. **Security:** How vault authorization and command restrictions are enforced.
7. **Tests:** Commands executed, results, and any failures.
8. **Deployment:** Exact steps needed to run the modified versions.
9. **Known limitations:** Remaining compatibility issues.
10. **Next phase:** Recommended steps for adding Commit and Push later.

If the workspace contains only one of the two repositories, implement all possible changes in that checkout and clearly identify the missing repository-dependent work. Do not pretend that code in an inaccessible repository was modified.

Do not claim success without building and testing the relevant code.

## Final principle

**This is a pull-only integration of the existing Obsidian Git plugin, not a new Git synchronization application.**

Reuse the existing Obsidian Git architecture whenever possible.

Keep server-side Git execution narrowly scoped and secure.

Preserve desktop and mobile compatibility.

Avoid implementing Commit, Push, or other future functionality in this task.

The final user experience in Ignis should be:

- Open Obsidian Git.
- Click **Pull**.
- Receive remote changes safely.
- See an accurate success, up-to-date, or conflict message.
- Click any other Git operation and receive a clear notice that the feature is planned for a future version.
