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
            "schemaVersion": 6,
            "id": "meanwhile",
            "moduleKind": "data",
            "basedOn": None,
            "title": "与此同时",
            "description": "显示正文之外的场外事件。",
            "surface": surface,
            "contextOrder": 100,
            "displayOrder": 10,
            "dataContractFile": "data-contract.json",
            "resourceCatalogFile": None,
            "frontendViewFile": "frontend-view.json" if surface == "frontend" else None,
            "skillFile": "skill/SKILL.md",
            "workflowFiles": ["workflows/query-scenes/workflow.json"],
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
        if surface == "frontend":
            write_json(module / "frontend-view.json", {"schemaVersion": 1, "regions": [{"type": "json", "path": "collections.scenes.records"}]})
        skill = module / "skill" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: meanwhile\ndescription: Generate the authored meanwhile output when triggered.\n---\n\n# Meanwhile\n", encoding="utf-8")
        write_json(module / "workflows" / "query-scenes" / "workflow.json", {
            "schemaVersion": 3,
            "id": "query-scenes",
            "ownerModuleId": "meanwhile",
            "kind": "module-external",
            "interface": {"inputs": {}, "exports": {}},
            "nodes": [{"id": "return", "type": "workflow-return", "exports": {}}],
        })
        return "features/meanwhile/module.json"

    def test_accepts_module_v6_data_contract(self) -> None:
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

    def test_accepts_a_structurally_valid_public_team_node(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "workflows" / "team-check" / "workflow.json", {
                "schemaVersion": 3,
                "id": "team-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "meeting",
                    "type": "team",
                    "team": {
                        "schemaVersion": 1,
                        "leader": {"id": "leader", "agentId": "leader-agent"},
                        "secretary": {"id": "secretary", "agentId": "secretary-agent"},
                        "experts": [{"id": "logic", "agentId": "expert-agent", "focus": "logic"}],
                        "assistants": [],
                    },
                }],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

    def test_module_workflow_team_nodes_use_the_same_adapter_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            workflow_path = root / "features" / "meanwhile" / "workflows" / "query-scenes" / "workflow.json"
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
            workflow["nodes"].insert(0, {
                "id": "meeting",
                "type": "team",
                "team": {
                    "leader": {"id": "same", "agentId": "leader-agent"},
                    "secretary": {"id": "same", "agentId": "secretary-agent"},
                    "assistants": [{"id": "tool", "kind": "tool", "adapter": "unknown-tool", "inputAdapter": "unknown-input"}],
                },
            })
            write_json(workflow_path, workflow)
            write_json(root / "manifest.json", {"feature_modules": [path]})
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertTrue(any("member IDs must be unique" in error for error in errors))
            self.assertTrue(any("inputAdapter is unsupported" in error for error in errors))
            self.assertTrue(any("adapter is unsupported" in error for error in errors))

    def test_rejects_duplicate_team_members_and_unknown_ability_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "workflows" / "team-check" / "workflow.json", {
                "schemaVersion": 3,
                "id": "team-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "meeting",
                    "type": "team",
                    "team": {
                        "schemaVersion": 1,
                        "leader": {"id": "same", "agentId": "leader-agent"},
                        "secretary": {"id": "same", "agentId": "secretary-agent"},
                        "experts": [],
                        "assistants": [{"id": "bad", "kind": "anything"}],
                    },
                }],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("member IDs must be unique" in error for error in errors))
            self.assertTrue(any("kind is invalid" in error for error in errors))

    def test_module_internal_write_access_must_be_covered_by_collection_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            write_json(root / "features" / "meanwhile" / "workflows" / "query-scenes" / "workflow.json", {
                "schemaVersion": 3,
                "id": "query-scenes",
                "ownerModuleId": "meanwhile",
                "kind": "module-internal",
                "writeLocks": [{"moduleId": "meanwhile", "collectionId": None}],
                "interface": {"inputs": {}, "exports": {}},
                "nodes": [
                    {"id": "write", "type": "code", "moduleAccess": [{"moduleId": "meanwhile", "collectionId": "scenes", "capabilities": ["scene.write"], "views": []}]},
                    {"id": "return", "type": "workflow-return", "dependsOn": ["write"], "exports": {}},
                ],
            })
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertEqual(errors, [])
            workflow_path = root / "features" / "meanwhile" / "workflows" / "query-scenes" / "workflow.json"
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
            workflow["writeLocks"] = [{"moduleId": "meanwhile", "collectionId": "missing"}]
            write_json(workflow_path, workflow)
            errors = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertTrue(any("unknown owner collection" in error for error in errors))
            self.assertTrue(any("not covered by workflow.writeLocks" in error for error in errors))

    def test_multiple_module_internal_workflow_requires_stable_identity_and_exact_locks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            workflow_path = root / "features" / "meanwhile" / "workflows" / "query-scenes" / "workflow.json"
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
            workflow["kind"] = "module-internal"
            workflow["instancePolicy"] = {"mode": "multiple"}
            workflow["writeLocks"] = [{"moduleId": "meanwhile", "collectionId": None}]
            write_json(workflow_path, workflow)
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertTrue(any("dedupeKey is required" in error for error in errors))
            self.assertTrue(any("maxConcurrentInstances must be a positive integer" in error for error in errors))
            self.assertTrue(any("exact collection locks" in error for error in errors))

    def test_validates_random_runtime_service_on_code_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "workflows" / "random-event" / "workflow.json", {
                "schemaVersion": 3,
                "id": "random-event",
                "kind": "turn-background",
                "nodes": [{"id": "roll", "type": "code", "runtimeServices": ["random"]}],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

            write_json(root / "workflows" / "random-event" / "workflow.json", {
                "schemaVersion": 3,
                "id": "random-event",
                "kind": "turn-background",
                "nodes": [{"id": "roll", "type": "agent", "runtimeServices": ["random", "fortune"]}],
            })
            errors = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("only for code nodes" in error for error in errors))
            self.assertTrue(any("unsupported services" in error for error in errors))

    def test_accepts_module_v6_resource_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / "features" / "card-context-library"
            write_json(module / "module.json", {
                "schemaVersion": 6, "id": "card-context-library", "moduleKind": "resource", "basedOn": None,
                "title": "资料库", "description": "静态资料", "surface": "background", "contextOrder": 100, "displayOrder": 100,
                "dataContractFile": None, "resourceCatalogFile": "catalog.json", "frontendViewFile": None,
                "skillFile": "skill/SKILL.md", "workflowFiles": ["workflows/export-context/workflow.json"],
            })
            write_json(module / "catalog.json", {
                "schemaVersion": 1, "moduleId": "card-context-library",
                "categories": {"world": {"title": "世界观", "description": "世界资料"}},
                "selectionGroups": {},
                "documents": [{
                    "id": "world-core", "path": "documents/world/core.md", "title": "世界", "summary": "世界细节", "categories": ["world"],
                    "subcategory": None, "readPolicy": "conditional", "authority": "canonical", "appliesAt": ["planning", "writing"],
                    "priority": 50, "selectionGroup": None, "readWhen": ["涉及设定"], "perspective": "narrator", "aliases": [], "related": [], "sources": ["lore:1"],
                }],
            })
            (module / "documents" / "world").mkdir(parents=True)
            (module / "documents" / "world" / "core.md").write_text("世界资料\n", encoding="utf-8")
            skill = module / "skill" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: card-context-library\ndescription: Export card context.\n---\n", encoding="utf-8")
            write_json(module / "workflows" / "export-context" / "workflow.json", {
                "schemaVersion": 3, "id": "export-context", "ownerModuleId": "card-context-library", "kind": "module-external",
                "interface": {
                    "inputs": {"categories": {"type": "parameter", "required": True, "valueType": "string-array"}},
                    "exports": {"context": {"format": "document-set"}},
                },
                "nodes": [
                    {"id": "export", "type": "code", "outputs": {"context": {"path": "context", "format": "document-set"}}},
                    {"id": "return", "type": "workflow-return", "dependsOn": ["export"], "exports": {"context": {"fromNode": "export", "output": "context"}}},
                ],
            })
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, ["features/card-context-library/module.json"], errors)
            self.assertEqual(errors, [])
            write_json(root / "manifest.json", {"feature_modules": ["features/card-context-library/module.json"]})
            write_json(root / "workflows" / "standard-rp" / "workflow.json", {
                "schemaVersion": 3, "id": "standard-rp", "kind": "foreground",
                "nodes": [
                    {
                        "id": "resources", "type": "call", "target": "card-context-library/export-context",
                        "arguments": {"categories": ["world"]}, "documents": {}, "outputPaths": {"context": "card-context"},
                        "outputs": {"context": {"path": "card-context", "format": "document-set"}},
                    },
                    {"id": "write", "type": "agent", "dependsOn": ["resources"], "outputs": {"narrative": {"path": "narrative.md", "format": "narrative"}}},
                    {"id": "finish", "type": "turn-finalize", "dependsOn": ["write"], "narrative": {"fromNode": "write", "output": "narrative"}},
                ],
            })
            workflow_errors: list[str] = []
            VALIDATOR.validate_workflows(root, workflow_errors)
            self.assertEqual(workflow_errors, [])
            (root / "core").mkdir()
            (root / "core" / "foundation.md").write_text("简洁的总体设定。\n", encoding="utf-8")
            (root / "openings").mkdir()
            (root / "openings" / "00.md").write_text("开场。\n", encoding="utf-8")
            write_json(root / "context" / "retrieval-policy.json", {
                "schemaVersion": 2,
                "source": "messages",
                "code": {"profile": "default"},
                "agent": {"mode": "disabled", "fallback": "code", "onNotTriggered": "code", "maxRecords": 20},
            })
            manifest = {
                "schema_version": 2,
                "id": "resource-card",
                "name": "Resource Card",
                "cover": None,
                "fixed_context": "core/foundation.md",
                "context_policy": "context/retrieval-policy.json",
                "context_skill": None,
                "feature_modules": ["features/card-context-library/module.json"],
                "context_processors": [],
                "openings": [{"id": "opening-00", "file": "openings/00.md"}],
                "default_opening": "opening-00",
            }
            manifest_errors: list[str] = []
            manifest_warnings: list[str] = []
            VALIDATOR.validate_manifest(root, manifest, manifest_errors, manifest_warnings)
            self.assertEqual(manifest_errors, [])
            self.assertIn("manifest source metadata is missing", manifest_warnings)

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
                "schemaVersion": 3,
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

    def test_workflow_handoff_defaults_to_declared_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "manifest.json", {"feature_modules": []})
            write_json(root / "workflows" / "handoff" / "workflow.json", {
                "schemaVersion": 3,
                "id": "handoff",
                "kind": "turn-background",
                "nodes": [
                    {
                        "id": "prepare",
                        "type": "code",
                        "outputs": {
                            "map": {"path": "guides/WORKSPACE-DOCUMENTS.md", "scope": "workflow", "retain": "run"},
                        },
                        "workspaceHandoff": {"include": [{"output": "map"}]},
                    },
                    {"id": "consume", "type": "agent", "dependsOn": ["prepare"]},
                ],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

    def test_director_module_design_conventions_warn_instead_of_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "core").mkdir()
            (root / "core" / "foundation.md").write_text("设定。\n", encoding="utf-8")
            (root / "context").mkdir()
            write_json(root / "context" / "retrieval-policy.json", {
                "schemaVersion": 2,
                "source": "messages",
                "code": {"profile": "default"},
                "agent": {"mode": "disabled", "fallback": "code", "onNotTriggered": "code", "maxRecords": 20},
            })
            (root / "openings").mkdir()
            (root / "openings" / "00.md").write_text("开场。\n", encoding="utf-8")
            context_module = root / "features" / "card-context-library"
            write_json(context_module / "module.json", {"id": "card-context-library", "resourceCatalogFile": "catalog.json"})
            write_json(context_module / "catalog.json", {"categories": {"world": {}}, "documents": []})
            director_module = root / "features" / "world-narrative-coordinator"
            write_json(director_module / "module.json", {"id": "world-narrative-coordinator"})
            manifest = {
                "schema_version": 2,
                "id": "director-dependency-test",
                "name": "Director dependency test",
                "cover": None,
                "fixed_context": "core/foundation.md",
                "context_policy": "context/retrieval-policy.json",
                "context_skill": None,
                "feature_modules": [
                    "features/card-context-library/module.json",
                    "features/world-narrative-coordinator/module.json",
                ],
                "context_processors": [],
                "openings": [{"id": "opening-00", "file": "openings/00.md"}],
                "default_opening": "opening-00",
            }
            errors: list[str] = []
            warnings: list[str] = []
            VALIDATOR.validate_manifest(root, manifest, errors, warnings)
            # Both statements are conventions the coordinator's own calls already enforce
            # structurally, so they inform the author without blocking a deliberate card.
            self.assertEqual([error for error in errors if "world-narrative-coordinator" in error], [])
            self.assertIn("design: world-narrative-coordinator requires the narrative-memory module", warnings)
            self.assertIn("design: world-narrative-coordinator requires card-context-library category director-future", warnings)

    def test_design_invariants_are_optional_but_checked_when_declared(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for declared, expected in (
                ({"foregroundWorkflow": "main", "requiresCardContextResources": True}, []),
                ({"foregroundWorkflow": "main", "requiresNarrativeAgentCallable": ["demo/lookup"]}, []),
                ({"requiresCardContextResources": True}, ["foregroundWorkflow is required"]),
                ({"foregroundWorkflow": "main", "unknown": True}, ["unknown fields"]),
                ({"foregroundWorkflow": "main", "requiresEffectiveMemoryTimeline": "yes"}, ["must be a boolean"]),
                ({"foregroundWorkflow": "main", "requiresNarrativeAgentCallable": "demo/lookup"}, ["must be an array"]),
                ({"foregroundWorkflow": "absent"}, ["must reference a card-local workflow"]),
            ):
                errors: list[str] = []
                VALIDATOR.validate_design_invariants(root, {"design_invariants": declared}, errors)
                self.assertEqual(
                    [any(fragment in error for error in errors) for fragment in expected],
                    [True] * len(expected),
                    f"{declared} produced {errors}",
                )

    def test_required_narrative_call_is_checked_for_every_narrative_agent(self) -> None:
        target = "demo/lookup"
        by_id = {
            "writer-a": {"id": "writer-a", "type": "agent", "outputs": {"story": {"format": "narrative"}}, "workflowCalls": [target]},
            "writer-b": {"id": "writer-b", "type": "agent", "outputs": {"story": {"format": "narrative"}}, "workflowCalls": []},
        }
        problems = VALIDATOR.foreground_design_problems(
            "workflows/main/workflow.json", by_id, lambda _node_id: set(), {"agentCallable": [target]}
        )
        self.assertEqual(problems, [f"workflows/main/workflow.json narrative Agent must expose {target}; node writer-b does not"])


if __name__ == "__main__":
    unittest.main()
