import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { assertCommittedDataReceipt, executeDataBatch, executeDataBatchOrThrow } from "./rp-data-changes.mjs";
import { getDataRecord, getDataRecordHistory, queryData, queryDataStable } from "./rp-data-query.mjs";
import { createDataReadView, readDataReadViewCollection } from "./rp-data-read-view.mjs";
import { commitDataFiles, inspectDataImpact, inspectDataIntegrity } from "./rp-data-transactions.mjs";

const contract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "rumors",
  collections: {
    entries: {
      storage: { kind: "hybrid", partition: { mode: "index", index: "source", fallback: "unknown" } },
      recordTypes: {
        "rumor.entry": {
          dataSchemaVersion: 1,
          indexes: {
            source: { path: "/data/source", type: "id", operators: ["eq"] },
            spread: { path: "/data/spread", type: "number", default: 0, operators: ["eq", "gte", "lte"] },
          },
          searchableFields: ["/data/content"],
          views: { rp: { format: "text", fields: [{ path: "/data/content" }] } },
          actions: ["create", "update", "archive", "restore", "delete", "increase-spread"],
          processors: { "increase-spread": { file: "runtime/increase-spread.mjs", export: "increaseSpread" } },
        },
      },
    },
  },
  capabilities: {
    "rumor.query": { collections: ["entries"], actions: ["query"], views: ["rp"] },
    "rumor.write": { collections: ["entries"], actions: ["create", "update", "archive", "restore", "delete", "increase-spread"], views: [] },
  },
});

test("strict data submissions accept committed receipts and reject failed or partial receipts", async () => {
  const committed = { batchId: "ok", status: "committed", results: [] };
  assert.equal(assertCommittedDataReceipt(committed), committed);
  for (const status of ["failed", "partial"]) {
    const receipt = { batchId: `batch-${status}`, status, results: [{ status: "failed", code: "revision_conflict", error: "stale revision" }] };
    assert.throws(() => assertCommittedDataReceipt(receipt), error => {
      assert.equal(error.code, "revision_conflict");
      assert.equal(error.receipt, receipt);
      return true;
    });
  }
  await assert.rejects(executeDataBatchOrThrow({}, {}, { }), /must be an object|protocolVersion|batch/i);
});

test("module profile settings override only the initial session snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-data-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "module");
  await mkdir(join(moduleDirectory, "collections", "settings", "initial"), { recursive: true });
  await writeFile(join(moduleDirectory, "collections", "settings", "initial", "snapshot.json"), JSON.stringify({
    protocolVersion: 2, id: "settings", moduleId: "settings-module", collectionId: "settings", recordType: "settings.value", dataSchemaVersion: 1, revision: 1, sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "active",
    provenance: { source: "initial" }, binding: { messageId: null, turn: 0 }, data: { archive: { interval: 10 }, enabled: true }, note: null,
  }), "utf8");
  const settingsContract = normalizeDataContract({
    schemaVersion: 1, moduleId: "settings-module",
    collections: { settings: { storage: { kind: "snapshot", partition: { mode: "single" }, initialSnapshotFile: "collections/settings/initial/snapshot.json" }, recordTypes: { "settings.value": { dataSchemaVersion: 1, indexes: {}, searchableFields: [], views: {}, actions: ["update"] } } } },
    capabilities: {},
  });
  const sessionDirectory = join(root, "session");
  const first = new RpDataStore({ sessionDirectory, modules: [{ contract: settingsContract, moduleDirectory }], initialOverrides: { "settings-module": { archive: { interval: 3 } } } });
  await first.initialize();
  assert.deepEqual((await first.readCollection("settings-module", "settings")).records[0].data, { archive: { interval: 3 }, enabled: true });
  const second = new RpDataStore({ sessionDirectory, modules: [{ contract: settingsContract, moduleDirectory }], initialOverrides: { "settings-module": { archive: { interval: 99 } } } });
  await second.initialize();
  assert.equal((await second.readCollection("settings-module", "settings")).records[0].data.archive.interval, 3);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rp-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "card", "features", "rumors");
  const store = new RpDataStore({ sessionDirectory: join(root, "session"), modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  return { root, store };
}

test("a persisted data read view exposes only causally accepted batches, including deletions", async t => {
  const { store } = await fixture(t);
  const view = await createDataReadView({ sessionDirectory: store.sessionDirectory, store, sourceId: "root-run" });
  const submit = (batchId, operations) => executeDataBatch(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations }, {
    access: { rumors: ["rumor.write"] },
    context: { workflowId: "child", workflowRunId: batchId, nodeId: "commit", binding: { turn: 1, messageId: null } },
  });
  const accepted = await submit("causal-create", [{ operationId: "create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.causal", data: { content: "causal", source: "character.queen" } }]);
  await submit("unrelated-create", [{ operationId: "create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.unrelated", data: { content: "unrelated", source: "character.queen" } }]);
  assert.equal(accepted.results[0].record.id, "rumor.causal");
  const readCollection = (moduleId, collectionId) => readDataReadViewCollection({ sessionDirectory: store.sessionDirectory, store, viewId: view.viewId, batchIds: ["causal-create"], moduleId, collectionId });
  const visible = await queryData(store, { moduleId: "rumors", collectionId: "entries", view: "rp" }, { capabilities: ["rumor.query"], views: ["rp"], runtimeLimit: 20, readCollection });
  assert.deepEqual(visible.items.map(item => item.id), ["rumor.causal"]);
  const deleted = await submit("causal-delete", [{ operationId: "delete", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "delete", targetId: "rumor.causal", expectedRevision: 1 }]);
  assert.equal(deleted.results[0].action, "delete");
  assert.equal(deleted.results[0].record, null);
  const afterDelete = await readDataReadViewCollection({ sessionDirectory: store.sessionDirectory, store, viewId: view.viewId, batchIds: ["causal-create", "causal-delete"], moduleId: "rumors", collectionId: "entries" });
  assert.deepEqual(afterDelete.records, []);
});

test("unified batches commit, index, query, budget, and replay idempotently", async t => {
  const { store } = await fixture(t);
  const batch = {
    protocolVersion: 1,
    batchId: "batch-create",
    status: "pending",
    commitPolicy: "atomic",
    operations: [
      { operationId: "op-one", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.one", data: { content: "王冠是赝品", source: "character.queen", spread: 8 } },
      { operationId: "op-two", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.two", data: { content: "厨房存在密道", source: "character.guard", spread: 3 } },
    ],
  };
  const receipt = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, context: { initiatorKind: "agent", nodeId: "update", binding: { turn: 4 } } });
  assert.equal(receipt.status, "committed");
  const replay = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] } });
  assert.equal(replay.idempotentReplay, true);
  const conflictingReplay = await executeDataBatch(store, { ...batch, operations: [{ ...batch.operations[0], data: { ...batch.operations[0].data, content: "被篡改" } }] }, { access: { rumors: ["rumor.write"] } });
  assert.equal(conflictingReplay.results[0].code, "idempotency_conflict");
  const result = await queryData(store, { moduleId: "rumors", collectionId: "entries", where: { spread: { gte: 3 } }, search: { query: "王冠" }, view: "rp", limit: 10 }, { capabilities: ["rumor.query"], runtimeLimit: 20, runtimeCharacters: 100 });
  assert.deepEqual(result.items.map(item => item.value), ["王冠是赝品"]);
  assert.equal(result.matched, 1);
  const bounded = await queryData(store, { moduleId: "rumors", collectionId: "entries", view: "rp", limit: 20 }, { capabilities: ["rumor.query"], runtimeLimit: 1, runtimeCharacters: 100 });
  assert.equal(bounded.returned, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.nextCursor, "offset:1");
  await assert.rejects(queryData(store, { moduleId: "rumors", collectionId: "entries", view: "full" }, { capabilities: ["rumor.write"], views: ["rp"] }), /not granted view full/);
});

test("revision conflicts and permissions reject silent writes", async t => {
  const { store } = await fixture(t);
  await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-seed",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.one", data: { content: "旧内容", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  const conflict = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-conflict",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-conflict", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.one", expectedRevision: 2, data: { content: "新内容", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.results[0].code, "revision_conflict");
  const unguarded = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-unguarded",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-unguarded", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.one", data: { content: "无版本保护", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  assert.equal(unguarded.results[0].code, "expected_revision_required");
  const denied = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-denied",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-denied", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "archive", targetId: "rumor.one" }],
  }, { access: { rumors: ["rumor.query"] } });
  assert.equal(denied.results[0].code, "permission_denied");
  const state = await store.readCollection("rumors", "entries");
  assert.equal(state.records[0].revision, 1);
  assert.equal(state.records[0].status, "active");
});

test("workflow data reads honor the frozen visible-through turn and historical revision", async t => {
  const { store } = await fixture(t);
  const writeAccess = { rumors: ["rumor.write"] };
  await executeDataBatch(store, { protocolVersion: 1, batchId: "visible-create", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "visible-create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.visible", data: { content: "turn two", source: "character.queen" } }] }, { access: writeAccess, context: { initiatorKind: "code", binding: { turn: 2, messageId: null } } });
  const readAccess = { capabilities: ["rumor.query"], views: ["rp"], runtimeLimit: 20, runtimeCharacters: 1000, visibleThroughTurn: 1 };
  assert.equal(await getDataRecord(store, { moduleId: "rumors", collectionId: "entries", id: "rumor.visible", view: "rp" }, readAccess), null);
  assert.equal((await queryData(store, { moduleId: "rumors", collectionId: "entries", view: "rp" }, readAccess)).returned, 0);
  const revisionOne = (await store.readCollection("rumors", "entries")).records[0];
  const readSnapshotAt = new Date().toISOString();
  await new Promise(resolve => setTimeout(resolve, 2));
  await executeDataBatch(store, { protocolVersion: 1, batchId: "visible-update", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "visible-update", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.visible", expectedRevision: revisionOne.revision, data: { content: "turn three", source: "character.queen" } }] }, { access: writeAccess, context: { initiatorKind: "code", binding: { turn: 3, messageId: null } } });
  const historical = await getDataRecord(store, { moduleId: "rumors", collectionId: "entries", id: "rumor.visible", view: "rp" }, { ...readAccess, visibleThroughTurn: 2, visibleThroughTime: readSnapshotAt });
  assert.equal(historical.value, "turn two");
  assert.equal(historical.revision, 1);
});

test("data receipts retain exact input revisions and impact inspection is read-only", async t => {
  const { store } = await fixture(t);
  const sourceReferences = [
    { kind: "message", id: "message.one", revision: 1, narrativeSource: { producerKind: "user", layer: "in-world" } },
    { kind: "message", id: "message.two", revision: 3, narrativeSource: { producerKind: "agent", producerId: "writer", layer: "story" } },
  ];
  const receipt = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-sourced",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-sourced", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.sourced", data: { content: "有来源", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] }, context: { workflowId: "archive", workflowRunId: "run.1", nodeId: "commit", binding: { turn: 9, messageId: "message.two" }, sourceReferences } });
  assert.deepEqual(receipt.sourceReferences.map(item => [item.id, item.revision]), [["message.one", 1], ["message.two", 3]]);
  assert.equal(receipt.targets[0].moduleId, "rumors");
  const record = (await store.readCollection("rumors", "entries")).records[0];
  assert.deepEqual(record.provenance.sourceReferences, receipt.sourceReferences);
  const before = JSON.stringify(record);
  const impact = await inspectDataImpact(store.sessionDirectory, { messageId: "message.two", revision: 3, allowedModuleIds: ["rumors"] });
  assert.equal(impact.matched, true);
  assert.equal(impact.batches[0].batchId, "batch-sourced");
  assert.deepEqual(impact.batches[0].matchedRevisions, [3]);
  assert.equal(JSON.stringify((await store.readCollection("rumors", "entries")).records[0]), before);
  assert.equal((await inspectDataImpact(store.sessionDirectory, { messageId: "message.two", revision: 2 })).matched, false);
  assert.equal((await inspectDataImpact(store.sessionDirectory, { messageId: "message.two", revision: 3, allowedModuleIds: ["other"] })).matched, false);
  const changed = await inspectDataIntegrity(store.sessionDirectory, { messages: [{ id: "message.two", revision: 4, binding: { turn: 9 } }], allowedModuleIds: ["rumors"] });
  assert.deepEqual(changed.issues.map(item => [item.type, item.startTurn, item.recordedRevisions, item.currentRevision]), [["source-revised", 9, [3], 4]]);
});

test("frontend keyset pagination remains stable while records are added and revised", async t => {
  const { store } = await fixture(t);
  const create = (batchId, id, content) => executeDataBatch(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `op-${batchId}`, moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: id, data: { content, source: "character.queen" } }] }, { access: { rumors: ["rumor.write"] } });
  await create("stable-one", "rumor.one", "一");
  await create("stable-two", "rumor.two", "二");
  const access = { capabilities: ["rumor.query"], views: ["rp"], runtimeLimit: 1, runtimeCharacters: 1000 };
  const first = await queryDataStable(store, { moduleId: "rumors", collectionId: "entries", view: "rp", limit: 1 }, access);
  assert.deepEqual(first.items.map(item => item.id), ["rumor.one"]);
  await create("stable-three", "rumor.three", "三");
  await executeDataBatch(store, { protocolVersion: 1, batchId: "stable-revise", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "op-stable-revise", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.one", expectedRevision: 1, data: { content: "一改", source: "character.queen" } }] }, { access: { rumors: ["rumor.write"] } });
  const second = await queryDataStable(store, { moduleId: "rumors", collectionId: "entries", view: "rp", limit: 1, cursor: first.nextCursor }, access);
  const third = await queryDataStable(store, { moduleId: "rumors", collectionId: "entries", view: "rp", limit: 1, cursor: second.nextCursor }, access);
  assert.deepEqual([second.items[0].id, third.items[0].id], ["rumor.two", "rumor.three"]);
  const history = await getDataRecordHistory(store, { moduleId: "rumors", collectionId: "entries", id: "rumor.one", view: "rp", limit: 10 }, { capabilities: ["rumor.query"], views: ["rp"], runtimeLimit: 10 });
  assert.deepEqual(history.items.map(item => item.revision), [2, 1]);
});

test("best-effort commits require explicit workflow authorization", async t => {
  const { store } = await fixture(t);
  const batch = {
    protocolVersion: 1,
    batchId: "best-effort",
    status: "pending",
    commitPolicy: "best-effort",
    operations: [{ operationId: "create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.best", data: { content: "分步提交", source: "character.queen" } }],
  };
  await assert.rejects(executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] } }), /does not allow best-effort/);
  const receipt = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, allowBestEffort: true });
  assert.equal(receipt.status, "committed");
});

test("derived indexes can be removed and rebuilt from authoritative data", async t => {
  const { store } = await fixture(t);
  await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-index",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-index", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", data: { content: "内容", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  await rm(join(store.sessionDirectory, "indexes"), { recursive: true, force: true });
  await store.rebuildIndexes();
  const index = JSON.parse(await readFile(join(store.sessionDirectory, "indexes", "rumors.json"), "utf8"));
  assert.equal(index.entries.length, 1);
});

test("module-local processors implement guarded custom record operations", async t => {
  const { store } = await fixture(t);
  const runtime = join(store.module("rumors").moduleDirectory, "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "increase-spread.mjs"), `export function increaseSpread({ current, operation }) {
    return { record: { data: { ...current.data, spread: current.data.spread + operation.params.amount } } };
  }`, "utf8");
  await executeDataBatch(store, { protocolVersion: 1, batchId: "processor-seed", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.processor", data: { content: "处理器", source: "character.queen", spread: 1 } }] }, { access: { rumors: ["rumor.write"] } });
  const receipt = await executeDataBatch(store, { protocolVersion: 1, batchId: "processor-run", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "increase", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "increase-spread", targetId: "rumor.processor", expectedRevision: 1, params: { amount: 2 } }] }, { access: { rumors: ["rumor.write"] } });
  assert.equal(receipt.status, "committed");
  const updated = (await store.readCollection("rumors", "entries")).records[0];
  assert.equal(updated.data.spread, 3);
  assert.equal(updated.revision, 2);
  assert.equal(updated.provenance.operationId, "increase");
});

test("multi-file transaction failure restores an already replaced target", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDirectory = join(root, "session");
  const first = join(sessionDirectory, "modules", "state.json");
  const invalidTarget = join(sessionDirectory, "modules", "directory-target");
  await mkdir(join(first, ".."), { recursive: true });
  await mkdir(invalidTarget, { recursive: true });
  await writeFile(first, "before", "utf8");
  await assert.rejects(commitDataFiles(sessionDirectory, "rollback-test", [{ path: first, content: "after" }, { path: invalidTarget, content: "cannot replace directory" }], { batchId: "rollback-test" }));
  assert.equal(await readFile(first, "utf8"), "before");
});
