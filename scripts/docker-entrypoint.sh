#!/usr/bin/env sh
set -e

RUNTIME_ROOT=${CORAZON_ROOT_DIR:-/root/.corazon}
CODEX_HOME=${CODEX_HOME:-"${RUNTIME_ROOT}"}
WORKFLOW_LOCAL_DATA_DIR=${WORKFLOW_LOCAL_DATA_DIR:-"${RUNTIME_ROOT}/workflow-data"}
SSH_DIR=${CORAZON_SSH_DIR:-/root/.ssh}

export WORKFLOW_LOCAL_DATA_DIR

if [ ! -d "$RUNTIME_ROOT" ]; then
  echo "Corazon runtime root was not found at: $RUNTIME_ROOT" >&2
  echo "Mount a host directory to this path before starting the container." >&2
  echo "Host setup example:" >&2
  echo "  mkdir -p <host-state-dir>/.corazon <host-state-dir>/.ssh" >&2
  echo "  npx corazon setup --runtime-root <host-state-dir>/.corazon --codex-home ~/.codex" >&2
  echo "  docker run -v <host-state-dir>/.corazon:$RUNTIME_ROOT -v <host-state-dir>/.ssh:$SSH_DIR -v ~/.codex:/root/.codex-seed:ro ..." >&2
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
  echo "Seed it with: npx corazon setup --runtime-root <host-state-dir>/.corazon --codex-home ~/.codex" >&2
  echo "Continuing (Codex may rely on fallback defaults)." >&2
fi

exec "$@"
