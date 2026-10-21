const { GitServiceError, publicError } = require("./errors");

function mountRoutes(router, service, options) {
    const origins = new Set(
        options.origins ?? [options.origin].filter(Boolean)
    );
    router.use((req, res, next) => {
        let source = req.headers.origin;
        if (!source && req.method === "GET") {
            try {
                source = new URL(req.headers.referer).origin;
            } catch {
                /* no trusted browser source */
            }
        }
        if (!options.enabled || origins.size === 0)
            return res.status(503).json({
                error: {
                    code: "DISABLED",
                    message:
                        "Enable the Ignis Git plugin and configure WS_ORIGINS (or IGNIS_GIT_ORIGIN) with an explicit browser origin.",
                },
            });
        if (
            !origins.has(source) ||
            req.headers["x-obsidian-git"] !== "1" ||
            (req.method !== "GET" && !req.is("application/json"))
        ) {
            return res.status(403).json({
                error: {
                    code: "FORBIDDEN",
                    message:
                        "The Git request must originate from the configured Ignis browser.",
                },
            });
        }
        res.set("Cache-Control", "no-store");
        next();
    });
    const handle =
        (action, fields = []) =>
        async (req, res) => {
            try {
                const input = req.method === "GET" ? req.query : req.body;
                if (
                    !input ||
                    typeof input !== "object" ||
                    Array.isArray(input) ||
                    Object.keys(input).some(
                        (key) => !["vaultId", ...fields].includes(key)
                    )
                )
                    throw new GitServiceError(
                        "INVALID_REQUEST",
                        "Unexpected request fields.",
                        400
                    );
                const result = await action(input.vaultId, input);
                res.json(result);
            } catch (error) {
                const safe = publicError(error);
                res.status(safe.status).json({
                    error: {
                        code: safe.code,
                        message: safe.message,
                        reportFile: safe.reportFile,
                    },
                });
            }
        };
    for (const [route, method, fields] of [
        ["/merge-state", "mergeState", []],
        ["/diff", "fileDiff", ["path", "kind"]],
        ["/content", "fileContent", ["path", "source"]],
        ["/conflicts", "conflictDetails", ["path"]],
    ])
        router.get(
            route,
            handle((id, input) => service[method](id, input), fields)
        );
    for (const [route, action, fields] of [
        ["/merge", "start", ["expectedHead", "expectedUpstream", "confirmed"]],
        [
            "/mark-resolved",
            "resolve",
            [
                "path",
                "expectedHead",
                "expectedMergeHead",
                "expectedHash",
                "confirmed",
                "delete",
                "allowMarkers",
            ],
        ],
    ])
        router.post(
            route,
            handle(async (id, input) => {
                let result;
                try {
                    result = await service.mergeAction(id, action, input);
                } catch (error) {
                    try {
                        await options.reconcile(id);
                    } catch {
                        /* original mutation error remains authoritative */
                    }
                    throw error;
                }
                try {
                    await options.reconcile(id);
                } catch {
                    return {
                        ...result,
                        refreshWarning:
                            "Git state changed, but vault reconciliation failed. Use Ignis: Refresh vault from disk.",
                    };
                }
                return result;
            }, fields)
        );
    router.get(
        "/health",
        handle((id) => service.health(id))
    );
    router.get(
        "/state",
        handle((id) => service.state(id))
    );
    for (const operation of ["stage", "unstage", "stage-all", "unstage-all"]) {
        const field = operation.endsWith("-all") ? "dir" : "path";
        router.post(
            `/${operation}`,
            handle(
                (id, input) => service.mutateIndex(id, operation, input[field]),
                [field]
            )
        );
    }
    router.post(
        "/commit",
        handle(
            async (id, input) => {
                const result = await service.commit(id, input);
                try {
                    await options.reconcile(id);
                } catch {
                    return {
                        ...result,
                        refreshWarning:
                            "Commit completed, but vault reconciliation failed. Use Ignis: Refresh vault from disk.",
                    };
                }
                return result;
            },
            ["mode", "message", "amend", "autoStageOnEmptyIndex"]
        )
    );
    router.post(
        "/pull",
        handle(
            async (id, input) => {
                try {
                    const result = await service.pull(id, input);
                    if (
                        result.status === "updated" ||
                        result.status === "merge-pending"
                    ) {
                        try {
                            await options.reconcile(id);
                        } catch {
                            return {
                                ...result,
                                refreshWarning:
                                    "Pull changed repository state, but vault reconciliation failed. Use Ignis: Refresh vault from disk.",
                            };
                        }
                    }
                    return result;
                } catch (error) {
                    if (error.reportFile || error.reconcileVault) {
                        try {
                            await options.reconcile(id);
                        } catch {
                            /* preserve the original block error */
                        }
                    }
                    throw error;
                }
            },
            ["mergeOnDivergence"]
        )
    );
}
module.exports = { mountRoutes };
