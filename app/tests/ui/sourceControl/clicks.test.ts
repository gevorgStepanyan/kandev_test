// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { TFile } from "obsidian";
import StagedFile from "src/ui/sourceControl/components/stagedFileComponent.svelte";
import ConflictFile from "src/ui/sourceControl/components/conflictFileComponent.svelte";
import SourceControl from "src/ui/sourceControl/sourceControl.svelte";
import Tree from "src/ui/sourceControl/components/treeComponent.svelte";
import Tools from "src/tools";
import { GitActions } from "src/gitActions";
import { IgnisGitManager } from "src/gitManager/ignisGit";
import DiffView from "src/ui/diff/diffView";
import SplitDiffView from "src/ui/diff/splitDiffView";
import {
    DEFAULT_SETTINGS,
    DIFF_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "src/constants";
import type GitView from "src/ui/sourceControl/sourceControl";
import type { DiffViewState } from "src/types";
import { FileType } from "src/types";
import { createFakePlugin } from "../../helpers/createFakePlugin";

vi.mock("obsidian", async (original) => ({
    ...(await original<typeof import("obsidian")>()),
    Keymap: {
        isModEvent: (event: MouseEvent) => (event.ctrlKey ? "tab" : false),
    },
}));

const components: Record<string, unknown>[] = [];
const splitViews: SplitDiffView[] = [];
beforeEach(() => {
    window.__ignis = { version: "test" };
    window.__currentVaultId = "Main";
    Object.assign(HTMLElement.prototype, {
        getAttr(this: HTMLElement, name: string) {
            return this.getAttribute(name);
        },
        addClass(this: HTMLElement, ...names: string[]) {
            this.classList.add(...names);
        },
        addClasses(this: HTMLElement, names: string[]) {
            this.classList.add(...names);
        },
        empty(this: HTMLElement) {
            this.replaceChildren();
        },
        setText(this: HTMLElement, value: string) {
            this.textContent = value;
        },
    });
});
afterEach(async () => {
    for (const view of splitViews.splice(0)) view.mergeView?.destroy();
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    delete window.__ignis;
    delete window.__currentVaultId;
    vi.unstubAllGlobals();
});

function setup(diffStyle: "git_unified" | "split" = "git_unified") {
    const plugin = createFakePlugin();
    plugin.settings.basePath = "";
    plugin.settings.gitDir = "";
    plugin.settings.diffStyle = diffStyle;
    plugin.settings.diffTimeout = 50;
    plugin.displayMessage = vi.fn();
    const file = Object.assign(new TFile(), {
        path: "note.md",
        extension: "md",
    });
    const rendered = document.createElement("div");
    document.body.append(rendered);
    const openFile = vi.fn().mockResolvedValue(undefined);
    const setViewState = vi.fn(
        async ({ type, state }: { type: string; state: DiffViewState }) => {
            if (type === SPLIT_DIFF_VIEW_CONFIG.type) {
                const container = document.createElement("div");
                container.append(document.createElement("div"), rendered);
                const split = Object.create(
                    SplitDiffView.prototype
                ) as SplitDiffView;
                Object.assign(split, {
                    plugin,
                    app: plugin.app,
                    state,
                    contentEl: rendered,
                    containerEl: container,
                    fileSaveDebouncer: vi.fn(),
                });
                splitViews.push(split);
                await split.createMergeView();
                return;
            }
            expect(type).toBe(DIFF_VIEW_CONFIG.type);
            const diff = Object.create(DiffView.prototype) as DiffView;
            Object.assign(diff, {
                plugin,
                app: plugin.app,
                state,
                contentEl: rendered,
                parser: new DOMParser(),
            });
            await diff.refresh();
        }
    );
    const getLeaf = vi.fn(() => ({ openFile, setViewState }));
    Object.assign(plugin.app, {
        vault: { getAbstractFileByPath: () => file, getFileByPath: () => file },
        viewRegistry: { getTypeByExtension: () => "markdown" },
    });
    Object.assign(plugin.app.workspace, { getLeaf });
    Object.assign(plugin, {
        isAllInitialized: vi.fn().mockResolvedValue(true),
    });
    plugin.gitManager = new IgnisGitManager(plugin);
    plugin.tools = new Tools(plugin);
    plugin.gitActions = new GitActions(plugin);
    const view = {
        app: plugin.app,
        plugin,
        leaf: { getRoot: () => ({ side: "right" }) },
    } as unknown as GitView;
    const target = document.createElement("div");
    document.body.append(target);
    return { plugin, view, target, rendered, openFile, setViewState, getLeaf };
}

describe("rendered Source Control clicks in Ignis", () => {
    it("uses the existing conflict list without extra merge buttons or a review icon", async () => {
        const { plugin, view, target } = setup();
        plugin.settings = { ...DEFAULT_SETTINGS };
        plugin.gitReady = true;
        plugin.state.mergeInProgress = true;
        plugin.cachedStatus = {
            all: [],
            staged: [],
            changed: [],
            conflicted: ["note.md"],
            stagedOutsideVault: 0,
            conflictedOutsideVault: 0,
        };
        plugin.getUnpushedCommits = vi.fn().mockResolvedValue(0);
        Object.assign(view, { registerEvent: vi.fn() });
        Object.assign(plugin.app.workspace, {
            on: vi.fn(() => ({})),
            offref: vi.fn(),
        });
        Object.assign(plugin.app.vault, {
            on: vi.fn(() => ({})),
            offref: vi.fn(),
            adapter: {
                read: vi
                    .fn()
                    .mockResolvedValue(
                        "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\n"
                    ),
            },
        });
        vi.spyOn(
            plugin.gitManager.mergeWorkflow!,
            "getMergeState"
        ).mockResolvedValue({
            operation: "merge",
            kind: "merge-conflicted",
            head: "a".repeat(40),
            mergeHead: "b".repeat(40),
            unresolvedPaths: [
                {
                    path: "note.md",
                    kind: "content",
                    availableStages: [1, 2, 3],
                },
            ],
            canCommitMerge: false,
        });
        flushSync(() =>
            components.push(
                mount(SourceControl, { target, props: { plugin, view } })
            )
        );
        await vi.waitFor(() =>
            expect(target.querySelector('[data-path="note.md"]')).not.toBeNull()
        );
        expect(target.querySelector("textarea")).not.toBeNull();
        expect(
            target.querySelector('[aria-label="Mark resolved"]')
        ).not.toBeNull();
        expect(
            target.querySelector('[aria-label="Review base / ours / theirs"]')
        ).toBeNull();
        expect(target.textContent).not.toContain("Abort merge");
        expect(target.textContent).not.toContain("Merge incoming changes");
    });
    it("opens staged split diffs using only allowed server head/index content sources", async () => {
        const { plugin, view, target, rendered } = setup("split");
        const fetchMock = vi.fn((url: string) =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        kind: "text",
                        text: url.includes("source=head")
                            ? "before\n"
                            : "staged\n",
                        hash: "c".repeat(64),
                    })
                )
            )
        );
        vi.stubGlobal("fetch", fetchMock);
        flushSync(() =>
            components.push(
                mount(StagedFile, {
                    target,
                    props: {
                        view,
                        change: {
                            path: "note.md",
                            vaultPath: "note.md",
                            index: "M",
                            workingDir: " ",
                        },
                    },
                })
            )
        );
        target.querySelector<HTMLElement>(".nav-file-title-content")!.click();
        await vi.waitFor(() =>
            expect(rendered.querySelectorAll(".cm-editor")).toHaveLength(2)
        );
        expect(
            fetchMock.mock.calls.map(([url]) =>
                new URL(url, "https://ignis.invalid").searchParams.get("source")
            )
        ).toEqual(["head", "index"]);
        expect(plugin.displayError).not.toHaveBeenCalled();
    });

    it("surfaces a failure to open the staged diff pane", async () => {
        const { plugin, view, target, setViewState } = setup();
        const error = new Error("Pane unavailable");
        setViewState.mockRejectedValueOnce(error);
        flushSync(() =>
            components.push(
                mount(StagedFile, {
                    target,
                    props: {
                        view,
                        change: {
                            path: "note.md",
                            vaultPath: "note.md",
                            index: "M",
                            workingDir: " ",
                        },
                    },
                })
            )
        );
        target.querySelector<HTMLElement>(".nav-file-title-content")!.click();
        await vi.waitFor(() =>
            expect(plugin.displayError).toHaveBeenCalledWith(error)
        );
    });
    it.each(["flat", "tree"])(
        "opens staged HEAD-to-index diffs from the filename in %s layout",
        async (layout) => {
            const { plugin, view, target, rendered, setViewState } = setup();
            const fetchMock = vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        kind: "text",
                        diff: "diff --git a/note.md b/note.md\n--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-before\n+staged\n",
                    })
                )
            );
            vi.stubGlobal("fetch", fetchMock);
            const change = {
                path: "note.md",
                vaultPath: "note.md",
                index: "M",
                workingDir: " ",
            };
            if (layout === "tree")
                flushSync(() =>
                    components.push(
                        mount(Tree, {
                            target,
                            props: {
                                plugin,
                                view,
                                closed: {},
                                fileType: FileType.staged,
                                hierarchy: {
                                    title: "",
                                    path: "",
                                    vaultPath: "",
                                    children: [
                                        {
                                            title: "note.md",
                                            path: "note.md",
                                            vaultPath: "note.md",
                                            data: change,
                                        },
                                    ],
                                },
                            },
                        })
                    )
                );
            else
                flushSync(() =>
                    components.push(
                        mount(StagedFile, {
                            target,
                            props: {
                                view,
                                change: {
                                    path: "note.md",
                                    vaultPath: "note.md",
                                    index: "M",
                                    workingDir: " ",
                                },
                            },
                        })
                    )
                );
            target
                .querySelector<HTMLElement>(".nav-file-title-content")!
                .click();
            await vi.waitFor(() =>
                expect(rendered.textContent).toContain("staged")
            );
            expect(setViewState).toHaveBeenCalledWith(
                expect.objectContaining({
                    state: {
                        aFile: "note.md",
                        bFile: "note.md",
                        aRef: "HEAD",
                        bRef: "",
                    },
                })
            );
            expect(fetchMock.mock.calls[0]![0]).toContain("kind=staged");
            expect(plugin.displayError).not.toHaveBeenCalled();
        }
    );

    it.each(["flat", "tree"])(
        "opens a conflict filename in live preview through the real manager and action in %s layout",
        async (layout) => {
            const { plugin, view, target, openFile } = setup();
            const head = "a".repeat(40),
                incoming = "b".repeat(40);
            const text = {
                kind: "text",
                text: "conflict",
                hash: "c".repeat(64),
            };
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(
                    new Response(
                        JSON.stringify({
                            path: "note.md",
                            kind: "content",
                            availableStages: [1, 2, 3],
                            merge: {
                                operation: "merge",
                                kind: "merge-conflicted",
                                head,
                                mergeHead: incoming,
                                unresolvedPaths: [
                                    {
                                        path: "note.md",
                                        kind: "content",
                                        availableStages: [1, 2, 3],
                                    },
                                ],
                                canCommitMerge: false,
                            },
                            contents: {
                                base: text,
                                ours: text,
                                theirs: text,
                                worktree: text,
                            },
                        })
                    )
                )
            );
            if (layout === "tree")
                flushSync(() =>
                    components.push(
                        mount(Tree, {
                            target,
                            props: {
                                plugin,
                                view,
                                closed: {},
                                fileType: FileType.conflicted,
                                conflictCounts: { "note.md": 1 },
                                hierarchy: {
                                    title: "",
                                    path: "",
                                    vaultPath: "",
                                    children: [
                                        {
                                            title: "note.md",
                                            path: "note.md",
                                            vaultPath: "note.md",
                                            data: {
                                                path: "note.md",
                                                vaultPath: "note.md",
                                                index: "U",
                                                workingDir: "U",
                                            },
                                        },
                                    ],
                                },
                            },
                        })
                    )
                );
            else
                flushSync(() =>
                    components.push(
                        mount(ConflictFile, {
                            target,
                            props: {
                                view,
                                manager: plugin.gitManager,
                                path: "note.md",
                                count: 1,
                            },
                        })
                    )
                );
            target
                .querySelector<HTMLElement>(".nav-file-title-content")!
                .click();
            await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
            expect(openFile).toHaveBeenCalledWith(expect.any(TFile), {
                active: true,
                state: { mode: "source", source: false },
            });
            expect(plugin.displayError).not.toHaveBeenCalled();
        }
    );
});

describe("rendered Ignis Push button", () => {
    it.each([false, true])(
        "uses the existing action/manager/transport chain and releases loading (count unavailable: %s)",
        async (countUnavailable) => {
            const { plugin, view, target } = setup();
            plugin.settings = { ...DEFAULT_SETTINGS };
            plugin.gitReady = true;
            const empty = {
                all: [],
                changed: [],
                staged: [],
                conflicted: [],
                stagedOutsideVault: 0,
                conflictedOutsideVault: 0,
            };
            plugin.cachedStatus = empty;
            plugin.getUnpushedCommits = countUnavailable
                ? vi
                      .fn()
                      .mockRejectedValue(
                          new Error("remote readiness unavailable")
                      )
                : vi.fn().mockResolvedValue(1);
            plugin.updateCachedStatus = vi.fn().mockResolvedValue(empty);
            Object.assign(view, { registerEvent: vi.fn() });
            Object.assign(plugin.app.workspace, {
                on: vi.fn(() => ({})),
                offref: vi.fn(),
            });
            Object.assign(plugin.app.vault, {
                on: vi.fn(() => ({})),
                offref: vi.fn(),
            });
            vi.spyOn(
                plugin.gitManager.mergeWorkflow!,
                "getMergeState"
            ).mockResolvedValue({
                operation: "none",
                kind: "clean",
                head: "a".repeat(40),
                unresolvedPaths: [],
                canCommitMerge: false,
            });
            const pending: Promise<unknown>[] = [];
            Object.assign(plugin, {
                promiseQueue: {
                    addTask(task: () => Promise<unknown>) {
                        pending.push(task());
                    },
                },
            });
            const request = vi
                .fn<(url: string) => Promise<Response>>()
                .mockImplementation((url: string) =>
                    Promise.resolve(
                        new Response(
                            JSON.stringify(
                                url.includes("/push-state?")
                                    ? {
                                          configured: true,
                                          canPush: true,
                                          unpushedCommits: 1,
                                      }
                                    : {
                                          error: {
                                              code: "PUSH_NON_FAST_FORWARD",
                                              message:
                                                  "Pull/merge remote changes first.",
                                          },
                                      }
                            ),
                            { status: url.includes("/push-state?") ? 200 : 409 }
                        )
                    )
                );
            vi.stubGlobal("fetch", request);
            const action = vi.spyOn(plugin.gitActions, "push");
            const backend = vi.spyOn(plugin.gitManager, "push");
            flushSync(() =>
                components.push(
                    mount(SourceControl, { target, props: { plugin, view } })
                )
            );
            await vi.waitFor(() =>
                expect(plugin.getUnpushedCommits).toHaveBeenCalled()
            );
            const button = target.querySelector<HTMLElement>("#push")!;
            expect(button).not.toBeNull();
            expect(button.classList.contains("is-disabled")).toBe(false);
            expect(button.getAttribute("aria-disabled")).not.toBe("true");
            button.click();
            await Promise.all(pending);
            expect(action).toHaveBeenCalledOnce();
            expect(backend).toHaveBeenCalledOnce();
            expect(
                request.mock.calls.filter(([url]) => url.endsWith("/push"))
            ).toHaveLength(1);
            expect(plugin.displayError).toHaveBeenCalledTimes(
                countUnavailable ? 2 : 1
            );
            expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
                "obsidian-git:refresh"
            );
            flushSync();
            expect(
                target.querySelector("#refresh")!.classList.contains("loading")
            ).toBe(false);
            // No `refreshed` event is emitted by the mock app.
            button.click();
            await Promise.all(pending);
            expect(action).toHaveBeenCalledTimes(2);
        }
    );
});
