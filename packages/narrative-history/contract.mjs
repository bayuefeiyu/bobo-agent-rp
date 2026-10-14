import { createHash } from "node:crypto";

export const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, indexEveryTurns: 3, protectionMode: "context", protectRecentTurns: 5, targetCharacters: 800, maxCharacters: 1200, overlapCharacters: 120, shortTailCharacters: 200, candidatesPerQuery: 30, maxResults: 6, maxOutputCharacters: 6000, maxPerTurn: 2, deadlineMs: 15000 });
export const DEFAULT_SERVICES = Object.freeze({ schemaVersion: 1,
  embedding: { protocol: "embeddings", url: "", model: "", spaceRevision: "1", dimensions: 384, queryPrefix: "", documentPrefix: "", maxInputCharacters: 8192, batchSize: 16, timeoutMs: 30000 },
  rerank: { protocol: "cohere-rerank", url: "", model: "", maxInputCharacters: 8192, timeoutMs: 30000, minScore: null },
});
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !(key in DEFAULT_SETTINGS))) fail("history_settings_invalid");
  const result = { ...DEFAULT_SETTINGS, ...value };
  if (typeof result.enabled !== "boolean" || !["context", "fixed"].includes(result.protectionMode)) fail("history_settings_invalid");
  const bounds = { indexEveryTurns: [1,50], protectRecentTurns: [0,50], targetCharacters: [64,10000], maxCharacters: [64,20000], overlapCharacters: [0,1000], shortTailCharacters: [0,2000], candidatesPerQuery: [1,60], maxResults: [1,20], maxOutputCharacters: [128,40000], maxPerTurn: [1,8], deadlineMs: [100,30000] };
  for (const [key,[min,max]] of Object.entries(bounds)) if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) fail("history_settings_invalid", `Invalid ${key}.`);
  if (result.targetCharacters > result.maxCharacters || result.overlapCharacters >= result.targetCharacters || result.shortTailCharacters > result.targetCharacters) fail("history_settings_invalid");
  return result;
}
export function normalizeServices(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !(key in DEFAULT_SERVICES))) fail("history_configuration_invalid");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) fail("history_configuration_invalid");
  const result = structuredClone(DEFAULT_SERVICES);
  for (const group of ["embedding", "rerank"]) {
    const input = value[group] ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !(key in result[group]))) fail("history_configuration_invalid");
    Object.assign(result[group], input);
    for (const key of ["url","model"]) if (typeof result[group][key] !== "string" || result[group][key].length > 2000) fail("history_configuration_invalid");
    if (result[group].url) { let url; try { url = new URL(result[group].url); } catch { fail("history_configuration_invalid"); } if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("history_configuration_invalid"); }
    for (const [key,min,max] of [["maxInputCharacters",128,100000],["timeoutMs",100,120000]]) if (!Number.isSafeInteger(result[group][key]) || result[group][key] < min || result[group][key] > max) fail("history_configuration_invalid");
  }
  const e = result.embedding;
  if (e.protocol !== "embeddings" || result.rerank.protocol !== "cohere-rerank" || !Number.isSafeInteger(e.dimensions) || e.dimensions < 1 || e.dimensions > 8192 || !Number.isSafeInteger(e.batchSize) || e.batchSize < 1 || e.batchSize > 128) fail("history_configuration_invalid");
  for (const key of ["spaceRevision","queryPrefix","documentPrefix"]) if (typeof e[key] !== "string" || e[key].length > 1000) fail("history_configuration_invalid");
  if (!e.spaceRevision || result.rerank.minScore !== null && !Number.isFinite(result.rerank.minScore)) fail("history_configuration_invalid");
  return result;
}
export const spaceKey = config => digest({ ...config.embedding, batchSize: undefined, timeoutMs: undefined, maxInputCharacters: undefined });
export const chunkKey = settings => digest({ version: "narrative-paragraphs/v1", ...Object.fromEntries(["targetCharacters","maxCharacters","overlapCharacters","shortTailCharacters"].map(key => [key, settings[key]])) });
export function sources(messages) {
  return messages.filter(message => message.data?.role === "assistant" && message.data.content?.trim()).map(message => ({ id: message.id, revision: message.revision, turn: message.binding.turn, content: message.data.content, key: digest([message.id, message.revision, message.data.content]) }));
}
export function protectedSources(messages, settings, recentCompleteTurns = 5) {
  const all = sources(messages), turns = [...new Set(all.filter(source => source.turn > 0).map(source => source.turn))].sort((a,b) => a-b);
  const count = settings.protectionMode === "context" ? recentCompleteTurns : settings.protectRecentTurns;
  const protectedTurns = new Set(count ? turns.slice(-count) : []);
  return { all, eligible: all.filter(source => !protectedTurns.has(source.turn) && (source.turn !== 0 || turns.length >= count)), protectedTurns: [...protectedTurns] };
}
