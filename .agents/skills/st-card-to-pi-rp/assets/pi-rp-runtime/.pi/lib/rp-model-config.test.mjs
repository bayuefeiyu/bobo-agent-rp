import assert from "node:assert/strict";
import test from "node:test";

import { composeNodePrompt, composeWorkflowNodeDynamicContext, normalizeAgentProfile, normalizeModelProfile, normalizeRuntimePolicy, resolveNodeProfiles } from "./rp-model-config.mjs";

test("normalizes optional model head and tail prompts", () => {
  const model = normalizeModelProfile({
    schemaVersion: 1,
    id: "writer",
    provider: "openai",
    model: "gpt-test",
    thinking: "high",
    headPrompt: "head.md",
    tailPrompt: "tail.md",
    maxConcurrency: 3,
  });
  assert.equal(model.headPrompt, "head.md");
  assert.equal(model.tailPrompt, "tail.md");
  assert.equal(model.maxConcurrency, 3);
});

test("keeps agent default model as a low-priority convenience", () => {
  const agent = normalizeAgentProfile({ schemaVersion: 1, id: "writer", defaultModelId: "agent-default" });
  const workflow = { defaults: { modelId: "workflow-default" } };
  assert.equal(resolveNodeProfiles({ node: { agentId: "writer", modelId: "node-model" }, workflow, agent }).modelId, "node-model");
  assert.equal(resolveNodeProfiles({ node: { agentId: "writer", modelId: null }, workflow, agent }).modelId, "workflow-default");
  assert.equal(resolveNodeProfiles({ node: { agentId: "writer", modelId: null }, workflow: { defaults: {} }, agent }).modelId, "agent-default");
});

test("places the model head after Pi system text and the tail last", () => {
  const prompt = composeNodePrompt({
    piSystemPrompt: "PI",
    modelHead: "HEAD",
    agentPrompt: "AGENT",
    fixedContext: "FIXED",
    dynamicContext: "DYNAMIC",
    upstreamArtifacts: "UPSTREAM",
    currentInput: "INPUT",
    nodePrompt: "NODE",
    modelTail: "TAIL",
  });
  assert.equal(prompt.systemPrompt, "PI\n\nHEAD\n\nAGENT\n\nFIXED");
  assert.deepEqual(prompt.contextMessages, ["DYNAMIC", "UPSTREAM", "INPUT", "NODE", "TAIL"]);
});

test("keeps fixed prompts while limiting implicit chat history to foreground nodes", () => {
  const fixed = composeNodePrompt({ piSystemPrompt: "PI", agentPrompt: "AGENT", fixedContext: "FIXED", dynamicContext: "", nodePrompt: "TASK" });
  assert.equal(fixed.systemPrompt, "PI\n\nAGENT\n\nFIXED");
  const foreground = composeWorkflowNodeDynamicContext({ workflowKind: "foreground", turn: 8, recentCompleteTurns: 2, recentContext: "TURN-6\nTURN-7" });
  const background = composeWorkflowNodeDynamicContext({ workflowKind: "global-background", turn: 8, recentCompleteTurns: 2, recentContext: "TURN-6\nTURN-7", callContext: true, arguments: { target: "selected" }, documentWorkspace: true });
  assert.match(foreground, /TURN-6/);
  assert.doesNotMatch(background, /TURN-6|TURN-7/);
  assert.match(background, /Module call inputs: CALL-INPUTS\.md/);
  assert.doesNotMatch(background, /Parameters:/);
  assert.match(background, /WORKSPACE-DOCUMENTS\.md/);
});

test("defaults to ten global workers and no silent fallback", () => {
  assert.deepEqual(normalizeRuntimePolicy(), {
    schemaVersion: 1,
    maxConcurrency: 10,
    modelFailure: { silentFallback: false, defaultFallbackModelId: null },
  });
});
