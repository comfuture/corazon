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

Use `scripts/shared-memory.mjs`.
All command responses must be parsed as JSON.

### Ensure Memory API

```bash
node scripts/shared-memory.mjs ensure \
  --api-base-url "http://127.0.0.1:3000"
```

### Search Memory

```bash
node scripts/shared-memory.mjs search \
  --api-base-url "http://127.0.0.1:3000" \
  --query "user preference related statement" \
  --limit 5
```

### Upsert Memory

```bash
node scripts/shared-memory.mjs upsert \
  --api-base-url "http://127.0.0.1:3000" \
  --section "Preferences" \
  --text "The user prefers concise responses." \
  --threshold 0.62
```

## Required Workflow

1. Run `ensure` before memory read/write tasks in the current execution context.
2. Run `search` before writing when duplicate or near-duplicate risk exists.
3. Run `upsert` for writes. Do not bypass the API with direct file edits.
4. Prefer updating an existing near-duplicate memory over creating a new memory.

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
