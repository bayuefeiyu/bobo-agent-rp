import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "../web-api.mjs";
import { createImageDataFacade } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-image-adapter.ts";
import { createWebDataAccess } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-image-execution-guard.ts";
import { normalizeDataContract } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { queryData, getDataRecord } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";
import { executeDataBatchOrThrow } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";

test("real data projections and preference batch match the shipped contract", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-image-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = fileURLToPath(new URL("../..", import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(moduleDirectory, "module.json"), "utf8"));
  const contract = normalizeDataContract(JSON.parse(await readFile(resolve(moduleDirectory, manifest.dataContractFile), "utf8")), manifest.id);
  const store = new RpDataStore({ sessionDirectory: root, modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  const facade = createImageDataFacade({ webApi: api, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: 1 });
  const before = (await facade.readSettings()).records.find(record => record.id === api.COMPONENTS.preferencesRecordId);
  assert.equal(before.recordType, api.RECORD_TYPES.preferences);
  assert.equal(typeof before.data.quickMode, "boolean");
  const { batch } = api.preferenceUpdate(before, { selectedProfileIds: ["available", "missing"], quickMode: !before.data.quickMode }, [{ id: "available" }], "web-prefs", "update-prefs");
  await facade.dataFor(api.ACCESS.preferencesConfigure).submit(batch);
  const after = (await facade.readSettings()).records.find(record => record.id === before.id);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.data.quickMode, !before.data.quickMode);
  assert.deepEqual(after.data.selectedProfileIds, ["available"]);
  assert.deepEqual(after.data.inputPolicy, before.data.inputPolicy);
  assert.deepEqual((await facade.readRequests()).records, []);
  assert.deepEqual((await facade.readRenders()).records, []);
});

test("query paging delivers all records and rejects repeated cursors or incomplete projection", async () => {
  const page = id => ({ items: [{ id, recordType: "image.request", revision: 1, value: { 请求: { ordinal: 1 } } }] });
  const seen = [];
  const result = await api.readWebRecords({ query: request => { seen.push(request); return { ...page(String(seen.length)), nextCursor: seen.length === 1 ? "next" : null }; } }, api.COLLECTIONS.requests);
  assert.deepEqual(result.records.map(record => record.id), ["1", "2"]);
  assert.equal(seen[1].cursor, "next");
  await assert.rejects(api.readWebRecords({ query: () => ({ ...page("x"), nextCursor: "same" }) }, api.COLLECTIONS.requests), /repeated a cursor/);
  await assert.rejects(api.readWebRecords({ query: () => ({ items: [], truncated: true, nextCursor: null }) }, api.COLLECTIONS.requests), /budget/);
  await assert.rejects(api.readWebRecords({ query: () => ({ items: [{ value: {} }], nextCursor: null }) }, api.COLLECTIONS.requests), /projection/);
});

test("recovery and regeneration use module-owned domain rules", () => {
  const request = { id: "request", data: { ordinal: 3, selectedProfileIds: ["p1", "p2"], contentPrompts: [{ guideId: "g1", content: "old" }, { guideId: "g2", content: "keep" }] } };
  const renders = ["pending", "submitting", "submitted", "completed", "failed"].map((state, i) => ({ id: `render-${i}`, data: { state, requestId: "request", profileId: "p1", guideId: "g1" } }));
  assert.equal(api.recoverableRenders(renders, "request").length, 3);
  const one = api.regenerationSource([request], renders, "render-0", "new", "single");
  assert.deepEqual(one.profileIds, ["p1"]);
  assert.deepEqual(one.editedContentPrompts, [{ guideId: "g1", content: "new" }, { guideId: "g2", content: "keep" }]);
  assert.equal(one.ordinal, 4);
  assert.deepEqual(api.regenerationSource([request], renders, "render-0", "new", "all").profileIds, ["p1", "p2"]);
  assert.equal(api.regenerationSource([request], renders, "missing", "new", "all"), null);
});
