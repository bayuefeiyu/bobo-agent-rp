export function buildAgentChangeBatch(value, {
  batchId,
  allowedCollections,
  archiveFirst = false,
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : null;
  const operations = Array.isArray(source?.operations) ? source.operations : null;
  if (!operations) throw new Error("Director Agent must return an object containing an operations array.");
  const allowed = new Set(allowedCollections || []);
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error(`Director operation ${index} must be an object.`);
    if (operation.moduleId !== "world-narrative-coordinator" || !allowed.has(operation.collectionId)) throw new Error(`Director operation ${index} exceeds the allowed collections.`);
  }
  const ordered = archiveFirst
    ? operations.map((operation, index) => ({ operation, index })).sort((left, right) => {
        const rank = item => item.operation.collectionId === "archive-outbox" ? 0 : 1;
        return rank(left) - rank(right) || left.index - right.index;
      }).map(item => item.operation)
    : operations;
  return {
    protocolVersion: 1,
    batchId,
    status: "pending",
    commitPolicy: "atomic",
    operations: ordered.map((operation, index) => ({ ...operation, operationId: operation.operationId || `${batchId}-op-${index + 1}` })),
  };
}

export async function submitCommitted(data, batch, options) {
  const receipt = await data.submit(batch, options);
  if (receipt?.status !== "committed") throw new Error(receipt?.error?.message || receipt?.error || `Director data batch ${batch.batchId} completed with status ${receipt?.status || "unknown"}.`);
  return receipt;
}
