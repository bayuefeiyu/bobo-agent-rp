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
            "schemaVersion": 4,
            "id": "meanwhile",
            "basedOn": None,
            "title": "与此同时",
            "description": "显示正文之外的场外事件。",
            "surface": surface,
            "contextOrder": 100,
            "displayOrder": 10,
            "dataContractFile": "data-contract.json",
            "frontendViewFile": "frontend-view.json",
            "skillFile": "skill/SKILL.md",
        })
        write_json(module / "data-contract.json", {
            "schemaVersion": 1,
            "moduleId": "meanwhile",
            "collections": {
                "scenes": {
                    "storage": {"kind": "record-log", "partition": {"mode": "single"}, "initialRecordsFile": "collections/scenes/initial/records.json"},
                    "recordTypes": {
                        "scene.entry": {
                            "dataSchemaVersion": 1,
                            "indexes": {},
                            "searchableFields": ["/data/content"],
                            "views": {"rp": {"format": "text", "fields": [{"path": "/data/content"}]}},
                            "actions": ["create", "archive"],
                        }
                    },
                }
            },
            "capabilities": {
                "scene.query": {"collections": ["scenes"], "actions": ["query"], "views": ["rp"]},
                "scene.write": {"collections": ["scenes"], "actions": ["create", "archive"], "views": []},
            },
        })
        write_json(module / "collections" / "scenes" / "initial" / "records.json", [])
        write_json(module / "frontend-view.json", {"schemaVersion": 1, "regions": [{"type": "json", "path": "collections.scenes.records"}]})
        skill = module / "skill" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: meanwhile\ndescription: Generate the authored meanwhile output when triggered.\n---\n\n# Meanwhile\n", encoding="utf-8")
        return "features/meanwhile/module.json"

    def test_accepts_module_v4_data_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root)
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertEqual(errors, [])

    def test_accepts_background_data_module(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertEqual(errors, [])

    def test_packaged_png_source_requires_manifest_cover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "source" / "extracted.json", {"source": {"format": "png", "cover": {"available": True}}, "card": {}})
            self.assertTrue(VALIDATOR.extracted_source_requires_cover(root, {"source": {}}))

    def test_workflow_rejects_unknown_access_and_unordered_collection_writers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self.make_output_module(root)
            write_json(root / "manifest.json", {"feature_modules": [module_path]})
            write_json(root / "workflows" / "conflict" / "workflow.json", {
                "schemaVersion": 2,
                "id": "conflict",
                "kind": "turn-background",
                "nodes": [
                    {"id": "left", "type": "agent", "moduleAccess": [{"moduleId": "meanwhile", "collectionId": "scenes", "capabilities": ["scene.write"], "views": []}]},
                    {"id": "right", "type": "agent", "moduleAccess": [{"moduleId": "meanwhile", "collectionId": "scenes", "capabilities": ["scene.write"], "views": []}]},
                    {"id": "bad", "type": "agent", "moduleAccess": [{"moduleId": "meanwhile", "collectionId": "missing", "capabilities": ["missing"], "views": []}]},
                ],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("unordered writers left and right" in error for error in errors))
            self.assertTrue(any("unknown module collection" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
