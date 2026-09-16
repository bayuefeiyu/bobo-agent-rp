import { createHash } from "node:crypto";

import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./rp-token-usage.mjs";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function adaptAssistanceTaskInput(ability, task) {
  const documents = { ...structuredClone(ability.documents || {}), ...structuredClone(task.documents || {}) };
  if (ability.inputAdapter === "natural-language-v1" || ability.inputAdapter === "memory-request-v1") {
    return { text: task.text, arguments: structuredClone(ability.fixedArguments || {}), documents };
  }
  throw new Error(`Unsupported team input adapter: ${ability.inputAdapter}`);
}

export class AssistanceTaskManager {
  constructor({ state, store, abilities, startWorkflow, invokeAgent, invokeTool, onUsage = () => {}, onRetry = () => {}, isCancelled = () => false, concurrency = 2 }) {
    this.state = state;
    this.store = store;
    this.abilities = new Map(abilities.map(entry => [entry.id, entry]));
    this.startWorkflow = startWorkflow;
    this.invokeAgent = invokeAgent;
    this.invokeTool = invokeTool;
    this.onUsage = onUsage;
    this.onRetry = onRetry;
    this.isCancelled = isCancelled;
    this.concurrency = concurrency;
    this.running = new Map();
    this.queue = Object.values(this.state.tasks || {}).filter(task => task.status === "queued");
    if (this.queue.length) queueMicrotask(() => this.#pump());
  }

  async start({ abilityId, requestId, text, documents = {}, required = false }) {
    this.#assertActive();
    const ability = this.abilities.get(abilityId);
    if (!ability || !ability.enabled) throw new Error(`Unavailable team ability: ${abilityId}`);
    const taskFingerprint = fingerprint({ abilityId, requestId, text, documents, fixedArguments: ability.fixedArguments, inputAdapter: ability.inputAdapter });
    this.state.taskFingerprints ||= {};
    const prior = this.state.taskFingerprints[`${abilityId}:${requestId}`];
    if (prior) {
      if (prior.fingerprint !== taskFingerprint) throw Object.assign(new Error(`Assistance request ${requestId} was reused with different input.`), { code: "team_task_conflict" });
      const existing = this.state.tasks?.[prior.taskId];
      if (existing && ["failed", "timed-out"].includes(existing.status)) {
        const nextAttempt = (existing.attempt || 1) + 1;
        await this.onRetry({ task: structuredClone(existing), nextAttempt });
        existing.attempt = nextAttempt;
        existing.status = "queued";
        existing.error = null;
        existing.result = null;
        delete existing.publication;
        delete existing.startedAt;
        delete existing.completedAt;
        if (!this.state.pendingTaskIds.includes(existing.taskId)) this.state.pendingTaskIds.push(existing.taskId);
        await this.store.event(this.state, "assistance-task-requeued", { taskId: existing.taskId, abilityId, requestId, attempt: existing.attempt });
        this.queue.push(existing);
        this.#pump();
      }
      return { taskId: prior.taskId, reused: true };
    }
    const taskId = `task-${String(++this.state.taskSeq).padStart(4, "0")}`;
    const task = {
      taskId,
      abilityId,
      requestId,
      required,
      attempt: 1,
      status: "queued",
      fingerprint: taskFingerprint,
      text,
      documents,
      createdAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    this.state.taskFingerprints[`${abilityId}:${requestId}`] = { taskId, fingerprint: taskFingerprint };
    this.state.tasks ||= {};
    this.state.tasks[taskId] = task;
    this.state.pendingTaskIds.push(taskId);
    await this.store.event(this.state, "assistance-task-queued", { taskId, abilityId, requestId, required });
    this.queue.push(task);
    this.#pump();
    return { taskId, reused: false };
  }

  get(taskId) {
    const task = this.state.tasks?.[taskId];
    if (!task) throw new Error(`Unknown assistance task: ${taskId}`);
    return structuredClone(task);
  }

  async wait(taskIds = null) {
    const ids = taskIds || Object.keys(this.state.tasks || {});
    while (true) {
      const running = ids.map(id => this.running.get(id)).filter(Boolean);
      if (running.length) {
        await Promise.race(running);
        continue;
      }
      if (!ids.some(id => !["succeeded", "failed", "timed-out", "cancelled"].includes(this.state.tasks[id]?.status))) break;
      if (!this.queue.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return ids.map(id => this.get(id));
  }

  async drain() {
    return this.wait(Object.keys(this.state.tasks || {}));
  }

  #pump() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      const promise = this.#execute(task).finally(() => {
        this.running.delete(task.taskId);
        this.#pump();
      });
      this.running.set(task.taskId, promise);
    }
  }

  async #execute(task) {
    const ability = this.abilities.get(task.abilityId);
    const attempt = task.attempt || 1;
    const attemptId = `${task.taskId}#attempt-${attempt}`;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    await this.store.event(this.state, "assistance-task-started", { taskId: task.taskId, abilityId: task.abilityId });
    let timer;
    let timedOut = false;
    let observedUsage = null;
    try {
      this.#assertActive();
      const adapted = adaptAssistanceTaskInput(ability, task);
      const execution = Promise.resolve(ability.kind === "workflow"
        ? this.startWorkflow({
            workflow: ability.target,
            text: adapted.text,
            arguments: adapted.arguments,
            documents: adapted.documents,
            outputPaths: Object.fromEntries(ability.exports.map(id => [id, `team/tasks/${task.taskId}/outputs/${id}`])),
          }, { parallel: true, agent: false })
        : ability.kind === "agent"
          ? this.invokeAgent({
              executionId: task.taskId,
              attemptId,
              abilityId: ability.id,
              agentId: ability.agentId,
              modelId: ability.modelId,
              role: "assistant",
              prompt: [ability.prompt, task.text].filter(Boolean).join("\n\n"),
              documents: task.documents,
            })
          : this.invokeTool({ adapter: ability.adapter, text: adapted.text, documents: adapted.documents, arguments: adapted.arguments }));
      execution.then(
        result => { if (timedOut) void this.#recordLateUsage(task, ability, result?.usage || null, "late-succeeded", attempt); },
        error => { if (timedOut) void this.#recordLateUsage(task, ability, error?.usage || null, "late-failed", attempt); },
      );
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error(`Assistance task timed out after ${ability.timeoutMs}ms.`), { code: "team_task_timeout" })); }, ability.timeoutMs); });
      const result = await Promise.race([execution, timeout]);
      observedUsage = result?.usage || null;
      await this.#recordAttemptUsage(task, ability, observedUsage, "returned", attempt);
      this.#assertActive();
      task.result = ability.kind === "workflow" && result && typeof result === "object"
        ? {
            ...result,
            outputs: Object.fromEntries(Object.entries(result.outputs || {}).map(([id, path]) => [id, typeof path === "string" && path.startsWith("team/") ? path.slice("team/".length) : path])),
          }
        : result;
      task.status = "publishing";
      const report = await this.store.artifact(`tasks/${task.taskId}/report.json`, `${JSON.stringify(task.result, null, 2)}\n`);
      const delivered = [
        { path: `tasks/${task.taskId}/report.json`, kind: "file", taskId: task.taskId },
        ...Object.entries(task.result?.outputs || {}).filter(([, path]) => typeof path === "string").map(([id, path]) => ({
          path,
          kind: task.result?.outputArtifacts?.[id]?.kind === "directory" ? "directory" : "file",
          taskId: task.taskId,
        })),
      ];
      await this.store.registerDeliveries(delivered);
      task.completedAt = new Date().toISOString();
      task.publication = {
        status: "confirmed",
        report,
        deliveries: structuredClone(delivered),
        confirmedAt: task.completedAt,
      };
      const confirmation = await this.store.event(this.state, "assistance-task-succeeded", {
        taskId: task.taskId,
        abilityId: task.abilityId,
        completedAt: task.completedAt,
        report,
        deliveries: delivered,
        finalStatus: "succeeded",
      });
      task.publication.confirmationEventSeq = confirmation.seq;
      task.status = "succeeded";
      await this.#recordAttemptUsage(task, ability, observedUsage, "succeeded", attempt);
    } catch (error) {
      task.status = error?.code === "workflow_cancelled" ? "cancelled" : error?.code === "team_task_timeout" ? "timed-out" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date().toISOString();
      if (task.publication) task.publication.status = "unconfirmed";
      await this.#recordAttemptUsage(task, ability, error?.usage || observedUsage || null, task.status, attempt);
      await this.store.event(this.state, `assistance-task-${task.status}`, { taskId: task.taskId, abilityId: task.abilityId, error: task.error });
    } finally {
      clearTimeout(timer);
      this.state.pendingTaskIds = this.state.pendingTaskIds.filter(id => id !== task.taskId);
      await this.store.save(this.state);
    }
  }

  async #recordAttemptUsage(task, ability, rawUsage, outcome, attempt) {
    const attemptId = `${task.taskId}#attempt-${attempt}`;
    const normalized = normalizeTokenUsage(rawUsage && typeof rawUsage === "object" && !Number.isFinite(rawUsage.totalTokens) && Number.isFinite(rawUsage.total)
      ? { ...rawUsage, totalTokens: rawUsage.total }
      : rawUsage);
    task.usageAttempts ||= {};
    const existing = task.usageAttempts[attemptId] || null;
    const previous = existing?.usage || null;
    const merged = normalized
      ? Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, Math.max(previous?.[key] || 0, normalized[key])]))
      : previous;
    const status = merged ? (rawUsage?.partial === true ? "partial" : "recorded") : "unknown";
    const changed = Boolean(merged) && (!previous || Object.keys(merged).some(key => merged[key] !== previous[key]));
    const shouldNotify = !existing?.accounted || changed || existing.status !== status;
    task.usageAttempts[attemptId] = {
      attemptId,
      attempt,
      status,
      outcome,
      usage: merged || null,
      accounted: existing?.accounted || shouldNotify,
      updatedAt: new Date().toISOString(),
    };
    const recorded = Object.values(task.usageAttempts).filter(entry => entry.usage);
    task.usage = recorded.length ? recorded.reduce((total, entry) => addTokenUsage(total, entry.usage), emptyTokenUsage()) : null;
    if (shouldNotify) await this.onUsage(merged || null, { attemptId, attempt, status, outcome, task, ability });
    return { changed, status, usage: merged || null };
  }

  async #recordLateUsage(task, ability, usage, outcome, attempt) {
    try {
      const update = await this.#recordAttemptUsage(task, ability, usage, outcome, attempt);
      if (!update.changed) return;
      await this.store.event(this.state, "assistance-task-usage-supplemented", {
        taskId: task.taskId,
        abilityId: task.abilityId,
        attempt,
        attemptId: `${task.taskId}#attempt-${attempt}`,
        outcome,
        usage: update.usage,
      });
    } catch {
      // Usage reconciliation must never publish a late business result or change the terminal task outcome.
    }
  }

  #assertActive() {
    if (this.isCancelled()) throw Object.assign(new Error("The team workflow was cancelled before assistance could be dispatched or published."), { code: "workflow_cancelled" });
  }
}
