import {
  assertWorkflowCallAllowed,
  canonicalWorkflowRef,
  completeWorkflowNode,
  createWorkflowRun,
  failWorkflowNode,
  maybeFinalizeWorkflow,
  normalizeWorkflowCallRequest,
  normalizeWorkflowDefinition,
  workflowCallAuthorization,
  prepareWorkflowNodeRetry,
  readyWorkflowNodes,
  resolveInstanceKey,
  resolveWorkflowInstanceInput,
  requireWorkflowNodeRecovery,
  startWorkflowNode,
  workflowInvocationFingerprint,
  workflowRuntimeIdentity,
} from "./rp-workflows.mjs";
import { normalizeRuntimePolicy, resolveNodeProfiles } from "./rp-model-config.mjs";
import { mergeSourceReferences } from "./rp-narrative-source.mjs";

const TERMINAL_RUN_STATUSES = new Set(["completed", "skipped", "failed", "cancelled"]);
const TERMINAL_NODE_STATUSES = new Set(["completed", "skipped", "failed", "cancelled"]);

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
  constructor({ executor, resolveAgent, resolveModel, resolveWorkflow, policy = {}, onChange = async () => {}, beforeNodeComplete = async ({ result }) => result, onNodeComplete = async () => null, nodeHistory = () => null }) {
    if (typeof executor !== "function") throw new Error("RpWorkflowEngine requires an executor.");
    this.executor = executor;
    this.resolveAgent = resolveAgent || (() => null);
    this.resolveModel = resolveModel || (() => null);
    this.resolveWorkflow = resolveWorkflow || (() => null);
    this.policy = normalizeRuntimePolicy(policy);
    this.onChange = onChange;
    this.beforeNodeComplete = beforeNodeComplete;
    this.onNodeComplete = onNodeComplete;
    this.nodeHistory = nodeHistory;
    this.runs = new Map();
    this.instances = new Map();
    this.running = 0;
    this.runningGlobalBackground = 0;
    this.runningByModel = new Map();
    this.waiters = [];
    this.writeLocks = new Map();
    this.writeLockWaiters = [];
  }

  snapshot() {
    return [...this.runs.values()].map(entry => structuredClone(entry.run));
  }

  blockingTurnRuns() {
    const blocking = [];
    for (const entry of this.runs.values()) {
      if (entry.workflow.kind !== "turn-background" || TERMINAL_RUN_STATUSES.has(entry.run.status)) continue;
      if (entry.workflow.trigger?.blockNextTurnUntilReady !== true) continue;
      const nodes = entry.workflow.nodes.filter(node => !TERMINAL_NODE_STATUSES.has(entry.run.nodes[node.id]?.status));
      blocking.push({
        runId: entry.run.id,
        workflowId: entry.workflow.id,
        workflowTitle: entry.workflow.title,
        turn: entry.run.turn,
        status: entry.run.status,
        nodes: nodes.map(node => ({ id: node.id, title: node.title, status: entry.run.nodes[node.id]?.status || "pending" })),
      });
    }
    return structuredClone(blocking);
  }

  hasBlockingTurnRun() {
    return this.blockingTurnRuns().length > 0;
  }

  async addSourceReferences(runId, sourceReferences) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    const merged = mergeSourceReferences(entry.run.sourceReferences || [], sourceReferences || []);
    if (JSON.stringify(merged) === JSON.stringify(entry.run.sourceReferences || [])) return structuredClone(entry.run.sourceReferences || []);
    entry.run.sourceReferences = merged;
    entry.run.updatedAt = new Date().toISOString();
    await this.#changed(entry);
    return structuredClone(merged);
  }

  pruneRuns(predicate) {
    for (const [runId, entry] of this.runs) {
      if (!predicate(entry.run)) continue;
      entry.stopped = true;
      this.#releaseWriteLocks(entry);
      this.runs.delete(runId);
      if (this.instances.get(entry.key) === entry) this.instances.delete(entry.key);
    }
  }

  async start(definition, options = {}) {
    const workflow = normalizeWorkflowDefinition(definition);
    if (workflow.kind.startsWith("module-") && !options.callContext) throw new Error("Module workflows may start only through a parent workflow call.");
    if (!workflow.kind.startsWith("module-") && options.callContext) throw new Error("Top-level workflows cannot start as child calls.");
    const instanceInput = resolveWorkflowInstanceInput(workflow, options);
    const key = resolveInstanceKey(workflow, instanceInput, options.id);
    const invocationFingerprint = workflowInvocationFingerprint(instanceInput);
    const activeForKey = this.instances.get(key);
    if (activeForKey && !TERMINAL_RUN_STATUSES.has(activeForKey.run.status)) {
      if (options.reuseActive === true && activeForKey.run.invocationFingerprint === invocationFingerprint) return structuredClone(activeForKey.run);
      if (options.reuseActive === true) throw Object.assign(new Error(`Workflow instance ${key} was reused with different input.`), { code: "workflow_instance_conflict", status: 409 });
      throw new Error(`Workflow instance is already active: ${key}`);
    }
    const identity = workflowRuntimeIdentity(workflow);
    const sameWorkflow = [...this.runs.values()].filter(entry => entry.identity === identity && !TERMINAL_RUN_STATUSES.has(entry.run.status));
    if (sameWorkflow.length >= workflow.instancePolicy.maxConcurrentInstances) throw new Error(`Workflow ${workflow.id} reached its instance limit.`);
    const run = createWorkflowRun(workflow, { ...options, instanceKey: key, invocationFingerprint });
    const entry = {
      workflow,
      identity,
      run,
      key,
      modelOverrides: {},
      exhaustionOverrides: new Set(),
      wake: deferred(),
      stopped: false,
      locksHeld: false,
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
    run.sourceReferences = mergeSourceReferences(run.sourceReferences || []);
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
    const identity = workflowRuntimeIdentity(workflow);
    const instanceInput = resolveWorkflowInstanceInput(workflow, run);
    const expectedKey = resolveInstanceKey(workflow, instanceInput, run.id);
    const expectedFingerprint = workflowInvocationFingerprint(instanceInput);
    if (run.instanceKey && run.instanceKey !== expectedKey) throw new Error(`Restored workflow instance key does not match its persisted input: ${run.instanceKey}.`);
    if (run.invocationFingerprint && run.invocationFingerprint !== expectedFingerprint) throw new Error("Restored workflow invocation fingerprint does not match its persisted input.");
    const key = expectedKey;
    run.instanceKey = key;
    run.invocationFingerprint = expectedFingerprint;
    const activeForKey = this.instances.get(key);
    if (activeForKey && !TERMINAL_RUN_STATUSES.has(activeForKey.run.status)) throw new Error(`Workflow instance is already active: ${key}`);
    const sameWorkflow = [...this.runs.values()].filter(entry => entry.identity === identity && !TERMINAL_RUN_STATUSES.has(entry.run.status));
    if (sameWorkflow.length >= workflow.instancePolicy.maxConcurrentInstances) throw new Error(`Workflow ${workflow.id} reached its instance limit.`);
    const entry = { workflow, identity, run, key, modelOverrides: {}, exhaustionOverrides: new Set(), wake: deferred(), stopped: false, locksHeld: false };
    this.runs.set(run.id, entry);
    this.instances.set(entry.key, entry);
    if (!TERMINAL_RUN_STATUSES.has(entry.run.status)) await this.#acquireWriteLocks(entry);
    await this.onChange(entry.run, workflow);
    if (entry.run.status === "running") queueMicrotask(() => { void this.#pump(entry); });
    return structuredClone(entry.run);
  }

  async wait(runId) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    while (!TERMINAL_RUN_STATUSES.has(entry.run.status) && !["awaiting-model-choice", "awaiting-recovery"].includes(entry.run.status)) {
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

  async recover(runId, nodeId = null) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    const recoverable = Object.values(entry.run.nodes).filter(state => state.status === "awaiting-recovery" && (!nodeId || state.id === nodeId));
    if (!recoverable.length) throw new Error(`Workflow run ${runId} has no matching recovery-required node.`);
    for (const state of recoverable) {
      const children = [...this.runs.values()].filter(candidate => candidate.run.callContext?.parentRunId === runId && candidate.run.callContext?.parentNodeId === state.id && candidate.run.status === "awaiting-recovery");
      for (const child of children) await this.recover(child.run.id);
      entry.exhaustionOverrides.add(state.id);
      prepareWorkflowNodeRetry(entry.run, state.id);
    }
    await this.onChange(entry.run, entry.workflow);
    queueMicrotask(() => { void this.#pump(entry); });
    return structuredClone(entry.run);
  }

  async cancel(runId, reason) {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    entry.stopped = true;
    const childRuns = [...this.runs.values()].filter(candidate => candidate.run.callContext?.parentRunId === runId && !TERMINAL_RUN_STATUSES.has(candidate.run.status));
    for (const child of childRuns) await this.cancel(child.run.id, reason || "parent_cancelled");
    for (const state of Object.values(entry.run.nodes)) {
      if (!TERMINAL_NODE_STATUSES.has(state.status)) state.status = "cancelled";
    }
    entry.run.status = "cancelled";
    entry.run.completedAt = new Date().toISOString();
    entry.run.error = reason || "cancelled_by_user";
    this.#releaseWriteLocks(entry);
    await this.#changed(entry);
    for (const wake of this.waiters.splice(0)) wake();
    return structuredClone(entry.run);
  }

  async skip(runId, reason = "skipped_by_user") {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow run: ${runId}`);
    entry.stopped = true;
    const now = new Date().toISOString();
    for (const state of Object.values(entry.run.nodes)) {
      if (TERMINAL_NODE_STATUSES.has(state.status)) continue;
      const attempt = state.attempts?.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "cancelled";
        attempt.error = reason;
        attempt.completedAt = now;
      }
      state.status = "skipped";
      state.error = reason;
      state.completedAt = now;
    }
    entry.run.status = "skipped";
    entry.run.completedAt = now;
    entry.run.error = reason;
    this.#releaseWriteLocks(entry);
    await this.#changed(entry);
    for (const wake of this.waiters.splice(0)) wake();
    return structuredClone(entry.run);
  }

  async #pump(entry) {
    if (entry.pumping || entry.stopped) return;
    entry.pumping = true;
    try {
      if (!entry.locksHeld) await this.#acquireWriteLocks(entry);
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
      if (TERMINAL_RUN_STATUSES.has(entry.run.status)) this.#releaseWriteLocks(entry);
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
    let slotHeld = true;
    let callQueue = Promise.resolve();
    const workflowCallCounts = new Map();
    const invokeWorkflow = (request, options = {}) => {
      const reference = typeof request?.workflow === "string" ? request.workflow : node.target;
      const callBinding = node.workflowCalls?.find(item => item.target === reference);
      const callCount = workflowCallCounts.get(reference) || 0;
      if (callBinding?.maxCalls && callCount >= callBinding.maxCalls) throw new Error(`Workflow call limit exceeded for ${reference}.`);
      workflowCallCounts.set(reference, callCount + 1);
      const operation = callQueue.then(async () => {
        if (slotHeld) {
          this.#release(entry.workflow.kind, binding.modelId);
          slotHeld = false;
        }
        try {
          return await this.#invokeAndWait(entry, node, request, options);
        } finally {
          if (!slotHeld && !entry.stopped) {
            await this.#acquire(entry.workflow.kind, binding.modelId, model);
            slotHeld = true;
          }
        }
      });
      callQueue = operation.then(() => undefined, () => undefined);
      return operation;
    };
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
        let result = await this.executor({ workflow: entry.workflow, run: entry.run, node, agent, model, binding, invokeWorkflow });
        if (entry.stopped || entry.run.status === "cancelled") return;
        result = await this.beforeNodeComplete({ workflow: entry.workflow, run: entry.run, node, agent, binding, result: result || {} }) || result || {};
        if (entry.stopped || entry.run.status === "cancelled") return;
        const executionStatus = result?.executionStatus || result?.output?.executionStatus || "completed";
        if (["recovery-required", "partially-completed"].includes(executionStatus) && (result?.output?.recoveryRequired !== false)) {
          requireWorkflowNodeRecovery(entry.workflow, entry.run, node.id, { ...result, error: result?.output?.error || executionStatus });
        } else if (["failed", "partially-completed"].includes(executionStatus)) {
          failWorkflowNode(entry.workflow, entry.run, node.id, result?.output?.error || executionStatus, { retryable: false, awaitModelChoice: false, output: result?.output });
          maybeFinalizeWorkflow(entry.workflow, entry.run);
        } else {
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
        }
      } catch (error) {
        if (entry.stopped || entry.run.status === "cancelled") return;
        if (error?.code === "workflow_recovery_required") {
          requireWorkflowNodeRecovery(entry.workflow, entry.run, node.id, { error: error.message, output: error.output || null });
          await this.#changed(entry);
          return;
        }
        const deterministic = error?.code === "workflow_child_failed";
        const state = failWorkflowNode(entry.workflow, entry.run, node.id, error, deterministic ? { retryable: false, awaitModelChoice: false, output: error.output || null } : {});
        if (deterministic) maybeFinalizeWorkflow(entry.workflow, entry.run);
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
      if (slotHeld) this.#release(entry.workflow.kind, binding.modelId);
    }
  }

  async #invokeAndWait(parentEntry, parentNode, request, options = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Workflow call request must be an object.");
    const reference = typeof request.workflow === "string" ? request.workflow : parentNode.target;
    if (!reference) throw new Error("Workflow call request must name a target workflow.");
    const target = await this.resolveWorkflow(reference);
    if (!target) throw new Error(`Unknown module workflow: ${reference}`);
    const normalizedTarget = normalizeWorkflowDefinition(target);
    assertWorkflowCallAllowed(parentEntry.workflow, parentNode, normalizedTarget, { agent: options.agent === true });
    const normalizedRequest = normalizeWorkflowCallRequest(normalizedTarget, request, workflowCallAuthorization(parentNode, reference));
    const parentStack = Array.isArray(parentEntry.run.callContext?.stack) ? parentEntry.run.callContext.stack : [];
    const callerIdentity = parentEntry.workflow.kind.startsWith("module-")
      ? canonicalWorkflowRef(parentEntry.workflow)
      : `top-level/${parentEntry.workflow.id}`;
    const stack = parentStack.length ? [...parentStack] : [callerIdentity];
    const targetReference = canonicalWorkflowRef(normalizedTarget);
    if (stack.includes(targetReference)) throw new Error(`Workflow call cycle detected at ${targetReference}.`);
    if (stack.length >= 8) throw new Error("Workflow call depth exceeds the runtime limit of 8.");
    const invocationFingerprint = workflowInvocationFingerprint(normalizedRequest.arguments);
    const childInstanceKey = resolveInstanceKey(normalizedTarget, normalizedRequest.arguments);
    const completedChild = [...this.runs.values()].find(candidate => (normalizedTarget.instancePolicy.mode === "multiple"
      ? candidate.run.instanceKey === childInstanceKey
      : candidate.run.callContext?.parentRunId === parentEntry.run.id && candidate.run.callContext?.parentNodeId === parentNode.id)
      && candidate.run.status === "completed"
      && candidate.run.invocationFingerprint === invocationFingerprint
      && canonicalWorkflowRef(candidate.workflow) === targetReference);
    if (completedChild) {
      const returnNode = normalizedTarget.nodes.find(node => node.type === "workflow-return");
      return {
        callId: completedChild.run.id,
        workflow: targetReference,
        outputs: completedChild.run.nodes[returnNode.id]?.output?.outputs || completedChild.run.nodes[returnNode.id]?.output || {},
      };
    }
    if (normalizedTarget.kind === "module-internal" && normalizedTarget.instancePolicy.mode === "single") {
      const activeChild = this.instances.get(childInstanceKey);
      if (activeChild && !TERMINAL_RUN_STATUSES.has(activeChild.run.status)) {
        const prior = await this.wait(activeChild.run.id);
        if (prior.status !== "completed") throw Object.assign(new Error(`Prior module workflow ${targetReference} ended with status ${prior.status}.`), { code: "workflow_child_failed", childRunId: prior.id, output: prior });
        return this.#invokeAndWait(parentEntry, parentNode, request, options);
      }
    }
    const child = await this.start(normalizedTarget, {
      cardId: parentEntry.run.cardId,
      chatId: parentEntry.run.chatId,
      turn: parentEntry.run.turn,
      visibleThroughTurn: parentEntry.run.visibleThroughTurn,
      sourceReferences: parentEntry.run.sourceReferences || [],
      trigger: parentEntry.run.trigger && typeof parentEntry.run.trigger === "object"
        ? structuredClone(parentEntry.run.trigger)
        : { type: "unknown" },
      arguments: normalizedRequest.arguments,
      textInput: normalizedRequest.text,
      documents: normalizedRequest.documents,
      outputPaths: normalizedRequest.outputPaths,
      payload: {
        call: {
          ...normalizedRequest,
        },
      },
      callContext: {
        rootRunId: parentEntry.run.callContext?.rootRunId || parentEntry.run.id,
        parentRunId: parentEntry.run.id,
        parentNodeId: parentNode.id,
        parentWorkflowId: parentEntry.workflow.id,
        depth: stack.length,
        stack: [...stack, targetReference],
      },
      reuseActive: normalizedTarget.kind === "module-internal" && normalizedTarget.instancePolicy.mode === "multiple",
    });
    const completed = await this.wait(child.id);
    if (completed.status === "awaiting-recovery") throw Object.assign(new Error(`Module workflow ${targetReference} requires recovery.`), { code: "workflow_recovery_required", childRunId: completed.id, output: completed });
    if (completed.status !== "completed") throw Object.assign(new Error(`Module workflow ${targetReference} ended with status ${completed.status}.`), { code: "workflow_child_failed", childRunId: completed.id, output: completed });
    const returnNode = normalizedTarget.nodes.find(node => node.type === "workflow-return");
    return {
      callId: completed.id,
      workflow: targetReference,
      outputs: completed.nodes[returnNode.id]?.output?.outputs || completed.nodes[returnNode.id]?.output || {},
    };
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

  #locksConflict(left, right) {
    return left.moduleId === right.moduleId
      && (left.collectionId === null || right.collectionId === null || left.collectionId === right.collectionId);
  }

  async #acquireWriteLocks(entry) {
    const requested = entry.workflow.writeLocks || [];
    if (!requested.length || entry.locksHeld) {
      entry.locksHeld = true;
      return;
    }
    const available = () => requested.every(lock => [...this.writeLocks.entries()].every(([holder, held]) => holder === entry.run.id || held.every(item => !this.#locksConflict(lock, item))));
    while (!available()) {
      if (entry.stopped) return;
      const waiter = deferred();
      this.writeLockWaiters.push(waiter.resolve);
      await waiter.promise;
    }
    this.writeLocks.set(entry.run.id, structuredClone(requested));
    entry.locksHeld = true;
  }

  #releaseWriteLocks(entry) {
    if (!entry?.locksHeld) return;
    this.writeLocks.delete(entry.run.id);
    entry.locksHeld = false;
    for (const wake of this.writeLockWaiters.splice(0)) wake();
  }

  async #changed(entry) {
    await this.onChange(entry.run, entry.workflow);
    entry.wake.resolve();
    entry.wake = deferred();
  }
}
