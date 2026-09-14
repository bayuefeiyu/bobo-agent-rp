import { capabilityAllows, isSafeDataId, recordTypeDefinition } from "./rp-data-contracts.mjs";

const LEGACY_TYPES = new Set(["text", "markdown", "json", "key-value", "list", "table", "image-generation"]);
const INTERACTIVE_TYPES = new Set(["record-browser", "story-browser", "settings-form", "workflow-controls", "integrity-alerts"]);
const FIELD_TYPES = new Set(["text", "textarea", "integer", "number", "boolean", "select", "json"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exact(value, allowed, required, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`${label} has invalid fields; unknown=[${unknown.join(", ")}], missing=[${missing.join(", ")}].`);
}

function id(value, label) {
  if (!isSafeDataId(value)) throw new Error(`${label} must be a safe ID.`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function pointer(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.split("/").some((part, index) => index > 0 && !part)) throw new Error(`${label} must be an RFC 6901 pointer below the record data root.`);
  return value;
}

function common(raw, label) {
  return {
    id: id(raw.id, `${label}.id`),
    type: raw.type,
    title: text(raw.title, `${label}.title`),
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    spoiler: raw.spoiler === true,
  };
}

function ensureRecordTarget(contract, raw, label, { update = false } = {}) {
  const collection = contract.collections[raw.collectionId];
  if (!collection) throw new Error(`${label} references unknown collection ${raw.collectionId}.`);
  const recordTypes = raw.recordTypes || (raw.recordType ? [raw.recordType] : Object.keys(collection.recordTypes));
  if (!Array.isArray(recordTypes) || !recordTypes.length) throw new Error(`${label}.recordTypes must not be empty.`);
  for (const type of recordTypes) {
    const definition = recordTypeDefinition(contract, raw.collectionId, type);
    if (!definition.views[raw.view]) throw new Error(`${label} record type ${type} has no ${raw.view} view.`);
    if (update && !definition.actions.includes("update")) throw new Error(`${label} record type ${type} cannot be updated.`);
  }
  if (!capabilityAllows(contract, [raw.readCapability], { collectionId: raw.collectionId, action: "query", view: raw.view })) throw new Error(`${label}.readCapability does not grant the declared query view.`);
  if (update && !capabilityAllows(contract, [raw.updateCapability], { collectionId: raw.collectionId, action: "update" })) throw new Error(`${label}.updateCapability does not grant update.`);
  return recordTypes;
}

function normalizeFilter(raw, definitions, label) {
  const value = object(raw, label);
  exact(value, ["id", "label", "index", "operator", "control", "options"], ["id", "label", "index", "operator", "control"], label);
  const control = value.control;
  if (!["text", "number", "boolean", "select"].includes(control)) throw new Error(`${label}.control is unsupported.`);
  const indexes = definitions.map(definition => definition.indexes[value.index]).filter(Boolean);
  if (indexes.length !== definitions.length || indexes.some(index => !index.operators.includes(value.operator))) throw new Error(`${label} references an index/operator not shared by every selected record type.`);
  const options = value.options === undefined ? [] : value.options;
  if (!Array.isArray(options) || options.some(option => typeof option !== "string")) throw new Error(`${label}.options must be a string array.`);
  if (indexes.some(index => index.type === "enum" && options.some(option => !index.values.includes(option)))) throw new Error(`${label}.options contains a value outside the declared enum index.`);
  return { id: id(value.id, `${label}.id`), label: text(value.label, `${label}.label`), index: id(value.index, `${label}.index`), operator: value.operator, control, options: [...new Set(options)] };
}

function normalizeField(raw, label) {
  const value = object(raw, label);
  exact(value, ["path", "label", "type", "required", "minimum", "maximum", "options", "help"], ["path", "label", "type"], label);
  if (!FIELD_TYPES.has(value.type)) throw new Error(`${label}.type is unsupported.`);
  const options = value.options === undefined ? [] : value.options;
  if (!Array.isArray(options) || options.some(option => typeof option !== "string")) throw new Error(`${label}.options must be a string array.`);
  return {
    path: pointer(value.path, `${label}.path`), label: text(value.label, `${label}.label`), type: value.type,
    required: value.required === true,
    minimum: Number.isFinite(value.minimum) ? value.minimum : null,
    maximum: Number.isFinite(value.maximum) ? value.maximum : null,
    options: [...new Set(options)],
    help: typeof value.help === "string" ? value.help.trim() : "",
  };
}

function normalizeParameter(raw, label) {
  const value = object(raw, label);
  exact(value, ["name", "label", "type", "required", "minimum", "maximum", "options", "default", "help"], ["name", "label", "type"], label);
  const field = normalizeField({ path: `/${value.name}`, label: value.label, type: value.type, required: value.required, minimum: value.minimum, maximum: value.maximum, options: value.options, help: value.help }, label);
  return { ...field, name: id(value.name, `${label}.name`), default: structuredClone(value.default) };
}

export function normalizeModuleFrontendView(value, contract) {
  const input = object(value, "frontend view");
  exact(input, ["schemaVersion", "regions"], ["schemaVersion", "regions"], "frontend view");
  if (![1, 2].includes(input.schemaVersion) || !Array.isArray(input.regions)) throw new Error("Frontend view must use schemaVersion 1 or 2 and contain regions.");
  if (input.schemaVersion === 1) return structuredClone(input);
  const seen = new Set();
  const regions = input.regions.map((raw, index) => {
    const region = object(raw, `frontend region ${index}`);
    if (!INTERACTIVE_TYPES.has(region.type)) {
      if (!LEGACY_TYPES.has(region.type)) throw new Error(`Frontend region ${index} has unsupported type ${region.type}.`);
      return structuredClone(region);
    }
    if (seen.has(region.id)) throw new Error(`Duplicate frontend region ID ${region.id}.`);
    seen.add(region.id);
    const base = common(region, `frontend region ${index}`);
    if (region.type === "record-browser") {
      exact(region, ["id", "type", "title", "description", "spoiler", "collectionId", "recordTypes", "view", "readCapability", "pageSize", "maxCharacters", "filters", "includeInactive", "empty"], ["id", "type", "title", "collectionId", "recordTypes", "view", "readCapability"], `frontend region ${index}`);
      const recordTypes = ensureRecordTarget(contract, region, `frontend region ${index}`);
      const definitions = recordTypes.map(type => recordTypeDefinition(contract, region.collectionId, type));
      const pageSize = Number.isSafeInteger(region.pageSize) ? region.pageSize : 20;
      const maxCharacters = Number.isSafeInteger(region.maxCharacters) ? region.maxCharacters : 50000;
      if (pageSize < 1 || pageSize > 100 || maxCharacters < 1000 || maxCharacters > 200000) throw new Error(`frontend region ${index} has invalid budgets.`);
      return { ...base, collectionId: region.collectionId, recordTypes, view: region.view, readCapability: region.readCapability, pageSize, maxCharacters, includeInactive: region.includeInactive === true, filters: (region.filters || []).map((item, itemIndex) => normalizeFilter(item, definitions, `frontend region ${index}.filters[${itemIndex}]`)), empty: typeof region.empty === "string" ? region.empty : "暂无记录。" };
    }
    if (region.type === "story-browser") {
      exact(region, ["id", "type", "title", "description", "spoiler", "collectionId", "recordTypes", "indexView", "fullView", "readCapability", "pageSize", "indexMaxCharacters", "fullMaxCharacters", "allowSeriesGrouping", "allowOpenAuthoritySource", "empty"], ["id", "type", "title", "collectionId", "recordTypes", "indexView", "fullView", "readCapability"], `frontend region ${index}`);
      const indexTypes = ensureRecordTarget(contract, { ...region, view: region.indexView }, `frontend region ${index} index`);
      ensureRecordTarget(contract, { ...region, recordTypes: indexTypes, view: region.fullView }, `frontend region ${index} full`);
      const pageSize = Number.isSafeInteger(region.pageSize) ? region.pageSize : 10;
      const indexMaxCharacters = Number.isSafeInteger(region.indexMaxCharacters) ? region.indexMaxCharacters : 50000;
      const fullMaxCharacters = Number.isSafeInteger(region.fullMaxCharacters) ? region.fullMaxCharacters : 200000;
      if (pageSize < 1 || pageSize > 100 || indexMaxCharacters < 1000 || indexMaxCharacters > 200000 || fullMaxCharacters < 1000 || fullMaxCharacters > 1000000) throw new Error(`frontend region ${index} has invalid story budgets.`);
      return { ...base, collectionId: region.collectionId, recordTypes: indexTypes, indexView: region.indexView, fullView: region.fullView, readCapability: region.readCapability, pageSize, indexMaxCharacters, fullMaxCharacters, allowSeriesGrouping: region.allowSeriesGrouping === true, allowOpenAuthoritySource: region.allowOpenAuthoritySource === true, empty: typeof region.empty === "string" ? region.empty : "暂无故事。" };
    }
    if (region.type === "settings-form") {
      exact(region, ["id", "type", "title", "description", "spoiler", "collectionId", "recordType", "recordId", "view", "readCapability", "updateCapability", "fields", "submitLabel"], ["id", "type", "title", "collectionId", "recordType", "recordId", "view", "readCapability", "updateCapability", "fields"], `frontend region ${index}`);
      ensureRecordTarget(contract, { ...region, recordTypes: [region.recordType] }, `frontend region ${index}`, { update: true });
      if (!isSafeDataId(region.recordId)) throw new Error(`frontend region ${index}.recordId must be a safe ID.`);
      if (!Array.isArray(region.fields) || !region.fields.length) throw new Error(`frontend region ${index}.fields must not be empty.`);
      return { ...base, collectionId: region.collectionId, recordType: region.recordType, recordId: region.recordId, view: region.view, readCapability: region.readCapability, updateCapability: region.updateCapability, fields: region.fields.map((item, itemIndex) => normalizeField(item, `frontend region ${index}.fields[${itemIndex}]`)), submitLabel: typeof region.submitLabel === "string" && region.submitLabel.trim() ? region.submitLabel.trim() : "保存设置" };
    }
    if (region.type === "integrity-alerts") {
      exact(region, ["id", "type", "title", "description", "spoiler", "coverage", "action", "empty"], ["id", "type", "title", "action"], `frontend region ${index}`);
      const action = object(region.action, `frontend region ${index}.action`);
      exact(action, ["workflowRegionId", "workflowId", "startTurnParameter", "endTurnParameter", "operationParameter", "operationValue"], ["workflowRegionId", "workflowId", "startTurnParameter", "endTurnParameter"], `frontend region ${index}.action`);
      let coverage = null;
      if (region.coverage !== undefined && region.coverage !== null) {
        const rawCoverage = object(region.coverage, `frontend region ${index}.coverage`);
        exact(rawCoverage, ["collectionId", "view", "readCapability", "stateRecordType", "stateRecordId", "lastArchivedTurnPath", "settingsRecordType", "settingsRecordId", "enabledPath", "protectRecentTurnsPath", "archiveEveryTurnsPath", "coverageRecordType", "startTurnPath", "endTurnPath"], ["collectionId", "view", "readCapability", "stateRecordType", "stateRecordId", "lastArchivedTurnPath", "settingsRecordType", "settingsRecordId", "enabledPath", "protectRecentTurnsPath", "archiveEveryTurnsPath", "coverageRecordType", "startTurnPath", "endTurnPath"], `frontend region ${index}.coverage`);
        const recordTypes = [rawCoverage.stateRecordType, rawCoverage.settingsRecordType, rawCoverage.coverageRecordType].map((type, typeIndex) => id(type, `frontend region ${index}.coverage.recordTypes[${typeIndex}]`));
        ensureRecordTarget(contract, { ...rawCoverage, recordTypes }, `frontend region ${index}.coverage`);
        coverage = {
          collectionId: rawCoverage.collectionId,
          view: rawCoverage.view,
          readCapability: rawCoverage.readCapability,
          stateRecordType: recordTypes[0],
          stateRecordId: id(rawCoverage.stateRecordId, `frontend region ${index}.coverage.stateRecordId`),
          lastArchivedTurnPath: pointer(rawCoverage.lastArchivedTurnPath, `frontend region ${index}.coverage.lastArchivedTurnPath`),
          settingsRecordType: recordTypes[1],
          settingsRecordId: id(rawCoverage.settingsRecordId, `frontend region ${index}.coverage.settingsRecordId`),
          enabledPath: pointer(rawCoverage.enabledPath, `frontend region ${index}.coverage.enabledPath`),
          protectRecentTurnsPath: pointer(rawCoverage.protectRecentTurnsPath, `frontend region ${index}.coverage.protectRecentTurnsPath`),
          archiveEveryTurnsPath: pointer(rawCoverage.archiveEveryTurnsPath, `frontend region ${index}.coverage.archiveEveryTurnsPath`),
          coverageRecordType: recordTypes[2],
          startTurnPath: pointer(rawCoverage.startTurnPath, `frontend region ${index}.coverage.startTurnPath`),
          endTurnPath: pointer(rawCoverage.endTurnPath, `frontend region ${index}.coverage.endTurnPath`),
        };
      }
      return {
        ...base,
        coverage,
        action: {
          workflowRegionId: id(action.workflowRegionId, `frontend region ${index}.action.workflowRegionId`),
          workflowId: id(action.workflowId, `frontend region ${index}.action.workflowId`),
          startTurnParameter: id(action.startTurnParameter, `frontend region ${index}.action.startTurnParameter`),
          endTurnParameter: id(action.endTurnParameter, `frontend region ${index}.action.endTurnParameter`),
          operationParameter: action.operationParameter === undefined ? null : id(action.operationParameter, `frontend region ${index}.action.operationParameter`),
          operationValue: typeof action.operationValue === "string" ? action.operationValue : "repair",
        },
        empty: typeof region.empty === "string" ? region.empty : "未发现需要处理的归档问题。",
      };
    }
    exact(region, ["id", "type", "title", "description", "spoiler", "workflows"], ["id", "type", "title", "workflows"], `frontend region ${index}`);
    if (!Array.isArray(region.workflows) || !region.workflows.length) throw new Error(`frontend region ${index}.workflows must not be empty.`);
    const workflows = region.workflows.map((rawWorkflow, workflowIndex) => {
      const workflow = object(rawWorkflow, `frontend region ${index}.workflows[${workflowIndex}]`);
      exact(workflow, ["id", "title", "description", "parameters", "confirm"], ["id", "title"], `frontend region ${index}.workflows[${workflowIndex}]`);
      return { id: id(workflow.id, `frontend workflow ${workflowIndex}.id`), title: text(workflow.title, `frontend workflow ${workflowIndex}.title`), description: typeof workflow.description === "string" ? workflow.description.trim() : "", confirm: typeof workflow.confirm === "string" ? workflow.confirm.trim() : "", parameters: (workflow.parameters || []).map((item, itemIndex) => normalizeParameter(item, `frontend workflow ${workflowIndex}.parameters[${itemIndex}]`)) };
    });
    if (new Set(workflows.map(item => item.id)).size !== workflows.length) throw new Error(`frontend region ${index} contains duplicate workflow IDs.`);
    return { ...base, workflows };
  });
  for (const region of regions.filter(item => item.type === "integrity-alerts")) {
    const workflowRegion = regions.find(item => item.id === region.action.workflowRegionId && item.type === "workflow-controls");
    const workflow = workflowRegion?.workflows?.find(item => item.id === region.action.workflowId);
    if (!workflow) throw new Error(`Integrity region ${region.id} references an undeclared workflow control.`);
    const parameters = new Map(workflow.parameters.map(item => [item.name, item]));
    for (const name of [region.action.startTurnParameter, region.action.endTurnParameter]) if (parameters.get(name)?.type !== "integer") throw new Error(`Integrity region ${region.id} turn parameters must reference integer workflow parameters.`);
    if (region.action.operationParameter) {
      const parameter = parameters.get(region.action.operationParameter);
      if (!parameter || (parameter.type === "select" && !parameter.options.includes(region.action.operationValue))) throw new Error(`Integrity region ${region.id} operation parameter is invalid.`);
    }
  }
  return { schemaVersion: 2, regions };
}

export function frontendRegion(module, regionId, expectedType = null) {
  const region = module?.view?.regions?.find(item => item?.id === regionId);
  if (!region || (expectedType && region.type !== expectedType)) throw new Error(`Frontend region ${regionId} is not declared for module ${module?.id || "unknown"}.`);
  return region;
}

function decodePointer(pointerValue) {
  return pointerValue.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function setAtPointer(root, pointerValue, nextValue) {
  const parts = decodePointer(pointerValue);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(nextValue);
}

function normalizedFieldValue(field, value, label) {
  if ((value === null || value === undefined || value === "") && !field.required) return value === "" ? "" : null;
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
    return value;
  }
  if (field.type === "integer" || field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) throw new Error(`${label} must be a ${field.type}.`);
    if (field.minimum !== null && value < field.minimum) throw new Error(`${label} is below its minimum.`);
    if (field.maximum !== null && value > field.maximum) throw new Error(`${label} is above its maximum.`);
    return value;
  }
  if (field.type === "json") {
    if (value === null || typeof value !== "object") throw new Error(`${label} must be a JSON object or array.`);
    return structuredClone(value);
  }
  if (typeof value !== "string" || (field.required && !value.trim())) throw new Error(`${label} must be text.`);
  if (value.length > 50000) throw new Error(`${label} is too long.`);
  if (field.type === "select" && !field.options.includes(value)) throw new Error(`${label} is not an allowed option.`);
  return value;
}

export function applyFrontendSettingsValues(region, currentData, values) {
  const input = object(values, "settings values");
  const allowed = new Map(region.fields.map(field => [field.path, field]));
  const unknown = Object.keys(input).filter(path => !allowed.has(path));
  if (unknown.length) throw new Error(`Settings values contain undeclared fields: ${unknown.join(", ")}.`);
  const next = structuredClone(currentData);
  for (const [path, value] of Object.entries(input)) setAtPointer(next, path, normalizedFieldValue(allowed.get(path), value, path));
  return next;
}

export function validateFrontendWorkflowPayload(region, workflowId, payload) {
  const workflow = region.workflows.find(item => item.id === workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} is not declared by this frontend region.`);
  const input = object(payload || {}, "workflow payload");
  const fields = new Map(workflow.parameters.map(field => [field.name, field]));
  const unknown = Object.keys(input).filter(name => !fields.has(name));
  if (unknown.length) throw new Error(`Workflow payload contains undeclared parameters: ${unknown.join(", ")}.`);
  const normalized = {};
  for (const field of workflow.parameters) {
    const value = Object.hasOwn(input, field.name) ? input[field.name] : field.default;
    if (value === undefined && field.required) throw new Error(`Workflow parameter ${field.name} is required.`);
    if (value !== undefined) normalized[field.name] = normalizedFieldValue(field, value, `workflow parameter ${field.name}`);
  }
  return normalized;
}
