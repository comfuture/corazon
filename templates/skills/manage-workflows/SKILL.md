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
description: 실행 시마다 지정된 인사 메시지를 한 줄로 출력합니다.
on:
  interval: 2m
  workflow-dispatch: true
skills:
  - shared-memory
---
각 실행에서 assistant 메시지로 정확히 "안녕하세요" 한 줄만 출력한다.
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
- Time trigger(`schedule/interval/rrule`)는 동시에 하나만 사용.
- 시간 트리거가 없다면 `workflow-dispatch: true`가 필요.

## Instruction Writing Principles
- "워크플로우를 생성/수정" 같은 메타 지시를 쓰지 말고, **실행 시 실제 수행 작업**을 작성.
- 스케줄/주기 정보는 `on`에 두고 instruction 본문에는 넣지 않음.
- 출력 형식, 완료 조건, 금지사항을 명확히 작성.

Good:
- `각 실행에서 assistant 메시지로 정확히 "안녕하세요" 한 줄만 출력한다.`

Bad:
- `2분마다 안녕하세요를 말하는 워크플로우를 만들어라.`

## Scriptless Recommended Flow
1. `workflows/` 디렉토리에서 대상 파일을 찾음.
2. 파일 frontmatter와 instruction을 규칙에 맞게 직접 수정.
3. 저장 후 파일 유효성(이름/트리거/instruction) 점검.
4. 필요 시 `/workflows` UI에서 실행/이력 확인.

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
# dependencies = []
# ///
```

### Examples

```bash
scripts/manage-workflows.py list --root /path/to/corazon --running-only
```

```bash
scripts/manage-workflows.py create \
  --root /path/to/corazon \
  --instruction "각 실행에서 assistant 메시지로 정확히 \"안녕하세요\" 한 줄만 출력한다." \
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
  --text "매 1분마다 안녕하세요 한 줄 출력하는 워크플로우를 만들어줘"
```

## Output Contract (Script)
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
