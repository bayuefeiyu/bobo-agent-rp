import test from "node:test";
import assert from "node:assert/strict";
import { createFrontendRuntime, FakeNode, importWithRuntime, settle } from "./frontend-runtime.mjs";
import { MODEL_PROVIDERS } from "../public/model-providers.js";

const flatten = node => [node, ...node.children.flatMap(flatten)];
class ConfigNode extends FakeNode {
  append(...nodes) { for (const node of nodes) if (node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); const first=this.children.length===0;super.append(node); node.parent = this;if(this.tagName==="SELECT"&&first)this.value=node.value; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelectorAll(selector) {
    return flatten(this).slice(1).filter(node => selector.split(",").some(part => part.startsWith(".") ? node.classList.contains(part.slice(1)) : node.tagName.toLowerCase() === part));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector) || null; }
  focus() { this.focused = true; }
  checkValidity() {
    if (this.disabled) return true;
    if (this.customValidity) { this.validationMessage = this.customValidity; return false; }
    if (this.pattern && this.value && !new RegExp(`^(?:${this.pattern})$`).test(this.value)) { this.validationMessage = "格式不正确。"; return false; }
    if (this.tagName === "SELECT") {
      const selected = flatten(this).some(node => node.tagName === "OPTION" && String(node.value) === String(this.value) && node.value !== "");
      if (this.required && !selected) { this.validationMessage = "请选择一项。"; return false; }
    } else if (this.required && (this.value == null || this.value === "")) {
      this.validationMessage = "请填写此字段。"; return false;
    } else if (this.type === "number" && this.value !== "") {
      const value = Number(this.value);
      if (!Number.isFinite(value) || this.min != null && value < Number(this.min) || this.max != null && value > Number(this.max)) {
        this.validationMessage = "数值超出允许范围。"; return false;
      }
    }
    this.validationMessage = ""; return true;
  }
  reportValidity() { this.reported = true; return this.checkValidity(); }
  setCustomValidity(message) { this.customValidity = message; }
  remove() { if (this.parent) this.parent.children=this.parent.children.filter(node=>node!==this); }
}
const button = (root, label) => flatten(root).find(node => node.tagName === "BUTTON" && node.textContent === label);
const input = (root, label) => flatten(root).find(node => node.dataset.configLabel === label);
const edit = (root, label, value) => { const node=input(root,label);node.value=value;node.dispatch("input");return node; };

async function boot(sequence, { activeProfileId = "editable", hasCachedSecret = false, modelSecretCopy = true, testResponse = () => ({ elapsedMs: 1, reply: "ok" }), additionalAgents = [], saveResponse = async () => {}, builtinProfile = false } = {}) {
  const mutations = [];
  const connections = [], secrets = [];
  const profile = { id: "editable", name: "Editable", builtin: builtinProfile, models: [{ schemaVersion: 1, id: "test-model", provider: "custom", api: "openai-responses", model: "test", contextWindow: 128000, maxOutputTokens: 4096, maxConcurrency: 10,hasSecret:hasCachedSecret }], agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {} };
  const runtime = createFrontendRuntime({ responses: {
    "GET /api/v1/config/context": { scope: "card", mode: "play", token: "synthetic-token", modelSecretCopy },
    "GET /api/v1/config/catalog": { agents: [{key:"module/demo/agent/writer",moduleId:"demo",group:"Demo",base:{id:"demo/writer",name:"Writer",defaultModelId:"pi:current",outputMode:"text",tools:[],contextPermissions:[]}},...additionalAgents], workflows: [{key:"module/demo/workflow/story",moduleId:"demo",group:"Demo",base:{id:"demo/story",kind:"foreground",turnContext:{recentCompleteTurns:5},nodes:[{id:"write",type:"agent",agentId:"demo/writer",prompt:"Write"}]}}], modules: [{ id: "memory", title: "Memory", base: { count: 3, cooldown: "10d", mode: "single" }, fields: [
      { path: "/count", label: "最近完整回合数", type: "integer", required: true, minimum: 1, maximum: 20, options: [] },
      { path: "/cooldown", label: "世界时间参考CD", type: "text", required: true, options: [] },
      { path: "/mode", label: "推演形式", type: "select", required: true, options: ["single", "team"] },
    ] }] },
    "GET /api/v1/config/profiles": { activeProfileId, profiles: [{ id: "editable", name: "Editable" }] },
    "GET /api/v1/config/profiles/editable": () => structuredClone(profile),
    "PUT /api/v1/config/profiles/editable": async ({ options }) => { const saved = JSON.parse(options.body);await saveResponse(saved); mutations.push(saved); Object.assign(profile, saved); return {}; },
    "PUT /api/v1/config/profiles/editable/secrets/models/new-model": ({ options }) => { const value=JSON.parse(options.body);secrets.push(value);profile.models.find(model=>model.id==="new-model").hasSecret=Boolean(value.apiKey);return {}; },
    "PUT /api/v1/config/profiles/editable/secrets/models/test-model": ({ options }) => { secrets.push(JSON.parse(options.body));return {}; },
    "PUT /api/v1/config/profiles/editable/secrets/models/test-model-copy-2": ({ options }) => { const value=JSON.parse(options.body);secrets.push(value);profile.models.find(model=>model.id==="test-model-copy-2").hasSecret=Boolean(value.apiKey)||Boolean(profile.models.find(model=>model.id===value.sourceModelId)?.hasSecret);return {}; },
    "POST /api/v1/models/discover": ({ options }) => { connections.push({ path: "discover", body: JSON.parse(options.body) }); return { models: ["a", "b"] }; },
    "POST /api/v1/models/test": ({ options }) => { connections.push({ path: "test", body: JSON.parse(options.body) }); return testResponse(); },
  } });
  // Fixture handlers may return a delayed value or reject like an HTTP save operation.
  const fixtureFetch=runtime.globals.fetch;
  runtime.globals.fetch=async(...args)=>{
    const response=await fixtureFetch(...args);
    try{const value=await response.json();return {...response,json:async()=>value};}
    catch(error){return {...response,ok:false,status:503,json:async()=>({error:error.message})};}
  };
  for (const [id, node] of runtime.elements) { Object.setPrototypeOf(node, ConfigNode.prototype); node.id = id; }
  runtime.document.createElement = tag => new ConfigNode(tag);
  const tabs = new ConfigNode("div"), buttons = ["models", "agents", "assignments", "workflows", "modules"].map(panel => {
    const button = new ConfigNode("button"); button.className = "config-tab"; button.dataset.configPanel = panel; tabs.append(button); return button;
  });
  const panels = buttons.map(button => runtime.elements.get(`config-panel-${button.dataset.configPanel}`));
  for (const panel of panels) panel.className = "config-category-panel";
  const originalQuery = runtime.document.querySelector;
  runtime.document.querySelector = selector => selector === ".config-tabs" ? tabs : originalQuery(selector);
  runtime.document.querySelectorAll = selector => {
    if (selector === ".config-tab") return buttons;
    if (selector === ".config-category-panel") return panels;
    if (selector.startsWith(".config-category-panel input")) return panels.flatMap(flatten).filter(node => ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName));
    if (selector === "input[data-secret-for]") return panels.flatMap(flatten).filter(node => node.dataset.secretFor);
    if (selector === "input[data-model-index]") return panels.flatMap(flatten).filter(node => node.dataset.modelIndex !== undefined);
    if (selector === "select[data-model-options]") return panels.flatMap(flatten).filter(node=>node.dataset.modelOptions);
    if (selector === "[data-agent-model-key]") return panels.flatMap(flatten).filter(node=>node.dataset.agentModelKey);
    return [];
  };
  runtime.globals.location = runtime.window.location;
  const windowListeners=new Map();runtime.window.addEventListener=(kind,handler)=>windowListeners.set(kind,handler);
  runtime.globals.prompt = () => assert.fail("Adding a model must not open a prompt");
  runtime.globals.confirm = () => true;
  const { restore } = await importWithRuntime(`../public/config.js?config-save=${sequence}`, runtime);
  await settle();
  const hasUnsavedChanges=()=>{let prevented=false;windowListeners.get("beforeunload")?.({preventDefault:()=>{prevented=true;}});return prevented;};
  return { runtime, mutations, connections, secrets, restore, buttons, panels, hasUnsavedChanges };
}

test("saving models succeeds with required module fields whose options are empty", async () => {
  const { runtime, mutations, restore, hasUnsavedChanges } = await boot(1);
  try {
    const nodes = flatten(runtime.elements.get("config-panel-modules"));
    const count = nodes.find(node => node.dataset.configLabel === "最近完整回合数");
    assert.equal(count.tagName, "INPUT"); assert.equal(count.type, "number"); assert.equal(count.checkValidity(), true);
    const cooldown = nodes.find(node => node.dataset.configLabel === "世界时间参考CD");
    assert.equal(cooldown.tagName, "INPUT"); assert.equal(cooldown.type, "text"); assert.equal(cooldown.checkValidity(), true);
    assert.equal(nodes.find(node => node.dataset.configLabel === "推演形式").tagName, "SELECT");
    assert.equal(runtime.elements.has("save-profile"), false);
    await button(runtime.elements.get("config-panel-models"),"保存").onclick();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].models[0].id, "test-model");
    assert.equal(runtime.elements.get("status").textContent, "保存成功。");
    assert.equal(hasUnsavedChanges(),false);
    assert.deepEqual(runtime.unknownRequests, []);
  } finally { restore(); }
});

const extraAgent={key:"module/memory/agent/editor",moduleId:"memory",group:"Memory",base:{id:"memory/editor",name:"Editor",defaultModelId:"pi:current",tools:[]}};
const assignmentSelect=(panel,key)=>flatten(panel).find(node=>node.dataset.assignmentAgent===key);
const assignmentStatus=(panel,key)=>flatten(panel).find(node=>node.dataset.assignmentResult===key);
test("assignment page expands modules and saves a single model without other Agent or module drafts",async()=>{
  const {runtime,mutations,restore,hasUnsavedChanges}=await boot(11,{additionalAgents:[extraAgent]});
  try{
    const panel=runtime.elements.get("config-panel-assignments"),key="module/demo/agent/writer";
    assert.equal(panel.querySelectorAll(".assignment-module").length,2);
    assert.equal(panel.querySelectorAll(".assignment-row").length,2);
    assert.equal(panel.querySelectorAll("button").some(node=>node.textContent.includes("保存")),false);
    edit(runtime.elements.get("config-panel-agents"),"名称","Unsaved writer");
    edit(runtime.elements.get("config-panel-modules"),"最近完整回合数",21);
    const select=assignmentSelect(panel,key);select.value="test-model";select.dispatch("input");
    assert.equal(assignmentStatus(panel,key).textContent,"保存中…");await settle(10);
    assert.equal(mutations.length,1);
    assert.deepEqual(mutations[0].agentOverrides,{[key]:{defaultModelId:"test-model"}});
    assert.deepEqual(mutations[0].moduleOverrides,{});
    assert.equal(assignmentStatus(panel,key).textContent,"已保存");
    assert.equal(input(runtime.elements.get("config-panel-agents"),"名称").value,"Unsaved writer");
    assert.equal(hasUnsavedChanges(),true);
    await button(runtime.elements.get("config-panel-agents"),"保存 Agent").onclick();
    assert.equal(mutations[1].agentOverrides[key].name,"Unsaved writer");
    assert.equal(mutations[1].agentOverrides[key].defaultModelId,"test-model");
    assert.deepEqual(runtime.unknownRequests,[]);
  }finally{restore();}
});

test("selected Agents across modules receive one atomic batch save",async()=>{
  const {runtime,mutations,restore,hasUnsavedChanges}=await boot(12,{additionalAgents:[extraAgent]});
  try{
    const panel=runtime.elements.get("config-panel-assignments");
    const all=flatten(panel).find(node=>node.type==="checkbox"&&node.parent.parent.className==="assignment-toolbar");
    all.checked=true;all.dispatch("change");
    const bulk=flatten(panel).find(node=>node.dataset.batchModel);assert.equal(bulk.disabled,false);
    bulk.value="test-model";bulk.dispatch("input");await settle(10);
    assert.equal(mutations.length,1);
    assert.deepEqual(mutations[0].agentOverrides,{"module/demo/agent/writer":{defaultModelId:"test-model"},[extraAgent.key]:{defaultModelId:"test-model"}});
    assert.equal(assignmentSelect(panel,extraAgent.key).value,"test-model");
    assert.equal(assignmentStatus(panel,extraAgent.key).textContent,"已保存");
    assert.equal(hasUnsavedChanges(),false);
  }finally{restore();}
});

test("instant saves serialize rapid changes and rollback failures with an inline retry",async()=>{
  let release,fail=false,requests=0;
  const {runtime,mutations,restore,hasUnsavedChanges}=await boot(13,{saveResponse:async()=>{
    if(fail)throw new Error("保存服务不可用");
    if(++requests===1)await new Promise(resolve=>{release=resolve;});
  }});
  try{
    const panel=runtime.elements.get("config-panel-assignments"),key="module/demo/agent/writer";
    let select=assignmentSelect(panel,key);select.value="test-model";select.dispatch("input");await settle();
    select=assignmentSelect(panel,key);select.value="pi:current";select.dispatch("input");
    release();await settle(10);
    assert.deepEqual(mutations.map(value=>value.agentOverrides[key].defaultModelId),["test-model","pi:current"]);
    assert.equal(assignmentSelect(panel,key).value,"pi:current");assert.equal(hasUnsavedChanges(),false);
    fail=true;select=assignmentSelect(panel,key);select.value="test-model";select.dispatch("input");await settle(10);
    assert.equal(assignmentSelect(panel,key).value,"pi:current");
    assert.match(assignmentStatus(panel,key).textContent,/保存失败.*不可用/);
    fail=false;await button(panel,"重试").onclick();
    assert.equal(assignmentSelect(panel,key).value,"test-model");assert.equal(assignmentStatus(panel,key).textContent,"已保存");
    assert.equal(hasUnsavedChanges(),false);
  }finally{restore();}
});

test("fallback defaults off and saves selection and switch immediately without saving concurrency drafts",async()=>{
  const {runtime,mutations,restore}=await boot(14);
  try{
    const panel=runtime.elements.get("config-panel-assignments"),workflows=runtime.elements.get("config-panel-workflows");
    assert.equal(input(panel,"启用兜底模型").checked,false);
    let enabled=input(panel,"启用兜底模型");enabled.checked=true;enabled.dispatch("input");await settle();
    assert.equal(mutations.length,0);assert.equal(input(panel,"启用兜底模型").checked,false);
    assert.match(assignmentStatus(panel,"policy").textContent,/先选择有效的兜底模型/);
    edit(workflows,"全局最大并发",3);
    edit(panel,"兜底模型","test-model");await settle(10);
    assert.equal(mutations[0].workflowOverrides.runtimePolicy.maxConcurrency,10);
    enabled=input(panel,"启用兜底模型");enabled.checked=true;enabled.dispatch("input");await settle(10);
    assert.deepEqual(mutations[1].workflowOverrides.runtimePolicy.modelFailure,{silentFallback:true,defaultFallbackModelId:"test-model"});
    await button(workflows,"保存运行策略").onclick();
    assert.equal(mutations[2].workflowOverrides.runtimePolicy.maxConcurrency,3);
    assert.equal(mutations[2].workflowOverrides.runtimePolicy.modelFailure.silentFallback,true);
    enabled=input(panel,"启用兜底模型");enabled.checked=false;enabled.dispatch("input");await settle(10);
    assert.deepEqual(mutations[3].workflowOverrides.runtimePolicy.modelFailure,{silentFallback:false,defaultFallbackModelId:"test-model"});
    assert.equal(input(workflows,"默认模型"),undefined);
    assert.equal(input(workflows,"允许静默兜底"),undefined);
    assert.deepEqual(runtime.unknownRequests,[]);
  }finally{restore();}
});

test("builtin assignments remain read-only",async()=>{
  const {runtime,mutations,restore}=await boot(15,{builtinProfile:true});
  try{
    const panel=runtime.elements.get("config-panel-assignments");
    assert.equal(assignmentSelect(panel,"module/demo/agent/writer").disabled,true);
    assert.equal(input(panel,"启用兜底模型").disabled,true);
    assert.equal(input(panel,"兜底模型").disabled,true);
    assert.equal(mutations.length,0);
  }finally{restore();}
});

test("new model ID is entered in the form and draft parameters can connect before saving", async () => {
  const { runtime, mutations, connections, secrets, restore } = await boot(3);
  try {
    const panel = runtime.elements.get("config-panel-models");
    await flatten(panel).find(node => node.textContent === "新增模型").onclick();
    const modelCard = panel.children.at(-1), grid = modelCard.querySelector(".field-grid");
    const inputs = grid.children.map(label => flatten(label).find(node => node.dataset.configLabel));
    assert.deepEqual(inputs.slice(0, 7).map(input => input.dataset.configLabel), ["ID", "显示名称", "服务商", "API 格式", "URL", "API Key", "模型名"]);
    const enter = (name, value) => { const input = inputs.find(node => node.dataset.configLabel === name); input.value = value; input.dispatch("input"); return input; };
    assert.equal(inputs[0].disabled, false);
    enter("ID", "new-model"); enter("URL", "https://fixture.invalid/v1"); enter("API Key", "draft-test-key");
    const discovery = flatten(modelCard).find(node => node.tagName === "BUTTON" && node.textContent === "获取模型列表");
    assert.equal(discovery.parent.className, "model-input-row");
    await discovery.onclick();
    assert.equal(connections[0].body.modelId, null);
    assert.equal(connections[0].body.profileId, "editable");
    assert.equal(connections[0].body.baseUrl, "https://fixture.invalid/v1");
    assert.equal(connections[0].body.apiKey, "draft-test-key");
    assert.deepEqual(flatten(modelCard).find(node => node.tagName === "DATALIST").children.map(node => node.value), ["a", "b"]);
    enter("模型名", "b");
    const actions = modelCard.querySelector(".model-actions");
    assert.deepEqual(actions.querySelectorAll("button").map(button => button.textContent), ["测试", "保存"]);
    await button(actions,"测试").onclick();
    assert.equal(connections[1].body.modelProfile.model, "b");
    assert.equal(connections[1].body.apiKey, "draft-test-key");
    assert.equal(mutations.length, 0); assert.equal(secrets.length, 0);
    await button(actions,"保存").onclick();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].models.at(-1).id, "new-model");
    assert.ok(!JSON.stringify(mutations[0]).includes("draft-test-key"));
    assert.deepEqual(secrets, [{ apiKey: "draft-test-key" }]);
    assert.deepEqual(runtime.unknownRequests, []);
  } finally { restore(); }
});

test("model test shows pending, success, failure and validation next to its button", async () => {
  let resolveTest, fail=false;
  const {runtime,mutations,connections,restore}=await boot(10,{testResponse:()=>{
    if(fail)throw new Error("服务返回 401：API Key 无效。");
    return new Promise(resolve=>{resolveTest=resolve;});
  }});
  try{
    const panel=runtime.elements.get("config-panel-models"),testButton=button(panel,"测试");
    const result=panel.querySelector(".model-test-result");
    assert.equal(result.hidden,true);
    assert.equal(result.parent,testButton.parent);
    assert.deepEqual(result.parent.children,[testButton,result]);
    assert.equal(result.getAttribute("role"),"status");
    assert.equal(result.getAttribute("aria-live"),"polite");
    const pending=testButton.onclick();
    assert.equal(testButton.disabled,true);
    assert.equal(result.hidden,false);
    assert.equal(result.dataset.state,"pending");
    assert.equal(result.textContent,"测试中…");
    await settle();resolveTest({elapsedMs:42,reply:"ok"});await pending;
    assert.equal(result.dataset.state,"success");
    assert.equal(result.textContent,"连接成功（42ms）：ok");
    assert.equal(testButton.disabled,false);
    fail=true;await testButton.onclick();
    assert.equal(result.dataset.state,"error");
    assert.equal(result.textContent,"服务返回 401：API Key 无效。");
    assert.equal(testButton.disabled,false);
    edit(panel,"模型名","");await testButton.onclick();
    assert.equal(result.dataset.state,"error");
    assert.equal(result.textContent,"请修正“模型名”。");
    assert.equal(input(panel,"模型名").reported,true);
    assert.equal(connections.length,2);assert.equal(mutations.length,0);
    assert.deepEqual(runtime.unknownRequests,[]);
  }finally{restore();}
});

test("adding another model preserves unsaved keys and duplicate IDs cannot save", async () => {
  const { runtime, mutations, restore } = await boot(4);
  try {
    const panel = runtime.elements.get("config-panel-models");
    const key = flatten(panel).find(node => node.dataset.configLabel === "API Key");
    key.value = "unsaved-test-key"; key.dispatch("input");
    await flatten(panel).find(node => node.textContent === "新增模型").onclick();
    let selector=input(panel,"模型配置");selector.value="0";selector.dispatch("input");
    assert.equal(flatten(panel).find(node => node.dataset.configLabel === "API Key").value, "unsaved-test-key");
    selector=input(panel,"模型配置");selector.value="1";selector.dispatch("input");
    const id = flatten(panel.children.at(-1)).find(node => node.dataset.configLabel === "ID");
    id.value = "test-model"; id.dispatch("input");
    await button(panel,"保存").onclick();
    assert.equal(mutations.length, 0);
    assert.match(runtime.elements.get("status").textContent, /模型 ID 已存在/);
  } finally { restore(); }
});

test("a hidden invalid field is revealed and named without saving the profile", async () => {
  const { runtime, mutations, restore, buttons, panels } = await boot(2);
  try {
    const panel = runtime.elements.get("config-panel-modules");
    const count = flatten(panel).find(node => node.dataset.configLabel === "最近完整回合数");
    assert.equal(panel.hidden, true);
    count.value = 21; count.dispatch("input");
    await button(panel,"保存模块参数").onclick();
    assert.equal(mutations.length, 0);
    assert.equal(panel.hidden, false);
    assert.equal(panels.find(node => node.id === "config-panel-models").hidden, true);
    assert.equal(buttons.find(node => node.dataset.configPanel === "modules").classList.contains("active"), true);
    assert.equal(count.focused, true); assert.equal(count.reported, true);
    assert.match(runtime.elements.get("status").textContent, /最近完整回合数.*超出允许范围/);
    count.value = 4; count.dispatch("input");
    await button(panel,"保存模块参数").onclick();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].moduleOverrides.memory.count, 4);
  } finally { restore(); }
});

test("model and module saves commit only their own changes and preserve other drafts", async () => {
  const { runtime, mutations, restore } = await boot(5);
  try {
    const models=runtime.elements.get("config-panel-models"),modules=runtime.elements.get("config-panel-modules");
    edit(modules,"最近完整回合数",21);
    edit(models,"显示名称","Saved name");
    await button(models,"保存").onclick();
    assert.equal(mutations.length,1);
    assert.equal(mutations[0].models[0].name,"Saved name");
    assert.deepEqual(mutations[0].moduleOverrides,{});
    assert.equal(input(modules,"最近完整回合数").value,21);
    edit(models,"显示名称","Unsaved name");
    edit(modules,"最近完整回合数",4);
    await button(modules,"保存模块参数").onclick();
    assert.equal(mutations[1].models[0].name,"Saved name");
    assert.equal(mutations[1].moduleOverrides.memory.count,4);
    assert.equal(input(models,"显示名称").value,"Unsaved name");
  } finally { restore(); }
});

test("Agent, workflow and runtime policy have independent saves", async () => {
  const { runtime, mutations, restore, hasUnsavedChanges } = await boot(6);
  try {
    const agents=runtime.elements.get("config-panel-agents"),workflows=runtime.elements.get("config-panel-workflows");
    edit(agents,"名称","New writer");
    edit(workflows,"全局最大并发",3);
    edit(workflows,"最近完整正文回合数",7);
    await button(agents,"保存 Agent").onclick();
    assert.equal(mutations[0].agentOverrides["module/demo/agent/writer"].name,"New writer");
    assert.deepEqual(mutations[0].workflowOverrides,{});
    await button(workflows,"保存工作流").onclick();
    assert.equal(mutations[1].workflowOverrides["module/demo/workflow/story"].turnContext.recentCompleteTurns,7);
    assert.equal(mutations[1].workflowOverrides.runtimePolicy,undefined);
    await button(workflows,"保存运行策略").onclick();
    assert.equal(mutations[2].workflowOverrides.runtimePolicy.maxConcurrency,3);
    assert.equal(mutations[2].workflowOverrides["module/demo/workflow/story"].turnContext.recentCompleteTurns,7);
    assert.equal(hasUnsavedChanges(),false);
  } finally { restore(); }
});

test("picker shows one model, copies collision-free drafts and keeps removal in the picker", async () => {
  const { runtime, mutations, connections, secrets, restore } = await boot(7,{hasCachedSecret:true});
  try {
    const panel=runtime.elements.get("config-panel-models");
    const select = index => { const picker=input(panel,"模型配置");picker.value=String(index);picker.dispatch("input"); };
    edit(panel,"API Key","unsaved-original-key");
    await button(panel,"复制配置").onclick();
    assert.equal(input(panel,"ID").value,"test-model-copy");
    assert.equal(input(panel,"显示名称").value,"test-model-copy");
    assert.equal(input(panel,"API Key").value,"");
    assert.equal(input(panel,"API Key").placeholder,"留空使用已保存的 Key");
    await button(panel,"测试").onclick();
    assert.equal(connections[0].body.modelId,"test-model");
    assert.equal(connections[0].body.apiKey,"");
    assert.equal(panel.querySelectorAll(".config-card").length,2);
    assert.equal(button(panel,"移除").parent.className,"model-picker");
    assert.equal(button(panel,"复制配置").disabled,true);
    select(0);await button(panel,"复制配置").onclick();
    assert.equal(input(panel,"ID").value,"test-model-copy-2");
    await button(panel,"保存").onclick();
    assert.deepEqual(mutations[0].models.map(model=>model.id),["test-model","test-model-copy-2"]);
    assert.deepEqual(secrets,[{sourceModelId:"test-model"}]);
    assert.equal(input(panel,"ID").disabled,true);
    select(0);assert.equal(input(panel,"API Key").value,"unsaved-original-key");
    await button(panel,"移除").onclick();
    assert.deepEqual(mutations[1].models.map(model=>model.id),["test-model-copy-2"]);
    assert.deepEqual(secrets,[{sourceModelId:"test-model"},{apiKey:""}]);
    assert.equal(input(panel,"ID").value,"test-model-copy");
    await button(panel,"移除").onclick();
    assert.equal(mutations.length,2);
    assert.equal(input(panel,"ID").value,"test-model-copy-2");
    assert.equal(panel.querySelectorAll(".config-card").length,2);
    assert.deepEqual(runtime.unknownRequests,[]);
  } finally { restore(); }
});

test("an old server cannot silently discard a copied model's cached key", async () => {
  const {runtime,mutations,secrets,restore}=await boot(8,{hasCachedSecret:true,modelSecretCopy:false});
  try{
    const panel=runtime.elements.get("config-panel-models");await button(panel,"复制配置").onclick();
    await button(panel,"保存").onclick();
    assert.equal(mutations.length,0);assert.equal(secrets.length,0);
    assert.match(runtime.elements.get("status").textContent,/重启服务/);
  }finally{restore();}
});

test("selecting a vendor fills its official URL and native protocol without saving",async()=>{
  const {runtime,mutations,restore}=await boot(9);
  try{
    const panel=runtime.elements.get("config-panel-models");await button(panel,"新增模型").onclick();
    for(const preset of MODEL_PROVIDERS.filter(provider=>provider.id!=="custom")){
      edit(panel,"服务商",preset.id);
      assert.equal(input(panel,"URL").value,preset.url);
      assert.equal(input(panel,"API 格式").value,preset.api);
      assert.equal(flatten(panel).find(node=>node.tagName==="A").href,preset.docs);
    }
    edit(panel,"服务商","gemini");
    assert.equal(input(panel,"API 格式").value,"google-generative-ai");
    edit(panel,"服务商","custom");
    assert.equal(input(panel,"API 格式").value,"google-generative-ai");
    assert.equal(mutations.length,0);
  }finally{restore();}
});
