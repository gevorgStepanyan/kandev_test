import { MarkdownView, moment } from "obsidian";
import { GitManager } from "./gitManager";
import {
    fileEntries,
    ignisRequest,
    record,
    repositoryState,
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
    type Status,
    type UnstagedFile,
} from "src/types";

export class IgnisGitManager extends GitManager {
    private controllers = new Set<AbortController>();
    private pendingState?: Promise<IgnisRepositoryState>;
    private stateExpires = 0;
    private unloaded = false;

    private async request(
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
            const request = this.request("state").then(repositoryState);
            this.pendingState = request;
            void request.then(
                () => {
                    this.stateExpires = Date.now() + 1000;
                },
                () => {
                    if (this.pendingState === request)
                        this.pendingState = undefined;
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
        return (await this.state()).unpushedCommits;
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
                "The Ignis write-safety API is unavailable. Update Ignis before pulling."
            );
        if (
            writes.getState() !== "clean" ||
            writes.listFailed().length ||
            writes.getDetail().pending
        )
            throw new IgnisGitError(
                "BROWSER_DIRTY",
                "Wait for Ignis writes to finish and resolve failed writes before pulling."
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
                "Close editable Markdown panes or switch them to reading view before pulling in this pilot. Unsaved edits must reach disk first."
            );
    }

    async pull(): Promise<PullResult> {
        return this.withGitOperation(GitOperation.pull, async () => {
            this.ensureBrowserSafe();
            this.pendingState = undefined;
            try {
                const value = await this.request("pull", true);
                if (!record(value))
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "Invalid Ignis pull response."
                    );
                if (typeof value.refreshWarning === "string")
                    this.plugin.displayMessage(value.refreshWarning);
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
            }
        });
    }

    private unsupported(): never {
        throw new IgnisUnsupportedGitFeatureError();
    }
    commitNoopReason: "nothing-staged" | "no-changes" = "no-changes";

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
            if (options.amend)
                throw new IgnisGitError(
                    "AMEND_UNSUPPORTED",
                    "Amend is unavailable in Ignis because publication state cannot be established reliably."
                );
            if (
                mode === "all" ||
                (mode === "smart" && this.plugin.settings.autoStageOnEmptyIndex)
            )
                this.ensureStagingSafe();
            this.pendingState = undefined;
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
                    (value.commit.files as number) <= 0 ||
                    typeof value.commit.branch !== "string" ||
                    !value.commit.branch
                )
                    throw new IgnisGitError(
                        "INVALID_RESPONSE",
                        "Invalid Ignis commit result. Inspect history before retrying; a commit may already exist."
                    );
                this.pendingState = undefined;
                this.app.workspace.trigger("obsidian-git:head-change");
                return value.commit.files as number;
            } finally {
                this.pendingState = undefined;
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
            writes.getDetail().pending
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
    stage(filepath: string, relativeToVault: boolean): Promise<void> {
        return this.mutateIndex("stage", {
            path: this.getRelativeRepoPath(filepath, relativeToVault),
        });
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
    push(): Promise<never> {
        return this.unsupported();
    }
    canPush(): Promise<boolean> {
        return this.unsupported();
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
    getDiffString(): Promise<string> {
        return this.unsupported();
    }
    show(): Promise<string> {
        return this.unsupported();
    }
    unload(): void {
        this.unloaded = true;
        for (const controller of this.controllers) controller.abort();
        this.pendingState = undefined;
    }
}
