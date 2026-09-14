import { buildAgentChangeBatch, submitCommitted } from "../lib/agent-change-batch.mjs";
import { applyArchiveContentVersions } from "../lib/archive-content-version.mjs";

function bindingFor(mode, conversation, turn) {
  if (mode === "unbound") return null;
  const messages = conversation.messages.filter(message => message.binding?.turn <= turn);
  const message = mode === "user"
    ? [...messages].reverse().find(item => item.binding?.turn === turn && item.data?.role === "user")
    : [...messages].reverse().find(item => item.binding?.turn === turn && item.data?.role !== "user") || [...messages].reverse().find(item => item.binding?.turn === turn);
  return message ? { turn: message.binding.turn, messageId: message.id } : null;
}

export async function execute({ run, node, conversation, data }) {
  const rawSource = run.nodes[node.metadata.sourceNode]?.output;
  const source = node.metadata.sourceField ? rawSource?.[node.metadata.sourceField] : rawSource;
  let batch = buildAgentChangeBatch(source, { batchId: `${run.id}-${node.metadata.sourceNode}-changes`, allowedCollections: node.metadata.allowedCollections, archiveFirst: node.metadata.archiveFirst === true });
  if (!batch.operations.length) return { committed: false, skipped: true, reason: "empty-change-set" };
  batch = await applyArchiveContentVersions(data, batch);
  const binding = bindingFor(node.metadata.bindingMode || "assistant", conversation, run.turn || 0);
  const sourceMessageIds = (run.sourceReferences || []).filter(reference => reference.kind === "message").map(reference => reference.id);
  const options = binding ? { binding, sourceMessageIds } : { sourceMessageIds };
  const receipt = await submitCommitted(data, batch, options);
  return { committed: true, batchId: batch.batchId, operationCount: batch.operations.length, receipt };
}
