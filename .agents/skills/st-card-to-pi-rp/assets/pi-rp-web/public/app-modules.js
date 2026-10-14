// 模块区域渲染（实施方案 §11 第 6 条：按职责提取的原生模块之一）。
//
// 负责：模块列表与显示顺序设置、模块记录/故事/设置/创作要求/归档状态/工作流控制的区域渲染，
// 以及区域分发中枢 `createModuleRegion`。
//
import { createSettingsAutosave } from "./module-autosave.js";
import { renderMarkdown } from "./markdown.js?v=4";
import { buildModuleJsonTree } from "./module-json.js?v=2";
import { composePromptPreview, selectionsFromValues } from "./prompt-controls.js?v=1";
import { renderImageGenerationRegion } from "./app-image.js?v=1";
import { appendModuleEmpty, componentReference, elements, getClient, modelPresets, request, showError, state } from "./app-context.js";

export function toggleCardModule(button) {
  const content = document.getElementById(button.getAttribute("aria-controls"));
  if (!content) return;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  content.hidden = !expanded;
  if (expanded) content.loadModuleTabs?.();
  const stateLabel = button.querySelector(".module-toggle-state");
  if (stateLabel) stateLabel.textContent = expanded ? "收起" : "展开";
  const moduleId = button.closest("[data-module-id]")?.dataset.moduleId;
  if (moduleId) {
    if (expanded) state.expandedFeatureModules.add(moduleId);
    else state.expandedFeatureModules.delete(moduleId);
  }
}

export function appendModuleValue(container, value, format = "text") {
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

export function appendModuleJsonNode(container, node, root = false) {
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

export function appendInteractiveValue(container, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "module-json-fields";
  appendModuleJsonNode(wrapper, buildModuleJsonTree(value), true);
  container.append(wrapper);
}

export function inputForDeclaration(field, value) {
  let input;
  if (field.type === "textarea" || field.type === "json") input = document.createElement("textarea");
  else if (field.type === "select") {
    input = document.createElement("select");
    if (!field.required) input.append(new Option("—", ""));
    const labels = { context: "跟随创作窗口", fixed: "固定轮数", update: "补建 / 恢复", rebuild: "重新编码", cancel: "取消索引任务", status: "查看状态" };
    for (const option of field.options || []) input.append(new Option(labels[option] || option, option));
  } else {
    input = document.createElement("input");
    input.type = field.type === "boolean" ? "checkbox" : ["integer", "number"].includes(field.type) ? "number" : "text";
    if (field.type === "integer") input.step = "1";
    if (field.minimum != null) input.min = String(field.minimum);
    if (field.maximum != null) input.max = String(field.maximum);
  }
  input.dataset.fieldPath = field.path || `/${field.name}`;
  input.className = field.type === "select" ? "setting-select" : field.type === "boolean" ? "" : "setting-input";
  input.required = field.required === true;
  if (field.type === "boolean") input.checked = value === true;
  else if (value !== undefined && value !== null) input.value = field.type === "json" ? JSON.stringify(value, null, 2) : String(value);
  return input;
}

export function declaredInputValue(input, field) {
  if (field.type === "boolean") return input.checked;
  if (["integer", "number"].includes(field.type)) return input.value === "" ? null : Number(input.value);
  if (field.type === "json") return JSON.parse(input.value);
  return input.value;
}

export function createDeclaredField(field, value) {
  const label = document.createElement("label");
  label.className = "module-interactive-field";
  if (field.type === "boolean") label.classList.add("module-interactive-boolean");
  const title = document.createElement("span"); title.textContent = field.label;
  const input = inputForDeclaration(field, value);
  label.append(title, input);
  if (field.help) { const help = document.createElement("small"); help.textContent = field.help; label.append(help); }
  return { label, input };
}

export function valueAtPath(value, path) {
  if (!path) return value;
  return String(path).split(".").reduce((current, key) => current == null ? undefined : current[key], value);
}

export async function renderRecordHistory(container, module, region, recordId) {
  container.replaceChildren();
  appendModuleEmpty(container, "正在读取修订历史……");
  async function load(cursor = null, reset = false) {
    try {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/records/${encodeURIComponent(recordId)}/history${suffix}`);
      if (reset || cursor === null) container.replaceChildren();
      for (const item of payload.items || []) {
        const article = document.createElement("article"); article.className = "module-history-record";
        const heading = document.createElement("strong"); heading.textContent = `修订 ${item.revision} · 第${item.turn}轮 · ${item.status}`;
        article.append(heading); appendInteractiveValue(article, item.value); container.append(article);
      }
      if (!(payload.items || []).length && cursor === null) appendModuleEmpty(container, "没有可显示的修订历史。");
      if (payload.nextCursor) {
        const more = document.createElement("button"); more.type = "button"; more.className = "module-file-button"; more.textContent = "更多修订";
        more.addEventListener("click", () => { more.remove(); void load(payload.nextCursor); }); container.append(more);
      }
    } catch (error) { if (cursor === null) container.replaceChildren(); appendModuleEmpty(container, error.message); }
  }
  await load(null, true);
}

export async function renderRecordBrowserRegion(section, module, region) {
  const controls = document.createElement("form"); controls.className = "module-interactive-controls";
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索记录内容"; search.setAttribute("aria-label", "搜索记录内容"); controls.append(search);
  const filterInputs = [];
  for (const filter of region.filters || []) {
    const field = { ...filter, type: filter.control, path: `/${filter.id}`, required: false, options: filter.control === "boolean" ? ["true", "false"] : filter.options };
    if (filter.control === "boolean") field.type = "select";
    const built = createDeclaredField(field, ""); filterInputs.push({ filter, input: built.input }); controls.append(built.label);
  }
  const searchButton = document.createElement("button"); searchButton.type = "submit"; searchButton.textContent = "查询"; controls.append(searchButton);
  const results = document.createElement("div"); results.className = "module-record-list";
  const paging = document.createElement("div"); paging.className = "module-pagination";
  const previous = document.createElement("button"); previous.type = "button"; previous.className = "secondary-button"; previous.textContent = "上一页";
  const next = document.createElement("button"); next.type = "button"; next.className = "secondary-button"; next.textContent = "下一页";
  const pageLabel = document.createElement("span"); paging.append(previous, pageLabel, next);
  section.append(controls, results, paging);
  const cursors = [null]; let page = 0, generation = 0;
  async function loadPage(reset = false) {
    const currentGeneration = ++generation;
    if (reset) { cursors.splice(0, cursors.length, null); page = 0; }
    results.replaceChildren(); appendModuleEmpty(results, "正在读取记录……"); previous.disabled = true; next.disabled = true;
    const params = new URLSearchParams(); if (cursors[page]) params.set("cursor", cursors[page]); if (search.value.trim()) params.set("search", search.value.trim());
    for (const { filter, input } of filterInputs) if (input.value !== "") params.set(`filter.${filter.id}`, input.value);
    try {
      const payload = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/records?${params}`);
      if (currentGeneration !== generation) return;
      results.replaceChildren();
      for (const item of payload.items || []) {
        const article = document.createElement("article"); article.className = "module-record module-browser-record";
        const heading = document.createElement("div"); heading.className = "module-browser-heading";
        const title = document.createElement("strong"); title.textContent = item.id;
        const meta = document.createElement("span"); meta.textContent = `${item.recordType} · r${item.revision} · 第${item.turn}轮${item.status === "active" ? "" : ` · ${item.status}`}`;
        const historyButton = document.createElement("button"); historyButton.type = "button"; historyButton.className = "module-file-button"; historyButton.textContent = "修订历史";
        const history = document.createElement("div"); history.className = "module-record-history"; history.hidden = true;
        historyButton.addEventListener("click", () => { history.hidden = !history.hidden; if (!history.hidden && !history.dataset.loaded) { history.dataset.loaded = "true"; void renderRecordHistory(history, module, region, item.id); } });
        heading.append(title, meta, historyButton); article.append(heading); appendInteractiveValue(article, item.value); article.append(history); results.append(article);
      }
      if (!(payload.items || []).length) appendModuleEmpty(results, region.empty);
      if (payload.nextCursor) cursors[page + 1] = payload.nextCursor; else cursors.splice(page + 1);
      previous.disabled = page === 0; next.disabled = !payload.nextCursor; pageLabel.textContent = `第 ${page + 1} 页 · ${payload.returned || 0} 条`;
    } catch (error) { if (currentGeneration !== generation) return; results.replaceChildren(); appendModuleEmpty(results, error.message); pageLabel.textContent = "读取失败"; }
  }
  controls.addEventListener("submit", event => { event.preventDefault(); void loadPage(true); });
  previous.addEventListener("click", () => { if (page > 0) { page -= 1; void loadPage(); } });
  next.addEventListener("click", () => { if (cursors[page + 1]) { page += 1; void loadPage(); } });
  section.querySelector(".module-empty")?.remove();
  section.refreshRegion = () => loadPage();
  await loadPage();
}

export async function renderStoryBrowserRegion(section, module, region) {
  const controls = document.createElement("div"); controls.className = "module-interactive-controls";
  const mode = document.createElement("select");
  for (const [value, label] of [["newest", "最新发布"], ["series", "按系列"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; if (value === "series" && !region.allowSeriesGrouping) option.disabled = true; mode.append(option); }
  controls.append(mode);
  const results = document.createElement("div"); results.className = "module-story-list";
  const more = document.createElement("button"); more.type = "button"; more.className = "secondary-button"; more.textContent = "更多故事";
  section.append(controls, results, more);
  let cursor = null; let items = [], generation = 0;
  const cards = new Map();
  const valueOf = (value, key) => value?.[key] ?? value?.[key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)] ?? null;
  async function load(reset = false, refresh = false) {
    const currentGeneration = ++generation, keepCount = items.length;
    if (reset) { cursor = null; items = []; results.replaceChildren(); }
    more.disabled = true;
    try {
      let nextCursor = refresh ? null : cursor;
      const refreshed = [];
      do {
        const suffix = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
        const payload = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/records${suffix}`);
        if (currentGeneration !== generation) return;
        (refresh ? refreshed : items).push(...(payload.items || []));
        nextCursor = payload.nextCursor || null;
      } while (refresh && nextCursor && refreshed.length < keepCount);
      if (refresh) items = refreshed;
      cursor = nextCursor;
      const ordered = mode.value === "series" ? [...items].sort((a, b) => String(valueOf(a.value, "seriesId") || "").localeCompare(String(valueOf(b.value, "seriesId") || "")) || Number(valueOf(a.value, "sequence") || 0) - Number(valueOf(b.value, "sequence") || 0)) : [...items];
      results.replaceChildren();
      for (const item of ordered) {
        const signature = JSON.stringify(item), cached = cards.get(item.id);
        if (cached?.signature === signature) { results.append(cached.article); continue; }
        const value = item.value || {}; const article = document.createElement("article"); article.className = "module-story-card";
        const heading = document.createElement("strong");
        const time = valueOf(value, "timeRange") || "时间未标明"; const locations = valueOf(value, "locations") || [];
        heading.textContent = `${Array.isArray(locations) ? locations.join("、") : locations} · ${typeof time === "string" ? time : `${time.start || "?"}—${time.end || "?"}`}`;
        const summary = document.createElement("p"); summary.textContent = valueOf(value, "summary") || "";
        const cast = document.createElement("small"); const characters = valueOf(value, "characters") || []; cast.textContent = Array.isArray(characters) ? characters.join("、") : String(characters);
        const actions = document.createElement("div"); actions.className = "module-interactive-actions";
        const read = document.createElement("button"); read.type = "button"; read.textContent = "阅读全文";
        const full = document.createElement("div"); full.className = "module-story-full"; full.hidden = true;
        read.addEventListener("click", async () => {
          if (!full.hidden) { full.hidden = true; read.textContent = "阅读全文"; return; }
          read.disabled = true;
          try { const story = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/stories/${encodeURIComponent(item.id)}`); full.replaceChildren(); appendInteractiveValue(full, story.value); full.hidden = false; read.textContent = "收起全文"; }
          catch (error) { full.replaceChildren(); appendModuleEmpty(full, error.message); full.hidden = false; }
          finally { read.disabled = false; }
        });
        actions.append(read);
        if (region.allowOpenAuthoritySource) { const source = document.createElement("button"); source.type = "button"; source.className = "module-file-button"; source.textContent = "打开源文件"; source.title = "高级 DIY：直接编辑将绕过版本、索引、归档和一致性保障"; source.addEventListener("click", async () => { source.disabled = true; try { await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/stories/${encodeURIComponent(item.id)}/open-source`, { method: "POST", body: "{}" }); } catch (error) { showError(error); } finally { source.disabled = false; } }); actions.append(source); }
        article.append(heading, summary, cast, actions, full); results.append(article);
        cards.set(item.id, { signature, article });
      }
      if (!items.length) appendModuleEmpty(results, region.empty || "暂无故事。");
      more.hidden = !cursor; more.disabled = !cursor;
    } catch (error) { if (currentGeneration !== generation) return; appendModuleEmpty(results, error.message); more.hidden = true; }
  }
  mode.addEventListener("change", () => { void load(true); }); more.addEventListener("click", () => { void load(false); });
  section.refreshRegion = () => load(false, true);
  await load(true);
}

function attachAutosave(section, form, payload, endpoint) {
  const sessionId = state.snapshot?.sessionId;
  const sameSession = () => { if (state.snapshot?.sessionId !== sessionId) throw new Error("聊天已经切换，原聊天的修改已停止提交。"); };
  const status = document.createElement("span"); status.className = "setting-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试"; retry.hidden = true;
  const reload = document.createElement("button"); reload.type = "button"; reload.textContent = "重新读取"; reload.hidden = true;
  const actions = document.createElement("div"); actions.className = "module-interactive-actions";
  actions.append(status, retry, reload); form.append(actions);
  const saver = createSettingsAutosave({
    revision: payload.record.revision, values: payload.values,
    read: async () => { sameSession(); const latest = await request(endpoint); sameSession(); return latest; },
    readOutcome: operationId => request(`${endpoint.replace(/\/settings$/, "")}/operations/${encodeURIComponent(operationId)}`),
    write: body => { sameSession(); return request(endpoint, { method: "PUT", body: JSON.stringify({ ...body, expectedSessionId: sessionId }) }); },
    notify: result => {
      section.dataset.unsaved = String(result.pending || result.saving || form.querySelector('[data-editing="true"]') != null);
      status.textContent = result.saving ? "保存中……" : result.error || (result.pending ? "待保存" : "已保存");
      retry.hidden = !result.error || result.conflict; reload.hidden = !result.conflict;
    },
  });
  retry.addEventListener("click", () => saver.retry());
  reload.addEventListener("click", () => {
    // Conflict reload is explicit and is the only operation allowed to discard a local draft.
    if (!window.confirm("重新读取会放弃此区域尚未保存的修改，继续吗？")) return;
    section.dataset.unsaved = "false";
    void section.reloadSettings();
  });
  form.addEventListener("submit", event => event.preventDefault());
  return saver;
}

export async function renderSettingsFormRegion(section, module, region) {
  appendModuleEmpty(section, "正在读取设置……");
  const endpoint = `/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/settings`;
  try {
    const payload = await request(endpoint);
    section.replaceChildren();
    if (region.title) { const title = document.createElement("h4"); title.textContent = region.title; section.append(title); }
    if (region.description) { const description = document.createElement("p"); description.className = "module-description"; description.textContent = region.description; section.append(description); }
    const form = document.createElement("form"); form.className = "module-settings-form";
    const inputs = [];
    for (const field of region.fields || []) { const built = createDeclaredField(field, payload.values?.[field.path]); inputs.push({ field, input: built.input, label: built.label }); }
    let groups = [];
    if (module.id === "narrative-memory" && region.id === "memory-settings") groups = [
      { id: "archive", title: "归档", matches: path => path.startsWith("/archive/") },
      { id: "retrieval", title: "检索", matches: path => path.startsWith("/retrieval/") },
      { id: "compression", title: "压缩", matches: path => path.startsWith("/compression/") },
    ];
    if (module.id === "narrative-controls" && region.id === "history-recall") groups = [
      { id: "timing", title: "触发与保护", matches: path => ["/enabled", "/indexEveryTurns", "/protectionMode", "/protectRecentTurns"].includes(path) },
      { id: "chunks", title: "原文切片", matches: path => ["/targetCharacters", "/maxCharacters", "/overlapCharacters", "/shortTailCharacters"].includes(path) },
      { id: "retrieval", title: "召回", matches: path => ["/candidatesPerQuery", "/maxResults", "/maxOutputCharacters", "/maxPerTurn", "/deadlineMs"].includes(path) },
    ];
    if (groups.length) {
      const pages = groups.map(group => ({ ...group, fields: inputs.filter(({ field }) => group.matches(field.path)) })).filter(page => page.fields.length);
      for (const { field, label } of inputs) if (!groups.some(group => group.matches(field.path))) form.append(label);
      const fieldTabs = document.createElement("div"); fieldTabs.className = "module-settings-tabs"; form.append(fieldTabs);
      const key = `${state.featureModulePayload?.sessionId || "no-chat"}-${module.id}-${region.id}-fields`;
      appendModuleTabs(fieldTabs, pages, key, (panel, page) => { panel.classList.add("module-settings-form"); for (const { label } of page.fields) panel.append(label); })();
    } else for (const { label } of inputs) form.append(label);
    section.reloadSettings = () => renderSettingsFormRegion(section, module, region);
    const saver = attachAutosave(section, form, payload, endpoint);
    for (const { field, input } of inputs) {
      const save = () => {
        try {
          if (!input.checkValidity()) throw new Error("请填写有效值并遵守取值范围。");
          input.dataset.editing = "false";
          saver.commit({ [field.path]: declaredInputValue(input, field) });
          input.removeAttribute("aria-invalid");
          input.parentNode.querySelector(".field-error")?.remove();
        } catch (error) {
          input.dataset.editing = "true"; section.dataset.unsaved = "true";
          input.setAttribute("aria-invalid", "true");
          let message = input.parentNode.querySelector(".field-error");
          if (!message) { message = document.createElement("span"); message.className = "field-error"; input.parentNode.append(message); }
          message.textContent = error.message;
        }
      };
      if (["boolean", "select"].includes(field.type)) input.addEventListener("change", save);
      else {
        input.addEventListener("input", () => { input.dataset.editing = "true"; section.dataset.unsaved = "true"; });
        input.addEventListener("blur", () => { if (input.dataset.editing === "true") save(); });
      }
    }
    section.append(form);
    section.refreshRegion = async () => {
      if (saver.dirty || section.dataset.unsaved === "true") return;
      const latest = await request(endpoint);
      if (JSON.stringify(latest.values) !== JSON.stringify(payload.values)) await renderSettingsFormRegion(section, module, region);
    };
  } catch (error) { section.replaceChildren(); appendModuleEmpty(section, error.message); }
}

export async function renderPromptControlsRegion(section, module, region) {
  appendModuleEmpty(section, "正在读取创作要求……");
  const endpoint = `/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/settings`;
  try {
    const payload = await request(endpoint), controls = payload.controls || { groups: [] };
    const selections = selectionsFromValues(controls, payload.values);
    section.replaceChildren();
    if (region.title) { const title = document.createElement("h4"); title.textContent = region.title; section.append(title); }
    if (region.description) { const description = document.createElement("p"); description.className = "module-description"; description.textContent = region.description; section.append(description); }
    const form = document.createElement("form"); form.className = "module-prompt-controls-form";
    section.reloadSettings = () => renderPromptControlsRegion(section, module, region);
    const saver = attachAutosave(section, form, payload, endpoint);
    for (const group of controls.groups || []) {
      const fieldset = document.createElement("fieldset"); fieldset.className = "prompt-control-group";
      const legend = document.createElement("legend"); legend.textContent = group.title || group.id; fieldset.append(legend);
      if (group.description) { const description = document.createElement("p"); description.className = "prompt-control-description"; description.textContent = group.description; fieldset.append(description); }
      const segmented = document.createElement("div"); segmented.className = "prompt-control-segmented";
      segmented.setAttribute("role", "radiogroup"); segmented.setAttribute("aria-label", group.title || group.id);
      const customLabel = document.createElement("label"); customLabel.className = "prompt-control-custom";
      const customTitle = document.createElement("span"); customTitle.textContent = "自定义文本";
      const customInput = document.createElement("textarea"); customInput.maxLength = 50000; customInput.placeholder = "输入本组创作要求……";
      customInput.value = selections[group.id]?.customText || ""; customLabel.append(customTitle, customInput);
      const preview = document.createElement("div"); preview.className = "prompt-control-inline-preview";
      const options = [];
      const updateGroup = () => {
        for (const { option, input, label } of options) { const selected = option.id === selections[group.id].optionId; input.checked = selected; label.classList.toggle("is-selected", selected); }
        customLabel.hidden = selections[group.id].optionId !== "custom"; customInput.disabled = customLabel.hidden;
        preview.hidden = !customLabel.hidden; preview.replaceChildren();
        if (!preview.hidden) {
          const content = composePromptPreview({ groups: [group] }, selections)[0]?.content;
          if (content) appendModuleValue(preview, content, "markdown");
          else appendModuleEmpty(preview, "此档位不附加提示词。");
        }
      };
      for (const option of group.options || []) {
        const label = document.createElement("label"); label.className = "prompt-control-option";
        const input = document.createElement("input"); input.type = "radio"; input.className = "sr-only";
        input.name = `prompt-${module.id}-${region.id}-${group.id}`; input.value = option.id;
        input.addEventListener("change", () => {
          selections[group.id].optionId = input.value; updateGroup();
          saver.commit({ [`/selections/${group.id}/optionId`]: input.value });
        });
        const copy = document.createElement("span"); copy.textContent = option.label || option.id; label.append(input, copy); segmented.append(label); options.push({ option, input, label });
      }
      customInput.addEventListener("input", () => { selections[group.id].customText = customInput.value; customInput.dataset.editing = "true"; section.dataset.unsaved = "true"; });
      customInput.addEventListener("blur", () => { if (customInput.dataset.editing !== "true") return; customInput.dataset.editing = "false"; saver.commit({ [`/selections/${group.id}/customText`]: customInput.value }); });
      fieldset.append(segmented, preview, customLabel); form.insertBefore(fieldset, form.lastChild);
      updateGroup();
    }
    section.append(form);
    section.refreshRegion = async () => {
      if (saver.dirty || section.dataset.unsaved === "true") return;
      const latest = await request(endpoint);
      if (JSON.stringify(latest.values) !== JSON.stringify(payload.values)) await renderPromptControlsRegion(section, module, region);
    };
  } catch (error) { section.replaceChildren(); appendModuleEmpty(section, error.message); }
}

export async function renderIntegrityAlertsRegion(section, module, region) {
  appendModuleEmpty(section, "正在检查归档状态……");
  try {
    const payload = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/integrity`);
    section.querySelector(".module-empty")?.remove();
    const issues = payload.issues || [];
    for (const issue of issues) {
      const article = document.createElement("article"); article.className = `module-integrity-alert severity-${issue.severity || "warning"}`;
      const title = document.createElement("strong");
      const range = issue.startTurn === issue.endTurn ? `第 ${issue.startTurn} 轮` : `第 ${issue.startTurn}—${issue.endTurn} 轮`;
      title.textContent = issue.type === "source-revised" ? `${range}的正文在归档后被修改` : `${range}尚未完成归档覆盖`;
      const detail = document.createElement("p");
      detail.textContent = issue.type === "source-revised"
        ? `记录依据为修订 ${(issue.recordedRevisions || [issue.recordedRevision]).filter(value => value != null).join("、")}，当前正文为修订 ${issue.currentRevision}。现有记忆不会自动失效，请由你决定是否复核。`
        : "该范围已经越过保护期和归档冷却，但没有成功覆盖；没有独立事件记录本身不算遗漏。";
      const repair = document.createElement("button"); repair.type = "button"; repair.textContent = "修复此范围";
      repair.addEventListener("click", async () => {
        repair.disabled = true;
        try {
          const action = payload.action;
          const workflowPayload = { [action.startTurnParameter]: issue.startTurn, [action.endTurnParameter]: issue.endTurn };
          if (action.operationParameter) workflowPayload[action.operationParameter] = action.operationValue;
          const result = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(action.workflowBindingId)}/workflows/${encodeURIComponent(action.workflowId)}/run`, { method: "POST", body: JSON.stringify({ payload: workflowPayload }) });
          detail.textContent = `已启动限定修复：${result.run?.id || action.workflowId}。`;
        } catch (error) { detail.textContent = `启动失败：${error.message}`; repair.disabled = false; }
      });
      article.append(title, detail, repair); section.append(article);
    }
    if (!issues.length) appendModuleEmpty(section, payload.empty || region.empty || "未发现需要处理的归档问题。");
    if (payload.untrackedReceipts) {
      const legacy = document.createElement("p"); legacy.className = "module-integrity-note";
      legacy.textContent = `另有 ${payload.untrackedReceipts} 个旧事务缺少精确来源修订，系统不能自动判断是否需要复核。`;
      section.append(legacy);
    }
  } catch (error) { section.querySelector(".module-empty")?.remove(); appendModuleEmpty(section, error.message); }
}

export async function renderWorkflowControlsRegion(section, module, region) {
  const status = document.createElement("div"); status.className = "module-workflow-status";
  async function refreshStatus() {
    try {
      const payload = await request("/api/v1/workflow-runs");
      const allowed = new Set((region.workflows || []).map(item => componentReference(module.id, item.id)));
      const runs = (payload.runs || []).filter(run => allowed.has(runWorkflowReference(run))).slice(-8).reverse();
      const fragment = document.createDocumentFragment();
      for (const run of runs) {
        const row = document.createElement("div"); row.className = "module-workflow-run";
        const label = document.createElement("span"); label.textContent = `${run.workflowTitle || run.workflowId} · ${run.status}`; row.append(label);
        if (!["completed", "skipped", "failed", "cancelled"].includes(run.status) && run.live !== false) {
          const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "module-file-button"; cancel.textContent = "取消";
          cancel.addEventListener("click", async () => { cancel.disabled = true; try { await request(`/api/v1/workflow-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }); await refreshStatus(); } catch (error) { showError(error); cancel.disabled = false; } });
          row.append(cancel);
        }
        fragment.append(row);
      }
      status.replaceChildren(fragment);
      if (!runs.length) appendModuleEmpty(status, "当前聊天还没有这些工作流的运行记录。");
    } catch (error) { status.replaceChildren(); appendModuleEmpty(status, error.message); }
  }
  for (const workflow of region.workflows || []) {
    const form = document.createElement("form"); form.className = "module-workflow-control";
    const heading = document.createElement("strong"); heading.textContent = workflow.title; form.append(heading);
    if (workflow.description) { const description = document.createElement("p"); description.textContent = workflow.description; form.append(description); }
    const inputs = [];
    for (const field of workflow.parameters || []) { const built = createDeclaredField(field, field.default); inputs.push({ field, input: built.input }); form.append(built.label); }
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "启动"; form.append(button);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (workflow.confirm && !window.confirm(workflow.confirm)) return; button.disabled = true; status.textContent = "正在启动……";
      try {
        const payload = Object.fromEntries(inputs.map(({ field, input }) => [field.name, declaredInputValue(input, field)]));
        const result = await request(`/api/v1/modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(region.bindingId)}/workflows/${encodeURIComponent(workflow.id)}/run`, { method: "POST", body: JSON.stringify({ payload }) });
        status.textContent = `已启动：${result.run?.id || workflow.id}（${result.run?.status || "pending"}）`; await refreshStatus();
      } catch (error) { status.textContent = `启动失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    section.append(form);
  }
  section.append(status);
  await refreshStatus();
}

const moduleRenderers = new Map([
  ["record-browser", renderRecordBrowserRegion], ["story-browser", renderStoryBrowserRegion],
  ["settings-form", renderSettingsFormRegion], ["prompt-controls", renderPromptControlsRegion],
  ["integrity-alerts", renderIntegrityAlertsRegion], ["workflow-controls", renderWorkflowControlsRegion],
  ["image-generation", (section, module, region) => renderImageGenerationRegion(section, region.imageMode)],
]);
export function registerModuleRenderer(type, renderer) {
  if (typeof type !== "string" || typeof renderer !== "function") throw new Error("A renderer type and function are required.");
  const previous = moduleRenderers.get(type); moduleRenderers.set(type, renderer);
  return () => { if (moduleRenderers.get(type) === renderer) { if (previous) moduleRenderers.set(type, previous); else moduleRenderers.delete(type); } };
}
export function createModuleRegion(region, _data, module = null) {
  const section = document.createElement("section");
  section.className = `module-region module-region-${region.type}`;
  if (region.spoiler) section.classList.add("module-region-spoiler");
  const renderer = moduleRenderers.get(region.type);
  if (!renderer) { appendModuleEmpty(section, "此界面暂不支持该模块的可选展示方式。"); return section; }
  const binding = module?.view?.bindings?.find(item => item.id === region.bindingId);
  if (!binding) { appendModuleEmpty(section, "模块展示缺少能力绑定。"); return section; }
  const declaration = { ...binding, ...region };
  const run = () => Promise.resolve(renderer(section, module, declaration)).catch(error => { section.replaceChildren(); appendModuleEmpty(section, error.message); });
  if (["integrity-alerts", "image-generation"].includes(region.type)) section.refreshRegion = run;
  void run();
  return section;
}

export function normalizeModuleDisplaySettings(value, modules = state.featureModules) {
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

export function savedModuleDisplaySettings() {
  return state.settings?.card?.settings?.featureModules || {};
}

export function orderedVisibleModules(modules) {
  const settings = normalizeModuleDisplaySettings(savedModuleDisplaySettings(), modules);
  const byId = new Map(modules.map(module => [module.id, module]));
  return settings.order.filter(id => !settings.hidden.has(id)).map(id => byId.get(id)).filter(Boolean);
}

export async function openFeatureModuleDocument(module, target, button) {
  const originalText = button.textContent;
  button.disabled = true;
  try {
    await request(`/api/v1/modules/${encodeURIComponent(module.id)}/open`, {
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

function modulePages(module) {
  const regions = (module.view?.regions || []).map(region => ({ ...module.view.bindings?.find(binding => binding.id === region.bindingId), ...region }));
  const find = (...ids) => regions.filter(region => ids.includes(region.id));
  if (module.id === "narrative-memory") return [
    { id: "overview", title: "运行概况", regions: find("memory-integrity", "memory-compression-state") },
    { id: "settings", title: "模块设置", regions: find("memory-settings") },
    { id: "records", title: "记忆档案", regions: find("entities", "relationships", "events", "cognitions", "knower-groups", "support", "source-captures"), subtabs: true },
    { id: "maintenance", title: "维护", regions: find("memory-workflows") },
    ...regions.filter(region => !["memory-integrity", "memory-compression-state", "memory-settings", "entities", "relationships", "events", "cognitions", "knower-groups", "support", "source-captures", "memory-workflows"].includes(region.id)).map(region => ({ id: region.id, title: region.title, regions: [region] })),
  ].filter(page => page.regions.length);
  if (module.id === "world-narrative-coordinator") return [
    ...find("director-prompt-controls", "director-status", "director-references", "director-settings").map(region => ({ id: region.id, title: region.title, regions: [region] })),
    { id: "maintenance", title: "统计与维护", regions: find("director-health", "director-workflows") },
    ...regions.filter(region => !["director-prompt-controls", "director-status", "director-references", "director-settings", "director-health", "director-workflows"].includes(region.id)).map(region => ({ id: region.id, title: region.title, regions: [region] })),
  ].filter(page => page.regions.length);
  if (module.id === "comfy-image-generation") return regions.flatMap(region => region.type === "image-generation" ? [
    { id: "generate", title: "生成图片", regions: [{ ...region, imageMode: "controls" }] },
    { id: "gallery", title: "生成记录", regions: [{ ...region, imageMode: "gallery" }] },
  ] : [{ id: region.id, title: region.title, regions: [region] }]);
  return regions.map((region, index) => ({ id: region.id || String(index), title: region.title || "内容", regions: [region] }));
}

function refreshModuleRegions(container) {
  for (const region of container.querySelectorAll(".module-region")) {
    const editing = region.contains(document.activeElement) && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (region.closest("[hidden]") || editing || !region.refreshRegion || region.refreshPending) continue;
    region.refreshPending = true;
    const scrollParent = container.closest(".module-rail"), scrollTop = scrollParent?.scrollTop;
    Promise.resolve(region.refreshRegion()).catch(() => {}).finally(() => { region.refreshPending = false; if (scrollParent) scrollParent.scrollTop = scrollTop; });
  }
}

function appendModuleTabs(container, pages, key, loadPage) {
  if (!pages.length) return () => {};
  const bar = document.createElement("div"); bar.className = "module-tabs"; bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "模块内容");
  const entries = pages.map(page => {
    const button = document.createElement("button"); button.type = "button"; button.className = "module-tab"; button.textContent = page.title;
    button.id = `${key}-${page.id}-tab`; button.setAttribute("role", "tab");
    const panel = document.createElement("div"); panel.className = "module-tab-panel"; panel.id = `${key}-${page.id}-panel`;
    panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", button.id); button.setAttribute("aria-controls", panel.id);
    return { page, button, panel, loaded: false };
  });
  const select = id => {
    state.moduleTabSelections.set(key, id);
    for (const entry of entries) {
      const active = entry.page.id === id;
      entry.button.setAttribute("aria-selected", String(active)); entry.button.tabIndex = active ? 0 : -1;
      entry.panel.hidden = !active;
      if (active && !entry.loaded) { entry.loaded = true; loadPage(entry.panel, entry.page); }
      else if (active) refreshModuleRegions(entry.panel);
    }
  };
  for (const [index, entry] of entries.entries()) {
    entry.button.addEventListener("click", () => select(entry.page.id));
    entry.button.addEventListener("keydown", event => {
      const target = event.key === "ArrowRight" ? (index + 1) % entries.length : event.key === "ArrowLeft" ? (index + entries.length - 1) % entries.length : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : -1;
      if (target >= 0) { event.preventDefault(); select(entries[target].page.id); entries[target].button.focus(); }
    });
    bar.append(entry.button);
  }
  container.append(bar, ...entries.map(entry => entry.panel));
  return () => select(pages.some(page => page.id === state.moduleTabSelections.get(key)) ? state.moduleTabSelections.get(key) : pages[0].id);
}

function moduleTabbedContent(module, scopeKey) {
  const key = `${scopeKey}-${module.id}`, signature = JSON.stringify(module.view);
  let cached = state.moduleRegionViews.get(key);
  const dataSignature = JSON.stringify([module.revision, getClient().cacheKey]);
  if (cached?.signature === signature) {
    Object.assign(cached.module, module);
    if (cached.dataSignature !== dataSignature) {
      cached.dataSignature = dataSignature;
      refreshModuleRegions(cached.content);
    }
    return cached.content;
  }
  const content = document.createElement("div"); content.id = `module-${module.id}`; content.className = "module-content";
  cached = { signature, dataSignature, module, content }; state.moduleRegionViews.set(key, cached);
  if (module.description) { const description = document.createElement("p"); description.className = "module-description"; description.textContent = module.description; content.append(description); }
  const pages = modulePages(module);
  const load = (panel, page) => {
    if (page.subtabs) {
      const children = page.regions.map(region => ({ id: region.id, title: region.title.replace(/^全部/, ""), regions: [region] }));
      appendModuleTabs(panel, children, `${key}-${page.id}`, load)();
    } else for (const region of page.regions) panel.append(createModuleRegion(region, cached.module.data, cached.module));
  };
  if (!pages.length) appendModuleEmpty(content, "此模块没有可显示区域。");
  else if (pages.length === 1) {
    let loaded = false;
    content.loadModuleTabs = () => { if (!loaded) { loaded = true; load(content, pages[0]); } else refreshModuleRegions(content); };
  } else content.loadModuleTabs = appendModuleTabs(content, pages, key, load);
  return content;
}

export function renderFeatureModules(payload) {
  const availableModules = Array.isArray(payload?.modules)
    ? [...payload.modules].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0) || String(left.id).localeCompare(String(right.id)))
    : [];
  state.featureModulePayload = payload;
  state.featureModules = availableModules;
  const scopeKey = payload?.sessionId || "no-chat";
  if (state.moduleViewScope !== scopeKey) { state.moduleRegionViews.clear(); state.moduleTabSelections.clear(); state.moduleLayoutSignature = ""; state.moduleViewScope = scopeKey; }
  const layoutSignature = JSON.stringify({ scopeKey, display: savedModuleDisplaySettings(), modules: availableModules.map(({ data, ...module }) => module) });
  if (layoutSignature === state.moduleLayoutSignature) {
    for (const module of availableModules) if (module.available && !module.error) moduleTabbedContent(module, scopeKey);
    return;
  }
  // Moving an active form would lose focus; leave its DOM and unsaved draft in place.
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && document.activeElement.closest?.(".card-module")) return;
  const signature = JSON.stringify({ payload, display: savedModuleDisplaySettings() });
  if (signature === state.featureModuleSignature) return;
  state.moduleLayoutSignature = layoutSignature;
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
    openDefinition.disabled = state.snapshot?.previewMode === true;
    openDefinition.title = openDefinition.disabled ? "开发预览只展示模块外观" : "使用系统默认编辑器打开模块定义文件";
    openDefinition.addEventListener("click", () => openFeatureModuleDocument(module, "definition", openDefinition));
    actions.append(openData, openDefinition);
    heading.append(toggle, actions);
    const content = module.available && !module.error ? moduleTabbedContent(module, scopeKey) : document.createElement("div");
    content.id = contentId;
    content.className = "module-content";
    content.hidden = !expanded;
    if (module.description && (!module.available || module.error)) {
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
      if (expanded) content.loadModuleTabs?.();
    }
    section.append(heading, content);
    fragment.append(section);
  }
  elements.moduleList.replaceChildren(fragment);
  renderModuleSettings();
}

export function syncModuleDisplayDraft() {
  const source = state.moduleDisplayDraft
    ? { order: state.moduleDisplayDraft.order, hidden: [...state.moduleDisplayDraft.hidden] }
    : savedModuleDisplaySettings();
  state.moduleDisplayDraft = normalizeModuleDisplaySettings(source);
}

export function markModuleDisplayDirty() {
  state.moduleDisplayVersion = (state.moduleDisplayVersion || 0) + 1;
  void saveModuleDisplaySettings();
}

export function moveModuleDisplay(moduleId, offset) {
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

export function renderModuleSettings() {
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
  elements.resetModuleSettings.disabled = disabled;
}

export async function saveModuleDisplaySettings(event) {
  event?.preventDefault();
  if (state.moduleDisplaySaving) return;
  syncModuleDisplayDraft();
  state.moduleDisplaySaving = true;
  const retry = document.querySelector("#retry-module-settings");
  retry.hidden = true;
  elements.moduleSettingsStatus.textContent = "保存中……";
  try {
    let savedVersion;
    do {
      savedVersion = state.moduleDisplayVersion;
    const result = await request("/api/v1/module-display-settings", {
      method: "POST",
      body: JSON.stringify({
        order: state.moduleDisplayDraft.order,
        hidden: [...state.moduleDisplayDraft.hidden],
      }),
    });
    state.settings ||= {};
    state.settings.card = result.card;
    if (savedVersion === state.moduleDisplayVersion) state.moduleDisplayDraft = normalizeModuleDisplaySettings(result.card?.settings?.featureModules);
    } while (savedVersion !== state.moduleDisplayVersion);
    state.featureModuleSignature = "";
    renderFeatureModules(state.featureModulePayload || { modules: state.featureModules });
    elements.moduleSettingsStatus.textContent = "已保存到当前角色卡设置；Agent 上下文未改变。";
  } catch (error) {
    elements.moduleSettingsStatus.textContent = `保存失败：${error.message}；修改已保留。`;
    retry.hidden = false;
  } finally {
    state.moduleDisplaySaving = false;
  }
}

export function resetModuleDisplaySettings() {
  state.moduleDisplayDraft = normalizeModuleDisplaySettings({ order: [], hidden: [] });
  markModuleDisplayDirty();
  renderModuleSettings();
}
