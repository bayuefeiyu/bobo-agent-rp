import test from "node:test";
import assert from "node:assert/strict";
import { createPresentationHost } from "./presentation-host.mjs";
import { createRpClient } from "./index.mjs";
const context = { serverInstanceId: "server", cardId: "card", chatId: "chat", executionId: null };
const connection = { apiVersion: { major: 1, minor: 0 }, hostVersion: { major: 1, minor: 0 }, readContext: context, capabilities: [] };
const createClient = () => createRpClient({ baseUrl: "http://localhost", fetch: async () => new Response(JSON.stringify({ data: connection })) });
const manifest = { schemaVersion: 1, id: "test", version: "1.0.0", kind: "custom", root: "frontends/test", entry: "index.mjs", apiVersion: { major: 1, minor: 0 }, hostVersion: { major: 1, minor: 0 }, requiredCapabilities: [], optionalCapabilities: [], assets: ["index.mjs"], immersive: true };
test("presentation host frees requests/rendering, routes management and falls back after load failure", async () => {
  const client = createClient(); await client.connect(); const navigated = [], layouts = [], errors = [];
  let contextValue = null, closed = 0, receivedSignal;
  const host = createPresentationHost({ client, container: { replaceChildren() {} }, navigate: panel => navigated.push(panel), layout: (...value) => layouts.push(value), onError: error => errors.push(error), fallback: () => navigated.push("fallback"), load: async url => {
    if (url === "bad") throw new Error("missing build chunk");
    return { mount: async value => { receivedSignal = value.signal; value.host.openManagement("profiles"); return { onContext: value => { contextValue = value; }, unmount() { closed++; } }; } };
  } });
  await host.mount(manifest, { createClient, entryUrl: "good", assetUrl: path => path }); assert.equal(host.active.id, "test"); assert.deepEqual(navigated, ["profiles"]);
  host.context({ ...context, chatId: "other" }); assert.equal(contextValue.chatId, "other");
  await host.unmount(); assert.equal(receivedSignal.aborted, true); assert.equal(closed, 1);
  await host.mount(manifest, { createClient, entryUrl: "bad", assetUrl: path => path }); assert.equal(host.active, null); assert.equal(errors.length, 1); assert.equal(navigated.at(-1), "fallback");
  assert.deepEqual(layouts.at(-1), [false, false]); client.dispose();
});

test("a retired asynchronous entry cannot mount after a replacement", async () => {
  const client = createClient(); await client.connect();
  let release, oldMounts = 0, currentMounts = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const host = createPresentationHost({ client, container: { replaceChildren() {} }, navigate() {}, load: url => url === "old" ? waiting : Promise.resolve({ mount: async () => { currentMounts++; return { unmount() {} }; } }) });
  const old = host.mount(manifest, { createClient, entryUrl: "old" });
  await new Promise(resolve => setImmediate(resolve));
  await host.mount({ ...manifest, id: "replacement" }, { createClient, entryUrl: "new" });
  release({ mount: async () => { oldMounts++; return { unmount() {} }; } });
  await old;
  assert.equal(oldMounts, 0); assert.equal(currentMounts, 1); assert.equal(host.active.id, "replacement");
  await host.unmount(); client.dispose();
});
