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

## Deploy integration status (Issue `#65`)
- `.github/workflows/deploy.yml` runs `pnpm recovery:post-deploy --json` after each `main` rollout.
- Recovery execution uses `docker --context production compose exec` from the runner, so it does not depend on a remote `/home/ubuntu/corazon` checkout.
- Recovery JSON is uploaded as a workflow artifact (`post-deploy-recovery-<run_id>`).
- Gate policy is enforced via `scripts/evaluate-post-deploy-recovery.mjs`:
  - `down` => deployment workflow fails.
  - repeated `degraded` (previous run also `degraded`) => warning + operator follow-up required.
  - single `degraded` => warning (non-blocking), continue with monitoring.
- Last recovery status is persisted on deploy host at `/home/ubuntu/.corazon/post-deploy-recovery-last-status.txt` only when the recovery gate emits a non-empty status.

## Manual dry-run / test path
- The deploy workflow supports manual dispatch input `post_deploy_check_only=true`.
- In this mode, build/deploy steps are skipped and only the recovery hook + gate evaluation run against the current production container.
- Check-only dispatch runs in an isolated workflow concurrency group and no longer cancels in-flight production deploy runs.
- This provides a no-rollout validation path for the recovery integration.
