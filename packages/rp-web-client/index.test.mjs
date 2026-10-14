import test from "node:test";
import assert from "node:assert/strict";
import { createRpClient } from "./index.mjs";
const context = { serverInstanceId: "server", cardId: "card", chatId: "chat", executionId: null };
const connection = { apiVersion: { major: 1, minor: 0 }, hostVersion: { major: 1, minor: 0 }, readContext: context };
const json = data => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

test("cancelled context discards late responses even when transport ignores abort", async () => {
  let resolveRead;
  const client = createRpClient({ baseUrl: "http://localhost", fetch: async url => url.includes("connection") ? json(connection) : new Promise(resolve => { resolveRead = resolve; }) });
  await client.connect(); const pending = client.chat.state(); await new Promise(resolve => setImmediate(resolve));
  client.preview("other"); resolveRead(json({ content: "old" }));
  await assert.rejects(pending, { code: "session_changed" }); client.dispose();
});

test("watchers mark initial and resynchronised snapshots, release polling and avoid implicit retries", async () => {
  let calls = 0, writes = 0; const seen = [];
  const client = createRpClient({ baseUrl: "http://localhost", fetch: async (url, options) => {
    if (url.includes("connection")) return json(connection);
    if (options.method === "POST") { writes++; throw new Error("connection lost"); }
    calls++; return json({ revision: 1 });
  } });
  await client.connect();
  const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()); };
  const stop = client.watch("state", (_value, meta) => seen.push(meta.kind), { intervalMs: 5 });
  await waitFor(() => calls >= 2); assert.deepEqual(seen, ["snapshot"]);
  client.preview("candidate"); await waitFor(() => seen.length === 2); assert.deepEqual(seen, ["snapshot", "snapshot"]);
  stop(); const count = calls; await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, count);
  await assert.rejects(client.chat.input({ content: "hello", operationId: "same" })); assert.equal(writes, 1);
  assert.throws(() => client.resourceUrl("https://attacker.invalid/api/v1/image")); client.dispose();
});
