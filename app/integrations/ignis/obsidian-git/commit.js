const { GitServiceError, publicError } = require("./errors");
const fs = require("node:fs/promises");

const MESSAGE_BYTES = 16 * 1024;
const MAX_BLOB_BYTES = 100000000;

function reject(code, message, status = 409) {
    throw new GitServiceError(code, message, status);
}

async function indexEntries(service, repo) {
    const entries = (await service.run(repo, ["ls-files", "--stage", "-z"])).out
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
            const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
            if (!match)
                reject(
                    "UNSUPPORTED_LAYOUT",
                    "The Git index could not be validated."
                );
            const [, mode, hash, stage, file] = match;
            service.validateIndexPath(file);
            if (
                file === "git_conflict.md" ||
                file.startsWith("git_conflict.md/")
            )
                reject(
                    "CONFLICT_REPORT_STAGED",
                    "The conflict report is tracked or staged. Preserve it and remove it from the index outside Ignis before committing."
                );
            if (stage !== "0")
                reject(
                    "UNMERGED_INDEX",
                    "Resolve and mark every conflict resolved in Source Control before committing."
                );
            if (!["100644", "100755"].includes(mode))
                reject(
                    "UNSUPPORTED_LAYOUT",
                    "Committing symlinks or submodules is unsupported in Ignis."
                );
            return { hash, file };
        });
    return entries;
}

async function validateState(service, repo) {
    const entries = await indexEntries(service, repo);
    const merge = await require("./merge").state(service, repo);
    if (merge.operation !== "none" && merge.operation !== "merge")
        reject(
            "UNFINISHED_OPERATION",
            "Finish or abort the merge, rebase, cherry-pick, revert or bisect outside Ignis before committing."
        );
    if (merge.operation === "merge" && merge.mergeHead === merge.head)
        reject(
            "UNFINISHED_OPERATION",
            "Invalid merge metadata. Inspect this operation outside Ignis."
        );
    // Also protect a tracked report staged for deletion (absent from the index).
    const head = await service.head(repo);
    if (
        head &&
        (
            await service.run(repo, [
                "ls-tree",
                "-r",
                "--name-only",
                "-z",
                head,
                "--",
                "git_conflict.md",
            ])
        ).out
    )
        reject(
            "CONFLICT_REPORT_STAGED",
            "The conflict report is tracked in HEAD. Preserve it and reconcile its tracking outside Ignis before committing."
        );
    return { entries, head, merge };
}

async function commit(service, repo, input) {
    if (
        !["staged", "all", "smart"].includes(input.mode) ||
        typeof input.amend !== "boolean" ||
        (input.mode === "smart"
            ? typeof input.autoStageOnEmptyIndex !== "boolean"
            : input.autoStageOnEmptyIndex !== undefined)
    )
        reject(
            "INVALID_REQUEST",
            "Choose staged, all, or smart commit with explicit boolean options.",
            400
        );
    if (input.amend)
        reject(
            "AMEND_UNSUPPORTED",
            "Amend is unavailable in Ignis: publication state cannot be established reliably without contacting remotes."
        );
    if (
        typeof input.message !== "string" ||
        !input.message.trim() ||
        input.message.includes("\0") ||
        Buffer.byteLength(input.message, "utf8") > MESSAGE_BYTES
    )
        reject(
            "INVALID_COMMIT_MESSAGE",
            "Enter a nonempty commit message of at most 16 KiB UTF-8, without NUL characters.",
            400
        );
    if (
        typeof process.getuid !== "function" ||
        process.getuid() === 0 ||
        process.getuid() !== (await fs.stat(repo)).uid
    )
        reject(
            "OWNERSHIP",
            "Run Ignis as the non-root vault owner (configure the container UID/GID) before committing.",
            403
        );
    const branch = await service.branch(repo);
    if (!branch.current)
        reject(
            "DETACHED_HEAD",
            "Check out a branch outside Ignis before committing; HEAD is detached."
        );
    const before = await validateState(service, repo);
    let status = await service.status(repo);
    const stageAll =
        before.merge.operation !== "merge" &&
        (input.mode === "all" ||
            (input.mode === "smart" &&
                !status.staged.length &&
                input.autoStageOnEmptyIndex));
    if (
        !stageAll &&
        !status.staged.length &&
        before.merge.operation !== "merge"
    )
        return { status: "nothing-to-commit", reason: "nothing-staged" };
    if (
        stageAll &&
        !status.staged.length &&
        !status.changed.some((file) => file.path !== "git_conflict.md")
    )
        return { status: "nothing-to-commit", reason: "no-changes" };
    // Require deployment-owned local identity; never infer an identity from the browser.
    const name = await service.config(repo, "user.name");
    const email = await service.config(repo, "user.email");
    if (!name || !email)
        reject(
            "GIT_IDENTITY_MISSING",
            "Configure repository-local user.name and user.email as the vault owner on the Ignis server before committing."
        );
    let commitStarted = false;
    try {
        if (stageAll) await service.stageChanges(repo, status.changed);
        const current = await validateState(service, repo);
        status = await service.status(repo);
        if (!status.staged.length && before.merge.operation !== "merge")
            return { status: "nothing-to-commit", reason: "no-changes" };
        const changedPaths = new Set(status.staged.map((file) => file.path));
        const hashes = [
            ...new Set(
                current.entries
                    .filter((entry) => changedPaths.has(entry.file))
                    .map((entry) => entry.hash)
            ),
        ];
        if (hashes.length) {
            const sizes = (
                await service.run(
                    repo,
                    ["cat-file", "--batch-check=%(objectsize)"],
                    [0],
                    hashes.join("\n") + "\n"
                )
            ).out
                .trim()
                .split("\n");
            if (
                sizes.length !== hashes.length ||
                sizes.some((size) => !/^\d+$/.test(size))
            )
                reject(
                    "GIT_COMMIT_FAILED",
                    "Unable to validate staged object sizes."
                );
            if (sizes.some((size) => Number(size) >= MAX_BLOB_BYTES))
                reject(
                    "FILE_TOO_LARGE",
                    "A staged blob is at least 100 MB. Remove it from the index or configure LFS outside Ignis before committing."
                );
        }
        const tree = (await service.run(repo, ["write-tree"])).out.trim();
        if (
            current.head !== before.head ||
            (await service.head(repo)) !== before.head ||
            current.merge.operation !== before.merge.operation ||
            current.merge.mergeHead !== before.merge.mergeHead
        )
            reject(
                "REPOSITORY_CHANGED",
                "Another process changed repository state. Review the index before retrying."
            );
        commitStarted = true;
        await service.run(
            repo,
            [
                "-c",
                "commit.gpgSign=false",
                "-c",
                `user.name=${name}`,
                "-c",
                `user.email=${email}`,
                "-c",
                `author.name=${name}`,
                "-c",
                `author.email=${email}`,
                "-c",
                `committer.name=${name}`,
                "-c",
                `committer.email=${email}`,
                "commit",
                "--no-gpg-sign",
                "--cleanup=verbatim",
                "-F",
                "-",
            ],
            [0],
            input.message
        );
        const next = await service.head(repo);
        if (!next || next === before.head)
            reject(
                "GIT_COMMIT_OUTCOME_UNCERTAIN",
                "Git did not confirm a new HEAD. Inspect history and staged state before retrying."
            );
        const actualTree = (
            await service.run(repo, ["show", "-s", "--format=%T", next])
        ).out.trim();
        const parents = (
            await service.run(repo, ["show", "-s", "--format=%P", next])
        ).out.trim();
        if (
            actualTree !== tree ||
            parents !==
                [before.head, before.merge.mergeHead]
                    .filter(Boolean)
                    .join(" ") ||
            (await service.branch(repo)).current !== branch.current
        )
            reject(
                "GIT_COMMIT_OUTCOME_UNCERTAIN",
                "Repository history changed unexpectedly during commit. Inspect history before retrying; a commit may already exist."
            );
        const files = new Set(
            (
                await service.run(repo, [
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--name-only",
                    "--no-renames",
                    "-r",
                    "-z",
                    ...(before.merge.operation === "merge"
                        ? [before.head, next]
                        : [next]),
                ])
            ).out
                .split("\0")
                .filter(Boolean)
        ).size;
        if (!files && before.merge.operation !== "merge")
            reject(
                "GIT_COMMIT_OUTCOME_UNCERTAIN",
                "An unexpected empty commit was observed. Inspect history before retrying."
            );
        const merge = await require("./merge").state(service, repo);
        if (merge.operation !== "none" || merge.unresolvedPaths.length)
            reject(
                "GIT_COMMIT_OUTCOME_UNCERTAIN",
                "Commit left unexpected Git operation state. Inspect repository before retrying."
            );
        if (before.merge.operation === "merge") {
            await require("./merge").report(
                service,
                repo,
                input.vaultId,
                merge,
                "Merge complete; two-parent commit verified: " + next
            );
        }
        return {
            status: "committed",
            merge,
            repositoryStatus: await service.status(repo),
            commit: {
                hash: next,
                shortHash: next.slice(0, 12),
                files,
                branch: branch.current,
            },
        };
    } catch (error) {
        if (commitStarted) {
            let head;
            let inspected = false;
            try {
                head = await service.head(repo);
                inspected = true;
            } catch {
                /* cannot establish outcome */
            }
            if (
                !inspected ||
                head !== before.head ||
                ["TIMEOUT", "OUTPUT_LIMIT", "UNAVAILABLE"].includes(error.code)
            )
                reject(
                    "GIT_COMMIT_OUTCOME_UNCERTAIN",
                    "Commit outcome is uncertain. A commit may already exist; inspect history and index before retrying. Changes may remain staged."
                );
        }
        // Never reset the index after staging or attempt automatic retries.
        const safe = publicError(error);
        throw new GitServiceError(
            safe.code,
            `${safe.message}${stageAll ? " Changes may remain staged; review Source Control before retrying." : " No index rollback was attempted."}`,
            safe.status
        );
    }
}
module.exports = { commit };
