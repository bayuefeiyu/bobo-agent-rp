import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { readVisibleArtifacts, workflowNodeWorkspace } from "./rp-data-artifacts.mjs";
import { finalizeNodeData, resolveCodeSubmissionBinding, resolveCodeSubmissionSourceReferences } from "./rp-data-node-runtime.mjs";

const contract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "state",
  collections: {
    values: {
      storage: { kind: "snapshot", partition: { mode: "single" } },
      recordTypes: { "state.value": { dataSchemaVersion: 1, indexes: {}, views: { rp: { format: "text", fields: [{ path: "/data/value" }] } }, actions: ["create"] } },
    },
  },
  capabilities: { "state.create": { collections: ["values"], actions: ["create"], views: [] } },
});

test("node-end commit reads only the explicitly declared output before success", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-node-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDirectory = join(root, "session");
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory: join(root, "module") }] });
  await store.initialize();
  const workflow = { id: "update-flow" };
  const run = { id: "run-one", turn: 2 };
  const node = {
    id: "update",
    type: "agent",
    agentId: "worker",
    outputs: {
      changes: { path: "drafts/changes.json", scope: "workflow", retain: "run", format: "unified-change-batch" },
      scratch: { path: "scratch.txt", scope: "node", retain: "node", format: "text" },
    },
    moduleAccess: [{ moduleId: "state", collectionId: "values", capabilities: ["state.create"], views: [] }],
    dataCommit: { onNodeEnd: [{ output: "changes", path: null, required: true }] },
  };
  const workspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id);
  await mkdir(join(workspace, "drafts"), { recursive: true });
  await writeFile(join(workspace, "scratch.txt"), "temporary", "utf8");
  await writeFile(join(workspace, "drafts", "changes.json"), JSON.stringify({
    protocolVersion: 1,
    batchId: "node-batch",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "node-op", moduleId: "state", collectionId: "values", recordType: "state.value", action: "create", data: { value: "ready" } }],
  }), "utf8");
  const result = await finalizeNodeData({ sessionDirectory, store, workflow, run, node, result: { output: "done" } });
  assert.equal(result.dataReceipts[0].status, "committed");
  assert.equal(result.artifacts.changes.scope, "workflow");
  await assert.rejects(readFile(join(workspace, "scratch.txt"), "utf8"), error => error.code === "ENOENT");
  const visible = await readVisibleArtifacts({ sessionDirectory, target: { workflowRunId: run.id, nodeId: "downstream", turn: 2 }, fromNodeIds: ["update"] });
  assert.equal(visible[0].id, "changes");
  assert.equal((await store.readCollection("state", "values")).records[0].data.value, "ready");
});

test("trusted code submissions may bind only to an existing visible historical message", () => {
  const messages = [
    { id: "m1", binding: { turn: 1 } },
    { id: "m2", binding: { turn: 2 } },
    { id: "m3", binding: { turn: 3 } },
  ];
  assert.deepEqual(resolveCodeSubmissionBinding({ turn: 2, messageId: "m2" }, { messages, visibleThroughTurn: 3 }), { turn: 2, messageId: "m2" });
  assert.deepEqual(resolveCodeSubmissionBinding(undefined, { fallback: { turn: 3, messageId: "m3" } }), { turn: 3, messageId: "m3" });
  assert.throws(() => resolveCodeSubmissionBinding({ turn: 3, messageId: "missing" }, { messages, visibleThroughTurn: 3 }), /unknown message/);
  assert.throws(() => resolveCodeSubmissionBinding({ turn: 1, messageId: "m2" }, { messages, visibleThroughTurn: 3 }), /does not match/);
  assert.throws(() => resolveCodeSubmissionBinding({ turn: 3, messageId: "m3" }, { messages, visibleThroughTurn: 2 }), /beyond/);
  assert.throws(() => resolveCodeSubmissionBinding({ turn: 2, messageId: "m2", extra: true }, { messages, visibleThroughTurn: 3 }), /only turn and messageId/);
});

test("trusted code source selection resolves exact visible message revisions", () => {
  const messages = [
    { id: "m1", revision: 1, binding: { turn: 1 }, metadata: { narrativeSource: { producerKind: "user", layer: "in-world" } } },
    { id: "m2", revision: 4, binding: { turn: 2 }, metadata: { narrativeSource: { producerKind: "agent", layer: "story" } } },
    { id: "m3", revision: 2, binding: { turn: 3 }, metadata: { narrativeSource: { producerKind: "agent", layer: "story" } } },
  ];
  assert.deepEqual(resolveCodeSubmissionSourceReferences(["m1", "m2"], { messages, visibleThroughTurn: 2 }).map(item => [item.id, item.revision]), [["m1", 1], ["m2", 4]]);
  assert.deepEqual(resolveCodeSubmissionSourceReferences(["m1"], { messages, visibleThroughTurn: 2, expectedRevisions: { m1: 1 } }).map(item => [item.id, item.revision]), [["m1", 1]]);
  assert.throws(() => resolveCodeSubmissionSourceReferences(["m2"], { messages, visibleThroughTurn: 2, expectedRevisions: { m2: 3 } }), error => error.code === "source_revision_conflict");
  assert.throws(() => resolveCodeSubmissionSourceReferences(["missing"], { messages, visibleThroughTurn: 3 }), /unknown message/);
  assert.throws(() => resolveCodeSubmissionSourceReferences(["m3"], { messages, visibleThroughTurn: 2 }), /beyond/);
  assert.throws(() => resolveCodeSubmissionSourceReferences(["m1", "m1"], { messages }), /duplicates/);
});
