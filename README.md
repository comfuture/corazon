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

If you use `mise`, install the repo-managed Python 3.12 + `uv` toolchain first:

```bash
mise install
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
mkdir -p "$CORAZON_HOST_STATE_DIR"/{.corazon,.ssh,chroma}
npx corazon setup \
  --runtime-root "$CORAZON_HOST_STATE_DIR/.corazon" \
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

The production image also installs Python 3.12 and `uv` via `mise`, so runtime-managed skills can rely on `python`, `python3`, `uv`, and `uvx` inside the container.

Or build and run with Docker directly:

```bash
docker build -t corazon .
docker run --rm -p 3000:3000 \
  -v "$CORAZON_HOST_STATE_DIR/.corazon:/root/.corazon" \
  -v "$CORAZON_HOST_STATE_DIR/.ssh:/root/.ssh" \
  -v "$CORAZON_CODEX_HOST_DIR:/root/.codex-seed:ro" \
  corazon
```

Notes:
- `${CORAZON_HOST_STATE_DIR}` contains Corazon runtime state (`.corazon/`), SSH material (`.ssh/`), and Chroma persistence (`chroma/`).
- `${CORAZON_CODEX_HOST_DIR}` points to the host Codex home mounted read-only at `/root/.codex-seed`. By default, Compose uses `${HOME}/.codex`.
- The runtime root (for example `${CORAZON_HOST_STATE_DIR}/.corazon`) should contain `config.toml`, `skills/`, `data/`, and `threads/`.
- Keep the host Codex home available when you want `auth.json` and other seed files to survive redeploys.
- Workflow local metadata is stored at `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_ROOT_DIR}/workflow-data`).

## Data & storage

- SQLite database: `${CORAZON_ROOT_DIR}/data/codex.sqlite` (default: `~/.corazon/data/codex.sqlite`)
- Thread working directories: `${CORAZON_ROOT_DIR}/threads/{threadId}` (default: `~/.corazon/threads/{threadId}`)
- Attachments are stored under each thread’s `attachments/` directory.
- Workflow local metadata: `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_ROOT_DIR}/workflow-data`)

## TODO

- [x] Core features built with Codex SDK, Vercel AI, and Nuxt UI
- [x] Thread persistence, titles, and usage stats
- [x] Per-thread working directories and attachments
- [x] Thread browsing/resume UX
- [ ] Login & OAuth
- [ ] Multi-user support
- [ ] Multi-project workspaces
- [ ] Isolated shell and code interpreter
