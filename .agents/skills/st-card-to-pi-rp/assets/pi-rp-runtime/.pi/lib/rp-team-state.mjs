import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { normalizeTokenUsage } from "./rp-token-usage.mjs";

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

const deliveryCommitQueues = new Map();

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const backup = `${path}.previous`;
  await rm(backup, { force: true });
  await rename(path, backup).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    await rename(temporary, path);
    await rm(backup, { force: true });
  } catch (error) {
    await rename(backup, path).catch(() => {});
    throw error;
  }
}

export function initialTeamState(config, { runId = null, nodeId = null } = {}) {
  return {
    schemaVersion: 1,
    runId,
    nodeId,
    status: "running",
    phase: "initial-analysis",
    round: 0,
    eventSeq: 0,
    speechSeq: 0,
    requestSeq: 0,
    taskSeq: 0,
    closeRequested: false,
    requestCutoffSpeechSeq: null,
    coordinationCursor: 0,
    deliveredTaskIds: [],
    pendingRequestIds: [],
    pendingTaskIds: [],
    budgets: Object.fromEntries(Object.entries(config.budgets).map(([pool, budget]) => [pool, { limit: budget.calls, reserved: 0, used: 0 }])),
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, recordedCalls: 0, unrecordedCalls: 0 },
    usageAttempts: {},
    deliverables: { report: null, references: null },
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

export function reserveTeamBudget(state, pool, executionId) {
  const budget = state.budgets[pool];
  if (!budget) throw new Error(`Unknown team budget pool: ${pool}`);
  state.reservations ||= {};
  const existing = state.reservations[executionId];
  if (existing) {
    if (existing.pool !== pool) throw new Error(`Execution ${executionId} is already reserved from ${existing.pool}.`);
    return existing;
  }
  if (budget.reserved + budget.used >= budget.limit) throw Object.assign(new Error(`Team budget exhausted: ${pool}.`), { code: "team_budget_exhausted", pool });
  const reservation = { executionId, pool, status: "reserved", reservedAt: new Date().toISOString() };
  state.reservations[executionId] = reservation;
  budget.reserved += 1;
  return reservation;
}

export function consumeTeamBudget(state, executionId, usage = null) {
  const reservation = state.reservations?.[executionId];
  if (!reservation) throw new Error(`Unknown team budget reservation: ${executionId}`);
  if (reservation.status === "used") return reservation;
  const budget = state.budgets[reservation.pool];
  budget.reserved = Math.max(0, budget.reserved - 1);
  budget.used += 1;
  reservation.status = "used";
  reservation.usedAt = new Date().toISOString();
  state.usage.calls += 1;
  if (usage && typeof usage === "object") {
    state.usage.recordedCalls = (state.usage.recordedCalls || 0) + 1;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      if (Number.isFinite(usage[key])) state.usage[key] += usage[key];
    }
    const totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : usage.total;
    if (Number.isFinite(totalTokens)) state.usage.totalTokens += totalTokens;
  } else state.usage.unrecordedCalls = (state.usage.unrecordedCalls || 0) + 1;
  return reservation;
}

export function recordTeamUsage(state, usage, { attemptId = null, status = null, outcome = null, source = null } = {}) {
  const normalized = normalizeTokenUsage(usage && typeof usage === "object" && !Number.isFinite(usage.totalTokens) && Number.isFinite(usage.total)
    ? { ...usage, totalTokens: usage.total }
    : usage);
  if (!attemptId) {
    if (!normalized) return false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) state.usage[key] += normalized[key];
    state.usage.recordedCalls = (state.usage.recordedCalls || 0) + 1;
    state.usage.unrecordedCalls = Math.max(0, (state.usage.unrecordedCalls || 0) - 1);
    return true;
  }

  state.usageAttempts ||= {};
  const existing = state.usageAttempts[attemptId] || null;
  const previous = existing?.usage || null;
  const merged = normalized
    ? Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, Math.max(previous?.[key] || 0, normalized[key])]))
    : previous;
  const changed = Boolean(merged) && (!previous || Object.keys(merged).some(key => merged[key] !== previous[key]));
  if (changed) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) state.usage[key] += merged[key] - (previous?.[key] || 0);
    if (!previous) {
      state.usage.recordedCalls = (state.usage.recordedCalls || 0) + 1;
      state.usage.unrecordedCalls = Math.max(0, (state.usage.unrecordedCalls || 0) - 1);
    }
  }
  state.usageAttempts[attemptId] = {
    attemptId,
    status: merged ? (status === "partial" ? "partial" : "recorded") : "unknown",
    outcome: outcome || existing?.outcome || null,
    source: source || existing?.source || null,
    usage: merged || null,
    updatedAt: new Date().toISOString(),
  };
  return changed;
}

export function releaseTeamBudget(state, executionId) {
  const reservation = state.reservations?.[executionId];
  if (!reservation || reservation.status !== "reserved") return;
  state.budgets[reservation.pool].reserved = Math.max(0, state.budgets[reservation.pool].reserved - 1);
  reservation.status = "released";
  reservation.releasedAt = new Date().toISOString();
}

export class TeamStateStore {
  constructor(root) {
    this.root = resolve(root);
    this.statePath = resolve(this.root, "state.json");
    this.eventsPath = resolve(this.root, "events.jsonl");
    this.writeQueue = Promise.resolve();
  }

  async ensure(config, identity = {}) {
    await mkdir(this.root, { recursive: true });
    let invalidStateError = null;
    const candidate = async path => readFile(path, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      invalidStateError ||= error;
      return null;
    });
    const currentState = await candidate(this.statePath);
    const candidates = [currentState, await candidate(`${this.statePath}.previous`), await this.#eventSnapshot()]
      .filter(Boolean)
      .sort((left, right) => (right.eventSeq || 0) - (left.eventSeq || 0));
    const state = candidates[0] || null;
    if (!state && invalidStateError) throw invalidStateError;
    if (state && state !== currentState) await atomicJson(this.statePath, state);
    if (state) return state;
    const created = initialTeamState(config, identity);
    await atomicJson(this.statePath, created);
    return created;
  }

  async read() {
    return JSON.parse(await readFile(this.statePath, "utf8"));
  }

  async #eventSnapshot() {
    const content = await readFile(this.eventsPath, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split(/\r?\n/).filter(Boolean);
    let snapshot = null;
    for (const [index, line] of lines.entries()) {
      try {
        const event = JSON.parse(line);
        if (event?.stateSnapshot && typeof event.stateSnapshot === "object") snapshot = event.stateSnapshot;
      } catch (error) {
        if (index !== lines.length - 1) throw Object.assign(new Error(`Team event journal is corrupted at line ${index + 1}.`), { cause: error });
      }
    }
    return snapshot;
  }

  async save(state) {
    state.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(state);
    const operation = this.writeQueue.then(() => atomicJson(this.statePath, snapshot));
    this.writeQueue = operation.catch(() => {});
    await operation;
  }

  async event(state, type, detail = {}) {
    const event = { seq: ++state.eventSeq, type, at: new Date().toISOString(), ...structuredClone(detail), stateSnapshot: structuredClone(state) };
    const handle = await open(this.eventsPath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.save(state);
    return event;
  }

  async artifact(relativePath, content) {
    const path = resolve(this.root, relativePath);
    const relation = relative(this.root, path);
    if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error("Team artifact path escapes the team workspace.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { path, relativePath: relativePath.replaceAll("\\", "/"), hash: hash(content), characters: content.length };
  }

  async readArtifact(relativePath, expectedHash = null) {
    const path = resolve(this.root, relativePath);
    const relation = relative(this.root, path);
    if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error("Team artifact path escapes the team workspace.");
    const content = await readFile(path, "utf8");
    if (expectedHash && hash(content) !== expectedHash) throw Object.assign(new Error(`Team artifact hash mismatch: ${relativePath}.`), { code: "team_artifact_corrupt", relativePath });
    return content;
  }

  async registerDeliveries(entries) {
    const normalized = entries.map(entry => ({
      path: String(entry.path || "").replaceAll("\\", "/"),
      kind: entry.kind === "directory" ? "directory" : "file",
      taskId: entry.taskId ? String(entry.taskId) : null,
    }));
    for (const entry of normalized) {
      if (!entry.path || entry.path.startsWith("/") || /^[A-Za-z]:/.test(entry.path) || entry.path.split("/").includes("..")) throw new Error("Team delivery path must be safe and relative.");
    }
    return this.#deliveryTransaction(async () => {
      const sharedRoot = resolve(this.root, "shared");
      const manifestRoot = resolve(sharedRoot, "delivery-manifests");
      await mkdir(manifestRoot, { recursive: true });
      const byTask = new Map();
      for (const entry of normalized.filter(item => item.taskId)) {
        if (!byTask.has(entry.taskId)) byTask.set(entry.taskId, []);
        byTask.get(entry.taskId).push(entry);
      }
      for (const [taskId, taskEntries] of byTask) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) throw new Error("Team delivery task ID must be filesystem-safe.");
        const manifest = {
          schemaVersion: 1,
          taskId,
          entries: [...taskEntries].sort((left, right) => `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`)),
        };
        manifest.hash = hash(manifest.entries);
        const manifestPath = resolve(manifestRoot, `${taskId}.json`);
        const existing = await readFile(manifestPath, "utf8").then(JSON.parse).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing) {
          if (existing.hash !== manifest.hash || JSON.stringify(existing.entries) !== JSON.stringify(manifest.entries)) {
            throw Object.assign(new Error(`Team delivery manifest conflict: ${taskId}.`), { code: "team_delivery_manifest_conflict", taskId });
          }
        } else await atomicJson(manifestPath, manifest);
      }

      const catalogPath = resolve(sharedRoot, "DELIVERIES.json");
      const current = await readFile(catalogPath, "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const manifests = [];
      for (const entry of await readdir(manifestRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const manifest = JSON.parse(await readFile(resolve(manifestRoot, entry.name), "utf8"));
        if (manifest.hash !== hash(manifest.entries)) throw Object.assign(new Error(`Team delivery manifest hash mismatch: ${entry.name}.`), { code: "team_delivery_manifest_corrupt" });
        manifests.push(...manifest.entries);
      }
      const merged = [];
      for (const entry of [...current, ...manifests, ...normalized.filter(item => !item.taskId)]) {
        const prior = merged.find(item => item.path === entry.path && item.kind === entry.kind);
        if (prior && prior.taskId !== entry.taskId) throw Object.assign(new Error(`Team delivery path is already owned by another task: ${entry.path}.`), { code: "team_delivery_path_conflict", path: entry.path });
        if (!prior) merged.push(entry);
      }
      merged.sort((left, right) => `${left.taskId || ""}\0${left.path}\0${left.kind}`.localeCompare(`${right.taskId || ""}\0${right.path}\0${right.kind}`));
      await atomicJson(catalogPath, merged);
      return structuredClone(merged);
    });
  }

  async registerDeliverySnapshot(deliveryId, taskIds) {
    if (typeof deliveryId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(deliveryId)) throw new Error("Team delivery snapshot ID must be filesystem-safe.");
    const allowedTaskIds = new Set(taskIds || []);
    return this.#deliveryTransaction(async () => {
      const deliveries = await readFile(resolve(this.root, "shared", "DELIVERIES.json"), "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const snapshot = deliveries.filter(entry => allowedTaskIds.has(entry.taskId));
      const snapshotPath = resolve(this.root, "shared", "deliveries", `${deliveryId}.json`);
      const existing = await readFile(snapshotPath, "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw Object.assign(new Error(`Team delivery snapshot conflict: ${deliveryId}.`), { code: "team_delivery_snapshot_conflict", deliveryId });
        return structuredClone(existing);
      }
      await atomicJson(snapshotPath, snapshot);
      return structuredClone(snapshot);
    });
  }

  async #deliveryTransaction(operation) {
    const previous = deliveryCommitQueues.get(this.root) || Promise.resolve();
    const queued = previous.then(async () => {
      const sharedRoot = resolve(this.root, "shared");
      const lockPath = resolve(sharedRoot, ".delivery-write.lock");
      await mkdir(sharedRoot, { recursive: true });
      let lock;
      try {
        lock = await open(lockPath, "wx");
      } catch (error) {
        if (error.code === "EEXIST") throw Object.assign(new Error("Another process owns the team delivery writer lock."), { code: "team_delivery_writer_conflict", lockPath });
        throw error;
      }
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid, root: this.root, acquiredAt: new Date().toISOString() })}\n`, "utf8");
        await lock.sync();
        return await operation();
      } finally {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    });
    deliveryCommitQueues.set(this.root, queued.catch(() => {}));
    return queued;
  }

  async publishSpeech(state, { executionId, memberId, phase, round = null, content, deliveryId = null }) {
    const speechId = `speech-${String(++state.speechSeq).padStart(4, "0")}`;
    const artifact = await this.artifact(`speeches/${speechId}.md`, String(content));
    state.executions ||= {};
    state.executions[executionId] = { kind: "speech", memberId, phase, round, artifactId: speechId, artifact };
    await this.event(state, "speech-published", { executionId, memberId, phase, round, artifactId: speechId, artifact, deliveryId });
    const speeches = Object.values(state.executions)
      .filter(execution => execution.kind === "speech" && execution.artifactId && execution.artifact?.relativePath)
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const transcript = [];
    for (const speech of speeches) {
      transcript.push(`## ${speech.artifactId} · ${speech.memberId} · ${speech.phase}${speech.round === null ? "" : ` · round ${speech.round}`}`, "", (await this.readArtifact(speech.artifact.relativePath, speech.artifact.hash)).trim(), "");
    }
    await this.artifact("shared/TRANSCRIPT.md", transcript.join("\n"));
    return { speechId, ...artifact };
  }
}
