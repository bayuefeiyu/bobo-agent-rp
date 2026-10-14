const COLLECTIONS = ["entities", "relationships", "events", "cognitions", "knower-groups"];

/** Only a provably empty authorized source bypasses creative matching. */
export async function execute({ data }) {
  for (const collectionId of COLLECTIONS) {
    const page = await data.query({ moduleId: "narrative-memory", collectionId, view: "retrieval", limit: 1 });
    if (!Array.isArray(page.items)) throw new Error("Invalid memory source query result.");
    if (page.items.length) return { route: "available", hasRecords: true };
    if (page.truncated || page.nextCursor) throw new Error("Memory source emptiness could not be established.");
  }
  return { route: "empty", hasRecords: false };
}
