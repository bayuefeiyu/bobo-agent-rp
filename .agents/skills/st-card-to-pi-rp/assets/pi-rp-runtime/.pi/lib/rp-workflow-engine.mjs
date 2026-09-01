import {
  completeWorkflowNode,
  createWorkflowRun,
  failWorkflowNode,
  maybeFinalizeWorkflow,
  normalizeWorkflowDefinition,
  prepareWorkflowNodeRetry,
  readyWorkflowNodes,
  resolveInstanceKey,
  startWorkflowNode,
} from "./rp-workflows.mjs";
import { normalizeRuntimePolicy, resolveNodeProfiles } from "./rp-model-config.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function modelLimit(models, modelId) {
  if (modelId === "pi:current") return 10;
  return models.get(modelId)?.maxConcurrency || 10;
}

export class RpWorkflowEngine {
  constructor({ executor, resolveAgent, resolveModel, policy = {}, onChange = async () => {}, onNodeComplete = async () => null, nodeHistory = () => null }) {
    if (typeof executor !== "function") throw new Error("RpWorkflowEngine requires an executor.");
    this.executor = executor;
    this.resolveAgent = resolveAgent || (() => null);
    this.resolveModel = resolveModel || (() => null);
    this.policy = normalizeRuntimePolicy(policy);
    this.onChange = onChange;
    this.onNodeComplete = onNodeComplete;
    this.nodeHistory = nodeHistory;
    this.runs = new Map();
    this.instances = new Map();
    this.running = 0;
    this.runningGlobalBackground = 0;
    this.runningByModel = new Map();
    this.waiters = [];
  }

  snapshot() {
    return [...this.runs.values()].map(entry => structuredClone(entry.run));
  }

  pruneRuns(predicate) {
    for (const [runId, entry] of this.runs) {
      if (!predicate(entry.run)) continue;
      entry.stopped = true;
      this.runs.delete(runId);
      if (this.instances.get(entry.key) === entry) this.instances.delete(entry.key);
    }
  }

  async start(definition, options = {}) {
    const workflow = normalizeWorkflowDefinition(definition);
    const key = resolveInstanceKey(workflow, options.payload);
    const activeForKey = this.instances.get(key);
    if (activeForKey && !["completed", "failed", "cancelled"].includes(activeForKey.run.status)) {
      throw new Error(`Workflow instance is already active: ${key}`);
    }
    const sameWorkflow = [...this.runs.values()].filter(entry => entry.workflow.id === workflow.id && !["completed", "failed", "cancelled"].includes(entry.run.status));
    if (sameWorkflow.length >= workflow.instancePolicy.maxConcurrentInstances) throw new Error(`Workflow ${workflow.id} reached its instance limit.`);
    const entry = {
      workflow,
      run: createWorkflowRun(workflow, options),
      key,
      modelOverrides: {},
      exhaustionOverrides: new Set(),
      wake: deferred(),
      stopped: false,
    };
    this.runs.set(entry.run.id, entry);
    this.instances.set(key, entry);
    await this.onChange(entry.run, workflow);
    queueMicrotask(() => { void this.#pump(entry); });
    return structuredClone(entry.run);
  }

  async restore(definition, savedRun) {
    const workflow = normalizeWorkflowDefinition(definition);
    const run = structuredClone(savedRun);
    if (run.workflowId !== workflow.id) throw new Error("Restored run does not match its workflow definition.");
    for (const node of workflow.nodes) {
      if (!run.nodes?.[node.id]) throw new Error(`Restored run is missing node ${node.id}.`);
      if (run.nodes[node.id].status === "running") {
        run.nodes[node.id].status = "awaiting-model-choice";
        run.nodes[node.id].error = "interrupted_by_runtime_restart";
        const attempt = run.nodes[node.id].attempts?.at(-1);
        if (attempt?.status === "running") {
          attempt.status = "failed";
          attempt.error = "interrupted_by_runtime_restart";
          attempt.completedAt = new Date().toISOString();
        }
      }
    }
    if (Object.values(run.nodes).some(state => state.status === "awaiting-model-choice")) run.status = "awaiting-model-choice";
    const entry = { workflow, run, key: `${workflow.id}:restored:${run.id}`, modelOverrides: {}, exhaustionOverrides: new Set(), wake: deferred(), stopped: false };
    this.runs.set(run.id, entry);
    this.instances.set(entry.key, entry);
    await this.onChange(entry.run, workflow);
    if (entry.run.status === "running") queueMicrotask(() => { void this.#pump(entry); });
    return structuredClone(entry.run);
  }

  async wait(runId) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    while (!["completed", "failed", "cancelled", "awaiting-model-choice"].includes(entry.run.status)) {
      const current = entry.wake;
      await current.promise;
    }
    return structuredClone(entry.run);
  }

  async retry(runId, nodeId, modelId, { saveOverride = false } = {}) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    if (typeof modelId === "string" && modelId.trim()) entry.modelOverrides[nodeId] = modelId.trim();
    entry.exhaustionOverrides.add(nodeId);
    prepareWorkflowNodeRetry(entry.run, nodeId);
    if (saveOverride) {
      const node = entry.workflow.nodes.find(item => item.id === nodeId);
      node.modelId = modelId;
    }
    await this.onChange(entry.run, entry.workflow);
    queueMicrotask(() => { void this.#pump(entry); });
    return structuredClone(entry.run);
  }

  async cancel(runId, reason) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    entry.stopped = true;
    for (const state of Object.values(entry.run.nodes)) {
      if (!["completed", "skipped", "failed", "cancelled"].includes(state.status)) state.status = "cancelled";
    }
    entry.run.status = "cancelled";
    entry.run.completedAt = new Date().toISOString();
    entry.run.error = reason || "cancelled_by_user";
    await this.#changed(entry);
    for (const wake of this.waiters.splice(0)) wake();
    return structuredClone(entry.run);
  }

  async #pump(entry) {
    if (entry.pumping || entry.stopped) return;
    entry.pumping = true;
    try {
      while (!entry.stopped && entry.run.status === "running") {
        const ready = readyWorkflowNodes(entry.workflow, entry.run).filter(node => !this.#coolingDown(entry, node));
        if (!ready.length) {
          maybeFinalizeWorkflow(entry.workflow, entry.run);
          await this.#changed(entry);
          break;
        }
        await Promise.all(ready.map(node => this.#executeWhenAvailable(entry, node)));
      }
    } finally {
      entry.pumping = false;
    }
  }

  #coolingDown(entry, node) {
    if (!node.cooldownTurns || !Number.isSafeInteger(entry.run.turn)) return false;
    const last = this.nodeHistory(entry.workflow.id, node.id);
    if (!Number.isSafeInteger(last) || entry.run.turn - last >= node.cooldownTurns) return false;
    const state = entry.run.nodes[node.id];
    state.status = "skipped";
    state.error = `cooldown_until_turn_${last + node.cooldownTurns}`;
    state.completedAt = new Date().toISOString();
    return true;
  }

  async #executeWhenAvailable(entry, node) {
    const agent = node.agentId || entry.workflow.defaults.agentId ? await this.resolveAgent(node.agentId || entry.workflow.defaults.agentId) : null;
    const binding = resolveNodeProfiles({ node: { ...node, modelId: entry.modelOverrides[node.id] || node.modelId }, workflow: entry.workflow, agent });
    const model = binding.modelId === "pi:current" ? null : await this.resolveModel(binding.modelId);
    await this.#acquire(entry.workflow.kind, binding.modelId, model);
    try {
      if (entry.stopped || entry.run.status === "cancelled") return;
      startWorkflowNode(entry.workflow, entry.run, node.id, {
        agentId: binding.agentId,
        modelId: binding.modelId,
        resolvedModel: model ? { provider: model.provider, model: model.model } : null,
        allowAfterExhaustion: entry.exhaustionOverrides.delete(node.id),
      });
      await this.#changed(entry);
      try {
        const result = await this.executor({ workflow: entry.workflow, run: entry.run, node, agent, model, binding });
        if (entry.stopped || entry.run.status === "cancelled") return;
        completeWorkflowNode(entry.workflow, entry.run, node.id, result || {});
        try {
          entry.run.nodes[node.id].processRecord = await this.onNodeComplete({
            workflow: entry.workflow,
            run: entry.run,
            node,
            agent,
            binding,
            result: result || {},
          });
        } catch (error) {
          entry.run.nodes[node.id].processRecord = {
            available: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } catch (error) {
        if (entry.stopped || entry.run.status === "cancelled") return;
        const state = failWorkflowNode(entry.workflow, entry.run, node.id, error);
        if (state.status === "awaiting-retry") prepareWorkflowNodeRetry(entry.run, node.id);
        else if (state.status === "awaiting-model-choice" && this.policy.modelFailure.silentFallback) {
          const fallback = this.policy.modelFailure.defaultFallbackModelId;
          if (fallback && fallback !== binding.modelId) {
            entry.modelOverrides[node.id] = fallback;
            entry.exhaustionOverrides.add(node.id);
            prepareWorkflowNodeRetry(entry.run, node.id);
          }
        }
      }
      await this.#changed(entry);
    } finally {
      this.#release(entry.workflow.kind, binding.modelId);
    }
  }

  async #acquire(kind, modelId, model) {
    const canRun = () => {
      const globalRoom = this.running < this.policy.maxConcurrency;
      const reservedRoom = kind !== "global-background" || this.runningGlobalBackground < Math.max(0, this.policy.maxConcurrency - 1);
      const modelRoom = (this.runningByModel.get(modelId) || 0) < modelLimit(new Map(model ? [[modelId, model]] : []), modelId);
      return globalRoom && reservedRoom && modelRoom;
    };
    while (!canRun()) {
      const waiter = deferred();
      this.waiters.push(waiter.resolve);
      await waiter.promise;
    }
    this.running += 1;
    if (kind === "global-background") this.runningGlobalBackground += 1;
    this.runningByModel.set(modelId, (this.runningByModel.get(modelId) || 0) + 1);
  }

  #release(kind, modelId) {
    this.running -= 1;
    if (kind === "global-background") this.runningGlobalBackground -= 1;
    this.runningByModel.set(modelId, Math.max(0, (this.runningByModel.get(modelId) || 1) - 1));
    for (const wake of this.waiters.splice(0)) wake();
  }

  async #changed(entry) {
    await this.onChange(entry.run, entry.workflow);
    entry.wake.resolve();
    entry.wake = deferred();
  }
}
