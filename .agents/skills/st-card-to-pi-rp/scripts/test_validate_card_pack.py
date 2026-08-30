from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_card_pack.py")
SPEC = importlib.util.spec_from_file_location("validate_card_pack", SCRIPT)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class ValidateCardPackTests(unittest.TestCase):
    def make_output_module(self, root: Path, surface: str = "frontend") -> str:
        module = root / "features" / "meanwhile"
        write_json(module / "module.json", {
            "schemaVersion": 3,
            "id": "meanwhile",
            "title": "与此同时",
            "description": "显示正文之外的场外事件。",
            "surface": surface,
            "contextOrder": 100,
            "displayOrder": 10,
            "storageFile": "storage.json",
            "viewFile": "view.json",
            "skillFile": "skill/SKILL.md",
        })
        write_json(module / "storage.json", {
            "schemaVersion": 2,
            "kind": "record-log",
            "contextSource": "records",
            "records": {"file": "records.jsonl", "initialFile": "initial-records.json", "schemaFile": "record.schema.json"},
            "snapshot": None,
            "catalogFile": "catalog.json",
            "retrievalPolicyFile": "retrieval-policy.json",
            "engine": {"kind": "post-narrative-output"},
        })
        write_json(module / "initial-records.json", [])
        write_json(module / "record.schema.json", {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": False,
            "required": ["content"],
            "properties": {"content": {"type": "string"}},
        })
        write_json(module / "retrieval-policy.json", {
            "schemaVersion": 1,
            "source": "module:meanwhile",
            "code": {"profile": "default"},
            "agent": {"mode": "disabled", "fallback": "code", "onNotTriggered": "code", "maxRecords": 20},
            "catalog": {"codeProfile": "default", "agentMode": "disabled"},
        })
        write_json(module / "view.json", {"schemaVersion": 1, "regions": [{"type": "markdown", "path": "records.0.data.content"}]})
        skill = module / "skill" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: meanwhile\ndescription: Generate the authored meanwhile output when triggered.\n---\n\n# Meanwhile\n", encoding="utf-8")
        return "features/meanwhile/module.json"

    def test_accepts_frontend_post_narrative_output_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root)
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertEqual(errors, [])

    def test_rejects_background_post_narrative_output_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertTrue(any("frontend surface" in error for error in errors))

    def test_packaged_png_source_requires_manifest_cover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "source" / "extracted.json", {"source": {"format": "png", "cover": {"available": True}}, "card": {}})
            self.assertTrue(VALIDATOR.extracted_source_requires_cover(root, {"source": {}}))


if __name__ == "__main__":
    unittest.main()
