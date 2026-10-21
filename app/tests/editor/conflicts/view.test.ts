import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateField } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { pluginRef } from "src/pluginGlobalRef";
import { createFakePlugin } from "../../helpers/createFakePlugin";
import {
    conflictBlocksField,
    refreshConflictState,
} from "src/editor/conflicts/view";

vi.mock("obsidian", async (importOriginal) => ({
    ...(await importOriginal<typeof import("obsidian")>()),
    editorLivePreviewField: StateField.define({
        create: () => true,
        update: (v: boolean) => v,
    }),
}));

afterEach(() => {
    delete window.__ignis;
    delete pluginRef.plugin;
});

const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\n";

function editorState() {
    return EditorState.create({
        doc: text,
        extensions: [editorLivePreviewField, conflictBlocksField],
    });
}

describe("conflict controls and authoritative Git state", () => {
    it("recomputes open Ignis editors after merge state changes without editing their text", () => {
        window.__ignis = { version: "test" };
        const plugin = createFakePlugin();
        const workflow = { canResolveTextConflicts: false };
        Object.assign(plugin, { gitManager: { mergeWorkflow: workflow } });
        pluginRef.plugin = plugin;
        let state = editorState();
        expect(state.field(conflictBlocksField)).toHaveLength(0);
        workflow.canResolveTextConflicts = true;
        state = state.update({
            effects: refreshConflictState.of(undefined),
        }).state;
        expect(state.field(conflictBlocksField)).toHaveLength(1);
        expect(state.doc.toString()).toBe(text);
        workflow.canResolveTextConflicts = false;
        state = state.update({
            effects: refreshConflictState.of(undefined),
        }).state;
        expect(state.field(conflictBlocksField)).toHaveLength(0);
        expect(state.doc.toString()).toBe(text);
    });

    it("preserves ordinary desktop conflict parsing", () => {
        expect(editorState().field(conflictBlocksField)).toHaveLength(1);
    });
});
