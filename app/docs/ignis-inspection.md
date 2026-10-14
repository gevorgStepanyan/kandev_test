# Ignis integration inspection

The checked-out Ignis tree is reference-only. Deployable server code will live in
`integrations/ignis/obsidian-git/`, outside that tree.

## Required plugin calls

`ObsidianGit.init()` chooses a manager, calls `checkRequirements()`, activates
editor features and status bars, then triggers refresh and HEAD events. Status
refresh calls `status()` and `isMergeInProgress()`; branch display calls
`branchInfo()`; the status bar reads `getLastCommitTime()` and
`getUnpushedCommits()`. Pull uses `GitActions.pullChangesFromRemote()` → `pull()` →
`isPullRemoteSet()` → manager `pull()`. The existing missing-upstream workflow
opens a configuration modal; Ignis needs an explanatory error instead.

The manager needs real requirements, status, branch/upstream, merge-state,
commit-time and unpushed-count data. Read-only config/remotes can be served from
a restricted repository-state response. History, snapshots and diffs are not
required and will refuse execution. Native blame, hunk patches and raw commands
are desktop-only. Ignis detection must override desktop identity before native
initialization, and desktop feature availability must exclude Ignis.

## Unsupported callers

Commands include direct adapter writes (`edit-gitignore`) and editor mutations
(hunk reset); manager stubs alone are insufficient. GitActions also performs
filesystem writes, repository deletion and workflow prompts before backend
calls. Commands and public workflow actions need early centralized guards.
Source-control rows use GitActions for mutations and Tools for diffs. History
mounts immediately call `log()`. View entry points need guarding. Automatics must
skip commit/sync/push setup, including edit debouncers, while retaining pull.
Settings must explain the runtime limits without changing shared settings.

## Ignis runtime and server

`packages/shim/src/loader.js` publishes `window.__ignis.version`.
`init.js` resolves the active vault and sets `window.__currentVaultId`;
`ignis-api.js` also exposes it through a live vault getter. Use the canonical
identifier, never a path supplied by the browser.

`server/plugin-system/discovery.js` loads CommonJS `plugins/<name>/index.js`.
The manager passes `{config, router, watcher, wss, getEnabledVaults, ...}` to
`register()`, mounts routes at `/api/ext/<pluginId>`, and persists per-vault
activation in `data/plugin-config.json`. Resolve IDs with `config.getVaultPath()`
and check `getEnabledVaults()`. Validate real paths against `config.vaultRoot`;
reject symlinked/outside vaults and external Git directories for this MVP.

Ignis has no built-in session authentication; this pilot targets the user's
single-user deployment. No new login system is needed. Restrict routes to an
explicit configured browser origin and require JSON plus a custom header for
mutations, preserving any deployment-wide access control.

## Filesystem reconciliation and deployment

Ignis's watcher publishes external disk changes to the shim's metadata/content
caches and Obsidian listeners. The public `/api/vault/refresh` endpoint reconciles
ignored paths too. Reuse it after pull/report creation rather than creating a
second cache. The write API exposes pending/failed write diagnostics; those
are not a complete unsaved-editor indicator. Conservatively refuse a pull while
editable Markdown panes are open or writes are pending/failed.

The Docker runtime installs neither Git nor SSH. Supply a derived image with
Git/OpenSSH and the server plugin, keeping Ignis's original entrypoint and
PUID/PGID handling. Credentials stay mounted on the server. No running browser
instance is available: automated checks and a documented deployment smoke test
will distinguish verified behavior from remaining live validation.
