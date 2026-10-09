"""Pure-input tests for the module workflow call surface validator."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from validation.resources import validate_module_call_surface  # noqa: E402


TARGET = "test/export"


def target_workflow(*, agent_callable: bool = True) -> dict[str, Any]:
    return {
        "agentCallable": agent_callable,
        "interface": {
            "inputs": {
                "requiredParameter": {"type": "parameter", "required": True},
                "requiredDocument": {"type": "document", "required": True},
                "optionalParameter": {"type": "parameter"},
            },
            "exports": {
                "result": {"format": "markdown", "kind": "file"},
            },
        },
    }


def validate(
    node: dict[str, Any],
    *,
    node_type: str = "call",
    module_workflows: dict[str, dict[str, Any]] | None = None,
    team_workflow_abilities: list[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    validate_module_call_surface(
        node,
        "node",
        node_type,
        module_workflows if module_workflows is not None else {TARGET: target_workflow()},
        {},
        team_workflow_abilities if team_workflow_abilities is not None else [],
        errors,
    )
    return errors


def valid_fixed_call() -> dict[str, Any]:
    return {
        "target": TARGET,
        "arguments": {"requiredParameter": "value"},
        "documents": {"requiredDocument": "source.md"},
        "outputPaths": {"result": "result.md"},
        "outputs": {"result": {"path": "result.md", "format": "markdown", "kind": "file"}},
    }


class ModuleCallSurfaceTests(unittest.TestCase):
    def test_accepts_fixed_call_with_required_inputs_and_matching_export(self) -> None:
        self.assertEqual([], validate(valid_fixed_call()))

    def test_rejects_missing_required_parameter_and_document(self) -> None:
        node = valid_fixed_call()
        node["arguments"] = {}
        node["documents"] = {}

        self.assertEqual(
            [
                "node is missing required parameter requiredParameter",
                "node is missing required document requiredDocument",
            ],
            validate(node),
        )

    def test_rejects_export_path_format_or_kind_mismatch(self) -> None:
        cases = {
            "path": {"path": "wrong.md"},
            "format": {"format": "json"},
            "kind": {"kind": "directory"},
        }
        expected = "node.outputs.result must match the target export path, format, and kind"

        for mismatch, changes in cases.items():
            with self.subTest(mismatch=mismatch):
                node = valid_fixed_call()
                node["outputs"]["result"].update(changes)
                self.assertEqual([expected], validate(node))

    def test_rejects_unknown_fixed_call_target(self) -> None:
        node = valid_fixed_call()
        node["target"] = "test/missing"

        self.assertEqual(
            ["node.target must reference a declared module workflow"],
            validate(node),
        )

    def test_rejects_unknown_dynamic_call_target(self) -> None:
        self.assertEqual(
            ["node.workflowCalls[0].target must reference a declared module workflow"],
            validate({"workflowCalls": ["test/missing"]}, node_type="agent"),
        )

    def test_rejects_duplicate_dynamic_workflow_target(self) -> None:
        node = {"workflowCalls": [TARGET, {"target": TARGET}]}

        self.assertEqual(
            ["node.workflowCalls contains duplicate target test/export"],
            validate(node, node_type="agent"),
        )

    def test_rejects_dynamic_target_that_is_not_agent_callable(self) -> None:
        node = {"workflowCalls": [TARGET]}

        self.assertEqual(
            ["node.workflowCalls[0].target is not agentCallable"],
            validate(
                node,
                node_type="agent",
                module_workflows={TARGET: target_workflow(agent_callable=False)},
            ),
        )

    def test_rejects_illegal_dynamic_binding_arguments_and_limits(self) -> None:
        node = {
            "workflowCalls": [
                {
                    "target": TARGET,
                    "fixedArguments": {"optionalParameter": "fixed", "unknown": "value"},
                    "allowedArguments": {"optionalParameter": ["allowed"], "otherUnknown": ["value"]},
                    "maxCalls": 0,
                    "documentSnapshotInput": "not a safe id",
                }
            ]
        }

        self.assertEqual(
            [
                "node.workflowCalls[0] cannot both fix and allow arguments ['optionalParameter']",
                "node.workflowCalls[0].maxCalls must be a positive integer",
                "node.workflowCalls[0].documentSnapshotInput must be a safe ID",
                "node.workflowCalls[0] restricts arguments absent from the target interface",
            ],
            validate(node, node_type="agent"),
        )

    def test_rejects_missing_team_workflow_ability_binding(self) -> None:
        node = {"workflowCalls": []}

        self.assertEqual(
            ["node.team workflow abilities require matching workflowCalls: ['test/export']"],
            validate(node, node_type="team", team_workflow_abilities=[TARGET]),
        )


if __name__ == "__main__":
    unittest.main()
