const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitService } = require("../obsidian-git/git-service");
const { mountRoutes } = require("../obsidian-git/routes");

const git = (dir, ...args) =>
    execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-git-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vaultRoot = path.join(root, "vaults"),
        repo = path.join(vaultRoot, "Main"),
        origin = path.join(root, "origin"),
        seed = path.join(root, "seed");
    await fs.mkdir(vaultRoot);
    await fs.mkdir(origin);
    await fs.mkdir(seed);
    git(origin, "init", "--bare", "--initial-branch=main");
    git(seed, "init", "--initial-branch=main");
    for (const dir of [seed]) {
        git(dir, "config", "user.name", "Test");
        git(dir, "config", "user.email", "test@example.com");
    }
    await fs.writeFile(path.join(seed, "note.md"), "initial\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "main");
    git(vaultRoot, "clone", origin, repo);
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    const ctx = {
        config: {
            vaultRoot,
            getVaultPath: (id) => (id === "Main" ? repo : null),
        },
        getEnabledVaults: () => ["Main"],
    };
    const service = new GitService(ctx);
    t.after(() => service.shutdown());
    const advance = async (file = "note.md", text = "remote\n") => {
        await fs.writeFile(path.join(seed, file), text);
        git(seed, "add", ".");
        git(seed, "commit", "-m", "remote");
        git(seed, "push");
    };
    return { root, repo, seed, service, ctx, advance };
}

test("reads real repository state and returns up-to-date without writes", async (t) => {
    const { service, repo } = await fixture(t);
    assert.deepEqual(await service.health("Main"), { requirements: "valid" });
    const state = await service.state("Main");
    assert.equal(state.branch.current, "main");
    assert.equal(state.branch.tracking, "origin/main");
    assert.equal(state.mergeInProgress, false);
    assert.equal(state.unpushedCommits, 0);
    assert.deepEqual(state.status.all, []);
    assert.equal(
        await service.pull("Main").then((r) => r.status),
        "up-to-date"
    );
    assert.equal(git(repo, "status", "--porcelain"), "");
});
test("fast-forwards using the configured upstream and handles unusual filenames", async (t) => {
    const { service, repo, advance } = await fixture(t);
    const name = 'space "and\nnewline.md';
    await advance(name, "remote data\n");
    const result = await service.pull("Main");
    assert.equal(result.status, "updated");
    assert.deepEqual(result.files, [
        { path: name, vaultPath: name, index: " ", workingDir: "A" },
    ]);
    assert.equal(
        await fs.readFile(path.join(repo, name), "utf8"),
        "remote data\n"
    );
    assert.equal(git(repo, "status", "--porcelain"), "");
});
for (const mode of ["modified", "staged", "untracked"])
    test(`blocks ${mode} work and creates an excluded report`, async (t) => {
        const { service, repo, advance } = await fixture(t);
        await advance();
        const file = mode === "untracked" ? "local.md" : "note.md";
        await fs.writeFile(path.join(repo, file), "local work\n");
        if (mode === "staged") git(repo, "add", file);
        const head = git(repo, "rev-parse", "HEAD"),
            index = git(repo, "ls-files", "--stage");
        await assert.rejects(
            service.pull("Main"),
            (e) =>
                e.code === "PULL_BLOCKED_DIRTY" &&
                e.message ===
                    "Please stage and commit your local changes before pulling." &&
                e.reportFile === "git_conflict.md"
        );
        assert.equal(git(repo, "rev-parse", "HEAD"), head);
        assert.equal(git(repo, "ls-files", "--stage"), index);
        assert.equal(
            await fs.readFile(path.join(repo, file), "utf8"),
            "local work\n"
        );
        assert.match(
            await fs.readFile(path.join(repo, "git_conflict.md"), "utf8"),
            /Please stage and commit your local changes before pulling\./
        );
        assert.equal(
            git(repo, "check-ignore", "git_conflict.md"),
            "git_conflict.md"
        );
    });
test("preserves local commits and blocks divergence without merge state", async (t) => {
    const { service, repo, advance } = await fixture(t);
    await fs.writeFile(path.join(repo, "local.md"), "local\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "local");
    assert.equal((await service.pull("Main")).status, "up-to-date");
    const head = git(repo, "rev-parse", "HEAD");
    await advance();
    await assert.rejects(service.pull("Main"), (e) => e.code === "DIVERGED");
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal((await service.state("Main")).mergeInProgress, false);
});

for (const conflicts of [false, true]) {
    test(`manual Pull fetches and starts a pending merge (conflicts=${conflicts})`, async (t) => {
        const { service, repo, advance } = await fixture(t);
        const localPath = conflicts ? "note.md" : "local.md";
        await fs.writeFile(path.join(repo, localPath), "ours\n");
        git(repo, "add", ".");
        git(repo, "commit", "-m", "local commit");
        const head = git(repo, "rev-parse", "HEAD");
        await advance("note.md", "theirs\n");
        const result = await service.pull("Main", { mergeOnDivergence: true });
        assert.equal(result.status, "merge-pending");
        assert.equal(
            result.merge.kind,
            conflicts ? "merge-conflicted" : "merge-awaiting-commit"
        );
        assert.equal(git(repo, "rev-parse", "HEAD"), head);
        assert.equal(
            git(repo, "rev-parse", "MERGE_HEAD"),
            git(repo, "rev-parse", "@{upstream}")
        );
        if (conflicts) {
            assert.deepEqual(
                result.merge.unresolvedPaths.map((file) => file.path),
                ["note.md"]
            );
            assert.match(git(repo, "ls-files", "-u"), / 1\tnote.md/);
            assert.match(
                await fs.readFile(path.join(repo, "note.md"), "utf8"),
                /<<<<<<< HEAD/
            );
        }
        await assert.rejects(
            service.pull("Main", { mergeOnDivergence: true }),
            { code: "UNFINISHED_OPERATION" }
        );
    });
}

test("manual Pull keeps dirty work intact and validates merge authorization type", async (t) => {
    const { service, repo, advance } = await fixture(t);
    await advance();
    await fs.writeFile(path.join(repo, "note.md"), "uncommitted note\n");
    await assert.rejects(service.pull("Main", { mergeOnDivergence: true }), {
        code: "PULL_BLOCKED_DIRTY",
    });
    await assert.rejects(service.pull("Main", { mergeOnDivergence: "yes" }), {
        code: "INVALID_REQUEST",
    });
    assert.equal((await service.state("Main")).merge.operation, "none");
    assert.equal(
        await fs.readFile(path.join(repo, "note.md"), "utf8"),
        "uncommitted note\n"
    );
});

test("Pull route forwards manual merge intent and reconciles pending merges and partial failures", async () => {
    const handlers = {};
    let attempts = 0,
        reconciled = 0;
    mountRoutes(
        {
            use() {},
            get() {},
            post(route, handle) {
                handlers[route] = handle;
            },
        },
        {
            async pull(id, input) {
                assert.equal(id, "Main");
                assert.equal(input.mergeOnDivergence, true);
                if (++attempts === 1)
                    return {
                        status: "merge-pending",
                        merge: { operation: "merge" },
                    };
                const { GitServiceError } = require("../obsidian-git/errors");
                throw Object.assign(
                    new GitServiceError("TIMEOUT", "Inspect merge state", 504),
                    { reconcileVault: true }
                );
            },
        },
        {
            enabled: true,
            origin: "https://ignis.test",
            reconcile: async () => {
                reconciled++;
            },
        }
    );
    const res = {
        status(code) {
            this.code = code;
            return this;
        },
        json(value) {
            this.value = value;
        },
    };
    const request = {
        method: "POST",
        body: { vaultId: "Main", mergeOnDivergence: true },
    };
    await handlers["/pull"](request, res);
    assert.equal(res.value.status, "merge-pending");
    await handlers["/pull"](request, res);
    assert.equal(res.code, 504);
    assert.equal(res.value.error.code, "TIMEOUT");
    assert.equal(reconciled, 2);
});
test("detects unfinished operations and preserves an existing user report", async (t) => {
    const { service, repo } = await fixture(t);
    await fs.writeFile(path.join(repo, "git_conflict.md"), "user file\n");
    await fs.writeFile(
        path.join(repo, ".git", "CHERRY_PICK_HEAD"),
        git(repo, "rev-parse", "HEAD")
    );
    await assert.rejects(
        service.pull("Main"),
        (e) => e.code === "UNFINISHED_OPERATION" && !e.reportFile
    );
    assert.equal(
        await fs.readFile(path.join(repo, "git_conflict.md"), "utf8"),
        "user file\n"
    );
});
test("missing upstream never configures one", async (t) => {
    const { service, repo } = await fixture(t);
    git(repo, "branch", "--unset-upstream");
    const before = await fs.readFile(path.join(repo, ".git", "config"), "utf8");
    await assert.rejects(service.pull("Main"), (e) => e.code === "NO_UPSTREAM");
    assert.equal(
        await fs.readFile(path.join(repo, ".git", "config"), "utf8"),
        before
    );
});
test("rejects traversal, disabled vaults and symlinks without touching targets", async (t) => {
    const { service, repo } = await fixture(t);
    await assert.rejects(
        service.health("../Main"),
        (e) => e.code === "INVALID_VAULT"
    );
    await assert.rejects(service.health("Work"), (e) => e.code === "DISABLED");
    await fs.symlink("/tmp", path.join(repo, "escape"));
    await assert.rejects(
        service.pull("Main"),
        (e) => e.code === "UNSUPPORTED_LAYOUT"
    );
});
test("reports missing repository without pretending it is ready", async (t) => {
    const { service, repo } = await fixture(t);
    await fs.rm(path.join(repo, ".git"), { recursive: true });
    assert.deepEqual(await service.health("Main"), {
        requirements: "missing-repo",
    });
});
test("same-repository lock releases after failure", async (t) => {
    const { service } = await fixture(t);
    let release, entered;
    const ready = new Promise((r) => (entered = r));
    const run = service.locked("Main", () => {
        entered();
        return new Promise((r) => (release = r));
    });
    await ready;
    await assert.rejects(service.health("Main"), (e) => e.code === "BUSY");
    release();
    await run;
    assert.deepEqual(await service.health("Main"), { requirements: "valid" });
});
test("bounded execution kills slow Git and releases repository lock", async (t) => {
    const { ctx, repo } = await fixture(t);
    const service = new GitService(ctx, { timeout: 40 });
    t.after(() => service.shutdown());
    await assert.rejects(
        service.run(repo, ["-c", "alias.pause=!sleep 3", "pause"]),
        (e) => e.code === "TIMEOUT"
    );
    assert.equal(service.children.size, 0);
});
test("routes enforce origin/JSON/header and reconcile applied files", async () => {
    const handlers = {};
    let guard;
    const router = {
        use: (fn) => (guard = fn),
        get: (p, fn) => (handlers[`GET ${p}`] = fn),
        post: (p, fn) => (handlers[`POST ${p}`] = fn),
    };
    let reconciled = false,
        pulled = false;
    mountRoutes(
        router,
        {
            pull: async () => {
                pulled = true;
                return { status: "updated", files: [], outsideVault: 0 };
            },
        },
        {
            enabled: true,
            origin: "https://ignis.test",
            reconcile: async () => {
                reconciled = true;
            },
        }
    );
    const res = {
        status(code) {
            this.code = code;
            return this;
        },
        json(value) {
            this.value = value;
            return this;
        },
        set() {},
    };
    const req = {
        method: "POST",
        headers: { origin: "https://evil.test", "x-obsidian-git": "1" },
        is: () => true,
        body: { vaultId: "Main" },
    };
    guard(req, res, () => assert.fail("untrusted origin accepted"));
    assert.equal(res.code, 403);
    assert.equal(pulled, false);
    req.headers.origin = "https://ignis.test";
    guard(req, res, () => {});
    await handlers["POST /pull"](req, res);
    assert.equal(pulled, true);
    assert.equal(reconciled, true);
    req.body.path = "/outside";
    await handlers["POST /pull"](req, res);
    assert.equal(res.code, 400);
});

test("protects ignored local files during fast-forward checkout", async (t) => {
    const { service, repo, advance } = await fixture(t);
    await fs.appendFile(
        path.join(repo, ".git", "info", "exclude"),
        "\nprivate.md\n"
    );
    await fs.writeFile(path.join(repo, "private.md"), "local ignored work\n");
    const head = git(repo, "rev-parse", "HEAD");
    await advance("private.md", "incoming\n");
    await assert.rejects(
        service.pull("Main"),
        (e) => e.code === "PULL_BLOCKED_CHECKOUT"
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal(
        await fs.readFile(path.join(repo, "private.md"), "utf8"),
        "local ignored work\n"
    );
});
test("rejects incoming symlinks before integration", async (t) => {
    const { service, repo, seed } = await fixture(t);
    await fs.symlink("/tmp", path.join(seed, "link"));
    git(seed, "add", ".");
    git(seed, "commit", "-m", "symlink");
    git(seed, "push");
    const head = git(repo, "rev-parse", "HEAD");
    await assert.rejects(
        service.pull("Main"),
        (e) => e.code === "UNSUPPORTED_LAYOUT"
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    await assert.rejects(
        fs.lstat(path.join(repo, "link")),
        (e) => e.code === "ENOENT"
    );
});
test("separate configured vaults remain independent while one is locked", async (t) => {
    const { service, repo, ctx } = await fixture(t);
    const work = path.join(ctx.config.vaultRoot, "Work");
    git(ctx.config.vaultRoot, "clone", repo, work);
    ctx.config.getVaultPath = (id) => ({ Main: repo, Work: work })[id];
    ctx.getEnabledVaults = () => ["Main", "Work"];
    let release, entered;
    const ready = new Promise((r) => (entered = r));
    const held = service.locked("Main", () => {
        entered();
        return new Promise((r) => (release = r));
    });
    await ready;
    try {
        assert.deepEqual(await service.health("Work"), {
            requirements: "valid",
        });
    } finally {
        release();
        await held;
    }
});
test("missing Git and oversized command output produce bounded sanitized errors", async (t) => {
    const { service, ctx, repo } = await fixture(t);
    const oldPath = process.env.PATH;
    try {
        process.env.PATH = "";
        assert.deepEqual(await service.health("Main"), {
            requirements: "missing-git",
        });
    } finally {
        process.env.PATH = oldPath;
    }
    const limited = new GitService(ctx, { maxOutput: 1 });
    t.after(() => limited.shutdown());
    await assert.rejects(
        limited.run(repo, ["--version"]),
        (e) => e.code === "OUTPUT_LIMIT" && !e.message.includes(repo)
    );
});
test("state reflects staged renames, untracked files and unresolved index entries", async (t) => {
    const { service, repo } = await fixture(t);
    git(repo, "mv", "note.md", "renamed.md");
    await fs.writeFile(path.join(repo, "untracked.md"), "local\n");
    let state = await service.state("Main");
    assert.equal(state.status.staged[0].from, "note.md");
    assert.equal(state.status.staged[0].path, "renamed.md");
    assert.equal(state.status.changed[0].path, "untracked.md");
    const blob = git(repo, "rev-parse", "HEAD:note.md");
    execFileSync("git", ["update-index", "--index-info"], {
        cwd: repo,
        input: `0 0000000000000000000000000000000000000000\tconflict.md\n100644 ${blob} 1\tconflict.md\n100644 ${blob} 2\tconflict.md\n100644 ${blob} 3\tconflict.md\n`,
    });
    state = await service.state("Main");
    assert.deepEqual(state.status.conflicted, ["conflict.md"]);
});
