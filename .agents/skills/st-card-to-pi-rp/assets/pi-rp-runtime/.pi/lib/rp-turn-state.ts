// 回合状态观测（S5 批次 4b）。
//
// 这些函数只**观察**会话与工作流的当前状态：读消息、读引擎快照、组装 Web 快照。
// 它们不改写状态、不写文件，因此可以脱离真实 Pi 会话测试（见 rp-turn-state.test.mjs）。
//
// 关键契约：Web 快照必须始终带上页面依赖的字段（例如"上一回合没有产出正文"的说明），
// 且**只有**当该失败属于当前聊天时才上报——否则玩家切到别的聊天还会看到旧失败的提示。
//
// 从 `../extensions/pi-rp-web.ts` 的闭包中搬出；除 `webSnapshot` 改为把 `active` 与
// `isolatedRuntime` 作为参数传入之外，逻辑与文案未改写。
import type { ActiveBridge, WebMessage, RecordEnvelope } from "./rp-host-types.ts";

import { validateRecordEnvelope } from "./rp-records.mjs";

export { blockingTurnWorkflows, bridgeBusy, latestCompletedTurn, recordToWebMessage, recordsToWebMessages, unfinishedWorkflowRunCount, webSnapshot };

function recordToWebMessage(record: RecordEnvelope): WebMessage {
const value = validateRecordEnvelope(record) as RecordEnvelope;
if (value.source !== "messages" || !["user", "assistant"].includes(value.data.role) || !["opening", "message"].includes(value.data.kind) || typeof value.data.content !== "string") {
  throw new Error(`Message record ${value.id} has invalid message data.`);
}
return {
  sequence: value.sequence,
  turn: value.binding.turn,
  role: value.data.role,
  kind: value.data.kind,
  content: value.data.content,
  createdAt: value.createdAt,
  ...(value.revision > 1 ? { editedAt: value.updatedAt } : {}),
};
}

function recordsToWebMessages(records: RecordEnvelope[]) {
return records.map(recordToWebMessage);
}

function latestCompletedTurn(target: ActiveBridge) {
  return target.messages.reduce((maximum, message) => message.data.role === "assistant" ? Math.max(maximum, message.binding.turn) : maximum, 0);
}

function blockingTurnWorkflows(target: ActiveBridge | null) {
  return target?.workflowEngine?.blockingTurnRuns?.() || [];
}

function bridgeBusy(target: ActiveBridge) {
  return target.pending || !target.context.isIdle() || target.workflowEngine?.hasBlockingTurnRun?.() === true;
}

function unfinishedWorkflowRunCount(target: ActiveBridge | null) {
  return target?.workflowEngine?.snapshot?.().filter((run: any) =>
    !["completed", "skipped", "failed", "cancelled"].includes(run.status) || run.terminalFinalization?.status === "pending" || run.terminalFinalization?.status === "running"
  ).length || 0;
}

function webSnapshot(active: ActiveBridge | null, isolatedRuntime: boolean, extra: Record<string, unknown> = {}) {
  const failure = active?.lastTurnFailure || null;
  return {
    sessionId: active?.recordId || null,
    openingId: active?.openingId || null,
    playerName: active?.playerName || "玩家",
    messages: active ? recordsToWebMessages(active.messages) : [],
    busy: active ? bridgeBusy(active) : false,
    blockingWorkflows: blockingTurnWorkflows(active),
    activeWorkflowRuns: unfinishedWorkflowRunCount(active),
    selectorUrl: isolatedRuntime ? process.env.BOBO_RP_LAUNCHER_URL || null : null,
    isolatedRuntime,
    lastTurnFailure: failure && failure.recordId === (active?.recordId || null) ? failure : null,
    ...extra,
  };
}
