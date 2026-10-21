const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitService } = require("../obsidian-git/git-service");
const { GitServiceError } = require("../obsidian-git/errors");
const { mountRoutes } = require("../obsidian-git/routes");

// All repositories, identities and remote-tracking refs are test-local.
// Run as a non-root user: the production handler intentionally refuses root.
const git = (repo, ...args) =>
    execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            PATH: process.env.PATH,
            HOME: repo,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            LC_ALL: "C",
        },
    });
async function fixture(t, initial = true) {
    assert.notEqual(
        process.getuid(),
        0,
        "Run commit tests as a non-root vault-owning user."
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-commit-"));
    t.after(async () => {
        await fs.chmod(path.join(root, "Main", ".git"), 0o755).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    });
    const repo = path.join(root, "Main");
    await fs.mkdir(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Commit Test");
    git(repo, "config", "user.email", "commit@example.invalid");
    const service = new GitService({
        config: {
            vaultRoot: root,
            getVaultPath: (id) => (id === "Main" ? repo : null),
        },
        getEnabledVaults: () => ["Main"],
    });
    t.after(() => service.shutdown());
    const write = (file, data) => fs.writeFile(path.join(repo, file), data);
    const head = () => git(repo, "rev-parse", "HEAD").trim();
    const call = (mode = "staged", extra = {}) =>
        service.commit("Main", {
            mode,
            message: "message",
            amend: false,
            ...extra,
        });
    if (initial) {
        await write("note.md", "initial\n");
        await write("delete.md", "delete\n");
        await write("rename.md", "rename\n");
        git(repo, "add", ".");
        git(
            repo,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "initial"
        );
    }
    return { root, repo, service, write, head, call };
}

test("creates an initial real commit with exact message, identity, tree and count", async (t) => {
    const { repo, write, call } = await fixture(t, false);
    await write("雪.md", "first\n");
    git(repo, "add", ".");
    const message = "-- 雪 'quotes'\n\nbody $() `literal`\n";
    const result = await call("staged", { message });
    assert.equal(result.status, "committed");
    assert.equal(result.commit.files, 1);
    assert.equal(result.commit.hash, git(repo, "rev-parse", "HEAD").trim());
    assert.match(
        git(repo, "cat-file", "-p", "HEAD"),
        /author Commit Test <commit@example.invalid>/
    );
    assert.equal(
        git(repo, "show", "-s", "--format=%B", "HEAD"),
        message + "\n"
    );
    assert.equal(git(repo, "show", "HEAD:雪.md"), "first\n");
    assert.equal(git(repo, "diff", "--cached"), "");
});

test("staged commit preserves partially staged bytes and unrelated edits/untracked files", async (t) => {
    const { repo, write, call, head } = await fixture(t);
    const previous = head();
    await write("note.md", "staged\n");
    git(repo, "add", "note.md");
    const indexBlob = git(repo, "rev-parse", ":note.md");
    await write("note.md", "newer unsaved-on-index\n");
    await write("delete.md", "unselected\n");
    await write("untracked.md", "untouched\n");
    const result = await call();
    assert.equal(result.commit.files, 1);
    assert.equal(git(repo, "rev-parse", "HEAD:note.md"), indexBlob);
    assert.equal(git(repo, "rev-parse", "HEAD^").trim(), previous);
    assert.equal(
        await fs.readFile(path.join(repo, "note.md"), "utf8"),
        "newer unsaved-on-index\n"
    );
    assert.match(git(repo, "status", "--porcelain=v1", "-z"), / M note.md\0/);
    assert.match(
        git(repo, "status", "--porcelain=v1", "-z"),
        /\?\? untracked.md\0/
    );
    assert.equal(git(repo, "show", "HEAD:delete.md"), "delete\n");
});

test("all stages additions, binary modifications, deletions and rename endpoints, excluding ignored/report files", async (t) => {
    const { repo, write, call } = await fixture(t);
    await write(".gitignore", "ignored.md\n");
    await write("ignored.md", "private\n");
    await write("git_conflict.md", "preserved report\n");
    await write("new.md", "new\n");
    await write("note.md", Buffer.from([0, 1, 255, 2]));
    await fs.unlink(path.join(repo, "delete.md"));
    await fs.rename(
        path.join(repo, "rename.md"),
        path.join(repo, "renamed.md")
    );
    const result = await call("all");
    assert.equal(result.commit.files, 6); // distinct paths; a rename has two endpoints
    assert.equal(
        git(repo, "ls-tree", "--name-only", "HEAD").includes("ignored.md"),
        false
    );
    assert.equal(
        git(repo, "ls-tree", "--name-only", "HEAD").includes("git_conflict.md"),
        false
    );
    assert.equal(git(repo, "diff", "--cached"), "");
    assert.equal(git(repo, "show", "HEAD:new.md"), "new\n");
    assert.equal(
        await fs.readFile(path.join(repo, "git_conflict.md"), "utf8"),
        "preserved report\n"
    );
    assert.equal(
        git(
            repo,
            "show",
            "--format=",
            "--name-only",
            "--no-renames",
            "-z",
            "HEAD"
        )
            .split("\0")
            .filter(Boolean).length,
        6
    );
});

for (const fallback of [false, true])
    for (const staged of [false, true])
        test(`smart checks the locked index: staged=${staged}, fallback=${fallback}`, async (t) => {
            const { repo, write, call, head } = await fixture(t);
            const previous = head();
            await write("note.md", "staged or changed\n");
            await write("new.md", "untracked\n");
            if (staged) git(repo, "add", "note.md");
            const result = await call("smart", {
                autoStageOnEmptyIndex: fallback,
            });
            if (!staged && !fallback) {
                assert.equal(result.status, "nothing-to-commit");
                assert.equal(result.reason, "nothing-staged");
                assert.equal(head(), previous);
            } else {
                assert.equal(result.status, "committed");
                assert.equal(result.commit.files, staged ? 1 : 2);
                assert.equal(
                    git(
                        repo,
                        "rev-list",
                        "--count",
                        `${previous}..HEAD`
                    ).trim(),
                    "1"
                );
            }
        });

for (const mode of ["staged", "all"])
    test(`${mode} without delta is a no-op without HEAD movement`, async (t) => {
        const { repo, call, head } = await fixture(t);
        const previous = head();
        assert.equal((await call(mode)).status, "nothing-to-commit");
        assert.equal(head(), previous);
        assert.equal(git(repo, "status", "--porcelain=v1", "-z"), "");
    });

for (const message of ["", " \n\t", "nul\0value", "雪".repeat(6000), null])
    test(`invalid message is refused (${String(message).length} characters)`, async (t) => {
        const { repo, write, call, head } = await fixture(t);
        await write("new.md", "keep\n");
        const previous = head();
        await assert.rejects(call("all", { message }), {
            code: "INVALID_COMMIT_MESSAGE",
        });
        assert.equal(head(), previous);
        assert.equal(git(repo, "diff", "--cached"), "");
    });

for (const marker of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
])
    test(`refuses unfinished ${marker} even with a resolved index`, async (t) => {
        const { repo, write, call, head } = await fixture(t);
        await write("note.md", "resolved\n");
        git(repo, "add", "note.md");
        if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker))
            await fs.mkdir(path.join(repo, ".git", marker));
        else await fs.writeFile(path.join(repo, ".git", marker), head());
        const previous = head();
        await assert.rejects(call(), { code: "UNFINISHED_OPERATION" });
        assert.equal(head(), previous);
        assert.match(git(repo, "diff", "--cached"), /resolved/);
    });

test("refuses unmerged index and preserves every stage", async (t) => {
    const { repo, call, head } = await fixture(t);
    const hash = git(repo, "rev-parse", "HEAD:note.md").trim();
    execFileSync("git", ["update-index", "--index-info"], {
        cwd: repo,
        input: `0 ${"0".repeat(40)}\tnote.md\n100644 ${hash} 1\tnote.md\n100644 ${hash} 2\tnote.md\n100644 ${hash} 3\tnote.md\n`,
    });
    const index = git(repo, "ls-files", "--stage");
    const previous = head();
    await assert.rejects(call(), { code: "UNMERGED_INDEX" });
    assert.equal(head(), previous);
    assert.equal(git(repo, "ls-files", "--stage"), index);
});

test("refuses detached HEAD and Amend without history changes", async (t) => {
    const { repo, call, head } = await fixture(t);
    const previous = head();
    for (const mode of ["staged", "all"])
        await assert.rejects(call(mode, { amend: true }), {
            code: "AMEND_UNSUPPORTED",
        });
    git(repo, "checkout", "--detach");
    await assert.rejects(call(), { code: "DETACHED_HEAD" });
    assert.equal(head(), previous);
});

for (const state of ["staged", "tracked", "deleted"])
    test(`protects ${state} conflict report`, async (t) => {
        const { repo, write, call, head } = await fixture(t);
        await write("git_conflict.md", "keep report\n");
        git(repo, "add", "git_conflict.md");
        if (state !== "staged") git(repo, "commit", "-m", "legacy report");
        if (state === "deleted") git(repo, "rm", "--cached", "git_conflict.md");
        const previous = head();
        await assert.rejects(call("all"), { code: "CONFLICT_REPORT_STAGED" });
        assert.equal(head(), previous);
        assert.equal(
            await fs.readFile(path.join(repo, "git_conflict.md"), "utf8"),
            "keep report\n"
        );
    });

test("requires trusted identity, disables hooks/signing, and pins author/committer", async (t) => {
    const { repo, write, call, head } = await fixture(t);
    await write("note.md", "changed\n");
    git(repo, "config", "--unset", "user.email");
    const previous = head();
    await assert.rejects(call("all"), { code: "GIT_IDENTITY_MISSING" });
    assert.equal(head(), previous);
    git(repo, "config", "user.email", "commit@example.invalid");
    git(repo, "config", "author.email", "different@example.invalid");
    git(repo, "config", "committer.email", "different@example.invalid");
    git(repo, "config", "commit.gpgSign", "true");
    git(repo, "config", "gpg.program", "/does-not-exist");
    await fs.writeFile(
        path.join(repo, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nexit 1\n",
        { mode: 0o755 }
    );
    assert.equal((await call("all")).status, "committed");
    assert.match(
        git(repo, "cat-file", "-p", "HEAD"),
        /committer Commit Test <commit@example.invalid>/
    );
    assert.match(
        git(repo, "cat-file", "-p", "HEAD"),
        /author Commit Test <commit@example.invalid>/
    );
});

test("native failure after stage-all preserves staged work and reports it", async (t) => {
    const { repo, service, write, call, head } = await fixture(t);
    await write("new.md", "preserve\n");
    const previous = head();
    const run = service.run.bind(service);
    service.run = async (dir, args, ...rest) => {
        if (args.includes("commit"))
            throw new GitServiceError(
                "GIT_FAILED",
                "Git refused the operation."
            );
        return run(dir, args, ...rest);
    };
    await assert.rejects(
        call("all"),
        (e) => e.code === "GIT_FAILED" && /remain staged/.test(e.message)
    );
    assert.equal(head(), previous);
    assert.match(git(repo, "diff", "--cached", "--name-only"), /new.md/);
    assert.equal(
        await fs.readFile(path.join(repo, "new.md"), "utf8"),
        "preserve\n"
    );
});

for (const committed of [false, true])
    test(`timeout is uncertain, never retried (commit actually created=${committed})`, async (t) => {
        const { repo, service, write, call, head } = await fixture(t);
        await write("new.md", "preserve\n");
        const previous = head();
        const run = service.run.bind(service);
        let attempts = 0;
        service.run = async (dir, args, ...rest) => {
            if (args.includes("commit")) {
                attempts++;
                if (committed) await run(dir, args, ...rest);
                throw new GitServiceError("TIMEOUT", "Timed out.");
            }
            return run(dir, args, ...rest);
        };
        await assert.rejects(call("all"), {
            code: "GIT_COMMIT_OUTCOME_UNCERTAIN",
        });
        assert.equal(attempts, 1);
        assert.equal(head() !== previous, committed);
        assert.equal(
            git(repo, "rev-list", "--count", `${previous}..HEAD`).trim(),
            committed ? "1" : "0"
        );
    });

test("rejects root execution and readonly Git metadata", async (t) => {
    const { repo, write, call } = await fixture(t);
    await write("new.md", "data\n");
    t.mock.method(process, "getuid", () => 0);
    await assert.rejects(call("all"), { code: "OWNERSHIP" });
    t.mock.restoreAll();
    await fs.chmod(path.join(repo, ".git"), 0o555);
    await assert.rejects(call("all"), (e) =>
        ["AUTH_OR_PERMISSION", "PERMISSION_DENIED"].includes(e.code)
    );
    assert.equal(
        await fs.readFile(path.join(repo, "new.md"), "utf8"),
        "data\n"
    );
});

test("locks serialize Commit with Stage/Pull and refuse a competing tab", async (t) => {
    const { repo, service, write, call } = await fixture(t);
    await write("new.md", "new\n");
    const run = service.run.bind(service);
    let entered, release;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const barrier = new Promise((resolve) => {
        release = resolve;
    });
    service.run = async (dir, args, ...rest) => {
        if (args.includes("commit")) {
            entered();
            await barrier;
        }
        return run(dir, args, ...rest);
    };
    const first = call("all");
    await ready;
    await assert.rejects(call("all"), { code: "BUSY" });
    await assert.rejects(service.mutateIndex("Main", "unstage-all"), {
        code: "BUSY",
    });
    await assert.rejects(service.pull("Main"), { code: "BUSY" });
    release();
    assert.equal((await first).status, "committed");
    assert.equal((await call("all")).status, "nothing-to-commit");
    assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "2");
});

test("Commit reuses staging, status, outgoing count and Pull without network operations of its own", async (t) => {
    const { repo, service, write, call, head } = await fixture(t);
    const previous = head();
    git(repo, "update-ref", "refs/remotes/origin/main", previous);
    git(
        repo,
        "config",
        "remote.origin.url",
        "ssh://unreachable.invalid/never-contact"
    );
    git(
        repo,
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*"
    );
    git(repo, "config", "branch.main.remote", "origin");
    git(repo, "config", "branch.main.merge", "refs/heads/main");
    await write("new.md", "new\n");
    await service.mutateIndex("Main", "stage-all");
    const run = service.run.bind(service);
    const commands = [];
    service.run = async (dir, args, ...rest) => {
        commands.push(args);
        assert.equal(
            args.some((v) =>
                [
                    "fetch",
                    "pull",
                    "push",
                    "reset",
                    "stash",
                    "merge",
                    "rebase",
                    "clean",
                ].includes(v)
            ),
            false
        );
        return run(dir, args, ...rest);
    };
    await call();
    const state = await service.state("Main");
    assert.equal(state.unpushedCommits, 1);
    assert.deepEqual(state.status.staged, []);
    assert.ok(state.lastCommitTime);
    assert.equal(
        commands.some((args) => args[0] === "add"),
        false
    );
    assert.equal(
        git(repo, "config", "remote.origin.url").trim(),
        "ssh://unreachable.invalid/never-contact"
    );
});

test("Commit rejects external repositories, submodules and unauthorized vault IDs", async (t) => {
    const { repo, service, call, head } = await fixture(t);
    await assert.rejects(service.commit("Other", {}), { code: "DISABLED" });
    await assert.rejects(service.commit("../Main", {}), {
        code: "INVALID_VAULT",
    });
    git(
        repo,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head()},module`
    );
    await assert.rejects(call(), { code: "UNSUPPORTED_LAYOUT" });
    git(repo, "update-index", "--force-remove", "module");
    await fs.rename(path.join(repo, ".git"), path.join(repo, ".outside-git"));
    await fs.writeFile(path.join(repo, ".git"), "gitdir: .outside-git\n");
    await assert.rejects(call(), { code: "UNSUPPORTED_LAYOUT" });
});

test("commit route rejects unknown fields/modes/types and preserves the shared origin boundary", async (t) => {
    const { service } = await fixture(t);
    const handlers = {};
    let guard;
    mountRoutes(
        {
            use: (fn) => {
                guard = fn;
            },
            get() {},
            post: (route, fn) => {
                handlers[route] = fn;
            },
        },
        service,
        { enabled: true, origin: "https://ignis.test" }
    );
    const res = {
        code: 200,
        status(code) {
            this.code = code;
            return this;
        },
        json(value) {
            this.value = value;
        },
        set() {},
    };
    const req = {
        method: "POST",
        headers: { origin: "https://ignis.test", "x-obsidian-git": "1" },
        is: () => true,
        body: { vaultId: "Main", mode: "staged", message: "msg", amend: false },
    };
    let accepted = false;
    guard(req, res, () => {
        accepted = true;
    });
    assert.equal(accepted, true);
    for (const extra of [
        { path: "/outside" },
        { flags: ["--amend"] },
        { author: "attacker" },
        { mode: "unknown" },
        { amend: "false" },
        { mode: "smart", autoStageOnEmptyIndex: "true" },
    ]) {
        await handlers["/commit"](
            { ...req, body: { ...req.body, ...extra } },
            res
        );
        assert.equal(res.code, 400);
        assert.equal(res.value.error.code, "INVALID_REQUEST");
    }
    for (const headers of [
        { origin: "https://evil.test", "x-obsidian-git": "1" },
        { origin: "https://ignis.test" },
        {},
    ]) {
        guard({ ...req, headers }, res, () =>
            assert.fail("untrusted request accepted")
        );
        assert.equal(res.code, 403);
    }
    guard({ ...req, is: () => false }, res, () =>
        assert.fail("non-JSON accepted")
    );
    assert.equal(res.code, 403);
});

test("initial no-op stays unborn and a second staged request does not make an empty commit", async (t) => {
    const { repo, write, call } = await fixture(t, false);
    assert.equal((await call()).status, "nothing-to-commit");
    assert.throws(() => git(repo, "rev-parse", "--verify", "HEAD"));
    await write("new.md", "new\n");
    git(repo, "add", "new.md");
    await call();
    assert.equal((await call()).status, "nothing-to-commit");
    assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(git(repo, "ls-files", "--stage").includes("new.md"), true);
});

test("large staged blobs are blocked using native object size, leaving data staged", async (t) => {
    const { repo, write, call, head } = await fixture(t);
    await write("large.bin", "");
    await fs.truncate(path.join(repo, "large.bin"), 100000000);
    git(repo, "add", "large.bin");
    const previous = head();
    await assert.rejects(call(), { code: "FILE_TOO_LARGE" });
    assert.equal(head(), previous);
    assert.match(git(repo, "diff", "--cached", "--name-only"), /large.bin/);
    assert.equal((await fs.stat(path.join(repo, "large.bin"))).size, 100000000);
});

test("detects external index changes between validation and commit, without retry or destructive recovery", async (t) => {
    const { repo, service, write, call, head } = await fixture(t);
    const previous = head();
    await write("new.md", "selected\n");
    const run = service.run.bind(service);
    service.run = async (dir, args, ...rest) => {
        if (args.includes("commit")) {
            await write("external.md", "external\n");
            git(repo, "add", "external.md");
        }
        return run(dir, args, ...rest);
    };
    await assert.rejects(call("all"), { code: "GIT_COMMIT_OUTCOME_UNCERTAIN" });
    assert.notEqual(head(), previous);
    assert.equal(git(repo, "show", "HEAD:external.md"), "external\n");
});

test("independent authorized vault can commit while the first vault is locked", async (t) => {
    const { root, repo, service, write } = await fixture(t);
    const second = path.join(root, "Work");
    await fs.mkdir(second);
    git(second, "init", "--initial-branch=main");
    git(second, "config", "user.name", "Other Vault");
    git(second, "config", "user.email", "other@example.invalid");
    await fs.writeFile(path.join(second, "other.md"), "other\n");
    service.ctx.config.getVaultPath = (id) =>
        ({ Main: repo, Work: second })[id];
    service.ctx.getEnabledVaults = () => ["Main", "Work"];
    let release, entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const held = service.locked("Main", async () => {
        entered();
        await new Promise((resolve) => {
            release = resolve;
        });
    });
    await ready;
    try {
        const result = await service.commit("Work", {
            mode: "all",
            message: "independent",
            amend: false,
        });
        assert.equal(result.commit.files, 1);
        assert.equal(git(second, "show", "HEAD:other.md"), "other\n");
        await write("new.md", "not included in other vault\n");
        assert.equal(
            git(second, "ls-tree", "--name-only", "HEAD").includes("new.md"),
            false
        );
    } finally {
        release();
        await held;
    }
});

test("Commit after a real local Pull and Stage preserves the existing graph and routes", async (t) => {
    const { root, repo, service, write, call, head } = await fixture(t);
    const origin = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    await fs.mkdir(origin);
    git(origin, "init", "--bare", "--initial-branch=main");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    git(root, "clone", origin, seed);
    git(seed, "config", "user.name", "Remote Fixture");
    git(seed, "config", "user.email", "remote@example.invalid");
    await fs.writeFile(path.join(seed, "incoming.md"), "incoming\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "incoming");
    git(seed, "push");
    assert.equal((await service.pull("Main")).status, "updated");
    const pulled = head();
    await write("note.md", "local staged after pull\n");
    await service.mutateIndex("Main", "stage", "note.md");
    assert.equal((await call()).commit.files, 1);
    assert.equal(git(repo, "rev-parse", "HEAD^").trim(), pulled);
    assert.equal(git(repo, "show", "HEAD:incoming.md"), "incoming\n");
    assert.equal((await service.state("Main")).unpushedCommits, 1);
    assert.equal((await service.pull("Main")).status, "up-to-date");
});
