export async function execute({ run, conversation, data, calls }) {
  const ready = await data.query({ moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", recordTypes: ["director.archive-handoff"], where: { status: { eq: "ready" } }, view: "archive-source", limit: 1000, maxCharacters: 1000000 });
  if (!ready.items?.length) return { captured: 0, skipped: true };
  const versions = ready.items.map(item => Number.isSafeInteger(item.value.contentVersion) ? item.value.contentVersion : Math.max(1, Number(item.revision) || 1));
  const captures = ready.items.map((item, index) => ({ captureId: `memory-source-world-narrative-coordinator-${item.id}-v${versions[index]}`, sourceModuleId: "world-narrative-coordinator", adapterId: "world-narrative-coordinator-outbox", title: `【世界叙事统筹归档交接】${item.value.subject}`, historyMode: "per-turn", format: "json", captureStatus: "succeeded", content: { ...item.value, contentVersion: versions[index] }, sourceReferences: [] }));
  const child = await calls.invoke({ workflow: "narrative-memory/narrative-memory-source-capture", arguments: { request: { captures } }, outputPaths: {} });
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const operations = ready.items.map((item, index) => ({ operationId: `${run.id}-confirm-${index + 1}`, moduleId: "world-narrative-coordinator", collectionId: "archive-outbox", recordType: "director.archive-handoff", action: "update", targetId: item.id, expectedRevision: item.revision, data: { ...item.value, contentVersion: versions[index], status: "captured", sourceCaptureId: captures[index].captureId }, note: null }));
  const receipt = await data.submit({ protocolVersion: 1, batchId: `${run.id}-confirm-captures`, status: "pending", commitPolicy: "atomic", operations }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  if (receipt?.status !== "committed") throw new Error(receipt?.error?.message || receipt?.error || `Capture confirmation completed with status ${receipt?.status || "unknown"}.`);
  return { captured: operations.length, sourceCaptureRunId: child.callId };
}
