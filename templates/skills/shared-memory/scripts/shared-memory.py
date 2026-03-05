#!/usr/bin/env -S uvx --with requests python

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

DEFAULT_LIMIT = 5
DEFAULT_THRESHOLD = 0.62
DEFAULT_MEMORY_API_BASE_URL = "http://localhost:3000"
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def to_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def clamp_limit(value: Any) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    if parsed < 1:
        return 1
    return min(parsed, 100)


def clamp_threshold(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD
    if parsed < 0:
        return 0.0
    if parsed > 1:
        return 1.0
    return parsed


def trim_trailing_slash(value: str) -> str:
    return value.rstrip("/")


def resolve_api_base_url(explicit: str | None) -> str:
    target = (
        (explicit or "").strip()
        or (os.getenv("CORAZON_MEMORY_API_BASE_URL") or "").strip()
        or DEFAULT_MEMORY_API_BASE_URL
    )
    if not target:
        raise ValueError("memory API base URL is empty")
    return trim_trailing_slash(target)


def build_loopback_api_base_candidates(api_base_url: str) -> list[str]:
    parsed = urlsplit(api_base_url)
    host = parsed.hostname
    if not host or host not in LOOPBACK_HOSTS:
        return [api_base_url]

    port = parsed.port
    candidates: list[str] = [api_base_url]
    for alt_host in LOOPBACK_HOSTS:
        if alt_host == host:
            continue

        netloc_host = f"[{alt_host}]" if ":" in alt_host else alt_host
        netloc = f"{netloc_host}:{port}" if port is not None else netloc_host
        alt_url = trim_trailing_slash(
            urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
        )
        if alt_url not in candidates:
            candidates.append(alt_url)
    return candidates


def read_response_json(response: requests.Response) -> dict[str, Any]:
    if not response.text:
        return {}
    try:
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {"raw": response.text}
    except ValueError:
        return {"raw": response.text}


def request_json(
    *,
    api_base_url: str,
    path: str,
    method: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    candidates = build_loopback_api_base_candidates(api_base_url)
    last_error: Exception | None = None

    for base_url in candidates:
        try:
            response = requests.request(
                method=method,
                url=f"{base_url}{path}",
                headers={"content-type": "application/json"} if body is not None else None,
                data=json.dumps(body) if body is not None else None,
                timeout=30,
            )
        except requests.exceptions.RequestException as error:
            last_error = error
            continue

        payload = read_response_json(response)
        if not response.ok:
            status_message = payload.get("statusMessage")
            if isinstance(status_message, str) and status_message.strip():
                raise RuntimeError(status_message.strip())
            raise RuntimeError(f"Request failed: {response.status_code}")
        return payload

    if last_error is not None:
        raise last_error
    raise RuntimeError("Request failed before receiving a response.")


def ensure_memory(api_base_url: str) -> dict[str, Any]:
    payload = request_json(
        api_base_url=api_base_url,
        path="/api/memory/health",
        method="GET",
    )
    return {
        "apiBaseUrl": api_base_url,
        "health": payload,
    }


def search_memory(api_base_url: str, query: str, limit: int) -> dict[str, Any]:
    payload = request_json(
        api_base_url=api_base_url,
        path="/api/memory/search",
        method="POST",
        body={
            "query": query,
            "limit": limit,
        },
    )
    results = payload.get("results")
    return {
        "apiBaseUrl": api_base_url,
        "query": query,
        "limit": limit,
        "results": results if isinstance(results, list) else [],
    }


def upsert_memory(
    api_base_url: str,
    section: str,
    text: str,
    threshold: float,
) -> dict[str, Any]:
    payload = request_json(
        api_base_url=api_base_url,
        path="/api/memory/remember",
        method="POST",
        body={
            "text": text,
            "section": section,
            "metadata": {
                "source": "shared-memory-skill",
                "section": section,
                "threshold": threshold,
            },
        },
    )

    memories = payload.get("memories")
    message_count = payload.get("messageCount")
    return {
        "apiBaseUrl": api_base_url,
        "section": section,
        "text": text,
        "threshold": threshold,
        "memories": memories if isinstance(memories, list) else [],
        "messageCount": message_count if isinstance(message_count, int) else 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shared-memory.py", add_help=True)
    parser.add_argument(
        "--api-base-url",
        default=None,
        help="Corazon API base URL. Falls back to CORAZON_MEMORY_API_BASE_URL.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("ensure", help="Check memory API health")

    search_parser = subparsers.add_parser("search", help="Search shared memory")
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--limit", default=str(DEFAULT_LIMIT))

    upsert_parser = subparsers.add_parser("upsert", help="Write memory")
    upsert_parser.add_argument("--text", required=True)
    upsert_parser.add_argument("--section", default="Facts")
    upsert_parser.add_argument("--threshold", default=str(DEFAULT_THRESHOLD))

    return parser


def run(argv: list[str]) -> dict[str, Any]:
    parser = build_parser()
    args = parser.parse_args(argv)
    api_base_url = resolve_api_base_url(args.api_base_url)

    if args.command == "ensure":
        return ensure_memory(api_base_url)
    if args.command == "search":
        query = args.query.strip()
        if not query:
            raise ValueError("missing --query")
        limit = clamp_limit(args.limit)
        return search_memory(api_base_url, query, limit)
    if args.command == "upsert":
        text = args.text.strip()
        if not text:
            raise ValueError("missing --text")
        section = args.section.strip() or "Facts"
        threshold = clamp_threshold(args.threshold)
        return upsert_memory(api_base_url, section, text, threshold)

    raise ValueError(f"unknown command: {args.command}")


def main() -> int:
    try:
        payload = run(sys.argv[1:])
        sys.stdout.write(f"{to_json({'ok': True, **payload})}\n")
        return 0
    except Exception as error:
        sys.stdout.write(f"{to_json({'ok': False, 'error': str(error)})}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
