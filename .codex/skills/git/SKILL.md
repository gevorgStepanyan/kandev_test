---
name: "git"
description: "Use whenever you need to work with Git: checking repository status, viewing diffs, staging files, committing changes, or considering any git command."
---

# Git Skill

This container uses local Git. All remote operations will fail and are not allowed.

## Allowed commands

Only these Git commands are allowed:

```bash
git status
git diff
git add .
git commit -m "Add login feature"
```

The commit message can change, but the command shape must stay exactly:

```bash
git commit -m "<message>"
```

## Required workflow

When you need to inspect or commit repository changes, use this exact flow:

```bash
git status
git diff
git add .
git commit -m "<clear commit message>"
```

Use `git diff` before staging or committing unless the user explicitly asked only for status.

## Stop-and-report rule

If any Git command fails with an error telling you to stop, follow this stop-and-report rule:

1. Stop immediately.
2. Do not try another Git command.
3. Report to the user:
   - the operation you attempted,
   - the exact command,
   - the exact error message,
   - the reason you stopped.

Do not attempt to bypass the restriction.

## Branch rule

All of your branches must start with the `ai_` prefix. The server only allows AI-agent Git operations on branches whose names start with:

```text
ai_
```

If Git reports that the current branch is not allowed, stop and report that only branches with the `ai_` prefix are allowed for AI agents.

## Workflow rule

You are allowed to use Git worktrees.

## Forbidden commands

Never run any Git command except the allowed commands above.

Forbidden examples include, but are not limited to:

```bash
git remote
git config
git credential
git ls-remote
git clone
git submodule
git tag
git blame
git rev-parse
git cat-file
gh
```

Do not request tokens, credentials, remotes, user identity, GitHub identity, SSH configuration, or credential helper data.
