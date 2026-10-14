import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApplication } from "./index.mjs";
import { createRpClient } from "../rp-web-client/index.mjs";
import { createHostSessionScope } from "../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-host-session-scope.ts";

test("headless clients isolate previews, cursors and commands across chat/connection changes", async t => {
  const scope = createHostSessionScope();
  scope.current = { recordId: "chat-one", sessionDirectory: "test-chat" };
  let mutations = 0;
  const services = {
    withRequest: (context, action) => scope.run(action, context),
    getState: async () => ({ messages: [{ sequence: 1, role: "assistant", content: scope.executionId || "adopted" }], busy: false }),
    queryModuleFrontendRegion: async (_module, _binding, value) => ({ items: [{ id: scope.executionId || "adopted" }], cursor: value.cursor, nextCursor: value.cursor ? null : "offset:1" }),
    submitInput: async () => { mutations++; },
    getUserAvatar: async () => ({ body: Buffer.from([1, 2, 3]), mimeType: "image/png" }),
  };
  const server = createServer(createApplication({ bridge: services, cardStore: { getPublicCard: async () => ({ id: "card-one" }) }, identity: () => ({ cardId: "card-one", chatId: scope.current.recordId }) }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const one = createRpClient({ baseUrl }), two = createRpClient({ baseUrl }); t.after(() => { one.dispose(); two.dispose(); });
  await Promise.all([one.connect(), two.connect()]);
  assert.equal(one.connection.capabilities.includes("post.input"), true);
  assert.equal(one.connection.capabilities.includes("post.narrative-attempts.regenerate"), false);
  one.preview("attempt-one"); two.preview("attempt-two");
  const [a, b] = await Promise.all([one.chat.state(), two.chat.state()]);
  assert.equal(a.messages[0].content, "attempt-one"); assert.equal(b.messages[0].content, "attempt-two");
  const page = await one.modules.query("module", "records");
  assert.equal((await one.modules.query("module", "records", `?cursor=${encodeURIComponent(page.nextCursor)}`)).cursor, "offset:1");
  await assert.rejects(two.modules.query("module", "records", `?cursor=${encodeURIComponent(page.nextCursor)}`), { code: "session_changed" });
  await assert.rejects(one.chat.input({ content: "test", operationId: "op-one" }), { code: "preview_read_only" });
  assert.equal(mutations, 0);
  one.preview(null); await one.chat.input({ content: "test", operationId: "op-one" }); assert.equal(mutations, 1);
  assert.equal((await one.request("user-avatar?playerName=test", { binary: true })).size, 3);
  await assert.rejects(one.attempts.regenerate({ executionId: "new" }), { code: "unsupported_capability" });
  assert.equal((await fetch(`${baseUrl}/api/state`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/index.html`)).status, 404); // API-only has no implicit public root.
  scope.current.recordId = "chat-two";
  await assert.rejects(one.chat.input({ content: "late", operationId: "op-late" }), { code: "session_changed" });
  assert.equal(mutations, 1);
  await one.connect(); assert.equal(one.readContext.chatId, "chat-two");
  const forbidden = await fetch(`${baseUrl}/api/v1/state`, { headers: { origin: "http://attacker.invalid" } }); assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${baseUrl}/api/v1/input`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(invalid.status, 400);
});

test("in-flight work cannot mutate the new chat after a switch", async () => {
  const scope = createHostSessionScope(); scope.current = { recordId: "old", sessionDirectory: "old" };
  let continueWork;
  const gated = new Promise(resolve => { continueWork = resolve; });
  const result = scope.run(async () => { const owner = scope.requireCurrent(); await gated; owner.recordId = "bad"; }, { serverInstanceId: "instance", cardId: "card", chatId: "old", executionId: null });
  scope.current.recordId = "new"; scope.current.sessionDirectory = "new"; continueWork();
  await assert.rejects(result, { code: "session_changed" }); assert.equal(scope.current.recordId, "new");
});
