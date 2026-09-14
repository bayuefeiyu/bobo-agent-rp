import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDocumentWorkspaceAgentTools,
  assertWorkflowCallAllowed,
  canonicalWorkflowRef,
  completeWorkflowNode,
  createWorkflowRun,
  failWorkflowNode,
  normalizeWorkflowCallRequest,
  normalizeWorkflowDefinition,
  workflowCallAuthorization,
  prepareWorkflowNodeRetry,
  readyWorkflowNodes,
  resolveCodeNodeRoute,
  resolveInstanceKey,
  resolveNodeQueryBudget,
  startWorkflowNode,
  workflowRuntimeIdentity,
} from "./rp-workflows.mjs";

test("document-workspace agents require read and explicit input declarations", () => {
  const definition = {
    schemaVersion: 3,
    id: "document-task",
    ownerModuleId: "docs",
    kind: "module-internal",
    interface: { inputs: { source: { type: "document", kind: "directory" } }, exports: {} },
    nodes: [
      { id: "work", type: "agent", agentId: "reader", metadata: { documentWorkspace: true, callInputs: ["source"] } },
      { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} },
    ],
  };
  const workflow = normalizeWorkflowDefinition(definition);
  assert.doesNotThrow(() => assertDocumentWorkspaceAgentTools(workflow.nodes[0], { id: "reader", tools: ["read"] }));
  assert.throws(() => assertDocumentWorkspaceAgentTools(workflow.nodes[0], { id: "reader", tools: [] }), /must enable the read tool/);
  assert.throws(() => normalizeWorkflowDefinition({
    ...definition,
    nodes: definition.nodes.map(node => node.id === "work" ? { ...node, metadata: { documentWorkspace: true, callInputs: ["missing"] } } : node),
  }), /undeclared document input missing/);
});

test("supports after-opening triggers and caller-selected query budgets", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "opening-bootstrap",
    kind: "turn-background",
    trigger: { type: "after-opening", blockNextTurnUntilReady: true },
    writeLocks: [{ moduleId: "director", collectionId: "private-state" }],
    nodes: [{
      id: "prepare",
      type: "code",
      moduleAccess: [{ moduleId: "director", collectionId: "private-state", capabilities: [], views: [], queryBudget: { maxRecords: 200, maxCharacters: 500000, defaultRecords: 35, defaultCharacters: 200000, parameter: "budget" } }],
    }],
  });
  assert.equal(workflow.trigger.type, "after-opening");
  assert.deepEqual(workflow.writeLocks, [{ moduleId: "director", collectionId: "private-state" }]);
  assert.deepEqual(resolveNodeQueryBudget(workflow.nodes[0].moduleAccess[0], { budget: { maxRecords: 120, maxCharacters: 300000 } }), { maxRecords: 120, maxCharacters: 300000 });
  assert.deepEqual(resolveNodeQueryBudget(workflow.nodes[0].moduleAccess[0], {}), { maxRecords: 35, maxCharacters: 200000 });
});

test("rejects an explicit empty lock list on module-internal workflows", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "unsafe-internal",
    ownerModuleId: "director",
    kind: "module-internal",
    writeLocks: [],
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  }), /must keep the default whole-module lock/);
});

test("allows keyed module-internal instances only with exact collection locks", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "render",
    ownerModuleId: "images",
    kind: "module-internal",
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.operationId" },
    writeLocks: [{ moduleId: "images", collectionId: "renders" }],
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  });
  assert.equal(workflow.instancePolicy.mode, "multiple");
  assert.equal(workflow.instancePolicy.maxConcurrentInstances, 2);
  assert.throws(() => resolveInstanceKey(workflow, {}), /did not resolve to a stable value/);

  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "unsafe-render",
    ownerModuleId: "images",
    kind: "module-internal",
    instancePolicy: { mode: "multiple", dedupeKey: "$.operationId" },
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  }), /must declare exact collection write locks/);
});

const foreground = {
  schemaVersion: 3,
  id: "standard-rp",
  kind: "foreground",
  nodes: [
    { id: "world", type: "agent" },
    { id: "character", type: "agent" },
    { id: "narrative", type: "agent", dependsOn: ["world", "character"], join: { mode: "all" }, outputs: { story: { path: "story.md", format: "narrative" } }, narrativeSource: { layer: "story" } },
    { id: "finalize", type: "turn-finalize", dependsOn: ["narrative"], narrative: { fromNode: "narrative", output: "story" } },
  ],
};

test("normalizes a foreground DAG and exposes parallel roots", () => {
  const workflow = normalizeWorkflowDefinition(foreground);
  const run = createWorkflowRun(workflow, { id: "run-1", turn: 1 });
  assert.deepEqual(readyWorkflowNodes(workflow, run).map(node => node.id), ["world", "character"]);
});

test("authorizes declared runtime services only on code nodes", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "random-code",
    kind: "turn-background",
    nodes: [{ id: "judge", type: "code", runtimeServices: ["random"] }],
  });
  assert.deepEqual(workflow.nodes[0].runtimeServices, ["random"]);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "random-agent",
    kind: "turn-background",
    nodes: [{ id: "judge", type: "agent", runtimeServices: ["random"] }],
  }), /only for code nodes/);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "unknown-service",
    kind: "turn-background",
    nodes: [{ id: "judge", type: "code", runtimeServices: ["fortune"] }],
  }), /unsupported services/);
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
  assert.deepEqual(run.nodes.narrative.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  assert.deepEqual(readyWorkflowNodes(foreground, run).map(node => node.id), ["finalize"]);
  startWorkflowNode(foreground, run, "finalize", { modelId: "pi:current" });
  completeWorkflowNode(foreground, run, "finalize");
  assert.equal(run.status, "completed");
});

test("stores successful node token usage on the node and attempt", () => {
  const run = createWorkflowRun(foreground, { id: "run-usage", turn: 1 });
  startWorkflowNode(foreground, run, "world", { modelId: "fast" });
  completeWorkflowNode(foreground, run, "world", {
    output: "analysis",
    usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 5, totalTokens: 235 },
  });
  assert.deepEqual(run.nodes.world.usage, { input: 120, output: 30, cacheRead: 80, cacheWrite: 5, totalTokens: 235 });
  assert.deepEqual(run.nodes.world.attempts[0].usage, run.nodes.world.usage);
});

test("sums every recorded attempt when the workflow finishes", () => {
  const workflow = {
    schemaVersion: 3,
    id: "usage-total",
    kind: "turn-background",
    nodes: [
      { id: "analyze", type: "agent" },
      { id: "publish", type: "code", dependsOn: ["analyze"] },
    ],
  };
  const run = createWorkflowRun(workflow, { id: "run-total", turn: 2 });
  startWorkflowNode(workflow, run, "analyze", { modelId: "writer" });
  failWorkflowNode(workflow, run, "analyze", new Error("invalid structured output"), {
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
  });
  prepareWorkflowNodeRetry(run, "analyze");
  startWorkflowNode(workflow, run, "analyze", { modelId: "writer" });
  completeWorkflowNode(workflow, run, "analyze", { usage: { input: 100, output: 25, cacheRead: 50, cacheWrite: 5, totalTokens: 180 } });
  startWorkflowNode(workflow, run, "publish", { modelId: "pi:current" });
  completeWorkflowNode(workflow, run, "publish");
  assert.equal(run.status, "completed");
  assert.deepEqual(run.usage, { input: 110, output: 35, cacheRead: 50, cacheWrite: 5, totalTokens: 200 });
  assert.equal(run.usageComplete, true);
  assert.deepEqual(run.usageAttempts, { recorded: 3, unrecorded: 0 });
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
    schemaVersion: 3,
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

test("normalizes a code-node output field used as its route", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "code-branching",
    kind: "turn-background",
    nodes: [
      { id: "prepare", type: "code", routeFromOutput: "route" },
      { id: "work", type: "agent", dependsOn: ["prepare"], conditions: [{ nodeId: "prepare", routes: ["run"] }] },
    ],
  });
  assert.equal(workflow.nodes[0].routeFromOutput, "route");
  assert.equal(resolveCodeNodeRoute(workflow.nodes[0], { route: "run" }), "run");
  assert.equal(resolveCodeNodeRoute(workflow.nodes[0], {}), null);
  assert.throws(() => resolveCodeNodeRoute(workflow.nodes[0], { route: "not a safe route" }), /invalid workflow route/);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "bad-code-route",
    kind: "turn-background",
    nodes: [{ id: "prepare", type: "code", routeFromOutput: "not a safe field" }],
  }), /routeFromOutput/);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "agent-code-route",
    kind: "turn-background",
    nodes: [{ id: "prepare", type: "agent", routeFromOutput: "route" }],
  }), /only for code nodes/);
});

test("turn-background trigger blocking is opt-in and rejected for other workflow kinds", () => {
  const ordinary = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "ordinary-background",
    kind: "turn-background",
    nodes: [{ id: "task", type: "code" }],
  });
  const blocking = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "blocking-background",
    kind: "turn-background",
    trigger: { type: "manual", blockNextTurnUntilReady: true },
    nodes: [{ id: "task", type: "code" }],
  });
  assert.equal(ordinary.trigger.blockNextTurnUntilReady, false);
  assert.equal(blocking.trigger.blockNextTurnUntilReady, true);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "global-background",
    kind: "global-background",
    trigger: { type: "manual", blockNextTurnUntilReady: true },
    nodes: [{ id: "task", type: "code" }],
  }), /only for turn-background trigger bindings/);
});

test("uses keyed multi-instance identities for independent characters", () => {
  const workflow = {
    schemaVersion: 3,
    id: "character-analysis",
    kind: "global-background",
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 6, dedupeKey: "$.characterId" },
    nodes: [{ id: "analyze", type: "agent" }],
  };
  assert.equal(workflowRuntimeIdentity(workflow), "top-level/character-analysis");
  assert.equal(resolveInstanceKey(workflow, { characterId: "alice" }), "top-level/character-analysis:alice");
  assert.equal(resolveInstanceKey(workflow, { characterId: "bob" }), "top-level/character-analysis:bob");
});

test("rejects the removed narrative node type", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "bad",
    kind: "global-background",
    nodes: [{ id: "story", type: "narrative" }],
  }), /Unsupported workflow node type/);
});

test("workflow authors statically declare narrative authority while legacy nodes stay conservative", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "directed-story",
    kind: "foreground",
    defaults: { agentId: "writer" },
    nodes: [
      { id: "director", type: "agent", narrativeSource: { layer: "authorial" } },
      { id: "story", type: "agent", dependsOn: ["director"], outputs: { narrative: { path: "narrative.md", format: "narrative" } }, narrativeSource: { layer: "story" } },
      { id: "legacy-code", type: "code", dependsOn: ["story"] },
      { id: "finalize", type: "turn-finalize", dependsOn: ["legacy-code"], narrative: { fromNode: "story", output: "narrative" } },
    ],
  });
  const run = createWorkflowRun(workflow, {
    id: "run-sources",
    sourceReferences: [{ kind: "message", id: "m-1", revision: 2, narrativeSource: { producerKind: "user", layer: "in-world" } }],
  });
  assert.equal(run.nodes.director.narrativeSource.layer, "authorial");
  assert.equal(run.nodes.director.narrativeSource.producerKind, "agent");
  assert.equal(run.nodes.story.narrativeSource.layer, "story");
  assert.equal(run.nodes["legacy-code"].narrativeSource.layer, "unspecified");
  assert.equal(run.sourceReferences[0].revision, 2);
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "forged-author",
    kind: "turn-background",
    nodes: [{ id: "worker", type: "agent", narrativeSource: { layer: "authorial", producerKind: "agent" } }],
  }), /only layer and characterId/);
});

test("normalizes node outputs, scoped module access, and explicit node-end commits", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "data-update",
    kind: "turn-background",
    nodes: [{
      id: "update",
      type: "agent",
      outputs: { changes: { path: "drafts/changes.json", scope: "workflow", retain: "run", format: "unified-change-batch" } },
      moduleAccess: [{ moduleId: "rumors", collectionId: "entries", capabilities: ["rumor.query", "rumor.write"], views: ["rp"], queryBudget: { maxRecords: 50, maxCharacters: 12000 } }],
      dataCommit: { allowBestEffort: true, onNodeEnd: [{ output: "changes", required: true }] },
    }],
  });
  const node = workflow.nodes[0];
  assert.equal(node.outputs.changes.scope, "workflow");
  assert.equal(node.dataCommit.allowBestEffort, true);
  assert.deepEqual(node.dataCommit.onNodeEnd, [{ output: "changes", path: null, required: true }]);
  assert.equal(node.moduleAccess[0].queryBudget.maxRecords, 50);
});

test("normalizes explicit file and directory workspace handoffs", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "handoff",
    kind: "turn-background",
    nodes: [{
      id: "prepare",
      type: "code",
      outputs: {
        plan: { path: "plan.md", format: "markdown", scope: "workflow", retain: "run" },
        materials: { path: "materials", kind: "directory", scope: "workflow", retain: "run" },
        context: { path: "context", format: "document-set", scope: "workflow", retain: "run" },
      },
      workspaceHandoff: { include: [
        { output: "plan", as: "approved-plan.md" },
        { output: "materials" },
      ] },
    }],
  });
  const node = workflow.nodes[0];
  assert.equal(node.outputs.plan.kind, "file");
  assert.equal(node.outputs.materials.kind, "directory");
  assert.equal(node.outputs.context.kind, "directory");
  assert.deepEqual(node.workspaceHandoff.include, [
    { output: "plan", as: "approved-plan.md" },
    { output: "materials" },
  ]);
});

test("rejects implicit, missing, short-lived, and overlapping workspace handoffs", () => {
  const base = {
    schemaVersion: 3,
    id: "bad-handoff",
    kind: "turn-background",
  };
  assert.throws(() => normalizeWorkflowDefinition({
    ...base,
    nodes: [{ id: "prepare", type: "code", outputs: {}, workspaceHandoff: { include: [{ output: "missing", as: "missing" }] } }],
  }), /unknown output/);
  assert.throws(() => normalizeWorkflowDefinition({
    ...base,
    nodes: [{ id: "prepare", type: "code", outputs: { draft: { path: "draft.md" } }, workspaceHandoff: { include: [{ output: "draft", as: "draft.md" }] } }],
  }), /must survive/);
  assert.throws(() => normalizeWorkflowDefinition({
    ...base,
    nodes: [{ id: "prepare", type: "code", outputs: {
      one: { path: "one", scope: "workflow" },
      two: { path: "two", scope: "workflow" },
    }, workspaceHandoff: { include: [{ output: "one", as: "bundle" }, { output: "two", as: "bundle/two" }] } }],
  }), /must not overlap/);
  assert.throws(() => normalizeWorkflowDefinition({
    ...base,
    nodes: [{ id: "prepare", type: "code", outputs: {
      bundle: { path: "bundle", kind: "directory", scope: "workflow" },
      item: { path: "bundle/item.md", scope: "workflow" },
    }, workspaceHandoff: { include: [{ output: "bundle" }, { output: "item" }] } }],
  }), /must not overlap/);
  assert.throws(() => normalizeWorkflowDefinition({
    ...base,
    nodes: [{ id: "prepare", type: "code", outputs: { folder: { path: "folder", format: "document-set", kind: "file" } } }],
  }), /document-set must use directory/);
});

test("rejects node-end commit targets that are not explicitly declared", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "bad-output",
    kind: "turn-background",
    nodes: [{ id: "update", type: "agent", dataCommit: { onNodeEnd: [{ output: "missing" }] } }],
  }), /unknown output/);
});

test("normalizes module workflows with explicit interfaces and a standard return", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "retrieve-context",
    ownerModuleId: "memory",
    kind: "module-external",
    agentCallable: true,
    interface: {
      inputs: { request: { type: "text", required: true } },
      exports: { context: { format: "markdown" } },
    },
    nodes: [
      { id: "compose", type: "agent", outputs: { context: { path: "context.md", format: "markdown" } } },
      { id: "return", type: "workflow-return", dependsOn: ["compose"], exports: { context: { fromNode: "compose", output: "context" } } },
    ],
  });
  assert.equal(canonicalWorkflowRef(workflow), "memory/retrieve-context");
  assert.equal(workflow.agentCallable, true);
  assert.equal(workflow.trigger, null);
  assert.equal(workflow.instancePolicy.mode, "multiple");
});

test("module workflow interfaces preserve ordinary directory exports", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "export-folder",
    ownerModuleId: "resources",
    kind: "module-external",
    interface: { exports: { bundle: { format: "resource-folder", kind: "directory" } } },
    nodes: [
      { id: "build", type: "code", outputs: { bundle: { path: "bundle", format: "resource-folder", kind: "directory" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { bundle: { fromNode: "build", output: "bundle" } } },
    ],
  });
  assert.equal(workflow.interface.exports.bundle.kind, "directory");
  assert.equal(workflow.nodes[0].outputs.bundle.kind, "directory");
});

test("module document inputs declare whether they accept files or directories", () => {
  const workflow = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "consume-folder",
    ownerModuleId: "resources",
    kind: "module-external",
    interface: {
      inputs: {
        request: { type: "document", formats: ["markdown"] },
        bundle: { type: "document", kind: "directory", formats: ["document-set"] },
      },
      exports: {},
    },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  });
  assert.equal(workflow.interface.inputs.request.kind, "file");
  assert.equal(workflow.interface.inputs.bundle.kind, "directory");
  assert.throws(() => normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "bad-input-kind",
    ownerModuleId: "resources",
    kind: "module-external",
    interface: { inputs: { text: { type: "text", kind: "file" } }, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  }), /Only document inputs/);
});

test("enforces node call lists, Agent exposure, and module call layering", () => {
  const external = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "query",
    ownerModuleId: "lore",
    kind: "module-external",
    agentCallable: true,
    interface: { exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  });
  const internal = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "update",
    ownerModuleId: "state",
    kind: "module-internal",
    agentCallable: false,
    interface: { exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  });
  const top = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "top",
    kind: "turn-background",
    nodes: [{ id: "worker", type: "agent", workflowCalls: ["lore/query"] }],
  });
  assert.equal(assertWorkflowCallAllowed(top, top.nodes[0], external, { agent: true }), "lore/query");
  assert.throws(() => assertWorkflowCallAllowed(top, top.nodes[0], internal, { agent: true }), /not callable by Agents/);
  const moduleCaller = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "compose",
    ownerModuleId: "combat",
    kind: "module-external",
    interface: { exports: {} },
    nodes: [{ id: "worker", type: "code", workflowCalls: ["state/update"] }, { id: "return", type: "workflow-return", dependsOn: ["worker"], exports: {} }],
  });
  assert.throws(() => assertWorkflowCallAllowed(moduleCaller, moduleCaller.nodes[0], internal), /only module-external/);
});

test("validates module call inputs and exact caller-selected export paths", () => {
  const target = {
    schemaVersion: 3,
    id: "lookup",
    ownerModuleId: "lore",
    kind: "module-external",
    interface: {
      inputs: { request: { type: "text", required: true } },
      exports: { context: { format: "markdown" } },
    },
    nodes: [
      { id: "build", type: "code", outputs: { context: { path: "context.md", format: "markdown" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { context: { fromNode: "build", output: "context" } } },
    ],
  };
  assert.deepEqual(normalizeWorkflowCallRequest(target, { text: "scene", outputPaths: { context: "lore/context.md" } }), {
    text: "scene",
    arguments: {},
    documents: {},
    outputPaths: { context: "lore/context.md" },
  });
  assert.throws(() => normalizeWorkflowCallRequest(target, { outputPaths: { context: "context.md" } }), /requires text input/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { text: "scene", outputPaths: {} }), /exactly match exports/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { text: "scene", outputPaths: { context: "..\/context.md" } }), /safe relative path/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { text: "scene", arguments: { extra: true }, outputPaths: { context: "context.md" } }), /undeclared parameter inputs/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { text: "scene", documents: { extra: "extra.md" }, outputPaths: { context: "context.md" } }), /undeclared document inputs/);
});

test("validates declared workflow parameter value types", () => {
  const target = {
    schemaVersion: 3,
    id: "typed",
    ownerModuleId: "lore",
    kind: "module-external",
    interface: { inputs: {
      count: { type: "parameter", valueType: "integer", required: true },
      options: { type: "parameter", valueType: "object" },
    }, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  };
  assert.equal(normalizeWorkflowCallRequest(target, { arguments: { count: 2, options: {} }, outputPaths: {} }).arguments.count, 2);
  assert.throws(() => normalizeWorkflowCallRequest(target, { arguments: { count: 2.5 }, outputPaths: {} }), /must be integer/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { arguments: { count: 2, options: [] }, outputPaths: {} }), /must be object/);
});

test("applies fixed and allowed argument policy to dynamic workflow calls", () => {
  const target = {
    schemaVersion: 3,
    id: "export-context",
    ownerModuleId: "card-context-library",
    kind: "module-external",
    interface: {
      inputs: { categories: { type: "parameter", required: true, valueType: "string-array" } },
      exports: { context: { format: "document-set" } },
    },
    nodes: [
      { id: "export", type: "code", outputs: { context: { path: "context", format: "document-set" } } },
      { id: "return", type: "workflow-return", dependsOn: ["export"], exports: { context: { fromNode: "export", output: "context" } } },
    ],
  };
  const caller = normalizeWorkflowDefinition({
    ...foreground,
    nodes: foreground.nodes.map(node => node.id === "narrative" ? {
      ...node,
      workflowCalls: [{ target: "card-context-library/export-context", allowedArguments: { categories: ["world", "rule"] } }],
    } : node),
  });
  const authorization = workflowCallAuthorization(caller.nodes.find(node => node.id === "narrative"), "card-context-library/export-context");
  assert.deepEqual(normalizeWorkflowCallRequest(target, { arguments: { categories: ["world", "rule"] }, outputPaths: { context: "context" } }, authorization).arguments, { categories: ["world", "rule"] });
  assert.throws(() => normalizeWorkflowCallRequest(target, { arguments: { categories: ["style"] }, outputPaths: { context: "context" } }, authorization), /exceeds/);
  assert.throws(() => normalizeWorkflowCallRequest(target, { arguments: { categories: ["world"] }, outputPaths: { context: "context" } }, {
    target: "card-context-library/export-context",
    fixedArguments: { undeclared: true },
    allowedArguments: null,
  }), /unknown parameter inputs/);
});

test("authorizes one bounded automatic document snapshot input", () => {
  const target = {
    schemaVersion: 3,
    id: "pre-review",
    ownerModuleId: "director",
    kind: "module-internal",
    agentCallable: true,
    interface: { inputs: { context: { type: "document", required: true, kind: "directory", formats: ["document-workspace-snapshot"] } }, exports: {} },
    nodes: [{ id: "work", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  const caller = normalizeWorkflowDefinition({
    schemaVersion: 3,
    id: "foreground",
    kind: "turn-background",
    nodes: [{ id: "write", type: "agent", workflowCalls: [{ target: "director/pre-review", documentSnapshotInput: "context", maxCalls: 1 }] }],
  });
  assert.equal(caller.nodes[0].workflowCalls[0].documentSnapshotInput, "context");
  assert.equal(caller.nodes[0].workflowCalls[0].maxCalls, 1);
  assert.equal(assertWorkflowCallAllowed(caller, caller.nodes[0], target, { agent: true }), "director/pre-review");
});
