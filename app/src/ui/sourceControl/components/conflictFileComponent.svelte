<script lang="ts">
    import { setIcon, TFile } from "obsidian";
    import type { GitManager } from "src/gitManager/gitManager";
    import { getDisplayPath, getNewLeaf, getTooltipSide } from "src/utils";
    import type GitView from "../sourceControl";

    interface Props {
        path: string;
        count: number | undefined;
        view: GitView;
        manager: GitManager;
    }

    let { path, count, view, manager }: Props = $props();
    let button: HTMLElement | undefined = $state();
    let reviewButton: HTMLElement | undefined = $state();
    let resolvedIcon: HTMLElement | undefined = $state();

    let vaultPath = $derived(manager.getRelativeVaultPath(path));
    let side = $derived(getTooltipSide(view.leaf));

    $effect(() => {
        if (reviewButton) setIcon(reviewButton, "git-compare");
        if (button) setIcon(button, count === 0 ? "plus" : "check");
    });

    $effect(() => {
        if (resolvedIcon) setIcon(resolvedIcon, "check");
    });

    function open(event: MouseEvent) {
        event.stopPropagation();
        if (manager.mergeWorkflow) {
            void view.plugin.gitActions.openConflict(path, event);
            return;
        }
        const file = view.app.vault.getAbstractFileByPath(vaultPath);
        if (file instanceof TFile) {
            getNewLeaf(view.app, event)
                ?.openFile(file)
                .catch((e) => view.plugin.displayError(e));
        }
    }

    function resolve(event: MouseEvent) {
        event.stopPropagation();
        view.plugin.promiseQueue.addTask(async () => {
            if (manager.mergeWorkflow)
                await view.plugin.gitActions.markResolved(path);
            else await view.plugin.gitActions.stage(path, false);
        });
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_unknown_aria_attribute -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<main onclick={open} class="tree-item nav-file">
    <div
        class="tree-item-self is-clickable nav-file-title"
        data-path={vaultPath}
        data-tooltip-position={side}
        aria-label={vaultPath}
    >
        <div class="tree-item-inner nav-file-title-content">
            {getDisplayPath(vaultPath)}
        </div>
        <div class="git-tools">
            <div class="buttons">
                {#if manager.mergeWorkflow}
                    <div
                        aria-label="Review base / ours / theirs"
                        bind:this={reviewButton}
                        class="clickable-icon"
                        onclick={(event) => {
                            event.stopPropagation();
                            view.plugin.gitActions.reviewConflict(path);
                        }}
                    ></div>
                {/if}
                <div
                    aria-label="Mark resolved"
                    bind:this={button}
                    onclick={resolve}
                    class="clickable-icon"
                ></div>
            </div>
            {#if count === 0}
                <div
                    class="type resolved"
                    aria-label={manager.mergeWorkflow
                        ? "No marker blocks; Git path still needs Mark resolved"
                        : "No conflicts left"}
                    bind:this={resolvedIcon}
                ></div>
            {:else if count !== undefined}
                <div
                    class="type conflict"
                    aria-label="{count} conflict(s) left"
                >
                    {count}
                </div>
            {/if}
        </div>
    </div>
</main>

<style lang="scss">
    .git-tools {
        display: grid;
        grid-template-columns: auto 4ch;
        column-gap: var(--size-2-1);
        align-items: center;
    }

    .git-tools .buttons {
        display: flex;
    }

    .git-tools .type.conflict {
        color: var(--git-change);
        width: 4ch;
        padding: 0;
        justify-content: flex-end;
        font-variant-numeric: tabular-nums;
    }

    .git-tools .type.resolved {
        color: var(--git-insert);
        width: 4ch;
        padding: 0;
        justify-content: flex-end;
    }

    .git-tools .type.resolved :global(svg) {
        width: var(--icon-m, 18px);
        height: var(--icon-m, 18px);
    }
</style>
