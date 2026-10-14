const { createRequire } = require("node:module");
const { transformSync } = require("esbuild");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const vm = require("node:vm");
const fs = require("node:fs");
const req = createRequire(path.join(root, "package.json"));
const stubModule = { exports: {} };
vm.runInNewContext(
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
    __ignis: { version: "pilot" },
    __currentVaultId: "Main",
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
};
const app = {
    workspace: {
        trigger() {},
        iterateAllLeaves() {},
        getLeavesOfType() {
            return [];
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
    fetch: async () => new Response(JSON.stringify({ requirements: "valid" })),
};
context.global = context;
try {
    vm.runInNewContext(
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
    .then(() => {
        if (!plugin.gitReady || spawned || plugin.useSimpleGit)
            throw new Error("Ignis native initialization regression");
        console.log(
            "Production bundle selected Ignis backend without spawning native Git."
        );
    })
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
