import { createHash, randomUUID } from "node:crypto";
import { capabilityAllows, isSafeDataId, recordTypeDefinition } from "./rp-data-contracts.mjs";
import { createDataRecord, reviseDataRecord } from "./rp-data-records.mjs";
import { extractRecordIndexes } from "./rp-data-index.mjs";
import { readDataReceipt, writeDataReceipt } from "./rp-data-transactions.mjs";

const POLICIES = new Set(["atomic", "grouped", "best-effort"]);
const LIFECYCLE = new Set(["create", "append", "update", "revise", "retract", "archive", "restore", "delete"]);
const commitQueues = new Map();

function clone(value) {
  return structuredClone(value);
}

export function normalizeDataBatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Data batch must be an object.");
  const batchFields = ["protocolVersion", "batchId", "status", "commitPolicy", "operations"];
  if (Object.keys(value).length !== batchFields.length || batchFields.some(field => !Object.hasOwn(value, field))) throw new Error("Data batch must use the exact protocol v1 field set.");
  if (value.protocolVersion !== 1) throw new Error("Data batch protocolVersion must be 1.");
  if (!isSafeDataId(value.batchId)) throw new Error("Data batch ID must be safe.");
  if (value.status !== "pending") throw new Error("Only pending data batches can be submitted.");
  const commitPolicy = value.commitPolicy || "atomic";
  if (!POLICIES.has(commitPolicy)) throw new Error("Data batch commitPolicy is invalid.");
  if (!Array.isArray(value.operations) || !value.operations.length) throw new Error("Data batch requires operations.");
  const ids = new Set();
  const operations = value.operations.map((operation, index) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error(`Operation ${index} must be an object.`);
    const operationFields = new Set(["operationId", "moduleId", "collectionId", "recordType", "action", "targetId", "data", "note", "groupId", "expectedRevision", "params"]);
    const unknown = Object.keys(operation).filter(field => !operationFields.has(field));
    if (unknown.length) throw new Error(`Operation ${index} contains unknown fields: ${unknown.join(", ")}.`);
    if (!isSafeDataId(operation.operationId) || ids.has(operation.operationId)) throw new Error(`Operation ${index} has an invalid or duplicate operationId.`);
    ids.add(operation.operationId);
    for (const field of ["moduleId", "collectionId", "recordType", "action"]) if (!isSafeDataId(operation[field])) throw new Error(`Operation ${operation.operationId} has an invalid ${field}.`);
    return {
      ...clone(operation),
      note: typeof operation.note === "string" && operation.note.trim() ? operation.note.trim() : null,
      groupId: isSafeDataId(operation.groupId) ? operation.groupId : "default",
    };
  });
  return { protocolVersion: 1, batchId: value.batchId, status: "pending", commitPolicy, operations };
}

export function createDataBatchDraft({ batchId, commitPolicy = "atomic" }) {
  return normalizeDataBatch({
    protocolVersion: 1,
    batchId,
    status: "pending",
    commitPolicy,
    operations: [{ operationId: "placeholder", moduleId: "placeholder", collectionId: "placeholder", recordType: "placeholder", action: "placeholder" }],
  }).operations.length && { protocolVersion: 1, batchId, status: "pending", commitPolicy, operations: [] };
}

export function updateDataBatchDraft(draft, changes) {
  if (!draft || draft.protocolVersion !== 1 || draft.status !== "pending" || !Array.isArray(draft.operations)) throw new Error("Data draft is invalid or no longer pending.");
  const next = clone(draft);
  for (const change of changes || []) {
    if (!isSafeDataId(change?.operationId)) throw new Error("A data draft change requires a safe operationId.");
    const index = next.operations.findIndex(operation => operation.operationId === change.operationId);
    if (change.action === "cancel") {
      if (index >= 0) next.operations.splice(index, 1);
      continue;
    }
    if (change.action !== "add" && change.action !== "replace") throw new Error(`Unsupported data draft action ${change.action}.`);
    if (!change.operation || typeof change.operation !== "object" || Array.isArray(change.operation)) throw new Error(`Data draft ${change.action} requires operation.`);
    const operation = { ...clone(change.operation), operationId: change.operationId };
    if (change.action === "add") {
      if (index >= 0) {
        if (JSON.stringify(next.operations[index]) !== JSON.stringify(operation)) throw new Error(`Operation ${change.operationId} already exists with different content.`);
      } else next.operations.push(operation);
    } else {
      if (index < 0) throw new Error(`Operation ${change.operationId} does not exist.`);
      next.operations[index] = operation;
    }
  }
  return next;
}

function conflict(operation, record) {
  if (!Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 1) {
    return { code: "expected_revision_required", expectedRevision: null, actualRevision: record.revision };
  }
  return operation.expectedRevision !== record.revision
    ? { code: "revision_conflict", expectedRevision: operation.expectedRevision, actualRevision: record.revision }
    : null;
}

function provenance(context, batch, operation) {
  return {
    initiatorKind: context.initiatorKind || "runtime",
    initiatorId: context.initiatorId || null,
    workflowId: context.workflowId || null,
    workflowRunId: context.workflowRunId || null,
    nodeId: context.nodeId || null,
    batchId: batch.batchId,
    operationId: operation.operationId,
    appliedBy: "rp-data-runtime",
    createdAt: new Date().toISOString(),
  };
}

async function collectionState(store, states, moduleId, collectionId) {
  const key = `${moduleId}/${collectionId}`;
  if (!states.has(key)) states.set(key, { moduleId, collectionId, ...clone(await store.readCollection(moduleId, collectionId)) });
  return states.get(key);
}

async function applyOperation(store, states, batch, operation, access, context, handlers) {
  const module = store.module(operation.moduleId);
  const definition = recordTypeDefinition(module.contract, operation.collectionId, operation.recordType);
  const capabilityIds = Array.isArray(access)
    ? access.filter(item => item.moduleId === operation.moduleId && item.collectionId === operation.collectionId).flatMap(item => item.capabilities || [])
    : access[operation.moduleId] || [];
  if (!capabilityAllows(module.contract, capabilityIds, { collectionId: operation.collectionId, action: operation.action })) {
    throw Object.assign(new Error(`Node lacks capability for ${operation.action} on ${operation.moduleId}/${operation.collectionId}.`), { code: "permission_denied" });
  }
  if (!definition.actions.includes(operation.action)) throw Object.assign(new Error(`Record type ${operation.recordType} does not allow ${operation.action}.`), { code: "action_not_allowed" });
  const state = await collectionState(store, states, operation.moduleId, operation.collectionId);
  const handler = handlers?.[`${operation.moduleId}:${operation.collectionId}:${operation.action}`]
    || await store.operationHandler(operation.moduleId, operation.collectionId, operation.recordType, operation.action);
  if (handler) {
    if (!isSafeDataId(operation.targetId)) throw Object.assign(new Error(`${operation.action} requires targetId.`), { code: "missing_target" });
    const current = state.records.find(record => record.id === operation.targetId);
    if (!current) throw Object.assign(new Error(`Record ${operation.targetId} does not exist.`), { code: "missing_record" });
    const mismatch = conflict(operation, current);
    if (mismatch) throw Object.assign(new Error(`Record ${current.id} revision conflict.`), mismatch);
    const response = await handler({ state: clone(state), current: clone(current), operation: clone(operation), contract: clone(module.contract), context: clone(context), batch: clone(batch) });
    if (!response || typeof response !== "object" || !response.record || typeof response.record !== "object" || Array.isArray(response.record) || !response.record.data || typeof response.record.data !== "object" || Array.isArray(response.record.data)) {
      throw Object.assign(new Error(`Processor for ${operation.action} must return { record: { data, status?, note? }, result? }.`), { code: "invalid_processor_result" });
    }
    const record = reviseDataRecord(current, response.record.data, {
      status: response.record.status ?? current.status,
      note: operation.note ?? response.record.note ?? current.note,
      provenance: provenance(context, batch, operation),
    });
    await store.validateRecordData(record);
    extractRecordIndexes(record, module.contract);
    const index = state.records.findIndex(item => item.id === current.id);
    state.records[index] = record;
    state.history.push(record);
    return response.result ?? record;
  }
  if (!LIFECYCLE.has(operation.action)) throw Object.assign(new Error(`No handler is registered for ${operation.action}.`), { code: "missing_handler" });
  const nextSequence = Math.max(-1, ...state.history.map(record => record.sequence), ...state.records.map(record => record.sequence)) + 1;
  if (operation.action === "create" || operation.action === "append") {
    const record = createDataRecord({
      contract: module.contract,
      collectionId: operation.collectionId,
      recordType: operation.recordType,
      data: operation.data,
      sequence: nextSequence,
      binding: context.binding,
      id: operation.targetId || null,
      note: operation.note,
      provenance: provenance(context, batch, operation),
    });
    await store.validateRecordData(record);
    if (state.records.some(item => item.id === record.id)) throw Object.assign(new Error(`Record ${record.id} already exists.`), { code: "duplicate_record" });
    extractRecordIndexes(record, module.contract);
    state.records.push(record);
    state.history.push(record);
    return record;
  }
  if (!isSafeDataId(operation.targetId)) throw Object.assign(new Error(`${operation.action} requires targetId.`), { code: "missing_target" });
  const index = state.records.findIndex(record => record.id === operation.targetId);
  if (index < 0) throw Object.assign(new Error(`Record ${operation.targetId} does not exist.`), { code: "missing_record" });
  const current = state.records[index];
  const mismatch = conflict(operation, current);
  if (mismatch) throw Object.assign(new Error(`Record ${current.id} revision conflict.`), mismatch);
  if (operation.action === "delete") {
    state.records.splice(index, 1);
    state.history = state.history.filter(record => record.id !== current.id);
    return null;
  }
  const status = operation.action === "retract" ? "retracted" : operation.action === "archive" ? "archived" : operation.action === "restore" ? "active" : current.status;
  const data = operation.action === "update" || operation.action === "revise" ? operation.data : current.data;
  const record = reviseDataRecord(current, data, { status, note: operation.note ?? current.note, provenance: provenance(context, batch, operation) });
  await store.validateRecordData(record);
  extractRecordIndexes(record, module.contract);
  state.records[index] = record;
  state.history.push(record);
  return record;
}

function operationFailure(operation, error) {
  return {
    operationId: operation.operationId,
    status: "failed",
    code: error?.code || "operation_failed",
    error: String(error?.message || error),
    ...(error?.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }),
  };
}

async function applyGroup(store, baseStates, batch, operations, access, context, handlers) {
  const states = clone(baseStates);
  const results = [];
  for (const operation of operations) {
    try {
      const record = await applyOperation(store, states, batch, operation, access, context, handlers);
      results.push({ operationId: operation.operationId, status: "committed", recordId: record?.id || operation.targetId || null, revision: record?.revision || null });
    } catch (error) {
      return { ok: false, states: baseStates, results: [...results, operationFailure(operation, error)] };
    }
  }
  return { ok: true, states, results };
}

async function executeDataBatchUnlocked(store, value, { access = {}, context = {}, handlers = {}, allowBestEffort = false } = {}) {
  const batch = normalizeDataBatch(value);
  if (batch.commitPolicy === "best-effort" && allowBestEffort !== true) {
    throw Object.assign(new Error("The current workflow node does not allow best-effort data commits."), { code: "best_effort_not_allowed" });
  }
  const batchHash = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
  const existing = await readDataReceipt(store.sessionDirectory, batch.batchId);
  if (existing) {
    if (existing.batchHash === batchHash) return { ...existing, idempotentReplay: true };
    if (existing.status !== "failed") return { schemaVersion: 1, batchId: batch.batchId, batchHash, status: "failed", committedAt: null, results: [{ operationId: null, status: "failed", code: "idempotency_conflict", error: "The batch ID was already committed with different content." }], runtimeReceiptId: randomUUID(), idempotentReplay: false };
  }
  let states = new Map();
  const results = [];
  if (batch.commitPolicy === "atomic") {
    const applied = await applyGroup(store, states, batch, batch.operations, access, context, handlers);
    results.push(...applied.results);
    if (!applied.ok) return writeDataReceipt(store.sessionDirectory, { schemaVersion: 1, batchId: batch.batchId, batchHash, status: "failed", committedAt: null, results, runtimeReceiptId: randomUUID() });
    states = applied.states;
  } else if (batch.commitPolicy === "grouped") {
    const groups = new Map();
    for (const operation of batch.operations) {
      if (!groups.has(operation.groupId)) groups.set(operation.groupId, []);
      groups.get(operation.groupId).push(operation);
    }
    for (const operations of groups.values()) {
      const applied = await applyGroup(store, states, batch, operations, access, context, handlers);
      results.push(...applied.results);
      if (applied.ok) states = applied.states;
    }
  } else {
    for (const operation of batch.operations) {
      const applied = await applyGroup(store, states, batch, [operation], access, context, handlers);
      results.push(...applied.results);
      if (applied.ok) states = applied.states;
    }
  }
  const committed = results.filter(result => result.status === "committed").length;
  const failed = results.length - committed;
  const receipt = {
    schemaVersion: 1,
    batchId: batch.batchId,
    batchHash,
    status: failed === 0 ? "committed" : committed ? "partial" : "failed",
    committedAt: committed ? new Date().toISOString() : null,
    results,
    runtimeReceiptId: randomUUID(),
  };
  if (committed) {
    try {
      await store.commit(batch.batchId, states, receipt);
    } catch (error) {
      return writeDataReceipt(store.sessionDirectory, {
        ...receipt,
        status: "failed",
        committedAt: null,
        results: [...results, { operationId: null, status: "failed", code: error?.code || "commit_failed", error: String(error?.message || error) }],
      });
    }
  }
  return receipt;
}

export async function executeDataBatch(store, value, options = {}) {
  const key = store.sessionDirectory;
  const previous = commitQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  commitQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await executeDataBatchUnlocked(store, value, options);
  } finally {
    release();
    if (commitQueues.get(key) === queued) commitQueues.delete(key);
  }
}
