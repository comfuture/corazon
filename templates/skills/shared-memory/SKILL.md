---
name: shared-memory
description: Use this skill to retrieve and upsert shared long-term memory via Corazon memory APIs backed by mem0 + ChromaDB.
---

# Shared Memory

## When To Use

Use this skill whenever the agent should persist or retrieve durable context shared across all threads.

## Memory Backend

- Backend: Corazon memory API (`/api/memory/*`)
- Engine: `mem0ai/oss`
- Vector store: ChromaDB
- Shared scope: all conversation threads (default `userId` is shared)

## Script And Commands

Use `scripts/shared-memory.py`.
All command responses must be parsed as JSON.

This script is uvx-based and installs runtime dependencies automatically.

### Ensure Memory API

```bash
scripts/shared-memory.py ensure \
  --api-base-url "http://localhost:3000"
```

### Search Memory

```bash
scripts/shared-memory.py search \
  --api-base-url "http://localhost:3000" \
  --query "user preference related statement" \
  --limit 5
```

### Upsert Memory

```bash
scripts/shared-memory.py upsert \
  --api-base-url "http://localhost:3000" \
  --section "Preferences" \
  --text "The user prefers concise responses." \
  --threshold 0.62
```

## Required Workflow

1. Run `ensure` before memory read/write tasks in the current execution context.
2. Run `search` before writing when duplicate or near-duplicate risk exists.
3. Run `upsert` for writes. Do not bypass the API with direct file edits.
4. Prefer updating an existing near-duplicate memory over creating a new memory.
5. Loopback fallback (`localhost`, `127.0.0.1`, `::1`) is handled automatically by the script for local development.

## Write Policy

- Keep entries short, factual, and reusable.
- Never store secrets, credentials, tokens, or private keys.
- Avoid conversational noise; store stable memory only.
- If uncertain, store a qualified statement (for example: "User likely prefers...").

## Output Contract

- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`

## Scope Boundary

- This skill is an API wrapper only.
- Storage/index internals are implemented in core server memory utilities.
