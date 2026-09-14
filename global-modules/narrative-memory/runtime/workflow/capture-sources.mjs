export async function execute({ run, data }) {
  const captures = Array.isArray(run.arguments?.request?.captures) ? run.arguments.request.captures : [];
  if (!captures.length) return { committed: false, skipped: true, reason: "no-adapted-sources" };
  const operations = [];
  for (const [index, capture] of captures.entries()) {
    if (!capture.sourceModuleId || !capture.adapterId || !capture.title || !["snapshot", "per-turn"].includes(capture.historyMode)) throw new Error(`Invalid source capture at index ${index}.`);
    const id = capture.captureId || `memory-source-${run.id}-${index + 1}`;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error(`Invalid source capture ID at index ${index}.`);
    if (capture.captureId && await data.get({ moduleId: "narrative-memory", collectionId: "source-captures", id, view: "archive" })) continue;
    operations.push({
      operationId: `memory-source-${run.id}-${index + 1}`,
      moduleId: "narrative-memory",
      collectionId: "source-captures",
      recordType: "memory.source-capture",
      action: "create",
      targetId: id,
      data: {
        sourceModuleId: capture.sourceModuleId,
        adapterId: capture.adapterId,
        title: capture.title,
        capturedTurn: run.turn || 0,
        historyMode: capture.historyMode,
        captureStatus: capture.captureStatus === "failed" ? "failed" : "succeeded",
        format: ["json", "yaml", "text"].includes(capture.format) ? capture.format : "text",
        content: capture.content ?? null,
        sourceReferences: Array.isArray(capture.sourceReferences) ? capture.sourceReferences : [],
        error: capture.error ? String(capture.error) : null,
      },
    });
  }
  if (!operations.length) return { committed: false, skipped: true, reason: "already-captured" };
  const batch = { protocolVersion: 1, batchId: `memory-source-capture-${run.id}`, status: "pending", commitPolicy: "atomic", operations };
  const receipt = await submitCommitted(data, batch);
  return { committed: true, batchId: batch.batchId, count: operations.length, receipt };
}
import { submitCommitted } from "../lib/data-helpers.mjs";
