import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { submitCommitted } from "../lib/agent-change-batch.mjs";

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export async function execute({ run, workspace, conversation, data }) {
  const proposed = parseJson(await readFile(resolve(workspace, "handoff/plan/deep-report.json"), "utf8"));
  if (proposed.schemaVersion !== 1 || proposed.basisTurn !== run.turn) throw new Error("Deep report must use schemaVersion 1 and the frozen run basisTurn.");
  for (const field of ["coverage", "assumptions", "invalidatingSignals", "worldNarrativeTopics", "nextReviewTriggers"]) if (!Array.isArray(proposed[field])) throw new Error(`Deep report ${field} must be an array.`);
  if (proposed.referenceUpdates === undefined) proposed.referenceUpdates = [];
  if (!Array.isArray(proposed.referenceUpdates)) throw new Error("Deep report referenceUpdates must be an array.");
  if (proposed.worldNarrativeTopics.filter(item => item?.status === "active").length !== 1 || !proposed.worldNarrativeTopics.some(item => item?.status === "backup")) throw new Error("Deep report must contain exactly one active world narrative topic and at least one backup.");
  for (const field of ["summary", "content"]) if (typeof proposed[field] !== "string") throw new Error(`Deep report ${field} must be text.`);
  const currentMessages = new Map(conversation.messages.map(message => [message.id, message]));
  for (const source of run.sourceReferences || []) {
    if (source.kind !== "message") continue;
    const current = currentMessages.get(source.id);
    if (!current || current.revision !== source.revision) throw new Error(`Deep report basis became stale at message ${source.id}; discard and start a new run.`);
  }
  const report = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" });
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  if (!report || !state) throw new Error("Deep director singleton records are missing.");
  const latestMessage = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const batch = {
    protocolVersion: 1,
    batchId: `${run.id}-deep-complete`,
    status: "pending",
    commitPolicy: "atomic",
    operations: [
      { operationId: `${run.id}-report`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-report", action: "update", targetId: report.id, expectedRevision: report.revision, data: { basisTurn: run.turn, basisWorldTime: proposed.basisWorldTime ?? null, previousRevision: report.revision, coverage: proposed.coverage, assumptions: proposed.assumptions, invalidatingSignals: proposed.invalidatingSignals, summary: proposed.summary, content: proposed.content, worldNarrativeTopics: proposed.worldNarrativeTopics, nextReviewTriggers: proposed.nextReviewTriggers, referenceUpdates: proposed.referenceUpdates.map(({ referenceId, title, summary, change }) => ({ referenceId, title, summary, change })) }, note: null },
      { operationId: `${run.id}-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { status: "idle", currentRunId: null, lastTriggerTurn: run.turn, lastTriggerWorldTime: proposed.basisWorldTime ?? null, lastCompletedTurn: run.turn, lastCompletedWorldTime: proposed.basisWorldTime ?? null, currentReportRevision: report.revision + 1, triggerReasons: Array.isArray(run.arguments?.triggerReasons) ? run.arguments.triggerReasons : [], failure: null }, note: null }
    ]
  };
  const options = latestMessage ? { binding: { turn: latestMessage.binding.turn, messageId: latestMessage.id }, sourceMessageIds: (run.sourceReferences || []).filter(source => source.kind === "message").map(source => source.id) } : { binding: { turn: run.turn || 0, messageId: null } };
  const receipt = await submitCommitted(data, batch, options);
  return { committed: true, receiptId: receipt.id || receipt.batchId || batch.batchId, reportRevision: report.revision + 1 };
}
