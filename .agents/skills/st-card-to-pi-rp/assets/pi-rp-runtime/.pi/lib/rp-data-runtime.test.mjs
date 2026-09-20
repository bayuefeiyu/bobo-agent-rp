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
import { commitDataFiles, inspectDataImpact, inspectDataIntegrity, recoverDataTransactions } from "./rp-data-transactions.mjs";

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

test("initial records and hybrid baseline bind the session player without rewriting the card", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-data-player-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "module");
  const initialPath = join(moduleDirectory, "initial.json");
  await mkdir(moduleDirectory, { recursive: true });
  const seed = {
    protocolVersion: 2, id: "rumor.seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", dataSchemaVersion: 1, revision: 1, sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "active",
    provenance: { source: "initial" }, binding: { messageId: null, turn: 0 }, data: { content: "{{user}}在场", source: "character.queen", spread: 0 }, note: null,
  };
  await writeFile(initialPath, JSON.stringify(seed), "utf8");
  const seededContract = structuredClone(contract);
  seededContract.collections.entries.storage.initialSnapshotFile = "initial.json";
  const sessionDirectory = join(root, "session");
  const first = new RpDataStore({ sessionDirectory, modules: [{ contract: seededContract, moduleDirectory }], playerName: "林$&舟" });
  await first.initialize();
  assert.equal((await first.readCollection("rumors", "entries")).records[0].data.content, "林$&舟在场");
  await writeFile(join(sessionDirectory, "session.json"), JSON.stringify({ playerName: "林$&舟" }), "utf8");
  const resumed = new RpDataStore({ sessionDirectory, modules: [{ contract: seededContract, moduleDirectory }] });
  assert.equal((await resumed.readCollection("rumors", "entries")).records[0].data.content, "林$&舟在场");
  assert.equal(JSON.parse(await readFile(initialPath, "utf8")).data.content, "{{user}}在场");
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

test("a corrupted derived index is rebuilt and announced instead of failing the query", async t => {
  const { store } = await fixture(t);
  await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "batch-corrupt-index",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "op-corrupt-index", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.queen", data: { content: "王冠是赝品", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => { warnings.push(String(message)); };
  try {
    await writeFile(join(store.sessionDirectory, "indexes", "rumors.json"), "{\"schemaVersion\": 1, \"entries\": [", "utf8");
    const index = await store.readIndex("rumors");
    assert.equal(index.entries.length, 1);
    assert.equal(JSON.parse(await readFile(join(store.sessionDirectory, "indexes", "rumors.json"), "utf8")).entries.length, 1);

    await writeFile(join(store.sessionDirectory, "indexes", "identities.json"), "not json at all", "utf8");
    // This module declares no identity-bearing record type, so a successful repair resolves nothing —
    // what matters is that the call returns instead of throwing and leaves a usable registry behind.
    assert.deepEqual(await store.resolveIdentity("rumor.queen"), []);
    const rebuilt = JSON.parse(await readFile(join(store.sessionDirectory, "indexes", "identities.json"), "utf8"));
    assert.equal(Array.isArray(rebuilt.entries), true);

    // Authoritative data is not repair-on-read: a damaged snapshot must still fail loudly.
    await writeFile(join(store.collectionRoot("rumors", "entries"), "snapshot.json"), "{broken", "utf8");
    await assert.rejects(store.readCollection("rumors", "entries"), SyntaxError);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /indexes\/rumors\.json was unreadable/);
  assert.match(warnings[1], /indexes\/identities\.json was unreadable/);
});

test("hybrid pruning keeps a deleted seeded record deleted", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-data-hybrid-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "card", "features", "field-notes");
  await mkdir(join(moduleDirectory, "collections", "notes", "initial"), { recursive: true });
  // A card-shipped initial record: `readCollection` re-seeds it into the history view on every read,
  // which is exactly why pruning must take `records` from the snapshot rather than from history.
  await writeFile(join(moduleDirectory, "collections", "notes", "initial", "snapshot.json"), JSON.stringify({
    protocolVersion: 2, id: "note.seeded", moduleId: "field-notes", collectionId: "notes", recordType: "note.entry", dataSchemaVersion: 1, revision: 1, sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "active",
    provenance: { source: "initial" }, binding: { messageId: "message.seeded", turn: 0 }, data: { text: "卡内初始记录" }, note: null,
  }), "utf8");
  const notesContract = normalizeDataContract({
    schemaVersion: 1,
    moduleId: "field-notes",
    collections: {
      notes: {
        storage: { kind: "hybrid", partition: { mode: "single" }, initialSnapshotFile: "collections/notes/initial/snapshot.json" },
        recordTypes: { "note.entry": { dataSchemaVersion: 1, indexes: {}, searchableFields: [], views: { rp: { format: "text", fields: [{ path: "/data/text" }] } }, actions: ["create", "delete"] } },
      },
    },
    capabilities: {
      "note.query": { collections: ["notes"], actions: ["query"], views: ["rp"] },
      "note.write": { collections: ["notes"], actions: ["create", "delete"], views: [] },
    },
  });
  const store = new RpDataStore({ sessionDirectory: join(root, "session"), modules: [{ contract: notesContract, moduleDirectory }] });
  await store.initialize();
  assert.deepEqual((await store.readCollection("field-notes", "notes")).records.map(record => record.id), ["note.seeded"]);

  const submit = (batchId, operations, messageId) => executeDataBatch(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations }, {
    access: { "field-notes": ["note.write"] },
    context: { binding: { turn: 1, messageId } },
  });
  const created = await submit("note-create", [{ operationId: "create", moduleId: "field-notes", collectionId: "notes", recordType: "note.entry", action: "create", targetId: "note.later", data: { text: "后来的一轮" } }], "message.later");
  assert.equal(created.status, "committed");
  const deleted = await submit("note-delete", [{ operationId: "delete", moduleId: "field-notes", collectionId: "notes", recordType: "note.entry", action: "delete", targetId: "note.seeded", expectedRevision: 1 }], "message.seeded");
  assert.equal(deleted.status, "committed");
  assert.deepEqual((await store.readCollection("field-notes", "notes")).records.map(record => record.id), ["note.later"]);

  // Pruning an unrelated message must not write the deleted record back into the authority.
  await store.pruneByMessageIds(["message.later"]);
  assert.deepEqual((await store.readCollection("field-notes", "notes")).records.map(record => record.id), []);
  assert.deepEqual(JSON.parse(await readFile(join(store.collectionRoot("field-notes", "notes"), "snapshot.json"), "utf8")), []);
});

test("a failed batch is re-executed instead of being replayed from its own failure", async t => {
  const { store } = await fixture(t);
  const seed = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "retry-seed",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.retry", data: { content: "初始", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 1, messageId: null } } });
  assert.equal(seed.status, "committed");
  const batch = {
    protocolVersion: 1,
    batchId: "retry-update",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "update", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.retry", expectedRevision: 5, data: { content: "过期版本", source: "character.queen" } }],
  };
  const first = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 2, messageId: null } } });
  assert.equal(first.status, "failed");
  assert.equal(first.results[0].code, "revision_conflict");

  // Byte-identical retry: the same failure must come from re-running, not from the stored receipt.
  const retry = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 2, messageId: null } } });
  assert.equal(retry.idempotentReplay ?? false, false);
  assert.notEqual(retry.runtimeReceiptId, first.runtimeReceiptId);
  assert.equal(retry.status, "failed");
  assert.equal(retry.results[0].code, "revision_conflict");

  // Once the revision guard is satisfied, the same batch ID finally commits.
  const corrected = await executeDataBatch(store, { ...batch, operations: [{ ...batch.operations[0], expectedRevision: 1 }] }, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 2, messageId: null } } });
  assert.equal(corrected.status, "committed");
  assert.equal((await store.readCollection("rumors", "entries")).records[0].data.content, "过期版本");

  // An outcome that did land stays idempotent, and a conflicting replay is still refused.
  const replay = await executeDataBatch(store, { ...batch, operations: [{ ...batch.operations[0], expectedRevision: 1 }] }, { access: { rumors: ["rumor.write"] } });
  assert.equal(replay.idempotentReplay, true);
  const conflict = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] } });
  assert.equal(conflict.results[0].code, "idempotency_conflict");
});

test("a partial receipt is still replayed idempotently", async t => {
  const { store } = await fixture(t);
  const access = { access: { rumors: ["rumor.write"] } };
  await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "partial-seed",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.taken", data: { content: "已存在", source: "character.queen" } }],
  }, access);
  const batch = {
    protocolVersion: 1,
    batchId: "partial-batch",
    status: "pending",
    commitPolicy: "grouped",
    operations: [
      { operationId: "ok", groupId: "first", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.fresh", data: { content: "新的", source: "character.queen" } },
      { operationId: "duplicate", groupId: "second", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.taken", data: { content: "重复", source: "character.queen" } },
    ],
  };
  const partial = await executeDataBatch(store, batch, access);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.results.map(result => result.status), ["committed", "failed"]);
  const replay = await executeDataBatch(store, batch, access);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.status, "partial");
  assert.equal((await store.readCollection("rumors", "entries")).history.length, 2);
});

test("a throw after commit returns the persisted outcome instead of overwriting it", async t => {
  const { store } = await fixture(t);
  const seed = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "commit-boundary-seed",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "seed", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", targetId: "rumor.boundary", data: { content: "写入前", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 1, messageId: null } } });
  assert.equal(seed.status, "committed");

  // A host wrapper throws after the transaction has already persisted its success receipt. The
  // receipt is the commit marker, so the caller must still see success and replay it idempotently.
  const realCommit = store.commit.bind(store);
  let failAfterWriting = true;
  store.commit = async (...args) => {
    const result = await realCommit(...args);
    if (failAfterWriting) {
      failAfterWriting = false;
      throw new Error("the commit transaction failed after writing its files");
    }
    return result;
  };
  const batch = {
    protocolVersion: 1,
    batchId: "commit-boundary-update",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "update", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "update", targetId: "rumor.boundary", expectedRevision: 1, data: { content: "写入后", source: "character.queen" } }],
  };
  const interrupted = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 2, messageId: null } } });
  assert.equal(interrupted.status, "committed");
  assert.equal(interrupted.recoveredAfterCommitError, true);
  const written = (await store.readCollection("rumors", "entries")).records[0];
  assert.equal(written.revision, 2);

  const retried = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] }, context: { binding: { turn: 2, messageId: null } } });
  assert.equal(retried.idempotentReplay, true);
  assert.equal(retried.status, "committed");
  const afterRetry = (await store.readCollection("rumors", "entries")).records[0];
  assert.equal(afterRetry.revision, 2);
  assert.equal(afterRetry.data.content, "写入后");
});

test("a create without targetId is not duplicated when a host throws after commit", async t => {
  const { store } = await fixture(t);
  const realCommit = store.commit.bind(store);
  let failAfterWriting = true;
  store.commit = async (...args) => {
    const result = await realCommit(...args);
    if (failAfterWriting) {
      failAfterWriting = false;
      throw new Error("host failed after the transaction committed");
    }
    return result;
  };
  const batch = {
    protocolVersion: 1,
    batchId: "commit-boundary-create",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", data: { content: "唯一事件", source: "character.queen" } }],
  };
  const first = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] } });
  const replay = await executeDataBatch(store, batch, { access: { rumors: ["rumor.write"] } });
  assert.equal(first.status, "committed");
  assert.equal(first.recoveredAfterCommitError, true);
  assert.equal(replay.idempotentReplay, true);
  const records = (await store.readCollection("rumors", "entries")).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].provenance.batchId, batch.batchId);
  assert.equal(records[0].provenance.operationId, "create");
});

test("an unresolved transaction journal blocks batch re-execution", async t => {
  const { store } = await fixture(t);
  const transactionRoot = join(store.sessionDirectory, "workspace", "transactions");
  await mkdir(transactionRoot, { recursive: true });
  await writeFile(join(transactionRoot, "unknown-batch.json"), JSON.stringify({ schemaVersion: 1, batchId: "unknown-batch", status: "rollback-failed", entries: [] }), "utf8");
  const receipt = await executeDataBatch(store, {
    protocolVersion: 1,
    batchId: "unknown-batch",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "create", moduleId: "rumors", collectionId: "entries", recordType: "rumor.entry", action: "create", data: { content: "不得落地", source: "character.queen" } }],
  }, { access: { rumors: ["rumor.write"] } });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.results[0].code, "commit_outcome_unknown");
  assert.equal((await store.readCollection("rumors", "entries")).records.length, 0);
});

test("startup recovery completes an interrupted rollback before allowing later work", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDirectory = join(root, "session");
  const transactionRoot = join(sessionDirectory, "workspace", "transactions");
  const stagingRoot = join(transactionRoot, "recover-batch");
  const target = join(sessionDirectory, "modules", "state.json");
  const backup = join(stagingRoot, "000000.previous");
  await mkdir(join(target, ".."), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(target, "partially-applied", "utf8");
  await writeFile(backup, "before", "utf8");
  await writeFile(join(transactionRoot, "recover-batch.json"), JSON.stringify({
    schemaVersion: 1,
    batchId: "recover-batch",
    status: "rollback-failed",
    entries: [{ target, backup, existed: true }],
  }), "utf8");

  assert.deepEqual(await recoverDataTransactions(sessionDirectory), ["recover-batch"]);
  assert.equal(await readFile(target, "utf8"), "before");
  const journal = JSON.parse(await readFile(join(transactionRoot, "recover-batch.json"), "utf8"));
  assert.equal(journal.status, "recovered-rolled-back");
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
  await assert.rejects(
    commitDataFiles(sessionDirectory, "rollback-test", [{ path: first, content: "after" }, { path: invalidTarget, content: "cannot replace directory" }], { batchId: "rollback-test" }),
    error => error.transactionOutcome === "rolled-back",
  );
  assert.equal(await readFile(first, "utf8"), "before");
});
