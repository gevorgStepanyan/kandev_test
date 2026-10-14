# Build Ignis unchanged first, then add only the Git pilot integration.
ARG IGNIS_BASE_IMAGE=ignis-base:pilot
FROM ${IGNIS_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY obsidian-git/ /app/apps/ignis-server/server/plugins/obsidian-git/
# Inherit Ignis's original entrypoint, which selects the PUID/PGID runtime user.
