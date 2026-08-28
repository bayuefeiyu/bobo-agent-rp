import { renderMarkdown } from "./markdown.js?v=4";
import { buildModuleJsonTree } from "./module-json.js?v=2";

const state = {
  card: null,
  snapshot: null,
  sessions: [],
  cards: [],
  settings: null,
  sending: false,
  switching: false,
  playerNameDirty: false,
  avatarVersion: Date.now(),
  activePanel: "story",
  featureModules: [],
  featureModulePayload: null,
  featureModuleSignature: "",
  expandedFeatureModules: new Set(),
  moduleDisplayDraft: null,
};

const elements = {
  appLayout: document.querySelector(".app-layout"),
  cardTitle: document.querySelector("#card-title"),
  connectionStatus: document.querySelector("#connection-status"),
  openingView: document.querySelector("#opening-view"),
  openingList: document.querySelector("#opening-list"),
  historyGroup: document.querySelector("#history-group"),
  historyList: document.querySelector("#history-list"),
  chooseChatButton: document.querySelector("#choose-chat-button"),
  chatView: document.querySelector("#chat-view"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  errorBanner: document.querySelector("#error-banner"),
  tabButtons: [...document.querySelectorAll(".tab-button")],
  panels: [...document.querySelectorAll(".panel")],
  userSettingsForm: document.querySelector("#user-settings-form"),
  playerName: document.querySelector("#player-name"),
  playerDescription: document.querySelector("#player-description"),
  playerAvatar: document.querySelector("#player-avatar"),
  playerAvatarImage: document.querySelector("#player-avatar-image"),
  playerAvatarFallback: document.querySelector("#player-avatar-fallback"),
  savedProfile: document.querySelector("#saved-profile"),
  userSettingsStatus: document.querySelector("#user-settings-status"),
  fontSize: document.querySelector("#font-size"),
  fontSizeValue: document.querySelector("#font-size-value"),
  systemSettingsStatus: document.querySelector("#system-settings-status"),
  moduleSettingsForm: document.querySelector("#module-display-settings-form"),
  moduleSettingsList: document.querySelector("#module-settings-list"),
  moduleSettingsStatus: document.querySelector("#module-settings-status"),
  resetModuleSettings: document.querySelector("#reset-module-settings"),
  saveModuleSettings: document.querySelector("#save-module-settings"),
  cardSearch: document.querySelector("#card-search"),
  cardGrid: document.querySelector("#card-grid"),
  handoffOverlay: document.querySelector("#handoff-overlay"),
  handoffTitle: document.querySelector("#handoff-title"),
  handoffDescription: document.querySelector("#handoff-description"),
  moduleList: document.querySelector("#card-module-list"),
};

function showHandoff(title, description) {
  state.switching = true;
  elements.appLayout.inert = true;
  elements.handoffTitle.textContent = title;
  elements.handoffDescription.textContent = description;
  elements.handoffOverlay.hidden = false;
  elements.handoffOverlay.focus();
  document.title = "页面已交接 · Pi RP";
}

function isInactiveBridgeMessage(message) {
  return /bridge is not active|closed Pi session/i.test(message || "");
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败，请稍后重试。");
    if (response.status === 409 && isInactiveBridgeMessage(error.message)) {
      showHandoff("这个页面已经失效", "它属于已经结束的 Pi 会话。请关闭此页，并使用最新打开的 Web RP 页面。");
    }
    throw error;
  }
  return payload;
}

function showError(error) {
  elements.errorBanner.textContent = error.message || String(error);
  elements.errorBanner.hidden = false;
  window.setTimeout(() => { elements.errorBanner.hidden = true; }, 5000);
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
}

function toggleCardModule(button) {
  const content = document.getElementById(button.getAttribute("aria-controls"));
  if (!content) return;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  content.hidden = !expanded;
  const stateLabel = button.querySelector(".module-toggle-state");
  if (stateLabel) stateLabel.textContent = expanded ? "收起" : "展开";
  const moduleId = button.closest("[data-module-id]")?.dataset.moduleId;
  if (moduleId) {
    if (expanded) state.expandedFeatureModules.add(moduleId);
    else state.expandedFeatureModules.delete(moduleId);
  }
}

function valueAtPath(value, path) {
  if (!path) return value;
  return String(path).split(".").reduce((current, key) => current == null ? undefined : current[key], value);
}

function appendModuleEmpty(container, message) {
  const empty = document.createElement("p");
  empty.className = "module-empty";
  empty.textContent = message || "暂无内容。";
  container.append(empty);
}

function appendModuleValue(container, value, format = "text") {
  if (format === "markdown") {
    const markdown = document.createElement("div");
    markdown.className = "module-markdown";
    renderMarkdown(markdown, value == null ? "" : String(value));
    container.append(markdown);
    return;
  }
  const text = document.createElement("p");
  text.className = "module-text";
  text.textContent = value == null ? "" : String(value);
  container.append(text);
}

function appendModuleJsonNode(container, node, root = false) {
  if (node.kind === "value") {
    const value = document.createElement("span");
    value.className = `module-json-value module-json-value-${node.valueType}`;
    value.textContent = node.display;
    container.append(value);
    return;
  }

  const tree = document.createElement("div");
  tree.className = `module-json-tree module-json-tree-${node.kind}${root ? " module-json-tree-root" : ""}`;
  if (!node.entries.length) {
    const empty = document.createElement("span");
    empty.className = "module-json-nested-empty";
    empty.textContent = node.emptyLabel;
    tree.append(empty);
  }
  for (const entry of node.entries) {
    if (entry.node.kind === "value") {
      const pair = document.createElement("div");
      pair.className = "module-json-pair";
      const key = document.createElement("span");
      key.className = "module-json-key";
      key.textContent = entry.key;
      pair.append(key);
      appendModuleJsonNode(pair, entry.node);
      tree.append(pair);
      continue;
    }

    const group = document.createElement("section");
    group.className = `module-json-group module-json-group-${entry.node.kind}`;
    const heading = document.createElement("div");
    heading.className = "module-json-group-heading";
    const key = document.createElement("span");
    key.className = "module-json-group-key";
    key.textContent = entry.key;
    const count = document.createElement("span");
    count.className = "module-json-count";
    count.textContent = `${entry.node.count} 项`;
    heading.append(key, count);
    group.append(heading);
    appendModuleJsonNode(group, entry.node);
    tree.append(group);
  }
  container.append(tree);
}

function createModuleRegion(region, data) {
  const section = document.createElement("section");
  section.className = `module-region module-region-${region.type || "text"}`;
  if (region.title) {
    const title = document.createElement("h4");
    title.textContent = region.title;
    section.append(title);
  }
  const value = valueAtPath(data, region.path);

  if (region.type === "json") {
    if (value === undefined) {
      appendModuleEmpty(section, region.empty);
      return section;
    }
    const tree = buildModuleJsonTree(value);
    if (tree.kind !== "value" && tree.entries.length === 0) {
      appendModuleEmpty(section, region.empty || tree.emptyLabel);
      return section;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "module-json-fields";
    appendModuleJsonNode(wrapper, tree, true);
    section.append(wrapper);
    return section;
  }

  if (region.type === "key-value") {
    const fields = Array.isArray(region.fields) ? region.fields : [];
    const list = document.createElement("dl");
    list.className = "module-key-values";
    for (const field of fields) {
      const fieldValue = valueAtPath(value, field.path);
      if ((fieldValue == null || fieldValue === "") && field.hideWhenEmpty) continue;
      const term = document.createElement("dt");
      term.textContent = field.label || field.path || "字段";
      const description = document.createElement("dd");
      if (field.format === "markdown") renderMarkdown(description, fieldValue == null ? "" : String(fieldValue));
      else description.textContent = fieldValue == null || fieldValue === "" ? (field.empty || "—") : String(fieldValue);
      list.append(term, description);
    }
    if (list.children.length) section.append(list);
    else appendModuleEmpty(section, region.empty);
    return section;
  }

  if (region.type === "list") {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) {
      appendModuleEmpty(section, region.empty);
      return section;
    }
    const list = document.createElement("div");
    list.className = "module-record-list";
    for (const item of items) {
      const article = document.createElement("article");
      article.className = "module-record";
      const titleValue = valueAtPath(item, region.item?.titlePath);
      if (titleValue) {
        const title = document.createElement("h5");
        title.textContent = String(titleValue);
        article.append(title);
      }
      const bodyValue = valueAtPath(item, region.item?.bodyPath);
      if (bodyValue != null && bodyValue !== "") appendModuleValue(article, bodyValue, region.item?.bodyFormat || "text");
      const metadata = Array.isArray(region.item?.meta) ? region.item.meta : [];
      if (metadata.length) {
        const meta = document.createElement("dl");
        meta.className = "module-record-meta";
        for (const field of metadata) {
          const fieldValue = valueAtPath(item, field.path);
          if (fieldValue == null || fieldValue === "") continue;
          const term = document.createElement("dt");
          term.textContent = field.label || field.path;
          const description = document.createElement("dd");
          description.textContent = String(fieldValue);
          meta.append(term, description);
        }
        if (meta.children.length) article.append(meta);
      }
      list.append(article);
    }
    section.append(list);
    return section;
  }

  if (region.type === "table") {
    const rows = Array.isArray(value) ? value : [];
    const columns = Array.isArray(region.columns) ? region.columns : [];
    if (!rows.length || !columns.length) {
      appendModuleEmpty(section, region.empty);
      return section;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "module-table-wrap";
    const table = document.createElement("table");
    table.className = "module-table";
    const headRow = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column.label || column.path;
      headRow.append(cell);
    }
    const head = document.createElement("thead");
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const rowElement = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        const cellValue = valueAtPath(row, column.path);
        cell.textContent = cellValue == null ? "" : String(cellValue);
        rowElement.append(cell);
      }
      body.append(rowElement);
    }
    table.append(head, body);
    wrapper.append(table);
    section.append(wrapper);
    return section;
  }

  if (value == null || value === "") appendModuleEmpty(section, region.empty);
  else appendModuleValue(section, value, region.type === "markdown" ? "markdown" : "text");
  return section;
}

function normalizeModuleDisplaySettings(value, modules = state.featureModules) {
  const defaults = [...modules].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0) || String(left.id).localeCompare(String(right.id)));
  const validIds = new Set(defaults.map(module => module.id));
  const order = [];
  if (Array.isArray(value?.order)) {
    for (const id of value.order) {
      if (validIds.has(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const module of defaults) {
    if (!order.includes(module.id)) order.push(module.id);
  }
  const hidden = new Set(Array.isArray(value?.hidden) ? value.hidden.filter(id => validIds.has(id)) : []);
  return { order, hidden };
}

function savedModuleDisplaySettings() {
  return state.settings?.card?.settings?.featureModules || {};
}

function orderedVisibleModules(modules) {
  const settings = normalizeModuleDisplaySettings(savedModuleDisplaySettings(), modules);
  const byId = new Map(modules.map(module => [module.id, module]));
  return settings.order.filter(id => !settings.hidden.has(id)).map(id => byId.get(id)).filter(Boolean);
}

function renderFeatureModules(payload) {
  const availableModules = Array.isArray(payload?.modules)
    ? [...payload.modules].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0) || String(left.id).localeCompare(String(right.id)))
    : [];
  state.featureModulePayload = payload;
  state.featureModules = availableModules;
  const signature = JSON.stringify({ payload, display: savedModuleDisplaySettings() });
  if (signature === state.featureModuleSignature) return;
  state.featureModuleSignature = signature;
  const modules = orderedVisibleModules(availableModules);
  const fragment = document.createDocumentFragment();
  if (!modules.length) {
    appendModuleEmpty(fragment, availableModules.length
      ? "功能区模块已在系统设置中全部隐藏。"
      : "当前角色卡没有配置功能区模块。");
    elements.moduleList.replaceChildren(fragment);
    renderModuleSettings();
    return;
  }
  for (const module of modules) {
    const section = document.createElement("section");
    section.className = "card-module";
    section.dataset.moduleId = module.id;
    const heading = document.createElement("h3");
    heading.className = "module-heading";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "module-toggle";
    const contentId = `module-${module.id}`;
    const expanded = state.expandedFeatureModules.has(module.id);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", contentId);
    const label = document.createElement("span");
    label.textContent = module.title;
    const stateLabel = document.createElement("span");
    stateLabel.className = "module-toggle-state";
    stateLabel.setAttribute("aria-hidden", "true");
    stateLabel.textContent = expanded ? "收起" : "展开";
    toggle.append(label, stateLabel);
    toggle.addEventListener("click", () => toggleCardModule(toggle));
    heading.append(toggle);
    const content = document.createElement("div");
    content.id = contentId;
    content.className = "module-content";
    content.hidden = !expanded;
    if (module.description) {
      const description = document.createElement("p");
      description.className = "module-description";
      description.textContent = module.description;
      content.append(description);
    }
    if (module.error) {
      appendModuleEmpty(content, module.error);
    } else if (!module.available) {
      appendModuleEmpty(content, "选择开场白或聊天记录后，此模块会建立当前聊天专属的数据文件。");
    } else {
      const regions = Array.isArray(module.view?.regions) ? module.view.regions : [];
      if (!regions.length) appendModuleEmpty(content, "此模块没有可显示区域。");
      for (const region of regions) content.append(createModuleRegion(region, module.data));
    }
    section.append(heading, content);
    fragment.append(section);
  }
  elements.moduleList.replaceChildren(fragment);
  renderModuleSettings();
}

function syncModuleDisplayDraft() {
  const source = state.moduleDisplayDraft
    ? { order: state.moduleDisplayDraft.order, hidden: [...state.moduleDisplayDraft.hidden] }
    : savedModuleDisplaySettings();
  state.moduleDisplayDraft = normalizeModuleDisplaySettings(source);
}

function markModuleDisplayDirty() {
  elements.moduleSettingsStatus.textContent = "尚未保存；这些调整只影响前端功能区。";
}

function moveModuleDisplay(moduleId, offset) {
  syncModuleDisplayDraft();
  const index = state.moduleDisplayDraft.order.indexOf(moduleId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= state.moduleDisplayDraft.order.length) return;
  [state.moduleDisplayDraft.order[index], state.moduleDisplayDraft.order[target]] = [
    state.moduleDisplayDraft.order[target],
    state.moduleDisplayDraft.order[index],
  ];
  markModuleDisplayDirty();
  renderModuleSettings();
}

function renderModuleSettings() {
  syncModuleDisplayDraft();
  const modulesById = new Map(state.featureModules.map(module => [module.id, module]));
  const fragment = document.createDocumentFragment();
  if (!state.moduleDisplayDraft.order.length) {
    const empty = document.createElement("p");
    empty.className = "module-settings-empty";
    empty.textContent = "当前角色卡没有可在前端显示的模块。后台模块不会出现在这里。";
    fragment.append(empty);
  }
  state.moduleDisplayDraft.order.forEach((moduleId, index) => {
    const module = modulesById.get(moduleId);
    if (!module) return;
    const row = document.createElement("div");
    row.className = "module-setting-row";
    row.dataset.moduleId = moduleId;

    const visibility = document.createElement("label");
    visibility.className = "module-visibility";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !state.moduleDisplayDraft.hidden.has(moduleId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.moduleDisplayDraft.hidden.delete(moduleId);
      else state.moduleDisplayDraft.hidden.add(moduleId);
      markModuleDisplayDirty();
    });
    const copy = document.createElement("span");
    copy.className = "module-setting-copy";
    const title = document.createElement("strong");
    title.textContent = module.title;
    const description = document.createElement("small");
    description.textContent = module.description || module.id;
    copy.append(title, description);
    visibility.append(checkbox, copy);

    const actions = document.createElement("div");
    actions.className = "module-order-actions";
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "上移";
    up.disabled = index === 0;
    up.setAttribute("aria-label", `上移 ${module.title}`);
    up.addEventListener("click", () => moveModuleDisplay(moduleId, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "下移";
    down.disabled = index === state.moduleDisplayDraft.order.length - 1;
    down.setAttribute("aria-label", `下移 ${module.title}`);
    down.addEventListener("click", () => moveModuleDisplay(moduleId, 1));
    actions.append(up, down);
    row.append(visibility, actions);
    fragment.append(row);
  });
  elements.moduleSettingsList.replaceChildren(fragment);
  const disabled = state.moduleDisplayDraft.order.length === 0;
  elements.saveModuleSettings.disabled = disabled;
  elements.resetModuleSettings.disabled = disabled;
}

function profileForName(playerName) {
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
  const started = Boolean(snapshot.openingId);
  elements.openingView.hidden = started;
  elements.chatView.hidden = !started;
  elements.chooseChatButton.hidden = !started;
  elements.chooseChatButton.disabled = snapshot.busy || state.switching;
  elements.connectionStatus.textContent = snapshot.busy ? "Pi 正在回复" : "已连接当前 Pi 会话";
  elements.input.disabled = snapshot.busy;
  elements.sendButton.disabled = snapshot.busy || state.sending;
  elements.sendButton.textContent = snapshot.busy ? "等待 Pi" : "发送";
  if (!state.playerNameDirty) elements.playerName.value = snapshot.playerName || "玩家";

  const messagesChanged = snapshot.messages.length !== previousCount || snapshot.messages.some((message, index) => {
    const previous = previousMessages[index];
    return !previous || previous.sequence !== message.sequence || previous.content !== message.content || previous.editedAt !== message.editedAt;
  });
  const playerNameChanged = snapshot.playerName !== previousPlayerName;
  if (started && (messagesChanged || playerNameChanged)) renderMessages(snapshot.messages, messagesChanged);
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
  for (const opening of state.card.openings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "opening-card";
    const title = document.createElement("h3");
    title.textContent = opening.title;
    const preview = document.createElement("p");
    preview.textContent = opening.content;
    button.append(title, preview);
    button.addEventListener("click", () => selectOpening(opening.id, button));
    fragment.append(button);
  }
  elements.openingList.replaceChildren(fragment);
}

function formatSessionTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
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
    elements.userSettingsStatus.textContent = avatar ? "角色设定和头像已保存" : "角色设定已保存并加入固定上下文";
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
    elements.systemSettingsStatus.textContent = "已保存到公共设置文件";
  } catch (error) {
    elements.systemSettingsStatus.textContent = "保存失败";
    showError(error);
  }
}

async function saveModuleDisplaySettings(event) {
  event.preventDefault();
  syncModuleDisplayDraft();
  elements.saveModuleSettings.disabled = true;
  elements.moduleSettingsStatus.textContent = "保存中……";
  try {
    const result = await request("/api/module-display-settings", {
      method: "POST",
      body: JSON.stringify({
        order: state.moduleDisplayDraft.order,
        hidden: [...state.moduleDisplayDraft.hidden],
      }),
    });
    state.settings.card = result.card;
    state.moduleDisplayDraft = normalizeModuleDisplaySettings(result.card?.settings?.featureModules);
    state.featureModuleSignature = "";
    renderFeatureModules(state.featureModulePayload || { modules: state.featureModules });
    elements.moduleSettingsStatus.textContent = "已保存到当前角色卡设置；Agent 上下文未改变。";
  } catch (error) {
    elements.moduleSettingsStatus.textContent = "保存失败";
    showError(error);
  } finally {
    elements.saveModuleSettings.disabled = state.featureModules.length === 0;
  }
}

function resetModuleDisplaySettings() {
  state.moduleDisplayDraft = normalizeModuleDisplaySettings({ order: [], hidden: [] });
  markModuleDisplayDirty();
  elements.moduleSettingsStatus.textContent = "已恢复卡片默认显示，保存后生效。";
  renderModuleSettings();
}

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

async function refreshState() {
  if (state.switching) return;
  try {
    const [snapshot, modules] = await Promise.all([request("/api/state"), request("/api/modules")]);
    applySnapshot(snapshot);
    renderFeatureModules(modules);
  } catch (error) {
    if (!elements.handoffOverlay.hidden) return;
    elements.connectionStatus.textContent = "与 Pi 会话连接中断";
  }
}

async function initialize() {
  state.card = await request("/api/card");
  elements.cardTitle.textContent = state.card.name;
  document.title = `${state.card.name} · Pi RP`;
  renderOpeningChoices();
  const snapshot = await request("/api/state");
  applySnapshot(snapshot);
  const settings = await request("/api/settings");
  state.settings = settings;
  applyFontSize(settings.common?.system?.fontSize ?? 16);
  if (!state.playerNameDirty) elements.playerName.value = settings.common?.user?.playerName || snapshot.playerName || "玩家";
  elements.playerDescription.value = settings.common?.user?.description || "";
  renderSavedProfiles();
  renderPlayerAvatarPreview();
  renderFeatureModules(await request("/api/modules"));
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
  showPanel("story");
  window.setInterval(refreshState, 600);
}

initialize().catch(showError);
