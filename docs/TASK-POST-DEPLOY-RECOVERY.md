# Post-Deploy Recovery Task (Non-Agent Path)

Issue: `#63`

## Goal
Provide an out-of-band recovery check path that still runs when the normal agent loop is degraded.

## What this adds
- `scripts/post-deploy-recovery.mjs`
  - Runs non-agent HTTP probes:
    - `GET /api/workflows`
    - `GET /api/memory/health`
    - `GET /api/settings/mcp`
    - `GET /api/chat/workdir`
    - `GET /api/chat/threads?limit=1` (non-critical signal)
  - Runs local runtime checks:
    - runtime root existence
    - `config.toml`
    - `workflow-data`
    - `threads`
    - `auth.json` (optional signal)
  - Builds a recovery report with:
    - detected symptoms
    - suspected root cause
    - confidence
    - proposed actions
    - actions attempted
    - rollback recommendation

## Safety model
- Default mode is read-only diagnostics.
- Optional `--apply-safe-fixes` only bootstraps missing required directories (`workflow-data`, `threads`) under runtime root.
- Optional `--probe-agent` can test `/api/chat` stream acceptance, but is disabled by default to avoid unnecessary runtime side effects.

## Usage
```bash
pnpm recovery:post-deploy
pnpm recovery:post-deploy --json
pnpm recovery:post-deploy --base-url http://127.0.0.1:3000 --runtime-root /root/.corazon
pnpm recovery:post-deploy --apply-safe-fixes
```

## Completion status for issue scope
- Distinguishes shallow service availability from non-agent functional health.
- Produces a concrete recovery plan format and rollback guidance.
- Supports an explicit non-agent execution path for post-deploy triage.

## Follow-up candidates
- Add deploy pipeline hook to run this task immediately after rollout.
- Add regression tests around classification thresholds and failure mapping.
- Add optional operator alert integration when status is `down` or repeated `degraded`.
