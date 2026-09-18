/**
 * ComfyUI history diagnostics.
 *
 * ComfyUI reports `status_str: "success"` whenever the execution loop itself finished. A node that
 * refused its inputs records an `execution_error` message and its branch is skipped, but an unrelated
 * branch — typically a text or note node — still runs, so the history looks successful and simply
 * contains no image. That is how RC-07 presented: the queue entry was accepted, the save nodes were
 * skipped by a seed above the node's limit, `status_str` was `success`, and the card recorded
 * "completed without an adapted image output reference".
 *
 * Re-reading the history tells the real story: which node errored, and whether that node is on the
 * path the requested output depends on. An error on that path is a failure of the image; an error
 * elsewhere is reported as a warning instead of being blamed for a missing image.
 */

function messages(history) {
  return Array.isArray(history?.status?.messages) ? history.status.messages : [];
}

/** Every `execution_error` entry in one history record, normalized. */
export function executionErrors(history) {
  const errors = [];
  for (const entry of messages(history)) {
    if (!Array.isArray(entry) || entry[0] !== "execution_error" || !entry[1] || typeof entry[1] !== "object") continue;
    const payload = entry[1];
    errors.push({
      nodeId: payload.node_id === undefined || payload.node_id === null ? null : String(payload.node_id),
      nodeType: typeof payload.node_type === "string" ? payload.node_type : null,
      message: typeof payload.exception_message === "string" && payload.exception_message ? payload.exception_message : "ComfyUI node execution failed.",
      details: typeof payload.exception_type === "string" ? payload.exception_type : null,
    });
  }
  return errors;
}

/** Warnings and other non-error status entries, kept for display next to a real failure. */
export function unrelatedStatusMessages(history) {
  return messages(history)
    .filter(entry => Array.isArray(entry) && !["execution_error", "execution_start", "execution_success", "execution_cached", "executing", "progress"].includes(entry[0]))
    .map(entry => ({ type: String(entry[0]), payload: entry[1] ?? null }));
}

/**
 * Which nodes can reach a target node.
 *
 * ComfyUI links are `[nodeId, outputIndex]` references inside `inputs`, so the dependency set is
 * derived from the frozen workflow that was actually submitted.
 */
export function outputLineage(workflow, targetNodeIds) {
  const reachable = new Set();
  const stack = [...(Array.isArray(targetNodeIds) ? targetNodeIds : [])].map(String);
  while (stack.length) {
    const nodeId = stack.pop();
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    const inputs = workflow?.[nodeId]?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const value of Object.values(inputs)) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const reference = String(value[0]);
      if (workflow?.[reference]) stack.push(reference);
    }
  }
  return reachable;
}

/**
 * Split node errors into the ones that can explain a missing image and the ones that cannot.
 *
 * An error whose node is not on the output lineage is *unrelated*: the requested image may still be
 * missing for a different reason, so it must not be reported as that reason.
 */
export function classifyNodeErrors({ history, workflow, targetNodeIds }) {
  const errors = executionErrors(history);
  if (!errors.length) return { blocking: [], unrelated: [], other: [] };
  const lineage = outputLineage(workflow, targetNodeIds);
  const blocking = [];
  const unrelated = [];
  const other = [];
  for (const error of errors) {
    if (error.nodeId && lineage.has(error.nodeId)) blocking.push(error);
    else if (error.nodeId) unrelated.push(error);
    else other.push(error);
  }
  return { blocking, unrelated, other };
}

/** One-line description used in the thrown error and in the render record. */
export function describeNodeError(error) {
  const where = error.nodeId ? `node ${error.nodeId}${error.nodeType ? ` (${error.nodeType})` : ""}` : "an unnamed node";
  return `${where}: ${error.message}`;
}
