import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

function safeRelativePath(value) {
  const path = String(value || "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
    throw new Error("Team read path must be a safe relative path.");
  }
  return path;
}

function safeDeliveryId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error("Team delivery id must be a safe catalog identifier.");
  }
  return id;
}

async function catalog(path) {
  return readFile(path, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function catalogAllows(entries, path) {
  return Array.isArray(entries) && entries.some(item => typeof item?.path === "string"
    && (path === item.path || item.kind === "directory" && path.startsWith(`${item.path.replace(/\/$/, "")}/`)));
}

async function assertRealContainment(base, target) {
  const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
  const relation = relative(realBase, realTarget);
  if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) {
    throw new Error("Team read path crosses a symbolic link outside its authorized root.");
  }
}

export async function readAuthorizedTeamMaterial({ path, teamRoot, teamNodeRoot, memberRoot, deliveryId = null, maxCharacters = 120000 }) {
  const relativePath = safeRelativePath(path);
  const memberPath = relativePath.startsWith("member/");
  const publishedPath = relativePath.startsWith("shared/") || relativePath.startsWith("speeches/") || relativePath.startsWith("rounds/");
  const [inputs, deliveries] = await Promise.all([
    catalog(resolve(teamRoot, "shared", "INPUTS.json")),
    deliveryId ? catalog(resolve(teamRoot, "shared", "deliveries", `${safeDeliveryId(deliveryId)}.json`)) : [],
  ]);
  const inputPath = catalogAllows(inputs, relativePath);
  const deliveredPath = catalogAllows(deliveries, relativePath);
  if (!memberPath && !publishedPath && !inputPath && !deliveredPath) {
    throw new Error("Team read path is outside the meeting areas and the declared input/delivery catalogs.");
  }
  const base = memberPath ? memberRoot : inputPath ? teamNodeRoot : teamRoot;
  const local = memberPath ? relativePath.slice("member/".length) : relativePath;
  const target = resolve(base, local);
  const targetRelative = relative(base, target);
  if (!targetRelative || targetRelative.startsWith("..") || targetRelative.includes(`..${sep}`)) throw new Error("Team read path escapes its authorized root.");
  await assertRealContainment(base, target);
  const content = await readFile(target, "utf8");
  if (content.length > maxCharacters) throw new Error("Team material exceeds the per-read technical limit; read a narrower declared document.");
  return { path: relativePath, content, characters: content.length };
}

export async function readDeclaredTeamDocuments({ documents, nodeWorkspace, maxCharacters = 30000 }) {
  let remaining = Math.max(1000, Math.min(Number.isSafeInteger(maxCharacters) ? maxCharacters : 30000, 100000));
  const result = [];
  for (const [id, declared] of Object.entries(documents || {})) {
    const relativePath = safeRelativePath(declared);
    const target = resolve(nodeWorkspace, relativePath);
    const relation = relative(nodeWorkspace, target);
    if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error(`Team tool document ${id} escapes the team workspace.`);
    await assertRealContainment(nodeWorkspace, target);
    const original = await readFile(target, "utf8");
    const content = original.slice(0, remaining);
    remaining -= content.length;
    result.push({ id, path: relativePath, content, truncated: content.length < original.length });
    if (remaining <= 0) break;
  }
  return result;
}
