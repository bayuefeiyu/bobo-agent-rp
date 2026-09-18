/**
 * Deep-director operation identity.
 *
 * The deep director has three different identifiers and conflating them breaks restart recovery:
 *
 *   - `operationId`  — the stable identity of one logical deep run. It is what `deep-state-current`
 *                      stores in `currentRunId`, what `begin-deep-operation` registers, and what
 *                      `finish-deep-operation` checks before writing a terminal status.
 *   - wrapper `runId` — the run of the *outer* workflow (`director-deep-wrapper`). A restart or a
 *                      retry produces a new one, so it can never be the operation identity.
 *   - child `runId`   — the run of the module workflow actually doing the work
 *                      (`deep-director-planning` / `deep-director-team-planning`). It is recorded
 *                      separately and is what a resume must reattach to.
 *
 * Deriving `operationId` from the wrapper's own run id made a restarted wrapper look like a
 * *different* operation while the state still pointed at the earlier one, so the wrapper reported
 * `already-running` and completed — and because it believed it was not the owner, it finished the
 * parent run while its own child was still working (RC-08). Deriving it from the trigger turn is
 * stable across restarts and retries of the same turn, and a genuinely new operation comes from a
 * new player turn.
 */

const TERMINAL_STATUSES = new Set(["completed", "skipped", "failed", "cancelled"]);

export function deepOperationId(turn) {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new Error("A deep operation requires the trigger turn.");
  return `deep-operation-turn-${turn}`;
}

/**
 * What the wrapper should do with the persisted deep state.
 *
 * `start` opens a new operation; `resume-child` reattaches to the child run this operation already
 * started; `resume-operation` continues an operation whose child run must be re-entered; `wait`
 * means another operation owns the state; `blocked` means a closed operation still owns it.
 */
export function deepStateVerdict({ operationId, state, operation = null, turn }) {
  if (!state) return { action: "start", reason: "deep-state-missing", operationId };
  const value = state.value?.data || state.value || {};
  const status = typeof value.status === "string" ? value.status : "idle";
  const currentRunId = typeof value.currentRunId === "string" && value.currentRunId ? value.currentRunId : null;
  if (status !== "running") {
    if (operation && typeof operation === "object") {
      return { action: "blocked", reason: "operation_closed", operationId, currentRunId, closedOperationId: operationId };
    }
    return { action: "start", reason: status === "failed" ? "previous-operation-failed" : "idle", operationId };
  }
  if (currentRunId !== operationId) {
    // Another operation is live. The wrapper belongs to this turn, so this is not its operation.
    return { action: "wait", reason: "another-operation-running", operationId, currentRunId };
  }
  // Same operation. A recorded child run means the module workflow is already in flight and the
  // wrapper must reattach to it instead of starting a second child.
  const childRunId = typeof value.currentChildRunId === "string" && value.currentChildRunId ? value.currentChildRunId : null;
  if (childRunId) return { action: "resume-child", reason: "operation-child-in-flight", operationId, currentRunId, childRunId };
  return { action: "resume-operation", reason: "operation-running-without-child", operationId, currentRunId };
}

/** Statuses a wrapper must not translate into a completed operation. */
export function isNonTerminalDeepStatus(status) {
  return !TERMINAL_STATUSES.has(status);
}

/**
 * The child run id a retried/resumed wrapper invocation already owns, or null.
 *
 * `runId` may be either a module-workflow child run or the wrapper itself; only a value that differs
 * from the wrapper identifies a child.
 */
export function recordedChildRun({ verdict, wrapperRunId }) {
  const childRunId = verdict?.childRunId || null;
  if (!childRunId || childRunId === wrapperRunId) return null;
  return childRunId;
}
