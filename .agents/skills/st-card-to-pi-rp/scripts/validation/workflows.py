"""S8 拆分第 4 层：工作流校验。

方案 §13 第 1 条把校验器按"模块/资源、工作流、manifest/provenance"分组；本模块承担
**工作流**一组：工作流结构、节点交付、模块调用面、设计不变量核对与集合写入锁。

**诊断文案与行为与拆分前逐字一致**；所有错误文本都从原实现原样搬来。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# 跨层调用：这些辅助按职责属于"模块/资源"层，已随 S8 第 5 层搬到 validation/resources.py。
# 直接从该层导入（而不是反向导入主入口），因为主入口可能以 importlib 按路径加载，
# 此时它不在 sys.modules 中，反向导入会在运行期形成部分初始化模块而失败。
from .resources import (
    component_ref,
    module_component_entries,
    module_contract_map,
    module_resource_catalog_map,
    module_workflow_map,
    validate_code_node_entry,
    validate_design_invariants,
    validate_module_call_surface,
    validate_runtime_services,
    workflow_kinds,
)
from .filesystem import load_json, require_file, safe_relative_path
from .shared import (
    DESIGN_INVARIANT_FIELDS,
    DESIGN_WARNING_PREFIX,
    NARRATIVE_AGENT_REQUIRED_CALLS,
    SHIPPED_FOREGROUND_TEMPLATES,
    SHIPPED_MEMORY_FOREGROUND_TEMPLATES,
    TRIGGER_DOCUMENT_READ,
    WRITE_ACTIONS,
)

REQUIRED_FIELD_CACHE: dict[str, list[str]] = {}


def foreground_design_problems(label: str, by_id: dict[str, Any], ancestors_for, checks: dict[str, Any]) -> list[str]:
    """Design-convention findings for one foreground workflow.

    `checks` selects the conventions to apply: `cardContext` requires prepared card resources before
    narration, `memoryTimeline` requires the effective memory timeline to be prepared before those
    resources are exported, and `agentCallable` lists calls every narrative Agent must expose.

    The same code reports the shipped templates' conventions as warnings and a card's own declared
    `design_invariants` as errors, so the two can never drift apart.
    """
    problems: list[str] = []
    context_call_ids = [node_id for node_id, node in by_id.items() if node.get("type") == "call" and node.get("target") == "card-context-library/export-context"]
    if checks.get("cardContext") and not context_call_ids:
        problems.append(f"{label} must prepare card-context-library resources before narration")
    if checks.get("memoryTimeline") and context_call_ids:
        timeline_call_ids = [node_id for node_id, node in by_id.items() if node.get("type") == "call" and node.get("target") == "narrative-memory/narrative-memory-reference-snapshot" and isinstance(node.get("arguments", {}).get("timeline"), dict)]
        if not timeline_call_ids or not any(timeline_id in ancestors_for(context_id) for context_id in context_call_ids for timeline_id in timeline_call_ids):
            problems.append(f"{label} must prepare an effective memory timeline before exporting card-context-library resources")
    required_calls = checks.get("agentCallable") or []
    if required_calls:
        narrative_agents = [node for node in by_id.values() if node.get("type") == "agent" and any(isinstance(output, dict) and output.get("format") == "narrative" for output in node.get("outputs", {}).values())]
        for target in required_calls:
            if not narrative_agents:
                problems.append(f"{label} narrative Agent must expose {target}")
                continue
            for node in narrative_agents:
                exposed = [binding if isinstance(binding, str) else binding.get("target") for binding in node.get("workflowCalls", [])]
                if target not in exposed:
                    problems.append(f"{label} narrative Agent must expose {target}; node {node.get('id', '<unknown>')} does not")
    return problems


def capability_actions(capabilities: Any, contract_capabilities: Any) -> set[str]:
    if not isinstance(capabilities, list) or not isinstance(contract_capabilities, dict):
        return set()
    return {
        action
        for capability_id in capabilities
        for action in (contract_capabilities.get(capability_id) or {}).get("actions", [])
        if isinstance(action, str)
    }


def required_record_fields(root: Path, module_id: str, definition: dict[str, Any]) -> set[str]:
    """The top-level properties a record of this type must carry, from its own schema file."""
    schema_file = definition.get("schemaFile")
    if not isinstance(schema_file, str) or not safe_relative_path(schema_file):
        return set()
    key = f"{module_id}/{schema_file}"
    if key not in REQUIRED_FIELD_CACHE:
        path = root / "features" / module_id / schema_file
        fields: list[str] = []
        try:
            schema = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            schema = None
        if isinstance(schema, dict) and schema.get("type") == "object" and isinstance(schema.get("properties"), dict):
            fields = sorted(field for field in schema.get("required", []) if isinstance(field, str) and field in schema["properties"])
        REQUIRED_FIELD_CACHE[key] = fields
    return set(REQUIRED_FIELD_CACHE[key])


def view_covers_record(view: Any, required: set[str]) -> bool:
    """Whether an object view hands back the whole record, i.e. every required property.

    Coverage is decided by the field *paths*, not their labels: one property may carry several labels
    (`/data/time/day` is both "day index" and "天数"), and a view may expose the record under a single
    key (`/data` → "state"). A path that reaches only into a required property (`/data/time/day` for a
    required `time` object) does not cover it — such a projection cannot be written back as a record.
    """
    if not isinstance(view, dict) or not isinstance(view.get("fields"), list):
        return False
    paths = {field["path"].rstrip("/") for field in view["fields"] if isinstance(field, dict) and isinstance(field.get("path"), str)}
    if any(path in {"", "/data"} for path in paths):
        return True
    return all(f"/data/{field}" in paths for field in required)


def validate_workflows(root: Path, errors: list[str], warnings: list[str] | None = None,
                       invariants: dict[str, Any] | None = None) -> set[str]:
    warnings = warnings if warnings is not None else []
    entries = module_component_entries(root, "workflowFiles")
    ids: set[str] = set()
    safe_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    allowed_kinds = {"foreground", "turn-background", "global-background", "module-external", "module-internal"}
    allowed_types = {"agent", "code", "call", "team", "gate", "join", "workflow-return", "turn-finalize"}
    contracts = module_contract_map(root)
    module_workflows = module_workflow_map(root)
    resource_catalogs = module_resource_catalog_map(root)
    registered_agents = set()
    for file, owner, _ in module_component_entries(root, "agentFiles"):
        agent = load_json(file, [])
        if isinstance(agent, dict) and isinstance(agent.get("id"), str):
            registered_agents.add(agent["id"] if component_ref(agent["id"]) else f"{owner}/{agent['id']}")

    def check_agent(reference: Any, owner: str, label: str) -> None:
        if reference is None:
            return
        qualified = reference if component_ref(reference) else f"{owner}/{reference}"
        if qualified not in registered_agents:
            errors.append(f"{label} must reference a registered module Agent: {reference!r}")

    for component_file, owner_id, module_root in entries:
        directory = component_file.parent
        label = component_file.relative_to(root).as_posix()
        workflow = load_json(component_file, errors)
        if not isinstance(workflow, dict):
            continue
        workflow_id = workflow.get("id")
        workflow_id = workflow_id if component_ref(workflow_id) else f"{owner_id}/{workflow_id}"
        if workflow.get("schemaVersion") != 4:
            errors.append(f"{label}.schemaVersion must be 4")
        # Module v7 requires every Workflow v4 to declare its owning module, and the
        # normalized reference must use that same module prefix. The module-registry
        # pass checks this for manifests, but a workflow referenced from elsewhere can
        # reach this pass without it, so assert it here too.
        declared_owner = workflow.get("ownerModuleId")
        if not isinstance(declared_owner, str) or not safe_id.fullmatch(declared_owner):
            errors.append(f"{label}.ownerModuleId must be a module ID")
        elif component_ref(workflow.get("id")) and workflow["id"].split("/")[0] != declared_owner:
            errors.append(f"{label}.id must use its ownerModuleId as its module prefix")
        if not isinstance(workflow_id, str) or not component_ref(workflow_id):
            errors.append(f"{label}.id is invalid")
        elif workflow_id.split("/")[-1] != directory.name:
            errors.append(f"{label}.id must match its directory")
        elif workflow_id in ids:
            errors.append(f"duplicate workflow id: {workflow_id}")
        else:
            ids.add(workflow_id)
        kind = workflow.get("kind")
        check_agent(workflow.get("defaults", {}).get("agentId") if isinstance(workflow.get("defaults"), dict) else None, owner_id, f"{label}.defaults.agentId")
        if kind not in allowed_kinds:
            errors.append(f"{label}.kind is invalid")
        # Only callable module workflows may expose themselves to Agents.
        if kind in {"foreground", "turn-background", "global-background"} and workflow.get("agentCallable") not in (None, False):
            errors.append(f"{label}.agentCallable is only allowed on callable module workflows")
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
            check_agent(node.get("agentId"), owner_id, f"{node_label}.agentId")
            team_spec = node.get("team", {}) if isinstance(node.get("team"), dict) else {}
            for role in ("leader", "secretary"):
                member = team_spec.get(role)
                if isinstance(member, dict):
                    check_agent(member.get("agentId"), owner_id, f"{node_label}.team.{role}.agentId")
            for member in team_spec.get("experts", []) if isinstance(team_spec.get("experts"), list) else []:
                if isinstance(member, dict):
                    check_agent(member.get("agentId"), owner_id, f"{node_label}.team.experts.agentId")
            for ability in [*(team_spec.get("assistants", []) if isinstance(team_spec.get("assistants"), list) else []), team_spec.get("baseRetrieval")]:
                if isinstance(ability, dict) and ability.get("kind") == "agent":
                    check_agent(ability.get("agentId"), owner_id, f"{node_label}.team.abilities.agentId")
            team_workflow_abilities: list[str] = []
            validate_runtime_services(node, node_label, errors)
            validate_code_node_entry(root, node, node_label, node_type, errors, module_source=(module_root, owner_id))
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
                        if not isinstance(agent_id, str) or not component_ref(agent_id):
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
                        if ability_kind == "agent" and (not isinstance(ability.get("agentId"), str) or not component_ref(ability["agentId"])):
                            errors.append(f"{ability_label}.agentId is invalid")
                        if ability_kind == "tool" and (not isinstance(ability.get("adapter"), str) or not safe_id.fullmatch(ability["adapter"])):
                            errors.append(f"{ability_label}.adapter is invalid")
                        elif ability_kind == "tool" and ability.get("adapter") != "declared-document-read-v1":
                            errors.append(f"{ability_label}.adapter is unsupported")
                    if len(ability_ids) != len(set(ability_ids)):
                        errors.append(f"{node_label}.team ability IDs must be unique")
            validate_module_call_surface(
                node,
                node_label,
                node_type,
                module_workflows,
                resource_catalogs,
                team_workflow_abilities,
                errors,
            )
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
                if isinstance(output, dict):
                    required_files = output.get("requiredFiles", [])
                    if not isinstance(required_files, list) or any(not safe_relative_path(path) for path in required_files) or (required_files and output.get("kind") != "directory"):
                        errors.append(f"{node_label}.outputs.{output_id}.requiredFiles must name relative files in a directory output")
                    if "jsonSchema" in output and (not isinstance(output["jsonSchema"], dict) or output.get("format") != "json" or output.get("kind", "file") != "file"):
                        errors.append(f"{node_label}.outputs.{output_id}.jsonSchema requires a JSON file and an object schema")
            delivery = node.get("delivery")
            if delivery is not None:
                if node_type != "agent" or not isinstance(delivery, dict) or set(delivery) - {"primaryOutput", "maxReminders"}:
                    errors.append(f"{node_label}.delivery must be an Agent delivery declaration")
                else:
                    primary = delivery.get("primaryOutput")
                    definition = outputs.get(primary) if isinstance(primary, str) else None
                    if primary is not None and (not isinstance(definition, dict) or definition.get("kind", "file") != "file" or definition.get("required") is False or primary == node.get("metadata", {}).get("documentWorkspaceSnapshot", {}).get("output")):
                        errors.append(f"{node_label}.delivery.primaryOutput must reference a required Agent file output")
                    reminders = delivery.get("maxReminders", 2)
                    if type(reminders) is not int or not 0 <= reminders <= 5:
                        errors.append(f"{node_label}.delivery.maxReminders must be an integer from 0 to 5")
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
                    elif "update" in capability_actions(capabilities, contract_capabilities):
                        # A node that writes a record reads it first, and the runtime renders that read
                        # through the *view* the node asked for. A projection that omits a required
                        # field therefore cannot produce a valid update: the batch is rejected by the
                        # record schema and the failure the node was recording is itself lost. Require
                        # at least one granted view that exposes every required field.
                        for record_type, definition in sorted((contracts[module_id]["collections"][collection_id].get("recordTypes") or {}).items()):
                            if not isinstance(definition, dict) or not (set(definition.get("actions") or []) & WRITE_ACTIONS):
                                continue
                            required = required_record_fields(root, module_id, definition)
                            if not required:
                                continue
                            declared_views = definition.get("views") if isinstance(definition.get("views"), dict) else {}
                            if any(view_covers_record(declared_views.get(view), required) for view in views if view in declared_views):
                                continue
                            errors.append(
                                f"{access_label} writes {module_id}/{collection_id} but none of its views exposes every "
                                f"required field of {record_type}; a read through a narrower projection cannot produce a "
                                f"valid update"
                            )
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

        declared_foreground = (invariants or {}).get("foregroundWorkflow")
        if declared_foreground == workflow_id:
            errors.extend(foreground_design_problems(label, by_id, ancestors_for, {
                "cardContext": (invariants or {}).get("requiresCardContextResources") is True,
                "memoryTimeline": (invariants or {}).get("requiresEffectiveMemoryTimeline") is True,
                "agentCallable": (invariants or {}).get("requiresNarrativeAgentCallable") or [],
            }))
        elif workflow_id.split("/")[-1] in SHIPPED_FOREGROUND_TEMPLATES:
            warnings.extend(f"{DESIGN_WARNING_PREFIX}{problem}" for problem in foreground_design_problems(label, by_id, ancestors_for, {
                "cardContext": True,
                "memoryTimeline": workflow_id.split("/")[-1] in SHIPPED_MEMORY_FOREGROUND_TEMPLATES,
                "agentCallable": NARRATIVE_AGENT_REQUIRED_CALLS if workflow_id.split("/")[-1] in SHIPPED_MEMORY_FOREGROUND_TEMPLATES else [],
            }))

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
    # Second pass: workflow/node triggers must name a registered module-owned entry workflow.
    # This also catches unresolved template placeholders (for example DIRECTOR_ENABLED_FOREGROUND_ID),
    # which pass the runtime's ID-pattern check but never match a real workflow, so the triggered
    # workflow would silently never run.
    for component_file, owner_id, module_root in entries:
        directory = component_file.parent
        workflow = load_json(component_file, [])
        trigger = workflow.get("trigger") if isinstance(workflow, dict) else None
        trigger_documents = trigger.get("documents", {}) if isinstance(trigger, dict) else {}
        for node in (workflow.get("nodes", []) if isinstance(workflow, dict) and isinstance(workflow.get("nodes"), list) else []):
            if not isinstance(node, dict):
                continue
            metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
            entry = metadata.get("entryFile")
            if not isinstance(entry, str) or not entry.replace("\\", "/").endswith("runtime/run-deep-if-needed.mjs"):
                continue
            node_label = f"workflows/{directory.name}/workflow.json node {node.get('id')}"
            source = metadata.get("storyContextSource")
            declared_inputs = metadata.get("triggerInputs", []) if isinstance(metadata.get("triggerInputs"), list) else []
            has_story_mapping = isinstance(trigger_documents, dict) and "story-context" in trigger_documents
            has_story_input = "story-context" in declared_inputs
            if source not in {"trigger", "history"}:
                errors.append(f'{node_label} metadata.storyContextSource must be explicitly declared as "trigger" or "history"')
                continue
            if source == "trigger":
                if not has_story_mapping:
                    errors.append(f'{node_label} metadata.storyContextSource "trigger" requires trigger.documents.story-context')
                if not has_story_input:
                    errors.append(f'{node_label} metadata.storyContextSource "trigger" requires metadata.triggerInputs to include story-context')
            else:
                if has_story_mapping:
                    errors.append(f'{node_label} metadata.storyContextSource "history" must not map trigger.documents.story-context')
                if has_story_input:
                    errors.append(f'{node_label} metadata.storyContextSource "history" must not declare story-context in metadata.triggerInputs')
        if not isinstance(trigger, dict) or trigger.get("type") not in {"after-workflow", "node"}:
            continue
        target = trigger.get("workflowId")
        if not isinstance(target, str) or target not in workflow_kinds(root):
            errors.append(
                f"workflows/{directory.name}/workflow.json.trigger.workflowId must reference a card-local top-level workflow: {target!r}"
            )
            continue
        source = module_workflows.get(target, {})
        if trigger.get("type") == "node" and not any(isinstance(node, dict) and node.get("id") == trigger.get("nodeId") for node in source.get("nodes", [])):
            errors.append(f"{component_file.relative_to(root).as_posix()}.trigger.nodeId must reference a node of {target}")
        # Trigger documents are resolved against the *source* workflow's declared node outputs at
        # run time. Checking the reference structurally here is what catches the RC-06 class of
        # defect: a converted wrapper that keeps `metadata.triggerInputs` after the post-director
        # integration it was mapped from was replaced by one that produces different outputs. An
        # unreplaced mapping is syntactically valid and simply fails during play.
        documents = trigger.get("documents")
        if documents is None:
            continue
        if not isinstance(documents, dict):
            errors.append(f"workflows/{directory.name}/workflow.json.trigger.documents must be an object")
            continue
        source = module_workflows.get(target, {})
        source_nodes = {
            node.get("id"): node
            for node in (source.get("nodes", []) if isinstance(source, dict) and isinstance(source.get("nodes"), list) else [])
            if isinstance(node, dict) and isinstance(node.get("id"), str)
        }
        for input_id, mapping in sorted(documents.items()):
            mapping_label = f"workflows/{directory.name}/workflow.json.trigger.documents.{input_id}"
            if not isinstance(mapping, dict) or not isinstance(mapping.get("fromNode"), str) or not isinstance(mapping.get("output"), str):
                errors.append(f"{mapping_label} must declare fromNode and output")
                continue
            source_node = source_nodes.get(mapping["fromNode"])
            if source_node is None:
                errors.append(f"{mapping_label}.fromNode must reference a node of {target}: {mapping['fromNode']!r}")
                continue
            outputs = source_node.get("outputs") if isinstance(source_node.get("outputs"), dict) else {}
            output = outputs.get(mapping["output"])
            if not isinstance(output, dict):
                errors.append(
                    f"{mapping_label}.output must reference an output declared by {target}/{mapping['fromNode']}: {mapping['output']!r}"
                )
                continue
            scope = output.get("scope", "workflow")
            if scope not in {"turn", "session", "public"}:
                errors.append(f"{mapping_label} must map an output with turn, session, or public scope, not {scope!r}")
        # A node that reads a trigger input it was not authorized for would fail during play rather
        # than at conversion; the runtime enforces the same set.
        for node in (workflow.get("nodes", []) if isinstance(workflow.get("nodes"), list) else []):
            if not isinstance(node, dict):
                continue
            metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
            declared_inputs = metadata.get("triggerInputs", []) if isinstance(metadata.get("triggerInputs"), list) else []
            for input_id in declared_inputs:
                if input_id not in documents:
                    errors.append(
                        f"workflows/{directory.name}/workflow.json node {node.get('id')} metadata.triggerInputs references undeclared trigger document {input_id}"
                    )
            # The runtime delivers a trigger document to `trigger/<id>` in the node workspace only for
            # the ids the node declares, so a script that reads that path without declaring the input
            # fails with ENOENT on every run — the shape of the turn-1 dispatch failure. The check is
            # textual on purpose: it reads the script the node actually executes.
            entry = metadata.get("entryFile")
            if not isinstance(entry, str):
                continue
            entry_path = module_root / entry
            if not safe_relative_path(entry) or not entry_path.is_file():
                continue
            try:
                entry_text = entry_path.read_text(encoding="utf-8-sig")
            except OSError:
                continue
            for input_id in sorted({match for match in TRIGGER_DOCUMENT_READ.findall(entry_text)}):
                if input_id in documents and input_id not in declared_inputs:
                    errors.append(
                        f"workflows/{directory.name}/workflow.json node {node.get('id')} reads trigger/{input_id} in {entry} "
                        f"but does not declare metadata.triggerInputs: [{input_id!r}]"
                    )
    return ids
