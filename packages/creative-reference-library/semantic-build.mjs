import { mkdir, readFile, writeFile, rename, rm, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fail, id } from "./contract.mjs";
import { openSnapshot, formalUnits } from "./core.mjs";
import { slicePassages } from "./passages.mjs";
import { normalizeSemanticConfig, configured, spaceFingerprint, indexFingerprint, digest, SEMANTIC_FORMAT, CHUNKER_VERSION } from "./semantic-contract.mjs";
import { createSemanticServices } from "./service-adapters.mjs";
import { fileDigest } from "./semantic-index.mjs";

export async function atomicJson(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
export async function buildSemanticIndex(root, inputConfig, { jobId = randomUUID(), resume = false, forceEncoding = false, secrets = {}, signal, fetchImpl, onProgress = async () => {}, queryPriority } = {}) {
  id(jobId); const config = normalizeSemanticConfig(inputConfig); if (!configured(config)) fail("semantic_configuration_incomplete");
  const base = resolve(root, "semantic"), directory = resolve(base, "jobs", jobId), lock = resolve(base, ".build-lock");
  await mkdir(base, { recursive: true });
  try { await mkdir(lock); } catch (error) { if (error.code === "EEXIST") fail("writer_busy"); throw error; }
  let db, cache, vectorFile, progress;
  try {
    await writeFile(resolve(lock, "owner.json"), JSON.stringify({ jobId, pid: process.pid }));
    let previous; if (resume) previous = JSON.parse(await readFile(resolve(directory, "job.json"), "utf8"));
    const snapshot = await openSnapshot(root, previous?.sourceGeneration, true);
    if (previous && (previous.indexFingerprint !== indexFingerprint(config) || previous.forceEncoding !== forceEncoding)) fail("resume_incompatible");
    await mkdir(directory, { recursive: true });
    progress = { jobId, sourceGeneration: snapshot.generation, indexFingerprint: indexFingerprint(config), forceEncoding, phase: "slicing", processedUnits: 0, passages: 0, encoded: 0, reused: 0, skippedBlocks: 0, status: "running", updatedAt: new Date().toISOString() };
    const update = async () => { progress.updatedAt = new Date().toISOString(); await atomicJson(resolve(directory, "job.json"), progress); await onProgress({ ...progress }); };
    const check = async () => { signal?.throwIfAborted(); if (await stat(resolve(directory, "cancel")).then(() => true, e => e.code === "ENOENT" ? false : Promise.reject(e))) fail("cancelled"); };
    await update();
    const cachePath = resolve(base, "cache.sqlite"); cache = new DatabaseSync(cachePath); cache.exec("CREATE TABLE IF NOT EXISTS vectors(key TEXT PRIMARY KEY, value BLOB)");
    const lookup = cache.prepare("SELECT value FROM vectors WHERE key=?"), store = cache.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?)");
    const dbPath = resolve(directory, "passages.sqlite"); await rm(dbPath, { force: true });
    db = new DatabaseSync(dbPath); db.exec("CREATE TABLE passages(id TEXT PRIMARY KEY, unitId TEXT,unitFingerprint TEXT,vectorIndex INTEGER UNIQUE,data TEXT); CREATE INDEX passageUnits ON passages(unitId,unitFingerprint)");
    const insert = db.prepare("INSERT INTO passages VALUES(?,?,?,?,?)");
    vectorFile = await open(resolve(directory, "vectors.f32"), "w"); let bytePosition = 0;
    const jobController = new AbortController(); const cancelPoll = setInterval(() => { stat(resolve(directory, "cancel")).then(() => jobController.abort(), () => {}); }, 250); cancelPoll.unref();
    const combined = signal ? AbortSignal.any([signal, jobController.signal]) : jobController.signal;
    const services = createSemanticServices(config, { ...secrets, fetchImpl, signal: combined, beforeRequest: async () => { await check(); while (queryPriority && Atomics.load(new Int32Array(queryPriority), 0)) { await new Promise(r => setTimeout(r, 25)); await check(); } } });
    const batch = []; let batchCharacters = 0;
    async function append(passage, bytes) {
      if (progress.passages + 1 > config.retrieval.maxVectors || bytePosition + bytes.length > config.retrieval.maxVectorBytes) fail("semantic_capacity_exceeded");
      await vectorFile.write(bytes, 0, bytes.length, bytePosition); insert.run(passage.id, passage.unitId, passage.unitFingerprint, progress.passages, JSON.stringify(passage)); bytePosition += bytes.length; progress.passages++;
    }
    async function flush() {
      if (!batch.length) return; await check(); progress.phase = "embedding"; await update();
      const vectors = await services.embed(batch.map(item => item.passage.input));
      for (let n = 0; n < batch.length; n++) { const bytes = Buffer.alloc(config.embedding.dimensions * 4); vectors[n].forEach((v, i) => bytes.writeFloatLE(v, i * 4)); store.run(batch[n].key, bytes); await append(batch[n].passage, bytes); progress.encoded++; }
      batch.length = 0; batchCharacters = 0; await update();
    }
    try {
      for await (const unit of formalUnits(root, snapshot)) {
        await check(); const sliced = slicePassages(unit, config); progress.skippedBlocks += sliced.skipped;
        for (const passage of sliced.passages) {
          const key = digest({ space: spaceFingerprint(config), input: passage.inputHash, force: forceEncoding ? jobId : "" });
          const bytes = lookup.get(key)?.value;
          if (bytes && bytes.length === config.embedding.dimensions * 4) { await append(passage, Buffer.from(bytes)); progress.reused++; }
          else { if (batch.length >= config.embedding.batchSize || batchCharacters + passage.input.length + config.embedding.documentPrefix.length > 250000) await flush(); batch.push({ key, passage }); batchCharacters += passage.input.length + config.embedding.documentPrefix.length; }
          if (progress.passages + batch.length > config.retrieval.maxVectors || bytePosition + batch.length * config.embedding.dimensions * 4 > config.retrieval.maxVectorBytes) fail("semantic_capacity_exceeded");
        }
        progress.processedUnits++; await update();
      }
      await flush(); await check(); progress.phase = "validating"; await update();
    } finally { clearInterval(cancelPoll); }
    await vectorFile.sync(); await vectorFile.close(); vectorFile = null; db.close(); db = null;
    const generation = randomUUID(), manifest = { format: SEMANTIC_FORMAT, generation, sourceGeneration: snapshot.generation, indexFingerprint: indexFingerprint(config), spaceFingerprint: spaceFingerprint(config), chunkerVersion: CHUNKER_VERSION, dimensions: config.embedding.dimensions, count: progress.passages, vectorBytes: bytePosition, skippedBlocks: progress.skippedBlocks, vectorHash: await fileDigest(resolve(directory, "vectors.f32")), passagesHash: await fileDigest(dbPath) };
    await atomicJson(resolve(directory, "manifest.json"), manifest); await check();
    const publishLock = resolve(base, ".publish-lock"); try { await mkdir(publishLock); } catch (error) { if (error.code === "EEXIST") fail("writer_busy"); throw error; }
    try {
      const indexDirectory = resolve(base, "indexes", generation); await mkdir(indexDirectory, { recursive: true });
      for (const file of ["vectors.f32", "passages.sqlite", "manifest.json"]) await rename(resolve(directory, file), resolve(indexDirectory, file));
      await check();
      await atomicJson(resolve(base, "active.json"), { format: SEMANTIC_FORMAT, generation });
    } finally { await rm(publishLock, { recursive: true, force: true }); }
    progress.status = "completed"; progress.phase = "completed"; progress.generation = generation; await update(); return { ...progress };
  } catch (error) {
    const cancelled = signal?.aborted || error.code === "cancelled" || error.name === "AbortError";
    if (progress) { progress.status = cancelled ? "cancelled" : "failed"; progress.errorCode = cancelled ? "cancelled" : error.code ?? "semantic_build_failed"; await atomicJson(resolve(directory, "job.json"), progress); await onProgress({ ...progress }); }
    if (cancelled) fail("cancelled"); throw error;
  } finally { await vectorFile?.close(); db?.close(); cache?.close(); await rm(lock, { recursive: true, force: true }); }
}
