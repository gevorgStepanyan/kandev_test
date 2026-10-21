import { afterEach, describe, expect, it, vi } from "vitest";
import {
    commandForRuntime,
    gitBackendForRuntime,
    isIgnis,
    IgnisUnsupportedGitFeatureError,
} from "src/platform/ignis";
import { runGitAction } from "src/gitAction";
import { createFakePlugin } from "../helpers/createFakePlugin";
import { GitActions } from "src/gitActions";
import { addCommmands } from "src/commands";

afterEach(() => {
    delete window.__ignis;
});
describe("Ignis runtime capabilities", () => {
    it("does not register Ignis-only merge or abort commands", () => {
        window.__ignis = { version: "test" };
        const plugin = createFakePlugin();
        const register = vi.fn<typeof plugin.addCommand>();
        plugin.addCommand = register;
        addCommmands(plugin);
        const ids = register.mock.calls.map(([command]) => command.id);
        expect(ids).toContain("pull");
        expect(ids).not.toContain("abort-merge");
        expect(ids).not.toContain("merge-incoming-changes");
        expect(
            Reflect.get(new GitActions(plugin), "abortMerge")
        ).toBeUndefined();
    });
    it("preserves desktop/mobile selection and prioritizes explicit Ignis detection", () => {
        expect(isIgnis()).toBe(false);
        expect(gitBackendForRuntime(true)).toBe("simple");
        expect(gitBackendForRuntime(false)).toBe("isomorphic");
        window.__ignis = { version: "pilot" };
        expect(gitBackendForRuntime(true)).toBe("ignis");
        expect(gitBackendForRuntime(false)).toBe("ignis");
    });
    it("replaces unsupported callbacks and checks before they can mutate editor/files", () => {
        window.__ignis = { version: "pilot" };
        const notice = vi.fn(),
            mutate = vi.fn();
        const guarded = commandForRuntime(
            { id: "edit-gitignore", name: "Edit", checkCallback: mutate },
            notice
        );
        guarded.callback?.();
        expect(notice).toHaveBeenCalledOnce();
        expect(mutate).not.toHaveBeenCalled();
        expect(guarded.checkCallback).toBeUndefined();
        for (const id of [
            "pull",
            "commit",
            "commit-specified-message",
            "commit-smart",
            "commit-smart-specified-message",
            "commit-staged",
            "commit-staged-specified-message",
            "stage-current-file",
            "unstage-current-file",
        ]) {
            const command = { id, name: id, callback: mutate };
            expect(commandForRuntime(command, notice)).toBe(command);
        }
        const hunk = commandForRuntime(
            { id: "stage-hunk", name: "Stage hunk", callback: mutate },
            notice
        );
        hunk.callback?.();
        expect(mutate).not.toHaveBeenCalled();
    });
    it("blocks public GitActions before readiness, prompts or direct filesystem operations", async () => {
        window.__ignis = { version: "pilot" };
        const plugin = createFakePlugin();
        const action = vi.fn();
        expect((await runGitAction(plugin, action)).status).toBe("failed");
        expect(action).not.toHaveBeenCalled();
        expect(plugin.displayError).toHaveBeenCalledWith(
            expect.any(IgnisUnsupportedGitFeatureError)
        );
        const actions = new GitActions(plugin);
        await actions.deleteRepository();
        await actions.cloneNewRepo();
        await actions.commit({ fromAuto: true });
        await actions.addFileToGitignore("note.md");
        expect(plugin.displayError).toHaveBeenCalledTimes(5);
    });
});
