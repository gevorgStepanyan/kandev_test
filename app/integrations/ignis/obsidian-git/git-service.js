const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { GitServiceError, publicError } = require("./errors");

// Commands and revisions come from this service or trusted repository configuration.
// Browser callers can select a configured vault, never a path or Git arguments.
class GitService {
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.timeout = options.timeout ?? 60000;
        this.maxOutput = options.maxOutput ?? 8 * 1024 * 1024;
        this.locks = new Set();
        this.children = new Set();
        this.stopped = false;
    }

    async run(repo, args, allowed = [0], input) {
        if (this.stopped)
            throw new GitServiceError(
                "UNAVAILABLE",
                "Git integration is shutting down.",
                503
            );
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
        // Do not let inherited Git path/config overrides redirect the repository.
        for (const key of Object.keys(env)) {
            if (
                key.startsWith("GIT_") &&
                !["GIT_TERMINAL_PROMPT", "GIT_SSH_COMMAND", "GIT_SSH"].includes(
                    key
                )
            )
                delete env[key];
        }
        return new Promise((resolve, reject) => {
            const child = spawn(
                "git",
                [
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "gc.auto=0",
                    "-c",
                    "maintenance.auto=false",
                    ...args,
                ],
                {
                    cwd: repo,
                    env,
                    shell: false,
                    detached: process.platform !== "win32",
                    stdio: [
                        input === undefined ? "ignore" : "pipe",
                        "pipe",
                        "pipe",
                    ],
                }
            );
            this.children.add(child);
            const stdout = [],
                stderr = [];
            let size = 0,
                failure;
            const fail = (error) => {
                failure ??= error;
                this.kill(child);
            };
            if (input !== undefined) {
                child.stdin.on("error", (error) => {
                    // A process that rejects its arguments may close stdin early.
                    // Its exit status remains authoritative in that case.
                    if (error.code !== "EPIPE") fail(publicError(error));
                });
                child.stdin.end(input);
            }
            const timer = setTimeout(
                () =>
                    fail(
                        new GitServiceError(
                            "TIMEOUT",
                            "Git timed out. Verify repository state before retrying.",
                            504
                        )
                    ),
                this.timeout
            );
            child.stdout.on("data", (data) => {
                size += data.length;
                stdout.push(data);
                if (size > this.maxOutput)
                    fail(
                        new GitServiceError(
                            "OUTPUT_LIMIT",
                            "Git output exceeds the pilot integration limit.",
                            413
                        )
                    );
            });
            child.stderr.on("data", (data) => {
                size += data.length;
                stderr.push(data);
                if (size > this.maxOutput)
                    fail(
                        new GitServiceError(
                            "OUTPUT_LIMIT",
                            "Git output exceeds the pilot integration limit.",
                            413
                        )
                    );
            });
            child.on("error", (error) => {
                failure =
                    error.code === "ENOENT"
                        ? new GitServiceError(
                              "GIT_MISSING",
                              "Git is not installed on the Ignis server.",
                              503
                          )
                        : publicError(error);
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                this.children.delete(child);
                if (failure) return reject(failure);
                let out;
                try {
                    out = new TextDecoder("utf-8", { fatal: true }).decode(
                        Buffer.concat(stdout)
                    );
                } catch {
                    return reject(
                        new GitServiceError(
                            "INVALID_ENCODING",
                            "Git output contains non-UTF-8 filenames unsupported by this pilot.",
                            400
                        )
                    );
                }
                const err = Buffer.concat(stderr).toString("utf8");
                if (allowed.includes(code)) return resolve({ code, out });
                // console.error("[obsidian-git] Git command failed", {
                //     args,
                //     exitCode: code,
                //     stderr: err.slice(0, 4000),
                // });
                let error;
                if (/dubious ownership/i.test(err))
                    error = new GitServiceError(
                        "OWNERSHIP",
                        "Git rejected vault ownership. Run Ignis with the vault owner's UID/GID.",
                        403
                    );
                else if (/index\.lock.*(?:exists|File exists)/is.test(err))
                    error = new GitServiceError(
                        "GIT_INDEX_LOCKED",
                        "Git's index is locked. Wait for other Git processes to finish; inspect stale locks outside Ignis.",
                        409
                    );
                else if (
                    /permission denied|authentication failed|could not read username/i.test(
                        err
                    )
                )
                    error = new GitServiceError(
                        "AUTH_OR_PERMISSION",
                        "Git authentication or filesystem permission failed. Check server SSH credentials and vault permissions.",
                        403
                    );
                else if (
                    /could not resolve|unable to access|connection refused|network is unreachable|connection timed out/i.test(
                        err
                    )
                )
                    error = new GitServiceError(
                        "NETWORK",
                        "The Ignis server cannot reach the Git remote.",
                        502
                    );
                else
                    error = new GitServiceError(
                        "GIT_FAILED",
                        "Git refused the operation. Inspect the repository in an authorized Git environment."
                    );
                reject(error);
            });
        });
    }

    async resolveVault(vaultId) {
        if (
            typeof vaultId !== "string" ||
            !vaultId ||
            vaultId.length > 255 ||
            /[\\/\x00-\x1f\x7f]/.test(vaultId) ||
            vaultId === "." ||
            vaultId === ".."
        ) {
            throw new GitServiceError(
                "INVALID_VAULT",
                "Invalid vault identifier.",
                400
            );
        }
        if (!this.ctx.getEnabledVaults().includes(vaultId))
            throw new GitServiceError(
                "DISABLED",
                "Git integration is not enabled for this vault.",
                403
            );
        const configured = this.ctx.config.getVaultPath(vaultId);
        if (!configured)
            throw new GitServiceError(
                "VAULT_MISSING",
                "The active vault does not exist.",
                404
            );
        const root = await fs.realpath(this.ctx.config.vaultRoot);
        let repo;
        try {
            repo = await fs.realpath(configured);
        } catch (error) {
            if (error.code === "ENOENT")
                throw new GitServiceError(
                    "VAULT_MISSING",
                    "The active vault does not exist.",
                    404
                );
            throw error;
        }
        if (repo !== path.resolve(configured) || path.dirname(repo) !== root)
            throw new GitServiceError(
                "UNSUPPORTED_LAYOUT",
                "The pilot requires a real vault directory directly inside the configured vault root.",
                400
            );
        return repo;
    }

    async validate(repo) {
        await this.run(repo, ["--version"]);
        let gitStat;
        try {
            gitStat = await fs.lstat(path.join(repo, ".git"));
        } catch (error) {
            if (error.code === "ENOENT")
                throw new GitServiceError(
                    "REPOSITORY_MISSING",
                    "No Git repository exists at the vault root.",
                    404
                );
            throw error;
        }
        if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
            throw new GitServiceError(
                "UNSUPPORTED_LAYOUT",
                "Worktrees and external Git directories are not supported by the pilot.",
                400
            );
        await this.rejectSymlinks(repo);
        for (const file of ["objects/info/alternates", "commondir"]) {
            try {
                await fs.lstat(path.join(repo, ".git", file));
                throw new GitServiceError(
                    "UNSUPPORTED_LAYOUT",
                    "External/shared Git object directories are unsupported by this pilot.",
                    400
                );
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        const top = (
            await this.run(repo, ["rev-parse", "--show-toplevel"])
        ).out.trim();
        if ((await fs.realpath(top)) !== repo)
            throw new GitServiceError(
                "UNSUPPORTED_LAYOUT",
                "The Git repository must be rooted at the vault.",
                400
            );
        if (
            (
                await this.run(repo, ["rev-parse", "--is-bare-repository"])
            ).out.trim() !== "false"
        )
            throw new GitServiceError(
                "UNSUPPORTED_LAYOUT",
                "A working-tree repository is required.",
                400
            );
    }

    async rejectSymlinks(repo) {
        let count = 0;
        const walk = async (dir) => {
            for (const entry of await fs.readdir(dir, {
                withFileTypes: true,
            })) {
                if (++count > 100000)
                    throw new GitServiceError(
                        "FILE_LIMIT",
                        "The vault exceeds the pilot's filesystem validation limit.",
                        413
                    );
                if (entry.isSymbolicLink())
                    throw new GitServiceError(
                        "UNSUPPORTED_LAYOUT",
                        "Symlinks inside the vault or Git directory are unsupported in this pilot.",
                        400
                    );
                if (entry.isDirectory()) await walk(path.join(dir, entry.name));
            }
        };
        await walk(repo);
    }

    async locked(vaultId, operation) {
        const repo = await this.resolveVault(vaultId);
        if (this.locks.has(repo))
            throw new GitServiceError(
                "BUSY",
                "Another Git operation is running for this vault.",
                409
            );
        this.locks.add(repo);
        try {
            await this.validate(repo);
            return await operation(repo);
        } finally {
            this.locks.delete(repo);
        }
    }

    async health(vaultId) {
        try {
            await this.locked(vaultId, async () => {});
            return { requirements: "valid" };
        } catch (error) {
            if (error.code === "REPOSITORY_MISSING")
                return { requirements: "missing-repo" };
            if (error.code === "GIT_MISSING")
                return { requirements: "missing-git" };
            throw error;
        }
    }

    async config(repo, key) {
        const { code, out } = await this.run(
            repo,
            ["config", "--local", "--get", key],
            [0, 1]
        );
        return code === 0 ? out.trim() : undefined;
    }

    async branch(repo) {
        const current =
            (
                await this.run(
                    repo,
                    ["symbolic-ref", "--quiet", "--short", "HEAD"],
                    [0, 1]
                )
            ).out.trim() || undefined;
        const upstream = await this.run(
            repo,
            [
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
            [0, 128]
        );
        const tracking =
            upstream.code === 0 ? upstream.out.trim() || undefined : undefined;
        const branches = (
            await this.run(repo, [
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
            ])
        ).out
            .trim()
            .split("\n")
            .filter(Boolean);
        return { current, tracking, branches };
    }

    async status(repo) {
        const raw = (
            await this.run(repo, [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ])
        ).out;
        const fields = raw.split("\0"),
            all = [],
            conflicted = [];
        for (let i = 0; i < fields.length; i++) {
            const record = fields[i];
            if (!record) continue;
            const index = record[0],
                workingDir = record[1],
                file = record.slice(3);
            const entry = { path: file, vaultPath: file, index, workingDir };
            if ([index, workingDir].some((v) => v === "R" || v === "C"))
                entry.from = fields[++i];
            if (
                ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
                    index + workingDir
                )
            )
                conflicted.push(file);
            all.push(entry);
        }
        return {
            all,
            changed: all.filter((v) => v.workingDir !== " "),
            staged: all.filter((v) => ![" ", "?"].includes(v.index)),
            conflicted,
            stagedOutsideVault: 0,
            conflictedOutsideVault: 0,
        };
    }

    validateIndexPath(target) {
        if (
            typeof target !== "string" ||
            !target ||
            target.includes("\\") ||
            target.includes("\0") ||
            path.posix.isAbsolute(target) ||
            /^[A-Za-z]:/.test(target) ||
            target
                .split("/")
                .some(
                    (part) =>
                        !part ||
                        part === "." ||
                        part === ".." ||
                        part.toLowerCase() === ".git"
                )
        )
            throw new GitServiceError(
                "INVALID_PATH",
                "Choose a relative file or folder inside the vault, excluding Git metadata.",
                400
            );
    }

    async mutateIndex(vaultId, operation, target) {
        return this.locked(vaultId, async (repo) => {
            if (
                !["stage", "unstage", "stage-all", "unstage-all"].includes(
                    operation
                )
            )
                throw new GitServiceError(
                    "INVALID_REQUEST",
                    "Unknown index operation.",
                    400
                );
            const all = operation.endsWith("-all");
            const staging = operation.startsWith("stage");
            if (target !== undefined || !all) this.validateIndexPath(target);
            if (
                target === "git_conflict.md" ||
                target?.startsWith("git_conflict.md/")
            )
                throw new GitServiceError(
                    "INVALID_PATH",
                    "The Pull conflict report is excluded from staging operations.",
                    400
                );
            const matches = (file) =>
                target === undefined ||
                file === target ||
                file.startsWith(target + "/");
            const status = await this.status(repo);
            if (status.conflicted.some(matches))
                throw new GitServiceError(
                    "UNMERGED_PATH",
                    "Resolve unmerged index entries outside Ignis before staging or unstaging this scope.",
                    409
                );
            const literal = (file) => `:(literal)${file}`;
            if (target !== undefined) {
                const known = (
                    await this.run(repo, [
                        "ls-files",
                        "-z",
                        "--cached",
                        "--others",
                        "--exclude-standard",
                        "--",
                        literal(target),
                    ])
                ).out;
                const ignored = await this.run(
                    repo,
                    ["check-ignore", "--quiet", "--", target],
                    [0, 1]
                );
                if (
                    !known &&
                    !status.all.some(
                        (file) =>
                            matches(file.path) ||
                            (file.from && matches(file.from))
                    )
                ) {
                    if (ignored.code === 0)
                        throw new GitServiceError(
                            "IGNORED_PATH",
                            "This path is ignored by Git. Review ignore rules outside Ignis before staging it.",
                            400
                        );
                    let exists = false;
                    try {
                        exists = (
                            await fs.lstat(path.join(repo, target))
                        ).isDirectory();
                    } catch (error) {
                        if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                            throw error;
                    }
                    if (!exists)
                        throw new GitServiceError(
                            "INVALID_PATH",
                            "The selected path is not present in the working tree or Git index.",
                            400
                        );
                }
            }
            const selected = (staging ? status.changed : status.staged).filter(
                (file) =>
                    (matches(file.path) ||
                        (!staging && file.from && matches(file.from))) &&
                    file.path !== "git_conflict.md"
            );
            if (selected.length) {
                const specs = [target === undefined ? ":/" : literal(target)];
                // A file row represents both sides of a staged rename. Folder
                // actions stay strictly within their requested subtree.
                if (!all && !staging) {
                    for (const file of selected) {
                        if (file.from) {
                            this.validateIndexPath(file.from);
                            if (file.from === "git_conflict.md")
                                throw new GitServiceError(
                                    "INVALID_PATH",
                                    "The Pull conflict report is excluded from staging operations.",
                                    400
                                );
                            specs.push(literal(file.from), literal(file.path));
                        }
                    }
                }
                specs.push(":(exclude,literal)git_conflict.md");
                if (staging) {
                    await this.stageChanges(repo, selected);
                } else if (await this.head(repo))
                    await this.run(repo, [
                        "restore",
                        "--staged",
                        "--",
                        ...specs,
                    ]);
                else
                    await this.run(repo, [
                        "rm",
                        "--cached",
                        "-r",
                        "-f",
                        "--ignore-unmatch",
                        "--",
                        ...specs,
                    ]);
            }
            return {
                status: "updated",
                operation,
                ...(target === undefined
                    ? {}
                    : { [all ? "dir" : "path"]: target }),
            };
        });
    }

    async stageChanges(repo, changes) {
        const paths = changes
            .filter((file) => file.path !== "git_conflict.md")
            .map((file) => {
                this.validateIndexPath(file.path);
                return `:(literal)${file.path}`;
            });
        if (paths.length) await this.run(repo, ["add", "-A", "--", ...paths]);
    }

    async commit(vaultId, input) {
        if (typeof process.getuid !== "function" || process.getuid() === 0)
            throw new GitServiceError(
                "OWNERSHIP",
                "Run Ignis as the non-root vault owner (configure the container UID/GID) before committing.",
                403
            );
        const { commit } = require("./commit");
        return this.locked(vaultId, (repo) => commit(this, repo, input));
    }

    async unfinished(repo) {
        for (const name of [
            "MERGE_HEAD",
            "REBASE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
        ]) {
            try {
                await fs.lstat(path.join(repo, ".git", name));
                return true;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        return false;
    }

    async head(repo, ref = "HEAD") {
        const result = await this.run(
            repo,
            ["rev-parse", "--verify", ref],
            [0, 128]
        );
        return result.code === 0 ? result.out.trim() : undefined;
    }

    async state(vaultId) {
        return this.locked(vaultId, async (repo) => {
            const branch = await this.branch(repo),
                status = await this.status(repo);
            const head = await this.head(repo);
            const lastCommitTime = head
                ? (
                      await this.run(repo, [
                          "show",
                          "-s",
                          "--format=%cI",
                          "HEAD",
                      ])
                  ).out.trim()
                : null;
            const unpushedCommits =
                branch.tracking && head
                    ? Number(
                          (
                              await this.run(repo, [
                                  "rev-list",
                                  "--count",
                                  "@{upstream}..HEAD",
                              ])
                          ).out.trim()
                      )
                    : 0;
            const config = Object.create(null),
                remotes = Object.create(null);
            for (const name of (await this.run(repo, ["remote"])).out
                .trim()
                .split("\n")
                .filter(Boolean)) {
                const url = await this.config(repo, `remote.${name}.url`);
                // Redact embedded credentials; keys/credential helpers never leave the server.
                if (url && /^[a-z]+:\/\//i.test(url)) {
                    try {
                        const parsed = new URL(url);
                        parsed.username = "";
                        parsed.password = "";
                        parsed.search = "";
                        parsed.hash = "";
                        remotes[name] = parsed.toString();
                    } catch {
                        remotes[name] = undefined;
                    }
                } else
                    remotes[name] =
                        url && !path.isAbsolute(url) ? url : undefined;
            }
            for (const key of ["user.name", "user.email"])
                config[key] = await this.config(repo, key);
            if (branch.current) {
                for (const suffix of ["remote", "merge"]) {
                    const key = `branch.${branch.current}.${suffix}`;
                    config[key] = await this.config(repo, key);
                }
            }
            return {
                status,
                branch,
                mergeInProgress: await this.unfinished(repo),
                lastCommitTime,
                unpushedCommits,
                config,
                remotes,
            };
        });
    }

    async report(repo, vaultId, reason, state, local, remote) {
        // Exclusive creation preserves all existing user/report files, including symlinks.
        const file = "git_conflict.md";
        const affected =
            local && remote
                ? (
                      await this.run(repo, [
                          "diff",
                          "--name-only",
                          "-z",
                          local,
                          remote,
                          "--",
                      ])
                  ).out
                      .split("\0")
                      .filter(Boolean)
                : [];
        const body = [
            "# Git Pull Conflict / Blocked Pull",
            "",
            `Detected: ${new Date().toISOString()}`,
            `Vault: ${JSON.stringify(vaultId)}`,
            `Branch: ${JSON.stringify(state.branch.current ?? "detached")}`,
            `Upstream: ${JSON.stringify(state.branch.tracking ?? "none")}`,
            "",
            "## Reason",
            reason,
            "",
            "## Local repository state",
            `Local HEAD: ${local ?? "unborn"}`,
            `Remote HEAD: ${remote ?? "unavailable"}`,
            `Unmerged files: ${state.status.conflicted.length}`,
            `Local changes: ${state.status.all.length ? "Yes" : "No"}`,
            "",
            "## Affected files / Git status",
            ...affected.map((file) => JSON.stringify(file)),
            "```text",
            ...state.status.all.map(
                (v) => `${v.index}${v.workingDir} ${JSON.stringify(v.path)}`
            ),
            "```",
            "",
            "## Recommended resolution",
            "Review local work and reconcile the repository manually in an authorized Git environment.",
            "No automatic reset, rebase, stash, commit or discard was performed.",
            "",
        ].join("\n");
        const exclude = path.join(repo, ".git", "info", "exclude");
        await fs.mkdir(path.dirname(exclude), { recursive: true });
        const existing = await fs.readFile(exclude, "utf8").catch((e) => {
            if (e.code === "ENOENT") return "";
            throw e;
        });
        if (!existing.split("\n").includes("/git_conflict.md"))
            await fs.appendFile(exclude, "\n/git_conflict.md\n");
        try {
            await fs.writeFile(path.join(repo, file), body, { flag: "wx" });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            return undefined;
        }
        return file;
    }

    async pull(vaultId) {
        return this.locked(vaultId, async (repo) => {
            const branch = await this.branch(repo);
            let status = await this.status(repo),
                local = await this.head(repo),
                remote = branch.tracking
                    ? await this.head(repo, "@{upstream}")
                    : undefined;
            const block = async (code, message) => {
                const reportFile = await this.report(
                    repo,
                    vaultId,
                    message,
                    { branch, status },
                    local,
                    remote
                );
                throw new GitServiceError(
                    code,
                    message +
                        (reportFile
                            ? " See git_conflict.md."
                            : " An existing git_conflict.md was preserved."),
                    409,
                    reportFile
                );
            };
            if ((await this.unfinished(repo)) || status.conflicted.length)
                await block(
                    "UNFINISHED_OPERATION",
                    "A merge, rebase or other Git operation is unfinished."
                );
            if (status.all.length)
                await block(
                    "PULL_BLOCKED_DIRTY",
                    "Local changes prevent a safe pull."
                );
            if (!branch.current || !branch.tracking || !local)
                throw new GitServiceError(
                    "NO_UPSTREAM",
                    "Pull requires an existing branch with a configured upstream. Configure it outside Ignis."
                );
            const remoteName = await this.config(
                repo,
                `branch.${branch.current}.remote`
            );
            if (!remoteName || remoteName.startsWith("-"))
                throw new GitServiceError(
                    "NO_UPSTREAM",
                    "The branch has no usable upstream remote."
                );
            await this.run(repo, [
                "fetch",
                "--no-recurse-submodules",
                "--",
                remoteName,
            ]);
            remote = await this.head(repo, "@{upstream}");
            if (!remote)
                throw new GitServiceError(
                    "NO_UPSTREAM",
                    "The configured upstream branch is unavailable."
                );
            if (
                local === remote ||
                (
                    await this.run(
                        repo,
                        ["merge-base", "--is-ancestor", remote, local],
                        [0, 1]
                    )
                ).code === 0
            )
                return { status: "up-to-date" };
            if (
                (
                    await this.run(
                        repo,
                        ["merge-base", "--is-ancestor", local, remote],
                        [0, 1]
                    )
                ).code !== 0
            )
                await block(
                    "DIVERGED",
                    "Local and remote history have diverged; no merge or rebase was attempted."
                );
            const tree = (await this.run(repo, ["ls-tree", "-r", remote])).out;
            if (/^(120000|160000) /m.test(tree))
                throw new GitServiceError(
                    "UNSUPPORTED_LAYOUT",
                    "The incoming tree contains symlinks or submodules, which this pilot does not support."
                );
            // Recheck after the network wait; another process may have edited the vault.
            status = await this.status(repo);
            if (
                status.all.length ||
                (await this.unfinished(repo)) ||
                (await this.head(repo)) !== local
            )
                await block(
                    "PULL_BLOCKED_DIRTY",
                    "Repository state changed during fetch; pull was stopped."
                );
            await this.rejectSymlinks(repo);
            try {
                await this.run(repo, [
                    "merge",
                    "--ff-only",
                    "--no-edit",
                    "--no-overwrite-ignore",
                    remote,
                ]);
            } catch (error) {
                if (
                    error.code === "GIT_FAILED" &&
                    (await this.head(repo)) === local
                )
                    await block(
                        "PULL_BLOCKED_CHECKOUT",
                        "Git could not safely update the working tree. Ignored file collisions or local changes may block checkout."
                    );
                throw error;
            }
            const next = await this.head(repo);
            const fields = (
                await this.run(repo, [
                    "diff",
                    "--name-status",
                    "-z",
                    "--no-renames",
                    local,
                    next,
                    "--",
                ])
            ).out.split("\0");
            const files = [];
            for (let i = 0; i + 1 < fields.length; i += 2) {
                if (fields[i])
                    files.push({
                        path: fields[i + 1],
                        vaultPath: fields[i + 1],
                        index: " ",
                        workingDir: fields[i],
                    });
            }
            return { status: "updated", files, outsideVault: 0 };
        });
    }

    kill(child) {
        try {
            if (process.platform !== "win32" && child.pid)
                process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }

    shutdown() {
        this.stopped = true;
        for (const child of this.children) this.kill(child);
    }
}
module.exports = { GitService };
