# Commit tests — manual deployment-server execution

**Tests generated but not executed (as requested).** No Vitest, Node test runner,
coverage, test containers, or bundle smoke test was invoked during implementation.
Behavioral acceptance remains pending on the deployment server.

## Prerequisites

Use a disposable checkout of this fork on a Linux deployment server, Node >=24,
pnpm >=11, native Git, and a **non-root account** owning that checkout and its
temporary directories. Commit intentionally rejects root and a process UID that
differs from the vault directory owner. Do not run these tests against a real
vault. No GitHub access, deploy keys, production identity, or Docker fixture is
needed. Git fixtures create their own identities and temporary repositories.
The new commit fixtures have no real remote. Existing Pull regression fixtures
use temporary local bare repositories. Temporary directories are removed by test
cleanup; the large-blob case stages a 100 MB sparse file.

From the checkout root:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/gitManager/ignisGit.test.ts tests/platform/ignis.test.ts tests/ui/sourceControl/commit.test.ts tests/automaticsManager.test.ts
node --test integrations/ignis/tests/commit.test.cjs
pnpm run test:ignis-server
pnpm run test
pnpm run tsc
pnpm run svelte
pnpm run lint
pnpm run format
pnpm run build
pnpm run test:ignis-bundle
```

The first two test commands focus on this phase. `test:ignis-server` includes
existing Pull/Staging regression tests plus Commit. `test` runs the full frontend
and server suites; overlap is intentional for a final server-side handoff check.
`test:ignis-bundle` is a separate browser-backend initialization smoke test.
Do not deploy if any required check fails.

## Generated and updated coverage

- `tests/gitManager/ignisGit.test.ts`: staged/all/Smart transport, exact messages,
  one stage-all commit request, stale/empty browser status, custom modal submit
  and cancel, formatting once, scope templates, script fallback, no-op conversion,
  cache/event invalidation, busy cleanup, write-safety and unsupported features.
- `tests/ui/sourceControl/commit.test.ts`: executes the actual Svelte script's
  handlers with inert lifecycle/rune adapters in Node, covering primary/menu
  actions, queueing, message preservation, busy state, and actual command-palette
  callbacks. This is a handler test, not a DOM or real browser test.
- `tests/platform/ignis.test.ts`: supported manual command allowlist, automatic
  commit and unsupported-action guards, unchanged backend selection.
- `integrations/ignis/tests/commit.test.cjs`: real initial and ordinary commit
  objects, staged blobs versus newer working bytes, additions/deletions/renames/
  binary files, ignore/report protections, Smart policy, true no-ops, validation,
  identity, disabled hooks/signing, unfinished operations/unmerged index, detached
  HEAD, deferred amend, failed/uncertain outcomes, root/permission and size errors,
  shared locks, independent vaults, external index races, status/outgoing count,
  authorization/layout and route-field/origin/JSON rejection. Assertions inspect
  native HEAD, tree, parent, index and working files.

Timeout outcomes and post-staging Git failures are deterministically injected at
the executor boundary. Existing server tests separately exercise real executor
timeouts/output limits. Incoming proxy authentication cannot be tested by this
repository's route harness: the reference Ignis server exposes no session API.
Validate that boundary in the actual deployment.

## Browser acceptance on a disposable test vault

1. Install both updated artifacts using the integration README. Enable the server
   plugin for only the test vault. Configure a server-local author and upstream
   locally if an outgoing count is needed; no network operation is needed to commit.
2. In Source Control, stage a note, then edit it again and wait for persistence.
   Commit staged with a multiline Unicode message. Inspect the commit blob and
   confirm that the newer edits and an unrelated untracked note remain in Changes.
3. Switch editable Markdown panes to reading view/close them, wait for clean Ignis
   writes, then choose **Stage all and commit**. Check additions and deletions,
   ignored files, the protected report, new HEAD, last commit time and outgoing
   count. Commit uses server-persisted bytes; a very recent save is not a flush
   guarantee. Review remaining Changes after each action.
4. Exercise primary Commit with staged work, then empty index with Smart fallback
   enabled and disabled. Exercise all six manual palette commands and custom-modal
   cancellation. Confirm one commit at most and no implicit Pull/Push.
5. Trigger an identity error and an ordinary no-op. Confirm the textarea survives
   both, busy indicators clear, and no success notice is shown. Retry only after
   inspecting history if the response says outcome uncertain or the connection
   was interrupted.
6. Verify Amend, Push, Commit-and-sync, scripts and automatic commits stay
   unavailable; desktop/mobile retain their existing backends. Check Pull and
   Stage/Unstage before and after Commit.
7. From an unauthenticated browser, verify the deployment proxy rejects access to
   the entire `/api/ext/obsidian-git` prefix; check unauthorized users cannot reach
   a trusted origin/session. The backend itself has no per-user/session ACL.

## Local non-test checks recorded during implementation

TypeScript and Svelte validation succeeded using their installed Node binaries;
Svelte reported zero errors/warnings. The pnpm launcher failed to spawn subprocesses
in this workspace (`Resource temporarily unavailable`), so equivalent binaries
were used. Production bundling initially hit esbuild OS-thread limits, then succeeded with
`GOMAXPROCS=1 GOGC=off UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 esbuild.config.mjs production`.
The normal deployment command remains `pnpm run build`. See
`IMPLEMENTATION_commit.md` for final static check results. These checks do not establish test or deployment acceptance.
