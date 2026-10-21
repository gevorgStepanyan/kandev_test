# Ignis Git integration

This fork detects `window.__ignis.version` before selecting a Git manager.
Desktop continues to use native `SimpleGit`; mobile continues to use
`IsomorphicGit`. Ignis uses `IgnisGitManager` and fixed same-origin JSON endpoints
under `/api/ext/obsidian-git/`. The canonical `window.__currentVaultId` identifies
the active vault. The browser never supplies a repository path or Git arguments.

The deployable CommonJS server plugin is in
`integrations/ignis/obsidian-git/`. The `ignis/` checkout is reference material and
has not been modified. Ignis discovers the installed plugin and gives it a
router, trusted vault configuration and enabled-vault list. The service checks
real filesystem paths and runs native Git with argument arrays, bounded
execution/output, no interactive prompts, no Git hooks and per-repository locks.
Successful pulls and new reports invoke Ignis's existing cache reconciliation,
including ignored files; its WebSocket watcher updates browser caches and vault
listeners. There is no second filesystem cache.

## Supported features and limits

Supported: repository requirements, status/branch/upstream/operation state,
last commit time, unpushed counts, manual/boot/automatic Pull, staging/unstaging,
manual Commit, staged/unstaged diffs, and explicit normal merge resolution.
Desktop/mobile continue using their existing backends. Ignis ignores shared
automatic commit/push settings; browser Pull timers are not an unattended server
scheduler and pause during unfinished Git operations.

Pull still fetches the actual upstream and fast-forwards only. Divergence now
offers **Merge incoming changes**, requiring explicit confirmation of the reviewed
OIDs and a clean worktree. A normal merge remains pending, with real Git index
stages preserved. Resolve text conflicts in the normal editor, save, switch to
reading view and **Mark resolved**; finish using the existing **Commit** flow.
During merges, every Commit mode uses only the intended staged set. Confirmed
Abort merge is conservative and blocks if tracked files or the index changed
after the merge began. It never substitutes a hard reset.

Diff View and read-only Split Diff View show server working-tree/index snapshots,
including deletions and renames. Binary/oversized files show explicit notices.
Complex conflicts and rebase/cherry-pick resolution require an authorized Git
environment. Push, sync, standalone Fetch, discard, clone/init, branch/remotes,
history/blame, arbitrary commands and interactive hunk operations remain
unavailable in Ignis.

The excluded `git_conflict.md` report appends diagnostic events to an unchanged
integration-owned report; tracked, edited and user-owned reports are preserved.
Its contents never determine whether a merge is active or resolved. Full API,
discovery, safety and recovery details are in
[CONFLICTS.md](../integrations/ignis/obsidian-git/CONFLICTS.md); local tests and a
disposable-vault deployment checklist are in
[TESTING_conflicts.md](../TESTING_conflicts.md).

Only repositories rooted at a real vault directory immediately under
`VAULT_ROOT` are supported. Leave base path and custom Git directory empty.
Parent/nested repos, linked worktrees, symlinks and submodules are rejected. The
pilot validates at most 100,000 filesystem entries and limits each Git command
to 60 seconds/8 MiB output. Browser requests have a 120-second timeout; if a
request times out, inspect repository state before retrying.

Before Pull, Merge, Abort merge or staging, save notes and **close editable Markdown panes or switch them to
reading view**. Pending/failed/retrying Ignis writes block these operations too. This conservative
rule avoids confusing disk state with unsaved editor buffers. Do not edit the
vault from other tabs or external programs during a Git mutation; the plugin's lock
serializes its own requests, not unrelated filesystem writers. Browser timers
are not an unattended server scheduler.

## Build and install

From the Obsidian Git repository, using Node >=24 and pnpm >=11:

```sh
pnpm install --frozen-lockfile
pnpm run all
pnpm run test:ignis-bundle
```

Copy `main.js`, `manifest.json` and `styles.css` to the server vault's
`.obsidian/plugins/obsidian-git/` directory, replacing the installed plugin
artifacts. Enable **Git** in Obsidian community plugins and reload the browser.
For example, with the server vault mounted locally:

```sh
mkdir -p /opt/ignis/vaults/Main/.obsidian/plugins/obsidian-git
cp main.js manifest.json styles.css /opt/ignis/vaults/Main/.obsidian/plugins/obsidian-git/
```

To add the server integration without modifying the Ignis checkout, build its
existing image and then this derived image. The base image's original entrypoint
is retained. Our layer adds Git/OpenSSH and copies the plugin to the discovery
directory; it adds no ownership-changing startup routine. The referenced
Ignis entrypoint itself currently performs recursive ownership checks/changes;
this fork does not change that existing behavior.

```sh
docker build -t ignis-base:pilot -f ignis/apps/ignis-server/Dockerfile ignis
```

Use `integrations/ignis/compose.yaml` as a standalone pilot example, or adapt its
image, environment and SSH mount to your existing service. It is not a required
replacement for your deployment configuration. In the shell running Compose:

```sh
export IGNIS_GIT_ORIGIN=https://obsidian.example.com
export IGNIS_VAULTS_DIR=/opt/ignis/vaults
export IGNIS_DATA_DIR=/opt/ignis/data
export IGNIS_SSH_DIR=/opt/ignis/ssh
export PUID=1000 PGID=1000
docker compose -f integrations/ignis/compose.yaml build
docker compose -f integrations/ignis/compose.yaml up -d
```

`IGNIS_GIT_ENABLED=false` disables routes globally; otherwise per-vault enablement applies. `IGNIS_GIT_ORIGIN` must be
exactly the browser origin (scheme, host and optional port, no trailing slash).
Set `IGNIS_BASE_IMAGE` if using another locally built base image. Existing
`VAULT_ROOT`, `PUID` and `PGID` determine the vault location and runtime owner.
Run Git as that runtime user; do not use `safe.directory '*'` or root as a workaround.

Mount `id_ed25519` and `known_hosts` read-only at `/run/ignis-ssh/`, owned/readable
by the runtime UID, with private-key permissions `0600`. Populate and verify
GitHub's host key using your trusted operator process. Keys remain on the
server, outside the image/browser/vault. `GIT_SSH_COMMAND` selects these files
with strict host checking and batch mode. Configure repository remotes, Git
identity and upstream outside the browser.

Enable **Obsidian Git (Pull, staging, Commit and conflicts)** for each applicable vault in Ignis's
server-plugin settings. On a stopped deployment, the equivalent persistent
`data/plugin-config.json` entry is:

```json
{ "obsidian-git": { "enabledVaults": ["Main"] } }
```

Preserve any existing plugin entries when editing that file. Plugin discovery
and per-vault enablement are required independently of enabling the Obsidian
community plugin.

This targets the stated single-user deployment. It introduces no login system.
Routes require the configured browser origin and a custom header; mutations
also require JSON. Cross-origin requests are rejected. Keep any existing
network/proxy access controls for Ignis; the origin check is CSRF protection,
not authentication for arbitrary HTTP clients.

## Verify and troubleshoot

Check inside the container as the configured UID/GID:

```sh
docker compose -f integrations/ignis/compose.yaml exec --user 1000:1000 ignis git --version
docker compose -f integrations/ignis/compose.yaml exec --user 1000:1000 ignis git -C /vaults/Main status
docker compose -f integrations/ignis/compose.yaml exec --user 1000:1000 ignis git -C /vaults/Main branch -vv
```

In the browser developer console on your Ignis origin, verify connectivity:

```js
await fetch(
    "/api/ext/obsidian-git/health?vaultId=" +
        encodeURIComponent(window.__currentVaultId),
    {
        headers: { "X-Obsidian-Git": "1" },
        credentials: "same-origin",
    }
).then((r) => r.json());
```

- Non-JSON/404/unavailable: install the server plugin, enable it for the active
  vault, check environment flags, then restart the server.
- 403: verify the exact browser origin, per-vault enablement and deployment
  access controls. Credentials for Git are server-side, not Ignis login fields.
- Missing Git or invalid layout: verify the container packages, `.git/` at the
  vault root and empty plugin base/custom Git paths.
- Dubious ownership/permission errors: check the mount owner and PUID/PGID;
  inspect Git as that user rather than suppressing ownership checks globally.
- SSH failure: verify mounted key permissions, known-hosts entries, remote URL
  and deploy-key access using the server runtime user.
- Missing upstream: set the intended upstream in an authorized Git environment;
  the pilot does not guess a remote branch.
- Dirty: save/preserve changes and allow writes to settle before retrying.
- Diverged: review and explicitly select Merge incoming changes.
- Unfinished merge: resolve/mark each path and Commit, or safely Abort merge.
  Rebase/cherry-pick resolution remains outside Ignis.
- Stale files: ensure the WebSocket is connected; use **Ignis: Refresh vault from
  disk**. A reconciliation failure after applied changes is reported as a
  refresh warning rather than a failed Git integration.
- Browser native-API errors: capture the stack and confirm the Ignis backend was
  selected. Native initialization, signs and line authoring remain excluded there;
  shared text-conflict editor controls are supported.

Use `pnpm run test:ignis-server` for server integration tests and
`pnpm run test:ignis-bundle` to build/check browser initialization with native
process APIs unavailable. In process-limited environments, run Vitest with
`RAYON_NUM_THREADS=2 pnpm exec vitest run --pool=threads --maxWorkers=1`.

Automated checks cover server operations with real temporary repositories and
browser transport/capability behavior with mocks. No running Ignis instance was
available during implementation; Docker and live Obsidian behavior still need
operator verification. Smoke-test up-to-date and changed remote branches, note
visibility after Pull, blocked local work, missing upstream and unsupported
buttons before adopting this pilot. Keep separate repositories for these tests.

For a later Push/history phase, extend explicit capabilities and fixed endpoints,
add shared workflow tests, and coordinate repository mutation with browser
writes before adding more operations. Do not expand this API into arbitrary
shell execution.
