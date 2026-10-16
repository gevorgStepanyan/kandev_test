# Goal — Extend Obsidian Git to work with Ignis

## Overall aim

Make the existing Obsidian Git plugin work naturally in Ignis, the browser-hosted
Obsidian environment. Reuse its familiar commands, Source Control view, status,
history, settings, and workflows while Git operates on the same vault persisted
on the Ignis server. Preserve ordinary desktop and mobile behavior and keep note
editing usable when Git is unavailable.

## Architecture

Select the backend automatically at runtime, without conflicting settings in a
synchronized vault:

- Desktop: Obsidian Git → `SimpleGit` → local native Git.
- Mobile: Obsidian Git → `IsomorphicGit` → mobile Git implementation.
- Ignis: Obsidian Git → `IgnisGitManager` → vault-scoped HTTP API → native Git on the server.

Extend the existing server integration in `integrations/ignis/obsidian-git/`.
Keep native Git execution there; reuse its routing, vault resolution, request
restrictions, locking, and error handling. The `ignis/` checkout is read-only
reference material for understanding Ignis interfaces.

## Development principles

- Extend existing `GitManager` contracts, actions, UI, queues, and transport instead of creating parallel services or workflows.
- Preserve notes, staged and unstaged work, commits, and conflict reports; never use destructive recovery shortcuts.
- Resolve vaults server-side, validate paths, prevent competing repository mutations, and keep independent vaults isolated.
- Report actual repository state and actionable errors; confirm success only after completion and refresh affected views and Ignis filesystem caches.
- Coordinate Git mutations with browser editing and writes; disk status alone cannot establish that browser content is saved.
- Keep unsupported features explicitly unavailable and changes compatible with upstream abstractions.

## Incremental delivery

Build capabilities through focused stages: Pull, staging/unstaging, commit,
push, sync, history, diffs, branches/remotes, conflict workflows, and automation.
Each assigned capability must work across the server, manager, relevant UI entry
points, and tests. Unattended automation must run independently of browser tabs.
Preserve existing functionality and leave unrelated stages to their own tasks.

## Agent workflow

Read `GOAL.md` for direction and `TASK_<stage_name>.md` for the assigned scope,
requirements, and acceptance criteria. Inspect local code and the
[implementation inventory](integrations/ignis/obsidian-git/done.md) before adding
functionality. Keep stage-specific behavior, schedules, and progress in task
files.
