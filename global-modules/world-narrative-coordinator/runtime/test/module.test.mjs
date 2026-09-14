import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeFeatureModuleManifest } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-feature-modules.mjs";
import { normalizeDataContract } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { executeDataBatch } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";
import { getDataRecord, queryData } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";
import { normalizeWorkflowDefinition } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";
import { execute as materialize } from "../workflow/materialize-guidance.mjs";
import { execute as preparePrivate } from "../workflow/prepare-private-context.mjs";
import { buildAgentChangeBatch } from "../lib/agent-change-batch.mjs";
import { applyArchiveContentVersions } from "../lib/archive-content-version.mjs";
import { execute as captureArchiveOutbox } from "../../integration/runtime/capture-archive-outbox.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function fixture() {
  const contract = normalizeDataContract(JSON.parse(await readFile(resolve(moduleRoot, "data-contract.json"), "utf8")));
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "director-module-"));
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory: moduleRoot }] });
  await store.initialize();
  const access = [
    { moduleId: "world-narrative-coordinator", collectionId: "private-state", capabilities: ["director.private.write", "director.guidance.materialize"], views: ["director"], queryBudget: { maxRecords: 10000, maxCharacters: 2000000 } },
  ];
  const data = {
    query(request) { return queryData(store, request, { capabilities: access[0].capabilities, views: access[0].views, runtimeLimit: 10000, runtimeCharacters: 2000000, nodeLimit: 10000, nodeCharacters: 2000000 }); },
    get(request) { return getDataRecord(store, request, { capabilities: access[0].capabilities, views: access[0].views }); },
  };
  return { contract, sessionDirectory, store, access, data };
}

test("package, contract, workflows, schemas, and initial records normalize", async () => {
  normalizeFeatureModuleManifest(JSON.parse(await readFile(resolve(moduleRoot, "module.json"), "utf8")));
  const { contract, store } = await fixture();
  assert.deepEqual(Object.keys(contract.collections), ["private-state", "deep-workbench", "archive-outbox", "settings"]);
  for (const directory of await readdir(resolve(moduleRoot, "workflows"))) {
    normalizeWorkflowDefinition(JSON.parse(await readFile(resolve(moduleRoot, "workflows", directory, "workflow.json"), "utf8")));
  }
  assert.equal((await store.readCollection("world-narrative-coordinator", "private-state")).records.length, 5);
  assert.equal((await store.readCollection("world-narrative-coordinator", "deep-workbench")).records.length, 2);
});

test("director workflows prepare private and authored context independently before consumers", async () => {
  for (const [workflowId, consumerId] of [["pre-director-update", "adjust"], ["post-director-update", "review"]]) {
    const workflow = normalizeWorkflowDefinition(JSON.parse(await readFile(resolve(moduleRoot, "workflows", workflowId, "workflow.json"), "utf8")));
    const privateNode = workflow.nodes.find(node => node.id === "prepare-private");
    const authorNode = workflow.nodes.find(node => node.id === "prepare-author-future");
    const consumer = workflow.nodes.find(node => node.id === consumerId);
    assert.deepEqual(privateNode.dependsOn, []);
    assert.deepEqual(authorNode.dependsOn, []);
    assert.deepEqual(new Set(consumer.dependsOn), new Set(["prepare-private", "prepare-author-future"]));
  }
  const deep = normalizeWorkflowDefinition(JSON.parse(await readFile(resolve(moduleRoot, "workflows/deep-director-planning/workflow.json"), "utf8")));
  for (const id of ["prepare-private", "prepare-author-future"]) assert.deepEqual(deep.nodes.find(node => node.id === id).dependsOn, ["mark-running"]);
  assert.deepEqual(new Set(deep.nodes.find(node => node.id === "plan").dependsOn), new Set(["prepare-private", "prepare-author-future"]));
});

test("materializer preserves channel boundaries and deterministic priority", async () => {
  const { sessionDirectory, store, access, data } = await fixture();
  const batch = {
    protocolVersion: 1, batchId: "guidance-fixture", status: "pending", commitPolicy: "atomic", operations: [
      { operationId: "create-advice", moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.guidance", action: "create", targetId: "guidance-advice", data: { title: "普通建议", content: "缓慢推进。", status: "active", channels: ["narrative"], kind: "direction", contextNature: null, strength: "advisory", lastReviewedTurn: 1 } },
      { operationId: "create-guardrail", moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.guidance", action: "create", targetId: "guidance-guardrail", data: { title: "紧急纠偏", content: "不要凭空追加追兵。", status: "active", channels: ["narrative"], kind: "correction", contextNature: null, strength: "guardrail", lastReviewedTurn: 1 } },
      { operationId: "create-hidden", moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.guidance", action: "create", targetId: "guidance-behind-scenes", data: { title: "幕后专用", content: "仅幕后可见。", status: "active", channels: ["behind-scenes"], kind: "context", contextNature: "plan", strength: "priority", lastReviewedTurn: 1 } },
      { operationId: "publish", moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.publication", action: "update", targetId: "publication-narrative", expectedRevision: 1, data: { channel: "narrative", items: [{ guidanceId: "guidance-advice", note: null }, { guidanceId: "guidance-guardrail", note: "已有追兵仍可继续出场。" }] } }
    ]
  };
  const receipt = await executeDataBatch(store, batch, { access, context: { initiatorKind: "code", initiatorId: "test", workflowId: "test", workflowRunId: "test", nodeId: "test", binding: { turn: 1, messageId: null }, sourceReferences: [] } });
  assert.equal(receipt.status, "committed");
  const workspace = await mkdtemp(resolve(tmpdir(), "director-guidance-"));
  const result = await materialize({ run: { arguments: { publicationId: "publication-narrative", channel: "narrative" } }, workspace, data });
  const text = await readFile(resolve(workspace, "guidance.md"), "utf8");
  assert.equal(result.guidanceCount, 2);
  assert.ok(text.indexOf("紧急纠偏") < text.indexOf("普通建议"));
  assert.match(text, /已有追兵仍可继续出场/);
  assert.doesNotMatch(text, /幕后专用|仅幕后可见/);
  const privateWorkspace = await mkdtemp(resolve(tmpdir(), "director-private-"));
  await preparePrivate({ workspace: privateWorkspace, data: {
    query: request => queryData(store, request, { capabilities: request.collectionId === "private-state" ? ["director.private.read"] : request.collectionId === "deep-workbench" ? ["director.deep.read"] : ["director.settings.read"], views: [request.view], runtimeLimit: 10000, runtimeCharacters: 2000000, nodeLimit: 10000, nodeCharacters: 2000000 }),
    get: request => getDataRecord(store, request, { capabilities: ["director.settings.read"], views: [request.view] }),
  } });
  const index = await readFile(resolve(privateWorkspace, "private-context", "DOCUMENTS.md"), "utf8");
  assert.match(index, /guidance-guardrail/);
  assert.match(index, /turn-brief-current/);
});

test("archive handoff schema rejects missing knowledge scope", async () => {
  const { store, access } = await fixture();
  const invalid = { protocolVersion: 1, batchId: "bad-outbox", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "bad", moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", recordType: "director.archive-handoff", action: "create", targetId: "handoff-bad", data: { status: "ready", recordKind: "event", intent: "upsert", subject: "一场事件", content: {}, sourceTurn: 1, dedupeKey: "event-1", sourceCaptureId: null } }] };
  const receipt = await executeDataBatch(store, invalid, { access: [{ moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", capabilities: ["director.archive.write"], views: ["director-status"] }], context: { initiatorKind: "code", initiatorId: "test", workflowId: "test", workflowRunId: "test", nodeId: "test", binding: { turn: 1, messageId: null }, sourceReferences: [] } });
  assert.equal(receipt.status, "failed");
  assert.match(JSON.stringify(receipt), /knowledgeScope|schema validation/i);
});

test("code supplies the director batch envelope and preserves operation concurrency fields", () => {
  const result = buildAgentChangeBatch({ operations: [
    { moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.watch", action: "update", targetId: "watch-1", expectedRevision: 7, data: { status: "active" } },
    { operationId: "archive-explicit", moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", recordType: "director.archive-handoff", action: "create", targetId: "handoff-1", data: { status: "ready" } },
  ] }, { batchId: "director-test", allowedCollections: ["private-state", "archive-outbox"], archiveFirst: true });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.commitPolicy, "atomic");
  assert.equal(result.status, "pending");
  assert.equal(result.operations[0].operationId, "archive-explicit");
  assert.equal(result.operations[1].targetId, "watch-1");
  assert.equal(result.operations[1].expectedRevision, 7);
  assert.equal(result.operations[1].operationId, "director-test-op-2");
});

test("archive capture replays with the same stable capture ID after confirmation fails", async () => {
  const ready = { id: "handoff-1", revision: 4, value: { contentVersion: 2, subject: "港口传闻", status: "ready" } };
  const captureIds = [];
  let submissions = 0;
  const data = {
    async query() { return { items: [ready] }; },
    async submit(batch) {
      submissions += 1;
      if (submissions === 1) throw new Error("confirmation interrupted");
      assert.equal(batch.operations[0].data.sourceCaptureId, captureIds[0]);
      return { status: "committed" };
    },
  };
  const calls = { async invoke(request) {
    captureIds.push(request.arguments.request.captures[0].captureId);
    return { callId: `capture-call-${captureIds.length}` };
  } };
  const task = { run: { id: "archive-run", turn: 3 }, conversation: { messages: [] }, data, calls };
  await assert.rejects(() => captureArchiveOutbox(task), /confirmation interrupted/);
  const result = await captureArchiveOutbox(task);
  assert.equal(result.captured, 1);
  assert.equal(captureIds.length, 2);
  assert.equal(captureIds[0], "memory-source-world-narrative-coordinator-handoff-1-v2");
  assert.equal(captureIds[1], captureIds[0]);
});

test("archive content versions ignore technical state and advance on every business edit", async () => {
  const base = { status: "ready", recordKind: "event", intent: "upsert", subject: "港口", content: { event: "A" }, knowledgeScope: { mode: "common" }, sourceTurn: 3, dedupeKey: "port", sourceCaptureId: null, contentVersion: 2 };
  let current = { id: "handoff-1", revision: 8, value: base };
  const data = { async get() { return structuredClone(current); } };
  const batch = value => ({ protocolVersion: 1, batchId: "version-test", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "update", moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", recordType: "director.archive-handoff", action: "update", targetId: current.id, expectedRevision: current.revision, data: value }] });
  const technical = await applyArchiveContentVersions(data, batch({ ...base, status: "captured", sourceCaptureId: "capture-2" }));
  assert.equal(technical.operations[0].data.contentVersion, 2);
  current = { id: current.id, revision: 9, value: technical.operations[0].data };
  const changed = await applyArchiveContentVersions(data, batch({ ...current.value, status: "ready", sourceCaptureId: null, content: { event: "B" } }));
  assert.equal(changed.operations[0].data.contentVersion, 3);
  current = { id: current.id, revision: 10, value: changed.operations[0].data };
  const changedBack = await applyArchiveContentVersions(data, batch({ ...current.value, content: { event: "A" } }));
  assert.equal(changedBack.operations[0].data.contentVersion, 4);
});
