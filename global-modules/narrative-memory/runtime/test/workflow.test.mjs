import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { execute as buildReferenceSnapshot } from "../workflow/build-reference-snapshot.mjs";
import { execute as composeMemory } from "../workflow/compose-memory.mjs";
import { execute as prepareRetrieval } from "../workflow/prepare-retrieval.mjs";
import { execute as prepareArchive } from "../workflow/prepare-archive.mjs";
import { execute as prepareCompression } from "../workflow/prepare-compression.mjs";
import { execute as materializeCompressionSnapshot } from "../workflow/materialize-compression-snapshot.mjs";
import { execute as materializeArchiveTask } from "../workflow/materialize-archive-task.mjs";
import { execute as materializeRangeTask } from "../workflow/materialize-range-task.mjs";
import { execute as materializeMaintenanceTask } from "../workflow/materialize-maintenance-task.mjs";
import { execute as materializeRetrievalTask } from "../workflow/materialize-retrieval-task.mjs";
import { execute as prepareRangeRepair } from "../workflow/prepare-range-repair.mjs";
import { execute as captureSources } from "../workflow/capture-sources.mjs";
import { contiguousCoveredTurn } from "../workflow/commit-range-repair.mjs";

function settings(overrides = {}) {
  return {
    archive: { enabled: true, archiveEveryTurns: 3, protectRecentTurns: 2, referenceEarlierTurns: 2, ...overrides.archive },
    retrieval: { entityQueryLimit: 20, initialInspectLimit: 30, supplementalInspectLimit: 5, informationLimit: 20, elasticInformationLimit: 5, possiblePerQueryLimit: 2, customBudgetInterfaceEnabled: true },
    compression: { enabled: true, initialTriggerEntryCount: 150, initialTargetEntryCount: 90, growthPerSuccessfulCycle: 10, allowManualTrigger: true, ...overrides.compression },
    maintenance: { deterministicAfterCommit: true, injectOverLimitRepairsIntoArchive: true, automaticSemanticAudit: false, manualWorkflowEnabled: true },
  };
}

function mockData({ archiveState = { lastArchivedTurn: 0 }, moduleSettings = settings(), captures = [], events = [] } = {}) {
  return {
    async get(request) {
      if (request.id === "narrative-memory-settings") return { id: request.id, recordType: "memory.settings", revision: 1, value: moduleSettings };
      if (request.id === "narrative-memory-archive-state") return { id: request.id, recordType: "memory.archive-state", revision: 2, value: { lastArchiveStatus: "succeeded", lastArchiveAt: null, lastArchiveRunId: null, lastCoveredMessageId: null, ...archiveState } };
      if (request.id === "narrative-memory-maintenance-state") return { id: request.id, recordType: "memory.maintenance-state", revision: 1, value: { compression: { triggerEntryCount: 150, targetEntryCount: 90, successfulCycleCount: 0, status: "idle", lastRunAt: null, lastRunId: null }, lastDeterministicCheckAt: null, lastDeterministicCheckStatus: "never" } };
      return null;
    },
    async query(request) {
      const items = request.collectionId === "source-captures" ? captures : request.collectionId === "events" && request.view === "maintenance" ? events : [];
      return { items, nextCursor: null };
    },
  };
}

test("archive preparation treats eligible turns as one continuous batch", async () => {
  const messages = [];
  for (let turn = 1; turn <= 5; turn += 1) messages.push({ id: `m${turn}`, revision: 1, binding: { turn }, metadata: { narrativeSource: { producerKind: "agent", layer: "story" } }, data: { role: "assistant", content: `第${turn}轮正文` } });
  const prepared = await prepareArchive({
    run: { turn: 5, trigger: { type: "after-workflow" }, payload: {} },
    conversation: { messages },
    data: mockData(),
  });
  assert.equal(prepared.shouldArchive, true);
  assert.equal(prepared.route, "archive");
  assert.equal(prepared.firstTurn, 1);
  assert.equal(prepared.eligibleLastTurn, 3);
  assert.equal(prepared.lastCoveredMessageId, "m3");
  assert.deepEqual(prepared.coveredMessageIds, ["m1", "m2", "m3"]);
  assert.deepEqual(prepared.sourceMessageIds, ["m1", "m2", "m3"]);
  assert.match(prepared.context["以下为本次归档的剧情"], /第1轮正文/);
  assert.match(prepared.context["以下为本次归档的剧情"], /第3轮正文/);
  assert.doesNotMatch(prepared.context["以下为本次归档的剧情"], /第4轮正文/);
});

test("manual range repair accepts completed ranges independently from automatic archive progress", async () => {
  const messages = [];
  for (let turn = 1; turn <= 6; turn += 1) messages.push({ id: `m${turn}`, revision: turn === 3 ? 2 : 1, binding: { turn }, metadata: { narrativeSource: { producerKind: "agent", layer: "story" } }, data: { role: "assistant", content: `第${turn}轮正文` } });
  const prepared = await prepareRangeRepair({
    run: { arguments: { request: { operation: "supplement", startTurn: 2, endTurn: 4, focus: "补充关系变化" } } },
    conversation: { messages },
    data: mockData({ archiveState: { lastArchivedTurn: 6 } }),
  });
  assert.deepEqual([prepared.firstTurn, prepared.eligibleLastTurn, prepared.operation], [2, 4, "supplement"]);
  assert.deepEqual(prepared.coveredMessageIds, ["m2", "m3", "m4"]);
  assert.match(prepared.context["以下为本次处理的剧情"], /第3轮正文/);
  assert.equal(prepared.context["用户补充要求"], "补充关系变化");
  await assert.rejects(() => prepareRangeRepair({ run: { arguments: { request: { operation: "repair", startTurn: 2, endTurn: 7 } } }, conversation: { messages }, data: mockData() }), /latest completed turn/);
});

test("manual coverage advances only the continuous archive frontier", () => {
  const coverages = [{ value: { startTurn: 6, endTurn: 8 } }, { value: { startTurn: 4, endTurn: 5 } }];
  assert.equal(contiguousCoveredTurn(3, coverages, { firstTurn: 10, eligibleLastTurn: 11 }), 8);
  assert.equal(contiguousCoveredTurn(3, coverages, { firstTurn: 9, eligibleLastTurn: 11 }), 11);
});

test("archive and compression preparation skip commits below their thresholds", async () => {
  const archive = await prepareArchive({
    run: { turn: 2, trigger: { type: "after-workflow" }, payload: {} },
    conversation: { messages: [{ id: "m2", binding: { turn: 2 }, data: { role: "assistant", content: "正文" } }] },
    data: mockData(),
  });
  assert.equal(archive.shouldArchive, false);
  assert.equal(archive.route, "skip");
  assert.equal(archive.reason, "cooldown-or-protection");

  const compression = await prepareCompression({ run: { turn: 2, trigger: { type: "after-workflow" } }, data: mockData() });
  assert.equal(compression.shouldCompress, false);
  assert.equal(compression.route, "skip");
  assert.equal(compression.reason, "below-trigger");
});

test("compression reuses its eligibility read to write the Agent timeline", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-compression-snapshot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let eventQueries = 0;
  const base = mockData({ events: [{ id: "e1", recordType: "memory.event", revision: 1, value: { name: "抵达港口", status: "completed", time: { displayStart: "第一日", sortValue: "0001" }, locationIds: ["harbor"], catalogSummary: "抵达港口" } }] });
  const data = { ...base, async query(request) { if (request.collectionId === "events") eventQueries += 1; return base.query(request); } };
  const run = { id: "compression-1", trigger: { type: "manual" }, nodes: {} };
  const result = await prepareCompression({ run, data });
  run.nodes["prepare-compression"] = { output: result };
  await materializeCompressionSnapshot({ run, workspace });
  assert.equal(result.route, "compress");
  assert.equal(eventQueries, 1);
  assert.match(await readFile(resolve(workspace, "reference-snapshot", "DOCUMENTS.md"), "utf8"), /不再次查询事件/);
  assert.match(await readFile(resolve(workspace, "reference-snapshot", "timeline.md"), "utf8"), /抵达港口/);
});

test("task materializers place effective inputs and usage guidance at the workspace front door", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-task-documents-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await materializeArchiveTask({ run: { nodes: { "prepare-archive": { output: { shouldArchive: true, route: "archive", firstTurn: 1, eligibleLastTurn: 3, context: { "以下为本次归档的剧情": "归档正文" } } } } }, workspace });
  await materializeRangeTask({ run: { nodes: { "prepare-range": { output: { shouldArchive: true, operation: "repair", firstTurn: 2, eligibleLastTurn: 4, context: { "以下为本次处理的剧情": "修复正文" } } } } }, workspace });
  await materializeMaintenanceTask({ run: { nodes: { "prepare-maintenance": { output: { request: { taskType: "merge" }, targets: [{ id: "entity-1", revision: 2 }] } } } }, workspace });
  await materializeRetrievalTask({ run: { nodes: { "prepare-retrieval": { output: { effectiveBudget: { entityQueryLimit: 20 } } } } }, workspace });
  for (const directory of ["archive-task", "range-task", "maintenance-task", "retrieval-task"]) assert.match(await readFile(resolve(workspace, directory, "DOCUMENTS.md"), "utf8"), /使用指导/);
  assert.match(await readFile(resolve(workspace, "archive-task/archive-story.md"), "utf8"), /归档正文/);
  assert.match(await readFile(resolve(workspace, "range-task/range-story.md"), "utf8"), /修复正文/);
  assert.match(await readFile(resolve(workspace, "maintenance-task/targets.md"), "utf8"), /entity-1/);
  assert.match(await readFile(resolve(workspace, "retrieval-task/effective-budget.md"), "utf8"), /entityQueryLimit/);
});

test("reference snapshots independently export filtered catalogs and effective timelines", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-reference-snapshot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const records = {
    entities: [{ id: "lin", recordType: "memory.entity", revision: 1, value: { "名称": "林月", "别名": [], "实体类型": "character", "摘要": "剑修", "模板": "entity.character" } }],
    relationships: [],
    events: [
      { id: "e1", recordType: "memory.event", revision: 1, value: { "名称": "相遇", "摘要": "林月抵达", "状态": "completed", "时间": { displayStart: "第一日", sortValue: "0001" }, "地点": ["gate"] } },
      { id: "s1", recordType: "memory.event-summary", revision: 1, value: { "名称": "入城", "摘要": "抵达并入城", "时间范围": { displayStart: "第一日", startSortValue: "0001", endSortValue: "0001" }, "地点": ["gate"], "直接来源": ["e1"], "覆盖事件": ["e1"], "前置摘要": [], "概况知情范围": { mode: "common", knowerIds: [] } } },
    ],
    cognitions: [],
    "knower-groups": [],
  };
  const queriedCollections = [];
  const fetchedRecords = [];
  const data = {
    async query(request) { queriedCollections.push(request.collectionId); return { items: records[request.collectionId] || [], nextCursor: null }; },
    async get(request) { fetchedRecords.push(`${request.collectionId}/${request.id}`); return (records[request.collectionId] || []).find(item => item.id === request.id) || null; },
  };
  const result = await buildReferenceSnapshot({ run: { arguments: { catalog: { entityIds: ["lin"], entityMode: "entry-only" }, timeline: { mode: "effective" } } }, data, workspace });
  assert.deepEqual(result.documents, ["catalog", "timeline"]);
  assert.match(await readFile(resolve(workspace, "reference-snapshot", "catalog.md"), "utf8"), /id: lin/);
  assert.match(await readFile(resolve(workspace, "reference-snapshot", "DOCUMENTS.md"), "utf8"), /catalog\.md/);
  assert.match(await readFile(resolve(workspace, "reference-snapshot", "timeline.md"), "utf8"), /coveredEventCount: 1/);
  assert.deepEqual(queriedCollections, ["events"]);
  assert.deepEqual(fetchedRecords, ["entities/lin"]);
  await assert.rejects(readFile(resolve(workspace, "reference-snapshot", "snapshot.json"), "utf8"), /ENOENT/);
});

test("exact catalog IDs use targeted gets without preloading catalog collections", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-reference-exact-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const gets = [];
  const data = {
    async query() { throw new Error("exact-ID snapshots must not scan a collection"); },
    async get(request) {
      gets.push(`${request.collectionId}/${request.id}`);
      return request.collectionId === "events" && request.id === "event-7"
        ? { id: "event-7", recordType: "memory.event", revision: 1, value: { "名称": "定点事件", "摘要": "仅取这一条", "状态": "completed", "时间": { displayStart: "第七日", sortValue: "0007" }, "地点": [] } }
        : null;
    },
  };
  const result = await buildReferenceSnapshot({ run: { arguments: { catalog: { collections: ["events"], recordIds: ["event-7"], recordTypes: ["memory.event"] } } }, data, workspace });
  assert.equal(result.catalogEntries, 1);
  assert.deepEqual(gets, ["events/event-7"]);
});

test("retrieval composition emits a document set without an implicit full timeline", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-retrieval-context-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const entity = { id: "lin", recordType: "memory.entity", revision: 1, value: { name: "林月", aliases: [], entityKind: "character", templateMode: "default", templateId: "entity.character", templateVersion: 1, catalogSummary: "剑修", sections: {}, informationBlocks: [], derivedFacets: {}, summaryOverLimit: false } };
  const data = {
    async get(request) {
      if (request.collectionId === "entities" && request.id === "lin") return entity;
      if (request.collectionId === "support" && request.id === "narrative-memory-settings") return { value: { retrieval: settings().retrieval } };
      return null;
    },
    async query() { return { items: [], nextCursor: null }; },
  };
  const result = await composeMemory({
    run: {
      arguments: {},
      nodes: {
        "prepare-retrieval": { output: { effectiveBudget: { entityQueryLimit: 20, initialInspectLimit: 30, supplementalInspectLimit: 5, informationLimit: 20, elasticInformationLimit: 5, possiblePerQueryLimit: 2 } } },
        "memory-retrieval": { output: { queries: [{ query: "林月", kind: "entity", matches: [{ recordId: "lin", recordType: "memory.entity", status: "direct" }] }], restrictedPerspectives: [] } },
      },
    },
    data,
    workspace,
  });
  assert.deepEqual(result.documents, ["general"]);
  const general = await readFile(resolve(workspace, "memory-context", "GENERAL.md"), "utf8");
  assert.match(general, /林月/);
  assert.doesNotMatch(general, /有效事件时间线/);
  assert.match(await readFile(resolve(workspace, "memory-context", "DOCUMENTS.md"), "utf8"), /GENERAL\.md/);
});

test("a match status from the other family is accepted, an unknown status is not", async t => {
  // Real team-meeting failure: the searcher labelled an entity match `confirmed` (a status this module
  // defines for information records) and the whole required base retrieval died on the code node, so
  // the meeting failed and the model never saw an error it could correct. The record type decides how
  // a match renders, so a label from the other vocabulary is usable; anything outside both still fails.
  const entity = { id: "lin", recordType: "memory.entity", revision: 1, value: { name: "林月", aliases: [], entityKind: "character", templateMode: "default", templateId: "entity.character", templateVersion: 1, catalogSummary: "剑修", sections: {}, informationBlocks: [], derivedFacets: {}, summaryOverLimit: false } };
  const event = { id: "event-1", recordType: "memory.event", revision: 1, value: { name: "抵达港口", status: "completed", time: { displayStart: "第三日", sortValue: "0003" }, locations: [], participants: [] } };
  const data = {
    async get(request) {
      if (request.collectionId === "entities" && request.id === "lin") return entity;
      if (request.collectionId === "events" && request.id === "event-1") return event;
      if (request.collectionId === "support" && request.id === "narrative-memory-settings") return { value: { retrieval: settings().retrieval } };
      return null;
    },
    async query(request) { return request.collectionId === "events" ? { items: [event], nextCursor: null } : { items: [], nextCursor: null }; },
  };
  const runWith = (status, { query } = {}) => ({
    arguments: {},
    nodes: {
      "prepare-retrieval": { output: { effectiveBudget: { entityQueryLimit: 20, initialInspectLimit: 30, supplementalInspectLimit: 5, informationLimit: 20, elasticInformationLimit: 5, possiblePerQueryLimit: 2 } } },
      "memory-retrieval": { output: { queries: [query || { query: "林月", kind: "entity", matches: [{ recordId: "lin", recordType: "memory.entity", status }] }], restrictedPerspectives: [] } },
    },
  });
  const accepted = await mkdtemp(join(tmpdir(), "memory-cross-family-status-"));
  t.after(() => rm(accepted, { recursive: true, force: true }));
  const result = await composeMemory({ run: runWith("confirmed"), data, workspace: accepted });
  assert.deepEqual(result.documents, ["general"]);
  assert.match(await readFile(resolve(accepted, "memory-context", "GENERAL.md"), "utf8"), /林月/);

  // The other direction is the same rule: an entity-family label on an information record is kept.
  const otherDirection = await mkdtemp(join(tmpdir(), "memory-cross-family-status-"));
  t.after(() => rm(otherDirection, { recursive: true, force: true }));
  await composeMemory({ run: runWith(null, { query: { query: "抵达港口", kind: "information", matches: [{ recordId: "event-1", recordType: "memory.event", status: "related" }] } }), data, workspace: otherDirection });
  assert.match(await readFile(resolve(otherDirection, "memory-context", "GENERAL.md"), "utf8"), /抵达港口/);

  const rejected = await mkdtemp(join(tmpdir(), "memory-unknown-status-"));
  t.after(() => rm(rejected, { recursive: true, force: true }));
  await assert.rejects(() => composeMemory({ run: runWith("maybe"), data, workspace: rejected }), /Invalid match status maybe/);
});

test("source capture accepts a stable caller ID and skips an existing capture on retry", async () => {
  const submitted = [];
  let existing = false;
  const data = {
    async get(request) { return existing && request.id === "memory-source-candidate-1" ? { id: request.id } : null; },
    async submit(batch) { submitted.push(batch); existing = true; return { id: batch.batchId, status: "committed" }; },
  };
  const run = { id: "capture-run", turn: 4, arguments: { request: { captures: [{ captureId: "memory-source-candidate-1", sourceModuleId: "local-scene-narrative", adapterId: "local-story", title: "故事", historyMode: "per-turn", format: "json", content: {}, sourceReferences: [] }] } } };
  assert.equal((await captureSources({ run, data })).committed, true);
  assert.equal(submitted[0].operations[0].targetId, "memory-source-candidate-1");
  assert.equal((await captureSources({ run: { ...run, id: "capture-retry" }, data })).reason, "already-captured");
  assert.equal(submitted.length, 1);
});

test("retrieval preparation gives Agent and composer one persisted effective budget", async () => {
  const defaults = { entityQueryLimit: 20, initialInspectLimit: 30, supplementalInspectLimit: 5, informationLimit: 20, elasticInformationLimit: 5, possiblePerQueryLimit: 2, customBudgetInterfaceEnabled: false };
  const data = { async get() { return { value: { retrieval: defaults } }; } };
  const ignored = await prepareRetrieval({ run: { arguments: { budget: { ...defaults, informationLimit: 40 } } }, data });
  assert.equal(ignored.customBudgetApplied, false);
  assert.equal(ignored.effectiveBudget.informationLimit, 20);
  const enabledData = { async get() { return { value: { retrieval: { ...defaults, customBudgetInterfaceEnabled: true } } }; } };
  const applied = await prepareRetrieval({ run: { arguments: { budget: { ...defaults, informationLimit: 40 } } }, data: enabledData });
  assert.equal(applied.customBudgetApplied, true);
  assert.equal(applied.effectiveBudget.informationLimit, 40);
});
