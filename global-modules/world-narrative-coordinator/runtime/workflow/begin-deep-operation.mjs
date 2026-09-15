import { submitCommitted } from "../lib/agent-change-batch.mjs";

export async function execute({ run, conversation, data }) {
  const operationId = run.arguments?.operationId;
  if (typeof operationId !== "string" || !operationId) throw new Error("Deep operationId is required.");
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!state) throw new Error("Deep director state is missing.");
  const value = state.value?.data || state.value || {};
  if (value.status === "running" && value.currentRunId !== operationId) throw Object.assign(new Error(`Another deep director operation is active: ${value.currentRunId}`), { code: "deep_operation_conflict" });
  if (value.status === "running" && value.currentRunId === operationId) return { acquired: true, reused: true, operationId };
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const reasons = Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [];
  const batch = { protocolVersion: 1, batchId: `${operationId}-deep-begin`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${operationId}-deep-begin-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...value, status: "running", currentRunId: operationId, lastTriggerTurn: run.turn, triggerReasons: reasons, failure: null }, note: null }] };
  await submitCommitted(data, batch, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  return { acquired: true, reused: false, operationId };
}
