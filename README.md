# Corazon

Corazon (Corazón) means “heart” in Spanish. This project is a web-first Codex workspace that aims to feel like a calm, persistent place to think, iterate, and ship — not just a chat box.

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

## Data & storage

- SQLite database: `.data/codex.sqlite`
- Thread working directories:
  - macOS: `~/Library/Application Support/Corazon/threads/{threadId}`
  - Linux: `~/.corazon/threads/{threadId}`
  - Windows: `%APPDATA%/Corazon/threads/{threadId}` (fallbacks to `%LOCALAPPDATA%`)
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
