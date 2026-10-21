import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";
import { compile, preprocess } from "svelte/compiler";
import { sveltePreprocess } from "svelte-preprocess";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [
        {
            name: "svelte-components-under-test",
            async transform(source: string, id: string) {
                if (!id.endsWith(".svelte")) return;
                const prepared = await preprocess(source, sveltePreprocess(), {
                    filename: id,
                });
                return compile(prepared.code, {
                    filename: id,
                    generate: "client",
                    css: "injected",
                    dev: false,
                }).js;
            },
        },
    ],
    resolve: {
        alias: [
            {
                find: /^svelte$/,
                replacement: path.resolve(
                    dirname,
                    "node_modules/svelte/src/index-client.js"
                ),
            },
            {
                find: "obsidian",
                replacement: path.resolve(dirname, "tests/stubs/obsidian.ts"),
            },
            { find: "src", replacement: path.resolve(dirname, "src") },
        ],
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: "coverage",
        },
    },
});
