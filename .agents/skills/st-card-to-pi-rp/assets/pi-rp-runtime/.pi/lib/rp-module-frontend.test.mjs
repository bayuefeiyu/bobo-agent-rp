import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { applyFrontendSettingsValues, frontendRegion, normalizeModuleFrontendView, validateFrontendWorkflowPayload } from "./rp-module-frontend.mjs";

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
  const view = normalizeModuleFrontendView({ schemaVersion: 2, regions: [
    { id: "records", type: "record-browser", title: "Records", collectionId: "entries", recordTypes: ["demo.entry"], view: "frontend", readCapability: "demo.frontend.read", filters: [{ id: "kind", label: "Kind", index: "kind", operator: "eq", control: "select", options: ["a", "b"] }] },
    { id: "settings", type: "settings-form", title: "Settings", collectionId: "settings", recordType: "demo.settings", recordId: "demo-settings", view: "frontend", readCapability: "demo.frontend.read", updateCapability: "demo.settings.update", fields: [{ path: "/enabled", label: "Enabled", type: "boolean" }] },
    { id: "work", type: "workflow-controls", title: "Work", workflows: [{ id: "demo-maintain", title: "Maintain", parameters: [{ name: "start", label: "Start", type: "integer", required: true, minimum: 1 }, { name: "end", label: "End", type: "integer", required: true, minimum: 1 }, { name: "mode", label: "Mode", type: "select", required: true, options: ["repair"], default: "repair" }] }] },
    { id: "integrity", type: "integrity-alerts", title: "Integrity", coverage: { collectionId: "settings", view: "frontend", readCapability: "demo.frontend.read", stateRecordType: "demo.settings", stateRecordId: "state", lastArchivedTurnPath: "/last", settingsRecordType: "demo.settings", settingsRecordId: "settings", enabledPath: "/enabled", protectRecentTurnsPath: "/protect", archiveEveryTurnsPath: "/every", coverageRecordType: "demo.settings", startTurnPath: "/start", endTurnPath: "/end" }, action: { workflowRegionId: "work", workflowId: "demo-maintain", startTurnParameter: "start", endTurnParameter: "end", operationParameter: "mode", operationValue: "repair" } },
  ] }, contract);
  assert.equal(frontendRegion({ id: "demo", view }, "records", "record-browser").pageSize, 20);
  assert.deepEqual(applyFrontendSettingsValues(view.regions[1], { enabled: false, untouched: 1 }, { "/enabled": true }), { enabled: true, untouched: 1 });
  assert.deepEqual(validateFrontendWorkflowPayload(view.regions[2], "demo-maintain", { start: 2, end: 3 }), { start: 2, end: 3, mode: "repair" });
  assert.equal(frontendRegion({ id: "demo", view }, "integrity", "integrity-alerts").action.workflowId, "demo-maintain");
  assert.throws(() => applyFrontendSettingsValues(view.regions[1], { enabled: false }, { "/hidden": true }), /undeclared fields/);
  assert.throws(() => validateFrontendWorkflowPayload(view.regions[2], "other", {}), /not declared/);
  assert.throws(() => normalizeModuleFrontendView({ schemaVersion: 2, regions: [{ id: "bad", type: "record-browser", title: "Bad", collectionId: "entries", recordTypes: ["demo.entry"], view: "frontend", readCapability: "demo.settings.update" }] }, contract), /does not grant/);
  assert.throws(() => normalizeModuleFrontendView({ schemaVersion: 2, regions: [{ id: "unknown", type: "custom-script", title: "Unknown" }] }, contract), /unsupported type/);
});
