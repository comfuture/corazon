#!/usr/bin/env sh
set -e

RUNTIME_ROOT=${CORAZON_ROOT_DIR:-/root/.corazon}
CODEX_HOME=${CODEX_HOME:-"${RUNTIME_ROOT}/.codex"}

if [ ! -d "$RUNTIME_ROOT" ]; then
  echo "Corazon runtime root was not found at: $RUNTIME_ROOT" >&2
  echo "Mount a host directory to this path before starting the container." >&2
  echo "Host setup example:" >&2
  echo "  npx corazon setup --runtime-root <host-runtime-root>" >&2
  echo "  docker run -v <host-runtime-root>:$RUNTIME_ROOT ..." >&2
  exit 1
fi

if [ ! -d "$CODEX_HOME" ]; then
  echo "Codex home was not found at: $CODEX_HOME" >&2
  echo "Create it with: npx corazon setup --runtime-root <host-runtime-root>" >&2
  echo "Continuing without Codex home (ensure OPENAI_API_KEY is set if needed)." >&2
fi

exec "$@"
