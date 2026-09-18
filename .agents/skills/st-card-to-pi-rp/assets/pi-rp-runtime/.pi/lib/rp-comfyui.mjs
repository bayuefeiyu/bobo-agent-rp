import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { deriveSeed, effectiveSeedRange, intersectSeedRanges, LEGACY_SEED_RANGE, normalizeSeedRange, seedRangeLabel } from "./rp-comfyui-seed.mjs";
import { classifyNodeErrors, describeNodeError, unrelatedStatusMessages } from "./rp-comfyui-diagnostics.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILE_FIELDS = ["schemaVersion", "id", "title", "revision", "guideId", "connectionId", "workflowFile", "bindings", "prompt", "output", "seedRange"];

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function projectId(root) { return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 20); }
function cacheRoot() {
  if (process.env.BOBO_AGENT_RP_CACHE_DIR?.trim()) return resolve(process.env.BOBO_AGENT_RP_CACHE_DIR.trim());
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return resolve(process.env.LOCALAPPDATA, "bobo-agent-rp");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "bobo-agent-rp");
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "bobo-agent-rp");
}
async function json(path, fallback) { return readFile(path, "utf8").then(JSON.parse).catch(error => error.code === "ENOENT" ? structuredClone(fallback) : Promise.reject(error)); }
async function atomicJson(path, value, sensitive = false) {
  await mkdir(dirname(path), { recursive: true, mode: sensitive ? 0o700 : undefined });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: sensitive ? 0o600 : undefined });
  await rename(temporary, path);
  if (sensitive && process.platform !== "win32") await chmod(path, 0o600);
}
function safeChild(root, ...parts) {
  const target = resolve(root, ...parts);
  if (target !== resolve(root) && !target.startsWith(`${resolve(root)}${sep}`)) throw new Error("Path escapes its configured root.");
  return target;
}
function cleanConnection(value) {
  if (!SAFE_ID.test(value?.id || "")) throw httpError(400, "Connection id is invalid.");
  const url = new URL(value.baseUrl || "http://127.0.0.1:8188");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw httpError(400, "ComfyUI baseUrl must be an HTTP(S) origin without credentials, query, or path.");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && url.protocol !== "https:" && value.allowInsecureRemote !== true) throw httpError(400, "Remote HTTP requires allowInsecureRemote=true; HTTPS is recommended.");
  const outputDirectoryPath = typeof value.outputDirectoryPath === "string" && value.outputDirectoryPath.trim() ? resolve(value.outputDirectoryPath.trim()) : null;
  if (outputDirectoryPath && !isAbsolute(outputDirectoryPath)) throw httpError(400, "outputDirectoryPath must be absolute.");
  return { schemaVersion: 1, id: value.id, title: String(value.title || value.id).trim(), baseUrl: url.origin, allowInsecureRemote: !loopback && url.protocol === "http:", outputDirectoryPath };
}
function cleanBindingList(value, role) {
  if (!Array.isArray(value)) throw new Error(`Profile bindings.${role} must be an array.`);
  return value.map(binding => {
    if (!binding || Object.keys(binding).length !== 2 || !SAFE_ID.test(String(binding.nodeId || "")) || typeof binding.input !== "string" || !binding.input) throw new Error(`Profile ${role} binding is invalid.`);
    return { nodeId: String(binding.nodeId), input: binding.input };
  });
}
function normalizeProfile(value, directory, workflow, guide, override = null) {
  // `seedRange` is required for every profile this repository ships and for every newly adapted
  // profile. A profile written before the field existed is still readable, but it is explicitly
  // *unverified*: its seed range is whatever the legacy derivation produced, which is exactly how
  // RC-07 shipped, so the profile reports that instead of claiming a validated range.
  const allowedFields = PROFILE_FIELDS.filter(field => field !== "seedRange" || Object.hasOwn(value, field));
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key => !allowedFields.includes(key)) || allowedFields.some(key => !Object.hasOwn(value, key))) throw new Error("Profile must use the exact profile v1 field set.");
  for (const key of ["id", "guideId", "connectionId"]) if (!SAFE_ID.test(value[key] || "")) throw new Error(`Profile ${key} is invalid.`);
  if (value.workflowFile !== "workflow.api.json") throw new Error("Profile workflowFile must be workflow.api.json.");
  const bindings = Object.fromEntries(["positive", "negative", "seed", "filenamePrefix"].map(role => [role, cleanBindingList(value.bindings?.[role], role)]));
  if (!bindings.positive.length || !bindings.filenamePrefix.length) throw new Error("Profile requires positive and filenamePrefix bindings.");
  for (const [role, list] of Object.entries(bindings)) for (const binding of list) if (!Object.hasOwn(workflow?.[binding.nodeId]?.inputs || {}, binding.input)) throw new Error(`Profile ${role} binding ${binding.nodeId}.${binding.input} is missing.`);
  const seedRange = Object.hasOwn(value, "seedRange") ? normalizeSeedRange(value.seedRange, "Profile seedRange") : null;
  const seedBindingRanges = bindings.seed.length ? intersectSeedRanges([seedRange || LEGACY_SEED_RANGE], "Profile seed range") : null;
  const prompt = { separator: String(value.prompt?.separator ?? ", "), positivePrefix: String(value.prompt?.positivePrefix || ""), positiveSuffix: String(value.prompt?.positiveSuffix || ""), negative: String(value.prompt?.negative || "") };
  const baseProfileDigest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const allowedOverride = override?.profileRevision === value.revision && override?.profileDigest === baseProfileDigest ? override.prompt : null;
  const effectivePrompt = allowedOverride ? { ...prompt, ...Object.fromEntries(Object.entries(allowedOverride).filter(([key, item]) => Object.hasOwn(prompt, key) && typeof item === "string")) } : prompt;
  return {
    ...value, bindings, seedRange, seedEffectiveRange: seedBindingRanges, prompt: effectivePrompt, directory, workflow, guide,
    seedRangeVerified: seedRange !== null,
    seedRangeWarning: seedRange === null
      ? "This profile predates the seed-range contract; re-run the adaptation step to verify the bound node's seed limit."
      : null,
    digest: baseProfileDigest,
    baseProfileDigest,
    overrideDigest: allowedOverride ? digest(allowedOverride) : null,
    workflowDigest: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
    guideDigest: createHash("sha256").update(guide).digest("hex"),
    overrideStale: Boolean(override && !allowedOverride),
  };
}

export function freezeComfyProfile(profile, connectionBaseUrl = profile.connectionBaseUrl) {
  const snapshot = {
    schemaVersion: 1,
    id: profile.id,
    title: profile.title,
    revision: String(profile.revision),
    guideId: profile.guideId,
    baseProfileDigest: profile.baseProfileDigest || profile.digest,
    overrideDigest: profile.overrideDigest || null,
    workflowDigest: profile.workflowDigest,
    guideDigest: profile.guideDigest || createHash("sha256").update(String(profile.guide || "")).digest("hex"),
    connectionId: profile.connectionId,
    connectionBaseUrl,
    workflow: structuredClone(profile.workflow),
    bindings: structuredClone(profile.bindings),
    prompt: structuredClone(profile.prompt),
    guide: String(profile.guide || ""),
    outputNodeIds: [...(profile.output?.nodeIds || [])],
    seedRange: profile.seedEffectiveRange ? structuredClone(profile.seedEffectiveRange) : effectiveSeedRange(profile),
    seedRangeVerified: profile.seedRangeVerified !== false && (profile.seedRange !== undefined || profile.seedEffectiveRange !== undefined),
  };
  snapshot.effectiveDigest = digest(snapshot);
  snapshot.snapshotId = `${snapshot.id}@${snapshot.effectiveDigest}`;
  return snapshot;
}
function setBindings(workflow, bindings, value) { for (const binding of bindings) workflow[binding.nodeId].inputs[binding.input] = value; }
function outputRefs(history, allowedNodeIds) {
  const result = [];
  for (const [nodeId, output] of Object.entries(history?.outputs || {})) {
    if (allowedNodeIds.length && !allowedNodeIds.includes(nodeId)) continue;
    for (const image of output?.images || []) if (image && typeof image.filename === "string") result.push({ filename: image.filename, subfolder: String(image.subfolder || ""), type: String(image.type || "output"), nodeId });
  }
  return result;
}

/**
 * Turn a finished history record into either image references or a truthful failure.
 *
 * `status_str: "success"` only means the execution loop finished: a node that rejected its inputs
 * records `execution_error` and skips its branch while unrelated branches still run, so the history
 * can be "successful" with no image at all. Reading the node errors first turns that into a named
 * cause instead of a vague missing-output message, and an error off the output path is reported as a
 * warning rather than blamed for the missing image.
 */
function interpretHistory(history, { workflow, outputNodeIds, promptId }) {
  const status = history?.status?.status_str;
  if (status === "error") throw Object.assign(new Error(`ComfyUI execution failed for prompt ${promptId}.`), { code: "comfy_execution_failed", promptId });
  const { blocking, unrelated, other } = classifyNodeErrors({ history, workflow, targetNodeIds: outputNodeIds });
  const warnings = [...unrelated, ...other].map(describeNodeError);
  const outputs = outputRefs(history, Array.isArray(outputNodeIds) ? outputNodeIds : []);
  if (!blocking.length && !outputs.length && status !== "success") {
    throw Object.assign(new Error(`ComfyUI did not finish prompt ${promptId}${status ? ` (${status})` : ""}.`), { code: "comfy_execution_failed", promptId, nodeErrors: [] });
  }
  if (blocking.length) {
    const summary = blocking.map(describeNodeError).join("; ");
    throw Object.assign(new Error(`ComfyUI skipped the image branch for prompt ${promptId}: ${summary}`), { code: "comfy_output_branch_failed", promptId, nodeErrors: blocking, warnings, status });
  }
  if (!outputs.length) throw Object.assign(new Error("ComfyUI completed without an adapted image output reference."), { code: "comfy_output_missing", promptId, nodeErrors: [], warnings, status });
  return { outputs, warnings, statusMessages: unrelatedStatusMessages(history) };
}
function progressSocket(connection, clientId, hasToken) {
  if (hasToken || typeof globalThis.WebSocket !== "function") return null;
  const url = new URL(connection.baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/ws"; url.searchParams.set("clientId", clientId);
  try { return new globalThis.WebSocket(url); } catch { return null; }
}
async function waitHistory(connection, promptId, headers, timeoutMs, socket = null) {
  const deadline = Date.now() + timeoutMs;
  let wake = null;
  if (socket) socket.addEventListener("message", event => {
    try {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      if (message?.data?.prompt_id === promptId && ["executing", "execution_error", "execution_success"].includes(message.type)) wake?.();
    } catch {}
  });
  try {
    while (Date.now() < deadline) {
      const response = await fetch(`${connection.baseUrl}/history/${encodeURIComponent(promptId)}`, { headers, signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const payload = await response.json();
        const history = payload?.[promptId];
        if (history) return history;
      }
      await Promise.race([new Promise(resolvePromise => setTimeout(resolvePromise, 750)), new Promise(resolvePromise => { wake = resolvePromise; })]);
      wake = null;
    }
  } finally {
    if (socket && socket.readyState < 2) socket.close();
  }
  throw new Error(`ComfyUI prompt ${promptId} did not finish within ${timeoutMs} ms.`);
}

export function createComfyUiService({ rootDirectory, cardDirectory, featureModules, secretCacheDirectory = null }) {
  const root = resolve(rootDirectory);
  const settingsPath = resolve(root, "settings", "comfyui-connections.json");
  const overridesPath = resolve(root, "settings", "comfyui-profile-overrides.json");
  const secretsPath = resolve(secretCacheDirectory || cacheRoot(), "projects", projectId(root), "comfyui-secrets.json");
  const module = featureModules.find(item => item.id === "comfy-image-generation");
  async function documents() {
    const settings = await json(settingsPath, { schemaVersion: 1, connections: [{ schemaVersion: 1, id: "local", title: "本机 ComfyUI", baseUrl: "http://127.0.0.1:8188", allowInsecureRemote: false, outputDirectoryPath: null }] });
    const secrets = await json(secretsPath, { schemaVersion: 1, connections: {} });
    return { settings, secrets };
  }
  async function connection(id, includeSecret = false) {
    const { settings, secrets } = await documents();
    const found = settings.connections.map(cleanConnection).find(item => item.id === id);
    if (!found) throw httpError(404, `Unknown ComfyUI connection: ${id}`);
    return includeSecret ? { ...found, token: secrets.connections?.[id]?.token || "" } : { ...found, hasToken: Boolean(secrets.connections?.[id]?.token) };
  }
  async function profiles(ids = null) {
    if (!module) return [];
    const profileRoot = resolve(module.moduleDirectory, "profiles");
    const entries = await readdir(profileRoot, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    const overrides = await json(overridesPath, { schemaVersion: 1, profiles: {} });
    const configuredConnections = new Map((await documents()).settings.connections.map(cleanConnection).map(item => [item.id, item]));
    const result = [];
    for (const entry of entries.filter(item => item.isDirectory() && SAFE_ID.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (Array.isArray(ids) && !ids.includes(entry.name)) continue;
      const directory = safeChild(profileRoot, entry.name);
      const value = await json(resolve(directory, "profile.json"), null);
      const workflow = await json(resolve(directory, "workflow.api.json"), null);
      if (!value || !workflow) continue;
      const guidePath = safeChild(module.moduleDirectory, "skill", "guides", value.guideId, "SKILL.md");
      const guide = await readFile(guidePath, "utf8");
      const profile = normalizeProfile(value, directory, workflow, guide, overrides.profiles?.[entry.name]);
      const configuredConnection = configuredConnections.get(profile.connectionId);
      if (!configuredConnection) throw new Error(`Profile ${profile.id} references unknown ComfyUI connection ${profile.connectionId}.`);
      const hydrated = { ...profile, connectionBaseUrl: configuredConnection.baseUrl };
      const executionSnapshot = freezeComfyProfile(hydrated, configuredConnection.baseUrl);
      result.push({ ...hydrated, effectiveDigest: executionSnapshot.effectiveDigest, executionSnapshot });
    }
    return result;
  }
  return {
    profiles,
    assemblePrompt(profile, content) {
      const separator = profile.prompt.separator;
      const positive = [profile.prompt.positivePrefix, String(content || "").trim(), profile.prompt.positiveSuffix].filter(Boolean).join(separator);
      return { positive, negative: profile.prompt.negative };
    },
    chatFolder({ cardId, chatId, now = new Date() }) {
      const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
      const card = String(cardId || "card").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 32) || "card";
      const hash = createHash("sha256").update(String(chatId || "chat")).digest("hex").slice(0, 6);
      return `${stamp}_${card}_${hash}`;
    },
    async listConnections() { const { settings, secrets } = await documents(); return settings.connections.map(cleanConnection).map(item => ({ ...item, hasToken: Boolean(secrets.connections?.[item.id]?.token) })); },
    async saveConnection(value) {
      const clean = cleanConnection(value);
      const { settings, secrets } = await documents();
      const index = settings.connections.findIndex(item => item.id === clean.id);
      if (index < 0) settings.connections.push(clean); else settings.connections[index] = clean;
      if (typeof value.token === "string" && value.token.trim()) secrets.connections[clean.id] = { token: value.token.trim() };
      await atomicJson(settingsPath, settings); await atomicJson(secretsPath, secrets, true);
      return { ...clean, hasToken: Boolean(secrets.connections[clean.id]?.token) };
    },
    async testConnection(id) {
      const value = await connection(id, true); const headers = value.token ? { authorization: `Bearer ${value.token}` } : {};
      const startedAt = Date.now(); const response = await fetch(`${value.baseUrl}/system_stats`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw httpError(400, `ComfyUI health check failed: HTTP ${response.status}`);
      return { ok: true, elapsedMs: Date.now() - startedAt, system: await response.json() };
    },
    async saveProfileOverride(profileId, prompt) {
      const profile = (await profiles([profileId]))[0]; if (!profile) throw httpError(404, "Profile was not found.");
      const document = await json(overridesPath, { schemaVersion: 1, profiles: {} });
      document.profiles[profileId] = { profileRevision: profile.revision, profileDigest: profile.digest, prompt: Object.fromEntries(Object.entries(prompt || {}).filter(([key, value]) => Object.hasOwn(profile.prompt, key) && typeof value === "string")) };
      await atomicJson(overridesPath, document); return document.profiles[profileId];
    },
    async generateFrozen({ snapshot, positivePrompt, negativePrompt, chatFolder, filenamePrefix, seed, payloadDigest, promptId, timeoutMs = 300000, onSubmitted = null }) {
      if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.snapshotId !== "string") throw Object.assign(new Error("A frozen ComfyUI profile snapshot is required."), { code: "comfy_pre_submit_failure" });
      if (typeof promptId !== "string" || !promptId) throw Object.assign(httpError(400, "A caller-supplied ComfyUI prompt ID is required."), { code: "comfy_pre_submit_failure" });
      if (!Number.isSafeInteger(seed) || seed < 0) throw Object.assign(httpError(400, "A frozen non-negative integer seed is required."), { code: "comfy_pre_submit_failure" });
      const current = await connection(snapshot.connectionId, true);
      const frozenUrl = new URL(snapshot.connectionBaseUrl);
      if (!["http:", "https:"].includes(frozenUrl.protocol) || frozenUrl.username || frozenUrl.password || frozenUrl.search || frozenUrl.hash || frozenUrl.pathname !== "/") throw Object.assign(httpError(400, "Frozen ComfyUI connection URL is invalid."), { code: "comfy_pre_submit_failure" });
      const value = { ...current, baseUrl: frozenUrl.origin };
      const headers = { "content-type": "application/json", ...(value.token ? { authorization: `Bearer ${value.token}` } : {}) };
      // The authoritative range check happens before anything is queued. Discovering an illegal seed
      // from the history is strictly worse: ComfyUI accepts the entry, skips the save branch, and the
      // card has to explain a submitted-but-empty render afterwards.
      const seedRange = normalizeSeedRange(snapshot.seedRange || LEGACY_SEED_RANGE, "Frozen profile seed range");
      if (!Number.isSafeInteger(seed) || seed < seedRange.min || seed > seedRange.max) {
        throw Object.assign(new Error(`Seed ${seed} is outside the frozen profile range ${seedRangeLabel(seedRange)}; the bound seed node would reject it.`), { code: "comfy_pre_submit_failure", seed, seedRange });
      }
      const workflow = structuredClone(snapshot.workflow);
      setBindings(workflow, snapshot.bindings.positive, positivePrompt);
      setBindings(workflow, snapshot.bindings.negative, negativePrompt);
      setBindings(workflow, snapshot.bindings.seed, seed);
      const safeFolder = String(chatFolder).replace(/[^A-Za-z0-9._-]+/g, "-");
      const safePrefix = String(filenamePrefix).replace(/[^A-Za-z0-9._-]+/g, "-");
      setBindings(workflow, snapshot.bindings.filenamePrefix, `bobo-agent-rp/${safeFolder}/${safePrefix}`);
      const expectedDigest = digest({ snapshotId: snapshot.snapshotId, effectiveDigest: snapshot.effectiveDigest, positivePrompt, negativePrompt, seed, filenamePrefix, promptId });
      if (payloadDigest !== expectedDigest) throw Object.assign(new Error("Frozen ComfyUI payload digest does not match the persisted render."), { code: "comfy_pre_submit_failure" });
      const clientId = `bobo-agent-rp-${randomUUID()}`;
      const socket = progressSocket(value, clientId, Boolean(value.token));
      let queue;
      try {
        queue = await fetch(`${value.baseUrl}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: workflow, prompt_id: promptId, client_id: clientId }), signal: AbortSignal.timeout(30000) });
      } catch (error) {
        if (socket && socket.readyState < 2) socket.close();
        throw Object.assign(new Error(`ComfyUI submission outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`), { code: "comfy_submission_uncertain", cause: error });
      }
      const responseText = await queue.text();
      let queued = null;
      try { queued = responseText ? JSON.parse(responseText) : {}; } catch {}
      if (!queue.ok) {
        if (socket && socket.readyState < 2) socket.close();
        const gatewayUncertain = queue.status >= 500 && queue.status <= 599;
        const explicitRejection = !gatewayUncertain && ([401, 403, 404, 429].includes(queue.status) || (queued && (Object.hasOwn(queued, "error") || Object.hasOwn(queued, "node_errors"))));
        const message = `ComfyUI queue request failed: HTTP ${queue.status} ${responseText.slice(0, 1000)}`;
        if (explicitRejection) throw Object.assign(httpError(queue.status, message), { code: "comfy_queue_rejected", response: queued });
        throw Object.assign(httpError(queue.status, `${message}; submission outcome is uncertain.`), { code: "comfy_submission_uncertain", response: queued });
      }
      if (!queued || typeof queued !== "object") {
        if (socket && socket.readyState < 2) socket.close();
        throw Object.assign(new Error("ComfyUI accepted the queue request but returned an unreadable response."), { code: "comfy_submission_uncertain" });
      }
      const effectivePromptId = queued.prompt_id || promptId;
      if (effectivePromptId !== promptId) {
        if (socket && socket.readyState < 2) socket.close();
        throw Object.assign(new Error("ComfyUI returned a different prompt ID after queue submission."), { code: "comfy_submission_uncertain", returnedPromptId: effectivePromptId });
      }
      const submittedAt = new Date().toISOString();
      try {
        if (typeof onSubmitted === "function") await onSubmitted({ promptId, submittedAt });
      } catch (error) {
        if (socket && socket.readyState < 2) socket.close();
        throw Object.assign(new Error(`ComfyUI accepted the prompt but local submission persistence failed: ${error instanceof Error ? error.message : String(error)}`), { code: "comfy_submission_uncertain", cause: error });
      }
      const history = await waitHistory(value, promptId, value.token ? { authorization: `Bearer ${value.token}` } : {}, timeoutMs, socket);
      const interpreted = interpretHistory(history, { workflow: snapshot.workflow, outputNodeIds: snapshot.outputNodeIds, promptId });
      return { promptId, submittedAt, completedAt: new Date().toISOString(), outputs: interpreted.outputs, warnings: interpreted.warnings };
    },
    async generate({ profileId, contentPrompt, chatFolder, filenamePrefix, promptId, timeoutMs = 300000, onSubmitted = null }) {
      const profile = (await profiles([profileId]))[0]; if (!profile) throw Object.assign(httpError(404, "Profile was not found."), { code: "comfy_pre_submit_failure" });
      const assembled = this.assemblePrompt(profile, contentPrompt);
      const snapshot = profile.executionSnapshot;
      // Even this ad-hoc path takes its seed from the frozen range: a random `Math.random()` seed can
      // exceed the bound node's limit, which ComfyUI accepts and then reports as a successful
      // execution with no image.
      const seed = deriveSeed(`ad-hoc:${promptId}`, 1, snapshot.seedRange);
      const payloadDigest = digest({ snapshotId: snapshot.snapshotId, effectiveDigest: snapshot.effectiveDigest, positivePrompt: assembled.positive, negativePrompt: assembled.negative, seed, filenamePrefix, promptId });
      return this.generateFrozen({ snapshot, positivePrompt: assembled.positive, negativePrompt: assembled.negative, chatFolder, filenamePrefix, seed, payloadDigest, promptId, timeoutMs, onSubmitted });
    },
    async resume({ profileId, promptId, timeoutMs = 300000 }) {
      const profile = (await profiles([profileId]))[0]; if (!profile) throw httpError(404, "Profile was not found.");
      const value = await connection(profile.connectionId, true);
      const history = await waitHistory(value, promptId, value.token ? { authorization: `Bearer ${value.token}` } : {}, timeoutMs);
      const interpreted = interpretHistory(history, { workflow: profile.workflow, outputNodeIds: profile.output?.nodeIds || [], promptId });
      return { promptId, completedAt: new Date().toISOString(), outputs: interpreted.outputs, warnings: interpreted.warnings };
    },
    async resumeRender({ connectionId, connectionBaseUrl, promptId, outputNodeIds = [], workflow = null, timeoutMs = 300000 }) {
      const current = await connection(connectionId, true);
      const frozenUrl = new URL(connectionBaseUrl);
      if (!["http:", "https:"].includes(frozenUrl.protocol) || frozenUrl.username || frozenUrl.password || frozenUrl.search || frozenUrl.hash || frozenUrl.pathname !== "/") throw httpError(400, "Frozen ComfyUI connection URL is invalid.");
      const value = { ...current, baseUrl: frozenUrl.origin };
      const history = await waitHistory(value, promptId, value.token ? { authorization: `Bearer ${value.token}` } : {}, timeoutMs);
      const interpreted = interpretHistory(history, { workflow, outputNodeIds, promptId });
      return { promptId, completedAt: new Date().toISOString(), outputs: interpreted.outputs, warnings: interpreted.warnings };
    },
    async view({ connectionId, output, preview = null }) {
      const value = await connection(connectionId, true);
      if (!output || typeof output.filename !== "string" || typeof output.subfolder !== "string" || typeof output.type !== "string") throw httpError(400, "Output reference is invalid.");
      const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type });
      if (preview) query.set("preview", preview);
      const response = await fetch(`${value.baseUrl}/view?${query}`, { headers: value.token ? { authorization: `Bearer ${value.token}` } : {}, signal: AbortSignal.timeout(30000) });
      if (response.status === 404) throw httpError(404, "ComfyUI source file was not found.");
      if (!response.ok) throw httpError(502, `ComfyUI image request failed: HTTP ${response.status}`);
      const mimeType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
      if (!mimeType.startsWith("image/")) throw httpError(502, "ComfyUI returned a non-image response for an output reference.");
      return { body: Buffer.from(await response.arrayBuffer()), mimeType };
    },
  };
}

export { cleanConnection, normalizeProfile };
