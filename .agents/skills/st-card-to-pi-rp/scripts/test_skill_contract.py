from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ConversionSkillContractTests(unittest.TestCase):
    def test_global_module_choice_precedes_formal_proposal(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        selection = skill.index("### 2. Resolve global-module scope before the formal proposal")
        proposal = skill.index("### 3. Present a concise conversion proposal")
        self.assertLess(selection, proposal)
        self.assertIn("Do not produce a formal conversion proposal while module scope is unresolved", skill)
        self.assertIn("Module selection does not authorize writes", skill)

    def test_memory_selection_requires_carrier_change_disclosure(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        required = [
            "Memory integration and content-carrier changes",
            "material moving from fixed prompts",
            "personality and behavior guidance that stays fixed",
            "remain owned by another feature module",
            "opening-specific initial records",
            "delayed source capture",
            "source revision tracking",
        ]
        for phrase in required:
            self.assertIn(phrase, skill)

    def test_document_workspace_is_generic_agent_capability(self):
        runtime = (ROOT / "assets" / "pi-rp-runtime" / ".pi" / "extensions" / "pi-rp-web.ts").read_text(encoding="utf-8")
        workflow_contract = (ROOT / "references" / "workflow-system.md").read_text(encoding="utf-8")
        workflow_root = ROOT / "assets" / "pi-rp-runtime" / "workflows"
        default_workflows = [
            json.loads((workflow_root / "standard-rp" / "workflow.json").read_text(encoding="utf-8")),
            json.loads((workflow_root / "advanced-memory-rp" / "workflow.json").read_text(encoding="utf-8")),
        ]

        for obsolete in ("creativeWorkspace", "CREATIVE-WORKSPACE.md", "prepare-creative-workspace"):
            self.assertNotIn(obsolete, runtime)
            self.assertNotIn(obsolete, workflow_contract)
            for workflow in default_workflows:
                self.assertNotIn(obsolete, json.dumps(workflow, ensure_ascii=False))

        self.assertIn("metadata.documentWorkspace: true", workflow_contract)
        self.assertIn("workspaceHandoff.include", workflow_contract)
        self.assertIn("WORKSPACE-DOCUMENTS.md", runtime)
        for workflow in default_workflows:
            agent_nodes = [node for node in workflow["nodes"] if node["type"] == "agent"]
            self.assertTrue(any(node.get("metadata", {}).get("documentWorkspace") is True for node in agent_nodes))
            prepared_outputs = [
                node for node in workflow["nodes"]
                if node.get("outputs") and node.get("id") != "write-narrative"
            ]
            self.assertTrue(prepared_outputs)
            self.assertTrue(all(node.get("workspaceHandoff", {}).get("include") for node in prepared_outputs))

    def test_advanced_memory_workflow_keeps_analysis_in_the_calling_agent(self):
        workflow = json.loads((ROOT / "assets" / "pi-rp-runtime" / "workflows" / "advanced-memory-rp" / "workflow.json").read_text(encoding="utf-8"))
        writer = next(node for node in workflow["nodes"] if node["id"] == "write-narrative")
        call_targets = [call if isinstance(call, str) else call["target"] for call in writer["workflowCalls"]]
        self.assertIn("narrative-memory/narrative-memory-retrieve", call_targets)
        self.assertIn("自然语言Markdown记忆查询清单", writer["prompt"])
        self.assertIn("需要推理的结论", writer["prompt"])
        self.assertNotIn("narrative-memory/narrative-memory-creative-context", json.dumps(workflow, ensure_ascii=False))
        timeline = next(node for node in workflow["nodes"] if node["id"] == "prepare-event-timeline")
        self.assertEqual(timeline["target"], "narrative-memory/narrative-memory-reference-snapshot")
        self.assertEqual(timeline["arguments"], {"timeline": {"mode": "effective"}})


if __name__ == "__main__":
    unittest.main()
