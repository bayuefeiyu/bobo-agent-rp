"""S8 行为基线：固定拆分校验器的已选可观察行为。

方案 §13 的验收要求"只保证当前格式的诊断准确、可定位和退出码正确"，因此这里保留纯参数
诊断探针和公开导出集合。它们用于锁定已选输入的诊断文本并防止公开辅助函数丢失；具体规则的
边界行为由针对性的测试覆盖，不把这组探针当成完整规则证明。

用法：
    python s8_behavior_baseline.py write   # 生成/更新基线
    python s8_behavior_baseline.py check    # 与基线逐字对比（拆分后运行）
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "validate_card_pack.py"
BASELINE = HERE / "s8-behavior-baseline.json"


def load_validator(script: Path = SCRIPT):
    spec = importlib.util.spec_from_file_location("validate_card_pack", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def diagnostic_probes(validator) -> dict[str, list[str]]:
    """对**纯参数**校验函数喂入构造输入，记录诊断文本。

    这些函数不访问临时目录，因此在受限沙箱下也能运行，从而给出可复现的行为指纹。
    """
    probes: dict[str, list[str]] = {}

    # 1. safe_relative_path：路径安全判定（含类型与越界）
    probe = {}
    for value in ["a/b.md", "../escape.md", "/abs.md", "a\\b.md", "", ".", "a/../b.md", None, 7, "ok/../..", "a//b"]:
        try:
            probe[repr(value)] = validator.safe_relative_path(value)
        except Exception as error:  # noqa: BLE001 - 记录而不是吞掉
            probe[repr(value)] = f"EXC {type(error).__name__}"
    probes["safe_relative_path"] = [json.dumps(probe, ensure_ascii=False, sort_keys=True)]

    # 2. validate_retrieval_policy：检索策略正反例
    lines: list[str] = []
    cases = {
        "default": {"schemaVersion": 2, "source": "messages", "code": {"profile": "default"}, "agent": {"mode": "append", "fallback": "code", "onNotTriggered": "empty", "maxRecords": 5}},
        "bad-source": {"schemaVersion": 2, "source": "other", "code": {"profile": "default"}, "agent": {"mode": "append", "fallback": "code", "onNotTriggered": "empty", "maxRecords": 5}},
        "with-selector": {"schemaVersion": 2, "source": "messages", "code": {"profile": "default", "selector": {"type": "all"}}, "agent": {"mode": "append", "fallback": "code", "onNotTriggered": "empty", "maxRecords": 5}},
        "not-a-dict": "nope",
        "extra-field": {"schemaVersion": 2, "source": "messages", "code": {"profile": "default"}, "agent": {"mode": "append", "fallback": "code", "onNotTriggered": "empty", "maxRecords": 5}, "x": 1},
    }
    for name, value in cases.items():
        errors: list[str] = []
        try:
            validator.validate_retrieval_policy(value, "messages", f"probe.{name}", errors)
        except Exception as error:  # noqa: BLE001
            errors.append(f"UNCAUGHT {type(error).__name__}: {error}")
        lines.append(f"{name} -> {errors}")
    probes["validate_retrieval_policy"] = lines

    # 3. validate_runtime_services：运行时服务白名单
    lines = []
    for name, node in {
        "allowed": {"runtimeServices": ["random"]},
        "unknown": {"runtimeServices": ["network"]},
        "not-a-list": {"runtimeServices": "random"},
        "absent": {},
    }.items():
        errors = []
        try:
            validator.validate_runtime_services(node, f"probe.{name}", errors)
        except Exception as error:  # noqa: BLE001
            errors.append(f"UNCAUGHT {type(error).__name__}: {error}")
        lines.append(f"{name} -> {errors}")
    probes["validate_runtime_services"] = lines

    # 4. validate_record：记录信封形状
    lines = []
    for name, value in {
        "ok": {"schemaVersion": 2, "id": "r1", "source": "messages", "sequence": 1, "revision": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "binding": {"turn": 1}, "data": {}},
        "missing-id": {"schemaVersion": 2},
        "bad-version": {"schemaVersion": 9},
    }.items():
        errors = []
        try:
            validator.validate_record(value, "messages", f"probe.{name}", errors)
        except Exception as error:  # noqa: BLE001
            errors.append(f"UNCAUGHT {type(error).__name__}: {error}")
        lines.append(f"{name} -> {errors}")
    probes["validate_record"] = lines

    return probes


def public_surface(validator) -> list[str]:
    """记录宿主/测试可见的顶层名字集合，防止公开导出意外丢失。"""
    return sorted(name for name in vars(validator) if not name.startswith("_"))


def snapshot() -> dict:
    validator = load_validator()
    return {
        "diagnosticProbes": diagnostic_probes(validator),
        "publicSurface": public_surface(validator),
    }


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    current = snapshot()
    if mode == "write":
        BASELINE.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {BASELINE}")
        print(f"  public surface: {len(current['publicSurface'])} names")
        return 0

    expected = json.loads(BASELINE.read_text(encoding="utf-8"))
    problems: list[str] = []
    for key in ("diagnosticProbes", "publicSurface"):
        if expected.get(key) != current.get(key):
            before, after = expected.get(key), current.get(key)
            if isinstance(before, list) and isinstance(after, list):
                missing = [x for x in before if x not in after]
                added = [x for x in after if x not in before]
                problems.append(f"{key} changed:\n    missing: {missing}\n    added:   {added}")
            else:
                problems.append(f"{key} changed:\n    expected: {before}\n    actual:   {after}")
    if problems:
        print("BEHAVIOUR CHANGED:")
        for problem in problems:
            print("  " + problem)
        return 1
    print("behaviour identical to baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
