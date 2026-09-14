import { collectionFor, getById, queryAll, unwrap } from "./data-helpers.mjs";
import { normalizeRecordData, resolveGroupMembers, uniqueStrings } from "./core.mjs";
import { loadTemplates, loadTimeAdapter } from "./module-files.mjs";

const ALLOWED_TYPES = new Set(["memory.entity", "memory.relationship", "memory.event", "memory.event-summary", "memory.cognition", "memory.knower-group", "memory.settings", "memory.archive-state", "memory.archive-coverage", "memory.maintenance-state", "memory.time-auxiliary", "memory.source-capture"]);
const WRITABLE_ACTIONS = new Set(["create", "update", "revise", "retract", "archive", "restore"]);

function dataReferences(recordType, data) {
  if (recordType === "memory.entity") return data.informationBlocks?.flatMap(block => block.knowerIds || []) || [];
  if (recordType === "memory.relationship") return [...(data.partyIds || []), ...(data.overviewInformationControl?.knowerIds || []), ...(data.informationBlocks?.flatMap(block => block.knowerIds || []) || [])];
  if (recordType === "memory.event") return [...(data.participantIds || []), ...(data.locationIds || []), ...(data.relatedEntityIds || []), ...(data.precedingEventIds || []), ...(data.relatedEventIds || []), ...(data.overviewInformationControl?.knowerIds || []), ...(data.informationBlocks?.flatMap(block => block.knowerIds || []) || [])];
  if (recordType === "memory.event-summary") return [...(data.sourceEntryIds || []), ...(data.coveredEventIds || []), ...(data.precedingSummaryIds || []), ...(data.locationIds || []), ...(data.overviewInformationControl?.knowerIds || [])];
  if (recordType === "memory.cognition") return [...(data.subjectRecordIds || []), ...(data.relatedRecordIds || []), ...(data.knowerScope?.knowerIds || []), ...(data.source?.entityIds || []), ...(data.source?.recordIds || []), ...(data.precedingCognitionIds || [])];
  if (recordType === "memory.knower-group") return [...(data.includeIds || []), ...(data.excludeIds || [])];
  return [];
}

async function allCurrentRecords(data, view, collections) {
  const records = [];
  for (const collectionId of collections) {
    const items = await queryAll(data, { moduleId: "narrative-memory", collectionId, view });
    records.push(...items.map(item => unwrap(item)));
  }
  return records;
}

export async function validateAndNormalizeBatch(data, rawBatch, { allowSupport = true, view = "maintenance", collections = ["entities", "relationships", "events", "cognitions", "knower-groups", "support", "source-captures"] } = {}) {
  if (!rawBatch || rawBatch.protocolVersion !== 1 || rawBatch.commitPolicy !== "atomic" || !Array.isArray(rawBatch.operations)) throw new Error("Expected an atomic unified-change-batch v1.");
  if (!rawBatch.batchId || rawBatch.status !== "pending") throw new Error("Batch requires batchId and pending status.");
  const current = await allCurrentRecords(data, view, collections);
  const currentById = new Map(current.map(item => [item.id, item]));
  // Queries normally expose effective active records.  A restore operation,
  // however, must also be able to address an inactive record by its stable ID.
  for (const source of rawBatch.operations) {
    if (!source || source.action === "create" || currentById.has(source.targetId)) continue;
    const collectionId = collectionFor(source.recordType);
    if (!collections.includes(collectionId)) continue;
    const existing = await getById(data, collectionId, source.targetId, view);
    if (existing) currentById.set(existing.id, existing);
  }
  const { templates } = await loadTemplates();
  const timeAdapter = await loadTimeAdapter();
  const operations = [];
  const pendingData = new Map();
  for (const [index, source] of rawBatch.operations.entries()) {
    if (!source || source.moduleId !== "narrative-memory" || !ALLOWED_TYPES.has(source.recordType) || source.collectionId !== collectionFor(source.recordType) || !WRITABLE_ACTIONS.has(source.action)) throw new Error(`Invalid memory operation at index ${index}.`);
    if (!allowSupport && source.collectionId === "support") throw new Error("This workflow cannot modify support records.");
    if (!source.operationId || !source.targetId) throw new Error(`Operation ${index} requires operationId and targetId.`);
    if (source.action !== "create") {
      const existing = currentById.get(source.targetId);
      if (!existing || source.expectedRevision !== existing.revision) throw new Error(`Stale or missing expectedRevision for ${source.targetId}.`);
      if (existing.recordType !== source.recordType) throw new Error(`Record type mismatch for ${source.targetId}.`);
    }
    const operation = { operationId: source.operationId, moduleId: "narrative-memory", collectionId: source.collectionId, recordType: source.recordType, action: source.action, targetId: source.targetId };
    if (source.expectedRevision !== undefined) operation.expectedRevision = source.expectedRevision;
    if (source.groupId !== undefined) operation.groupId = source.groupId;
    if (source.note !== undefined) operation.note = source.note;
    if (["create", "update", "revise"].includes(source.action)) {
      const templateId = source.data?.templateId;
      const template = templateId ? templates.get(templateId) : null;
      if (["memory.entity", "memory.relationship", "memory.event", "memory.event-summary", "memory.cognition", "memory.knower-group"].includes(source.recordType)) {
        if (!template || template.recordType !== source.recordType) throw new Error(`Missing or incompatible template ${templateId}.`);
        if (source.recordType === "memory.entity" && template.entityKind !== source.data?.entityKind && source.data?.templateMode !== "custom") throw new Error(`Entity template ${templateId} does not match entityKind.`);
      }
      operation.data = normalizeRecordData(source.recordType, source.data, template);
      if (source.recordType === "memory.event") {
        timeAdapter.validateTrueTime(operation.data.time.trueTime);
        operation.data.time.sortValue = timeAdapter.deriveSortValue(operation.data.time.trueTime);
        operation.data.time.timeRuleVersion = timeAdapter.timeRuleVersion;
      }
      pendingData.set(source.targetId, { id: source.targetId, recordType: source.recordType, data: operation.data });
    }
    operations.push(operation);
  }
  const effectiveById = new Map(currentById);
  for (const [id, record] of pendingData) effectiveById.set(id, record);
  const groups = [...effectiveById.values()].filter(item => item.recordType === "memory.knower-group").map(item => ({ id: item.id, ...item.data }));
  const changedGroupIds = operations.filter(item => item.recordType === "memory.knower-group" && item.data).map(item => item.targetId);
  const resolvedGroups = resolveGroupMembers(groups, { refreshFixedIds: changedGroupIds });
  for (const operation of operations.filter(item => item.recordType === "memory.knower-group" && item.data)) operation.data.resolvedMemberIds = resolvedGroups.get(operation.targetId) || [];
  const knownIds = new Set([...effectiveById.keys(), ...operations.filter(item => item.action === "create").map(item => item.targetId)]);
  for (const operation of operations.filter(item => item.data)) {
    const missing = uniqueStrings(dataReferences(operation.recordType, operation.data)).filter(id => !knownIds.has(id));
    if (missing.length) throw new Error(`Record ${operation.targetId} references unknown IDs: ${missing.join(", ")}.`);
  }
  return { protocolVersion: 1, batchId: rawBatch.batchId, status: "pending", commitPolicy: "atomic", operations };
}
