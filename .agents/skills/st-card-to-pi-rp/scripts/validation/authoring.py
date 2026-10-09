"""Authoring-facing validation helpers shared by manifest, module, and frontend checks.

These helpers have no dependency on validator layers. Keeping them here lets the
manifest, resources, and frontend modules depend on one lower-level module
without importing one another in a cycle.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .filesystem import safe_relative_path


SKILL_DESCRIPTION_LIMIT = 1024
SKILL_FRONTMATTER = re.compile(r"^---\r?\n(?P<body>.*?)(?:\r?\n)?^---(?:\r?\n|$)", re.DOTALL | re.MULTILINE)


def _skill_scalar(body: str, field: str) -> str | None:
    match = re.search(rf"^{field}:[ \t]*(.*?)[ \t]*$", body, re.MULTILINE)
    if match is None:
        return None
    raw = match.group(1).strip()
    if not raw or raw in {"|", ">", "|-", ">-"}:
        return None
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1].strip()
    return raw or None


def validate_skill_frontmatter(root: Path, value: Any, label: str, errors: list[str]) -> None:
    """Require the header that makes a Skill loadable, not merely the presence of the file."""
    if not safe_relative_path(value):
        return
    path = root / value
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        errors.append(f"{label} cannot be read: {error}")
        return
    match = SKILL_FRONTMATTER.match(text.replace("\r\n", "\n"))
    if match is None:
        errors.append(f"{label} must start with YAML frontmatter")
        return
    body = match.group("body")
    if not _skill_scalar(body, "name"):
        errors.append(f"{label} frontmatter must contain a one-line name")
    description = _skill_scalar(body, "description")
    if not description:
        errors.append(f"{label} frontmatter must contain a one-line description")
    elif len(description) > SKILL_DESCRIPTION_LIMIT:
        errors.append(f"{label} frontmatter description must be at most {SKILL_DESCRIPTION_LIMIT} characters")


def component_ref(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value))


def validate_director_prompt(text: str, agents: set[str], label: str, errors: list[str]) -> None:
    audience = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        opening = re.fullmatch(r"<!--\s*director-only:\s*(.*?)\s*-->", stripped)
        if opening:
            ids = [item.strip() for item in opening[1].split(",")]
            if audience or any(item not in agents for item in ids) or len(ids) != len(set(ids)):
                errors.append(f"{label}:{number}: nested director-only block or unknown/duplicate Agent ID")
            audience = True
        elif re.fullmatch(r"<!--\s*/director-only\s*-->", stripped):
            if not audience:
                errors.append(f"{label}:{number}: director-only closing marker has no opening marker")
            audience = False
        elif re.search(r"<!--\s*/?director-only\b", line):
            errors.append(f"{label}:{number}: director-only markers must be complete standalone comments")
    if audience:
        errors.append(f"{label}: director-only block is not closed")
