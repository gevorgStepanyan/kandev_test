import { sha256 } from "js-sha256";
import { GeneralModal } from "src/ui/modals/generalModal";
import type { MergeState, MergeWorkflow } from "./mergeWorkflow";
import { MarkdownView, moment } from "obsidian";
import { GitManager } from "./gitManager";
import {
    pushState,
    pushResult,
    type IgnisPushState,
    fileEntries,
    ignisRequest,
    record,
    repositoryState,
    mergeState,
    fileContent,
    conflictDetails,
    type IgnisRepositoryState,
    type IgnisMutationPayload,
    type IgnisCommitRequest,
} from "./ignisGitClient";
import {
    IgnisGitError,
    IgnisUnsupportedGitFeatureError,
} from "src/platform/ignis";
import {
    GitOperation,
    type BranchInfo,
    type PullResult,
    type PushResult,
    type Status,
    type UnstagedFile,
} from "src/types";

export class IgnisGitManager extends GitManager implements MergeWorkflow {
    override readonly mergeWorkflow = this;
    canResolveTextConflicts = false;
    private controllers = new Set<AbortController>();
    private pendingState?: Promise<IgnisRepositoryState>;
    private stateExpires = 0;
    private unloaded = false;
    private pendingPushState?: Promise<IgnisPushState>;
    private pushStateExpires = 0;

    private transportTail: Promise<unknown> = Promise.resolve();
    private request(
        endpoint: string,
        post = false,
        payload: IgnisMutationPayload = {}
    ): Promise<unknown> {
        const next = this.transportTail.then(() =>
            this.requestNow(endpoint, post, payload)
        );
        this.transportTail = next.catch(() => {});
        return next;
    }
    private async requestNow(
        endpoint: string,
        post = false,
        payload: IgnisMutationPayload = {}
    ): Promise<unknown> {
        if (this.unloaded)
            throw new IgnisGitError(
                "UNLOADED",
                "The Ignis Git manager has unloaded."
            );
        if (this.plugin.settings.basePath || this.plugin.settings.gitDir)
            throw new IgnisGitError(
                "UNSUPPORTED_LAYOUT",
                "The Ignis pilot requires the repository at the vault root, with no custom base path or Git directory."
            );
        const vaultId = window.__currentVaultId;
        if (!vaultId)
            throw new IgnisGitError(
                "VAULT_MISSING",
                "Ignis has not identified the active vault."
            );
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = window.setTimeout(() => controller.abort(), 120000);
        try {
            return await ignisRequest(
                endpoint,
                vaultId,
                controller.signal,
                post,
                payload
            );
        } finally {
            window.clearTimeout(timer);
            this.controllers.delete(controller);
        }
    }

    private state(): Promise<IgnisRepositoryState> {
        if (!this.pendingState || Date.now() >= this.stateExpires) {
            this.stateExpires = Number.POSITIVE_INFINITY;
            const request = this.request("state")
                .then(repositoryState)
                .then((value) => {
                    this.canResolveTextConflicts =
                        value.merge?.operation === "merge";
                    return value;
                });
            this.pendingState = request;
            void request.then(
                () => {
                    this.stateExpires = Date.now() + 1000;
                },
                () => {
                    if (this.pendingState === request)
                        this.pendingState = undefined;
                    this.pendingPushState = undefined;
                }
            );
        }
        return this.pendingState;
    }

    async checkRequirements(): Promise<
        "valid" | "missing-repo" | "missing-git"
    > {
        const value = await this.request("health");
        if (
            !record(value) ||
            !["valid", "missing-repo", "missing-git"].includes(
                String(value.requirements)
            )
        )
            throw new IgnisGitError(
                "INVALID_RESPONSE",
                "Invalid Ignis Git requirements response."
            );
        return value.requirements as "valid" | "missing-repo" | "missing-git";
    }
    async status(opts?: { path?: string }): Promise<Status> {
        // A refresh must observe writes and other tabs immediately, even within
        // the short cache window shared by branch/count/operation readers.
        this.pendingState = undefined;
        this.pendingPushState = undefined;
        const status = (await this.state()).status;
        if (!opts?.path) return status;
        const path = this.getRelativeRepoPath(opts.path).replace(/\/$/, "");
        const matches = (p: string) => p === path || p.startsWith(path + "/");
        return {
            ...status,
            all: status.all.filter((f) => matches(f.path)),
            staged: status.staged.filter((f) => matches(f.path)),
            changed: status.changed.filter((f) => matches(f.path)),
            conflicted: status.conflicted.filter(matches),
        };
    }
    async branchInfo(): Promise<BranchInfo> {
        return (await this.state()).branch;
    }
    async isMergeInProgress(): Promise<boolean> {
        return (await this.state()).mergeInProgress;
    }
    async getUnpushedCommits(): Promise<number> {
        return (await this.getPushState()).unpushedCommits;
    }
    async getLastCommitTime(): Promise<Date | undefined> {
        const value = (await this.state()).lastCommitTime;
        return value ? new Date(value) : undefined;
    }
    async getConfig(key: string, scope?: string): Promise<string | undefined> {
        if (scope && scope !== "local") return this.unsupported();
        const state = await this.state();
        if (
            ![
                "user.name",
                "user.email",
                `branch.${state.branch.current}.remote`,
                `branch.${state.branch.current}.merge`,
            ].includes(key)
        )
            return this.unsupported();
        return state.config[key];
    }
    async getRemotes(): Promise<string[]> {
        return Object.keys((await this.state()).remotes);
    }
    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return (await this.state()).remotes[remote];
    }

    private ensureBrowserSafe(): void {
        const writes = window.__ignis?.writes;
        if (!writes)
            throw new IgnisGitError(
                "BROWSER_STATE",
                "The Ignis write-safety API is unavailable. Update Ignis before Pull or Merge."
            );
        if (
            writes.getState() !== "clean" ||
            (writes.listPending?.().length ?? 0) ||
            writes.listFailed().length ||
            writes.getDetail().pending ||
            writes.getDetail().retrying
        )
            throw new IgnisGitError(
                "BROWSER_DIRTY",
                "Wait for Ignis writes to finish and resolve failed writes before Pull or Merge."
            );
        let editable = false;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (
                leaf.view instanceof MarkdownView &&
                leaf.view.getMode() === "source"
            )
                editable = true;
        });
        if (editable)
            throw new IgnisGitError(
                "BROWSER_DIRTY",
                "Close editable Markdown panes or switch them to reading view before Pull or Merge. Unsaved edits must reach disk first."
            );
    }

    async pull(
        options: { mergeOnDivergence?: boolean } = {}
    ): Promise<PullResult> {
        return this.withGitOperation(GitOperation.pull, async () => {
            this.ensureBrowserSafe();
            this.pendingState = undefined;
            this.pendingPushState = undefined;
            try {
                const value = await this.request(
                    "pull",
                    true,
                    options.mergeOnDivergence ? { mergeOnDivergence: true } : {}
                );
                if (!record(value))
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "Invalid Ignis pull response."
                    );
                if (typeof value.refreshWarning === "string")
                    this.plugin.displayMessage(value.refreshWarning);
                if (value.status === "merge-pending") {
                    const pending = mergeState(value.merge);
                    if (pending.operation !== "merge")
                        throw new IgnisGitError(
                            "INVALID_RESPONSE",
                            "Pull did not confirm a pending merge. Refresh repository state before retrying."
                        );
                    this.canResolveTextConflicts = true;
                    this.app.workspace.trigger("obsidian-git:head-change");
                    return {
                        status: "merge-pending",
                        conflicts: pending.unresolvedPaths.map(
                            (file) => file.path
                        ),
                    };
                }
                if (value.status === "up-to-date")
                    return { status: "up-to-date" };
                if (
                    value.status !== "updated" ||
                    !fileEntries(value.files) ||
                    value.outsideVault !== 0
                )
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "Invalid Ignis pull result. Check repository state before retrying."
                    );
                this.app.workspace.trigger("obsidian-git:head-change");
                return {
                    status: "updated",
                    files: value.files,
                    outsideVault: 0,
                };
            } finally {
                this.pendingState = undefined;
                this.pendingPushState = undefined;
                this.app.workspace.trigger("obsidian-git:refresh");
            }
        });
    }

    private unsupported(): never {
        throw new IgnisUnsupportedGitFeatureError();
    }
    commitNoopReason: "nothing-staged" | "no-changes" | undefined;

    commitAll(options: {
        message: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
        amend?: boolean;
    }): Promise<number> {
        return this.performCommit("all", options);
    }
    commit(options: { message: string; amend?: boolean }): Promise<number> {
        return this.performCommit("staged", options);
    }
    commitSmart(options: { message: string }): Promise<number> {
        return this.performCommit("smart", options);
    }

    private async performCommit(
        mode: IgnisCommitRequest["mode"],
        options: { message: string; amend?: boolean }
    ): Promise<number> {
        return this.withGitOperation(GitOperation.commit, async () => {
            this.commitNoopReason = undefined;
            if (options.amend)
                throw new IgnisGitError(
                    "AMEND_UNSUPPORTED",
                    "Amend is unavailable in Ignis because publication state cannot be established reliably."
                );
            this.pendingState = undefined;
            this.pendingPushState = undefined;
            const merging = await this.isMergeInProgress();
            if (merging) mode = "staged";
            if (
                mode === "all" ||
                (mode === "smart" && this.plugin.settings.autoStageOnEmptyIndex)
            )
                this.ensureStagingSafe();
            this.pendingState = undefined;
            this.pendingPushState = undefined;
            try {
                const snapshot = await this.status();
                const onlyStaged =
                    mode === "staged" ||
                    (mode === "smart" &&
                        (snapshot.staged.length > 0 ||
                            !this.plugin.settings.autoStageOnEmptyIndex));
                const intended = onlyStaged
                    ? snapshot.staged
                    : [
                          ...new Map(
                              [
                                  ...snapshot.staged,
                                  ...snapshot.changed.map((file) => ({
                                      ...file,
                                      index:
                                          file.workingDir === "?"
                                              ? "A"
                                              : file.workingDir,
                                  })),
                              ].map((file) => [file.path, file])
                          ).values(),
                      ];
                const message = await this.formatCommitMessage(
                    options.message,
                    {
                        staged: intended.filter(
                            (file) => file.path !== "git_conflict.md"
                        ),
                        stagedOutsideVault: 0,
                    }
                );
                if (
                    !message.trim() ||
                    message.includes("\0") ||
                    new TextEncoder().encode(message).length > 16 * 1024
                )
                    throw new IgnisGitError(
                        "INVALID_COMMIT_MESSAGE",
                        "Enter a nonempty commit message of at most 16 KiB UTF-8, without NUL characters."
                    );
                if (this.plugin.settings.commitMessageScript)
                    this.plugin.displayMessage(
                        "Commit message scripts are unsupported in Ignis. Using the message template instead."
                    );
                const value = await this.request("commit", true, {
                    mode,
                    message,
                    amend: false,
                    ...(mode === "smart"
                        ? {
                              autoStageOnEmptyIndex:
                                  !!this.plugin.settings.autoStageOnEmptyIndex,
                          }
                        : {}),
                });
                if (
                    record(value) &&
                    value.status === "nothing-to-commit" &&
                    (value.reason === "nothing-staged" ||
                        value.reason === "no-changes")
                ) {
                    this.commitNoopReason = value.reason;
                    return 0;
                }
                if (
                    !record(value) ||
                    value.status !== "committed" ||
                    !record(value.commit) ||
                    typeof value.commit.hash !== "string" ||
                    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
                        value.commit.hash
                    ) ||
                    !Number.isSafeInteger(value.commit.files) ||
                    (value.commit.files as number) < 0 ||
                    (!merging && value.commit.files === 0) ||
                    typeof value.commit.branch !== "string" ||
                    !value.commit.branch
                )
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "Invalid Ignis commit result. Inspect history before retrying; a commit may already exist."
                    );
                if (merging) {
                    const completed = mergeState(value.merge);
                    if (
                        completed.operation !== "none" ||
                        completed.head !== value.commit.hash
                    )
                        throw new IgnisGitError(
                            "INVALID_RESPONSE",
                            "The server did not confirm merge completion. Inspect repository state before retrying."
                        );
                }
                if (typeof value.refreshWarning === "string")
                    this.plugin.displayMessage(value.refreshWarning);
                this.pendingState = undefined;
                this.pendingPushState = undefined;
                this.app.workspace.trigger("obsidian-git:head-change");
                return value.commit.files as number;
            } finally {
                this.pendingState = undefined;
                this.pendingPushState = undefined;
                this.app.workspace.trigger("obsidian-git:refresh");
            }
        });
    }

    override async formatCommitMessage(
        template: string,
        scope?: Pick<Status, "staged" | "stagedOutsideVault">
    ): Promise<string> {
        const status = scope ?? (await this.getStagedForMessage());
        const files = status.staged;
        const groups = new Map<string, string[]>();
        for (const file of files) {
            const action =
                file.index === "?" || file.index === " "
                    ? file.workingDir
                    : file.index;
            groups.set(action, [...(groups.get(action) ?? []), file.path]);
        }
        const replacements: Record<string, string> = {
            date: moment().format(this.plugin.settings.commitDateFormat),
            hostname: this.plugin.localStorage.getHostname() || "",
            numFiles: String(files.length),
            files:
                files.length < 100
                    ? [...groups]
                          .map(
                              ([action, paths]) =>
                                  action + " " + paths.join(" ")
                          )
                          .join(", ")
                    : "Too many files to list",
        };
        // One pass prevents tokens introduced by filenames/hostname from expanding.
        let message = template.replace(
            /\{\{(date|hostname|numFiles|files)\}\}/g,
            (_, key: string) => replacements[key]!
        );
        if (this.plugin.settings.listChangedFilesInMessageBody)
            message +=
                "\n\nAffected files:\n" +
                (files.length < 100
                    ? files.map((file) => file.path).join("\n")
                    : "Too many files to list");
        return message;
    }
    private async mutateIndex(
        operation: "stage" | "unstage" | "stage-all" | "unstage-all",
        payload: { path?: string; dir?: string }
    ): Promise<void> {
        if (operation.startsWith("stage")) this.ensureStagingSafe();
        this.pendingState = undefined;
        this.pendingPushState = undefined;
        try {
            const value = await this.request(operation, true, payload);
            if (
                !record(value) ||
                value.status !== "updated" ||
                value.operation !== operation
            )
                throw new IgnisGitError(
                    "INVALID_RESPONSE",
                    "Invalid Ignis staging response. Refresh repository state before retrying."
                );
        } finally {
            // Also invalidate on transport failure: a cancelled request may
            // already have changed the server's index.
            this.pendingState = undefined;
            this.pendingPushState = undefined;
            this.app.workspace.trigger("obsidian-git:refresh");
        }
    }

    private ensureStagingSafe(): void {
        const writes = window.__ignis?.writes;
        if (!writes)
            throw new IgnisGitError(
                "BROWSER_STATE",
                "The Ignis write-safety API is unavailable. Update Ignis before staging."
            );
        if (
            (writes.listPending?.().length ?? 0) ||
            writes.listFailed().length ||
            writes.getState() !== "clean" ||
            writes.getDetail().pending ||
            writes.getDetail().retrying
        )
            throw new IgnisGitError(
                "BROWSER_DIRTY",
                "Wait for Ignis writes to finish and resolve failed writes before staging. Staging records the last persisted content."
            );
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (
                leaf.view instanceof MarkdownView &&
                leaf.view.getMode() === "source"
            )
                throw new IgnisGitError(
                    "BROWSER_DIRTY",
                    "Switch editable Markdown panes to reading view or close them, then wait for Ignis writes to finish before staging. Staging records the last persisted content."
                );
        });
        // The public Ignis API exposes delayed write status, not a save/flush
        // barrier. Make the persisted-snapshot semantics explicit rather than
        // claiming the editor buffer or a very recent save is included.
        this.plugin.displayMessage(
            "Staging content currently saved on the Ignis server. Recent editor saves may not be included; review Changes after staging."
        );
    }

    stageAll(options: { dir?: string; status?: Status }): Promise<void> {
        // dir is already repository-relative at existing UI call sites.
        return this.mutateIndex("stage-all", { dir: options.dir });
    }
    unstageAll(options: { dir?: string; status?: Status }): Promise<void> {
        return this.mutateIndex("unstage-all", { dir: options.dir });
    }
    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        const path = this.getRelativeRepoPath(filepath, relativeToVault);
        try {
            await this.mutateIndex("stage", { path });
        } catch (error) {
            if (
                error instanceof IgnisGitError &&
                error.code === "UNMERGED_PATH"
            )
                await this.markResolved(path);
            else throw error;
        }
    }
    unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        return this.mutateIndex("unstage", {
            path: this.getRelativeRepoPath(filepath, relativeToVault),
        });
    }
    discard(): Promise<void> {
        return this.unsupported();
    }
    discardAll(): Promise<void> {
        return this.unsupported();
    }
    getUntrackedPaths(): Promise<string[]> {
        return this.unsupported();
    }
    async getPushState(): Promise<IgnisPushState> {
        if (!this.pendingPushState || Date.now() >= this.pushStateExpires) {
            this.pushStateExpires = Number.POSITIVE_INFINITY;
            const request = this.request("push-state").then(pushState);
            this.pendingPushState = request;
            void request.then(
                () => {
                    this.pushStateExpires = Date.now() + 1000;
                },
                () => {
                    if (this.pendingPushState === request)
                        this.pendingPushState = undefined;
                }
            );
        }
        return this.pendingPushState;
    }
    async push(): Promise<PushResult> {
        return this.withGitOperation(GitOperation.push, async () => {
            if (
                this.plugin.settings.squashCommitsBeforePush ||
                this.plugin.settings.updateSubmodules
            )
                throw new IgnisGitError(
                    "PUSH_OPTION_UNSUPPORTED",
                    "Disable squash-before-push and submodule updates for Push in Ignis. These options are not supported."
                );
            try {
                return pushResult(await this.request("push", true));
            } finally {
                this.pendingState = undefined;
                this.pendingPushState = undefined;
                this.app.workspace.trigger("obsidian-git:refresh");
            }
        });
    }
    async canPush(): Promise<boolean> {
        return (await this.getPushState()).canPush;
    }
    checkout(): Promise<void> {
        return this.unsupported();
    }
    createBranch(): Promise<void> {
        return this.unsupported();
    }
    deleteBranch(): Promise<void> {
        return this.unsupported();
    }
    branchIsMerged(): Promise<boolean> {
        return this.unsupported();
    }
    init(): Promise<void> {
        return this.unsupported();
    }
    clone(): Promise<void> {
        return this.unsupported();
    }
    setConfig(): Promise<void> {
        return this.unsupported();
    }
    fetch(): Promise<void> {
        return this.unsupported();
    }
    setRemote(): Promise<void> {
        return this.unsupported();
    }
    log(): Promise<never> {
        return this.unsupported();
    }
    getRemoteBranches(): Promise<string[]> {
        return this.unsupported();
    }
    removeRemote(): Promise<void> {
        return this.unsupported();
    }
    updateUpstreamBranch(): Promise<void> {
        return this.unsupported();
    }
    updateGitPath(): Promise<void> {
        return this.unsupported();
    }
    updateBasePath(): Promise<void> {
        return this.unsupported();
    }
    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        if (hash && hash !== "HEAD") return this.unsupported();
        const value = await this.request(
            `diff?path=${encodeURIComponent(filePath)}&kind=${stagedChanges ? "staged" : "unstaged"}`
        );
        if (
            !record(value) ||
            typeof value.diff !== "string" ||
            !["text", "binary", "oversized", "unsupported"].includes(
                String(value.kind)
            )
        )
            throw new IgnisGitError(
                "INVALID_RESPONSE",
                "Invalid diff response."
            );
        if (value.kind !== "text")
            throw new IgnisGitError(
                "NON_TEXT_DIFF",
                "This file is binary or too large for a text diff."
            );
        return value.diff;
    }
    async getFileContent(path: string, source: string) {
        return fileContent(
            await this.request(
                `content?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}`
            )
        );
    }
    async show(
        commitHash: string,
        file: string,
        relativeToVault = true
    ): Promise<string> {
        const source = (
            {
                HEAD: "head",
                "": "index",
                ":1": "base",
                ":2": "ours",
                ":3": "theirs",
            } as Record<string, string>
        )[commitHash];
        if (!source) return this.unsupported();
        const value = await this.getFileContent(
            this.getRelativeRepoPath(file, relativeToVault),
            source
        );
        if (value.kind === "missing") return "";
        if (value.kind !== "text")
            throw new IgnisGitError(
                "NON_TEXT_DIFF",
                "This snapshot is binary, oversized or uses an unsupported Git mode."
            );
        return value.text!;
    }
    async getMergeState(): Promise<MergeState> {
        const value = mergeState(await this.request("merge-state"));
        this.canResolveTextConflicts = value.operation === "merge";
        return value;
    }
    async getConflictDetails(path: string) {
        const details = conflictDetails(
            await this.request(`conflicts?path=${encodeURIComponent(path)}`)
        );
        this.canResolveTextConflicts = details.merge.operation === "merge";
        return details;
    }
    private async confirm(
        action: string,
        description: string
    ): Promise<boolean> {
        return (
            (await new GeneralModal(this.plugin, {
                options: ["Cancel", action],
                onlySelection: true,
                placeholder: description,
            }).openAndGetResult()) === action
        );
    }
    private async mergeMutation(
        endpoint: string,
        payload: IgnisMutationPayload
    ): Promise<void> {
        await this.withGitOperation(GitOperation.pull, async () => {
            try {
                const value = await this.request(endpoint, true, payload);
                const state = mergeState(value);
                if (state.operation !== "merge")
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "The server did not confirm the expected merge state. Refresh before retrying."
                    );
                if (record(value) && typeof value.refreshWarning === "string")
                    this.plugin.displayMessage(value.refreshWarning);
                this.plugin.displayMessage(
                    state.kind === "merge-conflicted"
                        ? "Merge in progress. Resolve each conflict, save and mark resolved, then Commit."
                        : "All paths resolved. Review staged changes and finish the merge with Commit."
                );
            } finally {
                this.pendingState = undefined;
                this.pendingPushState = undefined;
                this.app.workspace.trigger("obsidian-git:head-change");
                this.app.workspace.trigger("obsidian-git:refresh");
            }
        });
    }
    async startMerge(state: MergeState): Promise<void> {
        if (
            !(await this.confirm(
                "Merge incoming changes",
                `Merge ${state.upstream?.ref ?? "upstream"} (${state.upstream?.oid.slice(0, 12) ?? "unknown"}) into HEAD ${state.head?.slice(0, 12)}? Commit remains manual.`
            ))
        )
            return;
        this.ensureBrowserSafe();
        await this.mergeMutation("merge", {
            expectedHead: state.head,
            expectedUpstream: state.upstream?.oid,
            confirmed: true,
        });
    }
    async markResolved(path: string): Promise<void> {
        this.ensureStagingSafe();
        const details = await this.getConflictDetails(path);
        const file = details.contents.worktree;
        if (file.kind !== "text" && file.kind !== "missing")
            throw new IgnisGitError(
                "UNSUPPORTED_OPERATION",
                "Resolve binary or oversized conflicts outside Ignis; stage data is available for inspection."
            );
        const vaultPath = this.getRelativeVaultPath(path);
        if (file.kind === "text") {
            const local = await this.app.vault.adapter.read(vaultPath);
            if (sha256(local) !== file.hash)
                throw new IgnisGitError(
                    "STALE_MERGE_STATE",
                    "The browser and server file content differ. Wait for saves, refresh and review again."
                );
        } else if (await this.app.vault.adapter.exists(vaultPath))
            throw new IgnisGitError(
                "STALE_MERGE_STATE",
                "The browser still has this file. Refresh before marking the deletion resolved."
            );
        const markers =
            file.kind === "text" &&
            /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |$)/m.test(file.text!);
        if (markers)
            throw new IgnisGitError(
                "CONFLICT_NOT_RESOLVED",
                "Conflict markers remain. Resolve them and save before marking the file resolved."
            );
        this.ensureStagingSafe();
        await this.mergeMutation("mark-resolved", {
            path,
            expectedHash: file.hash,
            expectedHead: details.merge.head,
            expectedMergeHead: details.merge.mergeHead,
            confirmed: true,
            delete: file.kind === "missing",
            allowMarkers: false,
        });
    }
    unload(): void {
        this.unloaded = true;
        for (const controller of this.controllers) controller.abort();
        this.pendingState = undefined;
        this.pendingPushState = undefined;
    }
}
