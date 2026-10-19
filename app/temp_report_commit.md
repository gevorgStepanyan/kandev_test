# Ignis Commit implementation review — 2026-10-19

Reviewed `GOAL.md`, `TASK_commit.md`, `IMPLEMENTATION_commit.md`, the referenced
frontend/backend implementations, their callers, generated tests, and deployment
documentation. The review also compared the shared manager contract and native/
mobile commit implementations, plugin refresh/status handling, automatic guards,
and the reference Ignis plugin context. `ignis/` was read-only reference material.

No tests, builds, type checks, lint checks, Docker experiments, or live browser
checks were run during this review. Only this report was created. Static-check
success recorded in `IMPLEMENTATION_commit.md` is an implementation claim, not a
result independently reproduced here. **Tests generated but not executed (as
requested).** Test execution remains for the deployment server.

**Not all tasks can be marked complete.** The main staged/all/Smart server flows,
frontend entry points, safety checks, tests and documentation are implemented.
Smart Commit has an additional restriction that changes the required behavior,
one palette failure path can leave Source Control loading, and transport failures
do not consistently explain uncertain commit outcomes. Session authorization also
depends on an external deployment boundary that this repository does not establish.
Deferring Amend is explicitly allowed by the task and is not an incomplete feature.

### Task assessment

The rows below follow the thirteen definition-of-done items in TASK_commit.md §12.
“Present” means supported by source inspection, not proven by executed tests.

| Task | Implementation reviewed | Assessment |
| --- | --- | --- |
| 1 — Existing manager methods and transport | `src/gitManager/ignisGit.ts`, `ignisGitClient.ts`, shared `gitManager.ts` | Present. Numeric signatures are retained; staged/all use the existing credentialed transport and one `/commit` mutation. No browser-side stage-then-commit sequence. |
| 2 — Smart policy | `GitActions.performCommit`, `IgnisGitManager.commitSmart`, backend `commit.js` | Partial. The server selects from authoritative locked state correctly, but the browser can block staged-only Smart commits before that decision; see finding 1. |
| 3 — Authorized native execution and shared lock | `routes.js`, `GitService.commit`, `locked`, `resolveVault`, `run` | Native execution and the shared lock are present. Enabled-vault/layout validation is implemented. Session-specific authorization is an external deployment dependency; see the authorization gap below. |
| 4 — Index preservation and serialized stage-all | `commit.js`, `GitService.stageChanges` | Present on inspection. Staged-only never calls add; all stages eligible literal paths and commits under one lock. No destructive rollback. External processes remain outside this lock, as documented. |
| 5 — Message, identity, count and HEAD | `IgnisGitManager.formatCommitMessage`, backend `commit.js` | Present on inspection. One-pass templates, bounded stdin message, local identity, new HEAD/tree/parent checks and real root-aware changed-path counts. Initial commits and rename endpoint counts are handled. |
| 6 — Commands, existing UI and notices | `src/commands.ts`, `src/platform/ignis.ts`, Source Control Svelte component, `GitActions` | Present, subject to finding 1. Six manual palette commands and the existing primary/staged/all paths are connected. Typed messages survive failure/cancel/no-op. |
| 7 — Refresh and busy-state completion | Manager invalidation/events, `src/main.ts`, Source Control and status bar | Partial. Normal commit outcomes request refresh and restore operation state; the palette preflight failure is uncovered, and live view/count/timestamp refresh is unverified. See finding 2. |
| 8 — No-op and error reporting | `commit.js`, manager result validation, `GitActions.reportCommitResult`, HTTP client | True no-op is distinguished from success, malformed results are rejected, and native uncertainty is handled. Transport ambiguity messaging remains incomplete; see finding 3. |
| 9 — Repository safeguards and no remote operations | `commit.js`, shared validation/executor | Present on inspection. Unfinished operations, unmerged entries, detached HEAD, unsafe layouts/index entries and tracked/staged reports are refused. Commit itself does not fetch/pull/push. |
| 10 — Guarded or unavailable Amend | UI, runtime command routing, `GitActions`, manager, backend and tests | Present through the permitted deferral policy. Explicit explanatory errors occur before history mutation; amend is not downgraded to a normal commit. |
| 11 — Preserve Pull/Staging and desktop/mobile | Shared service/transport, existing managers, guarded shared action/UI code | Existing paths remain. Shared staging selection is reused and missing-upstream parsing supports local commits. Regression preservation is plausible on inspection, but not established by executed checks; inherited Pull issues are outside this phase. |
| 12 — Generate tests and execution guide | Manager/platform/UI tests, `integrations/ignis/tests/commit.test.cjs`, `TESTING_commit.md` | Substantial test artifacts and exact commands are present. Specific coverage gaps remain below; existing test source is not proof that every required scenario is covered. |
| 13 — Do not run tests locally; report pending verification | `IMPLEMENTATION_commit.md`, `TESTING_commit.md`, `COMMIT.md` | Documentation explicitly complies. This review also ran no tests. Prior execution history cannot be independently certified from documentation alone. |

The discovery report identifies the real command/UI → queue → action → manager →
HTTP path, existing stubs, API prefix, executor, lock and error envelope. The final
handoff documents modified files, identity configuration, artifact deployment,
reload steps, limitations and Push as the next phase. Those reporting deliverables
are present.

### Findings requiring changes

Priority **P2** denotes a functional or reporting defect. These findings are based
on source paths, not locally executed reproductions.

1. **P2 — Smart Commit applies stage-all restrictions even when work is staged.**

   `src/gitManager/ignisGit.ts:246` calls `ensureStagingSafe()` for every Smart
   request with `autoStageOnEmptyIndex` enabled, before reading the snapshot or
   contacting the commit endpoint. That guard rejects editable Markdown panes,
   pending writes, or a missing write-safety API. The server would choose
   staged-only whenever its locked index is nonempty, and staged-only explicitly
   permits open editors because it records an existing index snapshot.

   Consequently, stage a note, reopen it for editing, and use the primary Commit
   button with fallback enabled: Smart is refused, although choosing **Commit
   staged** can commit the same index safely. Turning on fallback changes whether
   an already-staged commit is allowed. TASK_commit.md §§1/4 requires staged work
   to take priority and fallback permission to matter only for an empty index.

   This restriction is documented in `COMMIT.md` and intentionally asserted by
   `tests/gitManager/ignisGit.test.ts:862`; documentation does not make it equivalent
   to the requested Smart behavior. Let the locked server decision distinguish a
   safe staged operation from a fallback requiring browser staging readiness. Do
   not replace this with a browser-only mode decision, which would reintroduce the
   stale-index race. Cover staged Smart with open editors/pending writes as well
   as refusal of an unsafe empty-index fallback.

2. **P2 — A command-palette Commit can leave Source Control loading after preflight fails.**

   `src/gitActions.ts:537` calls `plugin.updateCachedStatus()` before entering the
   manager commit workflow. `src/main.ts:117` emits `loading-status`, then awaits
   HTTP state. If that read fails with NETWORK, BUSY, or invalid state, no
   `status-changed` event follows. `runGitAction` reports the error but does not
   emit a completion/refresh event.

   Palette callbacks in `src/commands.ts:203` onward only enqueue the action.
   They do not have the component commit handler's `finally` refresh. The
   manager's refresh `finally` is never reached in this case either. Thus the
   listener at `sourceControl.svelte:86` can set loading without either normal
   clearing event. The new `refreshed` listener at line 106 helps only if a
   refresh actually occurs. Commit controls remain disabled until another refresh
   completes. This is a remaining shared loading weakness exposed by the newly
   enabled palette path, not evidence that Commit introduced the original helper.

   Guarantee completion for failed status preflight, while preserving the error
   notice. Add coverage using real action/status events and a mounted listener
   harness; the current handler test disables `onMount` and cannot observe this.

3. **P2 — Lost commit responses do not consistently warn that a commit may exist.**

   The backend carefully returns `GIT_COMMIT_OUTCOME_UNCERTAIN` when native
   execution may have created a commit. But a successful server commit can also
   lose its HTTP response. `src/gitManager/ignisGitClient.ts:127` maps a fetch
   rejection to generic NETWORK with “Cannot reach the Ignis Git server.” A
   truncated/non-JSON response at line 138 advises checking integration enablement.
   `IgnisGitManager.performCommit` propagates these errors unchanged.

   Neither message explains that HEAD may already have changed or that history
   must be inspected before retrying. Abort and malformed JSON-object success
   paths provide better advice, so handling is inconsistent. `COMMIT.md:96` also
   overstates that the client treats transport interruption as ambiguous. A user
   retrying all after new edits arrive can create another commit; ordinary no-op
   detection is not an uncertainty policy.

   Distinguish failures of the commit POST from failures of its preliminary state
   read, attach explicit uncertain-outcome guidance to lost/unreadable commit
   responses, retain the typed message, and do not automatically retry. Add tests
   that simulate a response lost after server-side success. Cache invalidation and
   attempted refresh alone cannot establish the outcome while the network is down.

### Authorization requirement and deployment dependency

TASK_commit.md §5 requires authorization of the requesting session for the selected
vault, and §10 asks for unauthenticated-request rejection coverage. The integration
does not implement that contract itself: `routes.js:7` checks origin, a static
header and JSON; `git-service.js:207` checks plugin enablement for the vault. An
HTTP caller can supply those headers. There is no requesting principal or
principal-to-vault authorization check.

`COMMIT.md:118` discloses this honestly. The checked-out Ignis plugin context
(`ignis/apps/ignis-server/server/plugin-system/manager.js:113`) exposes enabled
vaults, not session/per-user ACLs. Reusing that prior boundary is consistent with
preserving Pull/Staging architecture, but does not prove session authorization.
The feature is conditional on an authenticated single-owner proxy covering the
entire API prefix. This review has no deployment evidence that such protection is
installed, and the route harness cannot verify it. Do not claim full authenticated
or cross-user isolation acceptance without that evidence. This is an inherited,
documented limitation, not a newly discovered weakening of Pull/Staging security.

### Parts that look sound on source inspection

- Commit extends the existing CommonJS integration, namespace, transport, error
  envelope and repository lock. State, Pull, staging and Commit use the same lock;
  competing requests fail with BUSY and independent vaults have separate locks.
- Staged-only sends no add operation. All selects native status paths with literal
  pathspecs, including deletions, and commits inside one lock. Ignored/untracked
  report files are excluded; tracked/staged reports, including staged report
  deletion, block Commit without rewriting the report.
- Native messages use stdin and verbatim cleanup. Frontend templates expand once,
  preserve introduced token-like text, and use local hostname storage without a
  browser hostname call. Script settings produce a notice and template fallback.
- Identity comes from repository-local configuration, author and committer are
  pinned, inherited Git overrides are stripped, and root/non-owner execution is
  rejected. Hooks, fsmonitor, automatic maintenance and commit signing are disabled
  in the relevant invocation paths.
- Backend success requires a new HEAD with the captured index tree and expected
  parent. Counts use native root-aware, NUL-delimited, no-rename diff output. Native
  failures never fabricate success, reset the index, or retry automatically.
- Ordinary server no-op maps to zero and a no-commit action result. Positive
  validated results alone produce commit success notices and HEAD-change events.
  Manager request outcomes invalidate state, and its operation wrapper restores idle.
- Existing labels, modes, queues and message modals are reused. Unsupported Amend,
  Push, Commit-and-sync and automatic commits remain guarded. Existing automatic
  Pull is retained rather than introduced as a side effect of Commit.
- Documentation explicitly says stage-all uses persisted server bytes and no
  save/flush barrier is available. External Git race detection has stated limits;
  it is not presented as filesystem-wide transaction isolation.

### Validation gaps and recommended next work

Generated frontend coverage is in `tests/gitManager/ignisGit.test.ts`,
`tests/platform/ignis.test.ts`, and `tests/ui/sourceControl/commit.test.ts`.
`tests/automaticsManager.test.ts` supplies existing automatic-routine coverage.
The new server file, `integrations/ignis/tests/commit.test.cjs`, creates temporary
repositories and checks actual objects, parents, index and working bytes. It
covers initial commits, partial staging, all/Smart modes, no-op, messages, protected
reports, identity, unfinished operations, size/permission errors, injected failure
and timeout outcomes, shared locks, independent vaults, and Commit after real local
Pull/Staging. This is substantial test delivery, not merely HTTP response assertions.

Remaining coverage limitations:

- Svelte tests evaluate the component script with inert runes/lifecycle hooks and
  mocked GitActions. Palette tests likewise mock actions. They do not exercise
  reactive DOM state, actual refresh listeners, outgoing count/timestamp updates,
  or a UI-to-real-repository commit. The documentation accurately calls this a
  handler test; browser acceptance is still required.
- Staged-only real-repository cases cover an initial addition and a modified,
  partially staged note. The deletion/rename/binary combination is exercised via
  all, leaving the explicit staged-only matrix requested by §10.2 incomplete.
- There is no deployment authentication test proving rejection of an otherwise
  valid unauthenticated caller, nor user/session-specific cross-vault isolation.
  Invalid and disabled vault tests establish a different boundary.
- The three failure/Smart cases described above lack appropriate acceptance tests;
  one current assertion explicitly preserves the Smart restriction.
- Desktop/mobile selection tests and existing backend suites are available, but
  final desktop/mobile regression behavior has not been established by this review.

Resolve the functional/reporting findings, add focused coverage, and establish the
deployment authorization boundary before describing every task as complete. Then
have the user run the documented non-root deployment-server commands and disposable
vault scenarios in `TESTING_commit.md`, including project checks and production
build. Intentionally unexecuted tests are not themselves a violation of this task's
definition of done; missing behavior and coverage remain distinct from pending
execution. No runtime fixes were made as part of this review.
