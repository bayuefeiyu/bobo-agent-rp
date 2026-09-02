import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createRpConfigStore } from "./rp-config-store.mjs";

function testStore(root) {
  return createRpConfigStore(root, resolve(root, "cards", "demo"), { secretCacheDirectory: resolve(root, "system-cache") });
}

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
    schemaVersion: 2,
    id: "standard",
    kind: "foreground",
    title: "Global",
    nodes: [{ id: "story", type: "narrative" }, { id: "done", type: "turn-finalize", dependsOn: ["story"] }],
  };
  await store.saveCardWorkflow({ ...workflow, title: "Card" });
  assert.equal((await store.getWorkflow("standard")).title, "Card");
});
