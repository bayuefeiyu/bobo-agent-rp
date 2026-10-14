// Browser-safe public protocol. No host objects or runtime dependencies.
export const API_VERSION = Object.freeze({ major: 1, minor: 0 });
export const HOST_VERSION = Object.freeze({ major: 1, minor: 0 });
export const API_ROOT = "/api/v1";
export const ERROR_STATUS = Object.freeze({
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  method_not_allowed: 405, session_changed: 409, revision_conflict: 409,
  preview_read_only: 409, operation_outcome_unknown: 409, api_incompatible: 409,
  invalid_state: 409,
  unsupported_capability: 501, internal_error: 500, request_too_large: 413,
});

export class RpWebError extends Error {
  constructor(code, message, { status = ERROR_STATUS[code] || 500, details = null, requestId = null, retryable = false } = {}) {
    super(message);
    this.name = "RpWebError";
    Object.assign(this, { code, status, details, requestId, retryable });
  }
}

export function assertCompatible(required, actual, label = "API") {
  if (!required || !actual || required.major !== actual.major || !Number.isInteger(required.minor) || required.minor > actual.minor) {
    throw new RpWebError("api_incompatible", `${label} version is incompatible.`, { details: { required, actual } });
  }
}

export function normalizeReadContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpWebError("invalid_request", "readContext must be an object.");
  const allowed = ["serverInstanceId", "cardId", "chatId", "executionId"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RpWebError("invalid_request", "readContext contains unknown fields.");
  const context = {};
  for (const key of allowed) {
    const id = value[key];
    if (key === "serverInstanceId" && (typeof id !== "string" || !id)) throw new RpWebError("invalid_request", "serverInstanceId is required.");
    if (id != null && (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id))) throw new RpWebError("invalid_request", `Invalid ${key}.`);
    context[key] = id ?? null;
  }
  return context;
}

export function contextKey(context) { return JSON.stringify(normalizeReadContext(context)); }

// Validate the supported JSON Schema vocabulary used by the public schemas.
// Reject unsupported keywords when authoring schemas rather than silently ignoring them.
export function validateSchema(schema, value, label = "$", definitions = {}) {
  if (!schema) throw new Error(`Unknown schema at ${label}.`);
  if (schema.$ref) return validateSchema(definitions[schema.$ref.split("/").at(-1)], value, label, definitions);
  if (schema.anyOf) {
    if (!schema.anyOf.some(item => { try { validateSchema(item, value, label, definitions); return true; } catch { return false; } })) throw new RpWebError("invalid_request", `${label} does not match an allowed shape.`);
    return value;
  }
  if (schema.enum && !schema.enum.includes(value)) throw new RpWebError("invalid_request", `${label} is not an allowed value.`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && type !== schema.type && !(schema.type === "integer" && Number.isSafeInteger(value))) throw new RpWebError("invalid_request", `${label} must be ${schema.type}.`);
  if (type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new RpWebError("invalid_request", `${label}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validateSchema(child, item, `${label}.${key}`, definitions);
      else if (schema.additionalProperties === false) throw new RpWebError("invalid_request", `${label}.${key} is not declared.`);
      else if (typeof schema.additionalProperties === "object") validateSchema(schema.additionalProperties, item, `${label}.${key}`, definitions);
    }
  }
  if (type === "array") {
    if (schema.maxItems != null && value.length > schema.maxItems) throw new RpWebError("invalid_request", `${label} has too many items.`);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, `${label}[${i}]`, definitions));
  }
  if (type === "string" && ((schema.minLength != null && value.length < schema.minLength) || (schema.maxLength != null && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new RpWebError("invalid_request", `${label} is invalid.`);
  if (type === "number" && (!Number.isFinite(value) || (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) throw new RpWebError("invalid_request", `${label} is outside its bounds.`);
  return value;
}
