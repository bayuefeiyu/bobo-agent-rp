import { mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LibraryClient } from "./client.mjs";
import { id, fail } from "./contract.mjs";
import { normalizeSemanticConfig, configured, digest, indexFingerprint } from "./semantic-contract.mjs";
import { createSemanticServices } from "./service-adapters.mjs";
import { atomicJson } from "./semantic-build.mjs";
import { semanticManifest } from "./semantic-index.mjs";

const managers = new Map();
async function json(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }
const credentialId = service => digest({ protocol: service.protocol, url: service.url, model: service.model });
const testFingerprint = config => digest({ embedding: config.embedding, rerank: config.rerank });
export function createSemanticManager({ configurationDirectory, getRoot }) {
  const directory = resolve(configurationDirectory), settingsPath = resolve(directory, "reference-semantic.json"), secretsPath = resolve(directory, "service-secrets.json");
  const jobs = new Map(), controllers = new Set(), activeRoots = new Set(); let saving = Promise.resolve();
  const pool = [], waiters = []; let closed = false;
  const queryCache = new Map(), queryPriority = new Int32Array(new SharedArrayBuffer(4));
  async function withClient(currentRoot, generation, semantic, execute) {
    if (closed) fail("cancelled");
    if (!semantic) { const client = new LibraryClient(); try { const snapshot = await client.open(currentRoot, generation); return await execute(client, snapshot, null); } finally { await client.close(); } }
    let entry = pool.find(item => !item.busy);
    if (!entry && pool.length < 2) { entry = { client: new LibraryClient(), busy: false, key: null }; pool.push(entry); }
    if (!entry) { if (waiters.length >= 8) fail("service_busy"); await new Promise((resolve, reject) => waiters.push({ resolve, reject })); return withClient(currentRoot, generation, semantic, execute); }
    entry.busy = true; clearTimeout(entry.timer); entry.client.worker.ref(); Atomics.add(queryPriority, 0, 1);
    const key = digest({ root: currentRoot, generation, semantic: semantic?.generation ?? null, fingerprint: semantic ? indexFingerprint(semantic.config) : null });
    try {
      if (entry.key !== key) { entry.key = null; entry.snapshot = await entry.client.open(currentRoot, generation); entry.info = semantic ? await entry.client.openSemantic(currentRoot, semantic.config, semantic.generation) : null; entry.key = key; }
      return await execute(entry.client, entry.snapshot, entry.info);
    } finally {
      entry.busy = false; Atomics.sub(queryPriority, 0, 1); entry.client.worker.unref(); waiters.shift()?.resolve();
      entry.timer = setTimeout(() => { if (!entry.busy) { const index = pool.indexOf(entry); if (index >= 0) pool.splice(index, 1); entry.client.close(); } }, 30000); entry.timer.unref();
    }
  }
  async function settings() { const value = await json(settingsPath, {}); return { config: normalizeSemanticConfig(value.config), revision: value.revision ?? "initial", tested: value.tested ?? null }; }
  async function credentials(config) { const document = await json(secretsPath, { schemaVersion: 1, services: {} }); return { embeddingKey: document.services[credentialId(config.embedding)] ?? "", rerankKey: document.services[credentialId(config.rerank)] ?? "" }; }
  async function root() { const value = await getRoot(); if (!value) fail("library_unbound"); return resolve(value); }
  async function publicSettings() { const value = await settings(), keys = await credentials(value.config); return { ...value, hasEmbeddingSecret: Boolean(keys.embeddingKey), hasRerankSecret: Boolean(keys.rerankKey) }; }
  async function save(value) {
    const next = saving.catch(() => {}).then(async () => {
      const config = normalizeSemanticConfig(value.config), previous = await settings();
      await mkdir(directory, { recursive: true });
      const document = await json(secretsPath, { schemaVersion: 1, services: {} });
      let credentialsChanged = false;
      for (const [kind, key] of [["embedding", "embeddingKey"], ["rerank", "rerankKey"]]) if (value[key] !== undefined) { if (typeof value[key] !== "string" || value[key].length > 10000) fail("invalid_request"); const serviceId = credentialId(config[kind]); credentialsChanged ||= (document.services[serviceId] ?? "") !== value[key]; if (value[key]) document.services[serviceId] = value[key]; else delete document.services[serviceId]; }
      await atomicJson(secretsPath, document); await atomicJson(settingsPath, { config, revision: randomUUID(), tested: !credentialsChanged && testFingerprint(config) === testFingerprint(previous.config) ? previous.tested : null });
      if (!config.enabled) { for (const controller of controllers) controller.abort(); if (previous.config.enabled) for (const job of jobs.values()) await writeFile(resolve(job.root, "semantic", "jobs", job.progress.jobId, "cancel"), "cancel\n").catch(() => {}); }
      return publicSettings();
    }); saving = next; return next;
  }
  async function test() {
    const value = await settings(); if (!configured(value.config)) fail("semantic_configuration_incomplete");
    const services = createSemanticServices(value.config, { ...(await credentials(value.config)), retries: 0 });
    await services.embed(["Synthetic library connection test."], "document"); await services.embed(["Synthetic query."], "query");
    await services.rerank("Synthetic query.", ["Synthetic library connection test.", "Unrelated synthetic text."]);
    const tested = testFingerprint(value.config);
    const next = saving.catch(() => {}).then(async () => { const current = await settings(); if (current.revision !== value.revision) fail("configuration_changed"); await mkdir(directory, { recursive: true }); await atomicJson(settingsPath, { ...current, tested }); }); saving = next; await next;
    return { status: "services_verified", dimensions: value.config.embedding.dimensions };
  }
  async function status() {
    const setting = await settings(); let currentRoot;
    try { currentRoot = await root(); } catch { return { ready: false, status: "library_unbound", enabled: setting.config.enabled, jobs: [] }; }
    const running = [...jobs.values()].filter(job => job.root === currentRoot).map(job => job.progress);
    const records = await readdir(resolve(currentRoot, "semantic", "jobs")).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    const owner = await json(resolve(currentRoot, "semantic", ".build-lock", "owner.json"), null);
    let ownerAlive = false; if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); ownerAlive = true; } catch (error) { ownerAlive = error.code === "EPERM"; } }
    const completed = (await Promise.all(records.slice(-100).map(jobId => json(resolve(currentRoot, "semantic", "jobs", id(jobId), "job.json"), null)))).filter(Boolean).map(job => ({ ...job, status: job.status === "running" && !jobs.has(job.jobId) && !(ownerAlive && owner.jobId === job.jobId) ? "interrupted" : job.status }));
    const jobList = [...new Map([...running, ...completed].map(job => [job.jobId, job])).values()];
    const base = { enabled: setting.config.enabled, revision: setting.revision, jobs: jobList };
    if (!setting.config.enabled) return { ...base, ready: false, status: "semantic_disabled" };
    if (!configured(setting.config)) return { ...base, ready: false, status: "semantic_configuration_incomplete" };
    if (setting.tested !== testFingerprint(setting.config)) return { ...base, ready: false, status: "semantic_services_unverified" };
    try {
      const source = await json(resolve(currentRoot, "library.json")), manifest = await semanticManifest(currentRoot);
      return await withClient(currentRoot, source.generation, { config: setting.config, generation: manifest.generation }, async (_client, _snapshot, info) => {
        if (!info.coverage.validPassages) return { ...base, ready: false, status: "semantic_empty", ...info };
        if (info.count > setting.config.retrieval.maxVectors || info.vectorBytes > setting.config.retrieval.maxVectorBytes) return { ...base, ready: false, status: "semantic_capacity_exceeded" };
        return { ...base, ready: true, status: info.coverage.partial ? "ready_partial" : "ready", ...info };
      });
    } catch (error) { return { ...base, ready: false, status: error.code === "ENOENT" ? "semantic_not_built" : ["semantic_index_incompatible", "semantic_index_corrupt"].includes(error.code) ? error.code : "semantic_index_unavailable" }; }
  }
  async function start({ resumeJobId, forceEncoding = false } = {}) {
    if (typeof forceEncoding !== "boolean") fail("invalid_request");
    const currentRoot = await root(); if (activeRoots.has(currentRoot)) fail("writer_busy");
    let setting = await settings(), jobId = resumeJobId ? id(resumeJobId) : randomUUID();
    const jobDirectory = resolve(currentRoot, "semantic", "jobs", jobId);
    if (resumeJobId) setting = await json(resolve(jobDirectory, "settings.json"), null);
    if (!setting || !configured(setting.config)) fail("semantic_configuration_incomplete");
    if (setting.tested !== testFingerprint(setting.config)) fail("semantic_services_unverified");
    if (resumeJobId) { const old = await json(resolve(jobDirectory, "job.json"), null); if (!old || !["cancelled", "failed", "running"].includes(old.status)) fail("resume_incompatible"); forceEncoding = old.forceEncoding; }
    await mkdir(jobDirectory, { recursive: true }); await rm(resolve(jobDirectory, "cancel"), { force: true }); await atomicJson(resolve(jobDirectory, "settings.json"), setting);
    const secrets = await credentials(setting.config), client = new LibraryClient();
    const progress = { jobId, status: "running", phase: "starting" }; const job = { root: currentRoot, progress, client }; jobs.set(jobId, job); activeRoots.add(currentRoot);
    job.promise = client.buildSemantic(currentRoot, setting.config, { jobId, resume: Boolean(resumeJobId), forceEncoding, secrets, queryPriority: queryPriority.buffer }).then(result => { job.progress = result; return result; }, error => { job.progress = { ...job.progress, status: error.code === "cancelled" ? "cancelled" : "failed", errorCode: error.code ?? "semantic_build_failed" }; }).finally(async () => { activeRoots.delete(currentRoot); jobs.delete(jobId); await client.close(); });
    return { jobId, status: "running" };
  }
  async function cancel(jobId) {
    const currentRoot = jobs.get(jobId)?.root ?? await root(), path = resolve(currentRoot, "semantic", "jobs", id(jobId));
    if (!jobs.has(jobId) && !(await json(resolve(path, "job.json"), null))) fail("job_not_found");
    await writeFile(resolve(path, "cancel"), "cancel\n", { mode: 0o600 }); return { jobId, status: "cancellation_requested" };
  }
  return {
    directory, settings, credentials, publicSettings, save, test, status, start, cancel, withClient, queryCache,
    async snapshot() { const setting = await settings(); if (!setting.config.enabled) fail("semantic_disabled"); if (!configured(setting.config)) fail("semantic_configuration_incomplete"); if (setting.tested !== testFingerprint(setting.config)) fail("semantic_services_unverified"); const currentRoot = await root(); return { ...setting, root: currentRoot, secrets: await credentials(setting.config), generation: (await semanticManifest(currentRoot)).generation }; },
    registerController(controller) { controllers.add(controller); return () => controllers.delete(controller); },
    async wait(jobId) { const job = jobs.get(jobId); if (job) await job.promise; return json(resolve(job?.root ?? await root(), "semantic", "jobs", id(jobId), "job.json"), null); },
    async close() { closed = true; for (const waiter of waiters.splice(0)) waiter.reject(Object.assign(new Error("Cancelled."), { code: "cancelled" })); for (const controller of controllers) controller.abort(); for (const job of jobs.values()) await writeFile(resolve(job.root, "semantic", "jobs", job.progress.jobId, "cancel"), "cancel\n").catch(() => {}); await Promise.allSettled([...jobs.values()].map(job => job.promise)); await Promise.all(pool.map(entry => { clearTimeout(entry.timer); return entry.client.close(); })); },
  };
}
export function getSemanticManager(options) { const key = resolve(options.configurationDirectory); if (!managers.has(key)) managers.set(key, createSemanticManager(options)); return managers.get(key); }
