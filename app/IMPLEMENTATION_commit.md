# Ignis manual Commit implementation report

## Discovery and reuse

The authoritative integration is `integrations/ignis/obsidian-git/`, not the
read-only `ignis/` reference checkout. Its CommonJS plugin mounts
`/api/ext/obsidian-git` through Ignis's existing loader. Existing `routes.js`
provides origin/header/JSON and request-field checks and the
`{error:{code,message,reportFile?}}` envelope. `GitService.resolveVault`, `validate`,
`locked` and `run` provide enabled-vault/root resolution, strict internal-repository
layout checks, a shared fail-fast per-repository lock, sanitized errors, disabled
hooks, bounded subprocesses and shutdown handling. Pull, index and status routes
remain in that integration.

The frontend path is command/Source Control -> `PromiseQueue` -> `GitActions` ->
`IgnisGitManager` -> `ignisGitClient.ignisRequest`. Previously `commit`/`commitAll`
were unsupported stubs, manual commands were guarded, and the Source Control
button/menu stopped with a future-feature notice. `GitActions.performCommit`
previously resolved Smart and no-op decisions using browser status alone.

Design constraints found in the reference checkout: no session/per-user vault ACL
API in the plugin context, and no browser save/flush barrier. Authentication
therefore remains the existing deployment's trusted single-owner proxy boundary.
The integration does not establish multi-user isolation. Cached remote refs cannot
safely establish publication, so Amend is explicitly deferred.

## Implementation and changed files

- `integrations/ignis/obsidian-git/commit.js` implements locked staged/all/Smart
  operations, validation, attached/unborn HEAD handling, unfinished-operation and
  report/index/layout checks, trusted local identity, non-root owner checks,
  native blob-size checks, stdin message handling, disabled signing, tree/parent/
  HEAD verification, real changed-path counts, no-op and uncertain outcomes.
- `integrations/ignis/obsidian-git/git-service.js` exposes Commit using the existing
  lock, adds optional stdin to the existing executor, and shares its literal
  Stage-all path selection with Commit. It also corrects missing-upstream parsing
  for commits without tracking and distinguishes index permission failures from
  an existing lock. No new Git executor, lock or service is created.
- `integrations/ignis/obsidian-git/routes.js` registers one allowlisted `/commit`
  endpoint. `index.js` updates the existing plugin display name/description.
- `src/gitManager/ignisGit.ts` implements the existing numeric `commit`/`commitAll`
  contracts and an Ignis-only `commitSmart`. Message templates expand once using
  the intended pre-request scope; no browser hostname/native Git/script is invoked.
  Real success emits HEAD change; all request outcomes invalidate cached state and
  request status refresh. `withGitOperation` restores idle. Stage-all/Smart fallback
  reuse browser staging safety; staged-only records the existing index.
- `src/gitManager/ignisGitClient.ts` adds typed commit request payloads to the
  existing same-origin, credentialed client; no second transport is introduced.
- `src/gitActions.ts` enables manual Ignis commits and leaves authoritative Smart/
  no-op selection to the server, retaining message/modal and result reporting.
  Scripts fall back to the template with a specific notice. Automatic commits and
  explicit Amend remain blocked before prompts/mutations; sync/Push remain guarded.
- `src/platform/ignis.ts` allows the six existing manual commit commands and routes
  the existing explicit Amend command to an explanatory unsupported error. Stable
  command IDs/modes in `src/commands.ts` are unchanged.
- `src/ui/sourceControl/sourceControl.svelte` enables primary Smart Commit and the
  staged/all dropdown, retains labels, preserves textarea text on failure/cancel/
  no-op, resets it after confirmed commit, and clears busy state. A separate local
  committing flag prevents refresh events from permitting duplicate clicks. Amend,
  sync and Push remain unavailable. Existing status/refresh listeners update staged
  and changed lists, outgoing count and status-bar last-commit time.
- `tests/gitManager/ignisGit.test.ts`, `tests/platform/ignis.test.ts` are updated;
  `tests/ui/sourceControl/commit.test.ts` and
  `integrations/ignis/tests/commit.test.cjs` are added. The UI test exercises real
  handlers in Node, not DOM rendering. Real repository fixtures inspect Git objects,
  index and working bytes, including injected failures and concurrency.
- `integrations/ignis/obsidian-git/COMMIT.md`, `README.md`, `done.md`, and root
  `TESTING_commit.md` document the endpoint, deployment policy, limitations and
  precise build/reload/manual test steps. No dependencies or lockfile changed.

## Semantics and safety

Staged-only never stages; newer file contents and untracked work remain untouched.
Stage-all stages eligible native status paths and commits in one repository lock.
Smart chooses staged-only whenever the locked index is nonempty, otherwise uses
its explicit fallback setting. A zero result is a no-op, not “Committed 0 files”.
The commit count is distinct changed paths; rename endpoints count separately.
Template file lists are pre-request hints and can be stale; they never authorize
Git paths. Server messages are final, bounded to 16 KiB UTF-8, supplied via stdin,
and preserved with Git's verbatim cleanup policy.

Only vault-root/internal `.git` layouts are eligible; external/parent/shared
repositories, linked worktrees, symlinks, submodules and unsafe index paths are
refused. A tracked/staged conflict report blocks Commit and is never rewritten or
automatically unstaged. No empty commit, implicit Pull/Push, history rewrite,
destructive rollback, script/hook execution or automatic retry is added.
Author/committer use required repository-local configuration; root/non-owner
execution is refused. Changed blobs >=100 MB are blocked for all Ignis commits.

The existing shared lock returns `BUSY` to competing tabs/Stage/Pull, rather than
queueing server requests; the frontend retains its existing queue. External Git
processes are not fully isolated: parent/tree/HEAD checks detect important races,
but cannot provide filesystem-wide transaction isolation. Failed stage-all can
leave work staged. Transport interruptions or ambiguous native results require
history/index inspection before a deliberate retry.

## Verification and deployment handoff

**Tests generated but not executed (as requested).** No acceptance criterion is
claimed verified by tests. Run the exact commands and disposable-vault browser
scenarios in `TESTING_commit.md` on the deployment server as a non-root user.
Proxy authentication and real DOM/Obsidian integration require deployment checks.
The read-only `ignis/` reference checkout was not edited.

Static TypeScript, Svelte (zero errors/warnings), ESLint and Prettier checks passed
using installed binaries directly. New/changed server modules and the new server
test file passed `node --check` syntax validation. The pnpm launcher hit workspace
process-spawn limits. Production bundling initially hit esbuild OS-thread limits, then succeeded using
`GOMAXPROCS=1 GOGC=off UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 esbuild.config.mjs production`,
producing the ignored root `main.js`. No tests or bundle smoke tests were run.

Deployment instructions, including exact Docker repository-local `user.name`/
`user.email` commands, updated integration mount, non-root UID/GID policy, frontend
build/artifact copy and server/browser reload, are in the integration's `COMMIT.md`.
Backend and frontend must both be upgraded. Keep existing settings and vault mounts.

Push is the next phase; Push, Commit-and-sync, Amend, unattended commits/schedules,
commit-message scripts, signing and unsupported history/diff features remain out
of scope. Deployment-server behavioral verification remains pending.

## UI follow-up

Removed the generic future-feature tooltip from Commit-and-sync and the Ignis-only
Source Control and obsolete pull-only settings banners. Commit and dropdown labels
now use the same wording as local Obsidian Git. Existing manual Commit actions
remain enabled. Unsupported Push, sync, Amend, Discard, repository setup and
Add-to-.gitignore controls are explicitly disabled rather than appearing enabled
and producing placeholder notices. Disabled row actions stop event propagation so
they cannot accidentally open a diff. Native/mobile availability is unchanged.

Changed `sourceControl.svelte`, its file/tree components, `settings.ts` and the
existing context-menu definitions in `main.ts`; extended the existing UI handler
regression tests. No server Git behavior changed. Tests remain intentionally
unexecuted; see the UI follow-up in `TESTING_commit.md`. Install the rebuilt plugin
`main.js` and reload the plugin/browser to replace any previously installed UI.
