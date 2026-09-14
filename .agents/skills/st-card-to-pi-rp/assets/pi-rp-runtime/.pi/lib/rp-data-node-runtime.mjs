import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { executeDataBatchOrThrow } from "./rp-data-changes.mjs";
import { cleanupArtifacts, registerNodeArtifacts } from "./rp-data-artifacts.mjs";
import { mergeSourceReferences, messageSourceReference } from "./rp-narrative-source.mjs";

function safeResolve(root, path) {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Node commit path escapes its workspace.");
  return target;
}

export function resolveCodeSubmissionBinding(requested, { messages = [], visibleThroughTurn = null, fallback = { turn: 0, messageId: null } } = {}) {
  if (requested === undefined || requested === null) return structuredClone(fallback);
  if (!requested || typeof requested !== "object" || Array.isArray(requested) || Object.keys(requested).some(key => !["turn", "messageId"].includes(key))) {
    throw new Error("Code data submission binding must contain only turn and messageId.");
  }
  if (!Number.isSafeInteger(requested.turn) || requested.turn < 0 || typeof requested.messageId !== "string" || !requested.messageId) {
    throw new Error("Code data submission binding requires a non-negative turn and a messageId.");
  }
  if (Number.isSafeInteger(visibleThroughTurn) && requested.turn > visibleThroughTurn) {
    throw new Error("Code data submission cannot bind beyond the workflow's visible turn.");
  }
  const message = messages.find(item => item?.id === requested.messageId);
  if (!message) throw new Error(`Code data submission binding references an unknown message: ${requested.messageId}.`);
  if (message.binding?.turn !== requested.turn) throw new Error("Code data submission binding turn does not match the referenced message.");
  return { turn: requested.turn, messageId: requested.messageId };
}

export function resolveCodeSubmissionSourceReferences(requestedMessageIds, { messages = [], visibleThroughTurn = null, fallback = [] } = {}) {
  if (requestedMessageIds === undefined || requestedMessageIds === null) return mergeSourceReferences(fallback);
  if (!Array.isArray(requestedMessageIds) || requestedMessageIds.some(id => typeof id !== "string" || !id)) {
    throw new Error("Code data submission sourceMessageIds must be an array of message IDs.");
  }
  const unique = new Set(requestedMessageIds);
  if (unique.size !== requestedMessageIds.length) throw new Error("Code data submission sourceMessageIds must not contain duplicates.");
  const selected = requestedMessageIds.map(id => {
    const message = messages.find(item => item?.id === id);
    if (!message) throw new Error(`Code data submission source references an unknown message: ${id}.`);
    if (Number.isSafeInteger(visibleThroughTurn) && message.binding?.turn > visibleThroughTurn) {
      throw new Error(`Code data submission source ${id} is beyond the workflow's visible turn.`);
    }
    return messageSourceReference(message);
  });
  return mergeSourceReferences(selected);
}

export async function finalizeNodeData({ sessionDirectory, store, workflow, run, node, result }) {
  const artifacts = await registerNodeArtifacts({ sessionDirectory, workflow, run, node });
  for (const inclusion of node.workspaceHandoff?.include || []) {
    if (!artifacts[inclusion.output]) {
      throw new Error(`Required workspace handoff output ${inclusion.output} is missing.`);
    }
  }
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
    const receipt = await executeDataBatchOrThrow(store, batch, {
      access: node.moduleAccess || [],
      allowBestEffort: node.dataCommit?.allowBestEffort === true,
      context: {
        initiatorKind: node.type === "code" ? "code" : "agent",
        initiatorId: node.agentId || node.id,
        workflowId: workflow.id,
        workflowRunId: run.id,
        nodeId: node.id,
        binding: { turn: Number.isSafeInteger(run.turn) ? run.turn : 0, messageId: result?.assistantMessageId || null },
        sourceReferences: run.sourceReferences || [],
      },
    });
    receipts.push(receipt);
  }
  await cleanupArtifacts(sessionDirectory, { type: "node", workflowRunId: run.id, nodeId: node.id });
  return { ...result, artifacts, dataReceipts: receipts };
}
