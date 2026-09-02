from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("inventory_card.py")
SPEC = importlib.util.spec_from_file_location("inventory_card", MODULE_PATH)
assert SPEC and SPEC.loader
inventory_card = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory_card)


class InventoryCardTests(unittest.TestCase):
    def write(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def build_project(self, root: Path) -> tuple[Path, Path]:
        converter = root / ".agents/skills/st-card-to-pi-rp"
        runtime = converter / "assets/pi-rp-runtime"
        web = converter / "assets/pi-rp-web"
        self.write(web / "public/app.js", "new-template")
        self.write(web / "public/new.js", "new")
        self.write(runtime / ".pi/lib/shared.mjs", "shared")
        self.write(runtime / "agents/writer/agent.json", "{}")
        workflow = {"schemaVersion": 2, "id": "standard-rp", "kind": "foreground", "nodes": [{"id": "narrative", "type": "narrative"}, {"id": "finish", "type": "turn-finalize", "dependsOn": ["narrative"]}]}
        workflow_text = json.dumps(workflow)
        self.write(runtime / "workflows/standard-rp/workflow.json", workflow_text)
        self.write(root / "play/.pi/lib/shared.mjs", "shared")
        self.write(root / "play/agents/writer/agent.json", "{}")
        self.write(root / "play/workflows/standard-rp/workflow.json", workflow_text)

        global_module = root / "global-modules/mood"
        card = root / "play/cards/test-card"
        module_definition = {
            "schemaVersion": 4, "id": "mood", "basedOn": "global:mood", "title": "Mood", "description": "Tracks mood",
            "surface": "frontend", "contextOrder": 10, "displayOrder": 10,
            "dataContractFile": "data-contract.json", "frontendViewFile": "view.json", "skillFile": "skill/SKILL.md",
        }
        data_contract = {
            "schemaVersion": 1,
            "moduleId": "mood",
            "collections": {
                "states": {
                    "storage": {"kind": "snapshot"},
                    "recordTypes": {"mood-state": {"indexes": {}, "views": {"rp": {"fields": ["/data/value"]}}}},
                }
            },
            "capabilities": {"mood.query": {"collection": "states", "operations": ["query", "get"]}},
        }
        self.write(global_module / "module.json", json.dumps(module_definition))
        self.write(global_module / "data-contract.json", json.dumps(data_contract))
        self.write(card / "features/mood/module.json", json.dumps(module_definition))
        card_contract = json.loads(json.dumps(data_contract))
        card_contract["collections"]["states"]["recordTypes"]["mood-state"]["indexes"]["intensity"] = {"path": "/data/intensity", "type": "number", "required": False}
        self.write(card / "features/mood/data-contract.json", json.dumps(card_contract))
        self.write(card / "web/public/app.js", "custom-card")
        self.write(card / "web/public/custom.js", "custom")
        self.write(card / "core/story.md", "story")
        self.write(card / "workflows/standard-rp/workflow.json", workflow_text)
        manifest = {
            "id": "test-card",
            "name": "Test Card",
            "fixed_context": ["core/story.md", "core/missing.md"],
            "primary_characters": [],
            "context_processors": [],
            "feature_modules": ["features/mood/module.json"],
            "openings": [],
        }
        self.write(card / "manifest.json", json.dumps(manifest))
        updated = root / "updated.png"
        updated.write_bytes(b"updated-source")
        return card, updated

    def test_builds_read_only_cross_layer_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            card, updated = self.build_project(root)
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())
            result = inventory_card.build_inventory(card, root, updated)
            after = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())

            self.assertEqual(before, after)
            self.assertEqual(result["card"]["id"], "test-card")
            self.assertEqual([item["path"] for item in result["references"]["missing"]], ["core/missing.md"])
            self.assertEqual(result["frontend"]["status"], "diverged")
            self.assertEqual(result["frontend"]["modified"], ["public/app.js"])
            self.assertEqual(result["frontend"]["currentOnly"], ["public/custom.js"])
            self.assertEqual(result["frontend"]["upstreamOnly"], ["public/new.js"])
            self.assertEqual(result["installedRuntime"]["pi"]["status"], "exact")
            self.assertEqual(result["workflows"][0]["matchesUpstream"], True)
            self.assertEqual(result["workflows"][0]["byteMatchesUpstream"], True)
            self.assertEqual(result["modules"][0]["upstreamComparison"]["status"], "diverged")
            self.assertEqual(result["modules"][0]["dataContractVersion"], 1)
            self.assertEqual(result["modules"][0]["collections"][0]["recordTypes"], ["mood-state"])
            self.assertEqual(result["modules"][0]["capabilities"], ["mood.query"])
            self.assertEqual(result["updatedSource"]["sha256"], inventory_card.sha256_file(updated))
            self.assertFalse(result["validation"]["available"])

    def test_rejects_missing_card_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "does not exist"):
                inventory_card.build_inventory(root / "missing", root)


if __name__ == "__main__":
    unittest.main()
