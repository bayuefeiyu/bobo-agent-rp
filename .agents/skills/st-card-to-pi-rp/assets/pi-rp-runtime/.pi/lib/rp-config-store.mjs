import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
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

export function createRpConfigStore(rootDirectory, cardDirectory) {
  const root = resolve(rootDirectory);
  const card = resolve(cardDirectory);
  const paths = {
    root,
    card,
    models: resolve(root, "settings", "model-profiles.json"),
    runtime: resolve(root, "settings", "workflow-runtime.json"),
    agents: resolve(root, "agents"),
    cardAgents: resolve(card, "agents"),
    workflows: resolve(root, "workflows"),
    cardWorkflows: resolve(card, "workflows"),
  };

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
      const models = await readJson(paths.models, { schemaVersion: 1, profiles: [] });
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
      const value = await readJson(paths.models, { schemaVersion: 1, profiles: [] });
      const profiles = Array.isArray(value.profiles) ? value.profiles.map(normalizeModelProfile) : [];
      return profiles.map(profile => {
        const source = value.profiles.find(item => item.id === profile.id) || {};
        const combined = { ...profile, apiKey: typeof source.apiKey === "string" ? source.apiKey : "", baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "" };
        return includeSecrets ? combined : publicModel(combined);
      });
    },
    async saveModel(value) {
      const profile = normalizeModelProfile(value);
      const document = await readJson(paths.models, { schemaVersion: 1, profiles: [] });
      const previous = document.profiles.find(item => item.id === profile.id);
      const saved = {
        ...profile,
        baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "",
        apiKey: typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : previous?.apiKey || "",
      };
      const index = document.profiles.findIndex(item => item.id === profile.id);
      if (index === -1) document.profiles.push(saved);
      else document.profiles[index] = saved;
      await atomicJson(paths.models, document);
      return publicModel(saved);
    },
    async removeModel(modelId) {
      assertId(modelId, "modelId");
      const document = await readJson(paths.models, { schemaVersion: 1, profiles: [] });
      const before = document.profiles.length;
      document.profiles = document.profiles.filter(item => item.id !== modelId);
      if (before === document.profiles.length) throw new Error(`Unknown model profile: ${modelId}`);
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
      const basePath = resolve(paths.agents, agentId, "agent.json");
      const overridePath = resolve(paths.cardAgents, agentId, "override.json");
      const base = await readJson(basePath);
      const override = await readJson(overridePath, null);
      return { effective: normalizeAgentProfile(mergeDefined(base, override)), base: normalizeAgentProfile(base), override, overridden: Boolean(override) };
    },
    async saveAgent(value, { scope = "card" } = {}) {
      const profile = normalizeAgentProfile(value);
      if (scope === "global") {
        await atomicJson(resolve(paths.agents, profile.id, "agent.json"), profile);
        await rm(resolve(paths.cardAgents, profile.id, "override.json"), { force: true });
        return this.getAgent(profile.id);
      }
      const base = await readJson(resolve(paths.agents, profile.id, "agent.json"));
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
      return normalizeWorkflowDefinition(raw);
    },
    async copyWorkflowToCard(workflowId) {
      const workflow = await this.getWorkflow(workflowId);
      await atomicJson(resolve(paths.cardWorkflows, workflowId, "workflow.json"), workflow);
      return workflow;
    },
    async saveCardWorkflow(value) {
      const workflow = normalizeWorkflowDefinition(value);
      await atomicJson(resolve(paths.cardWorkflows, workflow.id, "workflow.json"), workflow);
      return workflow;
    },
  };
}
