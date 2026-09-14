import { createHash, randomUUID } from "node:crypto";
import { normalizeNarrativeSource } from "./rp-narrative-source.mjs";

const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export function recordContentHash(record) {
  return createHash("sha256").update(JSON.stringify(record.data)).digest("hex");
}

export function createRecordEnvelope({ source, sequence, binding, metadata, data, id, createdAt }) {
  const timestamp = createdAt || new Date().toISOString();
  return validateRecordEnvelope({
    schemaVersion: 1,
    id: id || `record-${randomUUID()}`,
    source,
    sequence,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    binding: {
      messageId: binding?.messageId ?? null,
      turn: binding?.turn ?? 0,
    },
    metadata: {
      recordType: metadata?.recordType || "record",
      entityIds: Array.isArray(metadata?.entityIds) ? metadata.entityIds : [],
      tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
      narrativeSource: normalizeNarrativeSource(metadata?.narrativeSource),
      ...(typeof metadata?.title === "string" && metadata.title.trim() ? { title: metadata.title.trim() } : {}),
    },
    data,
  });
}

export function reviseRecord(record, data) {
  const current = validateRecordEnvelope(record);
  return validateRecordEnvelope({
    ...current,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    data,
  });
}

export function validateRecordEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Record must be an object.");
  if (value.schemaVersion !== 1) throw new Error("Record schemaVersion must be 1.");
  if (typeof value.id !== "string" || !safeIdPattern.test(value.id)) throw new Error("Record id is invalid.");
  if (typeof value.source !== "string" || !safeIdPattern.test(value.source)) throw new Error("Record source is invalid.");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("Record sequence is invalid.");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Record revision is invalid.");
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") throw new Error("Record timestamps are invalid.");
  if (!value.binding || typeof value.binding !== "object" || Array.isArray(value.binding)) throw new Error("Record binding is invalid.");
  if (value.binding.messageId !== null && (typeof value.binding.messageId !== "string" || !safeIdPattern.test(value.binding.messageId))) {
    throw new Error("Record binding.messageId is invalid.");
  }
  if (!Number.isSafeInteger(value.binding.turn) || value.binding.turn < 0) throw new Error("Record binding.turn is invalid.");
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) throw new Error("Record metadata is invalid.");
  if (typeof value.metadata.recordType !== "string" || !value.metadata.recordType.trim()) throw new Error("Record metadata.recordType is invalid.");
  for (const field of ["entityIds", "tags"]) {
    if (!Array.isArray(value.metadata[field]) || value.metadata[field].some(item => typeof item !== "string")) {
      throw new Error(`Record metadata.${field} must be a string array.`);
    }
  }
  if (value.metadata.narrativeSource !== undefined) normalizeNarrativeSource(value.metadata.narrativeSource);
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("Record data must be an object.");
  return value;
}

export function parseRecordLines(text) {
  return text.split("\n").filter(line => line.trim()).map((line, index) => {
    try {
      return validateRecordEnvelope(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid record at JSONL line ${index + 1}: ${error.message}`);
    }
  });
}

export function toRecordLines(records) {
  return records.length ? `${records.map(record => JSON.stringify(validateRecordEnvelope(record))).join("\n")}\n` : "";
}

export function defaultSelector(sourceKind) {
  return sourceKind === "messages" ? { type: "all" } : { type: "latest", limit: 1 };
}

export function normalizeRetrievalPolicy(value, sourceKind) {
  const codeProfile = value?.code?.profile === "custom" ? "custom" : "default";
  if (codeProfile === "custom" && (!value?.code?.selector || typeof value.code.selector !== "object")) {
    throw new Error("A custom code retrieval profile requires selector.");
  }
  const agentMode = ["disabled", "append", "override"].includes(value?.agent?.mode) ? value.agent.mode : "disabled";
  const maxRecords = Number.isSafeInteger(value?.agent?.maxRecords) && value.agent.maxRecords > 0
    ? Math.min(value.agent.maxRecords, 500)
    : 50;
  return {
    schemaVersion: 2,
    code: {
      profile: codeProfile,
      selector: codeProfile === "custom" ? value.code.selector : defaultSelector(sourceKind),
    },
    agent: {
      mode: agentMode,
      fallback: "code",
      onNotTriggered: value?.agent?.onNotTriggered === "empty" ? "empty" : "code",
      maxRecords,
    },
  };
}

function valueAtPath(record, path) {
  if (typeof path !== "string" || !path) return undefined;
  return path.split(".").reduce((current, key) => current == null ? undefined : current[key], record);
}

function chronological(records) {
  return [...records].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function selectRecords(records, selector, maximum = 500) {
  const available = chronological(records.map(validateRecordEnvelope));
  if (!selector || typeof selector !== "object") throw new Error("Record selector must be an object.");
  const cap = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(maximum, 500) : 500;
  let selected = [];
  let missing = [];

  if (selector.type === "all") {
    selected = available;
  } else if (selector.type === "latest") {
    const limit = Number.isSafeInteger(selector.limit) && selector.limit > 0 ? selector.limit : 1;
    selected = available.slice(-Math.min(limit, cap));
  } else if (selector.type === "ids") {
    if (!Array.isArray(selector.ids)) throw new Error("ids selector requires an ids array.");
    const requested = [...new Set(selector.ids.filter(id => typeof id === "string"))];
    const byId = new Map(available.map(record => [record.id, record]));
    selected = requested.map(id => byId.get(id)).filter(Boolean);
    missing = requested.filter(id => !byId.has(id));
  } else if (selector.type === "range") {
    const from = Number.isSafeInteger(selector.fromSequence) ? selector.fromSequence : 0;
    const to = Number.isSafeInteger(selector.toSequence) ? selector.toSequence : Number.MAX_SAFE_INTEGER;
    if (from > to) throw new Error("range selector fromSequence must not exceed toSequence.");
    selected = available.filter(record => record.sequence >= from && record.sequence <= to);
  } else if (selector.type === "around") {
    if (typeof selector.id !== "string") throw new Error("around selector requires id.");
    const index = available.findIndex(record => record.id === selector.id);
    if (index === -1) {
      missing = [selector.id];
    } else {
      const before = Number.isSafeInteger(selector.before) && selector.before >= 0 ? selector.before : 0;
      const after = Number.isSafeInteger(selector.after) && selector.after >= 0 ? selector.after : 0;
      selected = available.slice(Math.max(0, index - before), index + after + 1);
    }
  } else if (selector.type === "latest_per_key") {
    if (typeof selector.path !== "string" || !selector.path) throw new Error("latest_per_key selector requires path.");
    const values = Array.isArray(selector.values) ? new Set(selector.values.map(String)) : null;
    const limitPerKey = Number.isSafeInteger(selector.limitPerKey) && selector.limitPerKey > 0 ? selector.limitPerKey : 1;
    const groups = new Map();
    for (const record of available) {
      const key = valueAtPath(record, selector.path);
      if (key == null || (values && !values.has(String(key)))) continue;
      const group = groups.get(String(key)) || [];
      group.push(record);
      groups.set(String(key), group);
    }
    selected = chronological([...groups.values()].flatMap(group => group.slice(-limitPerKey)));
  } else {
    throw new Error(`Unsupported record selector: ${String(selector.type)}`);
  }

  if (selected.length > cap) selected = selected.slice(selected.length - cap);
  return { records: chronological(selected), missing };
}

function recordTitle(record) {
  if (typeof record.metadata.title === "string" && record.metadata.title.trim()) return record.metadata.title.trim();
  const content = typeof record.data.content === "string" ? record.data.content : JSON.stringify(record.data);
  return content.replace(/\s+/g, " ").trim().slice(0, 80) || record.metadata.recordType;
}

export function buildCatalog(records) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: chronological(records).map(record => {
      const contentHash = recordContentHash(record);
      return {
        recordId: record.id,
        recordRevision: record.revision,
        contentHash,
        source: record.source,
        sequence: record.sequence,
        turn: record.binding.turn,
        recordType: record.metadata.recordType,
        entityIds: record.metadata.entityIds,
        tags: record.metadata.tags,
        title: recordTitle(record),
      };
    }),
  };
}

export function formatCatalog(catalog) {
  if (!catalog?.entries?.length) return "No records are available.";
  return catalog.entries.map(entry => {
    const tags = [...new Set(entry.tags || [])];
    return [
      entry.recordId,
      entry.title,
      entry.recordType,
      `turn ${entry.turn}`,
      tags.length ? `tags: ${tags.join(", ")}` : "",
    ].filter(Boolean).join(" | ");
  }).join("\n");
}

export function formatRecords(records) {
  if (!records.length) return "No records selected.";
  return records.map(record => [
    `[${record.id} | ${record.source} | sequence ${record.sequence} | revision ${record.revision} | turn ${record.binding.turn}]`,
    JSON.stringify({ metadata: record.metadata, data: record.data }, null, 2),
  ].join("\n")).join("\n\n");
}
