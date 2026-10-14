import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TeamCollaborationRuntime } from "./rp-team-collaboration-runtime.mjs";
import { assertCollaborationToolMessage, installCollaborationContextGuard } from "./rp-team-collaboration-tools.mjs";
import { readPromptFile } from "./rp-node-context.mjs";

async function loadPi() {
  const candidates = [process.env.PI_PACKAGE_ROOT, process.env.APPDATA && resolve(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")].filter(Boolean);
  for (const root of candidates) try {
    const core = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-agent-core/dist/index.js")));
    const stream = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
    const wrapper = await import(pathToFileURL(join(root, "dist/core/tools/tool-definition-wrapper.js")));
    return { ...core, ...stream, ...wrapper };
  } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
  return null;
}
const pi = await loadPi();
const model = { id: "offline", name: "offline", api: "openai-completions", provider: "offline", contextWindow: 100000, maxTokens: 1000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tc = (name, args = {}) => ({ type: "toolCall", id: `call-${name}-${Math.random()}`, name, arguments: args });
function offlineStream(content) {
  const stream = new pi.AssistantMessageEventStream();
  stream.push({ type: "done", reason: "toolUse", message: { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() } });
  return stream;
}

test("installed Pi shares visible text and read results, then hands off and delivers without extra dispatch", { skip: !pi }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "rp-collaboration-pi-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "source.md"), "已核实的场景资料\n原文保留。");
  const narrative = "  正文首行\r\n\r\n人物抬起头。\n";
  const members = ["writer", "co"].map(id => ({ id, label: id, agentId: `demo/${id}`, tools: ["read", "write", "edit", "rp_files"] }));
  const node = { id: "draft", outputs: { narrative: { path: "narrative.md", kind: "file", format: "narrative" } }, delivery: { primaryOutput: "narrative" }, team: { schemaVersion: 2, protocol: "collaboration", members, initialMemberId: "writer", stageOwnerId: "writer", completionMemberId: "writer", outputOwners: { narrative: "writer" } } };
  const scripts = [
    [[{ type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" }, { type: "text", text: "公开场景分析" }, tc("read", { path: "source.md" })], [tc("rp_team_handoff")]],
    [[{ type: "text", text: "共创反馈" }, tc("rp_team_handoff")]],
    [[tc("write", { path: "work/writer/正文.md", content: narrative })], [tc("rp_deliver", { output: "narrative", path: "work/writer/正文.md" })], [tc("rp_node_complete")]],
  ];
  let activation = 0, requests = 0;
  const runtime = new TeamCollaborationRuntime({ workspace, node, runId: "offline", taskPrompt: "共同创作", invokeMember: async request => {
    if (activation === 1) { assert.match(request.prompt, /已核实的场景资料/); assert.match(request.prompt, /公开场景分析/); assert.doesNotMatch(request.prompt, /PRIVATE_REASONING_SENTINEL/); }
    const turns = scripts[activation++];
    let index = 0, agent, publications = Promise.resolve(), terminated = false;
    const tools = request.collaboration.tools.map(definition => pi.wrapToolDefinition({ ...definition, async execute(id, args) {
      await publications;
      assertCollaborationToolMessage(agent.state.messages);
      const result = await definition.execute(id, args);
      if (result.terminate) terminated = true;
      return result;
    } }));
    agent = new pi.Agent({ initialState: { model, tools }, streamFn: () => {
      requests++;
      const content = turns[index++];
      assert.ok(content, "a successful terminal tool must not cause another provider request");
      return offlineStream(content);
    } });
    installCollaborationContextGuard(agent, model);
    agent.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") {
      const visible = event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (visible) publications = publications.then(() => request.collaboration.publish(visible));
    } });
    await agent.prompt(request.prompt);
    await publications;
    assert.ok(terminated);
    return { terminated, usage: { input: index, output: index, totalTokens: index * 2 } };
  } });
  const result = await runtime.run({ inputPaths: ["source.md"] });
  assert.equal(requests, 6);
  assert.equal(activation, 3);
  assert.equal(result.output, narrative);
  assert.equal(await readFile(join(workspace, "narrative.md"), "utf8"), narrative);
  const transcript = await readFile(join(workspace, "team/shared/TRANSCRIPT.md"), "utf8");
  assert.match(transcript, /公开场景分析/);
  assert.match(transcript, /共创反馈/);
  assert.doesNotMatch(transcript, /PRIVATE_REASONING_SENTINEL/);
});

test("installed Pi rejects every tool in a batched handoff before any mutation", { skip: !pi }, async () => {
  let agent, mutations = 0, requests = 0;
  const definitions = ["write", "rp_team_handoff"].map(name => ({ name, label: name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() {
    assertCollaborationToolMessage(agent.state.messages);
    if (name === "write") mutations++;
    return { content: [{ type: "text", text: "ok" }], ...(name === "rp_team_handoff" ? { terminate: true } : {}) };
  } }));
  const turns = [[tc("write"), tc("rp_team_handoff")], [tc("rp_team_handoff")]];
  agent = new pi.Agent({ initialState: { model, tools: definitions.map(definition => pi.wrapToolDefinition(definition)) }, streamFn: () => {
    const content = turns[requests++]; assert.ok(content); return offlineStream(content);
  } });
  await agent.prompt("Hand off when ready.");
  assert.equal(mutations, 0);
  assert.equal(requests, 2);
  assert.equal(agent.state.messages.filter(message => message.role === "toolResult" && message.isError).length, 2);
});

test("installed Pi checks shared context growth before each provider request", { skip: !pi }, async () => {
  let requests = 0, transforms = 0;
  const agent = new pi.Agent({ initialState: { model: { ...model, contextWindow: 3000, maxTokens: 100 }, systemPrompt: "shared system", tools: [{ name: "read", label: "read", description: "read", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "资料".repeat(1000) }] }) }] }, transformContext: async messages => { transforms++; return messages; }, streamFn: () => { requests++; return offlineStream([tc("read")]); } });
  installCollaborationContextGuard(agent, agent.state.model);
  await agent.prompt("Read source.");
  assert.equal(requests, 1);
  assert.equal(transforms, 2);
  assert.equal(agent.state.messages.at(-1).stopReason, "error");
  assert.match(agent.state.messages.at(-1).errorMessage, /Shared collaboration history exceeds/);
});

test("shared module prompts expand within their owner and reject cycles and escapes", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-shared-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "prompts/agents"), { recursive: true });
  await mkdir(join(root, "prompts/shared"), { recursive: true });
  await writeFile(join(root, "prompts/agents/writer.md"), "writer\n{{include:prompts/shared/team.md}}");
  await writeFile(join(root, "prompts/shared/team.md"), "equal participants");
  assert.equal(await readPromptFile(root, "prompts/agents/writer.md"), "writer\nequal participants");
  await writeFile(join(root, "prompts/shared/team.md"), "{{include:prompts/shared/team.md}}");
  await assert.rejects(readPromptFile(root, "prompts/agents/writer.md"), /cycle/);
  await writeFile(join(root, "prompts/shared/team.md"), "{{include:prompts/shared/../../outside.md}}");
  await assert.rejects(readPromptFile(root, "prompts/agents/writer.md"), /escapes/);
});
