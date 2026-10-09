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
import { normalizeDataContract } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { normalizeModuleFrontendView } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-module-frontend.mjs";
import { buildConfigCatalog } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-catalog.mjs";
import { loadModuleComponents } from "../../st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-module-registry.mjs";

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

async function buildCatalog() {
  // 与单卡游玩模式共用同一份目录装配实现（rp-config-catalog.mjs）。开发模式只负责提供
  // 模块来源（global-modules/ 下的包）、文件读取与"无卡、无聊天"的作用域。
  const agents = [];
  const workflows = [];
  const modules = [];

  const entries = await readdir(modulesRoot, { withFileTypes: true });
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = resolve(modulesRoot, entry.name);
    const manifest = await loadModuleComponents(directory);
    const moduleTitle = manifest.title || manifest.id;
    for (const value of manifest.agents) {
      agents.push({ moduleId: manifest.id, moduleTitle, base: value });
    }
    for (const value of manifest.workflows) {
      workflows.push({ moduleId: manifest.id, moduleTitle, base: value });
    }
    // 交给共享构造函数的是**模块对象**：归一化的数据契约 + 归一化的前端视图 + 模块目录。
    const contract = manifest.dataContractFile ? normalizeDataContract(await json(resolve(directory, manifest.dataContractFile), {}), manifest.id) : null;
    const view = manifest.frontendViewFile ? normalizeModuleFrontendView(await json(resolve(directory, manifest.frontendViewFile), {}), contract) : null;
    modules.push({ ...manifest, contract, view });
  }

  return buildConfigCatalog({
    modules,
    readModuleDocument: async (relativePath, module) => json(resolve(module.moduleDirectory, relativePath), null),
    listAgents: async () => agents,
    listWorkflows: async () => workflows,
  });
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
    compatibility: { moduleProtocol: 7, workflowProtocol: 4 },
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
const configStore = createRpConfigStore(runtimeRoot, resolve(localRoot, "preview-card"), {
  profileStore,
  getModules: async () => Promise.all((await readdir(modulesRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => loadModuleComponents(resolve(modulesRoot, entry.name)))),
});

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
  listWorkflows: async () => ({ activeWorkflowId: null, workflows: await configStore.listWorkflows() }),
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
