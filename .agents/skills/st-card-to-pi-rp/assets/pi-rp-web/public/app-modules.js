// 模块区域渲染（实施方案 §11 第 6 条：按职责提取的原生模块之一）。
//
// 负责：模块列表与显示顺序设置、模块记录/故事/设置/创作要求/归档状态/工作流控制的区域渲染，
// 以及区域分发中枢 `createModuleRegion`。
//
import { renderMarkdown } from "./markdown.js?v=4";
import { buildModuleJsonTree } from "./module-json.js?v=2";
import { composePromptPreview, selectionsFromValues, valuesFromSelections } from "./prompt-controls.js?v=1";
import { renderImageGenerationRegion } from "./app-image.js?v=1";
import { appendModuleEmpty, componentReference, elements, modelPresets, request, showError, state } from "./app-context.js";

export function toggleCardModule(button) {
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
    for (const option of field.options || []) input.append(new Option(option, option));
  } else {
    input = document.createElement("input");
    input.type = field.type === "boolean" ? "checkbox" : ["integer", "number"].includes(field.type) ? "number" : "text";
    if (field.type === "integer") input.step = "1";
    if (field.minimum != null) input.min = String(field.minimum);
    if (field.maximum != null) input.max = String(field.maximum);
  }
  input.dataset.fieldPath = field.path || `/${field.name}`;
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
      const payload = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/records/${encodeURIComponent(recordId)}/history${suffix}`);
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
  const cursors = [null]; let page = 0;
  async function loadPage(reset = false) {
    if (reset) { cursors.splice(0, cursors.length, null); page = 0; }
    results.replaceChildren(); appendModuleEmpty(results, "正在读取记录……"); previous.disabled = true; next.disabled = true;
    const params = new URLSearchParams(); if (cursors[page]) params.set("cursor", cursors[page]); if (search.value.trim()) params.set("search", search.value.trim());
    for (const { filter, input } of filterInputs) if (input.value !== "") params.set(`filter.${filter.id}`, input.value);
    try {
      const payload = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/records?${params}`);
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
    } catch (error) { results.replaceChildren(); appendModuleEmpty(results, error.message); pageLabel.textContent = "读取失败"; }
  }
  controls.addEventListener("submit", event => { event.preventDefault(); void loadPage(true); });
  previous.addEventListener("click", () => { if (page > 0) { page -= 1; void loadPage(); } });
  next.addEventListener("click", () => { if (cursors[page + 1]) { page += 1; void loadPage(); } });
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
  let cursor = null; let items = [];
  const valueOf = (value, key) => value?.[key] ?? value?.[key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)] ?? null;
  async function load(reset = false) {
    if (reset) { cursor = null; items = []; results.replaceChildren(); }
    more.disabled = true;
    try {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/records${suffix}`);
      items.push(...(payload.items || [])); cursor = payload.nextCursor || null;
      const ordered = mode.value === "series" ? [...items].sort((a, b) => String(valueOf(a.value, "seriesId") || "").localeCompare(String(valueOf(b.value, "seriesId") || "")) || Number(valueOf(a.value, "sequence") || 0) - Number(valueOf(b.value, "sequence") || 0)) : [...items];
      results.replaceChildren();
      for (const item of ordered) {
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
          try { const story = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/stories/${encodeURIComponent(item.id)}`); full.replaceChildren(); appendInteractiveValue(full, story.value); full.hidden = false; read.textContent = "收起全文"; }
          catch (error) { full.replaceChildren(); appendModuleEmpty(full, error.message); full.hidden = false; }
          finally { read.disabled = false; }
        });
        actions.append(read);
        if (region.allowOpenAuthoritySource) { const source = document.createElement("button"); source.type = "button"; source.className = "module-file-button"; source.textContent = "打开源文件"; source.title = "高级 DIY：直接编辑将绕过版本、索引、归档和一致性保障"; source.addEventListener("click", async () => { source.disabled = true; try { await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/stories/${encodeURIComponent(item.id)}/open-source`, { method: "POST", body: "{}" }); } catch (error) { showError(error); } finally { source.disabled = false; } }); actions.append(source); }
        article.append(heading, summary, cast, actions, full); results.append(article);
      }
      if (!items.length) appendModuleEmpty(results, region.empty || "暂无故事。");
      more.hidden = !cursor; more.disabled = !cursor;
    } catch (error) { appendModuleEmpty(results, error.message); more.hidden = true; }
  }
  mode.addEventListener("change", () => { void load(true); }); more.addEventListener("click", () => { void load(false); });
  await load(true);
}

export async function renderSettingsFormRegion(section, module, region) {
  appendModuleEmpty(section, "正在读取设置……");
  try {
    const payload = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/settings`);
    section.replaceChildren();
    if (region.title) { const title = document.createElement("h4"); title.textContent = region.title; section.append(title); }
    if (region.description) { const description = document.createElement("p"); description.className = "module-description"; description.textContent = region.description; section.append(description); }
    const form = document.createElement("form"); form.className = "module-settings-form";
    const inputs = [];
    for (const field of region.fields || []) { const built = createDeclaredField(field, payload.values?.[field.path]); inputs.push({ field, input: built.input }); form.append(built.label); }
    const action = document.createElement("div"); action.className = "module-interactive-actions";
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = region.submitLabel || "保存设置";
    const status = document.createElement("span"); status.className = "setting-status"; action.append(submit, status); form.append(action); section.append(form);
    form.addEventListener("submit", async event => {
      event.preventDefault(); submit.disabled = true; status.textContent = "保存中……";
      try {
        const values = Object.fromEntries(inputs.map(({ field, input }) => [field.path, declaredInputValue(input, field)]));
        await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/settings`, { method: "PUT", body: JSON.stringify({ expectedRevision: payload.record.revision, values }) });
        status.textContent = "已保存"; await renderSettingsFormRegion(section, module, region);
      } catch (error) { status.textContent = `保存失败：${error.message}`; submit.disabled = false; }
    });
  } catch (error) { section.replaceChildren(); appendModuleEmpty(section, error.message); }
}

export async function renderPromptControlsRegion(section, module, region) {
  appendModuleEmpty(section, "正在读取创作要求……");
  try {
    const endpoint = `/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/settings`;
    const payload = await request(endpoint);
    const controls = payload.controls || { groups: [] };
    const groups = Array.isArray(controls.groups) ? controls.groups : [];
    const draftKey = JSON.stringify([state.featureModulePayload?.sessionId, module.id, region.id]);
    let draft = state.promptControlDrafts.get(draftKey);
    if (!draft?.dirty && !draft?.saving) {
      draft = { selections: selectionsFromValues(controls, payload.values), revision: payload.record.revision, dirty: false, saving: false, error: "" };
      state.promptControlDrafts.set(draftKey, draft);
    }
    const selections = draft.selections;

    section.replaceChildren();
    if (region.title) { const title = document.createElement("h4"); title.textContent = region.title; section.append(title); }
    if (region.description) { const description = document.createElement("p"); description.className = "module-description"; description.textContent = region.description; section.append(description); }

    const form = document.createElement("form");
    form.className = "module-prompt-controls-form";
    const groupViews = [];
    const previewBody = document.createElement("div");
    previewBody.className = "prompt-control-preview-body";

    const renderPreview = () => {
      previewBody.replaceChildren();
      const preview = composePromptPreview(controls, selections);
      if (!preview.length) {
        appendModuleEmpty(previewBody, "暂未选择创作要求。");
        return;
      }
      for (const item of preview) {
        const article = document.createElement("article");
        article.className = "prompt-control-preview-item";
        const title = document.createElement("h6");
        title.textContent = item.title;
        article.append(title);
        appendModuleValue(article, item.content, "markdown");
        previewBody.append(article);
      }
    };

    for (const group of groups) {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "prompt-control-group";
      const legend = document.createElement("legend");
      legend.textContent = group.title || group.id;
      fieldset.append(legend);
      if (group.description) {
        const description = document.createElement("p");
        description.className = "prompt-control-description";
        description.textContent = group.description;
        fieldset.append(description);
      }

      const segmented = document.createElement("div");
      segmented.className = "prompt-control-segmented";
      segmented.setAttribute("role", "radiogroup");
      segmented.setAttribute("aria-label", group.title || group.id);
      const customLabel = document.createElement("label");
      customLabel.className = "prompt-control-custom";
      const customTitle = document.createElement("span");
      customTitle.textContent = "自定义文本";
      const customInput = document.createElement("textarea");
      customInput.maxLength = 50000;
      customInput.placeholder = "输入本组创作要求……";
      customInput.value = selections[group.id]?.customText || "";
      customLabel.append(customTitle, customInput);
      const options = [];

      const updateGroup = () => {
        const selectedId = selections[group.id]?.optionId;
        for (const { option, input, label } of options) {
          const selected = option.id === selectedId;
          input.checked = selected;
          label.classList.toggle("is-selected", selected);
        }
        const customSelected = selectedId === "custom";
        customLabel.hidden = !customSelected;
        customInput.disabled = !customSelected;
        customInput.setAttribute("aria-hidden", String(!customSelected));
        renderPreview();
      };

      for (const option of Array.isArray(group.options) ? group.options : []) {
        const label = document.createElement("label");
        label.className = "prompt-control-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.className = "sr-only";
        input.name = `prompt-${module.id}-${region.id}-${group.id}`;
        input.value = option.id;
        input.checked = option.id === selections[group.id]?.optionId;
        input.addEventListener("change", () => {
          selections[group.id].optionId = input.value;
          draft.dirty = true;
          draft.error = "";
          updateGroup();
        });
        const copy = document.createElement("span");
        copy.textContent = option.label || option.id;
        label.append(input, copy);
        segmented.append(label);
        options.push({ option, input, label });
      }
      customInput.addEventListener("input", () => {
        selections[group.id].customText = customInput.value;
        draft.dirty = true;
        draft.error = "";
        renderPreview();
      });
      customLabel.hidden = selections[group.id]?.optionId !== "custom";
      customInput.disabled = customLabel.hidden;
      customInput.setAttribute("aria-hidden", String(customLabel.hidden));
      fieldset.append(segmented, customLabel);
      form.append(fieldset);
      groupViews.push({ updateGroup, fieldset });
    }

    const preview = document.createElement("section");
    preview.className = "prompt-control-preview";
    preview.setAttribute("aria-live", "polite");
    const previewTitle = document.createElement("h5");
    previewTitle.className = "prompt-control-preview-title";
    previewTitle.textContent = controls.title || "创作要求";
    preview.append(previewTitle, previewBody);
    form.append(preview);

    const action = document.createElement("div");
    action.className = "module-interactive-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = `保存${controls.title || "创作要求"}`;
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "secondary-button";
    reload.textContent = "重新读取";
    reload.hidden = true;
    const status = document.createElement("span");
    status.className = "setting-status";
    action.append(submit, reload, status);
    form.append(action);
    section.append(form);
    for (const view of groupViews) view.updateGroup();

    const updateSaving = () => {
      submit.disabled = draft.saving;
      for (const view of groupViews) view.fieldset.disabled = draft.saving;
      status.textContent = draft.saving ? "保存中……" : draft.error;
      reload.hidden = !draft.error;
    };
    updateSaving();

    reload.addEventListener("click", () => {
      reload.disabled = true;
      state.promptControlDrafts.delete(draftKey);
      void renderPromptControlsRegion(section, module, region);
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (draft.saving) return;
      draft.saving = true;
      draft.error = "";
      updateSaving();
      try {
        await request(endpoint, {
          method: "PUT",
          body: JSON.stringify({ expectedRevision: draft.revision, values: valuesFromSelections(controls, selections) }),
        });
        state.promptControlDrafts.delete(draftKey);
        await renderPromptControlsRegion(section, module, region);
      } catch (error) {
        const conflict = error.status === 409 || /revision|conflict/i.test(error.message || "");
        draft.error = conflict
          ? "保存冲突：当前聊天设置已经更新，草稿仍保留。点击“重新读取”会放弃草稿。"
          : `保存失败：${error.message}`;
        draft.saving = false;
        updateSaving();
      }
    });
  } catch (error) {
    section.replaceChildren();
    appendModuleEmpty(section, error.message);
  }
}

export async function renderIntegrityAlertsRegion(section, module, region) {
  appendModuleEmpty(section, "正在检查归档状态……");
  try {
    const payload = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/integrity`);
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
          const result = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(action.workflowRegionId)}/workflows/${encodeURIComponent(action.workflowId)}/run`, { method: "POST", body: JSON.stringify({ payload: workflowPayload }) });
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
      const payload = await request("/api/workflow-runs");
      const allowed = new Set((region.workflows || []).map(item => componentReference(module.id, item.id)));
      const runs = (payload.runs || []).filter(run => allowed.has(runWorkflowReference(run))).slice(-8).reverse();
      const fragment = document.createDocumentFragment();
      for (const run of runs) {
        const row = document.createElement("div"); row.className = "module-workflow-run";
        const label = document.createElement("span"); label.textContent = `${run.workflowTitle || run.workflowId} · ${run.status}`; row.append(label);
        if (!["completed", "skipped", "failed", "cancelled"].includes(run.status) && run.live !== false) {
          const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "module-file-button"; cancel.textContent = "取消";
          cancel.addEventListener("click", async () => { cancel.disabled = true; try { await request(`/api/workflow-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }); await refreshStatus(); } catch (error) { showError(error); cancel.disabled = false; } });
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
        const result = await request(`/api/modules/${encodeURIComponent(module.id)}/regions/${encodeURIComponent(region.id)}/workflows/${encodeURIComponent(workflow.id)}/run`, { method: "POST", body: JSON.stringify({ payload }) });
        status.textContent = `已启动：${result.run?.id || workflow.id}（${result.run?.status || "pending"}）`; await refreshStatus();
      } catch (error) { status.textContent = `启动失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    section.append(form);
  }
  section.append(status);
  await refreshStatus();
}

export function createModuleRegion(region, data, module = null) {
  const section = document.createElement("section");
  section.className = `module-region module-region-${region.type || "text"}`;
  if (region.title) {
    const title = document.createElement("h4");
    title.textContent = region.title;
    section.append(title);
  }
  const value = valueAtPath(data, region.path);

  if (region.spoiler) section.classList.add("module-region-spoiler");
  if (region.type === "record-browser") { appendModuleEmpty(section, "正在载入分页档案……"); void renderRecordBrowserRegion(section, module, region); return section; }
  if (region.type === "story-browser") { appendModuleEmpty(section, "正在载入故事目录……"); section.querySelector(".module-empty")?.remove(); void renderStoryBrowserRegion(section, module, region); return section; }
  if (region.type === "settings-form") { void renderSettingsFormRegion(section, module, region); return section; }
  if (region.type === "prompt-controls") { void renderPromptControlsRegion(section, module, region); return section; }
  if (region.type === "integrity-alerts") { void renderIntegrityAlertsRegion(section, module, region); return section; }
  if (region.type === "workflow-controls") { void renderWorkflowControlsRegion(section, module, region); return section; }

  if (region.type === "image-generation") {
    appendModuleEmpty(section, "正在读取生图配置……");
    void renderImageGenerationRegion(section);
    return section;
  }

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

export function renderFeatureModules(payload) {
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
    openDefinition.disabled = state.snapshot?.previewMode === true;
    openDefinition.title = openDefinition.disabled ? "开发预览只展示模块外观" : "使用系统默认编辑器打开模块定义文件";
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
      for (const region of regions) content.append(createModuleRegion(region, module.data, module));
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
  elements.moduleSettingsStatus.textContent = "尚未保存；这些调整只影响前端功能区。";
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
  elements.saveModuleSettings.disabled = disabled;
  elements.resetModuleSettings.disabled = disabled;
}

export async function saveModuleDisplaySettings(event) {
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

export function resetModuleDisplaySettings() {
  state.moduleDisplayDraft = normalizeModuleDisplaySettings({ order: [], hidden: [] });
  markModuleDisplayDirty();
  elements.moduleSettingsStatus.textContent = "已恢复卡片默认显示，保存后生效。";
  renderModuleSettings();
}
