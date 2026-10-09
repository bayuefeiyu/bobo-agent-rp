"""S8 拆分第 3 层：manifest、provenance、上下文处理器与检索策略。

方案 §13 第 1 条把校验器按"模块/资源、工作流、manifest/provenance"分组；本模块承担其中
**manifest/provenance** 一组，外加只被该组使用的辅助（技能 frontmatter、模块 ID 声明、
提示词引用、图片类型判定）。

**诊断文案与行为与拆分前逐字一致**；所有错误文本都从原实现原样搬来。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .authoring import (
    SKILL_DESCRIPTION_LIMIT,
    SKILL_FRONTMATTER,
    _skill_scalar,
    validate_skill_frontmatter,
)
from .filesystem import load_json, require_file, safe_relative_path
from .shared import ALLOWED_STATUSES, ALLOWED_TRANSFORMS, DESIGN_WARNING_PREFIX

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


def validate_prompt_references(root: Path, errors: list[str]) -> None:
    # 延迟导入：`module_component_entries` 属于"模块资源"层，留在主校验器内。
    from .resources import module_component_entries

    for loose in ("agents", "workflows", "prompts/agents", "prompts/workflows", "prompts/modules"):
        directory = root / loose
        if directory.is_dir() and any(directory.iterdir()):
            errors.append(f"Unowned components are forbidden in card/{loose}; use a feature module")
    for field in ("agentFiles", "workflowFiles"):
        for path, owner_id, module_root in module_component_entries(root, field):
            document = load_json(path, errors)
            label = path.relative_to(root).as_posix()
            if not isinstance(document, dict):
                continue
            if document.get("ownerModuleId") != owner_id:
                errors.append(f"{label}.ownerModuleId must match {owner_id}")

            def visit(value: Any, at: str) -> None:
                if isinstance(value, list):
                    for index, child in enumerate(value):
                        visit(child, f"{at}[{index}]")
                elif isinstance(value, dict):
                    if "promptFile" in value:
                        prompt = value["promptFile"]
                        if not safe_relative_path(prompt) or not prompt.startswith("prompts/"):
                            errors.append(f"{at}.promptFile must be a safe module-relative path under prompts/")
                        elif not (module_root / prompt).is_file():
                            errors.append(f"{at}.promptFile does not exist: {prompt}")
                        if "prompt" in value:
                            errors.append(f"{at} must not duplicate prompt text when promptFile is present")
                    for key, child in value.items():
                        visit(child, f"{at}.{key}")
            visit(document, label)


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


def validate_manifest(root: Path, manifest: Any, errors: list[str], warnings: list[str]) -> None:
    # 延迟导入：`validate_feature_modules` 属于"模块资源"层，留在主校验器内。
    from .resources import validate_feature_modules

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
        validate_skill_frontmatter(root, context_skill_path, "context_skill", errors)

    validate_feature_modules(root, manifest.get("feature_modules"), errors, warnings)
    module_ids = declared_module_ids(root, manifest)
    if "card-context-library" not in module_ids:
        errors.append("manifest feature_modules must include the card-context-library resource module")
    if "world-narrative-coordinator" in module_ids:
        # Both statements below are design conventions, and both are stated structurally by the
        # coordinator's own workflow calls: an uninstalled `narrative-memory` or a missing
        # `director-future` category is already a hard error from the module call checks. They stay
        # here as a readable second line of defence, not as a second gate.
        if "narrative-memory" not in module_ids:
            warnings.append(f"{DESIGN_WARNING_PREFIX}world-narrative-coordinator requires the narrative-memory module")
        context_catalog = None
        for module_path in manifest.get("feature_modules", []):
            if not safe_relative_path(module_path):
                continue
            module = load_json(root / module_path, [])
            if isinstance(module, dict) and module.get("id") == "card-context-library" and safe_relative_path(module.get("resourceCatalogFile")):
                context_catalog = load_json((root / module_path).parent / module["resourceCatalogFile"], [])
                break
        if not isinstance(context_catalog, dict) or "director-future" not in context_catalog.get("categories", {}):
            warnings.append(f"{DESIGN_WARNING_PREFIX}world-narrative-coordinator requires card-context-library category director-future")
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
