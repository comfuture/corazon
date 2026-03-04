#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WORKFLOW_NAME_PATTERN = re.compile(r"^[A-Za-z]+(?: [A-Za-z]+){1,2}$")
WORKFLOW_NAME_WORD_PATTERN = re.compile(r"^[A-Za-z]+$")
DEFAULT_WORKFLOW_NAME = "Task Workflow"
WORKFLOW_EXTENSION = ".md"
INTERVAL_PATTERN = re.compile(r"^([1-9][0-9]*)(s|m|h)$")
FRONTMATTER_PATTERN = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$")

CRON_MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
CRON_WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
RRULE_FREQ_VALUES = {"SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"}
RRULE_WEEKDAY_VALUES = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}


@dataclass
class TriggerConfig:
    schedule: str | None = None
    interval: str | None = None
    rrule: str | None = None
    workflow_dispatch: bool = False


@dataclass
class WorkflowFrontmatter:
    name: str
    description: str
    on: TriggerConfig
    skills: list[str]


@dataclass
class WorkflowDefinition:
    file_slug: str
    file_path: Path
    source: str
    frontmatter: WorkflowFrontmatter
    instruction: str
    is_valid: bool
    parse_error: str | None
    updated_at: float


def as_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_bool(value: Any, default: bool | None = None) -> bool | None:
    if isinstance(value, bool):
        return value
    if not isinstance(value, str):
        return default

    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "y"}:
        return True
    if normalized in {"false", "0", "no", "n"}:
        return False
    return default


def parse_csv(value: Any) -> list[str]:
    source = as_string(value)
    if not source:
        return []
    return [item.strip() for item in source.split(",") if item.strip()]


def unquote_yaml_scalar(value: str) -> str:
    raw = as_string(value)
    if not raw:
        return ""

    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        inner = raw[1:-1]
        return inner.replace(r"\\'", "'").replace(r'\\"', '"').replace(r"\\\\", "\\")

    return raw


def quote_yaml_scalar(value: str) -> str:
    source = as_string(value)
    if not source:
        return '""'

    plain_safe = re.compile(r"^[A-Za-z0-9 _./:+@-]+$")
    lower = source.lower()
    if plain_safe.match(source) and lower not in {"true", "false", "null"} and not source.isdigit():
        return source

    escaped = source.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def normalize_workflow_name(value: str) -> str:
    words = [
        token.strip()
        for token in re.sub(r"[^A-Za-z\s]", " ", value or "").split()
        if token.strip() and WORKFLOW_NAME_WORD_PATTERN.match(token.strip())
    ]

    if not words:
        return DEFAULT_WORKFLOW_NAME

    if len(words) == 1:
        return f"{words[0].title()} Workflow"

    return " ".join(word.title() for word in words[:3])


def derive_description(value: str) -> str:
    schedule_pattern = re.compile(
        r"\b(cron|rrule|interval|daily|weekly|monthly|every\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?))\b|"
        r"매(일|주|월|년|시간|분)|[0-9]+\s*(초|분|시간|일|주|개월)\s*마다",
        re.IGNORECASE,
    )
    meta_pattern = re.compile(
        r"(워크플로우\s*(생성|등록|수정|저장|작성)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow)",
        re.IGNORECASE,
    )

    normalized = meta_pattern.sub("", value or "")
    normalized = schedule_pattern.sub("", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()

    if not normalized:
        return "요청된 자동 작업을 수행합니다."

    return f"{normalized[:180].rstrip()}..." if len(normalized) > 180 else normalized


def to_file_slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return normalized or "workflow"


def parse_cron_atom(value: str, min_value: int, max_value: int, aliases: list[str] | None = None) -> int | None:
    source = as_string(value).upper()
    if not source:
        return None

    if re.fullmatch(r"-?\d+", source):
        parsed = int(source)
        return parsed if min_value <= parsed <= max_value else None

    if aliases and source in aliases:
        return min_value + aliases.index(source)

    return None


def validate_cron_part(value: str, min_value: int, max_value: int, aliases: list[str] | None = None) -> bool:
    source = as_string(value)
    if not source:
        return False

    step_match = re.fullmatch(r"(.+?)/(\d+)", source)
    if step_match:
        return int(step_match.group(2)) > 0 and validate_cron_part(step_match.group(1), min_value, max_value, aliases)

    if source == "*":
        return True

    range_match = re.fullmatch(r"([A-Za-z0-9-]+)-([A-Za-z0-9-]+)", source)
    if range_match:
        left = parse_cron_atom(range_match.group(1), min_value, max_value, aliases)
        right = parse_cron_atom(range_match.group(2), min_value, max_value, aliases)
        return left is not None and right is not None and left <= right

    return parse_cron_atom(source, min_value, max_value, aliases) is not None


def validate_cron_expression(value: str) -> bool:
    fields = [token for token in as_string(value).split() if token]
    if len(fields) != 5:
        return False

    if not all(validate_cron_part(part, 0, 59) for part in fields[0].split(",")):
        return False
    if not all(validate_cron_part(part, 0, 23) for part in fields[1].split(",")):
        return False
    if not all(validate_cron_part(part, 1, 31) for part in fields[2].split(",")):
        return False
    if not all(validate_cron_part(part, 1, 12, CRON_MONTH_NAMES) for part in fields[3].split(",")):
        return False
    if not all(validate_cron_part(part, 0, 7, CRON_WEEKDAY_NAMES) for part in fields[4].split(",")):
        return False

    return True


def validate_interval_expression(value: str) -> bool:
    return bool(INTERVAL_PATTERN.fullmatch(as_string(value)))


def split_rrule(value: str) -> dict[str, str] | None:
    parts = [segment.strip() for segment in as_string(value).split(";") if segment.strip()]
    if not parts:
        return None

    parsed: dict[str, str] = {}
    for part in parts:
        if "=" not in part:
            return None
        key, raw = part.split("=", 1)
        key = key.strip().upper()
        raw = raw.strip().upper()
        if not key or not raw or key in parsed or not re.fullmatch(r"[A-Z][A-Z0-9-]*", key):
            return None
        parsed[key] = raw

    return parsed


def validate_rrule_int_list(value: str, min_value: int, max_value: int, allow_negative: bool = False, disallow_zero: bool = False) -> bool:
    tokens = [token.strip() for token in as_string(value).split(",") if token.strip()]
    if not tokens:
        return False

    for token in tokens:
        if not re.fullmatch(r"[-+]?\d+", token):
            return False
        parsed = int(token)
        if not allow_negative and parsed < 0:
            return False
        if disallow_zero and parsed == 0:
            return False
        if parsed < min_value or parsed > max_value:
            return False

    return True


def validate_rrule_expression(value: str) -> bool:
    parsed = split_rrule(value)
    if not parsed:
        return False

    freq = parsed.get("FREQ")
    if not freq or freq not in RRULE_FREQ_VALUES:
        return False

    if "INTERVAL" in parsed and not re.fullmatch(r"[1-9]\d*", parsed["INTERVAL"]):
        return False
    if "COUNT" in parsed and not re.fullmatch(r"[1-9]\d*", parsed["COUNT"]):
        return False
    if "UNTIL" in parsed and not re.fullmatch(r"\d{8}(T\d{6}Z)?", parsed["UNTIL"]):
        return False

    if "BYDAY" in parsed:
        weekdays = [item.strip() for item in parsed["BYDAY"].split(",") if item.strip()]
        if not weekdays:
            return False
        for item in weekdays:
            match = re.fullmatch(r"([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)", item)
            if not match:
                return False
            if match.group(1):
                ordinal = int(match.group(1))
                if ordinal == 0 or ordinal < -53 or ordinal > 53:
                    return False

    checks = [
        ("BYHOUR", 0, 23, False, False),
        ("BYMINUTE", 0, 59, False, False),
        ("BYSECOND", 0, 59, False, False),
        ("BYMONTH", 1, 12, False, False),
        ("BYMONTHDAY", -31, 31, True, True),
        ("BYYEARDAY", -366, 366, True, True),
        ("BYWEEKNO", -53, 53, True, True),
    ]
    for key, min_value, max_value, allow_negative, disallow_zero in checks:
        if key in parsed and not validate_rrule_int_list(parsed[key], min_value, max_value, allow_negative, disallow_zero):
            return False

    if "WKST" in parsed and parsed["WKST"] not in RRULE_WEEKDAY_VALUES:
        return False

    return True


def validate_workflow(frontmatter: WorkflowFrontmatter, instruction: str) -> str | None:
    if not WORKFLOW_NAME_PATTERN.fullmatch(as_string(frontmatter.name)):
        return "Workflow name must be 2-3 English words."

    if not as_string(frontmatter.description):
        return "Workflow description is required."

    if not as_string(instruction):
        return "Workflow instruction is required."

    schedule = as_string(frontmatter.on.schedule)
    interval = as_string(frontmatter.on.interval)
    rrule = as_string(frontmatter.on.rrule)
    dispatch = frontmatter.on.workflow_dispatch is True

    trigger_count = len([value for value in [schedule, interval, rrule] if value])
    if trigger_count > 1:
        return "Only one time trigger is allowed: schedule, interval, or rrule."

    if schedule and not validate_cron_expression(schedule):
        return "Invalid cron expression in on.schedule."
    if interval and not validate_interval_expression(interval):
        return "Invalid interval expression in on.interval."
    if rrule and not validate_rrule_expression(rrule):
        return "Invalid RRULE expression in on.rrule."

    if not schedule and not interval and not rrule and not dispatch:
        return "Enable workflow-dispatch when no time trigger exists."

    return None


def parse_frontmatter_yaml(source: str) -> WorkflowFrontmatter:
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    name = ""
    description = ""
    on = TriggerConfig()
    skills: list[str] = []
    section = "root"

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?", stripped)
            if not match:
                continue
            key, raw = match.group(1), match.group(2) or ""

            if key == "on":
                section = "on"
                continue
            if key == "skills":
                section = "skills"
                continue

            section = "root"
            if key == "name":
                name = unquote_yaml_scalar(raw)
            elif key == "description":
                description = unquote_yaml_scalar(raw)
            continue

        if section == "on" and indent >= 2:
            match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?", stripped)
            if not match:
                continue
            key, raw = match.group(1), match.group(2) or ""
            value = unquote_yaml_scalar(raw)
            if key == "schedule":
                on.schedule = value or None
            elif key == "interval":
                on.interval = value or None
            elif key == "rrule":
                on.rrule = value or None
            elif key == "workflow-dispatch":
                on.workflow_dispatch = parse_bool(value, False) is True
            continue

        if section == "skills" and indent >= 2:
            match = re.fullmatch(r"-\s+(.*)", stripped)
            if not match:
                continue
            item = unquote_yaml_scalar(match.group(1))
            if item:
                skills.append(item)

    return WorkflowFrontmatter(
        name=as_string(name),
        description=as_string(description),
        on=on,
        skills=list(dict.fromkeys(skills)),
    )


def stringify_frontmatter_yaml(frontmatter: WorkflowFrontmatter) -> str:
    lines = [
        f"name: {quote_yaml_scalar(frontmatter.name)}",
        f"description: {quote_yaml_scalar(frontmatter.description)}",
        "on:",
    ]

    if as_string(frontmatter.on.schedule):
        lines.append(f"  schedule: {quote_yaml_scalar(frontmatter.on.schedule or '')}")
    if as_string(frontmatter.on.interval):
        lines.append(f"  interval: {quote_yaml_scalar(frontmatter.on.interval or '')}")
    if as_string(frontmatter.on.rrule):
        lines.append(f"  rrule: {quote_yaml_scalar(frontmatter.on.rrule or '')}")

    lines.append(f"  workflow-dispatch: {'true' if frontmatter.on.workflow_dispatch else 'false'}")
    lines.append("skills:")
    for skill in frontmatter.skills:
        lines.append(f"  - {quote_yaml_scalar(skill)}")

    return "\n".join(lines)


def serialize_workflow_source(frontmatter: WorkflowFrontmatter, instruction: str) -> str:
    normalized = WorkflowFrontmatter(
        name=normalize_workflow_name(frontmatter.name),
        description=derive_description(frontmatter.description),
        on=TriggerConfig(
            schedule=as_string(frontmatter.on.schedule) or None,
            interval=as_string(frontmatter.on.interval) or None,
            rrule=as_string(frontmatter.on.rrule) or None,
            workflow_dispatch=frontmatter.on.workflow_dispatch is True,
        ),
        skills=list(dict.fromkeys([item for item in frontmatter.skills if as_string(item)])),
    )
    body = as_string(instruction)

    error = validate_workflow(normalized, body)
    if error:
        raise ValueError(error)

    yaml_content = stringify_frontmatter_yaml(normalized)
    return f"---\n{yaml_content}\n---\n{body}\n"


def create_invalid_workflow(file_slug: str, file_path: Path, source: str, updated_at: float, parse_error: str) -> WorkflowDefinition:
    return WorkflowDefinition(
        file_slug=file_slug,
        file_path=file_path,
        source=source,
        frontmatter=WorkflowFrontmatter(
            name=file_slug,
            description="",
            on=TriggerConfig(workflow_dispatch=True),
            skills=[],
        ),
        instruction="",
        is_valid=False,
        parse_error=parse_error,
        updated_at=updated_at,
    )


def parse_workflow_source(file_slug: str, file_path: Path, source: str, updated_at: float) -> WorkflowDefinition:
    match = FRONTMATTER_PATTERN.match(source)
    if not match:
        return create_invalid_workflow(file_slug, file_path, source, updated_at, "Workflow file must start with YAML frontmatter.")

    try:
        frontmatter = parse_frontmatter_yaml(match.group(1) or "")
    except Exception as exc:  # noqa: BLE001
        return create_invalid_workflow(file_slug, file_path, source, updated_at, str(exc) or "Invalid YAML frontmatter.")

    instruction = as_string(match.group(2) or "")
    error = validate_workflow(frontmatter, instruction)
    if error:
        return create_invalid_workflow(file_slug, file_path, source, updated_at, error)

    return WorkflowDefinition(
        file_slug=file_slug,
        file_path=file_path,
        source=source,
        frontmatter=frontmatter,
        instruction=instruction,
        is_valid=True,
        parse_error=None,
        updated_at=updated_at,
    )


def corazon_root_default() -> Path:
    configured = as_string(os.getenv("CORAZON_ROOT_DIR")) or as_string(os.getenv("CORAZON_ROOT"))
    if configured:
        return Path(configured).expanduser().resolve()

    home = Path.home()
    legacy = home / ".corazon"

    if sys.platform == "darwin":
        return legacy

    if legacy.exists():
        return legacy

    if sys.platform == "win32":
        appdata = as_string(os.getenv("APPDATA"))
        return Path(appdata) / "Corazon" if appdata else home / "AppData" / "Roaming" / "Corazon"

    xdg = as_string(os.getenv("XDG_CONFIG_HOME"))
    return (Path(xdg) / "corazon") if xdg else (home / ".config" / "corazon")


def resolve_root(args: argparse.Namespace) -> Path:
    explicit = as_string(getattr(args, "root", ""))
    return Path(explicit).expanduser().resolve() if explicit else corazon_root_default()


def workflows_dir(root: Path) -> Path:
    return root / "workflows"


def ensure_workflows_dir(root: Path) -> Path:
    directory = workflows_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def workflow_path(root: Path, file_slug: str) -> Path:
    return workflows_dir(root) / f"{file_slug}{WORKFLOW_EXTENSION}"


def resolve_unique_slug(root: Path, base_slug: str) -> str:
    normalized = to_file_slug(base_slug)
    directory = ensure_workflows_dir(root)
    next_slug = normalized
    index = 2
    while (directory / f"{next_slug}{WORKFLOW_EXTENSION}").exists():
        next_slug = f"{normalized}-{index}"
        index += 1
    return next_slug


def load_workflows(root: Path) -> list[WorkflowDefinition]:
    directory = workflows_dir(root)
    if not directory.exists():
        return []

    results: list[WorkflowDefinition] = []
    for path in sorted(directory.glob(f"*{WORKFLOW_EXTENSION}")):
        source = path.read_text(encoding="utf-8")
        updated_at = path.stat().st_mtime
        file_slug = path.stem
        results.append(parse_workflow_source(file_slug, path, source, updated_at))

    results.sort(key=lambda item: (-item.updated_at, item.file_slug))
    return results


def save_workflow(root: Path, file_slug: str, frontmatter: WorkflowFrontmatter, instruction: str) -> WorkflowDefinition:
    normalized_slug = to_file_slug(file_slug)
    source = serialize_workflow_source(frontmatter, instruction)
    path = workflow_path(root, normalized_slug)
    ensure_workflows_dir(root)
    path.write_text(source, encoding="utf-8")
    return parse_workflow_source(normalized_slug, path, source, path.stat().st_mtime)


def delete_workflow(root: Path, file_slug: str) -> bool:
    path = workflow_path(root, to_file_slug(file_slug))
    if not path.exists():
        return False
    path.unlink(missing_ok=True)
    return True


def workflow_summary(item: WorkflowDefinition) -> dict[str, Any]:
    return {
        "fileSlug": item.file_slug,
        "filePath": str(item.file_path),
        "isValid": item.is_valid,
        "parseError": item.parse_error,
        "name": item.frontmatter.name,
        "description": item.frontmatter.description,
        "schedule": item.frontmatter.on.schedule,
        "interval": item.frontmatter.on.interval,
        "rrule": item.frontmatter.on.rrule,
        "workflowDispatch": item.frontmatter.on.workflow_dispatch,
        "skills": list(item.frontmatter.skills),
        "updatedAt": item.updated_at,
    }


def pick_selector(workflows: list[WorkflowDefinition], slug: str | None, query: str | None) -> WorkflowDefinition:
    normalized_slug = to_file_slug(as_string(slug))
    if normalized_slug:
        matched = [item for item in workflows if item.file_slug == normalized_slug]
        if not matched:
            raise ValueError(f"Workflow not found: {normalized_slug}")
        return matched[0]

    normalized_query = as_string(query).lower()
    if not normalized_query:
        raise ValueError("Provide --slug or --query.")

    matched = []
    for workflow in workflows:
        target = "\n".join([
            workflow.file_slug,
            workflow.frontmatter.name,
            workflow.frontmatter.description,
            workflow.instruction,
        ]).lower()
        if normalized_query in target:
            matched.append(workflow)

    if not matched:
        raise ValueError(f"No workflow matched query: {query}")
    if len(matched) > 1:
        raise ValueError(f"Multiple workflows matched query: {query}")

    return matched[0]


def infer_trigger_from_text(text: str) -> tuple[str | None, str | None]:
    source = as_string(text)
    if not source:
        return None, None

    rrule_match = re.search(r"FREQ=[A-Z]+(?:;[A-Z0-9-]+=[A-Z0-9,+:-]+)*", source, flags=re.IGNORECASE)
    if rrule_match:
        value = rrule_match.group(0).upper()
        if validate_rrule_expression(value):
            return "rrule", value

    tokens = source.replace("\n", " ").split()
    for idx in range(0, max(0, len(tokens) - 4)):
        candidate = " ".join(tokens[idx : idx + 5])
        if validate_cron_expression(candidate):
            return "schedule", candidate

    compact = re.search(r"\b([1-9][0-9]*)(s|m|h)\b", source, flags=re.IGNORECASE)
    if compact:
        value = f"{compact.group(1)}{compact.group(2).lower()}"
        if validate_interval_expression(value):
            return "interval", value

    interval_patterns = [
        (re.compile(r"([1-9][0-9]*)\s*(초|seconds?|secs?)\s*마다", re.IGNORECASE), "s"),
        (re.compile(r"(?:every|매)\s*([1-9][0-9]*)\s*(초|seconds?|secs?)\b", re.IGNORECASE), "s"),
        (re.compile(r"([1-9][0-9]*)\s*(분|minutes?|mins?)\s*마다", re.IGNORECASE), "m"),
        (re.compile(r"(?:every|매)\s*([1-9][0-9]*)\s*(분|minutes?|mins?)\b", re.IGNORECASE), "m"),
        (re.compile(r"([1-9][0-9]*)\s*(시간|hours?|hrs?)\s*마다", re.IGNORECASE), "h"),
        (re.compile(r"(?:every|매)\s*([1-9][0-9]*)\s*(시간|hours?|hrs?)\b", re.IGNORECASE), "h"),
    ]
    for pattern, unit in interval_patterns:
        match = pattern.search(source)
        if not match:
            continue
        value = f"{match.group(1)}{unit}"
        if validate_interval_expression(value):
            return "interval", value

    return None, None


def derive_instruction_from_text(text: str) -> str:
    source = as_string(text)
    if not source:
        return ""

    quoted = re.search(r"[\"'“”‘’]([^\"'“”‘’]+)[\"'“”‘’]", source)
    quoted_text = as_string(quoted.group(1) if quoted else "")
    if quoted_text and re.search(r"(말하|출력|send|say|print|메시지|인사)", source, flags=re.IGNORECASE):
        return f'각 실행에서 assistant 메시지로 정확히 "{quoted_text}" 한 줄만 출력한다.'

    schedule_pattern = re.compile(
        r"\b(cron|rrule|interval|daily|weekly|monthly|every\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?))\b|"
        r"매(일|주|월|년|시간|분)|[0-9]+\s*(초|분|시간|일|주|개월)\s*마다",
        re.IGNORECASE,
    )
    meta_pattern = re.compile(
        r"(워크플로우\s*(생성|등록|수정|저장|작성|삭제|목록)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow|"
        r"update\s+(a\s+)?workflow|delete\s+(a\s+)?workflow)",
        re.IGNORECASE,
    )

    normalized = meta_pattern.sub("", source)
    normalized = schedule_pattern.sub("", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or source


def infer_selector_from_text(text: str, workflows: list[WorkflowDefinition]) -> tuple[str | None, str | None]:
    source = as_string(text).lower()
    if not source or not workflows:
        return None, as_string(text) or None

    best_slug = None
    best_score = 0

    for workflow in workflows:
        score = 0
        slug = workflow.file_slug.lower()
        name = workflow.frontmatter.name.lower()
        description = workflow.frontmatter.description.lower()
        instruction_head = workflow.instruction.lower()[:96]

        if slug and slug in source:
            score += 5
        if name and name in source:
            score += 4
        if description and description in source:
            score += 2
        if instruction_head and instruction_head in source:
            score += 1

        if score > best_score:
            best_score = score
            best_slug = workflow.file_slug

    if best_score <= 0:
        return None, as_string(text) or None

    return best_slug, None


def parse_from_text(text: str, workflows: list[WorkflowDefinition], available_skills: list[str]) -> dict[str, Any]:
    source = as_string(text)
    normalized = source.lower()

    slug, query = infer_selector_from_text(source, workflows)
    trigger_type, trigger_value = infer_trigger_from_text(source)
    instruction = derive_instruction_from_text(source)
    name = normalize_workflow_name(instruction or source)
    description = derive_description(instruction or source)
    skills = [skill for skill in available_skills if skill.lower() in normalized][:5]

    is_delete = bool(re.search(r"(삭제|지워|remove|delete)", source, flags=re.IGNORECASE))
    is_list = bool(re.search(r"(목록|리스트|조회|보여|what|which|list|show)", source, flags=re.IGNORECASE))
    is_update = bool(re.search(r"(수정|업데이트|변경|edit|update|change)", source, flags=re.IGNORECASE))

    action = "create"
    if is_delete:
        action = "delete"
    elif is_list:
        action = "list"
    elif is_update:
        action = "update"

    return {
        "action": action,
        "confidence": "low",
        "reason": "Deterministic local parser.",
        "selector": {
            "slug": slug,
            "query": query,
        },
        "listOptions": {
            "runningOnly": bool(re.search(r"(running|실행중|동작중|진행중)", source, flags=re.IGNORECASE)),
            "activeOnly": bool(re.search(r"(active|활성)", source, flags=re.IGNORECASE)),
            "query": None,
        },
        "draft": {
            "name": name,
            "description": description,
            "instruction": instruction or source,
            "triggerType": trigger_type,
            "triggerValue": trigger_value,
            "workflowDispatch": True,
            "skills": skills,
        },
    }


def list_available_skills(root: Path) -> list[str]:
    candidates = []
    codex_home = as_string(os.getenv("CODEX_HOME"))
    if codex_home:
        candidates.append(Path(codex_home) / "skills")
    candidates.append(Path.home() / ".codex" / "skills")
    candidates.append(root / "templates" / "skills")

    names: list[str] = []
    for candidate in candidates:
        if not candidate.exists() or not candidate.is_dir():
            continue
        for entry in candidate.iterdir():
            if entry.is_dir() and not entry.name.startswith("."):
                names.append(entry.name)

    return sorted(set(names))


def build_frontmatter(
    name: str,
    description: str,
    trigger_type: str | None,
    trigger_value: str | None,
    workflow_dispatch: bool,
    skills: list[str],
) -> WorkflowFrontmatter:
    on = TriggerConfig(workflow_dispatch=workflow_dispatch)
    if trigger_type == "schedule" and trigger_value:
        on.schedule = trigger_value
    elif trigger_type == "interval" and trigger_value:
        on.interval = trigger_value
    elif trigger_type == "rrule" and trigger_value:
        on.rrule = trigger_value

    return WorkflowFrontmatter(
        name=normalize_workflow_name(name),
        description=derive_description(description),
        on=on,
        skills=list(dict.fromkeys([item for item in skills if as_string(item)])),
    )


def handle_list(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    workflows = load_workflows(root)
    query = as_string(args.query).lower()

    filtered = workflows
    if query:
        filtered = [
            item
            for item in filtered
            if query in "\n".join([item.file_slug, item.frontmatter.name, item.frontmatter.description, item.instruction]).lower()
        ]

    if args.valid_only:
        filtered = [item for item in filtered if item.is_valid]
    if args.active_only:
        filtered = [
            item
            for item in filtered
            if item.is_valid
            and (item.frontmatter.on.schedule or item.frontmatter.on.interval or item.frontmatter.on.rrule or item.frontmatter.on.workflow_dispatch)
        ]
    if args.running_only:
        filtered = [
            item
            for item in filtered
            if item.is_valid and (item.frontmatter.on.schedule or item.frontmatter.on.interval or item.frontmatter.on.rrule)
        ]

    return {
        "ok": True,
        "action": "list",
        "count": len(filtered),
        "workflows": [workflow_summary(item) for item in filtered],
    }


def handle_create(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    instruction = as_string(args.instruction)
    if not instruction:
        raise ValueError("create requires --instruction.")

    trigger_type = None
    trigger_value = None
    if as_string(args.schedule):
        trigger_type = "schedule"
        trigger_value = as_string(args.schedule)
    elif as_string(args.interval):
        trigger_type = "interval"
        trigger_value = as_string(args.interval)
    elif as_string(args.rrule):
        trigger_type = "rrule"
        trigger_value = as_string(args.rrule)

    frontmatter = build_frontmatter(
        name=as_string(args.name) or instruction,
        description=as_string(args.description) or instruction,
        trigger_type=trigger_type,
        trigger_value=trigger_value,
        workflow_dispatch=parse_bool(args.workflow_dispatch, True) is True,
        skills=parse_csv(args.skills),
    )

    file_slug = resolve_unique_slug(root, as_string(args.file_slug) or frontmatter.name)
    created = save_workflow(root, file_slug, frontmatter, instruction)

    return {
        "ok": True,
        "action": "create",
        "workflow": workflow_summary(created),
    }


def handle_update(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    workflows = load_workflows(root)
    target = pick_selector(workflows, args.slug, args.query)
    if not target.is_valid:
        raise ValueError(f"Cannot update invalid workflow: {target.file_slug}")

    trigger_type = None
    trigger_value = None

    if as_string(args.schedule):
        trigger_type = "schedule"
        trigger_value = as_string(args.schedule)
    elif as_string(args.interval):
        trigger_type = "interval"
        trigger_value = as_string(args.interval)
    elif as_string(args.rrule):
        trigger_type = "rrule"
        trigger_value = as_string(args.rrule)
    elif target.frontmatter.on.schedule:
        trigger_type = "schedule"
        trigger_value = target.frontmatter.on.schedule
    elif target.frontmatter.on.interval:
        trigger_type = "interval"
        trigger_value = target.frontmatter.on.interval
    elif target.frontmatter.on.rrule:
        trigger_type = "rrule"
        trigger_value = target.frontmatter.on.rrule

    if args.clear_schedule and trigger_type == "schedule":
        trigger_type = None
        trigger_value = None
    if args.clear_interval and trigger_type == "interval":
        trigger_type = None
        trigger_value = None
    if args.clear_rrule and trigger_type == "rrule":
        trigger_type = None
        trigger_value = None

    skills = parse_csv(args.skills)
    add_skills = parse_csv(args.add_skills)
    remove_skills = set(parse_csv(args.remove_skills))

    if skills:
        next_skills = skills
    else:
        next_skills = list(target.frontmatter.skills)
    next_skills = [item for item in dict.fromkeys([*next_skills, *add_skills]) if item not in remove_skills]

    frontmatter = build_frontmatter(
        name=as_string(args.name) or target.frontmatter.name,
        description=as_string(args.description) or target.frontmatter.description,
        trigger_type=trigger_type,
        trigger_value=trigger_value,
        workflow_dispatch=parse_bool(args.workflow_dispatch, target.frontmatter.on.workflow_dispatch) is True,
        skills=next_skills,
    )

    instruction = as_string(args.instruction) or target.instruction
    updated = save_workflow(root, target.file_slug, frontmatter, instruction)

    return {
        "ok": True,
        "action": "update",
        "workflow": workflow_summary(updated),
    }


def handle_delete(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    workflows = load_workflows(root)
    target = pick_selector(workflows, args.slug, args.query)

    if not delete_workflow(root, target.file_slug):
        raise ValueError(f"Workflow not found: {target.file_slug}")

    return {
        "ok": True,
        "action": "delete",
        "deleted": True,
        "workflow": workflow_summary(target),
    }


def handle_from_text(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    text = as_string(args.text)
    if not text:
        raise ValueError("from-text requires --text.")

    workflows = load_workflows(root)
    available_skills = list_available_skills(root)
    parsed = parse_from_text(text, workflows, available_skills)

    return {
        "ok": True,
        "action": "from-text",
        "parsed": parsed,
    }


def handle_apply_text(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    text = as_string(args.text)
    if not text:
        raise ValueError("apply-text requires --text.")

    workflows = load_workflows(root)
    available_skills = list_available_skills(root)
    parsed = parse_from_text(text, workflows, available_skills)

    action = parsed["action"]
    if action == "list":
        list_args = argparse.Namespace(
            query=parsed["listOptions"].get("query"),
            valid_only=False,
            active_only=bool(parsed["listOptions"].get("activeOnly")),
            running_only=bool(parsed["listOptions"].get("runningOnly")),
        )
        result = handle_list(root, list_args)
        result["parsed"] = parsed
        return result

    if action == "delete":
        delete_args = argparse.Namespace(
            slug=parsed["selector"].get("slug"),
            query=parsed["selector"].get("query"),
        )
        result = handle_delete(root, delete_args)
        result["parsed"] = parsed
        return result

    if action == "update":
        update_args = argparse.Namespace(
            slug=parsed["selector"].get("slug"),
            query=parsed["selector"].get("query"),
            name=parsed["draft"].get("name"),
            description=parsed["draft"].get("description"),
            instruction=parsed["draft"].get("instruction"),
            schedule=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "schedule" else None,
            interval=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "interval" else None,
            rrule=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "rrule" else None,
            clear_schedule=False,
            clear_interval=False,
            clear_rrule=False,
            workflow_dispatch=str(parsed["draft"].get("workflowDispatch", True)).lower(),
            skills=",".join(parsed["draft"].get("skills", [])),
            add_skills="",
            remove_skills="",
        )
        result = handle_update(root, update_args)
        result["parsed"] = parsed
        return result

    create_args = argparse.Namespace(
        instruction=parsed["draft"].get("instruction") or text,
        name=parsed["draft"].get("name"),
        description=parsed["draft"].get("description"),
        schedule=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "schedule" else None,
        interval=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "interval" else None,
        rrule=parsed["draft"].get("triggerValue") if parsed["draft"].get("triggerType") == "rrule" else None,
        workflow_dispatch=str(parsed["draft"].get("workflowDispatch", True)).lower(),
        skills=",".join(parsed["draft"].get("skills", [])),
        file_slug="",
    )
    result = handle_create(root, create_args)
    result["parsed"] = parsed
    return result


def json_ok(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def json_fail(message: str, details: Any = None) -> None:
    payload = {"ok": False, "error": message}
    if details is not None:
        payload["details"] = details
    print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="manage-workflows.py", add_help=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--root", default="")
    list_parser.add_argument("--query", default="")
    list_parser.add_argument("--valid-only", action="store_true")
    list_parser.add_argument("--active-only", action="store_true")
    list_parser.add_argument("--running-only", action="store_true")

    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("--root", default="")
    create_parser.add_argument("--instruction", required=True)
    create_parser.add_argument("--name", default="")
    create_parser.add_argument("--description", default="")
    create_parser.add_argument("--schedule", default="")
    create_parser.add_argument("--interval", default="")
    create_parser.add_argument("--rrule", default="")
    create_parser.add_argument("--workflow-dispatch", default="true")
    create_parser.add_argument("--skills", default="")
    create_parser.add_argument("--file-slug", default="")

    update_parser = subparsers.add_parser("update")
    update_parser.add_argument("--root", default="")
    update_parser.add_argument("--slug", default="")
    update_parser.add_argument("--query", default="")
    update_parser.add_argument("--name", default="")
    update_parser.add_argument("--description", default="")
    update_parser.add_argument("--instruction", default="")
    update_parser.add_argument("--schedule", default="")
    update_parser.add_argument("--interval", default="")
    update_parser.add_argument("--rrule", default="")
    update_parser.add_argument("--clear-schedule", action="store_true")
    update_parser.add_argument("--clear-interval", action="store_true")
    update_parser.add_argument("--clear-rrule", action="store_true")
    update_parser.add_argument("--workflow-dispatch", default="")
    update_parser.add_argument("--skills", default="")
    update_parser.add_argument("--add-skills", default="")
    update_parser.add_argument("--remove-skills", default="")

    delete_parser = subparsers.add_parser("delete")
    delete_parser.add_argument("--root", default="")
    delete_parser.add_argument("--slug", default="")
    delete_parser.add_argument("--query", default="")

    from_text_parser = subparsers.add_parser("from-text")
    from_text_parser.add_argument("--root", default="")
    from_text_parser.add_argument("--text", required=True)

    apply_text_parser = subparsers.add_parser("apply-text")
    apply_text_parser.add_argument("--root", default="")
    apply_text_parser.add_argument("--text", required=True)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    root = resolve_root(args)

    try:
        if args.command == "list":
            result = handle_list(root, args)
        elif args.command == "create":
            result = handle_create(root, args)
        elif args.command == "update":
            result = handle_update(root, args)
        elif args.command == "delete":
            result = handle_delete(root, args)
        elif args.command == "from-text":
            result = handle_from_text(root, args)
        elif args.command == "apply-text":
            result = handle_apply_text(root, args)
        else:
            raise ValueError(f"Unsupported command: {args.command}")

        json_ok(result)
    except Exception as exc:  # noqa: BLE001
        json_fail(str(exc) or "Unexpected error")


if __name__ == "__main__":
    main()
