const fs = require("node:fs/promises");
const { GitServiceError } = require("./errors");

function unsupported() {
    return new GitServiceError(
        "PUSH_CONFIG_UNSUPPORTED",
        "Push requires one safe configured remote and a single current-branch destination. Configure it outside Ignis; matching/mirror/force/tag pushes and executable repository configuration are unsupported."
    );
}
async function values(service, repo, key) {
    const { code, out } = await service.run(
        repo,
        ["config", "--null", "--get-all", key],
        [0, 1]
    );
    return code ? [] : out.split("\0").slice(0, -1);
}
async function single(service, repo, key) {
    const all = await values(service, repo, key);
    if (all.length > 1) throw unsupported();
    return all[0];
}
async function validRef(service, repo, ref) {
    if (
        !ref.startsWith("refs/heads/") ||
        (await service.run(repo, ["check-ref-format", ref], [0, 1])).code
    )
        throw unsupported();
    return ref;
}

// Resolve config locally; no browser input or implicit `git push` ref selection.
async function target(service, repo) {
    const branch = (await service.branch(repo)).current;
    const head = await service.head(repo);
    if (!branch || !head) return { blocked: "no-branch" };
    const source = await validRef(service, repo, `refs/heads/${branch}`);
    const get = (key) => single(service, repo, key);
    const upstreamRemote = await get(`branch.${branch}.remote`);
    const names = (await service.run(repo, ["remote"])).out
        .trim()
        .split("\n")
        .filter(Boolean);
    const fallbackRemote =
        names.length === 1
            ? names[0]
            : names.includes("origin")
              ? "origin"
              : undefined;
    const fetchRemote = upstreamRemote ?? fallbackRemote;
    const remote =
        (await get(`branch.${branch}.pushRemote`)) ??
        (await get("remote.pushDefault")) ??
        fetchRemote;
    if (!remote) return { missing: true };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote) || !names.includes(remote))
        throw unsupported();
    const mirror = await service.run(
        repo,
        ["config", "--bool", "--get", `remote.${remote}.mirror`],
        [0, 1]
    );
    if (mirror.code === 0 && mirror.out.trim() === "true") throw unsupported();
    const mappings = await values(service, repo, `remote.${remote}.push`);
    let ref;
    if (mappings.length) {
        if (mappings.length !== 1) throw unsupported();
        const parts = mappings[0].split(":");
        if (parts.length !== 2 || ![source, branch, "HEAD"].includes(parts[0]))
            throw unsupported();
        ref = await validRef(service, repo, parts[1]);
    } else {
        const mode = (await get("push.default")) ?? "simple";
        if (mode === "nothing") return { missing: true };
        if (!["simple", "current", "upstream"].includes(mode))
            throw unsupported();
        if (
            mode === "current" ||
            (mode === "simple" && remote !== fetchRemote)
        ) {
            ref = source;
        } else {
            const merge = await get(`branch.${branch}.merge`);
            if (!merge) return { missing: true };
            if (remote !== upstreamRemote) throw unsupported();
            ref = await validRef(service, repo, merge);
            if (mode === "simple" && ref !== source) throw unsupported();
        }
    }
    const urls = await values(service, repo, `remote.${remote}.pushurl`);
    const selected = urls.length
        ? urls
        : await values(service, repo, `remote.${remote}.url`);
    if (selected.length !== 1) throw unsupported();
    const url = selected[0];
    // Passing a URL directly must not resolve a second named remote whose
    // mirror/helper/ref policies could replace our validated remote policy.
    if (!url || /[\x00-\x20\x7f]/.test(url) || url.startsWith("-"))
        throw unsupported();
    if (
        names.includes(url) ||
        (await values(service, repo, `remote.${url}.url`)).length ||
        (await values(service, repo, `remote.${url}.mirror`)).length
    )
        throw unsupported();
    let protocol;
    if (/^(https|ssh):\/\//.test(url)) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw unsupported();
        }
        if (
            !parsed.hostname ||
            parsed.hostname.startsWith("-") ||
            (parsed.protocol === "ssh:" &&
                !/^[a-zA-Z0-9._-]*$/.test(parsed.username)) ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            (parsed.protocol === "https:" && parsed.username)
        )
            throw unsupported();
        protocol = parsed.protocol.slice(0, -1);
    } else if (
        /^(?:[\w.-]+@)?[a-zA-Z0-9][\w.-]*:[^:]+$/.test(url) &&
        !url.includes("://") &&
        !url.includes("::")
    ) {
        protocol = "ssh";
    } else if (service.pushTestRoot && require("node:path").isAbsolute(url)) {
        // Constructor-only fixture policy: never exposed through routes/config.
        // Local remotes must be real bare directories within the temporary root.
        const path = require("node:path");
        const real = await fs.realpath(url);
        if (
            !real.startsWith(service.pushTestRoot + path.sep) ||
            (
                await service.run(real, ["rev-parse", "--is-bare-repository"])
            ).out.trim() !== "true"
        )
            throw unsupported();
        protocol = "file";
    } else throw unsupported();
    return { branch, head, source, remote, ref, url, protocol };
}

async function safeConfig(service, repo) {
    // Includes and executable overrides in vault-local configuration are not a
    // credential provisioning mechanism. Global credentials/SSH env are trusted
    // administrator configuration; URL rewriting is refused at every scope.
    const local = (
        await service.run(repo, ["config", "--local", "--name-only", "--list"])
    ).out;
    if (
        /^(?:include(?:if\..*)?\.path|extensions\.worktreeconfig|core\.(?:sshcommand|gitproxy|askpass)|credential\.|http\.|protocol\.|remote\..*\.(?:receivepack|uploadpack|proxy|vcs))\b/im.test(
            local
        )
    )
        throw unsupported();
    const rewrites = await service.run(
        repo,
        ["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
        [0, 1]
    );
    if (
        rewrites.code === 0 ||
        (await values(service, repo, "push.pushOption")).length
    )
        throw unsupported();
}
function networkArgs(destination) {
    return [
        "-c",
        "protocol.allow=never",
        "-c",
        `protocol.${destination.protocol}.allow=always`,
        "-c",
        "core.sshCommand=ssh",
        "-c",
        "core.gitProxy=",
        "-c",
        "push.followTags=false",
        "-c",
        "push.negotiate=false",
        "-c",
        "fetch.prune=false",
        "-c",
        "fetch.pruneTags=false",
        "-c",
        "push.recurseSubmodules=no",
    ];
}
async function remoteHead(service, repo, destination) {
    const { out } = await service.run(repo, [
        ...networkArgs(destination),
        "ls-remote",
        "--refs",
        "--upload-pack=git-upload-pack",
        "--",
        destination.url,
        destination.ref,
    ]);
    const lines = out.trim().split("\n").filter(Boolean);
    if (!lines.length) return undefined;
    if (lines.length !== 1) throw unsupported();
    const [oid, ref] = lines[0].split("\t");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || ref !== destination.ref)
        throw unsupported();
    return oid;
}
async function remoteObject(service, repo, destination, published) {
    const exists = async () =>
        !(
            await service.run(
                repo,
                ["cat-file", "-e", `${published}^{commit}`],
                [0, 1, 128]
            )
        ).code;
    if (await exists()) return;
    await service.run(repo, [
        ...networkArgs(destination),
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "--upload-pack=git-upload-pack",
        "--no-recurse-submodules",
        "--",
        destination.url,
        destination.ref,
    ]);
    if (!(await exists()))
        throw new GitServiceError(
            "PUSH_OUTCOME_UNCERTAIN",
            "The remote changed during Push preflight. Refresh before retrying."
        );
}
async function pending(service, repo, destination, published) {
    if (published === destination.head) return 0;
    if (!published)
        return Number(
            (
                await service.run(repo, [
                    "rev-list",
                    "--count",
                    destination.head,
                ])
            ).out.trim()
        );
    await remoteObject(service, repo, destination, published);
    return Number(
        (
            await service.run(repo, [
                "rev-list",
                "--count",
                `${published}..${destination.head}`,
            ])
        ).out.trim()
    );
}
async function guard(service, repo) {
    const unmerged = (
        await service.run(
            repo,
            ["ls-files", "--unmerged", "-z"],
            [0],
            undefined,
            true
        )
    ).bytes;
    if (unmerged.length)
        return {
            status: "blocked",
            reason: "conflicts",
            files: new Set(
                unmerged
                    .toString("latin1")
                    .split("\0")
                    .filter(Boolean)
                    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
            ).size,
        };
    if (await service.unfinished(repo))
        return { status: "blocked", reason: "merge-in-progress" };
}
async function inspect(service, repo) {
    await safeConfig(service, repo);
    const destination = await target(service, repo);
    if (destination.blocked)
        return {
            configured: false,
            canPush: false,
            unpushedCommits: 0,
            blocked: destination.blocked,
        };
    if (destination.missing)
        return { configured: false, canPush: false, unpushedCommits: 0 };
    const blocked = await guard(service, repo);
    const published = await remoteHead(service, repo, destination);
    const count = await pending(service, repo, destination, published);
    return {
        configured: true,
        canPush: !blocked && count !== 0,
        unpushedCommits: count,
        destination,
        published,
        blocked,
    };
}
async function readiness(service, repo) {
    const { configured, canPush, unpushedCommits } = await inspect(
        service,
        repo
    );
    return { configured, canPush, unpushedCommits };
}
async function push(service, repo) {
    const blocked = await guard(service, repo);
    if (blocked) return blocked;
    const {
        configured,
        destination,
        published,
        blocked: stateBlocked,
    } = await inspect(service, repo);
    if (!configured)
        return stateBlocked === "no-branch"
            ? { status: "blocked", reason: "no-branch" }
            : { status: "skipped", reason: "no-upstream" };
    if (published === destination.head) return { status: "up-to-date" };
    let files = null;
    if (published) {
        await remoteObject(service, repo, destination, published);
        if (
            (
                await service.run(
                    repo,
                    [
                        "merge-base",
                        "--is-ancestor",
                        published,
                        destination.head,
                    ],
                    [0, 1]
                )
            ).code
        ) {
            if (
                !(
                    await service.run(
                        repo,
                        [
                            "merge-base",
                            "--is-ancestor",
                            destination.head,
                            published,
                        ],
                        [0, 1]
                    )
                ).code
            )
                return { status: "up-to-date" };
            throw nonFastForward();
        }
        const { bytes } = await service.run(
            repo,
            [
                "diff",
                "--name-only",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "-z",
                published,
                destination.head,
                "--",
            ],
            [0],
            undefined,
            true
        );
        files = bytes.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
    }
    // Pin the source OID: an external writer cannot change what this request
    // publishes between preflight and execution. Git rejects remote races.
    const finalGuard = await guard(service, repo);
    if (finalGuard) return finalGuard;
    if (
        (await service.head(repo)) !== destination.head ||
        (await service.branch(repo)).current !== destination.branch
    )
        throw new GitServiceError(
            "REPOSITORY_CHANGED",
            "The current branch changed during Push. Refresh and review before retrying."
        );
    const result = await service.run(repo, [
        ...networkArgs(destination),
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--signed=false",
        "--receive-pack=git-receive-pack",
        "--",
        destination.url,
        `${destination.head}:${destination.ref}`,
    ]);
    const lines = result.out
        .split("\n")
        .filter((line) => /^[ *+=]\t/.test(line));
    if (lines.length !== 1)
        throw new GitServiceError(
            "PUSH_OUTCOME_UNCERTAIN",
            "Push may have completed. Refresh and inspect the remote before retrying."
        );
    try {
        if ((await remoteHead(service, repo, destination)) !== destination.head)
            throw new Error("remote changed");
    } catch {
        throw new GitServiceError(
            "PUSH_OUTCOME_UNCERTAIN",
            "Push may have completed, but remote verification failed. Inspect the remote before retrying."
        );
    }
    if (lines[0].startsWith("=")) return { status: "up-to-date" };
    return { status: "pushed", files };
}
function nonFastForward() {
    return new GitServiceError(
        "PUSH_NON_FAST_FORWARD",
        "The remote has changes. Pull/merge remote changes first, then Push again."
    );
}
module.exports = { push, readiness, target, nonFastForward };
