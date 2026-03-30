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

Set `GH_COMMENT_SAFE_ALLOW_DUPLICATE=true` to bypass duplicate PR comment suppression.
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
allow_duplicate="${GH_COMMENT_SAFE_ALLOW_DUPLICATE:-false}"
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
body_without_fences_file="$(mktemp)"
normalized_body_file="$(mktemp)"
latest_body_file="$(mktemp)"
normalized_latest_body_file="$(mktemp)"
cleanup() {
  rm -f "$body_file" "$body_without_fences_file" "$normalized_body_file" "$latest_body_file" "$normalized_latest_body_file"
}
trap cleanup EXIT

cat > "$body_file"

if [[ ! -s "$body_file" ]]; then
  echo "Refusing to post an empty comment body." >&2
  exit 1
fi

awk '
  match($0, /^[[:space:]]*(```+|~~~+)/) {
    fence_delim = substr($0, RSTART + RLENGTH - 1, 1)
    fence_width = RLENGTH - (length($0) - length(substr($0, RSTART)))

    if (!in_fence) {
      in_fence = 1
      open_fence_delim = fence_delim
      open_fence_width = fence_width
      next
    }

    if (fence_delim == open_fence_delim && fence_width >= open_fence_width) {
      in_fence = 0
      open_fence_delim = ""
      open_fence_width = 0
      next
    }
  }
  !in_fence { print }
' "$body_file" > "$body_without_fences_file"

if (($(tr -d -c '\140' < "$body_without_fences_file" | wc -c) % 2 != 0)); then
  echo "Detected an unbalanced number of backticks outside fenced code blocks in comment body." >&2
  exit 1
fi

normalize_file() {
  local input_file="$1"
  local output_file="$2"
  awk '
    {
      sub(/[[:space:]]+$/, "", $0)
      lines[NR] = $0
    }
    END {
      last = NR
      while (last > 0 && lines[last] == "") {
        last--
      }
      for (i = 1; i <= last; i++) {
        print lines[i]
      }
    }
  ' "$input_file" > "$output_file"
}

normalize_file "$body_file" "$normalized_body_file"

if [[ "$target_type" == "pr" && -n "$repo" && "$allow_duplicate" != "true" && "$dry_run" != "true" ]]; then
  actor_login="$(gh api user --jq '.login')"
  gh api --paginate "repos/${repo}/issues/${target_number}/comments?per_page=100" \
    | node -e '
const fs = require("node:fs")
const actor = process.argv[1]
const raw = fs.readFileSync(0, "utf8").trim()
let comments = []
if (raw.length > 0) {
  try {
    const payload = JSON.parse(raw)
    comments = Array.isArray(payload) ? payload : []
  } catch {
    comments = raw
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        try {
          const page = JSON.parse(line)
          return Array.isArray(page) ? page : []
        } catch {
          return []
        }
      })
  }
}
const mine = comments.filter(comment => comment?.user?.login === actor)
process.stdout.write(mine.length > 0 ? String(mine[mine.length - 1].body ?? "") : "")
' "$actor_login" > "$latest_body_file"

  if [[ -s "$latest_body_file" ]]; then
    normalize_file "$latest_body_file" "$normalized_latest_body_file"
    if cmp -s "$normalized_body_file" "$normalized_latest_body_file"; then
      echo "Skipping duplicate PR comment for #${target_number}: latest comment by ${actor_login} has equivalent body."
      exit 0
    fi
  fi
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
