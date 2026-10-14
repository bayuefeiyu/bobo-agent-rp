import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentDelivery } from "./rp-agent-delivery.mjs";
import { registerAgentDeliveryTools } from "./rp-agent-delivery-tools.mjs";
import { installReferenceModelBudget } from "./rp-reference-library.mjs";
import { createTaskStageController, parseTaskStages, registerTaskStageTool } from "./rp-task-stages.mjs";
import { agentSoftBudgetExtension } from "./rp-agent-soft-budget.mjs";

// Exercise the installed Pi engine with a deterministic stream; no provider, credentials,
// user settings, network or model tokens are used.
async function loadPi() {
  const candidates = [process.env.PI_PACKAGE_ROOT, process.env.APPDATA && resolve(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")].filter(Boolean);
  for (const root of candidates) {
    try {
      const core = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-agent-core/dist/index.js")));
      const stream = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
      const wrapper = await import(pathToFileURL(join(root, "dist/core/tools/tool-definition-wrapper.js")));
      const { createWriteTool } = await import(pathToFileURL(join(root, "dist/core/tools/write.js")));
      const { createEditTool } = await import(pathToFileURL(join(root, "dist/core/tools/edit.js")));
      const { Type } = await import(pathToFileURL(join(root, "node_modules/typebox/build/index.mjs")));
      return { ...core, ...stream, ...wrapper, createWriteTool, createEditTool, Type };
    } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
  }
  return null;
}
const pi = await loadPi();

test("installed Pi receives soft-budget reminders after tool results and completes beyond the budget", { skip: !pi }, async () => {
  const handlers = {};
  agentSoftBudgetExtension({ metadata: { softBudget: { modelRequests: 2, outputTokens: 1, elapsedSeconds: 600 } } }, { kind: "module-external" })[0].factory({ on: (event, handler) => { handlers[event] = handler; } });
  let requests = 0;
  const contexts = [];
  const agent = new pi.Agent({ initialState: { model: { id: "offline", name: "offline", api: "openai-completions", provider: "offline", contextWindow: 100000, maxTokens: 1000 }, tools: [{ name: "finish_artifact", label: "Finish", description: "Finish artifact", parameters: pi.Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "artifact checked" }] }) }] },
    transformContext: messages => handlers.context({ messages }).messages,
    streamFn: (_model, context) => {
      contexts.push(structuredClone(context.messages));
      requests++;
      const stream = new pi.AssistantMessageEventStream();
      const finished = requests === 3;
      stream.push({ type: "done", reason: finished ? "stop" : "toolUse", message: { role: "assistant", content: finished ? [{ type: "text", text: "completed" }] : [{ type: "toolCall", id: `artifact-${requests}`, name: "finish_artifact", arguments: {} }], api: "openai-completions", provider: "offline", model: "offline", stopReason: finished ? "stop" : "toolUse", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      return stream;
    } });
  agent.subscribe(event => { if (event.type === "message_end") handlers.message_end(event); });
  await agent.prompt("Complete the artifact.");
  assert.equal(requests, 3, "the soft budget must not abort or create an extra completion request");
  assert.equal(agent.state.messages.at(-1).content[0].text, "completed");
  assert.ok(contexts[1].some(message => JSON.stringify(message.content).includes("缩小探索范围")));
  assert.ok(contexts[2].some(message => JSON.stringify(message.content).includes("已达到建议预算")));
  assert.ok(agent.state.messages.every(message => !JSON.stringify(message.content).includes("软预算提醒")), "the reminder never becomes business/session history");
});

test("installed Pi stops before provider dispatch when the reference model budget is exhausted", { skip: !pi }, async () => {
  let requests = 0, charges = 0, transforms = 0;
  const agent = new pi.Agent({
    initialState: {
      model: { id: "offline", name: "offline", api: "openai-completions", provider: "offline", contextWindow: 100000, maxTokens: 1000 },
      tools: [{ name: "continue_search", label: "Continue", description: "Continue searching", parameters: pi.Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }] }) }],
    },
    transformContext: async messages => { transforms++; return messages; },
    streamFn: () => {
      requests++;
      const stream = new pi.AssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message: {
        role: "assistant", content: [{ type: "toolCall", id: "continue", name: "continue_search", arguments: {} }],
        api: "openai-completions", provider: "offline", model: "offline", stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    },
  });
  const exhausted = Object.assign(new Error("Reference model call budget exhausted."), { code: "budget_exhausted" });
  const guard = installReferenceModelBudget(agent, async () => { if (++charges > 1) throw exhausted; });
  await agent.prompt("Search references.");
  assert.equal(requests, 1, "the second provider request must never start");
  assert.equal(transforms, 1, "the existing context transform is preserved for allowed requests");
  assert.equal(charges, 2);
  assert.equal(guard.error, exhausted);
  assert.equal(agent.state.messages.at(-1).stopReason, "error");
  await agent.prompt("Try again.");
  assert.equal(requests, 1, "retries in the same attempt cannot bypass the failed budget guard");
  assert.equal(charges, 2);
});

test("installed Pi delivers, repairs JSON, rejects batched completion and ends without another model turn", { skip: !pi }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "rp-delivery-pi-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const delivery = await createAgentDelivery({ workspace, node: { id: "json-writer", outputs: { result: { path: "result.json", format: "json", kind: "file" } }, delivery: { primaryOutput: "result" } }, agent: { outputMode: "json" } });
  let agent;
  const tools = [pi.createWriteTool(workspace), pi.createEditTool(workspace)];
  const handlers = [];
  registerAgentDeliveryTools({ registerTool: definition => tools.push(pi.wrapToolDefinition(definition)), on: (event, handler) => { assert.equal(event, "tool_call"); handlers.push(handler); } }, delivery, { currentMessages: () => agent.state.messages }, pi.Type);
  const tc = (name, args) => ({ type: "toolCall", id: `call-${Math.random()}`, name, arguments: args });
  const turns = [
    [tc("write", { path: "draft.json", content: '{"value":1,}' })],
    [tc("rp_deliver", { output: "result", path: "draft.json" })],
    [tc("edit", { path: "draft.json", oldText: "1,}", newText: "2}" })],
    [tc("rp_deliver", { output: "result", path: "draft.json" }), tc("rp_node_complete", {})],
    [tc("rp_node_complete", {})],
  ];
  let requests = 0;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  agent = new pi.Agent({
    initialState: { model: { id: "offline", name: "offline", api: "openai-completions", provider: "offline", contextWindow: 100000, maxTokens: 1000 }, tools },
    beforeToolCall: async ({ toolCall }) => {
      for (const handler of handlers) { const result = await handler({ toolName: toolCall.name, input: toolCall.arguments }); if (result) return result; }
    },
    streamFn: () => {
      const stream = new pi.AssistantMessageEventStream();
      const content = turns[requests++];
      assert.ok(content, "completion must not trigger an extra model request");
      const message = { role: "assistant", content, api: "openai-completions", provider: "offline", model: "offline", usage, stopReason: "toolUse", timestamp: Date.now() };
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  });
  await agent.prompt("Write and deliver JSON.");
  assert.equal(requests, 5);
  assert.equal(delivery.completed, true);
  assert.deepEqual(await delivery.result(), { value: 2 });
  assert.equal(await readFile(join(workspace, "draft.json"), "utf8"), '{"value":2}');
  const results = agent.state.messages.filter(message => message.role === "toolResult");
  assert.ok(results.some(result => result.toolName === "rp_deliver" && result.isError));
  assert.ok(results.some(result => result.toolName === "rp_node_complete" && result.isError));
  assert.equal(results.at(-1).toolName, "rp_node_complete");
  assert.equal(results.at(-1).isError, false);
});

test("delivery tool schemas are object rooted and closed", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "rp-delivery-schema-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const delivery = await createAgentDelivery({ workspace, node: { id: "writer", outputs: { text: { path: "text.md", kind: "file" } } } });
  const tools = [];
  registerAgentDeliveryTools({ registerTool: tool => tools.push(tool), on() {} }, delivery, { currentMessages: () => [] }, pi.Type);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.executionMode, "sequential");
  }
  assert.match(JSON.stringify(tools.find(tool => tool.name === "rp_deliver").parameters.properties.output), /"const":"text"/);
});

test("installed Pi places a new task stage after its advance result and before the next model call", { skip: !pi }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "rp-task-stage-pi-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const stages = parseTaskStages("共同要求\n<!-- stage -->\n只分析\n<!-- stage -->\n现在创作");
  const controller = createTaskStageController(stages);
  const delivery = await createAgentDelivery({
    workspace,
    node: { id: "writer", outputs: { result: { path: "result.md", format: "markdown", kind: "file" } }, delivery: { primaryOutput: "result" } },
    agent: {},
    beforeComplete: async () => controller.assertExhausted(),
  });
  let agent;
  const tools = [pi.createWriteTool(workspace)];
  const handlers = [];
  const runtime = { registerTool: definition => tools.push(pi.wrapToolDefinition(definition)), on: (event, handler) => { assert.equal(event, "tool_call"); handlers.push(handler); } };
  registerAgentDeliveryTools(runtime, delivery, { currentMessages: () => agent.state.messages }, pi.Type);
  registerTaskStageTool(runtime, controller, {
    currentMessages: () => agent.state.messages,
    enqueueStage: async message => agent.steer({ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }),
  }, pi.Type);
  const tc = (name, args) => ({ type: "toolCall", id: `call-${name}-${Math.random()}`, name, arguments: args });
  const turns = [
    [tc("rp_task_next", {})],
    [tc("rp_task_next", {})],
    [tc("write", { path: "draft.md", content: "正文" })],
    [tc("rp_deliver", { output: "result", path: "draft.md" })],
    [tc("rp_node_complete", {})],
  ];
  const contexts = [];
  let requests = 0;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  agent = new pi.Agent({
    initialState: { model: { id: "offline", name: "offline", api: "openai-completions", provider: "offline", contextWindow: 100000, maxTokens: 1000 }, tools },
    beforeToolCall: async ({ toolCall }) => {
      for (const handler of handlers) { const result = await handler({ toolName: toolCall.name, input: toolCall.arguments }); if (result) return result; }
    },
    streamFn: (...args) => {
      const context = args.find(value => Array.isArray(value?.messages));
      contexts.push(structuredClone(context?.messages || []));
      const stream = new pi.AssistantMessageEventStream();
      const content = turns[requests++];
      assert.ok(content, "staged completion must not trigger an extra model request");
      stream.push({ type: "done", reason: "toolUse", message: { role: "assistant", content, api: "openai-completions", provider: "offline", model: "offline", usage, stopReason: "toolUse", timestamp: Date.now() } });
      return stream;
    },
  });
  await agent.prompt(stages.initialText);
  assert.equal(requests, 5);
  const second = contexts[1];
  const advanceResultIndex = second.findIndex(message => message.role === "toolResult" && message.toolName === "rp_task_next");
  const nextStageIndex = second.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes("现在创作"));
  assert.ok(advanceResultIndex >= 0);
  assert.equal(nextStageIndex, advanceResultIndex + 1);
  assert.doesNotMatch(JSON.stringify(contexts[0]), /现在创作/);
  assert.equal(delivery.completed, true);
  assert.equal(await delivery.result(), "正文");
});
