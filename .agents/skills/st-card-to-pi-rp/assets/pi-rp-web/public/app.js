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
  models: [],
  agents: [],
  workflows: [],
  workflowRuns: [],
  activeWorkflowId: "standard-rp",
  workflowPolicy: null,
  workflowRenderSignature: "",
  tokenRenderSignature: "",
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
  deleteSavedProfile: document.querySelector("#delete-saved-profile"),
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
  modelProfileSelect: document.querySelector("#model-profile-select"),
  modelForm: document.querySelector("#model-profile-form"),
  modelPreset: document.querySelector("#model-preset"),
  modelId: document.querySelector("#model-id"),
  modelName: document.querySelector("#model-name"),
  modelBaseUrl: document.querySelector("#model-base-url"),
  modelApiKey: document.querySelector("#model-api-key"),
  modelApiFormat: document.querySelector("#model-api-format"),
  discoveredModels: document.querySelector("#discovered-models"),
  modelNameManual: document.querySelector("#model-name-manual"),
  modelContextWindow: document.querySelector("#model-context-window"),
  modelMaxOutput: document.querySelector("#model-max-output"),
  modelThinking: document.querySelector("#model-thinking"),
  modelMaxConcurrency: document.querySelector("#model-max-concurrency"),
  modelHeadPrompt: document.querySelector("#model-head-prompt"),
  modelTailPrompt: document.querySelector("#model-tail-prompt"),
  modelStatus: document.querySelector("#model-profile-status"),
  newModel: document.querySelector("#new-model-profile"),
  deleteModel: document.querySelector("#delete-model-profile"),
  testModel: document.querySelector("#test-model-profile"),
  discoverModels: document.querySelector("#discover-models"),
  agentSelect: document.querySelector("#agent-select"),
  agentForm: document.querySelector("#agent-form"),
  agentName: document.querySelector("#agent-name"),
  agentDescription: document.querySelector("#agent-description"),
  agentDefaultModel: document.querySelector("#agent-default-model"),
  agentTools: document.querySelector("#agent-tools"),
  agentContextPermissions: document.querySelector("#agent-context-permissions"),
  agentOutputMode: document.querySelector("#agent-output-mode"),
  agentPrompt: document.querySelector("#agent-prompt"),
  agentLayerBadge: document.querySelector("#agent-layer-badge"),
  agentStatus: document.querySelector("#agent-status"),
  restoreAgent: document.querySelector("#restore-agent"),
  saveAgentGlobal: document.querySelector("#save-agent-global"),
  workflowSelect: document.querySelector("#workflow-select"),
  activateWorkflow: document.querySelector("#activate-workflow"),
  refreshWorkflows: document.querySelector("#refresh-workflows"),
  showActiveWorkflow: document.querySelector("#show-active-workflow"),
  workflowSummary: document.querySelector("#workflow-summary"),
  workflowNodeList: document.querySelector("#workflow-node-list"),
  workflowRunList: document.querySelector("#workflow-run-list"),
  workflowStatus: document.querySelector("#workflow-status"),
  workflowPolicyForm: document.querySelector("#workflow-policy-form"),
  workflowMaxConcurrency: document.querySelector("#workflow-max-concurrency"),
  workflowSilentFallback: document.querySelector("#workflow-silent-fallback"),
  workflowFallbackModel: document.querySelector("#workflow-fallback-model"),
  refreshTokens: document.querySelector("#refresh-tokens"),
  tokenTotal: document.querySelector("#token-total"),
  tokenInput: document.querySelector("#token-input"),
  tokenOutput: document.querySelector("#token-output"),
  tokenCacheRead: document.querySelector("#token-cache-read"),
  tokenCacheWrite: document.querySelector("#token-cache-write"),
  tokenWorkflowList: document.querySelector("#token-workflow-list"),
  tokenNodeList: document.querySelector("#token-node-list"),
  tokenStatus: document.querySelector("#token-status"),
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

async function openFeatureModuleDocument(module, target, button) {
  const originalText = button.textContent;
  button.disabled = true;
  try {
    await request(`/api/modules/${encodeURIComponent(module.id)}/open`, {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    button.textContent = "已打开";
    window.setTimeout(() => { button.textContent = originalText; }, 1400);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = target === "data" && !module.available;
  }
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
    const actions = document.createElement("span");
    actions.className = "module-file-actions";
    const openData = document.createElement("button");
    openData.type = "button";
    openData.className = "module-file-button";
    openData.textContent = "查看数据";
    openData.title = module.available ? "使用系统默认编辑器打开当前模块的只读汇总文档" : "选择开场白或聊天记录后才能查看会话数据";
    openData.disabled = !module.available;
    openData.addEventListener("click", () => openFeatureModuleDocument(module, "data", openData));
    const openDefinition = document.createElement("button");
    openDefinition.type = "button";
    openDefinition.className = "module-file-button";
    openDefinition.textContent = "修改模块";
    openDefinition.title = "使用系统默认编辑器打开模块定义文件";
    openDefinition.addEventListener("click", () => openFeatureModuleDocument(module, "definition", openDefinition));
    actions.append(openData, openDefinition);
    heading.append(toggle, actions);
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

const modelPresets = {
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai-completions" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
  dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", api: "openai-completions" },
  custom: { baseUrl: "", api: "openai-completions" },
};

function modelOptions(selected = "pi:current") {
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

function renderModelSelectors() {
  const current = elements.modelProfileSelect.value;
  elements.modelProfileSelect.replaceChildren(...state.models.filter(item => !item.virtual).map(profile => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = `${profile.name} · ${profile.id}`; return option;
  }));
  if (current && state.models.some(item => item.id === current)) elements.modelProfileSelect.value = current;
  elements.agentDefaultModel.replaceChildren(...state.models.map(profile => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; return option;
  }));
  const fallback = state.workflowPolicy?.modelFailure?.defaultFallbackModelId || "";
  elements.workflowFallbackModel.replaceChildren(new Option("不设置", ""), ...state.models.map(profile => new Option(profile.name, profile.id)));
  elements.workflowFallbackModel.value = fallback;
}

function clearModelForm() {
  elements.modelForm.reset();
  elements.modelPreset.value = "custom";
  elements.modelContextWindow.value = "128000";
  elements.modelMaxOutput.value = "4096";
  elements.modelMaxConcurrency.value = "10";
  elements.modelThinking.value = "off";
  elements.modelId.readOnly = false;
  elements.modelApiKey.placeholder = "输入 API Key";
  elements.modelStatus.textContent = "正在创建新的模型配置。";
}

function loadModelForm() {
  const profile = state.models.find(item => item.id === elements.modelProfileSelect.value && !item.virtual);
  if (!profile) return clearModelForm();
  elements.modelId.value = profile.id;
  elements.modelId.readOnly = true;
  elements.modelName.value = profile.name;
  elements.modelPreset.value = modelPresets[profile.provider] ? profile.provider : "custom";
  elements.modelBaseUrl.value = profile.baseUrl || "";
  elements.modelApiKey.value = "";
  elements.modelApiKey.placeholder = profile.hasApiKey ? "已保存；留空保持不变" : "输入 API Key";
  elements.modelApiFormat.value = profile.api || "openai-completions";
  elements.modelNameManual.value = profile.model;
  elements.modelContextWindow.value = profile.contextWindow;
  elements.modelMaxOutput.value = profile.maxOutputTokens;
  elements.modelThinking.value = profile.thinking || "off";
  elements.modelMaxConcurrency.value = profile.maxConcurrency || 10;
  elements.modelHeadPrompt.value = profile.headPrompt || "";
  elements.modelTailPrompt.value = profile.tailPrompt || "";
  elements.modelStatus.textContent = profile.hasApiKey ? "API Key 已保存在项目外的系统缓存目录中。" : "此配置没有保存 API Key。";
}

function modelFormValue() {
  return {
    schemaVersion: 1,
    id: elements.modelId.value.trim(),
    name: elements.modelName.value.trim(),
    provider: elements.modelPreset.value === "custom" ? "openai-compatible" : elements.modelPreset.value,
    baseUrl: elements.modelBaseUrl.value.trim(),
    apiKey: elements.modelApiKey.value.trim(),
    api: elements.modelApiFormat.value,
    model: elements.modelNameManual.value.trim() || elements.discoveredModels.value,
    contextWindow: Number(elements.modelContextWindow.value),
    maxOutputTokens: Number(elements.modelMaxOutput.value),
    thinking: elements.modelThinking.value,
    maxConcurrency: Number(elements.modelMaxConcurrency.value),
    headPrompt: elements.modelHeadPrompt.value.trim(),
    tailPrompt: elements.modelTailPrompt.value.trim(),
  };
}

async function refreshModels(selectId) {
  const payload = await request("/api/models");
  state.models = [payload.current, ...(payload.profiles || [])];
  renderModelSelectors();
  if (selectId) elements.modelProfileSelect.value = selectId;
  loadModelForm();
  renderAgents();
  renderWorkflow();
}

async function saveModelProfile(event) {
  event.preventDefault();
  elements.modelStatus.textContent = "保存并注册模型中……";
  try {
    const value = modelFormValue();
    await request("/api/models", { method: "POST", body: JSON.stringify(value) });
    await refreshModels(value.id);
    elements.modelStatus.textContent = "模型配置已保存并立即注册。";
  } catch (error) { elements.modelStatus.textContent = "保存失败"; showError(error); }
}

async function discoverModelNames() {
  elements.discoverModels.disabled = true;
  elements.modelStatus.textContent = "读取模型列表中……";
  try {
    const result = await request("/api/models/discover", { method: "POST", body: JSON.stringify({ baseUrl: elements.modelBaseUrl.value, apiKey: elements.modelApiKey.value, api: elements.modelApiFormat.value }) });
    elements.discoveredModels.replaceChildren(...result.models.map(id => { const option = document.createElement("option"); option.value = id; option.textContent = id; return option; }));
    if (result.models[0]) elements.modelNameManual.value = result.models[0];
    elements.modelStatus.textContent = `已读取 ${result.models.length} 个模型。`;
  } catch (error) { elements.modelStatus.textContent = "加载失败，可继续手动输入模型名。"; showError(error); }
  finally { elements.discoverModels.disabled = false; }
}

async function testModelProfile() {
  const modelId = elements.modelId.value.trim();
  if (!state.models.some(item => item.id === modelId)) return showError(new Error("请先保存模型配置，再执行测试。"));
  elements.modelStatus.textContent = "发送极简 hello 测试中……";
  try {
    const result = await request("/api/models/test", { method: "POST", body: JSON.stringify({ modelId }) });
    elements.modelStatus.textContent = `成功 · ${result.elapsedMs} ms · ${result.reply || "（无文字）"}`;
  } catch (error) { elements.modelStatus.textContent = "API 测试失败"; showError(error); }
}

function currentAgentLayer() { return state.agents.find(item => item.effective.id === elements.agentSelect.value); }
function renderAgents() {
  const selected = elements.agentSelect.value;
  elements.agentSelect.replaceChildren(...state.agents.map(item => { const option = document.createElement("option"); option.value = item.effective.id; option.textContent = `${item.effective.name} · ${item.effective.id}`; return option; }));
  if (state.agents.some(item => item.effective.id === selected)) elements.agentSelect.value = selected;
  loadAgentForm();
}
function loadAgentForm() {
  const item = currentAgentLayer(); if (!item) return;
  const agent = item.effective;
  elements.agentName.value = agent.name;
  elements.agentDescription.value = agent.description || "";
  elements.agentDefaultModel.value = agent.defaultModelId || "pi:current";
  elements.agentTools.value = (agent.tools || []).join(", ");
  elements.agentContextPermissions.value = (agent.contextPermissions || []).join(", ");
  elements.agentOutputMode.value = agent.outputMode || "text";
  elements.agentPrompt.value = agent.prompt || "";
  elements.agentLayerBadge.textContent = item.overridden ? "当前卡已有覆盖" : "使用全局默认";
  elements.restoreAgent.disabled = !item.overridden;
}
function agentFormValue() {
  return { schemaVersion: 1, id: elements.agentSelect.value, name: elements.agentName.value.trim(), description: elements.agentDescription.value.trim(), defaultModelId: elements.agentDefaultModel.value, tools: elements.agentTools.value.split(",").map(x => x.trim()).filter(Boolean), contextPermissions: elements.agentContextPermissions.value.split(",").map(x => x.trim()).filter(Boolean), outputMode: elements.agentOutputMode.value, prompt: elements.agentPrompt.value.trim() };
}
async function saveAgent(scope) {
  elements.agentStatus.textContent = scope === "global" ? "覆盖全局配置中……" : "保存当前卡覆盖中……";
  try {
    const id = elements.agentSelect.value;
    await request(`/api/agents/${encodeURIComponent(id)}?scope=${scope}`, { method: "PUT", body: JSON.stringify(agentFormValue()) });
    state.agents = (await request("/api/agents")).agents;
    renderAgents();
    elements.agentStatus.textContent = scope === "global" ? "已覆盖全局基础配置。" : "已保存当前卡个性化覆盖。";
  } catch (error) { elements.agentStatus.textContent = "保存失败"; showError(error); }
}

function workflowKindLabel(kind) { return ({ foreground: "前台", "turn-background": "当前回合后台", "global-background": "全局后台" })[kind] || kind; }
function statusLabel(status) { return ({ pending: "等待", running: "执行中", completed: "完成", skipped: "跳过", failed: "失败", cancelled: "已取消", "awaiting-retry": "等待重试", "awaiting-model-choice": "等待选择模型" })[status] || status; }
function selectedWorkflow() { return state.workflows.find(item => item.id === elements.workflowSelect.value); }
function workflowPanelHasFocus() {
  const active = document.activeElement;
  return document.querySelector("#panel-workflows")?.contains(active) === true && active?.matches("select, input, textarea");
}
function agentLabel(agentId) {
  if (!agentId) return "未设置";
  const agent = state.agents.find(item => item.effective.id === agentId)?.effective;
  return agent ? `${agent.name} · ${agent.id}` : agentId;
}
function modelLabel(modelId) {
  if (!modelId) return "未设置";
  const model = state.models.find(item => item.id === modelId);
  return model ? `${model.name || model.id} · ${model.id}` : modelId;
}
function inheritedModel(workflow, nodeAgentId = "") {
  if (workflow.defaults?.modelId) return { source: "工作流默认模型", id: workflow.defaults.modelId };
  const agentId = nodeAgentId || workflow.defaults?.agentId || "";
  const agent = state.agents.find(item => item.effective.id === agentId)?.effective;
  return { source: "Agent 默认模型", id: agent?.defaultModelId || "pi:current" };
}
function renderWorkflow() {
  const workflow = selectedWorkflow();
  if (!workflow) return;
  const summaryTitle = document.createElement("strong"); summaryTitle.textContent = workflow.title;
  const summaryMeta = document.createElement("span"); summaryMeta.textContent = `${workflowKindLabel(workflow.kind)} · ${workflow.source === "card" ? "当前卡副本" : "全局模板"}${workflow.id === state.activeWorkflowId ? " · 当前前台工作流" : ""}`;
  const summaryDescription = document.createElement("p"); summaryDescription.textContent = workflow.description || "无简介";
  elements.workflowSummary.replaceChildren(summaryTitle, summaryMeta, summaryDescription);
  const fragment = document.createDocumentFragment();
  for (const node of workflow.nodes || []) {
    const card = document.createElement("article"); card.className = "workflow-node-card";
    const title = document.createElement("div"); title.className = "workflow-node-title";
    const nodeTitle = document.createElement("strong"); nodeTitle.textContent = node.title;
    const nodeMeta = document.createElement("span"); nodeMeta.textContent = `${node.type}${node.cooldownTurns ? ` · CD ${node.cooldownTurns} 回合` : ""}`;
    title.append(nodeTitle, nodeMeta);
    const description = document.createElement("p"); description.textContent = node.description || "无节点说明";
    const controls = document.createElement("div"); controls.className = "node-binding-controls";
    const agent = document.createElement("select"); agent.className = "setting-select";
    agent.append(new Option(`继承工作流默认 Agent（${agentLabel(workflow.defaults?.agentId)}）`, ""), ...state.agents.map(item => new Option(`${item.effective.name} · ${item.effective.id}`, item.effective.id))); agent.value = node.agentId || "";
    const model = modelOptions(node.modelId || ""); model.className = "setting-select";
    const inheritedModelOption = new Option("", "");
    const updateInheritedModelLabel = () => {
      const inherited = inheritedModel(workflow, agent.value);
      inheritedModelOption.textContent = `继承${inherited.source}（${modelLabel(inherited.id)}）`;
    };
    updateInheritedModelLabel();
    model.prepend(inheritedModelOption); model.value = node.modelId || "";
    agent.addEventListener("change", () => {
      const selectedAgent = state.agents.find(item => item.effective.id === agent.value)?.effective;
      updateInheritedModelLabel();
      if (!workflow.defaults?.modelId && selectedAgent?.defaultModelId) model.value = selectedAgent.defaultModelId;
    });
    const save = document.createElement("button"); save.type = "button"; save.textContent = "保存节点关联";
    save.addEventListener("click", async () => { try { await request(`/api/workflows/${workflow.id}/nodes/${node.id}/binding`, { method: "PUT", body: JSON.stringify({ agentId: agent.value, modelId: model.value }) }); await refreshWorkflowData(workflow.id); } catch (error) { showError(error); } });
    controls.append(agent, model, save); card.append(title, description, controls); fragment.append(card);
  }
  elements.workflowNodeList.replaceChildren(fragment);
  renderWorkflowRuns();
}
function renderWorkflowRuns() {
  const fragment = document.createDocumentFragment();
  for (const run of state.workflowRuns.slice().reverse().slice(0, 20)) {
    const card = document.createElement("article"); card.className = `workflow-run-card status-${run.status}`;
    const head = document.createElement("div"); head.className = "workflow-run-head";
    const runTitle = document.createElement("strong"); runTitle.textContent = run.workflowId;
    const runMeta = document.createElement("span"); runMeta.textContent = `${statusLabel(run.status)} · 回合 ${run.turn ?? "—"}`;
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
      if (run.live && ["failed", "awaiting-model-choice", "awaiting-retry"].includes(node.status)) {
        const model = modelOptions(node.attempts?.at(-1)?.modelId || "pi:current"); model.className = "setting-select";
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "用所选模型重试";
        const retryWith = async saveAsCardDefault => { try { await request(`/api/workflow-runs/${run.id}/nodes/${node.id}/retry`, { method: "POST", body: JSON.stringify({ modelId: model.value, saveAsCardDefault }) }); await refreshWorkflowData(); } catch (error) { showError(error); } };
        retry.addEventListener("click", () => retryWith(false));
        const saveAndRetry = document.createElement("button"); saveAndRetry.type = "button"; saveAndRetry.textContent = "保存为卡默认并重试"; saveAndRetry.addEventListener("click", () => retryWith(true));
        row.append(model, retry, saveAndRetry);
      }
      card.append(row);
    }
    if (run.live && !["completed", "failed", "cancelled"].includes(run.status)) { const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-danger run-cancel"; cancel.textContent = "取消实例"; cancel.addEventListener("click", async () => { await request(`/api/workflow-runs/${run.id}/cancel`, { method: "POST" }); await refreshWorkflowData(); }); card.append(cancel); }
    fragment.append(card);
  }
  if (!fragment.childNodes.length) { const empty = document.createElement("p"); empty.className = "module-settings-empty"; empty.textContent = "当前 Pi 会话还没有工作流实例。"; fragment.append(empty); }
  elements.workflowRunList.replaceChildren(fragment);
}

function formatTokenCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number.isFinite(value) ? value : 0);
}

function completedNodeUsageRows() {
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

function renderTokenUsage() {
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

async function refreshTokenUsage(force = false) {
  const payload = await request("/api/workflow-runs");
  state.workflowRuns = payload.runs || [];
  const signature = JSON.stringify(state.workflowRuns.map(run => ({ id: run.id, updatedAt: run.updatedAt, nodes: run.nodes })));
  if (!force && signature === state.tokenRenderSignature) return;
  state.tokenRenderSignature = signature;
  renderTokenUsage();
}

async function refreshWorkflowData(selectId, forceRender = false) {
  const [workflowData, runData] = await Promise.all([request("/api/workflows"), request("/api/workflow-runs")]);
  state.workflows = workflowData.workflows || []; state.activeWorkflowId = workflowData.activeWorkflowId; state.workflowRuns = runData.runs || [];
  renderTokenUsage();
  if (!forceRender && workflowPanelHasFocus()) return;
  const signature = JSON.stringify({ workflows: state.workflows, activeWorkflowId: state.activeWorkflowId, runs: state.workflowRuns });
  if (!forceRender && signature === state.workflowRenderSignature) return;
  state.workflowRenderSignature = signature;
  const selected = selectId || elements.workflowSelect.value || state.activeWorkflowId;
  elements.workflowSelect.replaceChildren(...state.workflows.map(item => new Option(`${item.title} · ${workflowKindLabel(item.kind)}`, item.id)));
  if (state.workflows.some(item => item.id === selected)) elements.workflowSelect.value = selected;
  renderWorkflow();
}
async function activateSelectedWorkflow() {
  const workflow = selectedWorkflow(); if (!workflow) return;
  elements.workflowStatus.textContent = workflow.kind === "foreground" ? "正在复制到当前卡并激活……" : "正在启动后台实例……";
  try { const result = await request(`/api/workflows/${workflow.id}/activate`, { method: "POST", body: "{}" }); await refreshWorkflowData(workflow.id); elements.workflowStatus.textContent = result.startsOnNextInput ? "已激活；下一条用户消息使用此工作流。" : "后台工作流已启动。"; }
  catch (error) { elements.workflowStatus.textContent = "操作失败"; showError(error); }
}
async function loadWorkflowPolicy() {
  state.workflowPolicy = await request("/api/workflow-policy");
  elements.workflowMaxConcurrency.value = state.workflowPolicy.maxConcurrency || 10;
  elements.workflowSilentFallback.checked = state.workflowPolicy.modelFailure?.silentFallback === true;
  renderModelSelectors();
}
async function saveWorkflowPolicy(event) {
  event.preventDefault();
  try {
    state.workflowPolicy = await request("/api/workflow-policy", { method: "PUT", body: JSON.stringify({ schemaVersion: 1, maxConcurrency: Number(elements.workflowMaxConcurrency.value), modelFailure: { silentFallback: elements.workflowSilentFallback.checked, defaultFallbackModelId: elements.workflowFallbackModel.value || null } }) });
    elements.workflowStatus.textContent = state.workflowPolicy.modelFailure.silentFallback ? "运行策略已保存；静默回退时仍会在实例记录中显示实际模型。" : "运行策略已保存；节点失败后等待用户选择模型。";
  } catch (error) { showError(error); }
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
elements.modelPreset.addEventListener("change", () => {
  const preset = modelPresets[elements.modelPreset.value] || modelPresets.custom;
  elements.modelBaseUrl.value = preset.baseUrl;
  elements.modelApiFormat.value = preset.api;
});
elements.modelProfileSelect.addEventListener("change", loadModelForm);
elements.newModel.addEventListener("click", clearModelForm);
elements.modelForm.addEventListener("submit", saveModelProfile);
elements.discoverModels.addEventListener("click", discoverModelNames);
elements.discoveredModels.addEventListener("change", () => { if (elements.discoveredModels.value) elements.modelNameManual.value = elements.discoveredModels.value; });
elements.testModel.addEventListener("click", testModelProfile);
elements.deleteModel.addEventListener("click", async () => {
  const id = elements.modelProfileSelect.value; if (!id || !window.confirm(`删除模型配置“${id}”吗？`)) return;
  try { await request(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" }); await refreshModels(); } catch (error) { showError(error); }
});
elements.agentSelect.addEventListener("change", loadAgentForm);
elements.agentForm.addEventListener("submit", event => { event.preventDefault(); saveAgent("card"); });
elements.saveAgentGlobal.addEventListener("click", () => { if (window.confirm("覆盖全局 Agent 基础配置会影响其他卡片，确定继续吗？")) saveAgent("global"); });
elements.restoreAgent.addEventListener("click", async () => { try { const id = elements.agentSelect.value; await request(`/api/agents/${encodeURIComponent(id)}/restore`, { method: "POST" }); state.agents = (await request("/api/agents")).agents; renderAgents(); elements.agentStatus.textContent = "已移除当前卡覆盖，恢复全局默认。"; } catch (error) { showError(error); } });
elements.workflowSelect.addEventListener("change", renderWorkflow);
elements.activateWorkflow.addEventListener("click", activateSelectedWorkflow);
elements.refreshWorkflows.addEventListener("click", () => refreshWorkflowData(undefined, true).catch(showError));
elements.showActiveWorkflow.addEventListener("click", () => { elements.workflowSelect.value = state.activeWorkflowId; renderWorkflow(); });
elements.workflowPolicyForm.addEventListener("submit", saveWorkflowPolicy);
elements.refreshTokens.addEventListener("click", () => refreshTokenUsage(true).catch(showError));

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
  const modelPayload = await request("/api/models");
  state.models = [modelPayload.current, ...(modelPayload.profiles || [])];
  renderModelSelectors();
  await loadWorkflowPolicy();
  loadModelForm();
  state.agents = (await request("/api/agents")).agents || [];
  renderAgents();
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
  showPanel("story");
  window.setInterval(refreshState, 600);
}

initialize().catch(showError);
