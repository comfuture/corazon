#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  gh-pr-feedback.sh <pr-number> [--repo owner/repo]
  gh-pr-feedback.sh --help

Collects PR feedback via REST endpoints to avoid GraphQL `projectCards` failures.
Returns a single JSON object with pull metadata, issue comments, review comments,
and reviews.
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

pr_number="$1"
shift

if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "PR number must be a positive integer: $pr_number" >&2
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

pull_file="$(mktemp)"
issue_comments_file="$(mktemp)"
review_comments_file="$(mktemp)"
reviews_file="$(mktemp)"

cleanup() {
  rm -f "$pull_file" "$issue_comments_file" "$review_comments_file" "$reviews_file"
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

    local page_json
    page_json="$(gh api "${endpoint}${separator}per_page=100&page=${page}")"
    printf '%s\n' "$page_json" >>"$out_file"

    local page_count
    page_count="$(node -e 'const payload = JSON.parse(process.argv[1]); process.stdout.write(String(Array.isArray(payload) ? payload.length : 0));' "$page_json")"
    if [[ "$page_count" -lt 100 ]]; then
      break
    fi
    page=$((page + 1))
  done
}

gh api "repos/${repo}/pulls/${pr_number}" >"$pull_file" &
fetch_paginated_arrays "repos/${repo}/issues/${pr_number}/comments" "$issue_comments_file" &
fetch_paginated_arrays "repos/${repo}/pulls/${pr_number}/comments" "$review_comments_file" &
fetch_paginated_arrays "repos/${repo}/pulls/${pr_number}/reviews" "$reviews_file" &
wait

node -e '
const fs = require("node:fs")
const [pullPath, issuePath, reviewCommentPath, reviewsPath] = process.argv.slice(1)

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
  pull: readJson(pullPath),
  issueComments: flattenPages(issuePath),
  reviewComments: flattenPages(reviewCommentPath),
  reviews: flattenPages(reviewsPath)
}
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
' "$pull_file" "$issue_comments_file" "$review_comments_file" "$reviews_file"
