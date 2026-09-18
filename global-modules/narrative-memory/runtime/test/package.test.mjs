import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importRuntimeTestModule } from "./runtime-test-runtime.mjs";

const { normalizeDataContract } = await importRuntimeTestModule("rp-data-contracts.mjs");
const { executeDataBatch } = await importRuntimeTestModule("rp-data-changes.mjs");
const { queryData } = await importRuntimeTestModule("rp-data-query.mjs");
const { validateJsonSchema } = await importRuntimeTestModule("rp-data-schema.mjs");
const { RpDataStore } = await importRuntimeTestModule("rp-data-store.mjs");
const { finalizeNodeData } = await importRuntimeTestModule("rp-data-node-runtime.mjs");
const {
  assertWorkflowCallAllowed,
  completeWorkflowNode,
  createWorkflowRun,
  normalizeWorkflowDefinition,
  readyWorkflowNodes,
  startWorkflowNode,
} = await importRuntimeTestModule("rp-workflows.mjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = async path => JSON.parse(await readFile(path, "utf8"));

test("the public runtime accepts the data contract and every workflow", async () => {
  const contract = await json(resolve(root, "data-contract.json"));
  assert.equal(normalizeDataContract(contract, "narrative-memory").moduleId, "narrative-memory");
  for (const workflowId of await readdir(resolve(root, "workflows"))) {
    const workflow = await json(resolve(root, "workflows", workflowId, "workflow.json"));
    assert.equal(normalizeWorkflowDefinition(workflow).id, workflowId);
  }
});

test("every nested module call obeys the public workflow layering rules", async () => {
  const workflows = new Map();
  for (const workflowId of await readdir(resolve(root, "workflows"))) {
    const workflow = normalizeWorkflowDefinition(await json(resolve(root, "workflows", workflowId, "workflow.json")));
    workflows.set(`narrative-memory/${workflow.id}`, workflow);
  }
  for (const workflow of workflows.values()) {
    for (const node of workflow.nodes) {
      if (node.type === "call") assert.doesNotThrow(() => assertWorkflowCallAllowed(workflow, node, workflows.get(node.target)));
    }
  }
});

test("archive and compression preparation routes skip every downstream model node", async () => {
  for (const workflowId of ["narrative-memory-archive", "narrative-memory-compression"]) {
    const workflow = normalizeWorkflowDefinition(await json(resolve(root, "workflows", workflowId, "workflow.json")));
    const prepare = workflow.nodes.find(node => node.id === (workflowId === "narrative-memory-archive" ? "prepare-archive" : "prepare-compression"));
    const run = createWorkflowRun(workflow, { id: `${workflowId}-skip-test`, turn: 1 });
    startWorkflowNode(workflow, run, prepare.id, { modelId: "pi:current" });
    completeWorkflowNode(workflow, run, prepare.id, { output: { route: "skip" }, route: "skip" });
    assert.deepEqual(readyWorkflowNodes(workflow, run).map(node => node.type), ["workflow-return"]);
    startWorkflowNode(workflow, run, "return", { modelId: "pi:current" });
    completeWorkflowNode(workflow, run, "return", { output: { outputs: {} } });
    assert.equal(run.status, "completed");
    assert.equal(workflow.nodes.filter(node => node.type === "agent").every(node => run.nodes[node.id].status === "skipped"), true);
  }
});

test("a skipped compression eligibility node completes real artifact finalization without a fake snapshot", async t => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "memory-compression-skip-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const workflow = normalizeWorkflowDefinition(await json(resolve(root, "workflows", "narrative-memory-compression", "workflow.json")));
  const node = workflow.nodes.find(item => item.id === "prepare-compression");
  const run = createWorkflowRun(workflow, { id: "compression-finalize-skip", turn: 1 });
  const finalized = await finalizeNodeData({ sessionDirectory, store: null, workflow, run, node, result: { output: { route: "skip", shouldCompress: false } } });
  assert.deepEqual(finalized.artifacts, {});
});

test("initial records satisfy their module-owned schemas", async () => {
  const contract = await json(resolve(root, "data-contract.json"));
  for (const [collectionId, collection] of Object.entries(contract.collections)) {
    const initial = collection.storage.initialRecordsFile || collection.storage.initialSnapshotFile;
    const records = await json(resolve(root, initial));
    for (const record of records) {
      assert.equal(record.moduleId, "narrative-memory");
      assert.equal(record.collectionId, collectionId);
      const definition = collection.recordTypes[record.recordType];
      assert.ok(definition, `unknown initial record type ${record.recordType}`);
      const schema = await json(resolve(root, definition.schemaFile));
      assert.deepEqual(validateJsonSchema(record.data, schema), [], `${record.id} failed its schema`);
    }
  }
});

test("template, Agent, and code-entry registries contain valid local targets", async () => {
  const registry = await json(resolve(root, "templates", "registry.json"));
  const seen = new Set();
  for (const item of registry.templates) {
    assert.equal(seen.has(item.templateId), false, `duplicate template ${item.templateId}`);
    seen.add(item.templateId);
    const template = await json(resolve(root, "templates", item.file));
    assert.equal(template.templateId, item.templateId);
    assert.equal(template.templateVersion, item.templateVersion);
    assert.equal(template.recordType, item.recordType);
  }
  for (const workflowId of await readdir(resolve(root, "workflows"))) {
    const workflow = await json(resolve(root, "workflows", workflowId, "workflow.json"));
    for (const node of workflow.nodes) {
      if (node.agentId) await readFile(resolve(root, "agents", node.agentId, "agent.json"));
      if (node.metadata?.entryFile) {
        const relative = node.metadata.entryFile.replace(/^features\/narrative-memory\//, "");
        await readFile(resolve(root, relative));
      }
    }
  }
});

test("the public data store initializes, commits, indexes, and renders complete records", async t => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "narrative-memory-store-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const contract = normalizeDataContract(await json(resolve(root, "data-contract.json")), "narrative-memory");
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory: root }] });
  await store.initialize();
  const entity = {
    name: "林月",
    aliases: ["青鸦"],
    entityKind: "character",
    templateMode: "default",
    templateId: "entity.character",
    templateVersion: 1,
    catalogSummary: "紫霄派剑修",
    sections: { 基本信息: { 性别: "女", 所属势力: "紫霄派" } },
    informationBlocks: [{ title: "旧伤", mode: "unclassified", knowerIds: [], content: { 当前状态: ["左臂有旧伤"] } }],
    derivedFacets: { gender: "女", affiliation: "紫霄派" },
    summaryOverLimit: false,
  };
  const receipt = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "memory-test-create",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "memory-test-create-lin", moduleId: "narrative-memory", collectionId: "entities", recordType: "memory.entity", action: "create", targetId: "lin", data: entity }],
  }, { access: { "narrative-memory": ["memory.archive.write"] }, context: { binding: { turn: 1, messageId: "m1" } } });
  assert.equal(receipt.status, "committed");
  const result = await queryData(store, {
    moduleId: "narrative-memory",
    collectionId: "entities",
    recordTypes: ["memory.entity"],
    where: { entityKind: { eq: "character" } },
    view: "frontend",
    limit: 10,
  }, { capabilities: ["memory.frontend.read"], views: ["frontend"], runtimeLimit: 20, runtimeCharacters: 20000 });
  assert.equal(result.returned, 1);
  assert.deepEqual(result.items[0].value, entity);

  const coverage = {
    startTurn: 1,
    endTurn: 3,
    operation: "repair",
    workflowRunId: "run.memory-range-test",
    batchId: "memory-test-coverage",
    coveredMessageIds: ["m1", "m2", "m3"],
    completedAt: "2026-09-07T00:00:00.000Z",
    userInstruction: null,
  };
  const coverageReceipt = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: coverage.batchId,
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "memory-test-create-coverage", moduleId: "narrative-memory", collectionId: "support", recordType: "memory.archive-coverage", action: "create", targetId: "coverage.1-3", data: coverage }],
  }, { access: { "narrative-memory": ["memory.support.update"] }, context: { workflowId: "narrative-memory-range-repair", workflowRunId: coverage.workflowRunId, nodeId: "commit-range-repair", binding: { turn: 3, messageId: "m3" } } });
  assert.equal(coverageReceipt.status, "committed");
  const coverageResult = await queryData(store, {
    moduleId: "narrative-memory",
    collectionId: "support",
    recordTypes: ["memory.archive-coverage"],
    view: "frontend",
    limit: 10,
  }, { capabilities: ["memory.frontend.read"], views: ["frontend"], runtimeLimit: 20, runtimeCharacters: 20000 });
  assert.equal(coverageResult.returned, 1);
  assert.deepEqual(coverageResult.items[0].value, { 开始回合: 1, 结束回合: 3, 处理方式: "repair", 完成时间: coverage.completedAt, 用户要求: null });
  const storedCoverage = (await store.readCollection("narrative-memory", "support")).records.find(record => record.id === "coverage.1-3");
  assert.deepEqual(storedCoverage.data, coverage);
});
