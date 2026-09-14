import { validateAndNormalizeBatch } from "../lib/batch-validation.mjs";
import { submitCommitted } from "../lib/data-helpers.mjs";

export async function execute({ run, data }) {
  const prepared = run.nodes["prepare-archive"]?.output;
  if (!prepared?.shouldArchive) return { committed: false, skipped: true, reason: prepared?.reason || "not-eligible" };
  const modelBatch = structuredClone(run.nodes["archive-model"]?.output);
  if (!modelBatch || !Array.isArray(modelBatch.operations) || !modelBatch.operations.length) throw new Error("Eligible正文归档不得提交空变更批次。");
  const stableTime = run.startedAt || run.createdAt || "1970-01-01T00:00:00.000Z";
  modelBatch.protocolVersion = 1;
  modelBatch.batchId = `memory-archive-${run.id}`;
  modelBatch.status = "pending";
  modelBatch.commitPolicy = "atomic";
  modelBatch.operations = modelBatch.operations.map((operation, index) => ({ ...operation, operationId: `memory-archive-${run.id}-${index + 1}` }));
  modelBatch.operations.push({
    operationId: `memory-archive-${run.id}-coverage`,
    moduleId: "narrative-memory",
    collectionId: "support",
    recordType: "memory.archive-coverage",
    action: "create",
    targetId: `memory-archive-coverage-${run.id}`,
    data: {
      startTurn: prepared.firstTurn,
      endTurn: prepared.eligibleLastTurn,
      operation: "automatic",
      workflowRunId: run.id,
      batchId: `memory-archive-${run.id}`,
      coveredMessageIds: prepared.coveredMessageIds,
      completedAt: stableTime,
      userInstruction: null,
    },
  });
  modelBatch.operations.push({
    operationId: `memory-archive-${run.id}-state`,
    moduleId: "narrative-memory",
    collectionId: "support",
    recordType: "memory.archive-state",
    action: "update",
    targetId: prepared.archiveState.id,
    expectedRevision: prepared.archiveState.revision,
    data: {
      lastArchivedTurn: prepared.eligibleLastTurn,
      lastArchiveStatus: "succeeded",
      lastArchiveAt: stableTime,
      lastArchiveRunId: run.id,
      lastCoveredMessageId: prepared.lastCoveredMessageId,
    },
  });
  const normalized = await validateAndNormalizeBatch(data, modelBatch, { view: "archive", collections: ["entities", "relationships", "events", "cognitions", "knower-groups", "support", "source-captures"] });
  const receipt = await submitCommitted(data, normalized, {
    binding: { turn: prepared.eligibleLastTurn, messageId: prepared.lastCoveredMessageId },
    sourceMessageIds: prepared.sourceMessageIds,
  });
  return { committed: true, coveredTurns: [prepared.firstTurn, prepared.eligibleLastTurn], batchId: normalized.batchId, receipt };
}
