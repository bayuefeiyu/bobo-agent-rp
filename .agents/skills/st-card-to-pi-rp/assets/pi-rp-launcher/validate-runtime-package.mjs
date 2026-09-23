import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isInside(root, path) { const rel = relative(root, path); return Boolean(rel && rel !== ".." && !rel.startsWith(`..${sep}`)); }

export async function validateRuntimePackage(cardDirectory) {
  const card = resolve(cardDirectory);
  const errors = [], changed = [];
  const manifest = JSON.parse(await readFile(join(card, "manifest.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(card, "runtime-lock.json"), "utf8"));
  const launch = JSON.parse(await readFile(join(card, "runtime", "launch.json"), "utf8"));
  if (!safeId.test(manifest.id) || lock.cardId !== manifest.id || launch.cardId !== manifest.id || lock.schemaVersion !== 1 || launch.schemaVersion !== 1) errors.push("Card launch identity or schema is invalid.");
  if (lock.packageFormat !== 1 || lock.launchProtocolVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(lock.runtimeVersion)) errors.push("Card package or launch protocol is incompatible.");
  if (launch.engine?.name !== "@earendil-works/pi-coding-agent" || !/^\d+\.\d+\.\d+$/.test(launch.engine?.testedVersion) || !Number.isInteger(launch.engine?.testedNodeMajor) || launch.engine.testedNodeMajor < 20 || !/^\d+\.\d+\.\d+$/.test(lock.testedNodeVersion) || Number(lock.testedNodeVersion.split(".")[0]) !== launch.engine.testedNodeMajor) errors.push("Card engine compatibility declaration is invalid.");
  if (!Array.isArray(lock.externalDependencies) || !lock.externalDependencies.some(item => item?.name === launch.engine?.name && item?.testedVersion === launch.engine?.testedVersion)) errors.push("Card external engine dependency is missing.");
  if (!lock.files || typeof lock.files !== "object" || Array.isArray(lock.files)) errors.push("Runtime file inventory is missing.");
  const required = [launch.entry, ...(Array.isArray(launch.skills) ? launch.skills : []), "web/server.mjs", "prompts/system/base.md", "prompts/system/tools.json", "defaults/common.json", "defaults/workflow-runtime.json", "defaults/model-profiles.json"];
  for (const file of required) if (typeof file !== "string" || !Object.hasOwn(lock.files || {}, file)) errors.push(`Required runtime file is not inventoried: ${String(file)}`);
  for (const [file, digest] of Object.entries(lock.files || {})) {
    const path = resolve(card, file);
    if (!isInside(card, path) || file.includes("\\") || file.startsWith("/")) { errors.push(`Runtime path escapes card: ${file}`); continue; }
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`Runtime dependency is not a regular file: ${file}`); continue; }
      const actual = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actual !== digest) changed.push(file);
    } catch (error) { errors.push(`Runtime dependency is missing: ${file} (${error.code || error.message})`); }
  }
  const cardFiles = new Set(Object.keys(lock.files || {}));
  for (const file of cardFiles) {
    if (!file.endsWith(".json") || !(/^(agents|workflows|features|defaults)\//.test(file))) continue;
    let document;
    try { document = JSON.parse(await readFile(join(card, file), "utf8")); }
    catch { continue; }
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, "promptFile") && Object.hasOwn(value, "prompt")) errors.push(`Prompt text is duplicated beside promptFile at ${path}`);
      for (const [key, child] of Object.entries(value)) {
        const label = `${path}.${key}`;
        if (key === "promptFile") {
          const normalized = typeof child === "string" ? child.replaceAll("\\", "/") : "";
          if (!normalized.startsWith("prompts/") || normalized.includes("/../") || normalized.endsWith("/..") || child.includes("\\")) errors.push(`Invalid card prompt reference ${String(child)} at ${label}`);
          else if (!cardFiles.has(normalized)) errors.push(`Missing card prompt reference ${child} at ${label}`);
        }
        if (key === "agentId" && typeof child === "string" && safeId.test(child) && !cardFiles.has(`agents/${child}/agent.json`)) errors.push(`Missing card Agent ${child} at ${label}`);
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
