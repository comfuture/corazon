# Dependency Security Audit Policy

This policy defines how Corazon handles dependency vulnerabilities detected by `pnpm audit`.

## Signal Source

- Command: `pnpm run security:audit`
- CI workflow: `.github/workflows/security-audit.yml`
- Triggers:
  - Scheduled run (daily, UTC)
  - Manual `workflow_dispatch`

## Threshold

- The audit command uses `--audit-level=high`.
- CI fails when at least one `high` or `critical` vulnerability is present.

## Triage Rules

1. `critical` and `high` findings are treated as immediate remediation candidates.
2. Findings that require breaking upgrades should be split into scoped follow-up issues with clear ownership and rollout steps.
3. Temporary risk acceptance must be explicitly documented in an issue with:
   - rationale
   - compensating controls (if any)
   - expiry/review date

## Follow-up Loop

1. Run `pnpm run security:audit` locally or via manual workflow dispatch.
2. If CI fails, inspect vulnerable package paths and identify upgrade-safe candidates first.
3. Ship fixes in small PR batches grouped by package domain.
4. Link remediation PRs back to the tracking issue.
