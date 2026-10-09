// S4：配置目录装配的单一实现（rp-config-catalog.mjs）回归。
//
// 覆盖方案第 9 节要求的边界：
//   - 非 settings 集合（区域声明的 collectionId 不是 settings）；
//   - 两种初始化来源（initialSnapshotFile / initialRecordsFile）；
//   - 精确记录选择（recordId 优先、recordType 其次；歧义必须报告而不是取第一条）；
//   - 多 region（同名字段冲突必须报告）；
//   - 缺失记录；
//   - 作者默认值与配置覆盖层分别返回。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConfigCatalog,
  componentEntry,
  moduleCatalogEntry,
  ownerQualifiedReference,
  resolveSettingsRegionDefaults,
  workflowConfigFields,
} from "./rp-config-catalog.mjs";

// ---------------------------------------------------------------- 测试夹具 --
function contractWith(collections) {
  return { schemaVersion: 1, moduleId: "demo", collections };
}

function settingsRegion(overrides = {}) {
  return {
    id: "demo-settings",
    type: "settings-form",
    collectionId: "support",
    recordType: "demo.settings",
    recordId: "demo-settings-current",
    fields: [{ path: "/data/enabled", label: "启用", type: "boolean" }],
    ...overrides,
  };
}

function moduleWith({ regions, collections, documents, id = "demo" }) {
  return {
    id,
    title: "演示模块",
    description: "仅用于测试。",
    moduleDirectory: "/virtual",
    contract: contractWith(collections),
    view: { schemaVersion: 2, regions },
    documents,
  };
}

function readerFrom(documents) {
  return async (relativePath) => (relativePath in documents ? documents[relativePath] : null);
}

test("workflow fields 只声明前台回合窗口与 Agent 节点字段", () => {
  const workflow = {
    kind: "foreground",
    defaults: { agentId: "demo/writer" },
    nodes: [
      { id: "plan", type: "code" },
      { id: "write", type: "agent", title: "正文" },
    ],
  };
  const fields = workflowConfigFields(workflow);
  const paths = fields.map((field) => field.path);
  assert.deepEqual(paths, [
    "/turnContext/recentCompleteTurns",
    "/defaults/agentId",
    "/defaults/modelId",
    "/nodes/1/agentId",
    "/nodes/1/modelId",
  ]);
  // code 节点不得产生字段。
  assert.ok(!paths.some((path) => path.startsWith("/nodes/0/")));
});

test("模块限定引用对两种宿主生成同一形式", () => {
  assert.equal(ownerQualifiedReference("agent", "memory", "memory/writer"), "module/memory/agent/writer");
  assert.equal(ownerQualifiedReference("workflow", "memory", "memory/run"), "module/memory/workflow/run");
  const entry = componentEntry({ kind: "workflow", moduleId: "memory", moduleTitle: "记忆", value: { id: "memory/run", kind: "turn-background", nodes: [] } });
  assert.equal(entry.key, "module/memory/workflow/run");
  assert.equal(entry.moduleId, "memory");
  assert.deepEqual(entry.fields, []);
});

test("区域声明的集合不是 settings 时仍能读到作者默认值", async () => {
  // 这正是真实缺陷：卡侧把集合硬编码为 settings，narrative-memory 的设置在 support 集合。
  const module = moduleWith({
    regions: [settingsRegion()],
    collections: { support: { storage: { kind: "snapshot", initialSnapshotFile: "collections/support/initial/snapshot.json" } } },
    documents: { "collections/support/initial/snapshot.json": { id: "demo-settings-current", recordType: "demo.settings", data: { enabled: true } } },
  });
  const entry = await moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) });
  assert.deepEqual(entry.base, { enabled: true });
  assert.deepEqual(entry.problems, []);
});

test("initialRecordsFile（记录日志集合）也被支持并精确选择", async () => {
  const module = moduleWith({
    regions: [settingsRegion()],
    collections: { support: { storage: { kind: "record-log", initialRecordsFile: "collections/support/initial/records.json" } } },
    documents: {
      "collections/support/initial/records.json": [
        { id: "other", recordType: "demo.settings", data: { enabled: false } },
        { id: "demo-settings-current", recordType: "demo.settings", data: { enabled: true, note: "选中" } },
      ],
    },
  });
  const entry = await moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) });
  assert.deepEqual(entry.base, { enabled: true, note: "选中" });
});

test("指定 recordId 缺失时不得回退到唯一同类型记录", async () => {
  const resolved = await resolveSettingsRegionDefaults({
    region: settingsRegion(),
    contract: contractWith({ support: { storage: { kind: "snapshot", initialSnapshotFile: "s.json" } } }),
    readDocument: async () => [{ id: "another", recordType: "demo.settings", data: { enabled: true } }],
  });
  assert.deepEqual(resolved.base, {});
  assert.match(resolved.reason, /demo-settings-current/);
});

test("snapshot 数组按精确 ID 选择后续记录", async () => {
  const resolved = await resolveSettingsRegionDefaults({
    region: settingsRegion(),
    contract: contractWith({ support: { storage: { kind: "snapshot", initialSnapshotFile: "s.json" } } }),
    readDocument: async () => [
      { id: "another", recordType: "demo.settings", data: { enabled: false } },
      { id: "demo-settings-current", recordType: "demo.settings", data: { enabled: true } },
    ],
  });
  assert.deepEqual(resolved.base, { enabled: true });
  assert.equal(resolved.reason, null);
});

test("recordType 存在歧义时必须报告而不是静默取第一条", async () => {
  const module = moduleWith({
    regions: [settingsRegion({ recordId: undefined })],
    collections: { support: { storage: { kind: "record-log", initialRecordsFile: "collections/support/initial/records.json" } } },
    documents: {
      "collections/support/initial/records.json": [
        { id: "a", recordType: "demo.settings", data: { enabled: false } },
        { id: "b", recordType: "demo.settings", data: { enabled: true } },
      ],
    },
  });
  const entry = await moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) });
  assert.deepEqual(entry.base, {}, "歧义时不得返回值");
  assert.equal(entry.problems.length, 1);
  assert.match(entry.problems[0], /demo\.settings/);
  assert.match(entry.problems[0], /匹配到 2 条记录/);
  assert.match(entry.problems[0], /拒绝静默取第一条/);
});

test("缺失记录与缺失文件都报告为问题，默认值为空", async () => {
  const module = moduleWith({
    regions: [settingsRegion()],
    collections: { support: { storage: { kind: "snapshot", initialSnapshotFile: "collections/support/initial/snapshot.json" } } },
    documents: {},
  });
  const entry = await moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) });
  assert.deepEqual(entry.base, {});
  assert.equal(entry.problems.length, 1);
  assert.match(entry.problems[0], /不存在/);
});

test("同一字段路径出现在两个区域时必须报告，不静默互相覆盖", async () => {
  const regionA = settingsRegion({ id: "region-a", fields: [{ path: "/data/enabled", label: "启用", type: "boolean" }] });
  const regionB = settingsRegion({ id: "region-b", recordId: "other-record", fields: [{ path: "/data/enabled", label: "启用", type: "boolean" }] });
  const module = moduleWith({
    regions: [regionA, regionB],
    collections: { support: { storage: { kind: "snapshot", initialSnapshotFile: "collections/support/initial/snapshot.json" } } },
    documents: { "collections/support/initial/snapshot.json": { id: "demo-settings-current", recordType: "demo.settings", data: { enabled: true } } },
  });
  await assert.rejects(moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) }), /在区域.*冲突/);
});

test("区域未声明集合时报告问题，不抛异常", async () => {
  const module = moduleWith({
    regions: [settingsRegion({ collectionId: "nope" })],
    collections: { support: { storage: { kind: "snapshot", initialSnapshotFile: "x.json" } } },
    documents: {},
  });
  const entry = await moduleCatalogEntry({ module, readDocument: readerFrom(module.documents) });
  assert.deepEqual(entry.base, {});
  assert.equal(entry.problems.length, 1);
  assert.match(entry.problems[0], /不在数据契约中/);
});

test("buildConfigCatalog 把作者默认值与覆盖层分开返回", async () => {
  const module = moduleWith({
    regions: [settingsRegion()],
    collections: { support: { storage: { kind: "snapshot", initialSnapshotFile: "collections/support/initial/snapshot.json" } } },
    documents: { "collections/support/initial/snapshot.json": { id: "demo-settings-current", recordType: "demo.settings", data: { enabled: true } } },
  });
  const catalog = await buildConfigCatalog({
    modules: [module],
    readModuleDocument: (relativePath) => readerFrom(module.documents)(relativePath),
    listAgents: async () => [{ moduleId: "demo", moduleTitle: "演示模块", base: { id: "demo/writer" } }],
    listWorkflows: async () => [{ ownerModuleId: "demo", moduleTitle: "演示模块", base: { id: "demo/run", kind: "turn-background", nodes: [] } }],
    includeRuntimePolicy: true,
    getRuntimePolicy: async () => ({ maxConcurrency: 10 }),
  });
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.agents.length, 1);
  assert.equal(catalog.workflows.length, 1);
  assert.equal(catalog.modules.length, 1);
  // 目录项的 base 是**作者默认值**；覆盖层属于配置方案，不在这里合并。
  assert.deepEqual(catalog.modules[0].base, { enabled: true });
  assert.deepEqual(catalog.runtimePolicy, { maxConcurrency: 10 });
});

test("resolveSettingsRegionDefaults 直接调用时也遵守同一套选择规则", async () => {
  const contract = contractWith({
    support: { storage: { kind: "snapshot", initialSnapshotFile: "s.json" } },
  });
  const resolved = await resolveSettingsRegionDefaults({
    region: settingsRegion(),
    contract,
    readDocument: async () => ({ id: "demo-settings-current", recordType: "demo.settings", data: { enabled: false } }),
  });
  assert.deepEqual(resolved.base, { enabled: false });
  assert.equal(resolved.source, "s.json");
  assert.equal(resolved.reason, null);

  const missing = await resolveSettingsRegionDefaults({
    region: settingsRegion({ collectionId: "absent" }),
    contract,
    readDocument: async () => null,
  });
  assert.deepEqual(missing.base, {});
  assert.match(missing.reason, /不在数据契约中/);
});

// 以下用例针对**真实资产**，防止共享实现与发布模块脱节。
test("真实模块：narrative-memory 的设置来自 support 集合而不是 settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { loadModuleComponents } = await import("./rp-module-registry.mjs");
  const { normalizeDataContract } = await import("./rp-data-contracts.mjs");
  const { normalizeModuleFrontendView } = await import("./rp-module-frontend.mjs");

  // 从本文件定位仓库根：.pi/lib -> .pi -> pi-rp-runtime -> assets -> st-card-to-pi-rp -> skills -> .agents -> 仓库根
  const root = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "../../../../../../..");
  const moduleDirectory = resolve(root, "global-modules", "narrative-memory");

  const manifest = await loadModuleComponents(moduleDirectory);
  const contract = normalizeDataContract(JSON.parse(await readFile(resolve(moduleDirectory, manifest.dataContractFile), "utf8")), manifest.id);
  const view = normalizeModuleFrontendView(JSON.parse(await readFile(resolve(moduleDirectory, manifest.frontendViewFile), "utf8")), contract);
  const region = (view.regions || []).find((item) => item.type === "settings-form");

  // 前提：该模块的设置**不在**名为 settings 的集合里。若将来改了布局，这条断言会提醒更新用例。
  assert.notEqual(region.collectionId, "settings", "该用例的前提是设置不在 settings 集合");
  assert.equal(contract.collections[region.collectionId] !== undefined, true);

  const entry = await moduleCatalogEntry({
    module: { ...manifest, contract, view },
    readDocument: async (relativePath) => JSON.parse(await readFile(resolve(moduleDirectory, relativePath), "utf8")),
  });
  assert.ok(Object.keys(entry.base).length > 0, "必须取到作者默认值（旧实现因硬编码 settings 返回空对象）");
  assert.deepEqual(entry.problems, []);
});
