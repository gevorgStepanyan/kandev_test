import { MarkdownView } from "obsidian";
import { GitManager } from "./gitManager";
import {
    fileEntries,
    ignisRequest,
    record,
    repositoryState,
    type IgnisRepositoryState,
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
} from "src/types";

export class IgnisGitManager extends GitManager {
    private controllers = new Set<AbortController>();
    private pendingState?: Promise<IgnisRepositoryState>;
    private stateExpires = 0;
    private unloaded = false;

    private async request(endpoint: string, post = false): Promise<unknown> {
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
                post
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
    commitAll(): Promise<number> {
        return this.unsupported();
    }
    commit(): Promise<number> {
        return this.unsupported();
    }
    stageAll(): Promise<void> {
        return this.unsupported();
    }
    unstageAll(): Promise<void> {
        return this.unsupported();
    }
    stage(): Promise<void> {
        return this.unsupported();
    }
    unstage(): Promise<void> {
        return this.unsupported();
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
