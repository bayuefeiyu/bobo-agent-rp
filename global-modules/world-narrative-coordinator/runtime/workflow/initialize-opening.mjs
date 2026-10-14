import { submitCommitted } from "../lib/agent-change-batch.mjs";

export async function execute({ run, conversation, data }) {
  const openingId = run.trigger?.openingId || run.payload?.openingId;
  if (typeof openingId !== "string" || !openingId) throw new Error("Opening initialization requires openingId.");
  const request = id => ({ moduleId: "world-narrative-coordinator", collectionId: "private-state", id, view: "director" });
  const bootstrap = await data.get(request("director-bootstrap-current"));
  const brief = await data.get(request("turn-brief-current"));
  if (!bootstrap || !brief) throw new Error("Director opening state is missing.");
  const value = bootstrap.value?.data || bootstrap.value;
  if (value.initialized) {
    if (value.openingId !== openingId) throw new Error("Director state belongs to another opening.");
    return { initialized: true, reused: true, openingId };
  }
  const latest = conversation.messages.find(message => message.data?.kind === "opening") || conversation.messages[0];
  const batch = {
    protocolVersion: 1, batchId: `${run.id}-opening-init`, status: "pending", commitPolicy: "atomic",
    operations: [
      { operationId: `${run.id}-bootstrap`, moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.bootstrap-state", action: "update", targetId: bootstrap.id, expectedRevision: bootstrap.revision, data: { initialized: true, openingId, initializedTurn: 0 } },
      { operationId: `${run.id}-brief`, moduleId: "world-narrative-coordinator", collectionId: "private-state", recordType: "director.turn-brief", action: "update", targetId: brief.id, expectedRevision: brief.revision, data: { ...(brief.value?.data || brief.value), turn: 0, summary: "开场基础状态已准备；本轮指导在玩家首次输入后按实际需要定稿。", activeConcerns: [], publicationSummary: [], deepRecommendation: { shouldStart: false, reasonCodes: [] } } },
    ],
  };
  await submitCommitted(data, batch, { binding: { turn: 0, messageId: latest?.id || null }, sourceMessageIds: latest ? [latest.id] : [] });
  return { initialized: true, openingId, planningDeferred: true };
}
