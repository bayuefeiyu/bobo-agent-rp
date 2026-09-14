import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFeatureModuleManifest } from "./rp-feature-modules.mjs";

const manifest = {
  schemaVersion: 6,
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
};

test("normalizes the exact Module v6 data manifest and owned workflow list", () => {
  assert.deepEqual(normalizeFeatureModuleManifest(manifest).workflowFiles, ["workflows/retrieve/workflow.json"]);
});

test("rejects legacy fields, empty workflow ownership, and escaping paths", () => {
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, schemaVersion: 5 }), /Invalid/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, workflowFiles: [] }), /at least one/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, workflowFiles: ["../workflow.json"] }), /inside the module/);
  assert.throws(() => normalizeFeatureModuleManifest({ ...manifest, extra: true }), /exact schemaVersion 6/);
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
