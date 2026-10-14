#!/bin/sh
set -e

# Configure git identity if provided
if [ -n "$GIT_AUTHOR_NAME" ]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
fi

if [ -n "$GIT_AUTHOR_EMAIL" ]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
fi

# Optional: set committer too (recommended)
if [ -n "$GIT_COMMITTER_NAME" ]; then
  git config --global user.name "$GIT_COMMITTER_NAME"
fi

if [ -n "$GIT_COMMITTER_EMAIL" ]; then
  git config --global user.email "$GIT_COMMITTER_EMAIL"
fi

# Debug (optional)
# git config --global --list

# Initialize the local git for ai agent
if [ ! -d .git ]; then
    git init
fi

# Run main container command (the CMD in the Dockerfile)
exec "$@"