import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IgnisGitManager } from "src/gitManager/ignisGit";
import { pushResult, pushState } from "src/gitManager/ignisGitClient";
import { GitActions } from "src/gitActions";
import { GitOperation, type CommitResult, type PullResult } from "src/types";
import { createFakePlugin } from "../helpers/createFakePlugin";

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
    branch: { current: "main", tracking: "origin/main", branches: ["main"] },
    mergeInProgress: false,
    lastCommitTime: null,
    unpushedCommits: 0,
    config: {},
    remotes: {},
};
const ready = { configured: true, canPush: true, unpushedCommits: 2 };
const json = (value: unknown, code = 200) =>
    new Response(JSON.stringify(value), { status: code });
const urlText = (url: RequestInfo | URL): string =>
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const reply = (value: unknown, code = 200) =>
    Promise.resolve(json(value, code));
function setup() {
    const plugin = createFakePlugin();
    Object.assign(plugin, {
        isAllInitialized: vi.fn().mockResolvedValue(true),
        displayMessage: vi.fn(),
        updateCachedStatus: vi.fn().mockResolvedValue(status),
    });
    Object.assign(plugin.app.workspace, { iterateAllLeaves: vi.fn() });
    const manager = new IgnisGitManager(plugin);
    plugin.gitManager = manager;
    const actions = new GitActions(plugin);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
        if (urlText(url).includes("/push-state?")) return reply(ready);
        if (urlText(url).endsWith("/push"))
            return reply({ status: "pushed", files: 3 });
        return reply(repository);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { plugin, manager, actions, fetchMock };
}
beforeEach(() => {
    window.__ignis = { version: "test" };
    window.__currentVaultId = "Main & Work";
});
afterEach(() => {
    delete window.__ignis;
    delete window.__currentVaultId;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
describe("Ignis Push", () => {
    it("manual action pushes once through existing transport with only active vaultId; never stages/commits/pulls", async () => {
        const { manager, plugin, actions, fetchMock } = setup();
        plugin.settings.disablePush = true; // Desktop allows manual Push.
        const push = vi.spyOn(manager, "push");
        const stage = vi.spyOn(manager, "stageAll");
        const commit = vi.spyOn(manager, "commit");
        const pull = vi.spyOn(manager, "pull");
        expect(await actions.push()).toEqual({
            status: "success",
            value: { status: "pushed", files: 3 },
        });
        expect(push).toHaveBeenCalledOnce();
        expect(stage).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(pull).not.toHaveBeenCalled();
        const post = fetchMock.mock.calls.find(([url]) =>
            urlText(url).endsWith("/push")
        )!;
        expect(post[1]).toMatchObject({
            method: "POST",
            credentials: "same-origin",
            headers: {
                "X-Obsidian-Git": "1",
                "Content-Type": "application/json",
            },
        });
        expect(JSON.parse(post[1]!.body as string)).toEqual({
            vaultId: "Main & Work",
        });
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            "Pushed 3 files to remote"
        );
        expect(plugin.displayError).not.toHaveBeenCalled();
        expect(plugin.setPluginState).toHaveBeenCalledWith({
            operation: GitOperation.idle,
        });
    });
    it.each([
        { status: "pushed", files: null },
        { status: "pushed", files: 0 },
        { status: "up-to-date" },
        { status: "blocked", reason: "no-branch" },
        { status: "blocked", reason: "conflicts", files: 2 },
        { status: "blocked", reason: "merge-in-progress" },
        { status: "skipped", reason: "no-upstream" },
        { status: "skipped", reason: "not-ready" },
    ])(
        "validates and preserves typed result $status $reason",
        async (result) => {
            const { manager, fetchMock } = setup();
            fetchMock.mockResolvedValueOnce(json(result));
            expect(await manager.push()).toEqual(result);
            expect(pushResult(result)).toEqual(result);
        }
    );
    it.each([
        { status: "pushed", files: -1 },
        { status: "pushed", files: "2" },
        { status: "blocked", reason: "conflicts", files: 0 },
        { status: "success" },
    ])("rejects invalid response %j", (result) => {
        expect(() => pushResult(result)).toThrow("Invalid");
    });
    it.each([
        "PUSH_NON_FAST_FORWARD",
        "AUTH_OR_PERMISSION",
        "NETWORK",
        "TIMEOUT",
        "ABORTED",
        "PUSH_REMOTE_REJECTED",
    ])("reports %s exactly once and refreshes/restores idle", async (code) => {
        const { manager, plugin, fetchMock, actions } = setup();
        fetchMock.mockImplementation((url) =>
            urlText(url).endsWith("/push")
                ? reply(
                      {
                          error: {
                              code,
                              message:
                                  "Pull/merge or check credentials before retrying.",
                          },
                      },
                      409
                  )
                : reply(ready)
        );
        expect((await actions.push()).status).toBe("failed");
        expect(plugin.displayError).toHaveBeenCalledOnce();
        expect(plugin.setPluginState).toHaveBeenLastCalledWith({
            operation: GitOperation.idle,
        });
        expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
            "obsidian-git:refresh"
        );
        fetchMock.mockResolvedValue(
            json({ configured: true, canPush: false, unpushedCommits: 0 })
        );
        expect(await manager.canPush()).toBe(false);
    });
    it("no-op uses the established notice and readiness cache shares counts and destination checks", async () => {
        const { manager, plugin, fetchMock, actions } = setup();
        expect(await manager.canPush()).toBe(true);
        expect(await manager.getUnpushedCommits()).toBe(2);
        expect(await actions.isPushRemoteSet()).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        fetchMock.mockResolvedValueOnce(json({ status: "up-to-date" }));
        await actions.push();
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            "No commits to push"
        );
    });
    it.each([
        { configured: true, canPush: true, unpushedCommits: 4 }, // New destination includes all history.
        { configured: true, canPush: false, unpushedCommits: 0 }, // Behind or equal.
        { configured: false, canPush: false, unpushedCommits: 0 },
    ])("reads truthful readiness %j", async (value) => {
        const { manager, fetchMock } = setup();
        fetchMock.mockResolvedValue(json(value));
        expect(await manager.canPush()).toBe(value.canPush);
        expect(await manager.getUnpushedCommits()).toBe(value.unpushedCommits);
        expect(() => pushState({ ...value, unpushedCommits: -1 })).toThrow();
    });
    it("missing push destination skips without opening upstream UI or posting", async () => {
        const { actions, fetchMock, plugin } = setup();
        fetchMock.mockResolvedValue(
            json({ configured: false, canPush: false, unpushedCommits: 0 })
        );
        expect(await actions.push()).toEqual({
            status: "success",
            value: { status: "skipped", reason: "no-upstream" },
        });
        expect(
            fetchMock.mock.calls.every(
                ([, options]) => options?.method === "GET"
            )
        ).toBe(true);
        expect(plugin.displayMessage).toHaveBeenCalledWith(
            expect.stringContaining("No push target")
        );
    });
    it.each(["squashCommitsBeforePush", "updateSubmodules"] as const)(
        "declines unsupported option %s without posting",
        async (key) => {
            const { manager, plugin, fetchMock } = setup();
            plugin.settings[key] = true;
            await expect(manager.push()).rejects.toMatchObject({
                code: "PUSH_OPTION_UNSUPPORTED",
            });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(plugin.setPluginState).toHaveBeenLastCalledWith({
                operation: GitOperation.idle,
            });
        }
    );
    it.each(["timeout", "unload"])(
        "aborts real pending transport on %s and clears busy state",
        async (kind) => {
            vi.useFakeTimers();
            const { manager, plugin, fetchMock } = setup();
            let started!: () => void;
            const entered = new Promise<void>((resolve) => (started = resolve));
            fetchMock.mockImplementation(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        options!.signal!.addEventListener("abort", () =>
                            reject(new Error("aborted"))
                        );
                        started();
                    })
            );
            const result = manager.push();
            const check = expect(result).rejects.toMatchObject({
                code: "ABORTED",
            });
            await entered;
            if (kind === "unload") manager.unload();
            else await vi.advanceTimersByTimeAsync(120000);
            await check;
            expect(plugin.setPluginState).toHaveBeenLastCalledWith({
                operation: GitOperation.idle,
            });
            expect(vi.getTimerCount()).toBe(0);
            expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
                "obsidian-git:refresh"
            );
        }
    );
});

// Exercise real orchestration, mocking only the pre-existing constituent
// operations so each stop condition and ordering can be asserted directly.
type Workflow = {
    performCommit: () => Promise<CommitResult>;
    performPull: () => Promise<PullResult>;
};
function composite() {
    const context = setup();
    const internals = context.actions as unknown as Workflow;
    const commit = vi.spyOn(internals, "performCommit").mockResolvedValue({
        status: "nothing-to-commit",
        reason: "nothing-staged",
    });
    const pull = vi
        .spyOn(internals, "performPull")
        .mockResolvedValue({ status: "up-to-date" });
    const push = vi.spyOn(context.manager, "push");
    return { ...context, commit, pull, push };
}
describe("Ignis Commit-and-sync composition", () => {
    it("continues after nothing-to-commit, honoring optional Pull order", async () => {
        const { plugin, actions, commit, pull, push } = composite();
        plugin.settings.pullBeforePush = true;
        plugin.settings.syncMethod = "merge";
        expect(
            (await actions.commitAndSync({ fromAutoBackup: false })).status
        ).toBe("success");
        expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
            pull.mock.invocationCallOrder[0]!
        );
        expect(pull.mock.invocationCallOrder[0]).toBeLessThan(
            push.mock.invocationCallOrder[0]!
        );
    });
    it("disablePush retains commit-only and optional Pull", async () => {
        const { plugin, actions, push, pull } = composite();
        plugin.settings.disablePush = true;
        plugin.settings.pullBeforePush = true;
        expect(
            await actions.commitAndSync({ fromAutoBackup: false })
        ).toMatchObject({
            status: "success",
            value: { status: "commit-only" },
        });
        expect(pull).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();
    });
    it.each(["skipped", "failed"])("stops on %s Commit", async (outcome) => {
        const { actions, commit, push, pull } = composite();
        if (outcome === "failed")
            commit.mockRejectedValue(new Error("commit failed"));
        else
            commit.mockResolvedValue({
                status: "skipped",
                reason: "not-ready",
            });
        await actions.commitAndSync({ fromAutoBackup: false });
        expect(push).not.toHaveBeenCalled();
        expect(pull).not.toHaveBeenCalled();
    });
    it.each(["merge-pending", "skipped", "failed"])(
        "stops on %s Pull",
        async (outcome) => {
            const { plugin, actions, pull, push } = composite();
            plugin.settings.pullBeforePush = true;
            if (outcome === "failed")
                pull.mockRejectedValue(new Error("pull failed"));
            else
                pull.mockResolvedValue(
                    outcome === "skipped"
                        ? { status: "skipped", reason: "no-upstream" }
                        : { status: "merge-pending", conflicts: ["note.md"] }
                );
            expect(
                (await actions.commitAndSync({ fromAutoBackup: false })).status
            ).toBe("failed");
            expect(push).not.toHaveBeenCalled();
        }
    );
    it("missing destination is skipped rather than synced", async () => {
        const { actions, fetchMock, push } = composite();
        fetchMock.mockResolvedValue(
            json({ configured: false, canPush: false, unpushedCommits: 0 })
        );
        expect(
            await actions.commitAndSync({ fromAutoBackup: false })
        ).toMatchObject({
            status: "success",
            value: { status: "skipped", reason: "push-skipped" },
        });
        expect(push).not.toHaveBeenCalled();
    });
    it("Push rejection fails composite instead of reporting synced", async () => {
        const { actions, push, plugin } = composite();
        push.mockRejectedValue(new Error("remote rejected"));
        expect(
            (await actions.commitAndSync({ fromAutoBackup: false })).status
        ).toBe("failed");
        expect(plugin.displayError).toHaveBeenCalledOnce();
    });
});
