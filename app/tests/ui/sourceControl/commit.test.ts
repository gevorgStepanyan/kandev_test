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
    setState(status: Status, message: string): void;
    readonly message: string;
    readonly loading: boolean;
};
function ui() {
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
        gitActions: { commit },
        displayMessage: notice,
        displayIgnisFutureFeature: notice,
        promiseQueue: {
            addTask: (task: () => Promise<unknown>) => {
                tasks.push(task());
            },
        },
    };
    const items = new Map<string, () => void>();
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
                setDisabled() {
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
        isIgnis: () => true,
        IGNIS_FUTURE_FEATURE_NOTICE: "future",
        Menu: { forEvent: () => menu },
    };
    evaluate(
        source +
            `
        globalThis.handlers = {
            commit, showCommitMenu,
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
    return { plugin, handlers, commit, trigger, items, notice, tasks, text };
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

    it("dropdown preserves staged/all labels and routes each mode; unsupported items only notify", async () => {
        const { handlers, commit, tasks, items, notice } = ui();
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
        expect(commit).toHaveBeenCalledTimes(2);
        expect(notice).toHaveBeenCalledTimes(2);
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
            gitActions: { commit },
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
        expect(notice).toHaveBeenCalled();
        expect(commit).toHaveBeenCalledTimes(6);
    });
});
