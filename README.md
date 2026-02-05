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

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

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

Prepare a runtime root (copies Codex config without logs/sessions/tmp):

```bash
npx corazon setup --runtime-root ./.corazon
```

Build and run with Docker Compose:

```bash
docker compose up --build
```

Or build and run with Docker directly:

```bash
docker build -t corazon .
docker run --rm -p 3000:3000 \
  -v "$(pwd)/.corazon:/root/.corazon" \
  corazon
```

Notes:
- The runtime root (e.g. `./.corazon`) should contain `.codex`, `data/`, and `threads/`.
- If you want a different runtime root, run `npx corazon setup --runtime-root /path/to/root` and mount it to `/root/.corazon` (or set `CORAZON_ROOT_DIR`).

## Data & storage

- SQLite database: `${CORAZON_ROOT_DIR}/data/codex.sqlite` (default: `~/.corazon/data/codex.sqlite`)
- Thread working directories: `${CORAZON_ROOT_DIR}/threads/{threadId}` (default: `~/.corazon/threads/{threadId}`)
- Attachments are stored under each thread’s `attachments/` directory.

## TODO

- [x] Core features built with Codex SDK, Vercel AI, and Nuxt UI
- [x] Thread persistence, titles, and usage stats
- [x] Per-thread working directories and attachments
- [x] Thread browsing/resume UX
- [ ] Login & OAuth
- [ ] Multi-user support
- [ ] Multi-project workspaces
- [ ] Isolated shell and code interpreter
