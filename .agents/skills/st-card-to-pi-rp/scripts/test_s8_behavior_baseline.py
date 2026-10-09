"""S8 行为基线测试：拆分后校验器的已选可观察行为必须与基线一致。

方案 §13 的风险提示是"改造不能只以测试通过为依据，还需核对责任表，防止测试未覆盖的校验被
拆分时遗漏"。本测试锁定已选纯参数诊断文本和公开名字集合；它不声称这组探针覆盖所有规则，
边界行为由针对性的纯输入测试覆盖。

基线文件 `s8-behavior-baseline.json` 由 `python s8_behavior_baseline.py write` 生成。
"""
from __future__ import annotations

import unittest
from pathlib import Path

from s8_behavior_baseline import BASELINE, diagnostic_probes, load_validator, public_surface


class S8BehaviourBaselineTests(unittest.TestCase):
    def test_validator_diagnostics_match_baseline(self) -> None:
        import json

        expected = json.loads(BASELINE.read_text(encoding="utf-8"))
        self.assertTrue(BASELINE.is_file(), f"缺少行为基线 {BASELINE}")
        actual = diagnostic_probes(load_validator())
        for key, value in expected["diagnosticProbes"].items():
            self.assertEqual(value, actual.get(key), f"{key} 的诊断文本与基线不一致")

    def test_validator_public_surface_matches_baseline(self) -> None:
        import json

        expected = json.loads(BASELINE.read_text(encoding="utf-8"))
        actual = public_surface(load_validator())
        missing = [name for name in expected["publicSurface"] if name not in actual]
        # 拆分时若公开辅助函数未重新导出，这里会立刻体现。
        self.assertEqual([], missing, f"这些公开名字在拆分后消失了：{missing}")


if __name__ == "__main__":
    unittest.main()
