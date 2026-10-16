## 21. Implementation priorities

Work in this order:

Checklist updated **2026-10-16**. Checked phases indicate implementation is
present; they do not mean every review finding is resolved. The user has
confirmed successful server API Pull and, after deploying the extended browser
plugin, successful Pull in Ignis. See the current status below for remaining work.

- [x] **Phase 1 — Investigation**

Map the existing architecture and required interfaces.

- [x] **Phase 2 — Backend**

Implement the Ignis server plugin, repository inspection endpoints, and safe pull operation.
Implemented and tested on the user's server: discovery, per-vault enablement,
and the Pull endpoint work. Review findings 3–5 remain open.

- [x] **Phase 3 — Browser manager**

Implement runtime detection, `IgnisGitManager`, HTTP transport, and the required read-only methods.

Implemented; the user reports Pull works after browser-plugin deployment.
Review findings 1 and 5 remain open.

- [x] **Phase 4 — Plugin integration**

Make the existing Pull command functional.

Ensure initialization, status, error reporting, and filesystem refresh work.

The basic Pull flow is confirmed by the user. Review findings 2, 4, and 6
remain open; failure paths, unload/reload, and detailed note-refresh behavior
still need validation.

- [x] **Phase 5 — Unsupported-feature handling**

Intercept unsupported commands, disable unsupported automatic routines, and remove accidental native process execution paths.

Guards are implemented. Review finding 7 remains open; exhaustive command/UI
coverage and native-import compatibility beyond the working Pull path remain
unverified.

- [ ] **Phase 6 — Testing and documentation**

Run checks, resolve failures, document deployment, and verify that normal Obsidian platforms have not regressed.

Complete all feasible phases rather than stopping after the investigation.

## Current status — 2026-10-16

- [x] Server integration installed in Ignis's code discovery directory, separate
  from `/app/data`; `/api/plugins` lists `obsidian-git`.
- [x] Server plugin enabled for the active vault; the direct API Pull test works
  (user confirmation).
- [x] Extended browser plugin deployed; Pull works in Ignis (user confirmation).
- [x] Deployment instructions and automated test implementations are present in
  `docs/ignis-integration.md`, `integrations/ignis/obsidian-git/README.md`, and
  the Ignis test/smoke files.
- [ ] Resolve review finding 1: browser write completion and mutation races.
- [ ] Resolve review finding 2: safe cleanup when editor setup was skipped.
- [ ] Resolve review finding 3: conflict/untracked status mapping.
- [ ] Resolve review finding 4: skipped/failed cache reconciliation reporting.
- [ ] Resolve review finding 5: server/browser filename compatibility.
- [ ] Resolve review finding 6: clear UI loading on refresh failures.
- [ ] Resolve review finding 7: Ignis-specific conflict guidance.
- [ ] Run and record the full project checks and production bundle smoke check
  against the final implementation; verify desktop/mobile regression coverage.
- [ ] Complete the remaining scenario coverage and live checks listed below,
  including blocked/error cases, unload/reload, and note visibility after Pull.

This update reviewed the current source and recorded the user's live test
results. It did not run automated checks or independently access the deployed
server. Successful Pull confirms the basic deployed path; it does not resolve
the seven findings below. Phase 6 remains incomplete.

The following dated review is preserved as historical evidence. Its phase
assessments and statements about missing live verification describe the
2026-10-14 review, not the updated checklist above.

## Static review of the pilot implementation — 2026-10-14

Reviewed the implementations, their callers, the existing test source, and the
corresponding Ignis interfaces. No tests, builds, type checks, lint checks, or
Docker/browser experiments were run during this review. Only this report was
changed; `ignis/` was used as read-only reference material.

The original checklist had no completed phases marked. Implementation artifacts
exist for every phase, but existence alone does not establish correctness or
successful validation. Phase 1 can be checked off from the inspection document
and source review. The other phases remain unchecked for the reasons below.

### Phase assessment

| Phase | Implementation reviewed | Assessment |
| --- | --- | --- |
| 1 — Investigation | `docs/ignis-inspection.md`, plugin lifecycle, both existing backends, Ignis runtime/plugin/config/cache interfaces | Complete as an architecture investigation. Runtime detection, active-vault identification, route mounting, and enabled-vault configuration match the checked-out Ignis source. The write-diagnostics assumptions need correction as described in finding 1. |
| 2 — Backend | `integrations/ignis/obsidian-git/{index,routes,git-service,errors}.js` | Substantial implementation present. Fast-forward-only integration and conservative dirty-tree handling are sensible, but status mapping and reconciliation have defects. Repository tests exist; their execution is unverified in this review. |
| 3 — Browser manager | `src/platform/ignis.ts`, `src/gitManager/ignisGit.ts`, `src/gitManager/ignisGitClient.ts` | Manager contract, same-origin transport, real health/state requests, timeouts, and unsupported-method rejection are implemented. Browser write safety and filename compatibility still need work. |
| 4 — Plugin integration | `src/main.ts`, `src/gitActions.ts`, source-control/status UI and refresh flow | Existing queued Pull workflow is reused and missing upstream does not open a setup modal. Unload/reload cleanup and failure-state UI need correction. Actual note visibility and open-note refresh remain unverified. |
| 5 — Unsupported-feature handling | `src/commands.ts`, `src/gitAction.ts`, `src/automaticsManager.ts`, `src/tools.ts`, editor/view guards | Broad guards are present before normal command/workflow mutations. Commit/push scheduling and commit debouncers are excluded in Ignis; Pull remains scheduled. Conflict-help guidance still advertises unavailable features. |
| 6 — Testing and documentation | Ignis manager/platform/automatic tests, server tests, `integrations/ignis/bundle-smoke.cjs`, `docs/ignis-integration.md`, Docker/Compose example | Documentation and automated test code exist. Passing checks, desktop/mobile regression coverage, Docker deployment, and live Ignis behavior cannot be certified by this static review. Several important scenarios are absent from the test source. |

### Findings requiring changes

Priority labels: **P1** should be resolved before relying on this pilot with real
vault data; **P2** identifies functional or reporting defects.

1. **P1 — Browser write diagnostics do not prove that all writes have finished.**

   `src/gitManager/ignisGit.ts:141` checks `getState()`, `listFailed()`, and
   `getDetail().pending` before sending Pull. However,
   `ignis/packages/shim/src/fs/write-durability.js:7,103,393` only counts
   non-silent in-flight writes after a 1,000 ms threshold. Silent writes are
   excluded, including from failed-write diagnostics. The manager can therefore
   accept a "clean" browser while a recent write is still in flight. Switching
   a note to reading view does not by itself establish that its save reached
   disk. A delayed save can arrive after fast-forward checkout and replace
   incoming content with older browser content.

   The check also happens only once. Opening an editable pane or beginning a
   write in the same tab during a slow fetch is not prevented. The server's
   post-fetch Git status check sees disk state, not unsaved or queued browser
   content. Closing editable panes is a useful precaution, but does not close
   these gaps. Coordinate Pull with an actual write-drain/mutation exclusion
   mechanism, or explicitly restrict the pilot to a quiescent browser and
   describe the remaining race without claiming that these diagnostics confirm
   write completion. Keep any proposed Ignis API changes outside this
   reference-only checkout.

2. **P1 — Ignis unload enters editor cleanup with undefined event references.**

   `src/editor/editorIntegration.ts:24` skips editor setup in Ignis, and both
   editor features refuse activation because `useSimpleGit` is false. Their
   event references consequently remain undefined. Nevertheless,
   `src/main.ts:515` calls `onUnloadPlugin()`, which unconditionally deactivates
   both features. The cleanup methods in
   `src/editor/lineAuthor/lineAuthorIntegration.ts:152` and
   `src/editor/signs/signsIntegration.ts:144` pass those undefined values to
   `workspace.offref()` / `vault.offref()`. Non-null assertions only affect
   TypeScript; they do not provide an EventRef at runtime.

   This violates the cleanup API contract and can throw before manager request
   cancellation, queue clearing, and timer/debouncer cleanup. It affects both
   ordinary unload and settings reload. Guard each optional event reference and
   make deactivation safe when setup never ran. This is a weakness in shared
   cleanup code exposed by the Ignis integration, not evidence that the pilot
   introduced every underlying cleanup issue. The bundle smoke script never
   exercises unload/reload.

3. **P2 — Server status does not match existing plugin status semantics.**

   `integrations/ignis/obsidian-git/git-service.js:402` includes unmerged entries
   in both ordinary lists: for a `UU` file, `changed` and `staged` both contain
   the file, alongside `conflicted`. Source control then displays it in three
   sections and counts it as an ordinary staged change. The existing backends
   exclude conflicted paths from `changed`, and the mobile backend also excludes
   them from `staged`; native `UU` entries are excluded from `staged` by its
   index-code filter. Preserve `all` and `conflicted`, and exclude unresolved
   paths from ordinary change/staging lists.

   The server also retains Git's `??` for untracked files, whereas the existing
   managers map untracked entries to `U`/`U` and
   `src/ui/modals/changedFilesModal.ts:26` relies on that mapping to label them
   "Untracked". Align that convention without confusing it with actual
   unmerged paths. The current server test checks the conflict path but does
   not assert its exclusion from the other lists or the UI untracked mapping.

4. **P2 — A skipped reconciliation is treated as successful refresh.**

   `integrations/ignis/obsidian-git/index.js:14` directly returns
   `cache.reconcileVault()`. In the reference implementation,
   `ignis/apps/ignis-server/server/cache/crawl.js:376` returns `null` if a crawl
   is already running, the cache is absent, or the vault cannot be resolved.
   `integrations/ignis/obsidian-git/routes.js:75` only detects thrown exceptions;
   `null` produces a normal successful Pull response with no refresh warning.
   A concurrent crawl need not have observed the files changed by Pull, and
   ignored paths especially depend on the explicit reconciliation.

   Inspect the return value and retry/coordinate a skipped crawl, or return a
   clear refresh warning. The report-creation error path also silently ignores
   reconciliation failures (`routes.js:88`), so the notice can point at a report
   that has not become visible. Preserve the original blocked-pull error while
   communicating the refresh problem. Existing route tests cover a successful
   mock reconciliation, not the actual `null` contract.

5. **P2 — Some filenames are rejected only after the server has applied Pull.**

   `src/gitManager/ignisGitClient.ts:23` rejects paths containing a backslash.
   On the Linux server, a backslash is a legal filename character. The incoming
   tree check at `integrations/ignis/obsidian-git/git-service.js:662` checks
   symlink/submodule modes but does not validate names against the browser's
   rules. An incoming `notes\\archive.md` can therefore be checked out and
   reported as updated by the server, then rejected as `INVALID_RESPONSE` by
   the browser. Subsequent repository-state requests also reject that entry
   while it appears in status.

   Agree on supported filename rules at both boundaries. If such names cannot
   be represented safely in Obsidian, reject the incoming tree before merge,
   with an understandable layout/filename error. Do not normalize two distinct
   Git filenames into the same vault path. The existing unusual-filename test
   covers spaces, quotes, and a newline, not this mismatch.

6. **P2 — Refresh failures can leave source control showing loading indefinitely.**

   `src/main.ts:117` emits `obsidian-git:loading-status` before requesting
   repository state. If that request fails, `status-changed` is never emitted.
   `refreshNow()` catches the error and emits `obsidian-git:refreshed`, but the
   Svelte view (`src/ui/sourceControl/sourceControl.svelte:85,91,297`) clears
   loading through its status refresh handler, not through a guaranteed
   completion/error handler. Its `refresh()` also awaits `getUnpushedCommits()`
   before clearing loading, so a rejected count request has the same effect.

   This is a shared UI weakness now exposed to HTTP/network/BUSY errors.
   Server `locked()` serializes reads as well as Pull, so a legitimate state
   read during another request can encounter BUSY. Clear loading on all refresh
   outcomes, keep prior data visibly stale when appropriate, and surface errors
   through the plugin's error handler rather than only `console.error`.
   `withGitOperation()` does restore the plugin's Git operation to idle; that
   does not reset the separate Svelte loading flag.

7. **P2 — Conflict help describes workflows deliberately unavailable in Ignis.**

   `src/statusBar.ts:91` opens `src/main.ts:720`'s unguarded merge-help modal.
   `src/ui/modals/mergeConflictModal.ts` tells users to use highlighted conflict
   blocks, "Keep ours/theirs", stage resolutions, commit, and then push.
   Ignis skips the editor conflict extension and blocks all those Git writes.
   Moreover, the Ignis `mergeInProgress` value represents any unfinished
   operation, so this merge-specific advice can appear during a rebase or
   cherry-pick. Provide Ignis-specific guidance to inspect the report and
   resolve the operation outside this pilot, or show the future-feature notice
   before opening this modal. Existing action guards still prevent the actual
   stage/commit/push mutations; the defect is misleading guidance.

### Parts that look sound on source inspection

- Runtime detection takes priority over desktop identity, uses the canonical
  active-vault global, and does not add a synchronized backend-selection setting.
- The manager extends the existing abstraction, uses `withGitOperation()` with
  `finally` restoration, and aborts tracked HTTP requests in its own unload
  method. Initialization validates server health rather than faking readiness.
- Normal command and workflow guards precede prompts and direct filesystem
  mutations. Backend unsupported stubs throw a dedicated error and do not send
  write requests. The source-control Pull button retains the existing queue.
- The server resolves configured, enabled vaults; rejects traversal, external
  Git directories and symlinks; uses fixed operations and argument arrays with
  `shell: false`; bounds individual child execution/output; and releases its
  repository lock in `finally`.
- Pull uses the configured upstream, blocks dirty/unfinished/diverged state,
  preserves local-ahead commits, rechecks disk state after fetch, and integrates
  with `--ff-only` and ignored-file overwrite protection. No automatic reset,
  stash, rebase, commit, or force path was found in this backend.
- Changed-file collection is NUL-delimited and disables rename detection,
  allowing renames to be reported as deletion/addition. Reports use exclusive
  creation and a local exclude rule. Existing report-name collisions remain
  explicitly deferred by `questions.md`; this review does not add a requirement
  to implement collision management now.
- Automatic commit/sync/push and edit-triggered commit setup are guarded, while
  the existing Pull timer and boot-Pull flow remain enabled. Documentation
  correctly limits timers to an active browser. Docker additions live outside
  `ignis/`, retain its entrypoint, and mount SSH credentials rather than baking
  them into the image.
- Origin/header/JSON checks are useful browser CSRF defenses. They are not
  authentication; the documentation states this accurately and follows the
  single-user pilot decision in `questions.md`.

### Validation gaps and recommended next work

The test files are useful implementation artifacts, but this review neither ran
them nor established that prior checks passed. The server suite does not cover
all of TASK.md's scenarios: successful modification/deletion/multiple-file
pulls, invalid remotes, actual authentication/network failures, filesystem
permission failures, and incoming submodules are examples of missing cases.
Command coverage samples the central guard rather than invoking every registered
unsupported command or every UI entry point. The new automatic-routine test
checks initial scheduling but not reload or unload during an in-flight Pull.

`integrations/ignis/bundle-smoke.cjs` runs the bundle in Node with real Node
modules for almost everything except process spawning and an Obsidian stub.
It calls `init()` directly, disables status/branch UI, overrides refresh, and
does not execute `onload()`, Pull, view mounting, or unload/reload. It is useful
for detecting accidental native process calls during that initialization path,
but does not prove compatibility with Ignis's actual Node shims or Obsidian
lifecycle. Eager imports of SimpleGit and native helpers remain, so real browser
module evaluation still needs verification; this is an unverified compatibility
area, not a confirmed import-time crash.

Resolve the two P1 findings first, then the status, reconciliation, filename,
loading-state, and help-text defects. Add targeted coverage for these paths in
a subsequent implementation task, followed by the normal project checks and a
live Ignis smoke test when authorized. Until then, describe this as a substantial
pull-only pilot with open correctness issues, rather than a completed or
deployment-verified integration.
