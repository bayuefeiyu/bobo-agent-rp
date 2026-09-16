import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { withDataCommitLock } from "./rp-data-changes.mjs";
import { buildIdentityEntries } from "./rp-data-index.mjs";
import { readDataReceipt } from "./rp-data-transactions.mjs";

function safeResolve(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Data read view path escapes its root.");
  return target;
}

function safeViewId(value) {
  if (typeof value !== "string" || !value) throw new Error("Data read view requires a stable source identity.");
  return createHash("sha256").update(value).digest("hex");
}

function collectionKey(moduleId, collectionId) {
  return `${moduleId}/${collectionId}`;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function recordsAtBoundary(store, module, collectionId, state, visibleThroughTurn, visibleThroughTime) {
  if (!Number.isSafeInteger(visibleThroughTurn) && !(typeof visibleThroughTime === "string" && visibleThroughTime)) return state.records;
  const collection = module.contract.collections[collectionId];
  const source = [...state.history, ...state.records];
  if (collection.storage.initialSnapshotFile) {
    const initial = await readFile(resolve(module.moduleDirectory, collection.storage.initialSnapshotFile), "utf8").then(JSON.parse);
    source.push(...(Array.isArray(initial) ? initial : [initial]));
  }
  const latest = new Map();
  for (const record of source) {
    if (Number.isSafeInteger(visibleThroughTurn) && (record.binding?.turn || 0) > visibleThroughTurn) continue;
    if (typeof visibleThroughTime === "string" && visibleThroughTime && typeof record.updatedAt === "string" && record.updatedAt > visibleThroughTime) continue;
    const prior = latest.get(record.id);
    if (!prior || record.revision > prior.revision) latest.set(record.id, record);
  }
  return [...latest.values()].filter(record => record.status === "active");
}

export async function createDataReadView({ sessionDirectory, store, sourceId, visibleThroughTurn = null, visibleThroughTime = null }) {
  const viewId = safeViewId(sourceId);
  const viewsRoot = safeResolve(sessionDirectory, "workspace", "data-read-views");
  const root = safeResolve(viewsRoot, viewId);
  const manifestPath = safeResolve(root, "manifest.json");
  const existing = await readFile(manifestPath, "utf8").then(JSON.parse).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.schemaVersion === 1 && existing.viewId === viewId) return structuredClone(existing);
  return withDataCommitLock(sessionDirectory, async () => {
    const replay = await readFile(manifestPath, "utf8").then(JSON.parse).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (replay?.schemaVersion === 1 && replay.viewId === viewId) return structuredClone(replay);
    const staging = safeResolve(viewsRoot, `${viewId}.building-${randomUUID()}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const collections = [];
    try {
      for (const module of [...store.modules.values()].sort((left, right) => left.contract.moduleId.localeCompare(right.contract.moduleId))) {
        for (const collectionId of Object.keys(module.contract.collections).sort()) {
          const state = await store.readCollection(module.contract.moduleId, collectionId);
          const records = await recordsAtBoundary(store, module, collectionId, state, visibleThroughTurn, visibleThroughTime);
          const file = `${createHash("sha256").update(collectionKey(module.contract.moduleId, collectionId)).digest("hex")}.json`;
          await writeFile(safeResolve(staging, file), `${JSON.stringify({ schemaVersion: 1, moduleId: module.contract.moduleId, collectionId, records }, null, 2)}\n`, "utf8");
          collections.push({ moduleId: module.contract.moduleId, collectionId, file, records: records.length });
        }
      }
      const manifest = { schemaVersion: 1, viewId, sourceId, visibleThroughTurn, visibleThroughTime, createdAt: new Date().toISOString(), collections };
      await writeFile(safeResolve(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await mkdir(dirname(root), { recursive: true });
      await rm(root, { recursive: true, force: true });
      await rename(staging, root);
      return structuredClone(manifest);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

export async function readDataReadViewCollection({ sessionDirectory, store, viewId, batchIds = [], moduleId, collectionId }) {
  const root = safeResolve(sessionDirectory, "workspace", "data-read-views", viewId);
  const manifest = await json(safeResolve(root, "manifest.json"));
  if (manifest?.schemaVersion !== 1 || manifest.viewId !== viewId) throw Object.assign(new Error(`Data read view ${viewId} is invalid.`), { code: "data_read_view_invalid" });
  const declared = manifest.collections.find(item => item.moduleId === moduleId && item.collectionId === collectionId);
  if (!declared) throw Object.assign(new Error(`Data read view ${viewId} does not contain ${moduleId}/${collectionId}.`), { code: "data_read_view_scope_error" });
  const base = await json(safeResolve(root, declared.file));
  const records = new Map((base.records || []).map(record => [record.id, structuredClone(record)]));
  for (const batchId of [...new Set(batchIds || [])]) {
    const receipt = await readDataReceipt(sessionDirectory, batchId);
    if (!receipt || !["committed", "partial"].includes(receipt.status)) {
      throw Object.assign(new Error(`Data read view batch ${batchId} is missing or not committed.`), { code: "data_read_view_incomplete" });
    }
    for (const result of receipt.results || []) {
      if (result.status !== "committed" || result.moduleId !== moduleId || result.collectionId !== collectionId) continue;
      if (result.action === "delete") {
        records.delete(result.recordId);
        continue;
      }
      if (!result.record || result.record.id !== result.recordId) {
        throw Object.assign(new Error(`Data read view batch ${batchId} lacks the committed record image for ${moduleId}/${collectionId}/${result.recordId}.`), { code: "data_read_view_incomplete" });
      }
      records.set(result.recordId, structuredClone(result.record));
    }
  }
  return { history: [], records: [...records.values()] };
}

export async function resolveDataReadViewIdentity({ sessionDirectory, store, viewId, batchIds = [], value }) {
  if (typeof value !== "string" || !value.trim()) return [];
  const entries = [];
  for (const module of store.modules.values()) {
    const records = [];
    for (const collectionId of Object.keys(module.contract.collections)) {
      const state = await readDataReadViewCollection({ sessionDirectory, store, viewId, batchIds, moduleId: module.contract.moduleId, collectionId });
      records.push(...state.records);
    }
    entries.push(...buildIdentityEntries(records, module.contract));
  }
  const needle = value.trim().toLocaleLowerCase();
  return entries.filter(entry => entry.id === value || entry.name.toLocaleLowerCase() === needle || entry.aliases.some(alias => alias.toLocaleLowerCase() === needle));
}

export async function deleteDataReadView({ sessionDirectory, viewId }) {
  if (typeof viewId !== "string" || !/^[a-f0-9]{64}$/.test(viewId)) throw new Error("Data read view ID is invalid.");
  await rm(safeResolve(sessionDirectory, "workspace", "data-read-views", viewId), { recursive: true, force: true });
}
