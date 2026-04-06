# Corazon

Corazon (Corazón) means “heart” in Spanish. This project is a web-first Codex workspace that aims to feel like a calm, persistent place to think, iterate, and ship — not just a chat box.

![Corazon screenshot](docs/screenshot-chat.png)

## What this does

- Web UI for running Codex with streaming chat.
- Thread persistence, titles, and usage stats.
- Per-thread working directories and attachments.
- Dashboard UX for browsing and resuming threads.

## Prerequisites

- Node.js 22+
- A package manager (pnpm recommended). If you use pnpm, allow native builds for `better-sqlite3`.
- Codex CLI access (ChatGPT subscription **or** API key, per your Codex setup)
- Optional: `mise` if you want the repo-managed Python 3.12 + `uv` toolchain locally

## Setup

```bash
pnpm install
```

If you use `mise`, install the repo-managed Python 3.12 + `uv` toolchain from the Docker config file first:

```bash
MISE_CONFIG_FILE=./docker/mise.toml mise install
```

## Development

```bash
pnpm dev
```

Optional runtime mode:
- `CORAZON_CODEX_CLIENT_MODE=app-server` (default)
- `CORAZON_CODEX_CLIENT_MODE=sdk` (fallback)

The app runs at:

```text
http://localhost:3000
```

## Production

```bash
pnpm build
pnpm preview
```

### Docker (production)

Prepare a host state root. Compose will bind-mount role-specific subdirectories from that root:

```bash
export CORAZON_HOST_STATE_DIR="$(pwd)/.docker-state"
export CORAZON_CODEX_HOST_DIR="$HOME/.codex"
export CORAZON_AUTH_SEED_MODE=copy-once
mkdir -p "$CORAZON_HOST_STATE_DIR"/{.corazon,.corazon-runtime,.ssh,chroma}
npx corazon setup \
  --agent-home "$CORAZON_HOST_STATE_DIR/.corazon" \
  --app-runtime-root "$CORAZON_HOST_STATE_DIR/.corazon-runtime" \
  --codex-home "$CORAZON_CODEX_HOST_DIR"
```

If you use Git over SSH, persist your SSH keys and `known_hosts` as well:

```bash
cp -R "$HOME/.ssh/." "$CORAZON_HOST_STATE_DIR/.ssh/"
chmod 700 "$CORAZON_HOST_STATE_DIR/.ssh"
```

Build and run with Docker Compose:

```bash
docker compose up --build
```

For ChatGPT-managed Codex auth on a headless server, keep `auth.json` on the writable agent-home bind mount and seed it only once from `${CORAZON_CODEX_HOST_DIR}`. With `CORAZON_AUTH_SEED_MODE=copy-once`, Corazon materializes `${CORAZON_HOST_STATE_DIR}/.corazon/auth.json` as a normal file so Codex can rotate refreshed tokens in place across restarts. The compose file also enables a periodic app-server keepalive that refreshes managed auth before it goes stale.

The production image also installs Python 3.12 and `uv` via `mise`, so runtime-managed skills can rely on `python`, `python3`, `uv`, and `uvx` inside the container.

Or build and run with Docker directly:

```bash
docker build -t corazon .
docker run --rm -p 3000:3000 \
  -v "$CORAZON_HOST_STATE_DIR/.corazon:/root/.corazon" \
  -v "$CORAZON_HOST_STATE_DIR/.corazon-runtime:/root/.corazon-runtime" \
  -v "$CORAZON_HOST_STATE_DIR/.ssh:/root/.ssh" \
  -v "$CORAZON_CODEX_HOST_DIR:/root/.codex-seed:ro" \
  corazon
```

Notes:
- `${CORAZON_HOST_STATE_DIR}` contains Corazon agent home (`.corazon/`), app runtime workspaces (`.corazon-runtime/`), SSH material (`.ssh/`), and Chroma persistence (`chroma/`).
- `${CORAZON_CODEX_HOST_DIR}` points to the host Codex home mounted read-only at `/root/.codex-seed`. By default, Compose uses `${HOME}/.codex`.
- The agent home (for example `${CORAZON_HOST_STATE_DIR}/.corazon`) should contain `config.toml`, `skills/`, `data/`, and Corazon-managed config/auth state.
- The app runtime root (for example `${CORAZON_HOST_STATE_DIR}/.corazon-runtime`) should contain `threads/` and `workflow-data/`.
- GitHub CLI (`gh`) is installed in the image, and entrypoint wiring persists `gh` auth/config under `${CORAZON_HOST_STATE_DIR}/.corazon/gh` via `/root/.config/gh`.
- Entrypoint wiring also persists `/root/.gitconfig` under `${CORAZON_HOST_STATE_DIR}/.corazon/gitconfig`, so `gh auth setup-git` survives redeploys.
- Keep the host Codex home available when you want `auth.json` and other seed files to survive redeploys.
- Workflow local metadata is stored at `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/workflow-data`).

## Data & storage

- SQLite database: `${CORAZON_ROOT_DIR}/data/codex.sqlite` (default: `~/.corazon/data/codex.sqlite`)
- Agent home / Codex state: `${CORAZON_ROOT_DIR}` (default: `~/.corazon`)
- App runtime root: `${CORAZON_RUNTIME_ROOT_DIR}` (default: sibling `~/.corazon-runtime` or platform equivalent)
- Thread working directories: `${CORAZON_THREADS_DIR}/{threadId}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/threads/{threadId}`)
- Attachments are stored under each thread’s `attachments/` directory.
- Workflow local metadata: `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/workflow-data`)

## TODO

- [x] Core features built with Codex SDK, Vercel AI, and Nuxt UI
- [x] Thread persistence, titles, and usage stats
- [x] Per-thread working directories and attachments
- [x] Thread browsing/resume UX
- [ ] Login & OAuth
- [ ] Multi-user support
- [ ] Multi-project workspaces
- [ ] Isolated shell and code interpreter
