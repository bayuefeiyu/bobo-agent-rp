import { request, watch, getClient } from "./app-context.js";

const labels = { running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消" };
const text = value => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const tokens = usage => usage ? `输入 ${usage.input.toLocaleString()} / 输出 ${usage.output.toLocaleString()} / 缓存读 ${usage.cacheRead.toLocaleString()} / 缓存写 ${usage.cacheWrite.toLocaleString()} / 合计 ${usage.totalTokens.toLocaleString()} token` : "token 用量：未提供";
function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function button(label, action) {
  const node = element("button", label); node.type = "button"; node.addEventListener("click", action); return node;
}

export async function openCallRecords(run, node) {
  const dialog = element("dialog", null, "call-record-dialog");
  const header = element("header", null, "call-record-header");
  const heading = element("div");
  heading.append(element("strong", `${run.workflowTitle || run.workflowId} · ${node.title || node.id}`), element("code", `${run.workflowId} / ${node.id}`));
  header.append(heading, button("关闭", () => dialog.close()));
  const totals = element("p", "正在加载……", "call-record-total");
  const filters = element("div", null, "call-record-controls");
  const attempt = element("select"), member = element("select");
  attempt.setAttribute("aria-label", "执行尝试"); member.setAttribute("aria-label", "团队成员");
  filters.append(attempt, member);
  const navigation = element("nav", null, "call-record-controls");
  let data = null, selectedId = null, tab = "response", closed = false, generation = 0, loading = 0, contentSignature = "";
  const filtered = () => (data?.calls || []).filter(call => (!attempt.value || String(call.attempt) === attempt.value) && (!member.value || call.memberId === member.value));
  const previous = button("上一调用", () => move(-1));
  const counter = element("span");
  const next = button("下一调用", () => move(1));
  const latest = button("最新调用", () => choose(filtered().at(-1)?.id));
  navigation.append(previous, counter, next, latest);
  const metadata = element("p", null, "call-record-metadata"), usage = element("p", null, "call-record-usage");
  const tabs = element("div", null, "call-record-tabs");
  const content = element("section", null, "call-record-content");
  const tabButtons = new Map();
  for (const [id, label] of [["request", "请求内容"], ["response", "模型响应"], ["tools", "工具执行"], ["result", "最终结果"]]) {
    const control = button(label, () => { tab = id; render(); }); tabButtons.set(id, control); tabs.append(control);
  }
  dialog.append(header, totals, filters, navigation, metadata, usage, tabs, content);
  document.body.append(dialog);
  dialog.showModal();
  const url = `/api/v1/workflow-runs/${encodeURIComponent(run.id)}/nodes/${encodeURIComponent(node.id)}/process-record`;
  function options(select, values, all) {
    const old = select.value;
    select.replaceChildren(element("option", all)); select.children[0].value = "";
    for (const [value, label] of values) { const option = element("option", label); option.value = value; select.append(option); }
    select.value = values.some(([value]) => value === old) ? old : "";
  }
  function section(title, value, expanded = false) {
    const detail = element("details"); detail.open = expanded;
    detail.append(element("summary", title), element("pre", text(value))); content.append(detail);
  }
  function render() {
    if (!data) return;
    totals.textContent = `节点累计：${tokens(data.usage)}${data.usageComplete === false ? " · 部分调用用量未提供" : ""}`;
    const calls = filtered(), index = calls.findIndex(call => call.id === selectedId), call = data.selectedCall;
    counter.textContent = calls.length ? `第 ${index + 1} / ${calls.length} 次调用` : "没有逐次调用记录";
    previous.disabled = index <= 0; next.disabled = index < 0 || index >= calls.length - 1; latest.disabled = index === calls.length - 1 || !calls.length;
    const seconds = call?.endedAt ? Math.max(0, (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000).toFixed(1) : null;
    metadata.textContent = call ? `${call.agentId || "Agent"} · ${call.modelId || call.providerModel} · ${labels[call.status] || call.status}${seconds ? ` · ${seconds} 秒` : ""}${call.error ? ` · ${call.error}` : ""}` : "";
    usage.textContent = call ? tokens(call.usage) : "";
    for (const [id, control] of tabButtons) { control.classList.toggle("active", id === tab); control.setAttribute("aria-pressed", String(id === tab)); }
    const signature = JSON.stringify([tab, call, data.legacy, tab === "result" ? data.result : null]);
    if (signature === contentSignature) return;
    contentSignature = signature; content.replaceChildren();
    if (tab === "result") { content.append(element("pre", data.result == null ? "尚无节点最终结果。" : text(data.result))); return; }
    if (!call) { content.append(element("p", data.legacy ? "旧版记录：仅含末次消息片段，无法恢复此前调用及逐次用量。" : "尚未产生模型调用记录。")); if (data.legacy) content.append(element("pre", data.legacy)); return; }
    if (tab === "request") {
      if (call.request?.systemPrompt) section("系统提示", call.request.systemPrompt);
      for (const [index, message] of (call.request?.messages || []).entries()) section(`消息 ${index + 1} · ${message.role}${message.toolName ? ` · ${message.toolName}` : ""}`, message.role === "system" ? message : message.content, index === call.request.messages.length - 1);
      if (call.request?.tools) section("可用工具定义", call.request.tools);
    } else if (tab === "response") {
      for (const block of call.response?.content || []) {
        if (block.type === "text") content.append(element("pre", block.text));
        else if (block.type === "thinking") section("推理内容（供应商返回）", block.thinking);
        else section(block.type === "toolCall" ? `工具调用 · ${block.name}` : block.type, block.arguments || block);
      }
      if (!call.response) content.append(element("p", call.status === "running" ? "模型正在生成，完成后显示响应。" : "未获得模型响应。"));
    } else {
      for (const event of call.tools || []) section(`${event.toolName || "工具"} · ${event.type === "tool_execution_start" ? "开始" : event.isError ? "失败" : "完成"}`, event.args ?? event.result ?? event, true);
      if (!call.tools?.length) content.append(element("p", "本次调用没有工具执行记录。"));
    }
  }
  async function load(id = selectedId, background = false) {
    if (background && loading) return;
    const ticket = ++generation;
    loading = ticket;
    selectedId = id || null;
    try {
      const query = [id ? `callId=${encodeURIComponent(id)}` : "", background ? "summaryOnly=1" : ""].filter(Boolean).join("&");
      const value = await request(url + (query ? `?${query}` : ""));
      if (closed || ticket !== generation) return;
      if (background) {
        const old = data?.calls.find(call => call.id === id), updated = value.calls.find(call => call.id === id);
        if (!data?.selectedCall && value.calls.length || JSON.stringify(old) !== JSON.stringify(updated) || data?.status !== value.status) {
          loading = 0;
          await load(id);
          return;
        }
        value.selectedCall = data.selectedCall; value.legacy = data.legacy; value.result = data.result;
      }
      data = value; selectedId = value.selectedCall?.id || null;
      options(attempt, [...new Set(data.calls.map(call => String(call.attempt)))].map(value => [value, `第 ${value} 次尝试`]), "全部尝试");
      options(member, [...new Set(data.calls.map(call => call.memberId).filter(Boolean))].map(value => [value, value]), "全部成员");
      attempt.hidden = attempt.children.length <= 2; member.hidden = member.children.length <= 1;
      render();
    } catch (error) { if (!closed && ticket === generation) { totals.textContent = `读取失败：${error.message}`; } }
    finally { if (loading === ticket) loading = 0; }
  }
  async function choose(id) { if (id) await load(id); }
  function move(offset) { const calls = filtered(); const index = calls.findIndex(call => call.id === selectedId); return choose(calls[index + offset]?.id); }
  for (const select of [attempt, member]) select.addEventListener("change", () => {
    const id = filtered().at(-1)?.id;
    if (id) choose(id); else { selectedId = null; data.selectedCall = null; render(); }
  });
  await load();
  const stop = watch(`${url}?summaryOnly=1`, () => load(selectedId, true), { intervalMs: 1500, visible: () => !document.hidden });
  const offContext = getClient().onContext(() => dialog.close());
  const close = () => dialog.close();
  window.addEventListener("pagehide", close, { once: true });
  dialog.addEventListener("close", () => { closed = true; generation++; stop(); offContext(); window.removeEventListener("pagehide", close); dialog.remove(); }, { once: true });
  return dialog;
}
