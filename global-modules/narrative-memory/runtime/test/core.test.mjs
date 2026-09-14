import assert from "node:assert/strict";
import test from "node:test";

import {
  composeMemoryDocument,
  deriveEventSummaryData,
  deriveFacets,
  effectiveEventEntries,
  normalizeInformationControl,
  normalizeRetrievalBudget,
  resolveGroupMembers,
  selectEntities,
  summaryOverLimit,
} from "../lib/core.mjs";

test("summary limits are soft flags and retrieval grants are hard limits", () => {
  assert.equal(summaryOverLimit("memory.entity", "甲".repeat(30)), false);
  assert.equal(summaryOverLimit("memory.entity", "甲".repeat(31)), true);
  assert.throws(() => normalizeRetrievalBudget({ entityQueryLimit: 21 }, undefined, { entityQueryLimit: 20 }), /workflow grant/);
  assert.throws(() => normalizeInformationControl({ mode: "restricted", knowerIds: [] }), /requires/);
});

test("template facets drive deterministic count and sampling", () => {
  const template = { filterFacets: [{ facetId: "gender", path: "/sections/基本信息/性别", valueType: "string" }] };
  const records = ["a", "b", "c"].map((id, index) => ({
    id,
    name: id.toUpperCase(),
    entityKind: "character",
    templateId: "entity.character",
    templateVersion: 1,
    derivedFacets: deriveFacets({ sections: { 基本信息: { 性别: index === 2 ? "女" : "男" } } }, template),
  }));
  const filter = { field: "gender", operator: "eq", value: "男" };
  assert.deepEqual(selectEntities(records, { mode: "count", filter }), { mode: "count", count: 2 });
  const seed = { sessionId: "s", turn: 7, workflowId: "w", maxResults: 3 };
  const left = selectEntities(records, { mode: "sample", count: 2, filter, selectionKey: "scene" }, seed);
  const right = selectEntities(records, { mode: "sample", count: 2, filter, selectionKey: "scene" }, seed);
  assert.deepEqual(left, right);
  assert.equal(left.items.length, 2);
});

test("knower groups expand nesting, apply exclusions, and reject cycles", () => {
  const resolved = resolveGroupMembers([
    { id: "inner", includeIds: ["lin", "lu"], excludeIds: [] },
    { id: "outer", includeIds: ["inner", "chen"], excludeIds: ["lu"] },
  ]);
  assert.deepEqual(resolved.get("outer"), ["chen", "lin"]);
  const frozen = resolveGroupMembers([
    { id: "dynamic", membershipMode: "dynamic", includeIds: ["new", "old"], excludeIds: [] },
    { id: "historical", membershipMode: "fixed", includeIds: ["dynamic"], excludeIds: [], resolvedMemberIds: ["old"] },
  ]);
  assert.deepEqual(frozen.get("historical"), ["old"]);
  const refreshed = resolveGroupMembers([
    { id: "dynamic", membershipMode: "dynamic", includeIds: ["new", "old"], excludeIds: [] },
    { id: "historical", membershipMode: "fixed", includeIds: ["dynamic"], excludeIds: [], resolvedMemberIds: ["old"] },
  ], { refreshFixedIds: ["historical"] });
  assert.deepEqual(refreshed.get("historical"), ["new", "old"]);
  assert.throws(() => resolveGroupMembers([
    { id: "a", includeIds: ["b"], excludeIds: [] },
    { id: "b", includeIds: ["a"], excludeIds: [] },
  ]), /cycle/);
});

function event(id, sortValue, { status = "completed", precedingEventIds = [] } = {}) {
  return {
    id,
    recordType: "memory.event",
    sequence: Number(sortValue),
    data: {
      name: id,
      catalogSummary: `${id}摘要`,
      status,
      time: { displayStart: `第${sortValue}天`, displayEnd: null, trueTime: `D${sortValue}`, sortValue, timeRuleVersion: "test-v1" },
      participantIds: [],
      locationIds: [],
      relatedEntityIds: [],
      precedingEventIds,
      relatedEventIds: [],
      overviewInformationControl: { mode: "common", knowerIds: [] },
      informationBlocks: [],
      sections: {},
      templateMode: "default",
      templateId: "event.default",
      templateVersion: 1,
      summaryOverLimit: false,
    },
  };
}

test("event summaries replace covered entries without deleting originals", () => {
  const first = event("e1", "0001");
  const second = event("e2", "0002", { precedingEventIds: ["e1"] });
  const data = deriveEventSummaryData(
    { sourceEntryIds: ["e1", "e2"], name: "两日摘要", catalogSummary: "发生两件事", sections: {} },
    new Map([["e1", first], ["e2", second]]),
    "test-v1",
  );
  const summary = { id: "s1", recordType: "memory.event-summary", sequence: 3, data };
  assert.deepEqual(data.coveredEventIds, ["e1", "e2"]);
  assert.deepEqual(effectiveEventEntries([first, second, summary]).map(item => item.id), ["s1"]);
  assert.throws(() => deriveEventSummaryData(
    { sourceEntryIds: ["e1", "ongoing"] },
    new Map([["e1", first], ["ongoing", event("ongoing", "0003", { status: "ongoing" })]]),
    "test-v1",
  ), /Ongoing/);
});

test("creative documents use YAML-like fields, compact scopes, and perspective filtering", () => {
  const entriesById = new Map([
    ["lin", { id: "lin", recordType: "memory.entity", data: {
      name: "林月",
      catalogSummary: "剑修",
      sections: { 基本信息: { 性别: "女" } },
      informationBlocks: [
        { title: "外貌", mode: "common", knowerIds: [], content: { 当前状态: ["佩剑"] } },
        { title: "旧伤", mode: "restricted", knowerIds: ["sect"], content: { 当前状态: ["左臂有旧伤"] } },
        { title: "遗迹宝物", mode: "undiscovered", knowerIds: [], content: { 宝物: "星髓" } },
        { title: "未整理", mode: "unclassified", knowerIds: [], content: { 当前状态: ["来历可疑"] } },
      ],
    }}],
    ["sect", { id: "sect", recordType: "memory.knower-group", data: { name: "紫霄派修士", includeIds: ["lin", "lu"], excludeIds: ["lu"] } }],
  ]);
  const groupMembers = resolveGroupMembers([{ id: "sect", includeIds: ["lin", "lu"], excludeIds: ["lu"] }]);
  const catalogNames = new Map([["lu", "陆衡"]]);
  const queryResults = [{ query: "林月", kind: "entity", matches: [{ recordId: "lin", status: "direct" }] }];
  const general = composeMemoryDocument({ queryResults, entriesById, groupMembers, catalogNames });
  assert.match(general, /基本信息:/);
  assert.match(general, /#### 紫霄派修士知情（陆衡除外）/);
  assert.match(general, /#### 尚无角色知情的信息/);
  assert.match(general, /#### 知情范围尚未确认/);
  assert.doesNotMatch(general, /^sections:/m);
  assert.doesNotMatch(general, /templateId:/);
  assert.doesNotMatch(general, /有效事件时间线/);
  const lin = composeMemoryDocument({ queryResults, entriesById, perspectiveId: "lin", groupMembers, catalogNames });
  assert.match(lin, /左臂有旧伤/);
  assert.doesNotMatch(lin, /星髓/);
  const lu = composeMemoryDocument({ queryResults, entriesById, perspectiveId: "lu", groupMembers, catalogNames });
  assert.doesNotMatch(lu, /左臂有旧伤/);
});
