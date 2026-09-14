import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function prepareFallbackStoryContext({ run, node, conversation, workspace }) {
  const limit = Number.isSafeInteger(node.metadata?.historyCompleteTurns) ? node.metadata.historyCompleteTurns : 20;
  const visible = conversation.messages.filter(message => (message.binding?.turn || 0) <= (run.visibleThroughTurn ?? run.turn ?? 0));
  const completeTurns = [...new Set(visible.filter(message => message.data?.role === "assistant").map(message => message.binding?.turn).filter(Number.isSafeInteger))].sort((a, b) => a - b).slice(-limit);
  const selected = visible.filter(message => completeTurns.includes(message.binding?.turn));
  const root = resolve(workspace, "deep-story-context");
  await mkdir(root, { recursive: true });
  const story = selected.map(message => `[${message.data?.role || "unknown"}｜turn ${message.binding?.turn || 0}｜${message.id || "unknown"}｜revision ${message.revision || 1}]\n${message.data?.content || ""}`).join("\n\n") || "No complete story turns are available for this opening or configured range.";
  await writeFile(resolve(root, "story.md"), `# Frozen story context\n\n${story}\n`, "utf8");
  await writeFile(resolve(root, "DOCUMENTS.md"), ["# Deep director story context", "", `This directory freezes at most ${limit} complete turns selected when the wrapper starts.`, "", "- `story.md`: required canonical story input.", ""].join("\n"), "utf8");
  return "deep-story-context";
}

export async function execute({ run, node, conversation, data, calls, workspace }) {
  const settings = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "settings", id: "director-settings-current", view: "runtime" });
  const settingsValue = settings?.value?.data || settings?.value || {};
  if (settingsValue.enabled !== true) return { started: false, reason: "director-disabled" };
  const brief = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "private-state", id: "turn-brief-current", view: "director" });
  const recommendation = brief?.value?.deepRecommendation || brief?.value?.data?.deepRecommendation;
  if (!recommendation?.shouldStart) return { started: false, reason: "not-recommended" };
  const state = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-status" });
  const stateValue = state?.value?.data || state?.value || {};
  if (!state || stateValue.status === "running") return { started: false, reason: "already-running" };
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  try {
    const inherited = "trigger/story-context";
    const storyContext = await exists(resolve(workspace, inherited, "DOCUMENTS.md"))
      ? inherited
      : await prepareFallbackStoryContext({ run, node, conversation, workspace });
    const result = await calls.invoke({ workflow: "world-narrative-coordinator/deep-director-planning", arguments: { triggerReasons: recommendation.reasonCodes || [] }, documents: { "story-context": storyContext }, outputPaths: {} });
    return { started: true, childRunId: result.callId, triggerReasons: recommendation.reasonCodes || [] };
  } catch (error) {
    const current = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-status" });
    const value = current?.value?.data || current?.value || {};
    if (current) await data.submit({ protocolVersion: 1, batchId: `${run.id}-deep-fail`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `${run.id}-deep-fail-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: current.id, expectedRevision: current.revision, data: { ...value, status: "failed", currentRunId: null, failure: error instanceof Error ? error.message : String(error) }, note: null }] }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
    throw error;
  }
}
