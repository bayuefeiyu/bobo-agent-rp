import { randomUUID } from "node:crypto";

function clone(value) {
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeVariableState(base, overlay) {
  if (!isObject(base) || !isObject(overlay)) return clone(overlay);
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isObject(value) && isObject(result[key])
      ? mergeVariableState(result[key], value)
      : clone(value);
  }
  return result;
}

function pointerParts(pointer) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("Variable path must be an RFC 6901 JSON Pointer beginning with '/'.");
  }
  return pointer.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function variableValueAt(state, pointer) {
  let current = state;
  for (const part of pointerParts(pointer)) {
    if (current === null || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function parentAt(state, pointer, create = false) {
  const parts = pointerParts(pointer);
  if (parts.length === 0) return { parent: null, key: "" };
  let current = state;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object") throw new Error(`Variable path parent is not an object: ${pointer}`);
    if (!(part in current)) {
      if (!create) throw new Error(`Variable path does not exist: ${pointer}`);
      current[part] = {};
    }
    current = current[part];
  }
  return { parent: current, key: parts.at(-1) };
}

function setAt(state, pointer, value, create = true) {
  const { parent, key } = parentAt(state, pointer, create);
  if (parent === null) return clone(value);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index > parent.length) throw new Error(`Invalid array index in variable path: ${pointer}`);
    parent[index] = clone(value);
  } else {
    if (!isObject(parent)) throw new Error(`Variable path parent is not an object: ${pointer}`);
    parent[key] = clone(value);
  }
  return state;
}

function removeAt(state, pointer) {
  const { parent, key } = parentAt(state, pointer, false);
  if (parent === null) throw new Error("The variable state root cannot be removed.");
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= parent.length) throw new Error(`Variable path does not exist: ${pointer}`);
    parent.splice(index, 1);
  } else {
    if (!isObject(parent) || !(key in parent)) throw new Error(`Variable path does not exist: ${pointer}`);
    delete parent[key];
  }
  return state;
}

function operationError(operation, state, error, code = "operation_failed") {
  return {
    operationId: operation.operationId,
    path: operation.path,
    attemptedValue: "value" in operation ? operation.value : null,
    currentValue: clone(variableValueAt(state, operation.path)),
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function applyVariableOperations(baseState, operations) {
  let state = clone(baseState);
  const applied = [];
  const errors = [];
  for (const operation of operations) {
    try {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Variable operation must be an object.");
      if (typeof operation.operationId !== "string" || !operation.operationId.trim()) throw new Error("Variable operationId is required.");
      if (typeof operation.path !== "string") throw new Error("Variable operation path is required.");
      const current = variableValueAt(state, operation.path);
      if (operation.operation === "set") {
        state = setAt(state, operation.path, operation.value, true);
      } else if (operation.operation === "delta") {
        if (typeof current !== "number" || typeof operation.value !== "number") throw new Error("delta requires an existing number and a numeric value.");
        state = setAt(state, operation.path, current + operation.value, false);
      } else if (operation.operation === "merge") {
        if (!isObject(current) || !isObject(operation.value)) throw new Error("merge requires an existing object and an object value.");
        state = setAt(state, operation.path, mergeVariableState(current, operation.value), false);
      } else if (operation.operation === "append") {
        if (!Array.isArray(current)) throw new Error("append requires an existing array.");
        current.push(clone(operation.value));
      } else if (operation.operation === "remove") {
        state = removeAt(state, operation.path);
      } else {
        throw new Error(`Unsupported variable operation: ${String(operation.operation)}`);
      }
      applied.push(operation.operationId);
    } catch (error) {
      errors.push(operationError(operation || {}, state, error));
    }
  }
  return { state, applied, errors };
}

export function createVariableDraft({ turnId, moduleId, assistantMessageId, userMessage, assistantMessage, baseRecordId }) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `variable-draft-${randomUUID()}`,
    status: "pending",
    turnId,
    moduleId,
    assistantMessageId,
    baseRecordId,
    userMessage,
    assistantMessage,
    operations: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateVariableDraft(draft, changes) {
  const next = clone(draft);
  if (next.status !== "pending") throw new Error("The variable draft is not pending.");
  for (const change of changes) {
    const index = next.operations.findIndex(item => item.operationId === change.operationId);
    if (change.action === "cancel") {
      if (index !== -1) next.operations.splice(index, 1);
      continue;
    }
    const operation = {
      operationId: change.operationId,
      operation: change.operation,
      path: change.path,
      ...(change.operation === "remove" ? {} : { value: clone(change.value) }),
      ...(typeof change.reason === "string" && change.reason.trim() ? { reason: change.reason.trim() } : {}),
    };
    if (change.action === "add") {
      if (index !== -1) {
        if (JSON.stringify(next.operations[index]) !== JSON.stringify(operation)) throw new Error(`operationId already exists: ${change.operationId}`);
      } else {
        next.operations.push(operation);
      }
    } else if (change.action === "replace") {
      if (index === -1) throw new Error(`Cannot replace unknown operationId: ${change.operationId}`);
      next.operations[index] = operation;
    } else {
      throw new Error(`Unsupported draft action: ${String(change.action)}`);
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function projectVariableState(state, { paths = [], bindings = [] }, definitions = {}) {
  const selected = {};
  const missing = [];
  const add = (label, pointer, policy = "error", emptyValue = null) => {
    const value = variableValueAt(state, pointer);
    if (value === undefined) {
      if (policy === "empty") selected[label] = clone(emptyValue);
      else if (policy === "error") missing.push({ label, path: pointer });
      return;
    }
    selected[label] = clone(value);
  };
  for (const pointer of [...new Set(paths)]) add(pointer, pointer);
  for (const id of [...new Set(bindings)]) {
    const definition = definitions[id];
    if (!definition) {
      missing.push({ label: id, path: null });
      continue;
    }
    if (typeof definition.path === "string") add(id, definition.path, definition.missing, definition.shape === "scalar" ? null : {});
    else if (Array.isArray(definition.paths)) {
      const value = {};
      let hasValue = false;
      for (const pointer of definition.paths) {
        const item = variableValueAt(state, pointer);
        if (item === undefined && definition.missing === "empty") {
          value[pointer] = null;
          hasValue = true;
        } else if (item === undefined) {
          if (definition.missing === "error") missing.push({ label: id, path: pointer });
        } else {
          value[pointer] = clone(item);
          hasValue = true;
        }
      }
      if (hasValue) selected[id] = value;
    }
  }
  return { selected, missing };
}

export function renderVariableTemplates(text, state, definitions = {}) {
  return text.replace(/\{\{rp_var:([a-zA-Z0-9._-]+)\}\}/g, (token, id) => {
    const definition = definitions[id];
    if (!definition || typeof definition.path !== "string") return token;
    const value = variableValueAt(state, definition.path);
    if (value === undefined) return token;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function sameVariableState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
