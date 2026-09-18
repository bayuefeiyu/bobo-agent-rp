import { submitCommitted } from "../lib/agent-change-batch.mjs";

export async function execute({ run, conversation, data }) {
  const operationId = run.arguments?.operationId;
  if (typeof operationId !== "string" || !operationId) throw new Error("Deep operationId is required.");
  const state = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!state) throw new Error("Deep director state is missing.");
  const value = state.value?.data || state.value || {};
  const operation = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: operationId, view: "deep-director" });
  const rootRunId = typeof run.arguments?.rootRunId === "string" && run.arguments.rootRunId ? run.arguments.rootRunId : operationId;
  if (value.status === "running" && value.currentRunId !== operationId) throw Object.assign(new Error(`Another deep director operation is active: ${value.currentRunId}`), { code: "deep_operation_conflict" });
  if (value.status === "running" && value.currentRunId === operationId) {
    // Re-entering the operation that already owns the state is a resume, not a conflict: a restarted
    // or retried wrapper calls this again before reattaching to its child run. Only a *closed*
    // operation blocks a new attempt.
    if (!operation) {
      const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
      await submitCommitted(data, { protocolVersion: 1, batchId: `${operationId}-deep-manifest-recovery`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${operationId}-manifest-recovery`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-operation", action: "create", targetId: operationId, data: { operationId, rootRunId, status: "running", openedTurn: run.turn, closedTurn: null, terminalError: null }, note: null }] }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
    }
    return { acquired: true, reused: true, operationId, manifestRecovered: !operation };
  }
  const batchId = `${operationId}-deep-begin`;
  const priorAcquisition = typeof data.receipt === "function" ? await data.receipt(batchId) : null;
  if (operation || priorAcquisition?.status === "committed") {
    throw Object.assign(new Error(`Deep director operation ${operationId} is closed; start a new wrapper run to create a new operation.`), {
      code: "operation_closed",
      operationId,
      restart: { workflow: "world-narrative-coordinator/director-deep-wrapper", requiresNewRun: true },
    });
  }
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const reasons = Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [];
  const batch = { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [
    { operationId: `${operationId}-manifest`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-operation", action: "create", targetId: operationId, data: { operationId, rootRunId, status: "running", openedTurn: run.turn, closedTurn: null, terminalError: null }, note: null },
    { operationId: `${operationId}-deep-begin-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...value, status: "running", currentRunId: operationId, currentChildRunId: null, lastTriggerTurn: run.turn, triggerReasons: reasons, failure: null }, note: null },
  ] };
  await submitCommitted(data, batch, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  return { acquired: true, reused: false, operationId };
}
