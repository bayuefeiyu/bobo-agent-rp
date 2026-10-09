import test from "node:test";
import assert from "node:assert/strict";
import { createConfigWebBridge } from "./rp-web-config-bridge.ts";

test("current model discovery uses active profile credentials without returning them", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ data: [{ id: "b" }, { id: "a" }] }) };
  };
  const owner = { configToken: "test" };
  const bridge = createConfigWebBridge({ manifest: {}, scope: { requireCurrent: () => owner },
    configProfiles: {}, configStore: { listModels: async options => {
      assert.equal(options.includeSecrets, true);
      return [{ id: "active-model", apiKey: "saved-test-key" }];
    } }, context: {}, resolveConfiguredModel: () => assert.fail("Discovery does not register models") });
  const result = await bridge.discoverModels({ modelId: "active-model", baseUrl: "https://fixture.invalid/v1/", api: "openai-responses" });
  assert.deepEqual(result, { models: ["a", "b"] });
  assert.equal(requests[0].url, "https://fixture.invalid/v1/models");
  assert.equal(requests[0].options.headers.authorization, "Bearer saved-test-key");
  assert.ok(!JSON.stringify(result).includes("saved-test-key"));
  await bridge.discoverModels({ modelId: "active-model", baseUrl: "https://fixture.invalid", api: "anthropic-messages", apiKey: "explicit-test-key" });
  assert.equal(requests[1].options.headers["x-api-key"], "explicit-test-key");
});
