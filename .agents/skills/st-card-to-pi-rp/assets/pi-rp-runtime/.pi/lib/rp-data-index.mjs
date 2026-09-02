import { recordTypeDefinition } from "./rp-data-contracts.mjs";
import { validateDataRecord } from "./rp-data-records.mjs";

export function dataValueAt(value, pointer) {
  if (pointer === "") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    return current[key];
  }, value);
}

function validIndexValue(value, definition) {
  if (value === undefined || value === null) return true;
  if (definition.type === "string" || definition.type === "id" || definition.type === "time") return typeof value === "string";
  if (definition.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "enum") return typeof value === "string" && definition.values.includes(value);
  if (definition.type === "id-list" || definition.type === "string-list") return Array.isArray(value) && value.every(item => typeof item === "string");
  return false;
}

export function extractRecordIndexes(record, contract) {
  validateDataRecord(record, contract);
  const definition = recordTypeDefinition(contract, record.collectionId, record.recordType);
  const values = {};
  for (const [id, index] of Object.entries(definition.indexes)) {
    let value = dataValueAt(record, index.path);
    if ((value === undefined || value === null) && Object.hasOwn(index, "default")) value = structuredClone(index.default);
    if (!validIndexValue(value, index)) throw new Error(`Record ${record.id} index ${id} does not match type ${index.type}.`);
    values[id] = value === undefined ? null : structuredClone(value);
  }
  return values;
}

export function buildDataIndex(records, contract) {
  return {
    schemaVersion: 1,
    moduleId: contract.moduleId,
    generatedAt: new Date().toISOString(),
    entries: records.map(record => ({
      id: record.id,
      collectionId: record.collectionId,
      recordType: record.recordType,
      revision: record.revision,
      sequence: record.sequence,
      status: record.status,
      turn: record.binding.turn,
      values: extractRecordIndexes(record, contract),
    })),
  };
}

export function buildIdentityEntries(records, contract) {
  const entries = [];
  for (const record of records) {
    const identity = recordTypeDefinition(contract, record.collectionId, record.recordType).identity;
    if (!identity || record.status !== "active") continue;
    const name = dataValueAt(record, identity.namePath);
    const aliases = identity.aliasesPath ? dataValueAt(record, identity.aliasesPath) : [];
    if (typeof name !== "string" || !name.trim()) throw new Error(`Identity record ${record.id} must provide a non-empty name.`);
    if (aliases !== undefined && aliases !== null && (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string" || !alias.trim()))) throw new Error(`Identity record ${record.id} aliases must be strings.`);
    entries.push({ id: record.id, moduleId: record.moduleId, collectionId: record.collectionId, recordType: record.recordType, name: name.trim(), aliases: [...new Set(aliases || [])] });
  }
  return entries;
}

function compare(actual, operator, expected) {
  if (operator === "eq") return Object.is(actual, expected);
  if (operator === "neq") return !Object.is(actual, expected);
  if (operator === "contains") return Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" && actual.includes(String(expected));
  if (operator === "in") return Array.isArray(expected) && expected.includes(actual);
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  if (operator === "lte") return actual <= expected;
  throw new Error(`Unsupported query operator ${operator}.`);
}

export function queryDataIndex(index, contract, request) {
  const collectionId = request.collectionId;
  const collection = contract.collections[collectionId];
  if (!collection) throw new Error(`Unknown collection ${collectionId}.`);
  const recordTypes = request.recordTypes?.length ? new Set(request.recordTypes) : null;
  if (recordTypes) for (const type of recordTypes) recordTypeDefinition(contract, collectionId, type);
  let entries = index.entries.filter(entry => entry.collectionId === collectionId && (!recordTypes || recordTypes.has(entry.recordType)));
  if (!request.includeInactive) entries = entries.filter(entry => entry.status === "active");
  for (const [indexId, condition] of Object.entries(request.where || {})) {
    const definitions = [...(recordTypes || Object.keys(collection.recordTypes))].map(type => collection.recordTypes[type].indexes[indexId]).filter(Boolean);
    if (!definitions.length) throw new Error(`Unknown index ${indexId} for the selected record types.`);
    if (!condition || typeof condition !== "object" || Array.isArray(condition) || Object.keys(condition).length !== 1) throw new Error(`Query condition ${indexId} must contain exactly one operator.`);
    const operator = Object.keys(condition)[0];
    if (definitions.some(definition => !definition.operators.includes(operator))) throw new Error(`Index ${indexId} does not support ${operator}.`);
    entries = entries.filter(entry => compare(entry.values[indexId], operator, condition[operator]));
  }
  for (const sort of [...(request.sort || [])].reverse()) {
    if (!sort || typeof sort !== "object" || !["turn", "sequence", ...new Set([...(recordTypes || Object.keys(collection.recordTypes))].flatMap(type => Object.keys(collection.recordTypes[type].indexes)))].includes(sort.field)) throw new Error(`Unknown sort field ${sort?.field}.`);
    const direction = sort.order === "asc" ? 1 : -1;
    entries.sort((left, right) => {
      const leftValue = sort.field === "turn" ? left.turn : sort.field === "sequence" ? left.sequence : left.values[sort.field];
      const rightValue = sort.field === "turn" ? right.turn : sort.field === "sequence" ? right.sequence : right.values[sort.field];
      return leftValue === rightValue ? 0 : leftValue > rightValue ? direction : -direction;
    });
  }
  return entries;
}
