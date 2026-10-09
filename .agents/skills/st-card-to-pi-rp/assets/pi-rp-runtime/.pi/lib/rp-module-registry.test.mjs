import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { componentReference, loadCardComponents, loadModuleComponents, moduleFile } from "./rp-module-registry.mjs";

test("component references require a real owner and preserve already qualified identity", () => {
  assert.equal(componentReference("scene", "writer"), "scene/writer");
  assert.equal(componentReference("scene", "scene/writer"), "scene/writer");
  assert.equal(componentReference(null, "scene/writer"), "scene/writer");
  assert.throws(() => componentReference(null, "writer"), /module-id\/component-id/);
  assert.throws(() => componentReference("scene", "other/writer"), /owner module/);
});

test("card registry rejects loose components, undeclared Agents and module path escapes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rp-registry-boundary-"));
  try {
    await writeFile(resolve(root, "manifest.json"), JSON.stringify({ feature_modules: [] }));
    await mkdir(resolve(root, "agents"));
    await writeFile(resolve(root, "agents", "orphan.json"), "{}");
    await assert.rejects(loadCardComponents(root), /Unowned components/);
    await rm(resolve(root, "agents"), { recursive: true });
    await writeFile(resolve(root, "manifest.json"), JSON.stringify({ feature_modules: ["../module.json"] }));
    await assert.rejects(loadCardComponents(root), /inside its module/);
    await assert.rejects(moduleFile(root, "../outside.md"), /inside its module/);
    await mkdir(resolve(root, "directory"));
    await assert.rejects(moduleFile(root, "directory"), /regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a module frontend cannot activate its callable child instead of a background entry", async t => {
  let cursor = resolve(import.meta.dirname);
  while (cursor !== resolve(cursor, "..") && !(await readFile(resolve(cursor, "PROJECT-RELEASE-MANIFEST.json")).catch(() => null))) cursor = resolve(cursor, "..");
  const source = resolve(cursor, "global-modules", "narrative-memory");
  if (!await readFile(resolve(source, "module.json")).catch(() => null)) { t.skip("source module is not installed with this runtime"); return; }
  const root = await mkdtemp(resolve(tmpdir(), "rp-registry-controls-"));
  try {
    await cp(source, root, { recursive: true });
    await loadModuleComponents(root);
    const file = resolve(root, "frontend-view.json");
    const view = JSON.parse(await readFile(file, "utf8"));
    const region = view.regions.find(item => item.type === "workflow-controls");
    region.workflows[0].id = "narrative-memory-archive";
    await writeFile(file, JSON.stringify(view));
    await assert.rejects(loadModuleComponents(root), /owned background entry workflow/);
    region.workflows[0].id = "narrative-memory-archive-entry";
    await writeFile(file, JSON.stringify(view));
    await mkdir(resolve(root, "agents", "orphan"));
    await writeFile(resolve(root, "agents", "orphan", "agent.json"), "{}");
    await assert.rejects(loadModuleComponents(root), /Unregistered agent component/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
