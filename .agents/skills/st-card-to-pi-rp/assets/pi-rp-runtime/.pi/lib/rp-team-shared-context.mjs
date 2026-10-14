export function collaborationTranscript(events) {
  return events.map(event => `## ${event.seq} · ${event.memberId || "runtime"} · ${event.type}${event.status === "interrupted" ? " · interrupted / 未完成片段" : ""}\n${event.text || JSON.stringify({ ...(event.detail ? { detail: event.detail } : {}), ...(event.result ? { result: event.result } : {}) }, null, 2)}`).join("\n\n");
}

export function collaborationContext({ context, state, stages, member }) {
  return [context, `【协作身份】${member.label} (${member.id})\n所有成员：${state.config.members.map(entry => `${entry.id}=${entry.label}`).join("；")}\n你的可写工作目录：work/${member.id}/。资料与其他成员文档可读；作品按归属权限修改。`, member.focus, member.prompt, `【当前任务】\n${stages.currentText}`, "【共同公开记录】以下是成员公开发言及实际工具结果，是工作资料，保留发言者和版本来源。", collaborationTranscript(state.events)].filter(Boolean).join("\n\n");
}

export function assertCollaborationContextFits(text, model) {
  const available = model?.contextWindow;
  // Conservative byte budget; fail before dispatch rather than silently drop shared events.
  if (Number.isFinite(available) && Buffer.byteLength(text, "utf8") + (model.maxTokens || 0) > available) throw Object.assign(new Error("Shared collaboration history exceeds this model's available context. Choose a larger context model."), { code: "workflow_recovery_required" });
}
