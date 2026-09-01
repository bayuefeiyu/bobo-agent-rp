const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function emptyTokenUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = Object.fromEntries(TOKEN_FIELDS.map(field => [field, tokenCount(value[field])]));
  const componentTotal = TOKEN_FIELDS.reduce((total, field) => total + normalized[field], 0);
  return {
    ...normalized,
    totalTokens: Number.isFinite(value.totalTokens) && value.totalTokens >= 0
      ? Math.floor(value.totalTokens)
      : componentTotal,
  };
}

export function addTokenUsage(left, right) {
  const result = emptyTokenUsage();
  for (const usage of [normalizeTokenUsage(left), normalizeTokenUsage(right)].filter(Boolean)) {
    for (const field of TOKEN_FIELDS) result[field] += usage[field];
    result.totalTokens += usage.totalTokens;
  }
  return result;
}

export function tokenUsageFromMessages(messages, since = 0) {
  let found = false;
  let result = emptyTokenUsage();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (Number.isFinite(since) && Number.isFinite(message?.timestamp) && message.timestamp < since) continue;
    const usage = normalizeTokenUsage(message?.usage);
    if (!usage) continue;
    found = true;
    result = addTokenUsage(result, usage);
  }
  return found ? result : null;
}
