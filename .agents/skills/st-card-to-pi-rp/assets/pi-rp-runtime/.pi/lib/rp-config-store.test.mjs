import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createRpConfigStore, resolveActiveForegroundWorkflow } from "./rp-config-store.mjs";
import { createConfigProfileStore } from "./rp-config-profiles.mjs";

function cardDirectory(root) {
  return resolve(root, "cards", "demo");
}

function testStore(root, options = {}) {
  return createRpConfigStore(root, cardDirectory(root), {
    secretCacheDirectory: resolve(root, "system-cache"),
    ...options,
  });
}

function agentDefinition(ownerModuleId, id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    ownerModuleId,
    name: id,
    description: "Test Agent",
    prompt: `authored ${id}`,
    tools: [],
    contextPermissions: [],
    outputMode: "text",
    defaultModelId: "pi:current",
    ...overrides,
  };
}

function foregroundWorkflow(ownerModuleId, id, title = "Global") {
  return {
    schemaVersion: 4,
    id,
    ownerModuleId,
    kind: "foreground",
    title,
    nodes: [
      { id: "story", type: "agent", outputs: { narrative: { path: "narrative.md", format: "narrative" } } },
      { id: "done", type: "turn-finalize", dependsOn: ["story"], narrative: { fromNode: "story", output: "narrative" } },
    ],
  };
}

function moduleWorkflow(ownerModuleId, id, title = "Module workflow", modelId = "authored-model") {
  return {
    schemaVersion: 4,
    id,
    ownerModuleId,
    kind: "module-external",
    title,
    interface: { inputs: {}, exports: {} },
    nodes: [
      { id: "review", type: "agent", modelId },
      { id: "return", type: "workflow-return", dependsOn: ["review"], exports: {} },
    ],
  };
}

async function writeCard(root, moduleSpecs = []) {
  const card = cardDirectory(root);
  await mkdir(card, { recursive: true });
  const modules = {};
  for (const spec of moduleSpecs) {
    const moduleDirectory = resolve(card, "features", spec.id);
    const agents = spec.agents || [];
    const workflows = spec.workflows || [moduleWorkflow(spec.id, "default")];
    await mkdir(resolve(moduleDirectory, "skill"), { recursive: true });
    await mkdir(resolve(moduleDirectory, "agents"), { recursive: true });
    await mkdir(resolve(moduleDirectory, "workflows"), { recursive: true });
    await writeFile(resolve(moduleDirectory, "catalog.json"), "{}\n", "utf8");
    await writeFile(resolve(moduleDirectory, "skill", "SKILL.md"), "Test module.\n", "utf8");
    const manifest = {
      schemaVersion: 7,
      id: spec.id,
      moduleKind: "resource",
      basedOn: null,
      title: spec.title || spec.id,
      description: "Test feature module.",
      surface: "background",
      contextOrder: 0,
      displayOrder: 0,
      dataContractFile: null,
      resourceCatalogFile: "catalog.json",
      frontendViewFile: null,
      skillFile: "skill/SKILL.md",
      workflowFiles: workflows.map(workflow => `workflows/${workflow.id}/workflow.json`),
      agentFiles: agents.map(agent => `agents/${agent.id}/agent.json`),
    };
    await writeFile(resolve(moduleDirectory, "module.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const agentFiles = {};
    for (const agent of agents) {
      const path = resolve(moduleDirectory, "agents", agent.id, "agent.json");
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
      agentFiles[agent.id] = path;
    }
    const workflowFiles = {};
    for (const workflow of workflows) {
      const path = resolve(moduleDirectory, "workflows", workflow.id, "workflow.json");
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
      workflowFiles[workflow.id] = path;
    }
    modules[spec.id] = { directory: moduleDirectory, agentFiles, workflowFiles };
  }
  await writeFile(resolve(card, "manifest.json"), JSON.stringify({ feature_modules: moduleSpecs.map(spec => `features/${spec.id}/module.json`) }), "utf8");
  return { card, modules };
}

async function activeProfileStore(root, overrides = {}) {
  const profileStore = createConfigProfileStore({
    rootDirectory: root,
    directory: resolve(cardDirectory(root), "config-profiles"),
    scope: "card",
    ownerId: "demo",
    secretCacheDirectory: resolve(root, "system-cache"),
  });
  await profileStore.create({
    id: "custom",
    name: "Custom",
    seed: {
      schemaVersion: 1,
      kind: "pi-rp-config-profile",
      scope: "card",
      id: "custom",
      name: "Custom",
      models: [],
      agentOverrides: {},
      workflowOverrides: {},
      moduleOverrides: {},
      ...overrides,
    },
  });
  await profileStore.activate("custom");
  return profileStore;
}

test("resolves a default only from card-local foreground workflows", () => {
  const workflows = [
    { id: "shared/standard-rp", kind: "foreground", source: "global" },
    { id: "shared/advanced-memory-rp", kind: "foreground", source: "global" },
    { id: "card-story/card-story", kind: "foreground", source: "module" },
    { id: "card-story/card-background", kind: "turn-background", source: "module" },
  ];
  assert.equal(resolveActiveForegroundWorkflow(workflows), "card-story/card-story");
  assert.equal(resolveActiveForegroundWorkflow(workflows, "card-story/card-story"), "card-story/card-story");
  assert.throws(() => resolveActiveForegroundWorkflow(workflows, "shared/standard-rp"), /card-local foreground/);
  assert.throws(() => resolveActiveForegroundWorkflow(workflows, "card-story/card-background"), /card-local foreground/);
  assert.throws(() => resolveActiveForegroundWorkflow(workflows.filter(item => item.source === "global")), /no foreground workflow/);
  assert.throws(() => resolveActiveForegroundWorkflow([...workflows, { id: "card-story/second", kind: "foreground", source: "module" }]), /multiple foreground workflows/);
});

test("isolated card configuration never falls back to shared Agent or workflow files", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-isolated-config-"));
  const card = (await writeCard(root)).card;
  await mkdir(resolve(root, "agents", "writer"), { recursive: true });
  await mkdir(resolve(root, "workflows", "shared"), { recursive: true });
  await mkdir(resolve(card, "defaults"), { recursive: true });
  await writeFile(resolve(root, "agents", "writer", "agent.json"), JSON.stringify({ schemaVersion: 1, id: "writer", name: "Shared", prompt: "wrong" }));
  await writeFile(resolve(root, "workflows", "shared", "workflow.json"), JSON.stringify({ id: "shared" }));
  for (const [name, content] of [["model-profiles.json", { schemaVersion: 1, profiles: [] }], ["workflow-runtime.json", { schemaVersion: 1, maxConcurrency: 3 }]]) {
    await writeFile(resolve(card, "defaults", name), JSON.stringify(content));
  }
  const store = testStore(root, { isolatedRuntime: true });
  await store.ensure();
  assert.deepEqual(await store.listAgents(), []);
  assert.deepEqual(await store.listWorkflows(), []);
  await assert.rejects(store.getAgent("writer"), /module-id\/component-id/);
  await assert.rejects(store.getAgent("shared\/writer"), /not registered in this card/);
  await assert.rejects(store.getWorkflow("shared"), /Component reference|not registered in this card/);
  await assert.rejects(store.saveRuntimePolicy({ schemaVersion: 1, maxConcurrency: 4 }), /editable card configuration profile/);
});

test("applies a scoped Agent profile override without changing the module source", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const setup = await writeCard(root, [{ id: "scene", agents: [agentDefinition("scene", "writer", { prompt: "base" })], workflows: [moduleWorkflow("scene", "scene-work")] }]);
  const profileStore = await activeProfileStore(root);
  const store = testStore(root, { profileStore });
  await store.ensure();
  const reference = "scene/writer";
  await store.saveAgent({ ...agentDefinition("scene", reference, { prompt: "card", defaultModelId: "fast" }) });
  const layered = await store.getAgent(reference);
  assert.equal(layered.source, "module");
  assert.equal(layered.effective.prompt, "card");
  assert.equal(layered.base.prompt, "base");
  const profile = await profileStore.get("custom");
  assert.deepEqual(Object.keys(profile.agentOverrides), ["module/scene/agent/writer"]);
  assert.equal(JSON.parse(await readFile(setup.modules.scene.agentFiles.writer, "utf8")).prompt, "base");
  await store.saveAgent({ ...agentDefinition("scene", reference, { prompt: "card-next", defaultModelId: "fast" }) });
  await store.restoreAgent(reference);
  assert.equal((await store.getAgent(reference)).effective.prompt, "base");
  assert.deepEqual((await profileStore.get("custom")).agentOverrides, {});
});

test("loads a complete module-owned companion agent", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  await writeCard(root, [{ id: "image-module", agents: [agentDefinition("image-module", "image-prompt-writer", { name: "Image", prompt: "scene only", outputMode: "json", contextPermissions: ["workflow:scoped-output"] })], workflows: [moduleWorkflow("image-module", "generate")] }]);
  const store = testStore(root);
  await store.ensure();
  const agent = await store.getAgent("image-module/image-prompt-writer");
  assert.equal(agent.source, "module");
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

test("saves an existing module workflow file without creating a top-level copy", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const setup = await writeCard(root, [{ id: "narrative-controls", workflows: [foregroundWorkflow("narrative-controls", "standard", "Global")] }]);
  const store = testStore(root);
  await store.ensure();
  const reference = "narrative-controls/standard";
  assert.equal((await store.getWorkflow(reference)).title, "Global");
  await store.saveCardWorkflow({ ...(await store.getWorkflow(reference)), title: "Card" });
  assert.equal((await store.getWorkflow(reference)).title, "Card");
  assert.equal(JSON.parse(await readFile(setup.modules["narrative-controls"].workflowFiles.standard, "utf8")).title, "Card");
  await assert.rejects(readFile(resolve(setup.card, "workflows", "standard", "workflow.json"), "utf8"), /ENOENT/);
});

test("resolves a module workflow through its owner and distinguishes colliding local IDs", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  await writeCard(root, [
    { id: "world-narrative-coordinator", workflows: [moduleWorkflow("world-narrative-coordinator", "post-director-update", "Post director")] },
    { id: "narrative-memory", workflows: [moduleWorkflow("narrative-memory", "post-director-update", "Same id, other owner", "other-owner-model")] },
  ]);
  const store = testStore(root);
  await store.ensure();
  const workflow = await store.getModuleWorkflow("world-narrative-coordinator", "post-director-update");
  assert.equal(workflow.id, "world-narrative-coordinator/post-director-update");
  assert.equal(workflow.ownerModuleId, "world-narrative-coordinator");
  const other = await store.getModuleWorkflow("narrative-memory", "post-director-update");
  assert.equal(other.id, "narrative-memory/post-director-update");
  assert.equal(other.title, "Same id, other owner");
  assert.equal((await store.getModuleWorkflow(null, "world-narrative-coordinator/post-director-update")).id, workflow.id);
  await assert.rejects(() => store.getModuleWorkflow(null, "post-director-update"), /module-id\/component-id/);
  await assert.rejects(() => store.getModuleWorkflow("world-narrative-coordinator", "missing"), /not registered in this card/);
  assert.deepEqual((await store.listWorkflows()).map(item => item.id).sort(), ["narrative-memory/post-director-update", "world-narrative-coordinator/post-director-update"]);
});

test("saves a module workflow override under its owner-scoped profile key and leaves source unchanged", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const setup = await writeCard(root, [
    { id: "world-narrative-coordinator", workflows: [moduleWorkflow("world-narrative-coordinator", "post-director-update", "Post director")] },
    { id: "narrative-memory", workflows: [moduleWorkflow("narrative-memory", "post-director-update", "Same id, other owner", "other-owner-model")] },
  ]);
  const source = setup.modules["world-narrative-coordinator"].workflowFiles["post-director-update"];
  const profileStore = await activeProfileStore(root);
  const store = testStore(root, { profileStore });
  await store.ensure();
  const editable = await store.copyWorkflowToCard("post-director-update", "world-narrative-coordinator");
  editable.nodes.find(node => node.id === "review").modelId = "chosen-model";
  await store.saveCardWorkflow(editable);
  const profile = await profileStore.get("custom");
  assert.deepEqual(Object.keys(profile.workflowOverrides), ["module/world-narrative-coordinator/workflow/post-director-update"]);
  assert.equal(JSON.parse(await readFile(source, "utf8")).nodes.find(node => node.id === "review").modelId, "authored-model");
  const reloaded = await store.getModuleWorkflow("world-narrative-coordinator", "post-director-update");
  assert.equal(reloaded.nodes.find(node => node.id === "review").modelId, "chosen-model");
  const untouched = await store.getModuleWorkflow("narrative-memory", "post-director-update");
  assert.equal(untouched.nodes.find(node => node.id === "review").modelId, "other-owner-model");
  await assert.rejects(() => store.getWorkflow("post-director-update"), /module-id\/component-id/);
  await assert.rejects(readFile(resolve(setup.card, "workflows", "post-director-update", "workflow.json"), "utf8"), /ENOENT/);
});

test("a named override cannot rename a registered component or transfer it to another owner", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-identity-"));
  await writeCard(root, [{ id: "scene", agents: [agentDefinition("scene", "writer")] }]);
  const profileStore = await activeProfileStore(root, { agentOverrides: { "module/scene/agent/writer": { id: "other/writer", ownerModuleId: "other" } } });
  const store = testStore(root, { profileStore });
  await assert.rejects(store.getAgent("scene/writer"), /identity or ownership/);
});

test("rejects saving an unregistered module workflow and requires full top-level references", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const setup = await writeCard(root, [{ id: "memory", workflows: [moduleWorkflow("memory", "registered")] }]);
  const store = testStore(root);
  await store.ensure();
  await assert.rejects(() => store.saveCardWorkflow(moduleWorkflow("memory", "lookup")), /not registered in this card/);
  assert.equal((await store.getWorkflow("memory/registered")).id, "memory/registered");
  await assert.rejects(() => store.getWorkflow("registered"), /module-id\/component-id/);
  await assert.rejects(readFile(resolve(setup.card, "workflows", "lookup", "workflow.json"), "utf8"), /ENOENT/);
});

test("applies an active named profile without rewriting authored module Agent files", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const setup = await writeCard(root, [{ id: "runtime", agents: [agentDefinition("runtime", "writer", { prompt: "authored" })], workflows: [moduleWorkflow("runtime", "run")] }]);
  const profileStore = await activeProfileStore(root, {
    models: [{ schemaVersion: 1, id: "profile-model", name: "Profile", provider: "custom", model: "x", baseUrl: "https://example.test/v1" }],
    agentOverrides: { "module/runtime/agent/writer": { prompt: "profile prompt" } },
  });
  const store = testStore(root, { profileStore });
  await store.ensure();
  assert.equal((await store.getAgent("runtime/writer")).effective.prompt, "profile prompt");
  assert.deepEqual((await store.listModels()).map(model => model.id), ["profile-model"]);
  assert.equal(JSON.parse(await readFile(setup.modules.runtime.agentFiles.writer, "utf8")).prompt, "authored");
  await assert.rejects(readFile(resolve(setup.card, "agents", "writer", "agent.json"), "utf8"), /ENOENT/);
});

test("stores workflow runtime policy inside the active configuration profile", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const profileStore = await activeProfileStore(root, {
    workflowOverrides: { runtimePolicy: { schemaVersion: 1, maxConcurrency: 4, modelFailure: { silentFallback: false, defaultFallbackModelId: null } } },
  });
  const store = testStore(root, { profileStore });
  await store.ensure();
  assert.equal((await store.getRuntimePolicy()).maxConcurrency, 4);
  await store.saveRuntimePolicy({ schemaVersion: 1, maxConcurrency: 7, modelFailure: { silentFallback: true, defaultFallbackModelId: "fallback" } });
  const saved = await profileStore.get("custom");
  assert.equal(saved.workflowOverrides.runtimePolicy.maxConcurrency, 7);
  assert.equal(saved.workflowOverrides.runtimePolicy.modelFailure.defaultFallbackModelId, "fallback");
});

test("keeps incomplete profile model drafts out of runtime model listings", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const profileStore = await activeProfileStore(root, {
    models: [
      { schemaVersion: 1, id: "unfinished", name: "Unfinished", provider: "custom", model: "" },
      { schemaVersion: 1, id: "ready", name: "Ready", provider: "custom", model: "ready-model" },
    ],
  });
  const store = testStore(root, { profileStore });
  await store.ensure();
  assert.deepEqual((await store.listModels()).map(model => model.id), ["ready"]);
  assert.equal((await profileStore.get("custom")).models.length, 2);
});
