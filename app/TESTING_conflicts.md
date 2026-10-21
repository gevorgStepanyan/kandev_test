# Conflict and diff verification

## Local automated checks

No running Ignis, deployment credentials or production vault is needed. Use
Node >=24, pnpm >=11, native Git, and a non-root user (merge/Commit intentionally
refuse root). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run all
pnpm run test:ignis-bundle
```

For focused development:

```sh
pnpm exec vitest run tests/gitManager/ignisConflicts.test.ts tests/gitManager/ignisGit.test.ts tests/editor/conflicts/view.test.ts tests/ui/diff/splitDiffView.test.ts tests/automaticsManager.test.ts
pnpm run test:ignis-server
```

The frontend tests use the Obsidian stub and mocked HTTP. Server tests create
and remove temporary native repositories and local remotes. They cover true
merge state/stages, explicit/stale mutations, text/add-add/modify-delete/binary
conflicts, resolution races, safe/unsafe abort, restart reconstruction, true
merge commits (including identical resulting trees), staged-only merge policy,
reports, read-only diffs/index bytes, literal filenames, output limits,
unsupported operations, write checks, locks and the existing route restrictions.
They do not claim to exercise a live Obsidian editor or Ignis deployment.

## Deployment and fixture preparation (manual only)

Deploy `main.js`, `manifest.json`, `styles.css` and the complete
`integrations/ignis/obsidian-git/` directory using the existing
[installation instructions](integrations/ignis/obsidian-git/README.md). Recreate
or restart the service as appropriate, enable both plugins **for the test
vault**, and reload the browser. Inspect Docker logs using your deployment's
Compose file, for example `docker compose logs --tail=100 ignis`.

Run the following in one shell **inside the test container as the non-root
vault owner**. `VAULT_ROOT` must identify the configured vault root, not an
existing vault. It creates a new uniquely named test vault; its seed and local
bare remote live in a temporary directory. No production repository is used.
Run the block anew for each independent scenario; keep the printed paths.

```sh
set -eu
: "${VAULT_ROOT:?Set VAULT_ROOT to the configured container vault root}"
CASE_ROOT=$(mktemp -d /tmp/obsidian-git-conflicts.XXXXXX)
TEST_VAULT_PATH=$(mktemp -d "$VAULT_ROOT/GitConflictTest.XXXXXX")
TEST_VAULT_ID=$(basename "$TEST_VAULT_PATH")
git init --bare --initial-branch=main "$CASE_ROOT/remote.git"
git init --initial-branch=main "$CASE_ROOT/seed"
git -C "$CASE_ROOT/seed" config user.name 'Conflict Test'
git -C "$CASE_ROOT/seed" config user.email 'conflicts@example.invalid'
printf '.obsidian/\n' > "$CASE_ROOT/seed/.gitignore"
printf 'base\n' > "$CASE_ROOT/seed/note.md"
git -C "$CASE_ROOT/seed" add .
git -C "$CASE_ROOT/seed" commit -m 'Base fixture'
git -C "$CASE_ROOT/seed" remote add origin "$CASE_ROOT/remote.git"
git -C "$CASE_ROOT/seed" push -u origin main
git clone "$CASE_ROOT/remote.git" "$TEST_VAULT_PATH"
git -C "$TEST_VAULT_PATH" config user.name 'Conflict Test'
git -C "$TEST_VAULT_PATH" config user.email 'conflicts@example.invalid'
printf 'ours\n' > "$TEST_VAULT_PATH/note.md"
git -C "$TEST_VAULT_PATH" add note.md
git -C "$TEST_VAULT_PATH" commit -m 'Local test change'
printf 'theirs\n' > "$CASE_ROOT/seed/note.md"
git -C "$CASE_ROOT/seed" add note.md
git -C "$CASE_ROOT/seed" commit -m 'Incoming test change'
git -C "$CASE_ROOT/seed" push
printf 'Test vault ID: %s\nVault path: %s\nFixture path: %s\n' "$TEST_VAULT_ID" "$TEST_VAULT_PATH" "$CASE_ROOT"
```

Register/open the printed test vault in Ignis and install the browser plugin
there. Keep its configuration directory ignored; close editors and wait for
writes before mutations. Enable the server plugin for the printed vault ID.
Disable other Git jobs for this disposable vault while verifying this workflow.

## Manual browser checklist

- [ ] Open two tabs on the test vault. Pull reports divergence and creates an
      excluded diagnostic report. No merge begins until **Merge incoming changes**
      is confirmed. Cancel leaves HEAD/index/worktree unchanged.
- [ ] Confirm Merge in one tab; attempt an action using stale reviewed state in
      the second. It must reject stale requests and refresh, rather than repeat or
      overwrite the first tab's operation. A repository busy response is retryable
      after reviewing state.
- [ ] Conflicts lists `note.md`. Review base/ours/theirs and working resolution;
      compare using split diff. Confirm base=`base`, ours=`ours`, theirs=`theirs`.
- [ ] Open the note in live preview. Keep ours/theirs/both/base and manual edits
      use the ordinary editor/undo/save path. Mark resolved while an editable pane
      is open is blocked; switch to reading view and wait for successful saves.
- [ ] Remaining markers block ordinary resolution unless explicitly acknowledged
      as intentional literal text. Mark resolved moves the file from Conflicts to
      Staged. Edit again and verify staged vs unstaged diffs show different bytes.
- [ ] Review the staged diff and finish with the existing Commit button. A
      failed commit preserves the message/resolutions. A successful commit clears
      merge state and does not stage unrelated working edits or untracked notes.
- [ ] In a fresh fixture, start a merge and **before resolving** create an
      unrelated untracked note. Confirm Abort merge. Verify local commits, the note
      and pre-merge tracked content survive. Cancel abort leaves everything intact.
- [ ] In another fixture, edit/stage a resolution before Abort. It must block
      with recovery guidance and preserve edits. No hard-reset fallback is allowed.
- [ ] Reload the browser, disconnect/reconnect WebSocket, or restart the container
      during an unresolved merge. Conflicts/stages and merge state reconstruct from
      Git. If temporary fixture storage is not persistent across container recreation,
      preserve that storage for this check or test an ordinary container restart.
- [ ] Use additional fresh fixtures for a clean diverged merge (change different
      files on the two branches), fast-forward Pull (omit the local test commit),
      add/add (new file on both branches) and modify/delete (remove on one side).
      Clean divergence still waits for Commit; missing stages are visibly absent.
- [ ] Verify a binary/oversized file shows a notice and manual-resolution guidance;
      history/hunks/discard/rebase/cherry-pick controls remain unavailable.
- [ ] Keep a user-owned or tracked `git_conflict.md` in a separate fixture: it must
      never be overwritten or committed automatically. Actual Git state remains usable.
- [ ] Confirm ordinary Stage/Unstage and Commit outside merge state still work,
      including added/deleted/renamed files and a file edited again after staging.

Inspect only the disposable fixture when verifying native state:

```sh
git -C "$TEST_VAULT_PATH" status --porcelain=v1
git -C "$TEST_VAULT_PATH" ls-files -u
git -C "$TEST_VAULT_PATH" diff
git -C "$TEST_VAULT_PATH" diff --cached
git -C "$TEST_VAULT_PATH" log -1 --format='%H %P'
git -C "$TEST_VAULT_PATH" rev-parse --verify MERGE_HEAD
```

The last command is expected to fail after completion or successful abort.
A finished merge has two parents; `ls-files -u` is empty. Confirm the report
appends the corresponding completion/abort event and remains excluded. Remove
the disposable vault from Ignis and delete only the recorded fixture paths when
finished. Live deployment/editor/cache behavior remains a manual acceptance step.
