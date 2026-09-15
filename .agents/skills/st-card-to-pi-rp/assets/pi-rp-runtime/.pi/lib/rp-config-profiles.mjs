import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const RESERVED_ID = "builtin";
const SECRET_KEYS = new Set(["apikey", "api_key", "password", "secret", "token", "accesstoken", "access_token"]);

function clone(value) {
  return structuredClone(value);
}

function assertId(value, label = "id") {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === RESERVED_ID) throw new Error(`${label} is invalid.`);
  return value;
}

function cleanName(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Profile name is required.");
  const name = value.trim();
  if (name.length > 200) throw new Error("Profile name is too long.");
  return name;
}

function cleanObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};
}

function sensitivePath(value, path = "$") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = sensitivePath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) return `${path}.${key}`;
    const found = sensitivePath(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function assertConfigProfileHasNoSecrets(value) {
  const found = sensitivePath(value);
  if (found) throw new Error(`Configuration profiles cannot contain credentials (${found}).`);
}

export function normalizeConfigProfile(value, { scope = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration profile must be an object.");
  assertConfigProfileHasNoSecrets(value);
  if (value.schemaVersion !== 1 || value.kind !== "pi-rp-config-profile") throw new Error("Configuration profile must use pi-rp-config-profile schemaVersion 1.");
  const normalizedScope = value.scope === "global" || value.scope === "card" ? value.scope : null;
  if (!normalizedScope || (scope && normalizedScope !== scope)) throw new Error(`Configuration profile scope must be ${scope || "global or card"}.`);
  const models = Array.isArray(value.models) ? clone(value.models) : [];
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.id !== "string" || !SAFE_ID.test(model.id)) {
      throw new Error("Every model configuration must have a filesystem-safe id.");
    }
    delete model.hasApiKey;
    delete model.hasSecret;
    if (!("thinking" in model) && "thinkingLevel" in model) model.thinking = typeof model.thinkingLevel === "string" ? model.thinkingLevel : "off";
    delete model.thinkingLevel;
  }
  return {
    schemaVersion: 1,
    kind: "pi-rp-config-profile",
    scope: normalizedScope,
    id: assertId(value.id),
    name: cleanName(value.name),
    description: typeof value.description === "string" ? value.description.trim().slice(0, 2000) : "",
    models,
    agentOverrides: cleanObject(value.agentOverrides),
    workflowOverrides: cleanObject(value.workflowOverrides),
    moduleOverrides: cleanObject(value.moduleOverrides),
    compatibility: {
      moduleProtocol: Number.isSafeInteger(value.compatibility?.moduleProtocol) ? value.compatibility.moduleProtocol : 6,
      workflowProtocol: Number.isSafeInteger(value.compatibility?.workflowProtocol) ? value.compatibility.workflowProtocol : 3,
    },
  };
}

function cacheRoot() {
  if (process.env.BOBO_AGENT_RP_CACHE_DIR?.trim()) return resolve(process.env.BOBO_AGENT_RP_CACHE_DIR.trim());
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return resolve(process.env.LOCALAPPDATA, "bobo-agent-rp");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "bobo-agent-rp");
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "bobo-agent-rp");
}

function projectCacheId(root) {
  const identity = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 20);
}

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return clone(fallback);
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

function emptyProfile(scope, id, name) {
  return normalizeConfigProfile({
    schemaVersion: 1,
    kind: "pi-rp-config-profile",
    scope,
    id,
    name,
    models: [],
    agentOverrides: {},
    workflowOverrides: {},
    moduleOverrides: {},
    compatibility: { moduleProtocol: 6, workflowProtocol: 3 },
  }, { scope });
}

function publicProfile(profile, secretDocument, ownerId) {
  const slot = secretDocument.profiles?.[profile.scope]?.[ownerId]?.[profile.id]?.models || {};
  return {
    ...clone(profile),
    models: profile.models.map(model => ({ ...model, hasSecret: Boolean(slot[model.id]?.apiKey) })),
  };
}

export function createConfigProfileStore({ rootDirectory, directory, scope, ownerId = "global", secretCacheDirectory = null }) {
  if (scope !== "global" && scope !== "card") throw new Error("Profile store scope must be global or card.");
  const root = resolve(rootDirectory);
  const profilesDirectory = resolve(directory);
  const activePath = resolve(profilesDirectory, "active.json");
  const secretsPath = resolve(secretCacheDirectory || cacheRoot(), "projects", projectCacheId(root), "config-secrets.json");

  async function secretDocument() {
    const value = await json(secretsPath, { schemaVersion: 1, profiles: {} });
    if (!value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)) value.profiles = {};
    return value;
  }

  function profilePath(id) {
    return resolve(profilesDirectory, `${assertId(id)}.json`);
  }

  async function readProfile(id) {
    return normalizeConfigProfile(await json(profilePath(id), null), { scope });
  }

  return {
    paths: { root, profilesDirectory, activePath, secretsPath },
    scope,
    ownerId,
    async ensure() {
      await mkdir(profilesDirectory, { recursive: true });
      const active = await json(activePath, { schemaVersion: 1, activeProfileId: RESERVED_ID });
      if (active.schemaVersion !== 1 || (active.activeProfileId !== RESERVED_ID && !SAFE_ID.test(active.activeProfileId))) {
        await atomicJson(activePath, { schemaVersion: 1, activeProfileId: RESERVED_ID });
      }
    },
    async list() {
      await this.ensure();
      const entries = await readdir(profilesDirectory, { withFileTypes: true });
      const profiles = [];
      for (const entry of entries.filter(item => item.isFile() && item.name.endsWith(".json") && item.name !== "active.json").sort((a, b) => a.name.localeCompare(b.name))) {
        try {
          const profile = normalizeConfigProfile(await json(resolve(profilesDirectory, entry.name), null), { scope });
          profiles.push({ id: profile.id, name: profile.name, description: profile.description });
        } catch (error) {
          profiles.push({ id: entry.name.slice(0, -5), name: entry.name, invalid: true, error: error.message });
        }
      }
      const active = await json(activePath, { activeProfileId: RESERVED_ID });
      return {
        activeProfileId: profiles.some(item => item.id === active.activeProfileId && !item.invalid) ? active.activeProfileId : RESERVED_ID,
        profiles: [{ id: RESERVED_ID, name: "内置默认", builtin: true }, ...profiles],
      };
    },
    async get(id) {
      if (id === RESERVED_ID) return { ...emptyProfile(scope, "default-profile", "内置默认"), id: RESERVED_ID, builtin: true };
      const profile = await readProfile(id);
      return publicProfile(profile, await secretDocument(), ownerId);
    },
    async getActive() {
      const listing = await this.list();
      if (listing.activeProfileId === RESERVED_ID) return null;
      return readProfile(listing.activeProfileId);
    },
    async create({ id, name, description = "", seed = null }) {
      assertId(id);
      const existing = await json(profilePath(id), null);
      if (existing) throw new Error(`Configuration profile ${id} already exists.`);
      const value = normalizeConfigProfile({ ...(seed || emptyProfile(scope, id, name)), id, name, description, scope }, { scope });
      await atomicJson(profilePath(id), value);
      return publicProfile(value, await secretDocument(), ownerId);
    },
    async save(value) {
      const profile = normalizeConfigProfile(value, { scope });
      await readProfile(profile.id);
      await atomicJson(profilePath(profile.id), profile);
      return publicProfile(profile, await secretDocument(), ownerId);
    },
    async rename(id, name) {
      const profile = await readProfile(id);
      profile.name = cleanName(name);
      await atomicJson(profilePath(id), profile);
      return publicProfile(profile, await secretDocument(), ownerId);
    },
    async duplicate(id, { newId, name }) {
      const source = await readProfile(id);
      return this.create({ id: newId, name, description: source.description, seed: { ...source, id: newId, name } });
    },
    async remove(id) {
      assertId(id);
      await readProfile(id);
      await rm(profilePath(id));
      const active = await json(activePath, { schemaVersion: 1, activeProfileId: RESERVED_ID });
      if (active.activeProfileId === id) await atomicJson(activePath, { schemaVersion: 1, activeProfileId: RESERVED_ID });
      const secrets = await secretDocument();
      if (secrets.profiles?.[scope]?.[ownerId]) delete secrets.profiles[scope][ownerId][id];
      await atomicJson(secretsPath, secrets, { sensitive: true });
      return { deleted: id, activeProfileId: active.activeProfileId === id ? RESERVED_ID : active.activeProfileId };
    },
    async activate(id) {
      if (id !== RESERVED_ID) await readProfile(id);
      await atomicJson(activePath, { schemaVersion: 1, activeProfileId: id });
      return { activeProfileId: id };
    },
    async importProfile(value, { id = null, name = null } = {}) {
      const normalized = normalizeConfigProfile(value, { scope });
      const targetId = id ? assertId(id) : normalized.id;
      const targetName = name ? cleanName(name) : normalized.name;
      return this.create({ id: targetId, name: targetName, description: normalized.description, seed: { ...normalized, id: targetId, name: targetName } });
    },
    async exportProfile(id) {
      const profile = await readProfile(id);
      assertConfigProfileHasNoSecrets(profile);
      return clone(profile);
    },
    async saveModelSecret(profileId, modelId, apiKey) {
      assertId(profileId, "profileId");
      assertId(modelId, "modelId");
      await readProfile(profileId);
      const secrets = await secretDocument();
      secrets.profiles[scope] ||= {};
      secrets.profiles[scope][ownerId] ||= {};
      secrets.profiles[scope][ownerId][profileId] ||= { models: {} };
      secrets.profiles[scope][ownerId][profileId].models ||= {};
      if (typeof apiKey === "string" && apiKey.trim()) secrets.profiles[scope][ownerId][profileId].models[modelId] = { apiKey: apiKey.trim() };
      else delete secrets.profiles[scope][ownerId][profileId].models[modelId];
      await atomicJson(secretsPath, secrets, { sensitive: true });
      return { modelId, hasSecret: Boolean(apiKey?.trim()) };
    },
    async getModelSecret(profileId, modelId) {
      assertId(profileId, "profileId");
      assertId(modelId, "modelId");
      const secrets = await secretDocument();
      return secrets.profiles?.[scope]?.[ownerId]?.[profileId]?.models?.[modelId]?.apiKey || "";
    },
  };
}
