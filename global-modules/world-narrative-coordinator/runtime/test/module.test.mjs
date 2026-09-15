import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { execute as beginDeepOperation } from "../workflow/begin-deep-operation.mjs";
import { execute as commitDeepOperation } from "../workflow/commit-deep-operation.mjs";
import { buildAgentChangeBatch } from "../lib/agent-change-batch.mjs";
import { applyArchiveContentVersions } from "../lib/archive-content-version.mjs";
import { execute as captureArchiveOutbox } from "../../integration/runtime/capture-archive-outbox.mjs";
import { execute as runDeepIfNeeded } from "../../integration/runtime/run-deep-if-needed.mjs";

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
  assert.deepEqual(Object.keys(contract.collections), ["private-state", "deep-workbench", "reference-library", "archive-outbox", "health-dashboard", "settings"]);
  for (const directory of await readdir(resolve(moduleRoot, "workflows"))) {
    normalizeWorkflowDefinition(JSON.parse(await readFile(resolve(moduleRoot, "workflows", directory, "workflow.json"), "utf8")));
  }
  assert.equal((await store.readCollection("world-narrative-coordinator", "private-state")).records.length, 5);
  assert.equal((await store.readCollection("world-narrative-coordinator", "deep-workbench")).records.length, 2);
  assert.equal((await store.readCollection("world-narrative-coordinator", "reference-library")).records.length, 0);
  assert.equal((await store.readCollection("world-narrative-coordinator", "health-dashboard")).records.length, 1);
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
  const team = normalizeWorkflowDefinition(JSON.parse(await readFile(resolve(moduleRoot, "workflows/deep-director-team-planning/workflow.json"), "utf8")));
  assert.equal(team.nodes.find(node => node.id === "meeting").type, "team");
  assert.equal(team.nodes.find(node => node.id === "meeting").team.experts.length, 2);
  assert.deepEqual(team.writeLocks, []);
});

test("team deep output commits report, references, and running state atomically", async () => {
  const { store } = await fixture();
  const access = [
    { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", capabilities: ["director.deep.write"], views: ["deep-director"] },
    { moduleId: "world-narrative-coordinator", collectionId: "reference-library", capabilities: ["director.reference.write"], views: ["maintenance"] },
  ];
  const permissions = request => access.find(item => item.collectionId === request.collectionId);
  const data = {
    get: request => { const allowed = permissions(request); return getDataRecord(store, request, { capabilities: allowed.capabilities, views: [request.view] }); },
    submit: (batch, options = {}) => executeDataBatch(store, batch, { access, context: { initiatorKind: "code", initiatorId: "test", workflowId: "test", workflowRunId: "deep-run", nodeId: "test", binding: options.binding || { turn: 1, messageId: null }, sourceReferences: [] } }),
  };
  const run = { id: "deep-run", turn: 1, arguments: { operationId: "operation-1", triggerReasons: ["test"] } };
  const conversation = { messages: [] };
  const reportBasis = await getDataRecord(store, { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" }, { capabilities: ["director.deep.write"], views: ["deep-director"] });
  await beginDeepOperation({ run, conversation, data });
  const workspace = await mkdtemp(resolve(tmpdir(), "director-deep-commit-"));
  await mkdir(resolve(workspace, "inputs"), { recursive: true });
  const referenceUpdates = [{ referenceId: "reference-example", title: "示例参考", summary: "用于验证团队参考资料提交。", change: "created" }];
  const report = {
    basisTurn: 1, basisWorldTime: null, coverage: ["test"], assumptions: [], invalidatingSignals: [], summary: "团队深度报告", content: "完整报告正文。",
    worldNarrativeTopics: [
      { topicId: "active", title: "活跃题材", status: "active", premise: "继续观察。", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] },
      { topicId: "backup", title: "备用题材", status: "backup", premise: "条件成熟时启用。", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] },
    ],
    nextReviewTriggers: ["局势变化"], referenceUpdates,
  };
  const references = [{ ...referenceUpdates[0], content: "可复用的参考内容。", sources: [] }];
  await writeFile(resolve(workspace, "inputs/report.json"), JSON.stringify(report), "utf8");
  await writeFile(resolve(workspace, "inputs/references.json"), JSON.stringify(references), "utf8");
  await writeFile(resolve(workspace, "inputs/basis.json"), JSON.stringify({ schemaVersion: 1, operationId: "operation-1", basisTurn: 1, deepReport: { id: reportBasis.id, revision: reportBasis.revision }, references: {}, sourceMessages: [] }), "utf8");
  await commitDeepOperation({ run, workspace, conversation, data });
  const replay = await commitDeepOperation({ run, workspace, conversation, data });
  const state = await getDataRecord(store, { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" }, { capabilities: ["director.deep.write"], views: ["deep-director"] });
  const committedReport = await getDataRecord(store, { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" }, { capabilities: ["director.deep.write"], views: ["deep-director"] });
  const reference = await getDataRecord(store, { moduleId: "world-narrative-coordinator", collectionId: "reference-library", id: "reference-example", view: "maintenance" }, { capabilities: ["director.reference.write"], views: ["maintenance"] });
  assert.equal((state.value.data || state.value).status, "idle");
  assert.equal((committedReport.value.data || committedReport.value).summary, "团队深度报告");
  assert.equal((reference.value.data || reference.value).title, "示例参考");
  assert.equal(replay.receipt.idempotentReplay, true);
});

test("team deep commit rejects stale output and preserves a concurrently maintained reference", async () => {
  const { store } = await fixture();
  const access = [
    { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", capabilities: ["director.deep.write"], views: ["deep-director"] },
    { moduleId: "world-narrative-coordinator", collectionId: "reference-library", capabilities: ["director.reference.write"], views: ["maintenance"] },
  ];
  const constraints = request => { const item = access.find(entry => entry.collectionId === request.collectionId); return { capabilities: item.capabilities, views: [request.view] }; };
  const data = {
    get: request => getDataRecord(store, request, constraints(request)),
    submit: (batch, options = {}) => executeDataBatch(store, batch, { access, context: { initiatorKind: "code", initiatorId: "test", workflowId: "test", workflowRunId: "conflict", nodeId: "test", binding: options.binding || { turn: 1, messageId: null }, sourceReferences: [] } }),
  };
  await data.submit({ protocolVersion: 1, batchId: "seed-reference", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "seed-reference", moduleId: "world-narrative-coordinator", collectionId: "reference-library", recordType: "director.reference-document", action: "create", targetId: "reference-existing", data: { title: "原题", summary: "原摘要", content: "原内容", sources: [] } }] });
  const referenceBasis = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "reference-library", id: "reference-existing", view: "maintenance" });
  const reportBasis = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" });
  const run = { id: "deep-conflict", turn: 1, arguments: { operationId: "operation-conflict" } };
  await beginDeepOperation({ run, conversation: { messages: [] }, data });
  await data.submit({ protocolVersion: 1, batchId: "maintain-reference", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "maintain-reference", moduleId: "world-narrative-coordinator", collectionId: "reference-library", recordType: "director.reference-document", action: "update", targetId: "reference-existing", expectedRevision: referenceBasis.revision, data: { title: "维护后", summary: "维护摘要", content: "用户维护内容", sources: [] } }] });
  const workspace = await mkdtemp(resolve(tmpdir(), "director-deep-conflict-"));
  await mkdir(resolve(workspace, "inputs"), { recursive: true });
  const update = { referenceId: "reference-existing", title: "会议旧稿", summary: "旧摘要", change: "updated" };
  const report = { basisTurn: 1, basisWorldTime: null, coverage: [], assumptions: [], invalidatingSignals: [], summary: "报告", content: "正文", worldNarrativeTopics: [{ topicId: "active", title: "活跃", status: "active", premise: "前提", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] }, { topicId: "backup", title: "备用", status: "backup", premise: "前提", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] }], nextReviewTriggers: [], referenceUpdates: [update] };
  await writeFile(resolve(workspace, "inputs/report.json"), JSON.stringify(report), "utf8");
  await writeFile(resolve(workspace, "inputs/references.json"), JSON.stringify([{ ...update, content: "会议旧内容", sources: [] }]), "utf8");
  await writeFile(resolve(workspace, "inputs/basis.json"), JSON.stringify({ schemaVersion: 1, operationId: "operation-conflict", basisTurn: 1, deepReport: { id: reportBasis.id, revision: reportBasis.revision }, references: { "reference-existing": referenceBasis.revision }, sourceMessages: [] }), "utf8");
  await assert.rejects(commitDeepOperation({ run, workspace, conversation: { messages: [] }, data }), error => error.code === "revision_conflict");
  const maintained = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "reference-library", id: "reference-existing", view: "maintenance" });
  assert.equal((maintained.value.data || maintained.value).content, "用户维护内容");
});

test("team deep commit rejects a revised or removed source message", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "director-deep-source-conflict-"));
  await mkdir(resolve(workspace, "inputs"), { recursive: true });
  const report = {
    basisTurn: 1, basisWorldTime: null, coverage: [], assumptions: [], invalidatingSignals: [], summary: "report", content: "content",
    worldNarrativeTopics: [
      { topicId: "active", title: "active", status: "active", premise: "premise", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] },
      { topicId: "backup", title: "backup", status: "backup", premise: "premise", conditions: [], boundaries: [], suggestedAngles: [], invalidatingSignals: [] },
    ],
    nextReviewTriggers: [], referenceUpdates: [],
  };
  await writeFile(resolve(workspace, "inputs/report.json"), JSON.stringify(report), "utf8");
  await writeFile(resolve(workspace, "inputs/references.json"), "[]", "utf8");
  await writeFile(resolve(workspace, "inputs/basis.json"), JSON.stringify({ schemaVersion: 1, operationId: "source-op", basisTurn: 1, deepReport: { id: "deep-report-current", revision: 1 }, references: {}, sourceMessages: [{ id: "message-1", revision: 1, turn: 1 }] }), "utf8");
  let submissions = 0;
  const data = {
    receipt: async () => null,
    get: async request => request.id === "deep-state-current"
      ? { id: request.id, revision: 2, value: { status: "running", currentRunId: "source-op" } }
      : { id: request.id, revision: 1, value: {} },
    submit: async () => { submissions += 1; return { status: "committed" }; },
  };
  const run = { id: "source-run", turn: 1, arguments: { operationId: "source-op" } };
  await assert.rejects(commitDeepOperation({ run, workspace, conversation: { messages: [{ id: "message-1", revision: 2, binding: { turn: 1 } }] }, data }), error => error.code === "deep_source_conflict");
  await assert.rejects(commitDeepOperation({ run, workspace, conversation: { messages: [] }, data }), error => error.code === "deep_source_conflict");
  assert.equal(submissions, 0);
});

test("deep wrapper routes single and team modes through their intended call sequences", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "director-deep-wrapper-"));
  await mkdir(resolve(workspace, "trigger/story-context"), { recursive: true });
  await writeFile(resolve(workspace, "trigger/story-context/DOCUMENTS.md"), "# Frozen story context\n", "utf8");
  const conversation = { messages: [{ id: "message-1", binding: { turn: 7 }, data: { role: "assistant", content: "正文" } }] };
  const run = { id: "wrapper-run", turn: 7 };
  const node = { metadata: { historyCompleteTurns: 20 } };
  for (const mode of ["single", "team"]) {
    const callsMade = [];
    const data = { async get(request) {
      if (request.collectionId === "settings") return { value: { enabled: true, deep: { workflowMode: mode } } };
      if (request.collectionId === "private-state") return { value: { deepRecommendation: { shouldStart: true, reasonCodes: ["scheduled-review"] } } };
      if (request.id === "deep-state-current") return { id: request.id, revision: 1, value: { status: "idle", currentRunId: null } };
      if (request.id === "deep-report-current") return { id: request.id, revision: 1, value: { basisTurn: 0 } };
      throw new Error(`Unexpected collection: ${request.collectionId}`);
    }, async query() { return { items: [], nextCursor: null }; } };
    const calls = { async invoke(request) {
      callsMade.push(structuredClone(request));
      if (request.workflow.endsWith("deep-director-team-planning")) return { callId: "team-call", outputs: { report: "team-deep-report.json", references: "team-deep-references.json" } };
      return { callId: `${request.workflow}-call`, outputs: {} };
    } };
    const result = await runDeepIfNeeded({ run, node, conversation, data, calls, workspace });
    assert.equal(result.started, true);
    if (mode === "single") {
      assert.deepEqual(callsMade.map(item => item.workflow), ["world-narrative-coordinator/deep-director-planning"]);
    } else {
      assert.deepEqual(callsMade.map(item => item.workflow), [
        "world-narrative-coordinator/begin-deep-operation",
        "world-narrative-coordinator/deep-director-team-planning",
        "world-narrative-coordinator/commit-deep-operation",
      ]);
      assert.deepEqual(callsMade[1].documents, { "story-context": "trigger/story-context" });
      assert.deepEqual(callsMade[2].documents, { report: "team-deep-report.json", references: "team-deep-references.json", basis: "deep-publication-basis.json" });
    }
  }
});

test("team deep wrapper resumes its own running operation instead of abandoning it", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "director-deep-wrapper-resume-"));
  await mkdir(resolve(workspace, "trigger/story-context"), { recursive: true });
  await writeFile(resolve(workspace, "trigger/story-context/DOCUMENTS.md"), "# Frozen story context\n", "utf8");
  const run = { id: "wrapper-resume", turn: 7 };
  const callsMade = [];
  const data = {
    async get(request) {
      if (request.collectionId === "settings") return { value: { enabled: true, deep: { workflowMode: "team" } } };
      if (request.collectionId === "private-state") return { value: { deepRecommendation: { shouldStart: true, reasonCodes: ["resume"] } } };
      if (request.id === "deep-state-current") return { id: request.id, revision: 2, value: { status: "running", currentRunId: "wrapper-resume-deep-operation" } };
      if (request.id === "deep-report-current") return { id: request.id, revision: 1, value: { basisTurn: 0 } };
      throw new Error(`Unexpected request: ${JSON.stringify(request)}`);
    },
    async query() { return { items: [], nextCursor: null }; },
  };
  const calls = { async invoke(request) {
    callsMade.push(structuredClone(request));
    if (request.workflow.endsWith("deep-director-team-planning")) return { callId: "existing-team-child", outputs: { report: "team-deep-report.json", references: "team-deep-references.json" } };
    return { callId: `${request.workflow}-call`, outputs: {} };
  } };
  const result = await runDeepIfNeeded({ run, node: { metadata: {} }, conversation: { messages: [] }, data, calls, workspace });
  assert.equal(result.resumed, true);
  assert.deepEqual(callsMade.map(item => item.workflow), ["world-narrative-coordinator/deep-director-team-planning", "world-narrative-coordinator/commit-deep-operation"]);
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
    query: request => queryData(store, request, { capabilities: request.collectionId === "private-state" ? ["director.private.read"] : request.collectionId === "deep-workbench" ? ["director.deep.read"] : request.collectionId === "reference-library" ? ["director.reference.read"] : ["director.settings.read"], views: [request.view], runtimeLimit: 10000, runtimeCharacters: 2000000, nodeLimit: 10000, nodeCharacters: 2000000 }),
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
