import { capabilityAllows } from "./rp-data-contracts.mjs";
import { dataValueAt, queryDataIndex } from "./rp-data-index.mjs";
import { renderDataRecordView } from "./rp-data-views.mjs";

function cursorOffset(value) {
  if (value === undefined || value === null) return 0;
  const match = /^offset:(\d+)$/.exec(value);
  if (!match) throw new Error("Invalid data query cursor.");
  return Number(match[1]);
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
  const index = await store.readIndex(request.moduleId);
  let entries = queryDataIndex(index, module.contract, request);
  const state = await store.readCollection(request.moduleId, request.collectionId);
  const records = new Map(state.records.map(record => [record.id, record]));
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

export async function getDataRecord(store, request, access = {}) {
  const module = store.module(request.moduleId);
  const view = request.view || "rp";
  if (Array.isArray(access.views) && !access.views.includes(view)) throw new Error(`The current node was not granted view ${view}.`);
  if (!capabilityAllows(module.contract, access.capabilities || [], { collectionId: request.collectionId, action: "query", view })) {
    throw new Error(`The current node cannot read ${request.moduleId}/${request.collectionId} with view ${view}.`);
  }
  const state = await store.readCollection(request.moduleId, request.collectionId);
  const record = state.records.find(item => item.id === request.id);
  if (!record) return null;
  return { id: record.id, recordType: record.recordType, revision: record.revision, value: renderDataRecordView(record, module.contract, view) };
}
