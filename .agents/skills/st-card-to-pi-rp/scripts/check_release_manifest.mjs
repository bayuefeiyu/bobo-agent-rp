import { access, lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDataContract } from "../assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { normalizeFeatureModuleManifest } from "../assets/pi-rp-runtime/.pi/lib/rp-feature-modules.mjs";
import { normalizeResourceCatalog } from "../assets/pi-rp-runtime/.pi/lib/rp-resource-catalog.mjs";
import { normalizeWorkflowDefinition } from "../assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const manifestPath = "PROJECT-RELEASE-MANIFEST.json";
const commitIndex = process.argv.indexOf("--commit");
const mode = process.argv.includes("--staged") ? "staged" : commitIndex >= 0 ? "commit" : "workspace";
const commitRef = commitIndex >= 0 ? process.argv[commitIndex + 1] : null;
if (commitIndex >= 0 && !commitRef) throw new Error("--commit requires a Git revision.");

function posix(path) { return path.replaceAll("\\", "/"); }
function safeRelative(path, label = "release path") {
  if (typeof path !== "string" || !path.trim()) throw new Error(`${label} must be a non-empty relative path.`);
  const normalized = posix(path.trim()).replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label} escapes the repository: ${path}`);
  }
  return normalized;
}
function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: root, ...options });
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(detail || `git ${args.join(" ")} failed.`);
  }
  return result.stdout;
}
async function filesBelow(directory, base = root) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(path, base));
    else if (entry.isFile()) out.push(posix(relative(base, path)));
  }
  return out;
}
async function createReader() {
  if (mode === "workspace") return {
    async has(path) { return lstat(resolve(root, safeRelative(path))).then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false); },
    async readBuffer(path) {
      const target = resolve(root, safeRelative(path));
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${mode} target path is not a regular file: ${path}`);
      return readFile(target);
    },
    async list(prefix) {
      const target = resolve(root, safeRelative(prefix));
      return access(target).then(() => filesBelow(target), () => []);
    },
    async allFiles() { return filesBelow(root); },
  };
  const entries = mode === "staged"
    ? git(["ls-files", "--stage", "-z"], { encoding: "buffer" })
    : git(["ls-tree", "-r", "-z", commitRef], { encoding: "buffer" });
  const files = new Set();
  const symbolicLinks = new Set();
  for (const entry of entries.toString("utf8").split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error(`Unable to parse ${mode} Git tree entry.`);
    const metadata = entry.slice(0, separator).split(" ");
    if (mode === "staged" && metadata[2] !== "0") continue;
    const path = posix(entry.slice(separator + 1));
    files.add(path);
    if (metadata[0] === "120000") symbolicLinks.add(path);
  }
  return {
    async has(path) { const relativePath = safeRelative(path); return files.has(relativePath) && !symbolicLinks.has(relativePath); },
    async readBuffer(path) {
      const relativePath = safeRelative(path);
      if (!files.has(relativePath)) throw new Error(`${mode} target is missing ${relativePath}.`);
      if (symbolicLinks.has(relativePath)) throw new Error(`${mode} target contains an unsupported symbolic link: ${relativePath}`);
      return mode === "staged"
        ? git(["show", `:${relativePath}`], { encoding: "buffer" })
        : git(["show", `${commitRef}:${relativePath}`], { encoding: "buffer" });
    },
    async list(prefix) {
      const normalized = `${safeRelative(prefix).replace(/\/$/, "")}/`;
      return [...files].filter(path => path.startsWith(normalized));
    },
    async allFiles() { return [...files]; },
  };
}
function addPath(set, moduleId, path) {
  if (typeof path === "string" && path) set.add(safeRelative(`global-modules/${moduleId}/${path}`));
}
function parseJson(buffer, label) {
  try { return JSON.parse(buffer.toString("utf8")); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}
async function materialize(reader, directory) {
  for (const path of await reader.allFiles()) {
    const safePath = safeRelative(path);
    const destination = resolve(directory, safePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await reader.readBuffer(safePath));
  }
}
function runGeneratedChecks(manifest, targetRoot) {
  for (const script of manifest.generatedChecks || []) {
    const trustedScript = resolve(root, safeRelative(script, "generated check"));
    const result = spawnSync(process.execPath, [trustedScript, "--root", targetRoot, "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Generated check failed: ${script}`);
  }
}
function assertIgnoreRules(targetRoot, releasePaths) {
  const releaseInput = `${releasePaths.join("\0")}\0`;
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: targetRoot,
    input: releaseInput,
    encoding: "utf8",
  });
  if (![0, 1].includes(ignored.status)) throw new Error(ignored.stderr || "git check-ignore failed.");
  const ignoredPaths = ignored.stdout.split("\0").filter(Boolean);
  if (ignoredPaths.length) throw new Error(`Release files are ignored by Git rules:\n${ignoredPaths.join("\n")}`);

  const privateSentinels = [
    "play/settings/common.json",
    "play/cards/example/card.json",
    "play/sessions/example/chat/metadata.json",
  ];
  const privateInput = `${privateSentinels.join("\0")}\0`;
  const privateCheck = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: targetRoot,
    input: privateInput,
    encoding: "utf8",
  });
  if (![0, 1].includes(privateCheck.status)) throw new Error(privateCheck.stderr || "git check-ignore failed.");
  const protectedPaths = new Set(privateCheck.stdout.split("\0").filter(Boolean));
  const exposed = privateSentinels.filter(path => !protectedPaths.has(path));
  if (exposed.length) throw new Error(`Private play paths are not ignored:\n${exposed.join("\n")}`);
}

const reader = await createReader();
if (!await reader.has(manifestPath)) throw new Error(`${mode} target is missing ${manifestPath}.`);
const manifest = parseJson(await reader.readBuffer(manifestPath), manifestPath);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules) || !manifest.modules.length) {
  throw new Error(`${manifestPath} is invalid.`);
}

const moduleFiles = await reader.list("global-modules");
const actual = new Set(moduleFiles
  .map(path => path.match(/^global-modules\/([^/]+)\//)?.[1])
  .filter(Boolean));
const declared = new Set(manifest.modules.map(id => safeRelative(id, "module id")));
if ([...declared].some(id => !actual.has(id)) || [...actual].some(id => !declared.has(id))) {
  throw new Error(`Global module declaration mismatch; declared=${[...declared].join(",")}; actual=${[...actual].join(",")}.`);
}

const required = new Set((manifest.requiredPaths || []).map(path => safeRelative(path)));
const publishedModuleFiles = new Set();
for (const moduleId of manifest.modules) {
  const prefix = `global-modules/${moduleId}/`;
  for (const file of moduleFiles.filter(path => path.startsWith(prefix))) publishedModuleFiles.add(file);
  const moduleManifestPath = `${prefix}module.json`;
  required.add(moduleManifestPath);
  required.add(`${prefix}IMPORT.md`);
  const definition = normalizeFeatureModuleManifest(
    parseJson(await reader.readBuffer(moduleManifestPath), moduleManifestPath),
    moduleManifestPath,
  );
  if (definition.id !== moduleId) throw new Error(`Module directory ${moduleId} contains manifest id ${definition.id}.`);
  for (const field of ["dataContractFile", "resourceCatalogFile", "frontendViewFile", "skillFile"]) addPath(required, moduleId, definition[field]);
  for (const path of definition.workflowFiles || []) addPath(required, moduleId, path);

  if (definition.dataContractFile) {
    const path = `${prefix}${definition.dataContractFile}`;
    const contract = normalizeDataContract(parseJson(await reader.readBuffer(path), path), moduleId);
    for (const collection of Object.values(contract.collections || {})) {
      addPath(required, moduleId, collection.storage?.initialRecordsFile);
      addPath(required, moduleId, collection.storage?.initialSnapshotFile);
      for (const recordType of Object.values(collection.recordTypes || {})) {
        addPath(required, moduleId, recordType.schemaFile);
        for (const processor of Object.values(recordType.processors || {})) addPath(required, moduleId, processor.file);
      }
    }
  }
  if (definition.resourceCatalogFile) {
    const path = `${prefix}${definition.resourceCatalogFile}`;
    const catalog = normalizeResourceCatalog(parseJson(await reader.readBuffer(path), path), moduleId);
    for (const document of catalog.documents || []) addPath(required, moduleId, document.path);
  }
  for (const workflowFile of definition.workflowFiles || []) {
    const path = `${prefix}${workflowFile}`;
    const workflow = normalizeWorkflowDefinition(parseJson(await reader.readBuffer(path), path));
    for (const node of workflow.nodes || []) {
      const entry = node.metadata?.entryFile;
      const entryPrefix = `features/${moduleId}/`;
      if (typeof entry === "string" && entry.startsWith(entryPrefix)) addPath(required, moduleId, entry.slice(entryPrefix.length));
    }
  }
}

const targetFiles = mode === "workspace"
  ? new Set((await Promise.all([...new Set([...required, ...publishedModuleFiles])].map(async path => await reader.has(path) ? path : null))).filter(Boolean))
  : new Set(await reader.allFiles());
const missing = [...required].filter(path => !targetFiles.has(path));
if (missing.length) throw new Error(`${mode} release target is missing required paths:\n${missing.join("\n")}`);
for (const path of required) {
  if (!await reader.has(path)) throw new Error(`${mode} release target is missing required path: ${path}`);
  if (path.endsWith(".json")) parseJson(await reader.readBuffer(path), path);
  if (path.endsWith(".jsonl")) {
    const lines = (await reader.readBuffer(path)).toString("utf8").split(/\r?\n/).filter(line => line.trim());
    lines.forEach((line, index) => parseJson(Buffer.from(line), `${path}:${index + 1}`));
  }
}
const omitted = [...publishedModuleFiles].filter(path => !targetFiles.has(path));
if (omitted.length) throw new Error(`${mode} release target omits module files:\n${omitted.join("\n")}`);

let temporaryRoot = null;
try {
  const targetRoot = mode === "workspace" ? root : await mkdtemp(resolve(tmpdir(), "pi-rp-release-"));
  if (mode !== "workspace") {
    temporaryRoot = targetRoot;
    await materialize(reader, targetRoot);
    git(["-C", targetRoot, "init", "-q"], { encoding: "utf8" });
  }
  assertIgnoreRules(targetRoot, [...new Set([...required, ...publishedModuleFiles])]);
  runGeneratedChecks(manifest, targetRoot);
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Release manifest check passed for ${mode}: ${manifest.modules.length} modules, ${required.size} referenced paths, ${publishedModuleFiles.size} module files.`);
