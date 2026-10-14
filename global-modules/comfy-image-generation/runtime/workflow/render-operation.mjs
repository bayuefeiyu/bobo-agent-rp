import { readWebRecords, regenerationSource, recoverableRenders } from "../web-api.mjs";
import { buildImageOperation, ensureImageOperation, executeImageOperation } from "../image-execution.mjs";

// Web actions use the same execution workspace, scoped data and recovery machinery as
// other workflows. Nothing writes through an ambient session store.
export async function execute({ run, node, data, services }) {
  const [requests, renders] = await Promise.all([readWebRecords(data, "requests"), readWebRecords(data, "renders")]);
  if (node.metadata.action === "recover") {
    const request = requests.records.find(item => item.id === run.payload.requestId);
    if (!request) throw new Error("Image request was not found in this execution.");
    const selected = recoverableRenders(renders.records, request.id);
    return executeImageOperation({ data, services, requestId: request.id, renders: selected });
  }
  const source = regenerationSource(requests.records, renders.records, run.payload.renderId, run.payload.contentPrompt, run.payload.scope);
  if (!source) throw new Error("Source image request or render was not found in this attempt.");
  const profiles = await services.comfy.profiles(source.profileIds);
  if (!profiles.length) throw new Error("The adapted image profile is no longer available.");
  const originalOperationId = run.payload.operationId;
  const operationId = run.newExecutionRootId ? `${originalOperationId}-${run.newExecutionRootId}` : originalOperationId;
  const definition = buildImageOperation({
    operationId, ordinal: source.ordinal, source: source.request.data, profiles,
    contentPrompts: source.editedContentPrompts, chatFolder: source.render.data.chatFolder,
    services, derivedFrom: source.derivedFrom,
    intent: { operationId, profileIds: source.profileIds, inputPolicy: { kind: source.request.data.sourceKind },
      userDirection: source.request.data.userDirection, derivedFrom: source.derivedFrom, editedContentPrompts: source.editedContentPrompts },
  });
  const prepared = await ensureImageOperation({ data, definition });
  return executeImageOperation({ data, services, requestId: definition.requestId, renders: prepared.renders });
}
