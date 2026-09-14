import { queryAll } from "../lib/data-helpers.mjs";
import { SUMMARY_LIMITS } from "../lib/core.mjs";

function textForMessage(message) {
  const role = message?.data?.role === "user" ? "玩家输入" : "正文";
  const source = message?.metadata?.narrativeSource || {};
  const layer = { "in-world": "世界内陈述", story: "故事层", authorial: "作者层", unspecified: "来源层未指定" }[source.layer] || "来源层未指定";
  return `[${role}｜第${message?.binding?.turn ?? 0}轮｜${message?.id || "unknown"}｜${layer}]\n${message?.data?.content || ""}`;
}

async function supportRecord(data, id) {
  const item = await data.get({ moduleId: "narrative-memory", collectionId: "support", id, view: "archive" });
  if (!item) throw new Error(`Missing narrative-memory support record ${id}.`);
  return { id: item.id, revision: item.revision, data: item.value };
}

export async function execute({ run, conversation, data }) {
  const request = run.arguments?.request || {};
  const startTurn = Number(request.startTurn);
  const endTurn = Number(request.endTurn);
  const operation = request.operation;
  const userInstruction = typeof request.focus === "string" && request.focus.trim() ? request.focus.trim().slice(0, 5000) : null;
  if (!Number.isSafeInteger(startTurn) || !Number.isSafeInteger(endTurn) || startTurn < 1 || endTurn < startTurn) throw new Error("Range repair requires a valid positive startTurn/endTurn range.");
  if (!["repair", "supplement"].includes(operation)) throw new Error("Range repair operation must be repair or supplement.");
  const latestCompletedTurn = conversation.messages.reduce((maximum, message) => message?.data?.role === "assistant" ? Math.max(maximum, message.binding?.turn || 0) : maximum, 0);
  if (endTurn > latestCompletedTurn) throw new Error(`Range repair cannot include unfinished or future turn ${endTurn}; latest completed turn is ${latestCompletedTurn}.`);
  const settingsRecord = await supportRecord(data, "narrative-memory-settings");
  const archiveState = await supportRecord(data, "narrative-memory-archive-state");
  const referenceFirst = Math.max(0, startTurn - settingsRecord.data.archive.referenceEarlierTurns);
  const referenceMessages = conversation.messages.filter(message => (message.binding?.turn || 0) >= referenceFirst && (message.binding?.turn || 0) < startTurn);
  const archiveMessages = conversation.messages.filter(message => (message.binding?.turn || 0) >= startTurn && (message.binding?.turn || 0) <= endTurn);
  if (!archiveMessages.length) throw new Error("The selected range contains no messages in the current story branch.");
  const coveredTurns = new Set(archiveMessages.map(message => message.binding?.turn).filter(Number.isSafeInteger));
  for (let turn = startTurn; turn <= endTurn; turn += 1) if (!coveredTurns.has(turn)) throw new Error(`The current story branch has no message for selected turn ${turn}.`);
  const captureCandidates = await queryAll(data, { moduleId: "narrative-memory", collectionId: "source-captures", recordTypes: ["memory.source-capture"], where: { capturedTurn: { gte: startTurn } }, view: "archive" });
  const captures = captureCandidates.filter(item => (item.value?.capturedTurn ?? -1) <= endTurn);
  const overLimit = [];
  for (const [collectionId, recordTypes] of Object.entries({ entities: ["memory.entity"], relationships: ["memory.relationship"], events: ["memory.event", "memory.event-summary"], cognitions: ["memory.cognition"], "knower-groups": ["memory.knower-group"] })) {
    const items = await queryAll(data, { moduleId: "narrative-memory", collectionId, recordTypes, where: { summaryOverLimit: { eq: true } }, view: "archive" });
    for (const item of items) overLimit.push({ id: item.id, recordType: item.recordType, maximumCharacters: SUMMARY_LIMITS[item.recordType] });
  }
  const lastMessage = [...archiveMessages].reverse().find(message => message.data?.role === "assistant") || archiveMessages.at(-1);
  return {
    schemaVersion: 1,
    shouldArchive: true,
    operation,
    userInstruction,
    firstTurn: startTurn,
    eligibleLastTurn: endTurn,
    lastCoveredMessageId: lastMessage.id,
    coveredMessageIds: archiveMessages.map(message => message.id),
    sourceMessageIds: [...referenceMessages, ...archiveMessages].map(message => message.id),
    settingsRecord,
    archiveState,
    context: {
      "本次任务类型": operation === "repair" ? "复核并修复所选范围" : "重新审视并补充所选范围",
      "用户补充要求": userInstruction || "无",
      "以下为早期剧情，作为参考": referenceMessages.map(textForMessage).join("\n\n") || "无",
      "以下为本次处理的剧情": archiveMessages.map(textForMessage).join("\n\n"),
      "以下为本次处理范围的其他模块资料": captures.map(item => item.value).filter(Boolean),
    },
    overLimitSummaryTasks: overLimit,
  };
}
