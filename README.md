# Corazon

Corazon (Corazón) means “heart” in Spanish. This project is a web-first Codex workspace that aims to feel like a calm, persistent place to think, iterate, and ship — not just a chat box.

![Corazon screenshot](docs/screenshot-chat.png)

## What this does

- Web UI for running Codex with streaming chat.
- Thread persistence, titles, and usage stats.
- Per-thread working directories and attachments.
- Dashboard UX for browsing and resuming threads.

## Prerequisites

- Node.js 22+
- A package manager (pnpm recommended). If you use pnpm, allow native builds for `better-sqlite3`.
- Codex CLI access (ChatGPT subscription **or** API key, per your Codex setup)
- Optional: `mise` if you want the repo-managed Python 3.12 + `uv` toolchain locally

## Setup

```bash
pnpm install
```

If you use `mise`, install the repo-managed Python 3.12 + `uv` toolchain from the Docker config file first:

```bash
MISE_CONFIG_FILE=./docker/mise.toml mise install
```

## Development

```bash
pnpm dev
```

Lease ownership regression check (Telegram poller safety):

```bash
pnpm telegram:lease:smoke
```

Optional runtime mode:
- `CORAZON_CODEX_CLIENT_MODE=app-server` (default)
- `CORAZON_CODEX_CLIENT_MODE=sdk` (fallback)

Workflow script sandbox runtime:
- `CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER=local` (default; currently the only supported provider)
- `CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS=60000` default timeout for script-language workflow runs
- `CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES=256000` output cap for script-language workflow stdout/stderr
- `CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES=64000` source-size cap for script-language workflow bodies
- `CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES=8388608` temporary sandbox workspace cap for script-language workflow runs
- `CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE=host` containment policy (`host`, `auto`, or `linux-strict`)
- `CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PROFILE=none` optional Linux containment preset (`none`, `systemd-user-scope`, `systemd-system-scope`, `bubblewrap-minimal`)
- `CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX=["systemd-run","--scope","--user","--"]` Linux containment launcher prefix used when `auto`/`linux-strict` enables strict containment (`PATH` command or absolute executable path; slash-separated relative paths are rejected)
- `CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST=KEY_A,KEY_B` comma-separated host env keys allowed into script runtime
- `CORAZON_WORKFLOW_PYTHON_BIN=python3` optional Python binary override for `language: python` workflows

Note:
- `language: markdown` workflows continue to use the LLM execution path.
- `language: typescript` and `language: python` workflows run through the script sandbox provider path.
- Script runtime now pins `HOME` and `TMPDIR` to the per-run temporary sandbox directory instead of inheriting host home paths.
- Script runs expose provider metadata (`provider`, `language`, `trigger`, timeout/output/source policy) in failure summaries for faster triage.
- Script metadata now includes containment policy fields (`containmentModeRequested`, `containmentProfileRequested`, `containmentModeApplied`, `containmentProfileApplied`, `containmentEnforced`, `containmentFallbackReason`) so fallback/strict-mode outcomes are explicit in run records.
- On Linux, strict containment can be activated with either `CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX` (JSON array command prefix) or `CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PROFILE` presets. Explicit prefix takes precedence over profile. In strict mode, missing/invalid/unavailable containment config fails in `prepare`; in `auto`, it falls back to host mode with a reason.
- Profile presets require host tooling: `systemd-user-scope`/`systemd-system-scope` require `systemd-run`, and `bubblewrap-minimal` requires `bwrap`. If missing, fallback/error messages now include profile-specific setup hints.
- Failure summaries also include `failurePhase` (`prepare`/`execute`) for `provider-error` cases to separate setup/runtime bootstrap failures from script logic failures.
- Script sandbox metadata now includes phase-level timing (`prepareDurationMs`, `executeDurationMs`, `teardownDurationMs`) plus `executionDurationMs` and `outputTruncated`; failure summaries include these values for faster policy/provider triage without log scraping.
- Managed sandbox providers are planned as follow-up adapters behind the same provider interface.

Script sandbox triage quick map:
- `errorCode=execution-timeout`: script exceeded `CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS`; check `executionDurationMs`, then reduce workload or raise timeout cautiously.
- `errorCode=policy-violation` + `policyTrigger=output-size`: combined stdout/stderr exceeded `CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES`; reduce log volume or adjust output cap. If `outputTruncated=true`, captured logs were capped at the configured output budget.
- `errorCode=policy-violation` + `policyTrigger=source-size`: workflow body exceeded `CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES`; move logic into smaller units or increase source-size cap cautiously.
- `errorCode=policy-violation` + `policyTrigger=tmp-size`: script-created temporary workspace content exceeded `CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES`; reduce ephemeral file output or raise the tmp cap carefully.
- `errorCode=provider-error` + `failurePhase=prepare`: provider/runtime bootstrap failed before script execution (for example missing runtime binary); verify runtime dependencies and provider config.
- `errorCode=provider-error` + `failurePhase=prepare` + `containmentModeRequested=linux-strict`: strict containment was requested but Linux containment prefix configuration was invalid/missing, or the host is not Linux.
- `errorCode=provider-error` + `failurePhase=execute`: provider failed after process start; use `executionDurationMs`, `terminationScope`, and runtime command metadata to inspect teardown and subprocess behavior.
- `errorCode=execution-failed`: script process returned non-zero exit code; treat as script logic/runtime failure and inspect stderr with the captured metadata context.

The app runs at:

```text
http://localhost:3000
```

## Production

```bash
pnpm build
pnpm preview
```

### Docker (production)

Prepare a host state root. Compose will bind-mount role-specific subdirectories from that root:

```bash
export CORAZON_HOST_STATE_DIR="$(pwd)/.docker-state"
export CORAZON_CODEX_HOST_DIR="$HOME/.codex"
export CORAZON_AUTH_SEED_MODE=copy-once
mkdir -p "$CORAZON_HOST_STATE_DIR"/{.corazon,.corazon-runtime,.ssh,chroma}
npx corazon setup \
  --agent-home "$CORAZON_HOST_STATE_DIR/.corazon" \
  --app-runtime-root "$CORAZON_HOST_STATE_DIR/.corazon-runtime" \
  --codex-home "$CORAZON_CODEX_HOST_DIR"
```

If you use Git over SSH, persist your SSH keys and `known_hosts` as well:

```bash
cp -R "$HOME/.ssh/." "$CORAZON_HOST_STATE_DIR/.ssh/"
chmod 700 "$CORAZON_HOST_STATE_DIR/.ssh"
```

Build and run with Docker Compose:

```bash
docker compose up --build
```

For ChatGPT-managed Codex auth on a headless server, keep `auth.json` on the writable agent-home bind mount and seed it only once from `${CORAZON_CODEX_HOST_DIR}`. With `CORAZON_AUTH_SEED_MODE=copy-once`, Corazon materializes `${CORAZON_HOST_STATE_DIR}/.corazon/auth.json` as a normal file so Codex can rotate refreshed tokens in place across restarts. The compose file also enables a periodic app-server keepalive that refreshes managed auth before it goes stale.

The production image also installs Python 3.12 and `uv` via `mise`, so runtime-managed skills can rely on `python`, `python3`, `uv`, and `uvx` inside the container.

Or build and run with Docker directly:

```bash
docker build -t corazon .
docker run --rm -p 3000:3000 \
  -v "$CORAZON_HOST_STATE_DIR/.corazon:/root/.corazon" \
  -v "$CORAZON_HOST_STATE_DIR/.corazon-runtime:/root/.corazon-runtime" \
  -v "$CORAZON_HOST_STATE_DIR/.ssh:/root/.ssh" \
  -v "$CORAZON_CODEX_HOST_DIR:/root/.codex-seed:ro" \
  corazon
```

Notes:
- `${CORAZON_HOST_STATE_DIR}` contains Corazon agent home (`.corazon/`), app runtime workspaces (`.corazon-runtime/`), SSH material (`.ssh/`), and Chroma persistence (`chroma/`).
- `${CORAZON_CODEX_HOST_DIR}` points to the host Codex home mounted read-only at `/root/.codex-seed`. By default, Compose uses `${HOME}/.codex`.
- The agent home (for example `${CORAZON_HOST_STATE_DIR}/.corazon`) should contain `config.toml`, `skills/`, `data/`, and Corazon-managed config/auth state.
- The app runtime root (for example `${CORAZON_HOST_STATE_DIR}/.corazon-runtime`) should contain `threads/` and `workflow-data/`.
- GitHub CLI (`gh`) is installed in the image, and entrypoint wiring persists `gh` auth/config under `${CORAZON_HOST_STATE_DIR}/.corazon/gh` via `/root/.config/gh`.
- Entrypoint wiring also persists `/root/.gitconfig` under `${CORAZON_HOST_STATE_DIR}/.corazon/gitconfig`, so `gh auth setup-git` survives redeploys.
- Keep the host Codex home available when you want `auth.json` and other seed files to survive redeploys.
- Workflow local metadata is stored at `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/workflow-data`).

## Data & storage

- SQLite database: `${CORAZON_ROOT_DIR}/data/codex.sqlite` (default: `~/.corazon/data/codex.sqlite`)
- Agent home / Codex state: `${CORAZON_ROOT_DIR}` (default: `~/.corazon`)
- App runtime root: `${CORAZON_RUNTIME_ROOT_DIR}` (default: sibling `~/.corazon-runtime` or platform equivalent)
- Thread working directories: `${CORAZON_THREADS_DIR}/{threadId}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/threads/{threadId}`)
- Attachments are stored under each thread’s `attachments/` directory.
- Workflow local metadata: `${WORKFLOW_LOCAL_DATA_DIR}` (default: `${CORAZON_RUNTIME_ROOT_DIR}/workflow-data`)

## TODO

- [x] Core features built with Codex SDK, Vercel AI, and Nuxt UI
- [x] Thread persistence, titles, and usage stats
- [x] Per-thread working directories and attachments
- [x] Thread browsing/resume UX
- [ ] Login & OAuth
- [ ] Multi-user support
- [ ] Multi-project workspaces
- [ ] Isolated shell and code interpreter
