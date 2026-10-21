const { GitService } = require("./git-service");
const { mountRoutes } = require("./routes");
const { routeOptions } = require("./configuration");
module.exports = {
    id: "obsidian-git",
    name: "Obsidian Git (Pull, staging, Commit and conflicts)",
    description:
        "Native Git Pull, diffs, staging, manual merges and commits for the Obsidian Git browser backend",
    async register(ctx) {
        const { writeCoalescer } = require("@ignis/server-core");
        this.service = new GitService(ctx, {
            pendingWrites: () => writeCoalescer.pendingPaths(),
        });
        const cache = require("../../cache");
        mountRoutes(ctx.router, this.service, {
            ...routeOptions(),
            reconcile: (id) =>
                cache.reconcileVault(id, { includeIgnored: true }),
        });
    },
    async shutdown() {
        this.service?.shutdown();
    },
};
