import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentDelivery } from "./rp-agent-delivery.mjs";
import { registerAgentDeliveryTools } from "./rp-agent-delivery-tools.mjs";

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
