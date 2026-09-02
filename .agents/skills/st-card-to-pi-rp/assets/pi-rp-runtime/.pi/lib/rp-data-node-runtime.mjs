import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { executeDataBatch } from "./rp-data-changes.mjs";
import { cleanupArtifacts, registerNodeArtifacts } from "./rp-data-artifacts.mjs";

function safeResolve(root, path) {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Node commit path escapes its workspace.");
  return target;
}

export async function finalizeNodeData({ sessionDirectory, store, workflow, run, node, result }) {
  const artifacts = await registerNodeArtifacts({ sessionDirectory, workflow, run, node });
  const receipts = [];
  const root = resolve(sessionDirectory, "workspace", "private", workflow.id, run.id, node.id);
  for (const target of node.dataCommit?.onNodeEnd || []) {
    const artifact = target.output ? artifacts[target.output] : null;
    const path = artifact?.path || (target.path ? safeResolve(root, target.path) : null);
    if (!path) {
      if (target.required) throw new Error(`Required node change output ${target.output || target.path} is missing.`);
      continue;
    }
    let batch;
    try {
      batch = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!target.required && error?.code === "ENOENT") continue;
      throw new Error(`Cannot read node change document ${target.output || target.path}: ${error?.message || error}`);
    }
    const receipt = await executeDataBatch(store, batch, {
      access: node.moduleAccess || [],
      allowBestEffort: node.dataCommit?.allowBestEffort === true,
      context: {
        initiatorKind: node.type === "code" ? "code" : "agent",
        initiatorId: node.agentId || node.id,
        workflowId: workflow.id,
        workflowRunId: run.id,
        nodeId: node.id,
        binding: { turn: Number.isSafeInteger(run.turn) ? run.turn : 0, messageId: result?.assistantMessageId || null },
      },
    });
    receipts.push(receipt);
    if (receipt.status === "failed" || receipt.status === "partial") throw new Error(`Node data batch ${receipt.batchId} completed with status ${receipt.status}.`);
  }
  await cleanupArtifacts(sessionDirectory, { type: "node", workflowRunId: run.id, nodeId: node.id });
  return { ...result, artifacts, dataReceipts: receipts };
}
