const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return !parts.some(part => !part || part === "." || part === "..");
}

export function validateContextProcessorDefinition(value) {
  const fields = [
    "schemaVersion",
    "id",
    "description",
    "phase",
    "contextOrder",
    "entryFile",
    "dependencies",
    "fragments",
    "failure",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) {
    throw new Error("Context processor must use the exact schemaVersion 1 field set.");
  }
  if (value.schemaVersion !== 1) throw new Error("Context processor schemaVersion must be 1.");
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) throw new Error("Context processor id is invalid.");
  if (typeof value.description !== "string") throw new Error(`Context processor ${value.id} description must be a string.`);
  if (value.phase !== "before-narrative") throw new Error(`Context processor ${value.id} phase must be before-narrative.`);
  if (!Number.isSafeInteger(value.contextOrder)) throw new Error(`Context processor ${value.id} contextOrder must be an integer.`);
  if (!safeRelativePath(value.entryFile)) throw new Error(`Context processor ${value.id} entryFile must be a safe relative POSIX path.`);
  if (!value.dependencies || typeof value.dependencies !== "object" || Array.isArray(value.dependencies)) {
    throw new Error(`Context processor ${value.id} dependencies must be an object.`);
  }
  const dependencyFields = ["currentInput", "opening", "player", "messages", "variables", "modules", "settings"];
  if (Object.keys(value.dependencies).length !== dependencyFields.length || dependencyFields.some(field => !(field in value.dependencies))) {
    throw new Error(`Context processor ${value.id} dependencies must use the exact version 1 field set.`);
  }
  for (const field of ["currentInput", "opening", "player", "settings"]) {
    if (typeof value.dependencies[field] !== "boolean") throw new Error(`Context processor ${value.id} dependencies.${field} must be boolean.`);
  }
  for (const field of ["messages", "variables"]) {
    if (!['none', 'all'].includes(value.dependencies[field])) throw new Error(`Context processor ${value.id} dependencies.${field} must be none or all.`);
  }
  if (!Array.isArray(value.dependencies.modules) || value.dependencies.modules.some(moduleId => typeof moduleId !== "string" || !SAFE_ID.test(moduleId))) {
    throw new Error(`Context processor ${value.id} dependencies.modules must contain safe module IDs.`);
  }
  if (new Set(value.dependencies.modules).size !== value.dependencies.modules.length) {
    throw new Error(`Context processor ${value.id} dependencies.modules must not contain duplicates.`);
  }
  if (!Array.isArray(value.fragments) || value.fragments.length === 0) {
    throw new Error(`Context processor ${value.id} fragments must be a non-empty array.`);
  }
  const fragmentIds = new Set();
  for (const fragment of value.fragments) {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment) || Object.keys(fragment).sort().join(",") !== "file,id,title") {
      throw new Error(`Context processor ${value.id} fragment must contain exactly id, title, and file.`);
    }
    if (typeof fragment.id !== "string" || !SAFE_ID.test(fragment.id) || fragmentIds.has(fragment.id)) {
      throw new Error(`Context processor ${value.id} has an invalid or duplicate fragment id.`);
    }
    if (typeof fragment.title !== "string" || !fragment.title.trim()) throw new Error(`Context processor ${value.id} fragment ${fragment.id} requires a title.`);
    if (!safeRelativePath(fragment.file)) throw new Error(`Context processor ${value.id} fragment ${fragment.id} file is unsafe.`);
    fragmentIds.add(fragment.id);
  }
  if (!['error', 'omit'].includes(value.failure)) throw new Error(`Context processor ${value.id} failure must be error or omit.`);
  return clone(value);
}

export function buildContextProcessorInput(definition, available) {
  const dependencies = definition.dependencies;
  const selectedModules = {};
  for (const moduleId of dependencies.modules) {
    if (!(moduleId in available.modules)) throw new Error(`Context processor ${definition.id} requires unknown module ${moduleId}.`);
    selectedModules[moduleId] = clone(available.modules[moduleId]);
  }
  return deepFreeze({
    schemaVersion: 1,
    card: clone(available.card),
    turn: available.turn,
    currentInput: dependencies.currentInput ? available.currentInput : null,
    openingId: dependencies.opening ? available.openingId : null,
    player: dependencies.player ? clone(available.player) : null,
    messages: dependencies.messages === "all" ? clone(available.messages) : [],
    variables: dependencies.variables === "all" ? clone(available.variables) : null,
    modules: selectedModules,
    settings: dependencies.settings ? clone(available.settings) : null,
  });
}

export function validateContextProcessorResult(definition, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.include)) {
    throw new Error(`Context processor ${definition.id} must return exactly { include: string[] }.`);
  }
  const known = new Set(definition.fragments.map(fragment => fragment.id));
  if (value.include.some(id => typeof id !== "string" || !known.has(id))) {
    throw new Error(`Context processor ${definition.id} returned an unknown fragment id.`);
  }
  if (new Set(value.include).size !== value.include.length) {
    throw new Error(`Context processor ${definition.id} returned duplicate fragment ids.`);
  }
  return { include: [...value.include] };
}

export async function runContextProcessor(definition, handler, available) {
  if (typeof handler !== "function") throw new Error(`Context processor ${definition.id} must export selectContext().`);
  const input = buildContextProcessorInput(definition, available);
  return validateContextProcessorResult(definition, await handler(input));
}
