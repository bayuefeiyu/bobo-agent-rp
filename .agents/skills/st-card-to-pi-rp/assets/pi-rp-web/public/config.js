import { createRpClient } from "./vendor/rp-web-client/index.mjs";
import { collaborationModeOptions, getWorkflowNodeMode, switchWorkflowNode } from "./team-presets.js";
import { MODEL_PROVIDERS, MODEL_API_OPTIONS, providerPreset } from "./model-providers.js";

const state = { context:null, catalog:null, listing:null, profile:null, dirty:false };
const modelKeys = new WeakMap();
const modelKeySources = new WeakMap();
const modelOrigins = new WeakMap();
let saveQueue = Promise.resolve();
const assignmentSelection = new Set();
const assignmentVersions = new Map();
const assignmentResults = new Map();
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
const $ = selector => document.querySelector(selector);
let helpSequence = 0;
let referenceRefreshTimer;

async function renderReferenceLibrary() {
  const panel = $("#config-panel-references"); if (!panel) return;
  clearTimeout(referenceRefreshTimer);
  panel.replaceChildren();
  const view = card("用户私有创作资料库", "多张卡共享此设置。资料只通过检索模块获取；本设置独立于当前卡配置方案。");
  const input = document.createElement("input"); input.type = "text"; input.placeholder = "资料库的绝对目录"; input.setAttribute("aria-label", "私有资料库目录");
  const info = document.createElement("p"), save = document.createElement("button"); save.textContent = "保存资料库绑定";
  const browse=document.createElement("button");browse.type="button";browse.textContent="选择目录";browse.onclick=()=>openReferenceDirectoryPicker(input,info);
  const directoryRow=document.createElement("div");directoryRow.className="model-input-row";directoryRow.append(input,browse);
  view.root.append(directoryRow, save, info); panel.append(view.root);
  const show = value => { info.textContent = value.ready ? "文本索引已就绪；可调用自主检索或单元评分检索。" : value.bound ? "目录已绑定，文本索引未就绪。请先通过转换工具完成审核、入库。" : "尚未绑定资料库。"; };
  try { const value = await api("/api/v1/config/reference-library"); input.value = value.root || ""; show(value); }
  catch (error) { info.textContent = error.message; save.disabled = true; }
  save.onclick = async () => { save.disabled = true; try { show(await api("/api/v1/config/reference-library", { method: "PUT", body: { root: input.value.trim() } })); } catch (error) { info.textContent = error.message; } finally { save.disabled = false; } };
  await renderSemanticSettings(panel);
}
async function openReferenceDirectoryPicker(input,info) {
  const dialog=document.createElement("dialog");dialog.className="profile-config directory-picker";dialog.setAttribute("aria-label","选择私有创作资料库目录");
  const header=document.createElement("header"),title=document.createElement("h3"),cancel=document.createElement("button");title.textContent="选择资料库目录";cancel.textContent="取消";header.append(title,cancel);
  const roots=document.createElement("div");roots.className="directory-roots";
  const navigation=document.createElement("div");navigation.className="directory-navigation";
  const home=document.createElement("button"),up=document.createElement("button"),path=document.createElement("p");home.textContent="用户目录";up.textContent="上一级";path.className="directory-current-path";navigation.append(home,up,path);
  const folders=document.createElement("div");folders.className="directory-folders";
  const report=document.createElement("p");report.setAttribute("role","status");report.setAttribute("aria-live","polite");
  const footer=document.createElement("footer"),previous=document.createElement("button"),next=document.createElement("button"),choose=document.createElement("button");previous.textContent="上一页";next.textContent="下一页";choose.textContent="选择此目录";footer.append(previous,next,choose);
  dialog.append(header,roots,navigation,folders,report,footer);document.body.append(dialog);
  let closed=false,sequence=0,current=null;
  const close=()=>{closed=true;dialog.close();dialog.remove();input.focus();};cancel.onclick=close;dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
  const load=async(directory="",offset=0)=>{
    const requestId=++sequence;choose.disabled=true;up.disabled=true;previous.disabled=true;next.disabled=true;report.textContent="读取目录中…";folders.replaceChildren();
    try{
      const value=await api("/api/v1/config/reference-library/directories",{method:"POST",body:{path:directory,offset}});
      if(closed||requestId!==sequence)return;
      current=value;path.textContent=value.path;roots.replaceChildren();
      for(const root of value.roots){const button=document.createElement("button");button.textContent=root.name;button.onclick=()=>load(root.path);roots.append(button);}
      for(const folder of value.directories){const button=document.createElement("button");button.className="directory-folder";button.textContent=`📁 ${folder.name}`;button.onclick=()=>load(folder.path);folders.append(button);}
      up.disabled=!value.parent;previous.disabled=value.offset===0;next.disabled=value.nextOffset===null;choose.disabled=false;
      report.textContent=value.total?`共 ${value.total} 个文件夹${value.total>200?` · 第 ${Math.floor(value.offset/200)+1} 页`:""}`:"当前目录没有子文件夹，可以直接选择此目录。";
    }catch(error){if(!closed&&requestId===sequence){current=null;report.textContent=error.message;}}
  };
  home.onclick=()=>load();up.onclick=()=>current?.parent&&load(current.parent);previous.onclick=()=>current&&load(current.path,Math.max(0,current.offset-200));next.onclick=()=>current?.nextOffset!==null&&current&&load(current.path,current.nextOffset);
  choose.onclick=()=>{if(!current||choose.disabled)return;input.value=current.path;info.textContent="目录已选择，点击“保存资料库绑定”后生效。";close();};
  dialog.showModal();await load(input.value.trim());
}
async function renderSemanticSettings(panel) {
  const view = card("向量检索（c）", "保存设置不会向量化。测试连接只发送合成短文；手动构建向所选embedding服务发送正文片段，查询向embedding和rerank服务发送请求与候选。"); panel.append(view.root);
  let configuration;
  try { configuration = await api("/api/v1/config/reference-library/semantic/config"); } catch (error) { view.root.append(Object.assign(document.createElement("p"), { textContent: error.message })); return; }
  const config = structuredClone(configuration.config), grid = document.createElement("div"); grid.className = "field-grid";
  const semanticField = (label, value, description, options = {}) => field(label, value, description, { ...options, independent: true });
  let embeddingKey, rerankKey;
  grid.append(semanticField("启用向量检索", config.enabled, "需服务测试通过且已手动构建兼容索引才开放调用。关闭会取消在途语义操作，保留已建索引。", { type: "boolean", onInput: value => config.enabled = value }).label);
  for (const kind of ["embedding", "rerank"]) {
    const label = kind === "embedding" ? "Embedding" : "Rerank";
    for (const key of ["url", "model"]) grid.append(semanticField(`${label} ${key === "url" ? "接口完整地址" : "模型"}`, config[kind][key], key === "url" ? "填写完整POST路径，例如 /v1/embeddings 或 /v1/rerank。" : "服务中实际部署的模型标识。", { onInput: value => config[kind][key] = value }).label);
    grid.append(semanticField(`${label} API Key`, "", configuration[kind === "embedding" ? "hasEmbeddingSecret" : "hasRerankSecret"] ? "已有凭据；留空保留。" : "本地无认证服务可留空。", { type: "password", onInput: value => { if (kind === "embedding") embeddingKey = value || undefined; else rerankKey = value || undefined; } }).label);
  }
  grid.append(semanticField("向量维度", config.embedding.dimensions, "须与embedding服务一致；变更需手动重建。", { type: "number", min: 1, max: 8192, onInput: value => config.embedding.dimensions = value }).label);
  grid.append(semanticField("模型空间版本", config.embedding.spaceRevision, "同名模型更换权重时修改此值，并重新建库。", { onInput: value => config.embedding.spaceRevision = value }).label);
  const advanced = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "高级参数（预填推荐起测值）"; advanced.append(summary);
  for (const kind of ["embedding", "rerank", "chunking", "retrieval"]) {
    const extra = Object.fromEntries(Object.entries(config[kind]).filter(([key]) => !["url", "model", "dimensions", "spaceRevision"].includes(key)));
    advanced.append(semanticField(`${kind} 参数`, extra, kind === "chunking" ? "结构切片参数；保存后显示索引不兼容，需手动更新。" : kind === "retrieval" ? "精确扫描上限10万片段/512MiB，取先触及者。" : "输入长度、批量、前缀及超时；不是聊天模型配置。", { type: "json", rows: 9, wide: true, onInput: value => Object.assign(config[kind], value) }).label);
  }
  view.root.append(grid, advanced);
  const controls = document.createElement("div"), report = document.createElement("p"), jobs = document.createElement("div"); controls.className = "config-actions"; view.root.append(controls, report, jobs);
  let currentBuildRunning = false;
  const action = (label, fn) => { const button = document.createElement("button"); button.textContent = label; button.onclick = async () => { button.disabled = true; try { await fn(); await refresh(); } catch (error) { report.textContent = error.message; } finally { button.disabled = (button === build || button === rebuild) && currentBuildRunning; } }; controls.append(button); return button; };
  action("保存向量配置", async () => { const invalid = [...view.root.querySelectorAll("input,textarea")].find(input => !input.checkValidity()); if (invalid) { invalid.reportValidity(); throw new Error("请修正无效参数。"); } await api("/api/v1/config/reference-library/semantic/config", { method: "PUT", body: { config, embeddingKey, rerankKey } }); });
  action("测试已保存的服务", () => api("/api/v1/config/reference-library/semantic/test", { method: "POST", body: {} }));
  const build = action("手动构建 / 更新", () => api("/api/v1/config/reference-library/semantic/jobs", { method: "POST", body: {} }));
  const rebuild = action("重新编码全部内容", () => api("/api/v1/config/reference-library/semantic/jobs", { method: "POST", body: { forceEncoding: true } }));
  const labels = { semantic_disabled: "未开启", semantic_configuration_incomplete: "缺少服务配置", semantic_services_unverified: "请测试已保存服务", semantic_not_built: "尚未构建", semantic_index_incompatible: "配置已变更，请手动更新索引", semantic_empty: "没有有效片段", ready: "可用", ready_partial: "可用，覆盖不完整，待手动更新" };
  async function refresh() {
    clearTimeout(referenceRefreshTimer); const value = await api("/api/v1/config/reference-library/semantic/status");
    report.textContent = `状态：${labels[value.status] || value.status}${value.coverage ? `；覆盖${value.coverage.coveredUnits}/${value.coverage.totalUnits}单元，${value.coverage.validPassages}片段，跳过${value.coverage.skippedBlocks}块` : ""}`;
    const running = value.jobs.some(job => job.status === "running"); currentBuildRunning = running; build.disabled = running; rebuild.disabled = running; jobs.replaceChildren();
    for (const job of value.jobs.slice(-10)) {
      const row = document.createElement("p"); row.textContent = `${job.jobId.slice(0, 8)}：${job.status} / ${job.phase || ""}；处理${job.processedUnits || 0}单元，片段${job.passages || 0}，复用${job.reused || 0}${job.errorCode ? `；${job.errorCode}` : ""} `;
      if (["running", "cancelled", "failed", "interrupted"].includes(job.status)) { const button = document.createElement("button"), operation = job.status === "running" ? "cancel" : "resume"; button.textContent = operation === "cancel" ? "取消" : "继续"; button.onclick = async () => { try { await api(`/api/v1/config/reference-library/semantic/jobs/${job.jobId}/${operation}`, { method: "POST", body: {} }); await refresh(); } catch (error) { report.textContent = error.message; } }; row.append(button); }
      jobs.append(row);
    }
    if (running && !panel.hidden) referenceRefreshTimer = setTimeout(() => refresh().catch(error => report.textContent = error.message), 1500);
  }
  const query = document.createElement("input"), queryButton = document.createElement("button"), results = document.createElement("pre"); query.placeholder = "输入检索文本或关键词"; query.setAttribute("aria-label", "向量检索测试请求"); queryButton.textContent = "测试片段检索";
  queryButton.onclick = async () => { queryButton.disabled = true; try { const value = await api("/api/v1/config/reference-library/semantic/query", { method: "POST", body: { text: query.value } }); results.textContent = value.documents.map(d => `${d.title}\n${d.content}`).join("\n\n"); } catch (error) { results.textContent = error.message; } finally { queryButton.disabled = false; } };
  view.root.append(query, queryButton, results); await refresh();
}
document.addEventListener("click", event => { if (event.target.closest('[data-config-panel="references"]')) renderReferenceLibrary(); });

let historyRefreshTimer;
async function renderHistorySettings() {
  const panel = $("#config-panel-history"); if (!panel) return;
  clearTimeout(historyRefreshTimer); panel.replaceChildren();
  const view = card("历史原文回顾服务", "独立于资料库和记忆模块。连接测试使用合成短文；开启正文模块中的历史回顾后，会向服务发送合格历史片段以及本轮查询。此设置跨卡共享，服务凭据保存在本机。"); panel.append(view.root);
  let configuration;
  try { configuration = await api("/api/v1/config/narrative-history/config"); }
  catch (error) { view.root.append(Object.assign(document.createElement("p"), { textContent: error.message })); return; }
  const config = structuredClone(configuration.config), grid = document.createElement("div"); grid.className = "field-grid";
  let embeddingKey, rerankKey;
  for (const kind of ["embedding", "rerank"]) {
    const label = kind === "embedding" ? "Embedding" : "Rerank";
    for (const key of ["url", "model"]) grid.append(field(`${label} ${key === "url" ? "接口完整地址" : "模型"}`, config[kind][key], key === "url" ? "填写完整的 embeddings 或 rerank POST 地址。" : "实际部署的模型名称。", { independent: true, onInput: value => config[kind][key] = value }).label);
    grid.append(field(`${label} API Key`, "", configuration[kind === "embedding" ? "hasEmbeddingSecret" : "hasRerankSecret"] ? "已有凭据；留空保留。" : "本地无认证服务可留空。", { type: "password", independent: true, onInput: value => { if (kind === "embedding") embeddingKey = value || undefined; else rerankKey = value || undefined; } }).label);
  }
  grid.append(field("向量维度", config.embedding.dimensions, "与服务一致；修改后自动建立新的向量空间。", { type: "number", min: 1, max: 8192, independent: true, onInput: value => config.embedding.dimensions = value }).label);
  grid.append(field("模型空间版本", config.embedding.spaceRevision, "同名模型更换权重时修改；旧空间向量不会混用。", { independent: true, onInput: value => config.embedding.spaceRevision = value }).label);
  const advanced = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "高级服务参数"; advanced.append(summary);
  for (const kind of ["embedding", "rerank"]) {
    const extra = Object.fromEntries(Object.entries(config[kind]).filter(([key]) => !["url", "model", "dimensions", "spaceRevision"].includes(key)));
    advanced.append(field(`${kind} 参数`, extra, "长度、超时、前缀及批量限制；rerank minScore 可按模型设定，null 表示不设置阈值。", { type: "json", rows: 7, wide: true, independent: true, onInput: value => Object.assign(config[kind], value) }).label);
  }
  const controls = document.createElement("div"), report = document.createElement("p"); controls.className = "config-actions"; report.setAttribute("aria-live", "polite"); view.root.append(grid, advanced, controls, report);
  const refresh = async () => {
    clearTimeout(historyRefreshTimer);
    const value = await api("/api/v1/config/narrative-history/status");
    const connection = value.configuration?.verified ? "服务已验证" : "请保存并测试服务";
    report.textContent = value.sessionAvailable ? `${connection}；${value.enabled ? "回顾已开启" : "回顾已关闭"}；已索引 ${value.indexedSources}/${value.eligibleSources} 篇，待处理 ${value.pendingSources} 篇；保护轮次：${value.protectedTurns.join("、") || "无"}；索引轮次：${value.indexedTurns.join("、") || "无"}${value.partial ? "；覆盖不完整" : ""}${value.job ? `；任务 ${value.job.status}，已处理 ${value.job.processedSources} 篇${value.job.finishedAt ? `，完成于 ${new Date(value.job.finishedAt).toLocaleString()}` : ""}${value.job.errorCode ? `，${value.job.errorCode}` : ""}` : ""}` : `${connection}；开始或恢复聊天后显示会话索引状态。`;
    if (value.warningCode === "history_index_corrupt") report.textContent += "；索引损坏，请在正文模块选择重新编码。";
    if (value.job?.warningCode === "history_index_corrupt_rebuilt") report.textContent += "；已重建损坏索引，原文件保留用于诊断。";
    if (!panel.hidden) historyRefreshTimer = setTimeout(() => refresh().catch(error => report.textContent = error.message), value.job?.status === "running" ? 1500 : 5000);
  };
  const action = (label, fn) => { const button = document.createElement("button"); button.textContent = label; button.onclick = async () => { button.disabled = true; try { await fn(); await refresh(); } catch (error) { report.textContent = error.message; } finally { button.disabled = false; } }; controls.append(button); };
  action("保存服务配置", async () => { const invalid = [...view.root.querySelectorAll("input,textarea")].find(input => !input.checkValidity()); if (invalid) { invalid.reportValidity(); throw new Error("请修正无效参数。"); } return api("/api/v1/config/narrative-history/config", { method: "PUT", body: { config, embeddingKey, rerankKey } }); });
  action("测试已保存服务", () => api("/api/v1/config/narrative-history/test", { method: "POST", body: {} }));
  action("刷新状态", refresh);
  await refresh();
}
document.addEventListener("click", event => { if (event.target.closest('[data-config-panel="history"]')) renderHistorySettings(); });

const configClient = createRpClient({ baseUrl: window.location.href, fetch: (...args) => fetch(...args), auth: () => token ? { "x-rp-config-token": token } : {} });
let configConnection;
window.addEventListener("rp-read-context", event => {
  const current = configClient.readContext, next = event.detail;
  if (current && next && current.serverInstanceId === next.serverInstanceId && current.cardId === next.cardId) configClient.setReadContext({ ...next, executionId: null });
});
window.addEventListener("pagehide", () => { clearTimeout(referenceRefreshTimer); clearTimeout(historyRefreshTimer); configClient.dispose(); }, { once: true });
async function api(path, options = {}) {
  configConnection ||= configClient.connect().catch(error => { configConnection = null; throw error; });
  await configConnection;
  return configClient.request(path, options);
}

function status(message, error = false) { const node=$("#status"); node.textContent=message; node.style.color=error?"var(--danger)":"var(--muted)"; }
function markDirty() { if (state.profile?.builtin) return; state.dirty=true; status("有尚未保存的修改。") }
function deepClone(value) { return structuredClone(value); }
function pointerParts(path) { return path.split("/").slice(1).map(item => item.replaceAll("~1","/").replaceAll("~0","~")); }
function getAt(value, path) { let current=value; for (const part of pointerParts(path)) current=current?.[Array.isArray(current)?Number(part):part]; return current; }
function setAt(value, path, next) { const parts=pointerParts(path); let current=value; for(let i=0;i<parts.length-1;i+=1){const key=Array.isArray(current)?Number(parts[i]):parts[i]; const following=parts[i+1]; current[key]??=/^\d+$/.test(following)?[]:{}; current=current[key];} const last=Array.isArray(current)?Number(parts.at(-1)):parts.at(-1); current[last]=next; }

function help(text) { const node=document.createElement("span"); node.className="help"; node.tabIndex=0; node.textContent="?"; node.dataset.tooltip=text; node.setAttribute("aria-label",text); return node; }
function fieldCaption(labelText, description) { const caption=document.createElement("span");caption.className="field-caption";const helpNode=help(description);helpNode.id=`config-help-${++helpSequence}`;caption.append(document.createTextNode(labelText),helpNode);return {caption,helpNode}; }
function field(labelText, value, description, { type="text", wide=false, options=null, min=null, max=null, required=false, rows=4, onInput, independent=false }={}) {
  const label=document.createElement("label"); label.className=`field${wide?" wide":""}`; const {caption,helpNode}=fieldCaption(labelText,description); label.append(caption);
  let input;
  if(type==="textarea"||type==="json"){ input=document.createElement("textarea"); input.rows=rows; input.value=type==="json"?JSON.stringify(value??{},null,2):(value??""); }
  else if(type==="boolean"){ input=document.createElement("input"); input.type="checkbox"; input.checked=Boolean(value); }
  else if(options?.length){ input=document.createElement("select"); for(const option of options){const node=document.createElement("option"); const item=typeof option==="string"?{value:option,label:option}:option; node.value=item.value??""; node.textContent=item.label; input.append(node);} if(options.some(option=>option.value==="pi:current")){input.dataset.modelOptions="true";if(value&&!options.some(option=>option.value===value)){const missing=document.createElement("option");missing.value=value;missing.textContent=`${value}（已失效）`;input.append(missing);}}input.value=value??""; }
  else { input=document.createElement("input"); input.type=type; input.value=value??""; if(min!==null)input.min=min;if(max!==null)input.max=max; }
  input.dataset.configLabel=labelText;
  input.disabled=!independent&&Boolean(state.profile?.builtin); input.required=required; input.title=description; input.setAttribute("aria-describedby",helpNode.id); input.addEventListener("input",()=>{let next=type==="boolean"?input.checked:input.value;if(type==="number")next=input.value===""?null:Number(input.value);if(type==="json"){try{next=JSON.parse(input.value);input.setCustomValidity("");}catch{input.setCustomValidity("请输入有效 JSON");return;}}onInput?.(next,input);if(!independent)markDirty();}); label.append(input); return {label,input};
}
function card(title, description="") { const root=document.createElement("article");root.className="config-card";const header=document.createElement("header");const copy=document.createElement("div");const h=document.createElement("h3");h.textContent=title;copy.append(h);if(description){const p=document.createElement("p");p.textContent=description;copy.append(p);}header.append(copy);root.append(header);return {root,header}; }
function optionGroups(select, items, selected, labelOf) { const groups=new Map(); for(const item of items){if(!groups.has(item.group))groups.set(item.group,[]);groups.get(item.group).push(item);} for(const [name,values] of groups){const group=document.createElement("optgroup");group.label=name;for(const item of values){const option=document.createElement("option");option.value=item.key;option.textContent=labelOf(item);group.append(option);}select.append(group);}select.value=selected||items[0]?.key||""; }
function modelOptions() { return [{value:"",label:"未指定"},{value:"pi:current",label:"当前 Pi 模型"},...(state.savedProfile?.models||[]).map(item=>({value:item.id,label:`${item.name||item.model||item.id} · ${item.id}`}))]; }
function assignmentModelId(item) { return Object.hasOwn(state.profile.agentOverrides[item.key]||{},"defaultModelId")?state.profile.agentOverrides[item.key].defaultModelId:item.base.defaultModelId; }
function modelName(id) { const model=(state.savedProfile?.models||[]).find(item=>item.id===id);return id==="pi:current"?"当前 Pi 模型":model?`${model.name||model.model||id} · ${id}`:id?`${id}（已失效）`:"未指定"; }
function runtimePolicy() { return state.profile.workflowOverrides.runtimePolicy||state.catalog.runtimePolicy||{schemaVersion:1,maxConcurrency:10,modelFailure:{silentFallback:false,defaultFallbackModelId:null}}; }
function moduleLabel(item) { return item.group?.replace(/^模块 · /,"") || item.moduleId; }
function ownedAgents() { return state.catalog.agents.filter(item=>item.moduleId); }
function ownedWorkflows() { return state.catalog.workflows.filter(item=>item.moduleId); }
function agentOptions() { return [{value:"",label:"继承/未指定"},...ownedAgents().map(item=>({value:item.base.id,label:`${moduleLabel(item)} · ${item.base.name||item.base.id}`}))]; }

function renderModels() {
  const panel=$("#config-panel-models");panel.replaceChildren();
  const intro=card("模型配置","获取模型列表和测试连接直接使用当前填写的参数；保存后才写入配置方案及本机凭据缓存。");
  const picker=document.createElement("div");picker.className="model-picker";
  const selector=field("模型配置",String(Math.max(0,state.profile.models.indexOf(state.selectedModel))),"选择已保存模型或尚未保存的草稿。",{options:state.profile.models.length?state.profile.models.map((model,index)=>({value:String(index),label:`${model.name||model.id||"新模型"}${modelOrigins.has(model)?"":"（未保存）"}`})):[{value:"0",label:"暂无已保存模型"}],onInput:value=>{state.selectedModel=state.profile.models[Number(value)];renderModels();},independent:true});
  selector.input.setAttribute("aria-label","选择模型配置");selector.input.disabled=!state.profile.models.length;picker.append(selector.label);
  const add=document.createElement("button");add.textContent="新增模型";add.disabled=Boolean(state.profile.builtin);
  add.onclick=()=>{const model={schemaVersion:1,id:"",name:"",provider:"custom",model:"",baseUrl:"",api:"openai-completions",contextWindow:128000,maxOutputTokens:4096,thinking:"off",maxConcurrency:10,headPrompt:null,tailPrompt:null};state.profile.models.push(model);state.selectedModel=model;markDirty();renderModels();};
  if(!state.profile.models.includes(state.selectedModel))state.selectedModel=state.profile.models[0]||null;
  const copy=document.createElement("button");copy.textContent="复制配置";copy.disabled=Boolean(state.profile.builtin)||!modelOrigins.has(state.selectedModel);
  copy.onclick=()=>{
    const source=state.savedProfile.models.find(model=>model.id===modelOrigins.get(state.selectedModel));
    if(!source)return;
    let suffix="-copy",index=2;while(state.profile.models.some(model=>model.id===source.id+suffix))suffix=`-copy-${index++}`;
    const model={...deepClone(source),id:source.id+suffix,name:(source.name||source.id)+suffix};delete model.hasApiKey;modelKeySources.set(model,source.id);
    state.profile.models.push(model);state.selectedModel=model;markDirty();renderModels();status("已复制配置，将直接使用原配置的缓存 Key。");
  };
  const remove=document.createElement("button");remove.className="danger";remove.textContent="移除";remove.disabled=Boolean(state.profile.builtin)||!state.selectedModel;
  remove.onclick=async()=>{
    const model=state.selectedModel,origin=modelOrigins.get(model);
    if(!confirm(`移除模型 ${model.id||"新模型"}？`))return;
    try{
      if(origin)await persistItem(profile=>{profile.models=profile.models.filter(item=>item.id!==origin);},"模型已移除。",{removeModelId:origin});
      state.profile.models=state.profile.models.filter(item=>item!==model);state.selectedModel=null;updateDirty();renderModels();
    }catch(error){status(error.message,true);}
  };
  picker.append(add,copy,remove);intro.root.append(picker);panel.append(intro.root);
  if(!state.profile.models.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="当前方案没有模型配置。";panel.append(empty);return;}
  for(const [index,model] of state.profile.models.entries()){
    if(model!==state.selectedModel)continue;
    const item=card(model.name||model.id||"新模型",modelKeySources.has(model)&&model.hasSecret?"使用原配置缓存凭据":model.hasSecret?"已保存本机凭据":"未保存凭据");const grid=document.createElement("div");grid.className="field-grid";
    const bind=(key,description,options={})=>field(options.label||key,model[key],description,{...options,onInput:value=>{model[key]=value??null;}});
    const id=bind("id","用于工作流引用；已保存的 ID 保持固定。",{label:"ID",required:true});
    id.input.pattern="[A-Za-z0-9][A-Za-z0-9._-]*";id.input.dataset.modelIndex=String(index);
    id.input.disabled=Boolean(state.profile.builtin)||modelOrigins.has(model);
    const secret=field("API Key",modelKeys.get(model)||"","获取列表和测试使用当前 Key；保存时写入本机缓存，留空保留原 Key。",{type:"password",wide:true,onInput:value=>modelKeys.set(model,value)});
    secret.input.placeholder=model.hasSecret?"留空使用已保存的 Key":"输入 API Key";secret.input.dataset.secretFor=model.id;
    id.input.addEventListener("input",()=>{secret.input.dataset.secretFor=model.id;});
    const url=bind("baseUrl","模型服务 API 根地址。",{label:"URL",type:"url",wide:true});
    const apiField=bind("api","按服务商官方协议请求；自定义服务可自行指定。",{label:"API 格式",options:MODEL_API_OPTIONS});
    const providerInfo=document.createElement("div");providerInfo.className="model-provider-info";url.label.append(providerInfo);
    const showProvider=()=>{
      const preset=providerPreset(model.provider);providerInfo.replaceChildren();
      if(!preset?.docs)return;
      const link=document.createElement("a");link.href=preset.docs;link.target="_blank";link.rel="noopener noreferrer";link.textContent="官方接口文档";
      const apply=document.createElement("button");apply.type="button";apply.textContent="填入官方配置";apply.disabled=Boolean(state.profile.builtin);apply.onclick=()=>{applyPreset();markDirty();};
      providerInfo.append(document.createTextNode(`官方 URL：${preset.url}。${preset.note||""} `),link,apply);
    };
    const applyPreset=()=>{const preset=providerPreset(model.provider);if(preset&&model.provider!=="custom"){model.baseUrl=preset.url;model.api=preset.api;url.input.value=preset.url;apiField.input.value=preset.api;}showProvider();};
    const provider=field("服务商",model.provider,"选择服务商时自动填写已核对的官方 URL 和 API 格式。",{options:MODEL_PROVIDERS.map(provider=>({value:provider.id,label:provider.name})),onInput:value=>{
      model.provider=value;applyPreset();
    }});showProvider();
    const modelName=bind("model","发送给服务的实际模型名，也可从获取的列表中选择。",{label:"模型名",wide:true,required:true});
    const modelRow=document.createElement("div");modelRow.className="model-input-row";
    const suggestions=document.createElement("datalist");suggestions.id=`model-list-${++helpSequence}`;modelName.input.setAttribute("list",suggestions.id);
    modelRow.append(modelName.input);modelName.label.append(modelRow,suggestions);
    grid.append(id.label,bind("name","用于界面显示，不影响工作流引用。",{label:"显示名称"}).label,
      provider.label,apiField.label,url.label,secret.label,modelName.label,
      bind("contextWindow","模型可接受的上下文 Token 上限。",{label:"上下文长度",type:"number",min:1}).label,
      bind("maxOutputTokens","单次输出 Token 上限。",{label:"最大输出",type:"number",min:1}).label,
      field("思考强度",model.thinking??model.thinkingLevel??"off","模型支持时使用的思考强度。",{options:[{value:"off",label:"关闭/默认"},"minimal","low","medium","high","xhigh","max"],onInput:value=>{model.thinking=value;delete model.thinkingLevel;}}).label,
      bind("maxConcurrency","该模型允许的最大并发调用数。",{label:"最大并发",type:"number",min:1,max:10}).label,
      bind("headPrompt","追加在 Agent 提示词之前的模型级提示。",{label:"前置提示词",type:"textarea",wide:true}).label,
      bind("tailPrompt","每次模型调用前都会从旧位置移除并追加到上下文最末尾；工具调用后再次请求模型时也会重新置底。",{label:"后置提示词",type:"textarea",wide:true}).label);
    item.root.append(grid);const actions=document.createElement("div");actions.className="model-actions";
    const profileId=state.profile.id;
    for(const [label,path] of [["获取模型列表","discover"],["测试","test"]]){
      const button=document.createElement("button");button.textContent=label;
      button.disabled=state.context?.mode!=="play"||Boolean(state.profile.builtin);
      button.title="使用当前表单直接连接，不会保存或激活配置方案。";
      const result=path==="test"?document.createElement("span"):null;
      if(result){result.className="model-test-result";result.hidden=true;result.setAttribute("role","status");result.setAttribute("aria-live","polite");}
      const report=(message,kind="success")=>{
        if(result){result.hidden=false;result.textContent=message;result.dataset.state=kind;}
        else status(message,kind==="error");
      };
      button.onclick=async()=>{
        const requiredInputs=path==="discover"?[url.input]:[url.input,modelName.input];
        const invalid=requiredInputs.find(input=>!input.checkValidity());
        if(invalid){invalid.focus();invalid.reportValidity();return report(`请修正“${invalid.dataset.configLabel}”。`,"error");}
        button.disabled=true;
        if(result)report("测试中…","pending");
        try{
          const value=await api(`/api/v1/models/${path}`,{method:"POST",body:{profileId,modelId:modelOrigins.get(model)||modelKeySources.get(model)||null,modelProfile:model,baseUrl:model.baseUrl,api:model.api,apiKey:secret.input.value}});
          if(state.profile.id!==profileId)return;
          if(path==="discover"){
            suggestions.replaceChildren();for(const name of value.models){const option=document.createElement("option");option.value=name;suggestions.append(option);}
            status(value.models.length?`已获取 ${value.models.length} 个模型，可在模型名输入框中选择。`:"服务未返回模型列表。");
          }else report(`连接成功（${value.elapsedMs}ms）：${value.reply||""}`);
        }catch(error){report(error.message,"error")}finally{button.disabled=false}
      };
      if(path==="discover")modelRow.append(button);
      else{const group=document.createElement("div");group.className="model-test-action";group.append(button,result);actions.append(group);}
    }
    addSave(item,{label:"保存",validate:()=>{
      id.input.setCustomValidity(state.profile.models.some(other=>other!==model&&other.id===model.id)?"模型 ID 已存在，请使用不同的 ID。":"");
    },capture:()=>{
      const saved=deepClone(model),origin=modelOrigins.get(model);return profile=>{
        const existing=profile.models.findIndex(item=>item.id===(origin||saved.id));
        if(!origin&&existing!==-1)throw new Error("模型 ID 已存在，请使用不同的 ID。");
        if(existing===-1)profile.models.push(saved);else profile.models[existing]=saved;
      };
    },options:()=>({model,apiKey:secret.input.value,sourceModelId:modelKeySources.get(model)}),afterSave:()=>renderModels()},actions);
    if(model.hasSecret&&modelOrigins.has(model)){const clearSecret=document.createElement("button");clearSecret.className="danger";clearSecret.textContent="清除 API Key";clearSecret.disabled=Boolean(state.profile.builtin);clearSecret.title="从本机项目隔离缓存删除此方案和模型对应的凭据。";clearSecret.onclick=async()=>{if(!confirm(`清除模型 ${model.id} 的本机 API Key？`))return;try{await api(`/api/v1/config/profiles/${state.profile.id}/secrets/models/${model.id}`,{method:"PUT",body:{apiKey:""}});model.hasSecret=false;renderModels();status("已清除本机 API Key。");}catch(error){status(error.message,true)}};secret.label.append(clearSecret);}
    item.root.append(actions);panel.append(item.root);
  }
}

function renderAgents() {
  const panel=$("#config-panel-agents");panel.replaceChildren();
  const toolbar=document.createElement("div");toolbar.className="list-toolbar agent-pickers";
  const sourceLabel=document.createElement("label");sourceLabel.className="field";sourceLabel.append(fieldCaption("模块","按所属模块筛选 Agent。").caption);
  const sourceSelect=document.createElement("select");sourceLabel.append(sourceSelect);
  const agentLabel=document.createElement("label");agentLabel.className="field";agentLabel.append(fieldCaption("Agent","选择要在当前配置方案中覆盖的 Agent；不会修改源文件。").caption);
  const agentSelect=document.createElement("select");agentLabel.append(agentSelect);
  toolbar.append(sourceLabel,agentLabel);panel.append(toolbar);

  const sources=new Map();
  for(const item of ownedAgents()){
    const id=item.moduleId;
    if(!sources.has(id))sources.set(id,{id,label:moduleLabel(item)});
  }
  for(const source of sources.values()){const option=document.createElement("option");option.value=source.id;option.textContent=source.label;sourceSelect.append(option);}

  const render=()=>{
    panel.querySelectorAll(".config-card,.empty").forEach(node=>node.remove());
    const item=state.catalog.agents.find(value=>value.key===agentSelect.value);
    if(!item){const empty=document.createElement("div");empty.className="empty";empty.textContent="该分类没有 Agent。";panel.append(empty);return;}
    const base=item.base;
    const override=state.profile.agentOverrides[item.key]||{};
    const effective={...deepClone(base),...deepClone(override)};
    const sourceName=moduleLabel(item);
    const view=card(effective.name||base.id,`${sourceName} · ${base.id}`);
    const grid=document.createElement("div");grid.className="field-grid";
    const assign=(key,value)=>{state.profile.agentOverrides[item.key]??={};state.profile.agentOverrides[item.key][key]=value;};
    grid.append(
      field("名称",effective.name,"覆盖 Agent 的显示名称。",{onInput:value=>assign("name",value)}).label,
      field("简介",effective.description,"说明 Agent 的职责和适用范围。",{type:"textarea",onInput:value=>assign("description",value)}).label,
      field("输出形式",effective.outputMode,"约束 Agent 返回文本或 JSON。",{options:["text","json"],onInput:value=>assign("outputMode",value)}).label,
      field("工具",(effective.tools||[]).join(", "),"逗号分隔的工具白名单。",{wide:true,onInput:value=>assign("tools",value.split(",").map(item=>item.trim()).filter(Boolean))}).label,
      field("上下文权限",(effective.contextPermissions||[]).join(", "),"逗号分隔的上下文访问权限。",{wide:true,onInput:value=>assign("contextPermissions",value.split(",").map(item=>item.trim()).filter(Boolean))}).label,
      field("Agent 提示词",effective.prompt,"定义 Agent 的具体职责、边界和输出要求。",{type:"textarea",rows:14,wide:true,onInput:value=>assign("prompt",value)}).label,
    );
    const modelInfo=document.createElement("div");modelInfo.className="field wide";
    const modelText=document.createElement("span");modelText.dataset.agentModelKey=item.key;modelText.textContent=`指定模型：${modelName(assignmentModelId(item))}`;
    const configure=document.createElement("button");configure.type="button";configure.textContent="前往模型指定";configure.onclick=()=>showConfigPanel("config-panel-assignments");modelInfo.append(modelText,configure);grid.append(modelInfo);
    view.root.append(grid);
    addOverrideSave(view,"agentOverrides",item.key,"保存 Agent");panel.append(view.root);
  };
  const refreshAgentOptions=()=>{
    agentSelect.replaceChildren();
    const items=ownedAgents().filter(item=>item.moduleId===sourceSelect.value);
    for(const item of items){const option=document.createElement("option");option.value=item.key;option.textContent=item.base.name||item.base.id;agentSelect.append(option);}
    agentSelect.disabled=!items.length;render();
  };
  sourceSelect.onchange=refreshAgentOptions;agentSelect.onchange=render;refreshAgentOptions();
}

function renderModelAssignments() {
  const panel=$("#config-panel-assignments");panel.replaceChildren();
  const builtin=Boolean(state.profile.builtin),profileId=state.profile.id;
  const resultNode=(key)=>{
    const node=document.createElement("span");node.className="assignment-status";node.dataset.assignmentResult=key;node.setAttribute("role","status");node.setAttribute("aria-live","polite");return node;
  };
  const displayResult=(node,key)=>{const result=assignmentResults.get(key);node.textContent=result?.message||"";node.dataset.state=result?.kind||"saved";};
  const failureView=card("共用兜底模型","当前配置方案的全部工作流共用。关闭时直接报告模型问题；开启后自动尝试兜底，并记录切换原因。");
  const failure=runtimePolicy().modelFailure||{silentFallback:false,defaultFallbackModelId:null};
  const policyStatus=resultNode("policy");displayResult(policyStatus,"policy");
  const grid=document.createElement("div");grid.className="field-grid";
  const policyChange=async(key,value)=>{
    if(builtin)return;
    const next={...runtimePolicy().modelFailure,[key]:value};
    if(next.silentFallback&&!modelOptions().some(option=>option.value&&option.value===next.defaultFallbackModelId)){
      assignmentResults.set("policy",{kind:"error",message:"请先选择有效的兜底模型，再开启兜底。"});renderModelAssignments();return;
    }
    const version=(assignmentVersions.get("policy")||0)+1;assignmentVersions.set("policy",version);
    const savedPolicy=deepClone(state.savedProfile.workflowOverrides.runtimePolicy||state.catalog.runtimePolicy||{schemaVersion:1,maxConcurrency:10,modelFailure:{silentFallback:false,defaultFallbackModelId:null}});
    state.profile.workflowOverrides.runtimePolicy=deepClone(runtimePolicy());state.profile.workflowOverrides.runtimePolicy.modelFailure=next;
    assignmentResults.set("policy",{kind:"pending",message:"保存中…"});renderModelAssignments();updateDirty();
    try{
      await persistItem(profile=>{const policy=profile.workflowOverrides.runtimePolicy||deepClone(savedPolicy);policy.modelFailure={...policy.modelFailure,[key]:value};profile.workflowOverrides.runtimePolicy=policy;},"",{quiet:true});
      if(state.profile.id===profileId&&assignmentVersions.get("policy")===version)assignmentResults.set("policy",{kind:"saved",message:"已保存"});
    }catch(error){
      if(state.profile.id===profileId&&assignmentVersions.get("policy")===version){
        state.profile.workflowOverrides.runtimePolicy.modelFailure=deepClone(state.savedProfile.workflowOverrides.runtimePolicy?.modelFailure||state.catalog.runtimePolicy?.modelFailure||{silentFallback:false,defaultFallbackModelId:null});
        assignmentResults.set("policy",{kind:"error",message:`保存失败：${error.message}`});
      }
    }finally{if(state.profile.id===profileId){updateDirty();renderModelAssignments();}}
  };
  const enabled=field("启用兜底模型",failure.silentFallback,"默认关闭；开启时必须选定有效的兜底模型。",{type:"boolean",independent:true,onInput:value=>policyChange("silentFallback",value)});
  const fallback=field("兜底模型",failure.defaultFallbackModelId,"关闭时保留选择；当前 Pi 模型也必须明确指定。",{options:modelOptions(),independent:true,onInput:value=>policyChange("defaultFallbackModelId",value||null)});
  enabled.input.disabled=builtin;fallback.input.disabled=builtin;grid.append(enabled.label,fallback.label);failureView.root.append(grid,policyStatus);panel.append(failureView.root);

  const agents=ownedAgents();
  for(const key of assignmentSelection)if(!agents.some(item=>item.key===key))assignmentSelection.delete(key);
  const toolbar=document.createElement("div");toolbar.className="assignment-toolbar";
  const allLabel=document.createElement("label"),all=document.createElement("input");all.type="checkbox";all.disabled=builtin||!agents.length;
  all.checked=agents.length>0&&agents.every(item=>assignmentSelection.has(item.key));all.indeterminate=assignmentSelection.size>0&&!all.checked;
  all.addEventListener("change",()=>{for(const item of agents){if(all.checked)assignmentSelection.add(item.key);else assignmentSelection.delete(item.key);}renderModelAssignments();});
  allLabel.append(all,document.createTextNode(`全选（${agents.length} 个 Agent）`));toolbar.append(allLabel);
  const bulk=field(`批量指定（已选 ${assignmentSelection.size} 项）`,"","选择后立即保存所有选中 Agent 的模型。",{options:[{value:"",label:"选择模型并立即指定"},...modelOptions().filter(option=>option.value)],independent:true,onInput:value=>{if(value)saveAssignments(agents.filter(item=>assignmentSelection.has(item.key)),value);}});
  bulk.input.disabled=builtin||!assignmentSelection.size;bulk.input.dataset.batchModel="true";toolbar.append(bulk.label);
  const clear=document.createElement("button");clear.textContent="取消选择";clear.disabled=!assignmentSelection.size;clear.onclick=()=>{assignmentSelection.clear();renderModelAssignments();};toolbar.append(clear);panel.append(toolbar);
  const groups=new Map();for(const item of agents){if(!groups.has(item.moduleId))groups.set(item.moduleId,[]);groups.get(item.moduleId).push(item);}
  for(const items of groups.values()){
    const view=card(moduleLabel(items[0]),`${items.length} 个 Agent · 修改后立即保存`);view.root.classList.add("assignment-module");
    const selectLabel=document.createElement("label"),selectAll=document.createElement("input");selectAll.type="checkbox";selectAll.disabled=builtin;
    selectAll.checked=items.every(item=>assignmentSelection.has(item.key));selectAll.indeterminate=items.some(item=>assignmentSelection.has(item.key))&&!selectAll.checked;
    selectAll.addEventListener("change",()=>{for(const item of items){if(selectAll.checked)assignmentSelection.add(item.key);else assignmentSelection.delete(item.key);}renderModelAssignments();});selectLabel.append(selectAll,document.createTextNode("全选本模块"));view.header.append(selectLabel);
    for(const item of items){
      const row=document.createElement("div");row.className="assignment-row";row.dataset.agentKey=item.key;
      const check=document.createElement("input");check.type="checkbox";check.checked=assignmentSelection.has(item.key);check.disabled=builtin;check.setAttribute("aria-label",`选择 ${item.base.name||item.base.id}`);
      check.addEventListener("change",()=>{if(check.checked)assignmentSelection.add(item.key);else assignmentSelection.delete(item.key);renderModelAssignments();});
      const label=document.createElement("div");label.className="assignment-agent";const title=document.createElement("strong"),id=document.createElement("span");title.textContent=state.profile.agentOverrides[item.key]?.name||item.base.name||item.base.id;id.textContent=item.base.id;label.append(title,id);
      const model=field("指定模型",assignmentModelId(item),"此 Agent 的全部调用位置共用该模型；未指定时仅在开启兜底后使用兜底模型。",{options:modelOptions(),independent:true,onInput:value=>saveAssignments([item],value||null)});model.input.disabled=builtin;model.input.dataset.assignmentAgent=item.key;
      const result=resultNode(item.key);const previous=assignmentResults.get(item.key);
      if(previous)displayResult(result,item.key);else{const value=assignmentModelId(item);result.textContent=value&&modelOptions().some(option=>option.value===value)?"已保存":value?"模型已失效":"未指定模型";result.dataset.state=value&&modelOptions().some(option=>option.value===value)?"saved":"error";}
      row.append(check,label,model.label,result);
      if(previous?.kind==="error"&&Object.hasOwn(previous,"retryModelId")){const retry=document.createElement("button");retry.textContent="重试";retry.disabled=builtin;retry.onclick=()=>saveAssignments([item],previous.retryModelId);row.append(retry);}
      view.root.append(row);
    }
    panel.append(view.root);
  }
  if(!agents.length){const empty=document.createElement("p");empty.className="empty";empty.textContent="当前配置目录没有 Agent。";panel.append(empty);}
}

async function saveAssignments(items,modelId) {
  if(!items.length||state.profile.builtin)return;
  const profileId=state.profile.id,versions=new Map();
  for(const item of items){
    const version=(assignmentVersions.get(item.key)||0)+1;assignmentVersions.set(item.key,version);versions.set(item.key,version);
    state.profile.agentOverrides[item.key]??={};state.profile.agentOverrides[item.key].defaultModelId=modelId;
    assignmentResults.set(item.key,{kind:"pending",message:"保存中…"});
  }
  renderModelAssignments();refreshAgentModelLabels();updateDirty();
  try{
    await persistItem(profile=>{for(const item of items){profile.agentOverrides[item.key]??={};profile.agentOverrides[item.key].defaultModelId=modelId;}},"",{quiet:true});
    if(state.profile.id!==profileId)return;
    for(const item of items)if(assignmentVersions.get(item.key)===versions.get(item.key))assignmentResults.set(item.key,{kind:"saved",message:"已保存"});
  }catch(error){
    if(state.profile.id!==profileId)return;
    for(const item of items)if(assignmentVersions.get(item.key)===versions.get(item.key)){
      const saved=state.savedProfile.agentOverrides[item.key]||{};
      if(Object.hasOwn(saved,"defaultModelId"))state.profile.agentOverrides[item.key].defaultModelId=saved.defaultModelId;else delete state.profile.agentOverrides[item.key].defaultModelId;
      assignmentResults.set(item.key,{kind:"error",message:`保存失败：${error.message}`,retryModelId:modelId});
    }
  }finally{if(state.profile.id===profileId){updateDirty();renderModelAssignments();refreshAgentModelLabels();}}
}
function refreshAgentModelLabels() { for(const node of document.querySelectorAll("[data-agent-model-key]")){const item=ownedAgents().find(item=>item.key===node.dataset.agentModelKey);if(item)node.textContent=`指定模型：${modelName(assignmentModelId(item))}`;} }

function renderWorkflows() {
  const panel=$("#config-panel-workflows");panel.replaceChildren();
  const toolbar=document.createElement("div");toolbar.className="list-toolbar workflow-pickers";
  const sourceLabel=document.createElement("label");sourceLabel.className="field";sourceLabel.append(fieldCaption("模块","按所属模块筛选工作流。").caption);
  const sourceSelect=document.createElement("select");sourceLabel.append(sourceSelect);
  const workflowLabel=document.createElement("label");workflowLabel.className="field";workflowLabel.append(fieldCaption("工作流","编辑工作流运行策略、触发方式和所有节点；运行状态请在侧栏“工作流”页面查看。").caption);
  const workflowSelect=document.createElement("select");workflowLabel.append(workflowSelect);toolbar.append(sourceLabel,workflowLabel);panel.append(toolbar);
  const sources=new Map();
  for(const item of ownedWorkflows()){const id=item.moduleId;if(!sources.has(id))sources.set(id,{id,label:moduleLabel(item)});}
  for(const source of sources.values()){const option=document.createElement("option");option.value=source.id;option.textContent=source.label;sourceSelect.append(option);}

  const updateWorkflow=(item,path,value)=>{
    const next=deepClone(state.profile.workflowOverrides[item.key]||item.base);
    setAt(next,path,value);
    state.profile.workflowOverrides[item.key]=next;
  };
  const updateWorkflowNodeMode=(item,node,mode)=>{
    state.profile.nodeModeBackups??={};
    const workflow=deepClone(state.profile.workflowOverrides[item.key]||item.base);
    const baseNode=(item.base.nodes||[]).find(value=>value.id===node.id);
    const preset=item.collaborationPresets?.[node.id]||item.base.collaborationPresets?.[node.id];
    const result=switchWorkflowNode(workflow,node.id,mode,{workflowKey:item.key,preset,baseNode,nodeModeBackups:state.profile.nodeModeBackups});
    state.profile.workflowOverrides[item.key]=result.workflow;
    state.profile.nodeModeBackups=result.nodeModeBackups;
  };
  const nodeTypeLabel=type=>({agent:"Agent",team:"团队会议",code:"代码",call:"调用工作流","turn-finalize":"回合收尾","workflow-return":"工作流返回"})[type]||type||"未知";
  const nodeTypeDescription=node=>{
    if(node.type==="team"&&node.team?.protocol==="collaboration")return "按协作成员的阶段任务与接力协作，每位成员使用其 Agent 指定的模型。";
    if(node.type==="agent")return "调用 Agent 进行推理或创作，可选择 Agent 和节点提示词；模型在模型指定页设置。";
    if(node.type==="team")return "按固定议程组织 Leader、秘书、动态专家和助理协作；每位成员使用独立会话与 Agent/模型绑定。";
    if(node.type==="code")return `执行确定性代码${node.metadata?.entryFile?`：${node.metadata.entryFile}`:"。"}`;
    if(node.type==="call")return `调用子工作流${node.target?`：${node.target}`:"。"}`;
    if(node.type==="turn-finalize")return "完成本轮正文并提交最终展示结果。";
    if(node.type==="workflow-return")return "整理并返回该工作流声明的导出结果。";
    return "该节点不调用 Agent。";
  };
  const renderRuntimePolicy=()=>{
    const policy=state.profile.workflowOverrides.runtimePolicy||state.catalog.runtimePolicy||{schemaVersion:1,maxConcurrency:10,modelFailure:{silentFallback:false,defaultFallbackModelId:null}};
    const view=card("运行策略","属于当前配置方案；工作流运行页只显示状态，不再编辑这些值。");
    view.root.classList.add("workflow-policy-config");
    const grid=document.createElement("div");grid.className="field-grid";
    const assign=(path,value)=>{const next=deepClone(state.profile.workflowOverrides.runtimePolicy||policy);setAt(next,path,value);state.profile.workflowOverrides.runtimePolicy=next;};
    grid.append(
      field("全局最大并发",policy.maxConcurrency,"同时运行的工作流节点上限。",{type:"number",min:1,max:10,onInput:value=>assign("/maxConcurrency",value)}).label,
    );
    view.root.append(grid);
    addSave(view,{label:"保存运行策略",capture:()=>{const maxConcurrency=state.profile.workflowOverrides.runtimePolicy?.maxConcurrency??policy.maxConcurrency;return profile=>{profile.workflowOverrides.runtimePolicy={...(profile.workflowOverrides.runtimePolicy||deepClone(policy)),maxConcurrency};};}});panel.append(view.root);
  };
  const render=()=>{
    panel.querySelectorAll(".config-card,.empty,.workflow-config-editor").forEach(node=>node.remove());
    renderRuntimePolicy();
    const item=state.catalog.workflows.find(value=>value.key===workflowSelect.value);
    if(!item){const empty=document.createElement("div");empty.className="empty";empty.textContent="该分类没有工作流。";panel.append(empty);return;}
    const current=deepClone(state.profile.workflowOverrides[item.key]||item.base);
    const editor=document.createElement("div");editor.className="workflow-config-editor";panel.append(editor);
    const sourceName=moduleLabel(item);
    const overview=card(item.base.title||item.base.id,`${sourceName} · ${item.base.description||"无说明"}`);
    overview.root.classList.add("workflow-overview");
    const overviewMeta=document.createElement("div");overviewMeta.className="workflow-meta";
    overviewMeta.append(Object.assign(document.createElement("span"),{textContent:`ID：${item.base.id}`}),Object.assign(document.createElement("span"),{textContent:`类型：${item.base.kind||"未声明"}`}),Object.assign(document.createElement("span"),{textContent:`节点：${(current.nodes||[]).length}`}));
    overview.root.append(overviewMeta);

    if(current.kind==="foreground"){
      const turnContext=document.createElement("section");turnContext.className="workflow-turn-context-config";
      const heading=document.createElement("h4");heading.textContent="正文上下文";
      const grid=document.createElement("div");grid.className="field-grid";
      grid.append(field("最近完整正文回合数",current.turnContext?.recentCompleteTurns??5,"决定正文 Agent 和依赖正文快照的工作流可读取多少个最近完整回合；下一次工作流实例生效。",{type:"number",min:1,max:50,required:true,onInput:value=>updateWorkflow(item,"/turnContext/recentCompleteTurns",value)}).label);
      turnContext.append(heading,grid);overview.root.append(turnContext);
    }

    const hasAgentNodes=(current.nodes||[]).some(node=>node.type==="agent");
    if(hasAgentNodes){
      const defaults=document.createElement("section");defaults.className="workflow-defaults";
      const heading=document.createElement("h4");heading.textContent="Agent 节点默认值";
      const grid=document.createElement("div");grid.className="field-grid";
      grid.append(
        field("默认 Agent",current.defaults?.agentId,"Agent 节点未单独指定 Agent 时使用。",{options:agentOptions(),onInput:value=>updateWorkflow(item,"/defaults/agentId",value||null)}).label,
      );
      defaults.append(heading,grid);overview.root.append(defaults);
    }

    if(current.kind!=="foreground"){
      const trigger=document.createElement("section");trigger.className="workflow-trigger-config";
      const heading=document.createElement("h4");heading.textContent="触发方式";
      const grid=document.createElement("div");grid.className="field-grid";
      const triggerType=current.trigger?.type||"manual";
      grid.append(field("触发类型",triggerType,"决定该后台工作流何时启动。",{options:[{value:"manual",label:"手动触发"},{value:"after-opening",label:"开场选定后"},{value:"after-workflow",label:"工作流完成后"},{value:"node",label:"节点完成后"}],onInput:value=>{updateWorkflow(item,"/trigger/type",value);render();}}).label);
      if(["after-workflow","node"].includes(triggerType)){
        const workflowOptions=ownedWorkflows().filter(value=>value.key!==item.key).map(value=>({value:value.base.id,label:`${moduleLabel(value)} · ${value.base.title||value.base.id}`}));
        grid.append(field("目标工作流",current.trigger?.workflowId,"作为触发来源的工作流。",{options:workflowOptions,onInput:value=>{updateWorkflow(item,"/trigger/workflowId",value||null);render();}}).label);
        if(triggerType==="node"){
          const target=state.catalog.workflows.find(value=>value.base.id===current.trigger?.workflowId);
          const nodeOptions=(target?.base.nodes||[]).map(node=>({value:node.id,label:`${node.title||node.id} · ${nodeTypeLabel(node.type)}`}));
          grid.append(field("目标节点",current.trigger?.nodeId,"该节点完成后触发当前工作流。",{options:nodeOptions,onInput:value=>updateWorkflow(item,"/trigger/nodeId",value||null)}).label);
        }
      }
      grid.append(field("阻塞下一轮",current.trigger?.blockNextTurnUntilReady,"启用后，工作流完成、跳过或取消前不接受下一轮正文输入。",{type:"boolean",wide:true,onInput:value=>updateWorkflow(item,"/trigger/blockNextTurnUntilReady",value)}).label);
      trigger.append(heading,grid);overview.root.append(trigger);
    }
    addSave(overview,{label:"保存工作流",root:editor,capture:()=>{
      const workflow=deepClone(state.profile.workflowOverrides[item.key]);
      const backups=deepClone(state.profile.nodeModeBackups?.[item.key]);
      return profile=>{if(workflow!==undefined)profile.workflowOverrides[item.key]=workflow;if(backups!==undefined){profile.nodeModeBackups??={};profile.nodeModeBackups[item.key]=backups;}};
    }});
    editor.append(overview.root);

    const nodesHeading=document.createElement("div");nodesHeading.className="workflow-nodes-heading";
    const nodesTitle=document.createElement("h3");nodesTitle.textContent="全部节点";
    const nodesDescription=document.createElement("p");nodesDescription.textContent="所有节点都会显示；只有 Agent 节点提供 Agent 和模型选项。";
    nodesHeading.append(nodesTitle,nodesDescription);editor.append(nodesHeading);
    for(let index=0;index<(current.nodes||[]).length;index+=1){
      const node=current.nodes[index];
      const view=card(node.title||node.id,node.description||nodeTypeDescription(node));
      view.root.classList.add("workflow-node-config",`node-type-${String(node.type||"unknown").replace(/[^a-z0-9-]/gi,"-")}`);
      const badge=document.createElement("span");badge.className="node-type-badge";badge.textContent=nodeTypeLabel(node.type);view.header.append(badge);
      const meta=document.createElement("div");meta.className="workflow-meta";
      meta.append(Object.assign(document.createElement("span"),{textContent:`节点 ID：${node.id}`}),Object.assign(document.createElement("span"),{textContent:`依赖：${node.dependsOn?.join(", ")||"无"}`}));
      view.root.append(meta);
      const collaborationPreset=item.collaborationPresets?.[node.id]||item.base.collaborationPresets?.[node.id];
      if(collaborationPreset?.team?.schemaVersion===2&&collaborationPreset.team.protocol==="collaboration"){
        const mode=getWorkflowNodeMode(node)==="collaboration"?"collaboration":"agent";
        view.root.append(field("执行方式",mode,"选择普通 Agent 或预设协作团队；切换只替换当前节点的类型特有字段。",{options:collaborationModeOptions(node,collaborationPreset),onInput:value=>{updateWorkflowNodeMode(item,node,value);render();}}).label);
      }
      if(node.type==="agent"){
        const grid=document.createElement("div");grid.className="field-grid";
        grid.append(
          field("Agent",node.agentId,"仅覆盖当前 Agent 节点；留空时继承工作流默认 Agent。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/agentId`,value||null)}).label,
          field("节点提示词",node.prompt,"该 Agent 节点执行时使用的任务提示。",{type:"textarea",rows:8,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/prompt`,value)}).label,
        );
        if(node.context)grid.append(field("上下文配置",node.context,"控制该 Agent 节点读取哪些上游结果或固定上下文。",{type:"json",rows:7,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/context`,value)}).label);
        view.root.append(grid);
      }else if(node.type==="team"&&node.team?.protocol==="collaboration"){
        const team=node.team||{}, members=Array.isArray(team.members)?team.members:[];
        const grid=document.createElement("div");grid.className="field-grid collaboration-team-config";
        grid.append(field("自定义阶段任务",node.prompt||"",`当前任务来源：${node.promptFile||"自定义提示词"}。填写后替代预设任务；清空后恢复预设。可用 <!-- stage --> 分阶段。`,{type:"textarea",rows:10,wide:true,onInput:value=>{updateWorkflow(item,`/nodes/${index}/prompt`,value);updateWorkflow(item,`/nodes/${index}/promptFile`,value.trim()?null:collaborationPreset?.promptFile||null);}}).label);
        grid.append(field("成员列表",members,"协作成员 id、label、Agent 和 tools；模型统一由各自 Agent 指定。",{type:"json",rows:12,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/members`,value)}).label);
        for(let memberIndex=0;memberIndex<members.length;memberIndex+=1){
          const member=members[memberIndex]||{};
          grid.append(
            field(`成员 ${member.id||memberIndex+1} Agent`,member.agentId,"该成员使用的 Agent 配置。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/members/${memberIndex}/agentId`,value||null)}).label,
            field(`成员 ${member.id||memberIndex+1} tools`,member.tools||[],"可用工具列表；使用 JSON 数组编辑。",{type:"json",rows:3,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/members/${memberIndex}/tools`,value)}).label,
          );
        }
        const ids=members.map(member=>({value:member.id,label:member.label||member.id}));
        grid.append(
          field("初始成员",team.initialMemberId,"首个获得执行权的成员。",{options:ids,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/initialMemberId`,value)}).label,
          field("阶段负责人",team.stageOwnerId,"完成当前阶段后推进任务的成员。",{options:ids,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/stageOwnerId`,value)}).label,
          field("完成成员",team.completionMemberId,"提交整个协作节点完成结果的成员。",{options:ids,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/completionMemberId`,value)}).label,
          field("输出归属",team.outputOwners||{},"每个输出 ID 对应的成员 ID。",{type:"json",rows:6,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/outputOwners`,value)}).label,
          field("协作限制",team.limits||{},"maxActivations、maxToolCalls、maxProtocolReminders。",{type:"json",rows:6,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/limits`,value)}).label,
        );
        view.root.append(grid);
      }else if(node.type==="team"){
        const grid=document.createElement("div");grid.className="field-grid";
        grid.append(
          field("Leader Agent",node.team?.leader?.agentId,"Leader 负责分析、初案、讨论收口和最终裁定。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/leader/agentId`,value||null)}).label,
          field("秘书 Agent",node.team?.secretary?.agentId,"秘书负责请求整理、草稿、修订和参考文档。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/secretary/agentId`,value||null)}).label,
          field("专家列表",node.team?.experts||[],"数组顺序就是发言顺序；每项可设 id、agentId、focus 和 prompt，模型由 Agent 指定。",{type:"json",rows:12,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/experts`,value)}).label,
          field("助理能力",node.team?.assistants||[],"可动态增删 workflow、agent 或 tool 助理；Leader/专家只看公开说明，执行参数由运行时适配。",{type:"json",rows:14,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/assistants`,value)}).label,
          field("常规讨论轮数",node.team?.agenda?.normalRounds??2,"这是建议值，Leader 可提前收口或在上限内继续。",{type:"number",min:1,max:20,required:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/agenda/normalRounds`,value)}).label,
          field("最大讨论轮数",node.team?.agenda?.maxRounds??4,"达到上限后强制进入协助排空和总结陈词。",{type:"number",min:1,max:20,required:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/agenda/maxRounds`,value)}).label,
          field("助理并发",node.team?.agenda?.assistantConcurrency??2,"会议旁路同时执行的协助任务上限。",{type:"number",min:1,max:16,required:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/agenda/assistantConcurrency`,value)}).label,
          field("阶段独立额度",node.team?.budgets||{},"草稿、审查、最终修订使用独立池，不会被讨论透支。",{type:"json",rows:12,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/budgets`,value)}).label,
        );
        view.root.append(grid);
      }else{
        const notice=document.createElement("p");notice.className="non-agent-node-note";notice.textContent=`${nodeTypeDescription(node)} 此节点不调用 Agent，因此没有 Agent 或模型选项。`;view.root.append(notice);
      }
      editor.append(view.root);
    }
  };
  const refreshWorkflowOptions=()=>{workflowSelect.replaceChildren();const items=ownedWorkflows().filter(item=>item.moduleId===sourceSelect.value);for(const item of items){const option=document.createElement("option");option.value=item.key;option.textContent=item.base.title||item.base.id;workflowSelect.append(option);}workflowSelect.disabled=!items.length;render();};
  sourceSelect.onchange=refreshWorkflowOptions;workflowSelect.onchange=render;refreshWorkflowOptions();
}

const moduleOptionLabels={"recent-turns":"最近完整剧情","custom-brief":"自定义画面描述",latest:"最新回合作为目标",all:"全部回合作为目标",context:"跟随创作窗口",fixed:"固定轮数"};
function renderModules() { const panel=$("#config-panel-modules");panel.replaceChildren();for(const module of state.catalog.modules){const view=card(module.title,module.description);if(!module.fields.length){const p=document.createElement("p");p.textContent="该模块没有公开可配置参数。";view.root.append(p);panel.append(view.root);continue;}const override=state.profile.moduleOverrides[module.id]||{};const grid=document.createElement("div");grid.className="field-grid";for(const definition of module.fields){const current=getAt(override,definition.path)??getAt(module.base,definition.path)??definition.default;let options=null;if(definition.options)options=definition.options.map(item=>typeof item==="string"?{value:item,label:moduleOptionLabels[item]||item}:{value:item.value,label:item.label||item.value});const type=definition.type==="boolean"?"boolean":definition.type==="integer"||definition.type==="number"?"number":definition.type==="textarea"?"textarea":definition.type==="json"?"json":"text";grid.append(field(definition.label,current,`${definition.help} 生效时机：新会话初始化。`,{type,options,min:definition.minimum,max:definition.maximum,required:definition.required===true,wide:type==="textarea"||type==="json",onInput:value=>{state.profile.moduleOverrides[module.id]??={};setAt(state.profile.moduleOverrides[module.id],definition.path,value);}}).label);}view.root.append(grid);addOverrideSave(view,"moduleOverrides",module.id,"保存模块参数");panel.append(view.root);} }

function renderAll() { const builtin=Boolean(state.profile.builtin);for(const id of ["profile-rename","profile-copy","profile-delete","profile-export"])$("#"+id).disabled=builtin;renderModels();renderAgents();renderModelAssignments();renderWorkflows();renderModules(); }
async function loadProfile(id) { state.profile=await api(`/api/v1/config/profiles/${encodeURIComponent(id)}`);state.savedProfile=deepClone(state.profile);assignmentSelection.clear();assignmentVersions.clear();assignmentResults.clear();for(const model of state.profile.models)modelOrigins.set(model,model.id);state.selectedModel=state.profile.models[0]||null;state.dirty=false;renderAll();status(state.profile.builtin?"当前为只读内置默认；新建方案后即可编辑。":`已加载：${state.profile.name}`); }
async function refreshProfiles(preferred=null) { state.catalog=await api("/api/v1/config/catalog");state.listing=await api("/api/v1/config/profiles");const select=$("#profile-select");select.replaceChildren();for(const profile of state.listing.profiles){const option=document.createElement("option");option.value=profile.id;option.textContent=profile.invalid?`${profile.name}（无效）`:profile.name;option.disabled=Boolean(profile.invalid);select.append(option);}select.value=preferred||state.listing.activeProfileId;await loadProfile(select.value); }

function showConfigPanel(panelId) {
  document.querySelectorAll(".config-tab").forEach(button=>button.classList.toggle("active",`config-panel-${button.dataset.configPanel}`===panelId));
  document.querySelectorAll(".config-category-panel").forEach(panel=>panel.hidden=panel.id!==panelId);
}
function updateDirty() {
  const comparable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  state.dirty=comparable(state.profile)!==comparable(state.savedProfile)||state.profile.models.some(model=>Boolean(modelKeys.get(model)));
}
function refreshModelSelectors() {
  for(const select of document.querySelectorAll("select[data-model-options]")){
    const value=select.value,options=modelOptions();
    if(value&&!options.some(option=>option.value===value))options.push({value,label:`${value}（未保存或已移除）`});
    select.replaceChildren();for(const option of options){const node=document.createElement("option");node.value=option.value;node.textContent=option.label;select.append(node);}select.value=value;
  }
}
function addOverrideSave(view,section,key,label) {
  addSave(view,{label,capture:()=>{
    const value=deepClone(state.profile[section]?.[key]);
    if(section==="agentOverrides"&&value)delete value.defaultModelId;
    return profile=>{if(value!==undefined){profile[section]??={};profile[section][key]=section==="agentOverrides"?{...profile[section][key],...value}:value;}};
  }});
}
function addSave(view,{label="保存",root=view.root,validate,capture,options=()=>({}),afterSave},container=view.header) {
  const button=document.createElement("button");button.textContent=label;button.disabled=Boolean(state.profile.builtin);
  button.onclick=async()=>{
    validate?.();
    const invalid=[...root.querySelectorAll("input,select,textarea")].find(input=>!input.disabled&&!input.checkValidity());
    if(invalid){
      const panel=invalid.closest(".config-category-panel");if(panel)showConfigPanel(panel.id);
      invalid.focus();invalid.reportValidity();return status(`请修正“${invalid.dataset.configLabel||"配置字段"}”：${invalid.validationMessage||"填写有效且在范围内的值。"}`,true);
    }
    const fields=[...root.querySelectorAll("input,select,textarea")].map(input=>({input,disabled:input.disabled}));
    button.disabled=true;
    try{
      const change=capture(),settings=options();for(const {input} of fields)input.disabled=true;
      await persistItem(change,`${label}成功。`,settings);afterSave?.();
    }
    catch(error){status(error.message,true);}
    finally{for(const {input,disabled} of fields)input.disabled=disabled;button.disabled=Boolean(state.profile.builtin);}
  };
  container.append(button);return button;
}
function persistItem(change,message,{model,apiKey,sourceModelId,removeModelId,quiet=false}={}) {
  const profileId=state.profile.id;
  const modelId=model?.id;
  const run=async()=>{
    if(model&&sourceModelId&&!apiKey&&!state.context.modelSecretCopy)throw new Error("请重启服务后再保存副本，以使用缓存 Key。");
    const path=`/api/v1/config/profiles/${encodeURIComponent(profileId)}`;
    const current=await api(path);change(current);
    await api(path,{method:"PUT",body:current});
    if(model&&apiKey)await api(`${path}/secrets/models/${encodeURIComponent(modelId)}`,{method:"PUT",body:{apiKey}});
    else if(model&&sourceModelId)await api(`${path}/secrets/models/${encodeURIComponent(modelId)}`,{method:"PUT",body:{sourceModelId}});
    if(removeModelId)await api(`${path}/secrets/models/${encodeURIComponent(removeModelId)}`,{method:"PUT",body:{apiKey:""}});
    const saved=await api(path);
    if(state.profile.id!==profileId)return;
    state.savedProfile=deepClone(saved);
    if(model){modelOrigins.set(model,modelId);modelKeySources.delete(model);model.hasSecret=saved.models.find(item=>item.id===modelId)?.hasSecret||false;if(apiKey===modelKeys.get(model))modelKeys.delete(model);}
    refreshModelSelectors();
    updateDirty();if(!quiet){renderModelAssignments();refreshAgentModelLabels();status(message);}
  };
  const result=saveQueue.then(run);saveQueue=result.catch(()=>{});return result;
}

$(".config-tabs").addEventListener("click",event=>{const button=event.target.closest("button[data-config-panel]");if(!button)return;showConfigPanel(`config-panel-${button.dataset.configPanel}`);});
$("#profile-select").onchange=async event=>{if(state.dirty&&!confirm("放弃尚未保存的修改并切换方案？")){event.target.value=state.profile.id;return;}await api(`/api/v1/config/profiles/${event.target.value}/activate`,{method:"POST"});state.catalog=await api("/api/v1/config/catalog");await loadProfile(event.target.value);};
$("#profile-new").onclick=async()=>{const id=prompt("新方案 ID");if(!id)return;const name=prompt("方案名称",id);if(!name)return;try{await api("/api/v1/config/profiles",{method:"POST",body:{id,name,seedFromId:state.profile.id}});await api(`/api/v1/config/profiles/${id}/activate`,{method:"POST"});await refreshProfiles(id);}catch(error){status(error.message,true)}};
$("#profile-rename").onclick=async()=>{const name=prompt("新名称",state.profile.name);if(!name)return;try{await api(`/api/v1/config/profiles/${state.profile.id}/rename`,{method:"POST",body:{name}});await refreshProfiles(state.profile.id);}catch(error){status(error.message,true)}};
$("#profile-copy").onclick=async()=>{const newId=prompt("副本 ID",`${state.profile.id}-copy`);if(!newId)return;const name=prompt("副本名称",`${state.profile.name} 副本`);if(!name)return;try{await api(`/api/v1/config/profiles/${state.profile.id}/duplicate`,{method:"POST",body:{newId,name}});await api(`/api/v1/config/profiles/${newId}/activate`,{method:"POST"});await refreshProfiles(newId);status("已复制配置；出于安全考虑，凭据没有复制。") }catch(error){status(error.message,true)}};
$("#profile-delete").onclick=async()=>{if(!confirm(`删除方案“${state.profile.name}”及其本机凭据？此操作不可撤销。`))return;try{await api(`/api/v1/config/profiles/${state.profile.id}`,{method:"DELETE"});await refreshProfiles("builtin")}catch(error){status(error.message,true)}};
$("#profile-export").onclick=async()=>{try{const value=await api(`/api/v1/config/profiles/${state.profile.id}/export`);const blob=new Blob([JSON.stringify(value,null,2)+"\n"],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${state.profile.id}.json`;link.click();URL.revokeObjectURL(link.href);status("已导出不含凭据的 JSON。") }catch(error){status(error.message,true)}};
$("#profile-import").onclick=()=>$("#profile-file").click();
$("#profile-file").onchange=async event=>{const file=event.target.files[0];if(!file)return;try{const value=JSON.parse(await file.text());const summary=`名称：${value.name||"未命名"}\n作用域：${value.scope||"未知"}\n模型：${value.models?.length||0}\nAgent 覆盖：${Object.keys(value.agentOverrides||{}).length}\n工作流覆盖：${Object.keys(value.workflowOverrides||{}).length}\n模块覆盖：${Object.keys(value.moduleOverrides||{}).length}`;if(!confirm(`确认导入以下配置？\n\n${summary}`))return;const id=prompt("导入后的方案 ID",value.id);if(!id)return;const name=prompt("导入后的方案名称",value.name||id);if(!name)return;await api("/api/v1/config/import",{method:"POST",body:{profile:value,id,name}});await api(`/api/v1/config/profiles/${id}/activate`,{method:"POST"});await refreshProfiles(id);status("导入完成；JSON 中未包含任何凭据。") }catch(error){status(error.message,true)}finally{event.target.value=""}};

window.addEventListener("beforeunload",event=>{if(state.dirty){event.preventDefault();event.returnValue="";}});

try { state.context=await api("/api/v1/config/context");token ||= state.context.token || "";state.catalog=await api("/api/v1/config/catalog");$("#scope-badge").textContent=state.context.scope==="global"?"全局级":"单卡级";$("#mode-description").textContent=state.context.mode==="development"?"根目录开发预览：角色卡与聊天为空；此面板管理全局配置方案。":`单卡模式：配置只对 ${state.context.ownerId} 生效。`;await refreshProfiles(); }
catch(error){status(error.message,true);}
