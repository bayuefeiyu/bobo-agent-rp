import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { executeDataBatch } from "./rp-data-changes.mjs";
import { queryData } from "./rp-data-query.mjs";
import { commitDataFiles } from "./rp-data-transactions.mjs";

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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rp-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "card", "features", "rumors");
  const store = new RpDataStore({ sessionDirectory: join(root, "session"), modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  return { root, store };
}

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
