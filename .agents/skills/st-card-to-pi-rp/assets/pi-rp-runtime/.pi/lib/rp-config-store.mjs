import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { normalizeAgentProfile, normalizeModelProfile, normalizeRuntimePolicy } from "./rp-model-config.mjs";
import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

async function atomicJson(path, value, { sensitive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: sensitive ? 0o700 : undefined });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: sensitive ? 0o600 : undefined });
  await rename(temporary, path);
  if (sensitive && process.platform !== "win32") await chmod(path, 0o600);
}

function mergeDefined(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergeDefined(result[key], value);
    } else result[key] = structuredClone(value);
  }
  return result;
}

async function directoryIds(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory() && SAFE_ID.test(entry.name)).map(entry => entry.name).sort();
}

function publicModel(profile) {
  const { apiKey: _apiKey, ...safe } = profile;
  return { ...safe, hasApiKey: Boolean(profile.apiKey) };
}

function systemCacheRoot() {
  if (process.env.BOBO_AGENT_RP_CACHE_DIR?.trim()) return resolve(process.env.BOBO_AGENT_RP_CACHE_DIR.trim());
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return resolve(process.env.LOCALAPPDATA, "bobo-agent-rp");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "bobo-agent-rp");
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "bobo-agent-rp");
}

function projectCacheId(root) {
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 20);
}

function cleanSecretDocument(value) {
  const models = value?.models && typeof value.models === "object" && !Array.isArray(value.models) ? value.models : {};
  return { schemaVersion: 1, models };
}

export function createRpConfigStore(rootDirectory, cardDirectory, { secretCacheDirectory = null } = {}) {
  const root = resolve(rootDirectory);
  const card = resolve(cardDirectory);
  const secretDirectory = resolve(secretCacheDirectory || systemCacheRoot(), "projects", projectCacheId(root));
  const paths = {
    root,
    card,
    models: resolve(root, "settings", "model-profiles.json"),
    modelSecrets: resolve(secretDirectory, "model-secrets.json"),
    runtime: resolve(root, "settings", "workflow-runtime.json"),
    agents: resolve(root, "agents"),
    cardAgents: resolve(card, "agents"),
    workflows: resolve(root, "workflows"),
    cardWorkflows: resolve(card, "workflows"),
  };

  async function modelDocuments({ migrate = false } = {}) {
    const models = await readJson(paths.models, { schemaVersion: 1, profiles: [] });
    if (!Array.isArray(models.profiles)) models.profiles = [];
    const secrets = cleanSecretDocument(await readJson(paths.modelSecrets, { schemaVersion: 1, models: {} }));
    let migrated = false;
    models.profiles = models.profiles.map(profile => {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
      const { apiKey, ...safe } = profile;
      if (typeof apiKey === "string" && apiKey.trim() && typeof profile.id === "string") {
        secrets.models[profile.id] = { ...(secrets.models[profile.id] || {}), apiKey: apiKey.trim() };
      }
      if ("apiKey" in profile) migrated = true;
      return safe;
    });
    if (migrate && migrated) {
      await atomicJson(paths.modelSecrets, secrets, { sensitive: true });
      await atomicJson(paths.models, models);
    }
    return { models, secrets };
  }

  return {
    paths,
    async ensure() {
      await Promise.all([
        mkdir(paths.agents, { recursive: true }),
        mkdir(paths.cardAgents, { recursive: true }),
        mkdir(paths.workflows, { recursive: true }),
        mkdir(paths.cardWorkflows, { recursive: true }),
        mkdir(dirname(paths.models), { recursive: true }),
      ]);
      const { models } = await modelDocuments({ migrate: true });
      const runtime = await readJson(paths.runtime, normalizeRuntimePolicy());
      await atomicJson(paths.models, models);
      await atomicJson(paths.runtime, normalizeRuntimePolicy(runtime));
    },
    async getRuntimePolicy() {
      return normalizeRuntimePolicy(await readJson(paths.runtime, {}));
    },
    async saveRuntimePolicy(value) {
      const policy = normalizeRuntimePolicy(value);
      await atomicJson(paths.runtime, policy);
      return policy;
    },
    async listModels({ includeSecrets = false } = {}) {
      const { models: value, secrets } = await modelDocuments({ migrate: true });
      const profiles = value.profiles.map(normalizeModelProfile);
      return profiles.map(profile => {
        const source = value.profiles.find(item => item.id === profile.id) || {};
        const apiKey = typeof secrets.models[profile.id]?.apiKey === "string" ? secrets.models[profile.id].apiKey : "";
        const combined = { ...profile, apiKey, baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "" };
        return includeSecrets ? combined : publicModel(combined);
      });
    },
    async saveModel(value) {
      const profile = normalizeModelProfile(value);
      const { models: document, secrets } = await modelDocuments({ migrate: true });
      const saved = {
        ...profile,
        baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "",
      };
      if (typeof value.apiKey === "string" && value.apiKey.trim()) {
        secrets.models[profile.id] = { ...(secrets.models[profile.id] || {}), apiKey: value.apiKey.trim() };
      }
      const index = document.profiles.findIndex(item => item.id === profile.id);
      if (index === -1) document.profiles.push(saved);
      else document.profiles[index] = saved;
      await atomicJson(paths.modelSecrets, secrets, { sensitive: true });
      await atomicJson(paths.models, document);
      return publicModel({ ...saved, apiKey: secrets.models[profile.id]?.apiKey || "" });
    },
    async removeModel(modelId) {
      assertId(modelId, "modelId");
      const { models: document, secrets } = await modelDocuments({ migrate: true });
      const before = document.profiles.length;
      document.profiles = document.profiles.filter(item => item.id !== modelId);
      if (before === document.profiles.length) throw new Error(`Unknown model profile: ${modelId}`);
      delete secrets.models[modelId];
      await atomicJson(paths.modelSecrets, secrets, { sensitive: true });
      await atomicJson(paths.models, document);
    },
    async listAgents() {
      const ids = [...new Set([...(await directoryIds(paths.agents)), ...(await directoryIds(paths.cardAgents))])].sort();
      const result = [];
      for (const id of ids) result.push(await this.getAgent(id));
      return result;
    },
    async getAgent(agentId) {
      assertId(agentId, "agentId");
      const cardBasePath = resolve(paths.cardAgents, agentId, "agent.json");
      const globalBasePath = resolve(paths.agents, agentId, "agent.json");
      const cardBase = await readJson(cardBasePath, null);
      const basePath = cardBase ? cardBasePath : globalBasePath;
      const overridePath = resolve(paths.cardAgents, agentId, "override.json");
      const base = await readJson(basePath);
      const override = await readJson(overridePath, null);
      return { effective: normalizeAgentProfile(mergeDefined(base, override)), base: normalizeAgentProfile(base), override, overridden: Boolean(override), source: cardBase ? "card" : "global" };
    },
    async saveAgent(value, { scope = "card" } = {}) {
      const profile = normalizeAgentProfile(value);
      if (scope === "global") {
        await atomicJson(resolve(paths.agents, profile.id, "agent.json"), profile);
        await rm(resolve(paths.cardAgents, profile.id, "override.json"), { force: true });
        return this.getAgent(profile.id);
      }
      const base = await readJson(resolve(paths.cardAgents, profile.id, "agent.json"), null) || await readJson(resolve(paths.agents, profile.id, "agent.json"));
      const override = {};
      for (const key of Object.keys(profile)) {
        if (JSON.stringify(profile[key]) !== JSON.stringify(normalizeAgentProfile(base)[key])) override[key] = profile[key];
      }
      delete override.schemaVersion;
      delete override.id;
      await atomicJson(resolve(paths.cardAgents, profile.id, "override.json"), override);
      return this.getAgent(profile.id);
    },
    async restoreAgent(agentId) {
      assertId(agentId, "agentId");
      await rm(resolve(paths.cardAgents, agentId, "override.json"), { force: true });
      return this.getAgent(agentId);
    },
    async listWorkflows() {
      const cardIds = await directoryIds(paths.cardWorkflows);
      const globalIds = await directoryIds(paths.workflows);
      const ids = [...new Set([...cardIds, ...globalIds])].sort();
      const result = [];
      for (const id of ids) {
        const source = cardIds.includes(id) ? "card" : "global";
        try {
          const definition = await this.getWorkflow(id);
          result.push({ ...definition, source });
        } catch (error) {
          result.push({ schemaVersion: 1, id, title: id, source, invalid: true, error: error.message, nodes: [] });
        }
      }
      return result;
    },
    async getWorkflow(workflowId) {
      assertId(workflowId, "workflowId");
      const cardPath = resolve(paths.cardWorkflows, workflowId, "workflow.json");
      const globalPath = resolve(paths.workflows, workflowId, "workflow.json");
      const raw = await readJson(cardPath, null) || await readJson(globalPath);
      const workflow = normalizeWorkflowDefinition(raw);
      if (workflow.kind.startsWith("module-")) throw new Error("Module workflows must be registered through module.json.workflowFiles, not the top-level workflow store.");
      return workflow;
    },
    async copyWorkflowToCard(workflowId) {
      const workflow = await this.getWorkflow(workflowId);
      await atomicJson(resolve(paths.cardWorkflows, workflowId, "workflow.json"), workflow);
      return workflow;
    },
    async saveCardWorkflow(value) {
      const workflow = normalizeWorkflowDefinition(value);
      if (workflow.kind.startsWith("module-")) throw new Error("Module workflows cannot be saved as top-level card workflows.");
      await atomicJson(resolve(paths.cardWorkflows, workflow.id, "workflow.json"), workflow);
      return workflow;
    },
  };
}
