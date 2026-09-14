import { submitCommitted } from "../lib/agent-change-batch.mjs";

export async function execute({ run, conversation, data }) {
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!state) throw new Error("Deep director state is missing.");
  const value = state.value?.data || state.value || {};
  if (value.status === "running" && value.currentRunId !== run.id) throw new Error(`Another deep director run is active: ${value.currentRunId}`);
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const batch = { protocolVersion: 1, batchId: `${run.id}-deep-start`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${run.id}-deep-start-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...value, status: "running", currentRunId: run.id, lastTriggerTurn: run.turn, triggerReasons: Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [], failure: null }, note: null }] };
  const receipt = await submitCommitted(data, batch, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  return { markedRunning: true, receipt };
}
