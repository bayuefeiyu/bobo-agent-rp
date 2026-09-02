import { randomUUID } from "node:crypto";
import { isSafeDataId, recordTypeDefinition } from "./rp-data-contracts.mjs";

const STATUSES = new Set(["active", "retracted", "archived"]);

function clone(value) {
  return structuredClone(value);
}

function timestamp(value = null) {
  const result = value || new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error("Record timestamp is invalid.");
  return result;
}

export function createDataRecord({ contract, collectionId, recordType, data, sequence, binding = {}, id = null, note = null, provenance = {}, now = null }) {
  const definition = recordTypeDefinition(contract, collectionId, recordType);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Record data must be an object.");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Record sequence must be a non-negative integer.");
  if (id !== null && !isSafeDataId(id)) throw new Error("Record ID must be safe.");
  const at = timestamp(now);
  return {
    protocolVersion: 2,
    id: id || `${recordType}-${randomUUID()}`,
    moduleId: contract.moduleId,
    collectionId,
    recordType,
    dataSchemaVersion: definition.dataSchemaVersion,
    sequence,
    revision: 1,
    status: "active",
    createdAt: at,
    updatedAt: at,
    binding: {
      messageId: typeof binding.messageId === "string" ? binding.messageId : null,
      turn: Number.isSafeInteger(binding.turn) && binding.turn >= 0 ? binding.turn : 0,
    },
    data: clone(data),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    provenance: clone(provenance || {}),
  };
}

export function validateDataRecord(value, contract = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Record must be an object.");
  const fields = ["protocolVersion", "id", "moduleId", "collectionId", "recordType", "dataSchemaVersion", "sequence", "revision", "status", "createdAt", "updatedAt", "binding", "data", "note", "provenance"];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error("Record must use the exact envelope v2 field set.");
  if (value.protocolVersion !== 2) throw new Error("Record protocolVersion must be 2.");
  for (const [field, fieldValue] of [["id", value.id], ["moduleId", value.moduleId], ["collectionId", value.collectionId], ["recordType", value.recordType]]) {
    if (!isSafeDataId(fieldValue)) throw new Error(`Record ${field} must be a safe ID.`);
  }
  if (!Number.isSafeInteger(value.dataSchemaVersion) || value.dataSchemaVersion < 1) throw new Error("Record dataSchemaVersion is invalid.");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("Record sequence is invalid.");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Record revision is invalid.");
  if (!STATUSES.has(value.status)) throw new Error("Record status is invalid.");
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  if (!value.binding || typeof value.binding !== "object" || Array.isArray(value.binding)) throw new Error("Record binding is invalid.");
  if (Object.keys(value.binding).length !== 2 || !Object.hasOwn(value.binding, "messageId") || !Object.hasOwn(value.binding, "turn")) throw new Error("Record binding must contain exactly messageId and turn.");
  if (value.binding.messageId !== null && typeof value.binding.messageId !== "string") throw new Error("Record binding.messageId is invalid.");
  if (!Number.isSafeInteger(value.binding.turn) || value.binding.turn < 0) throw new Error("Record binding.turn is invalid.");
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("Record data must be an object.");
  if (value.note !== null && value.note !== undefined && typeof value.note !== "string") throw new Error("Record note is invalid.");
  if (!value.provenance || typeof value.provenance !== "object" || Array.isArray(value.provenance)) throw new Error("Record provenance is invalid.");
  if (contract) {
    if (value.moduleId !== contract.moduleId) throw new Error("Record moduleId does not match its data contract.");
    const definition = recordTypeDefinition(contract, value.collectionId, value.recordType);
    if (value.dataSchemaVersion !== definition.dataSchemaVersion) throw new Error("Record dataSchemaVersion does not match its record type.");
  }
  return value;
}

export function reviseDataRecord(record, changes, { status = record.status, note = record.note, provenance = record.provenance, now = null } = {}) {
  validateDataRecord(record);
  const data = changes === undefined ? record.data : changes;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Revised record data must be an object.");
  if (!STATUSES.has(status)) throw new Error("Revised record status is invalid.");
  return {
    ...clone(record),
    revision: record.revision + 1,
    status,
    updatedAt: timestamp(now),
    data: clone(data),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    provenance: clone(provenance || {}),
  };
}

export function parseDataRecordLines(text, contract = null) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => validateDataRecord(JSON.parse(line), contract));
}

export function toDataRecordLines(records) {
  return records.map(record => JSON.stringify(validateDataRecord(record))).join("\n") + (records.length ? "\n" : "");
}
