import assert from "node:assert/strict";
import test from "node:test";

import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";

const flow = {
  schemaVersion: 3,
  id: "parallel",
  kind: "foreground",
  nodes: [
    { id: "a", type: "agent" },
    { id: "b", type: "agent" },
    { id: "story", type: "agent", dependsOn: ["a", "b"], outputs: { narrative: { path: "narrative.md", format: "narrative" } } },
    { id: "done", type: "turn-finalize", dependsOn: ["story"], narrative: { fromNode: "story", output: "narrative" } },
  ],
};

test("runs parallel roots before narrative and finalization", async () => {
  const order = [];
  const records = [];
  const engine = new RpWorkflowEngine({
    executor: async ({ node }) => {
      order.push(`start:${node.id}`);
      await new Promise(resolve => setTimeout(resolve, node.id === "a" ? 8 : 2));
      order.push(`end:${node.id}`);
      return { output: node.id, processRecord: { received: { content: "private-input" }, sent: { content: "private-output" } } };
    },
    onNodeComplete: async ({ node, result }) => {
      records.push([node.id, result.output]);
      return { available: true, path: `process-records/run/${node.id}.md` };
    },
  });
  const started = await engine.start(flow, { id: "run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(["start:a", "start:b"]));
  assert.ok(order.indexOf("start:story") > order.indexOf("end:a"));
  assert.equal(completed.nodes.story.processRecord.available, true);
  assert.deepEqual(new Set(records.map(([nodeId]) => nodeId)), new Set(["a", "b", "story", "done"]));
  assert.doesNotMatch(JSON.stringify(completed), /private-(?:input|output)/);
});

test("an explicitly idempotent start returns the active run for the same instance key", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const workflow = { schemaVersion: 3, id: "idempotent", kind: "global-background", instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.operationId" }, nodes: [{ id: "task", type: "code" }] };
  const engine = new RpWorkflowEngine({ executor: async () => { await gate; return { output: "done" }; } });
  const first = await engine.start(workflow, { id: "first", payload: { operationId: "stable" } });
  const replay = await engine.start(workflow, { id: "second", payload: { operationId: "stable" }, reuseActive: true });
  assert.equal(replay.id, first.id);
  release();
  assert.equal((await engine.wait(first.id)).status, "completed");
});

test("stops for an explicit model choice after exhausted attempts", async () => {
  const engine = new RpWorkflowEngine({ executor: async () => { throw new Error("offline"); } });
  const started = await engine.start(flow, { id: "failed" });
  const failed = await engine.wait(started.id);
  assert.equal(failed.status, "awaiting-model-choice");
  assert.equal(failed.nodes.a.attempts.length, 3);
});

test("allows a user-selected model retry after automatic attempts are exhausted", async () => {
  let calls = 0;
  const workflow = { schemaVersion: 3, id: "retryable", kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
  const engine = new RpWorkflowEngine({ executor: async () => { calls += 1; if (calls <= 3) throw new Error("offline"); return { output: "ok" }; } });
  const started = await engine.start(workflow, { id: "retry-run" });
  await engine.wait(started.id);
  await engine.retry(started.id, "task", "pi:current");
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.nodes.task.attempts.length, 4);
});

test("runs node output registration and data commits before marking the node complete", async () => {
  const order = [];
  const workflow = { schemaVersion: 3, id: "commit-order", kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
  const engine = new RpWorkflowEngine({
    executor: async () => { order.push("execute"); return { output: "draft" }; },
    beforeNodeComplete: async ({ result }) => { order.push("commit"); return result; },
    onNodeComplete: async () => { order.push("complete"); return null; },
  });
  const started = await engine.start(workflow, { id: "commit-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(order, ["execute", "commit", "complete"]);
});

test("a failed node-end commit fails the node instead of releasing downstream work", async () => {
  const workflow = { schemaVersion: 3, id: "commit-failure", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 1 } }, { id: "after", type: "code", dependsOn: ["task"] }] };
  const engine = new RpWorkflowEngine({
    executor: async () => ({ output: "draft" }),
    beforeNodeComplete: async () => { throw new Error("data commit failed"); },
  });
  const started = await engine.start(workflow, { id: "commit-failure-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "awaiting-model-choice");
  assert.equal(completed.nodes.after.status, "pending");
});

test("reports only unfinished opted-in turn-background nodes as turn blockers", async () => {
  let releaseBlocking;
  let releaseNonblocking;
  const blockingWait = new Promise(resolve => { releaseBlocking = resolve; });
  const nonblockingWait = new Promise(resolve => { releaseNonblocking = resolve; });
  const workflow = {
    schemaVersion: 3,
    id: "turn-archive",
    title: "Turn archive",
    kind: "turn-background",
    trigger: { type: "manual", blockNextTurnUntilReady: true },
    nodes: [
      { id: "archive", title: "Archive", type: "code" },
      { id: "cleanup", title: "Cleanup", type: "code", dependsOn: ["archive"] },
    ],
  };
  const engine = new RpWorkflowEngine({
    executor: async ({ node }) => {
      if (node.id === "archive") await blockingWait;
      else await nonblockingWait;
      return { output: node.id };
    },
  });
  const started = await engine.start(workflow, { id: "blocking-run", turn: 7 });
  assert.equal(engine.hasBlockingTurnRun(), true);
  assert.deepEqual(engine.blockingTurnRuns(), [{
    runId: started.id,
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    turn: 7,
    status: "running",
    nodes: [
      { id: "archive", title: "Archive", status: "pending" },
      { id: "cleanup", title: "Cleanup", status: "pending" },
    ],
  }]);
  releaseBlocking();
  while (engine.snapshot()[0].nodes.archive.status !== "completed") await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.hasBlockingTurnRun(), true);
  assert.equal(engine.snapshot()[0].status, "running");
  releaseNonblocking();
  assert.equal((await engine.wait(started.id)).status, "completed");
});

test("keeps a failed blocking workflow locked for model choice and releases it on cancellation", async () => {
  const workflow = { schemaVersion: 3, id: "blocking-failure", kind: "turn-background", trigger: { type: "manual", blockNextTurnUntilReady: true }, nodes: [{ id: "archive", type: "agent", retry: { maxAttempts: 1 } }] };
  const engine = new RpWorkflowEngine({ executor: async () => { throw new Error("offline"); } });
  const started = await engine.start(workflow, { id: "blocking-failure-run" });
  const awaiting = await engine.wait(started.id);
  assert.equal(awaiting.status, "awaiting-model-choice");
  assert.equal(engine.hasBlockingTurnRun(), true);
  await engine.cancel(started.id, "cancelled_by_user");
  assert.equal(engine.hasBlockingTurnRun(), false);
});

test("records an explicit skip and releases the next turn without reporting success", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const workflow = { schemaVersion: 3, id: "skippable-archive", kind: "turn-background", trigger: { type: "manual", blockNextTurnUntilReady: true }, nodes: [{ id: "archive", type: "code" }] };
  const engine = new RpWorkflowEngine({ executor: async () => { await waiting; return { output: "late" }; } });
  const started = await engine.start(workflow, { id: "skippable-run" });
  const skipped = await engine.skip(started.id);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.error, "skipped_by_user");
  assert.equal(skipped.nodes.archive.status, "skipped");
  assert.equal(engine.hasBlockingTurnRun(), false);
  release();
});

test("aggregates multiple blocking workflow instances until every one is released", async () => {
  const waits = new Map();
  const executor = ({ workflow }) => new Promise(resolve => waits.set(workflow.id, resolve));
  const engine = new RpWorkflowEngine({ executor });
  const first = await engine.start({ schemaVersion: 3, id: "archive-a", kind: "turn-background", trigger: { type: "manual", blockNextTurnUntilReady: true }, nodes: [{ id: "task", type: "code" }] }, { id: "run-a" });
  const second = await engine.start({ schemaVersion: 3, id: "archive-b", kind: "turn-background", trigger: { type: "manual", blockNextTurnUntilReady: true }, nodes: [{ id: "task", type: "code" }] }, { id: "run-b" });
  assert.deepEqual(new Set(engine.blockingTurnRuns().map(item => item.runId)), new Set([first.id, second.id]));
  await engine.cancel(first.id);
  assert.deepEqual(engine.blockingTurnRuns().map(item => item.runId), [second.id]);
  await engine.skip(second.id);
  assert.equal(engine.hasBlockingTurnRun(), false);
  for (const resolve of waits.values()) resolve({ output: "late" });
});

test("restores an interrupted blocking node as a visible blocker", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const workflow = { schemaVersion: 3, id: "restored-archive", title: "Restored archive", kind: "turn-background", trigger: { type: "manual", blockNextTurnUntilReady: true }, nodes: [{ id: "archive", type: "code" }] };
  const first = new RpWorkflowEngine({ executor: async () => { await waiting; return { output: "done" }; } });
  const started = await first.start(workflow, { id: "restore-run", turn: 4 });
  while (first.snapshot()[0].nodes.archive.status !== "running") await new Promise(resolve => setImmediate(resolve));
  const saved = first.snapshot()[0];
  assert.equal(saved.instanceKey, "top-level/restored-archive");
  const restored = new RpWorkflowEngine({ executor: async () => ({ output: "unused" }) });
  const restoredRun = await restored.restore(workflow, saved);
  assert.equal(restoredRun.status, "awaiting-model-choice");
  assert.equal(restored.hasBlockingTurnRun(), true);
  assert.equal(restored.blockingTurnRuns()[0].nodes[0].status, "awaiting-model-choice");
  await assert.rejects(restored.restore(workflow, saved), /already active/);
  await restored.cancel(restoredRun.id);
  release();
});

test("a call node waits for a module workflow while releasing its scheduler slot", async () => {
  const child = {
    schemaVersion: 3,
    id: "lookup",
    ownerModuleId: "lore",
    kind: "module-external",
    interface: { inputs: {}, exports: { document: { format: "markdown" } } },
    nodes: [
      { id: "build", type: "code", outputs: { document: { path: "lookup.md", format: "markdown" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { document: { fromNode: "build", output: "document" } } },
    ],
  };
  const parent = {
    schemaVersion: 3,
    id: "caller",
    kind: "turn-background",
    nodes: [{ id: "lookup", type: "call", target: "lore/lookup", outputPaths: { document: "lore.md" } }],
  };
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 1 },
    resolveWorkflow: reference => reference === "lore/lookup" ? child : null,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, outputPaths: task.node.outputPaths }) };
      if (task.node.type === "workflow-return") return { output: { outputs: { document: "lookup.md" } } };
      return { output: "built" };
    },
  });
  const started = await engine.start(parent, { id: "parent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.ok(completed.nodes.lookup.output, JSON.stringify(engine.snapshot(), null, 2));
  assert.equal(completed.nodes.lookup.output.workflow, "lore/lookup");
  assert.deepEqual(completed.nodes.lookup.output.outputs, { document: "lookup.md" });
  const childRun = engine.snapshot().find(run => run.callContext?.parentRunId === started.id);
  assert.equal(childRun.status, "completed");
});

test("top-level and module workflows with the same id have independent instance limits", async () => {
  const child = {
    schemaVersion: 3,
    id: "agent-image-generation",
    ownerModuleId: "comfy-image-generation",
    kind: "module-external",
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  };
  const parent = {
    schemaVersion: 3,
    id: "agent-image-generation",
    kind: "turn-background",
    nodes: [{ id: "generate", type: "call", target: "comfy-image-generation/agent-image-generation", outputPaths: {} }],
  };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: reference => reference === "comfy-image-generation/agent-image-generation" ? child : null,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, outputPaths: {} }) };
      return { output: { outputs: {} } };
    },
  });
  const started = await engine.start(parent, { id: "same-id-parent" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  const childRun = engine.snapshot().find(run => run.callContext?.parentRunId === started.id);
  assert.equal(childRun.instanceKey.startsWith("comfy-image-generation/agent-image-generation:"), true);
});

test("supports bounded multi-level calls through module-external workflows", async () => {
  const leaf = {
    schemaVersion: 3,
    id: "snapshot",
    ownerModuleId: "state",
    kind: "module-external",
    interface: { inputs: {}, exports: { document: { format: "markdown" } } },
    nodes: [
      { id: "build", type: "code", outputs: { document: { path: "state.md", format: "markdown" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { document: { fromNode: "build", output: "document" } } },
    ],
  };
  const middle = {
    schemaVersion: 3,
    id: "resolve",
    ownerModuleId: "combat",
    kind: "module-external",
    interface: { inputs: {}, exports: { report: { format: "markdown" } } },
    nodes: [
      { id: "query-state", type: "code", workflowCalls: ["state/snapshot"] },
      { id: "build", type: "code", dependsOn: ["query-state"], outputs: { report: { path: "report.md", format: "markdown" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { report: { fromNode: "build", output: "report" } } },
    ],
  };
  const parent = {
    schemaVersion: 3,
    id: "turn",
    kind: "turn-background",
    nodes: [{ id: "combat", type: "call", target: "combat/resolve", outputPaths: { report: "combat.md" } }],
  };
  const workflows = new Map([["combat/resolve", middle], ["state/snapshot", leaf]]);
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 1 },
    resolveWorkflow: reference => workflows.get(reference) || null,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, outputPaths: task.node.outputPaths }) };
      if (task.workflow.id === "resolve" && task.node.id === "query-state") {
        const result = await task.invokeWorkflow({ workflow: "state/snapshot", outputPaths: { document: "state.md" } });
        assert.deepEqual(result.outputs, { document: "state.md" });
        return { output: result.outputs };
      }
      if (task.node.type === "workflow-return") {
        return { output: { outputs: task.workflow.id === "snapshot" ? { document: "state.md" } : { report: "combat.md" } } };
      }
      return { output: "built" };
    },
  });
  const trigger = { type: "after-workflow", workflowId: "standard-rp" };
  const started = await engine.start(parent, { id: "multi-level-parent", trigger });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.nodes.combat.output.outputs, { report: "combat.md" });
  const leafRun = engine.snapshot().find(run => run.workflowId === "snapshot");
  const middleRun = engine.snapshot().find(run => run.workflowId === "resolve");
  assert.equal(leafRun.callContext.depth, 2);
  assert.deepEqual(leafRun.callContext.stack, ["top-level/turn", "combat/resolve", "state/snapshot"]);
  assert.deepEqual(middleRun.trigger, trigger);
  assert.deepEqual(leafRun.trigger, trigger);
});

test("serializes module-internal workflows per owning module", async () => {
  const update = {
    schemaVersion: 3,
    id: "update",
    ownerModuleId: "state",
    kind: "module-internal",
    interface: { inputs: {}, exports: {} },
    nodes: [
      { id: "mutate", type: "code" },
      { id: "return", type: "workflow-return", dependsOn: ["mutate"], exports: {} },
    ],
  };
  const parent = id => ({
    schemaVersion: 3,
    id,
    kind: "turn-background",
    nodes: [{ id: "update", type: "call", target: "state/update", outputPaths: {} }],
  });
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 4 },
    resolveWorkflow: reference => reference === "state/update" ? update : null,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, outputPaths: {} }) };
      if (task.node.id === "mutate") {
        activeMutations += 1;
        maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
        await new Promise(resolve => setTimeout(resolve, 8));
        activeMutations -= 1;
      }
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      return { output: "updated" };
    },
  });
  const [left, right] = await Promise.all([
    engine.start(parent("left"), { id: "left-parent" }),
    engine.start(parent("right"), { id: "right-parent" }),
  ]);
  const [leftResult, rightResult] = await Promise.all([engine.wait(left.id), engine.wait(right.id)]);
  assert.equal(leftResult.status, "completed");
  assert.equal(rightResult.status, "completed");
  assert.equal(maximumActiveMutations, 1);
  assert.equal(engine.snapshot().filter(run => run.workflowId === "update").length, 2);
});

test("persists recovery-required nodes and resumes the same run after restart", async () => {
  const workflow = {
    schemaVersion: 3,
    id: "recoverable-operation",
    kind: "global-background",
    nodes: [{ id: "external", type: "code" }],
  };
  const firstEngine = new RpWorkflowEngine({
    executor: async () => ({ output: { executionStatus: "recovery-required", recoveryRequired: true, error: "remote outcome unknown", promptId: "prompt-1" } }),
  });
  const started = await firstEngine.start(workflow, { id: "recover-run", payload: { operationId: "operation-1" } });
  const awaiting = await firstEngine.wait(started.id);
  assert.equal(awaiting.status, "awaiting-recovery");
  assert.equal(awaiting.nodes.external.status, "awaiting-recovery");
  assert.equal(awaiting.nodes.external.output.promptId, "prompt-1");

  let recoveries = 0;
  const restoredEngine = new RpWorkflowEngine({ executor: async () => { recoveries += 1; return { output: { executionStatus: "completed", promptId: "prompt-1" } }; } });
  const restored = await restoredEngine.restore(workflow, awaiting);
  assert.equal(restored.status, "awaiting-recovery");
  await restoredEngine.recover(restored.id, "external");
  const completed = await restoredEngine.wait(restored.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, started.id);
  assert.equal(completed.error, null);
  assert.equal(recoveries, 1);
});

test("parent recovery reuses the recovered child workflow instead of starting the side effect again", async () => {
  const child = {
    schemaVersion: 3,
    id: "remote-child",
    ownerModuleId: "remote",
    kind: "module-internal",
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "submit", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["submit"], exports: {} }],
  };
  const parent = { schemaVersion: 3, id: "remote-parent", kind: "global-background", nodes: [{ id: "call", type: "call", target: "remote/remote-child", outputPaths: {} }] };
  let childAttempts = 0;
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: {}, outputPaths: {} }) };
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      childAttempts += 1;
      return childAttempts === 1
        ? { output: { executionStatus: "recovery-required", recoveryRequired: true, promptId: "remote-1" } }
        : { output: { executionStatus: "completed", promptId: "remote-1" } };
    },
  });
  const started = await engine.start(parent, { id: "remote-parent-run" });
  const awaiting = await engine.wait(started.id);
  assert.equal(awaiting.status, "awaiting-recovery");
  await engine.recover(started.id);
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(childAttempts, 2);
  assert.equal(engine.snapshot().filter(run => run.workflowId === "remote-child").length, 1);
});

test("allows parallel module-internal workflows on distinct declared collections", async () => {
  const child = (id, collectionId) => ({
    schemaVersion: 3,
    id,
    ownerModuleId: "director",
    kind: "module-internal",
    writeLocks: [{ moduleId: "director", collectionId }],
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "mutate", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["mutate"], exports: {} }],
  });
  const privateFlow = child("private-update", "private-state");
  const deepFlow = child("deep-update", "deep-workbench");
  const parent = (id, target) => ({ schemaVersion: 3, id, kind: "turn-background", nodes: [{ id: "call", type: "call", target, outputPaths: {} }] });
  let active = 0;
  let maximum = 0;
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 4 },
    resolveWorkflow: reference => reference.endsWith("private-update") ? privateFlow : deepFlow,
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, outputPaths: {} }) };
      if (task.node.id === "mutate") {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 8));
        active -= 1;
      }
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      return { output: "done" };
    },
  });
  const left = await engine.start(parent("private-parent", "director/private-update"), { id: "private-parent" });
  const right = await engine.start(parent("deep-parent", "director/deep-update"), { id: "deep-parent" });
  const results = await Promise.all([engine.wait(left.id), engine.wait(right.id)]);
  assert.deepEqual(results.map(result => result.status), ["completed", "completed"]);
  assert.equal(maximum, 2);
});

test("an Agent call requires both exact node exposure and agentCallable", async () => {
  const child = {
    schemaVersion: 3,
    id: "lookup",
    ownerModuleId: "lore",
    kind: "module-external",
    agentCallable: false,
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  };
  const parent = {
    schemaVersion: 3,
    id: "agent-caller",
    kind: "turn-background",
    nodes: [{ id: "writer", type: "agent", workflowCalls: ["lore/lookup"], retry: { maxAttempts: 1 } }],
  };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: () => child,
    executor: task => task.invokeWorkflow({ workflow: "lore/lookup" }, { agent: true }),
  });
  const started = await engine.start(parent, { id: "agent-parent" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "awaiting-model-choice");
  assert.match(completed.nodes.writer.error, /not callable by Agents/);
});
