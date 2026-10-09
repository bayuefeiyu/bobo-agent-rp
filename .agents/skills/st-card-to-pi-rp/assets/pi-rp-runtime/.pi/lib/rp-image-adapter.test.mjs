// S7 回归：生图模块的稳定入口与宿主侧适配器。
//
// 方案 §12 的验收要求"公共宿主除显式适配接线外，不直接读写生图专属集合或引用内部执行文件"，
// 以及"模块内测试能独立验证领域操作；宿主测试验证授权与操作转发"。
//
// 这里同时固定住两边：模块**拥有**哪些字符串与路径，宿主**不再**知道它们。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createImageDataFacade,
  loadImageExecution,
  loadImageWebApi,
  resetImageWebApiCache,
} from "./rp-image-adapter.ts";

const MODULE_DIR = resolve("global-modules/comfy-image-generation");

// 用绝对 URL 导入模块入口，而不是数 `../` 层数：相对层数写错会让测试以
// ERR_MODULE_NOT_FOUND 失败，看起来像"模块有问题"，实际只是路径算术错误。
const {
  ACCESS,
  CAPABILITIES,
  COLLECTIONS,
  MODULE_ID,
  RECORD_TYPES,
  loadExecution,
  readWebRecords,
  resolveImageModule,
} = await import(pathToFileURL(resolve(MODULE_DIR, "runtime", "web-api.mjs")).href);

test("模块入口拥有身份、集合、能力与授权声明", () => {
  assert.equal(MODULE_ID, "comfy-image-generation");
  assert.deepEqual(Object.keys(COLLECTIONS).sort(), ["renders", "requests", "settings"]);
  assert.equal(CAPABILITIES.requestsPrepare, "image.requests.prepare");
  assert.equal(CAPABILITIES.rendersExecute, "image.renders.execute");
  assert.equal(RECORD_TYPES.preferences, "image.preferences");

  // 授权声明里的每个 collectionId 都必须用 COLLECTIONS 常量，不能是散落字面量。
  const collectionIds = new Set(Object.values(COLLECTIONS));
  for (const declaration of [...ACCESS.preferences, ...ACCESS.requests]) {
    assert.equal(declaration.moduleId, MODULE_ID);
    assert.ok(collectionIds.has(declaration.collectionId), `未知集合 ${declaration.collectionId}`);
    assert.ok(declaration.capabilities.length > 0, `集合 ${declaration.collectionId} 缺少能力声明`);
    assert.ok(declaration.views.length > 0, `集合 ${declaration.collectionId} 缺少视图声明`);
  }
});

test("resolveImageModule 只按模块身份解析，未装载时返回 null", () => {
  const module = { id: "comfy-image-generation", moduleDirectory: "/x" };
  assert.equal(resolveImageModule([{ id: "other" }, module]), module);
  assert.equal(resolveImageModule([{ id: "other" }]), null);
  assert.equal(resolveImageModule(undefined), null);
});

test("loadExecution 由模块决定内部路径，并保留热加载 cacheKey 语义", async () => {
  const seen = [];
  const importModule = async (url) => { seen.push(url); return { marker: "stub" }; };
  const result = await loadExecution({ moduleDirectory: MODULE_DIR, cacheKey: "web=123", importModule, pathToUrl: (path) => `file:///${path.replaceAll("\\", "/")}` });
  assert.deepEqual(result, { marker: "stub" });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /runtime\/image-execution\.mjs\?web=123$/, "内部执行路径与 cacheKey 应由模块拼装");
});

test("宿主适配器加载模块入口，并按目录缓存", async () => {
  resetImageWebApiCache();
  const imports = [];
  const importModule = async (url) => { imports.push(url); return { MODULE_ID: "comfy-image-generation", stub: true }; };
  const first = await loadImageWebApi(MODULE_DIR, importModule);
  const second = await loadImageWebApi(MODULE_DIR, importModule);
  assert.equal(first, second, "同一模块目录只应解析一次入口");
  assert.equal(imports.length, 1);
  assert.match(imports[0], /runtime\/web-api\.mjs$/);
  resetImageWebApiCache();
});

test("数据门面把模块声明的集合与授权交给通用数据服务", async () => {
  const calls = [];
  const createWebDataAccess = ({ store, access }) => ({
    query: (request) => { calls.push({ access, request }); return { items: [{ id: "r1", recordType: "image.preferences", revision: 1, value: { 设置: { quickMode: true }, 请求: {}, 生成记录: {} } }], nextCursor: null }; },
  });
  const facade = createImageDataFacade({
    webApi: { MODULE_ID, COLLECTIONS, ACCESS, readWebRecords },
    createWebDataAccess,
    store: { name: "store" },
    queryData: () => ({}),
    getDataRecord: () => ({}),
    executeDataBatchOrThrow: () => ({}),
    currentTurn: 3,
  });

  const settings = await facade.readSettings();
  assert.deepEqual(settings.records[0].data, { quickMode: true });
  assert.equal(calls[0].request.moduleId, "comfy-image-generation");
  assert.equal(calls[0].request.collectionId, "settings");
  assert.deepEqual(calls[0].access, ACCESS.preferencesConfigure);

  await facade.readRequests();
  assert.equal(calls[1].request.collectionId, "requests");
  assert.deepEqual(calls[1].access, ACCESS.requests);

  await facade.readRenders();
  assert.equal(calls[2].request.collectionId, "renders");
});

test("宿主适配器委托模块加载内部执行实现", async () => {
  const seen = [];
  const webApi = {
    loadExecution: async ({ moduleDirectory, cacheKey }) => { seen.push([moduleDirectory, cacheKey]); return { ok: true }; },
  };
  const execution = await loadImageExecution(webApi, MODULE_DIR, "recover=1");
  assert.deepEqual(execution, { ok: true });
  assert.deepEqual(seen, [[MODULE_DIR, "recover=1"]]);
});

// S7 接线完成后的正向断言：宿主**必须**经适配器取得模块身份与操作，
// 且不得再自行书写生图专属字面量。这条断言取代了接线前的"尚未接入"占位断言
// （占位断言的作用是防止未完成的工作被误报为已完成；现已完成，故改为守住结果）。
test("宿主经适配器接入，且不再持有生图专属字面量", () => {
  const host = readFileSync(
    ".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-image-web-bridge.ts",
    "utf8",
  );
  assert.match(host, /from "\.\/rp-image-adapter\.ts"/, "宿主未接入显式生图适配器");
  // 宿主只按身份经适配器查找模块；集合名、能力名、recordType、内部执行路径一律向模块询问。
  for (const forbidden of [
    '"comfy-image-generation"',
    "image-execution.mjs",
    '"image.requests.prepare"',
    '"image.renders.execute"',
    '"image.preferences"',
    '"image-preferences"',
  ]) {
    assert.equal(host.includes(forbidden), false, `宿主仍持有生图专属字面量 ${forbidden}`);
  }
  // 动态加载内部执行实现必须经模块入口决定的路径。
  assert.match(host, /loadImageExecution\(/, "宿主未经适配器加载模块内部执行实现");
  assert.match(host, /resolveImageModuleContext\(/, "宿主未经适配器解析模块身份");
});
