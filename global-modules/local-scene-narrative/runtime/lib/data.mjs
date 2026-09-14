export async function queryAll(data, request, pageSize = 200, pageCharacters = 500000) {
  if (typeof data.queryAll === "function") return data.queryAll(request, { limit: pageSize, maxCharacters: pageCharacters });
  const items = [];
  let cursor = null;
  do {
    const result = await data.query({ ...request, cursor, limit: pageSize, maxCharacters: pageCharacters });
    items.push(...(result.items || []));
    cursor = result.nextCursor || null;
  } while (cursor);
  return items;
}

export async function latestBusinessRecord(data, request, field = "storySequence") {
  const result = await data.query({ ...request, sort: [{ field, order: "desc" }], limit: 1, maxCharacters: request.maxCharacters || 50000 });
  return result.items?.[0] || null;
}
