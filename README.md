# Kandev Sandbox Starter Pack 

This repo is containes a dev container setup with Codex. The goal is to keep Codex’s actions **inside `./app` folder**, not across your whole device. 

Specifically, this branch is meant when you want to have `.git` in the `./app` folder, but which won't be connected to a remote. There is another `.git` in the root of the repo, which is connected to a remote. This way, you can have a "sandbox" for Codex to experiment with Git without affecting your main repo.

---
## What is where?

- `docker-compose.yaml` - defines a single service `dev` where Codex lives. It mounts the `app` folder into the container as `/workspace` (read/write).
- `.devcontainer/` - contains the Dockerfile and devcontainer.json for `dev` service.
- `app/` - the folder that is mounted into the container. This is where you can put your code and data. Anything outside this folder will not be accessible to Codex.
- `.codex/` - contains the Codex config template. The dev container copies it to `~/.codex/` inside the container.
  >Note: This config is for standalone Codex usage.
- `agents/` - contains different agent configurations and profiles. The dev container copies it to `~/agents/` inside the container.


---
## Initial setup

1) Build the container with `docker compose build --no-cache`.
2) Run the container with `docker compose up -d`.
3) Connect to the container with `docker exec -it <CONTAINER_NAME> /bin/bash`. You can find the `<CONTAINER_NAME>` by running `docker ps` in a terminal.
   
   ---
   ### Inside the container setup
4) Run `codex` to authenticate and set up Codex.

---
## Git Access
There are two Git repos in this project. The main one leaves in `./.git`. It has the full access to the whole project and the remote origin. The second one is a "sandbox" repo that lives in `./app/.git`. It tracks only the `app` folder and has no remote origin. This means that if Codex is configured to only have access to the `app` folder, it can only interact with the sandbox repo, not the main repo.

Why this matters (especially with AI coding assistants):

- The ai agent can experiment, commit and do whatever it wants with the git history of the "sandboxed" `app/.git` repo.
- The main `./.git` repo remains clean and stable, and you have full control over the history that would ultimately be pushed to the remote origin.

## Useful commands for working with this template

- Rebuild container after changes to Dockerfile or config: `docker compose build <service> --no-cache`
  If the `<service>` is ommitted, it will rebuild all services.

- Stop the container without deleting data: `docker compose stop <service>`
  If the `<service>` is ommitted, it will stop all services.

- Start the container again: `docker compose start <service>`
  If the `<service>` is ommitted, it will start all services.

- Stop and remove the container (deletes all data): `docker compose down <service>`
  If the `<service>` is ommitted, it will stop and remove all services.

- Start the container: `docker compose up <service>`
  If the `<service>` is ommitted, it will rebuild and restart all services.

- Connect to the container with: `docker exec -it <CONTAINER_NAME> /bin/bash`. You can find the `<CONTAINER_NAME>` by running `docker ps` in a terminal.
  - To connect as the `root` user, add `-u root` to the command above.

- Restart the container: `docker compose restart <service>`
  If the `<service>` is ommitted, it will restart all services.