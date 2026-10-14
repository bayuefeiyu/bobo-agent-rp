import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execute as checkSource } from "../workflow/check-retrieval-source.mjs";
import { execute as composeMemory } from "../workflow/compose-memory.mjs";
import { importRuntimeTestModule } from "./runtime-test-runtime.mjs";
const { RpWorkflowEngine } = await importRuntimeTestModule("rp-workflow-engine.mjs");
const { resolveCodeNodeRoute } = await importRuntimeTestModule("rp-workflows.mjs");

test("empty memory sources complete the full retrieval workflow without invoking an Agent", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-empty-memory-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const workflow = JSON.parse(await readFile(new URL("../../workflows/narrative-memory-retrieve/workflow.json", import.meta.url)));
  const data = { query: async () => ({ items: [], truncated: false, nextCursor: null }) };
  let agents = 0;
  const engine = new RpWorkflowEngine({ executor: async ({ node, run }) => {
    if (node.type === "agent") { agents++; throw new Error("an empty source must not invoke a model"); }
    if (node.id === "check-retrieval-source") { const output = await checkSource({ data }); return { output, route: resolveCodeNodeRoute(node, output) }; }
    if (node.id === "prepare-retrieval") return { output: { effectiveBudget: { entityQueryLimit: 1, informationLimit: 1, elasticInformationLimit: 0, possiblePerQueryLimit: 0 } } };
    if (node.id === "compose-memory") return { output: await composeMemory({ run, data, workspace }) };
    return { output: {} };
  } });
  const run = await engine.start(workflow, { textInput: "查询当前任务相关的历史", callContext: { parentRunId: "test-parent", parentWorkflowId: "test/parent", parentNodeId: "call" } });
  const completed = await engine.wait(run.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.nodes["memory-retrieval"].error, "condition_not_matched");
  assert.equal(agents, 0);
  assert.ok((await readFile(resolve(workspace, "memory-context", "DOCUMENTS.md"), "utf8")).length);
});

test("any available record preserves Agent matching; uncertain emptiness reports failure", async () => {
  const result = await checkSource({ data: { query: async ({ collectionId }) => ({ items: collectionId === "events" ? [{ id: "event" }] : [], truncated: false }) } });
  assert.equal(result.route, "available");
  await assert.rejects(checkSource({ data: { query: async () => ({ items: [], truncated: true }) } }), /could not be established/);
  await assert.rejects(checkSource({ data: { query: async () => ({}) } }), /Invalid memory source/);
});
