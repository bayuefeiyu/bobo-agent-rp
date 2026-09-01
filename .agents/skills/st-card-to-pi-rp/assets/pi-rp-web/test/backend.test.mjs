import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../server.mjs";
import { createCardStore } from "../server/card-store.mjs";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-rp-web-"));
  const cardDirectory = join(root, "card");
  await mkdir(join(cardDirectory, "openings"), { recursive: true });
  await writeFile(join(cardDirectory, "manifest.json"), JSON.stringify({
    id: "test-card",
    name: "沈月",
    openings: [{ id: "opening-00", title: "初遇", file: "openings/00.md" }],
    default_opening: "opening-00",
  }), "utf8");
  await writeFile(
    join(cardDirectory, "openings", "00.md"),
    "---\nid: opening-00\n---\n{{char}}看向{{user}}。",
    "utf8",
  );
  return cardDirectory;
}

test("card-local server only transports view state and player input", async () => {
  const cardDirectory = await createFixture();
  const messages = [];
  let openingId = null;
  let playerName = "玩家";
  let submitted = null;
  let resumed = null;
  let deleted = null;
  let switched = null;
  let switchForceNew = false;
  let playerDescription = "";
  let savedProfiles = [{ name: "玩家", description: "" }, { name: "旧用户", description: "旧设定" }];
  let fontSize = 16;
  let moduleDisplaySettings = { order: ["character-memory"], hidden: [] };
  let avatarBody = null;
  let avatarMimeType = null;
  let savedModel = null;
  let workflowPolicy = { schemaVersion: 1, maxConcurrency: 10, modelFailure: { silentFallback: false, defaultFallbackModelId: null } };
  let openedModuleDocument = null;
  let openedProcessRecord = null;
  const bridge = {
    getState: async () => ({ openingId, playerName, messages, busy: false }),
    getSettings: async () => ({
      common: { schemaVersion: 1, user: { playerName, description: playerDescription, savedProfiles }, system: { fontSize } },
      card: { schemaVersion: 1, cardId: "test-card", settings: { featureModules: moduleDisplaySettings } },
    }),
    listFeatureModules: async () => ({
      sessionId: openingId ? "test-session" : null,
      modules: [{
        id: "character-memory", title: "角色记忆", description: "测试模块", displayOrder: 10,
        available: Boolean(openingId), view: { schemaVersion: 1, regions: [] }, data: openingId ? { memories: [] } : null,
      }],
    }),
    openFeatureModuleDocument: async (moduleId, target) => {
      openedModuleDocument = { moduleId, target };
      return { opened: true, moduleId, target, path: `sessions/test/${moduleId}/${target}.json` };
    },
    listModels: async () => ({ current: { id: "pi:current", name: "Current", virtual: true }, profiles: savedModel ? [savedModel] : [] }),
    saveModel: async model => { savedModel = { ...model, hasApiKey: Boolean(model.apiKey) }; delete savedModel.apiKey; return savedModel; },
    discoverModels: async () => ({ models: ["test-model"] }),
    testModel: async () => ({ ok: true, elapsedMs: 1, reply: "hello" }),
    deleteModel: async modelId => { savedModel = null; return { deleted: modelId }; },
    listAgents: async () => ({ agents: [{ effective: { schemaVersion: 1, id: "writer", name: "Writer", defaultModelId: "pi:current" }, base: {}, override: null, overridden: false }] }),
    saveAgent: async (agent, scope) => ({ effective: agent, scope }),
    restoreAgent: async agentId => ({ effective: { id: agentId }, overridden: false }),
    listWorkflows: async () => ({ activeWorkflowId: "standard", workflows: [{ id: "standard", title: "Standard", kind: "foreground", nodes: [] }] }),
    listWorkflowRuns: async () => ({ runs: [] }),
    openWorkflowNodeProcessRecord: async (runId, nodeId) => {
      openedProcessRecord = { runId, nodeId };
      return { opened: true, path: `workflow/process-records/${runId}/${nodeId}.md` };
    },
    getWorkflowPolicy: async () => workflowPolicy,
    saveWorkflowPolicy: async value => { workflowPolicy = value; return value; },
    activateWorkflow: async workflowId => ({ activated: workflowId }),
    updateWorkflowNodeBinding: async (workflowId, nodeId, binding) => ({ workflowId, nodeId, binding }),
    retryWorkflowNode: async (runId, nodeId, value) => ({ runId, nodeId, ...value }),
    cancelWorkflowRun: async runId => ({ id: runId, status: "cancelled" }),
    listCards: async () => [{ id: "test-card", name: "沈月", hasCover: true }],
    getCardCover: async () => ({ body: Buffer.from([1, 2, 3]), mimeType: "image/png" }),
    getUserAvatar: async () => ({ body: avatarBody, mimeType: avatarMimeType }),
    updateUserAvatar: async avatar => {
      avatarBody = avatar.body;
      avatarMimeType = avatar.mimeType;
      return { common: (await bridge.getSettings()).common, playerName: avatar.playerName };
    },
    switchCard: async (cardId, forceNew) => { switched = cardId; switchForceNew = forceNew; return { switching: true }; },
    selectOpening: async opening => {
      openingId = opening.id;
      playerName = opening.playerName;
      messages.push({ sequence: 0, turn: 0, role: "assistant", kind: "opening", content: opening.content });
      return { openingId, playerName, messages, busy: false };
    },
    submitInput: async content => { submitted = content; },
    updateUserSettings: async settings => {
      playerName = settings.playerName;
      playerDescription = settings.description;
      const existing = savedProfiles.find(profile => profile.name === playerName);
      if (existing) existing.description = playerDescription;
      else savedProfiles.push({ name: playerName, description: playerDescription });
      return { openingId, playerName, messages, busy: false, settings: (await bridge.getSettings()).common };
    },
    deleteUserProfile: async name => {
      if (savedProfiles.length <= 1) throw Object.assign(new Error("At least one saved player profile must remain."), { status: 409 });
      const index = savedProfiles.findIndex(profile => profile.name === name);
      if (index === -1) throw Object.assign(new Error("Saved player profile was not found."), { status: 404 });
      savedProfiles.splice(index, 1);
      return { openingId, playerName, messages, busy: false, settings: (await bridge.getSettings()).common, deletedPlayerName: name };
    },
    updateSystemSettings: async settings => {
      fontSize = settings.fontSize;
      return bridge.getSettings();
    },
    updateModuleDisplaySettings: async settings => {
      moduleDisplaySettings = settings;
      return { card: (await bridge.getSettings()).card };
    },
    listSessions: async () => [{
      id: "saved-01", playerName: "旧玩家", openingId: "opening-00",
      messageCount: 3, lastMessage: "上次的回复", updatedAt: "2026-08-25T00:00:00.000Z",
    }],
    resumeSession: async sessionId => {
      resumed = sessionId;
      return { openingId: "opening-00", playerName: "旧玩家", messages, busy: false };
    },
    deleteSession: async sessionId => { deleted = sessionId; return { deleted: sessionId }; },
    updateMessage: async (sequence, content) => {
      const message = messages.find(item => item.sequence === sequence);
      if (!message) throw Object.assign(new Error("Saved message was not found."), { status: 404 });
      message.content = content;
      message.editedAt = "2026-08-26T01:00:00.000Z";
      return { openingId, playerName, messages, busy: false };
    },
    deleteMessage: async sequence => {
      const index = messages.findIndex(item => item.sequence === sequence);
      if (index === -1) throw Object.assign(new Error("Saved message was not found."), { status: 404 });
      messages.splice(index);
      messages.forEach((message, nextSequence) => { message.sequence = nextSequence; });
      if (messages.length === 0) openingId = null;
      return { openingId, playerName, messages, busy: false };
    },
  };
  const server = createServer(createApplication({ cardStore: createCardStore(cardDirectory), bridge }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const pageResponse = await fetch(`${base}/`);
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get("cache-control"), "no-store");

    const card = await fetch(`${base}/api/card`).then(response => response.json());
    assert.equal(card.name, "沈月");
    assert.equal(card.openings[0].content, "{{char}}看向{{user}}。");

    const sessions = await fetch(`${base}/api/sessions`).then(response => response.json());
    assert.equal(sessions[0].id, "saved-01");

    const initialSettings = await fetch(`${base}/api/settings`).then(response => response.json());
    assert.equal(initialSettings.common.system.fontSize, 16);
    assert.deepEqual(initialSettings.card.settings.featureModules, { order: ["character-memory"], hidden: [] });

    const initialModules = await fetch(`${base}/api/modules`).then(response => response.json());
    assert.equal(initialModules.modules[0].id, "character-memory");
    assert.equal(initialModules.modules[0].available, false);
    const openedDefinition = await fetch(`${base}/api/modules/character-memory/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "definition" }) }).then(response => response.json());
    assert.equal(openedDefinition.opened, true);
    assert.deepEqual(openedModuleDocument, { moduleId: "character-memory", target: "definition" });

    const modelSaveResponse = await fetch(`${base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, id: "test", provider: "custom", model: "test-model", apiKey: "secret" }) });
    assert.equal(modelSaveResponse.status, 200);
    assert.equal((await fetch(`${base}/api/models`).then(response => response.json())).profiles[0].hasApiKey, true);
    assert.deepEqual((await fetch(`${base}/api/models/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json())).models, ["test-model"]);
    assert.equal((await fetch(`${base}/api/models/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "test" }) }).then(response => response.json())).reply, "hello");
    assert.equal((await fetch(`${base}/api/agents`).then(response => response.json())).agents[0].effective.id, "writer");
    assert.equal((await fetch(`${base}/api/workflows`).then(response => response.json())).activeWorkflowId, "standard");
    assert.equal((await fetch(`${base}/api/workflow-policy`).then(response => response.json())).maxConcurrency, 10);
    const openedProcess = await fetch(`${base}/api/workflow-runs/run-1/nodes/story/process-record/open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json());
    assert.equal(openedProcess.opened, true);
    assert.deepEqual(openedProcessRecord, { runId: "run-1", nodeId: "story" });
    const savedPolicy = await fetch(`${base}/api/workflow-policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, maxConcurrency: 8, modelFailure: { silentFallback: false, defaultFallbackModelId: null } }) }).then(response => response.json());
    assert.equal(savedPolicy.maxConcurrency, 8);

    const cards = await fetch(`${base}/api/cards`).then(response => response.json());
    assert.equal(cards[0].name, "沈月");
    const coverResponse = await fetch(`${base}/api/cards/test-card/cover`);
    assert.equal(coverResponse.headers.get("content-type"), "image/png");

    const openingResponse = await fetch(`${base}/api/opening`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingId: "opening-00", playerName: "旅人" }),
    });
    assert.equal(openingResponse.status, 201);
    const opened = await openingResponse.json();
    assert.equal(opened.messages[0].content, "沈月看向旅人。");
    const openedModules = await fetch(`${base}/api/modules`).then(response => response.json());
    assert.equal(openedModules.sessionId, "test-session");
    assert.equal(openedModules.modules[0].available, true);

    const inputResponse = await fetch(`${base}/api/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我向她点头。" }),
    });
    assert.equal(inputResponse.status, 202);
    assert.equal(submitted, "我向她点头。");

    const snapshot = await fetch(`${base}/api/state`).then(response => response.json());
    assert.equal(snapshot.openingId, "opening-00");

    const settingsResponse = await fetch(`${base}/api/user-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerName: "远行者", description: "来自北境的旅人。" }),
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.playerName, "远行者");
    assert.equal(playerDescription, "来自北境的旅人。");

    const deleteProfileResponse = await fetch(`${base}/api/user-profile?playerName=${encodeURIComponent("旧用户")}`, { method: "DELETE" });
    assert.equal(deleteProfileResponse.status, 200);
    const deletedProfile = await deleteProfileResponse.json();
    assert.equal(deletedProfile.deletedPlayerName, "旧用户");
    assert.equal(deletedProfile.settings.user.savedProfiles.some(profile => profile.name === "旧用户"), false);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const avatarUploadResponse = await fetch(`${base}/api/user-avatar?playerName=${encodeURIComponent("远行者")}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    assert.equal(avatarUploadResponse.status, 200);
    assert.deepEqual(avatarBody, png);
    const avatarResponse = await fetch(`${base}/api/user-avatar?playerName=${encodeURIComponent("远行者")}`);
    assert.equal(avatarResponse.status, 200);
    assert.equal(avatarResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await avatarResponse.arrayBuffer()), png);

    const invalidAvatarResponse = await fetch(`${base}/api/user-avatar?playerName=${encodeURIComponent("远行者")}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from("not an image"),
    });
    assert.equal(invalidAvatarResponse.status, 400);

    const systemSettingsResponse = await fetch(`${base}/api/system-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fontSize: 19 }),
    });
    assert.equal(systemSettingsResponse.status, 200);
    const systemSettings = await systemSettingsResponse.json();
    assert.equal(systemSettings.common.system.fontSize, 19);

    const moduleSettingsResponse = await fetch(`${base}/api/module-display-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["character-memory"], hidden: ["character-memory"] }),
    });
    assert.equal(moduleSettingsResponse.status, 200);
    const moduleSettings = await moduleSettingsResponse.json();
    assert.deepEqual(moduleSettings.card.settings.featureModules.hidden, ["character-memory"]);

    const invalidModuleSettingsResponse = await fetch(`${base}/api/module-display-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["character-memory", "character-memory"], hidden: [] }),
    });
    assert.equal(invalidModuleSettingsResponse.status, 400);

    const resumeResponse = await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "saved-01" }),
    });
    assert.equal(resumeResponse.status, 200);
    assert.equal(resumed, "saved-01");

    const switchResponse = await fetch(`${base}/api/card-switch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "another-card" }),
    });
    assert.equal(switchResponse.status, 202);
    assert.equal(switched, "another-card");

    await fetch(`${base}/api/card-switch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "test-card", forceNew: true }),
    });
    assert.equal(switched, "test-card");
    assert.equal(switchForceNew, true);

    const editMessageResponse = await fetch(`${base}/api/messages/0`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "修改后的开场。" }),
    });
    assert.equal(editMessageResponse.status, 200);
    assert.equal(messages[0].content, "修改后的开场。");

    messages.push(
      { sequence: 1, turn: 1, role: "user", kind: "message", content: "第一步。" },
      { sequence: 2, turn: 1, role: "assistant", kind: "message", content: "第一步的回应。" },
    );
    const truncateMessageResponse = await fetch(`${base}/api/messages/1`, { method: "DELETE" });
    assert.equal(truncateMessageResponse.status, 200);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "修改后的开场。");

    const deleteMessageResponse = await fetch(`${base}/api/messages/0`, { method: "DELETE" });
    assert.equal(deleteMessageResponse.status, 200);
    assert.equal(messages.length, 0);

    const deleteResponse = await fetch(`${base}/api/sessions/saved-01`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted, "saved-01");
  } finally {
    server.close();
    await once(server, "close");
  }
});
