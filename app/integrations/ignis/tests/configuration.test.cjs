const { test } = require("node:test");
const assert = require("node:assert/strict");
const { routeOptions } = require("../obsidian-git/configuration");
const { mountRoutes } = require("../obsidian-git/routes");

test("uses Ignis origins without duplicating Git startup configuration", () => {
    assert.deepEqual(
        routeOptions({
            WS_ORIGINS: "https://notes.example.com, http://localhost:3001 ",
            GIT_VAULT: "Main",
            GIT_REPO: "git@example.com:notes.git",
            GIT_BRANCH: "main",
        }),
        {
            enabled: true,
            origins: ["https://notes.example.com", "http://localhost:3001"],
        }
    );
});

test("preserves explicit legacy origin and disable overrides", () => {
    assert.deepEqual(
        routeOptions({
            WS_ORIGINS: "https://other.example.com",
            IGNIS_GIT_ORIGIN: "https://notes.example.com",
            IGNIS_GIT_ENABLED: "false",
        }),
        { enabled: false, origins: ["https://notes.example.com"] }
    );
});

function checkGuard(options, source) {
    let guard;
    mountRoutes(
        {
            use(fn) {
                guard = fn;
            },
            get() {},
            post() {},
        },
        {},
        options
    );
    let accepted = false;
    const res = {
        status(code) {
            this.code = code;
            return this;
        },
        json() {},
        set() {},
    };
    guard(
        { method: "GET", headers: { origin: source, "x-obsidian-git": "1" } },
        res,
        () => {
            accepted = true;
        }
    );
    return accepted ? 200 : res.code;
}

test("accepts configured origins and rejects unlisted or missing origins", () => {
    const options = routeOptions({
        WS_ORIGINS: "https://notes.example.com,http://localhost:3001",
    });
    assert.equal(checkGuard(options, "https://notes.example.com"), 200);
    assert.equal(checkGuard(options, "http://localhost:3001"), 200);
    assert.equal(checkGuard(options, "https://evil.example.com"), 403);
    assert.equal(checkGuard(options, undefined), 403);
    assert.equal(
        checkGuard(routeOptions({}), "https://notes.example.com"),
        503
    );
    assert.equal(
        checkGuard({ ...options, enabled: false }, "https://notes.example.com"),
        503
    );
});
