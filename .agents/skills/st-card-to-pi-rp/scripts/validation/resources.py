"""S8 拆分第 5 层：模块/资源校验。

方案 §13 第 1 条把校验器按"模块/资源、工作流、manifest/provenance"分组；本模块承担
**模块/资源**一组：功能模块清单、数据契约与记录、前端视图装配、资源目录、模块调用面，
以及只在该组内使用的遍历辅助（模块清单路径、契约/工作流/资源映射、组件引用判定）。

这里同时收容 validate_design_invariants（设计不变量核对）与 main 之外的共享规则
(validate_name_templates、validate_record 等)：它们既被本层使用，也被工作流层与
manifest 层使用。把它们放在本层而非主入口，是为了让 validation/workflows.py **不再反向
导入主入口**——那会形成循环导入，在 importlib.spec_from_file_location 加载方式下运行期失败。

**诊断文案与行为与拆分前逐字一致**；所有错误文本都从原实现原样搬来。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .authoring import component_ref, validate_director_prompt, validate_skill_frontmatter
from .filesystem import load_json, require_file, safe_relative_path
from .frontend import (
    validate_frontend_view_v2,
    validate_prompt_controls_resources,
    validate_resource_catalog,
    validate_time_adapter,
)
from .shared import (
    ALLOWED_STATUSES,
    CHARACTER_MACROS,
    DESIGN_INVARIANT_FIELDS,
    DESIGN_WARNING_PREFIX,
    PLAYER_MACROS,
    RUNTIME_SERVICES,
    STRUCTURAL_FIELDS,
)

def validate_name_templates(root: Path, errors: list[str]) -> None:
    """Check author-facing runtime material, leaving archived source text untouched."""
    excluded = {"source", "web", "provenance", "sessions"}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".md", ".json"}:
            continue
        relative = path.relative_to(root)
        if any(part in excluded for part in relative.parts[:-1]):
            continue
        if relative.as_posix() in {"provenance.json", "conversion-report.md", "unresolved.md"}:
            continue
        text = path.read_text(encoding="utf-8-sig")
        for macro in CHARACTER_MACROS:
            if macro in text:
                errors.append(f"{relative.as_posix()} contains {macro}; resolve its definite name during conversion")
        if "<user>" in text:
            errors.append(f"{relative.as_posix()} contains <user>; normalize it to {{{{user}}}} during conversion")
        if path.suffix.lower() != ".json":
            continue
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            continue  # The format validator reports malformed JSON separately.
        def check_structure(item: Any, label: str) -> None:
            if isinstance(item, dict):
                for key, child in item.items():
                    if any(macro in key for macro in PLAYER_MACROS):
                        errors.append(f"{label} has a player macro in a JSON key")
                    structural = key in STRUCTURAL_FIELDS or bool(re.search(r"(?:Id|Ids|Path|File)$", key))
                    if structural and isinstance(child, str) and any(macro in child for macro in PLAYER_MACROS):
                        errors.append(f"{label}.{key} has a player macro in a structural field")
                    check_structure(child, f"{label}.{key}")
            elif isinstance(item, list):
                for index, child in enumerate(item):
                    check_structure(child, f"{label}[{index}]")
        check_structure(value, relative.as_posix())


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


def validate_feature_modules(root: Path, values: Any, errors: list[str], warnings: list[str] | None = None) -> None:
    warnings = warnings if warnings is not None else []
    if not isinstance(values, list):
        errors.append("feature_modules must be an array")
        return
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    ids: set[str] = set()
    module_fields = {"schemaVersion", "id", "moduleKind", "basedOn", "title", "description", "surface", "contextOrder", "displayOrder", "dataContractFile", "resourceCatalogFile", "frontendViewFile", "skillFile", "agentFiles", "workflowFiles"}
    index_types = {"string", "number", "boolean", "enum", "id", "id-list", "string-list", "time"}
    index_operators = {"eq", "neq", "contains", "in", "gt", "gte", "lt", "lte"}
    surface_paths = module_surface_paths(root, values)
    all_module_workflows = module_workflow_map(root, surface_paths)
    all_resource_catalogs = module_resource_catalog_map(root, surface_paths)
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
        if set(module) != module_fields or module.get("schemaVersion") != 7:
            errors.append(f"{label} must use the exact module v7 field set")
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
        validate_time_adapter(module_root, f"{label} ({module_id})", errors)
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
            validate_skill_frontmatter(module_root, module.get(field), f"{label}.{field}", errors)
        for field in ("dataContractFile", "resourceCatalogFile", "frontendViewFile"):
            if module.get(field) is not None:
                require_file(module_root, module.get(field), f"{label}.{field}", errors)
        owned_contract = load_json(module_root / module["dataContractFile"], []) if has_data and safe_relative_path(module.get("dataContractFile")) and (module_root / module["dataContractFile"]).is_file() else {}
        for component_field, directory_name, filename in (("agentFiles", "agents", "agent.json"), ("workflowFiles", "workflows", "workflow.json")):
            declared = module.get(component_field)
            if not isinstance(declared, list) or any(not safe_relative_path(path) for path in declared):
                errors.append(f"{label}.{component_field} must be a list of module-relative files")
                continue
            if len(declared) != len(set(declared)):
                errors.append(f"{label}.{component_field} contains duplicates")
            registered = {(module_root / path).resolve() for path in declared}
            component_ids = set()
            for path in declared:
                require_file(module_root, path, f"{label}.{component_field}", errors)
                value = load_json(module_root / path, [])
                if not isinstance(value, dict):
                    continue
                ref = value.get("id")
                ref = ref if component_ref(ref) else f"{module_id}/{ref}"
                if not component_ref(ref) or not ref.startswith(module_id + "/") or value.get("ownerModuleId") != module_id:
                    errors.append(f"{label}.{component_field} component must belong to {module_id}")
                if ref in component_ids:
                    errors.append(f"{label}.{component_field} contains duplicate component ID {ref}")
                component_ids.add(ref)
            for file in (module_root / directory_name).rglob(filename):
                if file.resolve() not in registered:
                    errors.append(f"Unregistered module component: {file}")
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
                if not isinstance(owned, dict) or owned.get("schemaVersion") != 4:
                    errors.append(f"{workflow_label} must contain a workflow v4 object")
                    continue
                if owned.get("kind") not in {"foreground", "turn-background", "global-background", "module-external", "module-internal"} or owned.get("ownerModuleId") != module_id:
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
                        if not isinstance(lock, dict) or set(lock) - {"moduleId", "collectionId"} or (owned.get("kind") == "module-internal" and lock.get("moduleId") != module_id):
                            errors.append(f"{lock_label} must name only the owner module and an optional collection")
                            continue
                        collection_id = lock.get("collectionId")
                        if collection_id is not None and lock.get("moduleId") == module_id and collection_id not in owned_contract.get("collections", {}):
                            errors.append(f"{lock_label} references an unknown owner collection")
                        key = (lock.get("moduleId"), collection_id)
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
                if not isinstance(owned_nodes, list) or (owned.get("kind") in {"module-external", "module-internal"} and sum(1 for node in owned_nodes if isinstance(node, dict) and node.get("type") == "workflow-return") != 1):
                    errors.append(f"{workflow_label} must contain exactly one workflow-return node")
                if isinstance(owned_nodes, list):
                    for node_index, node in enumerate(owned_nodes):
                        if isinstance(node, dict):
                            owned_node_label = f"{workflow_label}.nodes[{node_index}]"
                            validate_runtime_services(node, owned_node_label, errors)
                            node_type = node.get("type", "agent")
                            if node_type not in allowed_node_types:
                                errors.append(f"{owned_node_label}.type is invalid")
                            validate_code_node_entry(root, node, owned_node_label, node_type, errors,
                                                     module_source=(module_root, module_id))
                            required_calls: set[str] = set()
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
                                        if not isinstance(member.get("agentId"), str) or not component_ref(member["agentId"]):
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
                            validate_module_call_surface(
                                node,
                                owned_node_label,
                                node_type,
                                all_module_workflows,
                                all_resource_catalogs,
                                sorted(required_calls),
                                errors,
                            )
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
                if "trigger" in owned and owned.get("kind") in {"module-external", "module-internal"}:
                    errors.append(f"{workflow_label} module workflows cannot declare triggers")
            if module_id == "card-context-library":
                # The shipped shape of the always-present resource module. A card may replace its
                # export workflow with a smarter one, so this is reported without blocking; the
                # shipped package itself is covered by the real-asset regression.
                if module_kind != "resource" or workflow_files != ["workflows/export-context/workflow.json"]:
                    warnings.append(f"{DESIGN_WARNING_PREFIX}{label} card-context-library must be a resource module with only export-context")
                else:
                    export_workflow = load_json(module_root / workflow_files[0], errors)
                    interface = export_workflow.get("interface", {}) if isinstance(export_workflow, dict) else {}
                    inputs = interface.get("inputs", {}) if isinstance(interface, dict) else {}
                    exports = interface.get("exports", {}) if isinstance(interface, dict) else {}
                    categories_input = inputs.get("categories", {}) if isinstance(inputs, dict) else {}
                    context_export = exports.get("context", {}) if isinstance(exports, dict) else {}
                    if export_workflow.get("kind") != "module-external" or categories_input.get("type") != "parameter" or categories_input.get("required") is not True or categories_input.get("valueType") != "string-array" or context_export.get("format") != "document-set":
                        warnings.append(f"{DESIGN_WARNING_PREFIX}{label} export-context must accept required category strings and export one document-set")
        if has_resources and safe_relative_path(module.get("resourceCatalogFile")) and (module_root / module["resourceCatalogFile"]).is_file():
            validate_resource_catalog(module_root, load_json(module_root / module["resourceCatalogFile"], errors), module_id, f"{label}.resourceCatalogFile", errors)
        if not has_data:
            continue
        view = load_json(module_root / module["frontendViewFile"], errors) if module.get("frontendViewFile") else None
        if isinstance(view, dict):
            for region in view.get("regions", []):
                if not isinstance(region, dict) or region.get("type") != "workflow-controls":
                    continue
                for item in region.get("workflows", []) if isinstance(region.get("workflows"), list) else []:
                    if not isinstance(item, dict):
                        continue
                    reference = f"{module_id}/{item.get('id')}"
                    target = all_module_workflows.get(reference)
                    if not target or target.get("kind") not in {"turn-background", "global-background"}:
                        errors.append(f"{label}.frontendViewFile control {reference} must reference an owned background entry workflow")
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
            for region in view.get("regions", []) if isinstance(view, dict) else []:
                if not isinstance(region, dict) or region.get("type") != "prompt-controls" or not safe_relative_path(region.get("controlsFile")):
                    continue
                controls_path = module_root / region["controlsFile"]
                controls = load_json(controls_path, errors)
                if not isinstance(controls, dict) or controls.get("schemaVersion") != 1 or not isinstance(controls.get("groups"), list) or not 1 <= len(controls["groups"]) <= 100:
                    errors.append(f"{label}.frontendViewFile prompt-controls requires controls schemaVersion 1 and 1–100 groups: {region['controlsFile']}")
                else:
                    catalog = load_json(module_root / module["resourceCatalogFile"], errors) if safe_relative_path(module.get("resourceCatalogFile")) else None
                    validate_prompt_controls_resources(root, module_root, controls, catalog, f"{label}/{region['controlsFile']}", errors)
                    recipients = controls.get("delivery", {}).get("agents", []) if isinstance(controls.get("delivery"), dict) else []
                    initial_file = collections.get(region.get("collectionId"), {}).get("storage", {}).get("initialSnapshotFile")
                    if recipients and all(isinstance(item, str) for item in recipients) and safe_relative_path(initial_file):
                        initial = load_json(module_root / initial_file, errors)
                        for record in initial if isinstance(initial, list) else []:
                            if isinstance(record, dict) and record.get("id") == region.get("recordId"):
                                selections = record.get("data", {}).get("selections", {})
                                for group_id, selection in selections.items() if isinstance(selections, dict) else []:
                                    if isinstance(selection, dict) and selection.get("optionId") == "custom" and isinstance(selection.get("customText"), str):
                                        validate_director_prompt(selection["customText"], set(recipients), f"{label}/{initial_file}/{group_id}", errors)


def manifest_module_paths(root: Path) -> list[str]:
    """Card-relative `feature_modules` paths, or an empty list outside a card."""
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return []
    values = manifest.get("feature_modules") if isinstance(manifest, dict) else None
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def module_contract_map(root: Path, module_paths: list[str] | None = None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for module_path in manifest_module_paths(root) if module_paths is None else module_paths:
        if not safe_relative_path(module_path):
            continue
        module = load_json(root / module_path, [])
        if not isinstance(module, dict) or not safe_relative_path(module.get("dataContractFile")):
            continue
        contract = load_json((root / module_path).parent / module["dataContractFile"], [])
        if isinstance(contract, dict) and isinstance(module.get("id"), str):
            result[module["id"]] = contract
    return result


def module_workflow_map(root: Path, module_paths: list[str] | None = None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for module_path in manifest_module_paths(root) if module_paths is None else module_paths:
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
                result[workflow["id"] if "/" in workflow["id"] else f"{module['id']}/{workflow['id']}"] = workflow
    return result


def module_resource_catalog_map(root: Path, module_paths: list[str] | None = None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for module_path in manifest_module_paths(root) if module_paths is None else module_paths:
        if not safe_relative_path(module_path):
            continue
        module = load_json(root / module_path, [])
        if not isinstance(module, dict) or not isinstance(module.get("id"), str) or not safe_relative_path(module.get("resourceCatalogFile")):
            continue
        catalog = load_json((root / module_path).parent / module["resourceCatalogFile"], [])
        if isinstance(catalog, dict):
            result[module["id"]] = catalog
    return result


def module_surface_paths(root: Path, values: Any) -> list[str]:
    """The module paths whose workflows and catalogs may be referenced while validating.

    Inside a card this is the manifest's `feature_modules`. Validating one or more project-global
    packages has no manifest, so the validated modules themselves form the surface; without that,
    a package could not even reference its own qualified workflows.
    """
    paths = manifest_module_paths(root)
    for value in values if isinstance(values, list) else []:
        if isinstance(value, str) and value not in paths:
            paths.append(value)
    return paths


def module_component_entries(root: Path, field: str) -> list[tuple[Path, str, Path]]:
    entries = []
    for module_path in manifest_module_paths(root):
        if not safe_relative_path(module_path):
            continue
        module_root = (root / module_path).parent
        module = load_json(root / module_path, [])
        if not isinstance(module, dict):
            continue
        for path in module.get(field, []) if isinstance(module.get(field), list) else []:
            if safe_relative_path(path):
                entries.append((module_root / path, module.get("id"), module_root))
    return entries


def workflow_kinds(root: Path) -> dict[str, str]:
    return {reference: workflow.get("kind") for reference, workflow in module_workflow_map(root).items()
            if workflow.get("kind") in {"foreground", "turn-background", "global-background"}}


def validate_code_node_entry(root: Path, node: dict[str, Any], node_label: str, node_type: str, errors: list[str],
                             module_source: tuple[Path, str] | None = None) -> None:
    """Validate a code node's `metadata.entryFile`.

    The runtime resolves this path below the owner module directory. The converter must keep
    the script inside that module rather than copying it to a shared card-root workflow folder.

    `module_source` is `(package_root, module_id)` while validating a workflow from the
    project-global package itself. A card installs that package at `features/<module-id>/`, so the
    identical `entryFile` lives below `package_root` once that install prefix is stripped. Without
    it, source-tree validation would report every module code node as a missing card file.
    """
    if node_type != "code":
        return
    metadata = node.get("metadata")
    if not isinstance(metadata, dict):
        return
    entry_file = metadata.get("entryFile")
    if entry_file is None:
        return
    label = f"{node_label}.metadata.entryFile"
    if not safe_relative_path(entry_file):
        errors.append(f"{label} is not a safe relative POSIX path: {entry_file!r}")
        return
    if module_source is not None and (module_source[0] / entry_file).is_file():
        return
    errors.append(f"{label} does not exist: {entry_file}")


def validate_module_call_surface(
    node: dict[str, Any],
    node_label: str,
    node_type: str,
    module_workflows: dict[str, dict[str, Any]],
    resource_catalogs: dict[str, dict[str, Any]],
    team_workflow_abilities: list[str],
    errors: list[str],
) -> None:
    """Validate one node's module-call surface.

    Covers the fixed `call` target with its interface matching, and the dynamic
    `workflowCalls` bindings with their exposure, argument policy, and budget fields.

    Shared by top-level and module workflow nodes so the two scopes cannot drift apart.
    """
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
                max_calls, document_snapshot_input = None, None
            elif isinstance(raw_call, dict) and not set(raw_call) - {"target", "fixedArguments", "allowedArguments", "maxCalls", "documentSnapshotInput"}:
                target = raw_call.get("target")
                fixed_arguments = raw_call.get("fixedArguments", {})
                allowed_arguments = raw_call.get("allowedArguments")
                max_calls = raw_call.get("maxCalls")
                document_snapshot_input = raw_call.get("documentSnapshotInput")
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
            if max_calls is not None and (not isinstance(max_calls, int) or isinstance(max_calls, bool) or max_calls < 1):
                errors.append(f"{call_label}.maxCalls must be a positive integer")
            if document_snapshot_input is not None and (
                not isinstance(document_snapshot_input, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", document_snapshot_input)
            ):
                errors.append(f"{call_label}.documentSnapshotInput must be a safe ID")
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


def validate_design_invariants(root: Path, manifest: Any, errors: list[str]) -> dict[str, Any]:
    """Read the invariants a card declares about its own design.

    These replace the validator's hardcoded guesses about the shipped templates: a card that
    declares an invariant is held to it, and a card that declares none — renamed, replaced, or
    decoupled — is never judged against a template it deliberately left behind.
    """
    declared = manifest.get("design_invariants") if isinstance(manifest, dict) else None
    if declared is None:
        return {}
    if not isinstance(declared, dict):
        errors.append("manifest design_invariants must be an object")
        return {}
    unknown = sorted(set(declared) - DESIGN_INVARIANT_FIELDS)
    if unknown:
        errors.append(f"manifest design_invariants has unknown fields: {unknown}")
    subject = declared.get("foregroundWorkflow")
    if subject is not None and (not isinstance(subject, str) or not subject):
        errors.append("manifest design_invariants.foregroundWorkflow must be a non-empty string")
        subject = None
    elif subject is None and len(declared) > 0:
        errors.append("manifest design_invariants.foregroundWorkflow is required by every other declared invariant")
    if subject is not None and subject not in workflow_kinds(root):
        errors.append(f"manifest design_invariants.foregroundWorkflow must reference a card-local workflow: {subject}")
    elif subject is not None and workflow_kinds(root).get(subject) != "foreground":
        errors.append(f"manifest design_invariants.foregroundWorkflow must reference a foreground workflow: {subject}")
    for field in ("requiresCardContextResources", "requiresEffectiveMemoryTimeline"):
        if field in declared and not isinstance(declared[field], bool):
            errors.append(f"manifest design_invariants.{field} must be a boolean")
    required_calls = declared.get("requiresNarrativeAgentCallable")
    if required_calls is not None:
        if not isinstance(required_calls, list) or any(not isinstance(value, str) or not value for value in required_calls):
            errors.append("manifest design_invariants.requiresNarrativeAgentCallable must be an array of module/workflow references")
    return declared
