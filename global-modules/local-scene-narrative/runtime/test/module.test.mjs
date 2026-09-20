import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { executeDataBatch } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";
import { getDataRecord, queryAllData, queryData } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";

import { execute as validateLocal } from "../workflow/validate-candidate.mjs";
import { execute as validateWorld } from "../../../world-scope-narrative/runtime/workflow/validate-candidate.mjs";
import { execute as assemble } from "../../../world-narrative-coordinator/runtime/workflow/assemble-reviewed-stories.mjs";
import { execute as exportRecent } from "../workflow/export-recent-stories.mjs";
import { latestBusinessRecord, queryAll } from "../lib/data.mjs";

async function draft(root, module) {
  const path = resolve(root, "handoff", "write", "candidate"); await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "story.md"), "一段完整故事。\n", "utf8");
  await writeFile(resolve(path, "metadata.json"), `${JSON.stringify({ module, summary: "一两句话。", timeRange: { start: "午后", end: "黄昏" }, locations: ["丹房"], characters: ["甲"], importantEntities: [{ name: "丹炉", unique: true }] })}\n`, "utf8");
}

test("local and world candidates preserve only minimal authored metadata plus runtime control", async () => {
  for (const [module, validate] of [["local-scene-narrative", validateLocal], ["world-scope-narrative", validateWorld]]) {
    const root = await mkdtemp(resolve(tmpdir(), "rp-story-candidate-"));
    try {
      await draft(root, module);
      const assignment = { candidateId: `${module}-c`, storyId: `${module}-s`, seriesId: `${module}-series`, sourceTurn: 7, notAfter: "夜晚", action: "continue" };
      await validate({ run: { arguments: { assignment } }, workspace: root });
      const metadata = JSON.parse(await readFile(resolve(root, "candidate", "metadata.json"), "utf8"));
      const control = JSON.parse(await readFile(resolve(root, "candidate", "control.json"), "utf8"));
      assert.deepEqual(Object.keys(metadata).sort(), ["characters", "importantEntities", "locations", "module", "summary", "timeRange"]);
      assert.equal(control.candidateId, assignment.candidateId);
      assert.equal(control.notAfter, "夜晚");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("director review assembler keeps accepted original, writes approval, and commits only private effects", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rp-story-review-"));
  try {
    const input = resolve(root, "inputs", "local-candidate"); await mkdir(input, { recursive: true });
    const metadata = { module: "local-scene-narrative", summary: "摘要。", timeRange: { start: "午后", end: "黄昏" }, locations: ["丹房"], characters: ["甲"], importantEntities: [] };
    await writeFile(resolve(input, "story.md"), "原始故事。\n", "utf8");
    await writeFile(resolve(input, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
    await writeFile(resolve(input, "control.json"), `${JSON.stringify({ candidateId: "c1" })}\n`, "utf8");
    const batches = [];
    const output = { decisions: { local: { decision: "accept-original", reason: "无硬冲突" } }, directorBatch: { protocolVersion: 1, commitPolicy: "atomic", operations: [] } };
    await assemble({ run: { id: "run-1", nodes: { review: { output } } }, node: { metadata: { sourceNode: "review" } }, workspace: root, data: { submit: async batch => { batches.push(batch); } } });
    assert.equal((await readFile(resolve(root, "reviewed", "local", "story.md"), "utf8")).trim(), "原始故事。");
    assert.equal(JSON.parse(await readFile(resolve(root, "reviewed", "local", "approval.json"), "utf8")).decision, "accept-original");
    assert.equal(batches.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("story data helpers traverse every page and select the latest business sequence", async () => {
  const calls = [];
  const data = {
    async query(request) {
      calls.push(request);
      if (request.sort) return { items: [{ id: "latest", value: { sequence: 701 } }], nextCursor: null };
      const offset = request.cursor ? Number(request.cursor.split(":")[1]) : 0;
      return { items: [{ id: `story-${offset + 1}` }], nextCursor: offset < 2 ? `offset:${offset + 1}` : null };
    },
  };
  assert.equal((await queryAll(data, { moduleId: "local-scene-narrative", collectionId: "story-publications" })).length, 3);
  assert.equal((await latestBusinessRecord(data, { moduleId: "local-scene-narrative", collectionId: "story-publications" })).value.sequence, 701);
  assert.deepEqual(calls.at(-1).sort, [{ field: "storySequence", order: "desc" }]);
  assert.equal(calls.at(-1).limit, 1);
});

test("the public sorter keeps story sequence separate from envelope insertion order", async t => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-story-sequence-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const moduleDirectory = resolve(process.cwd(), "global-modules/local-scene-narrative");
  const contract = JSON.parse(await readFile(resolve(moduleDirectory, "data-contract.json"), "utf8"));
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  const story = (id, sequence) => ({ storyId: id, seriesId: "series", sequence, sourceTurn: sequence, timeRange: { start: "早", end: "晚" }, locations: ["港口"], characters: [], importantEntities: [], summary: id, content: id, originStoryId: null, candidateId: `candidate-${id}`, approval: { authority: "test", runId: "run", decision: "accept-original" } });
  const writeAccess = [{ moduleId: "local-scene-narrative", collectionId: "story-publications", capabilities: ["local-story.publish"], views: ["publish"] }];
  for (const [id, sequence] of [["story-701", 701], ["story-700", 700]]) {
    const receipt = await executeDataBatch(store, { protocolVersion: 1, batchId: `create-${id}`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `create-${id}`, moduleId: "local-scene-narrative", collectionId: "story-publications", recordType: "local-narrative.story", action: "create", targetId: id, data: story(id, sequence) }] }, { access: writeAccess, context: { binding: { turn: sequence, messageId: null } } });
    assert.equal(receipt.status, "committed");
  }
  const constraints = { capabilities: ["local-story.publish"], views: ["publish"], runtimeLimit: 10, runtimeCharacters: 100000, nodeLimit: 10, nodeCharacters: 100000 };
  const data = { query: request => queryData(store, request, constraints) };
  const latest = await latestBusinessRecord(data, { moduleId: "local-scene-narrative", collectionId: "story-publications", recordTypes: ["local-narrative.story"], view: "publish" });
  assert.equal(latest.value.sequence, 701);
});

// RC-04: `exportRecentStories` wrote `{sourceTurn:{gte:from,lte:through}}` into one index
// condition. The public query contract allows exactly one operator per index, so the first turn of
// every session failed with "Query condition sourceTurn must contain exactly one operator." before
// the narrative Agent ever ran. These cases exercise the real RpDataStore and the module's own
// data contract — a permissive query mock would happily accept the illegal `where`.
async function storyStore(prefix, t) {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), prefix));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const moduleDirectory = resolve(process.cwd(), "global-modules/local-scene-narrative");
  const contract = JSON.parse(await readFile(resolve(moduleDirectory, "data-contract.json"), "utf8"));
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  // The creative read grants exactly the two views `export-recent-stories` consumes, which is what
  // the module's own workflow node declares; anything else would make the test pass for the wrong
  // reason.
  return { store, moduleDirectory, constraints: { capabilities: ["local-story.creative.read"], views: ["creative-index", "creative-full"], runtimeLimit: 50, runtimeCharacters: 500000, nodeLimit: 50, nodeCharacters: 500000 } };
}

async function publishStory(store, id, sourceTurn, sequence) {
  const data = { storyId: id, seriesId: "series-main", sequence, sourceTurn, timeRange: { start: "早", end: "晚" }, locations: ["城门"], characters: [], importantEntities: [], summary: `${id} 摘要`, content: `${id} 全文`, originStoryId: null, candidateId: `candidate-${id}`, approval: { authority: "director", runId: "run-1", decision: "accept-original" } };
  const receipt = await executeDataBatch(store, { protocolVersion: 1, batchId: `create-${id}`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `create-${id}`, moduleId: "local-scene-narrative", collectionId: "story-publications", recordType: "local-narrative.story", action: "create", targetId: id, data }] }, { access: [{ moduleId: "local-scene-narrative", collectionId: "story-publications", capabilities: ["local-story.publish"], views: ["publish"] }], context: { binding: { turn: sourceTurn, messageId: null } } });
  assert.equal(receipt.status, "committed");
}

function storyReader(store, constraints, pageCharacters = 500000) {
  return {
    query: request => queryData(store, request, { ...constraints, runtimeCharacters: pageCharacters, nodeCharacters: pageCharacters }),
    get: request => getDataRecord(store, request, constraints),
    queryAll: (request, page) => queryAllData(store, request, constraints, page),
  };
}
test("recent-story export succeeds on an empty collection", async t => {
  const { store, constraints } = await storyStore("rp-story-empty-", t);
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-story-export-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await exportRecent({ run: { arguments: { throughTurn: 3, recentCompleteTurns: 5 } }, workspace, data: storyReader(store, constraints) });
  assert.deepEqual(result, { count: 0, fromTurn: 0, throughTurn: 3 });
  assert.deepEqual(JSON.parse(await readFile(resolve(workspace, "stories", "story-index.json"), "utf8")), []);
});

test("recent-story export applies both turn bounds and drops stories after throughTurn", async t => {
  const { store, constraints } = await storyStore("rp-story-bounds-", t);
  // Turn 0 is the lower boundary, turn 2 the upper one, turn 3 must be excluded.
  for (const [id, turn, sequence] of [["s-0", 0, 1], ["s-1", 1, 2], ["s-2", 2, 3], ["s-9", 3, 4]]) await publishStory(store, id, turn, sequence);
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-story-export-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await exportRecent({ run: { arguments: { throughTurn: 2, recentCompleteTurns: 3 } }, workspace, data: storyReader(store, constraints) });
  assert.deepEqual(result, { count: 3, fromTurn: 0, throughTurn: 2 });
  const index = JSON.parse(await readFile(resolve(workspace, "stories", "story-index.json"), "utf8"));
  assert.deepEqual(index.map(item => item.id).sort(), ["s-0", "s-1", "s-2"]);
  for (const item of index) {
    const full = JSON.parse(await readFile(resolve(workspace, "stories", item.document), "utf8"));
    assert.equal(full.value.content, `${item.id} 全文`);
  }
});

test("recent-story export walks every page of a bounded window", async t => {
  const { store, constraints } = await storyStore("rp-story-pages-", t);
  for (let turn = 0; turn < 24; turn += 1) await publishStory(store, `s-${String(turn).padStart(2, "0")}`, turn, turn + 1);
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-story-export-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // One record per page: the character budget forces a cursor on every call, so a single-page
  // implementation would silently return one story instead of the whole window. The budget must still
  // be at least one record's worth of characters — a budget no record fits in is a hard bound now, so
  // the query reports `truncated` and returns nothing rather than delivering over budget.
  const data = storyReader(store, constraints, 200);
  const result = await exportRecent({ run: { arguments: { throughTurn: 9, recentCompleteTurns: 4 } }, workspace, data });
  assert.deepEqual(result, { count: 4, fromTurn: 6, throughTurn: 9 });
  const index = JSON.parse(await readFile(resolve(workspace, "stories", "story-index.json"), "utf8"));
  assert.deepEqual(index.map(item => item.id), ["s-06", "s-07", "s-08", "s-09"]);
});

test("recent-story export copies the full text of every windowed record", async t => {
  const { store, constraints } = await storyStore("rp-story-budget-", t);
  for (let turn = 10; turn < 14; turn += 1) await publishStory(store, `s-${turn}`, turn, turn + 1);
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-story-export-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // A node budget smaller than the window still returns the records the budget covers; the export
  // reports what it actually wrote rather than claiming a complete window.
  const data = storyReader(store, { ...constraints, runtimeLimit: 2 });
  const result = await exportRecent({ run: { arguments: { throughTurn: 12, recentCompleteTurns: 10 } }, workspace, data });
  assert.deepEqual(result, { count: 3, fromTurn: 3, throughTurn: 12 });
  const index = JSON.parse(await readFile(resolve(workspace, "stories", "story-index.json"), "utf8"));
  for (const item of index) {
    const full = JSON.parse(await readFile(resolve(workspace, "stories", item.document), "utf8"));
    assert.equal(full.value.content, `${item.id} 全文`);
    assert.equal(full.value.summary, undefined, "the creative-full view intentionally omits summaries");
  }
});

test("installed story modules use synchronized generated mechanics", async () => {
  const canonical = await readFile(resolve(process.cwd(), ".agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime/story-mechanics.mjs"), "utf8");
  const contract = await readFile(resolve(process.cwd(), ".agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime/story-contract.mjs"), "utf8");
  for (const module of ["local-scene-narrative", "world-scope-narrative"]) {
    assert.equal(await readFile(resolve(process.cwd(), "global-modules", module, "runtime/lib/story-mechanics.mjs"), "utf8"), canonical);
    assert.equal(await readFile(resolve(process.cwd(), "global-modules", module, "runtime/lib/story-contract.mjs"), "utf8"), contract);
  }
  assert.equal(await readFile(resolve(process.cwd(), "global-modules/world-narrative-coordinator/runtime/lib/story-contract.mjs"), "utf8"), contract);
  assert.deepEqual(JSON.parse(await readFile(resolve(process.cwd(), "global-modules/local-scene-narrative/schemas/story.schema.json"), "utf8")), JSON.parse(await readFile(resolve(process.cwd(), "global-modules/world-scope-narrative/schemas/story.schema.json"), "utf8")));
});
