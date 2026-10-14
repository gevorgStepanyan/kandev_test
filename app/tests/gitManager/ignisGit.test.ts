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
            () => manager.stage(),
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
