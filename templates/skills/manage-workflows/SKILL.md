---
name: manage-workflows
description: Manage Corazon workflow definitions in the current workspace. Prefer direct file editing (workflows/*.md) with strict frontmatter/instruction rules; use the Python helper script only when deterministic bulk operations are needed.
---

# Manage Workflows

Use this skill to manage Corazon workflow files in `workflows/*.md`.

## Priority
1. Default: edit workflow files directly (without scripts).
2. Optional: run `scripts/manage-workflows.py` when deterministic CLI automation is necessary.
3. Do not use OS-level schedulers (`crontab`, `systemd`, `launchd`) for Corazon workflows.

## Workflow File Format
Each workflow file must be Markdown with YAML frontmatter.

```md
---
name: Hello Workflow
description: Prints exactly one configured greeting line on each run.
on:
  interval: 2m
  workflow-dispatch: true
skills:
  - shared-memory
---
On each run, output exactly one assistant message: "Hello".
```

## Frontmatter Rules
- `name`: English 2~3 words only. Example: `Hello Workflow`, `Daily Report Sender`.
- `description`: one-sentence summary of actual behavior.
- `on`: trigger config
  - `schedule`: 5-field cron
  - `interval`: `{number}{s|m|h}` such as `120s`, `60m`, `2h`
  - `rrule`: RFC5545 RRULE
  - `workflow-dispatch`: boolean
- `skills`: list of skill names.
- Use only one time trigger at a time (`schedule`, `interval`, or `rrule`).
- If no time trigger is configured, `workflow-dispatch: true` is required.

## Instruction Writing Principles
- Do not write meta instructions such as "create/update a workflow"; write the **actual run-time behavior**.
- Keep schedule/interval settings in `on`; do not duplicate timing details in the instruction body.
- State output format, completion criteria, and prohibitions explicitly.
- Prefer the user's language for generated `description` and `instruction` content unless the user requests a different language.

Good:
- `On each run, output exactly one assistant message: "Hello".`

Bad:
- `Create a workflow that says hello every 2 minutes.`

## Scriptless Recommended Flow
1. Find the target file in the `workflows/` directory.
2. Edit frontmatter and instruction directly according to the rules.
3. Validate file correctness (name/trigger/instruction) after saving.
4. Use the `/workflows` UI to inspect execution and run history when needed.

## Optional Python Script
When CLI automation is needed, use:

```bash
scripts/manage-workflows.py
```

This script is uv-compatible and self-contained via shebang + inline metadata:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6.0.2"]
# ///
```

### Examples

```bash
scripts/manage-workflows.py list --root /path/to/corazon --running-only
```

```bash
scripts/manage-workflows.py create \
  --root /path/to/corazon \
  --instruction "On each run, output exactly one assistant message: \"Hello\"." \
  --name "Hello Workflow" \
  --interval "2m" \
  --workflow-dispatch true
```

```bash
scripts/manage-workflows.py update \
  --root /path/to/corazon \
  --slug hello-workflow \
  --rrule "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
```

```bash
scripts/manage-workflows.py apply-text \
  --root /path/to/corazon \
  --text "Create a workflow that outputs one 'Hello' line every minute."
```

## Output Contract (Script)
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
