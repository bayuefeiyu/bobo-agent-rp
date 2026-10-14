import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCardComponents } from "../assets/pi-rp-runtime/.pi/lib/rp-module-registry.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const developmentRuntime = JSON.parse(await readFile(resolve(skillRoot, "../../../scripts/development-runtime.json"), "utf8"));
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeRelativePath(value, base) {
  if (typeof value !== "string" || !value || value.includes("\\") || /^[a-z]:/i.test(value) || isAbsolute(value) || value === "." || value.split("/").includes("..")) return false;
  const target = resolve(base, value);
  const relation = relative(resolve(base), target);
  return Boolean(relation) && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

async function discoverTranscriptProvider(source, manifest) {
  const featureModules = manifest?.feature_modules;
  if (!Array.isArray(featureModules)) return null;
  const candidates = [];
  for (const modulePath of featureModules) {
    if (!safeRelativePath(modulePath, source)) continue;
    const moduleFile = resolve(source, modulePath);
    const module = JSON.parse(await readFile(moduleFile, "utf8"));
    if (!module || typeof module !== "object" || !safeId.test(module.id) || typeof module.dataContractFile !== "string") continue;
    const moduleDirectory = dirname(moduleFile);
    if (!safeRelativePath(module.dataContractFile, moduleDirectory)) continue;
    let contract;
    try {
      contract = JSON.parse(await readFile(resolve(moduleDirectory, module.dataContractFile), "utf8"));
    } catch {
      continue;
    }
    const collection = contract?.collections?.conversation;
    const recordTypes = collection?.recordTypes;
    if (!recordTypes || typeof recordTypes !== "object" || !recordTypes["narrative.message"] || typeof recordTypes["narrative.message"] !== "object") continue;
    candidates.push({ schemaVersion: 1, moduleId: module.id, collectionId: "conversation", recordType: "narrative.message", view: "rp" });
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple transcript provider candidates found: ${candidates.map(candidate => candidate.moduleId).join(", ")}. Declare manifest.transcript_provider explicitly.`);
  }
  return candidates[0] || null;
}

function git(args, cwd) {
  return new Promise(resolveResult => execFile("git", args, { cwd }, (error, stdout) => resolveResult(error ? null : stdout.trim())));
}

async function exists(path) {
  return lstat(path).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
}

async function copyTree(source, target, { filter = () => true, preserve = false } = {}) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Linked card dependency is not allowed: ${source}`);
  if (info.isFile()) {
    if (preserve && await exists(target)) return;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported card dependency: ${source}`);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const child = join(source, entry.name);
    if (filter(child, entry)) await copyTree(child, join(target, entry.name), { filter, preserve });
  }
}

async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`Linked card dependency is not allowed: ${path}`);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

async function compileAgentPreferenceIncludes(cardRoot, templateRoot) {
  const promptRoot = cardRoot;
  const preferenceRoot = resolve(templateRoot, "assets", "prompt-templates", "agent-preferences");
  const includePattern = /\{\{include:([^{}\r\n]+)\}\}/g;
  for (const file of await files(promptRoot)) {
    const path = relative(promptRoot, file).replaceAll("\\", "/");
    if (!path.endsWith(".md") || !path.split("/").includes("agents")) continue;
    const source = await readFile(file, "utf8");
    if (!source.includes("{{include:")) continue;
    let expanded = "";
    let position = 0;
    for (const match of source.matchAll(includePattern)) {
      const reference = match[1].trim();
      if (reference.startsWith("prompts/shared/") && !reference.includes("\\")) {
        const parts = path.split("/");
        const moduleRoot = resolve(promptRoot, ...parts.slice(0, parts.lastIndexOf("prompts")));
        const { readPromptFile } = await import("../assets/pi-rp-runtime/.pi/lib/rp-node-context.mjs");
        expanded += source.slice(position, match.index) + (await readPromptFile(moduleRoot, reference)).trimEnd();
        position = match.index + match[0].length;
        continue;
      }
      if (!reference.startsWith("agent-preferences/") || reference.includes("\\")) {
        throw new Error(`Invalid Agent preference include in ${path}: ${reference}`);
      }
      const target = resolve(preferenceRoot, reference.slice("agent-preferences/".length));
      const relation = relative(preferenceRoot, target);
      if (!relation || isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
        throw new Error(`Agent preference include escapes its template directory in ${path}: ${reference}`);
      }
      const info = await lstat(target).catch(error => {
        if (error.code === "ENOENT") throw new Error(`Missing Agent preference include in ${path}: ${reference}`);
        throw error;
      });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Agent preference include must be a regular file in ${path}: ${reference}`);
      const realRoot = await realpath(preferenceRoot);
      const realTarget = await realpath(target);
      const realRelation = relative(realRoot, realTarget);
      if (!realRelation || isAbsolute(realRelation) || realRelation === ".." || realRelation.startsWith(`..${sep}`)) {
        throw new Error(`Agent preference include escapes its template directory in ${path}: ${reference}`);
      }
      expanded += source.slice(position, match.index) + (await readFile(target, "utf8")).trimEnd();
      position = match.index + match[0].length;
    }
    expanded += source.slice(position);
    if (expanded.includes("{{include:")) throw new Error(`Unresolved Agent preference include in ${path}`);
    await writeFile(file, expanded);
  }
}

export async function packageCardRuntime({ sourceCard, targetCard, templateRoot = skillRoot, packagesRoot = resolve(skillRoot, "../../../packages"), sourceRevision = null }) {
  const source = resolve(sourceCard);
  const target = resolve(targetCard);
  if (source === target) throw new Error("Publish to a new card directory; in-place changes require the explicit upgrade process.");
  if (await exists(target)) throw new Error(`Target card already exists: ${target}`);
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  if (manifest.schema_version !== 2 || !safeId.test(manifest.id)) throw new Error("Source card needs a schema_version 2 manifest with a safe ID.");
  if (basename(target) !== manifest.id) throw new Error(`Target directory must match card ID ${manifest.id}.`);
  if (dirname(target) === target) throw new Error("Target must be a card directory.");
  const tmp = join(dirname(target), `.${manifest.id}-package-${randomUUID()}`);
  const runtime = join(templateRoot, "assets", "pi-rp-runtime");
  const web = join(templateRoot, "assets", "pi-rp-web");
  try {
    await copyTree(source, tmp);
    if (!Object.hasOwn(manifest, "transcript_provider")) {
      const discovered = await discoverTranscriptProvider(source, manifest);
      if (discovered) {
        await writeFile(join(tmp, "manifest.json"), `${JSON.stringify({ ...manifest, transcript_provider: discovered }, null, 2)}\n`);
      }
    }
    const engine = join(tmp, "runtime", "engine");
    await copyTree(join(runtime, ".pi", "extensions"), join(engine, "extensions"));
    await copyTree(join(runtime, ".pi", "lib"), join(engine, "lib"), { filter: (path, entry) => entry.isDirectory() || !entry.name.endsWith(".test.mjs") });
    await copyTree(join(runtime, ".pi", "skills"), join(engine, "skills"));
    await copyTree(join(runtime, "prompts"), join(tmp, "prompts"), { preserve: true });
    await compileAgentPreferenceIncludes(tmp, templateRoot);
    const components = await loadCardComponents(tmp);
    // Service configuration is available even without the external reference module.
    await copyTree(resolve(packagesRoot, "semantic-services"), join(engine, "lib", "semantic-services"), { filter: (_path, entry) => entry.isDirectory() || !entry.name.endsWith(".test.mjs") });
    await copyTree(resolve(packagesRoot, "narrative-history"), join(engine, "lib", "narrative-history"), { filter: (_path, entry) => entry.isDirectory() || !entry.name.endsWith(".test.mjs") && entry.name !== "README.md" });
    if (components.some(module => module.externalResource === "creative-reference-library/v1")) {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 24 || major === 24 && minor < 14) throw new Error("Reference library requires Node.js 24.14.0 or newer.");
      await copyTree(resolve(packagesRoot, "creative-reference-library"), join(engine, "lib", "creative-reference-library"), { filter: (_path, entry) => entry.isDirectory() || ["client.mjs", "contract.mjs", "core.mjs", "worker.mjs", "package.json", "semantic-contract.mjs", "passages.mjs", "semantic-index.mjs", "semantic-build.mjs", "semantic-manager.mjs", "service-adapters.mjs"].includes(entry.name) });
    }
    await copyTree(join(runtime, "settings"), join(tmp, "defaults"), { preserve: true });
    if (await exists(join(source, "web", "server.mjs"))) throw new Error("Old custom Web servers are unsupported; author a frontend package for the new runtime.");
    await copyTree(join(web, "public"), join(tmp, "web", "public"));
    await copyTree(join(web, "frontend.json"), join(tmp, "web", "frontend.json"), { preserve: true });
    for (const name of ["rp-web-contract", "rp-web-client", "rp-web-server"]) await copyTree(resolve(packagesRoot, name), join(tmp, "runtime", "packages", name), { filter: (_path, entry) => entry.isDirectory() || !entry.name.endsWith(".test.mjs") && entry.name !== "API.md" });
    const engineInfo = { ...developmentRuntime.engine, testedNodeMajor: Number(process.versions.node.split(".")[0]) };
    await writeFile(join(tmp, "runtime", "launch.json"), `${JSON.stringify({ schemaVersion: 2, cardId: manifest.id, webApiVersion: 1, entry: "runtime/engine/extensions/pi-rp-web.ts", skills: ["runtime/engine/skills/play-pi-rp/SKILL.md", "runtime/engine/skills/play-pi-rp-web/SKILL.md"], engine: engineInfo }, null, 2)}\n`);
    for (const required of ["prompts/system/base.md", "prompts/system/tools.json", "defaults/common.json", "defaults/model-profiles.json", "defaults/workflow-runtime.json", "web/frontend.json", "runtime/packages/rp-web-server/index.mjs", "runtime/engine/extensions/pi-rp-web.ts"]) {
      if (!await exists(join(tmp, required))) throw new Error(`Card package is missing ${required}`);
    }
    const hashes = {};
    for (const path of await files(tmp)) {
      const rel = relative(tmp, path).replaceAll("\\", "/");
      if (rel === "runtime-lock.json" || rel === "settings.json" || rel.startsWith("config-profiles/") || rel.startsWith("settings-assets/") || rel.startsWith("settings/")) continue;
      hashes[rel] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    const revision = sourceRevision || await git(["rev-parse", "HEAD"], templateRoot);
    const workingTreeDirty = Boolean(await git(["status", "--porcelain"], templateRoot));
    await writeFile(join(tmp, "runtime-lock.json"), `${JSON.stringify({ schemaVersion: 2, cardId: manifest.id, packageFormat: 3, runtimeVersion: "2.0.0", launchProtocolVersion: 2, webApiVersion: 1, testedNodeVersion: process.versions.node, externalDependencies: [{ name: engineInfo.name, testedVersion: engineInfo.testedVersion }], sourceRevision: revision, workingTreeDirty, files: hashes }, null, 2)}\n`);
    await rename(tmp, target);
    return { cardId: manifest.id, target, fileCount: Object.keys(hashes).length };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceCard, targetCard] = process.argv.slice(2);
  if (!sourceCard || !targetCard) throw new Error("Usage: node package_card_runtime.mjs <source-card> <new-target-card>");
  console.log(JSON.stringify(await packageCardRuntime({ sourceCard, targetCard }), null, 2));
}
