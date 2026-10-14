FROM node:24-slim AS node

# A small Linux environment with Python pre-installed.
# Using an official Python image keeps setup simple for beginners.
FROM python:3.12-slim

COPY --from=node /usr/local/ /usr/local/

# Install a few basics (git for cloning repos, curl for downloads).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    bubblewrap \
    curl \
    bash \
    npm \
    git \
    ripgrep \
    procps \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex kandev@latest

COPY ./.devcontainer/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create a non-admin user (so accidental "system-level" changes are harder).
RUN useradd -m -s /bin/bash agent
USER agent

COPY .codex /tmp/.codex
RUN mkdir -p $HOME/.codex && cp -rn /tmp/.codex/* $HOME/.codex/
WORKDIR /workspace

COPY agents /tmp/agents
RUN mkdir -p $HOME/agents && cp -rn /tmp/agents/* $HOME/agents/

ENTRYPOINT ["/entrypoint.sh"]