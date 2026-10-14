const { GitService } = require("./git-service");
const { mountRoutes } = require("./routes");
const { routeOptions } = require("./configuration");
module.exports = {
    id: "obsidian-git",
    name: "Obsidian Git (pull-only pilot)",
    description:
        "Native fast-forward-only pulls for the Obsidian Git browser backend",
    async register(ctx) {
        this.service = new GitService(ctx);
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
