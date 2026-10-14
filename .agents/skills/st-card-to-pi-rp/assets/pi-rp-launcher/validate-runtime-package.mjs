import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFrontendManifest } from "./packages/rp-web-contract/frontend.mjs";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isInside(root, path) { const rel = relative(root, path); return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }

export async function validateRuntimePackage(cardDirectory) {
  const card = resolve(cardDirectory);
  const errors = [], changed = [];
  if (await lstat(join(card, ".frontend-backups/pending.json")).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error))) errors.push("Frontend installation is incomplete; run install-play-frontend.mjs --recover.");
  const manifest = JSON.parse(await readFile(join(card, "manifest.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(card, "runtime-lock.json"), "utf8"));
  const launch = JSON.parse(await readFile(join(card, "runtime", "launch.json"), "utf8"));
  if (!safeId.test(manifest.id) || lock.cardId !== manifest.id || launch.cardId !== manifest.id || lock.schemaVersion !== 2 || launch.schemaVersion !== 2) errors.push("Card launch identity or schema is invalid; old cards are unsupported.");
  if (lock.packageFormat !== 3 || lock.launchProtocolVersion !== 2 || lock.webApiVersion !== 1 || launch.webApiVersion !== 1 || lock.runtimeVersion !== "2.0.0") errors.push("Card package or launch protocol is incompatible.");
  if (launch.engine?.name !== "@earendil-works/pi-coding-agent" || !/^\d+\.\d+\.\d+$/.test(launch.engine?.testedVersion) || !Number.isInteger(launch.engine?.testedNodeMajor) || launch.engine.testedNodeMajor < 20 || !/^\d+\.\d+\.\d+$/.test(lock.testedNodeVersion) || Number(lock.testedNodeVersion.split(".")[0]) !== launch.engine.testedNodeMajor) errors.push("Card engine compatibility declaration is invalid.");
  if (!Array.isArray(lock.externalDependencies) || !lock.externalDependencies.some(item => item?.name === launch.engine?.name && item?.testedVersion === launch.engine?.testedVersion)) errors.push("Card external engine dependency is missing.");
  if (!lock.files || typeof lock.files !== "object" || Array.isArray(lock.files)) errors.push("Runtime file inventory is missing.");
  const required = [launch.entry, ...(Array.isArray(launch.skills) ? launch.skills : []), "web/frontend.json", "runtime/packages/rp-web-server/index.mjs", "runtime/packages/rp-web-server/static-host.mjs", "runtime/packages/rp-web-server/card-store.mjs", "runtime/packages/rp-web-contract/index.mjs", "runtime/packages/rp-web-contract/operations.mjs", "runtime/packages/rp-web-contract/operations.json", "runtime/packages/rp-web-contract/schemas.json", "runtime/packages/rp-web-contract/frontend.mjs", "runtime/packages/rp-web-client/index.mjs", "runtime/packages/rp-web-client/presentation-host.mjs", "web/public/index.html", "prompts/system/base.md", "prompts/system/tools.json", "defaults/common.json", "defaults/workflow-runtime.json", "defaults/model-profiles.json"];
  try {
    const frontend = normalizeFrontendManifest(JSON.parse(await readFile(join(card, "web/frontend.json"), "utf8")));
    required.push(...frontend.assets.map(path => `web/${frontend.root}/${path}`));
  } catch (error) { errors.push(`Frontend package is invalid: ${error.message}`); }
  for (const file of required) if (typeof file !== "string" || !Object.hasOwn(lock.files || {}, file)) errors.push(`Required runtime file is not inventoried: ${String(file)}`);
  for (const [file, digest] of Object.entries(lock.files || {})) {
    const path = resolve(card, file);
    if (!isInside(card, path) || isAbsolute(file) || file.includes("\\") || file.startsWith("/")) { errors.push(`Runtime path escapes card: ${file}`); continue; }
    try {
      let ancestor = card;
      for (const part of relative(card, path).split(sep)) {
        ancestor = join(ancestor, part);
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Linked runtime dependency is forbidden.");
      }
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`Runtime dependency is not a regular file: ${file}`); continue; }
      const actual = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actual !== digest) { changed.push(file); errors.push(`Runtime dependency hash differs: ${file}`); }
    } catch (error) { errors.push(`Runtime dependency is missing: ${file} (${error.code || error.message})`); }
  }
  const cardFiles = new Set(Object.keys(lock.files || {}));
  const mutable = path => path === "runtime-lock.json" || path === "settings.json" || ["config-profiles/", "settings-assets/", "settings/", ".frontend-backups/"].some(prefix => path.startsWith(prefix));
  async function inspectDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), file = relative(card, path).replaceAll("\\", "/");
      if (mutable(file) || mutable(`${file}/`)) continue;
      if (entry.isSymbolicLink()) errors.push(`Linked runtime dependency is forbidden: ${file}`);
      else if (entry.isDirectory()) await inspectDirectory(path);
      else if (entry.isFile() && !cardFiles.has(file)) errors.push(`Uninventoried runtime dependency: ${file}`);
    }
  }
  await inspectDirectory(card);
  const components = [], agents = new Set(), workflows = new Set();
  const validPath = value => typeof value === "string" && value && !value.includes("\\") && !value.startsWith("/") && !value.split("/").some(part => !part || part === "." || part === "..") && isInside(card, resolve(card, value));
  for (const path of manifest.feature_modules || []) {
    if (!validPath(path) || !cardFiles.has(path)) { errors.push(`Missing module manifest: ${path}`); continue; }
    const module = JSON.parse(await readFile(join(card, path), "utf8"));
    const prefix = path.slice(0, path.lastIndexOf("/") + 1);
    if (![7, 8].includes(module.schemaVersion) || !safeId.test(module.id)) errors.push(`Invalid module manifest: ${path}`);
    if (module.frontendViewFile) {
      const frontendPath = prefix + module.frontendViewFile;
      if (!validPath(module.frontendViewFile) || !cardFiles.has(frontendPath)) errors.push(`Missing frontend declaration: ${frontendPath}`);
      else {
        const view = JSON.parse(await readFile(join(card, frontendPath), "utf8"));
        if (view.schemaVersion !== 3 || !Array.isArray(view.bindings) || !Array.isArray(view.regions)) errors.push(`Unsupported module frontend declaration: ${frontendPath}`);
      }
    }
    if (module.schemaVersion === 8 && module.externalResource !== null && (module.id !== "creative-reference-library" || module.moduleKind !== "resource" || module.externalResource !== "creative-reference-library/v1" || module.resourceCatalogFile !== null || module.dataContractFile !== null || module.frontendViewFile !== null || module.surface !== "background")) errors.push(`Invalid external resource module: ${path}`);
    if (module.externalResource === "creative-reference-library/v1") {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 24 || major === 24 && minor < 14) errors.push("Reference library requires Node.js 24.14.0 or newer.");
      for (const core of ["client.mjs", "contract.mjs", "core.mjs", "worker.mjs", "semantic-contract.mjs", "passages.mjs", "semantic-index.mjs", "semantic-build.mjs", "semantic-manager.mjs", "service-adapters.mjs"]) if (!cardFiles.has(`runtime/engine/lib/creative-reference-library/${core}`)) errors.push(`Reference library core is missing: ${core}`);
    }
    for (const [field, registry] of [["agentFiles", agents], ["workflowFiles", workflows]]) {
      if (!Array.isArray(module[field])) { errors.push(`Missing ${field}: ${path}`); continue; }
      for (const local of module[field]) {
        const file = prefix + local;
        if (!validPath(local) || !cardFiles.has(file)) { errors.push(`Missing module component: ${file}`); continue; }
        const document = JSON.parse(await readFile(join(card, file), "utf8"));
        const ref = document.id?.includes("/") ? document.id : `${module.id}/${document.id}`;
        if (document.ownerModuleId !== module.id || ref.split("/").length !== 2 || ref.split("/")[0] !== module.id || !safeId.test(ref.split("/")[1])) errors.push(`Invalid component owner: ${file}`);
        if (field === "workflowFiles" && document.schemaVersion !== 4) errors.push(`Invalid workflow schema: ${file}`);
        if (registry.has(ref)) errors.push(`Duplicate component: ${ref}`);
        registry.add(ref);
        components.push({ file, prefix, owner: module.id, document });
      }
    }
  }
  for (const file of cardFiles) if (/^(agents|workflows|prompts\/(agents|workflows|modules))\//.test(file)) errors.push(`Unowned component: ${file}`);
  // Model heads/tails remain public card-relative sources, unlike owned component prompts.
  let models = { profiles: [] };
  if (cardFiles.has("defaults/model-profiles.json")) {
    try { models = JSON.parse(await readFile(join(card, "defaults/model-profiles.json"), "utf8")); }
    catch (error) { errors.push(`Invalid model profile defaults: ${error.code || error.message}`); }
  }
  for (const profile of models.profiles || []) for (const key of ["headPromptFile", "tailPromptFile"]) {
    const path = profile[key];
    if (path != null && (!validPath(path) || !path.startsWith("prompts/") || !cardFiles.has(path))) errors.push(`Missing or invalid public model prompt: ${String(path)}`);
  }
  for (const {file, prefix, owner, document} of components) {
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, "promptFile") && Object.hasOwn(value, "prompt")) errors.push(`Prompt text is duplicated beside promptFile at ${path}`);
      for (const [key, child] of Object.entries(value)) {
        const label = `${path}.${key}`;
        if (key === "promptFile") {
          const normalized = typeof child === "string" ? child.replaceAll("\\", "/") : "";
          if (!validPath(child) || !normalized.startsWith("prompts/")) errors.push(`Invalid module prompt reference ${String(child)} at ${label}`);
          else if (!cardFiles.has(prefix + normalized)) errors.push(`Missing module prompt reference ${child} at ${label}`);
        }
        if (key === "agentId" && typeof child === "string" && !agents.has(child.includes("/") ? child : `${owner}/${child}`)) errors.push(`Missing module Agent ${child} at ${label}`);
        if (key === "entryFile" && (!validPath(child) || !cardFiles.has(prefix + child))) errors.push(`Missing module entry file ${String(child)} at ${label}`);
        visit(child, label);
      }
    };
    visit(document, file);
  }
  return { ok: errors.length === 0, cardId: manifest.id, errors, changed, checked: Object.keys(lock.files || {}).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const card = process.argv[2];
  if (!card) throw new Error("Usage: node validate_runtime_package.mjs <card-directory>");
  const result = await validateRuntimePackage(card);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
