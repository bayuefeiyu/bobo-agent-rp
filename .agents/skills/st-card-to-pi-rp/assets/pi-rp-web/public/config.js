const state = { context:null, catalog:null, listing:null, profile:null, dirty:false };
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
const $ = selector => document.querySelector(selector);
let helpSequence = 0;

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "content-type":"application/json" } : {}), ...(options.method && options.method !== "GET" ? { "x-rp-config-token": token } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function status(message, error = false) { const node=$("#status"); node.textContent=message; node.style.color=error?"var(--danger)":"var(--muted)"; }
function markDirty() { if (state.profile?.builtin) return; state.dirty=true; status("有尚未保存的修改。") }
function deepClone(value) { return structuredClone(value); }
function pointerParts(path) { return path.split("/").slice(1).map(item => item.replaceAll("~1","/").replaceAll("~0","~")); }
function getAt(value, path) { let current=value; for (const part of pointerParts(path)) current=current?.[Array.isArray(current)?Number(part):part]; return current; }
function setAt(value, path, next) { const parts=pointerParts(path); let current=value; for(let i=0;i<parts.length-1;i+=1){const key=Array.isArray(current)?Number(parts[i]):parts[i]; const following=parts[i+1]; current[key]??=/^\d+$/.test(following)?[]:{}; current=current[key];} const last=Array.isArray(current)?Number(parts.at(-1)):parts.at(-1); current[last]=next; }

function help(text) { const node=document.createElement("span"); node.className="help"; node.tabIndex=0; node.textContent="?"; node.dataset.tooltip=text; node.setAttribute("aria-label",text); return node; }
function fieldCaption(labelText, description) { const caption=document.createElement("span");caption.className="field-caption";const helpNode=help(description);helpNode.id=`config-help-${++helpSequence}`;caption.append(document.createTextNode(labelText),helpNode);return {caption,helpNode}; }
function field(labelText, value, description, { type="text", wide=false, options=null, min=null, max=null, required=false, rows=4, onInput }={}) {
  const label=document.createElement("label"); label.className=`field${wide?" wide":""}`; const {caption,helpNode}=fieldCaption(labelText,description); label.append(caption);
  let input;
  if(type==="textarea"||type==="json"){ input=document.createElement("textarea"); input.rows=rows; input.value=type==="json"?JSON.stringify(value??{},null,2):(value??""); }
  else if(type==="boolean"){ input=document.createElement("input"); input.type="checkbox"; input.checked=Boolean(value); }
  else if(options){ input=document.createElement("select"); for(const option of options){const node=document.createElement("option"); const item=typeof option==="string"?{value:option,label:option}:option; node.value=item.value??""; node.textContent=item.label; input.append(node);} input.value=value??""; }
  else { input=document.createElement("input"); input.type=type; input.value=value??""; if(min!==null)input.min=min;if(max!==null)input.max=max; }
  input.disabled=Boolean(state.profile?.builtin); input.required=required; input.title=description; input.setAttribute("aria-describedby",helpNode.id); input.addEventListener("input",()=>{let next=type==="boolean"?input.checked:input.value;if(type==="number")next=input.value===""?null:Number(input.value);if(type==="json"){try{next=JSON.parse(input.value);input.setCustomValidity("");}catch{input.setCustomValidity("请输入有效 JSON");return;}}onInput?.(next,input);markDirty();}); label.append(input); return {label,input};
}
function card(title, description="") { const root=document.createElement("article");root.className="config-card";const header=document.createElement("header");const copy=document.createElement("div");const h=document.createElement("h3");h.textContent=title;copy.append(h);if(description){const p=document.createElement("p");p.textContent=description;copy.append(p);}header.append(copy);root.append(header);return {root,header}; }
function optionGroups(select, items, selected, labelOf) { const groups=new Map(); for(const item of items){if(!groups.has(item.group))groups.set(item.group,[]);groups.get(item.group).push(item);} for(const [name,values] of groups){const group=document.createElement("optgroup");group.label=name;for(const item of values){const option=document.createElement("option");option.value=item.key;option.textContent=labelOf(item);group.append(option);}select.append(group);}select.value=selected||items[0]?.key||""; }
function modelOptions() { return [{value:"",label:"继承/未指定"},{value:"pi:current",label:"当前 Pi 模型"},...(state.profile?.models||[]).map(item=>({value:item.id,label:item.name||item.model||item.id}))]; }
function agentOptions() { return [{value:"",label:"继承/未指定"},...state.catalog.agents.map(item=>({value:item.base.id,label:`${item.group} · ${item.base.name||item.base.id}`}))]; }

function renderModels() {
  const panel=$("#config-panel-models");panel.replaceChildren();
  const intro=card("模型配置","API Key 只写入本机项目隔离缓存；导出配置永远不包含凭据。");const add=document.createElement("button");add.textContent="新增模型";add.disabled=Boolean(state.profile.builtin);add.onclick=()=>{const id=prompt("模型配置 ID（字母、数字、点、下划线或连字符）");if(!id)return;if(state.profile.models.some(m=>m.id===id))return status("模型 ID 已存在。",true);state.profile.models.push({schemaVersion:1,id,name:id,provider:"custom",model:"",baseUrl:"",api:"openai-responses",contextWindow:128000,maxOutputTokens:4096,thinking:"off",maxConcurrency:10,headPrompt:null,tailPrompt:null});markDirty();renderModels();};intro.header.append(add);panel.append(intro.root);
  if(!state.profile.models.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="当前方案没有模型配置。";panel.append(empty);return;}
  for(const model of state.profile.models){const item=card(model.name||model.id,`配置 ID：${model.id}${model.hasSecret?" · 已保存本机凭据":" · 未保存凭据"}`);const grid=document.createElement("div");grid.className="field-grid";
    const bind=(key,description,options={})=>field(options.label||key,model[key],description,{...options,onInput:value=>{model[key]=value||null;}}).label;
    grid.append(bind("name","用于界面显示，不影响工作流引用。",{label:"显示名称"}),bind("provider","选择服务预设；自定义服务可使用 custom。",{label:"服务类型",options:["openai","anthropic","deepseek","openrouter","gemini","moonshot","dashscope","siliconflow","custom"]}),bind("baseUrl","模型服务 API 根地址。",{label:"API URL",type:"url",wide:true}),bind("api","请求协议格式。",{label:"API 格式",options:["openai-responses","openai-completions","anthropic-messages"]}),bind("model","发送给服务的实际模型名。",{label:"模型名"}),bind("contextWindow","模型可接受的上下文 Token 上限。",{label:"上下文长度",type:"number",min:1}),bind("maxOutputTokens","单次输出 Token 上限。",{label:"最大输出",type:"number",min:1}),field("思考强度",model.thinking??model.thinkingLevel??"off","模型支持时使用的思考强度。",{options:[{value:"off",label:"关闭/默认"},"minimal","low","medium","high","xhigh","max"],onInput:value=>{model.thinking=value;delete model.thinkingLevel;}}).label,bind("maxConcurrency","该模型允许的最大并发调用数。",{label:"最大并发",type:"number",min:1,max:10}),bind("headPrompt","追加在 Agent 提示词之前的模型级提示。",{label:"前置提示词",type:"textarea",wide:true}),bind("tailPrompt","每次模型调用前都会从旧位置移除并追加到上下文最末尾；工具调用后再次请求模型时也会重新置底。",{label:"后置提示词",type:"textarea",wide:true}));
    const secret=field("API Key", "", "凭据只保存到操作系统缓存，不会返回浏览器或进入导出 JSON。",{type:"password",wide:true}).label;secret.querySelector("input").placeholder=model.hasSecret?"留空保留已保存的 Key":"输入后随保存写入本机缓存";secret.querySelector("input").dataset.secretFor=model.id;grid.append(secret);item.root.append(grid);const actions=document.createElement("div");actions.className="model-actions";if(model.hasSecret){const clearSecret=document.createElement("button");clearSecret.className="danger";clearSecret.textContent="清除 API Key";clearSecret.disabled=Boolean(state.profile.builtin);clearSecret.title="从本机项目隔离缓存删除此方案和模型对应的凭据。";clearSecret.onclick=async()=>{if(!confirm(`清除模型 ${model.id} 的本机 API Key？`))return;try{await api(`/api/config/profiles/${state.profile.id}/secrets/models/${model.id}`,{method:"PUT",body:{apiKey:""}});model.hasSecret=false;renderModels();status("已清除本机 API Key。");}catch(error){status(error.message,true)}};actions.append(clearSecret);}const remove=document.createElement("button");remove.className="danger";remove.textContent="移除模型";remove.disabled=Boolean(state.profile.builtin);remove.onclick=()=>{if(confirm(`从方案中移除模型 ${model.id}？`)){state.profile.models=state.profile.models.filter(m=>m!==model);markDirty();renderModels();}};actions.append(remove);item.root.append(actions);panel.append(item.root);}
}

function renderAgents() {
  const panel=$("#config-panel-agents");panel.replaceChildren();
  const toolbar=document.createElement("div");toolbar.className="list-toolbar agent-pickers";
  const sourceLabel=document.createElement("label");sourceLabel.className="field";sourceLabel.append(fieldCaption("模块","“通用”只包含不属于任何模块的 Agent；其余 Agent 按所属模块筛选。").caption);
  const sourceSelect=document.createElement("select");sourceLabel.append(sourceSelect);
  const agentLabel=document.createElement("label");agentLabel.className="field";agentLabel.append(fieldCaption("Agent","选择要在当前配置方案中覆盖的 Agent；不会修改源文件。").caption);
  const agentSelect=document.createElement("select");agentLabel.append(agentSelect);
  toolbar.append(sourceLabel,agentLabel);panel.append(toolbar);

  const sources=new Map();
  for(const item of state.catalog.agents){
    const id=item.moduleId||"general";
    if(!sources.has(id))sources.set(id,{id,label:item.moduleId?item.group.replace(/^模块 · /,""):"通用"});
  }
  for(const source of sources.values()){const option=document.createElement("option");option.value=source.id;option.textContent=source.label;sourceSelect.append(option);}

  const render=()=>{
    panel.querySelectorAll(".config-card,.empty").forEach(node=>node.remove());
    const item=state.catalog.agents.find(value=>value.key===agentSelect.value);
    if(!item){const empty=document.createElement("div");empty.className="empty";empty.textContent="该分类没有 Agent。";panel.append(empty);return;}
    const base=item.base;
    const override=state.profile.agentOverrides[item.key]||{};
    const effective={...deepClone(base),...deepClone(override)};
    const sourceName=item.moduleId?item.group.replace(/^模块 · /,""):"通用";
    const view=card(effective.name||base.id,`${sourceName} · ${base.id}`);
    const grid=document.createElement("div");grid.className="field-grid";
    const assign=(key,value)=>{state.profile.agentOverrides[item.key]??={};state.profile.agentOverrides[item.key][key]=value;};
    grid.append(
      field("名称",effective.name,"覆盖 Agent 的显示名称。",{onInput:value=>assign("name",value)}).label,
      field("简介",effective.description,"说明 Agent 的职责和适用范围。",{type:"textarea",onInput:value=>assign("description",value)}).label,
      field("默认模型",effective.defaultModelId,"Agent 节点没有单独指定模型时使用。",{options:modelOptions(),onInput:value=>assign("defaultModelId",value||null)}).label,
      field("输出形式",effective.outputMode,"约束 Agent 返回文本或 JSON。",{options:["text","json"],onInput:value=>assign("outputMode",value)}).label,
      field("工具",(effective.tools||[]).join(", "),"逗号分隔的工具白名单。",{wide:true,onInput:value=>assign("tools",value.split(",").map(item=>item.trim()).filter(Boolean))}).label,
      field("上下文权限",(effective.contextPermissions||[]).join(", "),"逗号分隔的上下文访问权限。",{wide:true,onInput:value=>assign("contextPermissions",value.split(",").map(item=>item.trim()).filter(Boolean))}).label,
      field("Agent 提示词",effective.prompt,"定义 Agent 的具体职责、边界和输出要求。",{type:"textarea",rows:14,wide:true,onInput:value=>assign("prompt",value)}).label,
    );
    view.root.append(grid);panel.append(view.root);
  };
  const refreshAgentOptions=()=>{
    agentSelect.replaceChildren();
    const items=state.catalog.agents.filter(item=>(item.moduleId||"general")===sourceSelect.value);
    for(const item of items){const option=document.createElement("option");option.value=item.key;option.textContent=item.base.name||item.base.id;agentSelect.append(option);}
    agentSelect.disabled=!items.length;render();
  };
  sourceSelect.onchange=refreshAgentOptions;agentSelect.onchange=render;refreshAgentOptions();
}

function renderWorkflows() {
  const panel=$("#config-panel-workflows");panel.replaceChildren();
  const toolbar=document.createElement("div");toolbar.className="list-toolbar workflow-pickers";
  const sourceLabel=document.createElement("label");sourceLabel.className="field";sourceLabel.append(fieldCaption("模块","“通用”只包含不属于任何模块的工作流；其余工作流按所属模块筛选。").caption);
  const sourceSelect=document.createElement("select");sourceLabel.append(sourceSelect);
  const workflowLabel=document.createElement("label");workflowLabel.className="field";workflowLabel.append(fieldCaption("工作流","编辑工作流运行策略、触发方式和所有节点；运行状态请在侧栏“工作流”页面查看。").caption);
  const workflowSelect=document.createElement("select");workflowLabel.append(workflowSelect);toolbar.append(sourceLabel,workflowLabel);panel.append(toolbar);
  const sources=new Map();
  for(const item of state.catalog.workflows){const id=item.moduleId||"general";if(!sources.has(id))sources.set(id,{id,label:item.moduleId?item.group.replace(/^模块 · /,""):"通用"});}
  for(const source of sources.values()){const option=document.createElement("option");option.value=source.id;option.textContent=source.label;sourceSelect.append(option);}

  const updateWorkflow=(item,path,value)=>{
    const next=deepClone(state.profile.workflowOverrides[item.key]||item.base);
    setAt(next,path,value);
    state.profile.workflowOverrides[item.key]=next;
  };
  const nodeTypeLabel=type=>({agent:"Agent",team:"团队会议",code:"代码",call:"调用工作流","turn-finalize":"回合收尾","workflow-return":"工作流返回"})[type]||type||"未知";
  const nodeTypeDescription=node=>{
    if(node.type==="agent")return "调用 Agent 进行推理或创作，可覆盖 Agent、模型和节点提示词。";
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
      field("允许静默兜底",policy.modelFailure?.silentFallback,"节点模型失败后是否自动使用默认兜底模型。",{type:"boolean",onInput:value=>assign("/modelFailure/silentFallback",value)}).label,
      field("默认兜底模型",policy.modelFailure?.defaultFallbackModelId,"仅在允许静默兜底时使用。",{options:modelOptions(),wide:true,onInput:value=>assign("/modelFailure/defaultFallbackModelId",value||null)}).label,
    );
    view.root.append(grid);panel.append(view.root);
  };
  const render=()=>{
    panel.querySelectorAll(".config-card,.empty").forEach(node=>node.remove());
    renderRuntimePolicy();
    const item=state.catalog.workflows.find(value=>value.key===workflowSelect.value);
    if(!item){const empty=document.createElement("div");empty.className="empty";empty.textContent="该分类没有工作流。";panel.append(empty);return;}
    const current=deepClone(state.profile.workflowOverrides[item.key]||item.base);
    const sourceName=item.moduleId?item.group.replace(/^模块 · /,""):"通用";
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
        field("默认模型",current.defaults?.modelId,"Agent 节点和 Agent 都未指定模型时使用。",{options:modelOptions(),onInput:value=>updateWorkflow(item,"/defaults/modelId",value||null)}).label,
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
        const workflowOptions=state.catalog.workflows.filter(value=>value.key!==item.key).map(value=>({value:value.base.id,label:`${value.moduleId?value.group.replace(/^模块 · /,""):"通用"} · ${value.base.title||value.base.id}`}));
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
    panel.append(overview.root);

    const nodesHeading=document.createElement("div");nodesHeading.className="workflow-nodes-heading";
    const nodesTitle=document.createElement("h3");nodesTitle.textContent="全部节点";
    const nodesDescription=document.createElement("p");nodesDescription.textContent="所有节点都会显示；只有 Agent 节点提供 Agent 和模型选项。";
    nodesHeading.append(nodesTitle,nodesDescription);panel.append(nodesHeading);
    for(let index=0;index<(current.nodes||[]).length;index+=1){
      const node=current.nodes[index];
      const view=card(node.title||node.id,node.description||nodeTypeDescription(node));
      view.root.classList.add("workflow-node-config",`node-type-${String(node.type||"unknown").replace(/[^a-z0-9-]/gi,"-")}`);
      const badge=document.createElement("span");badge.className="node-type-badge";badge.textContent=nodeTypeLabel(node.type);view.header.append(badge);
      const meta=document.createElement("div");meta.className="workflow-meta";
      meta.append(Object.assign(document.createElement("span"),{textContent:`节点 ID：${node.id}`}),Object.assign(document.createElement("span"),{textContent:`依赖：${node.dependsOn?.join(", ")||"无"}`}));
      view.root.append(meta);
      if(node.type==="agent"){
        const grid=document.createElement("div");grid.className="field-grid";
        grid.append(
          field("Agent",node.agentId,"仅覆盖当前 Agent 节点；留空时继承工作流默认 Agent。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/agentId`,value||null)}).label,
          field("模型",node.modelId,"仅覆盖当前 Agent 节点；留空时按工作流和 Agent 默认值继承。",{options:modelOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/modelId`,value||null)}).label,
          field("节点提示词",node.prompt,"该 Agent 节点执行时使用的任务提示。",{type:"textarea",rows:8,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/prompt`,value)}).label,
        );
        if(node.context)grid.append(field("上下文配置",node.context,"控制该 Agent 节点读取哪些上游结果或固定上下文。",{type:"json",rows:7,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/context`,value)}).label);
        view.root.append(grid);
      }else if(node.type==="team"){
        const grid=document.createElement("div");grid.className="field-grid";
        grid.append(
          field("Leader Agent",node.team?.leader?.agentId,"Leader 负责分析、初案、讨论收口和最终裁定。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/leader/agentId`,value||null)}).label,
          field("Leader 模型",node.team?.leader?.modelId,"Leader 的独立模型绑定；留空则使用 Agent 默认模型。",{options:modelOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/leader/modelId`,value||null)}).label,
          field("秘书 Agent",node.team?.secretary?.agentId,"秘书负责请求整理、草稿、修订和参考文档。",{options:agentOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/secretary/agentId`,value||null)}).label,
          field("秘书模型",node.team?.secretary?.modelId,"秘书的独立模型绑定；留空则使用 Agent 默认模型。",{options:modelOptions(),onInput:value=>updateWorkflow(item,`/nodes/${index}/team/secretary/modelId`,value||null)}).label,
          field("专家列表",node.team?.experts||[],"数组顺序就是发言顺序；每项可设 id、agentId、modelId、focus 和 prompt。",{type:"json",rows:12,wide:true,onInput:value=>updateWorkflow(item,`/nodes/${index}/team/experts`,value)}).label,
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
      panel.append(view.root);
    }
  };
  const refreshWorkflowOptions=()=>{workflowSelect.replaceChildren();const items=state.catalog.workflows.filter(item=>(item.moduleId||"general")===sourceSelect.value);for(const item of items){const option=document.createElement("option");option.value=item.key;option.textContent=item.base.title||item.base.id;workflowSelect.append(option);}workflowSelect.disabled=!items.length;render();};
  sourceSelect.onchange=refreshWorkflowOptions;workflowSelect.onchange=render;refreshWorkflowOptions();
}

const moduleOptionLabels={"recent-turns":"最近完整剧情","custom-brief":"自定义画面描述",latest:"最新回合作为目标",all:"全部回合作为目标"};
function renderModules() { const panel=$("#config-panel-modules");panel.replaceChildren();for(const module of state.catalog.modules){const view=card(module.title,module.description);if(!module.fields.length){const p=document.createElement("p");p.textContent="该模块没有公开可配置参数。";view.root.append(p);panel.append(view.root);continue;}const override=state.profile.moduleOverrides[module.id]||{};const grid=document.createElement("div");grid.className="field-grid";for(const definition of module.fields){const current=getAt(override,definition.path)??getAt(module.base,definition.path)??definition.default;let options=null;if(definition.options)options=definition.options.map(item=>typeof item==="string"?{value:item,label:moduleOptionLabels[item]||item}:{value:item.value,label:item.label||item.value});const type=definition.type==="boolean"?"boolean":definition.type==="integer"||definition.type==="number"?"number":definition.type==="textarea"?"textarea":definition.type==="json"?"json":"text";grid.append(field(definition.label,current,`${definition.help} 生效时机：新会话初始化。`,{type,options,min:definition.minimum,max:definition.maximum,required:definition.required===true,wide:type==="textarea"||type==="json",onInput:value=>{state.profile.moduleOverrides[module.id]??={};setAt(state.profile.moduleOverrides[module.id],definition.path,value);}}).label);}view.root.append(grid);panel.append(view.root);} }

function renderAll() { const builtin=Boolean(state.profile.builtin);$("#save-profile").disabled=builtin;for(const id of ["profile-rename","profile-copy","profile-delete","profile-export"])$("#"+id).disabled=builtin;renderModels();renderAgents();renderWorkflows();renderModules(); }
async function loadProfile(id) { state.profile=await api(`/api/config/profiles/${encodeURIComponent(id)}`);state.dirty=false;renderAll();status(state.profile.builtin?"当前为只读内置默认；新建方案后即可编辑。":`已加载：${state.profile.name}`); }
async function refreshProfiles(preferred=null) { state.catalog=await api("/api/config/catalog");state.listing=await api("/api/config/profiles");const select=$("#profile-select");select.replaceChildren();for(const profile of state.listing.profiles){const option=document.createElement("option");option.value=profile.id;option.textContent=profile.invalid?`${profile.name}（无效）`:profile.name;option.disabled=Boolean(profile.invalid);select.append(option);}select.value=preferred||state.listing.activeProfileId;await loadProfile(select.value); }

async function saveCurrent() { if(state.profile.builtin)return;const invalid=[...document.querySelectorAll(".config-category-panel input, .config-category-panel select, .config-category-panel textarea")].find(input=>!input.disabled&&!input.checkValidity());if(invalid){invalid.reportValidity();return status("请先修正无效或超出范围的配置。",true);}await api(`/api/config/profiles/${state.profile.id}`,{method:"PUT",body:state.profile});for(const input of document.querySelectorAll("input[data-secret-for]")){if(input.value)await api(`/api/config/profiles/${state.profile.id}/secrets/models/${input.dataset.secretFor}`,{method:"PUT",body:{apiKey:input.value}});}state.dirty=false;await loadProfile(state.profile.id);status("配置方案已保存。") }

$(".config-tabs").addEventListener("click",event=>{const button=event.target.closest("button[data-config-panel]");if(!button)return;document.querySelectorAll(".config-tab").forEach(n=>n.classList.toggle("active",n===button));document.querySelectorAll(".config-category-panel").forEach(n=>n.hidden=n.id!==`config-panel-${button.dataset.configPanel}`);});
$("#save-profile").onclick=()=>saveCurrent().catch(error=>status(error.message,true));
$("#profile-select").onchange=async event=>{if(state.dirty&&!confirm("放弃尚未保存的修改并切换方案？")){event.target.value=state.profile.id;return;}await api(`/api/config/profiles/${event.target.value}/activate`,{method:"POST"});state.catalog=await api("/api/config/catalog");await loadProfile(event.target.value);};
$("#profile-new").onclick=async()=>{const id=prompt("新方案 ID");if(!id)return;const name=prompt("方案名称",id);if(!name)return;try{await api("/api/config/profiles",{method:"POST",body:{id,name,seedFromId:state.profile.id}});await api(`/api/config/profiles/${id}/activate`,{method:"POST"});await refreshProfiles(id);}catch(error){status(error.message,true)}};
$("#profile-rename").onclick=async()=>{const name=prompt("新名称",state.profile.name);if(!name)return;try{await api(`/api/config/profiles/${state.profile.id}/rename`,{method:"POST",body:{name}});await refreshProfiles(state.profile.id);}catch(error){status(error.message,true)}};
$("#profile-copy").onclick=async()=>{const newId=prompt("副本 ID",`${state.profile.id}-copy`);if(!newId)return;const name=prompt("副本名称",`${state.profile.name} 副本`);if(!name)return;try{await api(`/api/config/profiles/${state.profile.id}/duplicate`,{method:"POST",body:{newId,name}});await api(`/api/config/profiles/${newId}/activate`,{method:"POST"});await refreshProfiles(newId);status("已复制配置；出于安全考虑，凭据没有复制。") }catch(error){status(error.message,true)}};
$("#profile-delete").onclick=async()=>{if(!confirm(`删除方案“${state.profile.name}”及其本机凭据？此操作不可撤销。`))return;try{await api(`/api/config/profiles/${state.profile.id}`,{method:"DELETE"});await refreshProfiles("builtin")}catch(error){status(error.message,true)}};
$("#profile-export").onclick=async()=>{try{const value=await api(`/api/config/profiles/${state.profile.id}/export`);const blob=new Blob([JSON.stringify(value,null,2)+"\n"],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${state.profile.id}.json`;link.click();URL.revokeObjectURL(link.href);status("已导出不含凭据的 JSON。") }catch(error){status(error.message,true)}};
$("#profile-import").onclick=()=>$("#profile-file").click();
$("#profile-file").onchange=async event=>{const file=event.target.files[0];if(!file)return;try{const value=JSON.parse(await file.text());const summary=`名称：${value.name||"未命名"}\n作用域：${value.scope||"未知"}\n模型：${value.models?.length||0}\nAgent 覆盖：${Object.keys(value.agentOverrides||{}).length}\n工作流覆盖：${Object.keys(value.workflowOverrides||{}).length}\n模块覆盖：${Object.keys(value.moduleOverrides||{}).length}`;if(!confirm(`确认导入以下配置？\n\n${summary}`))return;const id=prompt("导入后的方案 ID",value.id);if(!id)return;const name=prompt("导入后的方案名称",value.name||id);if(!name)return;await api("/api/config/import",{method:"POST",body:{profile:value,id,name}});await api(`/api/config/profiles/${id}/activate`,{method:"POST"});await refreshProfiles(id);status("导入完成；JSON 中未包含任何凭据。") }catch(error){status(error.message,true)}finally{event.target.value=""}};

window.addEventListener("beforeunload",event=>{if(state.dirty){event.preventDefault();event.returnValue="";}});

try { state.context=await api("/api/config/context");token ||= state.context.token || "";state.catalog=await api("/api/config/catalog");$("#scope-badge").textContent=state.context.scope==="global"?"全局级":"单卡级";$("#mode-description").textContent=state.context.mode==="development"?"根目录开发预览：角色卡与聊天为空；此面板管理全局配置方案。":`单卡模式：配置只对 ${state.context.ownerId} 生效。`;await refreshProfiles(); }
catch(error){status(error.message,true);}
