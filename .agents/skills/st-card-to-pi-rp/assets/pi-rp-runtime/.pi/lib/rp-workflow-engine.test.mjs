import assert from "node:assert/strict";
import test from "node:test";

import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";

const flow = {
  schemaVersion: 1,
  id: "parallel",
  kind: "foreground",
  nodes: [
    { id: "a", type: "agent" },
    { id: "b", type: "agent" },
    { id: "story", type: "narrative", dependsOn: ["a", "b"] },
    { id: "done", type: "turn-finalize", dependsOn: ["story"] },
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

test("stops for an explicit model choice after exhausted attempts", async () => {
  const engine = new RpWorkflowEngine({ executor: async () => { throw new Error("offline"); } });
  const started = await engine.start(flow, { id: "failed" });
  const failed = await engine.wait(started.id);
  assert.equal(failed.status, "awaiting-model-choice");
  assert.equal(failed.nodes.a.attempts.length, 3);
});

test("allows a user-selected model retry after automatic attempts are exhausted", async () => {
  let calls = 0;
  const workflow = { schemaVersion: 1, id: "retryable", kind: "turn-background", nodes: [{ id: "task", type: "agent" }] };
  const engine = new RpWorkflowEngine({ executor: async () => { calls += 1; if (calls <= 3) throw new Error("offline"); return { output: "ok" }; } });
  const started = await engine.start(workflow, { id: "retry-run" });
  await engine.wait(started.id);
  await engine.retry(started.id, "task", "pi:current");
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.nodes.task.attempts.length, 4);
});
