import { randomUUID } from "node:crypto";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TERMINAL = new Set(["completed", "skipped", "failed", "cancelled"]);
const WORKFLOW_KINDS = new Set(["foreground", "turn-background", "global-background"]);
const NODE_TYPES = new Set(["agent", "code", "narrative", "gate", "join", "module-output", "variable-update", "turn-finalize"]);
const CONTEXT_MODES = new Set(["fixed", "previous-output", "inherit", "custom"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must be a filesystem-safe ID.`);
  return value;
}

function uniqueIds(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map((item, index) => assertId(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate IDs.`);
  return result;
}

function normalizeContext(value) {
  const context = value === undefined ? {} : assertObject(value, "node.context");
  const mode = typeof context.mode === "string" ? context.mode : "fixed";
  if (!CONTEXT_MODES.has(mode)) throw new Error(`Unsupported node context mode: ${mode}`);
  return {
    mode,
    fromNodes: uniqueIds(context.fromNodes, "node.context.fromNodes"),
    profileId: context.profileId === undefined || context.profileId === null
      ? null
      : assertId(context.profileId, "node.context.profileId"),
    processor: context.processor === undefined || context.processor === null
      ? null
      : assertId(context.processor, "node.context.processor"),
  };
}

function normalizeConditions(value, knownNodes) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("node.conditions must be an array.");
  return value.map((entry, index) => {
    const condition = assertObject(entry, `node.conditions[${index}]`);
    const nodeId = assertId(condition.nodeId, `node.conditions[${index}].nodeId`);
    if (!knownNodes.has(nodeId)) throw new Error(`node.conditions references an unknown node: ${nodeId}`);
    const routes = condition.routes === undefined ? [] : uniqueIds(condition.routes, `node.conditions[${index}].routes`);
    const statuses = condition.statuses === undefined ? ["completed"] : condition.statuses;
    if (!Array.isArray(statuses) || statuses.some(status => !TERMINAL.has(status))) {
      throw new Error(`node.conditions[${index}].statuses contains an unsupported status.`);
    }
    return { nodeId, routes, statuses: [...new Set(statuses)] };
  });
}

function normalizeTrigger(value) {
  const trigger = value === undefined ? { type: "manual" } : assertObject(value, "workflow.trigger");
  const type = typeof trigger.type === "string" ? trigger.type : "manual";
  if (type === "manual") return { type };
  if (type === "after-workflow") return { type, workflowId: assertId(trigger.workflowId, "workflow.trigger.workflowId") };
  if (type === "node") return {
    type,
    workflowId: assertId(trigger.workflowId, "workflow.trigger.workflowId"),
    nodeId: assertId(trigger.nodeId, "workflow.trigger.nodeId"),
  };
  throw new Error(`Unsupported workflow trigger type: ${type}`);
}

function assertAcyclic(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Workflow contains a dependency cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of nodes) visit(node.id);
}

export function normalizeWorkflowDefinition(value) {
  const input = assertObject(value, "workflow");
  if (input.schemaVersion !== 1) throw new Error("workflow.schemaVersion must be 1.");
  const id = assertId(input.id, "workflow.id");
  const kind = typeof input.kind === "string" ? input.kind : "foreground";
  if (!WORKFLOW_KINDS.has(kind)) throw new Error(`Unsupported workflow kind: ${kind}`);
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new Error("workflow.nodes must contain at least one node.");

  const knownNodes = new Set();
  for (const rawNode of input.nodes) {
    const node = assertObject(rawNode, "workflow node");
    const nodeId = assertId(node.id, "node.id");
    if (knownNodes.has(nodeId)) throw new Error(`Duplicate workflow node ID: ${nodeId}`);
    knownNodes.add(nodeId);
  }

  const nodes = input.nodes.map(rawNode => {
    const type = typeof rawNode.type === "string" ? rawNode.type : "agent";
    if (!NODE_TYPES.has(type)) throw new Error(`Unsupported workflow node type: ${type}`);
    const dependsOn = uniqueIds(rawNode.dependsOn, `node ${rawNode.id}.dependsOn`);
    for (const dependency of dependsOn) {
      if (!knownNodes.has(dependency)) throw new Error(`Node ${rawNode.id} depends on unknown node ${dependency}.`);
      if (dependency === rawNode.id) throw new Error(`Node ${rawNode.id} cannot depend on itself.`);
    }
    const maxAttempts = Number.isSafeInteger(rawNode.retry?.maxAttempts) && rawNode.retry.maxAttempts > 0
      ? Math.min(rawNode.retry.maxAttempts, 20)
      : 3;
    const joinMode = ["all", "any", "first-success", "quorum", "collect"].includes(rawNode.join?.mode)
      ? rawNode.join.mode
      : "all";
    const quorum = Number.isSafeInteger(rawNode.join?.quorum) && rawNode.join.quorum > 0
      ? rawNode.join.quorum
      : 1;
    return {
      id: rawNode.id,
      title: typeof rawNode.title === "string" && rawNode.title.trim() ? rawNode.title.trim() : rawNode.id,
      description: typeof rawNode.description === "string" ? rawNode.description.trim() : "",
      type,
      agentId: typeof rawNode.agentId === "string" && rawNode.agentId.trim() ? rawNode.agentId.trim() : null,
      modelId: typeof rawNode.modelId === "string" && rawNode.modelId.trim() ? rawNode.modelId.trim() : null,
      prompt: typeof rawNode.prompt === "string" && rawNode.prompt.trim() ? rawNode.prompt.trim() : null,
      dependsOn,
      conditions: normalizeConditions(rawNode.conditions, knownNodes),
      context: normalizeContext(rawNode.context),
      retry: { maxAttempts },
      cooldownTurns: Number.isSafeInteger(rawNode.cooldownTurns) && rawNode.cooldownTurns > 0
        ? Math.min(rawNode.cooldownTurns, 100000)
        : 0,
      required: rawNode.required !== false,
      blockNextTurn: kind === "turn-background" ? rawNode.blockNextTurn !== false : false,
      join: { mode: joinMode, quorum },
      metadata: rawNode.metadata && typeof rawNode.metadata === "object" && !Array.isArray(rawNode.metadata) ? rawNode.metadata : {},
    };
  });
  assertAcyclic(nodes);

  const narrativeCount = nodes.filter(node => node.type === "narrative").length;
  const finalizeCount = nodes.filter(node => node.type === "turn-finalize").length;
  if (kind === "foreground" && narrativeCount !== 1) throw new Error("A foreground workflow must contain exactly one narrative node.");
  if (kind === "foreground" && finalizeCount === 0) throw new Error("A foreground workflow must contain a turn-finalize node.");
  if (kind !== "foreground" && narrativeCount > 0) throw new Error("Background workflows cannot contain narrative nodes.");
  if (kind === "foreground") {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const ancestors = node => {
      const result = new Set();
      const visit = id => {
        for (const dependency of byId.get(id).dependsOn) {
          if (result.has(dependency)) continue;
          result.add(dependency);
          visit(dependency);
        }
      };
      visit(node.id);
      return result;
    };
    const finalizerAncestors = nodes.filter(node => node.type === "turn-finalize").map(ancestors);
    const narrativeId = nodes.find(node => node.type === "narrative").id;
    if (!finalizerAncestors.some(ids => ids.has(narrativeId))) throw new Error("A turn-finalize node must run after the narrative node.");
    const uncommitted = nodes.filter(node => node.required && node.type !== "turn-finalize" && !finalizerAncestors.some(ids => ids.has(node.id)));
    if (uncommitted.length) throw new Error(`Required foreground nodes are not committed by a turn-finalize node: ${uncommitted.map(node => node.id).join(", ")}`);
  }

  const instanceMode = input.instancePolicy?.mode === "multiple" ? "multiple" : "single";
  const maxConcurrentInstances = Number.isSafeInteger(input.instancePolicy?.maxConcurrentInstances) && input.instancePolicy.maxConcurrentInstances > 0
    ? Math.min(input.instancePolicy.maxConcurrentInstances, 10)
    : 1;
  return {
    schemaVersion: 1,
    id,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : id,
    description: typeof input.description === "string" ? input.description.trim() : "",
    kind,
    revision: typeof input.revision === "string" && input.revision.trim() ? input.revision.trim() : "1",
    defaults: {
      agentId: typeof input.defaults?.agentId === "string" ? input.defaults.agentId : null,
      modelId: typeof input.defaults?.modelId === "string" ? input.defaults.modelId : null,
      context: normalizeContext(input.defaults?.context),
    },
    instancePolicy: {
      mode: instanceMode,
      maxConcurrentInstances: instanceMode === "single" ? 1 : maxConcurrentInstances,
      dedupeKey: typeof input.instancePolicy?.dedupeKey === "string" && input.instancePolicy.dedupeKey.trim()
        ? input.instancePolicy.dedupeKey.trim()
        : null,
    },
    trigger: normalizeTrigger(input.trigger),
    publication: input.publication && typeof input.publication === "object" && !Array.isArray(input.publication)
      ? {
          namespace: typeof input.publication.namespace === "string" && ID_PATTERN.test(input.publication.namespace) ? input.publication.namespace : id,
          nodeIds: uniqueIds(input.publication.nodeIds, "workflow.publication.nodeIds"),
          schema: input.publication.schema && typeof input.publication.schema === "object" ? input.publication.schema : null,
        }
      : null,
    nodes,
  };
}

export function createWorkflowRun(definition, options = {}) {
  const workflow = normalizeWorkflowDefinition(definition);
  const now = options.now || new Date().toISOString();
  return {
    schemaVersion: 1,
    id: options.id || `workflow-${randomUUID()}`,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    kind: workflow.kind,
    status: "running",
    cardId: options.cardId || null,
    chatId: options.chatId || null,
    turn: Number.isSafeInteger(options.turn) ? options.turn : null,
    visibleThroughTurn: Number.isSafeInteger(options.visibleThroughTurn) ? options.visibleThroughTurn : null,
    trigger: options.trigger || { type: "manual" },
    payload: options.payload && typeof options.payload === "object" ? structuredClone(options.payload) : {},
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, {
      id: node.id,
      status: "pending",
      attempts: [],
      route: null,
      output: null,
      context: null,
      error: null,
      startedAt: null,
      completedAt: null,
    }])),
  };
}

function dependenciesState(workflow, run, node) {
  const states = node.dependsOn.map(id => run.nodes[id]);
  const completed = states.filter(state => state.status === "completed").length;
  const terminal = states.filter(state => TERMINAL.has(state.status)).length;
  const successRequired = node.join.mode === "quorum" ? node.join.quorum : 1;
  if (node.dependsOn.length === 0) return { ready: true, impossible: false };
  if (node.join.mode === "any" || node.join.mode === "first-success") {
    return { ready: completed >= 1, impossible: terminal === states.length && completed === 0 };
  }
  if (node.join.mode === "quorum") {
    return { ready: completed >= successRequired, impossible: terminal === states.length && completed < successRequired };
  }
  if (node.join.mode === "collect") return { ready: terminal === states.length, impossible: false };
  return {
    ready: states.every(state => state.status === "completed" || state.status === "skipped"),
    impossible: terminal === states.length && states.some(state => state.status === "failed" || state.status === "cancelled"),
  };
}

function conditionsState(run, node) {
  for (const condition of node.conditions) {
    const source = run.nodes[condition.nodeId];
    if (!TERMINAL.has(source.status)) return { ready: false, impossible: false };
    if (!condition.statuses.includes(source.status)) return { ready: false, impossible: true };
    if (condition.routes.length && !condition.routes.includes(source.route)) return { ready: false, impossible: true };
  }
  return { ready: true, impossible: false };
}

export function settleUnreachableNodes(definition, run, now = new Date().toISOString()) {
  const workflow = normalizeWorkflowDefinition(definition);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      const state = run.nodes[node.id];
      if (state.status !== "pending") continue;
      const dependencies = dependenciesState(workflow, run, node);
      const conditions = conditionsState(run, node);
      if (dependencies.impossible || conditions.impossible) {
        state.status = "skipped";
        state.completedAt = now;
        state.error = dependencies.impossible ? "dependency_unavailable" : "condition_not_matched";
        changed = true;
      }
    }
  }
  run.updatedAt = now;
  return run;
}

export function readyWorkflowNodes(definition, run) {
  const workflow = normalizeWorkflowDefinition(definition);
  settleUnreachableNodes(workflow, run);
  return workflow.nodes.filter(node => {
    const state = run.nodes[node.id];
    if (state.status !== "pending") return false;
    return dependenciesState(workflow, run, node).ready && conditionsState(run, node).ready;
  });
}

export function startWorkflowNode(definition, run, nodeId, attempt, now = new Date().toISOString()) {
  const workflow = normalizeWorkflowDefinition(definition);
  const node = workflow.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error(`Unknown workflow node: ${nodeId}`);
  const state = run.nodes[nodeId];
  if (state.status !== "pending" && state.status !== "awaiting-retry") throw new Error(`Node ${nodeId} is not ready to start.`);
  if (state.attempts.length >= node.retry.maxAttempts && attempt.allowAfterExhaustion !== true) throw new Error(`Node ${nodeId} exhausted its retry attempts.`);
  state.status = "running";
  state.startedAt ||= now;
  state.attempts.push({
    attempt: state.attempts.length + 1,
    status: "running",
    agentId: attempt.agentId || null,
    modelId: attempt.modelId || "pi:current",
    resolvedModel: attempt.resolvedModel || null,
    startedAt: now,
    completedAt: null,
    error: null,
  });
  run.updatedAt = now;
  return state.attempts.at(-1);
}

export function completeWorkflowNode(definition, run, nodeId, result = {}, now = new Date().toISOString()) {
  normalizeWorkflowDefinition(definition);
  const state = run.nodes[nodeId];
  if (!state || state.status !== "running") throw new Error(`Node ${nodeId} is not running.`);
  const attempt = state.attempts.at(-1);
  attempt.status = "completed";
  attempt.completedAt = now;
  state.status = "completed";
  state.output = result.output ?? null;
  state.context = result.context ?? null;
  state.route = result.route ?? null;
  state.completedAt = now;
  state.error = null;
  run.updatedAt = now;
  return maybeFinalizeWorkflow(definition, run, now);
}

export function failWorkflowNode(definition, run, nodeId, error, options = {}, now = new Date().toISOString()) {
  const workflow = normalizeWorkflowDefinition(definition);
  const node = workflow.nodes.find(item => item.id === nodeId);
  const state = run.nodes[nodeId];
  if (!node || !state || state.status !== "running") throw new Error(`Node ${nodeId} is not running.`);
  const message = error instanceof Error ? error.message : String(error);
  const attempt = state.attempts.at(-1);
  attempt.status = "failed";
  attempt.error = message;
  attempt.completedAt = now;
  state.error = message;
  if (options.retryable !== false && state.attempts.length < node.retry.maxAttempts) state.status = "awaiting-retry";
  else if (options.awaitModelChoice !== false) state.status = "awaiting-model-choice";
  else state.status = "failed";
  run.status = state.status === "awaiting-model-choice" ? "awaiting-model-choice" : run.status;
  run.updatedAt = now;
  return state;
}

export function prepareWorkflowNodeRetry(run, nodeId, now = new Date().toISOString()) {
  const state = run.nodes[nodeId];
  if (!state || !["awaiting-retry", "awaiting-model-choice", "failed"].includes(state.status)) {
    throw new Error(`Node ${nodeId} cannot be retried.`);
  }
  state.status = "pending";
  state.error = null;
  run.status = "running";
  run.updatedAt = now;
  return state;
}

export function cancelWorkflowRun(run, reason = "cancelled_by_user", now = new Date().toISOString()) {
  for (const state of Object.values(run.nodes)) {
    if (!TERMINAL.has(state.status)) {
      state.status = "cancelled";
      state.error = reason;
      state.completedAt = now;
      const attempt = state.attempts.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "cancelled";
        attempt.error = reason;
        attempt.completedAt = now;
      }
    }
  }
  run.status = "cancelled";
  run.completedAt = now;
  run.updatedAt = now;
  return run;
}

export function maybeFinalizeWorkflow(definition, run, now = new Date().toISOString()) {
  const workflow = normalizeWorkflowDefinition(definition);
  settleUnreachableNodes(workflow, run, now);
  const states = Object.values(run.nodes);
  if (states.some(state => ["running", "pending", "awaiting-retry", "awaiting-model-choice"].includes(state.status))) return run;
  const requiredFailed = workflow.nodes.some(node => node.required && ["failed", "cancelled"].includes(run.nodes[node.id].status));
  run.status = requiredFailed ? "failed" : "completed";
  run.completedAt = now;
  run.updatedAt = now;
  return run;
}

export function resolveInstanceKey(definition, payload = {}) {
  const workflow = normalizeWorkflowDefinition(definition);
  if (workflow.instancePolicy.mode === "single") return workflow.id;
  const selector = workflow.instancePolicy.dedupeKey;
  if (!selector) return `${workflow.id}:${randomUUID()}`;
  const path = selector.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let value = payload;
  for (const segment of path) value = value?.[segment];
  return `${workflow.id}:${value === undefined || value === null ? randomUUID() : String(value)}`;
}

export function activeWorkflowNodeIds(run) {
  return Object.values(run.nodes).filter(state => state.status === "running").map(state => state.id);
}

export function workflowTriggerMatches(definition, event) {
  const workflow = normalizeWorkflowDefinition(definition);
  const trigger = workflow.trigger || { type: "manual" };
  if (trigger.type === "manual") return event?.type === "manual";
  if (trigger.type === "after-workflow") return event?.type === "after-workflow" && event.workflowId === trigger.workflowId;
  if (trigger.type === "node") {
    return event?.type === "node" && event.workflowId === trigger.workflowId && event.nodeId === trigger.nodeId;
  }
  return false;
}
