import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createRpConfigStore, resolveActiveForegroundWorkflow } from "./rp-config-store.mjs";
import { createConfigProfileStore } from "./rp-config-profiles.mjs";

function testStore(root) {
  return createRpConfigStore(root, resolve(root, "cards", "demo"), { secretCacheDirectory: resolve(root, "system-cache") });
}

test("resolves a default only from card-local foreground workflows", () => {
  const workflows = [
    { id: "standard-rp", kind: "foreground", source: "global" },
    { id: "advanced-memory-rp", kind: "foreground", source: "global" },
    { id: "card-story", kind: "foreground", source: "card" },
    { id: "card-background", kind: "turn-background", source: "card" },
  ];
  assert.equal(resolveActiveForegroundWorkflow(workflows), "card-story");
  assert.equal(resolveActiveForegroundWorkflow(workflows, "card-story"), "card-story");
  assert.throws(() => resolveActiveForegroundWorkflow(workflows, "standard-rp"), /card-local foreground/);
  assert.throws(() => resolveActiveForegroundWorkflow(workflows, "card-background"), /card-local foreground/);
  assert.throws(() => resolveActiveForegroundWorkflow(workflows.filter(item => item.source === "global")), /no foreground workflow/);
  assert.throws(() => resolveActiveForegroundWorkflow([...workflows, { id: "second-card-story", kind: "foreground", source: "card" }]), /multiple foreground workflows/);
});

test("layers card agent overrides without changing the global profile", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = testStore(root);
  await store.ensure();
  await store.saveAgent({ schemaVersion: 1, id: "writer", name: "Writer", prompt: "base", defaultModelId: "pi:current" }, { scope: "global" });
  await store.saveAgent({ schemaVersion: 1, id: "writer", name: "Writer", prompt: "card", defaultModelId: "fast" });
  const layered = await store.getAgent("writer");
  assert.equal(layered.effective.prompt, "card");
  assert.equal(layered.base.prompt, "base");
  await store.saveAgent({ schemaVersion: 1, id: "writer", name: "Writer", prompt: "global-next", defaultModelId: "pi:current" }, { scope: "global" });
  assert.equal((await store.getAgent("writer")).overridden, false);
  assert.equal((await store.getAgent("writer")).effective.prompt, "global-next");
  await store.saveAgent({ schemaVersion: 1, id: "writer", name: "Writer", prompt: "card-next", defaultModelId: "fast" });
  await store.restoreAgent("writer");
  assert.equal((await store.getAgent("writer")).effective.prompt, "global-next");
});

test("loads a complete card-owned companion agent", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = testStore(root);
  await store.ensure();
  const path = resolve(root, "cards", "demo", "agents", "image-prompt-writer", "agent.json");
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, id: "image-prompt-writer", name: "Image", prompt: "scene only", tools: [], contextPermissions: ["workflow:scoped-output"], outputMode: "json", defaultModelId: "pi:current" }));
  const agent = await store.getAgent("image-prompt-writer");
  assert.equal(agent.source, "card");
  assert.equal(agent.effective.outputMode, "json");
});

test("keeps API keys outside the project and redacts them from list responses", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = testStore(root);
  await store.ensure();
  await store.saveModel({ schemaVersion: 1, id: "fast", provider: "custom", model: "x", apiKey: "secret", baseUrl: "https://example.test/v1" });
  assert.equal((await store.listModels())[0].hasApiKey, true);
  assert.equal((await store.listModels())[0].apiKey, undefined);
  assert.equal((await store.listModels({ includeSecrets: true }))[0].apiKey, "secret");
  assert.doesNotMatch(await readFile(store.paths.models, "utf8"), /secret|apiKey/);
  assert.match(await readFile(store.paths.modelSecrets, "utf8"), /secret/);
});

test("migrates a legacy project API key into the system cache", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  await mkdir(resolve(root, "settings"), { recursive: true });
  await writeFile(resolve(root, "settings", "model-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    profiles: [{ schemaVersion: 1, id: "legacy", provider: "custom", model: "x", apiKey: "legacy-secret" }],
  }), "utf8");
  const store = testStore(root);
  await store.ensure();
  assert.doesNotMatch(await readFile(store.paths.models, "utf8"), /legacy-secret|apiKey/);
  assert.match(await readFile(store.paths.modelSecrets, "utf8"), /legacy-secret/);
  assert.equal((await store.listModels({ includeSecrets: true }))[0].apiKey, "legacy-secret");
});

test("prefers a card workflow copy over the global template", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = testStore(root);
  await store.ensure();
  const workflow = {
    schemaVersion: 3,
    id: "standard",
    kind: "foreground",
    title: "Global",
    nodes: [
      { id: "story", type: "agent", outputs: { narrative: { path: "narrative.md", format: "narrative" } } },
      { id: "done", type: "turn-finalize", dependsOn: ["story"], narrative: { fromNode: "story", output: "narrative" } },
    ],
  };
  await store.saveCardWorkflow({ ...workflow, title: "Card" });
  assert.equal((await store.getWorkflow("standard")).title, "Card");
});

test("keeps module workflows out of the top-level workflow store", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = testStore(root);
  await store.ensure();
  await assert.rejects(() => store.saveCardWorkflow({
    schemaVersion: 3,
    id: "lookup",
    ownerModuleId: "memory",
    kind: "module-external",
    interface: { inputs: {}, exports: {} },
    nodes: [{ id: "return", type: "workflow-return", exports: {} }],
  }), /cannot be saved as top-level/);
});

test("applies an active named profile without rewriting authored Agent and model files", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const profileStore = createConfigProfileStore({ rootDirectory: root, directory: resolve(root, "cards", "demo", "config-profiles"), scope: "card", ownerId: "demo", secretCacheDirectory: resolve(root, "system-cache") });
  await profileStore.create({ id: "custom", name: "Custom", seed: {
    schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "custom", name: "Custom",
    models: [{ schemaVersion: 1, id: "profile-model", name: "Profile", provider: "custom", model: "x", baseUrl: "https://example.test/v1" }],
    agentOverrides: { "runtime/agent/writer": { prompt: "profile prompt" } }, workflowOverrides: {}, moduleOverrides: {},
  } });
  await profileStore.activate("custom");
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"), { secretCacheDirectory: resolve(root, "system-cache"), profileStore });
  await store.ensure();
  await store.saveAgent({ schemaVersion: 1, id: "writer", name: "Writer", prompt: "authored", defaultModelId: "pi:current" }, { scope: "global" });
  assert.equal((await store.getAgent("writer")).effective.prompt, "profile prompt");
  assert.deepEqual((await store.listModels()).map(model => model.id), ["profile-model"]);
  assert.equal(JSON.parse(await readFile(resolve(root, "agents", "writer", "agent.json"), "utf8")).prompt, "authored");
});

test("stores workflow runtime policy inside the active configuration profile", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const profileStore = createConfigProfileStore({ rootDirectory: root, directory: resolve(root, "cards", "demo", "config-profiles"), scope: "card", ownerId: "demo", secretCacheDirectory: resolve(root, "system-cache") });
  await profileStore.create({ id: "custom", name: "Custom", seed: {
    schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "custom", name: "Custom",
    models: [], agentOverrides: {}, workflowOverrides: {
      runtimePolicy: { schemaVersion: 1, maxConcurrency: 4, modelFailure: { silentFallback: false, defaultFallbackModelId: null } },
    }, moduleOverrides: {},
  } });
  await profileStore.activate("custom");
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"), { secretCacheDirectory: resolve(root, "system-cache"), profileStore });
  await store.ensure();
  assert.equal((await store.getRuntimePolicy()).maxConcurrency, 4);
  await store.saveRuntimePolicy({ schemaVersion: 1, maxConcurrency: 7, modelFailure: { silentFallback: true, defaultFallbackModelId: "fallback" } });
  const saved = await profileStore.get("custom");
  assert.equal(saved.workflowOverrides.runtimePolicy.maxConcurrency, 7);
  assert.equal(saved.workflowOverrides.runtimePolicy.modelFailure.defaultFallbackModelId, "fallback");
});

test("keeps incomplete profile model drafts out of runtime model listings", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const profileStore = createConfigProfileStore({ rootDirectory: root, directory: resolve(root, "cards", "demo", "config-profiles"), scope: "card", ownerId: "demo", secretCacheDirectory: resolve(root, "system-cache") });
  await profileStore.create({ id: "drafts", name: "Drafts", seed: {
    schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "drafts", name: "Drafts",
    models: [
      { schemaVersion: 1, id: "unfinished", name: "Unfinished", provider: "custom", model: "" },
      { schemaVersion: 1, id: "ready", name: "Ready", provider: "custom", model: "ready-model" },
    ],
    agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
  } });
  await profileStore.activate("drafts");
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"), { secretCacheDirectory: resolve(root, "system-cache"), profileStore });
  await store.ensure();
  assert.deepEqual((await store.listModels()).map(model => model.id), ["ready"]);
  assert.equal((await profileStore.get("drafts")).models.length, 2);
});
