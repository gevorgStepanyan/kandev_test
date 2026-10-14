// Reuse Ignis's origin allowlist and per-vault plugin enablement. The legacy
// Git-specific variables remain optional overrides for existing installations.
function routeOptions(env = process.env) {
    return {
        enabled: env.IGNIS_GIT_ENABLED !== "false",
        origins: (env.IGNIS_GIT_ORIGIN || env.WS_ORIGINS || "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
    };
}

module.exports = { routeOptions };
