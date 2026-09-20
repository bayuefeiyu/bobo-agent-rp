import { createHash } from "node:crypto";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const MODEL_TAIL_MESSAGE_TYPE = "rp-model-tail";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function normalizeModelProfile(value) {
  const input = object(value, "model profile");
  if (input.schemaVersion !== 1) throw new Error("model profile schemaVersion must be 1.");
  const profileId = id(input.id, "model profile id");
  const provider = id(input.provider, "model provider");
  if (typeof input.model !== "string" || !input.model.trim()) throw new Error("model profile model is required.");
  const thinking = typeof input.thinking === "string" ? input.thinking : "off";
  if (!THINKING_LEVELS.has(thinking)) throw new Error(`Unsupported thinking level: ${thinking}`);
  const positive = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
  return {
    schemaVersion: 1,
    id: profileId,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : profileId,
    provider,
    model: input.model.trim(),
    api: typeof input.api === "string" && input.api.trim() ? input.api.trim() : null,
    contextWindow: positive(input.contextWindow, 128000, 10_000_000),
    maxOutputTokens: positive(input.maxOutputTokens, 4096, 1_000_000),
    thinking,
    maxConcurrency: positive(input.maxConcurrency, 10, 10),
    headPrompt: typeof input.headPrompt === "string" && input.headPrompt.trim() ? input.headPrompt.trim() : null,
    tailPrompt: typeof input.tailPrompt === "string" && input.tailPrompt.trim() ? input.tailPrompt.trim() : null,
    headPromptFile: typeof input.headPromptFile === "string" && input.headPromptFile.trim() ? input.headPromptFile.trim() : null,
    tailPromptFile: typeof input.tailPromptFile === "string" && input.tailPromptFile.trim() ? input.tailPromptFile.trim() : null,
    parameters: input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? input.parameters : {},
  };
}

export function normalizeAgentProfile(value) {
  const input = object(value, "agent profile");
  if (input.schemaVersion !== 1) throw new Error("agent profile schemaVersion must be 1.");
  const agentId = id(input.id, "agent profile id");
  const tools = Array.isArray(input.tools) ? [...new Set(input.tools.filter(tool => typeof tool === "string" && tool.trim()).map(tool => tool.trim()))] : [];
  const permissions = Array.isArray(input.contextPermissions)
    ? [...new Set(input.contextPermissions.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()))]
    : [];
  return {
    schemaVersion: 1,
    id: agentId,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : agentId,
    description: typeof input.description === "string" ? input.description.trim() : "",
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : null,
    promptFile: typeof input.promptFile === "string" && input.promptFile.trim() ? input.promptFile.trim() : null,
    tools,
    contextPermissions: permissions,
    outputMode: input.outputMode === "json" ? "json" : "text",
    defaultModelId: typeof input.defaultModelId === "string" && input.defaultModelId.trim() ? input.defaultModelId.trim() : "pi:current",
  };
}

export function resolveNodeProfiles({ node, workflow, agent }) {
  const agentId = node.agentId || workflow.defaults?.agentId || agent?.id || null;
  const modelId = node.modelId || workflow.defaults?.modelId || agent?.defaultModelId || "pi:current";
  return { agentId, modelId };
}

export function composeNodePrompt({ piSystemPrompt, modelHead, agentPrompt, fixedContext, dynamicContext, upstreamArtifacts, currentInput, nodePrompt }) {
  const systemPrompt = [piSystemPrompt, modelHead, agentPrompt, fixedContext].filter(value => typeof value === "string" && value.trim()).join("\n\n");
  const contextMessages = [dynamicContext, upstreamArtifacts, currentInput, nodePrompt]
    .filter(value => typeof value === "string" && value.trim())
    .map(content => content.trim());
  return { systemPrompt, contextMessages };
}

export function moveModelTailToEnd(messages, modelTail, timestamp = Date.now()) {
  const context = Array.isArray(messages)
    ? messages.filter(message => message?.role !== "custom" || message.customType !== MODEL_TAIL_MESSAGE_TYPE)
    : [];
  if (typeof modelTail !== "string" || !modelTail.trim()) return context;
  if (context.at(-1)?.role === "user") {
    const last = context.at(-1);
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    return [...context.slice(0, -1), { ...last, content: [...content, { type: "text", text: `\n\n${modelTail.trim()}` }] }];
  }
  return [...context, {
    role: "custom",
    customType: MODEL_TAIL_MESSAGE_TYPE,
    content: modelTail.trim(),
    display: false,
    details: { transient: true },
    timestamp,
  }];
}

export function composeWorkflowNodeDynamicContext({ workflowKind, turn, recentCompleteTurns, recentContext, callContext, documentWorkspace, handoffMirrorRoots = [], customContext }) {
  return [
    Number.isSafeInteger(turn) ? `Turn: ${turn}` : "",
    workflowKind === "foreground" && Number.isSafeInteger(turn) && recentContext ? `Most recent ${recentCompleteTurns} complete turns:\n${recentContext}` : "",
    callContext ? "Module call inputs: CALL-INPUTS.md" : "",
    documentWorkspace ? "Workspace document index: WORKSPACE-DOCUMENTS.md" : "",
    !documentWorkspace && handoffMirrorRoots.length
      ? `Inherited workspace mirror roots: ${handoffMirrorRoots.join(", ")}\nPaths recorded inside inherited maps are relative to their corresponding mirror root unless the producing workflow deliberately renamed an output.`
      : "",
    customContext,
  ].filter(Boolean).join("\n\n");
}

export function promptHash(value) {
  return value && value.trim() ? `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` : null;
}

export function normalizeRuntimePolicy(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: 1,
    maxConcurrency: Number.isSafeInteger(input.maxConcurrency) && input.maxConcurrency > 0 ? Math.min(input.maxConcurrency, 10) : 10,
    modelFailure: {
      silentFallback: input.modelFailure?.silentFallback === true,
      defaultFallbackModelId: typeof input.modelFailure?.defaultFallbackModelId === "string" && input.modelFailure.defaultFallbackModelId.trim()
        ? input.modelFailure.defaultFallbackModelId.trim()
        : null,
    },
  };
}
