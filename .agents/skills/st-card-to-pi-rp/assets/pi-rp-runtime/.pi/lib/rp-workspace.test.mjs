import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendWorkflowRunRecord, clearPublicTurnWorkspace, ensureWorkflowWorkspace, pruneWorkflowState, workflowProcessRecordPath, workflowWorkspacePaths, writeWorkflowProcessRecord } from "./rp-workspace.mjs";

test("creates isolated per-run workflow workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-workspace-"));
  try {
    const paths = workflowWorkspacePaths(root, "memory", "run-1", "global-background");
    await ensureWorkflowWorkspace(paths);
    assert.match(paths.privateRun, /global-background/);
    await clearPublicTurnWorkspace(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes workflow runs and their registered files bound to a deleted suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-workspace-"));
  try {
    const first = await ensureWorkflowWorkspace(workflowWorkspacePaths(root, "memory", "run-3", "global-background"));
    const second = await ensureWorkflowWorkspace(workflowWorkspacePaths(root, "memory", "run-5", "global-background"));
    await appendWorkflowRunRecord(first.workflowRuns, { id: "run-3", turn: 3, visibleThroughTurn: 3 });
    await appendWorkflowRunRecord(first.workflowRuns, { id: "run-5", turn: 5, visibleThroughTurn: 5 });
    await writeWorkflowProcessRecord(first.workflowProcessRecords, {
      workflowId: "memory", runId: "run-5", nodeId: "summarize", nodeType: "agent", agentId: "worker", modelId: "pi:current",
      exchange: { received: { role: "user", content: "input with ``` fence" }, sent: { role: "assistant", content: "output" } },
    });
    const result = await pruneWorkflowState(root, 4);
    assert.deepEqual(result.removedRunIds, ["run-5"]);
    assert.match(await readFile(first.workflowRuns, "utf8"), /run-3/);
    assert.doesNotMatch(await readFile(first.workflowRuns, "utf8"), /run-5/);
    await assert.rejects(readFile(workflowProcessRecordPath(first.workflowProcessRecords, "run-5", "summarize"), "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes a user-only node process record with the last Agent exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-workspace-"));
  try {
    const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(root, "story", "run-1", "turn-background"));
    const path = await writeWorkflowProcessRecord(paths.workflowProcessRecords, {
      workflowId: "story", runId: "run-1", nodeId: "draft", nodeType: "agent", agentId: "writer", modelId: "pi:current",
      exchange: { received: { role: "user", content: "写下一段" }, sent: { role: "assistant", content: "故事正文" } },
    });
    const document = await readFile(path, "utf8");
    assert.match(document, /Agent 最后接收的内容/);
    assert.match(document, /写下一段/);
    assert.match(document, /Agent 最后发送的内容/);
    assert.match(document, /不会加入 Agent 上下文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
