import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createConfigProfileStore, normalizeConfigProfile } from "./rp-config-profiles.mjs";

async function store(scope = "global", ownerId = "global") {
  const root = await mkdtemp(resolve(tmpdir(), "rp-config-profiles-"));
  return createConfigProfileStore({
    rootDirectory: root,
    directory: resolve(root, "profiles"),
    scope,
    ownerId,
    secretCacheDirectory: resolve(root, "cache"),
  });
}

function profile(id = "main", scope = "global") {
  return {
    schemaVersion: 1,
    kind: "pi-rp-config-profile",
    scope,
    id,
    name: "Main",
    models: [{ id: "fast", provider: "custom", model: "x", baseUrl: "https://example.test/v1" }],
    agentOverrides: { "runtime/agent/writer": { prompt: "custom" } },
    workflowOverrides: {},
    moduleOverrides: {},
  };
}

test("creates, renames, duplicates, activates and deletes profiles", async () => {
  const target = await store();
  await target.ensure();
  await target.create({ id: "main", name: "Main", seed: profile() });
  await target.rename("main", "Renamed");
  await target.duplicate("main", { newId: "copy", name: "Copy" });
  await target.activate("copy");
  assert.equal((await target.list()).activeProfileId, "copy");
  assert.equal((await target.get("main")).name, "Renamed");
  await target.remove("copy");
  assert.equal((await target.list()).activeProfileId, "builtin");
});

test("keeps model credentials in the project-isolated cache and out of exports", async () => {
  const target = await store("card", "demo");
  await target.create({ id: "main", name: "Main", seed: profile("main", "card") });
  await target.saveModelSecret("main", "fast", "top-secret");
  assert.equal((await target.get("main")).models[0].hasSecret, true);
  assert.equal(await target.getModelSecret("main", "fast"), "top-secret");
  assert.doesNotMatch(JSON.stringify(await target.exportProfile("main")), /top-secret|apiKey/);
  assert.match(await readFile(target.paths.secretsPath, "utf8"), /top-secret/);
  await target.saveModelSecret("main", "fast", "");
  assert.equal((await target.get("main")).models[0].hasSecret, false);
  assert.equal(await target.getModelSecret("main", "fast"), "");
});

test("rejects wrong scopes and imported credentials", async () => {
  assert.throws(() => normalizeConfigProfile({ ...profile(), models: [{ id: "x", apiKey: "secret" }] }), /cannot contain credentials/);
  const target = await store("card", "demo");
  await assert.rejects(() => target.importProfile(profile("main", "global")), /scope must be card/);
});

test("copying a profile does not copy its credentials", async () => {
  const target = await store();
  await target.create({ id: "main", name: "Main", seed: profile() });
  await target.saveModelSecret("main", "fast", "secret");
  await target.duplicate("main", { newId: "copy", name: "Copy" });
  assert.equal((await target.get("copy")).models[0].hasSecret, false);
});

test("normalizes the legacy model thinkingLevel field", () => {
  const normalized = normalizeConfigProfile({
    ...profile(),
    models: [{ schemaVersion: 1, id: "fast", provider: "custom", model: "x", thinkingLevel: "high" }],
  });
  assert.equal(normalized.models[0].thinking, "high");
  assert.equal("thinkingLevel" in normalized.models[0], false);
});
