import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { applyFrontendSettingsValues, frontendBinding, frontendRegion, normalizeModuleFrontendView, validateFrontendWorkflowPayload } from "./rp-module-frontend.mjs";

const contract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "demo",
  collections: {
    settings: { storage: { kind: "snapshot", partition: { mode: "single" } }, recordTypes: {
      "demo.settings": { dataSchemaVersion: 1, indexes: {}, searchableFields: [], views: { frontend: { format: "object", fields: [{ path: "/data/enabled" }] } }, actions: ["update"] },
    } },
    entries: { storage: { kind: "hybrid", partition: { mode: "single" } }, recordTypes: {
      "demo.entry": { dataSchemaVersion: 1, indexes: { kind: { path: "/data/kind", type: "enum", values: ["a", "b"], operators: ["eq"] } }, searchableFields: ["/data/name"], views: { frontend: { format: "object", fields: [{ path: "/data/name" }] } }, actions: ["create"] },
    } },
  },
  capabilities: {
    "demo.frontend.read": { collections: ["settings", "entries"], actions: ["query"], views: ["frontend"] },
    "demo.settings.update": { collections: ["settings"], actions: ["update"], views: [] },
  },
});

test("normalizes only statically authorized interactive frontend regions", () => {
  const view = normalizeModuleFrontendView({
    schemaVersion: 3,
    bindings: [
      { id: "records", kind: "records", collectionId: "entries", recordTypes: ["demo.entry"], view: "frontend", readCapability: "demo.frontend.read", filters: [{ id: "kind", label: "Kind", index: "kind", operator: "eq", control: "select", options: ["a", "b"] }] },
      { id: "settings", kind: "settings", collectionId: "settings", recordType: "demo.settings", recordId: "demo-settings", view: "frontend", readCapability: "demo.frontend.read", updateCapability: "demo.settings.update", fields: [{ path: "/enabled", label: "Enabled", type: "boolean" }] },
      { id: "work", kind: "workflows", workflows: [{ id: "demo-maintain", title: "Maintain", parameters: [{ name: "start", label: "Start", type: "integer", required: true, minimum: 1 }, { name: "end", label: "End", type: "integer", required: true, minimum: 1 }, { name: "mode", label: "Mode", type: "select", required: true, options: ["repair"], default: "repair" }] }] },
      { id: "integrity", kind: "integrity", coverage: { collectionId: "settings", view: "frontend", readCapability: "demo.frontend.read", stateRecordType: "demo.settings", stateRecordId: "state", lastArchivedTurnPath: "/last", settingsRecordType: "demo.settings", settingsRecordId: "settings", enabledPath: "/enabled", protectRecentTurnsPath: "/protect", archiveEveryTurnsPath: "/every", coverageRecordType: "demo.settings", startTurnPath: "/start", endTurnPath: "/end" }, action: { workflowBindingId: "work", workflowId: "demo-maintain", startTurnParameter: "start", endTurnParameter: "end", operationParameter: "mode", operationValue: "repair" } },
    ],
    regions: [
      { id: "records", type: "record-browser", title: "Records", bindingId: "records" },
      { id: "settings", type: "settings-form", title: "Settings", bindingId: "settings" },
      { id: "work", type: "workflow-controls", title: "Work", bindingId: "work" },
      { id: "integrity", type: "integrity-alerts", title: "Integrity", bindingId: "integrity" },
    ],
  }, contract);
  const module = { id: "demo", view };
  const records = frontendBinding(module, "records", "record-browser");
  const settings = frontendBinding(module, "settings", "settings-form");
  const work = frontendBinding(module, "work", "workflow-controls");
  const integrity = frontendBinding(module, "integrity", "integrity-alerts");
  assert.equal(view.bindings[0].type, undefined);
  assert.equal(view.bindings[0].title, undefined);
  assert.equal(frontendRegion(module, "records").type, "record-browser");
  assert.equal(records.pageSize, 20);
  assert.deepEqual(applyFrontendSettingsValues(settings, { enabled: false, untouched: 1 }, { "/enabled": true }), { enabled: true, untouched: 1 });
  assert.deepEqual(validateFrontendWorkflowPayload(work, "demo-maintain", { start: 2, end: 3 }), { start: 2, end: 3, mode: "repair" });
  assert.equal(integrity.action.workflowId, "demo-maintain");
  assert.throws(() => applyFrontendSettingsValues(settings, { enabled: false }, { "/hidden": true }), /undeclared fields/);
  assert.throws(() => validateFrontendWorkflowPayload(work, "other", {}), /not declared/);
  assert.throws(() => normalizeModuleFrontendView({
    schemaVersion: 3,
    bindings: [{ id: "bad", kind: "records", collectionId: "entries", recordTypes: ["demo.entry"], view: "frontend", readCapability: "demo.settings.update" }],
    regions: [{ id: "bad", type: "record-browser", title: "Bad", bindingId: "bad" }],
  }, contract), /does not grant/);
  assert.throws(() => normalizeModuleFrontendView({ schemaVersion: 3, bindings: [{ id: "unknown", kind: "custom-script" }], regions: [] }, contract), /unsupported kind/);
  const extension = { schemaVersion: 3, bindings: [{ id: "gallery", kind: "images" }], regions: [{ id: "custom-gallery", bindingId: "gallery", type: "creator-gallery", title: "Custom", optional: true }] };
  assert.equal(normalizeModuleFrontendView(extension, contract).regions[0].optional, true);
  assert.throws(() => normalizeModuleFrontendView({ ...extension, regions: [{ ...extension.regions[0], optional: false }] }, contract), /Unsupported required renderer/);
});
