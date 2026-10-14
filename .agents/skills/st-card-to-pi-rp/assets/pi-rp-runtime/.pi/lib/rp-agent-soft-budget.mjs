const DEFAULT_BUDGET = Object.freeze({ modelRequests: 16, outputTokens: 12000, elapsedSeconds: 180 });
export const auxiliaryTaskScopePrompt = "辅助任务以当前输入实际涉及的范围为边界。没有发现、没有新增计划、没有修改均可成为有效结果；已有内容仍适用时直接沿用。找不到依据时保留未知，不为填满输出而反复检索、扩大调查或补造解释。只完成原定任务，不因有限结论自动提出续办或重新执行。";

export function resolveAgentSoftBudget(node, workflow) {
  const value = node.metadata?.softBudget;
  if (value === false) return null;
  if (value === undefined) return workflow.kind === "foreground" ? null : DEFAULT_BUDGET;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata.softBudget must be an object or false.");
  const budget = { ...DEFAULT_BUDGET, ...value };
  for (const [field, limit] of Object.entries(budget)) {
    if (!(field in DEFAULT_BUDGET) || !Number.isFinite(limit) || limit <= 0) throw new Error(`Invalid soft budget ${field}.`);
  }
  return budget;
}

// Request-only reminders: no abort, follow-up task, business-result field, or persisted message.
export function createAgentSoftBudget(budget, { now = () => Date.now() } = {}) {
  const startedAt = now();
  let requests = 0;
  let outputTokens = 0;
  const seen = new WeakSet();
  return {
    record(message) {
      if (!message || message.role !== "assistant" || seen.has(message)) return;
      seen.add(message);
      outputTokens += Math.max(0, Number(message.usage?.output) || 0);
    },
    beforeRequest(messages, { foregroundWaiting = false } = {}) {
      requests += 1;
      const elapsedSeconds = Math.max(0, (now() - startedAt) / 1000);
      const used = { modelRequests: requests, outputTokens, elapsedSeconds };
      const ratio = Math.max(...Object.entries(budget).map(([field, limit]) => used[field] / limit));
      if (ratio < 0.8 && !foregroundWaiting) return messages;
      const text = [
        `【当前任务软预算提醒】${foregroundWaiting ? "前台任务正在等待共享资源，请优先收敛当前辅助工作" : ratio >= 1 ? "已达到建议预算" : "预算已趋紧"}：模型请求 ${requests}/${budget.modelRequests}，输出 ${outputTokens}/${budget.outputTokens} token，耗时 ${Math.floor(elapsedSeconds)}/${budget.elapsedSeconds} 秒。`,
        "请缩小探索范围、降低分析深度，优先利用已有信息完成当前任务要求。避免扩展新分支、重复检索和非必要验证；保留完成交付所需的操作与检查。结论应与证据相称，无依据的内容可以不新增。",
        "按原定格式完成全部必需交付；不要因预算原因生成待办、续办请求或建议重新执行本任务。预算状态只用于调整当前工作方式，不写入业务结果。真正缺少必要条件或执行失败仍按既定机制报告，不编造结果。",
      ].join("\n");
      return [...messages, { role: "user", content: [{ type: "text", text }], timestamp: now() }];
    },
  };
}

export function agentSoftBudgetExtension(node, workflow, isForegroundWaiting = () => false) {
  const budget = resolveAgentSoftBudget(node, workflow);
  if (!budget) return [];
  return [{ name: "rp-agent-soft-budget", hidden: true, factory(pi) {
    const controller = createAgentSoftBudget(budget);
    pi.on("message_end", event => controller.record(event.message));
    pi.on("context", event => ({ messages: controller.beforeRequest(event.messages, { foregroundWaiting: isForegroundWaiting() }) }));
  } }];
}
