import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildConfigCatalog } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-catalog.mjs";
import { loadModuleComponents } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-module-registry.mjs";
import { normalizeWorkflowDefinition } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";
import { switchWorkflowNode } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/team-presets.js";
import { packageCardRuntime } from "../.agents/skills/st-card-to-pi-rp/scripts/package_card_runtime.mjs";
import { validateRuntimePackage } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs";
import { createConfigProfileStore } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-profiles.mjs";

const sourceModule = resolve("global-modules/narrative-controls");
const json = async path => JSON.parse(await readFile(path, "utf8"));
async function catalogFor(moduleDirectory) {
  const module = await loadModuleComponents(moduleDirectory);
  const workflows = await Promise.all(module.workflowFiles.map(path => json(join(moduleDirectory, path))));
  const catalog = await buildConfigCatalog({ modules: [{ ...module, moduleDirectory }], readModuleDocument: path => json(join(moduleDirectory, path)), listWorkflows: async () => workflows });
  return { module, workflows, catalog };
}

test("real narrative presets switch both existing workflows while preserving publication contracts", async () => {
  const { catalog } = await catalogFor(sourceModule);
  for (const id of ["standard-rp", "advanced-memory-rp"]) {
    const item = catalog.workflows.find(item => item.base.id === id);
    assert.ok(item, id);
    const base = item.base, original = base.nodes.find(node => node.id === "write-narrative");
    assert.equal(original.type, "agent");
    const references = original.workflowCalls.filter(call => call.target?.startsWith("creative-reference-library/"));
    assert.deepEqual(references, [{ target: "creative-reference-library/search-units", fixedArguments: { includeSemanticCandidates: false }, maxCalls: 1 }]);
    const switched = switchWorkflowNode(base, original.id, "collaboration", { workflowKey: item.key, preset: item.collaborationPresets[original.id] });
    const normalized = normalizeWorkflowDefinition(switched.workflow);
    const node = normalized.nodes.find(node => node.id === original.id);
    assert.equal(normalized.id, normalizeWorkflowDefinition(base).id);
    assert.equal(node.team.protocol, "collaboration");
    for (const field of ["outputs", "dependsOn", "context", "workflowCalls", "delivery", "narrativeSource", "metadata"]) assert.deepEqual(switched.node[field], original[field], field);
    assert.deepEqual(normalized.nodes.find(node => node.type === "turn-finalize").narrative, base.nodes.find(node => node.type === "turn-finalize").narrative);
    assert.deepEqual(switched.workflow.nodes.filter(node => node.id !== original.id), base.nodes.filter(node => node.id !== original.id));
    assert.equal(base.nodes.find(node => node.id === original.id).type, "agent");
  }
});

test("a fresh card package includes collaboration runtime, controls and expanded role prompts", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-team-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), target = join(root, "cards", "team-fixture");
  await mkdir(join(source, "features"), { recursive: true });
  const modules = ["narrative-controls", "card-context-library", "narrative-memory", "world-narrative-coordinator", "local-scene-narrative", "world-scope-narrative", "comfy-image-generation", "creative-reference-library"];
  for (const id of modules) await cp(id === "card-context-library" ? resolve(".agents/skills/st-card-to-pi-rp/assets/card-context-library") : resolve("global-modules", id), join(source, "features", id), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema_version: 2, id: "team-fixture", name: "Team fixture", feature_modules: modules.map(id => `features/${id}/module.json`) }));
  await packageCardRuntime({ sourceCard: source, targetCard: target });
  const validation = await validateRuntimePackage(target);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  const shared = (await readFile(join(sourceModule, "prompts/shared/team-collaboration.md"), "utf8")).trimEnd();
  for (const id of ["narrative-team-writer", "narrative-co-creator"]) {
    const agent = await json(join(target, `features/narrative-controls/agents/${id}/agent.json`));
    const prompt = await readFile(join(target, "features/narrative-controls", agent.promptFile), "utf8");
    assert.ok(prompt.includes(shared));
    assert.doesNotMatch(prompt, /\{\{include:/);
    assert.match(prompt, /你是专心写作的写手Haruki/);
  }
  const { catalog } = await catalogFor(join(target, "features/narrative-controls"));
  assert.equal(catalog.workflows.filter(item => item.collaborationPresets?.["write-narrative"]).length, 2);
  const lock = await json(join(target, "runtime-lock.json"));
  for (const path of ["runtime/engine/lib/rp-team-collaboration-runtime.mjs", "runtime/engine/lib/rp-team-collaboration-executor.ts", "runtime/engine/lib/rp-team-collaboration-tools.mjs", "web/public/team-presets.js", "features/narrative-controls/workflow-presets/standard-rp-collaboration.json", "features/narrative-controls/workflow-presets/advanced-memory-rp-collaboration.json"]) assert.ok(lock.files[path], `${path} included and hashed`);
});

test("configuration mode backups survive save, restart, export, import and a switch back", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-team-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { catalog } = await catalogFor(sourceModule);
  const item = catalog.workflows.find(item => item.base.id === "standard-rp");
  const original = structuredClone(item.base);
  const writer = original.nodes.find(node => node.id === "write-narrative");
  writer.modelId = "writer-model";
  writer.promptFile = null;
  writer.prompt = "original custom prompt";
  const switched = switchWorkflowNode(original, writer.id, "collaboration", { workflowKey: item.key, preset: item.collaborationPresets[writer.id] });
  switched.node.team.members[1].modelId = "co-model";
  const options = { rootDirectory: root, directory: join(root, "profiles"), scope: "global", ownerId: "test", secretCacheDirectory: join(root, "cache") };
  const store = createConfigProfileStore(options);
  await store.create({ id: "team", name: "Team", seed: { schemaVersion: 1, kind: "pi-rp-config-profile", scope: "global", id: "team", name: "Team", models: [], workflowOverrides: { [item.key]: switched.workflow }, nodeModeBackups: switched.nodeModeBackups } });
  const restarted = createConfigProfileStore(options);
  const exported = await restarted.exportProfile("team");
  await restarted.importProfile(exported, { id: "imported", name: "Imported" });
  const imported = await restarted.get("imported");
  assert.equal(imported.workflowOverrides[item.key].nodes.find(node => node.id === writer.id).team.members[1].modelId, "co-model");
  const restored = switchWorkflowNode(imported.workflowOverrides[item.key], writer.id, "agent", { workflowKey: item.key, baseNode: writer, nodeModeBackups: imported.nodeModeBackups });
  assert.equal(restored.node.prompt, "original custom prompt");
  assert.equal(restored.node.modelId, "writer-model");
  assert.equal(restored.node.promptFile, null);
  assert.deepEqual(restored.workflow.nodes.filter(node => node.id !== writer.id), original.nodes.filter(node => node.id !== writer.id));
});
