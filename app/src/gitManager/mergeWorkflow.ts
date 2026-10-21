/** Optional capability for the server-backed, explicitly confirmed merge flow. */
export interface MergeState {
    operation: "none" | "merge" | "rebase" | "cherry-pick" | "other";
    kind:
        | "clean"
        | "diverged"
        | "merge-conflicted"
        | "merge-awaiting-commit"
        | "rebase-or-other";
    head: string | null;
    upstream?: { ref: string; oid: string };
    mergeHead?: string;
    unresolvedPaths: {
        path: string;
        kind: string;
        availableStages: number[];
    }[];
    canCommitMerge: boolean;
    canAbortMerge: boolean;
}
export interface FileContent {
    kind: "text" | "missing" | "binary" | "oversized" | "unsupported";
    text?: string;
    hash?: string;
    mode?: string;
    size?: number;
    stageMissing?: boolean;
}
export interface ConflictDetails {
    path: string;
    kind: string;
    availableStages: number[];
    merge: MergeState;
    contents: Record<"base" | "ours" | "theirs" | "worktree", FileContent>;
}
export interface MergeWorkflow {
    readonly canResolveTextConflicts: boolean;
    getMergeState(): Promise<MergeState>;
    getConflictDetails(path: string): Promise<ConflictDetails>;
    startMerge(state: MergeState): Promise<void>;
    abortMerge(state: MergeState): Promise<void>;
    markResolved(path: string): Promise<void>;
    getFileContent(path: string, source: string): Promise<FileContent>;
}
