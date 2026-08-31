import assert from "node:assert/strict";
import test from "node:test";

import {
  completeWorkflowNode,
  createWorkflowRun,
  failWorkflowNode,
  normalizeWorkflowDefinition,
  prepareWorkflowNodeRetry,
  readyWorkflowNodes,
  resolveInstanceKey,
  startWorkflowNode,
} from "./rp-workflows.mjs";

const foreground = {
  schemaVersion: 1,
  id: "standard-rp",
  kind: "foreground",
  nodes: [
    { id: "world", type: "agent" },
    { id: "character", type: "agent" },
    { id: "narrative", type: "narrative", dependsOn: ["world", "character"], join: { mode: "all" } },
    { id: "finalize", type: "turn-finalize", dependsOn: ["narrative"] },
  ],
};

test("normalizes a foreground DAG and exposes parallel roots", () => {
  const workflow = normalizeWorkflowDefinition(foreground);
  const run = createWorkflowRun(workflow, { id: "run-1", turn: 1 });
  assert.deepEqual(readyWorkflowNodes(workflow, run).map(node => node.id), ["world", "character"]);
});

test("advances through parallel nodes to narrative and finalization", () => {
  const run = createWorkflowRun(foreground, { id: "run-1", turn: 1 });
  for (const id of ["world", "character"]) {
    startWorkflowNode(foreground, run, id, { modelId: "fast" });
    completeWorkflowNode(foreground, run, id, { output: { ok: id } });
  }
  assert.deepEqual(readyWorkflowNodes(foreground, run).map(node => node.id), ["narrative"]);
  startWorkflowNode(foreground, run, "narrative", { modelId: "writer" });
  completeWorkflowNode(foreground, run, "narrative", { output: "story" });
  assert.deepEqual(readyWorkflowNodes(foreground, run).map(node => node.id), ["finalize"]);
  startWorkflowNode(foreground, run, "finalize", { modelId: "pi:current" });
  completeWorkflowNode(foreground, run, "finalize");
  assert.equal(run.status, "completed");
});

test("waits for user model choice after the third failed attempt", () => {
  const run = createWorkflowRun(foreground, { id: "run-2", turn: 1 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    startWorkflowNode(foreground, run, "world", { modelId: "fast" });
    failWorkflowNode(foreground, run, "world", new Error("rate limited"));
    if (attempt < 2) prepareWorkflowNodeRetry(run, "world");
  }
  assert.equal(run.nodes.world.status, "awaiting-model-choice");
  assert.equal(run.status, "awaiting-model-choice");
});

test("supports route conditions and skips the inactive branch", () => {
  const workflow = {
    schemaVersion: 1,
    id: "branching",
    kind: "turn-background",
    nodes: [
      { id: "gate", type: "gate" },
      { id: "left", type: "agent", dependsOn: ["gate"], conditions: [{ nodeId: "gate", routes: ["left"] }] },
      { id: "right", type: "agent", dependsOn: ["gate"], conditions: [{ nodeId: "gate", routes: ["right"] }] },
    ],
  };
  const run = createWorkflowRun(workflow);
  startWorkflowNode(workflow, run, "gate", { modelId: "fast" });
  completeWorkflowNode(workflow, run, "gate", { route: "right" });
  assert.deepEqual(readyWorkflowNodes(workflow, run).map(node => node.id), ["right"]);
  assert.equal(run.nodes.left.status, "skipped");
});

test("uses keyed multi-instance identities for independent characters", () => {
  const workflow = {
    schemaVersion: 1,
    id: "character-analysis",
    kind: "global-background",
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 6, dedupeKey: "$.characterId" },
    nodes: [{ id: "analyze", type: "agent" }],
  };
  assert.equal(resolveInstanceKey(workflow, { characterId: "alice" }), "character-analysis:alice");
  assert.equal(resolveInstanceKey(workflow, { characterId: "bob" }), "character-analysis:bob");
});

test("rejects narrative nodes in background workflows", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 1,
    id: "bad",
    kind: "global-background",
    nodes: [{ id: "story", type: "narrative" }],
  }), /cannot contain narrative/);
});
