export async function queryAll(data, request) {
  if (typeof data.queryAll === "function") return data.queryAll(request, { limit: request.limit || 20, maxCharacters: request.maxCharacters || 6000 });
  const items = [];
  let cursor = null;
  do {
    const result = await data.query({ ...request, cursor, limit: request.limit || 20, maxCharacters: request.maxCharacters || 6000 });
    items.push(...(result.items || []));
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

export function unwrap(item) {
  return { id: item.id, recordType: item.recordType, revision: item.revision, data: item.value };
}

export async function getById(data, collectionId, id, view = "retrieval") {
  const item = await data.get({ moduleId: "narrative-memory", collectionId, id, view });
  return item ? unwrap(item) : null;
}

export function collectionFor(recordType) {
  if (recordType === "memory.entity") return "entities";
  if (recordType === "memory.relationship") return "relationships";
  if (recordType === "memory.event" || recordType === "memory.event-summary") return "events";
  if (recordType === "memory.cognition") return "cognitions";
  if (recordType === "memory.knower-group") return "knower-groups";
  if (["memory.settings", "memory.archive-state", "memory.archive-coverage", "memory.maintenance-state", "memory.time-auxiliary"].includes(recordType)) return "support";
  if (recordType === "memory.source-capture") return "source-captures";
  throw new Error(`Unknown narrative-memory record type: ${recordType}.`);
}

export async function submitCommitted(data, batch, options) {
  const receipt = await data.submit(batch, options);
  if (receipt?.status !== "committed") throw new Error(receipt?.error?.message || receipt?.error || `Narrative-memory batch ${batch.batchId} completed with status ${receipt?.status || "unknown"}.`);
  return receipt;
}
