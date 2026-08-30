export function createOutputDraft({ id, turn, assistantMessageId, userMessage, assistantMessage, moduleIds }) {
  if (!id || !assistantMessageId || !Array.isArray(moduleIds) || moduleIds.length === 0 || new Set(moduleIds).size !== moduleIds.length) {
    throw new Error("An output draft requires an ID, assistant binding, and unique module IDs.");
  }
  return {
    schemaVersion: 1,
    id,
    status: "pending",
    turn,
    assistantMessageId,
    userMessage,
    assistantMessage,
    moduleIds: [...moduleIds],
    decisions: {},
  };
}

export function updateOutputDraft(draft, updates) {
  if (!draft || draft.status !== "pending" || !Array.isArray(draft.moduleIds)) throw new Error("The output draft is not pending.");
  const allowed = new Set(draft.moduleIds);
  const decisions = { ...draft.decisions };
  for (const update of updates) {
    if (!allowed.has(update.moduleId)) throw new Error(`Unknown active output module: ${update.moduleId}`);
    if (update.decision === "emit") {
      if (typeof update.content !== "string" || !update.content.trim()) throw new Error(`Output module ${update.moduleId} requires non-empty content when decision=emit.`);
      decisions[update.moduleId] = { decision: "emit", content: update.content };
    } else if (update.decision === "not_triggered") {
      if (update.content !== undefined) throw new Error(`Output module ${update.moduleId} must omit content when decision=not_triggered.`);
      decisions[update.moduleId] = { decision: "not_triggered" };
    } else {
      throw new Error(`Output module ${update.moduleId} has an invalid decision.`);
    }
  }
  return { ...draft, decisions };
}

export function unresolvedOutputModuleIds(draft) {
  return draft.moduleIds.filter(id => !draft.decisions?.[id]);
}
