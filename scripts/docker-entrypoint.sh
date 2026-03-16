#!/usr/bin/env sh
set -e

RUNTIME_ROOT=${CORAZON_ROOT_DIR:-/root/.corazon}
CODEX_HOME=${CODEX_HOME:-"${RUNTIME_ROOT}"}
WORKFLOW_LOCAL_DATA_DIR=${WORKFLOW_LOCAL_DATA_DIR:-"${RUNTIME_ROOT}/workflow-data"}
SSH_DIR=${CORAZON_SSH_DIR:-/root/.ssh}
CODEX_SEED_SOURCE=${CORAZON_CODEX_SEED_SOURCE:-/root/.codex-seed}
CODEX_BIN=${CORAZON_CODEX_BIN:-/app/node_modules/.pnpm/node_modules/.bin/codex}

export WORKFLOW_LOCAL_DATA_DIR

if [ ! -d "$RUNTIME_ROOT" ]; then
  echo "Corazon runtime root was not found at: $RUNTIME_ROOT" >&2
  echo "Mount a host directory to this path before starting the container." >&2
  echo "Host setup example:" >&2
  echo "  mkdir -p <host-state-dir>/.corazon <host-state-dir>/.ssh <host-state-dir>/.codex-seed" >&2
  echo "  npx corazon setup --runtime-root <host-state-dir>/.corazon --codex-home <host-state-dir>/.codex-seed" >&2
  echo "  docker run -v <host-state-dir>/.corazon:$RUNTIME_ROOT -v <host-state-dir>/.ssh:$SSH_DIR -v <host-state-dir>/.codex-seed:/root/.codex-seed ..." >&2
  exit 1
fi

if [ ! -d "$CODEX_HOME" ]; then
  mkdir -p "$CODEX_HOME"
fi

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR" || true
mkdir -p "$WORKFLOW_LOCAL_DATA_DIR"

if [ ! -f "$CODEX_HOME/config.toml" ]; then
  echo "Codex config.toml was not found at: $CODEX_HOME/config.toml" >&2
  echo "Seed it with: npx corazon setup --runtime-root <host-state-dir>/.corazon --codex-home <host-state-dir>/.codex-seed" >&2
  echo "Continuing (Codex may rely on fallback defaults)." >&2
fi

AUTH_PATH="$CODEX_HOME/auth.json"
SEED_AUTH_PATH="$CODEX_SEED_SOURCE/auth.json"

if [ -L "$AUTH_PATH" ] && [ ! -e "$AUTH_PATH" ]; then
  rm -f "$AUTH_PATH"
fi

if [ ! -e "$AUTH_PATH" ] && [ -n "${OPENAI_API_KEY:-}" ] && [ -x "$CODEX_BIN" ]; then
  echo "Codex auth.json was not found at: $AUTH_PATH" >&2
  if [ ! -e "$SEED_AUTH_PATH" ]; then
    echo "Codex seed auth.json was not found at: $SEED_AUTH_PATH" >&2
  fi
  echo "Bootstrapping Codex API key login into $CODEX_HOME" >&2
  if ! printf '%s' "$OPENAI_API_KEY" | CODEX_HOME="$CODEX_HOME" "$CODEX_BIN" login --with-api-key >/dev/null; then
    echo "Failed to bootstrap Codex API key login." >&2
    exit 1
  fi
fi

exec "$@"
