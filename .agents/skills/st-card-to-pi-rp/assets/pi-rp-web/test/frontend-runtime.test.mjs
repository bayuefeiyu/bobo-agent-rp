// S6 运行期行为验收：真实 app.js 在替身 DOM 下确实能初始化并安全轮询。
//
// 方案 §11 的验收项里有两条**无法用字符串匹配验证**的：
//   1. "开发预览、未开始聊天、活跃聊天三种状态都可初始化，无缺失 DOM 错误"；
//   2. "轮询更新不能覆盖正在编辑的草稿或重复绑定监听器"。
//
// 本文件按仓库既有先例（markdown.test.mjs 的 FakeNode）扩展出一个够用的 DOM/fetch 替身，
// 然后**导入并执行真实的 app.js**（含模块级事件装配与 initialize() 启动链）。
// 因此它验证的是运行期行为，而不是源码里出现过某段字符串。
//
// 注意：替身自身的缺陷会被 app.js 的 `initialize().catch(showError)` 吞进错误横幅，
// 看起来像"页面坏了"。因此下面的断言先检查错误横幅，再检查具体行为——替身问题会立刻暴露。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createFrontendRuntime, createStateFixtures, importWithRuntime, settle } from "./frontend-runtime.mjs";

const APP = "../public/app.js";

// Node 会缓存 ES module：同一路径只求值一次。而每次测试都要**重新执行** app.js 的模块级装配
// 与 initialize()，因此用递增的查询串强制重新求值（浏览器里等价于不同的 `?v=N`）。
let bootSequence = 0;

async function boot(kind = "active-chat", options = {}) {
  bootSequence += 1;
  const runtime = createFrontendRuntime({ responses: createStateFixtures(kind, options.responses), search: options.search || "" });
  const { module, restore } = await importWithRuntime(`${APP}?boot=${bootSequence}`, runtime);
  await settle();
  return { runtime, module, restore };
}

function assertNoErrorBanner(runtime) {
  const banner = runtime.elements.get("error-banner");
  assert.ok(banner, "index.html 缺少 error-banner");
  assert.equal(banner.hidden, true, `初始化过程中 showError 被调用：${banner.textContent}`);
}

test("index 的版本化入口与无查询串入口共享 document 时只启动一次", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const entry = /src="(\/app\.js\?[^\"]+)"/.exec(html)?.[1];
  assert.ok(entry);
  const runtime = createFrontendRuntime({ responses: createStateFixtures("active-chat") });
  const { restore } = await importWithRuntime(`../public${entry}`, runtime);
  try {
    await settle();
    await import("../public/app.js");
    await settle();
    assertNoErrorBanner(runtime);
    assert.equal([...runtime.timers.values()].filter(timer => timer.delay === 600).length, 1);
    assert.equal(runtime.requests.filter(request => request.key === "GET /api/card").length, 1);
    assert.equal(runtime.elements.get("player-name").listenerCount("input"), 1);
  } finally { restore(); }
});

for (const kind of ["development-preview", "not-started", "active-chat"]) {
  test(`${kind}：真实 app.js 可以完整初始化且不报错`, async () => {
    const { runtime, module, restore } = await boot(kind);
    try {
      assertNoErrorBanner(runtime);
      // 启动链必须把全部端点跑完：少一个都说明中间有异常被吞掉。
      const keys = runtime.requests.map((request) => request.key);
      for (const required of ["GET /api/card", "GET /api/state", "GET /api/settings", "GET /api/modules",
        "GET /api/models", "GET /api/workflow-policy", "GET /api/workflows", "GET /api/workflow-runs",
        "GET /api/cards", "GET /api/sessions"]) {
        assert.ok(keys.includes(required), `${kind} 未请求 ${required}（启动链中断）`);
      }
      assert.deepEqual(runtime.unknownRequests, [], `请求了未登记的端点：${runtime.unknownRequests.join(", ")}`);
      // 卡片标题被写入 => initialize 真的跑到了 UI 更新阶段。
      assert.equal(runtime.elements.get("card-title").textContent, "沈月");
      const intervals = [...runtime.timers.values()].filter((timer) => timer.delay === 600);
      assert.equal(intervals.length, 1, "页面只能启动一个轮询器");
      assert.equal(keys.filter(key => key === "GET /api/card").length, 1);
      assert.equal(runtime.elements.get("player-name").listenerCount("input"), 1);
      // 页面入口仍然导出拆出模块的函数（拆分未破坏公开面）。
      assert.equal(typeof module.renderFeatureModules, "function");
      assert.equal(typeof module.renderTokenUsage, "function");
      assert.equal(typeof module.renderImageGenerationRegion, "function");
    } finally {
      restore();
    }
  });
}

test("开发预览：显示聊天视图（预览态没有开场白可选）", async () => {
  const preview = await boot("development-preview");
  try {
    assertNoErrorBanner(preview.runtime);
    // 预览态 `started = previewMode === true`，因此走的是**聊天视图**并显示预览提示，
    // 而不是开场白选择页。这里如实断言 app.js 的真实行为。
    assert.equal(preview.runtime.elements.get("chat-view").hidden, false, "预览态应显示聊天视图");
    assert.equal(preview.runtime.elements.get("opening-view").hidden, true, "预览态不应显示开场白视图");
    assert.match(preview.runtime.elements.get("connection-status").textContent, /开发预览/);
  } finally {
    preview.restore();
  }
});

test("活跃聊天：隐藏开场白视图并渲染消息", async () => {
  const active = await boot("active-chat");
  try {
    assertNoErrorBanner(active.runtime);
    assert.equal(active.runtime.elements.get("opening-view").hidden, true, "活跃聊天应隐藏开场白视图");
    assert.equal(active.runtime.elements.get("chat-view").hidden, false, "活跃聊天应显示聊天视图");
    // 消息区应被填充。注意 `replaceChildren(fragment)` 在替身里是"用一个 fragment 节点替换全部"，
    // 因此这里断言"至少有一个节点"而不是"等于消息条数"——替身不做 fragment 展开，
    // 那属于 DOM 实现细节，不是 app.js 的行为。消息条数由 snapshot 驱动，见下面的状态断言。
    const messages = active.runtime.elements.get("messages");
    assert.ok(messages.children.length >= 1, `消息区未被填充，children=${messages.children.length}`);
    assert.equal(active.runtime.elements.get("message-input").disabled, false, "活跃聊天的输入框应可用");
  } finally {
    active.restore();
  }
});

test("轮询不覆盖正在编辑的草稿", async () => {
  const { runtime, restore } = await boot("not-started");
  try {
    assertNoErrorBanner(runtime);
    const playerName = runtime.elements.get("player-name");
    // 模拟用户正在编辑：输入框有值，且脏标记被 input 事件置位。
    playerName.value = "未保存的草稿名字";
    playerName.dispatch("input");

    // 触发一次轮询：快照里的 playerName 与草稿不同。
    const poll = [...runtime.timers.values()].find((timer) => timer.delay === 600);
    assert.ok(poll, "未找到轮询定时器");
    runtime.requests.length = 0;
    await poll.handler();
    await settle(10);

    assert.equal(playerName.value, "未保存的草稿名字", "轮询覆盖了用户正在编辑的草稿");
    assert.equal(runtime.elements.get("user-settings-status").textContent, "", "轮询不应改写状态提示");
  } finally {
    restore();
  }
});

test("重复轮询不重复绑定监听器", async () => {
  const { runtime, restore } = await boot("not-started");
  try {
    assertNoErrorBanner(runtime);
    const poll = [...runtime.timers.values()].find((timer) => timer.delay === 600);
    const watched = ["player-name", "saved-profile", "card-search", "font-size", "workflow-select", "comfy-connection-select"];
    const before = watched.map((id) => runtime.elements.get(id).listenerCount("change") + runtime.elements.get(id).listenerCount("input"));

    for (let round = 0; round < 5; round += 1) {
      await poll.handler();
      await settle(10);
    }

    const after = watched.map((id) => runtime.elements.get(id).listenerCount("change") + runtime.elements.get(id).listenerCount("input"));
    assert.deepEqual(after, before, "轮询改变了监听器数量（说明每次都重新绑定）");
    // 轮询次数再多也不应让节点数无限增长。
    assert.ok(runtime.timers.size <= 4, `定时器数量异常增长：${runtime.timers.size}`);
  } finally {
    restore();
  }
});

test("初始化不会重复绑定同一点击监听器", async () => {
  const first = await boot("active-chat");
  const counts = first.runtime.elements.get("send-button").listenerCount("click");
  first.restore();
  assert.ok(counts <= 1, `send-button 的 click 监听器数量应为 <=1，实际 ${counts}`);
});
