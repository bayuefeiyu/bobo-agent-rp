import { createHash } from "node:crypto";
import { exact, fail, normalizeRequest } from "./contract.mjs";

export const SEMANTIC_FORMAT = "creative-reference-semantic-index/v1";
export const CHUNKER_VERSION = "markdown-blocks-utf8/v1";
export const digest = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const SEMANTIC_BUDGET = Object.freeze({ embeddingCalls: 4, rerankCalls: 4, rerankDocuments: 120, rerankCharacters: 120000, scanValues: 400000000, scanBytes: 2147483648 });
export const DEFAULT_SEMANTIC_CONFIG = Object.freeze({
  schemaVersion: 1, enabled: false,
  embedding: { protocol: "embeddings", url: "", model: "", spaceRevision: "1", dimensions: 384, queryPrefix: "", documentPrefix: "", maxInputCharacters: 8192, batchSize: 16, timeoutMs: 30000 },
  rerank: { protocol: "cohere-rerank", url: "", model: "", maxInputCharacters: 8192, timeoutMs: 30000, minScore: null },
  chunking: { targetCharacters: 800, maxCharacters: 1200, overlapCharacters: 120 },
  retrieval: { candidates: 60, maxPerUnit: 2, maxVectors: 100000, maxVectorBytes: 536870912, deadlineMs: 30000 },
});
function integer(value, minimum, maximum, name) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("invalid_request", `Invalid ${name}.`); return value; }
export function normalizeSemanticConfig(input = {}) {
  exact(input, Object.keys(DEFAULT_SEMANTIC_CONFIG), "semantic configuration");
  const config = structuredClone(DEFAULT_SEMANTIC_CONFIG);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail("invalid_request");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail("invalid_request");
  config.enabled = input.enabled ?? false;
  for (const group of ["embedding", "rerank", "chunking", "retrieval"]) { const supplied = input[group] === undefined ? {} : input[group]; exact(supplied, Object.keys(config[group]), group); Object.assign(config[group], supplied); }
  for (const group of ["embedding", "rerank"]) {
    const service = config[group];
    for (const key of ["url", "model"]) if (typeof service[key] !== "string" || service[key].length > 2000) fail("invalid_request");
    if (service.url) { let url; try { url = new URL(service.url); } catch { fail("invalid_request", "Invalid service URL."); } if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("invalid_request"); }
    integer(service.maxInputCharacters, 128, 100000, "input limit"); integer(service.timeoutMs, 100, 120000, "service timeout");
  }
  if (config.embedding.protocol !== "embeddings" || config.rerank.protocol !== "cohere-rerank") fail("invalid_request", "Unsupported semantic service protocol.");
  for (const key of ["spaceRevision", "queryPrefix", "documentPrefix"]) if (typeof config.embedding[key] !== "string" || config.embedding[key].length > 1000) fail("invalid_request");
  if (!config.embedding.spaceRevision) fail("invalid_request");
  integer(config.embedding.dimensions, 1, 8192, "dimensions"); integer(config.embedding.batchSize, 1, 128, "batch size");
  if (config.rerank.minScore !== null && (typeof config.rerank.minScore !== "number" || !Number.isFinite(config.rerank.minScore))) fail("invalid_request");
  integer(config.chunking.targetCharacters, 64, 10000, "chunk target"); integer(config.chunking.maxCharacters, config.chunking.targetCharacters, 20000, "chunk maximum"); integer(config.chunking.overlapCharacters, 0, Math.min(1000, config.chunking.targetCharacters - 1), "chunk overlap");
  integer(config.retrieval.candidates, 1, 200, "semantic candidates"); integer(config.retrieval.maxPerUnit, 1, 8, "per-unit limit");
  integer(config.retrieval.maxVectors, 1, 100000, "vector capacity"); integer(config.retrieval.maxVectorBytes, 4096, 536870912, "vector byte capacity"); integer(config.retrieval.deadlineMs, 100, 120000, "query deadline");
  return config;
}
export function configured(config) { return Boolean(config.embedding.url && config.embedding.model && config.rerank.url && config.rerank.model); }
export function spaceFingerprint(config) { const e = config.embedding; return digest({ protocol: e.protocol, url: e.url, model: e.model, spaceRevision: e.spaceRevision, dimensions: e.dimensions, queryPrefix: e.queryPrefix, documentPrefix: e.documentPrefix, normalization: "l2-f32-le/v1" }); }
export function indexFingerprint(config) { return digest({ space: spaceFingerprint(config), chunking: config.chunking, chunkerVersion: CHUNKER_VERSION, maxInputCharacters: config.embedding.maxInputCharacters, rerankInputLimit: config.rerank.maxInputCharacters }); }
export function normalizeSemanticRequest(input = {}) {
  exact(input, ["text", "keywords", "budget"], "semantic request");
  return normalizeRequest(input);
}
export function normalizedVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => typeof n !== "number" || !Number.isFinite(n))) fail("invalid_embedding", "Invalid embedding vector.");
  const scale = Math.max(...value.map(Math.abs)); if (!scale) fail("invalid_embedding", "Zero embedding vector.");
  const norm = Math.sqrt(value.reduce((sum, n) => sum + (n / scale) ** 2, 0));
  const vector = Float32Array.from(value, n => n / scale / norm);
  if (vector.some(n => !Number.isFinite(n))) fail("invalid_embedding"); return vector;
}
