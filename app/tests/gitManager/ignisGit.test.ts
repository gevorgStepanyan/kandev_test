import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { IgnisGitManager } from "src/gitManager/ignisGit";
import {
    IgnisGitError,
    IgnisUnsupportedGitFeatureError,
} from "src/platform/ignis";
import { GitOperation } from "src/types";
import { createFakePlugin } from "../helpers/createFakePlugin";
import { GitActions } from "src/gitActions";

const emptyStatus = {
    all: [],
    changed: [],
    staged: [],
    conflicted: [],
    stagedOutsideVault: 0,
    conflictedOutsideVault: 0,
};
const state = {
    status: emptyStatus,
    branch: { current: "main", tracking: "origin/main", branches: ["main"] },
    mergeInProgress: false,
    lastCommitTime: "2026-10-14T12:00:00Z",
    unpushedCommits: 2,
    config: { "branch.main.remote": "origin" },
    remotes: { origin: "git@example.test:notes.git" },
};
const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
function setup() {
    const plugin = createFakePlugin();
    const iterateAllLeaves = vi.fn();
    Object.assign(plugin.app.workspace, { iterateAllLeaves });
    Object.assign(plugin, {
        settings: { basePath: "", gitDir: "", updateSubmodules: true },
        displayMessage: vi.fn(),
        isAllInitialized: vi.fn(() => Promise.resolve(true)),
    });
    Object.assign(plugin.app, { vault: { getFiles: () => [] } });
    const manager = new IgnisGitManager(plugin);
    plugin.gitManager = manager;
    return { manager, plugin, iterateAllLeaves };
}
let fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
    window.__currentVaultId = "Main & Work";
    window.__ignis = {
        version: "pilot",
        writes: {
            getState: () => "clean",
            listFailed: () => [],
            listPending: () => [],
            getDetail: () => ({ pending: 0, retrying: 0 }),
        },
    };
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(state));
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    delete window.__ignis;
    delete window.__currentVaultId;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe("IgnisGitManager", () => {
    it("validates health instead of assuming Git readiness", async () => {
        const { manager } = setup();
        for (const requirements of [
            "valid",
            "missing-repo",
            "missing-git",
        ] as const) {
            fetchMock.mockResolvedValueOnce(response({ requirements }));
            expect(await manager.checkRequirements()).toBe(requirements);
        }
        fetchMock.mockResolvedValueOnce(
            response({ requirements: "something else" })
        );
        await expect(manager.checkRequirements()).rejects.toThrow("Invalid");
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            "/api/ext/obsidian-git/health?vaultId=Main%20%26%20Work"
        );
    });
    it("maps real status, branch, operation, time and count data", async () => {
        const { manager } = setup();
        const file = {
            path: "note.md",
            vaultPath: "note.md",
            index: "M",
            workingDir: " ",
        };
        fetchMock.mockResolvedValueOnce(
            response({
                ...state,
                status: { ...emptyStatus, all: [file], staged: [file] },
                mergeInProgress: true,
            })
        );
        expect((await manager.status()).staged).toEqual([file]);
        expect(await manager.branchInfo()).toEqual(state.branch);
        expect(await manager.isMergeInProgress()).toBe(true);
        expect(await manager.getUnpushedCommits()).toBe(2);
        expect(await manager.getLastCommitTime()).toEqual(
            new Date(state.lastCommitTime)
        );
        expect(await manager.getRemotes()).toEqual(["origin"]);
        expect(await manager.getConfig("branch.main.remote")).toBe("origin");
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it("pulls via a fixed same-origin endpoint and restores idle", async () => {
        const { manager, plugin } = setup();
        fetchMock.mockResolvedValueOnce(
            response({
                status: "updated",
                files: [
                    {
                        path: "new.md",
                        vaultPath: "new.md",
                        index: " ",
                        workingDir: "A",
                    },
                ],
                outsideVault: 0,
            })
        );
        expect((await manager.pull()).status).toBe("updated");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/ext/obsidian-git/pull");
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            method: "POST",
            credentials: "same-origin",
            body: JSON.stringify({ vaultId: "Main & Work" }),
        });
        expect(plugin.setPluginState).toHaveBeenNthCalledWith(1, {
            operation: GitOperation.pull,
        });
        expect(plugin.setPluginState).toHaveBeenNthCalledWith(2, {
            operation: GitOperation.idle,
        });
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:head-change"
        );
    });
    it("reports structured failures and leaves the operation idle", async () => {
        const { manager, plugin } = setup();
        fetchMock.mockResolvedValueOnce(
            response(
                {
                    error: {
                        code: "DIVERGED",
                        message: "History diverged. See git_conflict.md.",
                        reportFile: "git_conflict.md",
                    },
                },
                409
            )
        );
        await expect(manager.pull()).rejects.toMatchObject({
            code: "DIVERGED",
            reportFile: "git_conflict.md",
        });
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
    });
    it("rejects invalid/non-JSON data and network failures", async () => {
        const { manager } = setup();
        fetchMock.mockResolvedValueOnce(
            new Response("<html>proxy failure</html>", { status: 502 })
        );
        await expect(manager.checkRequirements()).rejects.toThrow("non-JSON");
        fetchMock.mockRejectedValueOnce(new Error("network"));
        await expect(manager.checkRequirements()).rejects.toMatchObject({
            code: "NETWORK",
        });
        fetchMock.mockResolvedValueOnce(
            response({
                ...state,
                status: {
                    ...emptyStatus,
                    all: [
                        {
                            path: "../escape",
                            vaultPath: "../escape",
                            index: "M",
                            workingDir: " ",
                        },
                    ],
                },
            })
        );
        await expect(manager.status()).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });
    it("times out requests and cancels requests on unload", async () => {
        vi.useFakeTimers();
        const { manager } = setup();
        fetchMock.mockImplementation(
            (_url, options) =>
                new Promise((_resolve, reject) =>
                    options?.signal?.addEventListener("abort", () =>
                        reject(new Error("abort"))
                    )
                )
        );
        const pending = expect(
            manager.checkRequirements()
        ).rejects.toMatchObject({ code: "ABORTED" });
        await vi.advanceTimersByTimeAsync(120000);
        await pending;
        const cancelled = expect(
            manager.checkRequirements()
        ).rejects.toMatchObject({ code: "ABORTED" });
        manager.unload();
        await cancelled;
    });
    it("rejects missing vaults and unsupported repository layouts before HTTP", async () => {
        const { manager, plugin } = setup();
        delete window.__currentVaultId;
        await expect(manager.checkRequirements()).rejects.toMatchObject({
            code: "VAULT_MISSING",
        });
        plugin.settings.basePath = "nested";
        await expect(manager.status()).rejects.toMatchObject({
            code: "UNSUPPORTED_LAYOUT",
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("blocks unsupported backend methods without sending a request", () => {
        const { manager } = setup();
        for (const action of [
            () => manager.commit(),
            () => manager.push(),
            () => manager.discardAll(),
            () => manager.init(),
            () => manager.clone(),
            () => manager.log(),
            () => manager.show(),
            () => manager.fetch(),
            () => manager.setConfig(),
            () => manager.updateBasePath(),
        ])
            expect(action).toThrow(IgnisUnsupportedGitFeatureError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("refuses pulls with editable panes or unconfirmed/failed writes", async () => {
        const { manager, iterateAllLeaves } = setup();
        const view = Object.assign(
            Object.create(MarkdownView.prototype) as MarkdownView,
            {
                getMode: () => "source",
            }
        );
        iterateAllLeaves.mockImplementation(
            (callback: (leaf: { view: MarkdownView }) => void) =>
                callback({ view })
        );
        await expect(manager.pull()).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        iterateAllLeaves.mockReset();
        window.__ignis!.writes!.getState = () => "pending";
        await expect(manager.pull()).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("does not prompt for unsupported upstream setup even when submodules are configured", async () => {
        const { plugin } = setup();
        fetchMock.mockResolvedValueOnce(
            response({
                ...state,
                branch: { current: "main", branches: ["main"] },
            })
        );
        expect((await new GitActions(plugin).pull()).status).toBe("failed");
        expect(plugin.displayError).toHaveBeenCalledWith(
            expect.any(IgnisGitError)
        );
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe("Ignis staging", () => {
    beforeEach(() => {
        fetchMock.mockImplementation(async (url, options) => {
            if (options?.method !== "POST") return response(state);
            const operation = String(url).split("/").pop();
            return response({ status: "updated", operation });
        });
    });

    it.each([true, false])(
        "converts a single path exactly once (vault relative: %s)",
        async (relativeToVault) => {
            const { manager } = setup();
            const convert = vi.spyOn(manager, "getRelativeRepoPath");
            await manager.stage("Notes/雪 [1].md", relativeToVault);
            expect(convert).toHaveBeenCalledExactlyOnceWith(
                "Notes/雪 [1].md",
                relativeToVault
            );
            const call = fetchMock.mock.calls.find(
                ([, options]) => options?.method === "POST"
            );
            expect(call?.[0]).toBe("/api/ext/obsidian-git/stage");
            expect(call?.[1]).toMatchObject({
                credentials: "same-origin",
                body: JSON.stringify({
                    vaultId: "Main & Work",
                    path: "Notes/雪 [1].md",
                }),
            });
        }
    );

    it("maps all four methods and ignores cached status as an input list", async () => {
        const { manager, plugin } = setup();
        await manager.stageAll({ status: emptyStatus });
        await manager.stageAll({ dir: "Notes" });
        await manager.unstage("Notes/file.md", false);
        await manager.unstageAll({});
        await manager.unstageAll({ dir: "Notes", status: emptyStatus });
        const calls = fetchMock.mock.calls.filter(
            ([, options]) => options?.method === "POST"
        );
        expect(
            calls.map(([url, options]) => [
                url,
                JSON.parse(options!.body as string),
            ])
        ).toEqual([
            ["/api/ext/obsidian-git/stage-all", { vaultId: "Main & Work" }],
            [
                "/api/ext/obsidian-git/stage-all",
                { vaultId: "Main & Work", dir: "Notes" },
            ],
            [
                "/api/ext/obsidian-git/unstage",
                { vaultId: "Main & Work", path: "Notes/file.md" },
            ],
            ["/api/ext/obsidian-git/unstage-all", { vaultId: "Main & Work" }],
            [
                "/api/ext/obsidian-git/unstage-all",
                { vaultId: "Main & Work", dir: "Notes" },
            ],
        ]);
        expect(
            plugin.app.workspace.trigger.mock.calls.filter(
                ([event]) => event === "obsidian-git:refresh"
            )
        ).toHaveLength(5);
    });

    it("awaits server confirmation, invalidates status and refreshes direct manager calls", async () => {
        const { manager, plugin } = setup();
        await manager.status();
        let finish!: (response: Response) => void;
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    finish = resolve;
                })
        );
        let done = false;
        const request = manager.unstageAll({}).then(() => {
            done = true;
        });
        await Promise.resolve();
        expect(done).toBe(false);
        expect(plugin.app.workspace.trigger).not.toHaveBeenCalled();
        finish(response({ status: "updated", operation: "unstage-all" }));
        await request;
        await manager.status();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
    });

    it("enables queued GitActions staging flows and reports failed requests", async () => {
        const { plugin } = setup();
        const actions = new GitActions(plugin);
        expect((await actions.stage("a.md", false)).status).toBe("success");
        expect((await actions.stageAll("Notes")).status).toBe("success");
        expect((await actions.unstage("a.md", false)).status).toBe("success");
        expect((await actions.unstageAll()).status).toBe("success");
        fetchMock.mockResolvedValueOnce(
            response(
                {
                    error: {
                        code: "GIT_INDEX_LOCKED",
                        message: "Wait for Git to finish.",
                    },
                },
                409
            )
        );
        expect((await actions.unstageAll()).status).toBe("failed");
        expect(plugin.displayError).toHaveBeenCalledWith(
            expect.objectContaining({ code: "GIT_INDEX_LOCKED" })
        );
        expect(
            plugin.app.workspace.trigger.mock.calls.filter(
                ([event]) => event === "obsidian-git:refresh"
            )
        ).toHaveLength(5);
        expect(plugin.state.operation).toBe(GitOperation.idle);
    });

    it("rejects malformed success responses and refreshes after ambiguous failure", async () => {
        const { manager, plugin } = setup();
        fetchMock.mockResolvedValueOnce(
            response({ status: "updated", operation: "pull" })
        );
        await expect(manager.unstageAll({})).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
    });

    it("blocks reported pending writes while allowing index-only unstaging", async () => {
        const { manager } = setup();
        window.__ignis!.writes!.listPending = () => ["a.md"];
        await expect(manager.stage("a.md", true)).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        expect(fetchMock).not.toHaveBeenCalled();
        await manager.unstage("a.md", true);
    });

    it("explicitly announces persisted-content semantics before a staging request", async () => {
        const { manager, plugin } = setup();
        await manager.stageAll({});
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            expect.stringContaining("Recent editor saves may not be included")
        );
    });

    it("blocks editable panes, failed writes and missing safety APIs before staging", async () => {
        const { manager, iterateAllLeaves } = setup();
        const view = Object.assign(
            Object.create(MarkdownView.prototype) as MarkdownView,
            { getMode: () => "source" }
        );
        iterateAllLeaves.mockImplementation(
            (callback: (leaf: { view: MarkdownView }) => void) =>
                callback({ view })
        );
        await expect(manager.stageAll({})).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        iterateAllLeaves.mockReset();
        window.__ignis!.writes!.listFailed = () => ["note.md"];
        await expect(manager.stageAll({})).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        delete window.__ignis!.writes;
        await expect(manager.stageAll({})).rejects.toMatchObject({
            code: "BROWSER_STATE",
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves dual staged/changed status after refreshing a mutation", async () => {
        const { manager } = setup();
        await manager.status();
        await manager.unstage("other.md", false);
        const file = {
            path: "note.md",
            vaultPath: "note.md",
            index: "M",
            workingDir: "M",
        };
        fetchMock.mockResolvedValueOnce(
            response({
                ...state,
                status: {
                    ...emptyStatus,
                    all: [file],
                    changed: [file],
                    staged: [file],
                },
            })
        );
        const status = await manager.status();
        expect(status.changed).toEqual([file]);
        expect(status.staged).toEqual([file]);
    });

    it("keeps patch, discard and commit workflows blocked", async () => {
        const { plugin } = setup();
        const actions = new GitActions(plugin);
        await actions.applyPatch("patch");
        await actions.addFileToGitignore("a.md");
        await actions.commit({ fromAuto: false });
        await actions.runRawCommand("add .");
        expect(plugin.displayError).toHaveBeenCalledTimes(4);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
