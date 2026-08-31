import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createRpConfigStore } from "./rp-config-store.mjs";

test("layers card agent overrides without changing the global profile", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"));
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

test("keeps API keys on disk but redacts them from list responses", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"));
  await store.ensure();
  await store.saveModel({ schemaVersion: 1, id: "fast", provider: "custom", model: "x", apiKey: "secret", baseUrl: "https://example.test/v1" });
  assert.equal((await store.listModels())[0].hasApiKey, true);
  assert.equal((await store.listModels())[0].apiKey, undefined);
  assert.match(await readFile(store.paths.models, "utf8"), /secret/);
});

test("prefers a card workflow copy over the global template", async () => {
  const root = await mkdtemp(resolve(os.tmpdir(), "rp-config-"));
  const store = createRpConfigStore(root, resolve(root, "cards", "demo"));
  await store.ensure();
  const workflow = {
    schemaVersion: 1,
    id: "standard",
    kind: "foreground",
    title: "Global",
    nodes: [{ id: "story", type: "narrative" }, { id: "done", type: "turn-finalize", dependsOn: ["story"] }],
  };
  await store.saveCardWorkflow({ ...workflow, title: "Card" });
  assert.equal((await store.getWorkflow("standard")).title, "Card");
});
