// S5 批次 7 回归：生图去重闸门与 Web 数据访问装配。
//
// 去重闸门守的是一条真实不变量："同一个 requestId 的生图任务只能执行一次"。
// 原实现把 `has`/`new Promise`/`finally(delete)` 的组合手写了两遍——漏掉 `finally` 就会
// 让该 requestId 永久卡住、今后永不执行。这里把两个方向都固定住：
//   1. 重复提交不会二次执行；
//   2. 任务结束后闸门被释放，同一 requestId 可以再次执行。
import test from "node:test";
import assert from "node:assert/strict";

import { createImageExecutionGuard, createWebDataAccess } from "./rp-image-execution-guard.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("同一 requestId 的重复提交只执行一次", async () => {
  const guard = createImageExecutionGuard();
  guard.reset();
  let starts = 0;
  const gate = deferred();

  const first = guard.run("req-1", () => { starts += 1; return gate.promise; });
  const second = guard.run("req-1", () => { starts += 1; return Promise.resolve("second"); });

  assert.equal(starts, 1, "第二次提交不得再次启动任务");
  assert.equal(first, second, "重复提交应复用同一个在途任务");
  assert.deepEqual(guard.inFlightIds(), ["req-1"]);
  assert.equal(guard.alreadyRunning("req-1"), true);

  gate.resolve("done");
  assert.equal(await first, "done");
});

test("任务结束后闸门释放，同一 requestId 可以再次执行", async () => {
  const guard = createImageExecutionGuard();
  guard.reset();
  let starts = 0;
  await guard.run("req-1", () => { starts += 1; return Promise.resolve(); });

  // finally 必须已经清理，否则该 requestId 会永久卡住。
  assert.deepEqual(guard.inFlightIds(), []);
  assert.equal(guard.alreadyRunning("req-1"), false);

  await guard.run("req-1", () => { starts += 1; return Promise.resolve(); });
  assert.equal(starts, 2, "清理之后必须能再次执行");
});

test("任务失败也要释放闸门，且不抛出未处理的 rejection", async () => {
  const guard = createImageExecutionGuard();
  guard.reset();
  const seen = [];
  await guard.run("req-1", () => Promise.reject(new Error("comfy 挂了")), (error) => seen.push(error.message));

  assert.deepEqual(seen, ["comfy 挂了"], "失败必须交给错误回调，而不是静默吞掉");
  assert.deepEqual(guard.inFlightIds(), [], "失败后闸门同样要释放");
});

test("不同 requestId 互不影响", async () => {
  const guard = createImageExecutionGuard();
  guard.reset();
  const starts = [];
  const a = deferred();
  const b = deferred();
  guard.run("req-a", () => { starts.push("a"); return a.promise; });
  guard.run("req-b", () => { starts.push("b"); return b.promise; });
  assert.deepEqual(starts, ["a", "b"]);
  assert.deepEqual(guard.inFlightIds().sort(), ["req-a", "req-b"]);
  a.resolve();
  b.resolve();
});

test("Web 数据访问装配把访问声明翻译成读写能力", () => {
  const calls = [];
  const access = [
    { moduleId: "comfy-image-generation", collectionId: "requests", capabilities: ["image.requests.prepare"], views: ["maintenance"] },
    { moduleId: "comfy-image-generation", collectionId: "renders", capabilities: ["image.renders.execute"], views: ["maintenance"] },
  ];
  const data = createWebDataAccess({
    store: { name: "store" },
    access,
    queryData: (store, request, constraints) => { calls.push(["query", request.collectionId, constraints]); return "q"; },
    getDataRecord: (store, request, constraints) => { calls.push(["get", request.collectionId, constraints]); return "g"; },
    executeDataBatchOrThrow: (store, draft, options) => { calls.push(["submit", draft, options]); return "s"; },
    currentTurn: 7,
  });

  assert.equal(data.query({ collectionId: "requests" }), "q");
  assert.deepEqual(calls[0][2], { capabilities: ["image.requests.prepare"], views: ["maintenance"], runtimeLimit: 1000, runtimeCharacters: 1000000, nodeLimit: 1000, nodeCharacters: 1000000 });

  assert.equal(data.get({ collectionId: "renders" }), "g");
  assert.deepEqual(calls[1][2].capabilities, ["image.renders.execute"]);

  assert.equal(data.submit({ batchId: "b1" }), "s");
  assert.deepEqual(calls[2][2], {
    access,
    context: { initiatorKind: "user", initiatorId: "web", binding: { turn: 7, messageId: null } },
  });
});

test("未声明的集合必须报错而不是给出无约束访问", () => {
  const data = createWebDataAccess({
    store: {},
    access: [{ moduleId: "m", collectionId: "known", capabilities: [], views: [] }],
    queryData: () => "q",
    getDataRecord: () => "g",
    executeDataBatchOrThrow: () => "s",
    currentTurn: 0,
  });
  assert.throws(() => data.query({ collectionId: "unknown" }), /no declaration for collection unknown/);
  assert.throws(() => data.get({ collectionId: "unknown" }), /no declaration for collection unknown/);
});
