import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "js-sha256";
import { MarkdownView, TFile } from "obsidian";
import { IgnisGitManager } from "src/gitManager/ignisGit";
import { GitActions } from "src/gitActions";
import type { MergeState } from "src/gitManager/mergeWorkflow";
import { GitOperation } from "src/types";
import { createFakePlugin } from "../helpers/createFakePlugin";
const { choose } = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("src/ui/modals/generalModal", () => ({
    GeneralModal: class {
        openAndGetResult = choose;
    },
}));
const head = "a".repeat(40),
    upstream = "b".repeat(40);
const diverged: MergeState = {
    operation: "none",
    kind: "diverged",
    head,
    upstream: { ref: "origin/main", oid: upstream },
    unresolvedPaths: [],

    canCommitMerge: false,
};
const merging: MergeState = {
    ...diverged,
    operation: "merge",
    kind: "merge-conflicted",
    mergeHead: upstream,
    unresolvedPaths: [
        { path: "note.md", kind: "content", availableStages: [1, 2, 3] },
    ],
};
const content = (text: string) => ({
    kind: "text",
    text,
    hash: sha256(text),
    size: text.length,
});
const details = {
    path: "note.md",
    kind: "content",
    availableStages: [1, 2, 3],
    merge: merging,
    contents: {
        base: content("base\n"),
        ours: content("ours\n"),
        theirs: content("theirs\n"),
        worktree: content("resolved\n"),
    },
};
const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
function setup() {
    const plugin = createFakePlugin();
    plugin.displayMessage = vi.fn();
    const iterateAllLeaves = vi.fn();
    const read = vi.fn(() => Promise.resolve("resolved\n"));
    Object.assign(plugin.app.workspace, { iterateAllLeaves });
    Object.assign(plugin.app, {
        vault: {
            adapter: { read, exists: vi.fn(() => Promise.resolve(false)) },
        },
    });
    plugin.settings.basePath = "";
    plugin.settings.gitDir = "";
    const manager = new IgnisGitManager(plugin);
    plugin.gitManager = manager;
    return { plugin, manager, iterateAllLeaves, read };
}
let fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
    choose.mockReset();
    choose.mockResolvedValue("Cancel");
    window.__currentVaultId = "Notes & Work";
    window.__ignis = {
        version: "test",
        writes: {
            getState: () => "clean",
            listFailed: () => [],
            listPending: () => [],
            getDetail: () => ({ pending: 0, retrying: 0 }),
        },
    };
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(merging));
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__ignis;
    delete window.__currentVaultId;
});
describe("Ignis diff transport", () => {
    it("uses the existing authenticated vault-scoped client for distinct staged and unstaged diffs", async () => {
        const { manager } = setup();
        fetchMock.mockImplementation(() =>
            Promise.resolve(response({ kind: "text", diff: "real diff" }))
        );
        expect(await manager.getDiffString("space & 文.md", false)).toBe(
            "real diff"
        );
        expect(await manager.getDiffString("space & 文.md", true)).toBe(
            "real diff"
        );
        for (const [index, kind] of ["unstaged", "staged"].entries()) {
            const [url, init] = fetchMock.mock.calls[index]!;
            const parsed = new URL(url as string, "https://ignis.invalid");
            expect(parsed.searchParams.get("vaultId")).toBe("Notes & Work");
            expect(parsed.searchParams.get("path")).toBe("space & 文.md");
            expect(parsed.searchParams.get("kind")).toBe(kind);
            expect(init).toMatchObject({
                method: "GET",
                credentials: "same-origin",
                headers: { "X-Obsidian-Git": "1" },
            });
        }
    });
    it("maps only allowed sources and distinguishes missing, binary and invalid responses", async () => {
        const { manager } = setup();
        fetchMock.mockResolvedValueOnce(
            response({ kind: "missing", stageMissing: true })
        );
        expect(await manager.show(":1", "note.md", false)).toBe("");
        expect(fetchMock.mock.calls[0]![0] as string).toContain("source=base");
        fetchMock.mockResolvedValueOnce(response({ kind: "binary", size: 3 }));
        await expect(
            manager.show(":2", "note.md", false)
        ).rejects.toMatchObject({ code: "NON_TEXT_DIFF" });
        await expect(manager.show("HEAD~5", "note.md")).rejects.toThrow(
            "not available"
        );
        fetchMock.mockResolvedValueOnce(response({ kind: "text", diff: 123 }));
        await expect(
            manager.getDiffString("note.md", false)
        ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
        fetchMock.mockResolvedValueOnce(
            response(
                {
                    error: {
                        code: "OUTPUT_LIMIT",
                        message: "Diff exceeds the limit",
                    },
                },
                413
            )
        );
        await expect(
            manager.getDiffString("note.md", false)
        ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    });
});
describe("explicit merge workflow", () => {
    it.each([false, true])(
        "manual Pull merges divergence and reports pending state (conflicts=%s)",
        async (hasConflicts) => {
            const { plugin } = setup();
            Object.assign(plugin, {
                isAllInitialized: vi.fn().mockResolvedValue(true),
            });
            const actions = new GitActions(plugin);
            vi.spyOn(actions, "isPullRemoteSet").mockResolvedValue(true);
            fetchMock.mockResolvedValueOnce(
                response({
                    status: "merge-pending",
                    merge: hasConflicts
                        ? merging
                        : {
                              ...merging,
                              kind: "merge-awaiting-commit",
                              unresolvedPaths: [],
                              canCommitMerge: true,
                          },
                })
            );
            await actions.pullChangesFromRemote();
            expect(
                JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
            ).toMatchObject({ mergeOnDivergence: true });
            expect(choose).not.toHaveBeenCalled();
            expect(plugin.displayError).not.toHaveBeenCalled();
            expect(plugin.displayMessage).toHaveBeenCalledWith(
                expect.stringContaining(
                    hasConflicts ? "merge has conflicts" : "Commit to finish"
                )
            );
            expect(plugin.displayMessage).not.toHaveBeenCalledWith(
                expect.stringContaining("Everything is up-to-date")
            );
            expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
                "obsidian-git:refresh"
            );
        }
    );

    it("automatic Pull never authorizes a diverged merge", async () => {
        const { plugin } = setup();
        Object.assign(plugin, {
            isAllInitialized: vi.fn().mockResolvedValue(true),
        });
        const actions = new GitActions(plugin);
        vi.spyOn(actions, "isPullRemoteSet").mockResolvedValue(true);
        fetchMock.mockResolvedValueOnce(
            response(
                {
                    error: {
                        code: "DIVERGED",
                        message: "Automatic Pull requires manual integration",
                    },
                },
                409
            )
        );
        await actions.pullChangesFromRemote({ fromAuto: true });
        expect(
            JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
        ).not.toHaveProperty("mergeOnDivergence");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(choose).not.toHaveBeenCalled();
        expect(plugin.displayError).toHaveBeenCalledWith(
            expect.objectContaining({ code: "DIVERGED" })
        );
    });
    function conflictOpening() {
        const context = setup();
        const { plugin } = context;
        Object.assign(plugin, {
            isAllInitialized: vi.fn().mockResolvedValue(true),
        });
        const openFile = vi.fn().mockResolvedValue(undefined);
        const getLeaf = vi.fn(() => ({ openFile }));
        const file = Object.assign(new TFile(), {
            path: "note.md",
            name: "note.md",
            extension: "md",
        });
        const getAbstractFileByPath = vi.fn().mockReturnValue(file);
        Object.assign(plugin.app.vault, { getAbstractFileByPath });
        Object.assign(plugin.app.workspace, { getLeaf });
        const actions = new GitActions(plugin);
        const review = vi
            .spyOn(actions, "reviewConflict")
            .mockImplementation(() => {});
        fetchMock.mockResolvedValue(response(details));
        return {
            ...context,
            actions,
            review,
            openFile,
            getLeaf,
            file,
            getAbstractFileByPath,
        };
    }

    it("opens a clicked text conflict in live preview with resolution controls enabled", async () => {
        const { actions, manager, file, openFile, getLeaf, review, plugin } =
            conflictOpening();
        expect(manager.canResolveTextConflicts).toBe(false);
        await actions.openConflict("note.md");
        expect(getLeaf).toHaveBeenCalledWith(false);
        expect(openFile).toHaveBeenCalledWith(file, {
            active: true,
            state: { mode: "source", source: false },
        });
        expect(manager.canResolveTextConflicts).toBe(true);
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
        expect(review).not.toHaveBeenCalled();
        expect(
            fetchMock.mock.calls.every(([, init]) => init?.method === "GET")
        ).toBe(true);
    });

    it("shows stage review and a refresh notice when a server conflict is absent from the browser cache", async () => {
        const { actions, getAbstractFileByPath, review, openFile, plugin } =
            conflictOpening();
        getAbstractFileByPath.mockReturnValue(null);
        await actions.openConflict("note.md");
        expect(review).toHaveBeenCalledWith("note.md");
        expect(openFile).not.toHaveBeenCalled();
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            expect.stringContaining("Refresh vault from disk")
        );
    });

    it.each(["missing", "binary", "oversized"])(
        "opens read-only stage review for a %s working file",
        async (kind) => {
            const { actions, review, openFile } = conflictOpening();
            fetchMock.mockResolvedValue(
                response({
                    ...details,
                    contents: { ...details.contents, worktree: { kind } },
                })
            );
            await actions.openConflict("note.md");
            expect(review).toHaveBeenCalledWith("note.md");
            expect(openFile).not.toHaveBeenCalled();
        }
    );

    it("reports opening failures instead of silently ignoring the click", async () => {
        const { actions, openFile, plugin } = conflictOpening();
        const failure = new Error("Editor unavailable");
        openFile.mockRejectedValue(failure);
        await actions.openConflict("note.md");
        expect(plugin.displayError).toHaveBeenCalledWith(failure);
    });

    it("reports a real zero-file merge commit as committed and never stages unrelated work", async () => {
        const { manager, plugin } = setup();
        const ready = {
            ...merging,
            kind: "merge-awaiting-commit",
            unresolvedPaths: [],
            canCommitMerge: true,
        };
        const status = {
            all: [],
            changed: [],
            staged: [],
            conflicted: [],
            stagedOutsideVault: 0,
            conflictedOutsideVault: 0,
        };
        Object.assign(plugin, {
            isAllInitialized: vi.fn().mockResolvedValue(true),
            updateCachedStatus: vi.fn().mockResolvedValue(status),
        });
        plugin.state.mergeInProgress = true;
        plugin.settings.commitMessage = "Finish merge";
        plugin.settings.autoStageOnEmptyIndex = true;
        plugin.localStorage.getHostname = () => "browser";
        fetchMock.mockImplementation((_url, init) =>
            Promise.resolve(
                response(
                    init?.method === "POST"
                        ? {
                              status: "committed",
                              commit: {
                                  hash: "c".repeat(40),
                                  files: 0,
                                  branch: "main",
                              },
                              merge: {
                                  ...diverged,
                                  kind: "clean",
                                  head: "c".repeat(40),
                              },
                          }
                        : {
                              status,
                              branch: { current: "main", branches: ["main"] },
                              mergeInProgress: true,
                              merge: ready,
                              lastCommitTime: null,
                              unpushedCommits: 0,
                              config: {},
                              remotes: {},
                          }
                )
            )
        );
        const result = await new GitActions(plugin).commit({
            fromAuto: false,
            mode: "all",
        });
        expect(result).toMatchObject({
            status: "success",
            value: { status: "committed", files: 0 },
        });
        expect(manager.commitNoopReason).toBeUndefined();
        const posts = fetchMock.mock.calls.filter(
            ([, init]) => init?.method === "POST"
        );
        expect(posts).toHaveLength(1);
        expect(JSON.parse(posts[0]![1]!.body as string)).toMatchObject({
            mode: "staged",
        });
    });
    it("refreshes status within the cache window after another tab changes Git state", async () => {
        const { manager } = setup();
        const status = {
            all: [],
            changed: [],
            staged: [],
            conflicted: [],
            stagedOutsideVault: 0,
            conflictedOutsideVault: 0,
        };
        const repository = {
            status,
            branch: { branches: [] },
            lastCommitTime: null,
            unpushedCommits: 0,
            config: {},
            remotes: {},
        };
        fetchMock.mockResolvedValueOnce(
            response({ ...repository, mergeInProgress: false, merge: diverged })
        );
        await manager.status();
        fetchMock.mockResolvedValueOnce(
            response({ ...repository, mergeInProgress: true, merge: merging })
        );
        await manager.status();
        expect(await manager.isMergeInProgress()).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(["pending", "retrying"] as const)(
        "blocks merge while %s writes remain",
        async (field) => {
            const { manager } = setup();
            window.__ignis!.writes!.getDetail = () => ({
                pending: 0,
                retrying: 0,
                [field]: 1,
            });
            choose.mockResolvedValueOnce("Merge incoming changes");
            await expect(manager.startMerge(diverged)).rejects.toMatchObject({
                code: "BROWSER_DIRTY",
            });
            expect(fetchMock).not.toHaveBeenCalled();
        }
    );

    it("never merges on a divergence response or cancelled confirmation", async () => {
        const { manager } = setup();
        fetchMock.mockResolvedValueOnce(
            response(
                {
                    error: {
                        code: "DIVERGED",
                        message: "Merge incoming changes in Source Control",
                    },
                },
                409
            )
        );
        await expect(manager.pull()).rejects.toMatchObject({
            code: "DIVERGED",
        });
        await manager.startMerge(diverged);
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
        ).toHaveLength(1);
        expect(fetchMock.mock.calls[0]![0] as string).toContain("/pull");
    });
    it("requires confirmation, pins OIDs, refreshes state and restores idle after conflicts", async () => {
        const { manager, plugin } = setup();
        choose.mockResolvedValueOnce("Merge incoming changes");
        await manager.startMerge(diverged);
        expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual(
            {
                vaultId: "Notes & Work",
                expectedHead: head,
                expectedUpstream: upstream,
                confirmed: true,
            }
        );
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            expect.stringContaining("Merge in progress")
        );
    });
    it("blocks editable panes before issuing merge mutations", async () => {
        const { manager, iterateAllLeaves } = setup();
        choose.mockResolvedValueOnce("Merge incoming changes");
        const view = Object.assign(
            Object.create(MarkdownView.prototype) as MarkdownView,
            { getMode: () => "source" }
        );
        iterateAllLeaves.mockImplementation(
            (visit: (leaf: { view: MarkdownView }) => void) => visit({ view })
        );
        await expect(manager.startMerge(diverged)).rejects.toMatchObject({
            code: "BROWSER_DIRTY",
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("reads and compares persisted resolution before confirming and posting its hash", async () => {
        const { manager, read } = setup();
        choose.mockResolvedValueOnce("Mark resolved");
        const order: string[] = [];
        read.mockImplementation(() => {
            order.push("read");
            return Promise.resolve("resolved\n");
        });
        fetchMock.mockImplementation((url) => {
            if ((url as string).includes("/conflicts?")) {
                order.push("details");
                return Promise.resolve(response(details));
            }
            order.push("stage");
            return Promise.resolve(
                response({
                    ...merging,
                    kind: "merge-awaiting-commit",
                    unresolvedPaths: [],
                    canCommitMerge: true,
                })
            );
        });
        await manager.markResolved("note.md");
        expect(order).toEqual(["details", "read", "stage"]);
        expect(
            JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)
        ).toMatchObject({
            path: "note.md",
            expectedHash: sha256("resolved\n"),
            expectedMergeHead: upstream,
            confirmed: true,
        });
    });
    it("refuses browser/server mismatches and preserves state after a failed resolution", async () => {
        const { manager, plugin, read } = setup();
        read.mockResolvedValueOnce("not saved\n");
        fetchMock.mockResolvedValue(response(details));
        await expect(manager.markResolved("note.md")).rejects.toMatchObject({
            code: "STALE_MERGE_STATE",
        });
        expect(choose).not.toHaveBeenCalled();
        choose.mockResolvedValueOnce("Mark resolved");
        fetchMock
            .mockResolvedValueOnce(response(details))
            .mockResolvedValueOnce(
                response(
                    {
                        error: {
                            code: "STALE_MERGE_STATE",
                            message: "Changed during stage",
                        },
                    },
                    409
                )
            );
        await expect(manager.markResolved("note.md")).rejects.toMatchObject({
            code: "STALE_MERGE_STATE",
        });
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
    });
    it("validates Git state rather than trusting a successful HTTP response", async () => {
        const { manager } = setup();
        fetchMock.mockResolvedValueOnce(
            response({ ...merging, mergeHead: "arbitrary" })
        );
        await expect(manager.getMergeState()).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });

    it("rejects inconsistent state and never calls a clean response a successful merge", async () => {
        const { manager, plugin } = setup();
        fetchMock.mockResolvedValueOnce(
            response({ ...merging, canCommitMerge: true })
        );
        await expect(manager.getMergeState()).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        choose.mockResolvedValueOnce("Merge incoming changes");
        fetchMock.mockResolvedValueOnce(response(diverged));
        await expect(manager.startMerge(diverged)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        expect(plugin.displayMessage).not.toHaveBeenCalled();
    });
});
