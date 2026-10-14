// An independently designed gameplay consumer. Only public client and host contracts.
export async function mount({ container, client, host, signal, assetUrl }) {
  const style = document.createElement("link"); style.rel = "stylesheet"; style.href = assetUrl("stage.css");
  container.append(style);
  const stage = document.createElement("section"); stage.className = "story-stage";
  stage.innerHTML = '<header><h2></h2><button type="button" data-manage>配置与管理</button></header><nav data-openings></nav><article aria-live="polite"></article><nav data-versions></nav><form><label>你的下一步<textarea required></textarea></label><button>继续故事</button></form><aside data-modules></aside><p role="status"></p>';
  container.append(stage);
  const find = selector => stage.querySelector(selector), report = error => find('[role="status"]').textContent = error.message || String(error);
  const card = await client.request("card"); find("h2").textContent = card.name;
  const listen = (node, type, callback) => node.addEventListener(type, callback, { signal });
  listen(find("[data-manage]"), "click", () => host.openManagement("profiles"));
  for (const opening of card.openings) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = opening.title;
    listen(button, "click", async () => { try { await client.chat.opening({ openingId: opening.id, playerName: "玩家" }); } catch (error) { report(error); } });
    find("[data-openings]").append(button);
  }
  let snapshot = null, pendingIntent = null;
  const render = value => {
    snapshot = value;
    find("[data-openings]").hidden = Boolean(value.openingId);
    const narrative = value.messages.filter(message => message.role === "assistant").at(-1);
    find("article").textContent = narrative?.content || "选择开场，进入世界。";
    find("form button").disabled = value.busy || Boolean(client.readContext?.executionId) || !value.openingId;
    find('[role="status"]').textContent = value.busy ? "故事正在继续…" : client.readContext?.executionId ? "正在预览候选版本" : "";
    const versions = find("[data-versions]"); versions.replaceChildren();
    for (const [index, attempt] of (value.narrativeAttempts?.attempts || []).filter(item => item.turn === value.currentTurn && item.hasNarrative).entries()) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = `${index + 1}${attempt.selected ? " · 已采用" : " · 查看"}`;
      listen(button, "click", () => client.preview(attempt.selected ? null : attempt.id));
      versions.append(button);
      if (!attempt.selected && attempt.canAdopt && client.readContext?.executionId === attempt.id) {
        const adopt = document.createElement("button"); adopt.textContent = "采用"; adopt.type = "button";
        listen(adopt, "click", async () => { try { await client.attempts.adopt(attempt.id, { expectedRevision: value.narrativeAttempts.revision }); } catch (error) { report(error); } });
        versions.append(adopt);
      }
    }
  };
  const unwatch = client.watch("state", render, { signal, onError: report });
  listen(find("form"), "submit", async event => {
    event.preventDefault(); const content = find("textarea").value.trim();
    if (!content || snapshot?.busy) return;
    if (pendingIntent?.content !== content) pendingIntent = { content, operationId: crypto.randomUUID() };
    find("form button").disabled = true;
    try { await client.chat.input(pendingIntent); find("textarea").value = ""; pendingIntent = null; }
    catch (error) { report(error); find("form button").disabled = false; }
  });
  const uncertain = new Map();
  const unwatchModules = client.watch("modules", modules => {
    find("[data-modules]").replaceChildren();
    for (const module of modules.modules || []) {
    const binding = module.view.bindings.find(item => item.kind === "settings" && item.fields.some(field => field.type === "boolean"));
    if (!binding || !module.available) continue;
    const field = binding.fields.find(item => item.type === "boolean");
    const button = document.createElement("button"); button.type = "button"; button.textContent = `${module.title} · 切换${field.label}`;
    listen(button, "click", async () => {
      const key = `${module.id}/${binding.id}`;
      button.disabled = true;
      try {
        if (uncertain.has(key)) {
          const operationId = uncertain.get(key);
          const outcome = await client.request(`modules/${encodeURIComponent(module.id)}/bindings/${encodeURIComponent(binding.id)}/operations/${encodeURIComponent(operationId)}`);
          if (!outcome.saved) throw new Error("上次操作结果仍需确认，请检查当前设置后再操作。");
          uncertain.delete(key);
          return;
        }
        const current = await client.modules.settings(module.id, binding.id);
        const operationId = crypto.randomUUID();
        uncertain.set(key, operationId);
        await client.modules.update(module.id, binding.id, { expectedRevision: current.record.revision, operationId, values: { [field.path]: !current.values[field.path] } });
        uncertain.delete(key);
      } catch (error) { if (error.code && error.code !== "operation_outcome_unknown") uncertain.delete(key); report(error); }
      finally { button.disabled = false; }
    });
    find("[data-modules]").append(button);
    }
  }, { signal, intervalMs: 1500, onError: report });
  return { unmount() { unwatch(); unwatchModules(); style.remove(); stage.remove(); }, onContext() { pendingIntent = null; find("textarea").value = ""; }, onVisibility(visible) { stage.dataset.visible = String(visible); } };
}
