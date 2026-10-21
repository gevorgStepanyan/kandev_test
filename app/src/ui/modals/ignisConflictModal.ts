import { Modal, type EventRef } from "obsidian";
import type ObsidianGit from "src/main";

/** Read-only inspection of actual index stages, separate from editor marker counts. */
export class IgnisConflictModal extends Modal {
    private events: EventRef[] = [];
    private revision = 0;
    constructor(
        private plugin: ObsidianGit,
        private path: string
    ) {
        super(plugin.app);
    }
    onOpen(): void {
        this.events.push(
            this.app.workspace.on(
                "obsidian-git:status-changed",
                () => void this.refresh()
            )
        );
        this.events.push(
            this.app.workspace.on(
                "obsidian-git:head-change",
                () => void this.refresh()
            )
        );
        void this.refresh();
    }
    private async refresh(): Promise<void> {
        const revision = ++this.revision;
        try {
            const workflow = this.plugin.gitManager.mergeWorkflow;
            if (!workflow) return;
            const details = await workflow.getConflictDetails(this.path);
            if (revision !== this.revision) return;
            this.contentEl.empty();
            this.contentEl.createEl("h3", { text: this.path });
            this.contentEl.createEl("p", {
                text:
                    details.merge.operation === "merge"
                        ? `Git conflict: ${details.kind}. Ours is the current branch; theirs is the incoming merge head. Edit the file, save, switch to reading view, then Mark resolved.`
                        : `Git conflict: ${details.kind}. ${details.merge.operation} is in progress. Stages 2 and 3 can have different meanings during rebase. Inspection is read-only; finish this operation outside Ignis.`,
            });
            for (const source of [
                "base",
                "ours",
                "theirs",
                "worktree",
            ] as const) {
                const value = details.contents[source];
                this.contentEl.createEl("h4", {
                    text: `${source}${value.mode ? ` (${value.mode})` : ""}`,
                });
                this.contentEl.createEl("pre", {
                    text:
                        value.kind === "text"
                            ? value.text
                            : value.kind === "missing"
                              ? "This stage/file is absent."
                              : `${value.kind}: text rendering is unavailable. Preserve and resolve this file outside Ignis.`,
                });
            }
            for (const [label, aRef, bRef] of [
                ["Compare ours / theirs", ":2", ":3"],
                ["Compare base / ours", ":1", ":2"],
                ["Compare ours / resolution", ":2", undefined],
            ] as const) {
                const button = this.contentEl.createEl("button", {
                    text: label,
                });
                button.onclick = () =>
                    this.plugin.tools.openDiff({
                        aFile: this.path,
                        aRef,
                        bRef,
                    });
            }
        } catch (error) {
            if (revision === this.revision)
                this.contentEl.setText(
                    error instanceof Error ? error.message : String(error)
                );
        }
    }
    onClose(): void {
        this.revision++;
        for (const event of this.events) this.app.workspace.offref(event);
        this.events = [];
        this.contentEl.empty();
    }
}
