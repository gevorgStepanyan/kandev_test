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
- Operations targeting unresolved index entries fail with `UNMERGED_PATH`; native index-lock failures return `GIT_INDEX_LOCKED`. Index operations do not resolve conflicts or clear conflict reports.
- Successful operations, including valid no-ops, return `status: "updated"` and the operation/scope. They change the index without creating commits, updating HEAD, contacting remotes, or requesting vault filesystem reconciliation.

## Browser plugin

- Runtime detection selects `IgnisGitManager`, with same-origin HTTP transport, response validation, cached repository state, request timeouts, and cancellation on unload (`src/platform/ignis.ts`, `src/gitManager/ignisGit.ts`, and `src/gitManager/ignisGitClient.ts`).
- Manual and automatic Pull use the existing queued Git actions. Source Control, current-file commands, and file/folder context menus expose staging and unstaging; index requests invalidate cached state and request a status refresh.
- Pull and staging require the Ignis write-safety API, clean reported write state, and no editable Markdown source panes. Staging records content persisted on the server; the public Ignis API provides no save/flush barrier, so very recent saves may not be included. Unstaging does not require these browser-write restrictions.
- Unsupported commands, views, and manager operations display the future-feature notice. Push, sync, standalone Fetch, branch/repository/configuration mutations, history/diff views, hunk staging/patches, and discard remain unavailable; automatic commit/sync and Push are disabled.

## Manual Commit

- `POST /api/ext/obsidian-git/commit` supports staged, all and Smart modes using the existing resolver, validation, error envelope, bounded executor and repository lock. Stage-all and commit are one locked operation; Smart reads authoritative index state inside that lock.
- Commit refuses root/non-owner execution, missing local identity, detached HEAD, unfinished operations, unmerged entries, unsafe index layouts, tracked/staged conflict reports and changed blobs at least 100 MB. Hooks and signing are disabled. The server pins author/committer to trusted local configuration and verifies the resulting HEAD, tree and parent.
- Actual distinct changed-path counts include initial commits; rename endpoints count separately. Native failures leave data staged, and ambiguous outcomes never auto-retry. Commit contacts no remote.
- `IgnisGitManager.commit`, `commitAll` and Ignis-only `commitSmart` use the same transport; message templates run once, scripts fall back with a notice, and successful commits emit HEAD/status refreshes. No-op returns zero and a no-commit result. Source Control and the six existing manual palette commands are enabled; failures/cancellation/no-op preserve the textarea.
- Stage-all and Smart with fallback enabled retain the existing browser staging safety guard and persisted-content limitations. Staged-only records the index without claiming editor buffers are saved.
- Amend remains explicitly unsupported because publication cannot be reliably established from cached refs. Push, sync, automatic commits and schedules remain unavailable.
- The reference server exposes no session/per-user vault authorization API. Existing enabled-vault/origin checks require the deployment's authenticated, single-owner proxy boundary; they are not authentication themselves. See `COMMIT.md`.
- Frontend/handler/command and real-repository backend tests were generated but not executed locally as requested. `TESTING_commit.md` at the fork root lists exact manual commands; deployment acceptance remains pending.
