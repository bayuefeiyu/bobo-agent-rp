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


def write_workflow(root: Path, workflow_id: str, value: dict) -> None:
    module = root / "features" / "test"
    value["ownerModuleId"] = "test"
    module_path = module / "module.json"
    definition = json.loads(module_path.read_text(encoding="utf-8")) if module_path.is_file() else {
        "schemaVersion": 7, "id": "test", "moduleKind": "resource", "basedOn": None,
        "title": "Test", "description": "Fixture", "surface": "background", "contextOrder": 0, "displayOrder": 0,
        "dataContractFile": None, "resourceCatalogFile": "catalog.json", "frontendViewFile": None,
        "skillFile": "skill/SKILL.md", "agentFiles": [], "workflowFiles": [],
    }
    path = f"workflows/{workflow_id}/workflow.json"
    if path not in definition["workflowFiles"]:
        definition["workflowFiles"].append(path)
    write_json(module_path, definition)
    write_json(module / path, value)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {"feature_modules": []}
    if "features/test/module.json" not in manifest["feature_modules"]:
        manifest["feature_modules"].append("features/test/module.json")
    write_json(manifest_path, manifest)


class ValidateCardPackTests(unittest.TestCase):
    def make_output_module(self, root: Path, surface: str = "frontend") -> str:
        module = root / "features" / "meanwhile"
        write_json(module / "module.json", {
            "schemaVersion": 7,
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
            "agentFiles": [], "skillFile": "skill/SKILL.md",
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
            write_json(module / "frontend-view.json", {"schemaVersion": 3, "bindings": [{"id": "scenes", "kind": "records", "collectionId": "scenes", "recordTypes": ["scene.entry"], "view": "rp", "readCapability": "scene.query"}], "regions": [{"id": "scenes", "type": "record-browser", "title": "场外事件", "bindingId": "scenes"}]})
        skill = module / "skill" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: meanwhile\ndescription: Generate the authored meanwhile output when triggered.\n---\n\n# Meanwhile\n", encoding="utf-8")
        write_json(module / "workflows" / "query-scenes" / "workflow.json", {
            "schemaVersion": 4,
            "id": "query-scenes",
            "ownerModuleId": "meanwhile",
            "kind": "module-external",
            "interface": {"inputs": {}, "exports": {}},
            "nodes": [{"id": "return", "type": "workflow-return", "exports": {}}],
        })
        return "features/meanwhile/module.json"

    def test_accepts_module_v7_data_contract(self) -> None:
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

    def _write_transcript_provider_module(self, root: Path, *, view_format: str = "object") -> str:
        path = self.make_output_module(root, surface="background")
        module = root / "features" / "meanwhile"
        write_json(module / "data-contract.json", {
            "schemaVersion": 1,
            "moduleId": "meanwhile",
            "collections": {
                "conversation": {
                    "storage": {"kind": "record-log", "partition": {"mode": "single"}},
                    "recordTypes": {
                        "narrative.message": {
                            "dataSchemaVersion": 1,
                            "indexes": {},
                            "views": {"rp": {"format": view_format, "fields": [{"path": f"/data/{field}"} for field in ("role", "kind", "content", "narrativeSource")]}},
                            "actions": ["create", "update", "delete"],
                        }
                    },
                }
            },
            "capabilities": {},
        })
        return path

    def test_accepts_explicit_transcript_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_transcript_provider_module(root)
            errors: list[str] = []
            VALIDATOR.validate_manifest(root, {
                "schema_version": 2,
                "id": "test-card",
                "name": "Test Card",
                "feature_modules": [module_path],
                "transcript_provider": {
                    "schemaVersion": 1,
                    "moduleId": "meanwhile",
                    "collectionId": "conversation",
                    "recordType": "narrative.message",
                    "view": "rp",
                },
            }, errors, [])
            self.assertFalse(any("transcript_provider" in error for error in errors), errors)

    def test_rejects_transcript_view_missing_canonical_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_transcript_provider_module(root)
            contract_path = root / "features" / "meanwhile" / "data-contract.json"
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            contract["collections"]["conversation"]["recordTypes"]["narrative.message"]["views"]["rp"]["fields"] = [{"path": "/data/content"}]
            write_json(contract_path, contract)
            errors: list[str] = []
            VALIDATOR.validate_manifest(root, {
                "schema_version": 2, "id": "test-card", "name": "Test Card", "feature_modules": [module_path],
                "transcript_provider": {"schemaVersion": 1, "moduleId": "meanwhile", "collectionId": "conversation", "recordType": "narrative.message", "view": "rp"},
            }, errors, [])
            self.assertTrue(any("must expose role, kind, content, and narrativeSource" in error for error in errors), errors)

    def test_rejects_transcript_provider_unknown_module_and_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_transcript_provider_module(root)
            unknown_module_errors: list[str] = []
            VALIDATOR.validate_manifest(root, {
                "schema_version": 2,
                "id": "test-card",
                "name": "Test Card",
                "feature_modules": [module_path],
                "transcript_provider": {
                    "schemaVersion": 1,
                    "moduleId": "missing",
                    "collectionId": "conversation",
                    "recordType": "narrative.message",
                    "view": "rp",
                },
            }, unknown_module_errors, [])
            self.assertTrue(any("unknown installed module" in error for error in unknown_module_errors))

            unknown_view_errors: list[str] = []
            VALIDATOR.validate_manifest(root, {
                "schema_version": 2,
                "id": "test-card",
                "name": "Test Card",
                "feature_modules": [module_path],
                "transcript_provider": {
                    "schemaVersion": 1,
                    "moduleId": "meanwhile",
                    "collectionId": "conversation",
                    "recordType": "narrative.message",
                    "view": "missing",
                },
            }, unknown_view_errors, [])
            self.assertTrue(any("unknown view" in error for error in unknown_view_errors))

    def test_rejects_transcript_provider_illegal_fields_and_view_format(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_transcript_provider_module(root, view_format="text")
            errors: list[str] = []
            VALIDATOR.validate_manifest(root, {
                "schema_version": 2,
                "id": "test-card",
                "name": "Test Card",
                "feature_modules": [module_path],
                "transcript_provider": {
                    "schemaVersion": 1,
                    "moduleId": "meanwhile",
                    "collectionId": "conversation",
                    "recordType": "narrative.message",
                    "view": "rp",
                    "extra": True,
                },
            }, errors, [])
            self.assertTrue(any("must contain exactly" in error for error in errors))
            self.assertTrue(any("object-format view" in error for error in errors))

    def test_accepts_a_structurally_valid_public_team_node(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_workflow(root, "team-check", {
                "schemaVersion": 4,
                "id": "team-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "meeting",
                    "type": "team",
                    "team": {
                        "schemaVersion": 1,
                        "leader": {"id": "leader", "agentId": "test/leader-agent"},
                        "secretary": {"id": "secretary", "agentId": "test/secretary-agent"},
                        "experts": [{"id": "logic", "agentId": "test/expert-agent", "focus": "logic"}],
                        "assistants": [],
                    },
                }],
            })
            module = root / "features" / "test"
            definition = json.loads((module / "module.json").read_text(encoding="utf-8"))
            for agent_id in ("leader-agent", "secretary-agent", "expert-agent"):
                path = f"agents/{agent_id}/agent.json"
                definition["agentFiles"].append(path)
                write_json(module / path, {"id": agent_id, "ownerModuleId": "test"})
            write_json(module / "module.json", definition)
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

            # A well-formed qualified ID must still name an installed, registered Agent.
            definition["agentFiles"].pop()
            write_json(module / "module.json", definition)
            errors = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("registered module Agent" in error and "expert-agent" in error for error in errors))

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
                    "leader": {"id": "same", "agentId": "test/leader-agent"},
                    "secretary": {"id": "same", "agentId": "test/secretary-agent"},
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

    def test_module_workflow_accepts_collaboration_team_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            module = root / "features" / "meanwhile"
            definition = json.loads((module / "module.json").read_text(encoding="utf-8"))
            for agent_id in ("writer-agent", "co-creator-agent"):
                agent_path = f"agents/{agent_id}/agent.json"
                definition["agentFiles"].append(agent_path)
                write_json(module / agent_path, {"schemaVersion": 1, "id": agent_id, "ownerModuleId": "meanwhile"})
            write_json(module / "module.json", definition)
            workflow_path = module / "workflows" / "query-scenes" / "workflow.json"
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
            workflow["nodes"].insert(0, {
                "id": "write-narrative",
                "type": "team",
                "team": {
                    "schemaVersion": 2,
                    "protocol": "collaboration",
                    "initialMemberId": "writer",
                    "stageOwnerId": "writer",
                    "completionMemberId": "writer",
                    "members": [
                        {"id": "writer", "agentId": "meanwhile/writer-agent", "tools": ["read", "write"]},
                        {"id": "co-creator", "agentId": "meanwhile/co-creator-agent", "tools": ["read", "write", "rp_call"]},
                    ],
                    "outputOwners": {"narrative": "writer"},
                    "limits": {"maxActivations": 1},
                },
                "outputs": {"narrative": {"path": "narrative.md", "format": "narrative", "scope": "workflow", "retain": "run"}},
            })
            write_json(workflow_path, workflow)
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [path], errors)
            self.assertEqual(errors, [])

    def test_rejects_duplicate_team_members_and_unknown_ability_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_workflow(root, "team-check", {
                "schemaVersion": 4,
                "id": "team-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "meeting",
                    "type": "team",
                    "team": {
                        "schemaVersion": 1,
                        "leader": {"id": "same", "agentId": "test/leader-agent"},
                        "secretary": {"id": "same", "agentId": "test/secretary-agent"},
                        "experts": [],
                        "assistants": [{"id": "bad", "kind": "anything"}],
                    },
                }],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("member IDs must be unique" in error for error in errors))
            self.assertTrue(any("kind is invalid" in error for error in errors))

    def _register_test_agents(self, root: Path, *agent_ids: str) -> None:
        module = root / "features" / "test"
        definition = json.loads((module / "module.json").read_text(encoding="utf-8"))
        for agent_id in agent_ids:
            path = f"agents/{agent_id}/agent.json"
            if path not in definition["agentFiles"]:
                definition["agentFiles"].append(path)
            write_json(module / path, {"schemaVersion": 1, "id": agent_id, "ownerModuleId": "test"})
        write_json(module / "module.json", definition)

    def _collaboration_team(self, *, output_owners: dict[str, str] | None = None) -> dict:
        return {
            "schemaVersion": 2,
            "protocol": "collaboration",
            "initialMemberId": "writer",
            "stageOwnerId": "writer",
            "completionMemberId": "writer",
            "members": [
                {"id": "writer", "agentId": "test/writer-agent", "tools": ["read", "write", "edit", "rp_files"]},
                {"id": "co-creator", "agentId": "test/co-creator-agent", "tools": ["read", "write", "edit", "rp_files", "rp_call"]},
            ],
            "outputOwners": output_owners if output_owners is not None else {"narrative": "writer"},
            "limits": {"maxActivations": 32, "maxToolCalls": 128, "maxProtocolReminders": 2},
        }

    def test_accepts_collaboration_team_delivery_and_generated_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_workflow(root, "collaboration-check", {
                "schemaVersion": 4,
                "id": "collaboration-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "write-narrative",
                    "type": "team",
                    "team": self._collaboration_team(),
                    "outputs": {
                        "narrative": {"path": "narrative.md", "format": "narrative", "scope": "workflow", "retain": "run"},
                        "post-turn-context": {"path": "post-turn-context", "format": "document-workspace-snapshot", "kind": "directory", "scope": "turn", "retain": "turn"},
                    },
                    "delivery": {"primaryOutput": "narrative"},
                    "metadata": {"documentWorkspaceSnapshot": {"output": "post-turn-context"}},
                }],
            })
            self._register_test_agents(root, "writer-agent", "co-creator-agent")
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

    def test_collaboration_schema_differences_are_checked(self) -> None:
        cases = (
            ("one-member", lambda team: team.update({"members": team["members"][:1]}), "at least two members"),
            ("duplicate-id", lambda team: team["members"][1].update({"id": "writer"}), "member IDs must be unique"),
            ("bad-tool", lambda team: team["members"][0]["tools"].append("shell"), "unsupported collaboration tool"),
            ("meeting-field", lambda team: team.update({"agenda": {"normalRounds": 1}}), "meeting field agenda"),
            ("bad-limit", lambda team: team["limits"].update({"maxToolCalls": 10001}), "integer from 1 to 10000"),
            ("missing-owner", lambda team: team["outputOwners"].clear(), "assign an owner for output narrative"),
            ("required-call-without-permission", lambda team: team["members"][1]["tools"].clear(), "required calls need an authorized member"),
        )
        for name, mutate, expected in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                team = self._collaboration_team()
                mutate(team)
                write_workflow(root, "collaboration-check", {
                    "schemaVersion": 4,
                    "id": "collaboration-check",
                    "kind": "global-background",
                    "nodes": [{
                        "id": "write-narrative",
                        "type": "team",
                        "team": team,
                        "requiredCalls": ["test/lookup"],
                        "outputs": {"narrative": {"path": "narrative.md", "format": "narrative", "scope": "workflow", "retain": "run"}},
                    }],
                })
                self._register_test_agents(root, "writer-agent", "co-creator-agent")
                errors: list[str] = []
                VALIDATOR.validate_workflows(root, errors)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_collaboration_requires_registered_agents_and_rejects_meeting_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            team = self._collaboration_team()
            team["members"][1]["agentId"] = "test/missing-agent"
            write_workflow(root, "collaboration-check", {
                "schemaVersion": 4,
                "id": "collaboration-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "write-narrative",
                    "type": "team",
                    "team": team,
                    "outputs": {"narrative": {"path": "narrative.md", "format": "narrative", "scope": "workflow", "retain": "run"}},
                    "delivery": {"primaryOutput": "narrative"},
                }],
            })
            self._register_test_agents(root, "writer-agent")
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("registered module Agent" in error and "missing-agent" in error for error in errors), errors)

            # A schema-1 meeting team keeps its historical shape but cannot use Agent delivery.
            meeting = {
                "schemaVersion": 1,
                "leader": {"id": "leader", "agentId": "test/writer-agent"},
                "secretary": {"id": "secretary", "agentId": "test/writer-agent"},
                "experts": [],
                "assistants": [],
            }
            write_workflow(root, "meeting-delivery", {
                "schemaVersion": 4,
                "id": "meeting-delivery",
                "kind": "global-background",
                "nodes": [{
                    "id": "meeting",
                    "type": "team",
                    "team": meeting,
                    "outputs": {"report": {"path": "report.md", "scope": "workflow", "retain": "run"}},
                    "delivery": {"primaryOutput": "report"},
                }],
            })
            errors = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("Agent or collaboration team declaration" in error for error in errors), errors)

    def test_collaboration_preset_resource_is_schema_checked_and_target_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            team = self._collaboration_team()
            del team["outputOwners"]  # Presets need not know the target node's complete output set.
            write_workflow(root, "collaboration-check", {
                "schemaVersion": 4,
                "id": "collaboration-check",
                "kind": "global-background",
                "nodes": [{
                    "id": "write-narrative",
                    "type": "team",
                    "team": self._collaboration_team(),
                    "outputs": {"narrative": {"path": "narrative.md", "format": "narrative", "scope": "workflow", "retain": "run"}},
                    "metadata": {"collaborationPreset": "presets/collaboration.json"},
                }],
            })
            self._register_test_agents(root, "writer-agent", "co-creator-agent")
            module = root / "features" / "test"
            (module / "prompts" / "workflows").mkdir(parents=True)
            (module / "prompts" / "workflows" / "write-narrative-team.md").write_text("Team task\n", encoding="utf-8")
            write_json(module / "presets" / "collaboration.json", {
                "schemaVersion": 1,
                "nodeId": "write-narrative",
                "promptFile": "prompts/workflows/write-narrative-team.md",
                "team": team,
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

            preset = json.loads((module / "presets" / "collaboration.json").read_text(encoding="utf-8"))
            preset["nodeId"] = "other-node"
            write_json(module / "presets" / "collaboration.json", preset)
            errors = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("nodeId must match target node" in error for error in errors), errors)

    def test_module_internal_write_access_must_be_covered_by_collection_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.make_output_module(root, surface="background")
            write_json(root / "features" / "meanwhile" / "workflows" / "query-scenes" / "workflow.json", {
                "schemaVersion": 4,
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
            write_workflow(root, "random-event", {
                "schemaVersion": 4,
                "id": "random-event",
                "kind": "turn-background",
                "nodes": [{"id": "roll", "type": "code", "runtimeServices": ["random"]}],
            })
            errors: list[str] = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertEqual(errors, [])

            write_workflow(root, "random-event", {
                "schemaVersion": 4,
                "id": "random-event",
                "kind": "turn-background",
                "nodes": [{"id": "roll", "type": "agent", "runtimeServices": ["random", "fortune"]}],
            })
            errors = []
            VALIDATOR.validate_workflows(root, errors)
            self.assertTrue(any("only for code nodes" in error for error in errors))
            self.assertTrue(any("unsupported services" in error for error in errors))

    def _write_external_resource_module(
        self,
        root: Path,
        *,
        module_id: str = "creative-reference-library",
        external_resource: str | None = "creative-reference-library/v1",
        schema_version: int = 8,
        resource_catalog_file: str | None = None,
        workflow_owner: str | None = None,
        nodes: list[dict] | None = None,
    ) -> str:
        module_root = root / "features" / module_id
        module = {
            "schemaVersion": schema_version,
            "id": module_id,
            "moduleKind": "resource",
            "basedOn": None,
            "title": "参考资料库",
            "description": "测试资源模块",
            "surface": "background",
            "contextOrder": 0,
            "displayOrder": 0,
            "dataContractFile": None,
            "resourceCatalogFile": resource_catalog_file,
            "frontendViewFile": None,
            "skillFile": "skill/SKILL.md",
            "agentFiles": [],
            "workflowFiles": ["workflows/lookup/workflow.json"],
        }
        if schema_version == 8:
            module["externalResource"] = external_resource
        write_json(module_root / "module.json", module)
        if resource_catalog_file:
            write_json(
                module_root / "catalog.json",
                {
                    "schemaVersion": 1,
                    "moduleId": module_id,
                    "categories": {"world": {"title": "World", "description": "World references"}},
                    "selectionGroups": {},
                    "documents": [],
                },
            )
        skill = module_root / "skill" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text("---\nname: reference-library\ndescription: test\n---\n", encoding="utf-8")
        workflow_path = module_root / "workflows" / "lookup" / "workflow.json"
        owner = workflow_owner or module_id
        workflow_nodes = nodes or [{"id": "return", "type": "workflow-return", "exports": {}}]
        write_json(
            workflow_path,
            {
                "schemaVersion": 4,
                "id": f"{module_id}/lookup",
                "ownerModuleId": owner,
                "kind": "module-external",
                "agentCallable": True,
                "interface": {"inputs": {}, "exports": {}},
                "nodes": workflow_nodes,
            },
        )
        return f"features/{module_id}/module.json"

    def test_accepts_v8_external_reference_without_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_external_resource_module(root)
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertEqual(errors, [])

    def test_v8_null_external_reference_keeps_resource_catalog_rule(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_external_resource_module(
                root,
                external_resource=None,
                resource_catalog_file="catalog.json",
            )
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertEqual(errors, [])

            missing_catalog_root = root / "missing-catalog"
            missing_catalog_path = self._write_external_resource_module(missing_catalog_root, external_resource=None)
            errors = []
            VALIDATOR.validate_feature_modules(missing_catalog_root, [missing_catalog_path], errors)
            self.assertTrue(any("resourceCatalogFile must match moduleKind resource" in error for error in errors))

    def test_external_reference_rejects_a_declared_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_external_resource_module(root, resource_catalog_file="catalog.json")
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertTrue(any("resourceCatalogFile must match moduleKind resource" in error for error in errors))

    def test_rejects_unsupported_external_resource_binding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module_path = self._write_external_resource_module(
                root,
                module_id="other-resource",
                external_resource="creative-reference-library/v1",
            )
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertTrue(any("unsupported external resource binding" in error for error in errors))

    def test_reference_library_runtime_service_allows_owned_agent_or_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code_node = {"id": "lookup", "type": "code", "runtimeServices": ["referenceLibrary"]}
            code_return = {"id": "return", "type": "workflow-return", "dependsOn": ["lookup"], "exports": {}}
            module_path = self._write_external_resource_module(root, nodes=[code_node, code_return])
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertEqual(errors, [])
            write_json(root / "manifest.json", {"feature_modules": [module_path]})
            workflow_errors: list[str] = []
            VALIDATOR.validate_workflows(root, workflow_errors)
            self.assertEqual(workflow_errors, [])

            agent_node = {"id": "lookup", "type": "agent", "runtimeServices": ["referenceLibrary"]}
            agent_return = {"id": "return", "type": "workflow-return", "dependsOn": ["lookup"], "exports": {}}
            agent_root = root / "agent-case"
            agent_module_path = self._write_external_resource_module(agent_root, nodes=[agent_node, agent_return])
            errors = []
            VALIDATOR.validate_feature_modules(agent_root, [agent_module_path], errors)
            self.assertEqual(errors, [])

    def test_reference_library_runtime_service_rejects_wrong_owner_and_random_agent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ref_node = {"id": "lookup", "type": "agent", "runtimeServices": ["referenceLibrary"]}
            ref_return = {"id": "return", "type": "workflow-return", "dependsOn": ["lookup"], "exports": {}}
            module_path = self._write_external_resource_module(root, workflow_owner="other-resource", nodes=[ref_node, ref_return])
            errors: list[str] = []
            VALIDATOR.validate_feature_modules(root, [module_path], errors)
            self.assertTrue(any("must be a module workflow owned" in error for error in errors))

            random_node = {"id": "lookup", "type": "agent", "runtimeServices": ["random"]}
            random_return = {"id": "return", "type": "workflow-return", "dependsOn": ["lookup"], "exports": {}}
            random_root = root / "random-case"
            random_module_path = self._write_external_resource_module(random_root, nodes=[random_node, random_return])
            errors = []
            VALIDATOR.validate_feature_modules(random_root, [random_module_path], errors)
            self.assertTrue(any("only for code nodes" in error for error in errors))

    def test_accepts_module_v7_resource_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / "features" / "card-context-library"
            write_json(module / "module.json", {
                "schemaVersion": 7, "id": "card-context-library", "moduleKind": "resource", "basedOn": None,
                "title": "资料库", "description": "静态资料", "surface": "background", "contextOrder": 100, "displayOrder": 100,
                "dataContractFile": None, "resourceCatalogFile": "catalog.json", "frontendViewFile": None,
                "agentFiles": [], "skillFile": "skill/SKILL.md", "workflowFiles": ["workflows/export-context/workflow.json"],
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
                "schemaVersion": 4, "id": "export-context", "ownerModuleId": "card-context-library", "kind": "module-external",
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
            write_workflow(root, "standard-rp", {
                "schemaVersion": 4, "id": "standard-rp", "kind": "foreground",
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
            write_workflow(root, "conflict", {
                "schemaVersion": 4,
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
            write_workflow(root, "handoff", {
                "schemaVersion": 4,
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
