const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORAGE_KINDS = new Set(["record-log", "snapshot", "hybrid"]);
const PARTITION_MODES = new Set(["single", "index", "turn-range"]);
const INDEX_TYPES = new Set(["string", "number", "boolean", "enum", "id", "id-list", "string-list", "time"]);
const INDEX_OPERATORS = new Set(["eq", "neq", "contains", "in", "gt", "gte", "lt", "lte"]);
const VIEW_FORMATS = new Set(["text", "object"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function knownFields(value, allowed, label, required = []) {
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  const missing = required.filter(field => !Object.hasOwn(value, field));
  if (unknown.length || missing.length) throw new Error(`${label} has invalid fields; unknown=[${unknown.join(", ")}], missing=[${missing.join(", ")}].`);
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe ID.`);
  return value;
}

function safeRelativePath(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return value.replaceAll("\\", "/");
}

function pointer(value, label) {
  if (typeof value !== "string" || !value.startsWith("/data/")) throw new Error(`${label} must be an RFC 6901 pointer below /data/.`);
  return value;
}

function stringArray(value, label, allowed = null) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new Error(`${label} must be a string array.`);
  const result = [...new Set(value)];
  if (allowed && result.some(item => !allowed.has(item))) throw new Error(`${label} contains an unsupported value.`);
  return result;
}

function normalizeIndex(value, label) {
  const input = object(value, label);
  knownFields(input, ["path", "type", "operators", "default", "values"], label, ["path", "type"]);
  const type = input.type;
  if (!INDEX_TYPES.has(type)) throw new Error(`${label}.type is unsupported.`);
  const operators = input.operators === undefined ? ["eq"] : stringArray(input.operators, `${label}.operators`, INDEX_OPERATORS);
  const result = {
    path: pointer(input.path, `${label}.path`),
    type,
    operators,
  };
  if (Object.hasOwn(input, "default")) result.default = structuredClone(input.default);
  if (input.values !== undefined) result.values = stringArray(input.values, `${label}.values`);
  if (type === "enum" && !result.values?.length) throw new Error(`${label}.values is required for enum indexes.`);
  return result;
}

function normalizeView(value, label) {
  const input = object(value, label);
  knownFields(input, ["format", "fields", "separator"], label, ["fields"]);
  const format = input.format || "object";
  if (!VIEW_FORMATS.has(format)) throw new Error(`${label}.format is unsupported.`);
  if (!Array.isArray(input.fields) || input.fields.length === 0) throw new Error(`${label}.fields must be a non-empty array.`);
  const fields = input.fields.map((raw, index) => {
    const field = object(raw, `${label}.fields[${index}]`);
    knownFields(field, ["path", "label"], `${label}.fields[${index}]`, ["path"]);
    return {
      path: pointer(field.path, `${label}.fields[${index}].path`),
      ...(field.label === undefined ? {} : { label: String(field.label) }),
    };
  });
  return {
    format,
    fields,
    separator: typeof input.separator === "string" ? input.separator : "\n",
  };
}

function normalizeRecordType(value, label) {
  const input = object(value, label);
  knownFields(input, ["dataSchemaVersion", "indexes", "searchableFields", "views", "actions", "schemaFile", "processors", "identity"], label, ["dataSchemaVersion"]);
  if (!Number.isSafeInteger(input.dataSchemaVersion) || input.dataSchemaVersion < 1) throw new Error(`${label}.dataSchemaVersion must be a positive integer.`);
  const indexes = {};
  for (const [id, definition] of Object.entries(object(input.indexes || {}, `${label}.indexes`))) {
    indexes[safeId(id, `${label}.indexes key`)] = normalizeIndex(definition, `${label}.indexes.${id}`);
  }
  const views = {};
  for (const [id, definition] of Object.entries(object(input.views || {}, `${label}.views`))) {
    views[safeId(id, `${label}.views key`)] = normalizeView(definition, `${label}.views.${id}`);
  }
  const processors = {};
  for (const [action, raw] of Object.entries(object(input.processors || {}, `${label}.processors`))) {
    safeId(action, `${label}.processors action`);
    const processor = object(raw, `${label}.processors.${action}`);
    knownFields(processor, ["file", "export"], `${label}.processors.${action}`, ["file", "export"]);
    processors[action] = {
      file: safeRelativePath(processor.file, `${label}.processors.${action}.file`),
      export: safeId(processor.export, `${label}.processors.${action}.export`),
    };
  }
  let identity = null;
  if (input.identity !== undefined && input.identity !== null) {
    const rawIdentity = object(input.identity, `${label}.identity`);
    knownFields(rawIdentity, ["namePath", "aliasesPath"], `${label}.identity`, ["namePath"]);
    identity = {
      namePath: pointer(rawIdentity.namePath, `${label}.identity.namePath`),
      aliasesPath: rawIdentity.aliasesPath === undefined ? null : pointer(rawIdentity.aliasesPath, `${label}.identity.aliasesPath`),
    };
  }
  return {
    dataSchemaVersion: input.dataSchemaVersion,
    indexes,
    searchableFields: (input.searchableFields || []).map((path, index) => pointer(path, `${label}.searchableFields[${index}]`)),
    views,
    actions: stringArray(input.actions || [], `${label}.actions`),
    schemaFile: safeRelativePath(input.schemaFile, `${label}.schemaFile`),
    processors,
    identity,
  };
}

function normalizeStorage(value, label) {
  const input = object(value, label);
  knownFields(input, ["kind", "partition", "initialRecordsFile", "initialSnapshotFile"], label, ["kind"]);
  if (!STORAGE_KINDS.has(input.kind)) throw new Error(`${label}.kind is unsupported.`);
  const partition = object(input.partition || { mode: "single" }, `${label}.partition`);
  knownFields(partition, ["mode", "index", "fallback", "size"], `${label}.partition`, ["mode"]);
  const mode = partition.mode || "single";
  if (!PARTITION_MODES.has(mode)) throw new Error(`${label}.partition.mode is unsupported.`);
  if (mode === "index" && (typeof partition.index !== "string" || !partition.index)) throw new Error(`${label}.partition.index is required.`);
  if (mode === "turn-range" && (!Number.isSafeInteger(partition.size) || partition.size < 1)) throw new Error(`${label}.partition.size must be positive.`);
  return {
    kind: input.kind,
    partition: {
      mode,
      ...(mode === "index" ? { index: partition.index, fallback: String(partition.fallback || "unassigned") } : {}),
      ...(mode === "turn-range" ? { size: partition.size } : {}),
    },
    initialRecordsFile: safeRelativePath(input.initialRecordsFile, `${label}.initialRecordsFile`),
    initialSnapshotFile: safeRelativePath(input.initialSnapshotFile, `${label}.initialSnapshotFile`),
  };
}

export function normalizeDataContract(value, expectedModuleId = null) {
  const input = object(value, "data contract");
  knownFields(input, ["schemaVersion", "moduleId", "collections", "capabilities"], "data contract", ["schemaVersion", "moduleId", "collections", "capabilities"]);
  if (input.schemaVersion !== 1) throw new Error("data contract schemaVersion must be 1.");
  const moduleId = safeId(input.moduleId, "data contract moduleId");
  if (expectedModuleId && moduleId !== expectedModuleId) throw new Error(`Data contract moduleId must be ${expectedModuleId}.`);
  const collections = {};
  for (const [id, raw] of Object.entries(object(input.collections, "data contract collections"))) {
    safeId(id, "collection ID");
    const collection = object(raw, `collection ${id}`);
    knownFields(collection, ["storage", "recordTypes"], `collection ${id}`, ["storage", "recordTypes"]);
    const recordTypes = {};
    for (const [typeId, definition] of Object.entries(object(collection.recordTypes, `collection ${id}.recordTypes`))) {
      recordTypes[safeId(typeId, `collection ${id} record type`)] = normalizeRecordType(definition, `collection ${id}.recordTypes.${typeId}`);
    }
    if (Object.keys(recordTypes).length === 0) throw new Error(`Collection ${id} requires at least one record type.`);
    collections[id] = { storage: normalizeStorage(collection.storage, `collection ${id}.storage`), recordTypes };
  }
  if (Object.keys(collections).length === 0) throw new Error("A data contract requires at least one collection.");

  const capabilities = {};
  for (const [id, raw] of Object.entries(object(input.capabilities || {}, "data contract capabilities"))) {
    safeId(id, "capability ID");
    const capability = object(raw, `capability ${id}`);
    knownFields(capability, ["collections", "actions", "views"], `capability ${id}`, ["collections", "actions", "views"]);
    const collectionIds = stringArray(capability.collections || [], `capability ${id}.collections`);
    const unknown = collectionIds.filter(collectionId => !collections[collectionId]);
    if (unknown.length) throw new Error(`Capability ${id} references unknown collections: ${unknown.join(", ")}.`);
    const actions = stringArray(capability.actions || [], `capability ${id}.actions`);
    const views = stringArray(capability.views || [], `capability ${id}.views`);
    for (const collectionId of collectionIds) {
      const definitions = Object.values(collections[collectionId].recordTypes);
      const supportedActions = new Set(["query", ...definitions.flatMap(definition => definition.actions)]);
      if (actions.some(action => !supportedActions.has(action))) throw new Error(`Capability ${id} has an action unsupported by ${collectionId}.`);
      if (views.some(view => definitions.some(definition => !definition.views[view]))) throw new Error(`Capability ${id} view must be defined by every record type in ${collectionId}.`);
    }
    capabilities[id] = {
      collections: collectionIds,
      actions,
      views,
    };
  }
  return { schemaVersion: 1, moduleId, collections, capabilities };
}

export function recordTypeDefinition(contract, collectionId, recordType) {
  const collection = contract?.collections?.[collectionId];
  if (!collection) throw new Error(`Unknown collection ${collectionId}.`);
  const definition = collection.recordTypes?.[recordType];
  if (!definition) throw new Error(`Unknown record type ${recordType} in ${collectionId}.`);
  return definition;
}

export function capabilityAllows(contract, capabilityIds, { collectionId, action, view = null }) {
  return (capabilityIds || []).some(id => {
    const capability = contract?.capabilities?.[id];
    return capability
      && capability.collections.includes(collectionId)
      && capability.actions.includes(action)
      && (view === null || capability.views.includes(view));
  });
}

export function isSafeDataId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}
