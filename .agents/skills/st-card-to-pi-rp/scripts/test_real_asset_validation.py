"""Real-asset card validation regression.

Builds a complete fixture card from the assets this repository actually ships —
every project-global module, every runtime top-level workflow, and the coordinator's
integration templates — then runs the card validator over it and exercises the
positive/negative cases of the protocol-drift fixes. A second fixture lays the same
packages out as standalone roots, covering validation of the project-global sources
themselves, where no card manifest exists.

Deliberately avoids `tempfile`: some sandboxes deny the `chmod` that Python's
TemporaryDirectory performs. Both fixtures are built in git-ignored directories at the
repository root instead.

Usage:
    python -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_real_asset_validation.py
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
from pathlib import Path


def repository_root() -> Path:
    for candidate in [Path(__file__).resolve(), *Path(__file__).resolve().parents]:
        if (candidate / "PROJECT-RELEASE-MANIFEST.json").is_file():
            return candidate
    raise SystemExit("could not locate the repository root")


ROOT = repository_root()
SCRIPTS = ROOT / ".agents" / "skills" / "st-card-to-pi-rp" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import validate_card_pack as V  # noqa: E402

ASSETS = ROOT / ".agents" / "skills" / "st-card-to-pi-rp" / "assets"
FIXTURE = ROOT / ".tmp-card-validation"
SOURCE_FIXTURE = ROOT / ".tmp-module-source-validation"
MODULE_IDS = ["card-context-library", "narrative-memory", "local-scene-narrative",
              "world-scope-narrative", "world-narrative-coordinator", "comfy-image-generation"]
INTEGRATION = ROOT / "global-modules" / "world-narrative-coordinator" / "integration" / "workflows"
PLACEHOLDERS = {"DIRECTOR_ENABLED_FOREGROUND_ID": "standard-rp",
                "DIRECTOR_POST_WORKFLOW_ID": "director-post-turn"}

failures: list[str] = []


def report(label: str, errors: list[str], expect_empty: bool = True) -> None:
    ok = (not errors) == expect_empty
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}")
    for item in errors:
        print(f"        - {item}")
    if not ok:
        failures.append(label)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def module_source(module_id: str) -> Path:
    global_path = ROOT / "global-modules" / module_id
    return global_path if global_path.is_dir() else ASSETS / module_id


def run_cli(card: Path) -> list[str]:
    """Run the validator CLI in-process and return the captured error lines."""
    buffer = io.StringIO()
    argv = sys.argv
    sys.argv = ["validate_card_pack.py", str(card)]
    try:
        with contextlib.redirect_stderr(buffer):
            V.main()
    except SystemExit:
        pass
    finally:
        sys.argv = argv
    return [line for line in buffer.getvalue().splitlines() if line.startswith("error:")]


def build_fixture() -> None:
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    for directory in ("features", "workflows", "source", "openings", "core", "context"):
        (FIXTURE / directory).mkdir(parents=True)

    feature_modules, frontend_ids = [], []
    for module_id in MODULE_IDS:
        shutil.copytree(module_source(module_id), FIXTURE / "features" / module_id)
        feature_modules.append(f"features/{module_id}/module.json")
        if load(FIXTURE / "features" / module_id / "module.json").get("frontendViewFile"):
            frontend_ids.append(module_id)

    for directory in sorted(p for p in (ASSETS / "pi-rp-runtime" / "workflows").iterdir() if p.is_dir()):
        shutil.copytree(directory, FIXTURE / "workflows" / directory.name)

    write_json(FIXTURE / "manifest.json", {
        "schema_version": 2, "id": "fixture-card", "name": "夹具卡", "cover": None,
        "fixed_context": "core/foundation.md",
        "context_policy": "context/retrieval-policy.json",
        "context_processors": [],
        "feature_modules": feature_modules,
        "openings": [{"id": "opening-00", "title": "默认开场", "file": "openings/00.md", "source": "first_mes"}],
        "default_opening": "opening-00",
    })
    write_json(FIXTURE / "settings.json", {
        "schemaVersion": 1, "cardId": "fixture-card",
        "settings": {"activeWorkflowId": "standard-rp",
                     "featureModules": {"order": sorted(frontend_ids), "hidden": []}},
    })
    write_json(FIXTURE / "provenance.json", {"schema_version": 1, "source_units": [], "generated_passages": []})
    write_json(FIXTURE / "context" / "retrieval-policy.json", {
        "schemaVersion": 2, "source": "messages", "code": {"profile": "default"},
        "agent": {"mode": "disabled", "fallback": "code", "onNotTriggered": "code", "maxRecords": 100},
    })
    (FIXTURE / "core" / "foundation.md").write_text("# 夹具基础设定\n\n仅用于校验回归。\n", encoding="utf-8")
    (FIXTURE / "openings" / "00.md").write_text("---\nid: opening-00\ntitle: 默认开场\n---\n\n开场正文。\n", encoding="utf-8")
    (FIXTURE / "unresolved.md").write_text("# 未决内容\n\n无。\n", encoding="utf-8")
    (FIXTURE / "conversion-report.md").write_text("# 转换报告\n\n夹具。\n", encoding="utf-8")
    for web_file in ("server.mjs", "public/index.html", "public/app.js", "public/markdown.js",
                     "public/module-json.js", "public/styles.css"):
        target = FIXTURE / "web" / web_file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("// fixture\n", encoding="utf-8")

    # Card-owned support scripts: the converter copies assets/card-runtime/ into the card root.
    card_runtime = ASSETS / "card-runtime"
    if card_runtime.is_dir():
        shutil.copytree(card_runtime, FIXTURE, dirs_exist_ok=True)


def install_integration(replace: bool) -> None:
    for source in sorted(p for p in INTEGRATION.iterdir() if p.is_dir()):
        target = FIXTURE / "workflows" / source.name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target)
        if replace:
            path = target / "workflow.json"
            text = path.read_text(encoding="utf-8")
            for token, value in PLACEHOLDERS.items():
                text = text.replace(token, value)
            path.write_text(text, encoding="utf-8")


def build_source_fixture() -> list[str]:
    """Lay every shipped package out under its own directory, as `global-modules/` does."""
    if SOURCE_FIXTURE.exists():
        shutil.rmtree(SOURCE_FIXTURE)
    paths: list[str] = []
    for module_id in MODULE_IDS:
        shutil.copytree(module_source(module_id), SOURCE_FIXTURE / module_id)
        paths.append(f"{SOURCE_FIXTURE.name}/{module_id}/module.json")
    return paths


def source_errors(paths: list[str]) -> list[str]:
    errors: list[str] = []
    V.validate_feature_modules(ROOT, paths, errors)
    return errors


def count_advanced_bindings() -> int:
    total = 0
    for path in sorted((FIXTURE / "workflows").glob("*/workflow.json")):
        for node in load(path).get("nodes", []):
            for binding in node.get("workflowCalls", []) or []:
                if isinstance(binding, dict) and ({"maxCalls", "documentSnapshotInput"} & set(binding)):
                    total += 1
    return total


print("== building fixture from shipped assets ==")
build_fixture()
print(f"modules={len(MODULE_IDS)} workflows={len(list((FIXTURE / 'workflows').iterdir()))}")

print()
print("== shipped templates must validate cleanly ==")
baseline = run_cli(FIXTURE)
report("complete fixture card has no unexpected errors", baseline)

print()
print("== activeWorkflowId must reference a foreground workflow ==")
settings_path = FIXTURE / "settings.json"
settings_original = load(settings_path)
foreground_total = sorted(kind_id for kind_id, kind in V.workflow_kinds(FIXTURE).items() if kind == "foreground")
print(f"        （夹具含 {len(foreground_total)} 个前台工作流：{foreground_total}）")

broken = json.loads(json.dumps(settings_original))
broken["settings"]["activeWorkflowId"] = "narrative-memory-archive"
write_json(settings_path, broken)
report("negative: a non-foreground target must fail",
       [e for e in run_cli(FIXTURE) if "activeWorkflowId" in e], expect_empty=False)

alt = FIXTURE / "workflows" / "fixture-alt"
shutil.copytree(FIXTURE / "workflows" / "standard-rp", alt)
alt_json = load(alt / "workflow.json")
alt_json["id"], alt_json["title"] = "fixture-alt", "夹具备用前台"
write_json(alt / "workflow.json", alt_json)

broken = json.loads(json.dumps(settings_original))
broken["settings"].pop("activeWorkflowId", None)
write_json(settings_path, broken)
report("negative: multiple foreground workflows without the field must fail",
       [e for e in run_cli(FIXTURE) if "activeWorkflowId" in e], expect_empty=False)

shutil.rmtree(alt)
stash = FIXTURE / ".stash-advanced-memory-rp"
shutil.move(str(FIXTURE / "workflows" / "advanced-memory-rp"), str(stash))
report("positive: a single foreground workflow needs no explicit field",
       [e for e in run_cli(FIXTURE) if "activeWorkflowId" in e])
shutil.move(str(stash), str(FIXTURE / "workflows" / "advanced-memory-rp"))
write_json(settings_path, settings_original)

print()
print("== after-workflow triggers must reference a card-local workflow ==")
install_integration(replace=False)
report("negative: an unreplaced placeholder ID must fail",
       [e for e in run_cli(FIXTURE) if "trigger.workflowId" in e], expect_empty=False)

install_integration(replace=True)
report("positive: replaced placeholders must not fail",
       [e for e in run_cli(FIXTURE) if "trigger.workflowId" in e])

print()
print("== module workflow nodes share the call checks ==")
coordinator_call = FIXTURE / "features" / "world-narrative-coordinator" / "workflows" / "post-director-update" / "workflow.json"
coordinator_text = coordinator_call.read_text(encoding="utf-8")
coordinator_call.write_text(coordinator_text.replace('"target": "card-context-library/export-context"',
                                                    '"target": "card-context-library/export-context-typo"'),
                            encoding="utf-8")
report("negative: a misspelled module call target must fail",
       [e for e in run_cli(FIXTURE) if "must reference a declared module workflow" in e], expect_empty=False)
coordinator_call.write_text(coordinator_text, encoding="utf-8")

local_call = FIXTURE / "features" / "local-scene-narrative" / "workflows" / "create-story-candidate" / "workflow.json"
local_text = local_call.read_text(encoding="utf-8")
local_call.write_text(local_text.replace("narrative-memory/narrative-memory-retrieve",
                                         "narrative-memory/narrative-memory-retrive"), encoding="utf-8")
report("negative: a misspelled module workflowCalls target must fail",
       [e for e in run_cli(FIXTURE) if "must reference a declared module workflow" in e], expect_empty=False)
local_call.write_text(local_text, encoding="utf-8")
report("positive: restored module workflows report no call errors",
       [e for e in run_cli(FIXTURE) if "must reference a declared module workflow" in e])

print()
print("== code node entries must exist inside the card ==")
installed = FIXTURE / "runtime" / "workflow" / "prepare-recent-narrative-stories.mjs"
if not installed.is_file():
    failures.append("fixture did not install the card-runtime asset")
    print("[FAIL] fixture did not install the card-runtime asset")
else:
    stash = FIXTURE / ".stash-entry.mjs"
    shutil.move(str(installed), str(stash))
    report("negative: a missing card script must fail",
           [e for e in run_cli(FIXTURE) if "metadata.entryFile" in e], expect_empty=False)
    shutil.move(str(stash), str(installed))
    report("positive: an installed card script reports no entryFile error",
           [e for e in run_cli(FIXTURE) if "metadata.entryFile" in e])

module_entry = FIXTURE / "features" / "narrative-memory" / "runtime" / "workflow" / "prepare-archive.mjs"
module_stash = FIXTURE / ".stash-module-entry.mjs"
shutil.move(str(module_entry), str(module_stash))
report("negative: a missing installed module script must fail inside the card",
       [e for e in run_cli(FIXTURE) if "metadata.entryFile" in e], expect_empty=False)
shutil.move(str(module_stash), str(module_entry))
report("positive: a restored module script reports no entryFile error",
       [e for e in run_cli(FIXTURE) if "metadata.entryFile" in e])

print()
print("== shipped packages must validate from their own source tree ==")
source_paths = build_source_fixture()
report("every shipped package validates without a card manifest", source_errors(source_paths))

target_workflow = SOURCE_FIXTURE / "narrative-memory" / "workflows" / "narrative-memory-archive" / "workflow.json"
target_original = target_workflow.read_text(encoding="utf-8")
target_workflow.write_text(target_original.replace('"narrative-memory/narrative-memory-reference-snapshot"',
                                                  '"narrative-memory/narrative-memory-reference-snapshott"'),
                           encoding="utf-8")
report("negative: an undeclared qualified target must fail from the source tree",
       [e for e in source_errors(source_paths) if "must reference a declared module workflow" in e],
       expect_empty=False)
target_workflow.write_text(target_original, encoding="utf-8")

source_entry = SOURCE_FIXTURE / "narrative-memory" / "workflows" / "narrative-memory-range-repair" / "workflow.json"
source_entry_original = source_entry.read_text(encoding="utf-8")
source_entry.write_text(source_entry_original.replace("features/narrative-memory/runtime/workflow/prepare-range-repair.mjs",
                                                      "features/narrative-memory/runtime/workflow/prepare-range-repair-missing.mjs"),
                        encoding="utf-8")
report("negative: a module entry file missing from its own package must fail",
       [e for e in source_errors(source_paths) if "metadata.entryFile" in e], expect_empty=False)
source_entry.write_text(source_entry_original, encoding="utf-8")
report("positive: restored package sources report no entryFile error",
       [e for e in source_errors(source_paths) if "metadata.entryFile" in e])

print()
print("== frontend region types and call bindings ==")
for module_id in ("local-scene-narrative", "world-scope-narrative"):
    module_root = FIXTURE / "features" / module_id
    errors: list[str] = []
    V.validate_frontend_view_v2(load(module_root / "frontend-view.json"),
                                load(module_root / "data-contract.json"),
                                f"{module_id}.frontend-view", errors)
    report(f"{module_id} story-browser region passes", errors)

view = load(FIXTURE / "features" / "local-scene-narrative" / "frontend-view.json")
contract = load(FIXTURE / "features" / "local-scene-narrative" / "data-contract.json")
broken_view = json.loads(json.dumps(view))
broken_view["regions"][0]["indexView"] = "not-a-declared-view"
errors = []
V.validate_frontend_view_v2(broken_view, contract, "negative.indexView", errors)
report("negative: an undeclared indexView must fail", errors, expect_empty=False)

advanced = count_advanced_bindings()
print(f"        （夹具中携带 maxCalls / documentSnapshotInput 的绑定：{advanced} 处）")
report("fixture exercises the advanced binding fields", [] if advanced else ["not covered"])

print()
if failures:
    print(f"RESULT: {len(failures)} check(s) failed")
    for item in failures:
        print(f"  - {item}")
    raise SystemExit(1)
print("RESULT: all checks passed")
