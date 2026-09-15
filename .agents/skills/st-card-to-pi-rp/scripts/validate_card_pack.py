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
RUNTIME_SERVICES = {"random"}


def validate_runtime_services(node: dict[str, Any], label: str, errors: list[str]) -> None:
    services = node.get("runtimeServices", [])
    if not isinstance(services, list) or any(not isinstance(service, str) for service in services):
        errors.append(f"{label}.runtimeServices must be a string array")
        return
    if len(services) != len(set(services)):
        errors.append(f"{label}.runtimeServices must not contain duplicates")
    if services and node.get("type", "agent") != "code":
        errors.append(f"{label}.runtimeServices is supported only for code nodes")
    unsupported = sorted(set(services) - RUNTIME_SERVICES)
    if unsupported:
        errors.append(f"{label}.runtimeServices contains unsupported services: {unsupported}")


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


def validate_frontend_view_v2(view: Any, contract: dict[str, Any], label: str, errors: list[str]) -> None:
    if not isinstance(view, dict) or set(view) != {"schemaVersion", "regions"} or view.get("schemaVersion") not in {1, 2} or not isinstance(view.get("regions"), list):
        errors.append(f"{label} must contain schemaVersion 1 or 2 and a regions array")
        return
    if view["schemaVersion"] == 1:
        return
    interactive = {"record-browser", "settings-form", "workflow-controls", "integrity-alerts"}
    legacy = {"text", "markdown", "json", "key-value", "list", "table", "image-generation"}
    seen: set[str] = set()
    collections = contract.get("collections", {})
    capabilities = contract.get("capabilities", {})
    for index, region in enumerate(view["regions"]):
        region_label = f"{label}.regions[{index}]"
        if not isinstance(region, dict) or region.get("type") not in interactive | legacy:
            errors.append(f"{region_label} has an unsupported type")
            continue
        if region.get("type") not in interactive:
            continue
        region_id = region.get("id")
        if not isinstance(region_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", region_id) or region_id in seen:
            errors.append(f"{region_label}.id is invalid or duplicate")
        else:
            seen.add(region_id)
        if not isinstance(region.get("title"), str) or not region["title"].strip():
            errors.append(f"{region_label}.title is required")
        if region.get("type") == "workflow-controls":
            workflows = region.get("workflows")
            if not isinstance(workflows, list) or not workflows:
                errors.append(f"{region_label}.workflows must be a non-empty array")
            elif any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("parameters", []), list) for item in workflows):
                errors.append(f"{region_label}.workflows is invalid")
            continue
        if region.get("type") == "integrity-alerts":
            action = region.get("action")
            if not isinstance(action, dict) or not all(isinstance(action.get(key), str) for key in ("workflowRegionId", "workflowId", "startTurnParameter", "endTurnParameter")):
                errors.append(f"{region_label}.action is invalid")
            coverage = region.get("coverage")
            if coverage is not None:
                if not isinstance(coverage, dict):
                    errors.append(f"{region_label}.coverage must be an object")
                    continue
                collection_id = coverage.get("collectionId")
                collection = collections.get(collection_id)
                record_types = [coverage.get("stateRecordType"), coverage.get("settingsRecordType"), coverage.get("coverageRecordType")]
                if not isinstance(collection, dict) or any(item not in collection.get("recordTypes", {}) for item in record_types):
                    errors.append(f"{region_label}.coverage references unknown records")
                    continue
                view_id = coverage.get("view")
                if any(view_id not in collection["recordTypes"][item].get("views", {}) for item in record_types):
                    errors.append(f"{region_label}.coverage view is not declared by every record type")
                read_capability = capabilities.get(coverage.get("readCapability"), {})
                if collection_id not in read_capability.get("collections", []) or "query" not in read_capability.get("actions", []) or view_id not in read_capability.get("views", []):
                    errors.append(f"{region_label}.coverage capability does not grant the declared view")
            continue
        collection_id = region.get("collectionId")
        collection = collections.get(collection_id)
        if not isinstance(collection, dict):
            errors.append(f"{region_label}.collectionId is unknown")
            continue
        record_types = region.get("recordTypes") if region.get("type") == "record-browser" else [region.get("recordType")]
        if not isinstance(record_types, list) or not record_types or any(item not in collection.get("recordTypes", {}) for item in record_types):
            errors.append(f"{region_label} references unknown record types")
            continue
        view_id = region.get("view")
        if any(view_id not in collection["recordTypes"][item].get("views", {}) for item in record_types):
            errors.append(f"{region_label}.view is not declared by every record type")
        read_capability = capabilities.get(region.get("readCapability"), {})
        if collection_id not in read_capability.get("collections", []) or "query" not in read_capability.get("actions", []) or view_id not in read_capability.get("views", []):
            errors.append(f"{region_label}.readCapability does not grant the declared view")
        if region.get("type") == "settings-form":
            update_capability = capabilities.get(region.get("updateCapability"), {})
            if collection_id not in update_capability.get("collections", []) or "update" not in update_capability.get("actions", []):
                errors.append(f"{region_label}.updateCapability does not grant update")
            if not isinstance(region.get("recordId"), str) or not isinstance(region.get("fields"), list) or not region["fields"]:
                errors.append(f"{region_label} requires recordId and editable fields")
    workflow_regions = {region.get("id"): region for region in view["regions"] if isinstance(region, dict) and region.get("type") == "workflow-controls"}
    for index, region in enumerate(view["regions"]):
        if not isinstance(region, dict) or region.get("type") != "integrity-alerts" or not isinstance(region.get("action"), dict):
            continue
        action = region["action"]
        workflow_region = workflow_regions.get(action.get("workflowRegionId"))
        workflow = next((item for item in workflow_region.get("workflows", []) if isinstance(item, dict) and item.get("id") == action.get("workflowId")), None) if workflow_region else None
        if workflow is None:
            errors.append(f"{label}.regions[{index}].action references an undeclared workflow control")


def validate_resource_catalog(module_root: Path, catalog: Any, module_id: str, label: str, errors: list[str]) -> None:
    fields = {"schemaVersion", "moduleId", "categories", "selectionGroups", "documents"}
    if not isinstance(catalog, dict) or set(catalog) != fields or catalog.get("schemaVersion") != 1 or catalog.get("moduleId") != module_id:
        errors.append(f"{label} must be an exact resource catalog v1 for {module_id}")
        return
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    categories = catalog.get("categories")
    if not isinstance(categories, dict) or not categories:
        errors.append(f"{label}.categories must be a non-empty object")
        categories = {}
    else:
        for category_id, category in categories.items():
            if not isinstance(category_id, str) or not safe_id.fullmatch(category_id) or not isinstance(category, dict) or set(category) != {"title", "description"} or not isinstance(category.get("title"), str) or not category["title"].strip() or not isinstance(category.get("description"), str):
                errors.append(f"{label}.categories.{category_id} is invalid")
    groups = catalog.get("selectionGroups")
    if not isinstance(groups, dict):
        errors.append(f"{label}.selectionGroups must be an object")
        groups = {}
    else:
        for group_id, group in groups.items():
            if not isinstance(group_id, str) or not safe_id.fullmatch(group_id) or not isinstance(group, dict) or set(group) != {"title", "mode", "instruction", "fallback"}:
                errors.append(f"{label}.selectionGroups.{group_id} is invalid")
                continue
            if group.get("mode") not in {"one", "at-most-one", "one-or-more", "any"} or not isinstance(group.get("title"), str) or not group["title"].strip() or not isinstance(group.get("instruction"), str) or not group["instruction"].strip() or (group.get("fallback") is not None and (not isinstance(group["fallback"], str) or not safe_id.fullmatch(group["fallback"]))):
                errors.append(f"{label}.selectionGroups.{group_id} is invalid")
    documents = catalog.get("documents")
    if not isinstance(documents, list):
        errors.append(f"{label}.documents must be an array")
        return
    document_fields = {"id", "path", "title", "summary", "categories", "subcategory", "readPolicy", "authority", "appliesAt", "priority", "selectionGroup", "readWhen", "perspective", "aliases", "related", "sources"}
    ids: set[str] = set()
    paths: set[str] = set()
    valid_documents: list[dict[str, Any]] = []
    for index, document in enumerate(documents):
        document_label = f"{label}.documents[{index}]"
        if not isinstance(document, dict) or set(document) != document_fields:
            errors.append(f"{document_label} must use the exact document field set")
            continue
        document_id, document_path = document.get("id"), document.get("path")
        if not isinstance(document_id, str) or not safe_id.fullmatch(document_id) or document_id in ids:
            errors.append(f"{document_label}.id is invalid or duplicated")
            continue
        ids.add(document_id)
        if not safe_relative_path(document_path) or not str(document_path).startswith("documents/") or not str(document_path).lower().endswith(".md") or document_path in paths:
            errors.append(f"{document_label}.path must be a unique Markdown file below documents/")
        else:
            paths.add(document_path)
            require_file(module_root, document_path, f"{document_label}.path", errors)
        document_categories = document.get("categories")
        if not isinstance(document_categories, list) or not document_categories or any(not isinstance(item, str) or not safe_id.fullmatch(item) for item in document_categories) or len(document_categories) != len(set(document_categories)) or any(item not in categories for item in document_categories):
            errors.append(f"{document_label}.categories must reference unique declared categories")
        subcategory = document.get("subcategory")
        if subcategory is not None and (not isinstance(subcategory, str) or not safe_id.fullmatch(subcategory)):
            errors.append(f"{document_label}.subcategory must be null or a safe ID")
        if document.get("readPolicy") not in {"required", "conditional", "choice", "optional"}:
            errors.append(f"{document_label}.readPolicy is invalid")
        if document.get("authority") not in {"binding", "canonical", "advisory", "exploratory"}:
            errors.append(f"{document_label}.authority is invalid")
        applies_at = document.get("appliesAt")
        if not isinstance(applies_at, list) or any(not isinstance(item, str) or item not in {"analysis", "retrieval", "planning", "writing", "checking", "archiving"} for item in applies_at) or len(applies_at) != len(set(applies_at)):
            errors.append(f"{document_label}.appliesAt is invalid")
        selection_group = document.get("selectionGroup")
        if (document.get("readPolicy") == "choice") != isinstance(selection_group, str) or (isinstance(selection_group, str) and selection_group not in groups):
            errors.append(f"{document_label}.selectionGroup must name a declared group exactly for choice documents")
        for field in ("readWhen", "aliases", "related", "sources"):
            value = document.get(field)
            if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value) or len(value) != len(set(value)):
                errors.append(f"{document_label}.{field} must be a unique string array")
        if not isinstance(document.get("priority"), int) or isinstance(document.get("priority"), bool) or not isinstance(document.get("title"), str) or not document["title"].strip() or not isinstance(document.get("summary"), str) or not document["summary"].strip() or not isinstance(document.get("perspective"), str) or not document["perspective"].strip():
            errors.append(f"{document_label} has invalid title, summary, perspective, or priority")
        valid_documents.append(document)
    for document in valid_documents:
        if any(related not in ids for related in document.get("related", [])):
            errors.append(f"{label} document {document.get('id')} references an unknown related document")
    for group_id, group in groups.items():
        members = [document for document in valid_documents if document.get("selectionGroup") == group_id]
        if not members:
            errors.append(f"{label} selection group {group_id} has no members")
        elif group.get("fallback") is not None and all(document.get("id") != group["fallback"] for document in members):
            errors.append(f"{label} selection group {group_id} fallback is not a member")
    documents_root = module_root / "documents"
    actual_paths = {
        path.relative_to(module_root).as_posix()
        for path in documents_root.rglob("*.md")
        if path.is_file()
    } if documents_root.is_dir() else set()
    if actual_paths != paths:
        for path in sorted(actual_paths - paths):
            errors.append(f"{label} contains an unlisted resource document: {path}")


def validate_feature_modules(root: Path, values: Any, errors: list[str]) -> None:
    if not isinstance(values, list):
        errors.append("feature_modules must be an array")
        return
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    ids: set[str] = set()
    module_fields = {"schemaVersion", "id", "moduleKind", "basedOn", "title", "description", "surface", "contextOrder", "displayOrder", "dataContractFile", "resourceCatalogFile", "frontendViewFile", "skillFile", "workflowFiles"}
    index_types = {"string", "number", "boolean", "enum", "id", "id-list", "string-list", "time"}
    index_operators = {"eq", "neq", "contains", "in", "gt", "gte", "lt", "lte"}
    all_module_workflows = module_workflow_map(root)
    allowed_node_types = {"agent", "team", "code", "call", "gate", "join", "workflow-return", "turn-finalize"}
    for index, path_value in enumerate(values):
        label = f"feature_modules[{index}]"
        if not safe_relative_path(path_value):
            errors.append(f"{label} must be a safe relative path")
            continue
        module_root = (root / path_value).parent
        module = load_json(root / path_value, errors)
        if not isinstance(module, dict):
            continue
        if set(module) != module_fields or module.get("schemaVersion") != 6:
            errors.append(f"{label} must use the exact module v6 field set")
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
        module_kind = module.get("moduleKind")
        if module_kind not in {"data", "resource", "hybrid"}:
            errors.append(f"{label}.moduleKind is invalid")
            continue
        has_data = module_kind in {"data", "hybrid"}
        has_resources = module_kind in {"resource", "hybrid"}
        if has_data != isinstance(module.get("dataContractFile"), str):
            errors.append(f"{label}.dataContractFile must match moduleKind {module_kind}")
        if has_resources != isinstance(module.get("resourceCatalogFile"), str):
            errors.append(f"{label}.resourceCatalogFile must match moduleKind {module_kind}")
        if module.get("surface") == "frontend" and not has_data:
            errors.append(f"{label} resource-only modules must use background surface")
        if (module.get("surface") == "frontend") != isinstance(module.get("frontendViewFile"), str):
            errors.append(f"{label}.frontendViewFile must be present exactly for frontend modules")
        if not isinstance(module.get("contextOrder"), int) or not isinstance(module.get("displayOrder"), int):
            errors.append(f"{label} contextOrder and displayOrder must be integers")
        for field in ("skillFile",):
            require_file(module_root, module.get(field), f"{label}.{field}", errors)
        for field in ("dataContractFile", "resourceCatalogFile", "frontendViewFile"):
            if module.get(field) is not None:
                require_file(module_root, module.get(field), f"{label}.{field}", errors)
        owned_contract = load_json(module_root / module["dataContractFile"], []) if has_data and safe_relative_path(module.get("dataContractFile")) and (module_root / module["dataContractFile"]).is_file() else {}
        workflow_files = module.get("workflowFiles")
        if not isinstance(workflow_files, list) or not workflow_files:
            errors.append(f"{label}.workflowFiles must contain at least one module workflow")
        else:
            if len(workflow_files) != len(set(path for path in workflow_files if isinstance(path, str))):
                errors.append(f"{label}.workflowFiles must not contain duplicates")
            for workflow_index, workflow_path in enumerate(workflow_files):
                workflow_label = f"{label}.workflowFiles[{workflow_index}]"
                require_file(module_root, workflow_path, workflow_label, errors)
                if not safe_relative_path(workflow_path) or not (module_root / workflow_path).is_file():
                    continue
                owned = load_json(module_root / workflow_path, errors)
                if not isinstance(owned, dict) or owned.get("schemaVersion") != 3:
                    errors.append(f"{workflow_label} must contain a workflow v3 object")
                    continue
                if owned.get("kind") not in {"module-external", "module-internal"} or owned.get("ownerModuleId") != module_id:
                    errors.append(f"{workflow_label} must be a module workflow owned by {module_id}")
                instance_policy = owned.get("instancePolicy", {})
                if not isinstance(instance_policy, dict):
                    errors.append(f"{workflow_label}.instancePolicy must be an object")
                    instance_policy = {}
                instance_mode = instance_policy.get("mode", "multiple" if owned.get("kind") == "module-external" else "single")
                if instance_mode not in {"single", "multiple"}:
                    errors.append(f"{workflow_label}.instancePolicy.mode is invalid")
                owned_locks = owned.get("writeLocks")
                if owned.get("kind") == "module-internal" and owned_locks == []:
                    errors.append(f"{workflow_label}.writeLocks must not be empty")
                if owned_locks is not None:
                    if not isinstance(owned_locks, list):
                        errors.append(f"{workflow_label}.writeLocks must be an array")
                        owned_locks = []
                    seen_owned_locks: set[tuple[str, str | None]] = set()
                    for lock_index, lock in enumerate(owned_locks):
                        lock_label = f"{workflow_label}.writeLocks[{lock_index}]"
                        if not isinstance(lock, dict) or set(lock) - {"moduleId", "collectionId"} or lock.get("moduleId") != module_id:
                            errors.append(f"{lock_label} must name only the owner module and an optional collection")
                            continue
                        collection_id = lock.get("collectionId")
                        if collection_id is not None and collection_id not in owned_contract.get("collections", {}):
                            errors.append(f"{lock_label} references an unknown owner collection")
                        key = (module_id, collection_id)
                        if key in seen_owned_locks:
                            errors.append(f"{workflow_label}.writeLocks contains a duplicate lock")
                        seen_owned_locks.add(key)
                if owned.get("kind") == "module-internal" and instance_mode == "multiple":
                    if not isinstance(instance_policy.get("dedupeKey"), str) or not instance_policy["dedupeKey"].strip():
                        errors.append(f"{workflow_label}.instancePolicy.dedupeKey is required for multiple module-internal workflows")
                    maximum = instance_policy.get("maxConcurrentInstances")
                    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
                        errors.append(f"{workflow_label}.instancePolicy.maxConcurrentInstances must be a positive integer")
                    if not isinstance(owned_locks, list) or not owned_locks or any(not isinstance(lock, dict) or lock.get("collectionId") is None for lock in owned_locks):
                        errors.append(f"{workflow_label}.writeLocks must contain exact collection locks for multiple module-internal workflows")
                interface = owned.get("interface", {}) if isinstance(owned.get("interface", {}), dict) else {}
                interface_inputs = interface.get("inputs", {}) if isinstance(interface.get("inputs", {}), dict) else {}
                interface_exports = interface.get("exports", {}) if isinstance(interface.get("exports", {}), dict) else {}
                for input_id, definition in interface_inputs.items():
                    if not isinstance(definition, dict):
                        errors.append(f"{workflow_label}.interface.inputs.{input_id} is invalid")
                        continue
                    input_type = definition.get("type", "parameter")
                    input_kind = definition.get("kind", "file" if input_type == "document" else None)
                    if input_type == "document" and input_kind not in {"file", "directory", "either"}:
                        errors.append(f"{workflow_label}.interface.inputs.{input_id}.kind is invalid")
                    if input_type != "document" and "kind" in definition:
                        errors.append(f"{workflow_label}.interface.inputs.{input_id}.kind is supported only for document inputs")
                for export_id, definition in interface_exports.items():
                    if not isinstance(definition, dict):
                        errors.append(f"{workflow_label}.interface.exports.{export_id} is invalid")
                        continue
                    export_format = definition.get("format", "markdown")
                    export_kind = definition.get("kind", "directory" if export_format == "document-set" else "file")
                    if export_kind not in {"file", "directory"}:
                        errors.append(f"{workflow_label}.interface.exports.{export_id}.kind is invalid")
                    if export_format == "document-set" and export_kind != "directory":
                        errors.append(f"{workflow_label}.interface.exports.{export_id} document-set must use directory kind")
                owned_nodes = owned.get("nodes", [])
                if not isinstance(owned_nodes, list) or sum(1 for node in owned_nodes if isinstance(node, dict) and node.get("type") == "workflow-return") != 1:
                    errors.append(f"{workflow_label} must contain exactly one workflow-return node")
                if isinstance(owned_nodes, list):
                    for node_index, node in enumerate(owned_nodes):
                        if isinstance(node, dict):
                            owned_node_label = f"{workflow_label}.nodes[{node_index}]"
                            validate_runtime_services(node, owned_node_label, errors)
                            node_type = node.get("type", "agent")
                            if node_type not in allowed_node_types:
                                errors.append(f"{owned_node_label}.type is invalid")
                            if node_type == "team":
                                team = node.get("team")
                                if not isinstance(team, dict) or team.get("schemaVersion", 1) != 1:
                                    errors.append(f"{owned_node_label}.team must be a schemaVersion 1 object")
                                else:
                                    members = [team.get("leader"), team.get("secretary")]
                                    experts = team.get("experts", [])
                                    if not isinstance(experts, list):
                                        errors.append(f"{owned_node_label}.team.experts must be an array")
                                        experts = []
                                    members.extend(experts)
                                    member_ids: list[str] = []
                                    for member_index, member in enumerate(members):
                                        member_label = f"{owned_node_label}.team.members[{member_index}]"
                                        if not isinstance(member, dict):
                                            errors.append(f"{member_label} must be an object")
                                            continue
                                        if not isinstance(member.get("id"), str) or not safe_id.fullmatch(member["id"]):
                                            errors.append(f"{member_label}.id is invalid")
                                        else:
                                            member_ids.append(member["id"])
                                        if not isinstance(member.get("agentId"), str) or not safe_id.fullmatch(member["agentId"]):
                                            errors.append(f"{member_label}.agentId is invalid")
                                    if len(member_ids) != len(set(member_ids)):
                                        errors.append(f"{owned_node_label}.team member IDs must be unique")
                                    abilities = team.get("assistants", [])
                                    if not isinstance(abilities, list):
                                        errors.append(f"{owned_node_label}.team.assistants must be an array")
                                        abilities = []
                                    base_retrieval = team.get("baseRetrieval")
                                    if base_retrieval is not None:
                                        abilities = [*abilities, base_retrieval]
                                    ability_ids: list[str] = []
                                    required_calls: set[str] = set()
                                    for ability_index, ability in enumerate(abilities):
                                        ability_label = f"{owned_node_label}.team.abilities[{ability_index}]"
                                        if not isinstance(ability, dict):
                                            errors.append(f"{ability_label} must be an object")
                                            continue
                                        if not isinstance(ability.get("id"), str) or not safe_id.fullmatch(ability["id"]):
                                            errors.append(f"{ability_label}.id is invalid")
                                        else:
                                            ability_ids.append(ability["id"])
                                        ability_kind = ability.get("kind")
                                        if ability_kind not in {"workflow", "agent", "tool"}:
                                            errors.append(f"{ability_label}.kind is invalid")
                                        if ability.get("inputAdapter", "natural-language-v1") not in {"natural-language-v1", "memory-request-v1"}:
                                            errors.append(f"{ability_label}.inputAdapter is unsupported")
                                        if ability_kind == "workflow":
                                            target = ability.get("target")
                                            if target not in all_module_workflows:
                                                errors.append(f"{ability_label}.target must reference a declared module workflow")
                                            elif ability.get("enabled", True):
                                                required_calls.add(target)
                                        if ability_kind == "tool" and ability.get("adapter") != "declared-document-read-v1":
                                            errors.append(f"{ability_label}.adapter is unsupported")
                                    if len(ability_ids) != len(set(ability_ids)):
                                        errors.append(f"{owned_node_label}.team ability IDs must be unique")
                                    declared_calls = {binding if isinstance(binding, str) else binding.get("target") for binding in node.get("workflowCalls", []) if isinstance(binding, (str, dict))}
                                    missing_calls = sorted(required_calls - declared_calls)
                                    if missing_calls:
                                        errors.append(f"{owned_node_label}.team workflow abilities require matching workflowCalls: {missing_calls}")
                            if owned.get("kind") == "module-internal":
                                effective_locks = owned_locks if isinstance(owned_locks, list) else [{"moduleId": module_id, "collectionId": None}]
                                for access in node.get("moduleAccess", []) if isinstance(node.get("moduleAccess", []), list) else []:
                                    if not isinstance(access, dict) or access.get("moduleId") != module_id:
                                        continue
                                    collection_id = access.get("collectionId")
                                    capabilities = owned_contract.get("capabilities", {}) if isinstance(owned_contract, dict) else {}
                                    writable = any(
                                        isinstance(capabilities.get(capability_id), dict)
                                        and any(action != "query" for action in capabilities[capability_id].get("actions", []))
                                        for capability_id in access.get("capabilities", []) if isinstance(capability_id, str)
                                    )
                                    if writable and not any(isinstance(lock, dict) and lock.get("moduleId") == module_id and lock.get("collectionId") in {None, collection_id} for lock in effective_locks):
                                        errors.append(f"{workflow_label}.nodes[{node_index}] writable access to {collection_id} is not covered by workflow.writeLocks")
                if "trigger" in owned:
                    errors.append(f"{workflow_label} module workflows cannot declare triggers")
            if module_id == "card-context-library":
                if module_kind != "resource" or workflow_files != ["workflows/export-context/workflow.json"]:
                    errors.append(f"{label} card-context-library must be a resource module with only export-context")
                else:
                    export_workflow = load_json(module_root / workflow_files[0], errors)
                    interface = export_workflow.get("interface", {}) if isinstance(export_workflow, dict) else {}
                    inputs = interface.get("inputs", {}) if isinstance(interface, dict) else {}
                    exports = interface.get("exports", {}) if isinstance(interface, dict) else {}
                    categories_input = inputs.get("categories", {}) if isinstance(inputs, dict) else {}
                    context_export = exports.get("context", {}) if isinstance(exports, dict) else {}
                    if export_workflow.get("kind") != "module-external" or categories_input.get("type") != "parameter" or categories_input.get("required") is not True or categories_input.get("valueType") != "string-array" or context_export.get("format") != "document-set":
                        errors.append(f"{label} export-context must accept required category strings and export one document-set")
        if has_resources and safe_relative_path(module.get("resourceCatalogFile")) and (module_root / module["resourceCatalogFile"]).is_file():
            validate_resource_catalog(module_root, load_json(module_root / module["resourceCatalogFile"], errors), module_id, f"{label}.resourceCatalogFile", errors)
        if not has_data:
            continue
        view = load_json(module_root / module["frontendViewFile"], errors) if module.get("frontendViewFile") else None
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
        if view is not None:
            validate_frontend_view_v2(view, contract, f"{label}.frontendViewFile", errors)


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


def module_workflow_map(root: Path) -> dict[str, dict[str, Any]]:
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
        if not isinstance(module, dict) or not isinstance(module.get("id"), str):
            continue
        module_root = (root / module_path).parent
        for workflow_path in module.get("workflowFiles", []) if isinstance(module.get("workflowFiles"), list) else []:
            if not safe_relative_path(workflow_path):
                continue
            workflow = load_json(module_root / workflow_path, [])
            if isinstance(workflow, dict) and isinstance(workflow.get("id"), str):
                result[f"{module['id']}/{workflow['id']}"] = workflow
    return result


def module_resource_catalog_map(root: Path) -> dict[str, dict[str, Any]]:
    manifest = load_json(root / "manifest.json", [])
    result: dict[str, dict[str, Any]] = {}
    for module_path in manifest.get("feature_modules", []) if isinstance(manifest, dict) and isinstance(manifest.get("feature_modules"), list) else []:
        if not safe_relative_path(module_path):
            continue
        module = load_json(root / module_path, [])
        if not isinstance(module, dict) or not isinstance(module.get("id"), str) or not safe_relative_path(module.get("resourceCatalogFile")):
            continue
        catalog = load_json((root / module_path).parent / module["resourceCatalogFile"], [])
        if isinstance(catalog, dict):
            result[module["id"]] = catalog
    return result


def validate_workflows(root: Path, errors: list[str]) -> set[str]:
    workflow_root = root / "workflows"
    if not workflow_root.exists():
        return set()
    ids: set[str] = set()
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    allowed_kinds = {"foreground", "turn-background", "global-background"}
    allowed_types = {"agent", "code", "call", "team", "gate", "join", "turn-finalize"}
    contracts = module_contract_map(root)
    module_workflows = module_workflow_map(root)
    resource_catalogs = module_resource_catalog_map(root)
    for directory in sorted(path for path in workflow_root.iterdir() if path.is_dir()):
        label = f"workflows/{directory.name}/workflow.json"
        workflow = load_json(directory / "workflow.json", errors)
        if not isinstance(workflow, dict):
            continue
        workflow_id = workflow.get("id")
        if workflow.get("schemaVersion") != 3:
            errors.append(f"{label}.schemaVersion must be 3")
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
        write_locks = workflow.get("writeLocks", [])
        if not isinstance(write_locks, list):
            errors.append(f"{label}.writeLocks must be an array")
        else:
            if kind == "module-internal" and "writeLocks" in workflow and not write_locks:
                errors.append(f"{label}.writeLocks must not be empty for a module-internal workflow")
            seen_locks: set[tuple[str, str | None]] = set()
            for lock_index, lock in enumerate(write_locks):
                lock_label = f"{label}.writeLocks[{lock_index}]"
                if not isinstance(lock, dict) or set(lock) - {"moduleId", "collectionId"}:
                    errors.append(f"{lock_label} is invalid")
                    continue
                module_id, collection_id = lock.get("moduleId"), lock.get("collectionId")
                if module_id not in contracts or (collection_id is not None and collection_id not in contracts.get(module_id, {}).get("collections", {})):
                    errors.append(f"{lock_label} references an unknown module or collection")
                    continue
                key = (module_id, collection_id)
                if key in seen_locks:
                    errors.append(f"{label}.writeLocks contains duplicate {module_id}/{collection_id or '*'}")
                seen_locks.add(key)
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
            node_type = node.get("type", "agent")
            team_workflow_abilities: list[str] = []
            validate_runtime_services(node, node_label, errors)
            if node_type == "team":
                team = node.get("team")
                if not isinstance(team, dict) or team.get("schemaVersion", 1) != 1:
                    errors.append(f"{node_label}.team must be a schemaVersion 1 object")
                else:
                    members: list[dict[str, Any]] = []
                    for role in ("leader", "secretary"):
                        member = team.get(role)
                        if not isinstance(member, dict):
                            errors.append(f"{node_label}.team.{role} must be an object")
                        else:
                            members.append(member)
                    experts = team.get("experts", [])
                    if not isinstance(experts, list) or any(not isinstance(item, dict) for item in experts):
                        errors.append(f"{node_label}.team.experts must be an array of objects")
                    else:
                        members.extend(experts)
                    member_ids: list[str] = []
                    for member_index, member in enumerate(members):
                        member_label = f"{node_label}.team.members[{member_index}]"
                        member_id, agent_id = member.get("id"), member.get("agentId")
                        if not isinstance(member_id, str) or not safe_id.fullmatch(member_id):
                            errors.append(f"{member_label}.id is invalid")
                        else:
                            member_ids.append(member_id)
                        if not isinstance(agent_id, str) or not safe_id.fullmatch(agent_id):
                            errors.append(f"{member_label}.agentId is invalid")
                        if member.get("modelId") is not None and not isinstance(member.get("modelId"), str):
                            errors.append(f"{member_label}.modelId must be a string or null")
                        for text_field in ("focus", "prompt"):
                            if member.get(text_field) is not None and not isinstance(member.get(text_field), str):
                                errors.append(f"{member_label}.{text_field} must be a string")
                    if len(member_ids) != len(set(member_ids)):
                        errors.append(f"{node_label}.team member IDs must be unique")
                    abilities = team.get("assistants", [])
                    if not isinstance(abilities, list) or any(not isinstance(item, dict) for item in abilities):
                        errors.append(f"{node_label}.team.assistants must be an array of objects")
                        abilities = []
                    base_retrieval = team.get("baseRetrieval")
                    if base_retrieval is not None:
                        if not isinstance(base_retrieval, dict):
                            errors.append(f"{node_label}.team.baseRetrieval must be an object or null")
                        else:
                            abilities = [*abilities, base_retrieval]
                    ability_ids: list[str] = []
                    for ability_index, ability in enumerate(abilities):
                        ability_label = f"{node_label}.team.abilities[{ability_index}]"
                        ability_id, ability_kind = ability.get("id"), ability.get("kind")
                        if not isinstance(ability_id, str) or not safe_id.fullmatch(ability_id):
                            errors.append(f"{ability_label}.id is invalid")
                        else:
                            ability_ids.append(ability_id)
                        if ability_kind not in {"workflow", "agent", "tool"}:
                            errors.append(f"{ability_label}.kind is invalid")
                        input_adapter = ability.get("inputAdapter", "natural-language-v1")
                        if input_adapter not in {"natural-language-v1", "memory-request-v1"}:
                            errors.append(f"{ability_label}.inputAdapter is unsupported")
                        if ability_kind == "workflow":
                            if ability.get("target") not in module_workflows:
                                errors.append(f"{ability_label}.target must reference a declared module workflow")
                            elif ability.get("enabled", True):
                                team_workflow_abilities.append(ability["target"])
                        if ability_kind == "agent" and (not isinstance(ability.get("agentId"), str) or not safe_id.fullmatch(ability["agentId"])):
                            errors.append(f"{ability_label}.agentId is invalid")
                        if ability_kind == "tool" and (not isinstance(ability.get("adapter"), str) or not safe_id.fullmatch(ability["adapter"])):
                            errors.append(f"{ability_label}.adapter is invalid")
                        elif ability_kind == "tool" and ability.get("adapter") != "declared-document-read-v1":
                            errors.append(f"{ability_label}.adapter is unsupported")
                    if len(ability_ids) != len(set(ability_ids)):
                        errors.append(f"{node_label}.team ability IDs must be unique")
            if node_type == "call":
                target = node.get("target")
                target_workflow = module_workflows.get(target)
                if not isinstance(target, str) or target_workflow is None:
                    errors.append(f"{node_label}.target must reference a declared module workflow")
                else:
                    arguments = node.get("arguments", {})
                    documents = node.get("documents", {})
                    output_paths = node.get("outputPaths", {})
                    if not isinstance(arguments, dict) or not isinstance(documents, dict) or not isinstance(output_paths, dict):
                        errors.append(f"{node_label} call arguments, documents, and outputPaths must be objects")
                    else:
                        interface = target_workflow.get("interface", {}) if isinstance(target_workflow.get("interface"), dict) else {}
                        inputs = interface.get("inputs", {}) if isinstance(interface.get("inputs"), dict) else {}
                        exports = interface.get("exports", {}) if isinstance(interface.get("exports"), dict) else {}
                        for input_id, definition in inputs.items():
                            if not isinstance(definition, dict) or not definition.get("required"):
                                continue
                            input_type = definition.get("type", "parameter")
                            if input_type == "parameter" and input_id not in arguments:
                                errors.append(f"{node_label} is missing required parameter {input_id}")
                            if input_type == "document" and input_id not in documents:
                                errors.append(f"{node_label} is missing required document {input_id}")
                        if target == "card-context-library/export-context" and isinstance(arguments.get("categories"), list):
                            declared_categories = set(resource_catalogs.get("card-context-library", {}).get("categories", {}))
                            if not arguments["categories"] or any(category not in declared_categories for category in arguments["categories"]):
                                errors.append(f"{node_label}.arguments.categories must select declared card-context-library categories")
                        if set(output_paths) != set(exports):
                            errors.append(f"{node_label}.outputPaths must exactly match target exports")
                        declared_node_outputs = node.get("outputs", {}) if isinstance(node.get("outputs", {}), dict) else {}
                        for export_id, export_definition in exports.items():
                            output = declared_node_outputs.get(export_id)
                            export_format = export_definition.get("format", "markdown") if isinstance(export_definition, dict) else "markdown"
                            export_kind = export_definition.get("kind", "directory" if export_format == "document-set" else "file") if isinstance(export_definition, dict) else "file"
                            output_kind = output.get("kind", "directory" if output.get("format") == "document-set" else "file") if isinstance(output, dict) else None
                            if not isinstance(output, dict) or output.get("path") != output_paths.get(export_id) or output.get("format") != export_format or output_kind != export_kind:
                                errors.append(f"{node_label}.outputs.{export_id} must match the target export path, format, and kind")
            workflow_calls = node.get("workflowCalls", [])
            if not isinstance(workflow_calls, list):
                errors.append(f"{node_label}.workflowCalls must be an array")
            elif node_type not in {"agent", "code", "team"} and workflow_calls:
                errors.append(f"{node_label}.workflowCalls is supported only for agent, code, and team nodes")
            else:
                declared_workflow_calls = {binding if isinstance(binding, str) else binding.get("target") for binding in workflow_calls if isinstance(binding, (str, dict))}
                missing_team_calls = sorted(set(team_workflow_abilities) - declared_workflow_calls)
                if missing_team_calls:
                    errors.append(f"{node_label}.team workflow abilities require matching workflowCalls: {missing_team_calls}")
                seen_targets: set[str] = set()
                for call_index, raw_call in enumerate(workflow_calls):
                    call_label = f"{node_label}.workflowCalls[{call_index}]"
                    if isinstance(raw_call, str):
                        target, fixed_arguments, allowed_arguments = raw_call, {}, None
                    elif isinstance(raw_call, dict) and not set(raw_call) - {"target", "fixedArguments", "allowedArguments"}:
                        target = raw_call.get("target")
                        fixed_arguments = raw_call.get("fixedArguments", {})
                        allowed_arguments = raw_call.get("allowedArguments")
                    else:
                        errors.append(f"{call_label} is invalid")
                        continue
                    target_workflow = module_workflows.get(target)
                    if not isinstance(target, str) or target_workflow is None:
                        errors.append(f"{call_label}.target must reference a declared module workflow")
                        continue
                    if target in seen_targets:
                        errors.append(f"{node_label}.workflowCalls contains duplicate target {target}")
                    seen_targets.add(target)
                    if node_type == "agent" and target_workflow.get("agentCallable") is not True:
                        errors.append(f"{call_label}.target is not agentCallable")
                    if not isinstance(fixed_arguments, dict) or (allowed_arguments is not None and not isinstance(allowed_arguments, dict)):
                        errors.append(f"{call_label} fixedArguments and allowedArguments are invalid")
                        continue
                    overlap = set(fixed_arguments) & set(allowed_arguments or {})
                    if overlap:
                        errors.append(f"{call_label} cannot both fix and allow arguments {sorted(overlap)}")
                    parameter_inputs = {
                        input_id for input_id, definition in target_workflow.get("interface", {}).get("inputs", {}).items()
                        if isinstance(definition, dict) and definition.get("type", "parameter") == "parameter"
                    }
                    if (set(fixed_arguments) | set(allowed_arguments or {})) - parameter_inputs:
                        errors.append(f"{call_label} restricts arguments absent from the target interface")
                    for argument_id, allowed in (allowed_arguments or {}).items():
                        if not isinstance(allowed, list) or not allowed or any(not isinstance(value, (str, int, float, bool)) and value is not None for value in allowed):
                            errors.append(f"{call_label}.allowedArguments.{argument_id} must be a non-empty scalar array")
                    if target == "card-context-library/export-context" and isinstance((allowed_arguments or {}).get("categories"), list):
                        declared_categories = set(resource_catalogs.get("card-context-library", {}).get("categories", {}))
                        if any(category not in declared_categories for category in allowed_arguments["categories"]):
                            errors.append(f"{call_label}.allowedArguments.categories contains an undeclared resource category")
            if "blockNextTurn" in node:
                errors.append(f"{node_label}.blockNextTurn was replaced by trigger.blockNextTurnUntilReady")
            narrative_source = node.get("narrativeSource")
            if narrative_source is not None:
                if not isinstance(narrative_source, dict) or set(narrative_source) - {"layer", "characterId"}:
                    errors.append(f"{node_label}.narrativeSource may contain only layer and characterId")
                else:
                    if narrative_source.get("layer") not in {"unspecified", "in-world", "story", "authorial"}:
                        errors.append(f"{node_label}.narrativeSource.layer is invalid")
                    if narrative_source.get("characterId") is not None and (not isinstance(narrative_source.get("characterId"), str) or not safe_id.fullmatch(narrative_source["characterId"])):
                        errors.append(f"{node_label}.narrativeSource.characterId is invalid")
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
                elif output.get("kind", "directory" if output.get("format") == "document-set" else "file") not in {"file", "directory"}:
                    errors.append(f"{node_label}.outputs.{output_id}.kind is invalid")
                elif output.get("format") == "document-set" and output.get("kind", "directory") != "directory":
                    errors.append(f"{node_label}.outputs.{output_id} document-set must use directory kind")
            handoff = node.get("workspaceHandoff", {"include": []})
            if not isinstance(handoff, dict) or set(handoff) != {"include"} or not isinstance(handoff.get("include"), list):
                errors.append(f"{node_label}.workspaceHandoff must contain only an include array")
            else:
                handoff_outputs: set[str] = set()
                handoff_targets: list[str] = []
                for include_index, inclusion in enumerate(handoff["include"]):
                    include_label = f"{node_label}.workspaceHandoff.include[{include_index}]"
                    if not isinstance(inclusion, dict) or "output" not in inclusion or not set(inclusion).issubset({"output", "as"}):
                        errors.append(f"{include_label} must contain output and may contain as")
                        continue
                    output_id = inclusion.get("output")
                    if output_id not in outputs:
                        errors.append(f"{include_label} references unknown output {output_id}")
                        continue
                    if output_id in handoff_outputs:
                        errors.append(f"{node_label}.workspaceHandoff duplicates output {output_id}")
                    handoff_outputs.add(output_id)
                    target = inclusion.get("as", outputs[output_id].get("path"))
                    if not safe_relative_path(target) or "." in target.replace("\\", "/").split("/"):
                        errors.append(f"{include_label} target is invalid")
                        continue
                    normalized_target = target.replace("\\", "/")
                    if any(existing == normalized_target or existing.startswith(normalized_target + "/") or normalized_target.startswith(existing + "/") for existing in handoff_targets):
                        errors.append(f"{node_label}.workspaceHandoff target paths overlap at {normalized_target}")
                    handoff_targets.append(normalized_target)
                    output = outputs[output_id]
                    scope = output.get("scope", "node")
                    retain = output.get("retain", "node" if scope == "node" else "run" if scope == "workflow" else "turn" if scope == "turn" else "session")
                    if scope == "node" or retain == "node":
                        errors.append(f"{include_label} output must survive the producing node")
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
                        elif kind == "module-internal" and any(action != "query" for action in capability.get("actions", [])):
                            effective_locks = write_locks if "writeLocks" in workflow else [{"moduleId": workflow.get("ownerModuleId"), "collectionId": None}]
                            if not any(
                                isinstance(lock, dict)
                                and lock.get("moduleId") == module_id
                                and lock.get("collectionId") in {None, collection_id}
                                for lock in effective_locks
                            ):
                                errors.append(f"{access_label} writable capability {capability_id!r} is not covered by workflow.writeLocks")
                    allowed_views = {
                        view
                        for capability_id in capabilities
                        for view in (contract_capabilities.get(capability_id, {}).get("views", []) if isinstance(contract_capabilities, dict) else [])
                    }
                    if any(view not in allowed_views for view in views):
                        errors.append(f"{access_label}.views exceeds its capabilities")
                    budget = access.get("queryBudget")
                    if budget is not None:
                        if not isinstance(budget, dict) or set(budget) - {"maxRecords", "maxCharacters", "defaultRecords", "defaultCharacters", "parameter"} or any(isinstance(budget.get(field), bool) or not isinstance(budget.get(field), int) or budget[field] < 1 for field in ("maxRecords", "maxCharacters")):
                            errors.append(f"{access_label}.queryBudget is invalid")
                        elif any(field in budget and (isinstance(budget[field], bool) or not isinstance(budget[field], int) or budget[field] < 1 or budget[field] > budget[maximum]) for field, maximum in (("defaultRecords", "maxRecords"), ("defaultCharacters", "maxCharacters"))):
                            errors.append(f"{access_label}.queryBudget defaults are invalid")
                        elif "parameter" in budget and (not isinstance(budget["parameter"], str) or not safe_id.fullmatch(budget["parameter"])):
                            errors.append(f"{access_label}.queryBudget.parameter is invalid")
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
            route_field = node.get("routeFromOutput")
            if route_field is not None and (node.get("type", "agent") != "code" or not isinstance(route_field, str) or not safe_id.fullmatch(route_field)):
                errors.append(f"{label} node {node_id}.routeFromOutput must be a safe field ID on a code node")
            conditions = node.get("conditions", [])
            if not isinstance(conditions, list):
                errors.append(f"{label} node {node_id}.conditions must be an array")
            else:
                for condition_index, condition in enumerate(conditions):
                    condition_label = f"{label} node {node_id}.conditions[{condition_index}]"
                    if not isinstance(condition, dict) or set(condition) - {"nodeId", "routes", "statuses"}:
                        errors.append(f"{condition_label} is invalid")
                        continue
                    if condition.get("nodeId") not in node_ids:
                        errors.append(f"{condition_label}.nodeId references an unknown node")
                    routes = condition.get("routes", [])
                    if not isinstance(routes, list) or any(not isinstance(route, str) or not safe_id.fullmatch(route) for route in routes):
                        errors.append(f"{condition_label}.routes is invalid")
                    statuses = condition.get("statuses", ["completed"])
                    if not isinstance(statuses, list) or any(status not in {"completed", "skipped", "failed", "cancelled"} for status in statuses):
                        errors.append(f"{condition_label}.statuses is invalid")
            if node.get("type", "agent") == "agent" and node.get("metadata", {}).get("documentWorkspace") is True:
                context = node.get("context", {}) if isinstance(node.get("context", {}), dict) else {}
                sources = context.get("fromNodes") if isinstance(context.get("fromNodes"), list) and context.get("fromNodes") else dependencies
                for source_id in sources:
                    source = by_id.get(source_id, {})
                    indexed = source.get("metadata", {}).get("documentIndex", {}) if isinstance(source.get("metadata", {}), dict) else {}
                    included = {
                        item.get("output") for item in source.get("workspaceHandoff", {}).get("include", [])
                        if isinstance(item, dict)
                    }
                    for output_id in indexed if isinstance(indexed, dict) else []:
                        if output_id in source.get("outputs", {}) and output_id not in included:
                            errors.append(f"{label} node {source_id} documents {output_id} for {node_id} but does not include it in workspaceHandoff")
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

        if workflow_id in {"standard-rp", "advanced-memory-rp"}:
            context_call_ids = [node_id for node_id, node in by_id.items() if node.get("type") == "call" and node.get("target") == "card-context-library/export-context"]
            if not context_call_ids:
                errors.append(f"{label} must prepare card-context-library resources before narration")
            if workflow_id == "advanced-memory-rp" and context_call_ids:
                timeline_call_ids = [node_id for node_id, node in by_id.items() if node.get("type") == "call" and node.get("target") == "narrative-memory/narrative-memory-reference-snapshot" and isinstance(node.get("arguments", {}).get("timeline"), dict)]
                if not timeline_call_ids or not any(timeline_id in ancestors_for(context_id) for context_id in context_call_ids for timeline_id in timeline_call_ids):
                    errors.append(f"{label} must prepare an effective memory timeline before exporting card-context-library resources")
                narrative_agents = [node for node in by_id.values() if node.get("type") == "agent" and any(isinstance(output, dict) and output.get("format") == "narrative" for output in node.get("outputs", {}).values())]
                if not narrative_agents or any("narrative-memory/narrative-memory-retrieve" not in [binding if isinstance(binding, str) else binding.get("target") for binding in node.get("workflowCalls", [])] for node in narrative_agents):
                    errors.append(f"{label} narrative Agent must expose narrative-memory/narrative-memory-retrieve")

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
        finalizers = [(node_id, node) for node_id, node in by_id.items() if node.get("type", "agent") == "turn-finalize"]
        if kind == "foreground" and len(finalizers) != 1:
            errors.append(f"{label} foreground workflow requires exactly one turn-finalize node")
        elif kind == "foreground":
            finalizer_id, finalizer = finalizers[0]
            narrative = finalizer.get("narrative")
            if not isinstance(narrative, dict) or set(narrative) != {"fromNode", "output"}:
                errors.append(f"{label} turn-finalize must map one narrative output")
            else:
                source = by_id.get(narrative.get("fromNode"), {})
                output = source.get("outputs", {}).get(narrative.get("output")) if isinstance(source.get("outputs", {}), dict) else None
                if not isinstance(output, dict) or output.get("format") != "narrative":
                    errors.append(f"{label} turn-finalize source must be a declared narrative-format output")
                if narrative.get("fromNode") not in ancestors_for(finalizer_id):
                    errors.append(f"{label} turn-finalize must run after its narrative source")
        elif finalizers:
            errors.append(f"{label} only foreground workflows may contain turn-finalize")
        trigger = workflow.get("trigger", {"type": "manual"})
        if not isinstance(trigger, dict):
            errors.append(f"{label}.trigger must be an object")
        elif trigger.get("type", "manual") not in {"manual", "after-opening", "after-workflow", "node"}:
            errors.append(f"{label}.trigger.type is invalid")
        elif trigger.get("blockNextTurnUntilReady", False) is True and kind != "turn-background":
            errors.append(f"{label}.trigger.blockNextTurnUntilReady is only valid for turn-background workflows")
    return ids


def validate_manifest(root: Path, manifest: Any, errors: list[str], warnings: list[str]) -> None:
    if not isinstance(manifest, dict):
        errors.append("manifest.json must contain an object")
        return
    if manifest.get("schema_version") != 2:
        errors.append("manifest schema_version must be 2")
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
    if not isinstance(fixed_context, str):
        errors.append("manifest fixed_context must be one relative file path")
    else:
        require_file(root, fixed_context, "fixed_context", errors)

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
    module_ids = declared_module_ids(root, manifest)
    if "card-context-library" not in module_ids:
        errors.append("manifest feature_modules must include the card-context-library resource module")
    if "world-narrative-coordinator" in module_ids:
        if "narrative-memory" not in module_ids:
            errors.append("world-narrative-coordinator requires the narrative-memory module")
        context_catalog = None
        for module_path in manifest.get("feature_modules", []):
            if not safe_relative_path(module_path):
                continue
            module = load_json(root / module_path, [])
            if isinstance(module, dict) and module.get("id") == "card-context-library" and safe_relative_path(module.get("resourceCatalogFile")):
                context_catalog = load_json((root / module_path).parent / module["resourceCatalogFile"], [])
                break
        if not isinstance(context_catalog, dict) or "director-future" not in context_catalog.get("categories", {}):
            errors.append("world-narrative-coordinator requires card-context-library category director-future")
    elif isinstance(fixed_context, str) and safe_relative_path(fixed_context) and (root / fixed_context).is_file():
        foundation_text = (root / fixed_context).read_text(encoding="utf-8-sig").strip()
        for module_path in manifest.get("feature_modules", []):
            if not safe_relative_path(module_path):
                continue
            module = load_json(root / module_path, [])
            if not isinstance(module, dict) or module.get("id") != "card-context-library" or not safe_relative_path(module.get("resourceCatalogFile")):
                continue
            module_root = (root / module_path).parent
            catalog = load_json(module_root / module["resourceCatalogFile"], [])
            for document in catalog.get("documents", []) if isinstance(catalog, dict) and isinstance(catalog.get("documents"), list) else []:
                document_path = document.get("path") if isinstance(document, dict) else None
                if safe_relative_path(document_path) and (module_root / document_path).is_file():
                    if foundation_text and (module_root / document_path).read_text(encoding="utf-8-sig").strip() == foundation_text:
                        errors.append(f"fixed_context exactly duplicates card-context-library document {document.get('id')}")
    validate_context_processors(root, manifest.get("context_processors"), module_ids, errors)

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
        if "recommended_context" in opening:
            errors.append(f"openings[{index}].recommended_context was replaced by the card-context-library catalog")

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
