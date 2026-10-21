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
    it("ignores synced commit/push settings and schedules only the 60-minute pull", async () => {
        vi.useFakeTimers();
        window.__ignis = { version: "pilot" };
        const plugin = createFakePlugin();
        const pull = vi.fn(() => Promise.resolve());
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 1,
                autoPushInterval: 1,
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
            },
            promiseQueue: new PromiseQueue(),
            gitActions: {
                pullChangesFromRemote: pull,
                commit: vi.fn(),
                push: vi.fn(),
            },
            gitManager: {
                isMergeInProgress: vi.fn().mockResolvedValue(false),
            },
        });
        const manager = new AutomaticsManager(plugin);
        try {
            await manager.init();
            expect(plugin.autoCommitDebouncer).toBeUndefined();
            expect(vi.getTimerCount()).toBe(1);
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
        } finally {
            manager.unload();
            delete window.__ignis;
            vi.useRealTimers();
        }
    });
});
