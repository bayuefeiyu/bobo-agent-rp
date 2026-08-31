#!/usr/bin/env python3
"""Validate the structural contract of a converted Pi RP card pack."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

ALLOWED_STATUSES = {"mapped", "metadata-only", "unsupported", "unresolved", "duplicate"}
ALLOWED_TRANSFORMS = {
    "verbatim",
    "format-only",
    "split",
    "merged",
    "summary-anchor",
    "bridge",
    "generated-runtime",
}

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SIGNATURE = b"\xff\xd8\xff"


def supported_image_type(path: Path) -> str | None:
    try:
        head = path.read_bytes()[:12]
    except OSError:
        return None
    if head.startswith(PNG_SIGNATURE):
        return "image/png"
    if head.startswith(JPEG_SIGNATURE):
        return "image/jpeg"
    if len(head) >= 12 and head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def extracted_source_requires_cover(root: Path, manifest: dict[str, Any]) -> bool:
    candidates = [root / "source" / "extracted.json"]
    artifact = manifest.get("source", {}).get("artifact") if isinstance(manifest.get("source"), dict) else None
    if isinstance(artifact, str) and artifact.endswith(".json") and safe_relative_path(artifact):
        candidates.append(root / artifact)
    for path in candidates:
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        source = payload.get("source") if isinstance(payload, dict) else None
        if not isinstance(source, dict):
            continue
        if source.get("format") == "png":
            return True
        cover = source.get("cover")
        if isinstance(cover, dict) and cover.get("available") is True:
            return True
    return False


def load_json(path: Path, errors: list[str]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        errors.append(f"missing required file: {path.name}")
    except json.JSONDecodeError as error:
        errors.append(f"invalid JSON in {path.name}: {error}")
    except OSError as error:
        errors.append(f"cannot read {path.name}: {error}")
    return None


def safe_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts and "." != value


def require_file(root: Path, value: Any, label: str, errors: list[str]) -> None:
    if not safe_relative_path(value):
        errors.append(f"{label} is not a safe relative POSIX path: {value!r}")
        return
    if not (root / value).is_file():
        errors.append(f"{label} does not exist: {value}")


def declared_frontend_module_ids(root: Path, manifest: Any) -> set[str]:
    result: set[str] = set()
    if not isinstance(manifest, dict) or not isinstance(manifest.get("feature_modules"), list):
        return result
    for value in manifest["feature_modules"]:
        if not safe_relative_path(value):
            continue
        try:
            module = json.loads((root / value).read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if (
            isinstance(module, dict)
            and isinstance(module.get("id"), str)
            and module.get("surface") == "frontend"
        ):
            result.add(module["id"])
    return result


def declared_module_ids(root: Path, manifest: Any) -> set[str]:
    result: set[str] = set()
    if not isinstance(manifest, dict) or not isinstance(manifest.get("feature_modules"), list):
        return result
    for value in manifest["feature_modules"]:
        if not safe_relative_path(value):
            continue
        module = load_json(root / value, [])
        if isinstance(module, dict) and isinstance(module.get("id"), str):
            result.add(module["id"])
    return result


def validate_context_processors(root: Path, values: Any, module_ids: set[str], errors: list[str]) -> None:
    if not isinstance(values, list):
        errors.append("context_processors must be an array")
        return
    processor_ids: set[str] = set()
    fields = {
        "schemaVersion", "id", "description", "phase", "contextOrder", "entryFile",
        "dependencies", "fragments", "failure",
    }
    dependency_fields = {"currentInput", "opening", "player", "messages", "variables", "modules", "settings"}
    for index, path in enumerate(values):
        label = f"context_processors[{index}]"
        require_file(root, path, label, errors)
        if not safe_relative_path(path) or not (root / path).is_file():
            continue
        processor = load_json(root / path, errors)
        if not isinstance(processor, dict):
            errors.append(f"{label} must contain a JSON object")
            continue
        if set(processor) != fields:
            errors.append(f"{label} must contain exactly {sorted(fields)}")
        processor_id = processor.get("id")
        if processor.get("schemaVersion") != 1:
            errors.append(f"{label}.schemaVersion must be 1")
        if not isinstance(processor_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", processor_id):
            errors.append(f"{label}.id is invalid")
        elif processor_id in processor_ids:
            errors.append(f"duplicate context processor id: {processor_id}")
        else:
            processor_ids.add(processor_id)
        if not isinstance(processor.get("description"), str):
            errors.append(f"{label}.description must be a string")
        if processor.get("phase") != "before-narrative":
            errors.append(f"{label}.phase must be before-narrative")
        if isinstance(processor.get("contextOrder"), bool) or not isinstance(processor.get("contextOrder"), int):
            errors.append(f"{label}.contextOrder must be an integer")
        require_file(root, processor.get("entryFile"), f"{label}.entryFile", errors)
        dependencies = processor.get("dependencies")
        if not isinstance(dependencies, dict) or set(dependencies) != dependency_fields:
            errors.append(f"{label}.dependencies must contain exactly {sorted(dependency_fields)}")
        else:
            for field in ("currentInput", "opening", "player", "settings"):
                if not isinstance(dependencies.get(field), bool):
                    errors.append(f"{label}.dependencies.{field} must be boolean")
            for field in ("messages", "variables"):
                if dependencies.get(field) not in {"none", "all"}:
                    errors.append(f"{label}.dependencies.{field} must be none or all")
            modules = dependencies.get("modules")
            if not isinstance(modules, list) or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", item) for item in modules):
                errors.append(f"{label}.dependencies.modules must contain safe module IDs")
            elif len(set(modules)) != len(modules):
                errors.append(f"{label}.dependencies.modules must not contain duplicates")
            else:
                missing = sorted(set(modules) - module_ids)
                if missing:
                    errors.append(f"{label}.dependencies.modules references unknown modules: {missing}")
        fragments = processor.get("fragments")
        if not isinstance(fragments, list) or not fragments:
            errors.append(f"{label}.fragments must be a non-empty array")
        else:
            fragment_ids: set[str] = set()
            for fragment_index, fragment in enumerate(fragments):
                fragment_label = f"{label}.fragments[{fragment_index}]"
                if not isinstance(fragment, dict) or set(fragment) != {"id", "title", "file"}:
                    errors.append(f"{fragment_label} must contain exactly id, title, and file")
                    continue
                fragment_id = fragment.get("id")
                if not isinstance(fragment_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", fragment_id) or fragment_id in fragment_ids:
                    errors.append(f"{fragment_label}.id is invalid or duplicated")
                else:
                    fragment_ids.add(fragment_id)
                if not isinstance(fragment.get("title"), str) or not fragment["title"].strip():
                    errors.append(f"{fragment_label}.title must be a non-empty string")
                require_file(root, fragment.get("file"), f"{fragment_label}.file", errors)
        if processor.get("failure") not in {"error", "omit"}:
            errors.append(f"{label}.failure must be error or omit")


def validate_retrieval_policy(value: Any, expected_source: str, label: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a JSON object")
        return
    required = {"schemaVersion", "source", "code", "agent", "catalog"}
    if set(value) != required:
        errors.append(f"{label} must contain exactly {sorted(required)}")
    if value.get("schemaVersion") != 1 or value.get("source") != expected_source:
        errors.append(f"{label} must use schemaVersion 1 and source {expected_source!r}")
    code = value.get("code")
    if not isinstance(code, dict) or code.get("profile") not in {"default", "custom"}:
        errors.append(f"{label}.code.profile must be default or custom")
    elif code["profile"] == "custom" and (set(code) != {"profile", "selector"} or not isinstance(code.get("selector"), dict)):
        errors.append(f"{label}.code custom profile must contain exactly profile and selector")
    elif code["profile"] == "default" and set(code) != {"profile"}:
        errors.append(f"{label}.code default profile must not define a selector")
    if isinstance(code, dict) and code.get("profile") == "custom" and isinstance(code.get("selector"), dict):
        selector = code["selector"]
        selector_type = selector.get("type")
        if selector_type not in {"all", "latest", "ids", "range", "around", "latest_per_key"}:
            errors.append(f"{label}.code.selector.type is unsupported")
        if selector_type == "ids" and not isinstance(selector.get("ids"), list):
            errors.append(f"{label}.code.selector ids requires an ids array")
        if selector_type == "around" and not isinstance(selector.get("id"), str):
            errors.append(f"{label}.code.selector around requires id")
        if selector_type == "latest_per_key" and not isinstance(selector.get("path"), str):
            errors.append(f"{label}.code.selector latest_per_key requires path")
    agent = value.get("agent")
    if not isinstance(agent, dict):
        errors.append(f"{label}.agent must be an object")
    else:
        if set(agent) != {"mode", "fallback", "onNotTriggered", "maxRecords"}:
            errors.append(f"{label}.agent must contain exactly mode, fallback, onNotTriggered, and maxRecords")
        if agent.get("mode") not in {"disabled", "append", "override"}:
            errors.append(f"{label}.agent.mode must be disabled, append, or override")
        if agent.get("fallback") != "code":
            errors.append(f"{label}.agent.fallback must be code")
        if agent.get("onNotTriggered") not in {"code", "empty"}:
            errors.append(f"{label}.agent.onNotTriggered must be code or empty")
        if isinstance(agent.get("maxRecords"), bool) or not isinstance(agent.get("maxRecords"), int) or agent["maxRecords"] < 1:
            errors.append(f"{label}.agent.maxRecords must be a positive integer")
    catalog = value.get("catalog")
    if not isinstance(catalog, dict) or catalog.get("codeProfile") != "default" or catalog.get("agentMode") not in {"disabled", "append", "override"}:
        errors.append(f"{label}.catalog has invalid codeProfile or agentMode")
    elif set(catalog) != {"codeProfile", "agentMode"}:
        errors.append(f"{label}.catalog must contain exactly codeProfile and agentMode")


def validate_record(value: Any, expected_source: str, label: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a record object")
        return
    required = {"schemaVersion", "id", "source", "sequence", "revision", "createdAt", "updatedAt", "binding", "metadata", "data"}
    if not required.issubset(value):
        errors.append(f"{label} is missing common record-envelope fields")
    if value.get("schemaVersion") != 1 or value.get("source") != expected_source:
        errors.append(f"{label} must use schemaVersion 1 and source {expected_source!r}")
    if not isinstance(value.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", value["id"]):
        errors.append(f"{label}.id is invalid")
    for field, minimum in (("sequence", 0), ("revision", 1)):
        item = value.get(field)
        if isinstance(item, bool) or not isinstance(item, int) or item < minimum:
            errors.append(f"{label}.{field} must be an integer >= {minimum}")
    binding = value.get("binding")
    if not isinstance(binding, dict) or set(binding) != {"messageId", "turn"}:
        errors.append(f"{label}.binding must contain exactly messageId and turn")
    metadata = value.get("metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("recordType"), str) or not isinstance(metadata.get("entityIds"), list) or not isinstance(metadata.get("tags"), list):
        errors.append(f"{label}.metadata is invalid")
    if not isinstance(value.get("data"), dict):
        errors.append(f"{label}.data must be an object")


def validate_feature_modules(root: Path, values: Any, errors: list[str]) -> None:
    if not isinstance(values, list):
        errors.append("feature_modules must be an array")
        return
    required_fields = {
        "schemaVersion",
        "id",
        "title",
        "description",
        "surface",
        "contextOrder",
        "displayOrder",
        "storageFile",
        "viewFile",
        "skillFile",
    }
    ids: set[str] = set()
    variable_engine_count = 0
    for index, value in enumerate(values):
        label = f"feature_modules[{index}]"
        if not safe_relative_path(value):
            errors.append(f"{label} is not a safe relative POSIX path: {value!r}")
            continue
        module_path = root / value
        module = load_json(module_path, errors)
        if not isinstance(module, dict):
            errors.append(f"{label} must reference a JSON object")
            continue
        missing_fields = sorted(required_fields - module.keys())
        unexpected_fields = sorted(module.keys() - required_fields)
        if missing_fields:
            errors.append(f"{label} is missing required fields: {missing_fields}")
        if unexpected_fields:
            errors.append(f"{label} contains unexpected fields: {unexpected_fields}")
        if module.get("schemaVersion") != 3:
            errors.append(f"{label} schemaVersion must be 3")
        module_id = module.get("id")
        if not isinstance(module_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", module_id):
            errors.append(f"{label}.id must be filesystem-safe")
        elif module_id in ids:
            errors.append(f"duplicate feature module id: {module_id}")
        else:
            ids.add(module_id)

        if not isinstance(module.get("title"), str) or not module["title"].strip():
            errors.append(f"{label}.title must be a non-empty string")
        if not isinstance(module.get("description"), str):
            errors.append(f"{label}.description must be a string")
        if module.get("surface") not in {"frontend", "background"}:
            errors.append(f"{label}.surface must be frontend or background")
        for field in ("contextOrder", "displayOrder"):
            value_order = module.get(field)
            if isinstance(value_order, bool) or not isinstance(value_order, int):
                errors.append(f"{label}.{field} must be an integer")

        module_root = module_path.parent
        loaded: dict[str, Any] = {}
        for field in ("storageFile", "viewFile", "skillFile"):
            child = module.get(field)
            if not safe_relative_path(child):
                errors.append(f"{label}.{field} must be a safe relative path")
                continue
            child_path = module_root / child
            if not child_path.is_file():
                errors.append(f"{label}.{field} does not exist: {child}")
                continue
            if field in {"storageFile", "viewFile"}:
                value_data = load_json(child_path, errors)
                loaded[field] = value_data
                if field == "viewFile" and (
                    not isinstance(value_data, dict)
                    or value_data.get("schemaVersion") != 1
                    or not isinstance(value_data.get("regions"), list)
                ):
                    errors.append(f"{label}.viewFile must contain schemaVersion 1 and a regions array")
                elif field == "viewFile":
                    allowed_region_types = {"text", "markdown", "key-value", "list", "table", "json"}
                    for region_index, region in enumerate(value_data["regions"]):
                        region_label = f"{label}.viewFile.regions[{region_index}]"
                        if not isinstance(region, dict) or region.get("type") not in allowed_region_types:
                            errors.append(f"{region_label}.type must be one of {sorted(allowed_region_types)}")
                            continue
                        if region.get("path") is not None and not isinstance(region.get("path"), str):
                            errors.append(f"{region_label}.path must be a string")
                        if region.get("type") == "key-value" and not isinstance(region.get("fields"), list):
                            errors.append(f"{region_label}.fields must be an array")
                        if region.get("type") == "list" and not isinstance(region.get("item"), dict):
                            errors.append(f"{region_label}.item must be an object")
                        if region.get("type") == "table" and not isinstance(region.get("columns"), list):
                            errors.append(f"{region_label}.columns must be an array")
            else:
                skill_text = child_path.read_text(encoding="utf-8-sig")
                if not skill_text.strip():
                    errors.append(f"{label}.{field} must not be empty")
                elif not re.match(r"^---\r?\n[\s\S]*?^name:\s*\S+[\s\S]*?^description:\s*\S+[\s\S]*?^---", skill_text, re.MULTILINE):
                    errors.append(f"{label}.{field} must be a skill with name and one-line description frontmatter")

        storage = loaded.get("storageFile")
        if not isinstance(storage, dict):
            continue
        storage_fields = {"schemaVersion", "kind", "contextSource", "records", "snapshot", "catalogFile", "retrievalPolicyFile", "engine"}
        if set(storage) != storage_fields or storage.get("schemaVersion") != 2:
            errors.append(f"{label}.storageFile must use the exact schemaVersion 2 field set")
            continue
        kind = storage.get("kind")
        if kind not in {"record-log", "snapshot", "hybrid"}:
            errors.append(f"{label}.storageFile.kind is invalid")
        if storage.get("contextSource") not in {"records", "snapshot"}:
            errors.append(f"{label}.storageFile.contextSource is invalid")
        requires_records = kind in {"record-log", "hybrid"}
        requires_snapshot = kind in {"snapshot", "hybrid"}
        if requires_records != isinstance(storage.get("records"), dict):
            errors.append(f"{label}.storageFile.records does not match kind")
        if requires_snapshot != isinstance(storage.get("snapshot"), dict):
            errors.append(f"{label}.storageFile.snapshot does not match kind")
        if storage.get("contextSource") == "records" and not isinstance(storage.get("records"), dict):
            errors.append(f"{label}.storageFile cannot use unavailable records context")
        if storage.get("contextSource") == "snapshot" and not isinstance(storage.get("snapshot"), dict):
            errors.append(f"{label}.storageFile cannot use unavailable snapshot context")
        engine = storage.get("engine")
        variable_engine = (
            isinstance(engine, dict)
            and set(engine) == {"kind", "configFile"}
            and engine.get("kind") == "variables"
            and safe_relative_path(engine.get("configFile"))
        )
        output_engine = isinstance(engine, dict) and set(engine) == {"kind"} and engine.get("kind") == "post-narrative-output"
        if engine is not None and not variable_engine and not output_engine:
            errors.append(f"{label}.storageFile.engine must be null, a variables engine with a safe configFile, or a post-narrative-output engine")
            engine = None
        elif variable_engine:
            variable_engine_count += 1
            if kind != "hybrid" or storage.get("contextSource") != "snapshot":
                errors.append(f"{label} variables engine requires hybrid storage with snapshot context")
        elif output_engine:
            if kind != "record-log" or storage.get("contextSource") != "records":
                errors.append(f"{label} post-narrative-output engine requires record-log storage with records context")
            if module.get("surface") != "frontend":
                errors.append(f"{label} post-narrative-output engine must use the frontend surface")
        for stream_name in ("records", "snapshot"):
            stream = storage.get(stream_name)
            if not isinstance(stream, dict):
                continue
            if set(stream) != {"file", "initialFile", "schemaFile"}:
                errors.append(f"{label}.storageFile.{stream_name} must contain file, initialFile, and schemaFile")
                continue
            stream_paths_are_safe = True
            for field in ("file", "initialFile", "schemaFile"):
                if not safe_relative_path(stream.get(field)):
                    errors.append(f"{label}.storageFile.{stream_name}.{field} must be a safe relative path")
                    stream_paths_are_safe = False
            if not stream_paths_are_safe:
                continue
            initial_path = module_root / stream["initialFile"]
            schema_path = module_root / stream["schemaFile"]
            schema = load_json(schema_path, errors)
            if not isinstance(schema, dict):
                errors.append(f"{label}.{stream_name}.schemaFile must contain a JSON schema object")
            elif output_engine and stream_name == "records":
                properties = schema.get("properties")
                if (
                    schema.get("type") != "object"
                    or schema.get("additionalProperties") is not False
                    or schema.get("required") != ["content"]
                    or not isinstance(properties, dict)
                    or set(properties) != {"content"}
                    or not isinstance(properties.get("content"), dict)
                    or properties["content"].get("type") != "string"
                ):
                    errors.append(f"{label}.records.schemaFile for post-narrative-output must define exactly one required string content field and disallow additional properties")
            initial = load_json(initial_path, errors)
            source = f"module:{module_id}"
            if stream_name == "records":
                if not isinstance(initial, list):
                    errors.append(f"{label}.records.initialFile must contain an array")
                else:
                    for record_index, record in enumerate(initial):
                        validate_record(record, source, f"{label}.records.initialFile[{record_index}]", errors)
            elif initial is not None:
                validate_record(initial, source, f"{label}.snapshot.initialFile", errors)
        for field in ("catalogFile", "retrievalPolicyFile"):
            if not safe_relative_path(storage.get(field)):
                errors.append(f"{label}.storageFile.{field} must be a safe relative path")
        policy_path = module_root / storage.get("retrievalPolicyFile", "")
        policy = load_json(policy_path, errors)
        validate_retrieval_policy(policy, f"module:{module_id}", f"{label}.retrievalPolicyFile", errors)

        if variable_engine:
            config_path = module_root / engine["configFile"]
            config = load_json(config_path, errors)
            config_fields = {"schemaVersion", "schemaFile", "initial", "bindingsFile", "hooks", "context"}
            if not isinstance(config, dict) or set(config) != config_fields or config.get("schemaVersion") != 1:
                errors.append(f"{label}.variables config must use the exact schemaVersion 1 field set")
                continue
            for field in ("schemaFile", "bindingsFile"):
                require_file(module_root, config.get(field), f"{label}.variables.{field}", errors)
            initial = config.get("initial")
            if not isinstance(initial, dict) or set(initial) != {"defaultFile", "openingFiles"}:
                errors.append(f"{label}.variables.initial must contain defaultFile and openingFiles")
            else:
                require_file(module_root, initial.get("defaultFile"), f"{label}.variables.initial.defaultFile", errors)
                opening_files = initial.get("openingFiles")
                if not isinstance(opening_files, dict):
                    errors.append(f"{label}.variables.initial.openingFiles must be an object")
                else:
                    for opening_id, opening_file in opening_files.items():
                        if not isinstance(opening_id, str) or not opening_id:
                            errors.append(f"{label}.variables.initial.openingFiles contains an invalid opening ID")
                        require_file(module_root, opening_file, f"{label}.variables.initial.openingFiles[{opening_id!r}]", errors)
            hooks = config.get("hooks")
            if not isinstance(hooks, dict) or set(hooks) != {"normalizeFile", "afterUpdateFile"}:
                errors.append(f"{label}.variables.hooks must contain normalizeFile and afterUpdateFile")
            else:
                for hook_name, hook_file in hooks.items():
                    if hook_file is not None:
                        require_file(module_root, hook_file, f"{label}.variables.hooks.{hook_name}", errors)
            context = config.get("context")
            if not isinstance(context, dict) or set(context) != {"alwaysForNarrative"} or not isinstance(context.get("alwaysForNarrative"), list) or any(not isinstance(item, str) for item in context.get("alwaysForNarrative", [])):
                errors.append(f"{label}.variables.context must contain a string-array alwaysForNarrative")
            bindings_path = module_root / config.get("bindingsFile", "")
            bindings = load_json(bindings_path, errors) if bindings_path.is_file() else None
            if not isinstance(bindings, dict) or set(bindings) != {"schemaVersion", "bindings"} or bindings.get("schemaVersion") != 1 or not isinstance(bindings.get("bindings"), dict):
                errors.append(f"{label}.variables.bindingsFile must contain schemaVersion 1 and bindings")
            else:
                for binding_id, definition in bindings["bindings"].items():
                    binding_label = f"{label}.variables.bindings[{binding_id!r}]"
                    if not isinstance(binding_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", binding_id):
                        errors.append(f"{binding_label} has an invalid ID")
                    if not isinstance(definition, dict) or definition.get("shape") not in {"scalar", "object", "subtree"} or definition.get("missing") not in {"error", "omit", "empty"}:
                        errors.append(f"{binding_label} has an invalid shape or missing policy")
                        continue
                    has_path = isinstance(definition.get("path"), str)
                    has_paths = isinstance(definition.get("paths"), list) and all(isinstance(item, str) for item in definition["paths"])
                    expected = {"shape", "missing", "path" if has_path else "paths"}
                    if has_path == has_paths or set(definition) != expected:
                        errors.append(f"{binding_label} must define exactly one of path or paths")
                if isinstance(context, dict) and isinstance(context.get("alwaysForNarrative"), list):
                    missing_bindings = sorted(set(context["alwaysForNarrative"]) - set(bindings["bindings"]))
                    if missing_bindings:
                        errors.append(f"{label}.variables.context references unknown bindings: {missing_bindings}")

    if variable_engine_count > 1:
        errors.append("a card may define only one variables storage engine")


def validate_workflows(root: Path, errors: list[str]) -> set[str]:
    workflow_root = root / "workflows"
    if not workflow_root.exists():
        return set()
    ids: set[str] = set()
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    allowed_kinds = {"foreground", "turn-background", "global-background"}
    allowed_types = {"agent", "code", "narrative", "gate", "join", "module-output", "variable-update", "turn-finalize"}
    for directory in sorted(path for path in workflow_root.iterdir() if path.is_dir()):
        label = f"workflows/{directory.name}/workflow.json"
        workflow = load_json(directory / "workflow.json", errors)
        if not isinstance(workflow, dict):
            continue
        workflow_id = workflow.get("id")
        if workflow.get("schemaVersion") != 1:
            errors.append(f"{label}.schemaVersion must be 1")
        if not isinstance(workflow_id, str) or not safe_id.fullmatch(workflow_id):
            errors.append(f"{label}.id is invalid")
        elif workflow_id != directory.name:
            errors.append(f"{label}.id must match its directory")
        elif workflow_id in ids:
            errors.append(f"duplicate workflow id: {workflow_id}")
        else:
            ids.add(workflow_id)
        kind = workflow.get("kind")
        if kind not in allowed_kinds:
            errors.append(f"{label}.kind is invalid")
        nodes = workflow.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            errors.append(f"{label}.nodes must be a non-empty array")
            continue
        node_ids: set[str] = set()
        by_id: dict[str, dict[str, Any]] = {}
        for index, node in enumerate(nodes):
            node_label = f"{label}.nodes[{index}]"
            if not isinstance(node, dict):
                errors.append(f"{node_label} must be an object")
                continue
            node_id = node.get("id")
            if not isinstance(node_id, str) or not safe_id.fullmatch(node_id):
                errors.append(f"{node_label}.id is invalid")
                continue
            if node_id in node_ids:
                errors.append(f"{label} has duplicate node id {node_id}")
            node_ids.add(node_id)
            by_id[node_id] = node
            if node.get("type", "agent") not in allowed_types:
                errors.append(f"{node_label}.type is invalid")
        for node_id, node in by_id.items():
            dependencies = node.get("dependsOn", [])
            if not isinstance(dependencies, list) or any(item not in node_ids for item in dependencies):
                errors.append(f"{label} node {node_id} has invalid dependencies")
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                errors.append(f"{label} contains a dependency cycle at {node_id}")
                return
            if node_id in visited:
                return
            visiting.add(node_id)
            for dependency in by_id.get(node_id, {}).get("dependsOn", []):
                if dependency in by_id:
                    visit(dependency)
            visiting.discard(node_id)
            visited.add(node_id)

        for node_id in by_id:
            visit(node_id)
        types = {node.get("type", "agent") for node in by_id.values()}
        narrative_count = sum(1 for node in by_id.values() if node.get("type", "agent") == "narrative")
        if kind == "foreground" and (narrative_count != 1 or "turn-finalize" not in types):
            errors.append(f"{label} foreground workflow requires exactly one narrative and at least one turn-finalize node")
        elif kind == "foreground":
            narrative_id = next(node_id for node_id, node in by_id.items() if node.get("type", "agent") == "narrative")
            finalizers = [node_id for node_id, node in by_id.items() if node.get("type", "agent") == "turn-finalize"]

            def ancestors(node_id: str) -> set[str]:
                result: set[str] = set()
                pending = list(by_id[node_id].get("dependsOn", []))
                while pending:
                    dependency = pending.pop()
                    if dependency in result or dependency not in by_id:
                        continue
                    result.add(dependency)
                    pending.extend(by_id[dependency].get("dependsOn", []))
                return result

            if not any(narrative_id in ancestors(finalizer) for finalizer in finalizers):
                errors.append(f"{label} turn-finalize must run after narrative")
        if kind != "foreground" and "narrative" in types:
            errors.append(f"{label} background workflow cannot contain a narrative node")
    return ids


def validate_manifest(root: Path, manifest: Any, errors: list[str], warnings: list[str]) -> None:
    if not isinstance(manifest, dict):
        errors.append("manifest.json must contain an object")
        return
    if manifest.get("schema_version") != 1:
        errors.append("manifest schema_version must be 1")
    for field in ("id", "name"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            errors.append(f"manifest {field} must be a non-empty string")
    if isinstance(manifest.get("id"), str) and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", manifest["id"]):
        errors.append("manifest id must be filesystem-safe: letters, digits, dot, underscore, and hyphen only")
    if manifest.get("cover") is not None:
        require_file(root, manifest.get("cover"), "cover", errors)
        if safe_relative_path(manifest.get("cover")) and (root / manifest["cover"]).is_file():
            if supported_image_type(root / manifest["cover"]) is None:
                errors.append("cover must contain a valid PNG/APNG, JPEG, or WebP image")
    elif extracted_source_requires_cover(root, manifest):
        errors.append("manifest cover is required because the extracted source contains an authored card image")

    fixed_context = manifest.get("fixed_context")
    if not isinstance(fixed_context, list) or not fixed_context:
        errors.append("manifest fixed_context must be a non-empty array")
    else:
        for index, path in enumerate(fixed_context):
            require_file(root, path, f"fixed_context[{index}]", errors)

    require_file(root, manifest.get("knowledge_map"), "knowledge_map", errors)

    primary_characters = manifest.get("primary_characters", [])
    if not isinstance(primary_characters, list):
        errors.append("primary_characters must be an array")
    else:
        for index, path in enumerate(primary_characters):
            require_file(root, path, f"primary_characters[{index}]", errors)

    context_policy_path = manifest.get("context_policy")
    require_file(root, context_policy_path, "context_policy", errors)
    context_policy = None
    if safe_relative_path(context_policy_path) and (root / context_policy_path).is_file():
        context_policy = load_json(root / context_policy_path, errors)
        validate_retrieval_policy(context_policy, "messages", "context_policy", errors)
    context_skill_path = manifest.get("context_skill")
    context_agent = context_policy.get("agent") if isinstance(context_policy, dict) else None
    context_catalog = context_policy.get("catalog") if isinstance(context_policy, dict) else None
    context_agent_enabled = (
        isinstance(context_agent, dict)
        and isinstance(context_catalog, dict)
        and (context_agent.get("mode") != "disabled" or context_catalog.get("agentMode") != "disabled")
    )
    if context_agent_enabled and context_skill_path is None:
        errors.append("manifest context_skill is required when message Agent retrieval or catalog enrichment is enabled")
    if context_skill_path is not None:
        require_file(root, context_skill_path, "context_skill", errors)
        if safe_relative_path(context_skill_path) and (root / context_skill_path).is_file():
            skill_text = (root / context_skill_path).read_text(encoding="utf-8-sig")
            if not re.match(r"^---\r?\n[\s\S]*?^name:\s*\S+[\s\S]*?^description:\s*\S+[\s\S]*?^---", skill_text, re.MULTILINE):
                errors.append("context_skill must be a skill with name and one-line description frontmatter")

    validate_feature_modules(root, manifest.get("feature_modules"), errors)
    validate_context_processors(root, manifest.get("context_processors"), declared_module_ids(root, manifest), errors)

    openings = manifest.get("openings")
    if not isinstance(openings, list) or not openings:
        errors.append("manifest openings must be a non-empty array")
        return

    ids: set[str] = set()
    for index, opening in enumerate(openings):
        if not isinstance(opening, dict):
            errors.append(f"openings[{index}] must be an object")
            continue
        opening_id = opening.get("id")
        if not isinstance(opening_id, str) or not opening_id:
            errors.append(f"openings[{index}].id must be a non-empty string")
        elif opening_id in ids:
            errors.append(f"duplicate opening id: {opening_id}")
        else:
            ids.add(opening_id)
        require_file(root, opening.get("file"), f"openings[{index}].file", errors)
        recommended = opening.get("recommended_context", [])
        if not isinstance(recommended, list):
            errors.append(f"openings[{index}].recommended_context must be an array")
        else:
            for context_index, path in enumerate(recommended):
                require_file(root, path, f"openings[{index}].recommended_context[{context_index}]", errors)

    default_opening = manifest.get("default_opening")
    if default_opening not in ids:
        errors.append("default_opening must reference an existing opening ID")

    source = manifest.get("source")
    if not isinstance(source, dict):
        warnings.append("manifest source metadata is missing")
    elif source.get("artifact"):
        require_file(root, source["artifact"], "source.artifact", errors)


def validate_provenance(root: Path, provenance: Any, errors: list[str], warnings: list[str]) -> None:
    if not isinstance(provenance, dict):
        errors.append("provenance.json must contain an object")
        return
    if provenance.get("schema_version") != 1:
        errors.append("provenance schema_version must be 1")
    units = provenance.get("source_units")
    if not isinstance(units, list):
        errors.append("provenance source_units must be an array")
        return

    ids: set[str] = set()
    for index, unit in enumerate(units):
        label = f"source_units[{index}]"
        if not isinstance(unit, dict):
            errors.append(f"{label} must be an object")
            continue
        unit_id = unit.get("id")
        if not isinstance(unit_id, str) or not unit_id:
            errors.append(f"{label}.id must be a non-empty string")
        elif unit_id in ids:
            errors.append(f"duplicate source unit id: {unit_id}")
        else:
            ids.add(unit_id)

        status = unit.get("status")
        if status not in ALLOWED_STATUSES:
            errors.append(f"{label}.status must be one of {sorted(ALLOWED_STATUSES)}")
        if not isinstance(unit.get("original"), str) or not unit["original"].strip():
            errors.append(f"{label}.original must preserve the non-empty source text")

        targets = unit.get("targets", [])
        if not isinstance(targets, list):
            errors.append(f"{label}.targets must be an array")
            continue
        if status == "mapped" and not targets:
            errors.append(f"{label} is mapped but has no targets")
        for target_index, target in enumerate(targets):
            target_label = f"{label}.targets[{target_index}]"
            if not isinstance(target, dict):
                errors.append(f"{target_label} must be an object")
                continue
            require_file(root, target.get("file"), f"{target_label}.file", errors)
            if target.get("transform") not in ALLOWED_TRANSFORMS:
                errors.append(f"{target_label}.transform must be one of {sorted(ALLOWED_TRANSFORMS)}")

    generated = provenance.get("generated_passages", [])
    if not isinstance(generated, list):
        errors.append("generated_passages must be an array")
        return
    for index, passage in enumerate(generated):
        label = f"generated_passages[{index}]"
        if not isinstance(passage, dict):
            errors.append(f"{label} must be an object")
            continue
        require_file(root, passage.get("file"), f"{label}.file", errors)
        if passage.get("kind") not in {"summary-anchor", "bridge", "generated-runtime"}:
            errors.append(f"{label}.kind must be summary-anchor, bridge, or generated-runtime")
        based_on = passage.get("based_on", [])
        if passage.get("kind") != "generated-runtime" and not based_on:
            warnings.append(f"{label} has no source units in based_on")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card_pack", type=Path)
    arguments = parser.parse_args()
    root = arguments.card_pack.resolve()
    if not root.is_dir():
        parser.error(f"card pack directory does not exist: {root}")

    errors: list[str] = []
    warnings: list[str] = []
    manifest = load_json(root / "manifest.json", errors)
    card_settings = load_json(root / "settings.json", errors)
    provenance = load_json(root / "provenance.json", errors)
    validate_manifest(root, manifest, errors, warnings)
    validate_provenance(root, provenance, errors, warnings)
    workflow_ids = validate_workflows(root, errors)
    if isinstance(card_settings, dict):
        if card_settings.get("schemaVersion") != 1:
            errors.append("settings schemaVersion must be 1")
        if isinstance(manifest, dict) and card_settings.get("cardId") != manifest.get("id"):
            errors.append("settings cardId must match manifest id")
        if not isinstance(card_settings.get("settings"), dict):
            errors.append("settings settings must be an object")
        else:
            active_workflow = card_settings["settings"].get("activeWorkflowId")
            if active_workflow is not None and active_workflow not in workflow_ids:
                errors.append("settings activeWorkflowId must reference a card-local workflow")
            module_display = card_settings["settings"].get("featureModules")
            if module_display is not None:
                if not isinstance(module_display, dict) or set(module_display) != {"order", "hidden"}:
                    errors.append("settings featureModules must contain exactly order and hidden")
                else:
                    normalized_lists: dict[str, list[str]] = {}
                    for field in ("order", "hidden"):
                        values = module_display.get(field)
                        if not isinstance(values, list):
                            errors.append(f"settings featureModules.{field} must be an array")
                            continue
                        if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value) for value in values):
                            errors.append(f"settings featureModules.{field} contains an invalid module ID")
                        if len(values) != len(set(values)):
                            errors.append(f"settings featureModules.{field} must not contain duplicates")
                        normalized_lists[field] = values
                    if "order" in normalized_lists and "hidden" in normalized_lists:
                        missing = sorted(set(normalized_lists["hidden"]) - set(normalized_lists["order"]))
                        if missing:
                            errors.append(f"settings featureModules.hidden contains IDs absent from order: {missing}")
                        frontend_ids = declared_frontend_module_ids(root, manifest)
                        ordered_ids = set(normalized_lists["order"])
                        if ordered_ids != frontend_ids:
                            errors.append(
                                "settings featureModules.order must contain every frontend module and no background or unknown IDs"
                            )

    for required in ("source", "unresolved.md", "conversion-report.md"):
        if not (root / required).exists():
            errors.append(f"missing required path: {required}")

    for web_file in ("web/server.mjs", "web/public/index.html", "web/public/app.js", "web/public/markdown.js", "web/public/module-json.js", "web/public/styles.css"):
        if not (root / web_file).is_file():
            errors.append(f"missing card-local Web file: {web_file}")

    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    if errors:
        print(f"validation failed with {len(errors)} error(s) and {len(warnings)} warning(s)", file=sys.stderr)
        return 1
    print(f"validation passed with {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
