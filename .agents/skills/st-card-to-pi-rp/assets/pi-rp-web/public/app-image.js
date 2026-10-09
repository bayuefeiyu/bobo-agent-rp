// 生图交互面板（实施方案 §11 第 6 条：按职责提取的原生模块之一）。
//
// 负责：生图偏好、运行参数表单、生图执行、图片查看器、内容提示词查看，以及 ComfyUI 连接表单
// 与"生图"面板的整体渲染。
//
import { appendModuleEmpty, elements, request, showError, state } from "./app-context.js";

export async function saveImagePreferences(next) {
  const current = state.imageGeneration?.preferences?.data || { selectedProfileIds: [], quickMode: false, inputPolicy: { kind: "recent-turns", turnCount: 3, target: "latest" } };
  const payload = { ...current, ...next };
  await request("/api/image-generation/preferences", { method: "PUT", body: JSON.stringify(payload) });
  state.imageGeneration.preferences = { ...(state.imageGeneration.preferences || {}), data: payload };
}

export function imageRunPayload(custom = false) {
  const preferences = state.imageGeneration?.preferences?.data || {};
  const inputPolicy = custom ? {
    kind: elements.imageSourceKind.value,
    turnCount: Number(elements.imageTurnCount.value) || 3,
    target: elements.imageTargetKind.value,
  } : preferences.inputPolicy;
  return {
    operationId: crypto.randomUUID(),
    profileIds: preferences.selectedProfileIds || [],
    inputPolicy,
    customBrief: custom ? elements.imageCustomBrief.value.trim() : "",
    userDirection: custom ? elements.imageUserDirection.value.trim() : "",
  };
}

export function openImageRunDialog() {
  const policy = state.imageGeneration?.preferences?.data?.inputPolicy || { kind: "recent-turns", turnCount: 3, target: "latest" };
  elements.imageSourceKind.value = ["recent-turns", "custom-brief"].includes(policy.kind) ? policy.kind : "recent-turns";
  elements.imageTurnCount.value = policy.turnCount || 3;
  elements.imageTargetKind.value = ["latest", "all"].includes(policy.target) ? policy.target : "latest";
  elements.imageCustomBrief.value = "";
  elements.imageUserDirection.value = "";
  elements.imageRunDialog.showModal();
}

export async function startImageRun(custom = false) {
  const payload = imageRunPayload(custom);
  if (!payload.profileIds.length) throw new Error("请至少选择一个已适配工作流。");
  if (custom && payload.inputPolicy?.kind === "recent-turns") await saveImagePreferences({ inputPolicy: payload.inputPolicy });
  await request("/api/image-generation/run", { method: "POST", body: JSON.stringify(payload) });
  elements.imageUserDirection.value = "";
  if (custom) elements.imageRunDialog.close();
}

export function renderImageViewer() {
  const url = state.imageViewerItems[state.imageViewerIndex];
  elements.imageViewerImage.src = url;
  elements.imageViewerDownload.href = url.replace(/\?preview=.*$/, "");
  elements.imageViewerImage.classList.toggle("zoomed", state.imageViewerZoomed);
  elements.imageViewerZoom.textContent = state.imageViewerZoomed ? "缩小" : "放大";
  elements.imageViewerPrevious.disabled = state.imageViewerIndex <= 0;
  elements.imageViewerNext.disabled = state.imageViewerIndex >= state.imageViewerItems.length - 1;
}

export function openImageViewer(items, index) {
  state.imageViewerItems = items;
  state.imageViewerIndex = index;
  state.imageViewerZoomed = false;
  renderImageViewer();
  elements.imageViewerDialog.showModal();
}

export function openImagePrompt(render) {
  state.imagePromptRenderId = render.id;
  elements.imageContentPrompt.value = render.data.contentPrompt || "";
  elements.imagePositivePrompt.value = render.data.positivePrompt || "";
  elements.imageNegativePrompt.value = render.data.negativePrompt || "";
  elements.imagePromptDialog.showModal();
}

export function loadComfyConnectionForm() {
  const connection = state.imageGeneration?.connections?.find(item => item.id === elements.comfyConnectionSelect.value);
  if (!connection) return;
  elements.comfyConnectionId.value = connection.id;
  elements.comfyConnectionTitle.value = connection.title;
  elements.comfyConnectionUrl.value = connection.baseUrl;
  elements.comfyConnectionToken.value = "";
  elements.comfyOutputPath.value = connection.outputDirectoryPath || "";
  elements.comfyInsecureRemote.checked = connection.allowInsecureRemote === true;
}

export function renderComfySettings() {
  const payload = state.imageGeneration;
  const connections = payload?.connections || [];
  const selected = elements.comfyConnectionSelect.value || connections[0]?.id || "local";
  elements.comfyConnectionSelect.replaceChildren(...connections.map(item => new Option(`${item.title}${item.hasToken ? " · 已保存凭据" : ""}`, item.id)));
  if (connections.some(item => item.id === selected)) elements.comfyConnectionSelect.value = selected;
  loadComfyConnectionForm();
  const fragment = document.createDocumentFragment();
  for (const profile of payload?.profiles || []) {
    const row = document.createElement("div"); row.className = "comfy-profile-document"; const name = document.createElement("strong"); name.textContent = `${profile.title}${profile.overrideStale ? " · 覆盖已过期" : ""}`; row.append(name);
    for (const [target, label] of [["profile", "固定提示词"], ["workflow", "API 工作流"], ["guide", "模型指导"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "module-file-button"; button.textContent = label;
      button.addEventListener("click", () => request(`/api/image-generation/profiles/${encodeURIComponent(profile.id)}/open`, { method: "POST", body: JSON.stringify({ target }) }).catch(showError)); row.append(button);
    }
    fragment.append(row);
  }
  if (!fragment.childNodes.length) appendModuleEmpty(fragment, "没有适配配置。请在项目根目录用 adapt-comfyui-workflow 添加。");
  elements.comfyProfileDocuments.replaceChildren(fragment);
}

export async function renderImageGenerationRegion(section) {
  state.imageGenerationRegion = section;
  let payload;
  try { payload = await request("/api/image-generation"); }
  catch (error) { appendModuleEmpty(section, error.message); return; }
  if (state.imageGenerationRegion !== section) return;
  state.imageGeneration = payload;
  renderComfySettings();
  const preferences = payload.preferences?.data || { selectedProfileIds: [], quickMode: false, inputPolicy: { kind: "recent-turns", turnCount: 3, target: "latest" } };
  const controls = document.createElement("div"); controls.className = "image-generation-controls";
  const profiles = document.createElement("fieldset"); profiles.className = "image-profile-list";
  const legend = document.createElement("legend"); legend.textContent = "生图工作流"; profiles.append(legend);
  for (const profile of payload.profiles || []) {
    const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = preferences.selectedProfileIds.includes(profile.id);
    checkbox.addEventListener("change", async () => {
      const selected = new Set(preferences.selectedProfileIds); if (checkbox.checked) selected.add(profile.id); else selected.delete(profile.id);
      preferences.selectedProfileIds = [...selected]; try { await saveImagePreferences({ selectedProfileIds: preferences.selectedProfileIds }); } catch (error) { showError(error); }
    });
    label.append(checkbox, document.createTextNode(profile.title)); profiles.append(label);
  }
  if (!(payload.profiles || []).length) appendModuleEmpty(profiles, "没有已适配工作流。请在项目根目录运行 adapt-comfyui-workflow。");
  const quickLabel = document.createElement("label"); quickLabel.className = "image-quick-toggle"; const quick = document.createElement("input"); quick.type = "checkbox"; quick.checked = preferences.quickMode === true;
  quick.addEventListener("change", async () => { preferences.quickMode = quick.checked; try { await saveImagePreferences({ quickMode: quick.checked }); } catch (error) { showError(error); } });
  quickLabel.append(quick, document.createTextNode(" 快速模式"));
  const actions = document.createElement("div"); actions.className = "image-generation-actions";
  const generate = document.createElement("button"); generate.type = "button"; generate.textContent = "生成图片"; generate.disabled = !(payload.profiles || []).length || !payload.sessionId;
  generate.addEventListener("click", async () => { try { if (preferences.quickMode && preferences.inputPolicy?.kind === "recent-turns") await startImageRun(false); else openImageRunDialog(); } catch (error) { showError(error); } });
  const customize = document.createElement("button"); customize.type = "button"; customize.className = "secondary-button"; customize.textContent = "定制本次"; customize.disabled = generate.disabled; customize.addEventListener("click", openImageRunDialog);
  actions.append(generate, customize); controls.append(profiles, quickLabel, actions);
  const gallery = document.createElement("div"); gallery.className = "image-gallery";
  const displayRenders = [...(payload.renders || [])].reverse();
  const viewerItems = displayRenders.filter(render => render.data.outputs?.[0]).map(render => `/api/image-generation/renders/${encodeURIComponent(render.id)}/images/0`);
  const summarizedRequests = new Set();
  for (const render of displayRenders) {
    if (!summarizedRequests.has(render.data.requestId)) {
      summarizedRequests.add(render.data.requestId);
      const siblings = displayRenders.filter(item => item.data.requestId === render.data.requestId);
      const completedCount = siblings.filter(item => item.data.state === "completed").length;
      const failedCount = siblings.filter(item => item.data.state === "failed").length;
      const recoveryCount = siblings.filter(item => ["submitting", "submitted"].includes(item.data.state) || item.data.errorKind === "submission-uncertain").length;
      const summary = document.createElement("p"); summary.className = "image-card-status image-request-summary";
      summary.textContent = recoveryCount
        ? (completedCount || failedCount ? `部分完成 · ${completedCount} 已完成 · ${failedCount} 确定失败 · ${recoveryCount} 等待恢复` : `${recoveryCount} 项等待恢复原任务`)
        : failedCount
          ? (completedCount ? `部分完成 · ${completedCount} 已完成 · ${failedCount} 确定失败` : `${failedCount} 项确定失败`)
          : completedCount === siblings.length
            ? `${completedCount} 项全部完成`
            : `${completedCount}/${siblings.length} 项已完成`;
      gallery.append(summary);
    }
    const card = document.createElement("article"); card.className = `image-card state-${render.data.state}`;
    const head = document.createElement("div"); head.className = "image-card-head"; const title = document.createElement("strong"); title.textContent = `#${render.data.ordinal} · ${render.data.profileId}`; const stateLabel = document.createElement("span"); stateLabel.textContent = ({ pending: "等待生成", submitting: "提交结果待确认", submitted: "生成中", completed: "已完成", failed: "确定失败", cancelled: "已取消" })[render.data.state] || render.data.state; head.append(title, stateLabel); card.append(head);
    const output = render.data.outputs?.[0];
    if (output) {
      const figure = document.createElement("button"); figure.type = "button"; figure.className = "image-thumbnail-button";
      const image = document.createElement("img"); image.loading = "lazy"; image.alt = `${render.data.profileId} 生成图`; const original = `/api/image-generation/renders/${encodeURIComponent(render.id)}/images/0`; image.src = `${original}?preview=webp;80`;
      image.addEventListener("error", () => { figure.replaceChildren(Object.assign(document.createElement("span"), { textContent: "源文件找不到；提示词仍可重新生成" })); });
      figure.append(image); figure.addEventListener("click", () => openImageViewer(viewerItems, viewerItems.indexOf(original))); card.append(figure);
    } else { const status = document.createElement("p"); status.className = "image-card-status"; status.textContent = render.data.error || (render.data.state === "pending" ? "等待生成" : "暂时没有图片输出"); card.append(status); }
    const prompt = document.createElement("button"); prompt.type = "button"; prompt.className = "module-file-button"; prompt.textContent = "查看提示词"; prompt.addEventListener("click", () => openImagePrompt(render)); card.append(prompt);
    if (["submitting", "submitted"].includes(render.data.state) || render.data.errorKind === "submission-uncertain") {
      const recover = document.createElement("button"); recover.type = "button"; recover.className = "secondary-button"; recover.textContent = "恢复原任务";
      recover.addEventListener("click", async () => {
        try {
          recover.disabled = true;
          await request(`/api/image-generation/requests/${encodeURIComponent(render.data.requestId)}/recover`, { method: "POST" });
          await renderImageGenerationRegion(section);
        } catch (error) { recover.disabled = false; showError(error); }
      });
      card.append(recover);
    }
    gallery.append(card);
  }
  if (!gallery.children.length) appendModuleEmpty(gallery, "当前聊天还没有生图记录。");
  section.replaceChildren(controls, gallery);
}
