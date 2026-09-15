import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createConfigProfileStore } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-profiles.mjs";
import { createRpConfigStore } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-store.mjs";
import { defaultCommonSettings, normalizeCommonSettings } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-common-settings.mjs";
import { removeSavedUserProfile } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-user-profiles.mjs";
import { createApplication } from "../../st-card-to-pi-rp/assets/pi-rp-web/server.mjs";

const repositoryRoot = resolve(process.cwd());
const runtimeRoot = resolve(repositoryRoot, ".agents", "skills", "st-card-to-pi-rp", "assets", "pi-rp-runtime");
const modulesRoot = resolve(repositoryRoot, "global-modules");
const localRoot = resolve(repositoryRoot, ".pi-rp-local");
const commonSettingsPath = resolve(localRoot, "common.json");
const avatarsRoot = resolve(localRoot, "avatars");
const token = randomBytes(24).toString("base64url");

async function json(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

async function filesNamed(root, name) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === name) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

function workflowFields(workflow) {
  const fields = [];
  if (workflow.kind === "foreground") {
    fields.push({ path: "/turnContext/recentCompleteTurns", label: "最近完整正文回合数", type: "integer", minimum: 1, maximum: 50, help: "决定正文 Agent 和依赖正文快照的工作流可读取多少个最近完整回合；下一次工作流实例生效。" });
  }
  if (workflow.defaults && typeof workflow.defaults === "object") {
    fields.push({ path: "/defaults/agentId", label: "默认 Agent", type: "agent", help: "节点没有单独指定 Agent 时使用；下一次工作流实例生效。" });
    fields.push({ path: "/defaults/modelId", label: "默认模型", type: "model", help: "节点和 Agent 都没有更高优先级模型时使用；下一次工作流实例生效。" });
  }
  for (let index = 0; index < (workflow.nodes || []).length; index += 1) {
    const node = workflow.nodes[index];
    if (node.type !== "agent") continue;
    fields.push({ path: `/nodes/${index}/agentId`, label: `${node.title || node.id} · Agent`, type: "agent", help: `${node.description || "Agent 节点"} 修改只影响之后启动的实例。` });
    fields.push({ path: `/nodes/${index}/modelId`, label: `${node.title || node.id} · 模型`, type: "model", help: "节点级模型覆盖，优先于工作流和 Agent 默认模型；下一次实例生效。" });
  }
  return fields;
}

function mergeConfigValue(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = mergeConfigValue(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

async function moduleDefaults(moduleDirectory, manifest, view) {
  if (!manifest.dataContractFile) return {};
  const contract = await json(resolve(moduleDirectory, manifest.dataContractFile), {});
  const regions = (view?.regions || []).filter(region => region.type === "settings-form");
  for (const region of regions) {
    const storage = contract.collections?.[region.collectionId]?.storage;
    const initial = storage?.initialSnapshotFile || storage?.initialRecordsFile;
    if (!initial) continue;
    const value = await json(resolve(moduleDirectory, initial), []);
    const records = Array.isArray(value) ? value : [value];
    const record = records.find(item => item?.id === region.recordId)
      || records.find(item => item?.recordType === region.recordType);
    if (record?.data && typeof record.data === "object") return record.data;
  }
  return {};
}

async function buildCatalog() {
  const agents = [];
  const workflows = [];
  const modules = [];

  for (const path of await filesNamed(resolve(runtimeRoot, "agents"), "agent.json")) {
    const value = await json(path);
    agents.push({ key: `runtime/agent/${value.id}`, group: "通用", base: value });
  }
  for (const path of await filesNamed(resolve(runtimeRoot, "workflows"), "workflow.json")) {
    const value = await json(path);
    workflows.push({ key: `runtime/workflow/${value.id}`, group: "通用", base: value, fields: workflowFields(value) });
  }

  const entries = await readdir(modulesRoot, { withFileTypes: true });
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = resolve(modulesRoot, entry.name);
    const manifest = await json(resolve(directory, "module.json"));
    if (!manifest?.id) continue;
    const group = `模块 · ${manifest.title || manifest.id}`;
    for (const path of await filesNamed(resolve(directory, "agents"), "agent.json")) {
      const value = await json(path);
      agents.push({ key: `module/${manifest.id}/agent/${value.id}`, group, moduleId: manifest.id, base: value });
    }
    const seen = new Set();
    for (const path of await filesNamed(directory, "workflow.json")) {
      const value = await json(path);
      if (!value?.id) continue;
      const key = `module/${manifest.id}/workflow/${value.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      workflows.push({ key, group, moduleId: manifest.id, base: value, fields: workflowFields(value) });
    }
    const view = manifest.frontendViewFile ? await json(resolve(directory, manifest.frontendViewFile), null) : null;
    const fields = [];
    for (const region of view?.regions || []) {
      if (region.type !== "settings-form") continue;
      for (const field of region.fields || []) fields.push({ ...field, help: field.help || region.description || manifest.description, applyMode: "new-session", regionId: region.id });
    }
    modules.push({ id: manifest.id, title: manifest.title || manifest.id, description: manifest.description || "", base: await moduleDefaults(directory, manifest, view), fields });
  }
  return { schemaVersion: 1, agents, workflows, modules };
}

function unavailable() {
  throw Object.assign(new Error("根目录开发模式只预览玩卡 UI；请在配置方案面板修改全局配置。"), { status: 409 });
}

await Promise.all([
  readFile(resolve(repositoryRoot, ".agents", "skills", "st-card-to-pi-rp", "SKILL.md")),
  readFile(resolve(modulesRoot, "narrative-memory", "module.json")),
]);
await Promise.all([
  mkdir(resolve(localRoot, "config-profiles"), { recursive: true }),
  mkdir(avatarsRoot, { recursive: true }),
]);

const profileStore = createConfigProfileStore({
  rootDirectory: repositoryRoot,
  directory: resolve(localRoot, "config-profiles"),
  scope: "global",
  ownerId: "global",
});
await profileStore.ensure();
const authoredCommonSettings = await json(resolve(runtimeRoot, "settings", "common.json"), defaultCommonSettings);
let commonSettings = normalizeCommonSettings(await json(commonSettingsPath, authoredCommonSettings));
await writeFile(commonSettingsPath, `${JSON.stringify(commonSettings, null, 2)}\n`, "utf8");
let catalog = await buildCatalog();

async function builtinProfile() {
  const document = await json(resolve(runtimeRoot, "settings", "model-profiles.json"), { profiles: [] });
  const configuredModels = Array.isArray(document.profiles) ? document.profiles : [];
  const models = configuredModels.length ? configuredModels : [{
    schemaVersion: 1, id: "custom-model", name: "自定义模型", provider: "custom", model: "", baseUrl: "",
    api: "openai-responses", contextWindow: 128000, maxOutputTokens: 4096, thinkingLevel: null,
    maxConcurrency: 10, thinking: "off", headPrompt: null, tailPrompt: null,
  }];
  return {
    schemaVersion: 1, kind: "pi-rp-config-profile", scope: "global", id: "builtin", name: "内置默认", builtin: true,
    models, agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
    compatibility: { moduleProtocol: 6, workflowProtocol: 3 },
  };
}

const initialProfiles = await profileStore.list();
if (initialProfiles.profiles.length === 1) {
  await profileStore.create({
    id: "development-default",
    name: "开发默认",
    description: "根目录开发预览的可编辑默认配置。",
    seed: await builtinProfile(),
  });
  await profileStore.activate("development-default");
}
const configStore = createRpConfigStore(runtimeRoot, resolve(localRoot, "preview-card"), { profileStore });

const previewState = () => ({
  sessionId: null,
  openingId: null,
  playerName: commonSettings.user?.playerName || "玩家",
  messages: [],
  busy: false,
  blockingWorkflows: [],
  previewMode: true,
});

function avatarPath(value) {
  if (!/^avatars\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(value || "")) throw Object.assign(new Error("Avatar path is invalid."), { status: 400 });
  return resolve(localRoot, value);
}

async function saveCommonSettings() {
  commonSettings = normalizeCommonSettings(commonSettings);
  await writeFile(commonSettingsPath, `${JSON.stringify(commonSettings, null, 2)}\n`, "utf8");
}

const cardStore = {
  getPublicCard: async () => ({ id: "development-preview", name: "通用前端开发预览", defaultOpening: null, openings: [] }),
  getOpening: unavailable,
};

const bridge = {
  getState: async () => previewState(),
  getSettings: async () => ({ common: commonSettings, card: { schemaVersion: 1, cardId: null, settings: { featureModules: { order: [], hidden: [] } } } }),
  listSessions: async () => [],
  listCards: async () => [],
  getCardCover: unavailable,
  getUserAvatar: async playerName => {
    const profile = commonSettings.user.savedProfiles.find(item => item.name === playerName);
    if (!profile?.avatar) throw Object.assign(new Error("Player avatar not found."), { status: 404 });
    const extension = profile.avatar.split(".").at(-1);
    return { body: await readFile(avatarPath(profile.avatar)), mimeType: extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg" };
  },
  listFeatureModules: async () => ({
    sessionId: null,
    modules: catalog.modules.map((module, index) => ({
      id: module.id, title: module.title, description: module.description, displayOrder: index,
      available: false, view: { schemaVersion: 2, regions: [] }, data: null,
    })),
  }),
  getImageGeneration: async () => ({ available: false, sessionId: null, profiles: [], connections: [], preferences: null, requests: [], renders: [] }),
  listModels: async () => ({ current: { id: "pi:current", name: "当前 Pi 模型", virtual: true }, profiles: await configStore.listModels() }),
  listAgents: async () => ({ agents: await configStore.listAgents() }),
  listWorkflows: async () => {
    const topLevel = (await configStore.listWorkflows()).map(workflow => ({ ...workflow, reference: workflow.id }));
    const profile = await profileStore.getActive();
    const moduleWorkflows = [];
    const entries = await readdir(modulesRoot, { withFileTypes: true });
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = resolve(modulesRoot, entry.name);
      const manifest = await json(resolve(directory, "module.json"));
      if (!manifest?.id) continue;
      for (const path of await filesNamed(directory, "workflow.json")) {
        const base = await json(path);
        if (!base?.id) continue;
        const owned = Boolean(base.ownerModuleId);
        const qualified = `module/${manifest.id}/workflow/${base.id}`;
        const override = owned ? profile?.workflowOverrides?.[qualified] || profile?.workflowOverrides?.[base.id] : null;
        const relativePath = path.slice(directory.length + 1).replaceAll("\\", "/");
        moduleWorkflows.push({
          ...mergeConfigValue(base, override),
          source: "module",
          moduleTitle: manifest.title || manifest.id,
          reference: owned ? `${manifest.id}/${base.id}` : `template/${manifest.id}/${relativePath}`,
        });
      }
    }
    return { activeWorkflowId: topLevel.find(item => item.kind === "foreground")?.id || "standard-rp", workflows: [...topLevel, ...moduleWorkflows] };
  },
  listWorkflowRuns: async () => ({ runs: [] }),
  getWorkflowPolicy: async () => configStore.getRuntimePolicy(),

  getConfigContext: async () => ({ mode: "development", scope: "global", ownerId: "global", token }),
  authorizeConfigMutation: async value => {
    if (value !== token) throw Object.assign(new Error("Configuration session token is invalid."), { status: 403 });
  },
  getConfigCatalog: async () => ({ ...catalog, runtimePolicy: await configStore.getRuntimePolicy() }),
  listConfigProfiles: async () => profileStore.list(),
  getConfigProfile: async id => id === "builtin" ? builtinProfile() : profileStore.get(id),
  createConfigProfile: async value => {
    const seed = value.seedFromId === "builtin" ? await builtinProfile() : value.seedFromId ? await profileStore.exportProfile(value.seedFromId) : null;
    return profileStore.create({ id: value.id, name: value.name, description: value.description, seed });
  },
  saveConfigProfile: async value => profileStore.save(value),
  renameConfigProfile: async (id, value) => profileStore.rename(id, value.name),
  duplicateConfigProfile: async (id, value) => profileStore.duplicate(id, value),
  deleteConfigProfile: async id => profileStore.remove(id),
  importConfigProfile: async value => profileStore.importProfile(value.profile, { id: value.id, name: value.name }),
  exportConfigProfile: async id => profileStore.exportProfile(id),
  saveConfigModelSecret: async (profileId, modelId, value) => profileStore.saveModelSecret(profileId, modelId, value.apiKey || ""),
  activateConfigProfile: async id => ({ ...(await profileStore.activate(id)), appliesToExistingModuleData: false, workflowInstancesKeepStartSnapshot: true }),

  selectOpening: unavailable,
  submitInput: unavailable,
  updateUserSettings: async ({ playerName, description }) => {
    commonSettings.user.playerName = playerName;
    commonSettings.user.description = description;
    const existing = commonSettings.user.savedProfiles.find(item => item.name === playerName);
    if (existing) existing.description = description;
    else commonSettings.user.savedProfiles.push({ name: playerName, description });
    await saveCommonSettings();
    return { ...previewState(), playerName, settings: commonSettings };
  },
  updateUserAvatar: async ({ playerName, mimeType, body }) => {
    let profile = commonSettings.user.savedProfiles.find(item => item.name === playerName);
    if (!profile) {
      profile = { name: playerName, description: playerName === commonSettings.user.playerName ? commonSettings.user.description : "" };
      commonSettings.user.savedProfiles.push(profile);
    }
    const previousAvatar = profile.avatar;
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const digest = createHash("sha256").update(playerName.normalize("NFC"), "utf8").digest("hex");
    profile.avatar = `avatars/${digest}.${extension}`;
    await writeFile(avatarPath(profile.avatar), body);
    await saveCommonSettings();
    if (previousAvatar && previousAvatar !== profile.avatar) await rm(avatarPath(previousAvatar), { force: true });
    return { common: commonSettings, playerName };
  },
  deleteUserProfile: async playerName => {
    const { settings, removed } = removeSavedUserProfile(commonSettings, playerName);
    commonSettings = settings;
    await saveCommonSettings();
    if (removed.avatar && !commonSettings.user.savedProfiles.some(profile => profile.avatar === removed.avatar)) await rm(avatarPath(removed.avatar), { force: true });
    return { ...previewState(), playerName: commonSettings.user.playerName, settings: commonSettings, deletedPlayerName: removed.name };
  },
  switchCard: unavailable,
  updateSystemSettings: async ({ fontSize }) => {
    commonSettings.system.fontSize = fontSize;
    await saveCommonSettings();
    return { common: commonSettings, card: { schemaVersion: 1, cardId: null, settings: { featureModules: { order: [], hidden: [] } } } };
  },
  updateModuleDisplaySettings: unavailable,
  resumeSession: unavailable,
  updateMessage: unavailable,
  deleteMessage: unavailable,
  deleteSession: unavailable,
  saveModel: unavailable,
  discoverModels: unavailable,
  testModel: unavailable,
  deleteModel: unavailable,
  saveAgent: unavailable,
  restoreAgent: unavailable,
  saveWorkflowPolicy: unavailable,
  activateWorkflow: unavailable,
  updateWorkflowNodeBinding: unavailable,
  updateWorkflowTrigger: unavailable,
};

const server = createServer(createApplication({ cardStore, bridge }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const url = `http://127.0.0.1:${address.port}/#token=${encodeURIComponent(token)}`;
if (process.env.BOBO_AGENT_RP_NO_OPEN !== "1") {
  if (process.platform === "win32") execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  else if (process.platform === "darwin") execFile("open", [url]);
  else execFile("xdg-open", [url]);
}
console.log(`Pi RP development preview UI: ${url}`);
console.log("Open 配置方案 in the shared sidebar to manage global profiles. Press Ctrl+C to stop.");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
