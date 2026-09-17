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

/**
 * A provider failure: the executor already dispatched the model call before it broke, which is
 * what makes the failure the model's rather than the runtime's.
 */
function modelFailure(message = "offline") {
  return async task => {
    task.markModelDispatched?.();
    throw new Error(message);
  };
}

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

test("a team node schedules independently configured member Agents without holding an outer model slot", async () => {
  const seen = [];
  const workflow = {
    schemaVersion: 3,
    id: "team-runtime",
    kind: "global-background",
    nodes: [{
      id: "meeting",
      type: "team",
      team: {
        schemaVersion: 1,
        leader: { id: "leader", agentId: "leader-agent", modelId: "strong" },
        secretary: { id: "secretary", agentId: "secretary-agent", modelId: "fast" },
        experts: [], assistants: [],
      },
    }],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, modelId: id === "leader-agent" ? "strong" : "fast", tools: [] }),
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    executor: async task => {
      if (task.node.type === "team") {
        const leader = await task.invokeAgent({ executionId: "leader-step", agentId: "leader-agent", modelId: "strong", role: "leader", prompt: "analyze" });
        const secretary = await task.invokeAgent({ executionId: "secretary-step", agentId: "secretary-agent", modelId: "fast", role: "secretary", prompt: "record" });
        return { output: [leader.output, secretary.output] };
      }
      seen.push([task.node.metadata.teamRole, task.agent.id, task.binding.modelId]);
      return { output: task.agent.id };
    },
  });
  const started = await engine.start(workflow, { id: "team-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(seen, [["leader", "leader-agent", "strong"], ["secretary", "secretary-agent", "fast"]]);
});

test("team preflight freezes member prompts before the first member call", async () => {
  let promptVersion = "original member prompt";
  let executedPrompt = null;
  const workflow = {
    schemaVersion: 3,
    id: "team-frozen-agent",
    kind: "global-background",
    nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader-agent" }, secretary: { id: "secretary", agentId: "secretary-agent" }, experts: [], assistants: [] } }],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, prompt: promptVersion, modelId: "pi:current", tools: [] }),
    executor: async task => {
      if (task.node.type === "team") {
        promptVersion = "changed after meeting preflight";
        await task.invokeAgent({ executionId: "leader-call", memberId: "leader", freezeKey: "member:leader", agentId: "leader-agent", role: "leader", prompt: "phase prompt" });
      } else executedPrompt = task.agent.prompt;
      return { output: {} };
    },
  });
  const started = await engine.start(workflow, { id: "team-frozen-agent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(executedPrompt, "original member prompt");
  assert.equal(completed.teamPreflights.meeting.bindings["member:leader"].agentSnapshot.prompt, "original member prompt");
  assert.equal(completed.nodes.meeting.status, "completed");
});

test("team preflight freezes effective model parameters before the first member call", async () => {
  let providerModel = "original-provider-model";
  let usedModel = null;
  const workflow = {
    schemaVersion: 3,
    id: "team-frozen-model",
    kind: "global-background",
    nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader-agent", modelId: "profile" }, secretary: { id: "secretary", agentId: "secretary-agent", modelId: "profile" }, experts: [], assistants: [] } }],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, tools: [] }),
    resolveModel: async id => ({ id, provider: "test", model: providerModel, apiKey: "must-not-persist", maxConcurrency: 2 }),
    executor: async task => {
      if (task.node.type === "team") {
        providerModel = "edited-during-meeting";
        await task.invokeAgent({ executionId: "leader-call", memberId: "leader", freezeKey: "member:leader", agentId: "leader-agent", modelId: "profile", role: "leader", prompt: "phase" });
      } else usedModel = task.model.model;
      return { output: {} };
    },
  });
  const started = await engine.start(workflow, { id: "team-frozen-model-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(usedModel, "original-provider-model");
  assert.equal(completed.teamPreflights.meeting.bindings["member:leader"].modelSnapshot.model, "original-provider-model");
  assert.equal("apiKey" in completed.teamPreflights.meeting.bindings["member:leader"].modelSnapshot, false);
});

test("team preflight rejects a workflow ability whose adapted request violates the target contract", async () => {
  let teamExecuted = false;
  const workflow = {
    schemaVersion: 3,
    id: "team-workflow-ability-preflight",
    kind: "global-background",
    nodes: [{
      id: "meeting",
      type: "team",
      team: {
        schemaVersion: 1,
        leader: { id: "leader", agentId: "leader-agent" },
        secretary: { id: "secretary", agentId: "secretary-agent" },
        experts: [],
        assistants: [],
        baseRetrieval: {
          id: "memory",
          kind: "workflow",
          target: "memory/retrieve",
          inputAdapter: "memory-request-v1",
          fixedArguments: { undeclared: true },
          exports: ["memory-context"],
          publicDescription: { title: "Memory" },
        },
      },
      workflowCalls: ["memory/retrieve"],
    }],
  };
  const target = {
    schemaVersion: 3,
    id: "retrieve",
    ownerModuleId: "memory",
    kind: "module-external",
    interface: {
      inputs: {
        request: { type: "text", required: true },
        budget: { type: "parameter", required: false, valueType: "object" },
      },
      exports: { "memory-context": { format: "document-set" } },
    },
    nodes: [
      { id: "build", type: "code", outputs: { "memory-context": { path: "memory-context", format: "document-set" } } },
      { id: "return", type: "workflow-return", dependsOn: ["build"], exports: { "memory-context": { fromNode: "build", output: "memory-context" } } },
    ],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, tools: [] }),
    resolveWorkflow: async reference => reference === "memory/retrieve" ? target : null,
    executor: async () => { teamExecuted = true; return { output: {} }; },
  });
  const started = await engine.start(workflow, { id: "team-workflow-ability-preflight-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "failed");
  assert.equal(teamExecuted, false);
  assert.match(completed.nodes.meeting.error, /undeclared parameter inputs: undeclared/);
});

test("team retry model override applies only to the selected failed member", async () => {
  const seenModels = [];
  const workflow = {
    schemaVersion: 3,
    id: "team-member-retry-model",
    kind: "global-background",
    nodes: [{ id: "meeting", type: "team", retry: { maxAttempts: 1 }, team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader-agent", modelId: "old-model" }, secretary: { id: "secretary", agentId: "secretary-agent", modelId: "old-model" }, experts: [], assistants: [] } }],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, tools: [] }),
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    executor: async task => {
      if (task.node.type === "team") {
        await task.invokeAgent({ executionId: "leader-call", memberId: "leader", freezeKey: "member:leader", agentId: "leader-agent", modelId: "old-model", role: "leader", prompt: "phase" });
        return { output: {} };
      }
      seenModels.push(task.binding.modelId);
      task.markModelDispatched?.();
      if (task.binding.modelId === "old-model") throw new Error("model failed");
      return { output: "recovered" };
    },
  });
  const started = await engine.start(workflow, { id: "team-member-retry-model-run" });
  const failed = await engine.wait(started.id);
  assert.equal(failed.status, "awaiting-model-choice");
  await engine.retry(started.id, "meeting", "replacement-model", { memberId: "member:leader" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(seenModels, ["old-model", "replacement-model"]);
  assert.equal(completed.teamPreflights.meeting.bindings["member:secretary"].resolvedModelId, "old-model");
});

test("a cancelled team rejects a late member result before publication", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let cancellationCode = null;
  const workflow = {
    schemaVersion: 3,
    id: "team-cancel",
    kind: "global-background",
    nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader-agent" }, secretary: { id: "secretary", agentId: "secretary-agent" }, experts: [], assistants: [] } }],
  };
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, modelId: "pi:current", tools: [] }),
    executor: async task => {
      if (task.node.type === "team") {
        try { await task.invokeAgent({ executionId: "late", agentId: "leader-agent", role: "leader", prompt: "wait" }); }
        catch (error) { cancellationCode = error.code; }
        return { output: "ignored" };
      }
      await gate;
      return { output: "late result" };
    },
  });
  const started = await engine.start(workflow, { id: "team-cancel-run" });
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await engine.cancel(started.id, "stop");
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancellationCode, "workflow_cancelled");
});

test("a team does not reacquire an outer scheduler slot after a workflow assistant returns", async () => {
  let slotsAfterChild = null;
  const child = { schemaVersion: 3, id: "lookup", ownerModuleId: "demo", kind: "module-external", interface: { inputs: {}, exports: {} }, nodes: [{ id: "return", type: "workflow-return", exports: {} }] };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    resolveAgent: async id => ({ id, modelId: "pi:current", tools: [] }),
    executor: async task => {
      if (task.node.type === "team") {
        await task.invokeWorkflow({ workflow: "demo/lookup", outputPaths: {} }, { parallel: true });
        slotsAfterChild = engine.running;
      }
      return { output: {} };
    },
  });
  const workflow = { schemaVersion: 3, id: "team-slot", kind: "global-background", nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader" }, secretary: { id: "secretary", agentId: "secretary" }, experts: [], assistants: [] }, workflowCalls: ["demo/lookup"] }] };
  const run = await engine.start(workflow, { id: "team-slot-run" });
  await engine.wait(run.id);
  assert.equal(slotsAfterChild, 0);
});

test("a cancelled team cannot dispatch a workflow assistant after its gate reopens", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  let childStarted = false;
  let cancellationCode = null;
  const child = { schemaVersion: 3, id: "lookup", ownerModuleId: "demo", kind: "module-external", interface: { inputs: {}, exports: {} }, nodes: [{ id: "return", type: "workflow-return", exports: {} }] };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    resolveAgent: async id => ({ id, modelId: "pi:current", tools: [] }),
    executor: async task => {
      if (task.node.type === "team") {
        entered();
        await gate;
        try { await task.invokeWorkflow({ workflow: "demo/lookup", outputPaths: {} }, { parallel: true }); }
        catch (error) { cancellationCode = error.code; }
        finished();
      } else childStarted = true;
      return { output: {} };
    },
  });
  const workflow = { schemaVersion: 3, id: "team-cancel-child", kind: "global-background", nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: "leader" }, secretary: { id: "secretary", agentId: "secretary" }, experts: [], assistants: [] }, workflowCalls: ["demo/lookup"] }] };
  const run = await engine.start(workflow, { id: "team-cancel-child-run" });
  await ready;
  await engine.cancel(run.id, "user-stop");
  release();
  await done;
  assert.equal(cancellationCode, "workflow_cancelled");
  assert.equal(childStarted, false);
});

test("global-background work can make progress when maxConcurrency is one", async () => {
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 1 },
    executor: async () => ({ output: "done" }),
  });
  const workflow = { schemaVersion: 3, id: "single-slot-background", kind: "global-background", nodes: [{ id: "work", type: "agent" }] };
  const started = await engine.start(workflow, { id: "single-slot-background-run" });
  const completed = await Promise.race([
    engine.wait(started.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("background scheduler deadlocked")), 250)),
  ]);
  assert.equal(completed.status, "completed");
});

test("child workflows inherit the root scheduling class", async () => {
  const child = {
    schemaVersion: 3,
    id: "scheduled-child",
    ownerModuleId: "demo",
    kind: "module-external",
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "work", type: "agent" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    executor: async task => task.node.type === "call"
      ? task.invokeWorkflow({ workflow: task.node.target, outputPaths: {} })
      : ({ output: {} }),
  });
  const parent = { schemaVersion: 3, id: "scheduled-parent", kind: "global-background", nodes: [{ id: "call", type: "call", target: "demo/scheduled-child" }] };
  const run = await engine.start(parent, { id: "scheduled-parent-run" });
  const completed = await engine.wait(run.id);
  assert.equal(completed.status, "completed");
  const childRun = [...engine.runs.values()].find(entry => entry.workflow.id === "scheduled-child")?.run;
  assert.equal(childRun?.effectiveSchedulingKind, "global-background");
});

test("a scheduler waiter observes cancellation before dispatch", async () => {
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const dispatched = [];
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 1 },
    executor: async ({ run }) => {
      dispatched.push(run.id);
      if (run.id === "scheduler-holder") await gate;
      return { output: "done" };
    },
  });
  const workflow = { schemaVersion: 3, id: "scheduler-cancel", kind: "global-background", instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.request" }, nodes: [{ id: "work", type: "agent" }] };
  const first = await engine.start(workflow, { id: "scheduler-holder", payload: { request: "first" } });
  await new Promise(resolve => setImmediate(resolve));
  const second = await engine.start(workflow, { id: "scheduler-waiter", payload: { request: "second" } });
  await new Promise(resolve => setImmediate(resolve));
  await engine.cancel(second.id, "cancel queued work");
  releaseFirst();
  await engine.wait(first.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dispatched, ["scheduler-holder"]);
});

test("foreground-class work takes the next slot ahead of queued background work at concurrency one", async () => {
  let releaseHolder;
  const gate = new Promise(resolve => { releaseHolder = resolve; });
  const order = [];
  const engine = new RpWorkflowEngine({
    policy: { maxConcurrency: 1 },
    executor: async ({ run }) => {
      order.push(run.id);
      if (run.id === "priority-holder") await gate;
      return { output: "done" };
    },
  });
  const background = id => ({ schemaVersion: 3, id, kind: "global-background", nodes: [{ id: "work", type: "agent" }] });
  const foregroundClass = { schemaVersion: 3, id: "priority-turn", kind: "turn-background", nodes: [{ id: "work", type: "agent" }] };
  const holder = await engine.start(background("priority-holder-flow"), { id: "priority-holder" });
  await new Promise(resolve => setImmediate(resolve));
  const queuedBackground = await engine.start(background("priority-background-flow"), { id: "priority-background" });
  const queuedForeground = await engine.start(foregroundClass, { id: "priority-foreground" });
  await new Promise(resolve => setImmediate(resolve));
  releaseHolder();
  await Promise.all([engine.wait(holder.id), engine.wait(queuedBackground.id), engine.wait(queuedForeground.id)]);
  assert.deepEqual(order, ["priority-holder", "priority-foreground", "priority-background"]);
});

test("terminal lifecycle finalization runs once for completion and cancellation", async () => {
  const finalized = [];
  const completedEngine = new RpWorkflowEngine({ executor: async () => ({ output: "ok" }), onRunTerminal: async ({ run }) => { finalized.push([run.id, run.status]); } });
  const completeFlow = { schemaVersion: 3, id: "finalize-complete", kind: "turn-background", nodes: [{ id: "task", type: "code" }] };
  const completeRun = await completedEngine.start(completeFlow, { id: "complete" });
  const complete = await completedEngine.wait(completeRun.id);
  assert.equal(complete.terminalFinalization.status, "completed");

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cancelEngine = new RpWorkflowEngine({ executor: async () => { await gate; return { output: "late" }; }, onRunTerminal: async ({ run }) => { finalized.push([run.id, run.status]); } });
  const cancelRun = await cancelEngine.start({ schemaVersion: 3, id: "finalize-cancel", kind: "global-background", nodes: [{ id: "task", type: "code" }] }, { id: "cancel" });
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await cancelEngine.cancel(cancelRun.id, "stop");
  release();
  assert.equal(cancelled.terminalFinalization.status, "completed");
  assert.deepEqual(finalized, [["complete", "completed"], ["cancel", "cancelled"]]);
});

test("a failed terminal finalization is retried after restoring the terminal run", async () => {
  const workflow = { schemaVersion: 3, id: "restore-finalization", kind: "global-background", nodes: [{ id: "task", type: "code" }] };
  const firstEngine = new RpWorkflowEngine({ executor: async () => ({ output: "ok" }), onRunTerminal: async () => { throw new Error("temporary finalizer failure"); } });
  const started = await firstEngine.start(workflow, { id: "restore-finalization-run" });
  const failedFinalization = await firstEngine.wait(started.id);
  assert.equal(failedFinalization.status, "completed");
  assert.equal(failedFinalization.terminalFinalization.status, "failed");

  let retries = 0;
  const restoredEngine = new RpWorkflowEngine({ executor: async () => { throw new Error("completed node must not rerun"); }, onRunTerminal: async () => { retries += 1; } });
  await restoredEngine.restore(workflow, failedFinalization);
  const restored = await restoredEngine.wait(started.id);
  assert.equal(restored.terminalFinalization.status, "completed");
  assert.equal(retries, 1);
});

test("a module terminal finalizer invokes one same-module internal workflow", async () => {
  const calls = [];
  const finalizer = {
    schemaVersion: 3,
    id: "release-operation",
    ownerModuleId: "demo",
    kind: "module-internal",
    interface: {
      inputs: {
        operationId: { type: "parameter", required: true, valueType: "string" },
        terminalStatus: { type: "parameter", required: true, valueType: "string" },
        terminalError: { type: "parameter", required: false, valueType: "string" },
      },
      exports: {},
    },
    writeLocks: [{ moduleId: "demo", collectionId: "state" }],
    nodes: [
      { id: "release", type: "code", metadata: { argumentInputs: ["operationId", "terminalStatus", "terminalError"] } },
      { id: "return", type: "workflow-return", dependsOn: ["release"], exports: {} },
    ],
  };
  const workflow = {
    schemaVersion: 3,
    id: "team-operation",
    ownerModuleId: "demo",
    kind: "module-external",
    interface: { inputs: { operationId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    terminalFinalizer: { target: "demo/release-operation", statuses: ["failed"], forwardArguments: ["operationId"] },
    nodes: [{ id: "work", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  const wrapper = {
    schemaVersion: 3,
    id: "team-operation-wrapper",
    kind: "global-background",
    nodes: [{ id: "call", type: "call", target: "demo/team-operation", arguments: { operationId: "operation-7" }, documents: {}, outputPaths: {} }],
  };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async reference => reference === "demo/release-operation" ? finalizer : reference === "demo/team-operation" ? workflow : null,
    executor: async ({ workflow: active, node, run, invokeWorkflow }) => {
      if (active.id === "team-operation-wrapper") return invokeWorkflow({ workflow: node.target, arguments: node.arguments, outputPaths: {} });
      if (active.id === "team-operation") return { output: { executionStatus: "failed", error: "meeting failed" } };
      if (node.id === "release") calls.push(structuredClone(run.arguments));
      return { output: {} };
    },
  });
  const started = await engine.start(wrapper, { id: "team-operation-wrapper-run" });
  const failedWrapper = await engine.wait(started.id);
  assert.equal(failedWrapper.status, "failed");
  const failed = engine.snapshot().find(run => run.workflowId === "team-operation");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.terminalFinalization.status, "completed", failed?.terminalFinalization.error);
  assert.equal(failed?.terminalFinalization.workflow, "demo/release-operation");
  assert.deepEqual(calls, [{ operationId: "operation-7", terminalStatus: "failed", terminalError: "meeting failed" }]);
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
  const engine = new RpWorkflowEngine({ executor: modelFailure() });
  const started = await engine.start(flow, { id: "failed" });
  const failed = await engine.wait(started.id);
  assert.equal(failed.status, "awaiting-model-choice");
  assert.equal(failed.nodes.a.attempts.length, 3);
});

test("allows a user-selected model retry after automatic attempts are exhausted", async () => {
  let calls = 0;
  const workflow = { schemaVersion: 3, id: "retryable", kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
  const engine = new RpWorkflowEngine({
    executor: async task => {
      calls += 1;
      task.markModelDispatched?.();
      if (calls <= 3) throw new Error("offline");
      return { output: "ok" };
    },
  });
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
    // The model answered; the node-end data commit is what failed afterwards.
    executor: async task => { task.markModelDispatched?.(); return { output: "draft" }; },
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
  const engine = new RpWorkflowEngine({ executor: modelFailure() });
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
  const started = await first.start(workflow, { id: "restore-run", turn: 4, dataReadViewId: "persisted-view", dataReadBatchIds: ["persisted-batch"] });
  while (first.snapshot()[0].nodes.archive.status !== "running") await new Promise(resolve => setImmediate(resolve));
  const saved = first.snapshot()[0];
  assert.equal(saved.instanceKey, "top-level/restored-archive");
  const restored = new RpWorkflowEngine({ executor: async () => ({ output: "unused" }) });
  const restoredRun = await restored.restore(workflow, saved);
  assert.equal(restoredRun.status, "awaiting-model-choice");
  assert.equal(restoredRun.dataReadViewId, "persisted-view");
  assert.deepEqual(restoredRun.dataReadBatchIds, ["persisted-batch"]);
  assert.equal(restored.hasBlockingTurnRun(), true);
  assert.equal(restored.blockingTurnRuns()[0].nodes[0].status, "awaiting-model-choice");
  await assert.rejects(restored.restore(workflow, saved), /already active/);
  await restored.cancel(restoredRun.id);
  release();
});

test("a parent waits on the exact child model choice and resumes the original call after retry", async () => {
  const child = {
    schemaVersion: 3,
    id: "model-choice-child",
    ownerModuleId: "demo",
    kind: "module-external",
    interface: { inputs: { requestId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    defaults: { modelId: "old-model" },
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.requestId" },
    nodes: [
      { id: "work", type: "agent", retry: { maxAttempts: 1 } },
      { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} },
    ],
  };
  const parent = {
    schemaVersion: 3,
    id: "model-choice-parent",
    kind: "global-background",
    writeLocks: [{ moduleId: "demo", collectionId: "state" }],
    nodes: [{ id: "call", type: "call", target: "demo/model-choice-child", arguments: { requestId: "request-1" }, outputPaths: {} }],
  };
  const competitor = {
    schemaVersion: 3,
    id: "model-choice-competitor",
    kind: "global-background",
    writeLocks: [{ moduleId: "demo", collectionId: "state" }],
    nodes: [{ id: "work", type: "code" }],
  };
  const models = [];
  let parentExecutions = 0;
  let competitorExecutions = 0;
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    executor: async task => {
      if (task.workflow.id === parent.id) {
        parentExecutions += 1;
        return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: task.node.arguments, outputPaths: {} }) };
      }
      if (task.workflow.id === competitor.id) {
        competitorExecutions += 1;
        return { output: {} };
      }
      if (task.node.id === "work") {
        models.push(task.binding.modelId);
        task.markModelDispatched?.();
        if (task.binding.modelId === "old-model") throw new Error("provider offline");
      }
      return { output: task.node.type === "workflow-return" ? { outputs: {} } : {} };
    },
  });
  const started = await engine.start(parent, { id: "model-choice-parent-run" });
  const waiting = await engine.wait(started.id);
  assert.equal(waiting.status, "awaiting-child");
  assert.equal(waiting.nodes.call.status, "awaiting-child");
  assert.equal(waiting.nodes.call.waitingOn.status, "awaiting-model-choice");
  const childRun = engine.snapshot().find(run => run.callContext?.parentRunId === started.id);
  assert.equal(childRun.status, "awaiting-model-choice");
  assert.equal(waiting.nodes.call.waitingOn.childRunId, childRun.id);

  const competing = await engine.start(competitor, { id: "model-choice-competitor-run" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(competitorExecutions, 0);
  assert.equal(engine.snapshot().find(run => run.id === competing.id).nodes.work.status, "pending");

  await engine.retry(childRun.id, "work", "replacement-model");
  while (engine.snapshot().find(run => run.id === started.id).status === "awaiting-child") await new Promise(resolve => setImmediate(resolve));
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal((await engine.wait(competing.id)).status, "completed");
  assert.equal(competitorExecutions, 1);
  assert.equal(engine.snapshot().filter(run => run.workflowId === child.id).length, 1);
  assert.equal(parentExecutions, 2);
  assert.deepEqual(models, ["old-model", "replacement-model"]);
});

test("restored child-wait metadata reconnects the parent after a targeted child retry", async () => {
  const child = {
    schemaVersion: 3,
    id: "restored-model-choice-child",
    ownerModuleId: "demo",
    kind: "module-external",
    interface: { inputs: { requestId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    defaults: { modelId: "old-model" },
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.requestId" },
    nodes: [
      { id: "work", type: "agent", retry: { maxAttempts: 1 } },
      { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} },
    ],
  };
  const parent = { schemaVersion: 3, id: "restored-model-choice-parent", kind: "global-background", nodes: [{ id: "call", type: "call", target: "demo/restored-model-choice-child", arguments: { requestId: "request-1" }, outputPaths: {} }] };
  const makeEngine = () => new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    executor: async task => {
      if (task.workflow.id === parent.id) return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: task.node.arguments, outputPaths: {} }) };
      if (task.node.id === "work" && task.binding.modelId === "old-model") {
        task.markModelDispatched?.();
        throw new Error("provider offline");
      }
      return { output: task.node.type === "workflow-return" ? { outputs: {} } : {} };
    },
  });
  const first = makeEngine();
  const started = await first.start(parent, { id: "restored-model-choice-parent-run" });
  const waiting = await first.wait(started.id);
  const savedChild = first.snapshot().find(run => run.callContext?.parentRunId === started.id);
  assert.equal(waiting.status, "awaiting-child");

  const restored = makeEngine();
  await restored.restore(parent, waiting);
  await restored.restore(child, savedChild);
  await restored.retry(savedChild.id, "work", "replacement-model");
  while (restored.snapshot().find(run => run.id === started.id).status === "awaiting-child") await new Promise(resolve => setImmediate(resolve));
  const completed = await restored.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.nodes.call.attempts.length, 2);
  assert.equal(restored.snapshot().filter(run => run.workflowId === child.id).length, 1);
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

test("completed child data batches become visible only to later causal child calls", async () => {
  let readerBatches = null;
  const parent = {
    schemaVersion: 3,
    id: "causal-parent",
    kind: "global-background",
    nodes: [
      { id: "write", type: "code", workflowCalls: ["state/write"] },
      { id: "read", type: "code", dependsOn: ["write"], workflowCalls: ["state/read"] },
    ],
  };
  const child = id => ({
    schemaVersion: 3,
    id,
    ownerModuleId: "state",
    kind: "module-external",
    interface: { inputs: {}, exports: {} },
    nodes: [
      { id: "work", type: "code" },
      { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} },
    ],
  });
  const workflows = new Map([["state/write", child("write")], ["state/read", child("read")]]);
  const engine = new RpWorkflowEngine({
    onRunStart: async ({ run }) => run.callContext ? null : { dataReadViewId: "root-view", dataReadBatchIds: [] },
    resolveWorkflow: async reference => workflows.get(reference),
    executor: async task => {
      if (task.workflow.id === "causal-parent") {
        await task.invokeWorkflow({ workflow: task.node.id === "write" ? "state/write" : "state/read" });
      } else if (task.node.id === "work" && task.workflow.id === "write") {
        task.run.nodes[task.node.id].dataReadBatchIds.push("batch-from-writer");
        task.run.dataReadBatchIds.push("batch-from-writer");
      } else if (task.node.id === "work" && task.workflow.id === "read") {
        readerBatches = [...task.run.dataReadBatchIds];
      }
      return { output: task.node.type === "workflow-return" ? { outputs: {} } : {} };
    },
  });
  const started = await engine.start(parent, { id: "causal-parent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(readerBatches, ["batch-from-writer"]);
  assert.deepEqual(completed.dataReadBatchIds, ["batch-from-writer"]);
});

test("parallel sibling calls keep independent read views until their explicit join", async () => {
  let releaseWriter;
  const readerStarted = new Promise(resolve => { releaseWriter = resolve; });
  let parallelReaderBatches = null;
  let joinedReaderBatches = null;
  const parent = {
    schemaVersion: 3,
    id: "parallel-causal-parent",
    kind: "global-background",
    nodes: [
      { id: "writer", type: "code", workflowCalls: ["state/write"] },
      { id: "parallel-reader", type: "code", workflowCalls: ["state/read"] },
      { id: "joined-reader", type: "code", dependsOn: ["writer", "parallel-reader"], workflowCalls: ["state/inspect"] },
    ],
  };
  const child = id => ({
    schemaVersion: 3,
    id,
    ownerModuleId: "state",
    kind: "module-external",
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "work", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  });
  const workflows = new Map([["state/write", child("write")], ["state/read", child("read")], ["state/inspect", child("inspect")]]);
  const targets = { writer: "state/write", "parallel-reader": "state/read", "joined-reader": "state/inspect" };
  const engine = new RpWorkflowEngine({
    onRunStart: async ({ run }) => run.callContext ? null : { dataReadViewId: "root-view", dataReadBatchIds: [] },
    resolveWorkflow: async reference => workflows.get(reference),
    executor: async task => {
      if (task.workflow.id === "parallel-causal-parent") await task.invokeWorkflow({ workflow: targets[task.node.id] });
      else if (task.node.id === "work" && task.workflow.id === "write") {
        await readerStarted;
        task.run.nodes[task.node.id].dataReadBatchIds.push("parallel-writer-batch");
        task.run.dataReadBatchIds.push("parallel-writer-batch");
      } else if (task.node.id === "work" && task.workflow.id === "read") {
        parallelReaderBatches = [...task.run.dataReadBatchIds];
        releaseWriter();
      } else if (task.node.id === "work" && task.workflow.id === "inspect") joinedReaderBatches = [...task.run.dataReadBatchIds];
      return { output: task.node.type === "workflow-return" ? { outputs: {} } : {} };
    },
  });
  const started = await engine.start(parent, { id: "parallel-causal-parent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(parallelReaderBatches, []);
  assert.deepEqual(joinedReaderBatches, ["parallel-writer-batch"]);
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

test("a state-dependent child can disable completed-call reuse", async () => {
  const child = {
    schemaVersion: 3,
    id: "lease-check",
    ownerModuleId: "lease",
    kind: "module-internal",
    interface: { inputs: { operationId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.operationId", reuseCompleted: false },
    writeLocks: [{ moduleId: "lease", collectionId: "state" }],
    nodes: [{ id: "acquire", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["acquire"], exports: {} }],
  };
  const parent = {
    schemaVersion: 3,
    id: "lease-parent",
    kind: "global-background",
    nodes: [{ id: "call-twice", type: "code", workflowCalls: ["lease/lease-check"] }],
  };
  let acquisitions = 0;
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    executor: async task => {
      if (task.workflow.id === "lease-parent") {
        const request = { workflow: "lease/lease-check", arguments: { operationId: "operation-1" }, outputPaths: {} };
        await task.invokeWorkflow(request);
        await task.invokeWorkflow(request);
        return { output: "done" };
      }
      if (task.node.id === "acquire") acquisitions += 1;
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      return { output: "done" };
    },
  });
  const started = await engine.start(parent, { id: "lease-parent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(acquisitions, 2);
  assert.equal(engine.snapshot().filter(run => run.workflowId === "lease-check").length, 2);
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
  // The call is refused before the Agent ever asks a model, so no model swap can help.
  assert.equal(completed.status, "failed");
  assert.equal(completed.nodes.writer.failureKind, "deterministic");
  assert.match(completed.nodes.writer.error, /not callable by Agents/);
});

test("classifies a non-model node failure as deterministic instead of a model failure", async () => {
  // A code node never calls a model, so offering "retry with another model" would be useless.
  const workflow = { schemaVersion: 3, id: "code-failure", kind: "turn-background", nodes: [{ id: "task", type: "code", retry: { maxAttempts: 1 } }] };
  const engine = new RpWorkflowEngine({ executor: async () => { throw new Error("script exploded"); } });
  const started = await engine.start(workflow, { id: "code-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.status, "failed");
  assert.equal(settled.nodes.task.status, "failed");
  assert.equal(settled.nodes.task.failureKind, "deterministic");
});

test("classifies an Agent failure before any model call as deterministic", async () => {
  // Staging inputs, resolving an Agent profile, or reading a handoff can fail before the model is
  // asked anything. Swapping models cannot fix any of those.
  const workflow = { schemaVersion: 3, id: "agent-staging-failure", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 1 } }] };
  const engine = new RpWorkflowEngine({ executor: async () => { throw new Error("handoff artifact is missing"); } });
  const started = await engine.start(workflow, { id: "agent-staging-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.status, "failed");
  assert.equal(settled.nodes.task.failureKind, "deterministic");
});

test("keeps a genuine model failure replaceable by another model", async () => {
  // The executor reports the dispatch, so the failure is the model's and another model may help.
  const workflow = { schemaVersion: 3, id: "model-failure", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 1 } }] };
  const engine = new RpWorkflowEngine({ executor: async task => { task.markModelDispatched?.(); throw new Error("provider is offline"); } });
  const started = await engine.start(workflow, { id: "model-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.status, "awaiting-model-choice");
  assert.equal(settled.nodes.task.failureKind, "model");
});

test("re-arms the model dispatch flag for every retry attempt", async () => {
  // Attempt one fails after its model call, the retry fails while staging. The retry verdict must
  // come from its own attempt, not from the attempt that already reached a model.
  const workflow = { schemaVersion: 3, id: "retry-staging-failure", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 2 } }] };
  let attempt = 0;
  const engine = new RpWorkflowEngine({
    executor: async task => {
      attempt += 1;
      if (attempt === 1) {
        task.markModelDispatched?.();
        throw new Error("provider is offline");
      }
      throw new Error("handoff artifact is missing");
    },
  });
  const started = await engine.start(workflow, { id: "retry-staging-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.nodes.task.attempts.length, 2);
  assert.equal(settled.nodes.task.status, "failed");
  // Had the first attempt's dispatch leaked into the second, this verdict would be a model failure.
  assert.equal(settled.nodes.task.failureKind, "deterministic");
});

test("treats a coded configuration failure on an agent node as deterministic", async () => {
  // The agent node would call a workflow this engine cannot resolve, which is decided by the
  // runtime before any model call: a model swap cannot fix it.
  const child = { schemaVersion: 3, id: "missing", ownerModuleId: "demo", kind: "module-external", agentCallable: true, interface: { inputs: {}, exports: {} }, nodes: [{ id: "return", type: "workflow-return", exports: {} }] };
  const workflow = { schemaVersion: 3, id: "agent-config-failure", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 1 }, workflowCalls: ["demo/missing"] }] };
  const engine = new RpWorkflowEngine({
    resolveWorkflow: reference => (reference === "demo/missing" ? undefined : child),
    executor: task => task.invokeWorkflow({ workflow: "demo/missing" }, { agent: true }),
  });
  const started = await engine.start(workflow, { id: "agent-config-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.nodes.task.status, "failed");
  assert.equal(settled.nodes.task.failureKind, "deterministic");
  assert.match(settled.nodes.task.error, /Unknown module workflow/);
});

test("a node-end commit refused by the card's own declarations is deterministic", { timeout: 5000 }, async () => {
  // Each of these names something the card or module must change — declared access, declared
  // actions, the node's commit policy, or a missing processor. Nothing about them is the model's,
  // and no retry can alter them, so the panel must not offer a model swap or silently retry.
  for (const code of ["permission_denied", "action_not_allowed", "best_effort_not_allowed", "missing_handler", "invalid_processor_result"]) {
    const workflow = { schemaVersion: 3, id: `commit-${code}`, kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
    const engine = new RpWorkflowEngine({
      executor: async task => { task.markModelDispatched?.(); return { output: "batch" }; },
      beforeNodeComplete: async () => { throw Object.assign(new Error(`commit refused: ${code}`), { code }); },
    });
    const started = await engine.start(workflow, { id: `commit-${code}-run` });
    const settled = await engine.wait(started.id);
    assert.equal(settled.nodes.task.status, "failed", code);
    assert.equal(settled.nodes.task.failureKind, "deterministic", code);
    assert.equal(settled.nodes.task.attempts.length, 1, code);
  }
});

test("a node-end commit refused by state or by the model's own data stays on the model path", { timeout: 5000 }, async () => {
  // Regeneration is the cheapest remedy for these: an agent retry re-reads state and re-renders the
  // batch, so the automatic attempts must survive. `data_schema_invalid` belongs here on purpose —
  // the offending data is the model's output.
  for (const code of ["revision_conflict", "expected_revision_required", "duplicate_record", "data_schema_invalid", "commit_failed"]) {
    const workflow = { schemaVersion: 3, id: `commit-${code}`, kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 2 } }] };
    const engine = new RpWorkflowEngine({
      executor: async task => { task.markModelDispatched?.(); return { output: "batch" }; },
      beforeNodeComplete: async () => { throw Object.assign(new Error(`commit refused: ${code}`), { code }); },
    });
    const started = await engine.start(workflow, { id: `commit-${code}-run` });
    const settled = await engine.wait(started.id);
    assert.equal(settled.nodes.task.status, "awaiting-model-choice", code);
    assert.equal(settled.nodes.task.failureKind, "model", code);
    assert.equal(settled.nodes.task.attempts.length, 2, code);
  }
});

test("reports where a failure happened so the panel can offer the right retry", { timeout: 5000 }, async () => {
  const workflow = { schemaVersion: 3, id: "commit-origin", kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
  const engine = new RpWorkflowEngine({
    executor: async task => { task.markModelDispatched?.(); return { output: "batch" }; },
    beforeNodeComplete: async () => { throw Object.assign(new Error("Record X revision conflict."), { code: "revision_conflict" }); },
  });
  const settled = await engine.wait((await engine.start(workflow, { id: "commit-origin-run" })).id);
  // Both fields describe the same failure, and the code survives for the hint text.
  assert.equal(settled.nodes.task.failureCause, "node_end_commit");
  assert.equal(settled.nodes.task.failureCode, "revision_conflict");

  // A failure from the executor itself is not a commit failure, and carries no code here.
  const plain = new RpWorkflowEngine({ executor: async task => { task.markModelDispatched?.(); throw new Error("provider is offline"); } });
  const plainSettled = await plain.wait((await plain.start({ ...workflow, id: "plain-run" }, { id: "plain-run" })).id);
  assert.equal(plainSettled.nodes.task.failureCause, null);
  assert.equal(plainSettled.nodes.task.failureCode, null);
});

test("retrying a node clears the previous failure's cause and code", { timeout: 5000 }, async () => {
  // The panel reads these fields, so a stale cause beside a fresh attempt would describe the wrong
  // retry — the marks must disappear with the error.
  const workflow = { schemaVersion: 3, id: "commit-recovery", kind: "turn-background", nodes: [{ id: "task", type: "agent", retry: { maxAttempts: 1 } }] };
  let attempt = 0;
  const engine = new RpWorkflowEngine({
    executor: async task => { task.markModelDispatched?.(); return { output: "batch" }; },
    beforeNodeComplete: async ({ result }) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("Record X revision conflict."), { code: "revision_conflict" });
      return result;
    },
  });
  const started = await engine.start(workflow, { id: "commit-recovery-run" });
  const failed = await engine.wait(started.id);
  assert.equal(failed.nodes.task.status, "awaiting-model-choice");
  assert.equal(failed.nodes.task.failureCause, "node_end_commit");
  await engine.retry(started.id, "task", null);
  const retried = await engine.wait(started.id);
  assert.equal(retried.status, "completed");
  assert.equal(retried.nodes.task.error, null);
  assert.equal(retried.nodes.task.failureKind, null);
  assert.equal(retried.nodes.task.failureCause, null);
  assert.equal(retried.nodes.task.failureCode, null);
});

test("a throwing onChange neither hangs waiters nor escapes the scheduler", { timeout: 5000 }, async () => {
  // The host hook fails after start(), so the failure lands inside the scheduler's own
  // propagation path. Previously the waiter's wake was never resolved (wait() hung forever)
  // and the rejection escaped an un-awaited tick, which terminates the host by default.
  let calls = 0;
  const engine = new RpWorkflowEngine({
    executor: async ({ node }) => ({ output: node.id }),
    onChange: async () => {
      calls += 1;
      if (calls > 1) throw new Error("persistence unavailable");
    },
  });
  const workflow = {
    schemaVersion: 3,
    id: "change-failure",
    kind: "turn-background",
    nodes: [{ id: "task", type: "code" }],
  };
  const started = await engine.start(workflow, { id: "change-failure-run" });
  const settled = await engine.wait(started.id);
  assert.equal(settled.status, "completed");
  const failures = settled.changeFailures || [];
  assert.ok(failures.length > 0, "the hook failure must be recorded on the run");
  assert.equal(failures.at(-1).hook, "onChange");
  assert.match(failures.at(-1).message, /persistence unavailable/);
});
