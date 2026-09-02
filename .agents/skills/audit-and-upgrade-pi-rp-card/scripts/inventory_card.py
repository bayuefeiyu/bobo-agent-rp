#!/usr/bin/env python3
"""Build a read-only maintenance inventory for one converted Pi RP card."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

IGNORED_PARTS = {".git", "node_modules", "__pycache__"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def file_map(root: Path | None) -> dict[str, str]:
    if root is None or not root.is_dir():
        return {}
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in IGNORED_PARTS for part in relative.parts):
            continue
        result[relative.as_posix()] = sha256_file(path)
    return result


def compare_trees(current: Path | None, upstream: Path | None) -> dict[str, Any]:
    current_files = file_map(current)
    upstream_files = file_map(upstream)
    current_names = set(current_files)
    upstream_names = set(upstream_files)
    shared = current_names & upstream_names
    modified = sorted(name for name in shared if current_files[name] != upstream_files[name])
    current_only = sorted(current_names - upstream_names)
    upstream_only = sorted(upstream_names - current_names)
    identical = sorted(name for name in shared if current_files[name] == upstream_files[name])
    if not current_files and not upstream_files:
        status = "both-missing-or-empty"
    elif not current_files:
        status = "current-missing"
    elif not upstream_files:
        status = "upstream-missing"
    elif not modified and not current_only and not upstream_only:
        status = "exact"
    else:
        status = "diverged"
    return {
        "status": status,
        "currentRoot": str(current.resolve()) if current and current.exists() else None,
        "upstreamRoot": str(upstream.resolve()) if upstream and upstream.exists() else None,
        "counts": {
            "identical": len(identical),
            "modified": len(modified),
            "currentOnly": len(current_only),
            "upstreamOnly": len(upstream_only),
        },
        "modified": modified,
        "currentOnly": current_only,
        "upstreamOnly": upstream_only,
    }


def manifest_references(manifest: dict[str, Any]) -> list[tuple[str, str]]:
    references: list[tuple[str, str]] = []

    def add(label: str, value: Any) -> None:
        if isinstance(value, str):
            references.append((label, value))

    add("cover", manifest.get("cover"))
    source = manifest.get("source")
    if isinstance(source, dict):
        add("source.artifact", source.get("artifact"))
    for field in ("fixed_context", "primary_characters", "context_processors", "feature_modules"):
        values = manifest.get(field)
        if isinstance(values, list):
            for index, value in enumerate(values):
                add(f"{field}[{index}]", value)
    for field in ("knowledge_map", "context_policy", "context_skill"):
        add(field, manifest.get(field))
    openings = manifest.get("openings")
    if isinstance(openings, list):
        for index, opening in enumerate(openings):
            if isinstance(opening, dict):
                add(f"openings[{index}].file", opening.get("file"))
    return references


def reference_inventory(card_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    entries = []
    for label, value in manifest_references(manifest):
        safe = safe_relative(value)
        target = card_root.joinpath(*PurePosixPath(value).parts) if safe else None
        entries.append({
            "label": label,
            "path": value,
            "safe": safe,
            "exists": bool(target and target.is_file()),
        })
    return {
        "entries": entries,
        "unsafe": [entry for entry in entries if not entry["safe"]],
        "missing": [entry for entry in entries if entry["safe"] and not entry["exists"]],
    }


def module_inventory(card_root: Path, project_root: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    modules = []
    declared = manifest.get("feature_modules")
    for value in declared if isinstance(declared, list) else []:
        if not safe_relative(value):
            modules.append({"manifestPath": value, "error": "unsafe-path"})
            continue
        definition_path = card_root.joinpath(*PurePosixPath(value).parts)
        definition = load_json(definition_path)
        if definition is None:
            modules.append({"manifestPath": value, "error": "missing-or-invalid-definition"})
            continue
        module_id = definition.get("id")
        module_root = definition_path.parent
        contract_file = definition.get("dataContractFile")
        contract = load_json(module_root / contract_file) if isinstance(contract_file, str) else None
        collections = contract.get("collections") if isinstance(contract, dict) and isinstance(contract.get("collections"), dict) else {}
        capabilities = contract.get("capabilities") if isinstance(contract, dict) and isinstance(contract.get("capabilities"), dict) else {}
        upstream = project_root / "global-modules" / str(module_id) if isinstance(module_id, str) else None
        modules.append({
            "id": module_id,
            "manifestPath": value,
            "surface": definition.get("surface"),
            "basedOn": definition.get("basedOn"),
            "dataContractVersion": contract.get("schemaVersion") if isinstance(contract, dict) else None,
            "collections": [
                {
                    "id": collection_id,
                    "recordTypes": sorted(record_type for record_type in collection.get("recordTypes", {}) if isinstance(record_type, str)),
                    "storageKind": collection.get("storage", {}).get("kind") if isinstance(collection.get("storage"), dict) else None,
                }
                for collection_id, collection in sorted(collections.items()) if isinstance(collection, dict)
            ],
            "capabilities": sorted(capabilities),
            "upstreamComparison": compare_trees(module_root, upstream),
        })
    return modules


def workflow_inventory(card_root: Path, project_root: Path, runtime_template: Path) -> list[dict[str, Any]]:
    workflows = []
    workflow_root = card_root / "workflows"
    if not workflow_root.is_dir():
        return workflows
    for definition_path in sorted(workflow_root.glob("*/workflow.json")):
        definition = load_json(definition_path)
        if definition is None:
            workflows.append({"path": definition_path.relative_to(card_root).as_posix(), "error": "invalid-json"})
            continue
        workflow_id = definition.get("id") or definition_path.parent.name
        candidates = [
            project_root / "play" / "workflows" / str(workflow_id) / "workflow.json",
            runtime_template / "workflows" / str(workflow_id) / "workflow.json",
        ]
        upstream_path = next((path for path in candidates if path.is_file()), None)
        upstream_definition = load_json(upstream_path) if upstream_path else None
        nodes = definition.get("nodes") if isinstance(definition.get("nodes"), list) else []
        workflows.append({
            "id": workflow_id,
            "path": definition_path.relative_to(card_root).as_posix(),
            "kind": definition.get("kind"),
            "revision": definition.get("revision"),
            "nodes": [
                {
                    "id": node.get("id"),
                    "type": node.get("type"),
                    "dependsOn": node.get("dependsOn", []),
                    "outputs": node.get("outputs", {}),
                    "moduleAccess": node.get("moduleAccess", []),
                    "dataCommit": node.get("dataCommit", {"onNodeEnd": []}),
                }
                for node in nodes if isinstance(node, dict)
            ],
            "upstreamPath": str(upstream_path.resolve()) if upstream_path else None,
            "matchesUpstream": bool(upstream_definition is not None and definition == upstream_definition),
            "byteMatchesUpstream": bool(upstream_path and sha256_file(definition_path) == sha256_file(upstream_path)),
        })
    return workflows


def run_validator(card_root: Path, project_root: Path) -> dict[str, Any]:
    validator = project_root / ".agents" / "skills" / "st-card-to-pi-rp" / "scripts" / "validate_card_pack.py"
    if not validator.is_file():
        return {"available": False, "passed": None, "exitCode": None, "output": ""}
    completed = subprocess.run(
        [sys.executable, str(validator), str(card_root)],
        cwd=project_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
    return {"available": True, "passed": completed.returncode == 0, "exitCode": completed.returncode, "output": output}


def git_revision(project_root: Path) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=project_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def build_inventory(card_root: Path, project_root: Path, updated_source: Path | None = None) -> dict[str, Any]:
    card_root = card_root.resolve()
    project_root = project_root.resolve()
    if not card_root.is_dir():
        raise ValueError(f"Card directory does not exist: {card_root}")
    manifest_path = card_root / "manifest.json"
    manifest = load_json(manifest_path)
    if manifest is None:
        raise ValueError(f"Missing or invalid manifest: {manifest_path}")

    converter_root = project_root / ".agents" / "skills" / "st-card-to-pi-rp"
    runtime_template = converter_root / "assets" / "pi-rp-runtime"
    web_template = converter_root / "assets" / "pi-rp-web"
    play_root = project_root / "play"
    updated = None
    if updated_source is not None:
        source_path = updated_source.resolve()
        updated = {
            "path": str(source_path),
            "exists": source_path.is_file(),
            "sha256": sha256_file(source_path) if source_path.is_file() else None,
        }

    return {
        "schemaVersion": 1,
        "projectRoot": str(project_root),
        "projectRevision": git_revision(project_root),
        "card": {
            "root": str(card_root),
            "id": manifest.get("id"),
            "name": manifest.get("name"),
            "manifestSha256": sha256_file(manifest_path),
            "fileCount": len(file_map(card_root)),
        },
        "references": reference_inventory(card_root, manifest),
        "modules": module_inventory(card_root, project_root, manifest),
        "workflows": workflow_inventory(card_root, project_root, runtime_template),
        "frontend": compare_trees(card_root / "web", web_template),
        "installedRuntime": {
            "pi": compare_trees(play_root / ".pi", runtime_template / ".pi"),
            "agents": compare_trees(play_root / "agents", runtime_template / "agents"),
            "workflows": compare_trees(play_root / "workflows", runtime_template / "workflows"),
        },
        "updatedSource": updated,
        "maintenance": load_json(card_root / "maintenance.json"),
        "validation": run_validator(card_root, project_root),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card", type=Path, help="Converted card-pack directory")
    parser.add_argument("--project-root", type=Path, default=Path.cwd(), help="Repository root (default: cwd)")
    parser.add_argument("--updated-source", type=Path, help="Optional updated source artifact to fingerprint")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args()
    try:
        inventory = build_inventory(args.card, args.project_root, args.updated_source)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(inventory, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
