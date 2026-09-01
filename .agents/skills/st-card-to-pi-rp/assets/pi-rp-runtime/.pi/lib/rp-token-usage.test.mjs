import assert from "node:assert/strict";
import test from "node:test";

import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage, tokenUsageFromMessages } from "./rp-token-usage.mjs";

test("normalizes and adds provider token usage", () => {
  assert.deepEqual(normalizeTokenUsage({ input: 10, output: 4, cacheRead: 20, cacheWrite: 2, totalTokens: 36 }), {
    input: 10, output: 4, cacheRead: 20, cacheWrite: 2, totalTokens: 36,
  });
  assert.deepEqual(addTokenUsage(emptyTokenUsage(), { input: 3, output: 2 }), {
    input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  });
});

test("sums all model and nested tool usage within a node time boundary", () => {
  const messages = [
    { role: "assistant", timestamp: 90, usage: { input: 100, output: 1, totalTokens: 101 } },
    { role: "assistant", timestamp: 110, usage: { input: 20, output: 5, cacheRead: 10, totalTokens: 35 } },
    { role: "toolResult", timestamp: 120, usage: { input: 4, output: 2, totalTokens: 6 } },
    { role: "assistant", timestamp: 130, usage: { input: 8, output: 3, cacheWrite: 1, totalTokens: 12 } },
  ];
  assert.deepEqual(tokenUsageFromMessages(messages, 100), {
    input: 32, output: 10, cacheRead: 10, cacheWrite: 1, totalTokens: 53,
  });
  assert.equal(tokenUsageFromMessages([{ role: "user", timestamp: 110 }], 100), null);
});
