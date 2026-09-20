import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDataIndex, buildIdentityEntries, extractRecordIndexes } from "./rp-data-index.mjs";
import { withDataCommitLock } from "./rp-data-changes.mjs";
import { renderCardText, renderCardTextValues } from "./rp-card-text.mjs";
import { parseDataRecordLines, toDataRecordLines, validateDataRecord } from "./rp-data-records.mjs";
import { validateJsonSchema } from "./rp-data-schema.mjs";
import { commitDataFiles, recoverDataTransactions } from "./rp-data-transactions.mjs";

function safeResolve(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Data path escapes its root.");
  return target;
}

async function json(path, fallback = null) {
  return readFile(path, "utf8").then(JSON.parse).catch(error => {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  });
}

async function text(path, fallback = "") {
  return readFile(path, "utf8").catch(error => {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  });
}

/**
 * Read a rebuildable JSON document, treating an unreadable one exactly like an absent one.
 *
 * Derived files — the per-module index and the identity registry — are rebuilt from authoritative
 * records, so a truncated file must not fail the query that happens to read it first. The damage is
 * still announced: repairing it silently would hide whatever corrupted it, and the rebuild then
 * overwrites the only evidence.
 *
 * Authoritative files (snapshot.json, history partitions, initial records) deliberately keep using
 * `json`, where a parse error stays an error.
 */
async function derivedJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.warn(`${label} was unreadable (${error instanceof Error ? error.message : String(error)}); rebuilding it from authoritative records.`);
    return null;
  }
}

function latestRecords(history) {
  const latest = new Map();
  for (const record of history) {
    const current = latest.get(record.id);
    if (!current || record.revision > current.revision || (record.revision === current.revision && record.sequence > current.sequence)) latest.set(record.id, record);
  }
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function mergeDefined(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = mergeDefined(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

function identityDocument(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Registered identity ID ${entry.id} is duplicated across modules.`);
    ids.add(entry.id);
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), entries };
}

function partitionName(record, contract, collectionId) {
  const partition = contract.collections[collectionId].storage.partition;
  if (partition.mode === "single") return "all";
  if (partition.mode === "turn-range") {
    const start = Math.floor(record.binding.turn / partition.size) * partition.size;
    return `turn-${String(start).padStart(8, "0")}-${String(start + partition.size - 1).padStart(8, "0")}`;
  }
  const values = extractRecordIndexes(record, contract);
  const raw = values[partition.index] ?? partition.fallback;
  const key = Array.isArray(raw) ? raw[0] ?? partition.fallback : raw;
  const readable = String(key).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unassigned";
  const hash = createHash("sha256").update(String(key)).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

export class RpDataStore {
  constructor({ sessionDirectory, modules, initialOverrides = {}, playerName = null }) {
    this.sessionDirectory = resolve(sessionDirectory);
    this.modules = new Map(modules.map(module => [module.contract.moduleId, module]));
    this.initialOverrides = initialOverrides && typeof initialOverrides === "object" && !Array.isArray(initialOverrides) ? structuredClone(initialOverrides) : {};
    this.playerName = playerName;
    this.processorCache = new Map();
    this.schemaCache = new Map();
  }

  async validateRecordData(record) {
    const module = this.module(record.moduleId);
    const definition = module.contract.collections[record.collectionId]?.recordTypes?.[record.recordType];
    if (!definition?.schemaFile) return record;
    const key = `${record.moduleId}/${record.collectionId}/${record.recordType}`;
    let schema = this.schemaCache.get(key);
    if (!schema) {
      schema = await json(safeResolve(module.moduleDirectory, definition.schemaFile));
      if (!schema) throw new Error(`Data schema ${definition.schemaFile} is missing or invalid.`);
      this.schemaCache.set(key, schema);
    }
    const errors = validateJsonSchema(record.data, schema);
    if (errors.length) throw Object.assign(new Error(`Record ${record.id} data schema validation failed: ${JSON.stringify(errors)}`), { code: "data_schema_invalid", validationErrors: errors });
    return record;
  }

  async operationHandler(moduleId, collectionId, recordType, action) {
    const module = this.module(moduleId);
    const processor = module.contract.collections[collectionId]?.recordTypes?.[recordType]?.processors?.[action];
    if (!processor) return null;
    const key = `${moduleId}/${collectionId}/${recordType}/${action}`;
    if (this.processorCache.has(key)) return this.processorCache.get(key);
    const path = safeResolve(module.moduleDirectory, processor.file);
    const loaded = await import(pathToFileURL(path).href);
    const handler = loaded[processor.export];
    if (typeof handler !== "function") throw new Error(`Data processor ${key} must export ${processor.export}().`);
    this.processorCache.set(key, handler);
    return handler;
  }

  module(moduleId) {
    const module = this.modules.get(moduleId);
    if (!module) throw new Error(`Unknown data module ${moduleId}.`);
    return module;
  }

  collectionRoot(moduleId, collectionId) {
    const module = this.module(moduleId);
    if (!module.contract.collections[collectionId]) throw new Error(`Unknown collection ${moduleId}/${collectionId}.`);
    return safeResolve(this.sessionDirectory, "modules", moduleId, "collections", collectionId);
  }

  renderSeedRecord(record, label) {
    if (!this.playerName) {
      if (["{{user}}", "{{char}}", "<user>", "<char>", "<bot>"].some(macro => JSON.stringify(record).includes(macro))) {
        throw new Error(`${label} contains a name macro but this data store has no session player name.`);
      }
      return record;
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "data" || key === "note") continue;
      if (typeof value === "string" && ["{{user}}", "{{char}}", "<user>", "<char>", "<bot>"].some(macro => value.includes(macro))) {
        throw new Error(`${label}.${key} contains a macro in a structural field.`);
      }
    }
    return { ...record, data: renderCardTextValues(record.data, this.playerName, `${label}.data`), note: typeof record.note === "string" ? renderCardText(record.note, this.playerName, `${label}.note`) : record.note };
  }

  async resolveSessionPlayerName() {
    if (this.playerName) return this.playerName;
    const metadata = await json(safeResolve(this.sessionDirectory, "session.json"), null);
    if (typeof metadata?.playerName === "string" && metadata.playerName.trim()) this.playerName = metadata.playerName;
    return this.playerName;
  }

  async initialize() {
    await recoverDataTransactions(this.sessionDirectory);
    for (const module of this.modules.values()) {
      for (const [collectionId, collection] of Object.entries(module.contract.collections)) {
        const root = this.collectionRoot(module.contract.moduleId, collectionId);
        await mkdir(safeResolve(root, "records"), { recursive: true });
        const history = await this.#readHistory(root, module.contract);
        const snapshot = await json(safeResolve(root, "snapshot.json"), null);
        if (history.length || snapshot) continue;
        let initialRecords = [];
        if (collection.storage.initialRecordsFile) {
          const value = await json(safeResolve(module.moduleDirectory, collection.storage.initialRecordsFile), []);
          if (!Array.isArray(value)) throw new Error(`${module.contract.moduleId}/${collectionId} initial records must be an array.`);
          initialRecords = value.map((record, index) => validateDataRecord(this.renderSeedRecord(record, `${module.contract.moduleId}/${collectionId}/initialRecords[${index}]`), module.contract));
          for (const record of initialRecords) await this.validateRecordData(record);
        }
        let initialSnapshot = [];
        if (collection.storage.initialSnapshotFile) {
          const value = await json(safeResolve(module.moduleDirectory, collection.storage.initialSnapshotFile), []);
          initialSnapshot = (Array.isArray(value) ? value : [value]).map((record, index) => validateDataRecord(this.renderSeedRecord(record, `${module.contract.moduleId}/${collectionId}/initialSnapshot[${index}]`), module.contract));
          const override = collectionId === "settings" ? this.initialOverrides[module.contract.moduleId] : null;
          if (override && initialSnapshot.length) initialSnapshot[0] = { ...initialSnapshot[0], data: mergeDefined(initialSnapshot[0].data, this.playerName ? renderCardTextValues(override, this.playerName, `${module.contract.moduleId}/settings/override`) : override) };
          for (const record of initialSnapshot) await this.validateRecordData(record);
        }
        const files = this.stateFiles(module.contract.moduleId, collectionId, { history: initialRecords, records: initialSnapshot.length ? initialSnapshot : latestRecords(initialRecords) });
        for (const file of files) {
          await mkdir(resolve(file.path, ".."), { recursive: true });
          await writeFile(file.path, file.content, "utf8");
        }
      }
    }
    await this.rebuildIndexes();
  }

  async #readHistory(root, contract) {
    const recordsRoot = safeResolve(root, "records");
    const names = await readdir(recordsRoot).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error));
    const history = [];
    for (const name of names.filter(name => name.endsWith(".jsonl")).sort()) {
      history.push(...parseDataRecordLines(await text(safeResolve(recordsRoot, name)), contract));
    }
    return history;
  }

  async readCollection(moduleId, collectionId) {
    await this.resolveSessionPlayerName();
    const module = this.module(moduleId);
    const collection = module.contract.collections[collectionId];
    if (!collection) throw new Error(`Unknown collection ${moduleId}/${collectionId}.`);
    const root = this.collectionRoot(moduleId, collectionId);
    let history = collection.storage.kind === "snapshot" ? [] : await this.#readHistory(root, module.contract);
    if (collection.storage.kind === "hybrid" && collection.storage.initialSnapshotFile) {
      const initial = await json(safeResolve(module.moduleDirectory, collection.storage.initialSnapshotFile), []);
      const seeded = (Array.isArray(initial) ? initial : [initial]).map((record, index) => validateDataRecord(this.renderSeedRecord(record, `${moduleId}/${collectionId}/initialSnapshot[${index}]`), module.contract));
      const override = collectionId === "settings" ? this.initialOverrides[moduleId] : null;
      if (override && seeded.length) seeded[0] = { ...seeded[0], data: mergeDefined(seeded[0].data, this.playerName ? renderCardTextValues(override, this.playerName, `${moduleId}/settings/override`) : override) };
      const identities = new Set(history.map(record => `${record.id}:${record.revision}`));
      history = [...seeded.filter(record => !identities.has(`${record.id}:${record.revision}`)), ...history];
    }
    const snapshot = collection.storage.kind === "record-log" ? null : await json(safeResolve(root, "snapshot.json"), []);
    const records = snapshot === null ? latestRecords(history) : (Array.isArray(snapshot) ? snapshot : [snapshot]).map(record => validateDataRecord(record, module.contract));
    for (const record of records) await this.validateRecordData(record);
    return { history, records };
  }

  async authorityFileForRecord(moduleId, collectionId, recordId) {
    const module = this.module(moduleId);
    const collection = module.contract.collections[collectionId];
    if (!collection || collection.storage.kind === "snapshot") throw new Error(`Collection ${moduleId}/${collectionId} has no record-log authority file.`);
    const state = await this.readCollection(moduleId, collectionId);
    const record = state.records.find(item => item.id === recordId);
    if (!record) throw new Error(`Record ${recordId} was not found.`);
    return safeResolve(this.collectionRoot(moduleId, collectionId), "records", `${partitionName(record, module.contract, collectionId)}.jsonl`);
  }

  stateFiles(moduleId, collectionId, state) {
    const module = this.module(moduleId);
    const collection = module.contract.collections[collectionId];
    const root = this.collectionRoot(moduleId, collectionId);
    const files = [];
    if (collection.storage.kind !== "snapshot") {
      const groups = new Map();
      for (const record of state.history) {
        const name = partitionName(record, module.contract, collectionId);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(record);
      }
      for (const [name, records] of groups) files.push({ path: safeResolve(root, "records", `${name}.jsonl`), content: toDataRecordLines(records) });
      if (groups.size === 0) files.push({ path: safeResolve(root, "records", "all.jsonl"), content: "" });
    }
    if (collection.storage.kind !== "record-log") {
      files.push({ path: safeResolve(root, "snapshot.json"), content: `${JSON.stringify(state.records, null, 2)}\n` });
    }
    return files;
  }

  async rebuildIndexes() {
    const root = safeResolve(this.sessionDirectory, "indexes");
    await mkdir(root, { recursive: true });
    const identities = [];
    for (const module of this.modules.values()) {
      const records = [];
      for (const collectionId of Object.keys(module.contract.collections)) records.push(...(await this.readCollection(module.contract.moduleId, collectionId)).records);
      await writeFile(safeResolve(root, `${module.contract.moduleId}.json`), `${JSON.stringify(buildDataIndex(records, module.contract), null, 2)}\n`, "utf8");
      identities.push(...buildIdentityEntries(records, module.contract));
    }
    await writeFile(safeResolve(root, "identities.json"), `${JSON.stringify(identityDocument(identities), null, 2)}\n`, "utf8");
  }

  async resolveIdentity(value) {
    if (typeof value !== "string" || !value.trim()) return [];
    let registry = await derivedJson(safeResolve(this.sessionDirectory, "indexes", "identities.json"), "indexes/identities.json");
    if (!registry) {
      await this.rebuildIndexes();
      registry = await json(safeResolve(this.sessionDirectory, "indexes", "identities.json"), { entries: [] });
    }
    const needle = value.trim().toLocaleLowerCase();
    return registry.entries.filter(entry => entry.id === value || entry.name.toLocaleLowerCase() === needle || entry.aliases.some(alias => alias.toLocaleLowerCase() === needle));
  }

  async readIndex(moduleId) {
    const module = this.module(moduleId);
    const path = safeResolve(this.sessionDirectory, "indexes", `${moduleId}.json`);
    let index = await derivedJson(path, `indexes/${moduleId}.json`);
    if (!index) {
      const records = [];
      for (const collectionId of Object.keys(module.contract.collections)) records.push(...(await this.readCollection(moduleId, collectionId)).records);
      index = buildDataIndex(records, module.contract);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    }
    return index;
  }

  async commit(batchId, changedStates, receipt) {
    const files = [];
    for (const state of changedStates.values()) {
      const stateFiles = this.stateFiles(state.moduleId, state.collectionId, state);
      files.push(...stateFiles);
      const recordsRoot = safeResolve(this.collectionRoot(state.moduleId, state.collectionId), "records");
      const existing = await readdir(recordsRoot).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error));
      const written = new Set(stateFiles.map(file => resolve(file.path)));
      for (const name of existing.filter(name => name.endsWith(".jsonl"))) {
        const path = safeResolve(recordsRoot, name);
        if (!written.has(resolve(path))) files.push({ path, content: "" });
      }
    }
    const modules = new Set([...changedStates.values()].map(state => state.moduleId));
    for (const moduleId of modules) {
      const module = this.module(moduleId);
      const records = [];
      for (const collectionId of Object.keys(module.contract.collections)) {
        const key = `${moduleId}/${collectionId}`;
        const state = changedStates.get(key) || { ...(await this.readCollection(moduleId, collectionId)), moduleId, collectionId };
        records.push(...state.records);
      }
      files.push({ path: safeResolve(this.sessionDirectory, "indexes", `${moduleId}.json`), content: `${JSON.stringify(buildDataIndex(records, module.contract), null, 2)}\n` });
    }
    const identities = [];
    for (const module of this.modules.values()) {
      const records = [];
      for (const collectionId of Object.keys(module.contract.collections)) {
        const key = `${module.contract.moduleId}/${collectionId}`;
        const state = changedStates.get(key) || await this.readCollection(module.contract.moduleId, collectionId);
        records.push(...state.records);
      }
      identities.push(...buildIdentityEntries(records, module.contract));
    }
    files.push({ path: safeResolve(this.sessionDirectory, "indexes", "identities.json"), content: `${JSON.stringify(identityDocument(identities), null, 2)}\n` });
    return commitDataFiles(this.sessionDirectory, batchId, files, receipt);
  }

  async pruneByMessageIds(messageIds) {
    const removed = new Set(messageIds || []);
    if (!removed.size) return null;
    // Read-modify-write of every collection must hold the same commit lock a batch takes, otherwise a
    // concurrent agent submit can be overwritten by a prune that read the collections before it landed.
    return withDataCommitLock(this.sessionDirectory, async () => {
      const states = new Map();
      for (const module of this.modules.values()) {
        for (const collectionId of Object.keys(module.contract.collections)) {
          const state = await this.readCollection(module.contract.moduleId, collectionId);
          const history = state.history.filter(record => !record.binding.messageId || !removed.has(record.binding.messageId));
          // Prune whichever source is authoritative for this collection, exactly as reading does. A
          // hybrid collection's authority is its snapshot, so deriving `records` from history would
          // write back every record that a lifecycle `delete` had already removed from the snapshot.
          const records = module.contract.collections[collectionId].storage.kind === "record-log"
            ? latestRecords(history)
            : state.records.filter(record => !record.binding.messageId || !removed.has(record.binding.messageId));
          if (history.length !== state.history.length || records.length !== state.records.length) {
            states.set(`${module.contract.moduleId}/${collectionId}`, { moduleId: module.contract.moduleId, collectionId, history, records });
          }
        }
      }
      if (!states.size) return null;
      const batchId = `prune-${Date.now()}-${randomUUID()}`;
      return this.commit(batchId, states, { schemaVersion: 1, batchId, status: "committed", committedAt: new Date().toISOString(), reason: "message_suffix_prune", results: [] });
    });
  }
}
