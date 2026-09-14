const BUSINESS_FIELDS = ["recordKind", "intent", "subject", "content", "knowledgeScope", "sourceTurn", "dedupeKey"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function archiveContentProjection(value) {
  return Object.fromEntries(BUSINESS_FIELDS.map(field => [field, canonical(value?.[field])]));
}

export function sameArchiveContent(left, right) {
  return JSON.stringify(archiveContentProjection(left)) === JSON.stringify(archiveContentProjection(right));
}

export async function applyArchiveContentVersions(data, batch) {
  const operations = [];
  for (const operation of batch.operations) {
    if (operation.collectionId !== "archive-outbox" || !["create", "update"].includes(operation.action) || !operation.data) {
      operations.push(operation);
      continue;
    }
    if (operation.action === "create") {
      operations.push({ ...operation, data: { ...operation.data, contentVersion: 1 } });
      continue;
    }
    const current = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", id: operation.targetId, view: "archive-source" });
    if (!current) throw new Error(`Archive handoff ${operation.targetId} was not found for versioned update.`);
    const baseline = Number.isSafeInteger(current.value?.contentVersion) ? current.value.contentVersion : Math.max(1, Number(current.revision) || 1);
    const contentVersion = sameArchiveContent(current.value, operation.data) ? baseline : baseline + 1;
    operations.push({ ...operation, data: { ...operation.data, contentVersion } });
  }
  return { ...batch, operations };
}
