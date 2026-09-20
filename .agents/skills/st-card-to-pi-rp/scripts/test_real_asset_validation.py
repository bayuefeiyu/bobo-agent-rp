"""Real-asset card validation regression.

Builds a complete fixture card from the assets this repository actually ships —
every project-global module, every runtime top-level workflow, and the coordinator's
integration templates — then runs the card validator over it and exercises the
positive/negative cases of the protocol-drift fixes. A second fixture lays the same
packages out as standalone roots, covering validation of the project-global sources
themselves, where no card manifest exists.

Deliberately avoids `tempfile`: some sandboxes deny the `chmod` that Python's
TemporaryDirectory performs. Both fixtures are built under the git-ignored local
development records directory instead.

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
LOCAL_TEMP = ROOT / "local-development-records" / "temp"
FIXTURE = LOCAL_TEMP / "card-validation"
SOURCE_FIXTURE = LOCAL_TEMP / "module-source-validation"
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


def run_cli_warnings(card: Path) -> list[str]:
    """Run the validator CLI in-process and return the captured warning lines."""
    buffer = io.StringIO()
    argv = sys.argv
    sys.argv = ["validate_card_pack.py", str(card)]
    try:
        with contextlib.redirect_stdout(buffer):
            V.main()
    except SystemExit:
        pass
    finally:
        sys.argv = argv
    return [line[len("warning: "):] for line in buffer.getvalue().splitlines() if line.startswith("warning: ")]


def design_warnings(card: Path) -> list[str]:
    return [warning for warning in run_cli_warnings(card) if warning.startswith("design: ")]


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
    fixture_prefix = SOURCE_FIXTURE.relative_to(ROOT).as_posix()
    for module_id in MODULE_IDS:
        shutil.copytree(module_source(module_id), SOURCE_FIXTURE / module_id)
        paths.append(f"{fixture_prefix}/{module_id}/module.json")
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
print("== trigger documents must resolve against the source workflow's outputs ==")

# RC-06: the converted wrapper kept `metadata.triggerInputs: ["story-context"]` after its post
# -director integration was swapped for one whose review node produced no such output, so the whole
# wrapper normalized as invalid. The reference is structurally checkable at conversion time.
deep_wrapper = FIXTURE / "workflows" / "director-deep-wrapper" / "workflow.json"
deep_original = deep_wrapper.read_text(encoding="utf-8")
deep_document = json.loads(deep_original)
report("positive: the shipped deep wrapper resolves its trigger document",
       [e for e in run_cli(FIXTURE) if "trigger.documents" in e or "triggerInputs" in e or "storyContextSource" in e])

broken = json.loads(deep_original)
broken["nodes"][0]["metadata"].pop("storyContextSource", None)
write_json(deep_wrapper, broken)
report("negative: a deep wrapper must declare its story-context source explicitly",
       [e for e in run_cli(FIXTURE) if "metadata.storyContextSource must be explicitly declared" in e],
       expect_empty=False)

broken = json.loads(deep_original)
broken["nodes"][0]["metadata"]["storyContextSource"] = "history"
write_json(deep_wrapper, broken)
report("negative: a trigger-backed deep wrapper must not fall back to history",
       [e for e in run_cli(FIXTURE) if 'metadata.storyContextSource "history" must not' in e],
       expect_empty=False)

broken = json.loads(deep_original)
broken["trigger"]["documents"]["story-context"] = {"fromNode": "no-such-node", "output": "story-context"}
write_json(deep_wrapper, broken)
report("negative: a trigger document naming an absent upstream node must fail",
       [e for e in run_cli(FIXTURE) if "trigger.documents.story-context.fromNode must reference a node of" in e],
       expect_empty=False)

broken = json.loads(deep_original)
broken["trigger"]["documents"]["story-context"] = {"fromNode": "review", "output": "no-such-output"}
write_json(deep_wrapper, broken)
report("negative: a trigger document naming an output the upstream node never declares must fail",
       [e for e in run_cli(FIXTURE) if "trigger.documents.story-context.output must reference an output declared by" in e],
       expect_empty=False)

broken = json.loads(deep_original)
broken["trigger"]["documents"] = {}
write_json(deep_wrapper, broken)
report("negative: a node reading an unmapped trigger input must fail",
       [e for e in run_cli(FIXTURE) if "metadata.triggerInputs references undeclared trigger document story-context" in e],
       expect_empty=False)

# The with-narratives integration reviews through `post-director`, whose only output is the
# delegation plan. Re-pointing the wrapper at it — the conversion mistake that produced RC-06 —
# keeps a syntactically valid mapping that can never resolve, so it must be rejected.
broken = json.loads(deep_original)
broken["trigger"]["workflowId"] = "director-post-with-narratives"
broken["trigger"]["documents"]["story-context"] = {"fromNode": "post-director", "output": "story-context"}
write_json(deep_wrapper, broken)
report("negative: pointing the wrapper at an integration without that output must fail",
       [e for e in run_cli(FIXTURE) if "trigger.documents.story-context.output must reference an output declared by director-post-with-narratives/post-director" in e],
       expect_empty=False)
deep_wrapper.write_text(deep_original, encoding="utf-8")
report("positive: restoring the shipped wrapper clears the trigger-document findings",
       [e for e in run_cli(FIXTURE) if "trigger.documents" in e or "triggerInputs" in e or "storyContextSource" in e])

report("positive: the opening deep wrapper explicitly permits history",
       [e for e in run_cli(FIXTURE) if "director-opening-deep-wrapper" in e and "storyContextSource" in e])

print()
print("== deep wrappers must authorize every call their runtime script makes ==")

# The wrapper's code node drives begin/planning/commit/finish. A template that declares only the
# planning call makes the node fail before any model runs — the same mismatch class as RC-06.
DEEP_RUNTIME_CALLS = {
    "director-deep-wrapper": [
        "world-narrative-coordinator/begin-deep-operation",
        "world-narrative-coordinator/deep-director-planning",
        "world-narrative-coordinator/deep-director-team-planning",
        "world-narrative-coordinator/commit-deep-operation",
        "world-narrative-coordinator/finish-deep-operation",
    ],
    "director-opening-deep-wrapper": [
        "world-narrative-coordinator/begin-deep-operation",
        "world-narrative-coordinator/deep-director-planning",
        "world-narrative-coordinator/finish-deep-operation",
    ],
}
for wrapper_id, expected in DEEP_RUNTIME_CALLS.items():
    wrapped = load(FIXTURE / "workflows" / wrapper_id / "workflow.json")
    declared = wrapped["nodes"][0].get("workflowCalls", [])
    missing = [target for target in expected if target not in declared]
    report(f"{wrapper_id} authorizes every call its script makes", missing)

print()
print("== nodes that write a record must be able to read the whole record ==")

# The runtime renders a read through the view the node asked for, and an `update` carries the whole
# record data. A writer holding only a projection (`deep-status` hides the world-time fields) cannot
# produce a valid update: the batch is rejected by the record schema, so the failure the node was
# recording is lost and the operation stays open. This is the shape of the run-3 stuck-operation bug.
for wrapper_id in DEEP_RUNTIME_CALLS:
    wrapper_path = FIXTURE / "workflows" / wrapper_id / "workflow.json"
    wrapper_original = wrapper_path.read_text(encoding="utf-8")
    narrowed = load(wrapper_path)
    for node in narrowed["nodes"]:
        for access in node.get("moduleAccess", []):
            if access.get("collectionId") == "deep-workbench" and "director.deep.write" in access.get("capabilities", []):
                access["views"] = ["deep-status"]
    write_json(wrapper_path, narrowed)
    report(f"negative: {wrapper_id} granted only the deep-status projection must fail",
           [e for e in run_cli(FIXTURE) if "cannot produce a valid update" in e], expect_empty=False)
    wrapper_path.write_text(wrapper_original, encoding="utf-8")
    report(f"positive: restoring {wrapper_id} clears the view-coverage findings",
           [e for e in run_cli(FIXTURE) if "cannot produce a valid update" in e])

print()
print("== a node that reads a staged trigger document must declare it ==")

# The runtime stages a run's frozen trigger documents at `trigger/<id>` in the node workspace, but
# only for the ids the node declares. `dispatch-story-candidate.mjs` reads `trigger/turn-context`
# unconditionally, so dropping the declaration reproduces the real turn-1 dispatch failure
# (`ENOENT … dispatch-local/trigger/turn-context`) at conversion time instead of during play.
post_workflow = FIXTURE / "workflows" / "director-post-with-narratives" / "workflow.json"
post_original = post_workflow.read_text(encoding="utf-8")
undeclared = load(post_workflow)
for node in undeclared["nodes"]:
    if node.get("id") == "dispatch-local":
        node["metadata"].pop("triggerInputs", None)
write_json(post_workflow, undeclared)
report("negative: a node reading trigger/turn-context without declaring it must fail",
       [e for e in run_cli(FIXTURE) if "does not declare metadata.triggerInputs" in e], expect_empty=False)
post_workflow.write_text(post_original, encoding="utf-8")
report("positive: restoring the declaration clears the trigger-read findings",
       [e for e in run_cli(FIXTURE) if "does not declare metadata.triggerInputs" in e])

print()
print("== a configured time rule needs an implemented adapter ==")

# The real card that failed its first archive documented its whole time rule in
# `config/time-system.json` (format, granularity, sort algorithm, examples) while
# `runtime/time-adapter.mjs` was still the module's throwing stub. Every static check passed and the
# failure only appeared when an archived event needed its `sortValue`.
time_declaration = FIXTURE / "features" / "narrative-memory" / "config" / "time-system.json"
time_adapter = FIXTURE / "features" / "narrative-memory" / "runtime" / "time-adapter.mjs"
declaration_original = time_declaration.read_text(encoding="utf-8")
adapter_original = time_adapter.read_text(encoding="utf-8")
configured = load(time_declaration)
configured["configured"] = True
configured["timeRuleVersion"] = "fixture-days-v1"
write_json(time_declaration, configured)
report("negative: a documented time rule with the stub adapter must fail",
       [e for e in run_cli(FIXTURE) if "is still the unconfigured stub" in e], expect_empty=False)

adapter_configured = adapter_original.replace('export const timeRuleVersion = "unconfigured";',
                                              'export const timeRuleVersion = "other-rule-v1";')
time_adapter.write_text(adapter_configured, encoding="utf-8")
report("negative: an adapter whose rule version contradicts the declaration must fail",
       [e for e in run_cli(FIXTURE) if "but config/time-system.json declares" in e], expect_empty=False)

time_declaration.write_text(declaration_original, encoding="utf-8")
report("negative: an implemented adapter with an unconfigured declaration must fail",
       [e for e in run_cli(FIXTURE) if "is not configured" in e], expect_empty=False)

time_adapter.write_text(adapter_original, encoding="utf-8")
report("positive: the shipped pair (unconfigured rule and stub adapter) validates",
       [e for e in run_cli(FIXTURE) if "time-adapter" in e or "time-system" in e])

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
print("== shipped module Skills must be loadable, not merely present ==")

# RC-01: `local-scene-narrative` shipped a Skill with no YAML frontmatter, so the bridge refused to
# start the card even though every file existed. These checks assert the header contract, not file
# presence, and the runtime mirrors them in `rp-skill-contract.mjs`.
for module_id in MODULE_IDS:
    module_root = FIXTURE / "features" / module_id
    module_manifest = load(module_root / "module.json")
    skill_relative = module_manifest.get("skillFile")
    skill_findings: list[str] = []
    V.validate_skill_frontmatter(module_root, skill_relative, f"{module_id}.skillFile", skill_findings)
    report(f"{module_id} publishes a loadable Skill header", skill_findings)

skill_path = FIXTURE / "features" / "local-scene-narrative" / "skill" / "SKILL.md"
skill_original = skill_path.read_text(encoding="utf-8")
# The validator labels a module Skill by its `feature_modules` slot, so match the contract suffix
# and keep the fixture's module ordering free to change.
SKILL_HEADER_ERROR = ".skillFile must start with YAML frontmatter"
SKILL_NAME_ERROR = ".skillFile frontmatter must contain a one-line name"
SKILL_DESCRIPTION_ERROR = ".skillFile frontmatter must contain a one-line description"
skill_body = skill_original.split("---", 2)[2].lstrip("\n")
skill_path.write_text(skill_body, encoding="utf-8")
report("negative: a module Skill without frontmatter must fail",
       [e for e in run_cli(FIXTURE) if e.endswith(SKILL_HEADER_ERROR)], expect_empty=False)
# Rebuild each negative header literally instead of editing the original one: byte-level
# replacements over the CJK body are not guaranteed to survive a POSIX-locale round trip.
skill_path.write_text(f"---\nname: local-scene-narrative\nnote: A description.\n---\n\n{skill_body}", encoding="utf-8")
report("negative: a module Skill without a one-line description must fail",
       [e for e in run_cli(FIXTURE) if e.endswith(SKILL_DESCRIPTION_ERROR)], expect_empty=False)
skill_path.write_text(f"---\nname: local-scene-narrative\ndescription: |\n  A description.\n---\n\n{skill_body}", encoding="utf-8")
report("negative: a block-scalar description is not a one-line description",
       [e for e in run_cli(FIXTURE) if e.endswith(SKILL_DESCRIPTION_ERROR)], expect_empty=False)
skill_path.write_text(f"---\ntitle: local-scene-narrative\ndescription: A description.\n---\n\n{skill_body}", encoding="utf-8")
report("negative: a module Skill without a name must fail",
       [e for e in run_cli(FIXTURE) if e.endswith(SKILL_NAME_ERROR)], expect_empty=False)
skill_path.write_text(skill_original, encoding="utf-8")
report("positive: the restored module Skill reports no header error",
       [e for e in run_cli(FIXTURE) if ".skillFile" in e])

print()
print("== shipped design conventions warn; a card's own invariants bind ==")

KNOWN_FIXTURE_WARNING = "manifest source metadata is missing"
report("the shipped card emits only the known fixture warning",
       [w for w in run_cli_warnings(FIXTURE) if w != KNOWN_FIXTURE_WARNING])


def set_node_field(workflow_name: str, node_id: str, field: str, value) -> str:
    """Return the original text of one fixture workflow with a node field replaced."""
    path = FIXTURE / "workflows" / workflow_name / "workflow.json"
    original = path.read_text(encoding="utf-8")
    document = json.loads(original)
    for node in document["nodes"]:
        if node["id"] == node_id:
            node[field] = value
            break
    else:
        raise SystemExit(f"fixture workflow {workflow_name} has no node {node_id}")
    write_json(path, document)
    return original


def restore(workflow_name: str, original: str) -> None:
    (FIXTURE / "workflows" / workflow_name / "workflow.json").write_text(original, encoding="utf-8")


standard_original = set_node_field("standard-rp", "prepare-card-context", "type", "code")
report("negative: dropping the shipped convention warns without blocking",
       [w for w in design_warnings(FIXTURE) if "must prepare card-context-library resources before narration" in w],
       expect_empty=False)
report("the same card still reports no error", run_cli(FIXTURE))
restore("standard-rp", standard_original)
report("positive: the shipped workflow reports no design warning", design_warnings(FIXTURE))

manifest_path = FIXTURE / "manifest.json"
manifest_original = load(manifest_path)
declared = json.loads(json.dumps(manifest_original))
declared["design_invariants"] = {"foregroundWorkflow": "standard-rp", "requiresCardContextResources": True}
write_json(manifest_path, declared)
report("positive: a declared invariant the card satisfies reports no error", run_cli(FIXTURE))

standard_original = set_node_field("standard-rp", "prepare-card-context", "type", "code")
report("negative: a declared invariant the card violates fails validation",
       [e for e in run_cli(FIXTURE) if "must prepare card-context-library resources before narration" in e],
       expect_empty=False)
report("positive: a declared invariant suppresses the matching design warning",
       [w for w in design_warnings(FIXTURE) if "before narration" in w])
restore("standard-rp", standard_original)

advanced_original = set_node_field("advanced-memory-rp", "prepare-card-context", "dependsOn", ["prepare-document-workspace"])
report("negative: a violation of an undeclared convention only warns",
       [w for w in design_warnings(FIXTURE) if "effective memory timeline" in w], expect_empty=False)
report("positive: the violated convention is not an error while undeclared", run_cli(FIXTURE))

declared = json.loads(json.dumps(manifest_original))
declared["design_invariants"] = {
    "foregroundWorkflow": "advanced-memory-rp",
    "requiresEffectiveMemoryTimeline": True,
    "requiresNarrativeAgentCallable": ["narrative-memory/narrative-memory-retrieve"],
}
write_json(manifest_path, declared)
report("negative: the same violation fails once declared",
       [e for e in run_cli(FIXTURE) if "effective memory timeline" in e], expect_empty=False)
restore("advanced-memory-rp", advanced_original)
report("positive: restoring the shipped ordering satisfies the declared invariant", run_cli(FIXTURE))

advanced_original = set_node_field("advanced-memory-rp", "write-narrative", "workflowCalls",
                                   ["world-narrative-coordinator/pre-director-update", "world-narrative-coordinator/materialize-guidance"])
report("negative: a declared Agent callable requirement fails when the narrative Agent drops it",
       [e for e in run_cli(FIXTURE) if "narrative Agent must expose narrative-memory/narrative-memory-retrieve" in e],
       expect_empty=False)
restore("advanced-memory-rp", advanced_original)

declared = json.loads(json.dumps(manifest_original))
declared["design_invariants"] = {"foregroundWorkflow": "standard-rp", "requiresNarativeAgentCallable": []}
write_json(manifest_path, declared)
report("negative: an unknown invariant field must fail",
       [e for e in run_cli(FIXTURE) if "design_invariants" in e], expect_empty=False)

declared = json.loads(json.dumps(manifest_original))
declared["design_invariants"] = {"foregroundWorkflow": "no-such-workflow"}
write_json(manifest_path, declared)
report("negative: an invariant naming an unknown workflow must fail",
       [e for e in run_cli(FIXTURE) if "design_invariants.foregroundWorkflow" in e], expect_empty=False)

declared = json.loads(json.dumps(manifest_original))
declared["design_invariants"] = {"requiresCardContextResources": True}
write_json(manifest_path, declared)
report("negative: an invariant without its subject workflow must fail",
       [e for e in run_cli(FIXTURE) if "foregroundWorkflow is required" in e], expect_empty=False)
write_json(manifest_path, manifest_original)
report("positive: removing the declaration restores a clean validation", run_cli(FIXTURE))

print()
print("== module dependency sidecars must match the shipped modules ==")


def workflow_calls(module_root: Path, module: dict) -> set[str]:
    """Every module-workflow reference this module's own workflows declare."""
    targets: set[str] = set()
    for relative in module.get("workflowFiles", []):
        document = load(module_root / relative)
        for node in document.get("nodes", []):
            if node.get("type") == "call" and isinstance(node.get("target"), str):
                targets.add(node["target"])
            for binding in node.get("workflowCalls", []) or []:
                target = binding if isinstance(binding, str) else binding.get("target")
                if isinstance(target, str):
                    targets.add(target)
    return targets


shipped_modules = {module_id: module_source(module_id) for module_id in MODULE_IDS}
sidecar_findings: list[str] = []
sidecars = 0
for module_id, module_root in shipped_modules.items():
    sidecar = module_root / "dependencies.json"
    if not sidecar.is_file():
        continue
    sidecars += 1
    document = load(sidecar)
    if document.get("schemaVersion") != 1 or document.get("moduleId") != module_id:
        sidecar_findings.append(f"{module_id}: dependencies.json must be schemaVersion 1 for {module_id}")
        continue
    declared = document.get("structuralRequires", [])
    actual = {target.split("/")[0] for target in workflow_calls(module_root, load(module_root / "module.json"))}
    for dependency in declared:
        if dependency not in shipped_modules:
            sidecar_findings.append(f"{module_id}: structuralRequires names an unknown module: {dependency}")
        elif dependency not in actual:
            sidecar_findings.append(f"{module_id}: structuralRequires claims {dependency}, but no owned workflow calls it")
    for dependency in document.get("orchestratedBy", []):
        if dependency not in shipped_modules:
            sidecar_findings.append(f"{module_id}: orchestratedBy names an unknown module: {dependency}")
        elif dependency in actual:
            sidecar_findings.append(f"{module_id}: {dependency} is declared as an orchestrator but is called structurally")
    decoupling = document.get("decoupling")
    if not isinstance(decoupling, dict) or not decoupling.get("workload") or not decoupling.get("riskIfDecoupled"):
        sidecar_findings.append(f"{module_id}: dependencies.json must disclose the decoupling workload and risk")
print(f"        （带依赖侧车的模块：{sidecars} 个）")
report("every dependency sidecar matches the shipped modules", sidecar_findings)
report("the coupling the README claims is recorded in the shipped sidecars",
       [] if sidecars >= 2 else ["fewer than two narrative modules declare a sidecar"])

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
