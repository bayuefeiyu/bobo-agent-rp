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

test("draft connections use the edited profile's saved key without requiring activation", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const secretReads = [], completions = [], requests = [];
  const providers = new Map(), removedProviders = [];
  let failCompletion = false;
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ data: [{ id: "draft-model" }] }) }; };
  const bridge = createConfigWebBridge({ manifest: {}, scope: { requireCurrent: () => ({}) },
    configProfiles: { getModelSecret: async (profileId, modelId) => { secretReads.push({ profileId, modelId }); return "inactive-test-key"; } },
    configStore: { listModels: () => assert.fail("Must not read the active scheme for a draft") },
    pi: { registerProvider: (id, config) => providers.set(id, config), unregisterProvider: id => { removedProviders.push(id); providers.delete(id); } },
    context: { modelRegistry: {
      find: (provider, id) => { const config = providers.get(provider); return { ...config.models[0], baseUrl: config.baseUrl, api: config.api, provider, id }; },
      complete: async (model, input, options) => { if (failCompletion) throw new Error("Fixture connection failed"); completions.push({ model, input, options }); return { content: [{ type: "text", text: "ok" }], provider: model.provider, model: model.id }; },
    } },
    resolveConfiguredModel: () => assert.fail("Drafts must not resolve saved model definitions") });
  const draft = { schemaVersion: 1, id: "existing", name: "Draft", provider: "custom", model: "draft-model", baseUrl: "https://fixture.invalid/v1", api: "openai-completions", contextWindow: 200000, maxOutputTokens: 4096, thinking: "off" };
  const discovery = await bridge.discoverModels({ profileId: "inactive", modelId: "existing", baseUrl: draft.baseUrl, api: draft.api });
  assert.deepEqual(discovery.models, ["draft-model"]);
  assert.equal(requests[0].options.headers.authorization, "Bearer inactive-test-key");
  const result = await bridge.testModel({ profileId: "inactive", modelId: "existing", modelProfile: draft });
  assert.equal(result.ok, true);
  assert.equal(completions[0].model.id, "draft-model");
  assert.equal(completions[0].model.baseUrl, draft.baseUrl);
  assert.equal(completions[0].model.api, draft.api);
  assert.equal(completions[0].model.contextWindow, 200000);
  assert.equal(completions[0].options.apiKey, "inactive-test-key");
  assert.equal(completions[0].options.maxTokens, 64);
  assert.deepEqual(secretReads, [{ profileId: "inactive", modelId: "existing" }, { profileId: "inactive", modelId: "existing" }]);
  await bridge.testModel({ profileId: "inactive", modelProfile: { ...draft, id: "" }, apiKey: "unsaved-test-key" });
  assert.equal(completions[1].options.apiKey, "unsaved-test-key");
  assert.equal(secretReads.length, 2);
  assert.equal(providers.size, 0);
  assert.equal(removedProviders.length, 2);
  assert.notEqual(removedProviders[0], removedProviders[1]);
  failCompletion = true;
  await assert.rejects(bridge.testModel({ modelProfile: draft, apiKey: "unsaved-test-key" }), /Fixture connection failed/);
  assert.equal(providers.size, 0);
  assert.equal(removedProviders.length, 3);
  assert.ok(!JSON.stringify(result).includes("inactive-test-key"));
});

test("model secret copy requests read from the profile cache without passing a key", async () => {
  const calls=[];
  const bridge=createConfigWebBridge({configProfiles:{
    copyModelSecret:async(profileId,sourceModelId,targetModelId)=>{calls.push({profileId,sourceModelId,targetModelId});return {hasSecret:true};},
    saveModelSecret:async()=>assert.fail("Cache copies must not pass a key through the client"),
  }});
  assert.deepEqual(await bridge.saveConfigModelSecret("scheme","copy",{sourceModelId:"source"}),{hasSecret:true});
  assert.deepEqual(calls,[{profileId:"scheme",sourceModelId:"source",targetModelId:"copy"}]);
});
