import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createApplication } from "../../../../../../packages/rp-web-server/index.mjs";
import { createCardStore } from "../../../../../../packages/rp-web-server/card-store.mjs";
import { createStaticHost } from "../../../../../../packages/rp-web-server/static-host.mjs";
import { renderCardText } from "../../pi-rp-runtime/.pi/lib/rp-card-text.mjs";

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
    "---\nid: opening-00\n---\n沈月看向{{user}}。",
    "utf8",
  );
  return cardDirectory;
}

function createApiFetch(base) {
  let readContext = null;
  return async function apiFetch(path, options = {}) {
    const url = new URL(path, base);
    if (url.pathname !== "/api/v1/connection" && readContext) {
      url.searchParams.set("readContext", JSON.stringify(readContext));
    }
    const response = await fetch(url, options);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return response;
    const envelope = await response.json();
    if (response.ok && envelope.readContext) readContext = envelope.readContext;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url,
      envelope,
      json: async () => response.ok ? envelope.data : envelope,
      text: response.text.bind(response),
      arrayBuffer: response.arrayBuffer.bind(response),
    };
  };
}

test("an opening with unresolved character macro is rejected instead of using the card title", async () => {
  const cardDirectory = await createFixture();
  await writeFile(join(cardDirectory, "openings", "00.md"), "{{char}}看向{{user}}。", "utf8");
  await assert.rejects(createCardStore(cardDirectory, renderCardText).validate(), /openings\/00\.md contains \{\{char\}\}/);
});

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
  let openedTeamTranscript = null;
  let configProfile = { schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "test-profile", name: "Test", models: [], agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {} };
  const bridge = {
    getState: async () => ({ openingId, playerName, messages, busy: false }),
    getSettings: async () => ({
      common: { schemaVersion: 1, user: { playerName, description: playerDescription, savedProfiles }, system: { fontSize } },
      card: { schemaVersion: 1, cardId: "test-card", settings: { featureModules: moduleDisplaySettings } },
    }),
    getConfigContext: async () => ({ mode: "play", scope: "card", ownerId: "test-card", token: "config-token" }),
    authorizeConfigMutation: async value => { if (value !== "config-token") throw Object.assign(new Error("Configuration session token is invalid."), { status: 403 }); },
    getConfigCatalog: async () => ({ schemaVersion: 1, agents: [], workflows: [], modules: [], runtimePolicy: workflowPolicy }),
    browseReferenceDirectories: async value=>({path:value.path,directories:[]}),
    listConfigProfiles: async () => ({ activeProfileId: "test-profile", profiles: [{ id: "builtin", name: "内置默认", builtin: true }, { id: "test-profile", name: "Test" }] }),
    getConfigProfile: async () => configProfile,
    createConfigProfile: async value => ({ ...configProfile, ...value }),
    saveConfigProfile: async value => { configProfile = value; return value; },
    renameConfigProfile: async (_id, value) => { configProfile.name = value.name; return configProfile; },
    duplicateConfigProfile: async (_id, value) => ({ ...configProfile, id: value.newId, name: value.name }),
    deleteConfigProfile: async id => ({ deleted: id, activeProfileId: "builtin" }),
    importConfigProfile: async value => value.profile,
    exportConfigProfile: async () => configProfile,
    saveConfigModelSecret: async (_profileId, modelId, value) => ({ modelId, hasSecret: Boolean(value.apiKey) }),
    activateConfigProfile: async id => ({ activeProfileId: id }),
    listFeatureModules: async () => ({
      sessionId: openingId ? "test-session" : null,
      modules: [{
        id: "character-memory", title: "角色记忆", description: "测试模块", displayOrder: 10,
        available: Boolean(openingId), view: { schemaVersion: 3, bindings: [], regions: [] }, data: openingId ? { memories: [] } : null,
      }],
    }),
    inspectDataImpact: async (messageId, revision, moduleId) => ({ messageId, revision, moduleId, matched: true, batches: [{ batchId: "batch-1" }] }),
    queryModuleFrontendRegion: async (moduleId, regionId, value) => ({ moduleId, regionId, value, returned: 1, items: [{ id: "record.one", revision: 1, value: { name: "One" } }] }),
    getModuleFrontendHistory: async (moduleId, regionId, recordId, cursor) => ({ moduleId, regionId, recordId, cursor, items: [{ revision: 1 }] }),
    getModuleFrontendSettings: async (moduleId, regionId) => ({ moduleId, regionId, record: { revision: 2 }, values: { "/enabled": true } }),
    updateModuleFrontendSettings: async (moduleId, regionId, value) => ({ moduleId, regionId, value, saved: true }),
    runModuleFrontendWorkflow: async (moduleId, regionId, workflowId, value) => ({ moduleId, regionId, workflowId, value, run: { id: "run-module" } }),
    inspectModuleFrontendIntegrity: async (moduleId, regionId) => ({ moduleId, regionId, issues: [{ type: "coverage-gap", startTurn: 3, endTurn: 4 }] }),
    openFeatureModuleDocument: async (moduleId, target) => {
      openedModuleDocument = { moduleId, target };
      return { opened: true, moduleId, target, path: `sessions/test/${moduleId}/${target}.json` };
    },
    listModels: async () => ({ current: { id: "pi:current", name: "Current", virtual: true }, profiles: savedModel ? [savedModel] : [] }),
    saveModel: async model => { savedModel = { ...model, hasApiKey: Boolean(model.apiKey) }; delete savedModel.apiKey; return savedModel; },
    discoverModels: async () => ({ models: ["test-model"] }),
    testModel: async () => ({ ok: true, elapsedMs: 1, reply: "hello" }),
    deleteModel: async modelId => { savedModel = null; return { deleted: modelId }; },
    listAgents: async () => ({ agents: [{ effective: { schemaVersion: 1, id: "demo-module/writer", name: "Writer", defaultModelId: "pi:current" }, base: {}, override: null, overridden: false }] }),
    saveAgent: async (agent, scope) => ({ effective: agent, scope }),
    restoreAgent: async agentId => ({ effective: { id: agentId }, overridden: false }),
    listWorkflows: async () => ({ activeWorkflowId: "demo-module/standard", workflows: [{ id: "demo-module/standard", ownerModuleId: "demo-module", title: "Standard", kind: "foreground", nodes: [] }] }),
    listWorkflowRuns: async () => ({ runs: [] }),
    getWorkflowNodeProcessRecord: async (runId,nodeId,callId) => ({runId,nodeId,selectedCall:{id:callId||"latest"},calls:[{id:"first"},{id:"latest"}]}),
    removeComfyConnection: async connectionId => ({removed:connectionId}),
    openWorkflowNodeProcessRecord: async (runId, nodeId) => {
      openedProcessRecord = { runId, nodeId };
      return { opened: true, path: `workflow/process-records/${runId}/${nodeId}.md` };
    },
    openWorkflowTeamTranscript: async (runId, nodeId) => {
      openedTeamTranscript = { runId, nodeId };
      return { opened: true, path: `workflow/private/${runId}/${nodeId}/team/shared/TRANSCRIPT.md` };
    },
    getWorkflowPolicy: async () => workflowPolicy,
    saveWorkflowPolicy: async value => { workflowPolicy = value; return value; },
    activateWorkflow: async workflowId => ({ activated: workflowId }),
    updateWorkflowNodeBinding: async (workflowId, nodeId, binding) => ({ workflowId, nodeId, binding }),
    updateWorkflowTrigger: async (workflowId, trigger) => ({ workflowId, trigger }),
    retryWorkflowNode: async (runId, nodeId, value) => ({ runId, nodeId, ...value }),
    recoverWorkflowNode: async (runId, nodeId) => ({ runId, nodeId, status: "running" }),
    cancelWorkflowRun: async runId => ({ id: runId, status: "cancelled" }),
    skipWorkflowRun: async runId => ({ id: runId, status: "skipped" }),
    getImageGeneration: async () => ({ available: true, sessionId: "test-session", profiles: [{ id: "demo", title: "Demo" }], connections: [], preferences: null, requests: [], renders: [] }),
    getComfyConnections: async () => ({ connections: [{ id: "saved", title: "Saved connection", baseUrl: "http://127.0.0.1:8188", hasToken: true }] }),
    saveImagePreferences: async preferences => ({ saved: true, preferences }),
    startImageGeneration: async () => ({ accepted: true, runId: "image-run-1" }),
    recoverImageGeneration: async requestId => ({ accepted: true, requestId }),
    saveComfyConnection: async value => ({ ...value, hasToken: Boolean(value.token), token: undefined }),
    testComfyConnection: async (id,draft)=>({ok:true,elapsedMs:2,cacheConnectionId:id,draft}),
    saveComfyProfileOverride: async () => ({ saved: true }),
    openComfyProfileDocument: async () => ({ opened: true }),
    getComfyRenderImage: async () => ({ body: Buffer.from([1, 2, 3]), mimeType: "image/png" }),
    regenerateComfyRender: async () => ({ accepted: true, requestId: "image-request-2" }),
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
  const server = createServer(createApplication({
    cardStore: createCardStore(cardDirectory, renderCardText),
    bridge,
    staticHost: createStaticHost({ root: fileURLToPath(new URL("../public/", import.meta.url)) }),
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const apiFetch = createApiFetch(base);

  try {
    const connectionResponse = await apiFetch(`${base}/api/v1/connection`);
    assert.equal(connectionResponse.status, 200);
    const connection = connectionResponse.envelope.data;
    assert.deepEqual(connection.apiVersion, { major: 1, minor: 0 });
    assert.deepEqual(connection.hostVersion, { major: 1, minor: 0 });
    assert.ok(connection.readContext?.serverInstanceId);
    const pageResponse = await fetch(`${base}/`);
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get("cache-control"), "no-cache");
    const page = await pageResponse.text();
    assert.match(page, /id="tab-profiles"/);
    assert.doesNotMatch(page, /id="tab-api"/);
    assert.doesNotMatch(page, /id="tab-agents"/);
    assert.match(page, /id="panel-profiles"/);
    assert.match(page, /src="\/config\.js\?v=4"/);

    // Configuration has a dedicated static entry alongside the API.
    const legacyConfigResponse = await fetch(`${base}/config.html`);
    assert.equal(legacyConfigResponse.status, 200);
    assert.match(await legacyConfigResponse.text(), /config-panel/);

    const card = await apiFetch(`${base}/api/v1/card`).then(response => response.json());
    assert.equal(card.name, "沈月");
    assert.equal(card.openings[0].content, "沈月看向{{user}}。");

    const sessions = await apiFetch(`${base}/api/v1/sessions`).then(response => response.json());
    assert.equal(sessions[0].id, "saved-01");

    const initialSettings = await apiFetch(`${base}/api/v1/settings`).then(response => response.json());
    assert.equal(initialSettings.common.system.fontSize, 16);
    assert.deepEqual(initialSettings.card.settings.featureModules, { order: ["character-memory"], hidden: [] });
    const configContext = await apiFetch(`${base}/api/v1/config/context`).then(response => response.json());
    assert.equal(configContext.scope, "card");
    const configCatalog = await apiFetch(`${base}/api/v1/config/catalog`).then(response => response.json());
    assert.equal(configCatalog.runtimePolicy.maxConcurrency, 10);
    const deniedDirectoryBrowse=await apiFetch(`${base}/api/v1/config/reference-library/directories`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"/library"})});
    assert.equal(deniedDirectoryBrowse.status,403);
    const browsed=await apiFetch(`${base}/api/v1/config/reference-library/directories`,{method:"POST",headers:{"content-type":"application/json","x-rp-config-token":"config-token"},body:JSON.stringify({path:"/library"})}).then(response=>response.json());
    assert.equal(browsed.path,"/library");
    const draftConnection={id:"draft",baseUrl:"http://127.0.0.1:12345",token:"synthetic-test-token"};
    const independentConnections=await apiFetch(`${base}/api/v1/image-generation/connections`).then(response=>response.json());
    assert.equal(independentConnections.connections[0].id,"saved");
    assert.equal(independentConnections.connections[0].hasToken,true);
    assert.equal(independentConnections.connections[0].token,undefined);
    const testedConnection=await apiFetch(`${base}/api/v1/image-generation/connections/local/test`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(draftConnection)}).then(response=>response.json());
    assert.equal(testedConnection.cacheConnectionId,"local");assert.deepEqual(testedConnection.draft,draftConnection);
    assert.equal((await apiFetch(`${base}/api/v1/config/profiles`).then(response => response.json())).activeProfileId, "test-profile");
    const deniedConfigSave = await apiFetch(`${base}/api/v1/config/profiles/test-profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(configProfile) });
    assert.equal(deniedConfigSave.status, 403);
    const deniedConfigError = await deniedConfigSave.json();
    assert.equal(deniedConfigError.error.code, "forbidden");
    assert.equal(deniedConfigError.error.retryable, false);
    assert.ok(deniedConfigError.requestId);
    const configSave = await apiFetch(`${base}/api/v1/config/profiles/test-profile`, { method: "PUT", headers: { "content-type": "application/json", "x-rp-config-token": "config-token" }, body: JSON.stringify({ ...configProfile, name: "Saved" }) });
    assert.equal(configSave.status, 200);
    assert.equal((await configSave.json()).name, "Saved");

    const initialModules = await apiFetch(`${base}/api/v1/modules`).then(response => response.json());
    assert.equal(initialModules.modules[0].id, "character-memory");
    assert.equal(initialModules.modules[0].available, false);
    const impact = await apiFetch(`${base}/api/v1/data-impact?messageId=message.one&revision=2&moduleId=character-memory`).then(response => response.json());
    assert.deepEqual({ messageId: impact.messageId, revision: impact.revision, moduleId: impact.moduleId }, { messageId: "message.one", revision: 2, moduleId: "character-memory" });
    const records = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/entries/records?search=one&filter.kind=a`).then(response => response.json());
    assert.equal(records.items[0].id, "record.one");
    assert.deepEqual(records.value.filters, { kind: "a" });
    const history = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/entries/records/record.one/history`).then(response => response.json());
    assert.equal(history.recordId, "record.one");
    const frontendSettings = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/settings/settings`).then(response => response.json());
    assert.equal(frontendSettings.record.revision, 2);
    const savedFrontendSettings = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/settings/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2, operationId: "settings-save-1", values: { "/enabled": false } }) }).then(response => response.json());
    assert.equal(savedFrontendSettings.saved, true);
    const integrityResponse = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/integrity/integrity`);
    const integrity = await integrityResponse.json();
    assert.deepEqual([integrity.moduleId, integrity.regionId, integrity.issues[0].startTurn], ["character-memory", "integrity", 3]);
    const moduleRun = await apiFetch(`${base}/api/v1/modules/character-memory/bindings/tools/workflows/character-memory-maintain/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: {} }) }).then(response => response.json());
    assert.equal(moduleRun.run.id, "run-module");
    const openedDefinition = await apiFetch(`${base}/api/v1/modules/character-memory/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "definition" }) }).then(response => response.json());
    assert.equal(openedDefinition.opened, true);
    assert.deepEqual(openedModuleDocument, { moduleId: "character-memory", target: "definition" });
    const imageGeneration = await apiFetch(`${base}/api/v1/image-generation`).then(response => response.json());
    assert.equal(imageGeneration.profiles[0].id, "demo");
    const imagePreferences = { selectedProfileIds: ["demo"], quickMode: true, inputPolicy: { kind: "recent-turns", turnCount: 3, target: "latest" } };
    const savedImagePreferences = await apiFetch(`${base}/api/v1/image-generation/preferences`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(imagePreferences) });
    assert.equal(savedImagePreferences.status, 200);
    assert.deepEqual((await savedImagePreferences.json()).preferences, imagePreferences);
    const imageRun = await apiFetch(`${base}/api/v1/image-generation/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileIds: ["demo"] }) });
    assert.equal(imageRun.status, 202);
    assert.equal((await imageRun.json()).runId, "image-run-1");

    const modelSaveResponse = await apiFetch(`${base}/api/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, id: "test", provider: "custom", model: "test-model", apiKey: "secret" }) });
    assert.equal(modelSaveResponse.status, 404);
    assert.deepEqual((await apiFetch(`${base}/api/v1/models`).then(response => response.json())).profiles, []);
    assert.deepEqual((await apiFetch(`${base}/api/v1/models/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json())).models, ["test-model"]);
    assert.equal((await apiFetch(`${base}/api/v1/models/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "test" }) }).then(response => response.json())).reply, "hello");
    assert.equal((await apiFetch(`${base}/api/v1/agents`).then(response => response.json())).agents[0].effective.id, "demo-module/writer");
    assert.equal((await apiFetch(`${base}/api/v1/workflows`).then(response => response.json())).activeWorkflowId, "demo-module/standard");
    const fullAgentId = "demo-module/writer";
    const savedAgent = await apiFetch(`${base}/api/v1/agents/${encodeURIComponent(fullAgentId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ignored", name: "Writer" }),
    });
    assert.equal(savedAgent.status, 404);
    const rejectedBareAgent = await apiFetch(`${base}/api/v1/agents/writer`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Writer" }),
    });
    assert.equal(rejectedBareAgent.status, 404);
    const restoredAgent = await apiFetch(`${base}/api/v1/agents/${encodeURIComponent(fullAgentId)}/restore`, { method: "POST" });
    assert.equal(restoredAgent.status, 404);
    const fullWorkflowId = "demo-module/standard";
    const activatedWorkflow = await apiFetch(`${base}/api/v1/workflows/${encodeURIComponent(fullWorkflowId)}/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(activatedWorkflow.status, 202);
    assert.equal((await activatedWorkflow.json()).activated, fullWorkflowId);
    const rejectedBareWorkflow = await apiFetch(`${base}/api/v1/workflows/standard/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(rejectedBareWorkflow.status, 400);
    const bindingResponse = await apiFetch(`${base}/api/v1/workflows/${encodeURIComponent(fullWorkflowId)}/nodes/story/binding`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: fullAgentId }) });
    assert.equal(bindingResponse.status, 404);
    const triggerResponse = await apiFetch(`${base}/api/v1/workflows/${encodeURIComponent(fullWorkflowId)}/trigger`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "manual" }) });
    assert.equal(triggerResponse.status, 404);
    assert.equal((await apiFetch(`${base}/api/v1/workflow-policy`).then(response => response.json())).maxConcurrency, 10);
    const viewedProcess = await apiFetch(`${base}/api/v1/workflow-runs/run-1/nodes/story/process-record?callId=first`).then(response => response.json());
    const removedConnection=await apiFetch(`${base}/api/v1/image-generation/connections/test-remove`,{method:"DELETE"}).then(response=>response.json());
    assert.equal(removedConnection.removed,"test-remove");
    assert.equal(viewedProcess.selectedCall.id,"first");
    assert.equal(viewedProcess.nodeId,"story");
    const openedProcess = await apiFetch(`${base}/api/v1/workflow-runs/run-1/nodes/story/process-record/open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json());
    assert.equal(openedProcess.opened, true);
    assert.deepEqual(openedProcessRecord, { runId: "run-1", nodeId: "story" });
    const openedTranscript = await apiFetch(`${base}/api/v1/workflow-runs/run-1/nodes/meeting/team-transcript/open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json());
    assert.equal(openedTranscript.opened, true);
    assert.deepEqual(openedTeamTranscript, { runId: "run-1", nodeId: "meeting" });
    const recoveredNodeResponse = await apiFetch(`${base}/api/v1/workflow-runs/run-1/nodes/story/recover`, { method: "POST" });
    assert.equal(recoveredNodeResponse.status, 202);
    const recoveredNode = await recoveredNodeResponse.json();
    assert.deepEqual(recoveredNode, { runId: "run-1", nodeId: "story", status: "running" });
    const recoveredImageResponse = await apiFetch(`${base}/api/v1/image-generation/requests/image-request-one/recover`, { method: "POST" });
    assert.equal(recoveredImageResponse.status, 202);
    const recoveredImage = await recoveredImageResponse.json();
    assert.deepEqual(recoveredImage, { accepted: true, requestId: "image-request-one" });
    const skippedRun = await apiFetch(`${base}/api/v1/workflow-runs/run-1/skip`, { method: "POST" }).then(response => response.json());
    assert.equal(skippedRun.status, "skipped");
    const savedPolicy = await apiFetch(`${base}/api/v1/workflow-policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, maxConcurrency: 8, modelFailure: { silentFallback: false, defaultFallbackModelId: null } }) });
    assert.equal(savedPolicy.status, 404);
    assert.equal((await apiFetch(`${base}/api/v1/workflow-policy`).then(response => response.json())).maxConcurrency, 10);

    const cards = await apiFetch(`${base}/api/v1/cards`).then(response => response.json());
    assert.equal(cards[0].name, "沈月");
    const coverResponse = await apiFetch(`${base}/api/v1/cards/test-card/cover`);
    assert.equal(coverResponse.headers.get("content-type"), "image/png");

    const openingResponse = await apiFetch(`${base}/api/v1/opening`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingId: "opening-00", playerName: "旅人" }),
    });
    assert.equal(openingResponse.status, 201);
    const opened = await openingResponse.json();
    assert.equal(opened.messages[0].content, "沈月看向旅人。");
    const openedModules = await apiFetch(`${base}/api/v1/modules`).then(response => response.json());
    assert.equal(openedModules.sessionId, "test-session");
    assert.equal(openedModules.modules[0].available, true);

    const inputResponse = await apiFetch(`${base}/api/v1/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我向她点头。", operationId: "input-1" }),
    });
    assert.equal(inputResponse.status, 202);
    assert.equal(submitted, "我向她点头。");

    const snapshot = await apiFetch(`${base}/api/v1/state`).then(response => response.json());
    assert.equal(snapshot.openingId, "opening-00");

    const settingsResponse = await apiFetch(`${base}/api/v1/user-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerName: "远行者", description: "来自北境的旅人。" }),
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.playerName, "远行者");
    assert.equal(playerDescription, "来自北境的旅人。");

    const deleteProfileResponse = await apiFetch(`${base}/api/v1/user-profile?playerName=${encodeURIComponent("旧用户")}`, { method: "DELETE" });
    assert.equal(deleteProfileResponse.status, 200);
    const deletedProfile = await deleteProfileResponse.json();
    assert.equal(deletedProfile.deletedPlayerName, "旧用户");
    assert.equal(deletedProfile.settings.user.savedProfiles.some(profile => profile.name === "旧用户"), false);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const avatarUploadResponse = await apiFetch(`${base}/api/v1/user-avatar?playerName=${encodeURIComponent("远行者")}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    assert.equal(avatarUploadResponse.status, 200);
    assert.deepEqual(avatarBody, png);
    const avatarResponse = await apiFetch(`${base}/api/v1/user-avatar?playerName=${encodeURIComponent("远行者")}`);
    assert.equal(avatarResponse.status, 200);
    assert.equal(avatarResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await avatarResponse.arrayBuffer()), png);

    const invalidAvatarResponse = await apiFetch(`${base}/api/v1/user-avatar?playerName=${encodeURIComponent("远行者")}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from("not an image"),
    });
    assert.equal(invalidAvatarResponse.status, 400);

    const systemSettingsResponse = await apiFetch(`${base}/api/v1/system-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fontSize: 19 }),
    });
    assert.equal(systemSettingsResponse.status, 200);
    const systemSettings = await systemSettingsResponse.json();
    assert.equal(systemSettings.common.system.fontSize, 19);

    const moduleSettingsResponse = await apiFetch(`${base}/api/v1/module-display-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["character-memory"], hidden: ["character-memory"] }),
    });
    assert.equal(moduleSettingsResponse.status, 200);
    const moduleSettings = await moduleSettingsResponse.json();
    assert.deepEqual(moduleSettings.card.settings.featureModules.hidden, ["character-memory"]);

    const invalidModuleSettingsResponse = await apiFetch(`${base}/api/v1/module-display-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["character-memory", "character-memory"], hidden: [] }),
    });
    assert.equal(invalidModuleSettingsResponse.status, 400);

    const resumeResponse = await apiFetch(`${base}/api/v1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "saved-01" }),
    });
    assert.equal(resumeResponse.status, 200);
    assert.equal(resumed, "saved-01");

    const switchResponse = await apiFetch(`${base}/api/v1/card-switch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "another-card" }),
    });
    assert.equal(switchResponse.status, 202);
    assert.equal(switched, "another-card");

    await apiFetch(`${base}/api/v1/card-switch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "test-card", forceNew: true }),
    });
    assert.equal(switched, "test-card");
    assert.equal(switchForceNew, true);

    const editMessageResponse = await apiFetch(`${base}/api/v1/messages/0`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "修改后的开场。", expectedRevision: 1, operationId: "message-edit-1" }),
    });
    assert.equal(editMessageResponse.status, 200);
    assert.equal(messages[0].content, "修改后的开场。");

    messages.push(
      { sequence: 1, turn: 1, role: "user", kind: "message", content: "第一步。" },
      { sequence: 2, turn: 1, role: "assistant", kind: "message", content: "第一步的回应。" },
    );
    const truncateMessageResponse = await apiFetch(`${base}/api/v1/messages/1`, { method: "DELETE" });
    assert.equal(truncateMessageResponse.status, 200);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "修改后的开场。");

    const deleteMessageResponse = await apiFetch(`${base}/api/v1/messages/0`, { method: "DELETE" });
    assert.equal(deleteMessageResponse.status, 200);
    assert.equal(messages.length, 0);

    const deleteResponse = await apiFetch(`${base}/api/v1/sessions/saved-01`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted, "saved-01");
  } finally {
    server.close();
    await once(server, "close");
  }
});
