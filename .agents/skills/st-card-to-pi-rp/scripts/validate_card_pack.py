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
    global_query_signatures: dict[str, str] = {}
    fields = {
        "schemaVersion", "id", "description", "phase", "contextOrder", "entryFile",
        "dependencies", "fragments", "failure",
    }
    dependency_fields = {"currentInput", "opening", "player", "messages", "dataQueries", "settings"}
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
        if processor.get("schemaVersion") != 2:
            errors.append(f"{label}.schemaVersion must be 2")
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
            if dependencies.get("messages") not in {"none", "all"}:
                errors.append(f"{label}.dependencies.messages must be none or all")
            queries = dependencies.get("dataQueries")
            if not isinstance(queries, list):
                errors.append(f"{label}.dependencies.dataQueries must be an array")
            else:
                query_ids: set[str] = set()
                for query_index, query in enumerate(queries):
                    query_label = f"{label}.dependencies.dataQueries[{query_index}]"
                    if not isinstance(query, dict):
                        errors.append(f"{query_label} must be an object")
                        continue
                    for field in ("id", "moduleId", "collectionId", "view"):
                        if not isinstance(query.get(field), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", query[field]):
                            errors.append(f"{query_label}.{field} is invalid")
                    if query.get("id") in query_ids:
                        errors.append(f"{query_label}.id is duplicated")
                    elif isinstance(query.get("id"), str):
                        query_ids.add(query["id"])
                        signature = json.dumps(query, ensure_ascii=False, sort_keys=True)
                        if query["id"] in global_query_signatures and global_query_signatures[query["id"]] != signature:
                            errors.append(f"{query_label}.id conflicts with another processor query")
                        global_query_signatures[query["id"]] = signature
                    if isinstance(query.get("moduleId"), str) and query["moduleId"] not in module_ids:
                        errors.append(f"{query_label}.moduleId references an unknown module")
                    if "limit" in query and (isinstance(query["limit"], bool) or not isinstance(query["limit"], int) or query["limit"] < 1):
                        errors.append(f"{query_label}.limit must be positive")
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
    required = {"schemaVersion", "source", "code", "agent"}
    if set(value) != required:
        errors.append(f"{label} must contain exactly {sorted(required)}")
    if value.get("schemaVersion") != 2 or value.get("source") != expected_source:
        errors.append(f"{label} must use schemaVersion 2 and source {expected_source!r}")
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


def validate_data_record_v2(value: Any, module_id: str, collection_id: str, record_type: str, label: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a record object")
        return
    required = {"protocolVersion", "id", "moduleId", "collectionId", "recordType", "dataSchemaVersion", "sequence", "revision", "status", "createdAt", "updatedAt", "binding", "data", "note", "provenance"}
    if set(value) != required:
        errors.append(f"{label} must use the exact record-envelope v2 field set")
    if value.get("protocolVersion") != 2 or value.get("moduleId") != module_id or value.get("collectionId") != collection_id or value.get("recordType") != record_type:
        errors.append(f"{label} has an invalid protocol/module/collection/recordType binding")
    if not isinstance(value.get("data"), dict):
        errors.append(f"{label}.data must be an object")


def validate_feature_modules(root: Path, values: Any, errors: list[str]) -> None:
    if not isinstance(values, list):
        errors.append("feature_modules must be an array")
        return
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    ids: set[str] = set()
    module_fields = {"schemaVersion", "id", "basedOn", "title", "description", "surface", "contextOrder", "displayOrder", "dataContractFile", "frontendViewFile", "skillFile"}
    index_types = {"string", "number", "boolean", "enum", "id", "id-list", "string-list", "time"}
    index_operators = {"eq", "neq", "contains", "in", "gt", "gte", "lt", "lte"}
    for index, path_value in enumerate(values):
        label = f"feature_modules[{index}]"
        if not safe_relative_path(path_value):
            errors.append(f"{label} must be a safe relative path")
            continue
        module_root = (root / path_value).parent
        module = load_json(root / path_value, errors)
        if not isinstance(module, dict):
            continue
        if set(module) != module_fields or module.get("schemaVersion") != 4:
            errors.append(f"{label} must use the exact module v4 field set")
            continue
        module_id = module.get("id")
        if not isinstance(module_id, str) or not safe_id.fullmatch(module_id):
            errors.append(f"{label}.id is invalid")
            continue
        if module_id in ids:
            errors.append(f"duplicate feature module id: {module_id}")
        ids.add(module_id)
        if module.get("basedOn") is not None and (not isinstance(module.get("basedOn"), str) or not safe_id.fullmatch(module["basedOn"])):
            errors.append(f"{label}.basedOn must be null or a safe module ID")
        if module.get("surface") not in {"frontend", "background"}:
            errors.append(f"{label}.surface is invalid")
        if not isinstance(module.get("contextOrder"), int) or not isinstance(module.get("displayOrder"), int):
            errors.append(f"{label} contextOrder and displayOrder must be integers")
        for field in ("dataContractFile", "frontendViewFile", "skillFile"):
            require_file(module_root, module.get(field), f"{label}.{field}", errors)
        view = load_json(module_root / str(module.get("frontendViewFile", "")), errors)
        if not isinstance(view, dict) or view.get("schemaVersion") != 1 or not isinstance(view.get("regions"), list):
            errors.append(f"{label}.frontendViewFile must contain schemaVersion 1 and a regions array")
        contract = load_json(module_root / str(module.get("dataContractFile", "")), errors)
        if not isinstance(contract, dict) or contract.get("schemaVersion") != 1 or contract.get("moduleId") != module_id or not isinstance(contract.get("collections"), dict) or not contract["collections"]:
            errors.append(f"{label}.dataContractFile must be a data contract v1 for {module_id}")
            continue
        collections = contract["collections"]
        for collection_id, collection in collections.items():
            collection_label = f"{label}.collections.{collection_id}"
            if not isinstance(collection_id, str) or not safe_id.fullmatch(collection_id) or not isinstance(collection, dict):
                errors.append(f"{collection_label} is invalid")
                continue
            storage = collection.get("storage")
            if not isinstance(storage, dict) or storage.get("kind") not in {"record-log", "snapshot", "hybrid"}:
                errors.append(f"{collection_label}.storage is invalid")
                continue
            partition = storage.get("partition", {"mode": "single"})
            if not isinstance(partition, dict) or partition.get("mode", "single") not in {"single", "index", "turn-range"}:
                errors.append(f"{collection_label}.storage.partition is invalid")
            record_types = collection.get("recordTypes")
            if not isinstance(record_types, dict) or not record_types:
                errors.append(f"{collection_label}.recordTypes must be a non-empty object")
                continue
            for record_type, definition in record_types.items():
                type_label = f"{collection_label}.recordTypes.{record_type}"
                if not isinstance(record_type, str) or not safe_id.fullmatch(record_type) or not isinstance(definition, dict):
                    errors.append(f"{type_label} is invalid")
                    continue
                if not isinstance(definition.get("dataSchemaVersion"), int) or definition["dataSchemaVersion"] < 1:
                    errors.append(f"{type_label}.dataSchemaVersion must be positive")
                identity = definition.get("identity")
                if identity is not None:
                    if not isinstance(identity, dict) or set(identity) - {"namePath", "aliasesPath"} or "namePath" not in identity:
                        errors.append(f"{type_label}.identity is invalid")
                    elif any(not isinstance(path, str) or not path.startswith("/data/") for path in identity.values()):
                        errors.append(f"{type_label}.identity paths must be below /data/")
                if definition.get("schemaFile") is not None:
                    require_file(module_root, definition.get("schemaFile"), f"{type_label}.schemaFile", errors)
                    if safe_relative_path(definition.get("schemaFile")) and (module_root / definition["schemaFile"]).is_file():
                        schema = load_json(module_root / definition["schemaFile"], errors)
                        if not isinstance(schema, dict):
                            errors.append(f"{type_label}.schemaFile must contain a JSON Schema object")
                indexes = definition.get("indexes", {})
                if not isinstance(indexes, dict):
                    errors.append(f"{type_label}.indexes must be an object")
                    indexes = {}
                for index_id, spec in indexes.items():
                    if not isinstance(spec, dict) or not isinstance(spec.get("path"), str) or not spec["path"].startswith("/data/") or spec.get("type") not in index_types:
                        errors.append(f"{type_label}.indexes.{index_id} is invalid")
                    elif any(operator not in index_operators for operator in spec.get("operators", ["eq"])):
                        errors.append(f"{type_label}.indexes.{index_id}.operators is invalid")
                views = definition.get("views", {})
                if not isinstance(views, dict):
                    errors.append(f"{type_label}.views must be an object")
                else:
                    for view_id, spec in views.items():
                        if not isinstance(spec, dict) or spec.get("format", "object") not in {"text", "object"} or not isinstance(spec.get("fields"), list) or not spec["fields"]:
                            errors.append(f"{type_label}.views.{view_id} is invalid")
                actions = definition.get("actions", [])
                if not isinstance(actions, list) or any(not isinstance(action, str) or not safe_id.fullmatch(action) for action in actions):
                    errors.append(f"{type_label}.actions must contain safe action IDs")
                    actions = []
                processors = definition.get("processors", {})
                if not isinstance(processors, dict):
                    errors.append(f"{type_label}.processors must be an object")
                else:
                    for action, processor in processors.items():
                        if action not in actions or not isinstance(processor, dict) or set(processor) != {"file", "export"}:
                            errors.append(f"{type_label}.processors.{action} is invalid")
                            continue
                        require_file(module_root, processor.get("file"), f"{type_label}.processors.{action}.file", errors)
                        if not isinstance(processor.get("export"), str) or not safe_id.fullmatch(processor["export"]):
                            errors.append(f"{type_label}.processors.{action}.export is invalid")
                for initial_field in ("initialRecordsFile", "initialSnapshotFile"):
                    initial_path = storage.get(initial_field)
                    if initial_path is not None:
                        require_file(module_root, initial_path, f"{collection_label}.storage.{initial_field}", errors)
                initial_records = storage.get("initialRecordsFile")
                if initial_records and safe_relative_path(initial_records) and (module_root / initial_records).is_file():
                    values_to_check = load_json(module_root / initial_records, errors)
                    if not isinstance(values_to_check, list):
                        errors.append(f"{collection_label}.initialRecordsFile must contain an array")
                    else:
                        for record_index, record in enumerate(values_to_check):
                            if isinstance(record, dict) and record.get("recordType") in record_types:
                                validate_data_record_v2(record, module_id, collection_id, record["recordType"], f"{collection_label}.initialRecords[{record_index}]", errors)
        capabilities = contract.get("capabilities", {})
        if not isinstance(capabilities, dict):
            errors.append(f"{label}.dataContractFile.capabilities must be an object")
        else:
            for capability_id, capability in capabilities.items():
                if not isinstance(capability_id, str) or not safe_id.fullmatch(capability_id) or not isinstance(capability, dict):
                    errors.append(f"{label}.capability {capability_id!r} is invalid")
                    continue
                unknown = set(capability.get("collections", [])) - set(collections)
                if unknown:
                    errors.append(f"{label}.capability {capability_id} references unknown collections: {sorted(unknown)}")
                actions = capability.get("actions", [])
                views = capability.get("views", [])
                if not isinstance(actions, list) or not isinstance(views, list):
                    errors.append(f"{label}.capability {capability_id} actions and views must be arrays")
                    continue
                for collection_id in capability.get("collections", []):
                    collection = collections.get(collection_id, {})
                    definitions = collection.get("recordTypes", {}).values() if isinstance(collection, dict) else []
                    declared_actions = {action for definition in definitions if isinstance(definition, dict) for action in definition.get("actions", [])}
                    type_definitions = [definition for definition in collection.get("recordTypes", {}).values() if isinstance(definition, dict)]
                    invalid_actions = set(actions) - declared_actions - {"query"}
                    invalid_views = {view for view in views if any(view not in definition.get("views", {}) for definition in type_definitions)}
                    if invalid_actions:
                        errors.append(f"{label}.capability {capability_id} has unsupported actions for {collection_id}: {sorted(invalid_actions)}")
                    if invalid_views:
                        errors.append(f"{label}.capability {capability_id} has undefined views for {collection_id}: {sorted(invalid_views)}")


def module_contract_map(root: Path) -> dict[str, dict[str, Any]]:
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for module_path in manifest.get("feature_modules", []) if isinstance(manifest, dict) else []:
        if not safe_relative_path(module_path):
            continue
        module = load_json(root / module_path, [])
        if not isinstance(module, dict) or not safe_relative_path(module.get("dataContractFile")):
            continue
        contract = load_json((root / module_path).parent / module["dataContractFile"], [])
        if isinstance(contract, dict) and isinstance(module.get("id"), str):
            result[module["id"]] = contract
    return result


def validate_workflows(root: Path, errors: list[str]) -> set[str]:
    workflow_root = root / "workflows"
    if not workflow_root.exists():
        return set()
    ids: set[str] = set()
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    allowed_kinds = {"foreground", "turn-background", "global-background"}
    allowed_types = {"agent", "code", "narrative", "gate", "join", "turn-finalize"}
    contracts = module_contract_map(root)
    for directory in sorted(path for path in workflow_root.iterdir() if path.is_dir()):
        label = f"workflows/{directory.name}/workflow.json"
        workflow = load_json(directory / "workflow.json", errors)
        if not isinstance(workflow, dict):
            continue
        workflow_id = workflow.get("id")
        if workflow.get("schemaVersion") != 2:
            errors.append(f"{label}.schemaVersion must be 2")
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
            outputs = node.get("outputs", {})
            if not isinstance(outputs, dict):
                errors.append(f"{node_label}.outputs must be an object")
                outputs = {}
            for output_id, output in outputs.items():
                if not isinstance(output_id, str) or not safe_id.fullmatch(output_id) or not isinstance(output, dict) or not safe_relative_path(output.get("path")):
                    errors.append(f"{node_label}.outputs.{output_id} is invalid")
                elif output.get("scope", "node") not in {"node", "workflow", "turn", "session", "public"}:
                    errors.append(f"{node_label}.outputs.{output_id}.scope is invalid")
                elif output.get("retain", "node") not in {"node", "run", "turn", "session", "permanent"}:
                    errors.append(f"{node_label}.outputs.{output_id}.retain is invalid")
            module_access = node.get("moduleAccess", [])
            if not isinstance(module_access, list):
                errors.append(f"{node_label}.moduleAccess must be an array")
            else:
                access_keys: set[tuple[str, str]] = set()
                for access_index, access in enumerate(module_access):
                    access_label = f"{node_label}.moduleAccess[{access_index}]"
                    if not isinstance(access, dict):
                        errors.append(f"{access_label} must be an object")
                        continue
                    module_id, collection_id = access.get("moduleId"), access.get("collectionId")
                    if module_id not in contracts or collection_id not in contracts.get(module_id, {}).get("collections", {}):
                        errors.append(f"{access_label} references an unknown module collection")
                        continue
                    key = (module_id, collection_id)
                    if key in access_keys:
                        errors.append(f"{node_label}.moduleAccess duplicates {module_id}/{collection_id}")
                    access_keys.add(key)
                    capabilities = access.get("capabilities", [])
                    views = access.get("views", [])
                    if not isinstance(capabilities, list) or not isinstance(views, list):
                        errors.append(f"{access_label} capabilities and views must be arrays")
                        continue
                    contract_capabilities = contracts[module_id].get("capabilities", {})
                    for capability_id in capabilities:
                        capability = contract_capabilities.get(capability_id) if isinstance(contract_capabilities, dict) else None
                        if not isinstance(capability, dict) or collection_id not in capability.get("collections", []):
                            errors.append(f"{access_label} capability {capability_id!r} is unknown or does not cover the collection")
                    allowed_views = {
                        view
                        for capability_id in capabilities
                        for view in (contract_capabilities.get(capability_id, {}).get("views", []) if isinstance(contract_capabilities, dict) else [])
                    }
                    if any(view not in allowed_views for view in views):
                        errors.append(f"{access_label}.views exceeds its capabilities")
                    budget = access.get("queryBudget")
                    if budget is not None and (not isinstance(budget, dict) or any(isinstance(budget.get(field), bool) or not isinstance(budget.get(field), int) or budget[field] < 1 for field in ("maxRecords", "maxCharacters"))):
                        errors.append(f"{access_label}.queryBudget is invalid")
            commit = node.get("dataCommit", {"onNodeEnd": []})
            if not isinstance(commit, dict) or not isinstance(commit.get("onNodeEnd"), list):
                errors.append(f"{node_label}.dataCommit.onNodeEnd must be an array")
            else:
                if "allowBestEffort" in commit and not isinstance(commit["allowBestEffort"], bool):
                    errors.append(f"{node_label}.dataCommit.allowBestEffort must be a boolean")
                for target in commit["onNodeEnd"]:
                    if not isinstance(target, dict) or (("output" in target) == ("path" in target)):
                        errors.append(f"{node_label}.dataCommit target must declare exactly one of output or path")
                    elif "output" in target and target["output"] not in outputs:
                        errors.append(f"{node_label}.dataCommit references unknown output {target['output']}")
                    elif "output" in target and outputs[target["output"]].get("format") != "unified-change-batch":
                        errors.append(f"{node_label}.dataCommit output {target['output']} must use unified-change-batch format")
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

        def ancestors_for(node_id: str) -> set[str]:
            result: set[str] = set()
            pending = list(by_id[node_id].get("dependsOn", []))
            while pending:
                dependency = pending.pop()
                if dependency in result or dependency not in by_id:
                    continue
                result.add(dependency)
                pending.extend(by_id[dependency].get("dependsOn", []))
            return result

        writers: dict[tuple[str, str], list[str]] = {}
        read_actions = {"query", "get"}
        for node_id, node in by_id.items():
            for access in node.get("moduleAccess", []) if isinstance(node.get("moduleAccess", []), list) else []:
                if not isinstance(access, dict):
                    continue
                contract = contracts.get(access.get("moduleId"), {})
                capabilities = contract.get("capabilities", {}) if isinstance(contract, dict) else {}
                actions = {action for capability_id in access.get("capabilities", []) for action in capabilities.get(capability_id, {}).get("actions", [])}
                if actions - read_actions:
                    writers.setdefault((access.get("moduleId"), access.get("collectionId")), []).append(node_id)
        for owner, owner_nodes in writers.items():
            for left_index, left in enumerate(owner_nodes):
                for right in owner_nodes[left_index + 1:]:
                    if left not in ancestors_for(right) and right not in ancestors_for(left):
                        errors.append(f"{label} has unordered writers {left} and {right} for {owner[0]}/{owner[1]}")
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
    context_agent_enabled = (
        isinstance(context_agent, dict)
        and context_agent.get("mode") != "disabled"
    )
    if context_agent_enabled and context_skill_path is None:
        errors.append("manifest context_skill is required when Agent message retrieval is enabled")
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
