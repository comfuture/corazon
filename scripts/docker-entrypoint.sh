#!/usr/bin/env sh
set -e

RUNTIME_ROOT=${CORAZON_ROOT_DIR:-/root/.corazon}
APP_RUNTIME_ROOT=${CORAZON_RUNTIME_ROOT_DIR:-/root/.corazon-runtime}
CODEX_HOME=${CODEX_HOME:-"${RUNTIME_ROOT}"}
CORAZON_THREADS_DIR=${CORAZON_THREADS_DIR:-"${APP_RUNTIME_ROOT}/threads"}
WORKFLOW_LOCAL_DATA_DIR=${WORKFLOW_LOCAL_DATA_DIR:-"${APP_RUNTIME_ROOT}/workflow-data"}
SSH_DIR=${CORAZON_SSH_DIR:-/root/.ssh}
GH_RUNTIME_CONFIG_DIR=${CORAZON_GH_CONFIG_DIR:-"${RUNTIME_ROOT}/gh"}
GH_CONFIG_DIR=${CORAZON_GH_CONFIG_PATH:-/root/.config/gh}
GITCONFIG_RUNTIME_PATH=${CORAZON_GITCONFIG_PATH:-"${RUNTIME_ROOT}/gitconfig"}
GITCONFIG_PATH=${CORAZON_GITCONFIG_TARGET_PATH:-/root/.gitconfig}

export CORAZON_THREADS_DIR
export WORKFLOW_LOCAL_DATA_DIR

if [ ! -d "$RUNTIME_ROOT" ]; then
  echo "Corazon agent home was not found at: $RUNTIME_ROOT" >&2
  echo "Mount a host directory to this path before starting the container." >&2
  echo "Host setup example:" >&2
  echo "  mkdir -p <host-state-dir>/.corazon <host-state-dir>/.corazon-runtime <host-state-dir>/.ssh" >&2
  echo "  npx corazon setup --agent-home <host-state-dir>/.corazon --app-runtime-root <host-state-dir>/.corazon-runtime --codex-home ~/.codex" >&2
  echo "  docker run -v <host-state-dir>/.corazon:$RUNTIME_ROOT -v <host-state-dir>/.corazon-runtime:$APP_RUNTIME_ROOT -v <host-state-dir>/.ssh:$SSH_DIR -v ~/.codex:/root/.codex-seed:ro ..." >&2
  exit 1
fi

if [ ! -d "$CODEX_HOME" ]; then
  mkdir -p "$CODEX_HOME"
fi

mkdir -p "$APP_RUNTIME_ROOT"
mkdir -p "$CORAZON_THREADS_DIR"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR" || true
mkdir -p "$WORKFLOW_LOCAL_DATA_DIR"
mkdir -p "$(dirname "$GH_CONFIG_DIR")"
mkdir -p "$GH_RUNTIME_CONFIG_DIR"
chmod 700 "$GH_RUNTIME_CONFIG_DIR" || true
mkdir -p "$(dirname "$GITCONFIG_PATH")"

# Persist GitHub CLI auth/config in the mounted agent home so redeploys keep gh login state.
if [ -d "$GH_CONFIG_DIR" ] && [ ! -L "$GH_CONFIG_DIR" ]; then
  if [ "$(ls -A -- "$GH_CONFIG_DIR" 2>/dev/null)" ]; then
    cp -R "$GH_CONFIG_DIR"/. "$GH_RUNTIME_CONFIG_DIR"/
  fi
  rm -rf "$GH_CONFIG_DIR"
fi

if [ -f "$GH_CONFIG_DIR" ]; then
  rm -f "$GH_CONFIG_DIR"
fi

ln -sfn "$GH_RUNTIME_CONFIG_DIR" "$GH_CONFIG_DIR"

# Persist git credential-helper config because `gh auth setup-git` writes to ~/.gitconfig.
if [ -f "$GITCONFIG_PATH" ] && [ ! -L "$GITCONFIG_PATH" ]; then
  cp "$GITCONFIG_PATH" "$GITCONFIG_RUNTIME_PATH"
  rm -f "$GITCONFIG_PATH"
fi

if [ -d "$GITCONFIG_PATH" ]; then
  rm -rf "$GITCONFIG_PATH"
fi

ln -sfn "$GITCONFIG_RUNTIME_PATH" "$GITCONFIG_PATH"

if [ ! -f "$CODEX_HOME/config.toml" ]; then
  echo "Codex config.toml was not found at: $CODEX_HOME/config.toml" >&2
  echo "Seed it with: npx corazon setup --agent-home <host-state-dir>/.corazon --app-runtime-root <host-state-dir>/.corazon-runtime --codex-home ~/.codex" >&2
  echo "Continuing (Codex may rely on fallback defaults)." >&2
fi

exec "$@"
