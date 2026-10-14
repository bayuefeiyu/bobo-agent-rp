import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeTokenUsage, addTokenUsage } from "./rp-token-usage.mjs";

export function callRecordPath(sessionDirectory, runId, nodeId) {
  for (const id of [runId, nodeId]) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Invalid process record ID.");
  return resolve(sessionDirectory, "workflow/process-records", runId, `${nodeId}.calls.jsonl`);
}
export async function hasCallRecords(sessionDirectory, runId, nodeId) {
  return stat(callRecordPath(sessionDirectory, runId, nodeId)).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
}
const queues = new Map();
function appendEvent(path, event) {
  const prior = queues.get(path) || Promise.resolve();
  const pending = prior.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf8");
  });
  queues.set(path, pending);
  pending.finally(() => { if (queues.get(path) === pending) queues.delete(path); }).catch(() => {});
  return pending;
}

// Observe the provider-ready context, after tails, budgets and tool messages have been assembled.
// Never record request options: they may contain credentials.
export function installCallRecorder(session, { sessionDirectory, run, node, binding, agentId, memberId = null }) {
  const nodeId = node.metadata?.recordNodeId || node.id;
  const path = callRecordPath(sessionDirectory, run.id, nodeId);
  const attempt = run.nodes?.[nodeId]?.attempts?.length || 1;
  const worker = session.agent;
  const property = typeof worker.streamFunction === "function" ? "streamFunction" : "streamFn";
  const original = worker[property];
  if (typeof original !== "function") throw new Error("Pi does not expose a model stream function for call recording.");
  let current = null, number = 0, pending = Promise.resolve(), recordError = null, finished = false;
  const save = event => { pending = appendEvent(path, event).catch(error => { recordError = error; }); };
  const wrapped = function(model, context, options) {
    current = { id: randomUUID(), attempt, memberId, agentId, modelId: binding.modelId, providerModel: model.id, provider: model.provider,
      number: ++number, startedAt: new Date().toISOString(), status: "running", request: structuredClone(context) };
    save({ type: "start", call: current });
    try { return original.call(this, model, context, options); }
    catch (error) { save({ type: "end", id: current.id, endedAt: new Date().toISOString(), status: "failed", error: String(error?.message || error), usage: null }); throw error; }
  };
  worker[property] = wrapped;
  const unsubscribe = session.subscribe(event => {
    if (!current) return;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      const usage = normalizeTokenUsage(message.usage);
      save({ type: "end", id: current.id, endedAt: new Date().toISOString(), status: message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "completed",
        response: structuredClone(message), usage: ["error", "aborted"].includes(message.stopReason) && usage?.totalTokens === 0 ? null : usage, error: message.errorMessage || null });
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      save({ type: "tool", id: current.id, event: structuredClone(event), at: new Date().toISOString() });
    }
  });
  /** @param {any} [error] */
  async function finish(error = null) {
    if (finished) return;
    finished = true;
    if (error && current) save({ type: "failure", id: current.id, error: String(error.message || error), endedAt: new Date().toISOString() });
    unsubscribe();
    if (worker[property] === wrapped) worker[property] = original;
    await pending;
    // Observability failures are reported without retrying a successful creative task.
    if (recordError) console.warn("Workflow call record could not be saved:", recordError.message);
  }
  return { finish };
}

export async function readCallRecords(sessionDirectory, runId, nodeId) {
  const text = await readFile(callRecordPath(sessionDirectory, runId, nodeId), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  const records = new Map();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    let event;
    try { event = JSON.parse(lines[index]); } catch (error) { if (index === lines.length - 1) continue; throw error; }
    if (event.type === "start") records.set(event.call.id, { ...event.call, tools: [] });
    else {
      const call = records.get(event.id); if (!call) continue;
      if (event.type === "end") Object.assign(call, { status: event.status, endedAt: event.endedAt, response: event.response, usage: event.usage, error: event.error });
      if (event.type === "tool") call.tools.push({ ...event.event, at: event.at });
      if (event.type === "failure") { call.error = event.error; if (call.status === "running") { call.status = "failed"; call.endedAt = event.endedAt; } }
    }
  }
  let usage = null;
  const calls = [...records.values()];
  for (const call of calls) if (call.usage) usage = addTokenUsage(usage, call.usage);
  return { schemaVersion: 1, calls, usage, usageComplete: calls.every(call => call.usage != null) };
}
