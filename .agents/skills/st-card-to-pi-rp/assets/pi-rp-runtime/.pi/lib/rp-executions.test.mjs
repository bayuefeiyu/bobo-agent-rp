import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpDataStore } from "./rp-data-store.mjs";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { executeDataBatchOrThrow } from "./rp-data-changes.mjs";
import { createExecutionService, executionDataStore } from "./rp-executions.mjs";

const contract = normalizeDataContract({ schemaVersion: 1, moduleId: "test", collections: {
  notes: { storage: { kind: "record-log", partition: { mode: "single" } }, recordTypes: {
    note: { dataSchemaVersion: 1, indexes: {}, searchableFields: [], views: { rp: { format: "object", fields: [{ path: "/data/value" }] } }, actions: ["create", "update", "delete"] },
  } },
}, capabilities: { write: { collections: ["notes"], actions: ["create", "update", "delete"], views: [] } } }, "test");
const access = [{ moduleId: "test", collectionId: "notes", capabilities: ["write"], views: [] }];
async function fixture(t, executionScope) {
  const directory = await mkdtemp(join(tmpdir(), "rp-executions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const effective = executionScope ? { ...contract, collections: { notes: { ...contract.collections.notes, executionScope } } } : contract;
  const store = new RpDataStore({ sessionDirectory: directory, modules: [{ contract: effective, moduleDirectory: directory }] });
  await store.initialize();
  const service = createExecutionService(store);
  await service.beginTurn(1);
  return { store, service };
}
async function write(store, { id = "item", value = 1, action = "create", revision, turn = 1, batch = "batch" } = {}) {
  return executeDataBatchOrThrow(store, { protocolVersion: 1, batchId: batch, status: "pending", commitPolicy: "atomic", operations: [{ operationId: "op", moduleId: "test", collectionId: "notes", recordType: "note", action, targetId: id, data: { value }, ...(revision ? { expectedRevision: revision } : {}) }] }, { access, context: { binding: { turn, messageId: null } } });
}
const start = (service, id, rest = {}) => service.start({ id, workflowId: "test/work", turn: 1, invocation: { logicalCallId: "task" }, ...rest });
const valueOf = async store => (await store.readCollection("test", "notes")).records.map(record => record.data.value);

test("fresh executions isolate data and namespace module batch IDs", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await start(service, "b");
  await write(executionDataStore(store, "a"));
  await write(executionDataStore(store, "b"), { value: 2 });
  assert.deepEqual(await valueOf(store), []);
  assert.deepEqual(await valueOf(executionDataStore(store, "a")), [1]);
  assert.deepEqual(await valueOf(executionDataStore(store, "b")), [2]);
  await service.finish("a", "completed");
  await service.adopt("a");
  assert.deepEqual(await valueOf(store), [1]);
});

test("rerun removes old contribution, reads new independent inputs, and replaces atomically", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await write(executionDataStore(store, "a"));
  await service.finish("a", "completed");
  await service.adopt("a");
  await write(store, { id: "other", value: 9, batch: "other" });
  await start(service, "b", { previousId: "a" });
  assert.deepEqual(await valueOf(executionDataStore(store, "b")), [9]);
  await write(executionDataStore(store, "b"), { value: 2 });
  assert.deepEqual(await valueOf(store), [1, 9]);
  await service.finish("b", "completed");
  await service.adopt("b");
  assert.deepEqual((await valueOf(store)).sort(), [2, 9]);
  await service.adopt("a");
  assert.deepEqual((await valueOf(store)).sort(), [1, 9]);
});

test("failed execution and stale selection leave accepted state intact", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await write(executionDataStore(store, "a"));
  await service.finish("a", "failed");
  await assert.rejects(service.adopt("a"), { code: "execution_not_complete" });
  assert.deepEqual(await valueOf(store), []);
  await start(service, "b");
  await write(executionDataStore(store, "b"));
  await service.finish("b", "completed");
  await assert.rejects(service.adopt("b", { expectedRevision: 0 }), { code: "execution_selection_conflict" });
  assert.deepEqual(await valueOf(store), []);
});

test("unrelated write to the same record conflicts rather than overwriting", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await write(executionDataStore(store, "a"));
  await service.finish("a", "completed");
  await write(store, { value: 8 });
  await assert.rejects(service.adopt("a"), { code: "execution_adoption_conflict" });
  assert.deepEqual(await valueOf(store), [8]);
});

test("old turns lock and suffix deletion reopens the surviving turn", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await service.finish("a", "completed");
  await service.beginTurn(2);
  await assert.rejects(service.adopt("a"), { code: "execution_turn_locked" });
  await assert.rejects(start(service, "b"), { code: "execution_turn_locked" });
  await service.prune(2);
  await start(service, "b");
  assert.ok((await service.list()).executions.b);
});

test("historical changes require explicit permission and are restored by execution turn", async t => {
  const { store, service } = await fixture(t);
  await write(store, { turn: 0 });
  await start(service, "denied");
  await assert.rejects(write(executionDataStore(store, "denied"), { action: "update", revision: 1, value: 2 }), { code: "execution_historical_write_denied" });
  await start(service, "allowed", { policy: { allowHistoricalWrites: true } });
  await write(executionDataStore(store, "allowed"), { action: "update", revision: 1, value: 3 });
  await service.finish("allowed", "completed");
  await service.adopt("allowed");
  assert.deepEqual(await valueOf(store), [3]);
  await service.prune(1);
  assert.deepEqual(await valueOf(store), [1]);
});

test("child contributions are visible only to their parent until root adoption", async t => {
  const { store, service } = await fixture(t);
  await start(service, "parent");
  await start(service, "child", { parentId: "parent" });
  await write(executionDataStore(store, "child"));
  await service.finish("child", "completed");
  await service.adopt("child");
  assert.deepEqual(await valueOf(store), []);
  assert.deepEqual(await valueOf(executionDataStore(store, "parent")), [1]);
  await service.finish("parent", "completed");
  await service.adopt("parent");
  assert.deepEqual(await valueOf(store), [1]);
});

test("late results stay with the inactive attempt and return only when it is adopted", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await write(executionDataStore(store, "a"));
  await service.finish("a", "completed");
  await service.adopt("a");
  await start(service, "late", { workflowId: "test/image", parentId: "a" });
  await start(service, "b", { previousId: "a" });
  await write(executionDataStore(store, "b"), { value: 2 });
  await service.finish("b", "completed");
  await service.adopt("b");
  await assert.rejects(start(service, "inactive-child", { parentId: "a" }), { code: "execution_inactive" });
  await start(service, "cleanup", { parentId: "a", workflowId: "test/cleanup", lifecycle: true });
  await write(executionDataStore(store, "cleanup"), { action: "update", revision: 1, value: 10 });
  await service.finish("cleanup", "completed");
  await service.adopt("cleanup");
  await write(executionDataStore(store, "late"), { id: "image", value: 30 });
  await service.finish("late", "completed");
  await service.adopt("late", { allowPast: true });
  assert.deepEqual(await valueOf(store), [2]);
  assert.deepEqual(await valueOf(executionDataStore(store, "a")), [10, 30]);
  await service.adopt("a");
  assert.deepEqual(await valueOf(store), [10, 30]);
});

test("deleting a later-origin historical repair restores the surviving parent and its candidates", async t => {
  const { store, service } = await fixture(t);
  await start(service, "a");
  await write(executionDataStore(store, "a"));
  await service.finish("a", "completed");
  await service.adopt("a");
  await start(service, "b", { previousId: "a" });
  await write(executionDataStore(store, "b"), { value: 2 });
  await service.finish("b", "completed");
  await service.beginTurn(2);
  await start(service, "repair", { workflowId: "test/archive", turn: 2, parentId: "a", policy: { allowHistoricalWrites: true } });
  await write(executionDataStore(store, "repair"), { action: "update", revision: 1, turn: 1, value: 8 });
  await service.finish("repair", "completed");
  await service.adopt("repair");
  assert.deepEqual(await valueOf(store), [8]);
  await service.prune(2);
  assert.deepEqual(await valueOf(store), [1]);
  await service.adopt("b");
  assert.deepEqual(await valueOf(store), [2]);
  await assert.rejects(write(executionDataStore(store, "repair"), { id: "late", batch: "late" }), { code: "execution_missing" });
});

test("a failed execution resumes its own work, while a new execution excludes its partial results", async t => {
  const { store, service } = await fixture(t);
  await start(service, "failed");
  await write(executionDataStore(store, "failed"));
  await service.finish("failed", "failed");
  await start(service, "fresh", { previousId: "failed" });
  assert.deepEqual(await valueOf(executionDataStore(store, "fresh")), []);
  await assert.rejects(write(executionDataStore(store, "failed"), { id: "late", batch: "late" }), { code: "execution_closed" });
  await service.resume("failed");
  await write(executionDataStore(store, "failed"), { id: "recovered", value: 5, batch: "recovery" });
  await service.finish("failed", "completed");
  await service.adopt("failed");
  assert.deepEqual(await valueOf(store), [1, 5]);
});

test("causal child inputs exclude sibling results, and immutable versions are shared", async t => {
  const { store, service } = await fixture(t);
  await start(service, "parent");
  const isolatedInput = Object.assign(Object.create(store), { readCollection: () => Promise.resolve({ history: [], records: [] }) });
  await start(service, "left", { parentId: "parent", workflowId: "test/left" });
  await write(executionDataStore(store, "left"));
  await service.finish("left", "completed");
  await service.adopt("left");
  await start(service, "right", { parentId: "parent", workflowId: "test/right", inputStore: isolatedInput });
  assert.deepEqual(await valueOf(executionDataStore(store, "right")), []);
  const before = await readdir(join(store.sessionDirectory, "workflow", "execution-states"));
  await start(service, "another", { parentId: "parent", workflowId: "test/another" });
  const after = await readdir(join(store.sessionDirectory, "workflow", "execution-states"));
  assert.deepEqual(after.sort(), before.sort(), "Identical record and collection versions must not be copied per execution");
});

test("session preferences remain live in presentation and are not rolled back with an attempt", async t => {
  const { store, service } = await fixture(t, "session");
  await write(store, { value: 4, turn: 0, batch: "initial" });
  await start(service, "a");
  await start(service, "b");
  await write(executionDataStore(store, "a"), { action: "update", revision: 1, value: 5 });
  assert.deepEqual(await valueOf(store), [5]);
  assert.deepEqual(await valueOf(executionDataStore(store, "b")), [4], "Execution input stays frozen");
  assert.deepEqual(await valueOf(executionDataStore(store, "b", { presentation: true })), [5], "Presentation uses the live session preference");
  await service.finish("a", "failed");
  await service.finish("b", "completed");
  await service.adopt("b");
  await service.prune(1);
  assert.deepEqual(await valueOf(store), [5]);
});
