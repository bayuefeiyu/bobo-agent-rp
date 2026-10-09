// S5 批次 5 回归：节点数据访问的授权闸门。
//
// 方案 10 的必需验收："授权资料交接和工作区白名单不扩大；未授权工具和跨模块写入仍被拒绝。"
// 这里固定住三道闸门的拒绝行为。
import test from "node:test";
import assert from "node:assert/strict";

import { currentDataNode, nodeDataAccess, requireCurrentAgentTool } from "./rp-node-data-access.ts";

const contractFor = (id) => ({ schemaVersion: 1, moduleId: id, collections: {} });
const featureModule = (id) => ({ id, contract: contractFor(id), moduleDirectory: `/cards/demo/features/${id}`, workflows: [], agents: [] });

test("nodeDataAccess 只在节点显式声明该集合时放行", () => {
  const node = {
    id: "work",
    moduleAccess: [
      { moduleId: "memory", collectionId: "events", capabilities: ["memory.events.query"], views: ["rp"] },
      { moduleId: "memory", collectionId: "entities", capabilities: ["memory.entities.query"], views: ["rp"] },
    ],
  };
  const access = nodeDataAccess(node, "memory", "events");
  assert.deepEqual(access.capabilities, ["memory.events.query"]);

  // 同模块但未声明的集合必须拒绝（不得因为"同模块"就放行）。
  assert.throws(() => nodeDataAccess(node, "memory", "cognitions"), /has no access to memory\/cognitions/);
  // 未声明的模块同样拒绝。
  assert.throws(() => nodeDataAccess(node, "comfy-image-generation", "renders"), /has no access/);
  // 没有任何 moduleAccess 的节点一律拒绝。
  assert.throws(() => nodeDataAccess({ id: "bare" }, "memory", "events"), /has no access/);
});

test("requireCurrentAgentTool 在节点未指定 Agent 时回退到工作流默认 Agent", async () => {
  const asked = [];
  const getAgent = async (agentId) => { asked.push(agentId); return { effective: { tools: ["rp_data_query"] } }; };
  const entry = { workflow: { defaults: { agentId: "demo/reader" } } };
  const agent = await requireCurrentAgentTool(entry, { id: "n" }, "rp_data_query", getAgent);
  assert.deepEqual(agent.tools, ["rp_data_query"]);
  assert.deepEqual(asked, ["demo/reader"]);
});

test("requireCurrentAgentTool 优先使用节点自己的 Agent", async () => {
  const asked = [];
  const getAgent = async (agentId) => { asked.push(agentId); return { effective: { tools: ["rp_data_query"] } }; };
  const entry = { workflow: { defaults: { agentId: "demo/default" } } };
  await requireCurrentAgentTool(entry, { id: "n", agentId: "demo/node-agent" }, "rp_data_query", getAgent);
  assert.deepEqual(asked, ["demo/node-agent"]);
});

test("requireCurrentAgentTool 拒绝未获授权的工具", async () => {
  const getAgent = async () => ({ effective: { tools: ["rp_data_query"] } });
  const entry = { workflow: { defaults: { agentId: "demo/reader" } } };
  await assert.rejects(() => requireCurrentAgentTool(entry, { id: "n" }, "rp_data_submit", getAgent), /is not authorized to use rp_data_submit/);
  // 档案里没有 tools 时同样拒绝。
  await assert.rejects(() => requireCurrentAgentTool(entry, { id: "n" }, "rp_data_query", async () => ({ effective: {} })), /is not authorized/);
});

test("requireCurrentAgentTool 在没有可解析 Agent 时报错而不是放行", async () => {
  const getAgent = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => requireCurrentAgentTool({ workflow: { defaults: {} } }, { id: "n" }, "rp_data_query", getAgent), /has no Agent authorized for rp_data_query/);
});

test("currentDataNode 缺会话或 run 时必须报错，不返回半成品", () => {
  const base = {
    featureModules: [featureModule("memory")],
    getRun: () => ({ workflow: { nodes: [{ id: "write" }] } }),
    workflowRunId: "run-1",
    narrativeNodeId: "write",
  };
  assert.throws(() => currentDataNode({ ...base, sessionDirectory: null }), /require an active workflow node/);
  assert.throws(() => currentDataNode({ ...base, sessionDirectory: "/sessions/chat-1", workflowRunId: null }), /require an active workflow node/);
  // 会话与 run 都在，但 run 或节点解析不出来时才报"不可用"。
  // 注意：`sessionDirectory` 缺失会先命中前一个守卫，因此这里必须显式给出会话目录。
  assert.throws(() => currentDataNode({ ...base, sessionDirectory: "/sessions/chat-1", getRun: () => undefined }), /workflow node is unavailable/);
  assert.throws(() => currentDataNode({ ...base, sessionDirectory: "/sessions/chat-1", narrativeNodeId: "missing" }), /workflow node is unavailable/);
});

test("currentDataNode 返回节点、运行与按会话装配的 store", () => {
  const entry = { workflow: { nodes: [{ id: "write" }, { id: "review" }] }, run: { id: "run-1" } };
  const result = currentDataNode({
    sessionDirectory: "/sessions/chat-1",
    featureModules: [featureModule("memory"), { id: "lore", contract: null, moduleDirectory: "/cards/demo/features/lore", workflows: [], agents: [] }],
    getRun: () => entry,
    workflowRunId: "run-1",
    narrativeNodeId: "write",
  });
  assert.equal(result.entry, entry);
  assert.equal(result.node.id, "write");
  // store 只含有契约的模块。
  assert.deepEqual([...result.store.modules.keys()], ["memory"]);
});
