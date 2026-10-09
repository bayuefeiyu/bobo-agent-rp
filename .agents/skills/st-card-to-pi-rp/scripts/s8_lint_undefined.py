"""S8 辅助检查：使用 Python 符号表查找疑似未定义的全局名字。

闭包自由变量不属于缺失全局导入。此检查不证明动态属性、控制流或调用参数正确；
实际行为仍需由校验器回归覆盖。用法：python s8_lint_undefined.py。
"""
from __future__ import annotations

import ast
import builtins
import symtable
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGETS = [HERE / "validate_card_pack.py", *sorted((HERE / "validation").glob("*.py"))]
ALLOWED = {"__file__", "__name__", "__doc__", "__package__", "__spec__", "__loader__", "annotations"}


def check(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    root = symtable.symtable(source, str(path), "exec")
    bound = {symbol.get_name() for symbol in root.get_symbols()
             if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()}
    known = bound | set(dir(builtins)) | ALLOWED
    problems: list[str] = []

    def visit(table):
        for symbol in table.get_symbols():
            name = symbol.get_name()
            if symbol.is_referenced() and symbol.is_global() and name not in known:
                line = next((node.lineno for node in ast.walk(tree)
                             if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                             and node.id == name and node.lineno >= table.get_lineno()), table.get_lineno())
                problems.append(f"{path.name}:{line}: '{name}' 在 {table.get_name()}() 中可能未定义")
        for child in table.get_children():
            visit(child)

    visit(root)
    return problems


def main() -> int:
    problems = [problem for target in TARGETS for problem in check(target)]
    if problems:
        print("可能的未定义引用：")
        for problem in sorted(set(problems)):
            print("  " + problem)
        return 1
    print(f"checked {len(TARGETS)} files: no undefined references found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
