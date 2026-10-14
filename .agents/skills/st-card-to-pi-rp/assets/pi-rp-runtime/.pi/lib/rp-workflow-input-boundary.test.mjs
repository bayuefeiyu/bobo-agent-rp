import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDataReadView, readDataReadViewCollection } from "./rp-data-read-view.mjs";
import { workflowExecutionReadBoundary } from "./rp-node-data-access.ts";

test("a causal child snapshot preserves inherited committed revisions without exposing later live writes", async t => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-causal-input-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const initial = { id: "state", revision: 1, status: "active", binding: { turn: 0 }, updatedAt: "2026-10-13T00:00:00Z" };
  const committed = { ...initial, revision: 2, updatedAt: "2026-10-13T00:01:00Z" };
  const unrelated = { ...initial, revision: 3, updatedAt: "2026-10-13T00:02:00Z" };
  const store = { sessionDirectory, modules: new Map([["test", { contract: { moduleId: "test", collections: { state: { storage: {} } } } }]]), readCollection: async () => ({ records: [initial], history: [] }) };
  const run = { visibleThroughTurn: 0, readSnapshotAt: "2026-10-13T00:00:30Z" };
  const parent = await createDataReadView({ sessionDirectory, store, sourceId: "parent", ...workflowExecutionReadBoundary(run, false) });
  const { writeDataReceipt } = await import("./rp-data-transactions.mjs");
  await writeDataReceipt(sessionDirectory, { batchId: "begin-operation", status: "committed", results: [{ status: "committed", moduleId: "test", collectionId: "state", recordId: "state", action: "update", record: committed }] });
  store.readCollection = async () => ({ records: [unrelated], history: [initial, committed] });
  const inherited = Object.assign(Object.create(store), { readCollection: (moduleId, collectionId) => readDataReadViewCollection({ sessionDirectory, store, viewId: parent.viewId, batchIds: ["begin-operation"], moduleId, collectionId }) });
  const child = await createDataReadView({ sessionDirectory, store: inherited, sourceId: "child", ...workflowExecutionReadBoundary(run, true) });
  const result = await readDataReadViewCollection({ sessionDirectory, store, viewId: child.viewId, moduleId: "test", collectionId: "state" });
  assert.equal(result.records[0].revision, 2, "the child keeps its own causal revision, not the stale or latest live revision");
});
