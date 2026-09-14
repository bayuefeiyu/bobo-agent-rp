import { validateAndNormalizeBatch } from "../lib/batch-validation.mjs";
import { queryAll, submitCommitted } from "../lib/data-helpers.mjs";

export function contiguousCoveredTurn(lastArchivedTurn, coverages, current) {
  const intervals = lastArchivedTurn > 0 ? [{ start: 1, end: lastArchivedTurn }] : [];
  for (const item of coverages) {
    const start = Number(item.value?.startTurn);
    const end = Number(item.value?.endTurn);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) intervals.push({ start, end });
  }
  intervals.push({ start: current.firstTurn, end: current.eligibleLastTurn });
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let contiguous = 0;
  for (const interval of intervals) {
    if (interval.start > contiguous + 1) break;
    contiguous = Math.max(contiguous, interval.end);
  }
  return contiguous;
}

export async function execute({ run, data }) {
  const prepared = run.nodes["prepare-range"]?.output;
  if (!prepared?.shouldArchive) throw new Error("Range repair preparation is missing.");
  const supplied = structuredClone(run.nodes["range-model"]?.output || {});
  const modelOperations = Array.isArray(supplied.operations) ? supplied.operations : [];
  const stableTime = run.startedAt || run.createdAt || "1970-01-01T00:00:00.000Z";
  const batchId = `memory-range-repair-${run.id}`;
  const coverageId = `memory-archive-coverage-${run.id}`;
  const operations = modelOperations.map((operation, index) => ({ ...operation, operationId: `${batchId}-${index + 1}` }));
  operations.push({
    operationId: `${batchId}-coverage`,
    moduleId: "narrative-memory",
    collectionId: "support",
    recordType: "memory.archive-coverage",
    action: "create",
    targetId: coverageId,
    data: {
      startTurn: prepared.firstTurn,
      endTurn: prepared.eligibleLastTurn,
      operation: prepared.operation,
      workflowRunId: run.id,
      batchId,
      coveredMessageIds: prepared.coveredMessageIds,
      completedAt: stableTime,
      userInstruction: prepared.userInstruction,
    },
  });
  const existingCoverage = await queryAll(data, { moduleId: "narrative-memory", collectionId: "support", recordTypes: ["memory.archive-coverage"], view: "archive" });
  const contiguous = contiguousCoveredTurn(prepared.archiveState.data.lastArchivedTurn, existingCoverage, prepared);
  if (contiguous > prepared.archiveState.data.lastArchivedTurn) {
    operations.push({
      operationId: `${batchId}-state`,
      moduleId: "narrative-memory",
      collectionId: "support",
      recordType: "memory.archive-state",
      action: "update",
      targetId: prepared.archiveState.id,
      expectedRevision: prepared.archiveState.revision,
      data: {
        lastArchivedTurn: contiguous,
        lastArchiveStatus: "succeeded",
        lastArchiveAt: stableTime,
        lastArchiveRunId: run.id,
        lastCoveredMessageId: prepared.lastCoveredMessageId,
      },
    });
  }
  const batch = { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations };
  const normalized = await validateAndNormalizeBatch(data, batch, { view: "archive", collections: ["entities", "relationships", "events", "cognitions", "knower-groups", "support", "source-captures"] });
  const receipt = await submitCommitted(data, normalized, {
    binding: { turn: prepared.eligibleLastTurn, messageId: prepared.lastCoveredMessageId },
    sourceMessageIds: prepared.sourceMessageIds,
  });
  return { committed: true, operation: prepared.operation, coveredTurns: [prepared.firstTurn, prepared.eligibleLastTurn], contiguousArchivedThrough: contiguous, batchId, coverageId, receipt };
}
