import { loadCardComponents, componentReference } from "./rp-module-registry.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { normalizeAgentProfile, normalizeModelProfile, normalizeRuntimePolicy } from "./rp-model-config.mjs";
import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolveActiveForegroundWorkflow(workflows, configured = /** @type {string | null} */ (null)) {
  const cardForeground = (Array.isArray(workflows) ? workflows : [])
    .filter(workflow => workflow?.source === "module" && workflow.kind === "foreground" && workflow.invalid !== true);
  if (typeof configured === "string" && configured.trim()) {
    const selected = cardForeground.find(workflow => workflow.id === configured);
    if (!selected) throw new Error(`Configured active workflow ${configured} must reference a valid card-local foreground workflow.`);
    return selected.id;
  }
  if (cardForeground.length === 1) return cardForeground[0].id;
  if (cardForeground.length === 0) throw new Error("The card declares no foreground workflow. Add one inside a registered feature module before opening Web mode.");
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

export function createRpConfigStore(rootDirectory, cardDirectory, { secretCacheDirectory = /** @type {string | null} */ (null), profileStore = /** @type {ReturnType<typeof import("./rp-config-profiles.mjs").createConfigProfileStore> | null} */ (null), getModules = /** @type {(() => Promise<import("./rp-host-types.ts").FeatureModule[]>) | null} */ (null), isolatedRuntime = false } = {}) {
  const root = resolve(rootDirectory);
  const card = resolve(cardDirectory);
  const secretDirectory = resolve(secretCacheDirectory || systemCacheRoot(), "projects", projectCacheId(root));
  const paths = {
    root,
    card,
    models: isolatedRuntime ? resolve(card, "defaults", "model-profiles.json") : resolve(root, "settings", "model-profiles.json"),
    modelSecrets: resolve(secretDirectory, "model-secrets.json"),
    runtime: isolatedRuntime ? resolve(card, "defaults", "workflow-runtime.json") : resolve(root, "settings", "workflow-runtime.json"),
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

  async function registeredModules() { return getModules ? getModules() : loadCardComponents(card); }
  const overrideKey = (kind, reference) => { const [owner, id] = reference.split("/"); return "module/" + owner + "/" + kind + "/" + id; };
  /**
   * @template {"agent" | "workflow"} K
   * @param {K} kind
   * @param {string} reference
   * @returns {Promise<{effective: K extends "agent" ? ReturnType<typeof normalizeAgentProfile> : ReturnType<typeof normalizeWorkflowDefinition> & {invalid?:boolean}, base: K extends "agent" ? ReturnType<typeof normalizeAgentProfile> : ReturnType<typeof normalizeWorkflowDefinition>,override:object|null,overridden:boolean,source:string,moduleId:string,moduleTitle:string,componentFile?:string,profileOverride:boolean}>}
   */
  async function component(kind, reference) {
    const ref = componentReference(null, reference);
    const owner = ref.split("/")[0];
    const module = (await registeredModules()).find(item => item.id === owner);
    const entry = module?.[kind === "agent" ? "agents" : "workflows"]?.find(item => item.id === ref);
    if (!entry) throw new Error(kind + " " + ref + " is not registered in this card.");
    const base = entry.componentFile ? await readJson(entry.componentFile) : entry;
    const normalize = kind === "agent" ? normalizeAgentProfile : normalizeWorkflowDefinition;
    const profile = await activeProfile();
    const override = profile?.[kind + "Overrides"]?.[overrideKey(kind, ref)] || null;
    const normalizedBase = normalize(base);
    const effective = normalize(mergeDefined(normalizedBase, override));
    if (effective.id !== ref || effective.ownerModuleId !== owner) throw new Error("Configuration overrides cannot change component identity or ownership.");
    return { effective, base: normalizedBase, override, overridden: Boolean(override), source: "module", moduleId: owner, moduleTitle: module.title, componentFile: entry.componentFile, profileOverride: Boolean(override) };
  }
  async function resolveOwnedWorkflow(owner, id) {
    return (await component("workflow", componentReference(owner, id))).effective;
  }
  async function saveComponent(kind, value) {
    const normalize = kind === "agent" ? normalizeAgentProfile : normalizeWorkflowDefinition;
    const normalized = normalize(value);
    const current = await component(kind, normalized.id);
    const profile = await activeProfile();
    if (profile) {
      profile[kind + "Overrides"][overrideKey(kind, normalized.id)] = normalized;
      await profileStore.save(profile);
    } else {
      if (!current.componentFile) throw new Error("No editable module component file.");
      await atomicJson(current.componentFile, normalized);
    }
    return normalized;
  }

  return {
    paths,
    async ensure() {
      if (isolatedRuntime) {
        for (const path of [paths.models, paths.runtime]) {
          if (!await readJson(path, null)) throw new Error(`Card runtime default is missing: ${path}`);
        }
        return;
      }
      await Promise.all([
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
      if (isolatedRuntime && !profile) throw new Error("Select an editable card configuration profile before changing runtime policy.");
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
      const { models: value, secrets } = await modelDocuments({ migrate: !isolatedRuntime });
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
      if (isolatedRuntime && !active) throw new Error("Select an editable card configuration profile before changing a model.");
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
      if (isolatedRuntime && !profile) throw new Error("Select an editable card configuration profile before removing a model.");
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
      const result = [];
      for (const module of await registeredModules()) for (const agent of module.agents || []) result.push(await component("agent", agent.id));
      return result;
    },
    async getAgent(reference) { return component("agent", reference); },
    async saveAgent(value) { await saveComponent("agent", value); return component("agent", normalizeAgentProfile(value).id); },
    async restoreAgent(reference) {
      const current = await component("agent", reference);
      const profile = await activeProfile();
      if (profile) { delete profile.agentOverrides[overrideKey("agent", current.effective.id)]; await profileStore.save(profile); }
      return component("agent", current.effective.id);
    },
    async listWorkflows() {
      const result = [];
      for (const module of await registeredModules()) for (const workflow of module.workflows || []) {
        const current = await component("workflow", workflow.id);
        result.push({ ...current.effective, source: "module", moduleTitle: module.title, reference: current.effective.id });
      }
      return result;
    },
    async getWorkflow(reference) { return resolveOwnedWorkflow(null, reference); },
    async getModuleWorkflow(owner, id) { return resolveOwnedWorkflow(owner, id); },
    async copyWorkflowToCard(id, owner = null) { return resolveOwnedWorkflow(owner, id); },
    async saveCardWorkflow(value) { return saveComponent("workflow", value); },

  };
}
