// S5 批次 4 回归：按会话构造数据 store 的唯一装配点。
//
// 此前宿主有 17 处各自构造 store。这里固定住收敛后的两条契约：
//   1. 只有声明了数据契约的模块参与数据层（资源模块不得伪造出空集合）；
//   2. 会话目录与绑定必须来自显式传入的参数，而不是宿主闭包状态。
import test from "node:test";
import assert from "node:assert/strict";

import { createSessionDataStore, dataModuleBindings } from "./rp-session-data-store.ts";

// 数据契约必须带 moduleId：store 以 contract.moduleId 作为模块键（这是真实契约的必填字段）。
const contractFor = (id) => ({ schemaVersion: 1, moduleId: id, collections: {} });

function module(id, contract, moduleDirectory = `/cards/demo/features/${id}`) {
  return { id, contract, moduleDirectory, title: id, workflows: [], agents: [] };
}

test("只有声明数据契约的模块进入数据绑定", () => {
  const data = module("memory", contractFor("memory"));
  const resource = module("lore", null);
  const bindings = dataModuleBindings([data, resource]);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].moduleDirectory, data.moduleDirectory);
  assert.equal(bindings[0].contract, data.contract);
});

test("绑定只携带契约与目录，不复制模块的其他字段", () => {
  const bindings = dataModuleBindings([module("memory", contractFor("memory"))]);
  assert.deepEqual(Object.keys(bindings[0]).sort(), ["contract", "moduleDirectory"]);
});

test("createSessionDataStore 使用传入的会话目录与绑定", () => {
  const store = createSessionDataStore({
    sessionDirectory: "/sessions/chat-1",
    featureModules: [module("memory", contractFor("memory")), module("lore", null)],
  });
  assert.equal(store.sessionDirectory.replaceAll("\\", "/").endsWith("/sessions/chat-1"), true);
  // store 以契约的 moduleId 为键；资源模块没有契约，因此不得出现。
  assert.deepEqual([...store.modules.keys()], ["memory"]);
});

test("未传 initialOverrides 与 playerName 时不伪造这两个字段", () => {
  const store = createSessionDataStore({
    sessionDirectory: "/sessions/chat-2",
    featureModules: [module("memory", { collections: {} })],
  });
  assert.deepEqual(store.initialOverrides, {});
  assert.equal(store.playerName, null);
});

test("传入 initialOverrides 与 playerName 时按原样交给 store", () => {
  const store = createSessionDataStore({
    sessionDirectory: "/sessions/chat-3",
    featureModules: [module("memory", { collections: {} })],
    initialOverrides: { memory: { enabled: true } },
    playerName: "阿岚",
  });
  assert.deepEqual(store.initialOverrides, { memory: { enabled: true } });
  assert.equal(store.playerName, "阿岚");
});

test("initialOverrides 被深拷贝，调用方之后改动不会影响已建 store", () => {
  const overrides = { memory: { enabled: true } };
  const store = createSessionDataStore({
    sessionDirectory: "/sessions/chat-4",
    featureModules: [module("memory", { collections: {} })],
    initialOverrides: overrides,
  });
  overrides.memory.enabled = false;
  assert.equal(store.initialOverrides.memory.enabled, true);
});
