"""S3：跨语言协议样例的 Python 侧消费者。

同一份 `tests/contracts/protocol-samples.json` 必须同时被本文件与
`tests/contracts/rp-contracts.test.mjs` 消费，且两侧对每个样例给出相同的接受/拒绝结论。
任何一侧都不允许通过跳过样例来"对齐"；本文件对每个样例都在临时卡包里搭出最小合成夹具，
把**样例本身**放进卡包（模块清单、工作流、数据契约或资源目录），再调用卡包校验器：

- `module.v7*`      → 样例写成 `features/<id>/module.json`，调用 `validate_feature_modules`；
- `workflow.v4*`    → 样例写成所属模块下的 `workflows/<workflow-id>/workflow.json`，调用 `validate_workflows`；
- `datacontract.v1*`→ 样例写成 `features/<module>/data-contract.json`，并让模块清单声明它；
- `catalog.v1*`     → 样例写成 `features/<module>/catalog.json`，并让模块清单声明它。

判定与 JS 侧一致：`errors` 非空即拒绝，空即接受。为了让"拒绝"确实由样例声明的规则造成而不是
夹具缺件造成，每个 `expect: reject` 样例都额外做两件事：在内存里生成一份"只修好被测字段"的基线
输入并断言它被接受；断言校验器返回的错误确实命中样例声明的 `ruleIds` 之一。
`expect: accept` 的样例则必须满足校验器施加的全部其它要求（Skill frontmatter、被引用的入口文件、
声明的输出、初始记录文件等），否则夹具本身就是缺件的。

跨语言结论不一致的样例登记在 `KNOWN_CROSS_LANGUAGE_CONFLICTS` 中，测试会以失败的形式把它们
逐条报出来——这是方案要求"记录冲突而不是掩盖冲突"的落地方式，不是本文件应当被改绿的地方。
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import unittest
from pathlib import Path
from typing import Any, Callable

SCRIPT = Path(__file__).with_name("validate_card_pack.py")
SPEC = importlib.util.spec_from_file_location("validate_card_pack", SCRIPT)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)

# 卡包根：.agents/skills/st-card-to-pi-rp
SKILL_ROOT = Path(__file__).resolve().parents[1]
SAMPLES_FILE = SKILL_ROOT / "tests" / "contracts" / "protocol-samples.json"
# 卡包根：仓库根。夹具必须写在仓库内（沙箱允许写工作区，系统临时目录不在其中），
# 临时夹具的名字带固定的 `.tmp-contract-samples-` 前缀，用完即删。
REPO_ROOT = SKILL_ROOT.parents[2]
FIXTURE_PREFIX = ".tmp-contract-samples-"
# 夹具容器模块 id：数据契约 / 资源目录的 moduleId 规则相对它校验，因此必须固定。
DEMO_MODULE = "demo-module"

# 跨语言冲突登记表：样例 ID → 该样例在 Python 卡包校验器上的**真实**结论与原因。
#
# 当前为空：S3 首次运行时此处登记了 3 条结论不一致与 1 条"结论对、依据不对"的样例。经判定，
# `struct.workflow.owner` 与 `struct.workflow.agentCallable` 在权威协议（Module v7 / Workflow v4）
# 中确实要求拒绝，而 Python 校验器在**卡级 `validate_workflows` 通道**缺少这两项检查，因此按
# 方案的处置方向修正了校验器实现，并让两条样例只携带它们声明的那一个缺陷。冲突已消除，登记表
# 保持为空；若将来再次出现不一致，应把样例登记到这里——本测试会以失败的形式把它暴露出来。
KNOWN_CROSS_LANGUAGE_CONFLICTS: dict[str, dict[str, Any]] = {}

# 各规则在 Python 卡包校验器上的判定依据：`rule_id -> 命中该规则时错误文本必然包含的片段`。
# 缺失的规则 ID 表示 Python 侧不检查它（例如 `reject.unsupportedVersion` 是归一到错误版本号的必然结果）。
# 声明了规则的样例必须真正因该规则被拒绝，否则拒绝就会来自夹具缺陷而不是被测规则。
RULE_ERROR_FRAGMENTS: dict[str, tuple[str, ...]] = {
    "struct.module.fieldSet": ("must use the exact module v7 field set",),
    "struct.module.kindFiles": ("must match moduleKind",),
    "struct.module.surface": ("resource-only modules must use background surface",),
    "struct.path.relative": ("is not a safe relative POSIX path", "must stay inside the module directory"),
    "struct.workflow.schemaVersion": ("schemaVersion must be 4",),
    "struct.workflow.owner": ("ownerModuleId must be a module ID", "must use its ownerModuleId as its module prefix"),
    "struct.workflow.agentCallable": ("agentCallable is only allowed on callable module workflows",),
    "struct.workflow.kindEnum": (".kind is invalid",),
    "struct.workflow.nodeTypeEnum": (".type is invalid",),
    "struct.workflow.nodesRequired": ("nodes must be a non-empty array",),
    "runtime.workflow.dag": ("has invalid dependencies",),
    "struct.datacontract.moduleId": ("must be a data contract v1 for",),
    "struct.datacontract.fieldSet": ("must be a data contract v1",),
    "struct.catalog.choiceGroup": ("must name a declared group exactly for choice documents",),
}

# 样例 ID 前缀 → 卡包侧装配入口。前缀即契约族，与 JS 侧 NORMALIZERS 一一对应。
SAMPLE_FAMILIES = ("module.v7", "workflow.v4", "datacontract.v1", "catalog.v1")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def new_fixture_root() -> Path:
    """在仓库根下新建本次运行的夹具根目录。

    这里不能用 `tempfile.mkdtemp`：它建出的目录在本机沙箱下无法再写入子目录
    （`PermissionError: [WinError 5]`），而显式 `mkdir` 建出的目录可以，所以夹具一律用显式目录。
    """
    for serial in range(1, 1000):
        root = REPO_ROOT / f"{FIXTURE_PREFIX}{os.getpid()}-{serial}"
        if root.exists():
            continue
        root.mkdir(parents=True, exist_ok=False)
        return root
    raise AssertionError(f"无法在 {REPO_ROOT} 下创建夹具目录")


def fixture_root_is_ours(root: Path) -> bool:
    """只有本文件新建的、位于仓库根且带固定前缀的真实目录才允许递归删除。"""
    resolved = root.resolve()
    return resolved.parent == REPO_ROOT.resolve() and resolved.name.startswith(FIXTURE_PREFIX) and resolved.is_dir()


def write_skill(module: Path, module_id: str) -> None:
    skill = module / "skill" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        f"---\nname: {module_id}\ndescription: Contract sample for {module_id}.\n---\n\n# {module_id}\n",
        encoding="utf-8",
    )


def load_samples() -> list[dict[str, Any]]:
    payload = json.loads(SAMPLES_FILE.read_text(encoding="utf-8-sig"))
    samples = payload.get("samples") if isinstance(payload, dict) else None
    if not isinstance(samples, list) or not samples:
        raise AssertionError(f"{SAMPLES_FILE} 必须包含非空的 samples 数组")
    return samples


def family_of(sample_id: str) -> str:
    family = next((prefix for prefix in SAMPLE_FAMILIES if sample_id.startswith(prefix)), None)
    if family is None:
        raise AssertionError(f"样例 {sample_id} 没有对应的卡包装配入口；请先声明契约族。")
    return family


def safe_relative(value: Any) -> bool:
    """与校验器一致的模块内相对路径判定；越界路径不得写出夹具目录。"""
    return VALIDATOR.safe_relative_path(value)


def module_id_of(sample_id: str, value: dict[str, Any]) -> str:
    """样例所属模块 = 夹具模块目录名。

    模块样例的模块就是样例本身（`id`）；数据契约 / 资源目录样例由容器模块承载，目录名取样例声明的
    `moduleId`（`moduleId` 正是这些样例的被测字段，夹具不得替它改名）；工作流取 `ownerModuleId`，
    没有声明时退回 id 的模块前缀（`struct.workflow.owner` 正是要拒绝这种情况）。
    """
    if sample_id.startswith("workflow.v4"):
        return str(value.get("ownerModuleId") or str(value.get("id") or "demo-module").split("/")[0])
    if sample_id.startswith("module.v7"):
        return str(value.get("id") or "demo-module")
    # 数据契约 / 资源目录的 moduleId 规则是"相对承载它的模块"校验的。容器必须**固定**为
    # DEMO_MODULE，否则从样例自身的 moduleId 推导容器，就会让"moduleId 与容器不符"永远成立不了
    # （容器跟着样例变），该样例会被夹具修好而通过。
    return DEMO_MODULE


def declared_component_paths(module: dict[str, Any], field: str) -> list[str]:
    declared = module.get(field)
    return [path for path in declared if safe_relative(path)] if isinstance(declared, list) else []


def write_data_contract(module: Path, value: dict[str, Any], relative: str, module_id: str,
                        fallback_collections: dict[str, Any] | None = None) -> None:
    """把（样例的）数据契约写到声明的位置，并补齐它引用的初始记录文件。

    样例声明的 `collections` 为空时可用 `fallback_collections` 顶替——校验器要求 Data 模块的契约非空，
    空 collections 本身不是"被拒绝的原因"，因此基线必须能补上它，才能证明拒绝来自被测缺陷。
    """
    # 不覆盖样例声明的 moduleId：moduleId 不符正是被测缺陷之一。
    contract = {**value}
    if fallback_collections and not contract.get("collections"):
        contract["collections"] = fallback_collections
    write_json(module / relative, contract)
    for definition in (contract.get("collections") or {}).values():
        storage = definition.get("storage") if isinstance(definition, dict) else None
        if isinstance(storage, dict) and safe_relative(storage.get("initialRecordsFile")):
            write_json(module / storage["initialRecordsFile"], [])


def write_resource_catalog(module: Path, value: dict[str, Any], relative: str, module_id: str,
                           fallback_categories: dict[str, Any] | None = None) -> None:
    """把（样例的）资源目录写到声明的位置，并补齐它列出的每篇 Markdown 资料。"""
    # 同上：不覆盖样例声明的 moduleId。
    catalog = {**value}
    if fallback_categories and not catalog.get("categories"):
        catalog["categories"] = fallback_categories
    write_json(module / relative, catalog)
    for document in catalog.get("documents") or []:
        if isinstance(document, dict) and safe_relative(document.get("path")):
            path = module / document["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{document.get('title', 'document')}\n", encoding="utf-8")


def write_workflow_fixture(root: Path, sample_id: str, value: dict[str, Any], module_id: str) -> str:
    """把样例写成某模块登记的工作流，返回该模块清单的卡内相对路径。"""
    module = root / "features" / module_id
    directory = str(value.get("id") or "run").split("/")[-1]
    relative = f"workflows/{directory}/workflow.json"
    write_json(module / relative, value)
    write_json(module / "module.json", {
        "schemaVersion": 7, "id": module_id, "moduleKind": "resource", "basedOn": None,
        "title": "样例夹具模块", "description": "仅用于协议样例。", "surface": "background",
        "contextOrder": 0, "displayOrder": 0, "dataContractFile": None,
        "resourceCatalogFile": "catalog.json", "frontendViewFile": None,
        "skillFile": "skill/SKILL.md", "agentFiles": [], "workflowFiles": [relative],
    })
    write_json(module / "catalog.json", {
        "schemaVersion": 1, "moduleId": module_id,
        "categories": {"lore": {"title": "设定", "description": "夹具。"}},
        "selectionGroups": {}, "documents": [],
    })
    return f"features/{module_id}/module.json"


def fixture_for_sample(root: Path, sample_id: str, value: dict[str, Any],
                       module_id: str, complete_empties: bool = False) -> tuple[list[str], Callable[[Path, list[str]], None]]:
    """按契约族装配夹具，返回 (送检的 feature_modules 路径列表, 在该根上运行校验的调用器)。

    校验器对模块工作流/数据契约/资源目录一律按**清单登记的路径**解析（`manifest_module_paths`），
    所以夹具必须同时写出 `manifest.json`，否则样例本身不会被校验到。

    装载样例本身时一律**原样写出**：不得顺手修正样例声明的字段，否则拒绝样例会被夹具悄悄"修好"。
    只有 `complete_empties`（用于"只修好被测缺陷"的基线）才把空的 collections / categories 换成合法内容。
    """
    family = family_of(sample_id)

    if family == "workflow.v4":
        module_path = write_workflow_fixture(root, sample_id, value, module_id)
        write_json(root / "manifest.json", {"feature_modules": [module_path]})
        return [module_path], lambda at, errors: VALIDATOR.validate_workflows(at, errors)

    module = root / "features" / module_id
    module_path = f"features/{module_id}/module.json"

    if family == "module.v7":
        definition = dict(value)
    else:
        # 数据契约 / 资源目录样例：清单只是承载样例的容器，本身必须完全合法。
        definition = {
            "schemaVersion": 7, "id": module_id, "moduleKind": "data", "basedOn": None,
            "title": "样例夹具模块", "description": "仅用于协议样例。", "surface": "frontend",
            "contextOrder": 0, "displayOrder": 0, "dataContractFile": "data-contract.json",
            "resourceCatalogFile": None, "frontendViewFile": "frontend-view.json",
            "skillFile": "skill/SKILL.md", "agentFiles": [], "workflowFiles": ["workflows/run/workflow.json"],
        }
        if family == "catalog.v1":
            definition.update({
                "moduleKind": "resource", "surface": "background", "dataContractFile": None,
                "resourceCatalogFile": "catalog.json", "frontendViewFile": None,
            })
        write_json(module / "workflows" / "run" / "workflow.json", {
            "schemaVersion": 4, "id": f"{module_id}/run", "ownerModuleId": module_id, "kind": "foreground",
            "nodes": [
                {"id": "narrative", "type": "agent", "outputs": {"story": {"path": "story.md", "format": "narrative"}}},
                {"id": "finalize", "type": "turn-finalize", "dependsOn": ["narrative"],
                 "narrative": {"fromNode": "narrative", "output": "story"}},
            ],
        })

    # 声明的组件与文件全部补齐；仅在路径合法时写出，越界路径交给校验器拒绝。
    for field in ("agentFiles", "workflowFiles"):
        for path in declared_component_paths(definition, field):
            if field == "agentFiles":
                write_json(module / path, {"id": path.split("/")[-2], "ownerModuleId": definition.get("id")})
            elif not (module / path).is_file():
                write_json(module / path, {
                    "schemaVersion": 4, "id": f"{definition.get('id')}/{path.split('/')[-2]}",
                    "ownerModuleId": definition.get("id"), "kind": "module-external", "agentCallable": True,
                    "interface": {"inputs": {}, "exports": {}},
                    "nodes": [{"id": "return", "type": "workflow-return", "exports": {}}],
                })
    if safe_relative(definition.get("skillFile")):
        write_skill(module, str(definition.get("id")))
    if safe_relative(definition.get("frontendViewFile")):
        write_json(module / definition["frontendViewFile"], {"schemaVersion": 1, "regions": []})

    # 样例清单原样落盘：多出的字段必须留在文件里，否则"多字段即拒绝"的样例会被夹具修好。
    write_json(module / "module.json", definition)
    write_json(root / "manifest.json", {"feature_modules": [module_path]})

    contract_file = definition.get("dataContractFile")
    catalog_file = definition.get("resourceCatalogFile")
    if family == "datacontract.v1":
        fallback = data_contract_fixture(module_id)["collections"] if complete_empties else None
        write_data_contract(module, value, "data-contract.json", module_id, fallback)
    elif family == "catalog.v1":
        fallback = resource_catalog_fixture(module_id)["categories"] if complete_empties else None
        write_resource_catalog(module, value, "catalog.json", module_id, fallback)
    else:
        # module.v7 样例：清单声明的契约 / 目录引用也必须存在且合法，否则夹具就是缺件的。
        # 只有当样例自己的模块 id 与夹具模块目录一致时才补齐，避免掩盖 moduleId 不符样例。
        if safe_relative(contract_file) and definition.get("id") == module_id:
            write_data_contract(module, data_contract_fixture(module_id), contract_file, module_id)
        if safe_relative(catalog_file) and definition.get("id") == module_id:
            write_resource_catalog(module, resource_catalog_fixture(module_id), catalog_file, module_id)

    return [module_path], lambda at, errors: VALIDATOR.validate_feature_modules(at, [module_path], errors)


def data_contract_fixture(module_id: str) -> dict[str, Any]:
    """一份与样例无关的最小合法数据契约，用于补齐 module.v7 夹具的声明的契约文件。"""
    return {
        "schemaVersion": 1, "moduleId": module_id,
        "collections": {
            "entries": {
                "storage": {"kind": "record-log", "partition": {"mode": "single"}},
                "recordTypes": {
                    "fixture.entry": {
                        "dataSchemaVersion": 1, "indexes": {}, "actions": ["create"],
                        "searchableFields": ["/data/content"],
                        "views": {"rp": {"format": "text", "fields": [{"path": "/data/content"}]}},
                    }
                },
            }
        },
        "capabilities": {
            "fixture.query": {"collections": ["entries"], "actions": ["query"], "views": ["rp"]},
            "fixture.write": {"collections": ["entries"], "actions": ["create"], "views": []},
        },
    }


def resource_catalog_fixture(module_id: str) -> dict[str, Any]:
    """一份与样例无关的最小合法资源目录，用于补齐 module.v7 夹具的声明的目录文件。"""
    return {
        "schemaVersion": 1, "moduleId": module_id,
        "categories": {"lore": {"title": "设定", "description": "夹具。"}},
        "selectionGroups": {},
        "documents": [
            {
                "id": "fixture-doc", "path": "documents/fixture-doc.md", "title": "夹具资料", "summary": "仅用于协议样例。",
                "categories": ["lore"], "subcategory": None, "readPolicy": "required", "authority": "canonical",
                "appliesAt": ["analysis"], "priority": 10, "selectionGroup": None, "readWhen": [],
                "perspective": "general", "aliases": [], "related": [], "sources": [],
            }
        ],
    }


def baseline_input(sample_id: str, value: dict[str, Any]) -> dict[str, Any]:
    """只在内存里修好样例声明的被测缺陷，其余原样保留；用于证明夹具本身是完整的。"""
    fixed = json.loads(json.dumps(value))
    if sample_id == "module.v7.reject.wrongVersion":
        fixed["schemaVersion"] = 7
    elif sample_id == "module.v7.reject.extraField":
        fixed.pop("legacyAgents", None)
    elif sample_id == "module.v7.reject.kindFileMismatch":
        fixed["moduleKind"] = "hybrid"
    elif sample_id == "module.v7.reject.resourceFrontend":
        fixed["surface"] = "background"
        fixed["frontendViewFile"] = None
    elif sample_id == "module.v7.reject.escapePath":
        fixed["dataContractFile"] = "data-contract.json"
    elif sample_id == "workflow.v4.reject.wrongVersion":
        fixed["schemaVersion"] = 4
    elif sample_id == "workflow.v4.reject.missingOwner":
        fixed["ownerModuleId"] = "demo-module"
    elif sample_id == "workflow.v4.reject.ownerMismatch":
        fixed["id"] = f"{value.get('ownerModuleId')}/{str(value.get('id')).split('/')[-1]}"
    elif sample_id == "workflow.v4.reject.unknownKind":
        fixed["kind"] = "module-external"
        fixed["agentCallable"] = True
    elif sample_id == "workflow.v4.reject.unknownNodeType":
        fixed["kind"] = "module-external"
        fixed["nodes"] = [{"id": "return", "type": "workflow-return", "exports": {}}]
    elif sample_id == "workflow.v4.reject.agentCallableOnEntry":
        fixed.pop("agentCallable", None)
    elif sample_id == "workflow.v4.reject.emptyNodes":
        fixed["kind"] = "module-external"
        fixed["nodes"] = [{"id": "return", "type": "workflow-return", "exports": {}}]
    elif sample_id == "workflow.v4.reject.danglingDependency":
        fixed["nodes"] = [
            {**node, "dependsOn": [dependency for dependency in node.get("dependsOn", []) if dependency != "ghost"]}
            if isinstance(node, dict) else node
            for node in fixed.get("nodes", [])
        ]
    elif sample_id == "datacontract.v1.reject.wrongVersion":
        fixed["schemaVersion"] = 1
        # 容器模块目录取 moduleId，故 moduleId 必须与容器一致；空 collections 由夹具补齐。
        fixed["moduleId"] = "demo-module"
    elif sample_id == "datacontract.v1.reject.moduleIdMismatch":
        # 容器固定为 DEMO_MODULE；只有让契约与容器一致，基线才应被接受。
        fixed["moduleId"] = DEMO_MODULE
    elif sample_id == "datacontract.v1.reject.unknownField":
        fixed.pop("legacyVariables", None)
    elif sample_id == "catalog.v1.reject.wrongVersion":
        fixed["schemaVersion"] = 1
    elif sample_id == "catalog.v1.reject.choiceWithoutGroup":
        for document in fixed.get("documents") or []:
            if isinstance(document, dict) and document.get("readPolicy") == "choice":
                document["readPolicy"] = "optional"
    else:
        raise AssertionError(f"样例 {sample_id} 声明为拒绝，但基线修正未定义；不得静默跳过。")
    return fixed


class ContractSampleTests(unittest.TestCase):
    """每个样例都在仓库内的临时卡包里独立装配，避免依赖真实的卡与会话数据。"""

    def setUp(self) -> None:
        self.samples = load_samples()
        self.fixture_root = new_fixture_root()
        self.case_serial = 0

    def tearDown(self) -> None:
        # 夹具目录是本文件自己在仓库根下新建的；删除前先确认父目录与前缀都对得上。
        if not fixture_root_is_ours(self.fixture_root):
            self.fail(f"夹具清理被拒绝，因为路径不符合预期形态：{self.fixture_root}")
        shutil.rmtree(self.fixture_root, ignore_errors=True)

    def compute_verdict(self, sample: dict[str, Any], value: dict[str, Any],
                        complete_empties: bool = False) -> tuple[bool, list[str]]:
        """在临时卡包里装配样例并跑卡包校验器；返回 (是否接受, 错误列表)。"""
        self.case_serial += 1
        sample_id = str(sample["id"])
        root = self.fixture_root / f"case-{self.case_serial}"
        root.mkdir(parents=True, exist_ok=False)
        _, run = fixture_for_sample(root, sample_id, value, module_id_of(sample_id, value), complete_empties)
        errors: list[str] = []
        run(root, errors)
        return not errors, errors

    def test_sample_set_declares_family_layer_and_expectation(self) -> None:
        self.assertTrue(self.samples, "样例集不得为空")
        for sample in self.samples:
            sample_id = sample["id"]
            self.assertIn(family_of(sample_id), SAMPLE_FAMILIES, f"{sample_id} 必须属于已知契约族")
            self.assertTrue(sample.get("ruleIds"), f"{sample_id} 必须声明 ruleIds")
            self.assertIn(sample.get("expect"), {"accept", "reject"}, f"{sample_id}.expect 必须是 accept 或 reject")
            self.assertIsInstance(sample.get("input"), dict, f"{sample_id} 必须有 object 输入")

    def test_cardpack_verdict_matches_every_declared_expectation(self) -> None:
        """逐样例断言接受/拒绝结论；登记在案的冲突如实报出，不静默通过。"""
        failures: list[str] = []
        conflicts: list[str] = []
        for sample in self.samples:
            sample_id = str(sample["id"])
            expected = sample["expect"] == "accept"
            with self.subTest(sample=sample_id):
                accepted, errors = self.compute_verdict(sample, sample["input"])
                conflict = KNOWN_CROSS_LANGUAGE_CONFLICTS.get(sample_id)
                if conflict is not None:
                    self.assertEqual(
                        accepted, conflict["python_accepted"],
                        f"{sample_id}: 登记的 Python 结论已变化（现为 {'accept' if accepted else 'reject'}）；"
                        f"请重判该规则实现并更新 KNOWN_CROSS_LANGUAGE_CONFLICTS。",
                    )
                    conflicts.append(
                        f"{sample_id}: 声明 {sample['expect']} / JS 侧 "
                        f"{'accept' if conflict['js_accepted'] else 'reject'} / Python 侧 "
                        f"{'accept' if accepted else 'reject'}（规则 {conflict['declared_rule']}）\n    {conflict['reason']}"
                    )
                    continue
                if accepted != expected:
                    failures.append(
                        f"{sample_id}: 期望 {sample['expect']}，实际 "
                        f"{'accept' if accepted else 'reject'}（{'; '.join(errors) or '无错误'}）"
                    )
        self.assertEqual(
            failures, [],
            "卡包侧样例结论与声明不一致（不要改样例或放宽断言来对齐）：\n" + "\n".join(failures),
        )
        if conflicts:
            self.fail(
                "跨语言规则冲突（已在 KNOWN_CROSS_LANGUAGE_CONFLICTS 登记；本条失败就是要被看到，"
                "不得改样例或放宽断言来掩盖）：\n" + "\n".join(conflicts)
            )

    def test_reject_samples_are_rejected_by_their_declared_rule(self) -> None:
        """拒绝样例必须**因声明的规则**被拒绝：否则夹具缺件也会让结论为 reject，测试就通过得莫名其妙。"""
        unattributed: list[str] = []
        for sample in self.samples:
            sample_id = str(sample["id"])
            if sample["expect"] != "reject" or sample_id in KNOWN_CROSS_LANGUAGE_CONFLICTS:
                continue
            with self.subTest(sample=sample_id):
                checkable = [
                    rule_id for rule_id in sample["ruleIds"]
                    if RULE_ERROR_FRAGMENTS.get(rule_id)
                ]
                if not checkable:
                    # 声明的规则都由 Python 侧不检查的机制决定（例如旧版本先被版本号拒绝）；
                    # 这类样例仍需在基线测试里证明夹具完整。
                    continue
                _, errors = self.compute_verdict(sample, sample["input"])
                fired = any(
                    fragment in error
                    for rule_id in checkable
                    for fragment in RULE_ERROR_FRAGMENTS[rule_id]
                    for error in errors
                )
                if not fired:
                    unattributed.append(
                        f"{sample_id}: 声明规则 {checkable} 未命中，实际错误为 {errors}"
                    )
        self.assertEqual(
            unattributed, [],
            "拒绝依据与声明的规则不符（结论可能来自夹具缺陷）：\n" + "\n".join(unattributed),
        )

    def test_reject_samples_fail_only_for_their_declared_defect(self) -> None:
        """拒绝样例的夹具必须完整：只修好被测缺陷的基线输入必须被接受。

        因 `ownerModuleId` / `agentCallable` 冲突而登记在案的样例不做基线断言：它们的"被拒绝"本来就没有
        发生，基线也就无从证明夹具完整；这类样例由 `test_cardpack_verdict_matches_every_declared_expectation`
        如实报告。
        """
        incomplete: list[str] = []
        for sample in self.samples:
            sample_id = str(sample["id"])
            if sample["expect"] != "reject" or sample_id in KNOWN_CROSS_LANGUAGE_CONFLICTS:
                continue
            with self.subTest(sample=sample_id):
                accepted, errors = self.compute_verdict(
                    sample, baseline_input(sample_id, sample["input"]), complete_empties=True
                )
                if not accepted:
                    incomplete.append(f"{sample_id}: 基线仍被拒绝（{'; '.join(errors)}）")
        self.assertEqual(incomplete, [], "夹具不完整，拒绝结论可能来自缺件而不是被测规则：\n" + "\n".join(incomplete))

    def test_accept_samples_are_accepted_by_the_cardpack_layer(self) -> None:
        """接受样例必须满足校验器施加的全部其它要求，不得因夹具缺件而失败。"""
        failures: list[str] = []
        for sample in self.samples:
            if sample["expect"] != "accept":
                continue
            with self.subTest(sample=str(sample["id"])):
                accepted, errors = self.compute_verdict(sample, sample["input"])
                if not accepted:
                    failures.append(f"{sample['id']}: {'; '.join(errors)}")
        self.assertEqual(failures, [], "接受样例的夹具仍不完整：\n" + "\n".join(failures))

    def test_every_sample_is_evaluated(self) -> None:
        """没有样例可以被跳过：每个样例都必须真正经过卡包校验器。"""
        evaluated = [str(sample["id"]) for sample in self.samples]
        skipped = [sample_id for sample_id in evaluated if family_of(sample_id) not in SAMPLE_FAMILIES]
        self.assertEqual(skipped, [], f"以下样例无法在 Python 侧评估：{skipped}")
        self.assertEqual(len(set(evaluated)), len(evaluated), "样例 ID 不得重复")


def print_verdict_report() -> int:
    """打印逐样例的 Python 侧结论表：id、结论、声明、是否一致、错误明细。"""
    samples = load_samples()
    root = new_fixture_root()
    try:
        for sample in samples:
            sample_id = str(sample["id"])
            case = root / f"case-{sample_id.replace('.', '_')}"
            case.mkdir(parents=True, exist_ok=True)
            _, run = fixture_for_sample(case, sample_id, sample["input"], module_id_of(sample_id, sample["input"]))
            errors: list[str] = []
            run(case, errors)
            verdict = "accept" if not errors else "reject"
            detail = "" if not errors else " | ".join(errors)
            print(f"{sample_id}\t{verdict}\texpect={sample['expect']}\tmatch={verdict == sample['expect']}\t{detail}")
    finally:
        if fixture_root_is_ours(root):
            shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    if "--report" in sys.argv:
        raise SystemExit(print_verdict_report())
    unittest.main()
    unittest.main()
