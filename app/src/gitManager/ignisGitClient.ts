import { IgnisGitError } from "src/platform/ignis";
import type { BranchInfo, FileStatusResult, Status } from "src/types";

export interface IgnisRepositoryState {
    status: Status;
    branch: BranchInfo;
    mergeInProgress: boolean;
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
    { path?: string; dir?: string } | IgnisCommitRequest;

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
        !value.split("/").some((p) => p === ".." || p === ".")
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
            `/api/ext/obsidian-git/${endpoint}${post ? "" : `?vaultId=${encodeURIComponent(vaultId)}`}`,
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
