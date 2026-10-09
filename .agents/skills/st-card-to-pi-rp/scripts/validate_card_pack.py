#!/usr/bin/env python3
"""Validate the structural contract of a converted Pi RP card pack."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

# 文件系统与 JSON 辅助已拆分到 validation/ 子包（方案 §13 第 1 条：共享辅助只保留一份）。
# 这里按名重新导出，使本模块的公开接口与拆分前一致（测试与调用方无需改动）。
#
# 引导 sys.path：本文件可能以三种方式加载——CLI 直接执行、importlib 按路径加载、unittest 发现。
# 其中后两种不会自动把所在目录加入 sys.path，因此显式加入（幂等）。
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

from validation.filesystem import load_json, require_file, safe_relative_path  # noqa: E402
# manifest/provenance 及其专属辅助已拆分到 validation/manifest.py（方案 §13）。
from validation.manifest import (  # noqa: E402
    JPEG_SIGNATURE,
    PNG_SIGNATURE,
    SKILL_DESCRIPTION_LIMIT,
    SKILL_FRONTMATTER,
    declared_module_ids,
    extracted_source_requires_cover,
    supported_image_type,
    validate_context_processors,
    validate_manifest,
    validate_prompt_references,
    validate_provenance,
    validate_retrieval_policy,
    validate_skill_frontmatter,
)
# 前端/资源/时间适配器等规则已拆分到 validation/frontend.py（方案 §13）。
# 按名重新导出以保持本模块公开接口不变。
from validation.frontend import (  # noqa: E402
    validate_frontend_view_v2,
    validate_prompt_controls_resources,
    validate_resource_catalog,
    validate_time_adapter,
)
# 协议常量已拆分到 validation/shared.py（S8 第 0 层），此处按名重新导出以保持公开接口不变。
from validation.shared import (  # noqa: E402
    ALLOWED_STATUSES,
    ALLOWED_TRANSFORMS,
    RUNTIME_SERVICES,
    CHARACTER_MACROS,
    PLAYER_MACROS,
    STRUCTURAL_FIELDS,
    SHIPPED_FOREGROUND_TEMPLATES,
    SHIPPED_MEMORY_FOREGROUND_TEMPLATES,
    NARRATIVE_AGENT_REQUIRED_CALLS,
    DESIGN_WARNING_PREFIX,
    DESIGN_INVARIANT_FIELDS,
    WRITE_ACTIONS,
    TRIGGER_DOCUMENT_READ,
)
# 模块/资源层已拆分到 validation/resources.py（S8 第 5 层）；按名重新导出以保持公开接口不变。
#
# 该导入**放在这里**（而不是文件末尾）：resources 层不再反向引用主入口，因此不会形成循环导入。
from validation.resources import (  # noqa: E402
    component_ref,
    declared_frontend_module_ids,
    manifest_module_paths,
    module_component_entries,
    module_contract_map,
    module_resource_catalog_map,
    module_surface_paths,
    module_workflow_map,
    validate_code_node_entry,
    validate_data_record_v2,
    validate_design_invariants,
    validate_director_prompt,
    validate_feature_modules,
    validate_module_call_surface,
    validate_name_templates,
    validate_record,
    validate_runtime_services,
    workflow_kinds,
)
# 工作流校验已拆分到 validation/workflows.py（S8 第 4 层）；按名重新导出以保持公开接口不变。
# workflows 从 validation/resources.py 取它需要的跨层辅助，同样不反向引用主入口。
from validation.workflows import (  # noqa: E402
    REQUIRED_FIELD_CACHE,
    capability_actions,
    foreground_design_problems,
    required_record_fields,
    validate_workflows,
    view_covers_record,
)

# The shipped foreground templates. Their design conventions are reported as warnings, because a
# card is free to rename, replace, or decouple its foreground workflow: an assertion keyed on a
# literal workflow ID stops applying the moment the card renames it. A card that wants the
# convention enforced declares the equivalent `manifest.design_invariants`, and the same checks
# become errors.

# Loadable Skill contract, mirrored from the runtime `rp-skill-contract.mjs`. Both the extension
# and this validator read the same two facts, so the same positive and negative fixtures in
# `test_real_asset_validation.py` and `rp-skill-contract.test.mjs` guard against rule drift.
# Actions that change a record's data. A node holding any of them must be able to read the whole
# record, because the runtime validates the updated record against its schema.

# A node script reading a staged trigger document. The runtime stages them at `trigger/<id>`, so the
# path literal is the declaration the node owes `metadata.triggerInputs`.

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
    invariants = validate_design_invariants(root, manifest, errors)
    validate_manifest(root, manifest, errors, warnings)
    validate_name_templates(root, errors)
    validate_prompt_references(root, errors)
    validate_provenance(root, provenance, errors, warnings)
    workflow_ids = validate_workflows(root, errors, warnings, invariants)
    if isinstance(card_settings, dict):
        if card_settings.get("schemaVersion") != 1:
            errors.append("settings schemaVersion must be 1")
        if isinstance(manifest, dict) and card_settings.get("cardId") != manifest.get("id"):
            errors.append("settings cardId must match manifest id")
        if not isinstance(card_settings.get("settings"), dict):
            errors.append("settings settings must be an object")
        else:
            active_workflow = card_settings["settings"].get("activeWorkflowId")
            kinds = workflow_kinds(root)
            foreground_ids = sorted(workflow_id for workflow_id, kind in kinds.items() if kind == "foreground")
            if not foreground_ids:
                errors.append("card must declare a foreground workflow inside a registered feature module")
            if active_workflow is not None:
                if active_workflow not in workflow_ids:
                    errors.append("settings activeWorkflowId must reference a card-local workflow")
                elif kinds.get(active_workflow) != "foreground":
                    errors.append("settings activeWorkflowId must reference a foreground workflow")
            elif len(foreground_ids) > 1:
                errors.append(
                    f"settings activeWorkflowId is required when the card declares multiple foreground workflows: {foreground_ids}"
                )
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
    if any(warning.startswith(DESIGN_WARNING_PREFIX) for warning in warnings):
        print(
            "note: design warnings are the shipped templates' conventions, not requirements. A card that "
            "deliberately differs keeps validating; to make a convention binding, declare it in "
            "manifest.design_invariants and it becomes an error."
        )
    if errors:
        print(f"validation failed with {len(errors)} error(s) and {len(warnings)} warning(s)", file=sys.stderr)
        return 1
    print(f"validation passed with {len(warnings)} warning(s)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
