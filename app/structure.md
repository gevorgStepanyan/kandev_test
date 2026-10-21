# Codebase structure

This is an agent-oriented map of the Obsidian Git plugin. Read this alongside
[AGENTS.md](AGENTS.md), then open the modules relevant to your task. This file
describes the current architecture; update it when responsibilities or entry
points change. It does not replace the implementation or project instructions.

## Start here for a task

| Task                                                            | Primary files                                                    | Related code and tests                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Plugin startup, repository readiness, reload, refresh, notices  | `src/main.ts`                                                    | `src/editor/editorIntegration.ts`, `src/statusBar.ts`                        |
| Commands and hotkeys                                            | `src/commands.ts`                                                | `src/gitActions.ts`; preserve released command IDs and readiness/file checks |
| Commit modes, commit-and-sync, prompts, remote/branch workflows | `src/gitActions.ts`                                              | `src/gitAction.ts`, `src/types.ts`, backend tests                            |
| Shared Git semantics                                            | `src/gitManager/gitManager.ts` and both backends                 | `tests/gitManager/gitManager.test.ts`                                        |
| Ignis browser Git and server pull service                       | `src/gitManager/ignisGit.ts`, `src/platform/ignis.ts`            | `integrations/ignis/`, `docs/ignis-integration.md`                           |
| Native Git, submodules, blame, Git executable/environment       | `src/gitManager/simpleGit.ts`                                    | `tests/gitManager/simpleGit.test.ts`                                         |
| Desktop authentication prompts                                  | `src/gitManager/askpassServer.ts`                                | askpass constants in `src/constants.ts`, `tests/gitManager/askpass.test.ts`  |
| Mobile Git, HTTP, merge/index metadata, filesystem adaptation   | `src/gitManager/isomorphicGit.ts`, `src/gitManager/myAdapter.ts` | `tests/gitManager/isomorphicGit.test.ts`                                     |
| Automatic commit/pull/push or pause/resume                      | `src/automaticsManager.ts`                                       | `src/setting/localStorageSettings.ts`, `tests/automaticsManager.test.ts`     |
| Source-control pane and file actions                            | `src/ui/sourceControl/sourceControl.svelte`                      | its TypeScript view wrapper and `components/`                                |
| Commit history and file trees                                   | `src/ui/history/historyView.svelte`                              | its TypeScript wrapper, `components/`, manager `log()`/`getTreeStructure()`  |
| Diff views and historical file snapshots                        | `src/ui/diff/`, `src/ui/readOnlyFileView.ts`                     | `src/tools.ts`, `tests/ui/diff/splitDiffView.test.ts`                        |
| Editor diff signs, hunk staging/reset/navigation                | `src/editor/signs/`                                              | `src/editor/control.ts`, `tests/editor/signs/`                               |
| Conflict parsing and editor resolution buttons                  | `src/editor/conflicts/`                                          | source-control conflict component, `tests/editor/conflicts/model.test.ts`    |
| Line authoring/blame gutter                                     | `src/editor/lineAuthor/`                                         | native `blame()`, `docs/dev/LineAuthorFeature.md`                            |
| Settings, defaults, persistence, credentials                    | `src/setting/`, `src/constants.ts`, `src/types.ts`               | loading/migrations/reload in `src/main.ts`                                   |
| Build, release artifacts, CI                                    | `esbuild.config.mjs`, `package.json`, `.github/workflows/`       | `manifest.json`, `versions.json`, `version-bump.cjs`                         |

## Runtime and action flow

`src/main.ts` exports `ObsidianGit`, the Obsidian `Plugin` subclass and composition
root. It owns the manager, `GitActions`, `AutomaticsManager`, `PromiseQueue`, editor
integration, settings services, status bars, cached status, and plugin state.

1. `onload()` sets the global plugin reference, migrates local storage, loads and
   migrates settings, adds the settings tab, and registers plugin resources.
2. `registerStuff()` registers views, commands, workspace/vault handlers, and
   editor extensions. This registration is intended to happen once and be
   independent of settings.
3. After layout readiness, `init()` detects Ignis first, choosing
   `IgnisGitManager` there, `SimpleGit` on ordinary desktop, and `IsomorphicGit`
   otherwise, checks requirements, updates `gitReady` and
   `repositoryMissing`, starts configured status bars/editor features/automatics,
   and optionally queues a boot pull.
4. Commands, UI controls, and automatic routines call `GitActions`, generally
   through `plugin.promiseQueue`. `GitActions` handles user workflow decisions,
   readiness, prompts, typed outcomes, refresh requests, and result notices;
   managers implement repository operations.
5. `reloadSettings()` loads persisted settings and, when they change, calls
   `unloadPlugin()` then `init({ fromReload: true })`, and remounts open
   source-control/history components. `unloadPlugin()` also serves ordinary
   unload: it stops features/timers, removes bars, unloads the manager, clears
   pending queue tasks, and cancels the refresh debouncer.

`src/gitAction.ts` centralizes action error handling in `runGitAction()`. The outer
result is `success` with a value, `failed`, or `cancelled`. Workflow values have
their own discriminated results in `src/types.ts` (for example, not-ready or
cancelled outcomes). Conflict errors refresh status and invoke conflict handling;
network errors invoke offline handling; other failures use `displayError()`.

`src/promiseQueue.ts` executes tasks serially and continues after failure. Its
`clear()` removes pending tasks; it does not cancel the running task.
`src/coalesce.ts` merges overlapping refresh requests into a follow-up run.
Neither the operation-state wrapper nor refresh coalescing replaces mutation
queueing.

### Refresh and workspace events

| Event                                   | Role                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `obsidian-git:refresh`                  | Request the plugin's coalesced refresh                       |
| `obsidian-git:loading-status`           | Announce a status read                                       |
| `obsidian-git:status-changed`           | Publish updated cached status to panes/diff/status consumers |
| `obsidian-git:refreshed`                | Announce refresh completion; editor signs refresh from this  |
| `obsidian-git:head-change`              | Notify history and line authoring of HEAD changes/readiness  |
| `obsidian-git:repository-state-changed` | Notify views of readiness/missing-repository changes         |
| `obsidian-git:menu`                     | Request the plugin's file context-menu actions               |

`updateCachedStatus()` reads status and merge state, refreshes the branch bar, and
publishes status. `refreshNow()` only reads status when a relevant pane or the
changed-files status bar needs it, then emits `refreshed`. The plugin shares an
unpushed-commit promise between consumers until refresh/status invalidation;
failed reads are removed from that cache. A routine refresh deliberately does
not reactivate line authoring, to avoid editor jumps.

## Git backends and data boundaries

- `src/gitManager/gitManager.ts`: abstract contract for status, staging,
  commits, discard, synchronization, branches/remotes/config, history, diff,
  snapshots, and requirements. Shared implementations cover path conversion,
  tree construction/simplification, and commit-message templates.
  `withGitOperation()` sets operation state and restores idle/clears progress in
  `finally`, including failures.
- `src/gitManager/simpleGit.ts`: desktop implementation using the native Git
  executable through `simple-git`. `setGitInstance()` configures repository
  location, executable, environment, progress, and askpass. Native-only helpers
  include blame/submodule-aware queries, patch application, LFS checks, and raw
  commands. Inspect this module for native pull/rebase/merge/reset behavior.
- `src/gitManager/askpassServer.ts`: local HTTP bridge for Git/SSH credential
  prompts, with a per-server token, serialized modal prompts, and shutdown
  handling. Shell-script support lives in `src/constants.ts`; the server is
  managed by `SimpleGit`.
- `src/gitManager/isomorphicGit.ts`: JavaScript implementation using
  `isomorphic-git`. `getRepo()` supplies filesystem, repository paths, auth
  callbacks, and an HTTP client backed by Obsidian `requestUrl`. It maps status
  matrices to plugin status codes, performs merge handling (including `diff3`),
  and manages merge metadata/index conflicts. HTTP helpers collect request bytes
  and handle gzipped response bytes. Do not assume native backend capabilities
  or pull strategies automatically exist here.
- `src/gitManager/myAdapter.ts`: Node-style filesystem facade over the Obsidian
  vault/data adapter for isomorphic-git, including binary reads/writes, stat/error
  translation, and Git index caching. `wrapFS()` in the backend scopes filesystem
  cache handling around operations.

Paths are a critical boundary: Obsidian files use vault-relative paths; Git
commands and diff states use repository-relative paths. Use manager
`getRelativeRepoPath()`/`getRelativeVaultPath()` and inspect methods' explicit
`relativeToVault` flags. `FileStatusResult` and tree nodes carry both `path` and
`vaultPath`. Native Git can discover a repository containing the vault;
`limitToVault` and native pathspec helpers restrict exposed/mutated files.
`Status.stagedOutsideVault` and `conflictedOutsideVault` retain omitted counts
used by commit/conflict logic. Preserve this behavior without adding access
outside the permitted vault/repository scope.

In `DiffViewState`, `aFile`/`bFile` are repository-relative (and may differ for
renames). An empty ref string means the Git index; `bRef === undefined` means
the working tree. Check for `undefined` explicitly rather than treating empty
strings as absent.

## Ignis integration

`src/platform/ignis.ts` owns runtime detection, backend selection, command
capability guards and Ignis-specific errors. `src/gitManager/ignisGit.ts` is the
pull-only HTTP manager; `ignisGitClient.ts` validates transport responses.
`main.ts` chooses it before native initialization; `useSimpleGit` is false in
Ignis so desktop editor features do not activate. `runGitAction()` blocks
unsupported workflows before prompts or mutations unless explicitly allowed.
Commands, Tools and restored view entry points also guard direct UI/file actions.
Automatics retain Pull but ignore commit/sync/push schedules in this runtime.

`integrations/ignis/obsidian-git/` is a separately installed CommonJS Ignis
server plugin, with a scoped router, native Git service, structured errors and
repository locks. It resolves enabled vaults through trusted server config,
validates root-only repositories, and fetches/fast-forwards clean worktrees.
Blocked pulls create an excluded report without overwriting existing files.
Server reconciliation uses Ignis's existing cache/watch system.
`integrations/ignis/Dockerfile` and `compose.yaml` provide deployment examples;
`bundle-smoke.cjs` checks the production bundle with native processes unavailable.
The `ignis/` checkout is read-only reference material and excluded from this
plugin's TypeScript checks. Never place implementation edits there.

See `docs/ignis-inspection.md` for the integration trace and
`docs/ignis-integration.md` for installation, constraints and live smoke checks.
Tests live in `tests/platform/ignis.test.ts`, `tests/gitManager/ignisGit.test.ts`,
and `integrations/ignis/tests/`. `pnpm run test` includes server tests;
`pnpm run test:ignis-bundle` rebuilds and checks bundle initialization.

## Views, modals, and presentation

- `src/ui/sourceControl/sourceControl.ts` (`GitView`) and
  `src/ui/history/historyView.ts` are Obsidian `ItemView` wrappers. They mount
  Svelte components with `{ plugin, view }`, unmount on close, and remount on
  reload. View IDs/icons/names come from `src/constants.ts`.
- `src/ui/sourceControl/sourceControl.svelte` owns pane state, commit modes and
  controls, missing-repository setup, changed/staged/pulled/conflicted sections,
  conflict counts, and workspace event subscriptions. `components/` contains
  file rows, conflict/staged/pulled variants, tree rendering, and large-list UI.
- `src/ui/history/historyView.svelte` loads/paginates logs and refreshes on HEAD
  changes; `components/` renders commits and their file/tree children.
- `src/ui/diff/diffView.ts` renders unified Git diffs with `diff2html`.
  `splitDiffView.ts` uses CodeMirror merge editors, handles reference and working
  versions, editing, and refresh. `contextMenu.ts` provides diff editor actions.
- `src/ui/readOnlyFileView.ts` opens file snapshots at a commit.
  `src/tools.ts` opens diff/snapshot views, chooses the configured diff style
  (mobile uses unified), checks oversized GitHub files, and prompts for raw
  native Git commands.
- `src/ui/modals/` contains general choice/input, branch, changed-file,
  commit-message, discard, ignore-file, and merge-conflict help dialogs.
- `src/statusBar.ts` owns operation/progress/messages, conflicts, pause/offline
  state, commit age, and counts. `src/ui/statusBar/branchStatusBar.ts` owns the
  branch display. `styles.css` supplies global plugin styling; Svelte component
  styles are injected into the bundle.

## Editor features

`src/editor/editorIntegration.ts` coordinates extension registration,
activation after Git readiness, settings changes, and cleanup.
`control.ts` connects each editor to per-file results using `FileSubscriber` and
a CodeMirror state field. `eventsPerFilepath.ts` keeps subscribers by filepath
so multiple editors can share results and clears its stale-subscriber timer on
unload.

### Diff signs and hunks (`src/editor/signs/`)

- `signsIntegration.ts`: desktop availability, event/timer wiring, extension
  activation, and changes status bar lifecycle.
- `signsProvider.ts`: fetches Git comparison content and sends it to subscribers.
- `diff.ts`: turns CodeMirror diff chunks into line hunks.
- `hunks.ts`: hunk/sign models, patch generation, inversion, and navigation logic.
- `hunkState.ts`: CodeMirror state/effects, incremental updates, and debounced
  computation against comparison content.
- `hunkActions.ts`: stage/unstage via patches, reset editor ranges, navigate hunks.
- `gutter.ts`, `tooltip.ts`, `changesStatusBar.ts`: render signs, previews, and
  change counts/actions.

Signs/hunk activation currently requires desktop `SimpleGit`; patch application
is a native-only action. Pure diff/patch logic has focused tests.

### Line authoring (`src/editor/lineAuthor/`)

`lineAuthorIntegration.ts` manages desktop-only activation and events;
`lineAuthorProvider.ts` obtains/caches native blame information and distributes
results; `model.ts` defines settings and authoring state. `view/view.ts` bridges
results to CodeMirror; `view/cache.ts` caches rendering; `view/contextMenu.ts`
offers authoring actions. `view/gutter/` handles gutter elements, coloring,
commit selection, context-menu element lookup, initial and untracked states.
See [docs/dev/LineAuthorFeature.md](docs/dev/LineAuthorFeature.md) for the feature
architecture and [docs/Line Authoring.md](docs/Line%20Authoring.md) for user behavior.

### Merge conflicts (`src/editor/conflicts/`)

`model.ts` parses ordinary/diff3 conflict blocks and computes replacements;
`actions.ts` applies chosen resolutions to editor text; `view.ts` defines
CodeMirror fields, decorations, and resolution widgets. Conflict extensions are
registered by the shared editor integration, separately from desktop signs and
line authoring. Editor marker resolution and unresolved Git index entries are
distinct; source-control conflict rows also coordinate staging/resolution state.

## Settings and supporting modules

| File                                  | Responsibility                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                        | Settings and shared status/log/diff/tree types, workflow result unions, plugin operation/progress state, errors, Obsidian event typing             |
| `src/constants.ts`                    | Default settings, view identifiers, formats, binary extensions, native askpass script                                                              |
| `src/setting/settings.ts`             | Settings tab, controls, persistence callbacks, feature refresh, line-author settings page/color/date helpers                                       |
| `src/setting/localStorageSettings.ts` | Device-local username, executable/environment, hostname, automatic timestamps/pause state, disable flag, gutter fallback; legacy storage migration |
| `src/setting/gitServerPassword.ts`    | Mobile password/token in Obsidian secret storage; settings persist the secret ID; migration of legacy local credentials                            |
| `src/automaticsManager.ts`            | Commit-and-sync/pull/push scheduling, change debounce, persisted last-run timestamps, timer cleanup and pause checks                               |
| `src/utils.ts`                        | Path/remote/ignore rules, file/binary checks, leaf/menu/hover helpers, color/date/array helpers, process spawning                                  |
| `src/openInGitHub.ts`                 | Construct/open remote file-line and file-history links                                                                                             |
| `src/pluginGlobalRef.ts`              | Global plugin reference used by editor modules                                                                                                     |
| `src/externalLibTypes.d.ts`           | Additional external/runtime type declarations                                                                                                      |

Persisted plugin settings load/save through Obsidian `loadData()`/`saveData()` in
`main.ts`; defaults merge through `mergeSettingsByPriority()` in `types.ts`.
Add settings to their type, defaults, UI, and migration/reload behavior as needed.

## Tests and validation

Read [tests/README.md](tests/README.md) for fixture APIs and conventions.
`vitest.config.ts` runs `tests/**/*.test.ts` in Node, aliases `obsidian` to
`tests/stubs/obsidian.ts` and `src` to the source tree, and loads `tests/setup.ts`.
The setup provides minimal Obsidian globals; these stubs are not a full app.

| Tests                                                    | What they exercise                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `tests/gitManager/gitManager.test.ts`                    | Shared contract behavior against both real backends via `helpers/gitManagerHarness.ts` |
| `tests/gitManager/simpleGit.test.ts`                     | Native-specific integration behavior                                                   |
| `tests/gitManager/isomorphicGit.test.ts`                 | JavaScript backend, adapter/transport/merge details                                    |
| `tests/gitManager/askpass.test.ts`                       | Desktop credential bridge                                                              |
| `tests/gitAction.test.ts`                                | Action success/failure/cancellation reporting                                          |
| `tests/automaticsManager.test.ts`                        | Automatic scheduling behavior                                                          |
| `tests/promiseQueue.test.ts`, `tests/coalesce.test.ts`   | Serialization and refresh request handling                                             |
| `tests/editor/signs/{diff,hunks,patchRoundTrip}.test.ts` | Diff/hunk computation and generated patch behavior                                     |
| `tests/editor/conflicts/model.test.ts`                   | Conflict parsing and replacement logic                                                 |
| `tests/ui/diff/splitDiffView.test.ts`                    | Split diff behavior                                                                    |

`tests/helpers/gitRepo.ts` creates temporary repositories and a local origin;
`cleanup.ts` registers cleanup. `createFakePlugin.ts` supplies focused plugin
spies; `simpleGit.ts` and `isomorphicGit.ts` create backend test contexts.
Shared semantic changes belong in the two-backend harness; native-only changes
belong in native tests. UI appearance still needs an Obsidian/manual check.

Use Node >=24 and pnpm >=11 (`pnpm install` for dependencies).
For source changes, run focused tests plus `pnpm run tsc`, `pnpm run svelte`,
`pnpm run lint`, and `pnpm run format`; `pnpm run all` combines these checks and
the full tests. `pnpm run test:watch` and `test:coverage` are available.
The format script checks `src`, `tests`, and `vitest.config.ts`; root Markdown
requires a separate formatter check. Build changes also require `pnpm run build`.

## Build, releases, and documentation

- `esbuild.config.mjs` bundles `src/main.ts` into ignored root `main.js` as
  CommonJS, targeting ES2018. It externalizes Obsidian/Electron/Node and selected
  CodeMirror modules, compiles Svelte with injected CSS, and injects
  `polyfill_buffer.js`. `pnpm run dev` watches with inline source maps;
  `pnpm run build` creates a minified production bundle.
- Release artifacts are `main.js`, `manifest.json`, and `styles.css`.
  `manifest.json` supplies plugin identity/version/minimum Obsidian version and
  allows mobile. `versions.json` records minimum-app compatibility by version.
- `package.json` defines scripts/dependencies and release bump configuration;
  `pnpm-lock.yaml` locks dependencies; `pnpm-workspace.yaml` allows specified
  dependency build scripts. `version-bump.cjs` updates compatibility entries when
  the minimum app version changes. `CHANGELOG.md` records releases.
- `.github/workflows/test.yml` runs type, Svelte, formatting, lint, tests, and
  production build jobs. `releases.yml` builds on tags, packages artifacts,
  attests provenance, and publishes a release.
- `tsconfig.json`, `eslint.config.mjs`, `.prettierrc.json`, and `.editorconfig`
  govern source checking/style. The TypeScript build uses strict checks.
- `README.md` is the public overview; `docs/` contains setup, authentication,
  features, conflict resolution, troubleshooting, integrations, and line
  authoring documentation. `docs/assets/` and `images/` hold documentation media.

When extending the plugin, choose the owning layer first, preserve mobile
capability guards and path/ref conventions, serialize mutations, and check
cleanup during both normal unload and settings reload.

## Ignis conflict workflow additions

`src/gitManager/mergeWorkflow.ts` defines an optional manager capability for
server-authoritative operation state, stage snapshots and explicit merge,
resolution. `ignisGitClient.ts` validates its typed responses.
`integrations/ignis/obsidian-git/merge.js` implements native read-only diffs/content,
Git-stage/state inspection, non-auto-committing merges, verified per-file staging
under the existing service lock. `commit.js` completes
resolved merges through the existing Commit handler. The Source Control pane,
`IgnisConflictModal`, existing diff views and shared conflict editor extensions
expose the workflow. See the integration's `CONFLICTS.md` and root
`TESTING_conflicts.md` for the contract, discovery inventory and acceptance checks.
