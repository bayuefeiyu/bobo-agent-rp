// 前端运行期测试辅助：一个足以运行真实 app.js 的最小 DOM + fetch 替身。
//
// 为什么需要它：方案 §11 的验收含**运行期行为**项——"开发预览 / 未开始聊天 / 活跃聊天三种状态
// 都可初始化，无缺失 DOM 错误"，以及"轮询更新不能覆盖正在编辑的草稿或重复绑定监听器"。
// 这些用字符串匹配断言无法验证。沙箱内没有 jsdom/happy-dom（且不引入新依赖），
// 因此按仓库既有先例（markdown.test.mjs 的 FakeNode）扩展出一个够用的替身。
//
// 设计要点：
// - 所有元素 id 从真实 index.html 解析，因此"页面缺少某个被查询的 id"会真的暴露成 null；
// - 记录每个节点的 addEventListener 次数，用于断言"未重复绑定"；
// - 定时器被捕获而非真正调度，使轮询行为可控可断言。
import { readFileSync } from "node:fs";

const PUBLIC = new URL("../public/", import.meta.url);

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  contains(name) { return this.set.has(name); }
}

export class FakeNode {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = { setProperty() {}, removeProperty() {} };
    this.listeners = new Map();
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.files = [];
    this.options = [];
    this.open = false;
    this.inert = false;
  }

  get className() { return [...this.classList.set].join(" "); }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; }

  get innerHTML() { return this._text; }
  set innerHTML(value) { this._text = String(value ?? ""); this.children = []; }

  get firstChild() { return this.children[0] ?? null; }
  get childNodes() { return this.children; }
  get childrenCount() { return this.children.length; }

  append(...nodes) { for (const node of nodes) if (node) this.children.push(node); }
  appendChild(node) { if (node) this.children.push(node); return node; }
  prepend(...nodes) { this.children.unshift(...nodes.filter(Boolean)); }
  insertBefore(node) { this.children.unshift(node); return node; }
  replaceChildren(...nodes) { this.children = nodes.filter(Boolean); }
  remove() { this.removed = true; }
  removeAttribute(name) { delete this.attributes[name]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  closest() { return null; }
  contains() { return false; }
  focus() {}
  blur() {}
  click() { this.dispatch("click"); }
  scrollIntoView() {}
  scrollTo() { this.scrolledTo = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  // 表单方法：真实 app.js 会调用 form.reset() / form.submit()。
  // 替身缺它们时抛出的错误会被 showError 吞进错误横幅，看起来像页面缺陷。
  reset() { this.value = ""; this.checked = false; for (const child of this.children) if (child.reset) child.reset(); }
  submit() { this.dispatch("submit"); }
  checkValidity() { return true; }
  reportValidity() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== handler));
  }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  totalListeners() { return [...this.listeners.values()].reduce((n, list) => n + list.length, 0); }
  dispatch(type, event = {}) {
    const payload = { type, preventDefault() {}, stopPropagation() {}, target: this, ...event };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(payload);
  }
}

/** 从真实 index.html 收集所有 id 与带 data-panel 的标签页，构造 id -> 节点 的登记表。 */
export function buildElementsFromHtml() {
  const html = readFileSync(new URL("index.html", PUBLIC), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map();
  for (const id of ids) elements.set(id, new FakeNode(id.startsWith("panel-") ? "section" : "div"));
  // 初始 `hidden` 必须按真实 HTML 设置：这些标签上写了 `hidden` 属性。
  // 否则 `showError` 从未被调用也会被误判为"错误横幅已显示"（替身造成的假阳性）。
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const node = elements.get(match[1]);
    if (node) node.hidden = /\shidden(\s|>|\/)/.test(tag);
  }
  // 标签页按钮：页面里带 data-panel 的 button
  const tabButtons = [];
  for (const match of html.matchAll(/<button[^>]*id="(tab-[^"]+)"[^>]*data-panel="([^"]+)"/g)) {
    const node = elements.get(match[1]) || new FakeNode("button");
    node.dataset.panel = match[2];
    if (!elements.has(match[1])) elements.set(match[1], node);
    tabButtons.push(node);
  }
  return { elements, ids, tabButtons, html };
}

/** 每个节点都返回一个可用的节点，避免替身自身造成"缺失 DOM"假阳性。 */
function makeDocument(elements) {
  const body = new FakeNode("body");
  const documentElement = new FakeNode("html");
  const document = {
    body,
    documentElement,
    title: "",
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => { const node = new FakeNode("#text"); node.textContent = text; return node; },
    createDocumentFragment: () => new FakeNode("#fragment"),
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (selector) => (selector.startsWith("#") ? elements.get(selector.slice(1)) ?? null : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  return document;
}

/**
 * 建立一个可以运行 app.js 的运行环境。
 *
 * @param {object} options
 * @param {Record<string, any>} options.responses 形如 `{"GET /api/card": {...}}` 的响应表；
 *   值可为对象或 `() => object`；未登记的 `/api/*` 请求返回 `{}`（并计入 `unknownRequests`）。
 */
export function createFrontendRuntime({ responses = {}, search = "" } = {}) {
  const { elements, ids, tabButtons, html } = buildElementsFromHtml();
  const document = makeDocument(elements);

  const timers = new Map();
  let timerSeq = 0;
  const window = {
    document,
    location: { search, hash: "", href: `http://127.0.0.1/?${search.replace(/^\?/, "")}` },
    setInterval(handler, delay) { const id = ++timerSeq; timers.set(id, { handler, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(handler) { const id = ++timerSeq; timers.set(id, { handler, delay: 0, once: true }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    alert() {},
    prompt: () => null,
    requestAnimationFrame: (handler) => { handler(); return 0; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  const requests = [];
  const unknownRequests = [];
  const fetchImpl = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const key = `${method} ${String(path).split("?")[0]}`;
    requests.push({ method, path, key });
    let body = responses[key];
    if (body === undefined) body = responses[`GET ${String(path).split("?")[0]}`];
    if (body === undefined) {
      if (String(path).startsWith("/api/")) unknownRequests.push(key);
      body = {};
    }
    const value = typeof body === "function" ? body({ method, path, options }) : body;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => value,
      text: async () => JSON.stringify(value),
    };
  };

  const globals = {
    document,
    window,
    fetch: fetchImpl,
    // app.js 里 `requestAnimationFrame(...)` 是**不带前缀**调用的（浏览器把它暴露为全局），
    // 因此必须装在 globalThis 上；只放进 window 不够。
    requestAnimationFrame: (handler) => { handler(0); return 0; },
    cancelAnimationFrame() {},
    // 浏览器全局：真实 app.js 会用到 `new Option(text, value)`。
    // 缺它时 initialize 会在 renderModelSelectors 处抛错，而该错误被
    // `initialize().catch(showError)` 捕获进错误横幅——于是替身的缺陷会伪装成"页面坏了"。
    // 因此替身必须补齐这类名字；这也正是运行期测试的价值：它真的会暴露缺失的全局。
    Option: class Option extends FakeNode {
      constructor(text = "", value = "", defaultSelected = false, selected = false) {
        super("option");
        this.textContent = text;
        this.value = value;
        this.defaultSelected = defaultSelected;
        this.selected = selected;
      }
    },
  };
  return { elements, ids, tabButtons, html, document, window, timers, requests, unknownRequests, globals, fetchImpl };
}

/**
 * 把替身挂到 globalThis，然后动态导入真实前端模块（导入即执行模块级装配）。
 *
 * 两点必须注意：
 * 1. Node 的 `globalThis.crypto` 是**只读**访问器（Node 24），直接赋值会抛
 *    `Cannot set property crypto of #<Object> which has only a getter`；
 *    因此统一用 `Object.defineProperty` 安装。crypto 已有原生实现，无需替身。
 * 2. 替身**不能**在 import 返回后立刻卸下：app.js 末尾是 `initialize().catch(showError)`，
 *    它的后续 await 与定时回调仍需要 `window`/`document`/`fetch`。因此由调用方在
 *    teardown 时显式清理（返回 restore 函数）。
 */
export async function importWithRuntime(modulePath, runtime) {
  const saved = new Map();
  for (const [key, value] of Object.entries(runtime.globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  }
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
  try {
    const module = await import(modulePath);
    return { module, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

/** 让事件循环推进若干轮，使 app.js 的启动 await 链完成。 */
export async function settle(turns = 40) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/**
 * 构造三种页面状态之一所需的 `/api/*` 响应。
 *
 * 方案 §11 验收项要求"开发预览、未开始聊天、活跃聊天三种状态都可初始化"。
 * 三者的差别集中在 `/api/state` 快照上：
 *   - `development-preview`：根目录预览，没有角色卡与聊天；
 *   - `not-started`：已选卡、已有开场白候选，但尚未选定；
 *   - `active-chat`：已有 openingId 与消息。
 * 其余端点返回结构合法的最小载荷，使真实的 initialize 能完整跑完。
 */
export function createStateFixtures(kind, overrides = {}) {
  const baseSnapshot = {
    previewMode: false, openingId: null, playerName: "玩家", messages: [], busy: false,
    blockingWorkflows: [], lastTurnFailure: null, sessionId: null,
    selectorUrl: null, isolatedRuntime: false,
  };
  const snapshots = {
    "development-preview": { ...baseSnapshot, previewMode: true, playerName: "玩家" },
    "not-started": { ...baseSnapshot, cardId: "demo-card", openingId: null },
    "active-chat": {
      ...baseSnapshot,
      cardId: "demo-card",
      openingId: "opening-1",
      sessionId: "session-1",
      messages: [
        { sequence: 1, turn: 1, role: "user", kind: "message", content: "你好", createdAt: "2026-10-09T00:00:00.000Z" },
        { sequence: 2, turn: 1, role: "assistant", kind: "message", content: "你好，旅人。", createdAt: "2026-10-09T00:00:01.000Z" },
      ],
    },
  };
  if (!snapshots[kind]) throw new Error(`unknown state fixture: ${kind}`);
  const { snapshot: snapshotOverride, ...rest } = overrides;
  const responses = {
    "GET /api/card": { id: "demo-card", name: "沈月", openings: [{ id: "opening-1", title: "初见", content: "沈月看向{{user}}。" }] },
    "GET /api/state": { ...snapshots[kind], ...(snapshotOverride || {}) },
    "GET /api/settings": {
      common: { system: { fontSize: 16 }, user: { playerName: "玩家", description: "", savedProfiles: [{ name: "玩家", description: "" }] } },
      card: { settings: { featureModules: { order: [], hidden: [] } } },
    },
    "GET /api/modules": { modules: [] },
    "GET /api/image-generation": { available: true, profiles: [], connections: [], preferences: null, requests: [], renders: [] },
    "GET /api/models": { current: { id: "pi:current", name: "当前 Pi 模型", virtual: true }, profiles: [] },
    "GET /api/workflow-policy": { schemaVersion: 1, maxConcurrency: 10, modelFailure: { silentFallback: false, defaultFallbackModelId: null } },
    "GET /api/agents": { agents: [] },
    "GET /api/workflows": { workflows: [], activeWorkflowId: null },
    "GET /api/workflow-runs": { runs: [] },
    "GET /api/cards": [{ id: "demo-card", name: "沈月", hasCover: false }],
    "GET /api/sessions": [],
    ...rest,
  };
  return responses;
}
