import { capabilityAllows } from "./rp-data-contracts.mjs";
import { buildDataIndex, dataValueAt, queryDataIndex } from "./rp-data-index.mjs";
import { renderDataRecordView } from "./rp-data-views.mjs";

function cursorOffset(value) {
  if (value === undefined || value === null) return 0;
  const match = /^offset:(\d+)$/.exec(value);
  if (!match) throw new Error("Invalid data query cursor.");
  return Number(match[1]);
}

function stableSignature(request) {
  return JSON.stringify({ moduleId: request.moduleId, collectionId: request.collectionId, recordTypes: request.recordTypes || [], where: request.where || {}, search: request.search || null, view: request.view || "rp", includeInactive: request.includeInactive === true, order: request.order === "desc" ? "desc" : "asc" });
}

function encodeCursor(value) {
  return `stable:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function decodeCursor(value, signature) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.startsWith("stable:")) throw new Error("Invalid stable data query cursor.");
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8")); }
  catch { throw new Error("Invalid stable data query cursor."); }
  if (decoded?.schemaVersion !== 1 || decoded.signature !== signature || !Number.isSafeInteger(decoded.sequence) || typeof decoded.id !== "string") throw new Error("Stable data query cursor does not match this query.");
  return decoded;
}

function withinSearch(record, definition, search) {
  if (!search?.query) return true;
  const fields = search.fields?.length ? search.fields : definition.searchableFields;
  const allowed = new Set(definition.searchableFields);
  if (!fields.length) throw new Error(`Record type ${record.recordType} has no searchable fields.`);
  if (fields.some(path => !allowed.has(path))) throw new Error(`Content search requested a field not declared searchable for ${record.recordType}.`);
  const needle = String(search.query).toLocaleLowerCase();
  return fields.some(path => String(dataValueAt(record, path) ?? "").toLocaleLowerCase().includes(needle));
}

function recordsVisibleThrough(state, visibleThroughTurn, visibleThroughTime, includeInactive = false) {
  if (!Number.isSafeInteger(visibleThroughTurn) && !(typeof visibleThroughTime === "string" && visibleThroughTime)) return state.records;
  const source = state.history?.length ? state.history : state.records;
  const latest = new Map();
  for (const record of source) {
    if (Number.isSafeInteger(visibleThroughTurn) && (record.binding?.turn || 0) > visibleThroughTurn) continue;
    if (typeof visibleThroughTime === "string" && visibleThroughTime && typeof record.updatedAt === "string" && record.updatedAt > visibleThroughTime) continue;
    const prior = latest.get(record.id);
    if (!prior || record.revision > prior.revision) latest.set(record.id, record);
  }
  return [...latest.values()].filter(record => includeInactive || record.status === "active");
}

async function readCollection(store, access, moduleId, collectionId) {
  return typeof access.readCollection === "function"
    ? access.readCollection(moduleId, collectionId)
    : store.readCollection(moduleId, collectionId);
}

export async function queryData(store, request, access = {}) {
  const module = store.module(request.moduleId);
  const view = request.view || "rp";
  if (Array.isArray(access.views) && !access.views.includes(view)) throw new Error(`The current node was not granted view ${view}.`);
  if (!capabilityAllows(module.contract, access.capabilities || [], { collectionId: request.collectionId, action: "query", view })) {
    throw new Error(`The current node cannot query ${request.moduleId}/${request.collectionId} with view ${view}.`);
  }
  const runtimeLimit = Number.isSafeInteger(access.runtimeLimit) ? access.runtimeLimit : 20;
  const nodeLimit = Number.isSafeInteger(access.nodeLimit) ? access.nodeLimit : runtimeLimit;
  const requestedLimit = Number.isSafeInteger(request.limit) && request.limit > 0 ? request.limit : runtimeLimit;
  const limit = Math.min(runtimeLimit, nodeLimit, requestedLimit);
  const runtimeCharacters = Number.isSafeInteger(access.runtimeCharacters) ? access.runtimeCharacters : 6000;
  const nodeCharacters = Number.isSafeInteger(access.nodeCharacters) ? access.nodeCharacters : runtimeCharacters;
  const requestedCharacters = Number.isSafeInteger(request.maxCharacters) && request.maxCharacters > 0 ? request.maxCharacters : runtimeCharacters;
  const maxCharacters = Math.min(runtimeCharacters, nodeCharacters, requestedCharacters);
  const customRead = typeof access.readCollection === "function";
  const state = await readCollection(store, access, request.moduleId, request.collectionId);
  const visibleRecords = recordsVisibleThrough(state, access.visibleThroughTurn, access.visibleThroughTime, request.includeInactive === true);
  const index = customRead || Number.isSafeInteger(access.visibleThroughTurn) || (typeof access.visibleThroughTime === "string" && access.visibleThroughTime)
    ? buildDataIndex(visibleRecords, module.contract)
    : await store.readIndex(request.moduleId);
  let entries = queryDataIndex(index, module.contract, request);
  const records = new Map(visibleRecords.map(record => [record.id, record]));
  entries = entries.filter(entry => {
    const record = records.get(entry.id);
    if (!record) return false;
    const definition = module.contract.collections[request.collectionId].recordTypes[record.recordType];
    return withinSearch(record, definition, request.search);
  });
  const offset = cursorOffset(request.cursor);
  const items = [];
  let usedCharacters = 0;
  let consumed = 0;
  for (const entry of entries.slice(offset)) {
    if (items.length >= limit) break;
    const record = records.get(entry.id);
    const rendered = renderDataRecordView(record, module.contract, view);
    const size = typeof rendered === "string" ? rendered.length : JSON.stringify(rendered).length;
    if (items.length && usedCharacters + size > maxCharacters) break;
    items.push({ id: entry.id, recordType: entry.recordType, revision: record.revision, value: rendered });
    usedCharacters += size;
    consumed += 1;
  }
  const nextOffset = offset + consumed;
  return {
    matched: entries.length,
    returned: items.length,
    truncated: nextOffset < entries.length,
    nextCursor: nextOffset < entries.length ? `offset:${nextOffset}` : null,
    view,
    items,
  };
}

export async function queryAllData(store, request, access = {}, page = {}) {
  const items = [];
  const seen = new Set();
  let cursor = request.cursor || null;
  do {
    if (cursor && seen.has(cursor)) throw new Error("Data query pagination repeated a cursor.");
    if (cursor) seen.add(cursor);
    const result = await queryData(store, {
      ...request,
      cursor,
      limit: page.limit || request.limit || 200,
      maxCharacters: page.maxCharacters || request.maxCharacters || 500000,
    }, access);
    items.push(...(result.items || []));
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

export async function getDataRecord(store, request, access = {}) {
  const module = store.module(request.moduleId);
  const view = request.view || "rp";
  if (Array.isArray(access.views) && !access.views.includes(view)) throw new Error(`The current node was not granted view ${view}.`);
  if (!capabilityAllows(module.contract, access.capabilities || [], { collectionId: request.collectionId, action: "query", view })) {
    throw new Error(`The current node cannot read ${request.moduleId}/${request.collectionId} with view ${view}.`);
  }
  const state = await readCollection(store, access, request.moduleId, request.collectionId);
  const record = recordsVisibleThrough(state, access.visibleThroughTurn, access.visibleThroughTime, request.includeInactive === true).find(item => item.id === request.id);
  if (!record) return null;
  return { id: record.id, recordType: record.recordType, revision: record.revision, value: renderDataRecordView(record, module.contract, view) };
}

export async function queryDataStable(store, request, access = {}) {
  const module = store.module(request.moduleId);
  const view = request.view || "rp";
  if (Array.isArray(access.views) && !access.views.includes(view)) throw new Error(`The current caller was not granted view ${view}.`);
  if (!capabilityAllows(module.contract, access.capabilities || [], { collectionId: request.collectionId, action: "query", view })) throw new Error(`The current caller cannot query ${request.moduleId}/${request.collectionId} with view ${view}.`);
  const runtimeLimit = Number.isSafeInteger(access.runtimeLimit) ? access.runtimeLimit : 20;
  const requestedLimit = Number.isSafeInteger(request.limit) && request.limit > 0 ? request.limit : runtimeLimit;
  const limit = Math.min(runtimeLimit, requestedLimit);
  const runtimeCharacters = Number.isSafeInteger(access.runtimeCharacters) ? access.runtimeCharacters : 50000;
  const requestedCharacters = Number.isSafeInteger(request.maxCharacters) && request.maxCharacters > 0 ? request.maxCharacters : runtimeCharacters;
  const maxCharacters = Math.min(runtimeCharacters, requestedCharacters);
  const signature = stableSignature(request);
  const cursor = decodeCursor(request.cursor, signature);
  const descending = request.order === "desc";
  const customRead = typeof access.readCollection === "function";
  const state = await readCollection(store, access, request.moduleId, request.collectionId);
  const visibleRecords = recordsVisibleThrough(state, access.visibleThroughTurn, access.visibleThroughTime, request.includeInactive === true);
  const index = customRead || Number.isSafeInteger(access.visibleThroughTurn) || (typeof access.visibleThroughTime === "string" && access.visibleThroughTime)
    ? buildDataIndex(visibleRecords, module.contract)
    : await store.readIndex(request.moduleId);
  let entries = queryDataIndex(index, module.contract, { ...request, sort: [{ field: "sequence", order: descending ? "desc" : "asc" }] });
  entries.sort((left, right) => descending ? right.sequence - left.sequence || right.id.localeCompare(left.id) : left.sequence - right.sequence || left.id.localeCompare(right.id));
  if (cursor) entries = entries.filter(entry => descending ? entry.sequence < cursor.sequence || (entry.sequence === cursor.sequence && entry.id < cursor.id) : entry.sequence > cursor.sequence || (entry.sequence === cursor.sequence && entry.id > cursor.id));
  const records = new Map(visibleRecords.map(record => [record.id, record]));
  entries = entries.filter(entry => {
    const record = records.get(entry.id);
    if (!record) return false;
    return withinSearch(record, module.contract.collections[request.collectionId].recordTypes[record.recordType], request.search);
  });
  const items = [];
  let usedCharacters = 0;
  for (const entry of entries) {
    if (items.length >= limit) break;
    const record = records.get(entry.id);
    const rendered = renderDataRecordView(record, module.contract, view);
    const size = typeof rendered === "string" ? rendered.length : JSON.stringify(rendered).length;
    if (items.length && usedCharacters + size > maxCharacters) break;
    items.push({ id: entry.id, recordType: entry.recordType, revision: record.revision, status: record.status, turn: record.binding.turn, value: rendered });
    usedCharacters += size;
  }
  const last = items.at(-1);
  const more = last ? entries.some(entry => descending ? entry.sequence < records.get(last.id).sequence || (entry.sequence === records.get(last.id).sequence && entry.id < last.id) : entry.sequence > records.get(last.id).sequence || (entry.sequence === records.get(last.id).sequence && entry.id > last.id)) : false;
  return { returned: items.length, truncated: more, nextCursor: more ? encodeCursor({ schemaVersion: 1, signature, sequence: records.get(last.id).sequence, id: last.id }) : null, view, items };
}

export async function getDataRecordHistory(store, request, access = {}) {
  const module = store.module(request.moduleId);
  const view = request.view || "rp";
  if (Array.isArray(access.views) && !access.views.includes(view)) throw new Error(`The current caller was not granted view ${view}.`);
  if (!capabilityAllows(module.contract, access.capabilities || [], { collectionId: request.collectionId, action: "query", view })) throw new Error(`The current caller cannot inspect history for ${request.moduleId}/${request.collectionId}.`);
  const limit = Math.min(Number.isSafeInteger(request.limit) && request.limit > 0 ? request.limit : 20, Number.isSafeInteger(access.runtimeLimit) ? access.runtimeLimit : 50);
  const beforeRevision = request.cursor === undefined || request.cursor === null ? Infinity : (() => {
    const match = /^revision:(\d+)$/.exec(request.cursor);
    if (!match) throw new Error("Invalid record-history cursor.");
    return Number(match[1]);
  })();
  const state = await readCollection(store, access, request.moduleId, request.collectionId);
  const history = state.history.filter(record => record.id === request.id && record.revision < beforeRevision).sort((left, right) => right.revision - left.revision);
  const selected = history.slice(0, limit);
  return {
    id: request.id,
    returned: selected.length,
    truncated: history.length > selected.length,
    nextCursor: history.length > selected.length ? `revision:${selected.at(-1).revision}` : null,
    items: selected.map(record => ({ id: record.id, recordType: record.recordType, revision: record.revision, status: record.status, updatedAt: record.updatedAt, turn: record.binding.turn, value: renderDataRecordView(record, module.contract, view) })),
  };
}
