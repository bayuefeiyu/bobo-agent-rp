import { createHash, randomUUID } from "node:crypto";
import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./rp-token-usage.mjs";
import { mergeSourceReferences, normalizeNarrativeSourceDeclaration, workflowNodeNarrativeSource } from "./rp-narrative-source.mjs";
import { normalizeTeamDefinition } from "./rp-team-config.mjs";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TERMINAL = new Set(["completed", "skipped", "failed", "cancelled"]);
const TOP_LEVEL_WORKFLOW_KINDS = new Set(["foreground", "turn-background", "global-background"]);
const MODULE_WORKFLOW_KINDS = new Set(["module-external", "module-internal"]);
const WORKFLOW_KINDS = new Set([...TOP_LEVEL_WORKFLOW_KINDS, ...MODULE_WORKFLOW_KINDS]);
const NODE_TYPES = new Set(["agent", "team", "code", "call", "gate", "join", "workflow-return", "turn-finalize"]);
const CONTEXT_MODES = new Set(["fixed", "previous-output", "inherit", "custom"]);
const OUTPUT_SCOPES = new Set(["node", "workflow", "turn", "session", "public"]);
const RETAIN_POLICIES = new Set(["node", "run", "turn", "session", "permanent"]);
const OUTPUT_KINDS = new Set(["file", "directory"]);
const RUNTIME_SERVICES = new Set(["random"]);
const PARAMETER_VALUE_TYPES = new Set(["any", "string", "number", "integer", "boolean", "object", "array", "string-array"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function workflowInvocationFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value ?? {}))).digest("hex");
}

export function assertDocumentWorkspaceAgentTools(node, agent) {
  if (node?.type !== "agent" || node?.metadata?.documentWorkspace !== true) return;
  if (!Array.isArray(agent?.tools) || !agent.tools.includes("read")) {
    throw new Error(`Agent ${agent?.id || node.agentId || "unknown"} must enable the read tool because node ${node.id || "unknown"} uses a document workspace.`);
  }
}

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

function assertWorkflowRef(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a module/workflow reference.`);
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error(`${label} must use module-id/workflow-id.`);
  return `${assertId(parts[0], `${label} module`)}/${assertId(parts[1], `${label} workflow`)}`;
}

function normalizeWorkflowCallBindings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map((item, index) => {
    if (typeof item === "string") return { target: assertWorkflowRef(item, `${label}[${index}]`), fixedArguments: {}, allowedArguments: null, maxCalls: null };
    const binding = assertObject(item, `${label}[${index}]`);
    const unknown = Object.keys(binding).filter(field => !["target", "fixedArguments", "allowedArguments", "maxCalls", "documentSnapshotInput"].includes(field));
    if (unknown.length) throw new Error(`${label}[${index}] contains unsupported fields: ${unknown.join(", ")}.`);
    const fixedArguments = binding.fixedArguments === undefined ? {} : structuredClone(assertObject(binding.fixedArguments, `${label}[${index}].fixedArguments`));
    const allowedArguments = binding.allowedArguments === undefined || binding.allowedArguments === null ? null : Object.fromEntries(Object.entries(assertObject(binding.allowedArguments, `${label}[${index}].allowedArguments`)).map(([key, allowed]) => {
      assertId(key, `${label}[${index}].allowedArguments key`);
      if (!Array.isArray(allowed) || !allowed.length || allowed.some(value => !["string", "number", "boolean"].includes(typeof value) && value !== null)) {
        throw new Error(`${label}[${index}].allowedArguments.${key} must be a non-empty array of scalar values.`);
      }
      return [key, structuredClone(allowed)];
    }));
    const overlap = Object.keys(fixedArguments).filter(key => allowedArguments && Object.hasOwn(allowedArguments, key));
    if (overlap.length) throw new Error(`${label}[${index}] cannot both fix and allow argument ${overlap.join(", ")}.`);
    const maxCalls = Number.isSafeInteger(binding.maxCalls) && binding.maxCalls > 0 ? Math.min(binding.maxCalls, 100) : null;
    const documentSnapshotInput = binding.documentSnapshotInput === undefined || binding.documentSnapshotInput === null ? null : assertId(binding.documentSnapshotInput, `${label}[${index}].documentSnapshotInput`);
    return { target: assertWorkflowRef(binding.target, `${label}[${index}].target`), fixedArguments, allowedArguments, maxCalls, documentSnapshotInput };
  });
  const targets = result.map(item => item.target);
  if (new Set(targets).size !== targets.length) throw new Error(`${label} must not contain duplicate workflow references.`);
  return result;
}

function normalizeWorkflowInterface(value, kind) {
  if (!MODULE_WORKFLOW_KINDS.has(kind)) {
    if (value !== undefined && value !== null) throw new Error("Only module workflows may declare interface.");
    return null;
  }
  const input = value === undefined ? {} : assertObject(value, "workflow.interface");
  const normalizeEntries = (entries, label, normalize) => {
    const object = entries === undefined ? {} : assertObject(entries, label);
    return Object.fromEntries(Object.entries(object).map(([id, raw]) => {
      assertId(id, `${label} key`);
      return [id, normalize(assertObject(raw, `${label}.${id}`), id)];
    }));
  };
  const inputs = normalizeEntries(input.inputs, "workflow.interface.inputs", raw => {
    const type = raw.type || "parameter";
    if (!["text", "parameter", "document"].includes(type)) throw new Error(`Unsupported module workflow input type: ${type}`);
    const formats = raw.formats === undefined ? [] : uniqueIds(raw.formats, "workflow input formats");
    const kind = type === "document" ? raw.kind || "file" : null;
    if (type === "document" && !["file", "directory", "either"].includes(kind)) throw new Error(`Unsupported module workflow document input kind: ${kind}`);
    if (type !== "document" && raw.kind !== undefined) throw new Error(`Only document inputs may declare kind.`);
    const valueType = type === "parameter" ? raw.valueType || "any" : null;
    if (valueType && !PARAMETER_VALUE_TYPES.has(valueType)) throw new Error(`Unsupported module workflow parameter valueType: ${valueType}`);
    return {
      type,
      required: raw.required === true,
      valueType,
      formats,
      ...(type === "document" ? { kind } : {}),
      description: typeof raw.description === "string" ? raw.description.trim() : "",
    };
  });
  const exports = normalizeEntries(input.exports, "workflow.interface.exports", (raw, id) => {
    const format = typeof raw.format === "string" && raw.format.trim() ? raw.format.trim() : "markdown";
    const kind = raw.kind || (format === "document-set" ? "directory" : "file");
    if (!OUTPUT_KINDS.has(kind)) throw new Error(`workflow.interface.exports.${id}.kind is unsupported.`);
    if (format === "document-set" && kind !== "directory") throw new Error(`workflow.interface.exports.${id} document-set must use directory kind.`);
    return {
      format,
      kind,
      description: typeof raw.description === "string" ? raw.description.trim() : "",
    };
  });
  return { inputs, exports };
}

function normalizePathMap(value, label) {
  if (value === undefined) return {};
  const input = assertObject(value, label);
  return Object.fromEntries(Object.entries(input).map(([id, path]) => [assertId(id, `${label} key`), safeRelativePath(path, `${label}.${id}`)]));
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

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return value.replaceAll("\\", "/");
}

function normalizeOutputs(value, nodeId) {
  if (value === undefined) return {};
  const input = assertObject(value, `node ${nodeId}.outputs`);
  return Object.fromEntries(Object.entries(input).map(([id, raw]) => {
    assertId(id, `node ${nodeId}.outputs key`);
    const output = assertObject(raw, `node ${nodeId}.outputs.${id}`);
    const scope = output.scope || "node";
    const retain = output.retain || (scope === "node" ? "node" : scope === "workflow" ? "run" : scope === "turn" ? "turn" : "session");
    const format = typeof output.format === "string" ? output.format : null;
    const kind = output.kind || (format === "document-set" ? "directory" : "file");
    if (!OUTPUT_SCOPES.has(scope)) throw new Error(`node ${nodeId}.outputs.${id}.scope is unsupported.`);
    if (!RETAIN_POLICIES.has(retain)) throw new Error(`node ${nodeId}.outputs.${id}.retain is unsupported.`);
    if (!OUTPUT_KINDS.has(kind)) throw new Error(`node ${nodeId}.outputs.${id}.kind is unsupported.`);
    if (format === "document-set" && kind !== "directory") throw new Error(`node ${nodeId}.outputs.${id} document-set must use directory kind.`);
    return [id, { path: safeRelativePath(output.path, `node ${nodeId}.outputs.${id}.path`), scope, retain, format, kind }];
  }));
}

function normalizeWorkspaceHandoff(value, outputs, nodeId) {
  if (value === undefined) return { include: [] };
  const handoff = assertObject(value, `node ${nodeId}.workspaceHandoff`);
  const unknown = Object.keys(handoff).filter(field => field !== "include");
  if (unknown.length) throw new Error(`node ${nodeId}.workspaceHandoff contains unsupported fields: ${unknown.join(", ")}.`);
  if (!Array.isArray(handoff.include)) throw new Error(`node ${nodeId}.workspaceHandoff.include must be an array.`);
  const outputIds = new Set();
  const targetPaths = [];
  const include = handoff.include.map((raw, index) => {
    const entry = assertObject(raw, `node ${nodeId}.workspaceHandoff.include[${index}]`);
    const entryUnknown = Object.keys(entry).filter(field => !["output", "as"].includes(field));
    if (entryUnknown.length) throw new Error(`node ${nodeId}.workspaceHandoff.include[${index}] contains unsupported fields: ${entryUnknown.join(", ")}.`);
    const output = assertId(entry.output, `node ${nodeId}.workspaceHandoff.include[${index}].output`);
    const definition = outputs[output];
    if (!definition) throw new Error(`node ${nodeId}.workspaceHandoff references unknown output ${output}.`);
    if (definition.scope === "node" || definition.retain === "node") {
      throw new Error(`node ${nodeId}.workspaceHandoff output ${output} must survive the producing node; use workflow or broader scope and run or longer retention.`);
    }
    if (outputIds.has(output)) throw new Error(`node ${nodeId}.workspaceHandoff duplicates output ${output}.`);
    outputIds.add(output);
    const hasAlias = entry.as !== undefined;
    const target = hasAlias
      ? safeRelativePath(entry.as, `node ${nodeId}.workspaceHandoff.include[${index}].as`)
      : definition.path;
    if (target === "." || target.split("/").includes(".")) throw new Error(`node ${nodeId}.workspaceHandoff.include[${index}] target must not contain dot path segments.`);
    if (targetPaths.some(existing => existing === target || existing.startsWith(`${target}/`) || target.startsWith(`${existing}/`))) {
      throw new Error(`node ${nodeId}.workspaceHandoff target paths must not overlap: ${target}.`);
    }
    targetPaths.push(target);
    return hasAlias ? { output, as: target } : { output };
  });
  return { include };
}

function normalizeModuleAccess(value, nodeId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`node ${nodeId}.moduleAccess must be an array.`);
  const seen = new Set();
  return value.map((raw, index) => {
    const access = assertObject(raw, `node ${nodeId}.moduleAccess[${index}]`);
    const moduleId = assertId(access.moduleId, `node ${nodeId}.moduleAccess[${index}].moduleId`);
    const collectionId = assertId(access.collectionId, `node ${nodeId}.moduleAccess[${index}].collectionId`);
    const key = `${moduleId}/${collectionId}`;
    if (seen.has(key)) throw new Error(`node ${nodeId}.moduleAccess duplicates ${key}.`);
    seen.add(key);
    const queryBudget = access.queryBudget === undefined ? null : assertObject(access.queryBudget, `node ${nodeId}.moduleAccess[${index}].queryBudget`);
    const unknownBudgetFields = queryBudget ? Object.keys(queryBudget).filter(field => !["maxRecords", "maxCharacters", "defaultRecords", "defaultCharacters", "parameter"].includes(field)) : [];
    if (unknownBudgetFields.length) throw new Error(`node ${nodeId}.moduleAccess[${index}].queryBudget contains unsupported fields: ${unknownBudgetFields.join(", ")}.`);
    return {
      moduleId,
      collectionId,
      capabilities: uniqueIds(access.capabilities, `node ${nodeId}.moduleAccess[${index}].capabilities`),
      views: uniqueIds(access.views, `node ${nodeId}.moduleAccess[${index}].views`),
      queryBudget: queryBudget ? {
        maxRecords: Number.isSafeInteger(queryBudget.maxRecords) && queryBudget.maxRecords > 0 ? queryBudget.maxRecords : 20,
        maxCharacters: Number.isSafeInteger(queryBudget.maxCharacters) && queryBudget.maxCharacters > 0 ? queryBudget.maxCharacters : 6000,
        defaultRecords: Number.isSafeInteger(queryBudget.defaultRecords) && queryBudget.defaultRecords > 0
          ? Math.min(queryBudget.defaultRecords, Number.isSafeInteger(queryBudget.maxRecords) ? queryBudget.maxRecords : 20)
          : null,
        defaultCharacters: Number.isSafeInteger(queryBudget.defaultCharacters) && queryBudget.defaultCharacters > 0
          ? Math.min(queryBudget.defaultCharacters, Number.isSafeInteger(queryBudget.maxCharacters) ? queryBudget.maxCharacters : 6000)
          : null,
        parameter: queryBudget.parameter === undefined || queryBudget.parameter === null
          ? null
          : assertId(queryBudget.parameter, `node ${nodeId}.moduleAccess[${index}].queryBudget.parameter`),
      } : null,
    };
  });
}

function normalizeWriteLocks(value, kind, ownerModuleId) {
  if (value === undefined) return kind === "module-internal" ? [{ moduleId: ownerModuleId, collectionId: null }] : [];
  if (!Array.isArray(value)) throw new Error("workflow.writeLocks must be an array.");
  if (kind === "module-external" && value.length) throw new Error("module-external workflows cannot declare write locks.");
  if (kind === "module-internal" && value.length === 0) throw new Error("module-internal workflows must keep the default whole-module lock or declare at least one collection lock.");
  const seen = new Set();
  return value.map((raw, index) => {
    const lock = assertObject(raw, `workflow.writeLocks[${index}]`);
    const unknown = Object.keys(lock).filter(field => !["moduleId", "collectionId"].includes(field));
    if (unknown.length) throw new Error(`workflow.writeLocks[${index}] contains unsupported fields: ${unknown.join(", ")}.`);
    const moduleId = assertId(lock.moduleId, `workflow.writeLocks[${index}].moduleId`);
    const collectionId = lock.collectionId === undefined || lock.collectionId === null ? null : assertId(lock.collectionId, `workflow.writeLocks[${index}].collectionId`);
    if (kind === "module-internal" && moduleId !== ownerModuleId) throw new Error("A module-internal workflow may lock only its owner module.");
    const key = `${moduleId}/${collectionId || "*"}`;
    if (seen.has(key)) throw new Error(`workflow.writeLocks contains duplicate lock ${key}.`);
    seen.add(key);
    return { moduleId, collectionId };
  });
}

export function resolveNodeQueryBudget(access, payload = {}) {
  const authored = access?.queryBudget;
  if (!authored) return { maxRecords: 20, maxCharacters: 6000 };
  const requested = authored.parameter && payload?.[authored.parameter] && typeof payload[authored.parameter] === "object" ? payload[authored.parameter] : null;
  const records = Number.isSafeInteger(requested?.maxRecords) && requested.maxRecords > 0 ? requested.maxRecords : authored.defaultRecords || authored.maxRecords;
  const characters = Number.isSafeInteger(requested?.maxCharacters) && requested.maxCharacters > 0 ? requested.maxCharacters : authored.defaultCharacters || authored.maxCharacters;
  return { maxRecords: Math.min(authored.maxRecords, records), maxCharacters: Math.min(authored.maxCharacters, characters) };
}

function normalizeDataCommit(value, outputs, nodeId) {
  if (value === undefined) return { allowBestEffort: false, onNodeEnd: [] };
  const input = assertObject(value, `node ${nodeId}.dataCommit`);
  if (!Array.isArray(input.onNodeEnd)) throw new Error(`node ${nodeId}.dataCommit.onNodeEnd must be an array.`);
  return {
    allowBestEffort: input.allowBestEffort === true,
    onNodeEnd: input.onNodeEnd.map((raw, index) => {
      const target = assertObject(raw, `node ${nodeId}.dataCommit.onNodeEnd[${index}]`);
      const hasOutput = target.output !== undefined;
      const hasPath = target.path !== undefined;
      if (hasOutput === hasPath) throw new Error(`node ${nodeId}.dataCommit.onNodeEnd[${index}] must declare exactly one of output or path.`);
      if (hasOutput) {
        const output = assertId(target.output, `node ${nodeId}.dataCommit.onNodeEnd[${index}].output`);
        if (!outputs[output]) throw new Error(`node ${nodeId}.dataCommit references unknown output ${output}.`);
        return { output, path: null, required: target.required !== false };
      }
      return { output: null, path: safeRelativePath(target.path, `node ${nodeId}.dataCommit.onNodeEnd[${index}].path`), required: target.required !== false };
    }),
  };
}

function normalizeTrigger(value, kind) {
  if (MODULE_WORKFLOW_KINDS.has(kind)) {
    if (value !== undefined && value !== null) throw new Error("Module workflows cannot declare triggers.");
    return null;
  }
  const trigger = value === undefined ? { type: "manual" } : assertObject(value, "workflow.trigger");
  const type = typeof trigger.type === "string" ? trigger.type : "manual";
  const blockNextTurnUntilReady = trigger.blockNextTurnUntilReady === true;
  if (blockNextTurnUntilReady && kind !== "turn-background") throw new Error("blockNextTurnUntilReady is supported only for turn-background trigger bindings.");
  const documents = trigger.documents === undefined ? {} : Object.fromEntries(Object.entries(assertObject(trigger.documents, "workflow.trigger.documents")).map(([inputId, raw]) => {
    assertId(inputId, "workflow.trigger.documents key");
    const source = assertObject(raw, `workflow.trigger.documents.${inputId}`);
    const unknown = Object.keys(source).filter(field => !["fromNode", "output"].includes(field));
    if (unknown.length) throw new Error(`workflow.trigger.documents.${inputId} contains unsupported fields: ${unknown.join(", ")}.`);
    return [inputId, { fromNode: assertId(source.fromNode, `workflow.trigger.documents.${inputId}.fromNode`), output: assertId(source.output, `workflow.trigger.documents.${inputId}.output`) }];
  }));
  if ((type === "manual" || type === "after-opening") && Object.keys(documents).length) throw new Error(`${type} triggers cannot map source workflow documents.`);
  if (type === "manual" || type === "after-opening") return { type, blockNextTurnUntilReady, documents: {} };
  if (type === "after-workflow") return { type, workflowId: assertId(trigger.workflowId, "workflow.trigger.workflowId"), blockNextTurnUntilReady, documents };
  if (type === "node") return {
    type,
    workflowId: assertId(trigger.workflowId, "workflow.trigger.workflowId"),
    nodeId: assertId(trigger.nodeId, "workflow.trigger.nodeId"),
    blockNextTurnUntilReady,
    documents,
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
  if (input.schemaVersion !== 3) throw new Error("workflow.schemaVersion must be 3.");
  const id = assertId(input.id, "workflow.id");
  const kind = typeof input.kind === "string" ? input.kind : "foreground";
  if (!WORKFLOW_KINDS.has(kind)) throw new Error(`Unsupported workflow kind: ${kind}`);
  const ownerModuleId = MODULE_WORKFLOW_KINDS.has(kind)
    ? assertId(input.ownerModuleId, "workflow.ownerModuleId")
    : null;
  if (!MODULE_WORKFLOW_KINDS.has(kind) && input.ownerModuleId !== undefined && input.ownerModuleId !== null) throw new Error("Top-level workflows cannot declare ownerModuleId.");
  if (!MODULE_WORKFLOW_KINDS.has(kind) && input.agentCallable !== undefined && input.agentCallable !== false) throw new Error("Only module workflows may declare agentCallable.");
  const agentCallable = MODULE_WORKFLOW_KINDS.has(kind) && input.agentCallable === true;
  const workflowInterface = normalizeWorkflowInterface(input.interface, kind);
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
    const outputs = normalizeOutputs(rawNode.outputs, rawNode.id);
    const workspaceHandoff = normalizeWorkspaceHandoff(rawNode.workspaceHandoff, outputs, rawNode.id);
    const routeFromOutput = rawNode.routeFromOutput === undefined || rawNode.routeFromOutput === null
      ? null
      : assertId(rawNode.routeFromOutput, `node ${rawNode.id}.routeFromOutput`);
    if (routeFromOutput && type !== "code") throw new Error(`node ${rawNode.id}.routeFromOutput is supported only for code nodes.`);
    if (rawNode.blockNextTurn !== undefined) throw new Error(`node ${rawNode.id}.blockNextTurn was replaced by trigger.blockNextTurnUntilReady.`);
    const workflowCalls = normalizeWorkflowCallBindings(rawNode.workflowCalls, `node ${rawNode.id}.workflowCalls`);
    if (workflowCalls.length && !["agent", "team", "code"].includes(type)) throw new Error(`node ${rawNode.id}.workflowCalls is supported only for agent, team, and code nodes.`);
    const runtimeServices = uniqueIds(rawNode.runtimeServices, `node ${rawNode.id}.runtimeServices`);
    if (runtimeServices.length && type !== "code") throw new Error(`node ${rawNode.id}.runtimeServices is supported only for code nodes.`);
    const unsupportedServices = runtimeServices.filter(service => !RUNTIME_SERVICES.has(service));
    if (unsupportedServices.length) throw new Error(`node ${rawNode.id}.runtimeServices contains unsupported services: ${unsupportedServices.join(", ")}.`);
    const target = rawNode.target === undefined || rawNode.target === null ? null : assertWorkflowRef(rawNode.target, `node ${rawNode.id}.target`);
    if ((type === "call") !== Boolean(target)) throw new Error(`node ${rawNode.id} must declare target exactly when type is call.`);
    const callArguments = rawNode.arguments === undefined ? {} : structuredClone(assertObject(rawNode.arguments, `node ${rawNode.id}.arguments`));
    const callDocuments = normalizePathMap(rawNode.documents, `node ${rawNode.id}.documents`);
    const callOutputPaths = normalizePathMap(rawNode.outputPaths, `node ${rawNode.id}.outputPaths`);
    if (type !== "call" && ((rawNode.arguments && Object.keys(rawNode.arguments).length) || (rawNode.documents && Object.keys(rawNode.documents).length) || (rawNode.outputPaths && Object.keys(rawNode.outputPaths).length))) {
      throw new Error(`node ${rawNode.id} call fields are supported only for call nodes.`);
    }
    const returnExports = rawNode.exports === undefined ? {} : Object.fromEntries(Object.entries(assertObject(rawNode.exports, `node ${rawNode.id}.exports`)).map(([exportId, raw]) => {
      assertId(exportId, `node ${rawNode.id}.exports key`);
      const source = assertObject(raw, `node ${rawNode.id}.exports.${exportId}`);
      return [exportId, {
        fromNode: assertId(source.fromNode, `node ${rawNode.id}.exports.${exportId}.fromNode`),
        output: source.output === undefined || source.output === null ? null : assertId(source.output, `node ${rawNode.id}.exports.${exportId}.output`),
      }];
    }));
    if (type !== "workflow-return" && rawNode.exports && Object.keys(rawNode.exports).length) throw new Error(`node ${rawNode.id}.exports is supported only for workflow-return nodes.`);
    const narrative = rawNode.narrative === undefined || rawNode.narrative === null ? null : (() => {
      const source = assertObject(rawNode.narrative, `node ${rawNode.id}.narrative`);
      return { fromNode: assertId(source.fromNode, `node ${rawNode.id}.narrative.fromNode`), output: assertId(source.output, `node ${rawNode.id}.narrative.output`) };
    })();
    if ((type === "turn-finalize") !== Boolean(narrative)) throw new Error(`node ${rawNode.id} must declare narrative exactly when type is turn-finalize.`);
    const narrativeSource = normalizeNarrativeSourceDeclaration(rawNode.narrativeSource, { defaultLayer: "unspecified" });
    const team = rawNode.team === undefined || rawNode.team === null ? null : normalizeTeamDefinition(rawNode.team);
    if ((type === "team") !== Boolean(team)) throw new Error(`node ${rawNode.id} must declare team exactly when type is team.`);
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
      routeFromOutput,
      context: normalizeContext(rawNode.context),
      retry: { maxAttempts },
      cooldownTurns: Number.isSafeInteger(rawNode.cooldownTurns) && rawNode.cooldownTurns > 0
        ? Math.min(rawNode.cooldownTurns, 100000)
        : 0,
      required: rawNode.required !== false,
      narrativeSource,
      join: { mode: joinMode, quorum },
      outputs,
      workspaceHandoff,
      moduleAccess: normalizeModuleAccess(rawNode.moduleAccess, rawNode.id),
      workflowCalls,
      runtimeServices,
      target,
      arguments: callArguments,
      documents: callDocuments,
      outputPaths: callOutputPaths,
      exports: returnExports,
      narrative,
      team,
      dataCommit: normalizeDataCommit(rawNode.dataCommit, outputs, rawNode.id),
      metadata: rawNode.metadata && typeof rawNode.metadata === "object" && !Array.isArray(rawNode.metadata) ? rawNode.metadata : {},
    };
  });
  for (const node of nodes) {
    if (node.type === "team") {
      const declaredCalls = new Set(node.workflowCalls.map(binding => binding.target));
      const missingCalls = [...node.team.assistants, ...(node.team.baseRetrieval ? [node.team.baseRetrieval] : [])]
        .filter(ability => ability.enabled && ability.kind === "workflow" && !declaredCalls.has(ability.target))
        .map(ability => ability.target);
      if (missingCalls.length) throw new Error(`node ${node.id} team workflow abilities require matching workflowCalls: ${[...new Set(missingCalls)].join(", ")}.`);
    }
    const callInputs = uniqueIds(node.metadata?.callInputs, `node ${node.id}.metadata.callInputs`);
    for (const inputId of callInputs) {
      if (workflowInterface?.inputs?.[inputId]?.type !== "document") throw new Error(`node ${node.id}.metadata.callInputs references undeclared document input ${inputId}.`);
    }
    const nodeOutputInputs = uniqueIds(node.metadata?.nodeOutputInputs, `node ${node.id}.metadata.nodeOutputInputs`);
    for (const dependencyId of nodeOutputInputs) {
      if (!node.dependsOn.includes(dependencyId) && !node.context.fromNodes.includes(dependencyId)) throw new Error(`node ${node.id}.metadata.nodeOutputInputs references non-upstream node ${dependencyId}.`);
    }
    const argumentInputs = uniqueIds(node.metadata?.argumentInputs, `node ${node.id}.metadata.argumentInputs`);
    for (const inputId of argumentInputs) {
      if (workflowInterface && workflowInterface.inputs?.[inputId]?.type !== "parameter") throw new Error(`node ${node.id}.metadata.argumentInputs references undeclared parameter input ${inputId}.`);
    }
    const triggerInputs = uniqueIds(node.metadata?.triggerInputs, `node ${node.id}.metadata.triggerInputs`);
    for (const inputId of triggerInputs) {
      if (!input.trigger?.documents?.[inputId]) throw new Error(`node ${node.id}.metadata.triggerInputs references undeclared trigger document ${inputId}.`);
    }
    if (node.metadata?.handoffInputs !== undefined) {
      if (!Array.isArray(node.metadata.handoffInputs)) throw new Error(`node ${node.id}.metadata.handoffInputs must be an array.`);
      const seen = new Set();
      for (const [index, selection] of node.metadata.handoffInputs.entries()) {
        const value = assertObject(selection, `node ${node.id}.metadata.handoffInputs[${index}]`);
        const sourceNodeId = assertId(value.nodeId, `node ${node.id}.metadata.handoffInputs[${index}].nodeId`);
        const outputId = assertId(value.output, `node ${node.id}.metadata.handoffInputs[${index}].output`);
        const key = `${sourceNodeId}/${outputId}`;
        if (seen.has(key)) throw new Error(`node ${node.id}.metadata.handoffInputs must not contain duplicate selections.`);
        seen.add(key);
        if (!node.dependsOn.includes(sourceNodeId) && !node.context.fromNodes.includes(sourceNodeId)) throw new Error(`node ${node.id}.metadata.handoffInputs references non-upstream node ${sourceNodeId}.`);
        const sourceNode = nodes.find(candidate => candidate.id === sourceNodeId);
        if (!sourceNode?.outputs?.[outputId] || !sourceNode.workspaceHandoff?.include?.some(entry => entry.output === outputId)) {
          throw new Error(`node ${node.id}.metadata.handoffInputs references unavailable handoff ${key}.`);
        }
      }
    }
    if (node.metadata?.textOutput !== undefined) {
      if (node.type !== "agent") throw new Error(`node ${node.id}.metadata.textOutput is allowed only on Agent nodes.`);
      const outputId = assertId(node.metadata.textOutput, `node ${node.id}.metadata.textOutput`);
      const output = node.outputs?.[outputId];
      if (!output || output.kind !== "file" || output.format !== "markdown") throw new Error(`node ${node.id}.metadata.textOutput must reference a declared Markdown file output.`);
    }
  }
  assertAcyclic(nodes);

  const finalizeCount = nodes.filter(node => node.type === "turn-finalize").length;
  const returnCount = nodes.filter(node => node.type === "workflow-return").length;
  if (kind === "foreground" && finalizeCount !== 1) throw new Error("A foreground workflow must contain exactly one turn-finalize node.");
  if (kind !== "foreground" && finalizeCount > 0) throw new Error("Only foreground workflows may contain turn-finalize nodes.");
  if (MODULE_WORKFLOW_KINDS.has(kind) && returnCount !== 1) throw new Error("A module workflow must contain exactly one workflow-return node.");
  if (!MODULE_WORKFLOW_KINDS.has(kind) && returnCount > 0) throw new Error("Only module workflows may contain workflow-return nodes.");
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
    const finalizer = nodes.find(node => node.type === "turn-finalize");
    const sourceNode = nodes.find(node => node.id === finalizer.narrative.fromNode);
    if (!sourceNode) throw new Error(`turn-finalize references unknown narrative node ${finalizer.narrative.fromNode}.`);
    if (!sourceNode.outputs[finalizer.narrative.output]) throw new Error(`turn-finalize references unknown narrative output ${finalizer.narrative.output}.`);
    if (sourceNode.outputs[finalizer.narrative.output].format !== "narrative") throw new Error("turn-finalize narrative output must use format narrative.");
    const finalizerAncestors = [ancestors(finalizer)];
    if (!finalizerAncestors[0].has(sourceNode.id)) throw new Error("A turn-finalize node must run after its narrative source node.");
    const uncommitted = nodes.filter(node => node.required && node.type !== "turn-finalize" && !finalizerAncestors.some(ids => ids.has(node.id)));
    if (uncommitted.length) throw new Error(`Required foreground nodes are not committed by a turn-finalize node: ${uncommitted.map(node => node.id).join(", ")}`);
  }
  if (MODULE_WORKFLOW_KINDS.has(kind)) {
    const returnNode = nodes.find(node => node.type === "workflow-return");
    const declaredExports = new Set(Object.keys(workflowInterface.exports));
    const returnedExports = new Set(Object.keys(returnNode.exports));
    if (declaredExports.size !== returnedExports.size || [...declaredExports].some(id => !returnedExports.has(id))) {
      throw new Error("workflow-return exports must exactly match workflow.interface.exports.");
    }
    for (const [exportId, source] of Object.entries(returnNode.exports)) {
      const sourceNode = nodes.find(node => node.id === source.fromNode);
      if (!sourceNode) throw new Error(`workflow-return ${exportId} references unknown node ${source.fromNode}.`);
      if (source.output && !sourceNode.outputs[source.output]) throw new Error(`workflow-return ${exportId} references unknown output ${source.output}.`);
      if (source.output && sourceNode.outputs[source.output].format !== workflowInterface.exports[exportId].format) {
        throw new Error(`workflow-return ${exportId} output format must match workflow.interface.exports.`);
      }
      if (source.output && sourceNode.outputs[source.output].kind !== workflowInterface.exports[exportId].kind) {
        throw new Error(`workflow-return ${exportId} output kind must match workflow.interface.exports.`);
      }
      if (!source.output && workflowInterface.exports[exportId].kind === "directory") {
        throw new Error(`workflow-return ${exportId} directory export must reference a declared output.`);
      }
    }
  }

  const defaultInstanceMode = kind === "module-external" ? "multiple" : "single";
  const instanceMode = input.instancePolicy?.mode === "multiple" ? "multiple" : input.instancePolicy?.mode === "single" ? "single" : defaultInstanceMode;
  const writeLocks = normalizeWriteLocks(input.writeLocks, kind, ownerModuleId);
  const dedupeKey = typeof input.instancePolicy?.dedupeKey === "string" && input.instancePolicy.dedupeKey.trim()
    ? input.instancePolicy.dedupeKey.trim()
    : null;
  if (kind === "module-internal" && instanceMode === "multiple" && writeLocks.some(lock => lock.collectionId === null)) {
    throw new Error("A multi-instance module-internal workflow must declare exact collection write locks.");
  }
  if (kind === "module-internal" && instanceMode === "multiple" && !dedupeKey) {
    throw new Error("A multi-instance module-internal workflow must declare a stable dedupeKey.");
  }
  if (kind === "module-internal" && instanceMode === "multiple" && !(Number.isSafeInteger(input.instancePolicy?.maxConcurrentInstances) && input.instancePolicy.maxConcurrentInstances > 0)) {
    throw new Error("A multi-instance module-internal workflow must declare maxConcurrentInstances.");
  }
  const maxConcurrentInstances = Number.isSafeInteger(input.instancePolicy?.maxConcurrentInstances) && input.instancePolicy.maxConcurrentInstances > 0
    ? Math.min(input.instancePolicy.maxConcurrentInstances, 10)
    : kind === "module-external" ? 10 : 1;
  const reuseCompleted = input.instancePolicy?.reuseCompleted !== false;
  const recentCompleteTurns = Number.isSafeInteger(input.turnContext?.recentCompleteTurns)
    ? input.turnContext.recentCompleteTurns
    : 5;
  if (kind === "foreground" && (recentCompleteTurns < 1 || recentCompleteTurns > 50)) throw new Error("workflow.turnContext.recentCompleteTurns must be an integer from 1 to 50.");
  if (kind !== "foreground" && input.turnContext !== undefined && input.turnContext !== null) throw new Error("Only foreground workflows may declare turnContext.");
  const terminalFinalizer = input.terminalFinalizer === undefined || input.terminalFinalizer === null ? null : (() => {
    const value = assertObject(input.terminalFinalizer, "workflow.terminalFinalizer");
    if (!MODULE_WORKFLOW_KINDS.has(kind)) throw new Error("Only module workflows may declare terminalFinalizer.");
    const statuses = value.statuses === undefined ? ["failed", "cancelled", "skipped"] : value.statuses;
    if (!Array.isArray(statuses) || !statuses.length || statuses.some(status => !["completed", "failed", "cancelled", "skipped"].includes(status))) throw new Error("workflow.terminalFinalizer.statuses is invalid.");
    const target = assertWorkflowRef(value.target, "workflow.terminalFinalizer.target");
    if (!ownerModuleId || !target.startsWith(`${ownerModuleId}/`)) throw new Error("workflow.terminalFinalizer.target must belong to the same module.");
    return {
      target,
      statuses: [...new Set(statuses)],
      forwardArguments: uniqueIds(value.forwardArguments, "workflow.terminalFinalizer.forwardArguments"),
    };
  })();
  return {
    schemaVersion: 3,
    id,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : id,
    description: typeof input.description === "string" ? input.description.trim() : "",
    kind,
    ownerModuleId,
    agentCallable,
    interface: workflowInterface,
    revision: typeof input.revision === "string" && input.revision.trim() ? input.revision.trim() : "1",
    defaults: {
      agentId: typeof input.defaults?.agentId === "string" ? input.defaults.agentId : null,
      modelId: typeof input.defaults?.modelId === "string" ? input.defaults.modelId : null,
      context: normalizeContext(input.defaults?.context),
    },
    instancePolicy: {
      mode: instanceMode,
      maxConcurrentInstances: instanceMode === "single" ? 1 : maxConcurrentInstances,
      dedupeKey,
      reuseCompleted,
    },
    trigger: normalizeTrigger(input.trigger, kind),
    turnContext: kind === "foreground" ? { recentCompleteTurns } : null,
    writeLocks,
    terminalFinalizer,
    nodes,
  };
}

export function resolveCodeNodeRoute(node, output) {
  if (!node?.routeFromOutput) return null;
  const route = output && typeof output === "object" && !Array.isArray(output) ? output[node.routeFromOutput] : null;
  if (route === undefined || route === null || route === "") return null;
  if (typeof route !== "string" || !ID_PATTERN.test(route)) throw new Error(`Code node ${node.id} returned an invalid workflow route.`);
  return route;
}

export function createWorkflowRun(definition, options = {}) {
  const workflow = normalizeWorkflowDefinition(definition);
  const now = options.now || new Date().toISOString();
  return {
    schemaVersion: 3,
    id: options.id || `workflow-${randomUUID()}`,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    kind: workflow.kind,
    effectiveSchedulingKind: typeof options.effectiveSchedulingKind === "string" && options.effectiveSchedulingKind
      ? options.effectiveSchedulingKind
      : workflow.kind,
    ownerModuleId: workflow.ownerModuleId,
    callContext: options.callContext ? structuredClone(options.callContext) : null,
    instanceKey: typeof options.instanceKey === "string" && options.instanceKey ? options.instanceKey : null,
    invocationFingerprint: typeof options.invocationFingerprint === "string" && options.invocationFingerprint ? options.invocationFingerprint : null,
    invocationIdentity: options.invocationIdentity && typeof options.invocationIdentity === "object"
      ? structuredClone(options.invocationIdentity)
      : null,
    status: "running",
    cardId: options.cardId || null,
    chatId: options.chatId || null,
    turn: Number.isSafeInteger(options.turn) ? options.turn : null,
    visibleThroughTurn: Number.isSafeInteger(options.visibleThroughTurn) ? options.visibleThroughTurn : null,
    readSnapshotAt: typeof options.readSnapshotAt === "string" && options.readSnapshotAt ? options.readSnapshotAt : now,
    dataReadViewId: typeof options.dataReadViewId === "string" && options.dataReadViewId ? options.dataReadViewId : null,
    dataReadBatchIds: [...new Set(Array.isArray(options.dataReadBatchIds) ? options.dataReadBatchIds.filter(id => typeof id === "string" && id) : [])],
    inheritedDataReadBatchIds: [...new Set(Array.isArray(options.dataReadBatchIds) ? options.dataReadBatchIds.filter(id => typeof id === "string" && id) : [])],
    trigger: options.trigger || { type: "manual" },
    arguments: options.arguments && typeof options.arguments === "object" && !Array.isArray(options.arguments) ? structuredClone(options.arguments) : {},
    textInput: typeof options.textInput === "string" ? options.textInput : "",
    documents: options.documents && typeof options.documents === "object" && !Array.isArray(options.documents) ? structuredClone(options.documents) : {},
    outputPaths: options.outputPaths && typeof options.outputPaths === "object" && !Array.isArray(options.outputPaths) ? structuredClone(options.outputPaths) : {},
    payload: options.payload && typeof options.payload === "object" ? structuredClone(options.payload) : {},
    sourceReferences: mergeSourceReferences(options.sourceReferences || []),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    usage: null,
    usageComplete: null,
    usageComplete: false,
    usageAttempts: { recorded: 0, unrecorded: 0 },
    nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, {
      id: node.id,
      type: node.type,
      status: "pending",
      attempts: [],
      route: null,
      output: null,
      context: null,
      dataReadBatchIds: null,
      usage: null,
      processRecord: null,
      narrativeSource: workflowNodeNarrativeSource(workflow, node),
      waitingOn: null,
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
    usage: null,
    // Every attempt starts before any model call. The host flips this the moment it really
    // dispatches one, which is what separates a model failure from a runtime decision.
    modelDispatched: false,
  });
  run.updatedAt = now;
  return state.attempts.at(-1);
}

export function markWorkflowNodeModelDispatched(run, nodeId) {
  const attempt = run.nodes?.[nodeId]?.attempts?.at(-1);
  if (attempt) attempt.modelDispatched = true;
}

/**
 * Clear every trace of a node's previous failure.
 *
 * The failure fields are read by the panel, so they must disappear together with the error the
 * moment the node leaves the failed state — a stale cause next to a fresh attempt would describe
 * the wrong retry.
 */
function clearNodeFailure(state) {
  state.error = null;
  state.failureKind = null;
  state.failureCause = null;
  state.failureCode = null;
}

export function completeWorkflowNode(definition, run, nodeId, result = {}, now = new Date().toISOString()) {
  normalizeWorkflowDefinition(definition);
  const state = run.nodes[nodeId];
  if (!state || state.status !== "running") throw new Error(`Node ${nodeId} is not running.`);
  const attempt = state.attempts.at(-1);
  attempt.status = "completed";
  attempt.completedAt = now;
  attempt.usage = normalizeTokenUsage(result.usage) || emptyTokenUsage();
  attempt.usageComplete = result.usageComplete !== false;
  state.status = "completed";
  state.output = result.output ?? null;
  state.context = result.context ?? null;
  state.usage = attempt.usage;
  state.route = result.route ?? null;
  state.waitingOn = null;
  state.completedAt = now;
  clearNodeFailure(state);
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
  attempt.usage = normalizeTokenUsage(options.usage ?? error?.usage);
  attempt.usageComplete = attempt.usage ? options.usageComplete !== false : false;
  state.error = message;
  state.waitingOn = null;
  // Carries the runtime's own classification to the host: a deterministic failure cannot be
  // fixed by choosing another model, so the UI must not offer that as the remedy.
  state.failureKind = options.deterministic === true ? "deterministic" : "model";
  // Where the failure happened, also for the host. A node-end commit or output-staging failure is
  // retried by re-running the node, which re-renders the change, so the remedy is a plain retry
  // even though a model did run in this attempt and the failure is not deterministic.
  state.failureCause = options.nodeEndCommit === true ? "node_end_commit" : null;
  state.failureCode = options.failureCode || null;
  if (Object.hasOwn(options, "output")) state.output = structuredClone(options.output);
  if (options.retryable !== false && state.attempts.length < node.retry.maxAttempts) state.status = "awaiting-retry";
  else if (options.awaitModelChoice !== false) state.status = "awaiting-model-choice";
  else state.status = "failed";
  run.status = state.status === "awaiting-model-choice" ? "awaiting-model-choice" : run.status;
  run.updatedAt = now;
  return state;
}

export function requireWorkflowNodeRecovery(definition, run, nodeId, result = {}, now = new Date().toISOString()) {
  normalizeWorkflowDefinition(definition);
  const state = run.nodes[nodeId];
  if (!state || state.status !== "running") throw new Error(`Node ${nodeId} is not running.`);
  const attempt = state.attempts.at(-1);
  attempt.status = "recovery-required";
  attempt.completedAt = now;
  attempt.error = result.error || "recovery_required";
  attempt.usage = normalizeTokenUsage(result.usage) || emptyTokenUsage();
  attempt.usageComplete = result.usageComplete !== false;
  state.status = "awaiting-recovery";
  state.output = result.output ?? null;
  state.context = result.context ?? null;
  state.usage = attempt.usage;
  state.route = result.route ?? null;
  state.error = result.error || "recovery_required";
  state.completedAt = null;
  run.status = "awaiting-recovery";
  run.error = state.error;
  run.updatedAt = now;
  return state;
}

export function waitWorkflowNodeOnChild(definition, run, nodeId, waitingOn, now = new Date().toISOString()) {
  normalizeWorkflowDefinition(definition);
  const state = run.nodes[nodeId];
  if (!state || state.status !== "running") throw new Error(`Node ${nodeId} is not running.`);
  if (!waitingOn || typeof waitingOn !== "object" || typeof waitingOn.childRunId !== "string" || !waitingOn.childRunId) {
    throw new Error("A child wait must identify the child workflow run.");
  }
  const attempt = state.attempts.at(-1);
  attempt.status = "awaiting-child";
  attempt.completedAt = now;
  attempt.error = null;
  state.status = "awaiting-child";
  state.waitingOn = structuredClone(waitingOn);
  clearNodeFailure(state);
  state.completedAt = null;
  run.status = "awaiting-child";
  run.waitingOn = { nodeId, ...structuredClone(waitingOn) };
  run.error = null;
  run.updatedAt = now;
  return state;
}

export function resumeWorkflowNodeAfterChild(run, nodeId, now = new Date().toISOString()) {
  const state = run.nodes[nodeId];
  if (!state || state.status !== "awaiting-child") throw new Error(`Node ${nodeId} is not waiting on a child workflow.`);
  state.status = "pending";
  clearNodeFailure(state);
  const remaining = Object.values(run.nodes).find(candidate => candidate.status === "awaiting-child");
  run.status = remaining ? "awaiting-child" : "running";
  run.waitingOn = remaining ? { nodeId: remaining.id, ...structuredClone(remaining.waitingOn) } : null;
  run.error = null;
  run.updatedAt = now;
  return state;
}

export function prepareWorkflowNodeRetry(run, nodeId, now = new Date().toISOString()) {
  const state = run.nodes[nodeId];
  if (!state || !["awaiting-retry", "awaiting-model-choice", "awaiting-recovery", "failed"].includes(state.status)) {
    throw new Error(`Node ${nodeId} cannot be retried.`);
  }
  state.status = "pending";
  clearNodeFailure(state);
  run.status = "running";
  run.error = null;
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
  if (states.some(state => state.status === "awaiting-recovery")) {
    run.status = "awaiting-recovery";
    run.updatedAt = now;
    return run;
  }
  if (states.some(state => ["running", "pending", "awaiting-retry", "awaiting-model-choice", "awaiting-child"].includes(state.status))) return run;
  const requiredFailed = workflow.nodes.some(node => node.required && ["failed", "cancelled"].includes(run.nodes[node.id].status));
  run.status = requiredFailed ? "failed" : "completed";
  let usage = emptyTokenUsage();
  let recorded = 0;
  let unrecorded = 0;
  for (const state of states) {
    for (const attempt of state.attempts || []) {
      const attemptUsage = normalizeTokenUsage(attempt.usage);
      if (attemptUsage) {
        usage = addTokenUsage(usage, attemptUsage);
        recorded += 1;
        if (attempt.usageComplete === false) unrecorded += 1;
      } else if (["completed", "failed", "cancelled"].includes(attempt.status)) {
        unrecorded += 1;
      }
    }
  }
  run.usage = usage;
  run.usageComplete = unrecorded === 0;
  run.usageAttempts = { recorded, unrecorded };
  run.completedAt = now;
  run.updatedAt = now;
  return run;
}

export function workflowRuntimeIdentity(definition) {
  const workflow = normalizeWorkflowDefinition(definition);
  return MODULE_WORKFLOW_KINDS.has(workflow.kind)
    ? `${workflow.ownerModuleId}/${workflow.id}`
    : `top-level/${workflow.id}`;
}

export function resolveWorkflowInstanceInput(definition, options = {}) {
  const workflow = normalizeWorkflowDefinition(definition);
  if (MODULE_WORKFLOW_KINDS.has(workflow.kind)) {
    if (options.arguments && typeof options.arguments === "object" && !Array.isArray(options.arguments)) return structuredClone(options.arguments);
    if (options.payload?.call?.arguments && typeof options.payload.call.arguments === "object" && !Array.isArray(options.payload.call.arguments)) return structuredClone(options.payload.call.arguments);
    return {};
  }
  return options.payload && typeof options.payload === "object" && !Array.isArray(options.payload) ? structuredClone(options.payload) : {};
}

export function resolveInstanceKey(definition, instanceInput = {}, uniqueId = null) {
  const workflow = normalizeWorkflowDefinition(definition);
  const identity = workflowRuntimeIdentity(workflow);
  if (workflow.instancePolicy.mode === "single") return identity;
  const selector = workflow.instancePolicy.dedupeKey;
  if (!selector) return `${identity}:${uniqueId || randomUUID()}`;
  const path = selector.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let value = instanceInput;
  for (const segment of path) value = value?.[segment];
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`Workflow ${workflow.id} dedupeKey ${selector} did not resolve to a stable value.`);
  return `${identity}:${String(value)}`;
}

export function activeWorkflowNodeIds(run) {
  return Object.values(run.nodes).filter(state => state.status === "running").map(state => state.id);
}

export function workflowTriggerMatches(definition, event) {
  const workflow = normalizeWorkflowDefinition(definition);
  if (MODULE_WORKFLOW_KINDS.has(workflow.kind)) return false;
  const trigger = workflow.trigger || { type: "manual" };
  if (trigger.type === "manual") return event?.type === "manual";
  if (trigger.type === "after-opening") return event?.type === "after-opening";
  if (trigger.type === "after-workflow") return event?.type === "after-workflow" && event.workflowId === trigger.workflowId;
  if (trigger.type === "node") {
    return event?.type === "node" && event.workflowId === trigger.workflowId && event.nodeId === trigger.nodeId;
  }
  return false;
}

export function canonicalWorkflowRef(definition) {
  const workflow = normalizeWorkflowDefinition(definition);
  if (!MODULE_WORKFLOW_KINDS.has(workflow.kind)) throw new Error("Only module workflows have canonical module/workflow references.");
  return `${workflow.ownerModuleId}/${workflow.id}`;
}

export function assertWorkflowCallAllowed(callerWorkflow, callerNode, targetWorkflow, { agent = false, lifecycle = false } = {}) {
  const caller = normalizeWorkflowDefinition(callerWorkflow);
  const target = normalizeWorkflowDefinition(targetWorkflow);
  if (!MODULE_WORKFLOW_KINDS.has(target.kind)) throw new Error("Only module workflows may be called synchronously.");
  const sameOwnerLifecycle = lifecycle && caller.ownerModuleId === target.ownerModuleId && target.kind === "module-internal";
  if (MODULE_WORKFLOW_KINDS.has(caller.kind) && target.kind !== "module-external" && !sameOwnerLifecycle) {
    throw new Error("Module workflows may call only module-external workflows.");
  }
  const reference = canonicalWorkflowRef(target);
  const authorization = callerNode.workflowCalls.find(binding => binding.target === reference);
  if (authorization?.documentSnapshotInput) {
    const input = target.interface.inputs[authorization.documentSnapshotInput];
    if (!input || input.type !== "document" || !input.formats.includes("document-workspace-snapshot") || input.kind === "file") throw new Error(`Node ${callerNode.id} documentSnapshotInput must target a directory-capable document-workspace-snapshot input.`);
  }
  if (agent) {
    if (callerNode.type !== "agent") throw new Error("Agent workflow calls require an agent node.");
    if (!target.agentCallable) throw new Error(`Module workflow ${reference} is not callable by Agents.`);
  }
  if (["agent", "code"].includes(callerNode.type) && !callerNode.workflowCalls.some(binding => binding.target === reference)) {
    throw new Error(`Node ${callerNode.id} is not allowed to call ${reference}.`);
  }
  if (callerNode.type === "call" && callerNode.target !== reference) throw new Error(`Call node ${callerNode.id} targets another workflow.`);
  return reference;
}

export function workflowCallAuthorization(callerNode, reference) {
  if (!["agent", "code"].includes(callerNode.type)) return null;
  return callerNode.workflowCalls.find(binding => binding.target === reference) || null;
}

function applyWorkflowCallArgumentPolicy(parameters, authorization) {
  if (!authorization) return parameters;
  const result = structuredClone(parameters);
  for (const [key, fixed] of Object.entries(authorization.fixedArguments || {})) {
    if (Object.hasOwn(result, key) && JSON.stringify(result[key]) !== JSON.stringify(fixed)) throw new Error(`Workflow call argument ${key} is fixed by the caller node.`);
    result[key] = structuredClone(fixed);
  }
  if (authorization.allowedArguments) {
    const permitted = new Set([...Object.keys(authorization.fixedArguments || {}), ...Object.keys(authorization.allowedArguments)]);
    const unknown = Object.keys(result).filter(key => !permitted.has(key));
    if (unknown.length) throw new Error(`Workflow call arguments are not allowed by the caller node: ${unknown.join(", ")}.`);
    for (const [key, allowed] of Object.entries(authorization.allowedArguments)) {
      if (!Object.hasOwn(result, key)) continue;
      const values = Array.isArray(result[key]) ? result[key] : [result[key]];
      if (values.some(value => !allowed.some(candidate => Object.is(candidate, value)))) throw new Error(`Workflow call argument ${key} exceeds the caller node's allowed values.`);
    }
  }
  return result;
}

export function normalizeWorkflowCallRequest(targetWorkflow, request, authorization = null) {
  const target = normalizeWorkflowDefinition(targetWorkflow);
  if (!MODULE_WORKFLOW_KINDS.has(target.kind)) throw new Error("Only module workflows accept call requests.");
  if (authorization) {
    const parameterIds = new Set(Object.entries(target.interface.inputs)
      .filter(([, definition]) => definition.type === "parameter")
      .map(([id]) => id));
    const policyKeys = new Set([
      ...Object.keys(authorization.fixedArguments || {}),
      ...Object.keys(authorization.allowedArguments || {}),
    ]);
    const unknownPolicyKeys = [...policyKeys].filter(key => !parameterIds.has(key));
    if (unknownPolicyKeys.length) throw new Error(`Workflow call policy references unknown parameter inputs: ${unknownPolicyKeys.join(", ")}.`);
  }
  const input = assertObject(request, "workflow call request");
  const text = input.text === undefined ? "" : typeof input.text === "string" ? input.text : (() => { throw new Error("workflow call text must be a string."); })();
  const requestedParameters = input.arguments === undefined ? {} : structuredClone(assertObject(input.arguments, "workflow call arguments"));
  const parameters = applyWorkflowCallArgumentPolicy(requestedParameters, authorization);
  const documents = normalizePathMap(input.documents, "workflow call documents");
  const outputPaths = normalizePathMap(input.outputPaths, "workflow call outputPaths");
  const declaredParameters = Object.fromEntries(Object.entries(target.interface.inputs).filter(([, definition]) => definition.type === "parameter"));
  const declaredDocuments = Object.fromEntries(Object.entries(target.interface.inputs).filter(([, definition]) => definition.type === "document"));
  const unknownParameters = Object.keys(parameters).filter(id => !Object.hasOwn(declaredParameters, id));
  if (unknownParameters.length) throw new Error(`Module workflow ${canonicalWorkflowRef(target)} received undeclared parameter inputs: ${unknownParameters.join(", ")}.`);
  const unknownDocuments = Object.keys(documents).filter(id => !Object.hasOwn(declaredDocuments, id));
  if (unknownDocuments.length) throw new Error(`Module workflow ${canonicalWorkflowRef(target)} received undeclared document inputs: ${unknownDocuments.join(", ")}.`);
  const matchesValueType = (value, valueType) => valueType === "any"
    || (valueType === "string" && typeof value === "string")
    || (valueType === "number" && typeof value === "number" && Number.isFinite(value))
    || (valueType === "integer" && Number.isSafeInteger(value))
    || (valueType === "boolean" && typeof value === "boolean")
    || (valueType === "object" && Boolean(value) && typeof value === "object" && !Array.isArray(value))
    || (valueType === "array" && Array.isArray(value))
    || (valueType === "string-array" && Array.isArray(value) && value.every(item => typeof item === "string"));
  for (const [id, value] of Object.entries(parameters)) {
    if (!matchesValueType(value, declaredParameters[id].valueType)) throw new Error(`Module workflow ${canonicalWorkflowRef(target)} parameter ${id} must be ${declaredParameters[id].valueType}.`);
  }
  for (const [id, definition] of Object.entries(target.interface.inputs)) {
    if (!definition.required) continue;
    const present = definition.type === "text" ? Boolean(text.trim()) : definition.type === "document" ? Boolean(documents[id]) : Object.hasOwn(parameters, id);
    if (!present) throw new Error(`Module workflow ${canonicalWorkflowRef(target)} requires ${definition.type} input ${id}.`);
  }
  const declaredExports = Object.keys(target.interface.exports).sort();
  const suppliedExports = Object.keys(outputPaths).sort();
  if (JSON.stringify(declaredExports) !== JSON.stringify(suppliedExports)) {
    throw new Error(`Module workflow ${canonicalWorkflowRef(target)} outputPaths must exactly match exports: ${declaredExports.join(", ") || "(none)"}.`);
  }
  return { text, arguments: parameters, documents, outputPaths };
}
