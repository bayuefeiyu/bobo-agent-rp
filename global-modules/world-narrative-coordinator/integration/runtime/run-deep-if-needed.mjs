import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { queryAll } from "../../runtime/lib/data.mjs";
import { deepOperationId, deepStateVerdict, recordedChildRun } from "../../runtime/lib/deep-operation-identity.mjs";

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function prepareFallbackStoryContext({ run, node, conversation, workspace }) {
  const limit = Number.isSafeInteger(node.metadata?.historyCompleteTurns) ? node.metadata.historyCompleteTurns : 20;
  const visible = conversation.messages.filter(message => (message.binding?.turn || 0) <= (run.visibleThroughTurn ?? run.turn ?? 0));
  const completeTurns = [...new Set(visible.filter(message => message.data?.role === "assistant").map(message => message.binding?.turn).filter(Number.isSafeInteger))].sort((a, b) => a - b).slice(-limit);
  const selected = visible.filter(message => completeTurns.includes(message.binding?.turn));
  const root = resolve(workspace, "deep-story-context");
  await mkdir(root, { recursive: true });
  const story = selected.map(message => `[${message.data?.role || "unknown"}｜turn ${message.binding?.turn || 0}｜${message.id || "unknown"}｜revision ${message.revision || 1}]\n${message.data?.content || ""}`).join("\n\n") || "No complete story turns are available for this opening or configured range.";
  await writeFile(resolve(root, "story.md"), `# Frozen story context\n\n${story}\n`, "utf8");
  await writeFile(resolve(root, "DOCUMENTS.md"), ["# Deep director story context", "", `This directory freezes at most ${limit} complete turns selected when the wrapper starts.`, "", "- `story.md`: required canonical story input.", ""].join("\n"), "utf8");
  return "deep-story-context";
}

/**
 * Where this wrapper's deep run gets its story context.
 *
 * `trigger` requires the upstream workflow to hand over the story context it already froze; the
 * wrapper must not substitute raw conversation history, because that duplicates material the run
 * already owns and silently changes what a deep report is based on. `history` is the explicit
 * opening/manual fallback: those entry points legitimately have no frozen story context yet.
 */
function storyContextSource(node) {
  const declared = node.metadata?.storyContextSource;
  if (declared === undefined || declared === null) return "history";
  if (!["trigger", "history"].includes(declared)) throw new Error(`Node ${node.id} metadata.storyContextSource must be "trigger" or "history".`);
  return declared;
}

export async function execute({ run, node, conversation, data, calls, workspace }) {
  const settings = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "settings", id: "director-settings-current", view: "runtime" });
  const settingsValue = settings?.value?.data || settings?.value || {};
  if (settingsValue.enabled !== true) return { started: false, reason: "director-disabled" };
  const brief = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "private-state", id: "turn-brief-current", view: "director" });
  const recommendation = brief?.value?.deepRecommendation || brief?.value?.data?.deepRecommendation;
  if (!recommendation?.shouldStart) return { started: false, reason: "not-recommended" };
  // The operation identity is derived from the trigger turn, never from this wrapper's own run id:
  // a restart hands the wrapper a new run id, and treating that as a new operation is what made the
  // wrapper finish itself while its own child was still working.
  const operationId = deepOperationId(run.turn);
  const state = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  const operation = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: operationId, view: "deep-status" }).catch(() => null);
  const verdict = deepStateVerdict({ operationId, state, operation, turn: run.turn });
  if (verdict.action === "wait") return { started: false, reason: "already-running", operationId: verdict.currentRunId, childRunId: null };
  if (verdict.action === "blocked") {
    throw Object.assign(new Error(`Deep director operation ${operationId} is already closed; this turn's deep run cannot be restarted in place.`), { code: "operation_closed", operationId });
  }
  const resuming = verdict.action === "resume-child" || verdict.action === "resume-operation";
  const existingChildRunId = recordedChildRun({ verdict, wrapperRunId: run.id });
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const workflow = settingsValue.deep?.workflowMode === "team"
    ? "world-narrative-coordinator/deep-director-team-planning"
    : "world-narrative-coordinator/deep-director-planning";
  try {
    let basisPath = null;
    if (workflow.endsWith("deep-director-team-planning")) {
      const deepReport = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-status" });
      const referenceRecords = await queryAll(data, { moduleId: "world-narrative-coordinator", collectionId: "reference-library", recordTypes: ["director.reference-document"], view: "reference-index", includeInactive: true });
      const sourceMessages = conversation.messages
        .filter(message => (message.binding?.turn || 0) <= (run.visibleThroughTurn ?? run.turn ?? 0))
        .map(message => ({ id: message.id, revision: message.revision || 1, turn: message.binding?.turn || 0 }));
      basisPath = "deep-publication-basis.json";
      const basisFile = resolve(workspace, basisPath);
      const existingBasis = await readFile(basisFile, "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existingBasis) {
        if (existingBasis.schemaVersion !== 1 || existingBasis.operationId !== operationId || existingBasis.basisTurn !== run.turn) throw new Error("Existing deep publication basis does not belong to this operation and turn.");
      } else {
        await writeFile(basisFile, `${JSON.stringify({ schemaVersion: 1, operationId, basisTurn: run.turn, deepReport: deepReport ? { id: deepReport.id, revision: deepReport.revision } : null, references: Object.fromEntries(referenceRecords.map(item => [item.id, item.revision])), sourceMessages }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      }
    }
    const inherited = "trigger/story-context";
    const hasInherited = await exists(resolve(workspace, inherited, "DOCUMENTS.md"));
    if (!hasInherited && storyContextSource(node) === "trigger") {
      // Failing here is the point: the upstream integration did not hand over a story context, and
      // pretending that conversation history is the frozen context would make the deep report look
      // successful while being based on different material.
      throw new Error(`Node ${node.id} requires the frozen story context from its trigger, but this run received no trigger/story-context. Re-map the trigger document in ${run.workflowId || "the wrapper"} to an output the source workflow really declares.`);
    }
    const storyContext = hasInherited ? inherited : await prepareFallbackStoryContext({ run, node, conversation, workspace });
    // Both modes register the operation the same way. `begin-deep-operation` is idempotent for the
    // operation that already owns the state, so a restarted or retried wrapper resumes instead of
    // creating a second operation, and a closed operation blocks a new attempt explicitly.
    await calls.invoke({ workflow: "world-narrative-coordinator/begin-deep-operation", arguments: { operationId, rootRunId: run.id, triggerReasons: recommendation.reasonCodes || [] }, outputPaths: {} });
    const result = await calls.invoke({ workflow, arguments: { operationId, triggerReasons: recommendation.reasonCodes || [] }, documents: { "story-context": storyContext }, outputPaths: workflow.endsWith("deep-director-team-planning") ? { report: "team-deep-report.json", references: "team-deep-references.json" } : {} });
    if (workflow.endsWith("deep-director-team-planning")) {
      await calls.invoke({ workflow: "world-narrative-coordinator/commit-deep-operation", arguments: { operationId }, documents: { report: result.outputs.report, references: result.outputs.references, basis: basisPath }, outputPaths: {} });
    }
    return { started: true, resumed: resuming, resumedChildRunId: existingChildRunId, childRunId: result.callId, operationId, workflow, triggerReasons: recommendation.reasonCodes || [] };
  } catch (error) {
    if (["workflow_recovery_required", "workflow_child_waiting", "operation_closed"].includes(error?.code)) {
      // Waiting on a child and awaiting recovery are not failures: the operation stays open and the
      // next attempt reattaches to the same invocation instead of starting a second one.
      throw error;
    }
    if (workflow.endsWith("deep-director-team-planning")) {
      const terminalStatus = error?.code === "workflow_cancelled" ? "cancelled" : "failed";
      await calls.invoke({ workflow: "world-narrative-coordinator/finish-deep-operation", arguments: { operationId, terminalStatus, terminalError: error instanceof Error ? error.message : String(error) }, outputPaths: {} }).catch(() => {});
      throw error;
    }
    // The failure patch is a full record update, so it must be read through the complete view: a
    // projection like `deep-status` hides `lastTriggerWorldTime`/`lastCompletedWorldTime`, and a
    // patch built from it is either rejected by the schema or silently rewrites those fields to null.
    // The writer nodes inside the module read the same way for the same reason.
    const current = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
    const value = current?.value?.data || current?.value || {};
    // Only the operation that owns the state may mark it failed. A wrapper that merely observed
    // someone else's operation must not overwrite that operation's running state.
    //
    // The patch starts from the *current* record rather than a hand-written field list: the deep-state
    // schema requires every field to be present, so a failure handler that reconstructs the record
    // from a subset would itself be rejected — leaving the operation stuck as `running` and its
    // `deep-operation` manifest open, which is worse than the failure it was trying to record.
    if (current && value.currentRunId === operationId) {
      const failedState = { ...value, status: "failed", currentRunId: null, currentChildRunId: null, lastTriggerTurn: value.lastTriggerTurn ?? run.turn ?? null, lastTriggerWorldTime: value.lastTriggerWorldTime ?? null, lastCompletedTurn: value.lastCompletedTurn ?? null, lastCompletedWorldTime: value.lastCompletedWorldTime ?? null, currentReportRevision: value.currentReportRevision ?? 1, triggerReasons: Array.isArray(value.triggerReasons) ? value.triggerReasons : [], failure: error instanceof Error ? error.message : String(error) };
      await data.submit({ protocolVersion: 1, batchId: `${operationId}-deep-fail`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${operationId}-deep-fail-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: current.id, expectedRevision: current.revision, data: failedState, note: null }] }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
    }
    throw error;
  }
}
