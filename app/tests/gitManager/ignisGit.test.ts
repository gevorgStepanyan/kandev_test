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
import { CustomMessageModal } from "src/ui/modals/customMessageModal";

vi.mock("src/ui/modals/customMessageModal", () => ({
    CustomMessageModal: class {
        openAndGetResult(): Promise<string | undefined> {
            return Promise.resolve(undefined);
        }
    },
}));

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
const asyncResponse = (value: unknown, status = 200) =>
    Promise.resolve(response(value, status));
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
    vi.restoreAllMocks();
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
        fetchMock.mockResolvedValueOnce(
            response({ configured: true, canPush: true, unpushedCommits: 2 })
        );
        expect(await manager.getUnpushedCommits()).toBe(2);
        expect(await manager.getLastCommitTime()).toEqual(
            new Date(state.lastCommitTime)
        );
        expect(await manager.getRemotes()).toEqual(["origin"]);
        expect(await manager.getConfig("branch.main.remote")).toBe("origin");
        expect(fetchMock).toHaveBeenCalledTimes(2);
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
        await Promise.resolve();
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
            () => manager.discardAll(),
            () => manager.init(),
            () => manager.clone(),
            () => manager.log(),
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
        fetchMock.mockImplementation((url, options) => {
            if (options?.method !== "POST") return asyncResponse(state);
            const address =
                typeof url === "string"
                    ? url
                    : url instanceof URL
                      ? url.href
                      : url.url;
            const operation = address.split("/").pop();
            return asyncResponse({ status: "updated", operation });
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
                JSON.parse(options!.body as string) as unknown,
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

    it("keeps patch, discard and automatic commit workflows blocked", async () => {
        const { plugin } = setup();
        const actions = new GitActions(plugin);
        await actions.applyPatch("patch");
        await actions.addFileToGitignore("a.md");
        await actions.commit({ fromAuto: true });
        await actions.runRawCommand("add .");
        expect(plugin.displayError).toHaveBeenCalledTimes(4);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("Ignis manual commits", () => {
    const file = {
        path: "note.md",
        vaultPath: "note.md",
        index: "M",
        workingDir: "M",
    };
    const committed = {
        status: "committed",
        commit: {
            hash: "a".repeat(40),
            shortHash: "a".repeat(12),
            files: 2,
            branch: "main",
        },
    };
    function commitSetup(staged = true, changed = true) {
        const ctx = setup();
        Object.assign(ctx.plugin.settings, {
            commitMessage: "vault update",
            autoCommitMessage: "automatic",
            autoStageOnEmptyIndex: true,
            commitDateFormat: "YYYY-MM-DD",
            commitMessageScript: "",
            listChangedFilesInMessageBody: false,
        });
        Object.assign(ctx.plugin.localStorage, {
            getHostname: () => "browser",
        });
        Object.assign(ctx.plugin, {
            updateCachedStatus: vi.fn(() => ctx.manager.status()),
        });
        fetchMock.mockImplementation((_url, options) =>
            asyncResponse(
                options?.method === "POST"
                    ? committed
                    : {
                          ...state,
                          status: {
                              ...emptyStatus,
                              all: [file],
                              staged: staged ? [file] : [],
                              changed: changed ? [file] : [],
                          },
                      }
            )
        );
        return { ...ctx, actions: new GitActions(ctx.plugin) };
    }
    const posts = () =>
        fetchMock.mock.calls.filter(
            ([, options]) => options?.method === "POST"
        );

    it("sends a staged-only request and preserves multiline Unicode and leading hyphens", async () => {
        const { manager, plugin } = commitSetup();
        const message = "-- 雪 'quotes'\n\nbody punctuation: $() `literal`\n";
        expect(await manager.commit({ message })).toBe(2);
        expect(posts()).toHaveLength(1);
        expect(posts()[0]).toEqual([
            "/api/ext/obsidian-git/commit",
            expect.objectContaining({
                credentials: "same-origin",
                body: JSON.stringify({
                    vaultId: "Main & Work",
                    mode: "staged",
                    message,
                    amend: false,
                }),
            }),
        ]);
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:head-change"
        );
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
    });

    it("commits all in one request, ignoring caller-supplied status and file lists", async () => {
        const { manager } = commitSetup();
        const stage = vi.spyOn(manager, "stageAll");
        expect(
            await manager.commitAll({
                message: "all",
                status: emptyStatus,
                unstagedFiles: [],
            })
        ).toBe(2);
        expect(stage).not.toHaveBeenCalled();
        expect(posts()).toHaveLength(1);
        expect(JSON.parse(posts()[0]![1]!.body as string)).toEqual({
            vaultId: "Main & Work",
            mode: "all",
            message: "all",
            amend: false,
        });
    });

    it.each([
        [true, true],
        [false, true],
        [false, false],
    ])(
        "delegates smart selection to the locked server (staged=%s, fallback=%s)",
        async (staged, fallback) => {
            const { plugin, actions } = commitSetup(staged);
            plugin.settings.autoStageOnEmptyIndex = fallback;
            const result = await actions.commit({
                fromAuto: false,
                mode: "smart",
                commitMessage: "smart",
            });
            expect(result).toEqual({
                status: "success",
                value: { status: "committed", files: 2 },
            });
            expect(JSON.parse(posts()[0]![1]!.body as string)).toEqual({
                vaultId: "Main & Work",
                mode: "smart",
                message: "smart",
                amend: false,
                autoStageOnEmptyIndex: fallback,
            });
        }
    );

    it("does not suppress a request because cached browser status says nothing staged", async () => {
        const { actions } = commitSetup(false, false);
        expect(
            (await actions.commit({ fromAuto: false, mode: "staged" })).status
        ).toBe("success");
        expect(
            (JSON.parse(posts()[0]![1]!.body as string) as { mode: string })
                .mode
        ).toBe("staged");
    });

    it("uses the existing custom-message modal once and cancels without a mutation", async () => {
        const { actions } = commitSetup();
        const modal = vi
            .spyOn(CustomMessageModal.prototype, "openAndGetResult")
            .mockResolvedValueOnce("-- 雪\n\nmodal body")
            .mockResolvedValueOnce(undefined);
        expect(
            (
                await actions.commit({
                    fromAuto: false,
                    mode: "staged",
                    requestCustomMessage: true,
                })
            ).status
        ).toBe("success");
        expect(posts()).toHaveLength(1);
        expect(
            (JSON.parse(posts()[0]![1]!.body as string) as { message: string })
                .message
        ).toBe("-- 雪\n\nmodal body");
        expect(
            (
                await actions.commit({
                    fromAuto: false,
                    mode: "staged",
                    requestCustomMessage: true,
                })
            ).status
        ).toBe("cancelled");
        expect(modal).toHaveBeenCalledTimes(2);
        expect(posts()).toHaveLength(1);
    });

    it("maps a server no-op to no commit, without a HEAD event or success notice", async () => {
        const { manager, actions, plugin } = commitSetup();
        const request = vi.spyOn(manager, "formatCommitMessage");
        fetchMock.mockImplementation((_url, options) =>
            asyncResponse(
                options?.method === "POST"
                    ? { status: "nothing-to-commit", reason: "nothing-staged" }
                    : state
            )
        );
        expect(
            await actions.commit({ fromAuto: false, mode: "smart" })
        ).toEqual({
            status: "success",
            value: { status: "nothing-to-commit", reason: "nothing-staged" },
        });
        expect(request).toHaveBeenCalledOnce();
        expect(plugin.app.workspace.trigger).not.toHaveBeenCalledWith(
            "obsidian-git:head-change"
        );
        expect(plugin.displayMessage).not.toHaveBeenCalledWith(
            expect.stringMatching(/^Committed/)
        );
    });

    it("formats the intended scope exactly once without recursively expanding introduced tokens", async () => {
        const { manager, plugin } = commitSetup();
        plugin.settings.listChangedFilesInMessageBody = true;
        Object.assign(plugin.localStorage, {
            getHostname: () => "{{numFiles}}",
        });
        const other = {
            ...file,
            path: "{{hostname}}.md",
            vaultPath: "{{hostname}}.md",
            index: "?",
            workingDir: "?",
        };
        fetchMock.mockImplementation((_url, options) =>
            asyncResponse(
                options?.method === "POST"
                    ? committed
                    : {
                          ...state,
                          status: {
                              ...emptyStatus,
                              all: [file, other],
                              staged: [file],
                              changed: [file, other],
                          },
                      }
            )
        );
        const format = vi.spyOn(manager, "formatCommitMessage");
        await manager.commitAll({
            message: "{{numFiles}} {{hostname}} {{files}}",
        });
        expect(format).toHaveBeenCalledOnce();
        const body = JSON.parse(posts()[0]![1]!.body as string) as {
            message: string;
        };
        expect(body.message).toBe(
            "2 {{numFiles}} M note.md, A {{hostname}}.md\n\nAffected files:\nnote.md\n{{hostname}}.md"
        );
    });

    it("staged templates exclude unselected working changes", async () => {
        const { manager } = commitSetup();
        const other = {
            ...file,
            path: "other.md",
            vaultPath: "other.md",
            index: " ",
            workingDir: "M",
        };
        fetchMock.mockImplementation((_url, options) =>
            asyncResponse(
                options?.method === "POST"
                    ? committed
                    : {
                          ...state,
                          status: {
                              ...emptyStatus,
                              all: [file, other],
                              staged: [file],
                              changed: [file, other],
                          },
                      }
            )
        );
        await manager.commit({ message: "{{numFiles}} {{files}}" });
        expect(
            (JSON.parse(posts()[0]![1]!.body as string) as { message: string })
                .message
        ).toBe("1 M note.md");
    });

    it.each([
        { ...committed, commit: { ...committed.commit, files: 0 } },
        { ...committed, commit: { ...committed.commit, hash: "invalid" } },
        { status: "updated" },
    ])(
        "rejects malformed commit success without a HEAD event",
        async (result) => {
            const { manager, plugin } = commitSetup();
            fetchMock.mockImplementation((_url, options) =>
                asyncResponse(options?.method === "POST" ? result : state)
            );
            await expect(
                manager.commit({ message: "message" })
            ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
            expect(plugin.app.workspace.trigger).not.toHaveBeenCalledWith(
                "obsidian-git:head-change"
            );
            expect(plugin.setPluginState).toHaveBeenLastCalledWith({
                operation: GitOperation.idle,
            });
        }
    );

    it("rejects invalid messages before mutation and scripts use the template path", async () => {
        const { manager, plugin } = commitSetup();
        for (const message of [" \n", "a\0b", "雪".repeat(6000)])
            await expect(manager.commit({ message })).rejects.toMatchObject({
                code: "INVALID_COMMIT_MESSAGE",
            });
        expect(posts()).toHaveLength(0);
        plugin.settings.commitMessageScript = "must never execute";
        await manager.commit({ message: "template" });
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            expect.stringContaining("scripts are unsupported")
        );
        expect(posts()).toHaveLength(1);
    });

    it("invalidates cached status after success and errors, restoring idle without a HEAD event on error", async () => {
        const { manager, plugin } = commitSetup();
        await manager.status();
        fetchMock.mockImplementation((_url, options) =>
            asyncResponse(
                options?.method === "POST"
                    ? {
                          error: {
                              code: "GIT_COMMIT_FAILED",
                              message: "Changes may remain staged.",
                          },
                      }
                    : state,
                options?.method === "POST" ? 409 : 200
            )
        );
        await expect(
            manager.commitAll({ message: "try" })
        ).rejects.toMatchObject({ code: "GIT_COMMIT_FAILED" });
        expect(plugin.app.workspace.trigger).not.toHaveBeenCalledWith(
            "obsidian-git:head-change"
        );
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
        const count = fetchMock.mock.calls.length;
        fetchMock.mockResolvedValueOnce(
            response({ configured: true, canPush: true, unpushedCommits: 1 })
        );
        await manager.getUnpushedCommits();
        expect(fetchMock.mock.calls.length).toBe(count + 1);
    });

    it("blocks stage-all with unsaved writes while permitting staged snapshot commits", async () => {
        const { manager } = commitSetup();
        window.__ignis!.writes!.getState = () => "pending";
        await expect(
            manager.commitAll({ message: "all" })
        ).rejects.toMatchObject({ code: "BROWSER_DIRTY" });
        await expect(
            manager.commitSmart({ message: "smart" })
        ).rejects.toMatchObject({ code: "BROWSER_DIRTY" });
        expect(posts()).toHaveLength(0);
        expect(await manager.commit({ message: "index snapshot" })).toBe(2);
    });

    it("keeps automatic commits and Amend unavailable without requests", async () => {
        const { manager, actions } = commitSetup();
        await expect(
            manager.commit({ message: "amend", amend: true })
        ).rejects.toMatchObject({ code: "AMEND_UNSUPPORTED" });
        expect((await actions.commit({ fromAuto: true })).status).toBe(
            "failed"
        );
        expect(
            (await actions.commit({ fromAuto: false, amend: true })).status
        ).toBe("failed");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
