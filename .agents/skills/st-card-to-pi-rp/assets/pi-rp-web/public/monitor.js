import { initializePageContext, getClient, request, state, elements, showError } from "./app-context.js";
import { refreshWorkflowData, renderWorkflow, refreshTokenUsage, activateSelectedWorkflow, runningWorkflowReferences } from "./app-workflows.js";
initializePageContext();
state.activePanel = "workflows";
try {
  state.snapshot = await request("/api/v1/state");
  state.models = (await request("/api/v1/models")).profiles || [];
  state.agents = (await request("/api/v1/agents")).agents || [];
  state.workflowPolicy = await request("/api/v1/workflow-policy");
  await refreshWorkflowData(undefined, true);
  await refreshTokenUsage(true);
  elements.workflowSelect.addEventListener("change", renderWorkflow);
  elements.refreshWorkflows.addEventListener("click", () => refreshWorkflowData(undefined, true).catch(showError));
  elements.refreshTokens.addEventListener("click", () => refreshTokenUsage(true).catch(showError));
  elements.activateWorkflow.addEventListener("click", () => activateSelectedWorkflow().catch(showError));
  const locate = async running => {
    await refreshWorkflowData(undefined, true);
    const references = running ? [...runningWorkflowReferences()] : [state.activeWorkflowId].filter(Boolean);
    if (!references.length) { elements.workflowStatus.textContent = running ? "当前没有正在运行的工作流。" : "当前未配置前台工作流。"; return; }
    elements.workflowSelect.value = references[(references.indexOf(elements.workflowSelect.value) + 1) % references.length];
    renderWorkflow();
  };
  elements.showActiveWorkflow.addEventListener("click", () => locate(false).catch(showError));
  elements.showRunningWorkflow.addEventListener("click", () => locate(true).catch(showError));
  const stop = getClient().watch("state", async snapshot => { state.snapshot = snapshot; await refreshWorkflowData(); await refreshTokenUsage(); }, { intervalMs: 1500, visible: () => !document.hidden, onError: showError });
  window.addEventListener("pagehide", () => { stop(); getClient().dispose(); }, { once: true });
} catch (error) { showError(error); }
