#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  gh-comment-safe.sh pr <number> [--repo owner/repo] [--dry-run]
  gh-comment-safe.sh issue <number> [--repo owner/repo] [--dry-run]

Reads markdown body from stdin and posts with `gh <target> comment --body-file`.
Use a single-quoted heredoc to preserve backticks and code identifiers:

  cat <<'MD' | scripts/gh-comment-safe.sh pr 123 --repo comfuture/corazon
  Updated `flushTextDraft` guard.
  MD
USAGE
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

target_type="$1"
target_number="$2"
shift 2

case "$target_type" in
  pr|issue) ;;
  *)
    echo "Unsupported target type: $target_type (expected: pr or issue)" >&2
    exit 1
    ;;
esac

repo=""
dry_run="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --repo" >&2
        exit 1
      fi
      repo="$2"
      shift 2
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

body_file="$(mktemp)"
cleanup() {
  rm -f "$body_file"
}
trap cleanup EXIT

cat > "$body_file"

if [[ ! -s "$body_file" ]]; then
  echo "Refusing to post an empty comment body." >&2
  exit 1
fi

if (($(tr -d -c '\140' < "$body_file" | wc -c) % 2 != 0)); then
  echo "Detected an unbalanced number of backticks in comment body." >&2
  exit 1
fi

cmd=(gh "$target_type" comment "$target_number" --body-file "$body_file")
if [[ -n "$repo" ]]; then
  cmd+=(--repo "$repo")
fi

if [[ "$dry_run" == "true" ]]; then
  printf 'DRY RUN:'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  cat "$body_file"
  exit 0
fi

"${cmd[@]}"
