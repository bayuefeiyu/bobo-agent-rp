// 工作流与用量面板（实施方案 §11 第 6 条：按职责提取的原生模块之一）。
//
// 负责：工作流列表与运行记录渲染、节点用量与 Token 用量汇总、运行策略表单的读取与保存、
// 工作流激活，以及工作流相关的标签/引用解析。
//
import { componentReference, elements, modelPresets, request, runWorkflowReference, showError, state } from "./app-context.js";

const terminalWorkflowStatuses = new Set(["completed", "skipped", "failed", "cancelled"]);


export function workflowKindLabel(kind) { return ({ foreground: "前台", "turn-background": "当前回合后台", "global-background": "全局后台" })[kind] || kind; }

export function workflowReference(workflow) { return workflow.reference || componentReference(workflow.ownerModuleId, workflow.id); }

export function isActiveWorkflowRun(run) { return run.live !== false && !terminalWorkflowStatuses.has(run.status); }

export function runningWorkflowReferences() { return new Set(state.workflowRuns.filter(isActiveWorkflowRun).map(runWorkflowReference)); }

export function selectedWorkflow() { return state.workflows.find(item => workflowReference(item) === elements.workflowSelect.value); }

export function workflowPanelHasFocus() {
  const active = document.activeElement;
  return document.querySelector("#panel-workflows")?.contains(active) === true && active?.matches("select, input, textarea");
}

export function renderWorkflow() {
  const workflow = selectedWorkflow();
  if (!workflow) return;
  const reference = workflowReference(workflow);
  const running = runningWorkflowReferences().has(reference);
  const sourceLabel = workflow.source === "module" ? `模块 · ${workflow.moduleTitle || workflow.ownerModuleId}` : workflow.source === "card" ? "当前卡工作流" : "通用工作流";
  const summaryTitle = document.createElement("strong"); summaryTitle.textContent = workflow.title;
  const summaryMeta = document.createElement("span"); summaryMeta.textContent = `${workflowKindLabel(workflow.kind)} · ${sourceLabel}${workflow.kind === "foreground" && workflow.id === state.activeWorkflowId ? " · 下轮默认前台" : ""}${running ? " · 正在运行" : ""}`;
  const summaryDescription = document.createElement("p"); summaryDescription.textContent = workflow.description || "无简介";
  elements.workflowSummary.replaceChildren(summaryTitle, summaryMeta, summaryDescription);
  elements.workflowSelect.classList.toggle("has-running-selection", running);
  elements.activateWorkflow.disabled = Boolean(workflow.ownerModuleId) || state.snapshot?.previewMode === true;
  elements.activateWorkflow.title = workflow.ownerModuleId ? "模块工作流只能由所属模块或上级工作流调用；此处用于查看定义和运行状态。" : "激活前台工作流，或手动启动允许直接运行的后台工作流。";
  if (workflow.kind !== "foreground") {
    const trigger = document.createElement("p");
    trigger.className = "workflow-runtime-detail";
    trigger.textContent = `触发：${workflow.trigger?.type || "manual"}${workflow.trigger?.workflowId ? ` · ${workflow.trigger.workflowId}` : ""}${workflow.trigger?.nodeId ? ` / ${workflow.trigger.nodeId}` : ""}`;
    elements.workflowSummary.append(trigger);
  }
  const fragment = document.createDocumentFragment();
  for (const node of workflow.nodes || []) {
    const card = document.createElement("article"); card.className = "workflow-node-card";
    const title = document.createElement("div"); title.className = "workflow-node-title";
    const nodeTitle = document.createElement("strong"); nodeTitle.textContent = node.title;
    const nodeMeta = document.createElement("span"); nodeMeta.textContent = `${node.type}${node.cooldownTurns ? ` · CD ${node.cooldownTurns} 回合` : ""}`;
    title.append(nodeTitle, nodeMeta);
    const description = document.createElement("p"); description.textContent = node.description || "无节点说明";
    card.append(title, description);
    if (node.type === "agent") {
      const binding = document.createElement("p");
      binding.className = "workflow-runtime-detail";
      binding.textContent = `Agent：${agentLabel(node.agentId || workflow.defaults?.agentId)} · 模型：${modelLabel(node.modelId || inheritedModel(workflow, node.agentId).id)}`;
      card.append(binding);
    } else if (node.type === "team") {
      const members = [node.team?.leader, ...(node.team?.experts || []), node.team?.secretary].filter(Boolean);
      const binding = document.createElement("p");
      binding.className = "workflow-runtime-detail";
      binding.textContent = `会议成员：${members.map(member => `${member.role || member.id}=${agentLabel(member.agentId)} / ${modelLabel(member.modelId || inheritedModel(workflow, member.agentId).id)}`).join("；")} · 助理能力 ${node.team?.assistants?.length || 0}`;
      card.append(binding);
    }
    fragment.append(card);
  }
  elements.workflowNodeList.replaceChildren(fragment);
  renderWorkflowRuns();
}

export function renderWorkflowRuns() {
  const fragment = document.createDocumentFragment();
  for (const run of state.workflowRuns.slice().reverse().slice(0, 20)) {
    const card = document.createElement("article"); card.className = `workflow-run-card status-${run.status}`;
    const head = document.createElement("div"); head.className = "workflow-run-head";
    const runTitle = document.createElement("strong"); runTitle.textContent = run.workflowId;
    const runMeta = document.createElement("span"); runMeta.textContent = `${statusLabel(run.status)} · 回合 ${run.turn ?? "—"}${run.blocksNextTurn ? " · 正在阻止下一轮" : ""}`;
    head.append(runTitle, runMeta); card.append(head);
    if (run.status === "completed") {
      const usage = document.createElement("p"); usage.className = "workflow-run-usage";
      usage.textContent = run.usage
        ? `本次工作流总消耗：${formatTokenCount(run.usage.totalTokens)} token（输入 ${formatTokenCount(run.usage.input)} / 输出 ${formatTokenCount(run.usage.output)} / 缓存读 ${formatTokenCount(run.usage.cacheRead)} / 缓存写 ${formatTokenCount(run.usage.cacheWrite)}）${run.usageComplete === false ? " · 部分尝试未记录" : ""}`
        : "本次工作流总消耗：未记录（升级前完成）";
      card.append(usage);
    }
    for (const node of Object.values(run.nodes || {})) {
      const row = document.createElement("div"); row.className = `run-node status-${node.status}`;
      const runNodeId = document.createElement("span"); runNodeId.textContent = node.id;
      const runNodeStatus = document.createElement("strong"); runNodeStatus.textContent = statusLabel(node.status);
      row.append(runNodeId, runNodeStatus);
      if (node.team) {
        row.classList.add("team-run-node");
        const detail = document.createElement("span");
        detail.className = "workflow-runtime-detail";
        const tasks = Object.entries(node.team.taskCounts || {}).map(([status, count]) => `${status} ${count}`).join(" / ") || "无";
        const budgets = Object.entries(node.team.budgets || {}).map(([id, value]) => `${id} ${value.used || 0}/${value.limit || 0}`).join("；");
        detail.textContent = `会议：${node.team.phase} · 第 ${node.team.round || 0} 轮 · 发言 ${node.team.speechCount || 0} · 协助任务 ${tasks}${node.team.error ? ` · ${node.team.error}` : ""}${budgets ? ` · 额度 ${budgets}` : ""}`;
        if (node.team.failedMember?.memberId) detail.textContent += ` · 失败成员 ${node.team.failedMember.memberId}`;
        if ((node.team.usage?.unrecordedCalls || 0) > 0) detail.textContent += ` · ${node.team.usage.unrecordedCalls} 次调用用量未知`;
        row.append(detail);
        if (node.team.transcriptAvailable) {
          const openTranscript = document.createElement("button");
          openTranscript.type = "button";
          openTranscript.className = "process-record-button";
          openTranscript.textContent = "打开会议记录";
          openTranscript.addEventListener("click", async () => {
            openTranscript.disabled = true;
            try { await request(`/api/workflow-runs/${encodeURIComponent(run.id)}/nodes/${encodeURIComponent(node.id)}/team-transcript/open`, { method: "POST", body: "{}" }); }
            catch (error) { showError(error); }
            finally { openTranscript.disabled = false; }
          });
          row.append(openTranscript);
        }
      }
      if (node.processRecord?.available) {
        const openProcessRecord = document.createElement("button");
        openProcessRecord.type = "button";
        openProcessRecord.className = "process-record-button";
        openProcessRecord.textContent = "打开过程记录";
        openProcessRecord.title = "使用系统默认编辑器打开此节点最后一次 Agent 收发记录";
        openProcessRecord.addEventListener("click", async () => {
          const original = openProcessRecord.textContent;
          openProcessRecord.disabled = true;
          openProcessRecord.textContent = "正在打开……";
          try {
            await request(`/api/workflow-runs/${encodeURIComponent(run.id)}/nodes/${encodeURIComponent(node.id)}/process-record/open`, { method: "POST", body: "{}" });
          } catch (error) {
            showError(error);
          } finally {
            openProcessRecord.disabled = false;
            openProcessRecord.textContent = original;
          }
        });
        row.append(openProcessRecord);
      }
      if (run.live && !(run.kind === "foreground" && terminalWorkflowStatuses.has(run.status)) && ["failed", "awaiting-model-choice", "awaiting-retry"].includes(node.status) && (node.type !== "team" || node.team?.failedMember?.freezeKey)) {
        const retryModel = node.attempts?.at(-1)?.modelId || "pi:current";
        const retryWith = async (saveAsCardDefault, modelId) => { try { await request(`/api/workflow-runs/${run.id}/nodes/${node.id}/retry`, { method: "POST", body: JSON.stringify({ modelId, saveAsCardDefault, ...(node.team?.failedMember?.freezeKey ? { memberId: node.team.failedMember.freezeKey } : {}) }) }); await refreshWorkflowData(); } catch (error) { showError(error); } };
        if (node.failureKind === "deterministic") {
          // The runtime decided this before any model call, so swapping the model cannot help.
          const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试";
          retry.addEventListener("click", () => retryWith(false, retryModel));
          const hint = document.createElement("span"); hint.className = "workflow-node-hint"; hint.textContent = "非模型故障：修正卡片或配置后再试";
          row.append(retry, hint);
        } else if (node.failureCause === "node_end_commit") {
          // The model answered; the node's own output or commit stage refused the result. Retrying
          // re-runs the node and re-renders the change, which is the remedy — another model is not.
          const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试";
          retry.addEventListener("click", () => retryWith(false, retryModel));
          const hint = document.createElement("span"); hint.className = "workflow-node-hint";
          hint.textContent = node.failureCode ? `提交未通过（${node.failureCode}）：重试会重新生成本轮改动` : "提交未通过：重试会重新生成本轮改动";
          row.append(retry, hint);
        } else {
          const model = modelOptions(retryModel); model.className = "setting-select";
          const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "用所选模型重试";
          retry.addEventListener("click", () => retryWith(false, model.value));
          const saveAndRetry = document.createElement("button"); saveAndRetry.type = "button"; saveAndRetry.textContent = "保存为卡默认并重试"; saveAndRetry.addEventListener("click", () => retryWith(true, model.value));
          row.append(model, retry, saveAndRetry);
        }
      }
      if (run.live && node.status === "awaiting-recovery") {
        const recover = document.createElement("button"); recover.type = "button"; recover.textContent = "恢复原任务";
        recover.addEventListener("click", async () => { recover.disabled = true; try { await request(`/api/workflow-runs/${run.id}/nodes/${node.id}/recover`, { method: "POST" }); await refreshWorkflowData(); } catch (error) { showError(error); recover.disabled = false; } });
        row.append(recover);
      }
      card.append(row);
    }
    if (run.live && !["completed", "skipped", "failed", "cancelled"].includes(run.status)) {
      if (run.blocksNextTurn) {
        const skip = document.createElement("button"); skip.type = "button"; skip.className = "run-skip"; skip.textContent = "跳过并放行";
        skip.addEventListener("click", async () => { await request(`/api/workflow-runs/${run.id}/skip`, { method: "POST" }); await refreshWorkflowData(); });
        card.append(skip);
      }
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-danger run-cancel"; cancel.textContent = "取消实例";
      cancel.addEventListener("click", async () => { await request(`/api/workflow-runs/${run.id}/cancel`, { method: "POST" }); await refreshWorkflowData(); });
      card.append(cancel);
    }
    fragment.append(card);
  }
  if (!fragment.childNodes.length) { const empty = document.createElement("p"); empty.className = "module-settings-empty"; empty.textContent = "当前 Pi 会话还没有工作流实例。"; fragment.append(empty); }
  elements.workflowRunList.replaceChildren(fragment);
}

export function formatTokenCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number.isFinite(value) ? value : 0);
}

export function completedNodeUsageRows() {
  const rows = [];
  for (const run of state.workflowRuns) {
    for (const node of Object.values(run.nodes || {})) {
      if (node.status !== "completed") continue;
      const attempt = [...(node.attempts || [])].reverse().find(item => item.status === "completed") || null;
      rows.push({
        workflowId: run.workflowId,
        runId: run.id,
        turn: run.turn,
        nodeId: node.id,
        completedAt: node.completedAt || attempt?.completedAt || run.completedAt,
        modelId: attempt?.resolvedModel?.id || attempt?.modelId || "—",
        usage: node.usage ?? attempt?.usage ?? null,
      });
    }
  }
  return rows.sort((left, right) => new Date(right.completedAt || 0) - new Date(left.completedAt || 0));
}

export function renderTokenUsage() {
  const rows = completedNodeUsageRows();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let recorded = 0;
  for (const run of state.workflowRuns) {
    for (const node of Object.values(run.nodes || {})) {
      for (const attempt of node.attempts || []) {
        if (!attempt.usage) continue;
        for (const field of Object.keys(totals)) totals[field] += Number(attempt.usage[field]) || 0;
      }
    }
  }
  elements.tokenTotal.textContent = formatTokenCount(totals.totalTokens);
  elements.tokenInput.textContent = formatTokenCount(totals.input);
  elements.tokenOutput.textContent = formatTokenCount(totals.output);
  elements.tokenCacheRead.textContent = formatTokenCount(totals.cacheRead);
  elements.tokenCacheWrite.textContent = formatTokenCount(totals.cacheWrite);
  const workflowFragment = document.createDocumentFragment();
  for (const run of state.workflowRuns.filter(item => item.status === "completed").slice().reverse()) {
    const card = document.createElement("article"); card.className = "token-workflow-card";
    const head = document.createElement("div"); head.className = "token-node-head";
    const title = document.createElement("strong"); title.textContent = run.workflowId;
    const meta = document.createElement("span"); meta.textContent = `回合 ${run.turn ?? "—"} · ${formatSessionTime(run.completedAt)}`;
    head.append(title, meta); card.append(head);
    if (!run.usage) {
      const missing = document.createElement("p"); missing.className = "token-missing"; missing.textContent = "本次总消耗未记录（升级前完成）"; card.append(missing);
    } else {
      const total = document.createElement("p"); total.className = "token-workflow-total"; total.textContent = `${formatTokenCount(run.usage.totalTokens)} token${run.usageComplete === false ? "（已记录部分）" : ""}`; card.append(total);
      const values = document.createElement("div"); values.className = "token-values";
      for (const [label, field] of [["输入", "input"], ["输出", "output"], ["缓存读", "cacheRead"], ["缓存写", "cacheWrite"]]) {
        const item = document.createElement("span"); item.textContent = `${label} ${formatTokenCount(run.usage[field])}`; values.append(item);
      }
      card.append(values);
    }
    workflowFragment.append(card);
  }
  if (!workflowFragment.childNodes.length) { const empty = document.createElement("p"); empty.className = "module-settings-empty"; empty.textContent = "当前聊天还没有完成的工作流。"; workflowFragment.append(empty); }
  elements.tokenWorkflowList.replaceChildren(workflowFragment);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    if (row.usage) recorded += 1;
    const card = document.createElement("article"); card.className = "token-node-card";
    const head = document.createElement("div"); head.className = "token-node-head";
    const title = document.createElement("strong"); title.textContent = `${row.workflowId} / ${row.nodeId}`;
    const meta = document.createElement("span"); meta.textContent = `回合 ${row.turn ?? "—"} · ${formatSessionTime(row.completedAt)}`;
    head.append(title, meta);
    const model = document.createElement("p"); model.className = "token-model"; model.textContent = `模型：${row.modelId}`;
    card.append(head, model);
    if (!row.usage) {
      const missing = document.createElement("p"); missing.className = "token-missing"; missing.textContent = "未记录（此节点可能在统计功能加入前完成）"; card.append(missing);
    } else {
      const values = document.createElement("div"); values.className = "token-values";
      for (const [label, field] of [["总计", "totalTokens"], ["输入", "input"], ["输出", "output"], ["缓存读", "cacheRead"], ["缓存写", "cacheWrite"]]) {
        const item = document.createElement("span"); item.textContent = `${label} ${formatTokenCount(row.usage[field])}`; values.append(item);
      }
      card.append(values);
    }
    fragment.append(card);
  }
  if (!rows.length) { const empty = document.createElement("p"); empty.className = "module-settings-empty"; empty.textContent = "当前聊天还没有成功完成的工作流节点。"; fragment.append(empty); }
  elements.tokenNodeList.replaceChildren(fragment);
  elements.tokenStatus.textContent = rows.length ? `共 ${rows.length} 个成功节点，${recorded} 个有统计数据。` : "";
}

export async function refreshTokenUsage(force = false) {
  const payload = await request("/api/workflow-runs");
  state.workflowRuns = payload.runs || [];
  const signature = JSON.stringify(state.workflowRuns.map(run => ({ id: run.id, updatedAt: run.updatedAt, nodes: run.nodes })));
  if (!force && signature === state.tokenRenderSignature) return;
  state.tokenRenderSignature = signature;
  renderTokenUsage();
}

export async function refreshWorkflowData(selectId, forceRender = false) {
  const [workflowData, runData] = await Promise.all([request("/api/workflows"), request("/api/workflow-runs")]);
  state.workflows = workflowData.workflows || []; state.activeWorkflowId = workflowData.activeWorkflowId; state.workflowRuns = runData.runs || [];
  renderTokenUsage();
  if (!forceRender && workflowPanelHasFocus()) return;
  const signature = JSON.stringify({ workflows: state.workflows, activeWorkflowId: state.activeWorkflowId, runs: state.workflowRuns });
  if (!forceRender && signature === state.workflowRenderSignature) return;
  state.workflowRenderSignature = signature;
  const selected = selectId || elements.workflowSelect.value || state.activeWorkflowId;
  const running = runningWorkflowReferences();
  const options = state.workflows.map(item => {
    const reference = workflowReference(item);
    const owner = item.source === "module" ? `${item.moduleTitle || item.ownerModuleId} · ` : "";
    const option = new Option(`${owner}${item.title} · ${workflowKindLabel(item.kind)}`, reference);
    if (running.has(reference)) { option.classList.add("workflow-running-option"); option.style.fontWeight = "700"; }
    return option;
  });
  elements.workflowSelect.replaceChildren(...options);
  elements.workflowSelect.disabled = false;
  if (state.workflows.some(item => workflowReference(item) === selected)) elements.workflowSelect.value = selected;
  else if (state.workflows.length) elements.workflowSelect.value = workflowReference(state.workflows[0]);
  renderWorkflow();
}

export async function activateSelectedWorkflow() {
  const workflow = selectedWorkflow(); if (!workflow) return;
  elements.workflowStatus.textContent = workflow.kind === "foreground" ? "正在复制到当前卡并激活……" : "正在启动后台实例……";
  try { const reference = workflowReference(workflow); const result = await request(`/api/workflows/${encodeURIComponent(reference)}/activate`, { method: "POST", body: "{}" }); await refreshWorkflowData(reference); elements.workflowStatus.textContent = result.startsOnNextInput ? "已激活；下一条用户消息使用此工作流。" : "后台工作流已启动。"; }
  catch (error) { elements.workflowStatus.textContent = "操作失败"; showError(error); }
}

export function modelOptions(selected = "pi:current") {
  const fragment = document.createDocumentFragment();
  for (const profile of state.models) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || profile.id;
    fragment.append(option);
  }
  const select = document.createElement("select");
  select.append(fragment);
  select.value = selected;
  return select;
}

export function inheritedModel(workflow, nodeAgentId = "") {
  if (workflow.defaults?.modelId) return { source: "工作流默认模型", id: workflow.defaults.modelId };
  const agentId = nodeAgentId || workflow.defaults?.agentId || "";
  const agent = state.agents.find(item => item.effective.id === agentId)?.effective;
  return { source: "Agent 默认模型", id: agent?.defaultModelId || "pi:current" };
}

export function formatSessionTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function agentLabel(agentId) {
  if (!agentId) return "未设置";
  const agent = state.agents.find(item => item.effective.id === agentId)?.effective;
  return agent ? `${agent.name} · ${agent.id}` : agentId;
}

export function modelLabel(modelId) {
  if (!modelId) return "未设置";
  const model = state.models.find(item => item.id === modelId);
  return model ? `${model.name || model.id} · ${model.id}` : modelId;
}

export function statusLabel(status) { return ({ pending: "等待", running: "执行中", completed: "完成", skipped: "跳过", failed: "失败", cancelled: "已取消", "awaiting-retry": "等待重试", "awaiting-model-choice": "等待选择模型", "awaiting-recovery": "等待恢复原任务" })[status] || status; }

export function currentForegroundRun() { return state.workflowRuns.slice().reverse().find(run => run.kind === "foreground" && isActiveWorkflowRun(run)) || null; }
