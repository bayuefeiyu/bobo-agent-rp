import { showHandoff, isInactiveBridgeMessage } from "./app-context.js";
export { showHandoff, isInactiveBridgeMessage };
import { state, elements, request, showError, componentReference, runWorkflowReference, modelPresets, appendModuleEmpty, initializePageContext } from "./app-context.js";
export { state, elements, request, showError, componentReference, runWorkflowReference, modelPresets };
// image 模块（方案 §11 第 6 条）。
import {
  saveImagePreferences,
  imageRunPayload,
  openImageRunDialog,
  startImageRun,
  renderImageViewer,
  openImageViewer,
  openImagePrompt,
  loadComfyConnectionForm,
  renderComfySettings,
  renderImageGenerationRegion,
} from "./app-image.js?v=1";
// modules 模块（方案 §11 第 6 条）。
import {
  toggleCardModule,
  appendModuleValue,
  appendModuleJsonNode,
  appendInteractiveValue,
  inputForDeclaration,
  declaredInputValue,
  createDeclaredField,
  valueAtPath,
  renderRecordHistory,
  renderRecordBrowserRegion,
  renderStoryBrowserRegion,
  renderSettingsFormRegion,
  renderPromptControlsRegion,
  renderIntegrityAlertsRegion,
  renderWorkflowControlsRegion,
  createModuleRegion,
  normalizeModuleDisplaySettings,
  savedModuleDisplaySettings,
  orderedVisibleModules,
  openFeatureModuleDocument,
  renderFeatureModules,
  syncModuleDisplayDraft,
  markModuleDisplayDirty,
  moveModuleDisplay,
  renderModuleSettings,
  saveModuleDisplaySettings,
  resetModuleDisplaySettings,
} from "./app-modules.js?v=1";
// workflows 模块（方案 §11 第 6 条）。
import {
  workflowKindLabel,
  workflowReference,
  isActiveWorkflowRun,
  runningWorkflowReferences,
  selectedWorkflow,
  workflowPanelHasFocus,
  renderWorkflow,
  renderWorkflowRuns,
  formatTokenCount,
  completedNodeUsageRows,
  renderTokenUsage,
  refreshTokenUsage,
  refreshWorkflowData,
  activateSelectedWorkflow,
  modelOptions,
  inheritedModel,
  formatSessionTime,
  agentLabel,
  modelLabel,
  statusLabel,
  currentForegroundRun,
} from "./app-workflows.js?v=1";

// 保持既有调用点不变：页面与测试仍把拆出的函数视为 app.js 的一部分。
export {
  saveImagePreferences,
  imageRunPayload,
  openImageRunDialog,
  startImageRun,
  renderImageViewer,
  openImageViewer,
  openImagePrompt,
  loadComfyConnectionForm,
  renderComfySettings,
  renderImageGenerationRegion,
  toggleCardModule,
  appendModuleValue,
  appendModuleJsonNode,
  appendInteractiveValue,
  inputForDeclaration,
  declaredInputValue,
  createDeclaredField,
  valueAtPath,
  renderRecordHistory,
  renderRecordBrowserRegion,
  renderStoryBrowserRegion,
  renderSettingsFormRegion,
  renderPromptControlsRegion,
  renderIntegrityAlertsRegion,
  renderWorkflowControlsRegion,
  createModuleRegion,
  normalizeModuleDisplaySettings,
  savedModuleDisplaySettings,
  orderedVisibleModules,
  openFeatureModuleDocument,
  renderFeatureModules,
  syncModuleDisplayDraft,
  markModuleDisplayDirty,
  moveModuleDisplay,
  renderModuleSettings,
  saveModuleDisplaySettings,
  resetModuleDisplaySettings,
  appendModuleEmpty,
  workflowKindLabel,
  workflowReference,
  isActiveWorkflowRun,
  runningWorkflowReferences,
  selectedWorkflow,
  workflowPanelHasFocus,
  renderWorkflow,
  renderWorkflowRuns,
  formatTokenCount,
  completedNodeUsageRows,
  renderTokenUsage,
  refreshTokenUsage,
  refreshWorkflowData,
  activateSelectedWorkflow,
  modelOptions,
  inheritedModel,
  formatSessionTime,
  agentLabel,
  modelLabel,
  statusLabel,
  currentForegroundRun,
};

import { renderMarkdown } from "./markdown.js?v=4";
import { buildModuleJsonTree } from "./module-json.js?v=2";
import { composePromptPreview, selectionsFromValues, valuesFromSelections } from "./prompt-controls.js?v=1";

/** Keep the topbar status readable; the untruncated reason stays in the element's title attribute. */
function shortenDetail(detail, limit = 60) {
  const text = String(detail).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function showPanel(panelName) {
  state.activePanel = panelName;
  for (const button of elements.tabButtons) {
    const active = button.dataset.panel === panelName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of elements.panels) panel.hidden = panel.id !== `panel-${panelName}`;
  if (panelName === "story" && state.snapshot?.openingId && !state.snapshot.busy) elements.input.focus();
  if (panelName === "user") elements.playerName.focus();
  if (state.snapshot?.previewMode && panelName === "workflows") {
    document.querySelectorAll("#panel-workflows button, #panel-workflows input, #panel-workflows textarea")
      .forEach(control => { control.disabled = true; });
    elements.workflowSelect.disabled = false;
    elements.refreshWorkflows.disabled = false;
    elements.showActiveWorkflow.disabled = false;
  }
  if (state.snapshot?.previewMode && panelName === "system") {
    document.querySelectorAll("#module-display-settings-form button, #module-display-settings-form input, #module-display-settings-form textarea, #module-display-settings-form select, #comfy-connection-form button, #comfy-connection-form input, #comfy-connection-form textarea, #comfy-connection-form select")
      .forEach(control => { control.disabled = true; });
    elements.moduleSettingsStatus.textContent = "需要载入具体角色卡后才能保存模块显示覆盖。";
    elements.comfyConnectionStatus.textContent = "需要载入安装了生图模块的角色卡后配置连接。";
  }
}

export function profileForName(playerName) {
  return state.settings?.common?.user?.savedProfiles?.find(profile => profile.name === playerName);
}

function userAvatarUrl(playerName) {
  return `/api/user-avatar?playerName=${encodeURIComponent(playerName)}&v=${state.avatarVersion}`;
}

function createAvatarElement(role, playerName) {
  const avatar = document.createElement("div");
  avatar.className = `message-avatar ${role}`;
  const fallback = document.createElement("span");
  fallback.textContent = (playerName || "?").trim().slice(0, 1);
  avatar.append(fallback);

  const profile = role === "user" ? profileForName(playerName) : null;
  if (role === "assistant" || profile?.avatar) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = role === "assistant"
      ? `/api/cards/${encodeURIComponent(state.card.id)}/cover`
      : userAvatarUrl(playerName);
    image.addEventListener("load", () => avatar.classList.add("has-image"));
    image.addEventListener("error", () => image.remove());
    avatar.append(image);
  }
  return avatar;
}

function createMessageElement(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}${message.kind === "opening" ? " opening" : ""}`;
  const playerName = state.snapshot?.playerName || "你";
  const speakerName = message.role === "user" ? playerName : state.card.name;
  const avatar = createAvatarElement(message.role, speakerName);
  const body = document.createElement("div");
  body.className = "message-body";
  const header = document.createElement("div");
  header.className = "message-header";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = speakerName;
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "message-action";
  editButton.textContent = "修改";
  editButton.disabled = Boolean(state.snapshot?.busy);
  editButton.addEventListener("click", () => beginMessageEdit(message, body));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "message-action danger";
  deleteButton.textContent = "删除";
  deleteButton.disabled = Boolean(state.snapshot?.busy);
  deleteButton.addEventListener("click", () => deleteSavedMessage(message, deleteButton));
  actions.append(editButton, deleteButton);
  header.append(label, actions);
  const content = document.createElement("div");
  content.className = "message-content";
  renderMarkdown(content, message.content);
  body.append(header, content);
  article.append(avatar, body);
  return article;
}

function beginMessageEdit(message, body) {
  if (state.snapshot?.busy || body.querySelector(".message-editor")) return;
  const content = body.querySelector(".message-content");
  const actions = body.querySelector(".message-actions");
  const form = document.createElement("form");
  form.className = "message-editor";
  const textarea = document.createElement("textarea");
  textarea.rows = 6;
  textarea.maxLength = 100000;
  textarea.value = message.content;
  textarea.setAttribute("aria-label", "修改这条聊天记录");
  const footer = document.createElement("div");
  footer.className = "message-editor-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "primary";
  saveButton.textContent = "保存修改";
  footer.append(cancelButton, saveButton);
  form.append(textarea, footer);
  content.hidden = true;
  actions.hidden = true;
  body.append(form);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  cancelButton.addEventListener("click", () => {
    form.remove();
    content.hidden = false;
    actions.hidden = false;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const nextContent = textarea.value.trim();
    if (!nextContent) return;
    textarea.disabled = true;
    cancelButton.disabled = true;
    saveButton.disabled = true;
    saveButton.textContent = "保存中……";
    try {
      applySnapshot(await request(`/api/messages/${message.sequence}`, {
        method: "PUT",
        body: JSON.stringify({ content: nextContent }),
      }));
    } catch (error) {
      textarea.disabled = false;
      cancelButton.disabled = false;
      saveButton.disabled = false;
      saveButton.textContent = "保存修改";
      showError(error);
    }
  });
}

async function deleteSavedMessage(message, button) {
  if (state.snapshot?.busy) return;
  const messageIndex = state.snapshot.messages.findIndex(item => item.sequence === message.sequence);
  if (messageIndex === -1) return;
  const followingCount = state.snapshot.messages.length - messageIndex - 1;
  const deletingWholeChat = messageIndex === 0;
  const prompt = deletingWholeChat && followingCount > 0
    ? `删除这条消息会同时删除其后的 ${followingCount} 条消息，整条聊天记录将消失。确定继续吗？`
    : deletingWholeChat
      ? "这是当前聊天的最后一条记录。删除后整条聊天记录将消失，确定继续吗？"
    : followingCount > 0
      ? `删除这条消息会同时删除其后的 ${followingCount} 条消息。确定继续吗？`
      : "确定删除这条已保存的聊天记录吗？";
  if (!window.confirm(prompt)) return;
  button.disabled = true;
  try {
    const snapshot = await request(`/api/messages/${message.sequence}`, { method: "DELETE" });
    applySnapshot(snapshot);
    if (!snapshot.openingId) renderHistoryChoices(await request("/api/sessions"));
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
}

function renderMessages(messages, scrollToEnd = false) {
  const fragment = document.createDocumentFragment();
  for (const message of messages) fragment.append(createMessageElement(message));
  if (!messages.length && state.snapshot?.previewMode) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "根目录开发预览没有聊天内容；这里展示的是玩卡时使用的同一个聊天区域。";
    fragment.append(empty);
  }
  elements.messages.replaceChildren(fragment);
  if (scrollToEnd) {
    requestAnimationFrame(() => elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: "smooth" }));
  }
}

function applySnapshot(snapshot) {
  const previousCount = state.snapshot?.messages?.length ?? -1;
  const previousMessages = state.snapshot?.messages || [];
  const previousPlayerName = state.snapshot?.playerName;
  state.snapshot = snapshot;
  const previewMode = snapshot.previewMode === true;
  const started = previewMode || Boolean(snapshot.openingId);
  document.body.classList.toggle("development-preview", previewMode);
  elements.openingView.hidden = started;
  elements.chatView.hidden = !started;
  elements.chooseChatButton.hidden = previewMode || !started;
  elements.chooseChatButton.disabled = previewMode || snapshot.busy || state.switching;
  const blockingWorkflows = snapshot.blockingWorkflows || [];
  const turnFailure = previewMode ? null : snapshot.lastTurnFailure || null;
  // A blocking workflow whose host hooks keep failing never advances, so "waiting" alone leaves the
  // player with no idea whether to keep waiting. Surface the recorded reason instead.
  const stuckBlocking = blockingWorkflows.find(item => (item.changeFailures || []).length);
  const stuckDetail = stuckBlocking ? stuckBlocking.changeFailures.at(-1)?.message || "" : "";
  elements.connectionStatus.textContent = previewMode
    ? "开发预览 · 未载入角色卡和聊天"
    : turnFailure
    ? `该回合未成功产出正文${turnFailure.detail ? `：${shortenDetail(turnFailure.detail)}` : ""}`
    : stuckBlocking
    ? `后台工作流 ${stuckBlocking.workflowTitle || stuckBlocking.workflowId} 已卡住${stuckDetail ? `：${shortenDetail(stuckDetail)}` : ""}`
    : blockingWorkflows.length
    ? `等待后台工作流：${blockingWorkflows.map(item => item.workflowTitle || item.workflowId).join("、")}`
    : snapshot.busy ? "Pi 正在回复" : "已连接当前 Pi 会话";
  elements.connectionStatus.classList.toggle("turn-failure", Boolean(turnFailure || stuckBlocking));
  elements.connectionStatus.title = turnFailure?.detail || stuckDetail || "";
  elements.input.disabled = previewMode || snapshot.busy;
  elements.input.placeholder = previewMode ? "根目录预览模式不发送消息" : "输入你的行动或对话……";
  elements.sendButton.disabled = previewMode || snapshot.busy || state.sending;
  elements.sendButton.textContent = previewMode ? "仅预览" : blockingWorkflows.length ? "等待后台任务" : snapshot.busy ? "等待 Pi" : "发送";
  if (!state.playerNameDirty) elements.playerName.value = snapshot.playerName || "玩家";

  const messagesChanged = snapshot.messages.length !== previousCount || snapshot.messages.some((message, index) => {
    const previous = previousMessages[index];
    return !previous || previous.sequence !== message.sequence || previous.content !== message.content || previous.editedAt !== message.editedAt;
  });
  const playerNameChanged = snapshot.playerName !== previousPlayerName;
  if (!started && state.card?.openings && playerNameChanged) renderOpeningChoices();
  if (started && (messagesChanged || playerNameChanged || previewMode)) renderMessages(snapshot.messages, messagesChanged);
  for (const action of document.querySelectorAll(".message-action")) action.disabled = snapshot.busy;
}

async function selectOpening(openingId, button) {
  button.disabled = true;
  try {
    const playerName = elements.playerName.value.trim() || state.snapshot?.playerName || "玩家";
    applySnapshot(await request("/api/opening", {
      method: "POST",
      body: JSON.stringify({ openingId, playerName }),
    }));
    elements.input.focus();
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
}

function renderOpeningChoices() {
  const fragment = document.createDocumentFragment();
  const playerName = elements.playerName.value.trim() || state.snapshot?.playerName || "玩家";
  for (const opening of state.card.openings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "opening-card";
    const title = document.createElement("h3");
    title.textContent = opening.title.replaceAll("{{user}}", () => playerName);
    const preview = document.createElement("p");
    preview.textContent = opening.content.replaceAll("{{user}}", () => playerName);
    button.append(title, preview);
    button.addEventListener("click", () => selectOpening(opening.id, button));
    fragment.append(button);
  }
  elements.openingList.replaceChildren(fragment);
}


async function resumeSession(sessionId, button) {
  button.disabled = true;
  try {
    applySnapshot(await request("/api/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }));
    elements.input.focus();
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
}

function buildHistoryChoices(sessions, selectable) {
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-card-actions";
    const card = document.createElement(selectable ? "button" : "article");
    if (selectable) card.type = "button";
    card.className = "history-card";
    const heading = document.createElement("div");
    heading.className = "history-card-heading";
    const title = document.createElement("h4");
    title.textContent = formatSessionTime(session.updatedAt);
    const count = document.createElement("span");
    count.textContent = `${session.messageCount} 条消息`;
    heading.append(title, count);
    const metadata = document.createElement("p");
    metadata.className = "history-metadata";
    metadata.textContent = `玩家：${session.playerName || "玩家"}`;
    const preview = document.createElement("p");
    preview.className = "history-preview";
    preview.textContent = session.lastMessage || "尚无正文预览";
    card.append(heading, metadata, preview);
    if (selectable) card.addEventListener("click", () => resumeSession(session.id, card));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "history-delete";
    deleteButton.textContent = "删除";
    deleteButton.disabled = session.id === state.snapshot?.sessionId;
    deleteButton.title = deleteButton.disabled ? "当前聊天不能删除" : "删除这条聊天记录";
    deleteButton.addEventListener("click", () => deleteSession(session, deleteButton));
    wrapper.append(card, deleteButton);
    fragment.append(wrapper);
  }
  return fragment;
}

async function deleteSession(session, button) {
  if (!window.confirm(`确定删除 ${formatSessionTime(session.updatedAt)} 的聊天记录吗？此操作无法恢复。`)) return;
  button.disabled = true;
  try {
    await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    renderHistoryChoices(await request("/api/sessions"));
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
}

function renderSavedProfiles() {
  const profiles = state.settings?.common?.user?.savedProfiles || [];
  const fragment = document.createDocumentFragment();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.name;
    option.textContent = profile.name;
    fragment.append(option);
  }
  elements.savedProfile.replaceChildren(fragment);
  elements.savedProfile.value = state.settings?.common?.user?.playerName || profiles[0]?.name || "";
  if (!elements.savedProfile.value && profiles[0]) elements.savedProfile.value = profiles[0].name;
  elements.deleteSavedProfile.disabled = profiles.length <= 1 || !elements.savedProfile.value;
}

async function deleteSavedProfile() {
  const playerName = elements.savedProfile.value;
  const profiles = state.settings?.common?.user?.savedProfiles || [];
  if (!playerName || profiles.length <= 1) return;
  if (!window.confirm(`确定删除已保存用户“${playerName}”吗？关联头像也会删除，此操作无法恢复。`)) return;
  elements.deleteSavedProfile.disabled = true;
  elements.userSettingsStatus.textContent = "删除中……";
  try {
    const result = await request(`/api/user-profile?playerName=${encodeURIComponent(playerName)}`, { method: "DELETE" });
    applySnapshot(result);
    state.settings.common = result.settings;
    elements.playerName.value = result.settings.user.playerName;
    elements.playerDescription.value = result.settings.user.description || "";
    elements.playerAvatar.value = "";
    state.playerNameDirty = false;
    state.avatarVersion = Date.now();
    renderSavedProfiles();
    renderPlayerAvatarPreview();
    if (state.snapshot?.openingId) renderMessages(state.snapshot.messages);
    elements.userSettingsStatus.textContent = `已删除“${playerName}”`;
  } catch (error) {
    renderSavedProfiles();
    elements.userSettingsStatus.textContent = "删除失败";
    showError(error);
  }
}

function renderPlayerAvatarPreview() {
  const playerName = elements.playerName.value.trim() || "玩家";
  const profile = profileForName(playerName);
  elements.playerAvatarFallback.textContent = playerName.slice(0, 1);
  elements.playerAvatarImage.hidden = true;
  elements.playerAvatarImage.removeAttribute("src");
  if (!profile?.avatar) return;
  elements.playerAvatarImage.onload = () => { elements.playerAvatarImage.hidden = false; };
  elements.playerAvatarImage.onerror = () => { elements.playerAvatarImage.hidden = true; };
  elements.playerAvatarImage.src = userAvatarUrl(playerName);
}

async function uploadPlayerAvatar(playerName, file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error("头像必须是 PNG、JPEG 或 WebP 图片。");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("头像不能超过 5 MB。");
  const response = await fetch(`/api/user-avatar?playerName=${encodeURIComponent(playerName)}`, {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "头像上传失败。");
  return payload;
}

function renderCards() {
  const query = elements.cardSearch.value.trim().toLocaleLowerCase();
  const cards = state.cards.filter(card => card.name.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const card of cards) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "character-card";
    if (card.hasCover) {
      const image = document.createElement("img");
      image.className = "character-cover";
      image.src = `/api/cards/${encodeURIComponent(card.id)}/cover`;
      image.alt = `${card.name} 封面`;
      button.append(image);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "character-cover character-cover-placeholder";
      placeholder.textContent = card.name.slice(0, 1);
      button.append(placeholder);
    }
    const copy = document.createElement("span");
    copy.className = "character-card-copy";
    const name = document.createElement("span");
    name.className = "character-card-name";
    name.textContent = card.name;
    const current = document.createElement("span");
    current.className = "character-card-current";
    current.textContent = card.id === state.card.id ? "当前角色卡" : "";
    copy.append(name, current);
    button.append(copy);
    button.addEventListener("click", () => selectCard(card, button));
    fragment.append(button);
  }
  if (!cards.length && state.snapshot?.previewMode) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "根目录无法读取具体角色卡；进入 play 后，这里会显示可选择的角色卡。";
    fragment.append(empty);
  }
  elements.cardGrid.replaceChildren(fragment);
}

async function selectCard(card, button) {
  if (card.id === state.card.id) {
    showPanel("story");
    return;
  }
  if (state.switching) return;
  state.switching = true;
  button.disabled = true;
  elements.connectionStatus.textContent = `正在切换到 ${card.name}`;
  try {
    await request("/api/card-switch", { method: "POST", body: JSON.stringify({ cardId: card.id }) });
    showHandoff(`正在打开 ${card.name}`, "角色卡已经交给新的 Pi 会话。此页面不再接收操作，请使用最新打开的 Web RP 页面。");
  } catch (error) {
    if (!elements.handoffOverlay.hidden) return;
    state.switching = false;
    button.disabled = false;
    showError(error);
  }
}

function renderHistoryChoices(sessions) {
  state.sessions = sessions;
  elements.historyGroup.hidden = sessions.length === 0;
  elements.historyList.replaceChildren(buildHistoryChoices(sessions, true));
}

async function chooseChat() {
  state.switching = true;
  elements.chooseChatButton.disabled = true;
  elements.connectionStatus.textContent = "正在返回聊天记录选择";
  try {
    await request("/api/card-switch", {
      method: "POST",
      body: JSON.stringify({ cardId: state.card.id, forceNew: true }),
    });
    showHandoff("新的聊天选择页正在打开", "当前聊天已安全保留。此页面不再接收操作，请在最新打开的 Web RP 页面选择聊天记录或开场白。");
  } catch (error) {
    if (!elements.handoffOverlay.hidden) return;
    state.switching = false;
    elements.chooseChatButton.disabled = false;
    showError(error);
  }
}

async function sendMessage() {
  const content = elements.input.value.trim();
  if (!content || state.sending || state.snapshot?.busy || !state.snapshot?.openingId) return;
  state.sending = true;
  elements.sendButton.disabled = true;
  try {
    await request("/api/input", { method: "POST", body: JSON.stringify({ content }) });
    elements.input.value = "";
    applySnapshot(await request("/api/state"));
  } catch (error) {
    showError(error);
  } finally {
    state.sending = false;
    elements.sendButton.disabled = Boolean(state.snapshot?.busy);
  }
}

async function saveUserSettings(event) {
  event.preventDefault();
  const playerName = elements.playerName.value.trim();
  const description = elements.playerDescription.value.trim();
  const avatar = elements.playerAvatar.files[0];
  if (!playerName) return;
  const button = elements.userSettingsForm.querySelector("button[type='submit']");
  button.disabled = true;
  elements.userSettingsStatus.textContent = "保存中……";
  let profileSaved = false;
  try {
    state.playerNameDirty = false;
    const result = await request("/api/user-settings", {
      method: "POST",
      body: JSON.stringify({ playerName, description }),
    });
    applySnapshot(result);
    if (result.settings) {
      state.settings.common = result.settings;
      renderSavedProfiles();
      renderPlayerAvatarPreview();
      if (state.snapshot?.openingId) renderMessages(state.snapshot.messages);
    }
    profileSaved = true;
    if (avatar) {
      elements.userSettingsStatus.textContent = "角色设定已保存，正在上传头像……";
      const uploadResult = await uploadPlayerAvatar(playerName, avatar);
      state.settings.common = uploadResult.common;
      state.avatarVersion = Date.now();
      elements.playerAvatar.value = "";
      renderSavedProfiles();
      renderPlayerAvatarPreview();
      if (state.snapshot?.openingId) renderMessages(state.snapshot.messages);
    }
    elements.userSettingsStatus.textContent = state.snapshot?.previewMode
      ? (avatar ? "全局用户设置和头像已保存" : "全局用户设置已保存")
      : (avatar ? "角色设定和头像已保存到当前卡" : "角色设定已保存到当前卡并加入固定上下文");
  } catch (error) {
    state.playerNameDirty = true;
    elements.userSettingsStatus.textContent = profileSaved ? "角色设定已保存，但头像上传失败" : "保存失败";
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function applyFontSize(value) {
  const size = Math.min(24, Math.max(14, Number(value) || 16));
  document.documentElement.style.setProperty("--message-font-size", `${size}px`);
  elements.fontSize.value = String(size);
  elements.fontSizeValue.value = `${size} px`;
  elements.fontSizeValue.textContent = `${size} px`;
}

async function saveSystemSettings() {
  const fontSize = Number(elements.fontSize.value);
  elements.systemSettingsStatus.textContent = "保存中……";
  try {
    await request("/api/system-settings", {
      method: "POST",
      body: JSON.stringify({ fontSize }),
    });
    elements.systemSettingsStatus.textContent = state.snapshot?.previewMode ? "已保存为全局显示默认" : "已保存为当前卡显示覆盖";
  } catch (error) {
    elements.systemSettingsStatus.textContent = "保存失败";
    showError(error);
  }
}
// ── 阶段 1：事件装配 ──────────────────────────────────────────────────────────────
// 只做 DOM 事件绑定，不加载数据；它对元素是否存在敏感，因此单列为一个阶段。
function wirePanelEventHandlers() {
  for (const button of elements.tabButtons) {
    button.addEventListener("click", () => showPanel(button.dataset.panel));
    button.addEventListener("keydown", event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const offset = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
      const index = elements.tabButtons.indexOf(button);
      elements.tabButtons[(index + offset + elements.tabButtons.length) % elements.tabButtons.length].click();
    });
  }

  elements.composer.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage();
  });

  elements.input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  elements.playerName.addEventListener("input", () => {
    state.playerNameDirty = true;
    if (!state.snapshot?.openingId && state.card?.openings) renderOpeningChoices();
    elements.userSettingsStatus.textContent = "";
    renderPlayerAvatarPreview();
  });
  elements.playerDescription.addEventListener("input", () => {
    state.playerNameDirty = true;
    elements.userSettingsStatus.textContent = "";
  });
  elements.savedProfile.addEventListener("change", () => {
    const profile = state.settings?.common?.user?.savedProfiles?.find(item => item.name === elements.savedProfile.value);
    if (!profile) return;
    elements.playerName.value = profile.name;
    elements.playerDescription.value = profile.description || "";
    elements.playerAvatar.value = "";
    renderPlayerAvatarPreview();
    state.playerNameDirty = true;
    elements.userSettingsStatus.textContent = "选择后请保存以应用到当前会话";
  });
  elements.deleteSavedProfile.addEventListener("click", deleteSavedProfile);
  elements.cardSearch.addEventListener("input", renderCards);
  elements.userSettingsForm.addEventListener("submit", saveUserSettings);
  elements.playerAvatar.addEventListener("change", () => {
    const file = elements.playerAvatar.files[0];
    if (!file) return renderPlayerAvatarPreview();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      elements.playerAvatar.value = "";
      showError(new Error("请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。"));
    }
  });
  elements.fontSize.addEventListener("input", () => applyFontSize(elements.fontSize.value));
  elements.fontSize.addEventListener("change", saveSystemSettings);
  elements.moduleSettingsForm.addEventListener("submit", saveModuleDisplaySettings);
  elements.resetModuleSettings.addEventListener("click", resetModuleDisplaySettings);
  elements.chooseChatButton.addEventListener("click", chooseChat);
  elements.workflowSelect.addEventListener("change", renderWorkflow);
  elements.activateWorkflow.addEventListener("click", activateSelectedWorkflow);
  elements.refreshWorkflows.addEventListener("click", () => refreshWorkflowData(undefined, true).catch(showError));
  elements.showActiveWorkflow.addEventListener("click", () => {
    const run = currentForegroundRun();
    if (!run) { elements.workflowStatus.textContent = "当前没有正在运行的前台工作流。"; return; }
    const reference = runWorkflowReference(run);
    if (!state.workflows.some(item => workflowReference(item) === reference)) { elements.workflowStatus.textContent = "当前前台工作流仍在运行，但其定义已不在本卡工作流列表中。"; return; }
    elements.workflowSelect.value = reference;
    renderWorkflow();
    elements.workflowStatus.textContent = `已定位到正在运行的前台工作流：${selectedWorkflow()?.title || run.workflowId}`;
  });
  elements.refreshTokens.addEventListener("click", () => refreshTokenUsage(true).catch(showError));
  elements.imageRunConfirm.addEventListener("click", event => {
    event.preventDefault();
    startImageRun(true).catch(showError);
  });
  elements.imageViewerDialog.addEventListener("close", () => { elements.imageViewerImage.removeAttribute("src"); });
  elements.imageViewerPrevious.addEventListener("click", () => { if (state.imageViewerIndex > 0) { state.imageViewerIndex -= 1; renderImageViewer(); } });
  elements.imageViewerNext.addEventListener("click", () => { if (state.imageViewerIndex < state.imageViewerItems.length - 1) { state.imageViewerIndex += 1; renderImageViewer(); } });
  elements.imageViewerZoom.addEventListener("click", () => { state.imageViewerZoomed = !state.imageViewerZoomed; renderImageViewer(); });
  elements.imageRegenerateConfirm.addEventListener("click", async event => {
    event.preventDefault();
    try {
      await request(`/api/image-generation/renders/${encodeURIComponent(state.imagePromptRenderId)}/regenerate`, { method: "POST", body: JSON.stringify({ operationId: crypto.randomUUID(), contentPrompt: elements.imageContentPrompt.value.trim(), scope: elements.imageRegenerateScope.value }) });
      elements.imagePromptDialog.close();
    } catch (error) { showError(error); }
  });
  elements.comfyConnectionSelect.addEventListener("change", loadComfyConnectionForm);
  elements.comfyConnectionForm.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await request("/api/image-generation/connections", { method: "POST", body: JSON.stringify({ id: elements.comfyConnectionId.value.trim(), title: elements.comfyConnectionTitle.value.trim(), baseUrl: elements.comfyConnectionUrl.value.trim(), token: elements.comfyConnectionToken.value, outputDirectoryPath: elements.comfyOutputPath.value.trim(), allowInsecureRemote: elements.comfyInsecureRemote.checked }) });
      state.imageGeneration = await request("/api/image-generation"); renderComfySettings(); elements.comfyConnectionStatus.textContent = "连接配置已保存。";
    } catch (error) { showError(error); }
  });
  elements.comfyTestConnection.addEventListener("click", async () => {
    try { const result = await request(`/api/image-generation/connections/${encodeURIComponent(elements.comfyConnectionSelect.value)}/test`, { method: "POST" }); elements.comfyConnectionStatus.textContent = `连接正常 · ${result.elapsedMs} ms`; }
    catch (error) { elements.comfyConnectionStatus.textContent = "连接失败"; showError(error); }
  });
}

async function refreshState() {
  if (state.switching) return;
  try {
    const [snapshot, modules] = await Promise.all([request("/api/state"), request("/api/modules")]);
    applySnapshot(snapshot);
    renderFeatureModules(modules);
    if (state.activePanel === "workflows" && !workflowPanelHasFocus()) await refreshWorkflowData();
    if (state.activePanel === "tokens") await refreshTokenUsage();
  } catch (error) {
    if (!elements.handoffOverlay.hidden) return;
    elements.connectionStatus.textContent = "与 Pi 会话连接中断";
  }
}

async function initialize() {
  // 阶段 2：加载页面所需数据（卡片、快照、设置、模块、模型、工作流）。
  state.card = await request("/api/card");
  elements.cardTitle.textContent = state.card.name;
  document.title = `${state.card.name} · Pi RP`;
  renderOpeningChoices();
  const snapshot = await request("/api/state");
  applySnapshot(snapshot);
  if (snapshot.selectorUrl) {
    elements.returnToSelector.href = snapshot.selectorUrl;
    elements.returnToSelector.hidden = false;
  }
  if (snapshot.isolatedRuntime) {
    document.querySelector("#tab-cards").hidden = true;
  }
  const settings = await request("/api/settings");
  state.settings = settings;
  applyFontSize(settings.common?.system?.fontSize ?? 16);
  if (!state.playerNameDirty) elements.playerName.value = settings.common?.user?.playerName || snapshot.playerName || "玩家";
  elements.playerDescription.value = settings.common?.user?.description || "";
  renderSavedProfiles();
  renderPlayerAvatarPreview();
  renderFeatureModules(await request("/api/modules"));
  try { state.imageGeneration = await request("/api/image-generation"); renderComfySettings(); } catch {}
  const modelPayload = await request("/api/models");
  state.models = [modelPayload.current, ...(modelPayload.profiles || [])];
  state.workflowPolicy = await request("/api/workflow-policy");
  state.agents = (await request("/api/agents")).agents || [];
  await refreshWorkflowData(undefined, true);
  if (snapshot.openingId) renderMessages(snapshot.messages);
  state.cards = await request("/api/cards");
  renderCards();
  try {
    renderHistoryChoices(await request("/api/sessions"));
  } catch (error) {
    elements.historyGroup.hidden = false;
    elements.historyList.textContent = "聊天记录读取失败。";
    showError(error);
  }
  const requestedPanel = new URLSearchParams(window.location.search).get("panel");
  showPanel(elements.tabButtons.some(button => button.dataset.panel === requestedPanel) ? requestedPanel : "story");
  // 轮询只能有一份。`initialize()` 若被重复执行（同一页面被二次装配、页面从 bfcache 恢复等），
  // 无条件 `setInterval` 会让轮询叠加成两条、三条……请求量成倍增长。
  // 方案 §11 第 8 条要求"消除对已删除表单元素的依赖；轮询更新不能覆盖正在编辑的草稿或重复绑定监听器"，
  // 因此这里显式只注册一次；已注册时把句柄记下来，便于诊断。
  if (state.refreshTimer === undefined) {
    state.refreshTimer = window.setInterval(refreshState, 600);
  }
}

// 阶段 1 必须在启动前完成：绑定先于任何用户交互与数据加载。
if (initializePageContext()) {
  wirePanelEventHandlers();
  initialize().catch(showError);
}
