import { submitCommitted } from "../lib/agent-change-batch.mjs";
import { deepOperationId, isNonTerminalDeepStatus } from "../lib/deep-operation-identity.mjs";

/**
 * Open a single-Agent deep operation and record its stable identity.
 *
 * `currentRunId` is the *operation* identity and `currentChildRunId` is the module workflow run doing
 * the work. The wrapper compares its own run id against neither: a restart hands the wrapper a new
 * run id, and the deep state must keep pointing at the operation that is genuinely in flight.
 */
/**
 * The operation this run belongs to.
 *
 * A code node inside a module workflow sees the caller's parameters on `run.payload.call.arguments`,
 * while a node invoked directly sees them on `run.arguments`; the fallback keeps the identity stable
 * either way instead of inventing a per-run id.
 */
function resolveOperationId(run) {
  for (const candidate of [run.arguments?.operationId, run.payload?.call?.arguments?.operationId, run.payload?.operationId]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return deepOperationId(run.turn);
}

export async function execute({ run, conversation, data }) {
  const operationId = resolveOperationId(run);
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!state) throw new Error("Deep director state is missing.");
  const value = state.value?.data || state.value || {};
  if (isNonTerminalDeepStatus(value.status) && value.currentRunId && value.currentRunId !== operationId) {
    throw Object.assign(new Error(`Another deep director operation is active: ${value.currentRunId}`), { code: "deep_operation_conflict", operationId: value.currentRunId });
  }
  // This node runs inside the deep workflow, so its own run id is the child run the wrapper must
  // reattach to after a restart. Recording it here — before the planning Agent starts — is what makes
  // recovery possible at all.
  const childRunId = typeof run.arguments?.childRunId === "string" && run.arguments.childRunId ? run.arguments.childRunId : run.id;
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const batch = { protocolVersion: 1, batchId: `${operationId}-deep-start`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${operationId}-deep-start-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...value, status: "running", currentRunId: operationId, currentChildRunId: childRunId, lastTriggerTurn: run.turn, triggerReasons: Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [], failure: null }, note: null }] };
  const receipt = await submitCommitted(data, batch, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  return { markedRunning: true, operationId, currentChildRunId: childRunId, receipt };
}
