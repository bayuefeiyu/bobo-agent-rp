"""S8 拆分第 2 层：前端视图、资源目录、时间适配器与提示词控制资源。

这些规则只依赖参数（外加 `validation.filesystem` 的路径辅助），彼此不调用其他校验函数，
因此可以独立成模块并独立测试。

**诊断文案与行为与拆分前逐字一致**；所有错误文本都从原实现原样搬来。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .authoring import component_ref, validate_director_prompt
from .filesystem import require_file, safe_relative_path

def validate_frontend_view_v2(view: Any, contract: dict[str, Any], label: str, errors: list[str]) -> None:
    if not isinstance(view, dict) or set(view) != {"schemaVersion", "regions"} or view.get("schemaVersion") not in {1, 2} or not isinstance(view.get("regions"), list):
        errors.append(f"{label} must contain schemaVersion 1 or 2 and a regions array")
        return
    if view["schemaVersion"] == 1:
        return
    interactive = {"record-browser", "story-browser", "settings-form", "prompt-controls", "workflow-controls", "integrity-alerts"}
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
        if region.get("type") == "story-browser":
            # Mirrors rp-module-frontend.mjs: story-browser declares indexView/fullView rather than view.
            collection_id = region.get("collectionId")
            collection = collections.get(collection_id)
            if not isinstance(collection, dict):
                errors.append(f"{region_label}.collectionId is unknown")
                continue
            record_types = region.get("recordTypes")
            if not isinstance(record_types, list) or not record_types or any(item not in collection.get("recordTypes", {}) for item in record_types):
                errors.append(f"{region_label} references unknown record types")
                continue
            for view_field in ("indexView", "fullView"):
                view_id = region.get(view_field)
                if any(view_id not in collection["recordTypes"][item].get("views", {}) for item in record_types):
                    errors.append(f"{region_label}.{view_field} is not declared by every record type")
            read_capability = capabilities.get(region.get("readCapability"), {})
            declared_views = [region.get("indexView"), region.get("fullView")]
            if (
                collection_id not in read_capability.get("collections", [])
                or "query" not in read_capability.get("actions", [])
                or any(view_id not in read_capability.get("views", []) for view_id in declared_views)
            ):
                errors.append(f"{region_label}.readCapability does not grant the declared views")
            page_size = region.get("pageSize")
            if page_size is not None and (not isinstance(page_size, int) or isinstance(page_size, bool) or not 1 <= page_size <= 100):
                errors.append(f"{region_label}.pageSize must be an integer between 1 and 100")
            for budget_field, budget_maximum in (("indexMaxCharacters", 200000), ("fullMaxCharacters", 1000000)):
                budget = region.get(budget_field)
                if budget is not None and (not isinstance(budget, int) or isinstance(budget, bool) or not 1000 <= budget <= budget_maximum):
                    errors.append(f"{region_label}.{budget_field} must be an integer between 1000 and {budget_maximum}")
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
        if region.get("type") in {"settings-form", "prompt-controls"}:
            update_capability = capabilities.get(region.get("updateCapability"), {})
            if collection_id not in update_capability.get("collections", []) or "update" not in update_capability.get("actions", []):
                errors.append(f"{region_label}.updateCapability does not grant update")
            if region.get("type") == "prompt-controls":
                controls_file = region.get("controlsFile")
                if not isinstance(region.get("recordId"), str) or not isinstance(controls_file, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*\.json", controls_file) or any(part in {"", ".."} for part in controls_file.split("/")):
                    errors.append(f"{region_label} requires recordId and a safe controlsFile")
            elif not isinstance(region.get("recordId"), str) or not isinstance(region.get("fields"), list) or not region["fields"]:
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


def validate_time_adapter(module_root: Path, label: str, errors: list[str]) -> None:
    """The card's documented time rule and the adapter that implements it must agree.

    `narrative-memory` ships `config/time-system.json` unconfigured plus a `runtime/time-adapter.mjs`
    whose exports throw. A conversion that fills in the JSON — format, granularity, sort algorithm,
    examples — but leaves the adapter as the stub looks complete and passes every other check, then
    fails on the *first archived event*: the memory batch validator derives `sortValue` through the
    adapter and the archive stops with "time adapter is not configured for this card". Comparing the
    two files catches that mismatch at conversion time instead.
    """
    declaration_path = module_root / "config" / "time-system.json"
    adapter_path = module_root / "runtime" / "time-adapter.mjs"
    if not declaration_path.is_file() or not adapter_path.is_file():
        return
    try:
        declaration = json.loads(declaration_path.read_text(encoding="utf-8-sig"))
        adapter_text = adapter_path.read_text(encoding="utf-8-sig")
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"{label} time system could not be read: {error}")
        return
    if not isinstance(declaration, dict):
        errors.append(f"{label} config/time-system.json must be a JSON object")
        return
    declared_version = declaration.get("timeRuleVersion")
    configured = declaration.get("configured") is True
    exported = re.search(r'timeRuleVersion\s*=\s*"([^"]*)"', adapter_text)
    exported_version = exported.group(1) if exported else None
    if configured and (not isinstance(declared_version, str) or not declared_version or declared_version == "unconfigured"):
        errors.append(f"{label} config/time-system.json declares configured time rules but no timeRuleVersion")
        return
    if exported_version is None:
        errors.append(f"{label} runtime/time-adapter.mjs must export a literal timeRuleVersion")
        return
    if configured and exported_version == "unconfigured":
        errors.append(
            f"{label} documents time rule {declared_version!r} in config/time-system.json but runtime/time-adapter.mjs is still the unconfigured stub; "
            "a card that archives an event would fail with 'time adapter is not configured for this card'"
        )
        return
    if configured and exported_version != declared_version:
        errors.append(f"{label} runtime/time-adapter.mjs exports timeRuleVersion {exported_version!r} but config/time-system.json declares {declared_version!r}")
        return
    if not configured and exported_version != "unconfigured":
        errors.append(f"{label} runtime/time-adapter.mjs implements {exported_version!r} but config/time-system.json is not configured")


def validate_prompt_controls_resources(root: Path, module_root: Path, controls: dict[str, Any], catalog: Any, label: str, errors: list[str]) -> None:
    module_id = catalog.get("moduleId") if isinstance(catalog, dict) else None
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    def valid_id(value: Any) -> bool:
        return isinstance(value, str) and bool(safe_id.fullmatch(value)) and value not in {"constructor", "prototype", "__proto__"}
    documents = {item["id"]: item for item in catalog.get("documents", []) if isinstance(item, dict) and isinstance(item.get("id"), str)} if isinstance(catalog, dict) else {}
    groups_seen, used = set(), set()
    last_count = 0
    for group in controls["groups"]:
        if not isinstance(group, dict) or not valid_id(group.get("id")) or group["id"] in groups_seen or not isinstance(group.get("title"), str) or not group["title"].strip() or not isinstance(group.get("options"), list) or not group["options"]:
            errors.append(f"{label}: prompt group requires a unique safe ID, title and options")
            continue
        groups_seen.add(group["id"])
        for flag in ("allowNone", "allowCustom", "last"):
            if flag in group and not isinstance(group[flag], bool):
                errors.append(f"{label}: {flag} must be boolean")
        last_count += group.get("last") is True
        options_seen = set()
        for option in group["options"]:
            if not isinstance(option, dict) or not valid_id(option.get("id")) or option["id"] in {"none", "custom"} or option["id"] in options_seen or not isinstance(option.get("label"), str) or not option["label"].strip():
                errors.append(f"{label}: prompt option requires a unique safe ID and label")
                continue
            options_seen.add(option["id"])
            document = documents.get(option.get("documentId")) if isinstance(option.get("documentId"), str) else None
            if not document or document.get("selectionGroup") != group["id"] or document["id"] in used:
                errors.append(f"{label}: prompt option must reference one resource in its own selection group")
            else:
                used.add(document["id"])
    if last_count > 1 or len(used) != len(documents):
        errors.append(f"{label}: every prompt resource must belong to one option, with at most one final group")
    delivery = controls.get("delivery")
    if delivery is None:
        return
    agents = delivery.get("agents") if isinstance(delivery, dict) else None
    if not isinstance(delivery, dict) or delivery.get("mode") != "agent-prompt" or not isinstance(agents, list) or not agents or any(not component_ref(item) for item in agents) or len(agents) != len(set(agents)):
        errors.append(f"{label}: Agent prompt controls require unique recipient Agent IDs")
        return
    if "instruction" in delivery and not isinstance(delivery["instruction"], str):
        errors.append(f"{label}: Agent prompt instruction must be text")
    for agent_id in agents:
        if not agent_id.startswith(module_id + "/") or not (module_root / "agents" / agent_id.split("/")[-1] / "agent.json").is_file():
            errors.append(f"{label}: prompt delivery references an unknown Agent: {agent_id}")
    for document in documents.values():
        if safe_relative_path(document.get("path")) and (module_root / document["path"]).is_file():
            validate_director_prompt((module_root / document["path"]).read_text(encoding="utf-8-sig"), set(agents), f"{label}/{document['path']}", errors)
