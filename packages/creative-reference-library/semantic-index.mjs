import { readFile, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { id, fail } from "./contract.mjs";
import { SEMANTIC_FORMAT, CHUNKER_VERSION, indexFingerprint } from "./semantic-contract.mjs";

export async function fileDigest(path) {
  const hash = createHash("sha256"), file = await open(path, "r");
  try { const buffer = Buffer.alloc(1048576); let position = 0; while (true) { const { bytesRead } = await file.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; } return hash.digest("hex"); }
  finally { await file.close(); }
}
export async function semanticManifest(root, generation) {
  const pointer = generation ? { generation: id(generation) } : JSON.parse(await readFile(resolve(root, "semantic", "active.json"), "utf8"));
  id(pointer.generation);
  const directory = resolve(root, "semantic", "indexes", pointer.generation), manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  if (manifest.format !== SEMANTIC_FORMAT || manifest.generation !== pointer.generation || manifest.chunkerVersion !== CHUNKER_VERSION || !Number.isSafeInteger(manifest.count) || manifest.count < 0 || manifest.count > 100000 || !Number.isSafeInteger(manifest.dimensions) || manifest.dimensions < 1 || manifest.dimensions > 8192 || manifest.vectorBytes !== manifest.count * manifest.dimensions * 4 || manifest.vectorBytes > 536870912) fail("semantic_index_incompatible");
  if ((await stat(resolve(directory, "vectors.f32"))).size !== manifest.vectorBytes) fail("semantic_index_corrupt");
  return { ...manifest, directory };
}
export class SemanticReader {
  static async create(root, snapshot, config, generation) {
    const manifest = await semanticManifest(root, generation);
    if (manifest.indexFingerprint !== indexFingerprint(config)) fail("semantic_index_incompatible");
    if (await fileDigest(resolve(manifest.directory, "vectors.f32")) !== manifest.vectorHash || await fileDigest(resolve(manifest.directory, "passages.sqlite")) !== manifest.passagesHash) fail("semantic_index_corrupt");
    return new SemanticReader(root, snapshot, manifest);
  }
  constructor(root, snapshot, manifest) {
    this.manifest = manifest;
    this.db = new DatabaseSync(resolve(manifest.directory, "passages.sqlite"), { readOnly: true });
    try {
      this.db.prepare("ATTACH DATABASE ? AS formal").run(resolve(root, "versions", snapshot.generation, "text.sqlite"));
      this.rows = this.db.prepare("SELECT p.vectorIndex,p.id,p.unitId FROM passages p JOIN formal.units u ON u.id=p.unitId AND u.fingerprint=p.unitFingerprint ORDER BY p.vectorIndex").all();
      if (this.db.prepare("SELECT count(*) n FROM passages").get().n !== manifest.count || this.rows.some(row => row.vectorIndex < 0 || row.vectorIndex >= manifest.count)) fail("semantic_index_corrupt");
      this.allowed = new Set(this.rows.map(row => row.id));
      const totalUnits = this.db.prepare("SELECT count(*) n FROM formal.units").get().n;
      const coveredUnits = new Set(this.rows.map(row => row.unitId)).size;
      this.coverage = { totalUnits, coveredUnits, validPassages: this.rows.length, indexedPassages: manifest.count, skippedBlocks: manifest.skippedBlocks, partial: totalUnits !== coveredUnits || this.rows.length !== manifest.count || manifest.skippedBlocks > 0 };
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  passage(passageId) { if (!this.allowed.has(id(passageId))) fail("selection_invalid"); const row = this.db.prepare("SELECT data FROM passages WHERE id=?").get(passageId); if (!row) fail("selection_invalid"); return JSON.parse(row.data); }
  inspect(passageId) { const value = this.passage(passageId); const { content, input, ...metadata } = value; return { ...metadata, characters: content.length }; }
  async search(vector, limit, { signal, deadline = Infinity, cancelled } = {}) {
    const dimensions = this.manifest.dimensions;
    if (!(Array.isArray(vector) || vector instanceof Float32Array) || vector.length !== dimensions || vector.some(n => typeof n !== "number" || !Number.isFinite(n))) fail("invalid_embedding");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("invalid_request");
    const file = await open(resolve(this.manifest.directory, "vectors.f32"), "r"), top = [];
    // Sequential blocks, with validity checked before top-k insertion. Invalid
    // old hits cannot crowd out unchanged content from the current snapshot.
    const blockSize = Math.max(1, Math.floor(1048576 / (dimensions * 4))), buffer = Buffer.alloc(blockSize * dimensions * 4);
    let cursor = 0;
    try {
      for (let start = 0; start < this.manifest.count; start += blockSize) {
        signal?.throwIfAborted(); if (cancelled && Atomics.load(new Int32Array(cancelled), 0)) fail("cancelled"); if (Date.now() > deadline) fail("query_timeout");
        const count = Math.min(blockSize, this.manifest.count - start), expected = count * dimensions * 4;
        const { bytesRead } = await file.read(buffer, 0, expected, start * dimensions * 4); if (bytesRead !== expected) fail("semantic_index_corrupt");
        while (cursor < this.rows.length && this.rows[cursor].vectorIndex < start + count) {
          const row = this.rows[cursor++], offset = (row.vectorIndex - start) * dimensions * 4; let score = 0;
          for (let j = 0; j < dimensions; j++) { const n = buffer.readFloatLE(offset + j * 4); if (!Number.isFinite(n)) fail("semantic_index_corrupt"); score += n * vector[j]; }
          if (top.length < limit || score > top.at(-1).score) { top.push({ id: row.id, unitId: row.unitId, score }); top.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); if (top.length > limit) top.pop(); }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return top.map(row => ({ ...this.passage(row.id), vectorScore: row.score }));
    } finally { await file.close(); }
  }
}
