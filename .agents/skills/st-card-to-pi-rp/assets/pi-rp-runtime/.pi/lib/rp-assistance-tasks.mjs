import { createHash } from "node:crypto";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AssistanceTaskManager {
  constructor({ state, store, abilities, startWorkflow, invokeAgent, invokeTool, onUsage = () => {}, isCancelled = () => false, concurrency = 2 }) {
    this.state = state;
    this.store = store;
    this.abilities = new Map(abilities.map(entry => [entry.id, entry]));
    this.startWorkflow = startWorkflow;
    this.invokeAgent = invokeAgent;
    this.invokeTool = invokeTool;
    this.onUsage = onUsage;
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
        existing.attempt = (existing.attempt || 1) + 1;
        existing.status = "queued";
        existing.error = null;
        existing.result = null;
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
    while (ids.some(id => !["succeeded", "failed", "timed-out", "cancelled"].includes(this.state.tasks[id]?.status))) {
      const running = [...this.running.values()];
      if (!running.length && !this.queue.length) break;
      await Promise.race(running.length ? running : [new Promise(resolve => setTimeout(resolve, 10))]);
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
    task.status = "running";
    task.startedAt = new Date().toISOString();
    await this.store.event(this.state, "assistance-task-started", { taskId: task.taskId, abilityId: task.abilityId });
    let timer;
    try {
      this.#assertActive();
      const adapted = this.#adaptInput(ability, task);
      const execution = ability.kind === "workflow"
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
              abilityId: ability.id,
              agentId: ability.agentId,
              modelId: ability.modelId,
              role: "assistant",
              prompt: [ability.prompt, task.text].filter(Boolean).join("\n\n"),
              documents: task.documents,
            })
          : this.invokeTool({ adapter: ability.adapter, text: adapted.text, documents: adapted.documents, arguments: adapted.arguments });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Assistance task timed out after ${ability.timeoutMs}ms.`), { code: "team_task_timeout" })), ability.timeoutMs); });
      const result = await Promise.race([execution, timeout]);
      this.#assertActive();
      this.onUsage(result?.usage || null, { task, ability });
      task.result = ability.kind === "workflow" && result && typeof result === "object"
        ? {
            ...result,
            outputs: Object.fromEntries(Object.entries(result.outputs || {}).map(([id, path]) => [id, typeof path === "string" && path.startsWith("team/") ? path.slice("team/".length) : path])),
          }
        : result;
      task.status = "succeeded";
      task.completedAt = new Date().toISOString();
      await this.store.artifact(`tasks/${task.taskId}/report.json`, `${JSON.stringify(task.result, null, 2)}\n`);
      const delivered = [
        { path: `tasks/${task.taskId}/report.json`, kind: "file", taskId: task.taskId },
        ...Object.entries(task.result?.outputs || {}).filter(([, path]) => typeof path === "string").map(([id, path]) => ({
          path,
          kind: task.result?.outputArtifacts?.[id]?.kind === "directory" ? "directory" : "file",
          taskId: task.taskId,
        })),
      ];
      await this.store.registerDeliveries(delivered);
      await this.store.event(this.state, "assistance-task-succeeded", { taskId: task.taskId, abilityId: task.abilityId });
    } catch (error) {
      task.status = error?.code === "workflow_cancelled" ? "cancelled" : error?.code === "team_task_timeout" ? "timed-out" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date().toISOString();
      await this.store.event(this.state, `assistance-task-${task.status}`, { taskId: task.taskId, abilityId: task.abilityId, error: task.error });
    } finally {
      clearTimeout(timer);
      this.state.pendingTaskIds = this.state.pendingTaskIds.filter(id => id !== task.taskId);
      await this.store.save(this.state);
    }
  }

  #adaptInput(ability, task) {
    const documents = { ...structuredClone(ability.documents), ...structuredClone(task.documents) };
    if (ability.inputAdapter === "natural-language-v1") {
      return { text: task.text, arguments: structuredClone(ability.fixedArguments), documents };
    }
    if (ability.inputAdapter === "memory-request-v1") {
      return {
        text: task.text,
        arguments: { query: task.text, requestId: task.requestId, ...structuredClone(ability.fixedArguments) },
        documents,
      };
    }
    throw new Error(`Unsupported team input adapter: ${ability.inputAdapter}`);
  }

  #assertActive() {
    if (this.isCancelled()) throw Object.assign(new Error("The team workflow was cancelled before assistance could be dispatched or published."), { code: "workflow_cancelled" });
  }
}
