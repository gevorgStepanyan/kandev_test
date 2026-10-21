# Push: implementation and operating policy

Push extends this existing server plugin. Deploy the **whole directory**, including
`push.js`, with the rebuilt browser plugin. No changes to the reference `ignis/`
checkout, new service, remote configuration API or scheduler are needed.

## Actual architecture and inspection note

Existing sidebar Push, palette **Push** (`push2`) and **Commit-and-sync** (`push`)
→ `PromiseQueue` → `GitActions` → `IgnisGitManager` → `ignisRequest` → existing
`routes.js` → `GitService.locked` → `push.js` → bounded native executor → remote.
The sidebar's existing commit menu and Ctrl+Enter reuse Commit-and-sync.
Command IDs, icons, labels and desktop/mobile backends are unchanged. The
close-Obsidian composite remains unsupported in Ignis.

Reusable server helpers are `resolveVault`, `validate`, `locked`, `branch`, `head`,
`unfinished` and `run` in `git-service.js`. Existing routes supply JSON field
allowlisting, origin/header checks and sanitized errors. Pull, staging, Commit
and merge handlers use the same repository lock; competitors receive `BUSY` 409.
Ignis's plugin loader supplies `config`, `getEnabledVaults`, `router` and `log`.
Its authentication limitation is described below.

Push was disabled by manager stubs, `commandForRuntime`, `runReadyGitAction`,
sidebar handler/attributes, commit-menu guards and automatic timer guards. Only
Push, manual Commit-and-sync and separate automatic Push gates are relaxed.
Standalone Fetch, Amend, discard, history, remote/branch mutations and automatic
commit/sync remain unsupported. Automatic commits still fail before mutation.

Differences from the native backend: explicit validated single-ref pushes replace
argumentless push; no upstream creation, squash, recursive submodule push, hooks
or signing. Ignis's outgoing count is an actual commit count against the effective
push destination, rather than the native backend's diff-summary count. The old
`state.unpushedCommits` field remains compatible and upstream-based; the browser
now uses the authoritative Push-specific endpoint for counts and readiness.
No shared abstract manager interface or workflow result union changes.

## API and readiness

- `POST /api/ext/obsidian-git/push`: exactly `{"vaultId":"Main"}`.
- `GET /api/ext/obsidian-git/push-state?vaultId=Main`: returns
  `{"configured":true,"canPush":true,"unpushedCommits":2}`.
- Push returns the existing `PushResult`: `pushed` with `files: number|null`,
  `up-to-date`, `blocked` for no branch/conflicts/unfinished operation, or
  `skipped` for no target. The browser also validates existing not-ready results.
- Rejections use the existing `{error:{code,message}}` envelope. No destination,
  path, executable, flags, credentials or environment are accepted from clients.

Shallow/partial histories may be insufficient to establish ancestry; reconcile
them in an authorized Git environment if preflight cannot prove a safe update.

Readiness and publication resolve the effective target independently of the Pull
upstream. Readiness checks the live remote with `ls-remote`; if a remote commit
is absent locally, a branch-limited fetch downloads objects without writing
FETCH_HEAD, tracking refs, tags, index or working files. This makes behind/diverged
counts accurate with stale tracking refs. A new destination counts all commits
reachable from the local tip. Behind/equal is not pushable; divergence has outgoing
commits but is safely rejected by Push. Counts/readiness share one short browser
cache, invalidated by status and mutation refreshes. These reads require remote
connectivity and credentials; errors remain explicit rather than fabricating zero.

## Configured destination and safety

Remote precedence: `branch.<current>.pushRemote`, `remote.pushDefault`, branch
remote, then Git's sole-remote/origin fallback. Branch selection supports
`push.default=simple` (default), `current`, and `upstream`. Simple requires matching
branch/upstream names for a central workflow; a separately configured triangular
push remote uses the current branch. A missing upstream is not silently created,
even with `push.autoSetupRemote`. Configure it outside Ignis. `current` or an
explicit triangular destination can authorize publication without an upstream.

One exact configured `remote.<name>.push` mapping from HEAD/current branch to a
fully qualified `refs/heads/...` destination is supported. Multiple mappings,
wildcards, force prefixes, deletion, tag destinations, matching/mirror pushes,
multiple push URLs, URLs shadowed by another configured remote and configured
push options are refused. A single push URL
overrides the fetch URL. New destination branches are permitted when unambiguous;
no config is changed. Remote names must contain only letters, digits, dot,
underscore and hyphen, starting with a letter or digit.

Production accepts SSH URLs, ordinary SCP-style SSH addresses and HTTPS URLs.
Embedded passwords/HTTPS usernames, control characters, URL query/fragment,
`ext::`, custom helpers, HTTP, file URLs and filesystem remotes are refused.
The constructor's temporary-root option permits local bare test remotes only;
it is never wired to HTTP, environment or deployment configuration.

The executor uses `shell:false`, fixed Git operations/arguments, disabled hooks,
noninteractive credentials, bounded output and a 60-second per-process timeout.
Network calls pin allowed protocols and standard receive/upload-pack commands,
disable tag following, submodule recursion, pruning and push negotiation. The
source is a captured commit OID and only one branch refspec is passed. Native
non-force Push handles a remote race authoritatively. No reset, commit, stage,
merge, rebase, deletion, config change or force option is part of Push.

Repository-local includes, executable SSH/proxy/credential overrides, HTTP/protocol
overrides, helper/receive-pack/upload-pack configuration and worktree configuration
are refused. URL rewriting is refused at all scopes. Provision credentials through
trusted server environment/global SSH/HTTPS credential configuration, as in the
existing installation. `GIT_SSH_COMMAND`/`GIT_SSH` set by the trusted container are
preserved. Never provision shell commands or secrets through vault config or the
browser. Hooks disabled by this service also mean automatic LFS pre-push uploads
are unsupported; publish required LFS objects outside Ignis first.

Run as the non-root vault owner. Existing realpath, in-vault `.git`, symlink,
external object-directory and vault-root layout validation is reused. A filesystem
lock from unrelated Git processes can still reject operations. The service lock
isolates integration requests, not external administrative Git/config writes;
coordinate those writes. Push rechecks branch/HEAD and unfinished-operation state
before the final remote write. Different vaults keep independent locks.

## Results and workflow

Worktree/index dirtiness does not block publishing existing commits, and no browser
save barrier is imposed for standalone Push. Merge, rebase, cherry-pick, revert,
bisect, sequencer state and unmerged entries block Push. A resolved and committed
merge publishes normally. Dirty, staged and untracked content is preserved in
success, no-op and rejection tests.

Already-published history returns `up-to-date`, including a locally behind branch.
File counts compare the old remote tip to the published tree with NUL-delimited
raw bytes and no rename detection: distinct changed paths, with rename endpoints
counted separately. New destinations return `files:null`. Commit count is never
used as a file count. Empty-tree changes may legitimately report zero files.

Push parses native porcelain completion and verifies the remote ref afterward.
Timeout, disconnect or verification failure may leave publication completed;
inspect the remote before retrying. Retrying uses only normal Push and becomes a
no-op when the tip is already published. No automatic retry or force recovery.

Manual Push still works when `disablePush` is set, matching desktop behavior.
Commit-and-sync preserves existing message/Smart/staged behavior and optional Pull
ordering. Nothing-to-commit can publish existing commits. Failed, skipped or
cancelled Commit stops; failed/skipped Pull or a pending merge stops before Push.
Push disabled means commit-only with optional Pull. Missing destination or rejected
Push is never reported as synced. Squash-before-push and submodule-update settings
must be disabled for Ignis Push; unsupported options produce a clear error.

Only an explicitly configured separate positive `autoPushInterval`, with
`differentIntervalCommitAndPush`, enables browser auto-push. Readiness, paused,
disabled and unloaded state gate each queued invocation. No extra timer or
server scheduler is introduced. Existing Pull timers remain available; automatic
commit/sync schedules remain disabled. Timers require an open, active browser and
are best-effort. Guaranteed unattended 60/300-minute schedules are future work.

## Authentication, diagnostics and deployment

As agreed for this phase, the existing **authenticated single-owner proxy** is the
session boundary. Protect the entire `/api/ext/obsidian-git` prefix. The reference
Ignis context has no session/per-user vault ACL API; allowed origins, the custom
header and enabled-vault checks are not standalone authentication. Every enabled
vault belongs to that trusted boundary. No new multi-user auth claims are made.

`PUSH_NON_FAST_FORWARD` means use the existing Pull/merge/resolve/Commit flow before
retrying. `PUSH_REMOTE_REJECTED` means check protected-branch policy or remote hooks.
`AUTH_OR_PERMISSION`, `NETWORK`, `TIMEOUT`, `PUSH_CONFIG_UNSUPPORTED`, `OWNERSHIP`
and `BUSY` retain explicit actionable feedback. `PUSH_OUTCOME_UNCERTAIN` requires
remote inspection. Neither network failures nor remote divergence create, edit or
clear `git_conflict.md`. Logs record only sanitized result/error codes, never
raw subprocess output, host paths, remote URLs, key paths or credentials.

See [TESTING_pushing.md](../../../TESTING_pushing.md) for actual local validation
and the deployment-only checklist. Passing local fixtures does not establish
compatibility with a deployed Ignis container or real credential provider.
