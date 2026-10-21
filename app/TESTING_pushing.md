# Push local validation and deployment handoff

The phase follows [TASK_pushing.md](TASK_pushing.md), with three agreed decisions:
keep the existing authenticated single-owner proxy boundary; allow nothing-to-commit
to publish existing history; enable only the separate browser auto-push timer,
leaving automatic commit/sync disabled. The reference `ignis/` tree is unchanged. The tracked root `main.js` is rebuilt.
Implementation details and the discovery note are in
[PUSH.md](integrations/ignis/obsidian-git/PUSH.md).

## Changed code

Frontend:

- `src/gitManager/ignisGit.ts`: Push, live cached readiness/counts, state invalidation,
  cancellation and operation cleanup through the existing transport.
- `src/gitManager/ignisGitClient.ts`: validates Push/readiness response types.
- `src/gitActions.ts`: enables Push/manual sync, uses Push-specific destination
  readiness and stops sync after incomplete Pull.
- `src/platform/ignis.ts`: enables existing `push2`, `push` and specific-message sync
  command IDs; unrelated capability restrictions remain.
- `src/ui/sourceControl/sourceControl.svelte`: enables existing Push/commit-menu
  paths and releases loading/message state appropriately.
- `src/statusBar.ts`: clears obsolete Ignis outgoing counts before a remote read.
- `src/automaticsManager.ts`: enables configured separate Push intervals with
  readiness, pause/disable and unload guards, retaining automatic commit gating.

Server:

- `integrations/ignis/obsidian-git/push.js`: target policy, config validation,
  live remote readiness, merge guards, safe native push and verification.
- `git-service.js`: exposes both handlers under the existing lock, checks ownership,
  normalizes Push rejection/uncertain-outcome errors and emits sanitized logs.
- `routes.js`: adds `/push-state` and `/push` under existing request restrictions.

No abstract `GitManager` or shared workflow result changes. `IgnisPushState` is a
transport-only addition. Desktop/mobile implementations are unchanged.

## Automated local checks

Final local results (Node v24.22.0, pnpm 12.14.0):

| Command                                                                                                                                                                                                                                                                                             | Result                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run all`                                                                                                                                                                                                                                                                                      | Passed: TypeScript; Svelte 0 errors/0 warnings; Prettier; ESLint; 301 Vitest tests across 20 files; 148 server tests. Zero failed, cancelled or skipped tests.                         |
| `pnpm run test:ignis-server` (after final server-only configuration guard)                                                                                                                                                                                                                          | Passed: 149 tests, including 54 new Push tests and 95 existing regression tests; zero failed, cancelled or skipped.                                                                    |
| `pnpm run test:ignis-bundle`                                                                                                                                                                                                                                                                        | Passed: production `pnpm run build` and browser smoke initialization, staged diff/conflict editor, Push through HTTP without native processes, and manual Pull's pending-merge result. |
| `pnpm exec prettier --check integrations/ignis/obsidian-git/push.js integrations/ignis/obsidian-git/git-service.js integrations/ignis/obsidian-git/routes.js integrations/ignis/tests/push.test.cjs integrations/ignis/bundle-smoke.cjs integrations/ignis/obsidian-git/PUSH.md TESTING_pushing.md` | Passed.                                                                                                                                                                                |
| `pnpm exec prettier --check docs/ignis-integration.md structure.md integrations/ignis/obsidian-git/README.md integrations/ignis/obsidian-git/done.md`                                                                                                                                               | Passed.                                                                                                                                                                                |

The full test command runs `vitest run` followed by `pnpm run test:ignis-server`
(`node --test integrations/ignis/tests/*.test.cjs`). The final server-only rerun includes all
54 new Push tests and 95 pre-existing regression tests; it supersedes the
148-test server portion of the preceding full run. Frontend coverage includes
37 new manager/action Push tests, rendered Push clicks with available/unavailable
counts, command-ID tests and timer safeguards. The root `main.js` artifact was
rebuilt; dependency versions and lockfile did not change.

Development runs caught and fixed URL-policy edge cases, stale test expectations,
test typing/formatting issues and use of Obsidian's Array `contains` extension in
timer reload (now native `includes`). All were rerun through the passing final
checks above. No locally required check remains failed or unattempted. No deployment,
Docker, live browser/Obsidian, SSH-key or external-provider checks were run.

New `tests/gitManager/ignisPush.test.ts` checks real action/manager transport,
result validation, destination/count caching, no-op and error notices, idle/refresh,
actual abort/timeout, no hidden staging/commit/Pull and composite stop conditions.
Existing UI tests exercise unchanged command IDs and actual sidebar handlers;
automatic tests cover explicit intervals, pause, disable, no-op, failures and unload.
The bundle smoke check exercises Push with native process APIs unavailable.

`integrations/ignis/tests/push.test.cjs` uses isolated temporary bare repositories
and worktrees only. It covers first/multiple publication, unusual/non-UTF-8 names,
rename counts, preserved dirty index/worktree, destination precedence, custom
mapping, behind/diverged history, remote races, merge guards/completion, remote
hook rejection, bounded subprocess timeout, uncertain verification, retry, shared
locks, independent vaults, request restrictions and unsafe config. Mocked executor
cases check sanitized network/auth/protected-branch/killed-process failures.
The complete existing Pull/staging/Commit/conflict tests remain regression checks.
Every fixture removes its own temporary directories. No SSH keys, production vaults,
GitHub, Docker or running Ignis/Obsidian environment are used.

## Deployment-only checklist — operator runs separately

1. Update the complete server integration directory, including `push.js`, and the
   browser `main.js`/`manifest.json`/`styles.css` together; preserve settings.
   Recreate/reload the existing server plugin and reload the browser plugin.
2. Verify the proxy authenticates the full API prefix, origins and enabled-vault
   policy are correct, and direct unauthenticated access is blocked by the proxy.
3. Use a disposable vault and test remote. Confirm non-root ownership, Git/SSH
   availability, writable Git metadata and the existing server-only deploy key or
   global HTTPS helper. Check host-key trust and remote write permission.
4. Configure an unambiguous single push branch; disable squash/submodule options.
   Verify sidebar Push and palette Push (`push2`) publish existing commits only,
   preserve dirty/staged work and refresh the outgoing badge. Push again for no-op.
5. Exercise Commit-and-sync (`push`), optional Pull, disabled Push, custom messages,
   staged-only commits and a resolved merge. A pending merge must stop sync.
6. Advance the remote from another device. Verify no force/recovery occurs, existing
   Pull/merge resolution is offered, reports are preserved and Push works afterward.
7. Check protected-branch denial, unavailable network and credential errors. Confirm
   notices are actionable, loading ends and no secrets/host paths appear.
8. Enable a separate browser Push interval only deliberately; test pause/resume,
   unload/reload and two tabs contending for the same vault. Close/suspend the tab
   to confirm there is no claim of reliable unattended execution.

Deployment, real SSH/HTTPS credential integration, container permissions and live
browser cache/timer behavior remain operator acceptance checks. Future work is
unattended scheduling and advanced push/LFS/submodule/configuration workflows.
