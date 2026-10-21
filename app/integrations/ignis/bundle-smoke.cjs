const { createRequire } = require("node:module");
const { transformSync } = require("esbuild");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const vm = require("node:vm");
const fs = require("node:fs");
const req = createRequire(path.join(root, "package.json"));
const stubModule = { exports: {} };
const obsidianArrayExtensions =
    "Array.prototype.last = function () { return this[this.length - 1]; };\n";
vm.runInNewContext(
    obsidianArrayExtensions +
        transformSync(
            fs.readFileSync(path.join(root, "tests/stubs/obsidian.ts"), "utf8"),
            { loader: "ts", format: "cjs" }
        ).code,
    {
        module: stubModule,
        exports: stubModule.exports,
        setTimeout,
        clearTimeout,
        Date,
        console,
    }
);
const obsidian = { ...stubModule.exports, SettingPage: class {} };
let spawned = 0;
const unavailable = new Proxy(
    {},
    {
        get: () => () => {
            spawned++;
            throw new Error("Native processes unavailable");
        },
    }
);
const win = {
    __ignis: {
        version: "pilot",
        writes: {
            getState: () => "clean",
            listFailed: () => [],
            listPending: () => [],
            getDetail: () => ({ pending: 0, retrying: 0 }),
        },
    },
    __currentVaultId: "Main",
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
};
const openedFiles = [];
const app = {
    workspace: {
        trigger() {},
        iterateAllLeaves() {},
        getLeavesOfType() {
            return [];
        },
        getLeaf() {
            return {
                async openFile(file, options) {
                    openedFiles.push({ file, options });
                },
            };
        },
    },
    vault: {
        getAbstractFileByPath() {
            return Object.assign(new obsidian.TFile(), {
                path: "note.md",
                extension: "md",
            });
        },
    },
    loadLocalStorage() {
        return null;
    },
};
const moduleObj = { exports: {} };
const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    require(name) {
        if (name === "obsidian") return obsidian;
        if (name === "child_process" || name === "node:child_process")
            return unavailable;
        try {
            return req(name);
        } catch (e) {
            if (name.startsWith("@codemirror/"))
                return createRequire(req.resolve("codemirror"))(name);
            if (name.startsWith("@lezer/"))
                return createRequire(
                    createRequire(req.resolve("codemirror")).resolve(
                        "@codemirror/language"
                    )
                )(name);
            throw e;
        }
    },
    process,
    Buffer,
    window: win,
    document: { body: { style: { setProperty() {} } } },
    activeDocument: { body: { style: { setProperty() {} } } },
    activeWindow: win,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    Response,
    localStorage: { debug: "-simple-git" },
    fetch: async (url, init) => {
        if (url.includes("/push-state?"))
            return new Response(
                JSON.stringify({
                    configured: true,
                    canPush: true,
                    unpushedCommits: 1,
                })
            );
        if (url.endsWith("/push")) {
            if (
                JSON.stringify(JSON.parse(init.body)) !==
                JSON.stringify({ vaultId: "Main" })
            )
                throw new Error("Push payload contains arbitrary parameters");
            return new Response(
                JSON.stringify({ status: "pushed", files: null })
            );
        }
        if (url.includes("/state?"))
            return new Response(
                JSON.stringify({
                    status: {
                        all: [],
                        staged: [],
                        changed: [],
                        conflicted: [],
                        stagedOutsideVault: 0,
                        conflictedOutsideVault: 0,
                    },
                    branch: {
                        current: "main",
                        tracking: "origin/main",
                        branches: ["main"],
                    },
                    mergeInProgress: false,
                    lastCommitTime: null,
                    unpushedCommits: 1,
                    config: {},
                    remotes: {},
                })
            );
        if (url.endsWith("/pull")) {
            if (JSON.parse(init.body).mergeOnDivergence !== true)
                throw new Error("Manual Pull did not authorize integration");
            return new Response(
                JSON.stringify({
                    status: "merge-pending",
                    merge: {
                        operation: "merge",
                        kind: "merge-awaiting-commit",
                        head: "a".repeat(40),
                        mergeHead: "b".repeat(40),
                        unresolvedPaths: [],
                        canCommitMerge: true,
                    },
                })
            );
        }
        if (url.includes("/diff?")) {
            if (!url.includes("kind=staged"))
                throw new Error("Staged diff wiring regression");
            return new Response(
                JSON.stringify({ kind: "text", diff: "staged patch" })
            );
        }
        if (url.includes("/conflicts?")) {
            const value = {
                kind: "text",
                text: "conflict",
                hash: "c".repeat(64),
            };
            return new Response(
                JSON.stringify({
                    path: "note.md",
                    kind: "content",
                    availableStages: [1, 2, 3],
                    merge: {
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
                    },
                    contents: {
                        base: value,
                        ours: value,
                        theirs: value,
                        worktree: value,
                    },
                })
            );
        }
        return new Response(JSON.stringify({ requirements: "valid" }));
    },
};
context.global = context;
try {
    vm.runInNewContext(
        obsidianArrayExtensions +
            fs.readFileSync(path.join(root, "main.js"), "utf8"),
        context
    );
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
const Plugin = moduleObj.exports.default;
const plugin = new Plugin(app, { id: "obsidian-git", name: "Git" });
plugin.settings = {
    showStatusBar: false,
    showBranchStatusBar: false,
    autoPullOnBoot: false,
    autoSaveInterval: 0,
    autoPushInterval: 0,
    autoPullInterval: 0,
    basePath: "",
    gitDir: "",
    hunks: {},
    lineAuthor: {},
};
plugin.refresh = async () => {};
plugin
    .init({ fromReload: false })
    .then(async () => {
        if (!plugin.gitReady || spawned || plugin.useSimpleGit)
            throw new Error("Ignis native initialization regression");
        if (
            typeof plugin.gitActions.abortMerge !== "undefined" ||
            typeof plugin.gitManager.abortMerge !== "undefined"
        )
            throw new Error(
                "Removed merge abort functionality is still exposed"
            );
        console.log(
            "Production bundle selected Ignis backend without spawning native Git."
        );
        if (
            (await plugin.gitManager.getDiffString("note.md", true)) !==
            "staged patch"
        )
            throw new Error(
                "Production bundle did not expose staged diff support"
            );
        await plugin.gitActions.openConflict("note.md");
        if (
            openedFiles.length !== 1 ||
            openedFiles[0].options.state.mode !== "source" ||
            openedFiles[0].options.state.source !== false
        )
            throw new Error(
                "Production bundle did not open the conflict editor in live preview"
            );
        console.log(
            "Production bundle opened the Ignis staged diff and conflict editor."
        );
        const pushed = await plugin.gitActions.push();
        if (
            pushed.status !== "success" ||
            pushed.value.status !== "pushed" ||
            pushed.value.files !== null ||
            spawned
        )
            throw new Error(
                "Production bundle Push did not use Ignis transport"
            );
        console.log(
            "Production bundle Push used the existing action and HTTP transport without native processes."
        );
        const pulled = await plugin.gitActions.pull();
        if (
            pulled.status !== "success" ||
            pulled.value.status !== "merge-pending"
        )
            throw new Error(
                "Production bundle manual Pull did not preserve the pending merge result"
            );
        console.log(
            "Production bundle manual Pull integrated divergence without committing."
        );
    })
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
