import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { executeDataBatch } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";
import { queryData } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";

import { execute as validateLocal } from "../workflow/validate-candidate.mjs";
import { execute as validateWorld } from "../../../world-scope-narrative/runtime/workflow/validate-candidate.mjs";
import { execute as assemble } from "../../../world-narrative-coordinator/runtime/workflow/assemble-reviewed-stories.mjs";
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
