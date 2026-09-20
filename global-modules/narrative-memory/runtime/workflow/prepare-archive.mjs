import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { queryAll } from "../lib/data-helpers.mjs";
import { SUMMARY_LIMITS } from "../lib/core.mjs";

async function sourceGuidance(moduleDirectory, captures, services) {
  if (!moduleDirectory) return [];
  const registryPath = resolve(moduleDirectory, "config", "archive-sources", "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const sourceIds = new Set(captures.map(item => item.value?.sourceModuleId).filter(Boolean));
  const result = [];
  for (const source of registry.sources || []) {
    if (!sourceIds.has(source.sourceModuleId) || !source.guidanceFile) continue;
    const guidancePath = resolve(moduleDirectory, source.guidanceFile);
    const relation = relative(moduleDirectory, guidancePath);
    if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error(`Archive source guidance escapes narrative-memory: ${source.guidanceFile}`);
    result.push({ sourceModuleId: source.sourceModuleId, adapterId: source.id, guidance: services.cardText.render(await readFile(guidancePath, "utf8"), guidancePath) });
  }
  return result;
}

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

export async function execute({ run, conversation, data, module, services }) {
  const settingsRecord = await supportRecord(data, "narrative-memory-settings");
  const archiveState = await supportRecord(data, "narrative-memory-archive-state");
  const settings = settingsRecord.data.archive;
  const currentTurn = Math.max(run.turn || 0, ...conversation.messages.map(message => message.binding?.turn || 0));
  const protect = run.arguments?.request?.forceProtected === true ? 0 : settings.protectRecentTurns;
  const eligibleLastTurn = Math.max(0, currentTurn - protect);
  const firstTurn = archiveState.data.lastArchivedTurn + 1;
  const eligibleCount = Math.max(0, eligibleLastTurn - firstTurn + 1);
  const manual = run.trigger?.type === "manual";
  const shouldArchive = settings.enabled && eligibleCount > 0 && (manual || eligibleCount >= settings.archiveEveryTurns);
  if (!shouldArchive) return { schemaVersion: 1, route: "skip", shouldArchive: false, reason: settings.enabled ? "cooldown-or-protection" : "disabled", currentTurn, firstTurn, eligibleLastTurn, settingsRecord, archiveState };
  const referenceFirst = Math.max(0, firstTurn - settings.referenceEarlierTurns);
  const referenceMessages = conversation.messages.filter(message => (message.binding?.turn || 0) >= referenceFirst && (message.binding?.turn || 0) < firstTurn);
  const archiveMessages = conversation.messages.filter(message => (message.binding?.turn || 0) >= firstTurn && (message.binding?.turn || 0) <= eligibleLastTurn);
  const captureCandidates = await queryAll(data, { moduleId: "narrative-memory", collectionId: "source-captures", recordTypes: ["memory.source-capture"], where: { capturedTurn: { gte: firstTurn } }, view: "archive" });
  const captures = captureCandidates.filter(item => (item.value?.capturedTurn ?? -1) <= eligibleLastTurn);
  const captureGuidance = await sourceGuidance(module?.directory, captures, services);
  const overLimit = [];
  for (const [collectionId, recordTypes] of Object.entries({ entities: ["memory.entity"], relationships: ["memory.relationship"], events: ["memory.event", "memory.event-summary"], cognitions: ["memory.cognition"], "knower-groups": ["memory.knower-group"] })) {
    const items = await queryAll(data, { moduleId: "narrative-memory", collectionId, recordTypes, where: { summaryOverLimit: { eq: true } }, view: "archive" });
    for (const item of items) overLimit.push({ id: item.id, recordType: item.recordType, maximumCharacters: SUMMARY_LIMITS[item.recordType] });
  }
  const lastMessage = [...archiveMessages].reverse().find(message => message.data?.role !== "user") || archiveMessages.at(-1) || null;
  return {
    schemaVersion: 1,
    route: "archive",
    shouldArchive: true,
    firstTurn,
    eligibleLastTurn,
    lastCoveredMessageId: lastMessage?.id || null,
    settingsRecord,
    archiveState,
    coveredMessageIds: archiveMessages.map(message => message.id),
    sourceMessageIds: [...referenceMessages, ...archiveMessages].map(message => message.id),
    context: {
      "以下为早期剧情，作为参考": referenceMessages.map(textForMessage).join("\n\n") || "无",
      "以下为本次归档的剧情": archiveMessages.map(textForMessage).join("\n\n"),
      "以下为本次归档覆盖的其他模块资料": captures.map(item => item.value).filter(Boolean),
      "以下为其他模块来源各自预定义的归档说明": captureGuidance,
    },
    overLimitSummaryTasks: overLimit,
  };
}
