import { submitCommitted } from "../lib/agent-change-batch.mjs";

export async function execute({ run, conversation, data }) {
  const operationId = run.arguments?.operationId;
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!state) throw new Error("Deep director state is missing.");
  const value = state.value?.data || state.value || {};
  if (value.currentRunId !== operationId) return { finalized: false, reason: "operation-no-longer-owns-state" };
  const terminalStatus = run.arguments?.terminalStatus || "failed";
  const terminalError = run.arguments?.terminalError || `deep operation ended with ${terminalStatus}`;
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  await submitCommitted(data, { protocolVersion: 1, batchId: `${operationId}-deep-terminal-${terminalStatus}`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${operationId}-deep-terminal-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...value, status: terminalStatus === "cancelled" || terminalStatus === "skipped" ? "idle" : "failed", currentRunId: null, failure: terminalStatus === "cancelled" || terminalStatus === "skipped" ? null : String(terminalError) }, note: null }] }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  return { finalized: true, operationId, terminalStatus };
}
