import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

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

export function recordTeamUsage(state, usage) {
  if (!usage || typeof usage !== "object") return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (Number.isFinite(usage[key])) state.usage[key] += usage[key];
  }
  const totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : usage.total;
  if (Number.isFinite(totalTokens)) state.usage.totalTokens += totalTokens;
  state.usage.recordedCalls = (state.usage.recordedCalls || 0) + 1;
  state.usage.unrecordedCalls = Math.max(0, (state.usage.unrecordedCalls || 0) - 1);
  return true;
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

  async readArtifact(relativePath) {
    const path = resolve(this.root, relativePath);
    const relation = relative(this.root, path);
    if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error("Team artifact path escapes the team workspace.");
    return readFile(path, "utf8");
  }

  async registerDeliveries(entries) {
    const path = resolve(this.root, "shared", "DELIVERIES.json");
    await mkdir(dirname(path), { recursive: true });
    const current = await readFile(path, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const normalized = entries.map(entry => ({
      path: String(entry.path || "").replaceAll("\\", "/"),
      kind: entry.kind === "directory" ? "directory" : "file",
      taskId: entry.taskId || null,
    }));
    const merged = [...current];
    for (const entry of normalized) {
      if (!entry.path || entry.path.startsWith("/") || /^[A-Za-z]:/.test(entry.path) || entry.path.split("/").includes("..")) throw new Error("Team delivery path must be safe and relative.");
      if (!merged.some(item => item.path === entry.path && item.kind === entry.kind)) merged.push(entry);
    }
    await atomicJson(path, merged);
    return structuredClone(merged);
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
      transcript.push(`## ${speech.artifactId} · ${speech.memberId} · ${speech.phase}${speech.round === null ? "" : ` · round ${speech.round}`}`, "", (await this.readArtifact(speech.artifact.relativePath)).trim(), "");
    }
    await this.artifact("shared/TRANSCRIPT.md", transcript.join("\n"));
    return { speechId, ...artifact };
  }
}
