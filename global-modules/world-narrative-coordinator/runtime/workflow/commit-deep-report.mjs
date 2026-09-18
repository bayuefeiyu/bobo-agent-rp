import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { submitCommitted } from "../lib/agent-change-batch.mjs";
import { validateDeepReport } from "../lib/deep-report.mjs";
import { deepOperationId } from "../lib/deep-operation-identity.mjs";

/**
 * Commit one deep report.
 *
 * The report file is produced by the `materialize-report` node from the planning Agent's structured
 * JSON, so this node reads that declared artifact instead of the plan node's answer. It re-validates
 * the file — using the same contract function the materializer used — because this is the point where
 * authoritative records change: a hand-edited, truncated or stale file must be rejected here rather
 * than published.
 *
 * The operation manifest is closed here, in the same atomic batch, exactly as the team-mode commit
 * does. Releasing the state alone left `deep-operation-turn-<n>` `running` forever: the wrapper never
 * calls `finish-deep-operation` in single mode, and that node refuses to close a manifest the state no
 * longer names.
 */
export async function execute({ run, node, workspace, conversation, data }) {
  const reportNodeId = typeof node.metadata?.reportNode === "string" && node.metadata.reportNode ? node.metadata.reportNode : "materialize-report";
  const reportNode = run.nodes?.[reportNodeId];
  if (!reportNode) throw new Error(`Deep report node ${reportNodeId} is not part of this run.`);
  const reportError = reportNode.attempts?.at(-1)?.error;
  if (reportNode.status !== "completed") throw new Error(`Deep report node ${reportNodeId} is ${reportNode.status}${reportError ? ` (${reportError})` : ""}; refusing to commit without a materialized report.`);
  const proposed = validateDeepReport(await readFile(resolve(workspace, "handoff", reportNodeId, "deep-report.json"), "utf8"), { basisTurn: run.turn });
  const currentMessages = new Map(conversation.messages.map(message => [message.id, message]));
  for (const source of run.sourceReferences || []) {
    if (source.kind !== "message") continue;
    const current = currentMessages.get(source.id);
    if (!current || current.revision !== source.revision) throw new Error(`Deep report basis became stale at message ${source.id}; discard and start a new run.`);
  }
  const report = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" });
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!report || !state) throw new Error("Deep director singleton records are missing.");
  const operation = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: deepOperationId(run.turn), view: "deep-director" });
  const operationValue = operation?.value?.data || operation?.value || null;
  const latestMessage = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const batch = {
    protocolVersion: 1,
    batchId: `${run.id}-deep-complete`,
    status: "pending",
    commitPolicy: "atomic",
    operations: [
      { operationId: `${run.id}-report`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-report", action: "update", targetId: report.id, expectedRevision: report.revision, data: { basisTurn: run.turn, basisWorldTime: proposed.basisWorldTime ?? null, previousRevision: report.revision, coverage: proposed.coverage, assumptions: proposed.assumptions, invalidatingSignals: proposed.invalidatingSignals, summary: proposed.summary, content: proposed.content, worldNarrativeTopics: proposed.worldNarrativeTopics, nextReviewTriggers: proposed.nextReviewTriggers, referenceUpdates: proposed.referenceUpdates.map(({ referenceId, title, summary, change }) => ({ referenceId, title, summary, change })) }, note: null },
      { operationId: `${run.id}-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...(state.value?.data || state.value || {}), status: "idle", currentRunId: null, currentChildRunId: null, lastTriggerTurn: run.turn, lastTriggerWorldTime: proposed.basisWorldTime ?? null, lastCompletedTurn: run.turn, lastCompletedWorldTime: proposed.basisWorldTime ?? null, currentReportRevision: report.revision + 1, triggerReasons: Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [], failure: null }, note: null }
    ]
  };
  // Close the manifest only when it is still this operation's running record; a retried commit whose
  // manifest is already terminal must not reopen or rewrite it.
  if (operation && operationValue?.status === "running") {
    batch.operations.push({ operationId: `${run.id}-manifest-complete`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-operation", action: "update", targetId: operation.id, expectedRevision: operation.revision, data: { ...operationValue, status: "completed", closedTurn: run.turn, terminalError: null }, note: null });
  }
  const options = latestMessage ? { binding: { turn: latestMessage.binding.turn, messageId: latestMessage.id }, sourceMessageIds: (run.sourceReferences || []).filter(source => source.kind === "message").map(source => source.id) } : { binding: { turn: run.turn || 0, messageId: null } };
  const receipt = await submitCommitted(data, batch, options);
  return { committed: true, receiptId: receipt.id || receipt.batchId || batch.batchId, reportRevision: report.revision + 1, operationClosed: batch.operations.length > 2 };
}
