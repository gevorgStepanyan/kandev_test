import { describe, expect, it, vi } from "vitest";
import AutomaticsManager from "../src/automaticsManager";
import { PromiseQueue } from "../src/promiseQueue";
import { createFakePlugin } from "./helpers/createFakePlugin";

describe("AutomaticsManager auto commit-and-sync after file edits", () => {
    it("commits an edit made during a run exactly once, via the active debouncer", async () => {
        const plugin = createFakePlugin();
        const setLastAutoBackup = vi.fn();
        const commitAndSync = vi.fn(() => {
            // A vault event while the first commit-and-sync is still running.
            if (commitAndSync.mock.calls.length === 1) {
                plugin.autoCommitDebouncer?.();
            }
            return Promise.resolve();
        });
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 5,
                autoBackupAfterFileChange: true,
                setLastSaveToLastCommit: false,
                autoCommitOnlyStaged: false,
                differentIntervalCommitAndPush: false,
                autoPushInterval: 0,
                autoPullInterval: 0,
            },
            localStorage: {
                getPausedAutomatics: () => false,
                getLastAutoBackup: () => undefined,
                setLastAutoBackup,
                getLastAutoPull: () => undefined,
                getLastAutoPush: () => undefined,
            },
            promiseQueue: new PromiseQueue(),
            gitActions: { commitAndSync },
        });
        const manager = new AutomaticsManager(plugin);
        await manager.init();

        const firstDebouncer = plugin.autoCommitDebouncer!;
        firstDebouncer();
        firstDebouncer.run();
        await vi.waitFor(() => expect(setLastAutoBackup).toHaveBeenCalled());
        expect(commitAndSync).toHaveBeenCalledTimes(1);

        // Vault events call plugin.autoCommitDebouncer, so the edit from the
        // first run must be pending there.
        plugin.autoCommitDebouncer!.run();
        await vi.waitFor(() =>
            expect(setLastAutoBackup).toHaveBeenCalledTimes(2)
        );
        expect(commitAndSync).toHaveBeenCalledTimes(2);

        // No other debouncer may stay armed with the same edit.
        firstDebouncer.run();
        await new Promise<void>((resolve) =>
            plugin.promiseQueue.addTask(() => Promise.resolve(), resolve)
        );
        expect(commitAndSync).toHaveBeenCalledTimes(2);

        manager.unload();
    });
});

describe("Ignis automatic routines", () => {
    it("keeps automatic commits disabled and enables only explicit separate Push scheduling", async () => {
        vi.useFakeTimers();
        window.__ignis = { version: "pilot" };
        const plugin = createFakePlugin();
        const pull = vi.fn(() => Promise.resolve());
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 1,
                autoPushInterval: 300,
                autoPullInterval: 60,
                autoBackupAfterFileChange: true,
                differentIntervalCommitAndPush: true,
            },
            displayIgnisFutureFeature: vi.fn(),
            localStorage: {
                getPausedAutomatics: () => false,
                getLastAutoBackup: () => undefined,
                getLastAutoPull: () => undefined,
                getLastAutoPush: () => undefined,
                setLastAutoPull: vi.fn(),
                setLastAutoPush: vi.fn(),
            },
            promiseQueue: new PromiseQueue(),
            gitActions: {
                pullChangesFromRemote: pull,
                commit: vi.fn(),
                push: vi.fn(),
            },
            gitManager: {
                isMergeInProgress: vi.fn().mockResolvedValue(false),
                canPush: vi.fn().mockResolvedValue(true),
            },
        });
        const manager = new AutomaticsManager(plugin);
        try {
            await manager.init();
            expect(plugin.autoCommitDebouncer).toBeUndefined();
            expect(vi.getTimerCount()).toBe(2);
            await vi.advanceTimersByTimeAsync(60 * 60000);
            expect(pull).toHaveBeenCalledOnce();
            expect(pull).toHaveBeenCalledWith({ fromAuto: true });
            vi.mocked(plugin.gitManager.isMergeInProgress).mockResolvedValue(
                true
            );
            await vi.advanceTimersByTimeAsync(60 * 60000);
            expect(pull).toHaveBeenCalledOnce();
            vi.mocked(plugin.gitManager.isMergeInProgress).mockResolvedValue(
                false
            );
            await vi.advanceTimersByTimeAsync(60 * 60000);
            expect(pull).toHaveBeenCalledTimes(2);
            expect(plugin.gitActions.commit).not.toHaveBeenCalled();
            expect(plugin.gitActions.push).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(120 * 60000);
            expect(plugin.gitActions.push).toHaveBeenCalledOnce();
            manager.unload();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(300 * 60000);
            expect(plugin.gitActions.push).toHaveBeenCalledOnce();
        } finally {
            manager.unload();
            delete window.__ignis;
            vi.useRealTimers();
        }
    });
});

describe("Ignis Push timer safeguards", () => {
    async function setup(
        options: {
            separate?: boolean;
            paused?: boolean;
            disabled?: boolean;
            pending?: boolean;
            queued?: boolean;
        } = {}
    ) {
        vi.useFakeTimers();
        window.__ignis = { version: "test" };
        const plugin = createFakePlugin();
        const pending: (() => Promise<unknown>)[] = [];
        const push = vi.fn().mockResolvedValue(undefined);
        const canPush = vi.fn().mockResolvedValue(options.pending !== false);
        const paused = vi.fn(() => options.paused ?? false);
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 0,
                autoPushInterval: 5,
                autoPullInterval: 0,
                differentIntervalCommitAndPush: options.separate ?? true,
                disablePush: options.disabled ?? false,
            },
            localStorage: {
                getPausedAutomatics: paused,
                getLastAutoBackup: () => undefined,
                getLastAutoPull: () => undefined,
                getLastAutoPush: () => undefined,
                setLastAutoPush: vi.fn(),
            },
            gitActions: { push },
            gitManager: { canPush },
            promiseQueue: options.queued
                ? {
                      addTask: (task: () => Promise<unknown>) =>
                          pending.push(task),
                  }
                : new PromiseQueue(),
        });
        const manager = new AutomaticsManager(plugin);
        await manager.init();
        return { manager, plugin, push, canPush, paused, pending };
    }
    it.each(["disabled", "no-pending", "paused"])(
        "does not push when %s",
        async (reason) => {
            const c = await setup({
                disabled: reason === "disabled",
                pending: reason !== "no-pending",
            });
            try {
                if (reason === "paused") c.paused.mockReturnValue(true);
                await vi.advanceTimersByTimeAsync(5 * 60000);
                expect(c.push).not.toHaveBeenCalled();
            } finally {
                c.manager.unload();
                delete window.__ignis;
                vi.useRealTimers();
            }
        }
    );
    it.each([{ separate: false }, { paused: true }])(
        "creates no timer for %j",
        async (options) => {
            const c = await setup(options);
            try {
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                c.manager.unload();
                delete window.__ignis;
                vi.useRealTimers();
            }
        }
    );
    it("a queued auto-push cannot run or restart timers after unload", async () => {
        const c = await setup({ queued: true });
        try {
            await vi.advanceTimersByTimeAsync(5 * 60000);
            expect(c.pending).toHaveLength(1);
            c.manager.unload();
            await c.pending[0]!();
            expect(c.canPush).not.toHaveBeenCalled();
            expect(c.push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            c.manager.unload();
            delete window.__ignis;
            vi.useRealTimers();
        }
    });
    it("reports readiness failure once and keeps the configured interval", async () => {
        const c = await setup();
        try {
            c.canPush.mockRejectedValue(new Error("network unavailable"));
            await vi.advanceTimersByTimeAsync(5 * 60000);
            expect(c.plugin.displayError).toHaveBeenCalledOnce();
            expect(c.push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            c.manager.unload();
            delete window.__ignis;
            vi.useRealTimers();
        }
    });
});

describe("Ignis Push timer changes during readiness", () => {
    it("reload keeps one timer and disabling Push while readiness runs prevents publication", async () => {
        vi.useFakeTimers();
        window.__ignis = { version: "test" };
        const plugin = createFakePlugin();
        let finish!: (value: boolean) => void;
        const readiness = new Promise<boolean>((resolve) => (finish = resolve));
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 0,
                autoPushInterval: 5,
                autoPullInterval: 0,
                differentIntervalCommitAndPush: true,
                disablePush: false,
            },
            localStorage: {
                getPausedAutomatics: () => false,
                getLastAutoBackup: () => undefined,
                getLastAutoPull: () => undefined,
                getLastAutoPush: () => undefined,
                setLastAutoPush: vi.fn(),
            },
            gitManager: { canPush: vi.fn(() => readiness) },
            gitActions: { push: vi.fn().mockResolvedValue(undefined) },
            promiseQueue: new PromiseQueue(),
        });
        const manager = new AutomaticsManager(plugin);
        try {
            await manager.init();
            await vi.advanceTimersByTimeAsync(5 * 60000);
            expect(plugin.gitManager.canPush).toHaveBeenCalledOnce();
            manager.reload("push");
            plugin.settings.disablePush = true;
            finish(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(plugin.gitActions.push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            manager.unload();
            delete window.__ignis;
            vi.useRealTimers();
        }
    });
});
