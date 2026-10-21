import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandForRuntime } from "src/platform/ignis";
import type { Command } from "obsidian";
import type { CommitMode, Status } from "src/types";

// The Node test runner has no browser DOM. Execute the actual component script
// with inert lifecycle/rune adapters to exercise its handlers and queue, rather
// than maintaining copies of the handlers. Rendering is checked manually in Ignis.
function scriptWithoutImports(source: string) {
    const ast = ts.createSourceFile(
        "component.ts",
        source,
        ts.ScriptTarget.Latest,
        true
    );
    const imports = ast.statements.filter(ts.isImportDeclaration);
    for (const declaration of imports.reverse())
        source =
            source.slice(0, declaration.pos) + source.slice(declaration.end);
    return source;
}
function evaluate(source: string, context: Record<string, unknown>) {
    const code = ts.transpileModule(scriptWithoutImports(source), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    runInNewContext(code, context);
}
const file = {
    path: "note.md",
    vaultPath: "note.md",
    index: "M",
    workingDir: "M",
};
const status: Status = {
    all: [file],
    staged: [file],
    changed: [file],
    conflicted: [],
    stagedOutsideVault: 0,
    conflictedOutsideVault: 0,
};

type Handlers = {
    commit(mode?: CommitMode): void;
    showCommitMenu(event: { stopPropagation(): void }): void;
    getCommitActionDescription(sync: boolean): string;
    canCommitAndSync(mode: "staged" | "all"): boolean;
    canAmendStaged(): boolean;
    stageAll(event: { stopPropagation(): void }): void;
    unstageAll(event: { stopPropagation(): void }): void;
    pull(): void;
    push(): void;
    discard(event: { stopPropagation(): void }): void;
    setState(status: Status, message: string): void;
    readonly message: string;
    readonly loading: boolean;
};
function ui(ignis = true) {
    const tasks: Promise<unknown>[] = [];
    const commit = vi.fn().mockResolvedValue({
        status: "success",
        value: { status: "committed", files: 1 },
    });
    const trigger = vi.fn();
    const notice = vi.fn();
    const plugin = {
        settings: { commitMessage: "default", autoStageOnEmptyIndex: true },
        app: { workspace: { trigger } },
        gitActions: {
            commit,
            commitAndSync: vi.fn().mockResolvedValue({
                status: "success",
                value: {
                    status: "synced",
                    commit: { status: "committed" },
                },
            }),
            stageAll: vi.fn().mockResolvedValue({ status: "success" }),
            unstageAll: vi.fn().mockResolvedValue({ status: "success" }),
            pullChangesFromRemote: vi
                .fn()
                .mockResolvedValue({ status: "success" }),
            push: vi.fn().mockResolvedValue({ status: "success" }),
            discardAll: vi.fn().mockResolvedValue({ status: "success" }),
        },
        displayMessage: notice,
        displayIgnisFutureFeature: notice,
        promiseQueue: {
            addTask: (task: () => Promise<unknown>) => {
                tasks.push(task());
            },
        },
    };
    const items = new Map<string, () => void>();
    const disabledItems = new Map<string, boolean>();
    const menu = {
        addItem(configure: (item: unknown) => void) {
            let title = "";
            const item = {
                setTitle(value: string) {
                    title = value;
                    return item;
                },
                setIcon() {
                    return item;
                },
                setDisabled(disabled: boolean) {
                    disabledItems.set(title, disabled);
                    return item;
                },
                onClick(callback: () => void) {
                    items.set(title, callback);
                    return item;
                },
            };
            configure(item);
        },
        addSeparator() {},
        showAtMouseEvent() {},
    };
    const text = readFileSync(
        "src/ui/sourceControl/sourceControl.svelte",
        "utf8"
    );
    const source = text.split('<script lang="ts">')[1]!.split("</script>")[0]!;
    const context: Record<string, unknown> = {
        $props: () => ({ plugin, view: { app: plugin.app } }),
        $state: (value: unknown) => value,
        $derived: (value: unknown) => value,
        $effect: () => {},
        onMount: () => {},
        isIgnis: () => ignis,
        Menu: { forEvent: () => menu },
    };
    evaluate(
        source +
            `
        globalThis.handlers = {
            commit, showCommitMenu, getCommitActionDescription, canCommitAndSync, canAmendStaged,
            stageAll, unstageAll, pull, push, discard,
            setState(next, message) {
                status = next; commitMessage = message;
                stagedCount = next.staged.length; changedCount = next.changed.length;
                hasChanges = stagedCount + changedCount > 0;
                hasConflicts = next.conflicted.length > 0;
            },
            get message() { return commitMessage; },
            get loading() { return loading; },
        };`,
        context
    );
    const handlers = context.handlers as Handlers;
    handlers.setState(status, "-- 雪\n\nbody");
    return {
        plugin,
        handlers,
        commit,
        trigger,
        items,
        disabledItems,
        notice,
        tasks,
        text,
    };
}

describe("Source Control commit handlers", () => {
    it("primary Commit sends smart mode and resets its message only after confirmed success", async () => {
        const { handlers, commit, tasks, trigger, text } = ui();
        expect(text).toContain("onclick={() => commit()}");
        expect(text).toContain("bind:value={commitMessage}");
        handlers.commit();
        expect(handlers.loading).toBe(true);
        expect(commit).toHaveBeenCalledWith({
            fromAuto: false,
            commitMessage: "-- 雪\n\nbody",
            mode: "smart",
        });
        await Promise.all(tasks);
        expect(handlers.message).toBe("default");
        expect(handlers.loading).toBe(false);
        expect(trigger).toHaveBeenCalledWith("obsidian-git:refresh");
    });

    it.each(["failed", "cancelled", "nothing-to-commit"])(
        "preserves message and clears loading after %s",
        async (outcome) => {
            const { handlers, commit, tasks } = ui();
            commit.mockResolvedValue(
                outcome === "nothing-to-commit"
                    ? {
                          status: "success",
                          value: { status: outcome, reason: "no-changes" },
                      }
                    : { status: outcome }
            );
            handlers.commit("all");
            await Promise.all(tasks);
            expect(handlers.message).toBe("-- 雪\n\nbody");
            expect(handlers.loading).toBe(false);
        }
    );

    it("dropdown preserves staged/all labels and routes each mode; unsupported items are disabled", async () => {
        const { handlers, commit, tasks, items, disabledItems, notice } = ui();
        handlers.showCommitMenu({ stopPropagation() {} });
        items.get("Commit staged")!();
        await Promise.all(tasks);
        expect(commit).toHaveBeenLastCalledWith(
            expect.objectContaining({ mode: "staged" })
        );
        items.get("Stage all and commit")!();
        await Promise.all(tasks);
        expect(commit).toHaveBeenLastCalledWith(
            expect.objectContaining({ mode: "all" })
        );
        items.get("Amend staged")!();
        items.get("Commit staged and sync")!();
        await Promise.all(tasks);
        expect(commit).toHaveBeenCalledTimes(2);
        expect(notice).not.toHaveBeenCalled();
        expect(disabledItems.get("Commit staged")).toBe(false);
        expect(disabledItems.get("Stage all and commit")).toBe(false);
        expect(disabledItems.get("Amend staged")).toBe(true);
        expect(disabledItems.get("Commit staged and sync")).toBe(false);
    });

    it("uses the same commit tooltips and menu labels as desktop without pilot text", () => {
        const ignis = ui();
        const desktop = ui(false);
        for (const sync of [false, true]) {
            expect(ignis.handlers.getCommitActionDescription(sync)).toBe(
                desktop.handlers.getCommitActionDescription(sync)
            );
            expect(ignis.handlers.getCommitActionDescription(sync)).not.toMatch(
                /not available|future|Ignis/
            );
        }
        ignis.handlers.showCommitMenu({ stopPropagation() {} });
        desktop.handlers.showCommitMenu({ stopPropagation() {} });
        expect([...ignis.items.keys()]).toEqual([...desktop.items.keys()]);
        expect(ignis.handlers.canCommitAndSync("all")).toBe(true);
        expect(desktop.handlers.canCommitAndSync("all")).toBe(true);
        expect(ignis.handlers.canAmendStaged()).toBe(false);
        expect(desktop.handlers.canAmendStaged()).toBe(true);
        expect(ignis.text).not.toContain("IGNIS_FUTURE_FEATURE_NOTICE");
        expect(ignis.text).not.toContain("are available. Push, history");
        expect(readFileSync("src/setting/settings.ts", "utf8")).not.toContain(
            "Ignis pull-only pilot"
        );
    });

    it("keeps Stage all, Unstage all and Pull wired to the existing actions without notices", async () => {
        const { handlers, plugin, notice, tasks } = ui();
        const event = { stopPropagation: vi.fn() };
        handlers.stageAll(event);
        handlers.unstageAll(event);
        handlers.pull();
        await Promise.all(tasks);
        expect(plugin.gitActions.stageAll).toHaveBeenCalledOnce();
        expect(plugin.gitActions.unstageAll).toHaveBeenCalledOnce();
        expect(plugin.gitActions.pullChangesFromRemote).toHaveBeenCalledOnce();
        expect(notice).not.toHaveBeenCalled();
    });

    it("Push queues the existing action while Discard remains unavailable", async () => {
        const { handlers, plugin, notice, tasks } = ui();
        const event = { stopPropagation: vi.fn() };
        handlers.push();
        handlers.discard(event);
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(plugin.gitActions.push).toHaveBeenCalledOnce();
        await Promise.all(tasks);
        expect(plugin.gitActions.discardAll).not.toHaveBeenCalled();
        expect(tasks).toHaveLength(1);
        expect(notice).not.toHaveBeenCalled();
    });

    it("does not enqueue a second commit while one is running", async () => {
        const { handlers, commit, tasks } = ui();
        handlers.commit();
        handlers.commit();
        expect(commit).toHaveBeenCalledOnce();
        await Promise.all(tasks);
    });
});

afterEach(() => {
    delete window.__ignis;
});
describe("command-palette commit routes", () => {
    it("enables all six existing manual commands with their modes/message semantics", async () => {
        window.__ignis = { version: "test" };
        const commands = new Map<string, Command>();
        const tasks: Promise<unknown>[] = [];
        const commit = vi.fn().mockResolvedValue({ status: "success" });
        const notice = vi.fn();
        const plugin = {
            app: {},
            settings: {},
            gitActions: {
                commit,
                push: vi.fn().mockResolvedValue({ status: "success" }),
                commitAndSync: vi.fn().mockResolvedValue({ status: "success" }),
            },
            addCommand: (command: Command) => commands.set(command.id, command),
            displayIgnisFutureFeature: notice,
            promiseQueue: {
                addTask: (task: () => Promise<unknown>) => {
                    tasks.push(task());
                },
            },
        };
        const context: Record<string, unknown> = {
            exports: {},
            commandForRuntime,
        };
        evaluate(readFileSync("src/commands.ts", "utf8"), context);
        (
            context.exports as { addCommmands(plugin: unknown): void }
        ).addCommmands(plugin);
        for (const [id, mode, custom] of [
            ["commit", "all", false],
            ["commit-specified-message", "all", true],
            ["commit-smart", "smart", false],
            ["commit-smart-specified-message", "smart", true],
            ["commit-staged", "staged", false],
            ["commit-staged-specified-message", "staged", true],
        ] as const) {
            commands.get(id)!.callback!();
            await Promise.all(tasks);
            const options = commit.mock.lastCall![0] as {
                fromAuto: boolean;
                mode: string;
                requestCustomMessage?: boolean;
            };
            expect(options.fromAuto).toBe(false);
            expect(options.mode).toBe(mode);
            expect(!!options.requestCustomMessage).toBe(custom);
        }
        commands.get("push2")!.callback!();
        commands.get("push")!.callback!();
        await Promise.all(tasks);
        expect(plugin.gitActions.push).toHaveBeenCalledOnce();
        expect(plugin.gitActions.commitAndSync).toHaveBeenCalledWith({
            fromAutoBackup: false,
        });
        expect(commands.get("push2")!.name).toBe("Push");
        expect(commands.get("push")!.name).toBe("Commit-and-sync");
        expect(notice).not.toHaveBeenCalled();
        expect(commit).toHaveBeenCalledTimes(6);
    });
});
