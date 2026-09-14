import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertImageOperationIntent,
  ensurePreparedImageRequest,
  getImageRequest,
  normalizeImageOperationIntent,
  prepareImageOperation,
  requestValue,
} from "../image-execution.mjs";

function messageText(record) {
  const role = record?.data?.role === "user" ? "玩家" : "角色";
  return `[${role} · 第 ${record?.binding?.turn ?? 0} 轮]\n${record?.data?.content || ""}`;
}

function profileSummary(snapshot) {
  return {
    id: snapshot.id,
    title: snapshot.title || snapshot.id,
    revision: snapshot.revision,
    guideId: snapshot.guideId,
    connectionId: snapshot.connectionId,
    digest: snapshot.baseProfileDigest,
    effectiveDigest: snapshot.effectiveDigest,
    snapshotId: snapshot.snapshotId,
    workflowDigest: snapshot.workflowDigest,
    outputNodeIds: snapshot.outputNodeIds || [],
  };
}

async function writePromptContext(workspace, persisted) {
  const snapshots = persisted.effectiveProfileSnapshots || [];
  const guides = [...new Map(snapshots.map(snapshot => [snapshot.guideId, { guideId: snapshot.guideId, instruction: snapshot.guide }])).values()];
  const promptDirectory = resolve(workspace, "prompt-context");
  await mkdir(promptDirectory, { recursive: true });
  await writeFile(resolve(promptDirectory, "DOCUMENTS.md"), [
    "# 生图提示词任务资料",
    "",
    "## 使用说明",
    "",
    "只为下列每个 guideId 生成一条随剧情变化的画面内容提示词。参考内容仅用于保持人物与场景连续性；生图目标是本次画面的唯一剧情目标；额外要求只补充本次取景。固定风格、质量、LoRA、采样和负面提示词由工作流配置负责，不要在内容提示词中重复。",
    "",
    "最终只输出 JSON：`{\"prompts\":[{\"guideId\":\"...\",\"content\":\"...\"}]}`。每个下列 guideId 恰好出现一次。",
    "",
    "## 参考内容",
    "",
    persisted.referenceContext || "无",
    "",
    "## 生图目标",
    "",
    persisted.imageTarget,
    "",
    "## 本次额外要求",
    "",
    persisted.userDirection || "无",
    "",
    "## 连续性资料",
    "",
    `- 玩家：${persisted.continuityContext?.playerName || "未提供"}${persisted.continuityContext?.playerDescription ? `｜${persisted.continuityContext.playerDescription}` : ""}`,
    `- 主要角色：${persisted.continuityContext?.primaryCharacters || "未提供"}`,
    "",
    "## 模型指导",
    "",
    ...guides.flatMap(guide => [`### ${guide.guideId}`, "", guide.instruction || "无额外指导", ""]),
  ].join("\n"), "utf8");
}

function resolvedOutput(persisted, requestId, route) {
  const snapshots = persisted.effectiveProfileSnapshots || [];
  return {
    sourceKind: persisted.sourceKind,
    triggerKind: persisted.triggerKind,
    referenceContext: persisted.referenceContext,
    imageTarget: persisted.imageTarget,
    userDirection: persisted.userDirection,
    requestId,
    route,
    ordinal: persisted.ordinal,
    chatFolder: persisted.chatFolder,
    profiles: snapshots.map(profileSummary),
    guideIds: [...new Set(snapshots.map(item => item.guideId))],
    invocationFingerprint: persisted.invocationFingerprint,
    resolvedInputFingerprint: persisted.resolvedInputFingerprint,
  };
}

export async function execute({ run, conversation, services, data, workspace }) {
  const request = run.arguments?.request || {};
  const operationId = request.operationId || run.callContext?.callId || run.id;
  const invocationIntent = normalizeImageOperationIntent({ ...request, operationId });

  // Recovery is deliberately resolved before current preferences, chat selection, or profiles.
  const existing = await getImageRequest(data, operationId);
  if (existing) {
    const persisted = assertImageOperationIntent(existing, invocationIntent, operationId);
    await writePromptContext(workspace, persisted);
    return resolvedOutput(persisted, existing.id, persisted.promptState === "ready" ? "reuse" : "prompt");
  }

  const saved = await data.query({ moduleId: "comfy-image-generation", collectionId: "settings", recordTypes: ["image.preferences"], view: "rp", limit: 1 });
  const preferences = saved.items?.[0]?.value || {};
  const profileIds = invocationIntent.profileIds.length ? invocationIntent.profileIds : preferences["工作流"];
  const profiles = await services.comfy.profiles(profileIds);
  if (!profiles.length) throw new Error("没有已选择且有效的 ComfyUI 工作流配置。");
  const policy = invocationIntent.inputPolicy || preferences["输入范围"] || { kind: "recent-turns", turnCount: 3, target: "latest" };
  const messages = conversation.messages || [];
  let reference = "";
  let target = "";
  if (policy.kind === "custom-brief") {
    target = invocationIntent.customBrief;
  } else if (policy.kind === "workflow-output") {
    target = invocationIntent.workflowOutput;
  } else {
    const storyMessages = messages.filter(item => item.binding?.turn > 0);
    const selected = policy.kind === "selected-messages" && invocationIntent.messageIds.length
      ? messages.filter(item => invocationIntent.messageIds.includes(item.id))
      : (storyMessages.length ? storyMessages : messages.slice(-1)).slice(-Math.max(1, Math.min(20, policy.turnCount || 3)) * 2);
    const latestTurn = Math.max(0, ...selected.map(item => item.binding?.turn || 0));
    target = selected.filter(item => policy.target === "all" || item.binding?.turn === latestTurn).map(messageText).join("\n\n");
    reference = selected.filter(item => policy.target !== "all" && item.binding?.turn !== latestTurn).map(messageText).join("\n\n");
  }
  if (!target) throw new Error("当前输入范围没有可用于生图的目标内容。");
  const latestRequest = await data.query({ moduleId: "comfy-image-generation", collectionId: "requests", recordTypes: ["image.request"], view: "maintenance", sort: [{ field: "ordinal", order: "desc" }], limit: 1 });
  const ordinal = Number(requestValue(latestRequest.items?.[0])?.ordinal || 0) + 1;
  const source = {
    sourceKind: policy.kind,
    triggerKind: run.trigger?.type || "manual",
    referenceContext: reference,
    imageTarget: target,
    userDirection: invocationIntent.userDirection,
  };
  const definition = prepareImageOperation({
    operationId,
    ordinal,
    source,
    profiles,
    chatFolder: services.comfy.chatFolder({ cardId: run.cardId, chatId: run.chatId }),
    derivedFrom: invocationIntent.derivedFrom,
    intent: invocationIntent,
    continuityContext: {
      playerName: conversation.player?.name || "",
      playerDescription: conversation.player?.description || "",
      primaryCharacters: conversation.primaryCharacters || "",
    },
  });
  const prepared = await ensurePreparedImageRequest({ data, definition });
  const persisted = requestValue(prepared.request);
  await writePromptContext(workspace, persisted);
  return resolvedOutput(persisted, definition.requestId, prepared.route);
}
