import { deriveEventSummaryData, effectiveEventEntries } from "../lib/core.mjs";
import { queryAll, submitCommitted, unwrap } from "../lib/data-helpers.mjs";
import { validateAndNormalizeBatch } from "../lib/batch-validation.mjs";

export async function execute({ run, data }) {
  const prepared = run.nodes["prepare-compression"]?.output;
  if (!prepared?.shouldCompress) return { committed: false, skipped: true, reason: prepared?.reason || "not-eligible" };
  const groups = Array.isArray(run.nodes["plan-compression"]?.output?.groups) ? run.nodes["plan-compression"].output.groups : [];
  if (!groups.length) return { committed: false, skipped: true, reason: "no-semantic-groups" };
  const eventItems = await queryAll(data, { moduleId: "narrative-memory", collectionId: "events", view: "maintenance" });
  const events = eventItems.map(item => unwrap(item));
  const effective = effectiveEventEntries(events);
  const entriesById = new Map(effective.map(item => [item.id, item]));
  const used = new Set();
  const operations = [];
  for (const [index, group] of groups.entries()) {
    for (const id of group.sourceEntryIds || []) {
      if (used.has(id)) throw new Error(`Compression source ${id} is used more than once.`);
      if (!entriesById.has(id)) throw new Error(`Compression source ${id} is no longer effective.`);
      used.add(id);
    }
    const sourceEntries = (group.sourceEntryIds || []).map(id => entriesById.get(id));
    const timeRuleVersions = new Set(sourceEntries.map(entry => entry.recordType === "memory.event" ? entry.data.time.timeRuleVersion : entry.data.timeRange.timeRuleVersion));
    if (timeRuleVersions.size !== 1) throw new Error("Compression sources use incompatible time-rule versions.");
    const id = `memory-event-summary-${run.id}-${index + 1}`;
    operations.push({ operationId: `memory-compress-${run.id}-${index + 1}`, moduleId: "narrative-memory", collectionId: "events", recordType: "memory.event-summary", action: "create", targetId: id, data: deriveEventSummaryData(group, entriesById, [...timeRuleVersions][0]) });
  }
  const projectedCount = effective.length - [...groups].reduce((sum, group) => sum + Math.max(0, new Set(group.sourceEntryIds || []).size - 1), 0);
  if (projectedCount >= effective.length) return { committed: false, skipped: true, reason: "no-reduction" };
  const growth = prepared.settingsRecord.data.compression.growthPerSuccessfulCycle;
  const state = prepared.stateRecord.data;
  const stableTime = run.startedAt || run.createdAt || "1970-01-01T00:00:00.000Z";
  operations.push({
    operationId: `memory-compress-${run.id}-state`, moduleId: "narrative-memory", collectionId: "support", recordType: "memory.maintenance-state", action: "update", targetId: prepared.stateRecord.id, expectedRevision: prepared.stateRecord.revision,
    data: { ...state, compression: { triggerEntryCount: state.compression.triggerEntryCount + growth, targetEntryCount: state.compression.targetEntryCount + growth, successfulCycleCount: state.compression.successfulCycleCount + 1, status: "succeeded", lastRunAt: stableTime, lastRunId: run.id } },
  });
  const raw = { protocolVersion: 1, batchId: `memory-compression-${run.id}`, status: "pending", commitPolicy: "atomic", operations };
  const normalized = await validateAndNormalizeBatch(data, raw, { view: "archive", collections: ["entities", "relationships", "events", "cognitions", "knower-groups", "support"] });
  const receipt = await submitCommitted(data, normalized);
  return { committed: true, batchId: normalized.batchId, previousEntryCount: effective.length, projectedEntryCount: projectedCount, receipt };
}
