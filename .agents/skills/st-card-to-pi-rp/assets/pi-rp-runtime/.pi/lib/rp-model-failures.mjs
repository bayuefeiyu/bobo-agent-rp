/**
 * Provider and turn-end failure fidelity.
 *
 * Three rules the runtime must not fudge:
 *
 *   1. When a provider turn produces no usable text, report **why**. Collapsing an HTTP 400, a rate
 *      limit and a network drop into "no text output" sends the user to the model selector at
 *      random and destroys the only evidence that names the real cause.
 *   2. A request the provider rejected because of a malformed tool schema is a **configuration**
 *      fault. Another model cannot repair a schema this runtime sent, so automatic model switching
 *      only hides it. Rate limits, network faults and bad model output keep their own recovery
 *      paths, so the classification stays narrow: it matches the provider's own wording rather than
 *      treating every HTTP 400 as a configuration error.
 *   3. A failed turn must release the turn and say what failed. Reading an output that was never
 *      produced turns a clear narrative failure into a filesystem error, and reporting only "the
 *      workflow ended" hides which node the player or the card author has to look at.
 */

/** Human-readable cause for an assistant turn that produced no usable text. */
export function assistantFailureReason(message) {
  if (!message || message.role !== "assistant") return null;
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
  const detail = [message.errorMessage, message.rawStopReason]
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.trim());
  if (!detail.length && (!stopReason || stopReason === "stop")) return null;
  const unique = [...new Set(detail)];
  return `stopReason=${stopReason || "unknown"}${unique.length ? `: ${unique.join(" | ")}` : ""}`;
}

/** Whether a provider's own error text says the request carried an unusable tool schema. */
export function isToolSchemaRejection(text) {
  if (typeof text !== "string" || !text) return false;
  return /invalid schema for function|schema must be a json schema|invalid[^\n]{0,40}tool[^\n]{0,20}schema/i.test(text);
}

/**
 * The error a node throws when a provider turn returned no text.
 *
 * The label names the exact binding that failed and the provider's own wording is preserved
 * verbatim, because that text — not the model name — is what identifies the fault.
 */
export function noTextOutputError({ message, label = "Workflow agent", code = null }) {
  const reason = assistantFailureReason(message);
  if (!reason) return new Error(`${label} returned no text output.`);
  if (!isToolSchemaRejection(reason)) return new Error(`${label} returned no text output (${reason}).`);
  return Object.assign(
    new Error(`${label} returned no text output (${reason}). The provider rejected a tool schema this runtime sent; fix the node's tool or module-access configuration instead of switching models.`),
    { code: code || "tool_schema_invalid" },
  );
}

/**
 * The error a `turn-finalize` node throws when the narrative output it publishes was never
 * produced.
 *
 * A dependency that failed leaves the finalizer `skipped`, so reaching this read means the source
 * node did not complete for another reason. Reading the missing file anyway produced a bare ENOENT
 * that buried the real cause and read as a filesystem fault; this names the source node, its status
 * and its own error instead.
 */
export function narrativeOutputUnavailableError({ nodeId, sourceNodeId, outputId, sourceState }) {
  const status = sourceState?.status || "pending";
  const error = typeof sourceState?.error === "string" && sourceState.error ? sourceState.error : null;
  return new Error(`Node ${nodeId} cannot publish the narrative from ${sourceNodeId}/${outputId}: ${sourceNodeId} is ${status}${error ? ` (${error})` : ""}.`);
}

/**
 * The player-readable reason a foreground turn ended without a narrative.
 *
 * The failed node itself may be an upstream dependency rather than the narrative node, in which case
 * the narrative node is only `skipped`; naming the unreachable node is more useful than reporting
 * that "the workflow ended".
 */
export function describeTurnFailureReason(run, narrativePublished) {
  const nodes = run?.nodes || {};
  const direct = Object.values(nodes).find(state => ["failed", "cancelled"].includes(state?.status));
  if (direct) return `${direct.id}：${typeof direct.error === "string" && direct.error ? direct.error : `节点以 ${direct.status} 结束`}`;
  if (run?.status === "completed" && !narrativePublished) return "回合收尾节点未发布正文";
  const skipped = Object.entries(nodes).find(([, state]) => state?.status === "skipped" && state.error === "dependency_unavailable");
  if (skipped) return `${skipped[0]}：其上游节点未产出所需结果`;
  return `工作流以 ${run?.status || "unknown"} 结束`;
}
