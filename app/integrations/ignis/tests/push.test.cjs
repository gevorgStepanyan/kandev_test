const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitService } = require("../obsidian-git/git-service");
const { GitServiceError, publicError } = require("../obsidian-git/errors");
const { mountRoutes } = require("../obsidian-git/routes");

// The task explicitly authorizes these local Git fixtures. No external remote,
// user credentials, deployment, or production vault is touched.
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
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-push-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vaultRoot = path.join(root, "vaults");
    const repo = path.join(vaultRoot, "Main");
    const remote = path.join(root, "remote.git");
    const other = path.join(root, "other");
    await fs.mkdir(vaultRoot);
    await fs.mkdir(remote);
    await fs.mkdir(repo);
    git(remote, "init", "--bare", "--initial-branch=notes");
    git(repo, "init", "--initial-branch=notes");
    git(repo, "config", "user.name", "Push Fixture");
    git(repo, "config", "user.email", "push@example.invalid");
    const write = (name, data) => fs.writeFile(path.join(repo, name), data);
    const commit = async (name = "note.md", data = "next\n") => {
        await write(name, data);
        git(repo, "add", "--", name);
        git(
            repo,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "fixture"
        );
    };
    await commit("note.md", "initial\n");
    git(repo, "remote", "add", "publish", remote);
    git(repo, "config", "branch.notes.remote", "publish");
    git(repo, "config", "branch.notes.merge", "refs/heads/notes");
    const ctx = {
        config: {
            vaultRoot,
            getVaultPath: (id) => (id === "Main" ? repo : null),
        },
        getEnabledVaults: () => ["Main"],
    };
    const service = new GitService(ctx, { pushTestRoot: root });
    t.after(() => service.shutdown());
    const push = () => service.push("Main");
    const head = (where = repo, ref = "HEAD") =>
        git(where, "rev-parse", ref).trim();
    const snapshot = async () => ({
        head: head(),
        index: (await fs.readFile(path.join(repo, ".git/index"))).toString(
            "base64"
        ),
        status: git(repo, "status", "--porcelain=v1", "-z"),
        refs: git(repo, "show-ref"),
    });
    const advance = async (name = "other.md") => {
        if (!(await fs.stat(other).catch(() => false))) {
            git(root, "clone", remote, other);
            git(other, "config", "user.name", "Other Fixture");
            git(other, "config", "user.email", "other@example.invalid");
        }
        await fs.writeFile(path.join(other, name), "remote\n");
        git(other, "add", ".");
        git(other, "commit", "-m", "remote");
        git(other, "push");
    };
    return {
        root,
        repo,
        remote,
        service,
        push,
        head,
        write,
        commit,
        snapshot,
        advance,
        ctx,
    };
}
test("first publication and repeated no-op use only configured non-default remote/branch", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.service.pushReadiness("Main"), {
        configured: true,
        canPush: true,
        unpushedCommits: 1,
    });
    const before = await f.snapshot();
    assert.deepEqual(await f.push(), { status: "pushed", files: null });
    assert.equal(f.head(f.remote, "notes"), f.head());
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(await f.push(), { status: "up-to-date" });
    assert.deepEqual(await f.service.pushReadiness("Main"), {
        configured: true,
        canPush: false,
        unpushedCommits: 0,
    });
    assert.equal(
        git(f.remote, "for-each-ref", "--format=%(refname)"),
        "refs/heads/notes\n"
    );
});
test("one and multiple commits publish intact with accurate file counts and dirty index/worktree preserved", async (t) => {
    const f = await fixture(t);
    await f.push();
    await f.commit("note.md", "one\n");
    assert.deepEqual(await f.push(), { status: "pushed", files: 1 });
    await f.commit("space\n雪.md", "two\n");
    await f.commit("note.md", "three\n");
    git(f.repo, "mv", "note.md", "renamed.md");
    git(f.repo, "commit", "-m", "rename");
    await f.write("renamed.md", "staged\n");
    git(f.repo, "add", "renamed.md");
    await f.write("renamed.md", "newer working\n");
    await f.write("untracked.md", "untracked\n");
    const before = await f.snapshot();
    assert.equal((await f.service.pushReadiness("Main")).unpushedCommits, 3);
    assert.deepEqual(await f.push(), { status: "pushed", files: 3 });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.head(f.remote, "notes"), f.head());
    assert.deepEqual(await f.push(), { status: "up-to-date" });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(git(f.remote, "show", "notes:renamed.md"), "three\n");
    assert.equal(git(f.remote, "rev-list", "--count", "notes"), "5\n");
});
test("detached HEAD and absent target stop without guessed publication or config writes", async (t) => {
    const f = await fixture(t);
    git(f.repo, "checkout", "--detach");
    assert.deepEqual(await f.push(), {
        status: "blocked",
        reason: "no-branch",
    });
    git(f.repo, "checkout", "notes");
    git(f.repo, "config", "--unset", "branch.notes.remote");
    git(f.repo, "config", "--unset", "branch.notes.merge");
    const config = await fs.readFile(path.join(f.repo, ".git/config"));
    assert.deepEqual(await f.push(), {
        status: "skipped",
        reason: "no-upstream",
    });
    assert.deepEqual(
        await fs.readFile(path.join(f.repo, ".git/config")),
        config
    );
    assert.equal(git(f.remote, "for-each-ref"), "");
    git(f.repo, "remote", "remove", "publish");
    assert.equal((await f.service.pushReadiness("Main")).configured, false);
});
for (const setting of ["branch.notes.pushRemote", "remote.pushDefault"])
    test(`${setting} selects triangular destination independently of pull upstream`, async (t) => {
        const f = await fixture(t);
        await f.push();
        const destination = path.join(f.root, "triangular.git");
        await fs.mkdir(destination);
        git(destination, "init", "--bare");
        git(f.repo, "remote", "add", "outgoing", destination);
        git(f.repo, "config", setting, "outgoing");
        await f.commit();
        assert.equal(
            (await f.service.pushReadiness("Main")).unpushedCommits,
            2
        );
        await f.push();
        assert.equal(f.head(destination, "notes"), f.head());
        assert.notEqual(f.head(f.remote, "notes"), f.head());
    });
test("exact single-branch custom mapping and pushurl are honored", async (t) => {
    const f = await fixture(t);
    git(
        f.repo,
        "config",
        "remote.publish.push",
        "refs/heads/notes:refs/heads/trunk"
    );
    git(f.repo, "config", "remote.publish.pushurl", f.remote);
    await f.push();
    assert.equal(f.head(f.remote, "trunk"), f.head());
    assert.equal(
        git(f.remote, "for-each-ref", "--format=%(refname)"),
        "refs/heads/trunk\n"
    );
});
for (const diverge of [false, true])
    test(`remote advance (${diverge ? "diverged" : "behind"}) preserves history/index/report`, async (t) => {
        const f = await fixture(t);
        await f.push();
        await f.advance();
        if (diverge) await f.commit("local.md", "local\n");
        await f.write("git_conflict.md", "existing report\n");
        const before = await f.snapshot();
        const remoteBefore = f.head(f.remote, "notes");
        const readiness = await f.service.pushReadiness("Main");
        assert.equal(readiness.unpushedCommits, diverge ? 1 : 0);
        assert.equal(readiness.canPush, diverge);
        if (diverge)
            await assert.rejects(
                f.push(),
                (e) =>
                    e.code === "PUSH_NON_FAST_FORWARD" &&
                    /Pull\/merge/.test(e.message)
            );
        else assert.deepEqual(await f.push(), { status: "up-to-date" });
        assert.deepEqual(await f.snapshot(), before);
        assert.equal(f.head(f.remote, "notes"), remoteBefore);
        assert.equal(
            await fs.readFile(path.join(f.repo, "git_conflict.md"), "utf8"),
            "existing report\n"
        );
    });
for (const name of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "sequencer",
])
    test(`${name} blocks before network access, state remains untouched`, async (t) => {
        const f = await fixture(t);
        const metadata = path.join(f.repo, ".git", name);
        if (["rebase-merge", "sequencer"].includes(name))
            await fs.mkdir(metadata);
        else await fs.writeFile(metadata, f.head() + "\n");
        const run = f.service.run.bind(f.service);
        f.service.run = (repo, args, ...rest) => {
            assert.ok(!args.includes("push") && !args.includes("ls-remote"));
            return run(repo, args, ...rest);
        };
        assert.deepEqual(await f.push(), {
            status: "blocked",
            reason: "merge-in-progress",
        });
        assert.ok(await fs.stat(metadata));
    });
test("real unmerged index blocks; resolved committed merge pushes ordinary two-parent history", async (t) => {
    const f = await fixture(t);
    await f.push();
    await f.advance("note.md");
    await f.commit("note.md", "conflicting local\n");
    git(f.repo, "fetch", "publish");
    assert.throws(() => git(f.repo, "merge", "--no-commit", "publish/notes"));
    const before = await f.snapshot();
    assert.deepEqual(await f.push(), {
        status: "blocked",
        reason: "conflicts",
        files: 1,
    });
    assert.deepEqual(await f.snapshot(), before);
    await f.write("note.md", "resolved\n");
    git(f.repo, "add", "note.md");
    git(f.repo, "commit", "-m", "resolved merge");
    assert.equal((await f.push()).status, "pushed");
    assert.equal(
        git(f.remote, "show", "-s", "--format=%P", "notes").trim().split(" ")
            .length,
        2
    );
});
test("native non-force push rejects a remote race after preflight", async (t) => {
    const f = await fixture(t);
    await f.push();
    await f.commit("local.md", "local\n");
    const before = await f.snapshot();
    const run = f.service.run.bind(f.service);
    f.service.run = async (repo, args, ...rest) => {
        if (args.includes("push")) await f.advance();
        return run(repo, args, ...rest);
    };
    await assert.rejects(f.push(), (e) => e.code === "PUSH_NON_FAST_FORWARD");
    assert.deepEqual(await f.snapshot(), before);
    assert.notEqual(f.head(f.remote, "notes"), f.head());
});
test("remote pre-receive rejection never reports success; local pre-push hook is disabled", async (t) => {
    const f = await fixture(t);
    await f.push();
    await f.commit();
    const marker = path.join(f.root, "must-not-exist");
    const hook = path.join(f.repo, ".git/hooks/pre-push");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
        mode: 0o755,
    });
    const remoteHook = path.join(f.remote, "hooks/pre-receive");
    await fs.writeFile(
        remoteHook,
        "#!/bin/sh\necho 'sensitive /server/private token' >&2\nexit 1\n",
        { mode: 0o755 }
    );
    const before = f.head(f.remote, "notes");
    await assert.rejects(
        f.push(),
        (e) =>
            e.code === "PUSH_REMOTE_REJECTED" &&
            !/sensitive|\/server|token/.test(e.message)
    );
    assert.equal(f.head(f.remote, "notes"), before);
    assert.equal(await fs.stat(marker).catch(() => null), null);
    await fs.rm(remoteHook);
    assert.equal((await f.push()).status, "pushed");
});
for (const [key, value] of [
    ["push.default", "matching"],
    ["remote.publish.mirror", "true"],
    ["remote.publish.push", "+refs/heads/notes:refs/heads/notes"],
    ["remote.publish.push", "refs/heads/*:refs/heads/*"],
    ["remote.publish.push", ":refs/heads/notes"],
    ["remote.publish.push", "refs/heads/notes:refs/tags/no"],
    ["remote.publish.url", "ext::sh -c bad"],
    ["remote.publish.url", "helper::bad"],
    ["core.sshCommand", "sh -c bad"],
    ["credential.helper", "!bad"],
    ["include.path", "/missing/untrusted"],
    ["http.extraHeader", "secret"],
    ["url.ext::bad.insteadOf", "https://example.invalid/"],
    ["push.pushOption", "unexpected"],
    ["extensions.worktreeConfig", "true"],
])
    test(`rejects unsafe push configuration ${key}=${value}`, async (t) => {
        const f = await fixture(t);
        git(f.repo, "config", key, value);
        await assert.rejects(
            f.push(),
            (e) => e.code === "PUSH_CONFIG_UNSUPPORTED"
        );
        assert.equal(git(f.remote, "for-each-ref"), "");
    });
test("multiple refspecs/URLs rejected and production policy refuses file remotes", async (t) => {
    const f = await fixture(t);
    f.service.pushTestRoot = undefined;
    await assert.rejects(f.push(), (e) => e.code === "PUSH_CONFIG_UNSUPPORTED");
    f.service.pushTestRoot = f.root;
    git(
        f.repo,
        "config",
        "--add",
        "remote.publish.push",
        "notes:refs/heads/notes"
    );
    git(
        f.repo,
        "config",
        "--add",
        "remote.publish.push",
        "other:refs/heads/other"
    );
    await assert.rejects(f.push(), (e) => e.code === "PUSH_CONFIG_UNSUPPORTED");
    git(f.repo, "config", "--unset-all", "remote.publish.push");
    git(f.repo, "config", "--add", "remote.publish.pushurl", f.remote);
    git(f.repo, "config", "--add", "remote.publish.pushurl", f.remote);
    await assert.rejects(f.push(), (e) => e.code === "PUSH_CONFIG_UNSUPPORTED");
});
test("per-repository lock covers remote operation, competing mutations fail BUSY, release on error", async (t) => {
    const f = await fixture(t);
    const run = f.service.run.bind(f.service);
    let entered;
    const started = new Promise((resolve) => (entered = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    f.service.run = async (repo, args, ...rest) => {
        if (args.includes("push")) {
            entered();
            await gate;
            throw new GitServiceError(
                "TIMEOUT",
                "Push timed out; inspect remote state.",
                504
            );
        }
        return run(repo, args, ...rest);
    };
    const first = f.push();
    await started;
    for (const call of [
        f.push,
        () => f.service.pull("Main"),
        () => f.service.mutateIndex("Main", "stage-all"),
        () =>
            f.service.commit("Main", {
                mode: "staged",
                amend: false,
                message: "test",
            }),
        () => f.service.mergeAction("Main", "start", {}),
    ])
        await assert.rejects(call(), (e) => e.code === "BUSY");
    release();
    await assert.rejects(first, (e) => e.code === "TIMEOUT");
    assert.equal(f.service.locks.size, 0);
    f.service.run = run;
    assert.equal((await f.push()).status, "pushed");
});
test("independent vaults do not share refs or locks", async (t) => {
    const a = await fixture(t),
        b = await fixture(t);
    a.service.locks.add(a.repo);
    assert.equal((await b.push()).status, "pushed");
    assert.equal(git(a.remote, "for-each-ref"), "");
    a.service.locks.clear();
    await a.push();
});
test("executor timeout kills a hanging remote hook, releases lock and permits retry", async (t) => {
    const f = await fixture(t);
    const hook = path.join(f.remote, "hooks/pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nwhile :; do :; done\n", {
        mode: 0o755,
    });
    const run = f.service.run.bind(f.service);
    f.service.run = async (repo, args, ...rest) => {
        f.service.timeout = args.includes("push") ? 100 : 60000;
        return run(repo, args, ...rest);
    };
    await assert.rejects(f.push(), (e) => e.code === "TIMEOUT");
    assert.equal(f.service.children.size, 0);
    assert.equal(f.service.locks.size, 0);
    await fs.rm(hook);
    f.service.run = run;
    f.service.timeout = 60000;
    assert.equal((await f.push()).status, "pushed");
});
test("vault isolation, symlink escape and sanitized failures reuse established protections", async (t) => {
    const f = await fixture(t);
    for (const id of ["../Main", "/Main", "unknown", "Main/../Other"])
        await assert.rejects(f.service.push(id));
    const link = path.join(f.repo, "escape");
    await fs.symlink(f.root, link);
    await assert.rejects(f.push(), (e) => e.code === "UNSUPPORTED_LAYOUT");
    await fs.rm(link);
    assert.equal(
        publicError(new Error("/private/path secret")).message.includes(
            "secret"
        ),
        false
    );
});
function router(service) {
    const routes = new Map();
    let middleware;
    mountRoutes(
        {
            use(fn) {
                middleware = fn;
            },
            get(p, fn) {
                routes.set(`GET ${p}`, fn);
            },
            post(p, fn) {
                routes.set(`POST ${p}`, fn);
            },
        },
        service,
        {
            enabled: true,
            origins: ["https://ignis.example.invalid"],
            reconcile: async () => {},
        }
    );
    return async (body, options = {}) => {
        const req = {
            method: "POST",
            body,
            headers: {
                origin: "https://ignis.example.invalid",
                "x-obsidian-git": "1",
                ...options.headers,
            },
            is: () => options.json !== false,
        };
        let status = 200,
            value,
            next = false;
        const res = {
            status(v) {
                status = v;
                return res;
            },
            json(v) {
                value = v;
                return res;
            },
            set() {},
        };
        middleware(req, res, () => (next = true));
        if (next) await routes.get("POST /push")(req, res);
        return { status, value };
    };
}
test("Push route accepts only vaultId and enforces origin/header/JSON with safe error envelope", async () => {
    const calls = [];
    const request = router({
        push: async (id) => {
            calls.push(id);
            return { status: "pushed", files: null };
        },
    });
    assert.equal((await request({ vaultId: "Main" })).value.status, "pushed");
    for (const key of [
        "remote",
        "refspec",
        "force",
        "executable",
        "command",
        "env",
        "sshKey",
        "path",
        "dir",
        "branch",
    ])
        assert.equal(
            (await request({ vaultId: "Main", [key]: "bad" })).status,
            400
        );
    for (const body of [null, [], "bad"])
        assert.equal((await request(body)).status, 400);
    for (const headers of [
        { origin: undefined },
        { origin: "https://evil.invalid" },
        { "x-obsidian-git": undefined },
    ])
        assert.equal(
            (await request({ vaultId: "Main" }, { headers })).status,
            403
        );
    assert.equal(
        (await request({ vaultId: "Main" }, { json: false })).status,
        403
    );
    assert.deepEqual(calls, ["Main"]);
});

test("file counts use NUL records even for non-UTF-8 byte filenames", async (t) => {
    const f = await fixture(t);
    await f.push();
    await fs.writeFile(
        Buffer.concat([
            Buffer.from(f.repo + path.sep),
            Buffer.from([0xff, 0x61]),
        ]),
        "bytes\n"
    );
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "non-UTF-8 path");
    assert.deepEqual(await f.push(), { status: "pushed", files: 1 });
});
test("push.default current and upstream choose only their explicit single branch", async (t) => {
    const f = await fixture(t);
    git(f.repo, "config", "push.default", "upstream");
    git(f.repo, "config", "branch.notes.merge", "refs/heads/trunk");
    await f.push();
    assert.equal(f.head(f.remote, "trunk"), f.head());
    git(f.repo, "config", "push.default", "current");
    await f.push();
    assert.equal(f.head(f.remote, "notes"), f.head());
});
test("tags are not implicitly followed, even with push.followTags enabled", async (t) => {
    const f = await fixture(t);
    git(f.repo, "tag", "-a", "v-fixture", "-m", "tag");
    git(f.repo, "config", "push.followTags", "true");
    await f.push();
    assert.equal(git(f.remote, "for-each-ref", "refs/tags"), "");
});
test("failed post-push verification reports uncertain outcome and retry is a no-op", async (t) => {
    const f = await fixture(t);
    const run = f.service.run.bind(f.service);
    let pushed = false;
    f.service.run = async (repo, args, ...rest) => {
        if (args.includes("ls-remote") && pushed)
            throw new GitServiceError("NETWORK", "remote unreachable", 502);
        const result = await run(repo, args, ...rest);
        if (args.includes("push")) pushed = true;
        return result;
    };
    await assert.rejects(f.push(), (e) => e.code === "PUSH_OUTCOME_UNCERTAIN");
    assert.equal(f.head(f.remote, "notes"), f.head());
    assert.equal(f.service.locks.size, 0);
    f.service.run = run;
    assert.deepEqual(await f.push(), { status: "up-to-date" });
});
test("route rejects invalid/disabled vault identifiers and inaccessible vaults", async (t) => {
    const f = await fixture(t);
    const request = router(f.service);
    for (const vaultId of [
        null,
        1,
        true,
        {},
        "../Main",
        "Main/child",
        "unknown",
    ])
        assert.notEqual((await request({ vaultId })).status, 200);
    assert.notEqual((await request({})).status, 200);
    f.ctx.config.getVaultPath = () => null;
    assert.equal((await request({ vaultId: "Main" })).status, 404);
});
// Isolate the executor with a fake process; no network or shell is involved.
// Reloading this module captures spawn for this test only; all fixture services
// above retain their real executor and the module cache is restored immediately.
for (const [message, expected, exitCode] of [
    [
        "! [rejected] (fetch first) /private/key secret",
        "PUSH_NON_FAST_FORWARD",
        1,
    ],
    ["! [remote rejected] (protected branch)", "PUSH_REMOTE_REJECTED", 1],
    [
        "Permission denied (publickey) /private/key secret",
        "AUTH_OR_PERMISSION",
        128,
    ],
    [
        "Authentication failed for https://user:secret@host/repo",
        "AUTH_OR_PERMISSION",
        128,
    ],
    ["Could not resolve hostname private.host", "NETWORK", 128],
    ["Connection refused /private/key secret", "NETWORK", 128],
    ["unexpected /private/key secret", "GIT_FAILED", 128],
    ["killed /private/key secret", "PUSH_OUTCOME_UNCERTAIN", null],
])
    test(`executor sanitizes and classifies ${expected}: ${exitCode}`, async () => {
        const childProcess = require("node:child_process");
        const { EventEmitter } = require("node:events");
        const modulePath = require.resolve("../obsidian-git/git-service");
        const cached = require.cache[modulePath];
        const spawn = childProcess.spawn;
        let Service;
        try {
            childProcess.spawn = (_executable, args, options) => {
                assert.equal(options.shell, false);
                assert.ok(args.includes("core.hooksPath=/dev/null"));
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                queueMicrotask(() => {
                    child.stderr.emit("data", Buffer.from(message));
                    child.emit("close", exitCode);
                });
                return child;
            };
            delete require.cache[modulePath];
            Service = require(modulePath).GitService;
        } finally {
            childProcess.spawn = spawn;
            require.cache[modulePath] = cached;
        }
        const service = new Service({});
        await assert.rejects(
            service.run("/fixture", ["push"]),
            (e) =>
                e.code === expected &&
                !/\/private|secret|private.host/.test(e.message)
        );
        assert.equal(service.children.size, 0);
    });

test("production SSH/HTTPS target policy accepts trusted URLs without contacting them", async (t) => {
    const f = await fixture(t);
    f.service.pushTestRoot = undefined;
    const { target } = require("../obsidian-git/push");
    for (const url of [
        "git@example.invalid:notes.git",
        "ssh://git@example.invalid/notes.git",
        "https://example.invalid/notes.git",
    ]) {
        git(f.repo, "config", "remote.publish.url", url);
        assert.equal((await target(f.service, f.repo)).url, url);
    }
    for (const url of [
        "https://user:secret@example.invalid/notes.git",
        "https://user@example.invalid/notes.git",
        "http://example.invalid/notes.git",
        "ssh://-host/notes.git",
        "file:///outside/remote.git",
    ]) {
        git(f.repo, "config", "remote.publish.url", url);
        await assert.rejects(
            target(f.service, f.repo),
            (e) =>
                e.code === "PUSH_CONFIG_UNSUPPORTED" &&
                !e.message.includes("secret")
        );
    }
});
test("simple does not treat a same-remote pushRemote override as a triangular first push", async (t) => {
    const f = await fixture(t);
    git(f.repo, "config", "--unset", "branch.notes.merge");
    git(f.repo, "config", "--unset", "branch.notes.remote");
    git(f.repo, "config", "branch.notes.pushRemote", "publish");
    assert.deepEqual(await f.push(), {
        status: "skipped",
        reason: "no-upstream",
    });
    assert.equal(git(f.remote, "for-each-ref"), "");
});

test("a destination URL cannot inherit settings from a shadow named remote", async (t) => {
    const f = await fixture(t);
    git(f.repo, "config", `remote.${f.remote}.url`, f.remote);
    git(f.repo, "config", `remote.${f.remote}.mirror`, "true");
    await assert.rejects(f.push(), (e) => e.code === "PUSH_CONFIG_UNSUPPORTED");
    assert.equal(git(f.remote, "for-each-ref"), "");
});
