const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const LAYERS = new Set(["unspecified", "in-world", "story", "authorial"]);
const PRODUCERS = new Set(["unknown", "user", "card", "agent", "code", "runtime"]);

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

export function normalizeNarrativeSource(value, fallback = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const layer = input.layer ?? fallback.layer ?? "unspecified";
  const producerKind = input.producerKind ?? fallback.producerKind ?? "unknown";
  if (!LAYERS.has(layer)) throw new Error(`Unsupported narrative source layer: ${String(layer)}.`);
  if (!PRODUCERS.has(producerKind)) throw new Error(`Unsupported narrative source producer: ${String(producerKind)}.`);
  const producerId = input.producerId === null || input.producerId === undefined ? safeId(fallback.producerId) : safeId(input.producerId);
  const characterId = input.characterId === null || input.characterId === undefined ? safeId(fallback.characterId) : safeId(input.characterId);
  if (input.producerId !== null && input.producerId !== undefined && !producerId) throw new Error("Narrative source producerId must be a safe ID or null.");
  if (input.characterId !== null && input.characterId !== undefined && !characterId) throw new Error("Narrative source characterId must be a safe ID or null.");
  return { producerKind, producerId, layer, characterId };
}

export function normalizeNarrativeSourceDeclaration(value, { defaultLayer = "unspecified" } = {}) {
  if (value === undefined || value === null) return { layer: defaultLayer, characterId: null };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["layer", "characterId"].includes(key))) {
    throw new Error("Workflow narrativeSource may contain only layer and characterId.");
  }
  const source = normalizeNarrativeSource({ layer: value.layer ?? defaultLayer, characterId: value.characterId ?? null });
  return { layer: source.layer, characterId: source.characterId };
}

export function workflowNodeNarrativeSource(workflow, node) {
  const producerKind = node.type === "agent" || node.type === "narrative" ? "agent" : node.type === "code" ? "code" : "runtime";
  const producerId = producerKind === "agent"
    ? node.agentId || workflow.defaults?.agentId || node.id
    : producerKind === "code" ? node.id : workflow.id;
  return normalizeNarrativeSource({
    producerKind,
    producerId,
    layer: node.narrativeSource?.layer ?? (node.type === "narrative" ? "story" : "unspecified"),
    characterId: node.narrativeSource?.characterId ?? null,
  });
}

export function messageSourceReference(record) {
  if (!record || typeof record.id !== "string" || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("Message source reference requires a stored message revision.");
  return {
    kind: "message",
    id: record.id,
    revision: record.revision,
    narrativeSource: normalizeNarrativeSource(record.metadata?.narrativeSource),
  };
}

export function artifactSourceReference(artifact) {
  const id = [artifact?.workflowRunId, artifact?.nodeId, artifact?.id].filter(Boolean).join(":");
  if (!safeId(id)) throw new Error("Artifact source reference requires safe workflow, node, and artifact IDs.");
  return {
    kind: "artifact",
    id,
    revision: null,
    narrativeSource: normalizeNarrativeSource(artifact.narrativeSource),
  };
}

export function normalizeSourceReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !["message", "artifact"].includes(value.kind) || !safeId(value.id)) throw new Error("Source reference is invalid.");
  const revision = value.kind === "message" && Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : null;
  if (value.kind === "message" && revision === null) throw new Error("Message source reference requires a revision.");
  return { kind: value.kind, id: value.id, revision, narrativeSource: normalizeNarrativeSource(value.narrativeSource) };
}

export function mergeSourceReferences(...groups) {
  const merged = new Map();
  for (const value of groups.flat()) {
    const source = normalizeSourceReference(value);
    merged.set(`${source.kind}:${source.id}:${source.revision ?? "none"}`, source);
  }
  return [...merged.values()];
}

export function narrativeSourceLabel(value) {
  const source = normalizeNarrativeSource(value);
  const layer = { "unspecified": "未指定来源层", "in-world": "世界内陈述", story: "正文叙事", authorial: "作者层设定" }[source.layer];
  const producer = source.producerId ? `${source.producerKind}:${source.producerId}` : source.producerKind;
  return `${layer}; producer=${producer}${source.characterId ? `; character=${source.characterId}` : ""}`;
}
