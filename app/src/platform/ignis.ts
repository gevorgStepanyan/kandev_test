import type { Command } from "obsidian";

export const IGNIS_FUTURE_FEATURE_NOTICE =
    "This Git feature is not available in Ignis yet. It will be implemented in a future version.";

export interface IgnisRuntime {
    version?: string;
    writes?: {
        getState(): string;
        listFailed(): string[];
        getDetail(): { pending: number; retrying: number };
    };
}

declare global {
    interface Window {
        __ignis?: IgnisRuntime;
        __currentVaultId?: string;
    }
}

export function isIgnis(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.__ignis?.version === "string"
    );
}

export function gitBackendForRuntime(
    desktop: boolean
): "ignis" | "simple" | "isomorphic" {
    return isIgnis() ? "ignis" : desktop ? "simple" : "isomorphic";
}

// Keep command IDs and names stable; block before callbacks, checks or editor edits.
export function commandForRuntime(
    command: Command,
    notice: () => void
): Command {
    if (
        !isIgnis() ||
        [
            "pull",
            "open-git-view",
            "list-changed-files",
            "pause-automatic-routines",
        ].includes(command.id)
    )
        return command;
    return {
        id: command.id,
        name: command.name,
        icon: command.icon,
        callback: notice,
    };
}

export class IgnisUnsupportedGitFeatureError extends Error {
    constructor() {
        super(IGNIS_FUTURE_FEATURE_NOTICE);
    }
}

export class IgnisGitError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly reportFile?: string
    ) {
        super(message);
    }
}
