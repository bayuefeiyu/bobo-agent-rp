import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFeatureModuleManifest } from "./rp-feature-modules.mjs";

const manifest = {
  schemaVersion: 7,
  id: "memory",
  moduleKind: "data",
  basedOn: null,
  title: "Memory",
  description: "Memory module",
  surface: "frontend",
  contextOrder: 10,
  displayOrder: 20,
  dataContractFile: "data-contract.json",
  resourceCatalogFile: null,
  frontendViewFile: "frontend-view.json",
  skillFile: "skill/SKILL.md",
  workflowFiles: ["workflows/retrieve/workflow.json"],
  agentFiles: ["agents/retriever/agent.json"],
};

test("normalizes the exact Module v7 data manifest and owned component lists", () => {
  assert.deepEqual(normalizeFeatureModuleManifest(manifest).workflowFiles, ["workflows/retrieve/workflow.json"]);
  assert.deepEqual(normalizeFeatureModuleManifest(manifest).agentFiles, ["agents/retriever/agent.json"]);
});

test("rejects legacy fields, empty workflow ownership, and escaping paths", () => {
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, schemaVersion: 6 }), /Invalid/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, workflowFiles: [] }), /at least one/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, workflowFiles: ["../workflow.json"] }), /inside the module/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, extra: true }), /exact schemaVersion 7/);
});

test("normalizes resource-only modules without fake data or frontend files", () => {
  const resource = normalizeFeatureModuleManifest({
    ...manifest,
    id: "card-context-library",
    moduleKind: "resource",
    surface: "background",
    dataContractFile: null,
    resourceCatalogFile: "catalog.json",
    frontendViewFile: null,
  });
  assert.equal(resource.dataContractFile, null);
  assert.equal(resource.resourceCatalogFile, "catalog.json");
});

test("v8 external binding is exact and cannot grant an unrelated module access", () => {
  const external = { ...manifest, schemaVersion: 8, id: "creative-reference-library", moduleKind: "resource", externalResource: "creative-reference-library/v1", surface: "background", dataContractFile: null, resourceCatalogFile: null, frontendViewFile: null };
  assert.equal(normalizeFeatureModuleManifest(external).externalResource, "creative-reference-library/v1");
  assert.throws(() => normalizeFeatureModuleManifest({ ...external, id: "other" }), /unsupported external/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...external, schemaVersion: 7 }), /exact/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...external, resourceCatalogFile: "catalog.json" }), /match moduleKind/);
  assert.equal(normalizeFeatureModuleManifest({ ...manifest, schemaVersion: 8, externalResource: null }).dataContractFile, "data-contract.json");
});
