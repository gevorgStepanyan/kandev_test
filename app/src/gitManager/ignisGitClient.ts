import { IgnisGitError } from "src/platform/ignis";
import type { MergeState, FileContent, ConflictDetails } from "./mergeWorkflow";
import type { BranchInfo, FileStatusResult, Status } from "src/types";

export interface IgnisRepositoryState {
    status: Status;
    branch: BranchInfo;
    mergeInProgress: boolean;
    merge?: MergeState;
    lastCommitTime: string | null;
    unpushedCommits: number;
    config: Record<string, string | undefined>;
    remotes: Record<string, string | undefined>;
}

export type IgnisCommitRequest = {
    mode: "staged" | "all" | "smart";
    message: string;
    amend: boolean;
    autoStageOnEmptyIndex?: boolean;
};

export type IgnisMutationPayload =
    | { mergeOnDivergence: boolean }
    | { path?: string; dir?: string }
    | IgnisCommitRequest
    | {
          expectedHead?: string | null;
          expectedUpstream?: string;
          expectedMergeHead?: string;
          expectedHash?: string;
          confirmed?: boolean;
          path?: string;
          delete?: boolean;
          allowMarkers?: boolean;
      };

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function paths(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.every((v: unknown) => typeof v === "string")
    );
}
function safePath(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        !/^[a-z]:/i.test(value) &&
        !value
            .split("/")
            .some(
                (p) =>
                    !p || p === ".." || p === "." || p.toLowerCase() === ".git"
            )
    );
}
export function fileEntries(value: unknown): value is FileStatusResult[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry: unknown) =>
                record(entry) &&
                safePath(entry.path) &&
                entry.vaultPath === entry.path &&
                (entry.from === undefined || safePath(entry.from)) &&
                typeof entry.index === "string" &&
                entry.index.length === 1 &&
                typeof entry.workingDir === "string" &&
                entry.workingDir.length === 1
        )
    );
}
function stringMap(
    value: unknown
): value is Record<string, string | undefined> {
    return (
        record(value) &&
        Object.values(value).every(
            (v) => v === undefined || typeof v === "string"
        )
    );
}
export function repositoryState(value: unknown): IgnisRepositoryState {
    if (
        !record(value) ||
        !record(value.status) ||
        !record(value.branch) ||
        !fileEntries(value.status.all) ||
        !fileEntries(value.status.changed) ||
        !fileEntries(value.status.staged) ||
        !paths(value.status.conflicted) ||
        !value.status.conflicted.every(safePath) ||
        value.status.stagedOutsideVault !== 0 ||
        value.status.conflictedOutsideVault !== 0 ||
        !paths(value.branch.branches) ||
        (value.branch.current !== undefined &&
            typeof value.branch.current !== "string") ||
        (value.branch.tracking !== undefined &&
            typeof value.branch.tracking !== "string") ||
        typeof value.mergeInProgress !== "boolean" ||
        (value.lastCommitTime !== null &&
            (typeof value.lastCommitTime !== "string" ||
                !Number.isFinite(Date.parse(value.lastCommitTime)))) ||
        !Number.isInteger(value.unpushedCommits) ||
        (value.unpushedCommits as number) < 0 ||
        !stringMap(value.config) ||
        !stringMap(value.remotes)
    ) {
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            "The Ignis Git server returned invalid repository state."
        );
    }
    if (value.merge !== undefined) mergeState(value.merge);
    return value as unknown as IgnisRepositoryState;
}

export async function ignisRequest(
    endpoint: string,
    vaultId: string,
    signal: AbortSignal,
    post = false,
    payload: IgnisMutationPayload = {}
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(
            `/api/ext/obsidian-git/${endpoint}${post ? "" : `${endpoint.includes("?") ? "&" : "?"}vaultId=${encodeURIComponent(vaultId)}`}`,
            {
                method: post ? "POST" : "GET",
                credentials: "same-origin",
                signal,
                headers: {
                    "X-Obsidian-Git": "1",
                    ...(post ? { "Content-Type": "application/json" } : {}),
                },
                body: post
                    ? JSON.stringify({ vaultId, ...payload })
                    : undefined,
            }
        );
    } catch (_error) {
        throw new IgnisGitError(
            signal.aborted ? "ABORTED" : "NETWORK",
            signal.aborted
                ? "The Ignis Git request timed out or was cancelled. Check repository state before retrying."
                : "Cannot reach the Ignis Git server."
        );
    }
    let value: unknown;
    try {
        value = await response.json();
    } catch (_error) {
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            `The Ignis Git server returned a non-JSON response (${response.status}). Verify that the integration is enabled.`
        );
    }
    if (!response.ok) {
        if (
            record(value) &&
            record(value.error) &&
            typeof value.error.code === "string" &&
            typeof value.error.message === "string"
        ) {
            throw new IgnisGitError(
                value.error.code,
                value.error.message,
                value.error.reportFile === "git_conflict.md"
                    ? value.error.reportFile
                    : undefined
            );
        }
        throw new IgnisGitError(
            "HTTP_ERROR",
            `The Ignis Git server rejected the request (${response.status}).`
        );
    }
    return value;
}

export function mergeState(value: unknown): MergeState {
    if (
        !record(value) ||
        !["none", "merge", "rebase", "cherry-pick", "other"].includes(
            String(value.operation)
        ) ||
        ![
            "clean",
            "diverged",
            "merge-conflicted",
            "merge-awaiting-commit",
            "rebase-or-other",
        ].includes(String(value.kind)) ||
        (value.head !== null && !validOid(value.head)) ||
        (value.mergeHead !== undefined && !validOid(value.mergeHead)) ||
        (value.upstream !== undefined &&
            (!record(value.upstream) ||
                !validOid(value.upstream.oid) ||
                typeof value.upstream.ref !== "string")) ||
        typeof value.canCommitMerge !== "boolean" ||
        typeof value.canAbortMerge !== "boolean" ||
        !Array.isArray(value.unresolvedPaths) ||
        !value.unresolvedPaths.every(
            (v: unknown) =>
                record(v) &&
                safePath(v.path) &&
                typeof v.kind === "string" &&
                Array.isArray(v.availableStages) &&
                v.availableStages.length > 0 &&
                v.availableStages.every((stage: unknown) =>
                    [1, 2, 3].includes(stage as number)
                )
        )
    )
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            "Invalid merge state. Refresh before continuing."
        );
    const merging = value.operation === "merge";
    const unresolved = value.unresolvedPaths.length > 0;
    if (
        (merging && (!value.head || !value.mergeHead)) ||
        (!merging && value.mergeHead !== undefined) ||
        value.canCommitMerge !== (merging && !unresolved) ||
        (value.canAbortMerge && !merging) ||
        (merging
            ? value.kind !==
              (unresolved ? "merge-conflicted" : "merge-awaiting-commit")
            : value.operation === "none"
              ? unresolved ||
                !["clean", "diverged"].includes(String(value.kind))
              : value.kind !== "rebase-or-other")
    )
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            "Inconsistent merge state. Refresh before continuing."
        );
    return value as unknown as MergeState;
}
function validOid(value: unknown): boolean {
    return (
        typeof value === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
    );
}
export function fileContent(value: unknown): FileContent {
    if (
        !record(value) ||
        !["text", "missing", "binary", "oversized", "unsupported"].includes(
            String(value.kind)
        ) ||
        (value.kind === "text" &&
            (typeof value.text !== "string" ||
                typeof value.hash !== "string" ||
                !/^[a-f0-9]{64}$/.test(value.hash)))
    )
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            "Invalid file snapshot returned by Ignis."
        );
    return value as unknown as FileContent;
}
export function conflictDetails(value: unknown): ConflictDetails {
    if (
        !record(value) ||
        !safePath(value.path) ||
        typeof value.kind !== "string" ||
        !Array.isArray(value.availableStages) ||
        !record(value.contents)
    )
        throw new IgnisGitError(
            "INVALID_RESPONSE",
            "Invalid conflict details returned by Ignis."
        );
    mergeState(value.merge);
    for (const source of ["base", "ours", "theirs", "worktree"])
        fileContent(value.contents[source]);
    return value as unknown as ConflictDetails;
}
