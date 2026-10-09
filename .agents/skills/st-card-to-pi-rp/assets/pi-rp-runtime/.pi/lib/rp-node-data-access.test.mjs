// S5 批次 3 回归：冻结读原语。
//
// 方案 10 的必需行为验收里有一条："冻结数据读取与来源修订检查不能退化为读取最新值。"
// 这两个函数正是那条规则的实现点，因此这里显式断言"有冻结视图时绝不走实时边界"。
import test from "node:test";
import assert from "node:assert/strict";

import { resolveWorkflowIdentity, workflowDataReadAccess } from "./rp-node-data-access.ts";

function fakeStore(resolved = { id: "live", source: "live" }) {
  return {
    sessionDirectory: "/sessions/chat-1",
    resolveIdentity(value) { return { ...resolved, sentinel: `live:${value}` }; },
  };
}

test("声明了 dataReadViewId 时，读取必须走冻结视图而不是实时边界", async () => {
  const calls = [];
  const readCollection = async (options) => { calls.push(options); return { records: ["frozen"] }; };
  const run = { dataReadViewId: "view-abc", inheritedDataReadBatchIds: ["batch-1"] };
  const store = fakeStore();

  const access = workflowDataReadAccess(run, store, undefined, readCollection);

  // 冻结路径只暴露 readCollection，**不得**同时给出实时可见边界。
  assert.deepEqual(Object.keys(access), ["readCollection"]);
  assert.equal(access.visibleThroughTurn, undefined);
  assert.equal(access.visibleThroughTime, undefined);

  const result = await access.readCollection("memory", "events");
  assert.deepEqual(result, { records: ["frozen"] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sessionDirectory: "/sessions/chat-1",
    store,
    viewId: "view-abc",
    batchIds: ["batch-1"],
    moduleId: "memory",
    collectionId: "events",
  });
});

test("未声明冻结视图时，只能按回合/时间边界读，且不构造 readCollection", () => {
  const run = { visibleThroughTurn: 7, readSnapshotAt: "2026-10-09T00:00:00.000Z" };
  const access = workflowDataReadAccess(run, fakeStore(), []);
  assert.deepEqual(access, { visibleThroughTurn: 7, visibleThroughTime: "2026-10-09T00:00:00.000Z" });
  assert.equal(access.readCollection, undefined, "没有冻结视图时不得提供集合读取能力");
});

test("batchIds 默认取自 run 的继承批次", async () => {
  const calls = [];
  const readCollection = async (options) => { calls.push(options); return {}; };
  const run = { dataReadViewId: "view-x", inheritedDataReadBatchIds: ["inherited-1", "inherited-2"] };
  const access = workflowDataReadAccess(run, fakeStore(), undefined, readCollection);
  await access.readCollection("m", "c");
  assert.deepEqual(calls[0].batchIds, ["inherited-1", "inherited-2"]);
});

test("identity 解析在有冻结视图时走冻结视图，否则走 store 实时身份", async () => {
  const frozenCalls = [];
  const resolveIdentity = async (options) => { frozenCalls.push(options); return [{ id: "frozen", name: "冻结" }]; };
  const store = fakeStore({ id: "live-identity" });

  const frozenRun = { dataReadViewId: "view-abc", inheritedDataReadBatchIds: ["b1"] };
  const frozen = await resolveWorkflowIdentity(frozenRun, store, "某实体", undefined, resolveIdentity);
  assert.deepEqual(frozen, [{ id: "frozen", name: "冻结" }]);
  assert.deepEqual(frozenCalls[0], {
    sessionDirectory: "/sessions/chat-1",
    store,
    viewId: "view-abc",
    batchIds: ["b1"],
    value: "某实体",
  });

  // 没有冻结视图：必须回退到 store 的实时身份解析，而不是伪造一个冻结结果。
  const live = await resolveWorkflowIdentity({}, store, "某实体", [], resolveIdentity);
  assert.equal(live.sentinel, "live:某实体");
  assert.equal(frozenCalls.length, 1, "实时路径不得调用冻结解析器");
});
