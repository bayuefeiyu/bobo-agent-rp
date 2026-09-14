export async function queryAll(data, request, pageSize = 500, pageCharacters = 500000) {
  if (typeof data.queryAll === "function") return data.queryAll(request, { limit: pageSize, maxCharacters: pageCharacters });
  const items = [];
  let cursor = null;
  do {
    const result = await data.query({ ...request, cursor, limit: pageSize, maxCharacters: pageCharacters });
    items.push(...(result.items || []));
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function safeFileId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "record";
}
