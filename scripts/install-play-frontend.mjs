import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeFrontendManifest } from "../packages/rp-web-contract/frontend.mjs";
import { operations } from "../packages/rp-web-contract/operations.mjs";
import { validateRuntimePackage } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs";

const json = async file => JSON.parse(await readFile(file, "utf8"));
const digest = body => createHash("sha256").update(body).digest("hex");
function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Frontend operation escapes the selected card.");
  return path;
}
async function regularPath(root, file) {
  const target = inside(root, resolve(root, file));
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Linked frontend assets are forbidden.");
  }
  if (!(await lstat(target)).isFile()) throw new Error("Frontend asset must be a regular file.");
  return target;
}
async function listFiles(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Linked frontend assets are forbidden.");
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) found.push(relative(root, file).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return found.sort();
}
async function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}
const protectedFiles = files => Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith("web/frontends/") && name !== "web/frontend.json"));

export async function installPlayFrontend({ cardDirectory, packageDirectory = null, restore = null, replace = false }) {
  const card = resolve(cardDirectory);
  const validation = await validateRuntimePackage(card);
  if (!validation.ok) throw new Error(`Target must be a valid new-runtime card: ${validation.errors.join("; ")}`);
  const manifestPath = resolve(card, "web/frontend.json"), lockPath = resolve(card, "runtime-lock.json");
  const oldManifest = await readFile(manifestPath), oldLockBody = await readFile(lockPath), lock = JSON.parse(oldLockBody);
  const old = normalizeFrontendManifest(JSON.parse(oldManifest));
  if (!replace && old.kind === "custom") throw new Error("Target already has a custom frontend. Use --replace explicitly.");
  let frontend, entries = [], sourceRoot = null;
  if (restore) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(restore)) throw new Error("Invalid backup ID.");
    const backup = resolve(card, ".frontend-backups", restore);
    frontend = normalizeFrontendManifest(await json(await regularPath(card, relative(card, resolve(backup, "frontend.json")))));
    const previousLock = await json(await regularPath(card, relative(card, resolve(backup, "runtime-lock.json"))));
    if (JSON.stringify(protectedFiles(previousLock.files)) !== JSON.stringify(protectedFiles(lock.files))) throw new Error("Backup belongs to another platform/runtime; cross-runtime rollback is unsupported.");
    for (const asset of frontend.assets) await regularPath(card, `web/${frontend.root}/${asset}`);
  } else {
    const source = resolve(packageDirectory);
    frontend = normalizeFrontendManifest(await json(await regularPath(source, "frontend.json")));
    if (frontend.kind !== "custom") throw new Error("Only custom gameplay packages can be installed.");
    sourceRoot = inside(source, resolve(source, frontend.root));
    let directory = source;
    for (const part of frontend.root.split("/")) {
      directory = resolve(directory, part);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Frontend root must contain only regular directories.");
    }
    entries = await listFiles(sourceRoot);
    if (JSON.stringify(entries) !== JSON.stringify([...frontend.assets].sort())) throw new Error("Frontend asset inventory must exactly match the package files.");
    frontend.root = `frontends/${frontend.id}-${frontend.version}-${randomUUID()}`;
  }
  const supported = new Set(operations.map(operation => operation.id));
  const missing = frontend.requiredCapabilities.filter(capability => !supported.has(capability));
  if (missing.length) throw new Error(`Unknown required frontend capabilities: ${missing.join(", ")}`);
  const backupId = `frontend-${randomUUID()}`, backupDirectory = resolve(card, ".frontend-backups", backupId);
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(resolve(backupDirectory, "frontend.json"), oldManifest);
  await writeFile(resolve(backupDirectory, "runtime-lock.json"), oldLockBody);
  const journal = resolve(card, ".frontend-backups/pending.json");
  let installedRoot = null;
  await writeFile(journal, JSON.stringify({ backupId, newRoot: sourceRoot ? frontend.root : null }));
  try {
    if (sourceRoot) {
      const staging = resolve(backupDirectory, "staging");
      await mkdir(staging);
      for (const entry of entries) {
        const source = await regularPath(sourceRoot, entry), target = inside(staging, resolve(staging, entry));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(source));
      }
      installedRoot = inside(resolve(card, "web/frontends"), resolve(card, "web", frontend.root));
      await mkdir(dirname(installedRoot), { recursive: true });
      await rename(staging, installedRoot);
      for (const entry of entries) lock.files[`web/${frontend.root}/${entry}`] = digest(await readFile(resolve(installedRoot, entry)));
    }
    const manifestBody = Buffer.from(JSON.stringify(frontend, null, 2) + "\n");
    lock.files["web/frontend.json"] = digest(manifestBody);
    await atomicWrite(lockPath, JSON.stringify(lock, null, 2) + "\n");
    await atomicWrite(manifestPath, manifestBody);
    // pending journal is deliberately ignored only by this transaction's validator invocation.
    await rm(journal);
    const after = await validateRuntimePackage(card);
    if (!after.ok) throw new Error(`Installed frontend failed validation: ${after.errors.join("; ")}`);
    for (const [file, hash] of Object.entries(protectedFiles(JSON.parse(oldLockBody).files))) if (digest(await readFile(resolve(card, file))) !== hash) throw new Error(`Protected platform file changed: ${file}`);
    return { cardId: validation.cardId, frontendId: frontend.id, backupId, restartRequired: true };
  } catch (error) {
    await atomicWrite(manifestPath, oldManifest);
    await atomicWrite(lockPath, oldLockBody);
    if (installedRoot) await rm(inside(resolve(card, "web/frontends"), installedRoot), { recursive: true, force: true });
    await rm(journal, { force: true });
    throw error;
  }
}

export async function recoverFrontendInstall(cardDirectory) {
  const card = resolve(cardDirectory), journal = resolve(card, ".frontend-backups/pending.json");
  const pending = await json(journal);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pending.backupId)) throw new Error("Invalid recovery journal.");
  const backup = resolve(card, ".frontend-backups", pending.backupId);
  const manifest = await readFile(await regularPath(card, relative(card, resolve(backup, "frontend.json"))));
  const lock = await readFile(await regularPath(card, relative(card, resolve(backup, "runtime-lock.json"))));
  normalizeFrontendManifest(JSON.parse(manifest));
  if (pending.newRoot) {
    const descriptor = { ...JSON.parse(manifest), kind: "custom", root: pending.newRoot };
    normalizeFrontendManifest(descriptor);
    await rm(inside(resolve(card, "web/frontends"), resolve(card, "web", descriptor.root)), { recursive: true, force: true });
  }
  await atomicWrite(resolve(card, "web/frontend.json"), manifest);
  await atomicWrite(resolve(card, "runtime-lock.json"), lock);
  await rm(journal);
  return validateRuntimePackage(card);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [cardDirectory, packageDirectory] = process.argv.slice(2);
  const restoreIndex = process.argv.indexOf("--restore");
  console.log(JSON.stringify(process.argv.includes("--recover") ? await recoverFrontendInstall(cardDirectory) : await installPlayFrontend({ cardDirectory, packageDirectory, replace: process.argv.includes("--replace"), restore: restoreIndex >= 0 ? process.argv[restoreIndex + 1] : null }), null, 2));
}
