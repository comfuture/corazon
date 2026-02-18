---
name: shared-memory
description: Use this skill when the agent should read or update shared long-term memory in CODEX_HOME/MEMORY.md using sectioned list items with deduplicated upserts.
---

# Shared Memory

## Overview

Use this skill to maintain shared memory across all threads in `MEMORY.md`.
This skill is file-based only and must not call embedding APIs.

## Memory File Rules

- Memory file path: `${CODEX_HOME}/MEMORY.md`.
- Shared by all threads.
- Default sections are:
  - `## Facts`
  - `## Preferences`
  - `## Decisions`
  - `## Tasks`
- Content is managed as list items (`- ...`) under sections.
- Missing sections may be created automatically.

## Command Workflow

Always execute commands in this order:

1. Ensure memory file and default sections exist.
2. Search existing items for overlap.
3. Upsert to update an existing item when similar enough; otherwise append.

Use the script at `scripts/shared-memory.mjs`.

### 1) Ensure

```bash
node scripts/shared-memory.mjs ensure --memory-file "${CODEX_HOME}/MEMORY.md"
```

### 2) Search

```bash
node scripts/shared-memory.mjs search \
  --memory-file "${CODEX_HOME}/MEMORY.md" \
  --query "user preference related statement" \
  --limit 5
```

### 3) Upsert

```bash
node scripts/shared-memory.mjs upsert \
  --memory-file "${CODEX_HOME}/MEMORY.md" \
  --section "Preferences" \
  --text "The user prefers concise responses." \
  --threshold 0.72
```

## Write Policy

- Prefer updates over new entries.
- Before writing, ensure and search first.
- Keep entries factual and concise.
- Do not duplicate near-identical items.
- Do not store secrets.

## Output Contract

All commands return JSON.

- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`

## Scope Boundary

- This skill implements only markdown memory management.
- Embedding/index providers are out of scope for now.
