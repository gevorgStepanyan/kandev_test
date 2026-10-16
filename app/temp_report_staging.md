# Staging phase progress report

This report compares the current workspace with `TASK_staging.md`. It records
implementation and verification separately. **The staging phase is partially
implemented and is not yet verified complete.** The user will run integration
tests on a separate server; live Ignis testing is deferred to that environment.

## 1. Architecture and discovery — done

- Read `GOAL.md`, `TASK_staging.md`, `structure.md`, and the existing integration
  inventory at `integrations/ignis/obsidian-git/done.md`.
- Inspected the shared manager contract, desktop/mobile staging implementations,
  Ignis manager/client, GitActions, commands, Source Control file/folder/toolbar
  actions, file context menus, status refresh, server routes/service, and relevant
  Ignis reference code.
- Added a discovery note to the working log in `TASK_staging.md` before editing.
- Extended the existing integration. No replacement HTTP service or browser-side
  native Git executor was introduced. The `ignis/` reference checkout was not edited.
- Existing architecture reused: same-origin HTTP client, active vault ID,
  structured errors, server vault resolution, root-only repository validation,
  bounded native Git executor, and shared per-repository lock.

## 2. Implemented frontend changes

| File | Work present |
| --- | --- |
| `src/gitManager/ignisGit.ts` | Replaced the four staging stubs with HTTP operations using the existing interface signatures. Single paths pass through `getRelativeRepoPath` once; directory paths retain existing repository-relative semantics. Cached `status` options are not sent or trusted. Responses must confirm `status: "updated"` and the requested operation. |
| `src/gitManager/ignisGitClient.ts` | Extended the existing POST client with optional `path`/`dir` payload fields, preserving vault ID, same-origin credentials, headers, timeout/cancellation, and error handling. |
| `src/platform/ignis.ts` | Allowed the existing `stage-current-file` and `unstage-current-file` command IDs; added typing for optional public `writes.listPending()`. Other unsupported commands remain guarded. |
| `src/gitActions.ts` | Allowed only staging/unstaging through the existing readiness/action boundary. Ignis manager methods own the refresh request, avoiding a duplicate successful-action refresh. Other file mutations retain their guards. |
| `src/ui/sourceControl/sourceControl.svelte` | Removed the Ignis toolbar staging blocks, added queue completion callbacks to clear loading on success/failure, clears Ignis loading on refresh completion, and updated the availability banner. |
| `tests/gitManager/ignisGit.test.ts` | Added HTTP/payload, confirmation, error, cache invalidation, refresh, write-safety, dual-status, and unsupported-workflow tests. |
| `tests/platform/ignis.test.ts` | Added checks that staging command IDs remain enabled while hunk staging remains blocked. |

Existing file rows, staged rows, tree folder actions, and file-explorer context
menus already call queued GitActions. They therefore reach the new implementation
without changes to their component files or `src/commands.ts`. This wiring was
reviewed in source; actual clicks in a running Ignis instance are not verified.
Direct manager calls also request refresh.

### Editor/write safety

Staging refuses editable Markdown source panes, reported pending writes, failed
writes, and a missing Ignis write-safety API. The notice instructs users to close
editable panes or switch to reading view and wait for saves. Unstaging is not
blocked by editing because it changes only the index.

The public Ignis loader exposes delayed write status, **not** a save/flush barrier
or the internal per-path write tracker. Consequently, staging explicitly
announces that it captures content currently saved on the server and that very
recent saves may not be included. It does not guarantee an atomic snapshot of
browser buffers, synchronize other tabs, or freeze external writers. This is the
last-persisted-content fallback allowed by the task, not a completed save barrier.

### Status and feedback

- Invalidates the manager's cached repository state before and after a mutation.
- Requests `obsidian-git:refresh` after a request settles, including ambiguous
  failures where the server might already have changed the index.
- Reuses the existing status publication and Source Control lists; no optimistic
  row reclassification or replacement status model was added.
- Returns success only after a valid server confirmation. Structured server
  failures propagate through existing error notices.
- Preserves the existing full `Status` transport and server porcelain parser,
  including dual staged/changed entries and zero outside-vault counts for the
  supported vault-root layout. Server status parsing itself was not rewritten.
- Toolbar completion and refresh-completion handlers clear loading. Full browser
  rendering, error recovery, and list/tree behavior remain to be exercised.

## 3. Implemented server changes

All changes are under the existing `integrations/ignis/obsidian-git/` directory:

| File | Work present |
| --- | --- |
| `routes.js` | Added four POST routes using existing middleware/error envelopes. Extended field validation so each route accepts only vault ID and its appropriate path/directory field; rejects array/non-object bodies. Pull still accepts only vault ID. |
| `git-service.js` | Added `validateIndexPath()` and `mutateIndex()`. Reuses `locked()`, vault/repository validation, authoritative status, and the bounded argument-array executor. Added sanitized `GIT_INDEX_LOCKED` error mapping. |
| `index.js` | Updated the plugin display name/description to mention Pull and staging; plugin ID and registration lifecycle remain unchanged. |

### API implemented

All paths below share `/api/ext/obsidian-git` and the existing
`X-Obsidian-Git: 1` header and JSON requirement.

| POST route | JSON body |
| --- | --- |
| `/stage` | `{ "vaultId": "Main", "path": "Notes/a.md" }` |
| `/unstage` | `{ "vaultId": "Main", "path": "Notes/a.md" }` |
| `/stage-all` | `{ "vaultId": "Main", "dir": "Notes" }`; omit `dir` for the vault |
| `/unstage-all` | `{ "vaultId": "Main", "dir": "Notes" }`; omit `dir` for the vault |

Success: `{ "status": "updated", "operation": "stage", "path": "Notes/a.md" }`.
Bulk operations use their route name as `operation`, echo `dir` when supplied,
and omit it otherwise. A valid no-op can also return `updated`. Responses do not
include a fresh Status; the existing client refresh reads actual state afterward.
Errors retain `{ "error": { "code", "message", "reportFile"? } }`.

### Index semantics implemented, awaiting repository verification

- Stage file/folder/all: `git add -A -- <scope>` with literal user paths.
- Unstage with HEAD: `git restore --staged -- <scope>`.
- Unstage before the first commit: `git rm --cached -r -f --ignore-unmatch --
  <scope>`; `--cached` preserves working files. No dedicated unborn-repository
  test has yet been added or run for this implementation.
- All-vault operations use `:/`; only vault-root repositories are accepted.
- Staged rename file actions include both old and new paths when unstaging;
  directory actions retain their subtree boundary. Rename behavior needs real
  repository tests, especially moves across directory boundaries.
- `git_conflict.md` is explicitly excluded from bulk operations; direct targeting
  is rejected. Existing report content is never written by the new handlers.
- Conflicted paths in the requested scope are blocked with `UNMERGED_PATH`.
- Paths are checked inside the shared lock. Rejects absolute/drive paths, empty
  paths/components, traversal, NUL, backslashes, and `.git` components.
- Uses Git index/status and filesystem directory checks to permit tracked
  deletions and deleted subtrees. Uses literal pathspecs and a `--` separator;
  ignore checking also disables pathspec interpretation.
- Ignores are respected; staging never uses force-add.
- Native index operations do not intentionally alter HEAD, remote refs, or
  working files. These invariants have not yet been proved by new server tests.

### Existing safety boundaries retained

- Root-only repositories; custom base paths/Git directories and parent/nested
  repository layouts remain unsupported.
- Existing validation rejects symlinks throughout the vault rather than adding
  support for staging symlink entries. This is a retained limitation relative
  to the broader task's symlink-entry requirement.
- Same per-repository lock and BUSY/409 behavior as Pull/status.
- Same origin/header/JSON checks and enabled-vault map as Pull. This deployment
  relies on existing external network/proxy access controls; origin validation
  is CSRF protection, **not** a new authenticated per-user authorization layer.
- Runs as the Ignis process user; deployment must choose the vault-owning UID/GID.
- Browser request cancellation uses the existing client AbortController. New
  handlers do not add server request-disconnect cancellation; an index operation
  may finish after the browser stops waiting.
- Pull strategy, reconciliation, and conflict-report generation were not rewritten.
  Index-only staging does not invoke vault filesystem reconciliation.

## 4. TASK_staging.md scope coverage

| Requirement | Current state |
| --- | --- |
| Stage one file | Implemented; payload unit tests pass; real index cases unverified. |
| Stage all | Implemented, including Git's deletion handling; unverified on server. |
| Stage directory | Implemented with literal subtree scope; source wiring reviewed. |
| Unstage one file | Implemented, including staged rename handling; server tests pending. |
| Unstage all | Implemented, including unborn fallback; server tests pending. |
| Unstage directory | Implemented with subtree scope; cross-directory rename cases pending. |
| Refresh full status | Implemented through existing events/cache invalidation; mocked dual-state test passes; live lists/counts pending. |
| Feedback/loading | Implemented; unit tests cover confirmation/errors; rendered UI behavior pending. |
| Regression safety | Desktop/mobile backend files untouched and unrelated Ignis guards retained; full regression suite is not green. |
| Server security/concurrency | Existing protections reused and path validation added; new staging-specific security/concurrency tests not added/run. |
| Browser save coordination | Last-persisted fallback and guards implemented; no save barrier available. |
| Documentation | Discovery log and this report added; integration README, integration guide, structure map, and implementation inventory still need updating. |

## 5. Checks actually observed

Commands were invoked via Corepack because `pnpm` was not initially on PATH.

| Command | Observed result |
| --- | --- |
| `corepack pnpm exec vitest run tests/gitManager/ignisGit.test.ts tests/platform/ignis.test.ts` | **Passed: 2 files, 24 tests.** Last focused run passed against the current staging test implementation. |
| `corepack pnpm run tsc` | **Passed** after removing the obsolete unsupported-stage test call. |
| `corepack pnpm run svelte` | **Passed: 0 errors, 0 warnings.** |
| `corepack pnpm run format` | **Passed** for the configured source/test scope. |
| `corepack pnpm run lint` | **Failed: 3 errors in `tests/gitManager/ignisGit.test.ts`**, detailed below. |
| `corepack pnpm exec vitest run` | **Failed/incomplete:** process/thread exhaustion (`EAGAIN`, resource temporarily unavailable); 4 failed files, 10 passed files, 86 failed and 102 passed tests, plus a worker error. Not a successful regression check. |
| `corepack pnpm exec vitest run --maxWorkers=1` | **Failed/incomplete:** retry still encountered process/resource failures; 5 failed files, 1 passed file, 69 failed and 48 passed tests, 9 errors. Other failures were also reported; they have not been isolated or proven unrelated to these changes. |
| `corepack pnpm run test:ignis-bundle` | **Did not build:** nested script could not find `pnpm` on PATH. A subsequent Corepack setup attempt stalled; no successful rebuild or smoke-test result was obtained. |
| New staging server integration tests/full Source Control UI test | **Not implemented/run.** User will perform separate-server integration verification. |

Outstanding lint errors in the staging tests:

1. `@typescript-eslint/require-await`: async fetch mock without `await`.
2. `@typescript-eslint/no-base-to-string`: `String(url)` for a fetch input union.
3. `@typescript-eslint/no-unsafe-return`: untyped `JSON.parse` in expected payload mapping.

A command intended to fix these was interrupted before applying the changes;
inspection confirms the original offending code remains. Do not report lint as
fixed. No new checks were launched for this documentation request.

The root `main.js` still has its earlier October 14 timestamp. It is not a verified
bundle of the staging changes. Build/reload is still required before deployment.

## 6. Remaining work / handoff

1. Fix the three test lint errors and rerun lint and formatting.
2. Obtain a successful production build and browser bundle smoke check with pnpm
   available to nested scripts. Resolve or isolate the broader regression failures
   in an environment with adequate process capacity.
3. Update `docs/ignis-integration.md`, integration `README.md`/`done.md`, and any
   architecture descriptions that still say pull-only or list staging unsupported.
4. Run the task's server index/security/concurrency cases and all six rendered
   Source Control actions on the user's test server. Include new/modified/deleted
   files, dual staged/unstaged edits, ignored/literal names, unborn branches,
   renames across directories, failed requests, and unchanged worktree/HEAD.
5. Confirm browser save notices and refresh/loading behavior in that deployment.
6. Review deployment security and retained symlink/layout limitations against the
   acceptance criteria before marking the staging phase complete.

For deployment, rebuild the browser plugin, install the resulting `main.js` with
its manifest/styles, copy the entire updated existing server integration directory
to its configured Ignis plugin mount, restart/recreate the server as appropriate,
and reload Obsidian Git. Detailed installation locations remain in the existing
integration README. Commit, Push, sync, hunk staging, discard, and other later
phases remain unsupported; they were not implemented here.

Workspace note: the existing `.gitignore` contains the unanchored pattern `ignis`,
which can also hide `integrations/ignis/` from ordinary Git change listings.
The server files above were edited on disk; ensure they are included in whatever
change-transfer/deployment process is used. The ignore rule was not changed.
