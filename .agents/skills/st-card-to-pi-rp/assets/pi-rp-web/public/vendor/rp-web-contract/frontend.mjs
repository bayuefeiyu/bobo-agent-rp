import { API_VERSION, HOST_VERSION, RpWebError, assertCompatible } from "./index.mjs";
export function normalizeFrontendManifest(value) {
  const fields = ["schemaVersion", "id", "version", "kind", "root", "entry", "apiVersion", "hostVersion", "requiredCapabilities", "optionalCapabilities", "assets", "immersive"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new RpWebError("invalid_request", "Frontend manifest must use the exact field set.");
  if (value.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.id) || !/^\d+\.\d+\.\d+$/.test(value.version) || !["builtin", "custom"].includes(value.kind) || typeof value.immersive !== "boolean") throw new RpWebError("invalid_request", "Frontend identity is invalid.");
  const safePath = path => typeof path === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) && path.split("/").every(part => part && !part.startsWith("."));
  if (!safePath(value.root) || !safePath(value.entry) || !value.entry.endsWith(".mjs") && !value.entry.endsWith(".js")) throw new RpWebError("invalid_request", "Frontend root and entry must be safe relative paths.");
  if (value.kind === "custom" && !value.root.startsWith("frontends/")) throw new RpWebError("invalid_request", "Custom frontend must use its own frontends directory.");
  for (const key of ["assets", "requiredCapabilities", "optionalCapabilities"]) if (!Array.isArray(value[key]) || new Set(value[key]).size !== value[key].length || value[key].some(item => typeof item !== "string" || !item)) throw new RpWebError("invalid_request", `Invalid ${key}.`);
  if (value.assets.some(path => !safePath(path)) || !value.assets.includes(value.entry)) throw new RpWebError("invalid_request", "Frontend entry must be included in its safe asset inventory.");
  assertCompatible(value.apiVersion, API_VERSION);
  assertCompatible(value.hostVersion, HOST_VERSION, "Presentation host");
  return structuredClone(value);
}
export function assertFrontendCapabilities(frontend, connection) {
  assertCompatible(frontend.apiVersion, connection.apiVersion);
  assertCompatible(frontend.hostVersion, connection.hostVersion, "Presentation host");
  const missing = frontend.requiredCapabilities.filter(id => !connection.capabilities.includes(id));
  if (missing.length) throw new RpWebError("unsupported_capability", "Frontend requires unavailable capabilities.", { details: { missing } });
}
