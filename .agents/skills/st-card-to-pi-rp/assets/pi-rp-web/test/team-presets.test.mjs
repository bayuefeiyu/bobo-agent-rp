import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  getWorkflowNodeMode,
  switchWorkflowNode,
} from "../public/team-presets.js";

const preset = {
  schemaVersion: 1,
  nodeId: "draft",
  promptFile: "prompts/workflows/draft-collaboration.md",
  team: {
    schemaVersion: 2,
    protocol: "collaboration",
    members: [
      { id: "planner", label: "Planner", agentId: "demo/planner", modelId: "model-a", tools: ["read", "write"] },
      { id: "reviewer", label: "Reviewer", agentId: "demo/reviewer", modelId: null, tools: ["read", "edit"] },
    ],
    initialMemberId: "planner",
    stageOwnerId: "planner",
    completionMemberId: "reviewer",
    outputOwners: { narrative: "reviewer", report: "reviewer" },
    limits: { maxActivations: 8, maxToolCalls: 12, maxProtocolReminders: 2 },
  },
};

function workflowFixture() {
  return {
    key: "demo/draft",
    schemaVersion: 4,
    ownerModuleId: "demo",
    id: "demo/draft",
    kind: "global-background",
    nodes: [
      {
        id: "draft",
        type: "agent",
        agentId: "demo/writer",
        modelId: "model-before",
        prompt: "write the report",
        title: "Draft",
        dependsOn: ["source"],
        context: { fromNodes: ["source"] },
        outputs: { report: { kind: "file", path: "report.md", format: "markdown" } },
        workflowCalls: [{ target: "demo/source", maxCalls: 1 }],
        metadata: { stable: true },
      },
      { id: "source", type: "code", metadata: { entryFile: "source.mjs" } },
    ],
  };
}

test("switching a composite workflow changes one node and preserves identity/common fields", () => {
  const original = workflowFixture();
  const result = switchWorkflowNode(original, "draft", "collaboration", {
    workflowKey: original.key,
    preset,
    nodeModeBackups: {},
  });
  const target = result.workflow.nodes[0];
  assert.equal(getWorkflowNodeMode(target), "collaboration");
  assert.equal(target.id, "draft");
  assert.deepEqual(target.dependsOn, ["source"]);
  assert.deepEqual(target.context, { fromNodes: ["source"] });
  assert.deepEqual(target.outputs, original.nodes[0].outputs);
  assert.deepEqual(target.workflowCalls, original.nodes[0].workflowCalls);
  assert.deepEqual(target.metadata, original.nodes[0].metadata);
  assert.equal(target.team.members.find(member => member.id === "reviewer").modelId, "model-before");
  assert.equal("writer" in target, false);
  assert.equal("agentId" in target, false);
  assert.equal("modelId" in target, false);
  assert.equal("prompt" in target, false);
  assert.equal(target.promptFile, preset.promptFile);
  const expectedTeam = structuredClone(preset.team);
  expectedTeam.members.find(member => member.id === "reviewer").modelId = "model-before";
  assert.deepEqual(target.team, expectedTeam);
  assert.deepEqual(result.workflow.nodes[1], original.nodes[1]);
  assert.deepEqual(original.nodes[0].agentId, "demo/writer");
  assert.equal(result.nodeModeBackups[original.key].draft.agent.type, "agent");
});

test("switching back and forth keeps user edits in both mode backups", () => {
  const original = workflowFixture();
  const first = switchWorkflowNode(original, "draft", "collaboration", { workflowKey: original.key, preset });
  const collaboration = structuredClone(first.workflow);
  collaboration.nodes[0].context = { fromNodes: ["source"], userEdited: true };
  collaboration.nodes[0].team.members[0].label = "User planner";
  collaboration.nodes[0].team.members[1].modelId = "model-user";
  collaboration.nodes[0].team.limits.maxToolCalls = 99;
  collaboration.nodes[0].prompt = "custom collaboration stages";
  collaboration.nodes[0].promptFile = null;
  const second = switchWorkflowNode(collaboration, "draft", "agent", {
    workflowKey: original.key,
    baseNode: original.nodes[0],
    nodeModeBackups: first.nodeModeBackups,
  });
  assert.equal(second.workflow.nodes[0].type, "agent");
  assert.deepEqual(second.workflow.nodes[0].context, collaboration.nodes[0].context);
  assert.equal(second.workflow.nodes[0].agentId, "demo/writer");
  assert.equal(second.workflow.nodes[0].modelId, "model-before");
  assert.equal(second.workflow.nodes[0].prompt, "write the report");
  assert.equal("team" in second.workflow.nodes[0], false);
  second.workflow.nodes[0].modelId = "agent-user";
  const third = switchWorkflowNode(second.workflow, "draft", "collaboration", {
    workflowKey: original.key,
    preset,
    nodeModeBackups: second.nodeModeBackups,
  });
  assert.deepEqual(third.workflow.nodes[0].context, collaboration.nodes[0].context);
  assert.equal(third.workflow.nodes[0].team.members[0].label, "User planner");
  assert.equal(third.workflow.nodes[0].team.members[1].modelId, "model-user");
  assert.equal(third.workflow.nodes[0].team.limits.maxToolCalls, 99);
  assert.equal(third.workflow.nodes[0].prompt, "custom collaboration stages");
  assert.equal(third.workflow.nodes[0].promptFile, null);
  assert.equal("writer" in third.workflow.nodes[0], false);
  const same = switchWorkflowNode(third.workflow, "draft", "collaboration", {
    workflowKey: original.key,
    preset,
    nodeModeBackups: third.nodeModeBackups,
  });
  assert.deepEqual(same.workflow.nodes[0].team, third.workflow.nodes[0].team);
  assert.deepEqual(same.workflow.nodes[0].context, third.workflow.nodes[0].context);
});

test("workflow renderer retains v1 meeting fields while adding collaboration branch", async () => {
  const source = await readFile(new URL("../public/app-workflows.js", import.meta.url), "utf8");
  assert.match(source, /node\.type === "team" && node\.team\?\.protocol === "collaboration"/);
  assert.match(source, /node\.team\.protocol === "collaboration"/);
  assert.match(source, /node\.team\?\.leader/);
  assert.match(source, /node\.team\?\.experts/);
  assert.match(source, /team-transcript\/open/);
});
