import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendWorkflowRunRecord, clearPublicTurnWorkspace, ensureWorkflowWorkspace, pruneWorkflowState, publishLongTermRecord, readLatestLongTermRecord, workflowWorkspacePaths } from "./rp-workspace.mjs";

test("creates isolated workflow workspaces and publishes versioned long-term records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-workspace-"));
  try {
    const paths = workflowWorkspacePaths(root, "memory", "run-1", "global-background");
    await ensureWorkflowWorkspace(paths);
    const published = await publishLongTermRecord(paths.publicLongTerm, "memory", {
      data: { summary: "remembered" },
      binding: { messageIds: ["message-1"], throughTurn: 3 },
    }, { type: "object" });
    assert.equal((await readLatestLongTermRecord(paths.publicLongTerm, "memory")).id, published.id);
    assert.match(await readFile(join(paths.publicLongTerm, "memory", "records.jsonl"), "utf8"), /remembered/);
    await clearPublicTurnWorkspace(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes workflow runs and long-term publications bound to a deleted suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-workspace-"));
  try {
    const first = await ensureWorkflowWorkspace(workflowWorkspacePaths(root, "memory", "run-3", "global-background"));
    const second = await ensureWorkflowWorkspace(workflowWorkspacePaths(root, "memory", "run-5", "global-background"));
    await appendWorkflowRunRecord(first.workflowRuns, { id: "run-3", turn: 3, visibleThroughTurn: 3 });
    await appendWorkflowRunRecord(first.workflowRuns, { id: "run-5", turn: 5, visibleThroughTurn: 5 });
    await publishLongTermRecord(first.publicLongTerm, "memory", { data: { value: 3 }, binding: { messageIds: [], throughTurn: 3 } }, {});
    await publishLongTermRecord(second.publicLongTerm, "memory", { data: { value: 5 }, binding: { messageIds: [], throughTurn: 5 } }, {});
    const result = await pruneWorkflowState(root, 4);
    assert.deepEqual(result.removedRunIds, ["run-5"]);
    assert.match(await readFile(first.workflowRuns, "utf8"), /run-3/);
    assert.doesNotMatch(await readFile(first.workflowRuns, "utf8"), /run-5/);
    assert.equal((await readLatestLongTermRecord(first.publicLongTerm, "memory")).data.value, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
