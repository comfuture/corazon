---
name: manage-workflows
description: Manage Corazon workflow definitions in the current workspace with deterministic scripts for list/create/update/delete operations. Use for any workflow-management request in Korean or English, including listing or inspecting current workflows, checking running or active workflows, filtering by schedule frequency such as daily or weekly runs, creating new scheduled automations from natural language, updating trigger/instruction/skills, and deleting workflows by name or intent.
---

# Manage Workflows

Use this skill to manage `workflows/*.md` directly from the Corazon workspace root.
For natural-language requests, delegate intent/trigger/skill selection to the LLM via `from-text` or `apply-text` instead of ad-hoc regex parsing.

## Script

Run `scripts/manage-workflows.mjs`.  
All command outputs are JSON.

```bash
node scripts/manage-workflows.mjs help
```

## Required Workflow

1. Resolve workspace root (default: current working directory, or pass `--root`).
2. If user input is natural language, run `from-text` first to verify intent.
3. Execute one of `list`, `create`, `update`, `delete`, or `apply-text`.
4. If `--query` matches multiple workflows, refine query or switch to `--slug`.
5. For recurring weekly/monthly schedules, prefer `rrule` over cron.
6. Return command JSON results without rewriting fields manually.

## Commands

### List

```bash
node scripts/manage-workflows.mjs list --root /path/to/corazon --running-only
```

### Create

```bash
node scripts/manage-workflows.mjs create \
  --root /path/to/corazon \
  --instruction "Summarize top news and send to Telegram." \
  --name "News Summary Telegram" \
  --rrule "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" \
  --workflow-dispatch true \
  --skills "shared-memory"
```

Natural-language creation:

```bash
node scripts/manage-workflows.mjs apply-text \
  --root /path/to/corazon \
  --text "매일 아침 9시에 주요 뉴스 요약해서 텔레그램으로 보내줘"
```

### Update

```bash
node scripts/manage-workflows.mjs update \
  --root /path/to/corazon \
  --slug news-summary-telegram \
  --rrule "FREQ=DAILY;BYHOUR=10;BYMINUTE=0" \
  --workflow-dispatch true
```

### Delete

```bash
node scripts/manage-workflows.mjs delete \
  --root /path/to/corazon \
  --query "고양이 사진에 좋아요 표시"
```

Natural-language deletion:

```bash
node scripts/manage-workflows.mjs apply-text \
  --root /path/to/corazon \
  --text "고양이 사진에 좋아요 표시하는 워크플로우 삭제해줘"
```

### Parse Only

```bash
node scripts/manage-workflows.mjs from-text --text "동작중인 워크플로우가 뭐뭐 있지?"
```

## Natural Language Coverage

`apply-text` and `from-text` use structured LLM output for:

- Schedule creation: `매일 아침 9시에 ...`
- Weekly schedule creation: `매주 금요일 저녁 5시에 ...`
- Interval creation: `1시간 마다 ...`
- Deletion by intent query: `... 워크플로우 삭제해줘`
- Active/running list query: `동작중인 워크플로우가 뭐뭐 있지?`

## Output Contract

- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
