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

repo="comfuture/corazon"
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

pull_json="$(gh api "repos/${repo}/pulls/${pr_number}")"
issue_comments_json="$(gh api "repos/${repo}/issues/${pr_number}/comments")"
review_comments_json="$(gh api "repos/${repo}/pulls/${pr_number}/comments")"
reviews_json="$(gh api "repos/${repo}/pulls/${pr_number}/reviews")"

node -e '
const [pullRaw, issueRaw, reviewCommentRaw, reviewsRaw] = process.argv.slice(1)
const payload = {
  pull: JSON.parse(pullRaw),
  issueComments: JSON.parse(issueRaw),
  reviewComments: JSON.parse(reviewCommentRaw),
  reviews: JSON.parse(reviewsRaw)
}
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
' "$pull_json" "$issue_comments_json" "$review_comments_json" "$reviews_json"
