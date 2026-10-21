// Native Git state is authoritative. Snapshot metadata only makes abort stricter.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { GitServiceError } = require("./errors");
const LIMIT = 1024 * 1024;
const oid = (v) =>
    typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const digest = (v) => createHash("sha256").update(v).digest("hex");
function fail(code, message, status = 409) {
    throw new GitServiceError(code, message, status);
}
async function gitPath(service, repo, name) {
    const value = (
        await service.run(repo, ["rev-parse", "--git-path", name])
    ).out.trim();
    const resolved = path.resolve(repo, value);
    if (!resolved.startsWith(path.join(repo, ".git") + path.sep))
        fail(
            "UNSUPPORTED_LAYOUT",
            "Git metadata must remain inside the vault."
        );
    return resolved;
}
async function exists(file) {
    try {
        await fs.lstat(file);
        return true;
    } catch (e) {
        if (e.code === "ENOENT") return false;
        throw e;
    }
}
async function stages(service, repo) {
    return (await service.run(repo, ["ls-files", "-u", "-z"])).out
        .split("\0")
        .filter(Boolean)
        .map((line) => {
            const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(line);
            if (!match)
                fail(
                    "UNSUPPORTED_LAYOUT",
                    "Cannot decode unmerged index entries."
                );
            service.validateIndexPath(match[4]);
            return {
                mode: match[1],
                oid: match[2],
                stage: Number(match[3]),
                path: match[4],
            };
        });
}
async function state(service, repo) {
    let operation = "none";
    for (const [name, kind] of [
        ["rebase-merge", "rebase"],
        ["rebase-apply", "rebase"],
        ["REBASE_HEAD", "rebase"],
        ["CHERRY_PICK_HEAD", "cherry-pick"],
        ["REVERT_HEAD", "other"],
        ["sequencer", "other"],
        ["BISECT_LOG", "other"],
        ["MERGE_HEAD", "merge"],
    ]) {
        if (await exists(await gitPath(service, repo, name))) {
            operation = kind;
            break;
        }
    }
    const head = await service.head(repo);
    const branch = await service.branch(repo);
    const upstream = branch.tracking
        ? await service.head(repo, "@{upstream}")
        : undefined;
    const mergeHead =
        operation === "merge"
            ? (
                  await fs.readFile(
                      await gitPath(service, repo, "MERGE_HEAD"),
                      "utf8"
                  )
              ).trim()
            : undefined;
    if (mergeHead && !oid(mergeHead))
        fail(
            "UNSUPPORTED_OPERATION",
            "Only normal two-parent merges are supported."
        );
    const entries = await stages(service, repo);
    const unresolvedPaths = [];
    for (const file of [...new Set(entries.map((v) => v.path))]) {
        const list = entries.filter((v) => v.path === file);
        const availableStages = list.map((v) => v.stage);
        const key = availableStages.join("");
        let kind =
            {
                123: "content",
                12: "modify-delete",
                13: "modify-delete",
                23: "add-add",
            }[key] ?? "other";
        if (list.some((v) => !["100644", "100755"].includes(v.mode)))
            kind = "other";
        else
            for (const entry of list) {
                if (
                    (await blob(service, repo, entry.oid, entry.mode)).kind ===
                    "binary"
                ) {
                    kind = "binary";
                    break;
                }
            }
        unresolvedPaths.push({ path: file, kind, availableStages });
    }
    if (operation === "none" && entries.length) operation = "other";
    let diverged = false;
    if (operation === "none" && head && upstream && head !== upstream) {
        const a = await service.run(
            repo,
            ["merge-base", "--is-ancestor", head, upstream],
            [0, 1]
        );
        const b = await service.run(
            repo,
            ["merge-base", "--is-ancestor", upstream, head],
            [0, 1]
        );
        diverged = a.code === 1 && b.code === 1;
    }
    return {
        operation,
        kind:
            operation === "merge"
                ? entries.length
                    ? "merge-conflicted"
                    : "merge-awaiting-commit"
                : operation !== "none"
                  ? "rebase-or-other"
                  : diverged
                    ? "diverged"
                    : "clean",
        head: head ?? null,
        upstream: upstream
            ? { ref: branch.tracking, oid: upstream }
            : undefined,
        mergeHead,
        unresolvedPaths,
        canCommitMerge: operation === "merge" && !entries.length,
        canAbortMerge:
            operation === "merge" &&
            (await exists(
                await gitPath(service, repo, "obsidian-git-merge.json")
            )),
    };
}
function textContent(bytes, mode) {
    if (bytes.length > LIMIT)
        return { kind: "oversized", size: bytes.length, mode };
    if (bytes.includes(0)) return { kind: "binary", size: bytes.length, mode };
    try {
        return {
            kind: "text",
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            size: bytes.length,
            mode,
            hash: digest(bytes),
        };
    } catch {
        return { kind: "binary", size: bytes.length, mode };
    }
}
async function worktree(service, repo, file) {
    service.validateIndexPath(file);
    try {
        const stat = await fs.lstat(path.join(repo, file));
        if (!stat.isFile())
            fail(
                "UNSUPPORTED_OPERATION",
                "Only regular files can be inspected or resolved here."
            );
        if (stat.size > LIMIT) return { kind: "oversized", size: stat.size };
        return textContent(
            await fs.readFile(path.join(repo, file)),
            stat.mode & 0o111 ? "100755" : "100644"
        );
    } catch (e) {
        if (e.code === "ENOENT") return { kind: "missing", hash: "missing" };
        throw e;
    }
}
async function blob(service, repo, hash, mode) {
    if (!["100644", "100755"].includes(mode))
        return { kind: "unsupported", mode };
    const size = Number(
        (await service.run(repo, ["cat-file", "-s", hash])).out.trim()
    );
    if (size > LIMIT) return { kind: "oversized", size, mode };
    const { bytes } = await service.run(
        repo,
        ["cat-file", "blob", hash],
        [0],
        undefined,
        true
    );
    return textContent(bytes, mode);
}
async function content(service, repo, file, source) {
    service.validateIndexPath(file);
    if (source === "worktree") return worktree(service, repo, file);
    if (["base", "ours", "theirs"].includes(source)) {
        const entry = (await stages(service, repo)).find(
            (v) =>
                v.path === file &&
                v.stage === { base: 1, ours: 2, theirs: 3 }[source]
        );
        return entry
            ? blob(service, repo, entry.oid, entry.mode)
            : { kind: "missing", stageMissing: true };
    }
    let raw;
    if (source === "index")
        raw = (
            await service.run(repo, [
                "ls-files",
                "--stage",
                "-z",
                "--",
                `:(literal)${file}`,
            ])
        ).out;
    else if (source === "head") {
        const head = await service.head(repo);
        raw = head
            ? (
                  await service.run(repo, [
                      "ls-tree",
                      "-z",
                      head,
                      "--",
                      `:(literal)${file}`,
                  ])
              ).out
            : "";
    } else
        fail(
            "INVALID_REQUEST",
            "Choose head, index, worktree, base, ours or theirs.",
            400
        );
    const entries = raw.split("\0").filter(Boolean);
    const match = entries
        .map((line) =>
            /^(\d+) (?:blob )?([a-f0-9]+)(?: (\d))?\t([\s\S]+)$/.exec(line)
        )
        .find((v) => v && v[4] === file && (!v[3] || v[3] === "0"));
    if (!match && source === "index" && entries.length)
        fail(
            "UNMERGED_PATH",
            "The index has unresolved stages. Compare ours, base and theirs."
        );
    return match
        ? blob(service, repo, match[2], match[1])
        : { kind: "missing" };
}
async function diff(service, repo, file, kind) {
    service.validateIndexPath(file);
    if (!["staged", "unstaged"].includes(kind))
        fail("INVALID_REQUEST", "Choose staged or unstaged diff.", 400);
    const status = await service.status(repo);
    const row = status.all.find((v) => v.path === file);
    // Detect binary/non-UTF8 and oversized inputs before asking Git for a
    // textual patch, including files Git attributes would otherwise force to text.
    const sources =
        kind === "staged" ? ["head", "index"] : ["index", "worktree"];
    for (const source of sources) {
        let value;
        try {
            value = await content(
                service,
                repo,
                source === "head" && row?.from ? row.from : file,
                source
            );
        } catch (error) {
            // An unmerged index has no stage 0. Git can still produce a
            // combined diff; detailed stage comparisons use the split view.
            if (error.code === "UNMERGED_PATH") continue;
            throw error;
        }
        if (!["text", "missing"].includes(value.kind))
            return { kind: value.kind, diff: "" };
    }
    if (row?.index === "?" && kind === "unstaged") {
        const value = await worktree(service, repo, file);
        if (value.kind !== "text") return { kind: value.kind, diff: "" };
        const result = await service.run(
            repo,
            [
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                "/dev/null",
                file,
            ],
            [0, 1]
        );
        return { kind: "text", diff: result.out };
    }
    const result = await service.run(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...(kind === "staged" ? ["--cached"] : []),
        "--",
        `:(literal)${file}`,
        ...(row?.from ? [`:(literal)${row.from}`] : []),
    ]);
    return {
        kind: /(?:^|\n)Binary files /.test(result.out) ? "binary" : "text",
        diff: result.out,
    };
}
async function snapshot(service, repo) {
    const tracked = (
        await service.run(repo, ["ls-files", "-z", "--cached"])
    ).out
        .split("\0")
        .filter(Boolean);
    const files = Object.create(null);
    for (const file of [...new Set(tracked)].sort()) {
        service.validateIndexPath(file);
        const stat = await fs.lstat(path.join(repo, file)).catch((e) => {
            if (e.code === "ENOENT") return undefined;
            throw e;
        });
        if (stat && (!stat.isFile() || stat.size > service.maxOutput))
            fail(
                "MERGE_ABORT_UNSAFE",
                "A merge file cannot be safely fingerprinted. Preserve work and recover outside Ignis."
            );
        files[file] = stat
            ? `${stat.mode & 0o777}:${digest(await fs.readFile(path.join(repo, file)))}`
            : "missing";
    }
    return {
        files,
        index: digest(
            (await service.run(repo, ["ls-files", "--stage", "-z"])).out
        ),
    };
}
async function owner(repo) {
    if (
        typeof process.getuid !== "function" ||
        process.getuid() === 0 ||
        process.getuid() !== (await fs.stat(repo)).uid
    )
        fail(
            "OWNERSHIP",
            "Run Ignis as the non-root vault owner before merging or aborting.",
            403
        );
}
async function start(service, repo, input) {
    await owner(repo);
    if (
        input.confirmed !== true ||
        !oid(input.expectedHead) ||
        !oid(input.expectedUpstream)
    )
        fail(
            "INVALID_REQUEST",
            "Confirm merge with the reviewed HEAD and upstream OIDs.",
            400
        );
    const before = await state(service, repo);
    if (before.operation !== "none")
        fail("MERGE_IN_PROGRESS", "Finish the current Git operation first.");
    if (
        before.head !== input.expectedHead ||
        before.upstream?.oid !== input.expectedUpstream
    )
        fail(
            "STALE_MERGE_STATE",
            "HEAD or upstream changed. Review incoming changes again."
        );
    if (before.kind !== "diverged")
        fail(
            "STALE_MERGE_STATE",
            "History is no longer diverged. Refresh and Pull again."
        );
    const branch = await service.branch(repo);
    if (!branch.current)
        fail("DETACHED_HEAD", "Check out a branch before starting a merge.");
    if (!branch.tracking)
        fail("NO_UPSTREAM", "Merge requires a branch with an upstream.");
    if ((await service.status(repo)).all.length)
        fail(
            "WORKTREE_DIRTY",
            "Unsafe to merge due to local changes. Commit or preserve them first."
        );
    for (const ref of [before.head, before.upstream.oid]) {
        const tree = (await service.run(repo, ["ls-tree", "-r", ref])).out;
        if (/^(120000|160000) /m.test(tree))
            fail(
                "UNSUPPORTED_LAYOUT",
                "Merge trees containing symlinks or submodules are unsupported."
            );
    }
    await service.checkPendingWrites(repo);
    let failure;
    try {
        await service.run(repo, [
            "-c",
            "merge.autoStash=false",
            "-c",
            "rerere.enabled=false",
            "-c",
            "merge.conflictStyle=diff3",
            "-c",
            "commit.gpgSign=false",
            "merge",
            "--no-commit",
            "--no-ff",
            "--no-overwrite-ignore",
            before.upstream.oid,
        ]);
    } catch (e) {
        failure = e;
    }
    const after = await state(service, repo);
    if (after.operation !== "merge") {
        if (failure) throw failure;
        fail(
            "GIT_FAILED",
            "Git did not establish a pending merge. Refresh repository state."
        );
    }
    if (after.head !== before.head || after.mergeHead !== before.upstream.oid)
        fail(
            "STALE_MERGE_STATE",
            "Repository changed during merge. Preserve files and inspect Git state."
        );
    await fs.writeFile(
        await gitPath(service, repo, "obsidian-git-merge.json"),
        JSON.stringify({
            head: before.head,
            mergeHead: after.mergeHead,
            snapshot: await snapshot(service, repo),
        }),
        { mode: 0o600 }
    );
    await report(service, repo, input.vaultId, after);
    if (failure && failure.code !== "GIT_FAILED") throw failure;
    return after;
}
async function resolve(service, repo, input) {
    await owner(repo);
    service.validateIndexPath(input.path);
    if (input.path === "git_conflict.md")
        fail("INVALID_PATH", "The conflict report cannot be staged.", 400);
    const current = await state(service, repo);
    if (current.operation !== "merge")
        fail(
            "UNSUPPORTED_OPERATION",
            "Only normal merge conflicts can be resolved in Ignis."
        );
    if (
        input.expectedMergeHead !== current.mergeHead ||
        input.expectedHead !== current.head
    )
        fail(
            "STALE_MERGE_STATE",
            "Merge state changed. Review the file again."
        );
    if (
        input.confirmed !== true ||
        !current.unresolvedPaths.some((v) => v.path === input.path)
    )
        fail(
            "STALE_MERGE_STATE",
            "This path is no longer an unresolved merge conflict."
        );
    const conflict = current.unresolvedPaths.find((v) => v.path === input.path);
    if (["other", "rename", "binary"].includes(conflict.kind))
        fail(
            "UNSUPPORTED_OPERATION",
            "Resolve this non-text or complex conflict in an authorized Git environment; its index stages are preserved."
        );
    const value = await worktree(service, repo, input.path);
    if (value.kind !== "text" && value.kind !== "missing")
        fail(
            "UNSUPPORTED_OPERATION",
            "Resolve binary or oversized files in an authorized Git environment."
        );
    if (value.hash !== input.expectedHash)
        fail(
            "STALE_MERGE_STATE",
            "File content changed since review. Save, refresh and review it again."
        );
    if (value.kind === "missing" && input.delete !== true)
        fail(
            "CONFLICT_NOT_RESOLVED",
            "Explicitly confirm keeping this file deleted."
        );
    if (
        value.kind === "text" &&
        /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |$)/m.test(value.text) &&
        input.allowMarkers !== true
    )
        fail(
            "CONFLICT_NOT_RESOLVED",
            "Conflict markers remain. Resolve them or explicitly acknowledge intentional literal markers."
        );
    await service.checkPendingWrites(repo);
    const oldIndex = await fs.readFile(await gitPath(service, repo, "index"));
    await service.stageChanges(repo, [{ path: input.path }]);
    const next = await worktree(service, repo, input.path);
    const indexed = await content(service, repo, input.path, "index");
    if (
        next.hash !== value.hash ||
        (value.kind === "text"
            ? indexed.hash !== value.hash
            : indexed.kind !== "missing")
    ) {
        // Restore only the index we held under the repository lock, never the note.
        await fs.writeFile(await gitPath(service, repo, "index"), oldIndex);
        fail(
            "STALE_MERGE_STATE",
            "File changed while staging. The prior index was restored; your file was preserved."
        );
    }
    const after = await state(service, repo);
    await report(service, repo, input.vaultId, after);
    return after;
}
async function abort(service, repo, input) {
    await owner(repo);
    const current = await state(service, repo);
    if (current.operation !== "merge")
        fail(
            "UNSUPPORTED_OPERATION",
            "Abort merge requires an active normal merge."
        );
    if (
        input.confirmed !== true ||
        !oid(input.expectedMergeHead) ||
        input.expectedMergeHead !== current.mergeHead ||
        input.expectedHead !== current.head
    )
        fail("STALE_MERGE_STATE", "Confirm the current merge before aborting.");
    let saved;
    try {
        saved = JSON.parse(
            await fs.readFile(
                await gitPath(service, repo, "obsidian-git-merge.json"),
                "utf8"
            )
        );
    } catch {
        fail(
            "MERGE_ABORT_UNSAFE",
            "No trustworthy merge snapshot is available. Preserve your work and abort in an authorized Git environment."
        );
    }
    if (
        saved.head !== current.head ||
        saved.mergeHead !== current.mergeHead ||
        JSON.stringify(saved.snapshot) !==
            JSON.stringify(await snapshot(service, repo))
    )
        fail(
            "MERGE_ABORT_UNSAFE",
            "Files or the index changed after merge started. Preserve your resolution edits before aborting outside Ignis."
        );
    await service.checkPendingWrites(repo);
    const untracked = (
        await service.run(repo, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ])
    ).out
        .split("\0")
        .filter(Boolean);
    const hashes = await Promise.all(
        untracked.map(async (file) => [
            file,
            digest(await fs.readFile(path.join(repo, file))),
        ])
    );
    try {
        await service.run(repo, ["merge", "--abort"]);
    } catch {
        fail(
            "MERGE_ABORT_UNSAFE",
            "Git refused abort. Merge state and files were retained; preserve your work and inspect the repository outside Ignis."
        );
    }
    const after = await state(service, repo);
    if (
        after.operation !== "none" ||
        after.unresolvedPaths.length ||
        after.head !== saved.head ||
        (await service.status(repo)).all.some((v) => v.index !== "?")
    )
        fail(
            "MERGE_ABORT_UNSAFE",
            "Abort finished with unexpected repository state. Inspect files before continuing."
        );
    for (const [file, hash] of hashes)
        if (digest(await fs.readFile(path.join(repo, file))) !== hash)
            fail(
                "MERGE_ABORT_UNSAFE",
                "An untracked file changed during abort. Inspect repository state."
            );
    await fs.unlink(await gitPath(service, repo, "obsidian-git-merge.json"));
    await report(
        service,
        repo,
        input.vaultId,
        after,
        "Merge aborted; pre-merge HEAD and tracked state verified."
    );
    return after;
}
async function report(service, repo, vaultId, current, reason) {
    const branch = await service.branch(repo);
    const status = await service.status(repo);
    await service.report(
        repo,
        vaultId,
        reason ??
            (current.kind === "merge-conflicted"
                ? "Merge in progress: resolve each conflict, save and mark resolved, then Commit."
                : "All paths resolved; finish merge commit."),
        { branch, status, merge: current },
        current.head,
        current.upstream?.oid
    );
}
module.exports = {
    state,
    content,
    diff,
    stages,
    start,
    resolve,
    abort,
    report,
    gitPath,
    digest,
};
