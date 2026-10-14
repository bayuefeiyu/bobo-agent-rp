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

import { createFrontendRuntime, createStateFixtures, importWithRuntime, settle, FakeNode } from "./frontend-runtime.mjs";

const APP = "../public/app.js";
const flattenNodes = node => [node, ...node.children.flatMap(flattenNodes)];
const viewV3 = (bindings, regions) => ({ schemaVersion: 3, bindings, regions });

test("module visibility and ordering save automatically, serializing rapid changes", async () => {
  let release;
  const writes = [];
  const modules = ["a", "b"].map(id => ({ id, title: id, available: true, revision: "initial", view: viewV3([], []) }));
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/modules": { sessionId: "test-session", modules },
    "POST /api/v1/module-display-settings": async ({ options }) => {
      const value = JSON.parse(options.body); writes.push(value);
      if (writes.length === 1) await new Promise(resolve => { release = resolve; });
      return { card: { settings: { featureModules: value } } };
    },
  } });
  try {
    const list = runtime.elements.get("module-settings-list");
    const checkboxes = flattenNodes(list).filter(n => n.type === "checkbox");
    checkboxes[0].checked = false; checkboxes[0].dispatch("change");
    checkboxes[1].checked = false; checkboxes[1].dispatch("change");
    flattenNodes(list).find(n => n.getAttribute("aria-label") === "下移 a").dispatch("click");
    await settle(); assert.equal(writes.length, 1); release(); await settle();
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], { order: ["b", "a"], hidden: ["a", "b"] });
    assert.equal(runtime.elements.has("save-module-settings"), false);
    assert.match(runtime.elements.get("module-settings-status").textContent, /已保存/);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("saved Comfy connections load independently when image workflow data fails, and failed list loading can be retried", async () => {
  let fail = true;
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/image-generation": () => { throw new Error("broken image workflow"); },
    "GET /api/v1/image-generation/connections": () => { if (fail) throw new Error("connection read failed"); return { connections: [{ id: "local", title: "本机", baseUrl: "http://127.0.0.1:8188", selected: true, hasToken: true }] }; },
  } });
  try {
    assert.match(runtime.elements.get("comfy-connection-status").textContent, /读取失败/);
    assert.equal(runtime.elements.get("comfy-reload-connections").hidden, false);
    fail = false; runtime.elements.get("comfy-reload-connections").dispatch("click"); await settle();
    assert.equal(runtime.elements.get("comfy-connection-select").value, "local");
    assert.equal(runtime.elements.get("comfy-connection-title").value, "本机");
    assert.match(runtime.elements.get("comfy-connection-token").placeholder, /已保存凭据/);
    assert.equal(runtime.elements.get("comfy-reload-connections").hidden, true);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("module tabs load lazily, preserve drafts across tab switches and refresh, and settings save on change or blur", async () => {
  const fields = [
    { path: "/enabled", type: "boolean", label: "Enabled" },
    { path: "/text", type: "text", label: "Text" },
    { path: "/count", type: "integer", label: "Count", minimum: 1 },
  ];
  const settingsRegion = { id: "settings", type: "settings-form", title: "Settings", bindingId: "settings" };
  const recordsRegion = { id: "records", title: "Records", type: "record-browser", bindingId: "records" };
  const feature = { id: "test", title: "Test module", available: true, revision: "initial", view: viewV3([
    { id: "settings", kind: "settings", fields },
    { id: "records", kind: "records" },
  ], [settingsRegion, recordsRegion]) };
  let revision = 1, values = { "/enabled": false, "/text": "old", "/count": 1 };
  const writes = [];
  const { runtime, module, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/modules": { sessionId: "test-session", modules: [feature] },
    "GET /api/v1/modules/test/bindings/settings/settings": () => ({ record: { revision }, values: { ...values } }),
    "PUT /api/v1/modules/test/bindings/settings/settings": ({ options }) => { const body = JSON.parse(options.body); writes.push(body); assert.equal(body.expectedRevision, revision); Object.assign(values, body.values); revision++; return { saved: true }; },
    "GET /api/v1/modules/test/bindings/records/records": { items: [], returned: 0 },
  } });
  try {
    const list = runtime.elements.get("card-module-list");
    assert.equal(runtime.requests.some(r => r.key.includes("bindings/settings/settings")), false);
    flattenNodes(list).find(n => n.classList.contains("module-toggle")).dispatch("click"); await settle();
    let nodes = flattenNodes(list);
    const input = path => nodes.find(n => n.dataset.fieldPath === path);
    assert.equal(nodes.some(n => n.tagName === "BUTTON" && /保存/.test(n.textContent)), false);
    input("/enabled").checked = true; input("/enabled").dispatch("change"); await settle();
    assert.deepEqual(writes[0].values, { "/enabled": true });
    const text = input("/text"); text.value = "draft"; text.dispatch("input"); await settle(); assert.equal(writes.length, 1);
    const tabs = nodes.filter(n => n.getAttribute("role") === "tab");
    tabs[1].dispatch("click"); await settle(); tabs[0].dispatch("click"); await settle();
    assert.equal(text.value, "draft");
    module.renderFeatureModules({ sessionId: "test-session", modules: [{ ...feature, revision: "changed" }] }); await settle();
    assert.equal(flattenNodes(list).includes(text), true); assert.equal(text.value, "draft");
    text.dispatch("blur"); await settle(); assert.equal(values["/text"], "draft");
    const count = input("/count"); count.value = "0"; count.checkValidity = () => false; count.dispatch("input"); count.dispatch("blur"); await settle();
    assert.equal(writes.length, 2); assert.equal(count.getAttribute("aria-invalid"), "true");
    assert.equal(count.parentNode.querySelector(".field-error") != null, true);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("prompt groups show only their own selected prompt below each dial and autosave custom text on blur", async () => {
  const controls = { groups: ["pace", "voice"].map(id => ({ id, title: id, options: [{ id: "a", label: "A", content: `## ${id} prompt` }, { id: "custom", label: "Custom" }] })) };
  const region = { id: "prompt", type: "prompt-controls", title: "Prompt", bindingId: "prompt" };
  const view = viewV3([{ id: "prompt", kind: "prompts", controls }], [region]);
  let revision = 1, values = { "/selections/pace/optionId": "a", "/selections/voice/optionId": "a" };
  const writes = [];
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/modules": { sessionId: "test-session", modules: [{ id: "test", title: "Test", available: true, revision: "initial", view }] },
    "GET /api/v1/modules/test/bindings/prompt/settings": () => ({ record: { revision }, values: { ...values }, controls }),
    "PUT /api/v1/modules/test/bindings/prompt/settings": ({ options }) => { const body = JSON.parse(options.body); writes.push(body); Object.assign(values, body.values); revision++; return { saved: true }; },
  } });
  try {
    const list = runtime.elements.get("card-module-list"); flattenNodes(list).find(n => n.classList.contains("module-toggle")).dispatch("click"); await settle();
    const nodes = flattenNodes(list), groups = nodes.filter(n => n.classList.contains("prompt-control-group"));
    assert.equal(groups.length, 2); assert.match(groups[0].textContent, /pace prompt/); assert.doesNotMatch(groups[0].textContent, /voice prompt/);
    assert.equal(nodes.some(n => n.classList.contains("prompt-control-preview")), false);
    const custom = flattenNodes(groups[0]).find(n => n.type === "radio" && n.value === "custom"); custom.dispatch("change"); await settle();
    assert.equal(values["/selections/pace/optionId"], "custom");
    const text = flattenNodes(groups[0]).find(n => n.tagName === "TEXTAREA"); text.value = "my custom prompt"; text.dispatch("input"); await settle(); assert.equal(writes.length, 1);
    text.dispatch("blur"); await settle(); assert.equal(values["/selections/pace/customText"], "my custom prompt");
    assert.equal(flattenNodes(groups[0]).find(n => n.classList.contains("prompt-control-inline-preview")).hidden, true);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("long memory settings use sub-tabs, keeping blur saves and values when switching groups", async () => {
  const fields = [
      { path: "/archive/enabled", type: "boolean", label: "Enabled" },
      { path: "/retrieval/entityQueryLimit", type: "integer", label: "Limit", minimum: 1 },
      { path: "/compression/enabled", type: "boolean", label: "Compression" },
  ];
  const feature = { id: "narrative-memory", title: "Memory", available: true, revision: "initial", view: viewV3([
    { id: "memory-settings", kind: "settings", fields },
  ], [{ id: "memory-settings", type: "settings-form", title: "Settings", bindingId: "memory-settings" }]) };
  let revision = 1, values = { "/archive/enabled": false, "/retrieval/entityQueryLimit": 2, "/compression/enabled": false };
  const writes = [];
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/modules": { sessionId: "session-1", modules: [feature] },
    "GET /api/v1/modules/narrative-memory/bindings/memory-settings/settings": () => ({ record: { revision }, values: { ...values } }),
    "PUT /api/v1/modules/narrative-memory/bindings/memory-settings/settings": ({ options }) => { const body = JSON.parse(options.body); writes.push(body); Object.assign(values, body.values); revision++; return { saved: true }; },
  } });
  try {
    const list = runtime.elements.get("card-module-list"); flattenNodes(list).find(n => n.classList.contains("module-toggle")).dispatch("click"); await settle();
    let nodes = flattenNodes(list);
    assert.equal(nodes.some(n => n.dataset.fieldPath === "/retrieval/entityQueryLimit"), false);
    nodes.find(n => n.getAttribute("role") === "tab" && n.textContent === "检索").dispatch("click");
    nodes = flattenNodes(list); const input = nodes.find(n => n.dataset.fieldPath === "/retrieval/entityQueryLimit"); input.value = "7"; input.dispatch("input"); input.dispatch("blur"); await settle();
    assert.equal(values["/retrieval/entityQueryLimit"], 7); assert.equal(writes[0].expectedSessionId, "session-1");
    nodes.find(n => n.getAttribute("role") === "tab" && n.textContent === "压缩").dispatch("click");
    nodes.find(n => n.getAttribute("role") === "tab" && n.textContent === "检索").dispatch("click");
    assert.equal(input.value, "7"); assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("module data refresh preserves loaded story pages and an opened story", async () => {
  const feature = { id: "stories", title: "Stories", available: true, revision: "initial", view: viewV3([
    { id: "list", kind: "stories" },
  ], [{ id: "list", type: "story-browser", title: "Stories", bindingId: "list" }]) };
  const item = id => ({ id, revision: 1, value: { summary: id, locations: ["place"], timeRange: "now" } });
  const { runtime, module, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/modules": { sessionId: "session-1", modules: [feature] },
    "GET /api/v1/modules/stories/bindings/list/records": ({ path }) => path.includes("cursor=page2") ? { items: [item("s2")], nextCursor: null } : { items: [item("s1")], nextCursor: "page2" },
    "GET /api/v1/modules/stories/bindings/list/stories/s1": { value: { content: "full story" } },
  } });
  try {
    const list = runtime.elements.get("card-module-list"); flattenNodes(list).find(n => n.classList.contains("module-toggle")).dispatch("click"); await settle();
    flattenNodes(list).find(n => n.tagName === "BUTTON" && n.textContent === "更多故事").dispatch("click"); await settle();
    assert.equal(flattenNodes(list).filter(n => n.classList.contains("module-story-card")).length, 2, JSON.stringify(runtime.requests.map(r => r.key)));
    flattenNodes(list).find(n => n.tagName === "BUTTON" && n.textContent === "阅读全文").dispatch("click"); await settle();
    const full = flattenNodes(list).find(n => n.classList.contains("module-story-full") && !n.hidden);
    assert.ok(full);
    module.renderFeatureModules({ sessionId: "session-1", modules: [{ ...feature, revision: "changed" }] }); await settle();
    const nodes = flattenNodes(list);
    assert.equal(nodes.filter(n => n.classList.contains("module-story-card")).length, 2, JSON.stringify(runtime.requests.map(r => r.key)));
    assert.equal(nodes.includes(full), true); assert.equal(full.hidden, false);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("reference semantic settings stay editable on builtin profiles; saving and service tests do not start builds", async () => {
  const { normalizeSemanticConfig } = await import("../../../../../../packages/creative-reference-library/semantic-contract.mjs");
  const config = normalizeSemanticConfig(), mutations = [];
  const runtime = createFrontendRuntime({ responses: {
    "GET /api/v1/config/context": { scope: "global", mode: "development", token: "synthetic-token" },
    "GET /api/v1/config/catalog": { agents: [], workflows: [], modules: [] },
    "GET /api/v1/config/profiles": { activeProfileId: "builtin", profiles: [{ id: "builtin", name: "Builtin" }] },
    "GET /api/v1/config/profiles/builtin": { builtin: true, models: [], agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {} },
    "GET /api/v1/config/reference-library": { bound: false },
    "POST /api/v1/config/reference-library/directories": ({options})=>{
      assert.equal(options.headers["x-rp-config-token"],"synthetic-token");
      const value=JSON.parse(options.body);
      return {path:value.path||"/",parent:value.path?"/":null,roots:[{name:"磁盘",path:"/"}],directories:value.path?[]:[{name:"Library",path:"/library"}],total:value.path?0:1,offset:0,nextOffset:null};
    },
    "GET /api/v1/config/reference-library/semantic/config": { config },
    "GET /api/v1/config/reference-library/semantic/status": { status: "semantic_disabled", jobs: [] },
    "PUT /api/v1/config/reference-library/semantic/config": ({ options }) => { mutations.push({ path: "save", body: JSON.parse(options.body), token: options.headers["x-rp-config-token"] }); return {}; },
    "POST /api/v1/config/reference-library/semantic/test": () => { mutations.push({ path: "test" }); return {}; },
    "POST /api/v1/config/reference-library/semantic/jobs": () => { mutations.push({ path: "build" }); return {}; },
  } });
  const listeners = [], querySelector = runtime.document.querySelector;
  runtime.document.querySelector = selector => selector === ".config-tabs" ? new FakeNode("div") : querySelector(selector);
  runtime.document.addEventListener = (_kind, handler) => listeners.push(handler);
  runtime.globals.location = runtime.window.location;
  const { restore } = await importWithRuntime("../public/config.js?reference-test", runtime);
  try {
    listeners[0]({ target: { closest: () => ({}) } }); await settle();
    const panel = runtime.elements.get("config-panel-references"); assert.ok(panel.textContent.includes("向量检索（c）"));
    const flatten = node => [node, ...node.children.flatMap(flatten)], nodes = flatten(panel);
    await nodes.find(node=>node.tagName==="BUTTON"&&node.textContent==="选择目录").onclick();
    const dialog=runtime.document.body.children.find(node=>node.tagName==="DIALOG");assert.equal(dialog.open,true);
    await flatten(dialog).find(node=>node.tagName==="BUTTON"&&node.textContent==="📁 Library").onclick();
    flatten(dialog).find(node=>node.tagName==="BUTTON"&&node.textContent==="选择此目录").onclick();
    assert.equal(dialog.open,false);
    assert.equal(nodes.find(node=>node.getAttribute("aria-label")==="私有资料库目录").value,"/library");
    assert.equal(mutations.length,0);
    const checkbox = nodes.find(n => n.type === "checkbox"); assert.equal(checkbox.disabled, false); checkbox.checked = true; checkbox.dispatch("input");
    assert.equal(runtime.elements.has("save-profile"), false);
    await nodes.find(n => n.tagName === "BUTTON" && n.textContent === "保存向量配置").onclick();
    assert.equal(mutations[0].body.config.enabled, true); assert.equal(mutations[0].token, "synthetic-token"); assert.equal(mutations.length, 1);
    await nodes.find(n => n.tagName === "BUTTON" && n.textContent === "测试已保存的服务").onclick(); assert.deepEqual(mutations.map(m => m.path), ["save", "test"]);
    await nodes.find(n => n.tagName === "BUTTON" && n.textContent === "手动构建 / 更新").onclick(); assert.deepEqual(mutations.map(m => m.path), ["save", "test", "build"]);
    assert.deepEqual(runtime.unknownRequests, []);
  } finally { restore(); }
});

// Node 会缓存 ES module：同一路径只求值一次。而每次测试都要**重新执行** app.js 的模块级装配
// 与 initialize()，因此用递增的查询串强制重新求值（浏览器里等价于不同的 `?v=N`）。
let bootSequence = 0;

async function boot(kind = "active-chat", options = {}) {
  bootSequence += 1;
  const runtime = createFrontendRuntime({ responses: createStateFixtures(kind, options.responses), search: options.search || "", mode: kind === "development-preview" ? "development" : "play" });
  const queryAll=runtime.document.querySelectorAll;
  runtime.document.querySelectorAll=selector=>selector===".tab-button:not([hidden])"?runtime.tabButtons.filter(button=>!button.hidden):selector===".panel"?[...runtime.elements.entries()].filter(([id])=>id.startsWith("panel-")).map(([,node])=>node):queryAll(selector);
  const { module, restore } = await importWithRuntime(`${APP}?boot=${bootSequence}`, runtime);
  await settle();
  return { runtime, module, restore };
}

function assertNoErrorBanner(runtime) {
  const banner = runtime.elements.get("error-banner");
  assert.ok(banner, "index.html 缺少 error-banner");
  assert.equal(banner.hidden, true, `初始化过程中 showError 被调用：${banner.textContent}`);
}

test("entering the workflow runtime page refreshes data immediately on every visit",async()=>{
  const {runtime,restore}=await boot("active-chat");
  try{
    const count=()=>runtime.requests.filter(request=>request.key==="GET /api/v1/workflow-runs").length;
    const initial=count();
    runtime.elements.get("tab-workflows").dispatch("click");await settle();assert.equal(count(),initial+1);
    runtime.elements.get("tab-story").dispatch("click");await settle();
    runtime.elements.get("tab-workflows").dispatch("click");await settle();assert.equal(count(),initial+2);
    assertNoErrorBanner(runtime);
  }finally{restore();}
});

test("module foreground activation and current-foreground navigation work while idle and running",async()=>{
  const standard="narrative-controls/standard-rp",advanced="narrative-controls/advanced-memory-rp";
  let active=advanced,runs=[];const activations=[];
  const workflows=[{id:standard,title:"Standard",ownerModuleId:"narrative-controls",source:"module",kind:"foreground",nodes:[]},{id:advanced,title:"Advanced",ownerModuleId:"narrative-controls",source:"module",kind:"foreground",nodes:[]},{id:"test/internal",title:"Internal",ownerModuleId:"test",source:"module",kind:"module-internal",nodes:[]},{id:"test/manual",title:"Manual",ownerModuleId:"test",source:"module",kind:"global-background",trigger:{type:"manual"},nodes:[]}];
  const {runtime,restore}=await boot("active-chat",{responses:{
    "GET /api/v1/workflows":()=>({activeWorkflowId:active,workflows}),
    "GET /api/v1/workflow-runs":()=>({runs}),
    "POST /api/v1/workflows/narrative-controls%2Fstandard-rp/activate":()=>{activations.push(standard);active=standard;return {activated:standard,startsOnNextInput:true};},
  }});
  try{
    const select=runtime.elements.get("workflow-select"),activate=runtime.elements.get("activate-workflow"),locate=runtime.elements.get("show-active-workflow");
    select.value=standard;select.dispatch("change");assert.equal(activate.disabled,false);
    activate.dispatch("click");await settle();assert.deepEqual(activations,[standard]);
    assert.equal(select.value,standard);assert.match(runtime.elements.get("workflow-status").textContent,/下一条用户消息/);
    select.value="test/internal";select.dispatch("change");assert.equal(activate.disabled,true);
    locate.dispatch("click");await settle();assert.equal(select.value,standard);assert.match(runtime.elements.get("workflow-status").textContent,/已配置的前台/);
    select.value="test/manual";select.dispatch("change");assert.equal(activate.hidden,true);
    runs=[{id:"live-run",workflowId:advanced,ownerModuleId:"narrative-controls",kind:"foreground",live:true,status:"running",nodes:{}}];
    locate.dispatch("click");await settle();assert.equal(select.value,advanced);assert.match(runtime.elements.get("workflow-status").textContent,/正在运行的前台/);
    assert.match(runtime.elements.get("workflow-run-list").textContent,/Advanced/);
    assert.match(runtime.elements.get("workflow-run-list").textContent,/narrative-controls\/advanced-memory-rp/);
    select.value=standard;select.dispatch("change");assert.equal(activate.disabled,false);
    assert.equal(activate.textContent,"设为下轮前台");
    activate.dispatch("click");await settle();assert.equal(active,standard);assert.equal(select.value,standard);
    assert.equal(runs[0].workflowId,advanced,"activation leaves the running instance unchanged");
    assert.match(runtime.elements.get("workflow-summary").textContent,/下轮默认前台/);
    assertNoErrorBanner(runtime);assert.deepEqual(runtime.unknownRequests,[]);
  }finally{restore();}
});

test("failed turn blockers remain visible and offer explicit skip and cancellation", async () => {
  const runs = [{ id: "blocked-post", workflowId: "test/post", kind: "turn-background", live: true, status: "failed", blocksNextTurn: true, nodes: {} },
    ...Array.from({ length: 25 }, (_, index) => ({ id: `old-${index}`, workflowId: "test/other", live: true, status: "completed", nodes: {} }))];
  const actions = [];
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/workflows": { activeWorkflowId: null, workflows: [{ id: "test/post", title: "后置导演", kind: "turn-background", nodes: [] }] },
    "GET /api/v1/workflow-runs": { runs },
    "POST /api/v1/workflow-runs/blocked-post/skip": () => { actions.push("skip"); return {}; },
  } });
  try {
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    runtime.elements.get("tab-workflows").dispatch("click"); await settle();
    const panel = runtime.elements.get("workflow-run-list");
    assert.match(panel.textContent, /正在阻止下一轮/);
    assert.ok(flatten(panel).find(node => node.textContent === "取消实例"));
    const skip = flatten(panel).find(node => node.textContent === "跳过并放行");
    assert.ok(skip);
    skip.dispatch("click"); await settle();
    assert.deepEqual(actions, ["skip"]);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("the record dialog shows exactly one call, keeps historical selection while polling, and removes its timer", async () => {
  const url = "/api/v1/workflow-runs/record-run/nodes/review/process-record";
  const calls = [1,2].map(number => ({id:`call-${number}`,attempt:1,memberId:null,agentId:"director",modelId:"model",status:"completed",startedAt:"2026-10-13T00:00:00Z",endedAt:"2026-10-13T00:00:01Z",usage:{input:number*10,output:2,cacheRead:0,cacheWrite:0,totalTokens:number*10+2},request:{systemPrompt:"system",messages:[{role:"user",content:`prompt-${number}`}]},response:{content:[{type:"text",text:`response-${number}`}]},tools:[]}));
  const {runtime,restore}=await boot("active-chat",{responses:{[`GET ${url}`]:({path})=>{
    const id=new URL(path,"http://localhost").searchParams.get("callId");
    return {calls:calls.map(({request,response,tools,...call})=>call),selectedCall:calls.find(call=>call.id===id)||calls.at(-1),usage:{input:30,output:4,cacheRead:0,cacheWrite:0,totalTokens:34},usageComplete:true,result:{done:true}};
  }}});
  let dialog;
  try{
    const {openCallRecords}=await import("../public/app-call-records.js");
    dialog=await openCallRecords({id:"record-run",workflowId:"test/director",workflowTitle:"Director"},{id:"review"});
    const flatten=node=>[node,...node.children.flatMap(flatten)];
    const click=async label=>{flatten(dialog).find(node=>node.tagName==="BUTTON"&&node.textContent===label).dispatch("click");await settle();};
    assert.match(dialog.textContent,/第 2 \/ 2 次调用/);
    assert.match(dialog.textContent,/response-2/);assert.ok(!dialog.textContent.includes("response-1"));
    await click("上一调用");
    assert.match(dialog.textContent,/第 1 \/ 2 次调用/);
    assert.match(dialog.textContent,/输入 10/);assert.match(dialog.textContent,/response-1/);assert.ok(!dialog.textContent.includes("response-2"));
    await click("请求内容");assert.match(dialog.textContent,/prompt-1/);assert.ok(!dialog.textContent.includes("prompt-2"));
    calls.push({...calls[1],id:"call-3",response:{content:[{type:"text",text:"response-3"}]}});
    assert.equal(await runtime.runNextTimer(timer => timer.kind === "timeout" && timer.delay === 1500), true, "record watcher should refresh its dialog");await settle();
    assert.match(dialog.textContent,/第 1 \/ 3 次调用/);assert.match(dialog.textContent,/prompt-1/);
    await click("最新调用");await click("模型响应");assert.match(dialog.textContent,/response-3/);assert.ok(!dialog.textContent.includes("response-1"));
    dialog.dispatch("close");assert.equal(await runtime.runNextTimer(timer => timer.kind === "timeout" && timer.delay === 1500), false, "closing the dialog should dispose its watcher");
    assertNoErrorBanner(runtime);assert.deepEqual(runtime.unknownRequests,[]);
  }finally{if(dialog)dialog.dispatch("close");restore();}
});

test("a delayed workflow poll cannot overwrite a newer selection or activation state", async () => {
  const standard = "test/standard", advanced = "test/advanced";
  const workflows = [{ id: standard, title: "Standard", kind: "foreground", nodes: [] }, { id: advanced, title: "Advanced", kind: "foreground", nodes: [] }];
  let active = standard, delayNext = false, finishOldRequest;
  const { runtime, module, restore } = await boot("active-chat", { responses: { "GET /api/v1/workflows": () => {
    const response = { activeWorkflowId: active, workflows };
    if (!delayNext) return response;
    delayNext = false;
    return new Promise(resolve => { finishOldRequest = () => resolve(response); });
  }, "GET /api/v1/workflow-runs": { runs: [] } } });
  try {
    delayNext = true;
    const oldPoll = module.refreshWorkflowData(standard, true);
    await settle();
    active = advanced;
    await module.refreshWorkflowData(advanced, true);
    finishOldRequest(); await oldPoll;
    assert.equal(runtime.elements.get("workflow-select").value, advanced);
    assert.match(runtime.elements.get("workflow-summary").textContent, /下轮默认前台/);
    assertNoErrorBanner(runtime);
  } finally { restore(); }
});

test("Comfy connection drafts survive refresh, saved selection reloads, and remove clears the selected connection", async () => {
  let connections=[{id:"local",title:"Local",baseUrl:"http://127.0.0.1:8188"},{id:"saved",title:"Saved",baseUrl:"http://127.0.0.1:8288",selected:true,hasToken:true}];
  const mutations=[];
  const {runtime,module,restore}=await boot("active-chat",{responses:{
    "GET /api/v1/image-generation":()=>({available:true,connections,profiles:[]}),
    "GET /api/v1/image-generation/connections":()=>({connections}),
    "POST /api/v1/image-generation/connections":({options})=>{const value=JSON.parse(options.body);mutations.push(value);connections=connections.map(item=>item.id===value.id?{...value,selected:true}:({...item,selected:false}));return value;},
    "DELETE /api/v1/image-generation/connections/saved":()=>{connections=connections.filter(item=>item.id!=="saved");return {removed:"saved"};},
  }});
  try {
    assert.equal(runtime.elements.get("comfy-connection-select").value,"saved");
    assert.equal(runtime.elements.get("comfy-connection-url").value,"http://127.0.0.1:8288");
    runtime.elements.get("comfy-connection-url").value="http://127.0.0.1:8388";
    runtime.elements.get("comfy-connection-form").dispatch("input");
    module.renderComfySettings();
    assert.equal(runtime.elements.get("comfy-connection-url").value,"http://127.0.0.1:8388");
    runtime.elements.get("comfy-connection-form").dispatch("submit");await settle();
    assert.equal(mutations[0].baseUrl,"http://127.0.0.1:8388");
    assert.equal(runtime.elements.get("comfy-connection-url").value,"http://127.0.0.1:8388");
    runtime.elements.get("comfy-remove-connection").dispatch("click");await settle();
    assert.equal(connections.length,1);
    assert.match(runtime.elements.get("comfy-connection-status").textContent,/已移除/);
    assertNoErrorBanner(runtime);
  } finally {restore();}
});

test("current-running navigation selects background workflows and cycles simultaneous runs without manual activation",async()=>{
  const flows=[{id:"test/front",title:"Front",kind:"foreground",nodes:[]},{id:"test/bg",title:"Background",kind:"turn-background",nodes:[]}];
  let runs=[{id:"bg",workflowId:"test/bg",live:true,status:"running",nodes:{}}];
  const {runtime,restore}=await boot("active-chat",{responses:{"GET /api/v1/workflows":{workflows:flows,activeWorkflowId:"test/front"},"GET /api/v1/workflow-runs":()=>({runs})}});
  try{
    runtime.elements.get("show-running-workflow").dispatch("click");await settle();
    assert.equal(runtime.elements.get("workflow-select").value,"test/bg");
    assert.equal(runtime.elements.get("activate-workflow").hidden,true);
    runs.push({id:"front",workflowId:"test/front",kind:"foreground",live:true,status:"running",nodes:{}});
    runtime.elements.get("show-running-workflow").dispatch("click");await settle();
    assert.equal(runtime.elements.get("workflow-select").value,"test/front");
    assert.ok(!runtime.requests.some(item=>item.method==="POST"));
  }finally{restore();}
});

test("opening completion keeps polling after optional initialization fails, and removes the typing placeholder", async()=>{
  const before=createStateFixtures("not-started"),after=createStateFixtures("active-chat");
  let opened=false,blocked=true;
  const {runtime,restore}=await boot("not-started",{responses:{
    "GET /api/v1/models":()=>{throw new Error("optional model listing unavailable");},
    "GET /api/v1/state":()=>opened?{...after["GET /api/v1/state"],busy:blocked,blockingWorkflows:blocked?[{workflowTitle:"初始化开场状态"},{workflowTitle:"开场导演初始化"}]:[]}:before["GET /api/v1/state"],
    "POST /api/v1/opening":()=>{opened=true;return {...after["GET /api/v1/state"],busy:true,blockingWorkflows:[{workflowTitle:"初始化开场状态"},{workflowTitle:"开场导演初始化"}]};},
  }});
  try{
    assert.match(runtime.elements.get("error-banner").textContent,/optional model/);
    const flatten=node=>[node,...node.children.flatMap(flatten)];
    const opening=flatten(runtime.elements.get("opening-list")).find(node=>node.tagName==="BUTTON");
    assert.ok(opening);opening.dispatch("click");await settle();
    assert.equal(runtime.elements.get("message-input").disabled,true);
    assert.ok(flatten(runtime.elements.get("messages")).some(node=>node.classList.contains("message-typing")));
    blocked=false;assert.equal(await runtime.runNextTimer(),true,"polling starts before optional initialization can abort");await settle();
    assert.equal(runtime.elements.get("message-input").disabled,false);
    assert.equal(runtime.elements.get("send-button").textContent,"发送");
    assert.ok(!runtime.elements.get("connection-status").textContent.includes("等待后台"));
    assert.ok(!flatten(runtime.elements.get("messages")).some(node=>node.classList.contains("message-typing")));
  }finally{restore();}
});

test("turn-state polling releases completed opening blockers even while module refresh is delayed", async()=>{
  let blocked=true,delay=false,finishModules;
  const fixtures=createStateFixtures("active-chat");
  const {runtime,restore}=await boot("active-chat",{responses:{
    "GET /api/v1/state":()=>({...fixtures["GET /api/v1/state"],busy:blocked,blockingWorkflows:blocked?[{workflowTitle:"初始化开场状态"}]:[]}),
    "GET /api/v1/modules":()=>delay?new Promise(resolve=>{finishModules=()=>resolve({modules:[]});}):{modules:[]},
  }});
  try{
    assert.equal(runtime.elements.get("message-input").disabled,true);
    delay=true;blocked=false;
    assert.equal(await runtime.runNextTimer(),true,"state watcher should refresh while module data is pending");await settle();
    assert.equal(runtime.elements.get("message-input").disabled,false);
    assert.ok(!runtime.elements.get("connection-status").textContent.includes("等待后台"));
    finishModules();await settle();assertNoErrorBanner(runtime);
  }finally{finishModules?.();restore();}
});

test("ComfyUI tests submit current unsaved form fields and show results beside the test button",async()=>{
  const calls=[];
  const {runtime,restore}=await boot("active-chat",{responses:{
    "POST /api/v1/image-generation/connections/local/test":({options})=>{calls.push(JSON.parse(options.body));return {ok:true,elapsedMs:17};},
  }});
  try{
    for(const [id,value] of [["comfy-connection-select","local"],["comfy-connection-id","draft"],["comfy-connection-title","Draft"],["comfy-connection-url","http://127.0.0.1:12345"],["comfy-connection-token","synthetic-draft-token"]])runtime.elements.get(id).value=value;
    runtime.elements.get("comfy-insecure-remote").checked=true;
    const testButton=runtime.elements.get("comfy-test-connection");testButton.dispatch("click");
    assert.equal(runtime.elements.get("comfy-connection-status").textContent,"测试中…");assert.equal(testButton.disabled,true);await settle();
    assert.deepEqual(calls,[{id:"draft",title:"Draft",baseUrl:"http://127.0.0.1:12345",token:"synthetic-draft-token",allowInsecureRemote:true}]);
    assert.equal(runtime.elements.get("comfy-connection-status").textContent,"连接正常 · 17 ms");assert.equal(testButton.disabled,false);
    assert.equal(runtime.requests.some(request=>request.key==="POST /api/v1/image-generation/connections"),false);
    assertNoErrorBanner(runtime);assert.deepEqual(runtime.unknownRequests,[]);
  }finally{restore();}
});

test("正文版本控件预览、采用和再次生成，预览期间禁止继续输入", async () => {
  const base = createStateFixtures("active-chat")["GET /api/v1/state"];
  let current = { ...base, currentTurn: 1, displayExecutionId: null, narrativeAttempts: { revision: 10, attempts: [
    { id: "a", turn: 1, selected: true, status: "completed", hasNarrative: true, canAdopt: true },
    { id: "b", turn: 1, selected: false, status: "completed", hasNarrative: true, canAdopt: true },
  ] } };
  const mutations = [], stateReads = [];
  const { runtime, restore } = await boot("active-chat", { responses: {
    "GET /api/v1/state": ({ path }) => {
      const encodedContext = new URL(path, "http://localhost").searchParams.get("readContext");
      const context = encodedContext ? JSON.parse(encodedContext) : null;
      stateReads.push(context);
      const previewing = context?.executionId === "b";
      return {
        ...current,
        displayExecutionId: context?.executionId || null,
        messages: current.messages.map(message => {
          if (message.role === "assistant" && previewing) return { ...message, attemptId: "b", content: "候选正文" };
          const { attemptId, ...withoutAttempt } = message;
          return withoutAttempt;
        }),
      };
    },
    "POST /api/v1/narrative-attempts/b/adopt": ({ options }) => {
      const value = JSON.parse(options.body); mutations.push(value);
      current = { ...current, displayExecutionId: null, messages: current.messages.map(({ attemptId, ...message }) => message), narrativeAttempts: { revision: 11, attempts: current.narrativeAttempts.attempts.map(attempt => ({ ...attempt, selected: attempt.id === "b" })) } };
      return current;
    },
    "POST /api/v1/narrative-attempts/regenerate": ({ options }) => { mutations.push(JSON.parse(options.body)); current = { ...current, busy: true }; return current; },
  } });
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const nodes = () => flatten(runtime.elements.get("messages"));
  try {
    assertNoErrorBanner(runtime);
    const selector = nodes().find(node => node.tagName === "SELECT");
    assert.ok(selector);
    selector.value = "b"; selector.dispatch("change"); await settle(15);
    assert.equal(runtime.elements.get("message-input").disabled, true);
    assert.ok(nodes().some(node => node.textContent === "候选正文"));
    assert.ok(stateReads.some(context => context?.executionId === "b"), JSON.stringify(stateReads));
    assert.equal(runtime.requests.some(request => request.key === "POST /api/v1/narrative-attempts/preview"), false);
    nodes().find(node => node.tagName === "BUTTON" && node.textContent === "采用此版本").dispatch("click"); await settle(15);
    assert.deepEqual(mutations[0], { expectedRevision: 10 });
    assert.equal(runtime.elements.get("message-input").disabled, false);
    nodes().find(node => node.tagName === "BUTTON" && node.textContent === "再次生成").dispatch("click"); await settle(15);
    assert.match(mutations[1].executionId, /^workflow-/);
    assert.equal(runtime.requests.some(request => request.key === "POST /api/v1/input"), false);
    assertNoErrorBanner(runtime);
    assert.deepEqual(runtime.unknownRequests, []);
  } finally { restore(); }
});

test("index 的版本化入口与无查询串入口共享 document 时只启动一次", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const entry = /src="(\/app\.js\?[^"]+)"/.exec(html)?.[1];
  assert.ok(entry);
  const runtime = createFrontendRuntime({ responses: createStateFixtures("active-chat") });
  const { restore } = await importWithRuntime(`../public${entry}`, runtime);
  try {
    await settle();
    await import("../public/app.js");
    await settle();
    assertNoErrorBanner(runtime);
    const initialStateReads = runtime.requests.filter(request => request.key === "GET /api/v1/state").length;
    assert.ok(initialStateReads >= 1, "SDK watcher should take an initial state snapshot");
    assert.equal(await runtime.runNextTimer(), true, "SDK watcher should have a refresh lifecycle");
    await settle();
    assert.ok(runtime.requests.filter(request => request.key === "GET /api/v1/state").length > initialStateReads, "watcher refresh should read state again");
    assert.equal(runtime.elements.get("player-name").listenerCount("input"), 1);
    runtime.window.dispatchEvent("pagehide");
    assert.equal(await runtime.runNextTimer(), false, "pagehide should dispose the state watcher");
  } finally { restore(); }
});

for (const kind of ["development-preview", "not-started", "active-chat"]) {
  test(`${kind}：真实 app.js 可以完整初始化且不报错`, async () => {
    const { runtime, module, restore } = await boot(kind);
    try {
      assertNoErrorBanner(runtime);
      // 启动链必须把全部端点跑完：少一个都说明中间有异常被吞掉。
      const keys = runtime.requests.map((request) => request.key);
      for (const required of ["GET /api/v1/card", "GET /api/v1/state", "GET /api/v1/settings", "GET /api/v1/modules",
        "GET /api/v1/models", "GET /api/v1/workflow-policy", "GET /api/v1/workflows", "GET /api/v1/workflow-runs",
        "GET /api/v1/cards", "GET /api/v1/sessions"]) {
        assert.ok(keys.includes(required), `${kind} 未请求 ${required}（启动链中断）`);
      }
      assert.deepEqual(runtime.unknownRequests, [], `请求了未登记的端点：${runtime.unknownRequests.join(", ")}`);
      // 卡片标题被写入 => initialize 真的跑到了 UI 更新阶段。
      assert.equal(runtime.elements.get("card-title").textContent, "沈月");
       const initialStateReads = keys.filter(key => key === "GET /api/v1/state").length;
       assert.ok(initialStateReads >= 1, "SDK watcher should take an initial state snapshot");
       assert.equal(await runtime.runNextTimer(), true, "SDK watcher should refresh state");
       await settle();
       assert.ok(runtime.requests.filter(request => request.key === "GET /api/v1/state").length > initialStateReads, "state refresh should occur after the watcher lifecycle");
      assert.equal(keys.filter(key => key === "GET /api/v1/card").length, 1);
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
    runtime.requests.length = 0;
    assert.equal(await runtime.runNextTimer(), true, "SDK watcher should continue its refresh lifecycle");
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
    const watched = ["player-name", "saved-profile", "card-search", "font-size", "workflow-select", "comfy-connection-select"];
    const before = watched.map((id) => runtime.elements.get(id).listenerCount("change") + runtime.elements.get(id).listenerCount("input"));

    for (let round = 0; round < 5; round += 1) {
      assert.equal(await runtime.runNextTimer(), true, "SDK watcher should continue its refresh lifecycle");
      await settle(10);
    }

    const after = watched.map((id) => runtime.elements.get(id).listenerCount("change") + runtime.elements.get(id).listenerCount("input"));
    assert.deepEqual(after, before, "轮询改变了监听器数量（说明每次都重新绑定）");
    // 轮询次数再多也不应让节点数无限增长。
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
