"""S8 拆分第 1 层：文件系统与 JSON 读取辅助。

方案 §13 第 1 条要求"共享诊断收集和文件读取辅助只保留一份"。这里就是那份唯一实现：
路径安全判定、必需文件检查与 JSON 读取（含诊断文案）。

**诊断文案与行为与拆分前逐字一致**——所有错误文本都从原实现原样搬来，未改写。
"""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any


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
