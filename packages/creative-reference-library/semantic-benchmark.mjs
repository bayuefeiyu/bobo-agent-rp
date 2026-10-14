// Synthetic scan benchmark; no provider, model, credentials or community text.
import { mkdtemp, mkdir, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { LibraryClient } from "./client.mjs";
import { FORMAT, INDEX_VERSION } from "./contract.mjs";
import { normalizeSemanticConfig, indexFingerprint, spaceFingerprint, SEMANTIC_FORMAT, CHUNKER_VERSION, normalizedVector } from "./semantic-contract.mjs";
import { fileDigest } from "./semantic-index.mjs";
const count = Number(process.argv[2] || 10000), dimensions = Number(process.argv[3] || 384), rounds = Number(process.argv[4] || 10);
if (!Number.isInteger(count) || count < 1 || count > 100000 || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192 || count * dimensions * 4 > 536870912 || !Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("Usage: semantic-benchmark.mjs COUNT DIMENSIONS ROUNDS; at most 100000 vectors / 512MiB.");
const root = await mkdtemp(join(tmpdir(), "reference-vector-benchmark-")), generation = randomUUID(), semanticGeneration = randomUUID(); let client;
try {
  const formal = resolve(root, "versions", generation), directory = resolve(root, "semantic", "indexes", semanticGeneration);
  await mkdir(formal, { recursive: true }); await mkdir(directory, { recursive: true });
  const config = normalizeSemanticConfig({ enabled: true, embedding: { dimensions } });
  const manifest = { format: FORMAT, generation, packages: [], indexVersion: INDEX_VERSION };
  await writeFile(resolve(root, "library.json"), JSON.stringify(manifest)); await writeFile(resolve(formal, "manifest.json"), JSON.stringify(manifest));
  const db = new DatabaseSync(resolve(formal, "text.sqlite")), passages = new DatabaseSync(resolve(directory, "passages.sqlite"));
  db.exec("CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE units(id TEXT PRIMARY KEY,fingerprint TEXT); BEGIN");
  db.prepare("INSERT INTO meta VALUES(?,?)").run("generation", generation); db.prepare("INSERT INTO meta VALUES(?,?)").run("indexVersion", INDEX_VERSION);
  passages.exec("CREATE TABLE passages(id TEXT PRIMARY KEY,unitId TEXT,unitFingerprint TEXT,vectorIndex INTEGER UNIQUE,data TEXT); BEGIN");
  const insertUnit = db.prepare("INSERT INTO units VALUES(?,?)"), insertPassage = passages.prepare("INSERT INTO passages VALUES(?,?,?,?,?)");
  const file = await open(resolve(directory, "vectors.f32"), "w"), buffer = Buffer.alloc(dimensions * 4 * 256);
  let buffered = 0, seed = 123456;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let n = 0; n < count; n++) {
    const unitId = `u-${n}`, passageId = `p-${n}`, fingerprint = `synthetic-${n}`, vector = normalizedVector(Array.from({ length: dimensions }, random), dimensions);
    insertUnit.run(unitId, fingerprint);
    insertPassage.run(passageId, unitId, fingerprint, n, JSON.stringify({ id: passageId, unitId, unitFingerprint: fingerprint, unitRevision: 1, title: "Synthetic", content: "Original synthetic benchmark material.", input: "Synthetic benchmark", inputHash: fingerprint, ranges: [[0, 38]], relations: [] }));
    vector.forEach((value, index) => buffer.writeFloatLE(value, (buffered * dimensions + index) * 4)); buffered++;
    if (buffered === 256 || n === count - 1) { await file.write(buffer.subarray(0, buffered * dimensions * 4)); buffered = 0; }
  }
  await file.close(); db.exec("COMMIT"); passages.exec("COMMIT"); db.close(); passages.close();
  const semantic = { format: SEMANTIC_FORMAT, generation: semanticGeneration, sourceGeneration: generation, indexFingerprint: indexFingerprint(config), spaceFingerprint: spaceFingerprint(config), chunkerVersion: CHUNKER_VERSION, dimensions, count, vectorBytes: count * dimensions * 4, skippedBlocks: 0, vectorHash: await fileDigest(resolve(directory, "vectors.f32")), passagesHash: await fileDigest(resolve(directory, "passages.sqlite")) };
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(semantic)); await writeFile(resolve(root, "semantic", "active.json"), JSON.stringify({ generation: semanticGeneration }));
  client = new LibraryClient(); await client.open(root); const started = performance.now(); await client.openSemantic(root, config); const openMs = performance.now() - started;
  const timings = [], query = normalizedVector(Array.from({ length: dimensions }, random), dimensions);
  for (let n = 0; n < rounds; n++) { const start = performance.now(); const results = await client.semanticSearch(query, 60, { deadline: Date.now() + 30000 }); if (results.length !== Math.min(60, count)) throw new Error("Unexpected top-k"); timings.push(performance.now() - start); }
  const sorted = [...timings].sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({ count, dimensions, rounds, openMs, firstScanMs: timings[0], p50Ms: sorted[Math.floor((sorted.length - 1) * .5)], p95Ms: sorted[Math.ceil((sorted.length - 1) * .95)], vectorBytes: semantic.vectorBytes, rssBytes: process.memoryUsage().rss, scope: "synthetic exact cosine scan only; no embedding/rerank/end-to-end quality measurement" }) + "\n");
} finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
