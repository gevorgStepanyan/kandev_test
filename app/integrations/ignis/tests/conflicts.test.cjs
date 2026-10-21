const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitService } = require("../obsidian-git/git-service");
const { mountRoutes } = require("../obsidian-git/routes");
const git = (repo, ...args) =>
    execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
async function fixture(t, kind = "content") {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-conflicts-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, "Main");
    await fs.mkdir(repo);
    const write = (file, text) => fs.writeFile(path.join(repo, file), text);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    await write("note.md", "base\n");
    await write("second.md", "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "switch", "-c", "incoming");
    if (kind === "clean") await write("remote.md", "incoming\n");
    else if (kind === "add-add") await write("added.md", "theirs\n");
    else if (kind === "delete") await fs.unlink(path.join(repo, "note.md"));
    else
        await write(
            "note.md",
            kind === "binary"
                ? Buffer.from([0, 2, 3])
                : kind === "identical"
                  ? "same\n"
                  : "theirs\n"
        );
    if (kind === "multiple") await write("second.md", "theirs\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "incoming");
    git(repo, "switch", "main");
    if (kind === "clean") await write("local.md", "local\n");
    else if (kind === "add-add") await write("added.md", "ours\n");
    else
        await write(
            "note.md",
            kind === "binary"
                ? Buffer.from([0, 1, 3])
                : kind === "identical"
                  ? "same\n"
                  : "ours\n"
        );
    if (kind === "multiple") await write("second.md", "ours\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "local");
    git(repo, "branch", "--set-upstream-to=incoming", "main");
    const ctx = {
        config: {
            vaultRoot: root,
            getVaultPath: (id) => (id === "Main" ? repo : undefined),
        },
        getEnabledVaults: () => ["Main"],
    };
    const service = new GitService(ctx);
    t.after(() => service.shutdown());
    const start = async (extra = {}) => {
        const current = await service.mergeState("Main");
        return service.mergeAction("Main", "start", {
            expectedHead: current.head,
            expectedUpstream: current.upstream.oid,
            confirmed: true,
            ...extra,
        });
    };
    const resolve = async (file, extra = {}) => {
        const details = await service.conflictDetails("Main", { path: file });
        return service.mergeAction("Main", "resolve", {
            path: file,
            expectedHead: details.merge.head,
            expectedMergeHead: details.merge.mergeHead,
            expectedHash: details.contents.worktree.hash,
            confirmed: true,
            ...extra,
        });
    };
    const commit = (mode = "staged") =>
        service.commit("Main", {
            mode,
            message: "Finish merge",
            amend: false,
            ...(mode === "smart" ? { autoStageOnEmptyIndex: true } : {}),
        });
    return { repo, service, ctx, write, start, resolve, commit };
}
test("clean diverged merge waits for Commit, preserves unrelated work and creates two parents", async (t) => {
    const f = await fixture(t, "clean");
    const before = await f.service.mergeState("Main");
    assert.equal(before.kind, "diverged");
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    const current = await f.start();
    assert.equal(current.kind, "merge-awaiting-commit");
    assert.equal(git(f.repo, "rev-parse", "HEAD"), before.head);
    await f.write("unrelated.md", "new note\n");
    const result = await f.commit("all");
    assert.equal(result.status, "committed");
    assert.deepEqual(
        git(f.repo, "show", "-s", "--format=%P", "HEAD").split(" "),
        [before.head, before.upstream.oid]
    );
    assert.equal((await f.service.mergeState("Main")).operation, "none");
    assert.equal(git(f.repo, "ls-files", "--", "unrelated.md"), "");
    assert.equal(git(f.repo, "ls-files", "--", "git_conflict.md"), "");
    const report = await fs.readFile(
        path.join(f.repo, "git_conflict.md"),
        "utf8"
    );
    assert.match(report, /finish merge commit/i);
    assert.match(report, /Merge complete/);
});

test("a merge with the same resulting tree still commits both parents with an accurate zero-file count", async (t) => {
    const f = await fixture(t, "identical");
    const state = await f.start();
    assert.equal(state.kind, "merge-awaiting-commit");
    assert.equal((await f.service.status(f.repo)).staged.length, 0);
    const result = await f.commit();
    assert.equal(result.status, "committed");
    assert.equal(result.commit.files, 0);
    assert.deepEqual(
        git(f.repo, "show", "-s", "--format=%P", "HEAD").split(" "),
        [state.head, state.mergeHead]
    );
});
test("text conflicts retain exact stages, reconstruct after restart and resolve via existing Commit", async (t) => {
    const f = await fixture(t);
    const original = await f.service.mergeState("Main");
    const current = await f.start();
    assert.equal(current.kind, "merge-conflicted");
    assert.equal(current.canCommitMerge, false);
    assert.match(git(f.repo, "ls-files", "-u"), / 1\tnote.md/);
    const details = await f.service.conflictDetails("Main", {
        path: "note.md",
    });
    assert.equal(details.contents.base.text, "base\n");
    assert.equal(details.contents.ours.text, "ours\n");
    assert.equal(details.contents.theirs.text, "theirs\n");
    const restarted = new GitService(f.ctx);
    t.after(() => restarted.shutdown());
    assert.equal((await restarted.mergeState("Main")).kind, "merge-conflicted");
    await assert.rejects(f.resolve("note.md"), {
        code: "CONFLICT_NOT_RESOLVED",
    });
    await assert.rejects(f.commit(), { code: "UNMERGED_INDEX" });
    await assert.rejects(f.service.mutateIndex("Main", "stage-all"), {
        code: "UNMERGED_PATH",
    });
    await f.write("note.md", "chosen resolution\n");
    assert.equal((await f.resolve("note.md")).canCommitMerge, true);
    assert.equal(git(f.repo, "ls-files", "-u"), "");
    await f.write("note.md", "later unstaged edit\n");
    await f.commit("smart");
    assert.equal(git(f.repo, "show", "HEAD:note.md"), "chosen resolution");
    assert.equal(
        await fs.readFile(path.join(f.repo, "note.md"), "utf8"),
        "later unstaged edit\n"
    );
    assert.equal(
        git(f.repo, "show", "-s", "--format=%P", "HEAD"),
        `${original.head} ${original.upstream.oid}`
    );
});
test("resolving one of two files leaves the second authoritative unmerged path", async (t) => {
    const f = await fixture(t, "multiple");
    await f.start();
    await f.write("note.md", "resolved\n");
    const current = await f.resolve("note.md");
    assert.deepEqual(
        current.unresolvedPaths.map((v) => v.path),
        ["second.md"]
    );
    await assert.rejects(f.commit(), { code: "UNMERGED_INDEX" });
    await assert.rejects(f.service.mutateIndex("Main", "unstage", "note.md"), {
        code: "UNSUPPORTED_OPERATION",
    });
});
for (const keep of ["file", "delete"])
    test(`modify/delete conflict supports explicit keep-${keep}`, async (t) => {
        const f = await fixture(t, "delete");
        await f.start();
        const details = await f.service.conflictDetails("Main", {
            path: "note.md",
        });
        assert.equal(details.contents.theirs.kind, "missing");
        assert.deepEqual(details.availableStages, [1, 2]);
        if (keep === "delete") {
            await fs.unlink(path.join(f.repo, "note.md"));
            await assert.rejects(f.resolve("note.md"), {
                code: "CONFLICT_NOT_RESOLVED",
            });
        }
        await f.resolve("note.md", { delete: keep === "delete" });
        await f.commit();
        assert.equal(
            git(f.repo, "ls-files", "--", "note.md"),
            keep === "delete" ? "" : "note.md"
        );
    });
test("add/add correctly reports missing base; binary stages are not decoded as text", async (t) => {
    const f = await fixture(t, "add-add");
    await f.start();
    const added = await f.service.conflictDetails("Main", { path: "added.md" });
    assert.equal(added.contents.base.kind, "missing");
    assert.deepEqual(added.availableStages, [2, 3]);
    const b = await fixture(t, "binary");
    await b.start();
    const binary = await b.service.conflictDetails("Main", { path: "note.md" });
    assert.equal(binary.contents.ours.kind, "binary");
    await assert.rejects(b.resolve("note.md"), {
        code: "UNSUPPORTED_OPERATION",
    });
});
test("stale merge, stale stage and unconfirmed mutation leave files and index intact", async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.start({ expectedHead: "a".repeat(40) }), {
        code: "STALE_MERGE_STATE",
    });
    await assert.rejects(f.start({ confirmed: false }), {
        code: "INVALID_REQUEST",
    });
    await f.write("untracked.md", "keep\n");
    await assert.rejects(f.start(), { code: "WORKTREE_DIRTY" });
    await fs.unlink(path.join(f.repo, "untracked.md"));
    await f.start();
    await f.write("note.md", "resolved\n");
    const index = git(f.repo, "ls-files", "--stage");
    await assert.rejects(f.resolve("note.md", { expectedHash: "old" }), {
        code: "STALE_MERGE_STATE",
    });
    assert.equal(git(f.repo, "ls-files", "--stage"), index);
});

test("removed abort functionality cannot change a pending merge", async (t) => {
    const f = await fixture(t);
    await f.start();
    const before = git(f.repo, "ls-files", "--stage");
    const contents = await fs.readFile(path.join(f.repo, "note.md"));
    assert.equal(require("../obsidian-git/merge").abort, undefined);
    await assert.rejects(f.service.mergeAction("Main", "abort", {}), {
        code: "UNSUPPORTED_OPERATION",
    });
    assert.equal(git(f.repo, "ls-files", "--stage"), before);
    assert.deepEqual(await fs.readFile(path.join(f.repo, "note.md")), contents);
    const current = await f.service.mergeState("Main");
    assert.equal(current.operation, "merge");
    assert.equal(Object.hasOwn(current, "canAbortMerge"), false);
    await assert.rejects(
        fs.stat(path.join(f.repo, ".git", "obsidian-git-merge.json")),
        { code: "ENOENT" }
    );
    const handlers = {};
    mountRoutes(
        {
            use() {},
            get() {},
            post(route, handle) {
                handlers[route] = handle;
            },
        },
        f.service,
        {
            enabled: true,
            origin: "https://test.invalid",
            reconcile: async () => {},
        }
    );
    assert.equal(handlers["/merge/abort"], undefined);
});

test("a pending merge from an older integration still finishes with Commit", async (t) => {
    const f = await fixture(t);
    const before = await f.start();
    const legacy = path.join(f.repo, ".git", "obsidian-git-merge.json");
    await fs.writeFile(legacy, "legacy abort metadata\n");
    await f.write("note.md", "resolved\n");
    await f.resolve("note.md");
    await f.commit();
    assert.deepEqual(
        git(f.repo, "show", "-s", "--format=%P", "HEAD").split(" "),
        [before.head, before.mergeHead]
    );
    assert.equal((await f.service.mergeState("Main")).operation, "none");
    assert.equal(await fs.readFile(legacy, "utf8"), "legacy abort metadata\n");
});
test("a write racing stage is detected and the original conflict index restored", async (t) => {
    const f = await fixture(t);
    await f.start();
    await f.write("note.md", "resolved\n");
    const index = git(f.repo, "ls-files", "--stage");
    const run = f.service.run.bind(f.service);
    f.service.run = async (repo, args, ...rest) => {
        if (args[0] === "add") await f.write("note.md", "raced edit\n");
        return run(repo, args, ...rest);
    };
    await assert.rejects(f.resolve("note.md"), { code: "STALE_MERGE_STATE" });
    assert.equal(git(f.repo, "ls-files", "--stage"), index);
    assert.equal(
        await fs.readFile(path.join(f.repo, "note.md"), "utf8"),
        "raced edit\n"
    );
});
test("worktree/index diffs and head/index snapshots are distinct and read only", async (t) => {
    const f = await fixture(t, "clean");
    await f.write("note.md", "staged\n");
    await f.service.mutateIndex("Main", "stage", "note.md");
    await f.write("note.md", "unstaged\n");
    const head = git(f.repo, "rev-parse", "HEAD"),
        index = git(f.repo, "ls-files", "--stage");
    assert.match(
        (await f.service.fileDiff("Main", { path: "note.md", kind: "staged" }))
            .diff,
        /\+staged/
    );
    const diff = (
        await f.service.fileDiff("Main", { path: "note.md", kind: "unstaged" })
    ).diff;
    assert.match(diff, /-staged/);
    assert.match(diff, /\+unstaged/);
    assert.equal(
        (
            await f.service.fileContent("Main", {
                path: "note.md",
                source: "head",
            })
        ).text,
        "base\n"
    );
    assert.equal(
        (
            await f.service.fileContent("Main", {
                path: "note.md",
                source: "index",
            })
        ).text,
        "staged\n"
    );
    assert.equal(git(f.repo, "rev-parse", "HEAD"), head);
    assert.equal(git(f.repo, "ls-files", "--stage"), index);
    assert.equal(
        await fs.readFile(path.join(f.repo, "note.md"), "utf8"),
        "unstaged\n"
    );
});
for (const file of [
    "-dash.md",
    'space "quote".md',
    "new\nline.md",
    "文.md",
    ":(glob)*.md",
])
    test(`literal diff and content path ${JSON.stringify(file)}`, async (t) => {
        const f = await fixture(t, "clean");
        await f.write(file, "literal\n");
        const diff = await f.service.fileDiff("Main", {
            path: file,
            kind: "unstaged",
        });
        assert.match(diff.diff, /\+literal/);
        await f.service.mutateIndex("Main", "stage", file);
        assert.equal(
            (
                await f.service.fileContent("Main", {
                    path: file,
                    source: "index",
                })
            ).text,
            "literal\n"
        );
        const staged = await f.service.fileDiff("Main", {
            path: file,
            kind: "staged",
        });
        assert.match(staged.diff, /\+literal/);
    });
test("deleted, renamed, empty, binary, non-UTF8 and oversized snapshots are explicit", async (t) => {
    const f = await fixture(t, "clean");
    assert.equal(
        (
            await f.service.fileDiff("Main", {
                path: "note.md",
                kind: "unstaged",
            })
        ).diff,
        ""
    );
    await fs.unlink(path.join(f.repo, "note.md"));
    assert.match(
        (
            await f.service.fileDiff("Main", {
                path: "note.md",
                kind: "unstaged",
            })
        ).diff,
        /-base/
    );
    git(f.repo, "mv", "second.md", "renamed.md");
    assert.match(
        (
            await f.service.fileDiff("Main", {
                path: "renamed.md",
                kind: "staged",
            })
        ).diff,
        /rename from second.md/
    );
    for (const bytes of [Buffer.from([0, 2]), Buffer.from([255])]) {
        await f.write("binary.md", bytes);
        assert.equal(
            (
                await f.service.fileContent("Main", {
                    path: "binary.md",
                    source: "worktree",
                })
            ).kind,
            "binary"
        );
    }
    await f.write("large.md", "x".repeat(1024 * 1024 + 1));
    assert.equal(
        (
            await f.service.fileContent("Main", {
                path: "large.md",
                source: "worktree",
            })
        ).kind,
        "oversized"
    );
});
test("all read endpoints validate paths, sources, vault authorization, symlinks and output bounds", async (t) => {
    const f = await fixture(t, "clean");
    for (const file of [
        "../escape",
        "/etc/passwd",
        ".git/config",
        "a/../b",
        "a\\b",
        "x\0y",
    ]) {
        await assert.rejects(
            f.service.fileDiff("Main", { path: file, kind: "unstaged" }),
            { code: "INVALID_PATH" }
        );
        await assert.rejects(
            f.service.fileContent("Main", { path: file, source: "worktree" }),
            { code: "INVALID_PATH" }
        );
    }
    await assert.rejects(
        f.service.fileContent("Other", { path: "note.md", source: "head" }),
        { code: "DISABLED" }
    );
    await assert.rejects(
        f.service.fileContent("Main", {
            path: "note.md",
            source: "HEAD~1:.git/config",
        }),
        { code: "INVALID_REQUEST" }
    );
    await assert.rejects(
        f.service.fileDiff("Main", { path: "note.md", kind: "bad" }),
        { code: "INVALID_REQUEST" }
    );
    const limited = new GitService(f.ctx, { maxOutput: 100 });
    t.after(() => limited.shutdown());
    await f.write("note.md", "z".repeat(2000));
    await assert.rejects(
        limited.fileDiff("Main", { path: "note.md", kind: "unstaged" }),
        { code: "OUTPUT_LIMIT" }
    );
    await fs.symlink(os.tmpdir(), path.join(f.repo, "escape"));
    await assert.rejects(
        f.service.fileContent("Main", {
            path: "escape/file",
            source: "worktree",
        }),
        { code: "UNSUPPORTED_LAYOUT" }
    );
});
test("new routes inherit common origin/JSON/header checks and exact field validation", async () => {
    const handlers = {};
    let guard;
    mountRoutes(
        {
            use: (fn) => (guard = fn),
            get: (p, fn) => (handlers[`GET ${p}`] = fn),
            post: (p, fn) => (handlers[`POST ${p}`] = fn),
        },
        {},
        {
            enabled: true,
            origin: "https://test.invalid",
            reconcile: async () => {},
        }
    );
    for (const [key, handle] of Object.entries(handlers)) {
        if (!/merge|diff|content|conflicts|mark-resolved/.test(key)) continue;
        const [method] = key.split(" ");
        let code;
        const res = {
            status(v) {
                code = v;
                return this;
            },
            json() {},
            set() {},
        };
        let allowed = false;
        guard(
            {
                method,
                headers: { origin: "https://evil.invalid" },
                is: () => true,
            },
            res,
            () => (allowed = true)
        );
        assert.equal(code, 403);
        assert.equal(allowed, false);
        const input = { vaultId: "Main", unexpected: "--exec" };
        await handle({ method, body: input, query: input }, res);
        assert.equal(code, 400);
    }
});
test("owned reports append, while edited or user-owned reports remain untouched", async (t) => {
    const f = await fixture(t);
    await f.start();
    const report = path.join(f.repo, "git_conflict.md");
    const original = await fs.readFile(report, "utf8");
    await fs.writeFile(report, original + "user edits\n");
    await f.write("note.md", "resolved\n");
    await f.resolve("note.md");
    assert.equal(await fs.readFile(report, "utf8"), original + "user edits\n");
});

test("diagnostic reporting never recreates a tracked report deleted by its owner", async (t) => {
    const f = await fixture(t, "clean");
    await f.write("git_conflict.md", "user-owned\n");
    git(f.repo, "add", "git_conflict.md");
    git(f.repo, "commit", "-m", "user report");
    await fs.unlink(path.join(f.repo, "git_conflict.md"));
    await assert.rejects(f.service.pull("Main"), {
        code: "PULL_BLOCKED_DIRTY",
    });
    await assert.rejects(fs.stat(path.join(f.repo, "git_conflict.md")), {
        code: "ENOENT",
    });
});

test("tracked diffs identify binary, invalid UTF-8 and oversized inputs before rendering", async (t) => {
    for (const [bytes, kind] of [
        [Buffer.from([0, 2, 3]), "binary"],
        [Buffer.from([255]), "binary"],
        [Buffer.from("x".repeat(1024 * 1024 + 1)), "oversized"],
    ]) {
        const f = await fixture(t, "clean");
        await f.write("note.md", bytes);
        assert.deepEqual(
            await f.service.fileDiff("Main", {
                path: "note.md",
                kind: "unstaged",
            }),
            { kind, diff: "" }
        );
        git(f.repo, "add", "note.md");
        assert.deepEqual(
            await f.service.fileDiff("Main", {
                path: "note.md",
                kind: "staged",
            }),
            { kind, diff: "" }
        );
    }
});

test("diff and status reads preserve the index bytes, including cached file metadata", async (t) => {
    const f = await fixture(t, "clean");
    await f.write("note.md", "changed on disk\n");
    const indexPath = path.join(f.repo, ".git", "index");
    const before = await fs.readFile(indexPath);
    await f.service.state("Main");
    await f.service.fileDiff("Main", { path: "note.md", kind: "unstaged" });
    await f.service.fileContent("Main", { path: "note.md", source: "index" });
    assert.deepEqual(await fs.readFile(indexPath), before);
});

for (const metadata of ["REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    test(`${metadata} permits inspection but blocks staging and merge-only actions`, async (t) => {
        const f = await fixture(t, "clean");
        const head = git(f.repo, "rev-parse", "HEAD");
        await fs.writeFile(path.join(f.repo, ".git", metadata), head + "\n");
        await f.write("note.md", "preserve\n");
        for (const operation of [
            "stage",
            "stage-all",
            "unstage",
            "unstage-all",
        ])
            await assert.rejects(
                f.service.mutateIndex(
                    "Main",
                    operation,
                    operation.endsWith("-all") ? undefined : "note.md"
                ),
                { code: "UNSUPPORTED_OPERATION" }
            );
        await assert.rejects(f.start(), { code: "MERGE_IN_PROGRESS" });
        assert.match(
            (
                await f.service.fileDiff("Main", {
                    path: "note.md",
                    kind: "unstaged",
                })
            ).diff,
            /\+preserve/
        );
        assert.equal((await f.service.state("Main")).mergeInProgress, true);
    });
}

test("orphaned unmerged stages block automatics even without MERGE_HEAD", async (t) => {
    const f = await fixture(t);
    await f.start();
    await fs.unlink(path.join(f.repo, ".git", "MERGE_HEAD"));
    const state = await f.service.state("Main");
    assert.equal(state.merge.operation, "other");
    assert.equal(state.mergeInProgress, true);
    assert.equal(state.merge.canCommitMerge, false);
    assert.deepEqual(state.status.conflicted, ["note.md"]);
});

test("merge and resolve share the existing repository lock", async (t) => {
    const f = await fixture(t);
    await f.service.locked("Main", async () => {
        for (const action of ["start", "resolve"])
            await assert.rejects(f.service.mergeAction("Main", action, {}), {
                code: "BUSY",
            });
    });
    await f.start();
    assert.equal((await f.service.mergeState("Main")).kind, "merge-conflicted");
});

test("pending server writes block merge and resolving without changing Git state", async (t) => {
    const f = await fixture(t);
    f.service.pendingWrites = () => [path.join(f.repo, "note.md")];
    await assert.rejects(f.start(), { code: "BROWSER_DIRTY" });
    assert.equal((await f.service.mergeState("Main")).operation, "none");
    f.service.pendingWrites = () => [];
    await f.start();
    await f.write("note.md", "saved resolution\n");
    f.service.pendingWrites = () => [path.join(f.repo, "note.md")];
    await assert.rejects(f.resolve("note.md"), { code: "BROWSER_DIRTY" });
    assert.equal((await f.service.mergeState("Main")).kind, "merge-conflicted");
});
