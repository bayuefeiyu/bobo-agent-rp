import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { normalizeAgentProfile, normalizeModelProfile, normalizeRuntimePolicy } from "./rp-model-config.mjs";
import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolveActiveForegroundWorkflow(workflows, configured = null) {
  const cardForeground = (Array.isArray(workflows) ? workflows : [])
    .filter(workflow => workflow?.source === "card" && workflow.kind === "foreground" && workflow.invalid !== true);
  if (typeof configured === "string" && configured.trim()) {
    const selected = cardForeground.find(workflow => workflow.id === configured);
    if (!selected) throw new Error(`Configured active workflow ${configured} must reference a valid card-local foreground workflow.`);
    return selected.id;
  }
  if (cardForeground.length === 1) return cardForeground[0].id;
  if (cardForeground.length === 0) throw new Error("The card declares no foreground workflow. Add one below workflows/ before opening Web mode.");
  throw new Error(`The card declares multiple foreground workflows (${cardForeground.map(workflow => workflow.id).join(", ")}); set settings.activeWorkflowId to choose one.`);
}

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

export function createRpConfigStore(rootDirectory, cardDirectory, { secretCacheDirectory = null, profileStore = null, resolveModuleWorkflow = null } = {}) {
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
    moduleWorkflowOverrides: resolve(card, "module-workflow-overrides.json"),
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

  async function activeProfile() {
    return profileStore ? profileStore.getActive() : null;
  }

  async function profileModel(profile, value, includeSecrets) {
    const normalized = normalizeModelProfile(value);
    const apiKey = await profileStore.getModelSecret(profile.id, normalized.id);
    const combined = {
      ...normalized,
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "",
      apiKey,
    };
    return includeSecrets ? combined : publicModel(combined);
  }

  function profileAgentOverride(profile, agentId) {
    if (!profile) return null;
    if (profile.agentOverrides?.[agentId]) return profile.agentOverrides[agentId];
    const key = Object.keys(profile.agentOverrides || {}).find(item => item.endsWith(`/agent/${agentId}`));
    return key ? profile.agentOverrides[key] : null;
  }

  function profileWorkflowOverride(profile, workflowId) {
    if (!profile) return null;
    if (profile.workflowOverrides?.[workflowId]) return profile.workflowOverrides[workflowId];
    const key = Object.keys(profile.workflowOverrides || {}).find(item => item.endsWith(`/workflow/${workflowId}`));
    return key ? profile.workflowOverrides[key] : null;
  }

  /**
   * Overrides are keyed by owner first. A module workflow and a top-level workflow may legally share
   * `workflowId`, and "save as default" must only ever touch the definition the failed run came
   * from — including when the two owners live in different storage layers.
   */
  function workflowOverrideKey(ownerModuleId, workflowId) {
    return ownerModuleId ? `${ownerModuleId}/workflow/${workflowId}` : workflowId;
  }

  function profileOwnerWorkflowOverride(profile, ownerModuleId, workflowId) {
    if (!profile) return null;
    const overrides = profile.workflowOverrides || {};
    const exact = workflowOverrideKey(ownerModuleId, workflowId);
    if (overrides[exact]) return overrides[exact];
    for (const [key, value] of Object.entries(overrides)) {
      if (key === exact || key.endsWith(`/${exact}`)) return value;
    }
    return ownerModuleId ? null : profileWorkflowOverride(profile, workflowId);
  }

  async function moduleWorkflowOverrides() {
    const document = await readJson(paths.moduleWorkflowOverrides, { schemaVersion: 1, workflows: {} });
    if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.workflows !== "object" || document.workflows === null || Array.isArray(document.workflows)) {
      throw new Error("Card module-workflow overrides must be a schemaVersion 1 document with a workflows object.");
    }
    return document;
  }

  /**
   * Resolve a workflow definition by owner. Every caller that has a persisted run — restore, retry,
   * panel actions — resolves through this, so a module workflow is never looked up in the top-level
   * store (which is what made panel retry answer `Workflow <id> was not found`).
   */
  async function resolveOwnedWorkflow(ownerModuleId, workflowId) {
    assertId(workflowId, "workflowId");
    const profile = await activeProfile();
    if (!ownerModuleId) {
      const cardPath = resolve(paths.cardWorkflows, workflowId, "workflow.json");
      const globalPath = resolve(paths.workflows, workflowId, "workflow.json");
      const raw = await readJson(cardPath, null) || await readJson(globalPath, null);
      if (!raw) throw new Error(`Workflow ${workflowId} was not found in the card or the shared runtime.`);
      const workflow = normalizeWorkflowDefinition(mergeDefined(raw, profileWorkflowOverride(profile, workflowId)));
      if (workflow.kind.startsWith("module-")) throw new Error(`Module workflow ${workflowId} must be resolved through its owning module, not the top-level workflow store.`);
      return workflow;
    }
    assertId(ownerModuleId, "ownerModuleId");
    if (typeof resolveModuleWorkflow !== "function") throw new Error(`Module workflow ${ownerModuleId}/${workflowId} cannot be resolved: the card has no feature-module registry.`);
    const raw = await resolveModuleWorkflow(ownerModuleId, workflowId);
    if (!raw) throw new Error(`Module workflow ${ownerModuleId}/${workflowId} was not found in the loaded card modules.`);
    const stored = profile ? null : (await moduleWorkflowOverrides()).workflows[workflowOverrideKey(ownerModuleId, workflowId)] || null;
    const workflow = normalizeWorkflowDefinition(mergeDefined(raw, profileOwnerWorkflowOverride(profile, ownerModuleId, workflowId) || stored));
    if (workflow.kind !== "module-external" && workflow.kind !== "module-internal") throw new Error(`Workflow ${ownerModuleId}/${workflowId} must be a module workflow.`);
    if (workflow.ownerModuleId && workflow.ownerModuleId !== ownerModuleId) throw new Error(`Module workflow ${ownerModuleId}/${workflowId} declares owner ${workflow.ownerModuleId}.`);
    return workflow;
  }

  /** Where an edited module workflow is written: the active profile, or the card's override layer. */
  async function saveModuleWorkflowOverride(value) {
    const workflow = normalizeWorkflowDefinition(value);
    if (!workflow.kind.startsWith("module-") || !workflow.ownerModuleId) throw new Error("Only an owned module workflow can be saved as a module override.");
    if (typeof resolveModuleWorkflow !== "function") throw new Error(`Module workflow ${workflow.ownerModuleId}/${workflow.id} cannot be resolved: the card has no feature-module registry.`);
    const profile = await activeProfile();
    if (profile) {
      profile.workflowOverrides[workflowOverrideKey(workflow.ownerModuleId, workflow.id)] = workflow;
      await profileStore.save(profile);
      return workflow;
    }
    const document = await moduleWorkflowOverrides();
    document.workflows[workflowOverrideKey(workflow.ownerModuleId, workflow.id)] = workflow;
    await atomicJson(paths.moduleWorkflowOverrides, document);
    return workflow;
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
      const base = normalizeRuntimePolicy(await readJson(paths.runtime, {}));
      const profile = await activeProfile();
      return normalizeRuntimePolicy(mergeDefined(base, profile?.workflowOverrides?.runtimePolicy));
    },
    async saveRuntimePolicy(value) {
      const policy = normalizeRuntimePolicy(value);
      const profile = await activeProfile();
      if (profile) {
        profile.workflowOverrides.runtimePolicy = policy;
        await profileStore.save(profile);
        return policy;
      }
      await atomicJson(paths.runtime, policy);
      return policy;
    },
    async listModels({ includeSecrets = false } = {}) {
      const profile = await activeProfile();
      if (profile) {
        const models = [];
        for (const value of profile.models) {
          try { models.push(await profileModel(profile, value, includeSecrets)); }
          catch { /* Incomplete models remain editable drafts in the profile UI. */ }
        }
        return models;
      }
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
      const active = await activeProfile();
      if (active) {
        const saved = {
          ...profile,
          baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "",
        };
        const index = active.models.findIndex(item => item.id === profile.id);
        if (index === -1) active.models.push(saved);
        else active.models[index] = saved;
        await profileStore.save(active);
        if (typeof value.apiKey === "string" && value.apiKey.trim()) await profileStore.saveModelSecret(active.id, profile.id, value.apiKey);
        return profileModel(active, saved, false);
      }
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
      const profile = await activeProfile();
      if (profile) {
        const before = profile.models.length;
        profile.models = profile.models.filter(item => item.id !== modelId);
        if (before === profile.models.length) throw new Error(`Unknown model profile: ${modelId}`);
        await profileStore.save(profile);
        await profileStore.saveModelSecret(profile.id, modelId, "");
        return;
      }
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
      const profile = await activeProfile();
      const profileOverride = profileAgentOverride(profile, agentId);
      return { effective: normalizeAgentProfile(mergeDefined(mergeDefined(base, override), profileOverride)), base: normalizeAgentProfile(base), override: profileOverride || override, overridden: Boolean(profileOverride || override), source: cardBase ? "card" : "global", profileOverride: Boolean(profileOverride) };
    },
    async saveAgent(value, { scope = "card" } = {}) {
      const profile = normalizeAgentProfile(value);
      const active = await activeProfile();
      if (active && scope !== "global") {
        const current = await this.getAgent(profile.id);
        const override = {};
        for (const key of Object.keys(profile)) {
          if (JSON.stringify(profile[key]) !== JSON.stringify(current.base[key])) override[key] = profile[key];
        }
        delete override.schemaVersion;
        delete override.id;
        active.agentOverrides[profile.id] = override;
        await profileStore.save(active);
        return this.getAgent(profile.id);
      }
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
      const profile = await activeProfile();
      if (profile) {
        delete profile.agentOverrides[agentId];
        for (const key of Object.keys(profile.agentOverrides)) if (key.endsWith(`/agent/${agentId}`)) delete profile.agentOverrides[key];
        await profileStore.save(profile);
        return this.getAgent(agentId);
      }
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
      return resolveOwnedWorkflow(null, workflowId);
    },
    async getModuleWorkflow(ownerModuleId, workflowId) {
      return resolveOwnedWorkflow(ownerModuleId, workflowId);
    },
    /**
     * Return the definition a panel edit should modify. A module workflow is already card-owned
     * through its module registration, so it is never copied into the top-level workflow store —
     * that copy would be an unreachable second definition of the same workflow.
     */
    async copyWorkflowToCard(workflowId, ownerModuleId = null) {
      const profile = await activeProfile();
      if (!ownerModuleId) {
        const workflow = await resolveOwnedWorkflow(null, workflowId);
        if (profile) return workflow;
        await atomicJson(resolve(paths.cardWorkflows, workflowId, "workflow.json"), workflow);
        return workflow;
      }
      return resolveOwnedWorkflow(ownerModuleId, workflowId);
    },
    async saveCardWorkflow(value) {
      const workflow = normalizeWorkflowDefinition(value);
      if (workflow.kind.startsWith("module-")) return saveModuleWorkflowOverride(workflow);
      const profile = await activeProfile();
      if (profile) {
        profile.workflowOverrides[workflowOverrideKey(null, workflow.id)] = workflow;
        await profileStore.save(profile);
        return workflow;
      }
      await atomicJson(resolve(paths.cardWorkflows, workflow.id, "workflow.json"), workflow);
      return workflow;
    },
  };
}
