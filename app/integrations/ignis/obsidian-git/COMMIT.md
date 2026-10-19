# Manual Commit API and deployment policy

The integration remains mounted at `/api/ext/obsidian-git` by the existing Ignis
server-plugin loader. Copy the **entire** integration directory when upgrading;
`commit.js` is required in addition to the previous Pull/Staging files.

## Request and response

`POST /api/ext/obsidian-git/commit` uses the same origin/header/JSON checks,
enabled-vault resolution, no-store responses, `{error:{code,message}}` envelope,
repository validation, native executor and per-repository lock as Pull/Staging.
Its allowlisted JSON body is:

```json
{
    "vaultId": "Main",
    "mode": "staged",
    "message": "Update notes\n\nDetails",
    "amend": false
}
```

`mode` is exactly `staged`, `all`, or `smart`. Smart additionally requires
`autoStageOnEmptyIndex: true|false`; other modes reject that field. `amend` is an
explicit boolean. Identity, paths, Git arguments, shell commands and environment
fields are rejected. Amend is always refused with `AMEND_UNSUPPORTED`: cached
remote-tracking refs cannot establish publication reliably. No fetch is performed.

A verified commit returns:

```json
{
    "status": "committed",
    "commit": {
        "hash": "<full hash>",
        "shortHash": "<12 chars>",
        "files": 3,
        "branch": "main"
    }
}
```

A no-op returns `{"status":"nothing-to-commit","reason":"nothing-staged"}`
or `reason: "no-changes"`. It creates no empty commit or HEAD event. The frontend
converts this to numeric zero and a no-commit action result; only positive,
validated counts produce a successful commit notice. Counts are distinct changed
paths from native `diff-tree --root --no-renames`: a rename counts both endpoints.
Initial commits do not require a parent. Unconfigured upstreams report no outgoing
count, consistent with the existing state contract.

## Index, message and failure behavior

Staged-only commits never call `add` and record the index snapshot, preserving
newer working edits and unrelated files. All stages the same eligible literal
changed-file paths as Stage all, then commits within one lock. Smart decides from
the **server index inside that lock**, using the setting only to permit empty-index
fallback. Competing requests receive existing `BUSY` (409); there is no automatic
retry, and independent vaults have independent locks.

Message expansion runs exactly once in `IgnisGitManager`, with configured date
format, locally stored hostname (empty if unset), intended file count/list and
optional affected-file body. Introduced token-looking filenames or hostnames are
not expanded recursively. The server receives final text over stdin to
`git commit --cleanup=verbatim -F -`, retaining Unicode, punctuation and line breaks
(with Git's normal final newline). Whitespace-only/NUL messages and messages over
16 KiB UTF-8 are refused. Scripts are never executed; configured script settings
produce a notice and use the supported template. File tokens describe the fresh
pre-request browser snapshot; a concurrent index change can make that text stale.
They do not authorize staging or select committed paths.

Stage-all, including Smart when fallback is enabled, conservatively reuses the
existing browser staging guard even if the server might choose staged-only. Clean
reported writes and no editable Markdown source panes are required. Ignis exposes
no save/flush barrier: recent saves may not be persisted yet. Staged-only can
commit an index snapshot while editors are open; this does not commit their buffers.

The server checks unfinished Git operations, unmerged index entries, attached HEAD,
index paths/modes and the protected report before mutations and again after
staging. Only vault-root repositories with an internal `.git` directory are
supported. Parent/shared repos, linked worktrees, symlinks and submodules are
refused. A tracked/staged `git_conflict.md`, including a staged deletion of a
previously tracked report, blocks Commit. An untracked report is excluded and
preserved. Scope settings cannot expand authorization beyond the vault.

Hooks remain disabled by the shared executor's `core.hooksPath=/dev/null`; commits
explicitly disable signing. No editor or signing prompt is used. Native execution
is bounded by the existing 60-second per-process timeout and 8 MiB output cap.
Staged changed blobs >=100,000,000 bytes are refused on Ignis regardless of remote;
small LFS pointer blobs are eligible, but configuring LFS is an administrator task.
No remote access, repository initialization, history rewrite or index rollback is
part of Commit. After native execution, HEAD must change, its parent must match the
previous HEAD (or be absent initially), and its tree must match the captured index.

If staging or commit fails, work may remain staged; inspect Source Control before
retrying. `GIT_COMMIT_OUTCOME_UNCERTAIN` means a commit may already exist. The client
also treats transport interruption as ambiguous. Neither side automatically
retries or resets/stashes/discards data. Status is invalidated and refreshed;
HEAD-change is emitted only for a validated successful response. Tree/parent checks
detect some external Git races, but the integration lock cannot isolate external
processes or prevent every filesystem race. Coordinate administrative Git work.

## Identity and security boundary

Run the server as the **non-root owner of the vault directory** with writable Git
metadata. Commit checks the process UID against the vault directory UID. Configure
the existing Compose PUID/PGID accordingly; no recursive ownership changes occur
in requests. Both author and committer are pinned to repository-local `user.name`
and `user.email`; inherited Git identity overrides are removed by the executor.
Missing identity produces `GIT_IDENTITY_MISSING`.

For the reference Compose setup (replace the example UID/GID and identity):

```sh
docker compose -f example-ignis-docker-compose.yaml exec --user 1000:1000 ignis git -C /vaults/Main config --local user.name 'Vault Author'
docker compose -f example-ignis-docker-compose.yaml exec --user 1000:1000 ignis git -C /vaults/Main config --local user.email 'author@example.com'
```

The reference Ignis plugin context provides configuration and enabled-vault lookup,
**not an authenticated session or per-user vault ACL API**. Existing origin/header
checks prevent cross-origin browser requests; they do not authenticate arbitrary
HTTP callers. As with the existing integration, serve this only behind the
operator's authenticated, trusted single-owner Ignis deployment/proxy. Protect the
entire API prefix, not just the web page. Every enabled vault is accessible within
that trusted deployment boundary. Multi-user isolation and unauthenticated direct
exposure are unsupported. No session authorization was invented or claimed here.

New errors include `INVALID_COMMIT_MESSAGE`, `GIT_IDENTITY_MISSING`,
`UNMERGED_INDEX`, `DETACHED_HEAD`, `CONFLICT_REPORT_STAGED`, `FILE_TOO_LARGE`,
`AMEND_UNSUPPORTED`, `REPOSITORY_CHANGED`, `GIT_COMMIT_FAILED` and
`GIT_COMMIT_OUTCOME_UNCERTAIN`; existing validation, ownership, permission, busy,
timeout and native-failure codes are reused. Responses contain no native stderr,
server paths, credentials or commit-message logging.

## Build and reload

1. From this fork's root, run `pnpm install --frozen-lockfile`, execute the manual
   checks in `TESTING_commit.md`, and run `pnpm run build` on the deployment server.
2. Copy `main.js`, `manifest.json` and `styles.css` into the existing vault plugin
   directory (usually `/vaults/Main/.obsidian/plugins/obsidian-git/`). Keep its
   existing `data.json` settings. Use the actual plugin directory if customized.
3. Update the mounted backend directory with **all** files from
   `integrations/ignis/obsidian-git/`. Keep the existing mount, allowed origins and
   enabled-vault settings described in `README.md`; add no duplicate integration.
4. Configure local identity and non-root ownership as above, then restart/recreate
   the existing service using
   `docker compose -f example-ignis-docker-compose.yaml up -d --build --force-recreate ignis`.
5. Reload the browser and disable/re-enable the Obsidian Git plugin (or reload
   Obsidian) to load the new bundle. Verify health/state and perform browser
   acceptance only against a disposable vault before using real work.

Push, Commit-and-sync, Amend, automatic commits, schedules and commit-message
scripts remain unsupported. Push is the next phase, outside this change.
