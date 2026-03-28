#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  gh-issue-feedback.sh <issue-number> [--repo owner/repo]
  gh-issue-feedback.sh --help

Collects issue feedback via REST endpoints to avoid GraphQL `projectCards` failures.
Returns a single JSON object with issue metadata and comments.
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

issue_number="$1"
shift

if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Issue number must be a positive integer: $issue_number" >&2
  exit 1
fi

repo=""
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
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$repo" ]]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
fi

if [[ -z "$repo" ]]; then
  echo "Could not determine repository. Use --repo owner/repo." >&2
  exit 1
fi

issue_file="$(mktemp)"
comments_file="$(mktemp)"

cleanup() {
  rm -f "$issue_file" "$comments_file"
}
trap cleanup EXIT

fetch_paginated_arrays() {
  local endpoint="$1"
  local out_file="$2"
  local page=1
  : >"$out_file"

  while true; do
    local separator="?"
    if [[ "$endpoint" == *"?"* ]]; then
      separator="&"
    fi

    local page_file
    page_file="$(mktemp)"
    gh api "${endpoint}${separator}per_page=100&page=${page}" >"$page_file"
    cat "$page_file" >>"$out_file"
    printf '\n' >>"$out_file"

    local page_count
    page_count="$(node -e '
const fs = require("node:fs")
const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
process.stdout.write(String(Array.isArray(payload) ? payload.length : 0))
' "$page_file")"
    rm -f "$page_file"
    if [[ "$page_count" -lt 100 ]]; then
      break
    fi
    page=$((page + 1))
  done
}

gh api "repos/${repo}/issues/${issue_number}" >"$issue_file"
fetch_paginated_arrays "repos/${repo}/issues/${issue_number}/comments" "$comments_file"

node -e '
const fs = require("node:fs")
const [issuePath, commentsPath] = process.argv.slice(1)

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"))
const flattenPages = (path) => {
  const raw = fs.readFileSync(path, "utf8").trim()
  if (!raw) return []
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line)
      return Array.isArray(parsed) ? parsed : []
    })
}

const payload = {
  issue: readJson(issuePath),
  comments: flattenPages(commentsPath)
}
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
' "$issue_file" "$comments_file"
