import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withDataCommitLock } from "./rp-data-changes.mjs";
import { commitDataFiles, recoverDataTransactions } from "./rp-data-transactions.mjs";
import { buildDataIndex, buildIdentityEntries } from "./rp-data-index.mjs";

const clone = value => structuredClone(value);
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const manifestPath = store => resolve(store.sessionDirectory, "workflow", "executions.json");
const blobPath = (store, id) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid execution state reference.");
  return resolve(store.sessionDirectory, "workflow", "execution-states", `${id}.json`);
};
async function json(path, fallback) {
  return readFile(path, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT" && fallback !== undefined) return clone(fallback);
    throw error;
  });
}
async function manifest(store) {
  const value = await json(manifestPath(store), { schemaVersion: 1, revision: 0, turn: 0, executions: {}, selected: {} });
  if (value.schemaVersion !== 1 || !value.executions || !value.selected) throw new Error("Invalid execution manifest.");
  return value;
}
async function putBlob(store, value) {
  const id = hash(value);
  const path = blobPath(store, id);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", flag: "wx" }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  return id;
}
async function putState(store, state) {
  const references = new Map();
  const reference = async record => {
    const key = hash(record);
    if (!references.has(key)) references.set(key, await putBlob(store, { schemaVersion: 1, kind: "record", value: record }));
    return references.get(key);
  };
  const history = [], records = [];
  for (const record of state.history) history.push(await reference(record));
  for (const record of state.records) records.push(await reference(record));
  return putBlob(store, { schemaVersion: 1, kind: "collection", history, records });
}
async function readBlob(store, id) {
  const blob = await json(blobPath(store, id));
  if (hash(blob) !== id) throw new Error("Execution state content does not match its reference.");
  return blob;
}
async function readState(store, id) {
  const state = await readBlob(store, id);
  if (state.kind !== "collection") throw new Error("Invalid execution collection reference.");
  const records = new Map();
  for (const reference of new Set([...state.history, ...state.records])) {
    const blob = await readBlob(store, reference);
    if (blob.kind !== "record") throw new Error("Invalid execution record reference.");
    records.set(reference, blob.value);
  }
  return { history: state.history.map(reference => clone(records.get(reference))), records: state.records.map(reference => clone(records.get(reference))) };
}
function entryFor(value, id) {
  const entry = value.executions[id];
  if (!entry) throw failure("execution_missing", "This execution was deleted or does not exist.");
  return entry;
}
function assertCurrent(value, entry) {
  if (entry.turn !== value.turn) throw failure("execution_turn_locked", "Only the current turn may be executed or adopted.");
}
async function saveManifest(store, value, label, files = []) {
  value.revision += 1;
  const batchId = `execution-${label}-${randomUUID()}`;
  return commitDataFiles(store.sessionDirectory, batchId,
    [...files, { path: manifestPath(store), content: `${JSON.stringify(value, null, 2)}\n` }],
    { schemaVersion: 1, batchId, status: "committed", committedAt: new Date().toISOString(), results: [], reason: label });
}
async function locked(store, work) {
  return withDataCommitLock(store.sessionDirectory, async () => {
    await recoverDataTransactions(store.sessionDirectory);
    return work(await manifest(store));
  });
}
async function snapshot(store) {
  const refs = {};
  for (const module of store.modules.values()) {
    for (const collectionId of Object.keys(module.contract.collections)) {
      refs[`${module.contract.moduleId}/${collectionId}`] = await putState(store, await store.readCollection(module.contract.moduleId, collectionId));
    }
  }
  return refs;
}
function changedIds(before, after) {
  const left = new Map(before.records.map(record => [record.id, record]));
  const right = new Map(after.records.map(record => [record.id, record]));
  return [...new Set([...left.keys(), ...right.keys()])].filter(id => !same(left.get(id), right.get(id)));
}
// Merge complete histories only for records contributed by this execution. Unrelated records and
// their later revisions remain untouched. A changed target is a conflict, never an overwrite.
function replaceContribution(current, expected, desired, ids) {
  const currentRecords = new Map(current.records.map(record => [record.id, record]));
  const expectedRecords = new Map(expected.records.map(record => [record.id, record]));
  const desiredRecords = new Map(desired.records.map(record => [record.id, record]));
  for (const id of ids) {
    if (!same(currentRecords.get(id), expectedRecords.get(id))) throw failure("execution_adoption_conflict", `Record ${id} changed outside this execution.`);
    if (desiredRecords.has(id)) currentRecords.set(id, clone(desiredRecords.get(id)));
    else currentRecords.delete(id);
  }
  const replaced = new Set(ids);
  return {
    records: [...currentRecords.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
    history: [...current.history.filter(record => !replaced.has(record.id)), ...desired.history.filter(record => replaced.has(record.id))],
  };
}

export function executionBatchId(executionId, batchId) {
  return executionId ? `exec-${hash(`${executionId}:${batchId}`)}` : batchId;
}

/** Runtime-owned lifecycle; module contracts still own collection contents and permissions. */
export function createExecutionService(store) {
  return {
    async list() { return locked(store, value => clone(value)); },
    async beginTurn(turn) {
      if (!Number.isSafeInteger(turn) || turn < 0) throw new Error("Invalid execution turn.");
      return locked(store, async value => {
        if (turn < value.turn) throw failure("execution_turn_locked", "Delete the later turns before reopening an earlier turn.");
        if (turn === value.turn) return clone(value);
        value.turn = turn;
        await saveManifest(store, value, "begin-turn");
        return clone(value);
      });
    },
    async start({ id, workflowId, turn, previousId = null, parentId = null, attemptId = null, policy = {}, invocation = {}, sourceReferences = [], candidate = false, inputStore = null, lifecycle = false }) {
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Invalid execution ID.");
      return locked(store, async value => {
        if (turn !== value.turn) throw failure("execution_turn_locked", "Only the current turn may start a new execution.");
        const fingerprint = hash({ workflowId, turn, previousId, parentId, attemptId, invocation, candidate, lifecycle });
        if (value.executions[id]) {
          if (value.executions[id].fingerprint !== fingerprint) throw failure("execution_identity_conflict", "Execution ID was used with different inputs.");
          return clone(value.executions[id]);
        }
        const previous = previousId ? entryFor(value, previousId) : null;
        if (previous && (previous.turn !== turn || previous.workflowId !== workflowId)) throw failure("execution_target_mismatch", "A new execution must belong to the same turn and workflow.");
        if (previous && previous.status === "running") throw failure("execution_busy", "The original workflow is still running.");
        if (previous && policy.enabled === false) throw failure("execution_not_allowed", "This workflow does not allow a new execution.");
        const parent = parentId ? entryFor(value, parentId) : null;
        let ancestor = parent;
        while (ancestor) {
          if (ancestor.deactivated && !lifecycle) throw failure("execution_inactive", "An inactive execution cannot start further workflows.");
          ancestor = ancestor.parentId ? entryFor(value, ancestor.parentId) : null;
        }
        if (parent && parent.turn !== turn && !policy.allowHistoricalWrites) throw failure("execution_target_mismatch", "Execution parent belongs to another turn.");
        let base = inputStore ? await snapshot(inputStore) : parent ? { ...parent.base, ...parent.states } : await snapshot(store);
        // Read today's authorized inputs, but remove the contribution being replaced. A narrative
        // attempt uses this same rule to exclude its old post-turn state and archives.
        if (previous?.selected) {
          for (const [key, stateId] of Object.entries(previous.states)) {
            const original = await readState(store, previous.base[key]);
            const old = await readState(store, stateId);
            const current = await readState(store, base[key]);
            const ids = changedIds(original, old);
            base[key] = await putState(store, replaceContribution(current, old, original, ids));
          }
          // Keep the original baseline for replacement checks; other inputs may be refreshed.
        }
        const entry = {
          id, workflowId, turn, parentId, previousId, attemptId: attemptId || parent?.attemptId || null,
          invocation: clone(invocation), sourceReferences: clone(sourceReferences), policy: clone(policy),
          candidate, lifecycle, fingerprint, status: "running", base, states: {}, batches: [],
          createdAt: new Date().toISOString(), completedAt: null, accepted: null,
        };
        value.executions[id] = entry;
        await saveManifest(store, value, "start");
        return clone(entry);
      });
    },
    async finish(id, status, { sourceReferences } = {}) {
      if (!["completed", "skipped", "failed", "cancelled"].includes(status)) throw new Error("Invalid execution outcome.");
      return locked(store, async value => {
        const entry = entryFor(value, id);
        if (entry.status !== "running" && entry.status !== status) throw failure("execution_outcome_conflict", "Execution already has a different outcome.");
        entry.status = status;
        if (sourceReferences) entry.sourceReferences = clone(sourceReferences);
        entry.completedAt ||= new Date().toISOString();
        await saveManifest(store, value, "finish");
        return clone(entry);
      });
    },
    async resume(id) {
      return locked(store, async value => {
        const entry = entryFor(value, id);
        if (entry.status === "running") return clone(entry);
        if (entry.status !== "failed") throw failure("execution_closed", "Only a failed execution may resume in place.");
        if (!entry.policy.allowHistoricalWrites) assertCurrent(value, entry);
        entry.status = "running";
        entry.completedAt = null;
        await saveManifest(store, value, "resume");
        return clone(entry);
      });
    },
    /** @param {string} id @param {{expectedRevision?:number,allowPast?:boolean}} options */
    async adopt(id, { expectedRevision, allowPast = false } = {}) {
      return locked(store, async value => {
        const entry = entryFor(value, id);
        if (!allowPast) assertCurrent(value, entry);
        if (expectedRevision !== undefined && value.revision !== expectedRevision) throw failure("execution_selection_conflict", "Execution selection changed; refresh before adopting.");
        if (entry.status !== "completed") throw failure("execution_not_complete", "Only a completed execution can be adopted.");
        const slot = `${entry.parentId || "$root"}:${entry.workflowId}:${entry.invocation.logicalCallId || entry.previousId || entry.id}`;
        const selectedId = value.selected[slot];
        const previous = selectedId && selectedId !== id ? entryFor(value, selectedId) : entry.previousId && value.executions[entry.previousId]?.selected ? entryFor(value, entry.previousId) : null;
        const parent = entry.parentId ? entryFor(value, entry.parentId) : null;
        const changed = new Map();
        const keys = new Set([...Object.keys(entry.states), ...Object.keys(previous?.states || {})]);
        const accepted = {};
        for (const key of keys) {
          const [moduleId, collectionId] = key.split("/");
          const base = await readState(store, entry.base[key]);
          const desired = await readState(store, entry.states[key] || entry.base[key]);
          const oldBase = previous ? await readState(store, previous.base[key]) : base;
          const old = previous ? await readState(store, previous.states[key] || previous.base[key]) : base;
          const expected = previous?.accepted?.[key] ? await readState(store, previous.accepted[key]) : entry.accepted?.[key] ? await readState(store, entry.accepted[key]) : old;
          const ids = [...new Set([...changedIds(oldBase, old), ...changedIds(base, desired)])];
          const current = parent ? await readState(store, parent.states[key] || parent.base[key]) : await store.readCollection(moduleId, collectionId);
          const next = replaceContribution(current, expected, desired, ids);
          accepted[key] = await putState(store, next);
          if (parent) parent.states[key] = accepted[key];
          else changed.set(key, { moduleId, collectionId, ...next });
        }
        entry.accepted = accepted;
        value.selected[slot] = id;
        if (previous) { previous.selected = false; previous.deactivated = true; }
        entry.selected = true;
        entry.deactivated = false;
        // A selected completed parent may still receive an authorized background result. Propagate
        // only through selected ancestors; an inactive attempt retains the result privately.
        let ancestor = parent;
        while (ancestor?.selected && ancestor.status === "completed") {
          const nextParent = ancestor.parentId ? entryFor(value, ancestor.parentId) : null;
          for (const key of keys) {
            const [moduleId, collectionId] = key.split("/");
            const before = await readState(store, ancestor.accepted?.[key] || ancestor.base[key]);
            const after = await readState(store, ancestor.states[key] || ancestor.base[key]);
            const current = nextParent ? await readState(store, nextParent.states[key] || nextParent.base[key]) : changed.get(key) || await store.readCollection(moduleId, collectionId);
            const next = replaceContribution(current, before, after, changedIds(before, after));
            const stateId = await putState(store, next);
            ancestor.accepted ||= {};
            ancestor.accepted[key] = stateId;
            if (nextParent) nextParent.states[key] = stateId;
            else changed.set(key, { moduleId, collectionId, ...next });
          }
          ancestor = nextParent;
        }
        // The selection manifest and canonical records share the normal transaction journal.
        const batchId = `execution-adopt-${randomUUID()}`;
        value.revision += 1;
        await store.commit(batchId, changed, { schemaVersion: 1, batchId, status: "committed", committedAt: new Date().toISOString(), results: [], reason: "execution-adopt", executionId: id },
          [{ path: manifestPath(store), content: `${JSON.stringify(value, null, 2)}\n` }]);
        return clone(entry);
      });
    },
    async prune(fromTurn) {
      return locked(store, async value => {
        const removed = Object.values(value.executions).filter(entry => entry.turn >= fromTurn);
        const changed = new Map();
        // Reverse accepted contributions in reverse execution order, including changes bound to
        // older story turns. Shared immutable blobs remain available to surviving attempts.
        const removedIds = new Set(removed.map(entry => entry.id));
        const covered = entry => {
          let parent = entry.parentId;
          while (parent) {
            if (removedIds.has(parent)) return true;
            parent = value.executions[parent]?.parentId;
          }
          return false;
        };
        for (const entry of removed.filter(entry => entry.selected && !covered(entry)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
          for (const key of Object.keys(entry.states)) {
            const [moduleId, collectionId] = key.split("/");
            const base = await readState(store, entry.base[key]);
            const result = await readState(store, entry.states[key]);
            const parent = entry.parentId ? entryFor(value, entry.parentId) : null;
            const current = parent ? await readState(store, parent.states[key] || parent.base[key]) : changed.get(key) || await store.readCollection(moduleId, collectionId);
            const next = replaceContribution(current, result, base, changedIds(base, result));
            if (!parent) changed.set(key, { moduleId, collectionId, ...next });
            else {
              parent.states[key] = await putState(store, next);
              let ancestor = parent;
              while (ancestor?.selected) {
                const before = await readState(store, ancestor.accepted?.[key] || ancestor.base[key]);
                const after = await readState(store, ancestor.states[key] || ancestor.base[key]);
                const nextParent = ancestor.parentId ? entryFor(value, ancestor.parentId) : null;
                const target = nextParent ? await readState(store, nextParent.states[key] || nextParent.base[key]) : changed.get(key) || await store.readCollection(moduleId, collectionId);
                const restored = replaceContribution(target, before, after, changedIds(before, after));
                const reference = await putState(store, restored);
                ancestor.accepted ||= {};
                ancestor.accepted[key] = reference;
                if (nextParent) nextParent.states[key] = reference;
                else changed.set(key, { moduleId, collectionId, ...restored });
                ancestor = nextParent;
              }
            }
          }
        }
        for (const entry of removed) delete value.executions[entry.id];
        value.selected = Object.fromEntries(Object.entries(value.selected).filter(([, id]) => value.executions[id]));
        value.turn = Math.max(0, fromTurn - 1);
        value.revision += 1;
        const batchId = `execution-prune-${randomUUID()}`;
        await store.commit(batchId, changed, { schemaVersion: 1, batchId, status: "committed", committedAt: new Date().toISOString(), results: [], reason: "execution-prune" },
          [{ path: manifestPath(store), content: `${JSON.stringify(value, null, 2)}\n` }]);
        const retained = new Set(Object.values(value.executions).flatMap(entry => [...Object.values(entry.base), ...Object.values(entry.states), ...Object.values(entry.accepted || {})]));
        for (const reference of [...retained]) {
          const blob = await readBlob(store, reference);
          for (const recordReference of [...blob.history, ...blob.records]) retained.add(recordReference);
        }
        const root = resolve(store.sessionDirectory, "workflow", "execution-states");
        for (const name of await readdir(root).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
          if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name.slice(0, -5))) await rm(resolve(root, name), { force: true });
        }
        return removed.map(entry => entry.id);
      });
    },
  };
}

/** A scoped store preserves the normal capability/schema/processor checks and commit lock. */
export function executionDataStore(store, executionId, { presentation = false, readOnly = false, allowRevision = false } = {}) {
  if (!executionId) return store;
  const scoped = Object.create(store);
  scoped.executionId = executionId;
  scoped.module = store.module.bind(store);
  scoped.validateRecordData = store.validateRecordData.bind(store);
  scoped.operationHandler = store.operationHandler.bind(store);
  scoped.readCollection = async (moduleId, collectionId) => {
    store.module(moduleId);
    if (presentation && store.module(moduleId).contract.collections[collectionId]?.executionScope === "session") return store.readCollection(moduleId, collectionId);
    const entry = entryFor(await manifest(store), executionId);
    const id = entry.states[`${moduleId}/${collectionId}`] || entry.base[`${moduleId}/${collectionId}`];
    if (!id) throw failure("execution_read_scope", "Collection is absent from this execution's frozen input.");
    return readState(store, id);
  };
  scoped.authorityFileForRecord = async (moduleId, collectionId, recordId) => {
    const state = await scoped.readCollection(moduleId, collectionId);
    if (!state.records.some(record => record.id === recordId)) throw new Error("Record was not found in this execution.");
    const entry = entryFor(await manifest(store), executionId);
    return blobPath(store, hash({ schemaVersion: 1, kind: "record", value: state.records.find(record => record.id === recordId) }));
  };
  scoped.readIndex = async moduleId => {
    const module = store.module(moduleId);
    const records = [];
    for (const collectionId of Object.keys(module.contract.collections)) records.push(...(await scoped.readCollection(moduleId, collectionId)).records);
    return buildDataIndex(records, module.contract);
  };
  scoped.resolveIdentity = async value => {
    const entries = [];
    for (const module of store.modules.values()) {
      const records = [];
      for (const collectionId of Object.keys(module.contract.collections)) records.push(...(await scoped.readCollection(module.contract.moduleId, collectionId)).records);
      entries.push(...buildIdentityEntries(records, module.contract));
    }
    const needle = String(value).toLocaleLowerCase();
    return entries.filter(entry => entry.id === value || entry.name.toLocaleLowerCase() === needle || entry.aliases.some(alias => alias.toLocaleLowerCase() === needle));
  };
  scoped.commit = async (batchId, changedStates, receipt) => {
    if (readOnly) throw failure("execution_preview_readonly", "Candidate presentation is read-only; adopt it before changing its module data.");
    const value = await manifest(store);
    const entry = entryFor(value, executionId);
    const transcript = scoped.transcriptProvider || store.transcriptProvider;
    const revisionOnly = allowRevision && transcript && (receipt.results || []).every(result => result.status === "committed" && result.action === "update" && result.moduleId === transcript.moduleId && result.collectionId === transcript.collectionId);
    if (entry.status !== "running" && !(entry.status === "completed" && revisionOnly)) throw failure("execution_closed", "This execution no longer accepts writes.");
    for (const result of receipt.results || []) {
      if (result.status !== "committed") continue;
      if (transcript && result.moduleId === transcript.moduleId && result.collectionId === transcript.collectionId && result.record?.data?.role === "assistant" && result.record.binding.turn === entry.turn) {
        entry.narrativeDocument = { id: result.record.id, revision: result.record.revision, revisionSource: result.record.provenance?.initiatorKind || null };
      }
      const before = (await scoped.readCollection(result.moduleId, result.collectionId)).records.find(record => record.id === result.recordId);
      const independent = store.module(result.moduleId).contract.collections[result.collectionId].executionScope === "session";
      if (!revisionOnly && !independent && !entry.policy.allowHistoricalWrites && ((receipt.binding?.turn ?? entry.turn) < entry.turn || (before?.binding?.turn ?? entry.turn) < entry.turn)) {
        throw failure("execution_historical_write_denied", "This workflow does not allow changes to historical records.");
      }
    }
    const liveChanges = new Map();
    for (const [key, state] of changedStates) {
      if (store.module(state.moduleId).contract.collections[state.collectionId].executionScope === "session") {
        const frozen = await scoped.readCollection(state.moduleId, state.collectionId);
        const current = await store.readCollection(state.moduleId, state.collectionId);
        const next = replaceContribution(current, frozen, state, changedIds(frozen, state));
        liveChanges.set(key, { ...next, moduleId: state.moduleId, collectionId: state.collectionId });
        entry.base[key] = await putState(store, next);
      } else entry.states[key] = await putState(store, state);
    }
    entry.batches.push(batchId);
    value.revision += 1;
    const files = [{ path: manifestPath(store), content: `${JSON.stringify(value, null, 2)}\n` }];
    const outcome = { ...receipt, executionId, attemptId: entry.attemptId, executionTurn: entry.turn };
    return liveChanges.size ? store.commit(batchId, liveChanges, outcome, files) : commitDataFiles(store.sessionDirectory, batchId, files, outcome);
  };
  return scoped;
}
