import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { readVisibleArtifacts, workflowNodeWorkspace } from "./rp-data-artifacts.mjs";
import { finalizeNodeData } from "./rp-data-node-runtime.mjs";

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
