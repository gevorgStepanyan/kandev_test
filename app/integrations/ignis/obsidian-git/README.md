# Server installation with the existing Ignis Compose setup

The reference `ignis/example-ignis-docker-compose.yaml` already configures
`GIT_REPO`, `GIT_VAULT`, `GIT_BRANCH`, and author identity. Its custom entrypoint
initializes the repository and exports `GIT_SSH_COMMAND` using `/git-ssh/`.
Keep that setup: this backend inherits its SSH command and reads the existing
repository's upstream. It does not clone repositories or configure branches or
authors. No second SSH mount or duplicate repository variables are needed.

Copy this entire directory, including `configuration.js` and `package.json`,
to `/opt/ignis/git-backend/obsidian-git` on the server. Add the following entries
to the existing Ignis service, preserving its other environment and volume entries:

```yaml
environment:
    WS_ORIGINS: "https://obsidian.example.com"
volumes:
    - /opt/ignis/git-backend/obsidian-git:/app/apps/ignis-server/server/plugins/obsidian-git:ro
```

Use the exact browser origin, including scheme and port when applicable, without
a trailing slash. `WS_ORIGINS` is Ignis's existing comma-separated origin allowlist;
the backend reuses it. The reference Compose file does not currently set it.
If already configured, keep its existing value. An empty list disables Git routes.

Recreate the existing service to apply its environment and mount:

```sh
docker compose -f example-ignis-docker-compose.yaml up -d --build ignis
```

Enable **Obsidian Git (Pull, staging and Commit)** for `Main` through Ignis's server-plugin
settings. That per-vault setting controls backend enablement; an additional
`IGNIS_GIT_ENABLED=true` is unnecessary. The plugin uses Ignis's configured vault
root and enabled-vault list, rather than treating `GIT_VAULT` as authorization.

Optional legacy overrides: `IGNIS_GIT_ENABLED=false` disables routes globally;
`IGNIS_GIT_ORIGIN` overrides the shared origin list when a separate Git allowlist
is desired. Existing deployments using `IGNIS_GIT_ENABLED=true` continue to work.

The reference image already installs Git and OpenSSH. The host vault mount
`/mnt/ssd/obsidian:/vaults` places `Main` at `/vaults/Main` in the container.
No browser plugin artifacts or remote SSH connection are required for this test:

```sh
ORIGIN='https://obsidian.example.com'
curl --fail-with-body -i --get \
  "$ORIGIN/api/ext/obsidian-git/health" \
  --data-urlencode 'vaultId=Main' \
  -H "Origin: $ORIGIN" \
  -H 'X-Obsidian-Git: 1'
```

A valid repository returns HTTP 200 with `{"requirements":"valid"}`.
This checks local Git prerequisites; it does not fetch or pull from the remote.

## Manual Commit

See [COMMIT.md](COMMIT.md) for the commit endpoint, modes, identity/ownership
configuration, protected-index policy, authentication boundary, and exact build/
reload steps. See [TESTING_commit.md](../../../TESTING_commit.md) for generated
tests and manual deployment-server commands. Tests were intentionally not run
locally. Existing mounts, origins and vault enablement continue to apply.
