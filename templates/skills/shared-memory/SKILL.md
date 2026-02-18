---
name: shared-memory
description: Use this skill to read and update shared long-term memory in CODEX_HOME/MEMORY.md using sectioned markdown list items with deduplicated upserts.
---

# Shared Memory

## When To Use

Use this skill whenever the agent should persist or retrieve durable context shared across all threads.

## Memory Source

- File path: `${CODEX_HOME}/MEMORY.md`
- Shared scope: all conversation threads
- Storage model: section headers (`## Section`) with one-depth list items (`- item` or `* item`)
- Default sections:
  - `## Facts`
  - `## Preferences`
  - `## Decisions`
  - `## Tasks`

## Script And Commands

Use `scripts/shared-memory.mjs`.
All command responses must be parsed as JSON.

### Ensure Memory File

```bash
node scripts/shared-memory.mjs ensure --memory-file "${CODEX_HOME}/MEMORY.md"
```

### Search Memory

```bash
node scripts/shared-memory.mjs search \
  --memory-file "${CODEX_HOME}/MEMORY.md" \
  --query "user preference related statement" \
  --limit 5
```

### Upsert Memory

```bash
node scripts/shared-memory.mjs upsert \
  --memory-file "${CODEX_HOME}/MEMORY.md" \
  --section "Preferences" \
  --text "The user prefers concise responses." \
  --threshold 0.72
```

## Required Workflow

1. Run `ensure` before any read/write.
2. Run `search` before writing when you need explicit evidence of potential duplicates.
3. Run `upsert` for writes. Do not append directly.
4. Prefer updating an existing near-duplicate memory over adding a new item.
5. Create a missing section only when necessary for the new memory.

## Write Policy

- Keep entries short, factual, and reusable.
- Never store secrets, credentials, tokens, or private keys.
- Avoid conversational noise; store stable memory only.
- If memory is uncertain, write a qualified statement (for example: "User likely prefers...").

## Output Contract

- Success shape: `{ "ok": true, ... }`
- Error shape: `{ "ok": false, "error": "..." }`

## Scope Boundary

- This skill is markdown memory only.
- Embedding providers and vector retrieval are not implemented in this skill.
