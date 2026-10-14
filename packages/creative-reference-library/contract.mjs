export const FORMAT = "creative-reference-library/v1";
export const INDEX_VERSION = "han-bigram-latin/v1";
export const DEFAULT_BUDGET = Object.freeze({ queries: 8, candidates: 200, scored: 40, reads: 40, readCharacters: 100000, scoreCharacters: 60000, modelCalls: 12, results: 8, outputCharacters: 40000, embeddingCalls: 4, rerankCalls: 4, rerankDocuments: 120, rerankCharacters: 120000, scanValues: 400000000, scanBytes: 2147483648 });
export class LibraryError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export function fail(code, message) { throw new LibraryError(code, message); }
export function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value) || value.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail("invalid_format", "Invalid portable stable ID.");
  return value;
}
export function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail("invalid_format", `Unexpected fields in ${label}.`);
}
export function normalizeUnit(value) {
  exact(value, ["id", "revision", "title", "summary", "keywords", "aliases", "content", "relations"], "unit");
  id(value.id);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("invalid_format", "revision must be a positive integer.");
  for (const key of ["title", "summary", "content"]) if (typeof value[key] !== "string" || !value[key].trim()) fail("invalid_format", `${key} must be nonempty.`);
  if (value.title.length > 300 || value.summary.length > 3000 || value.content.length > 2000000) fail("invalid_format", "Unit text exceeds format limit.");
  for (const key of ["keywords", "aliases"]) if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(term => typeof term !== "string" || !term.trim() || term.length > 200)) fail("invalid_format", `Invalid ${key}.`);
  const relations = value.relations ?? [];
  if (!Array.isArray(relations) || relations.length > 40) fail("invalid_format", "Invalid relations.");
  for (const relation of relations) {
    exact(relation, ["id", "kind"], "relation"); id(relation.id);
    if (!["context", "related"].includes(relation.kind)) fail("invalid_format", "Unknown relation kind.");
  }
  return { id: value.id, revision: value.revision, title: value.title, summary: value.summary, keywords: [...new Set(value.keywords)], aliases: [...new Set(value.aliases)], content: value.content, relations: relations.map(r => ({ id: r.id, kind: r.kind })) };
}
export function normalizeRequest(value = {}, { allowSemantic = false } = {}) {
  exact(value, ["text", "keywords", "context", "budget", "includeSemanticCandidates", "fields"], "request");
  const text = value.text ?? "", context = value.context ?? "", keywords = value.keywords ?? [];
  if (typeof text !== "string" || text.length > 8000 || typeof context !== "string" || context.length > 12000 || !Array.isArray(keywords) || keywords.length > 32 || keywords.some(k => typeof k !== "string" || !k.trim() || k.length > 200)) fail("invalid_request");
  if (!text.trim() && !keywords.length) fail("invalid_request", "Provide text or keywords.");
  if (value.includeSemanticCandidates !== undefined && typeof value.includeSemanticCandidates !== "boolean") fail("invalid_request");
  if (value.includeSemanticCandidates && !allowSemantic) fail("capability_unavailable", "Semantic retrieval is not ready.");
  const fields = value.fields ?? ["terms", "title", "summary", "body"];
  if (!Array.isArray(fields) || !fields.length || fields.some(field => !["terms", "title", "summary", "body"].includes(field)) || new Set(fields).size !== fields.length) fail("invalid_request", "Invalid search fields.");
  return { text, keywords, context, fields, budget: effectiveBudget(value.budget), includeSemanticCandidates: value.includeSemanticCandidates ?? false };
}
export function effectiveBudget(request = {}, upper = DEFAULT_BUDGET) {
  exact(request, Object.keys(DEFAULT_BUDGET), "budget");
  const result = {};
  for (const [key, max] of Object.entries(upper)) {
    const requested = request[key] ?? max;
    if (!Number.isSafeInteger(requested) || requested < 1) fail("invalid_request", `Invalid budget ${key}.`);
    result[key] = Math.min(max, requested);
  }
  return result;
}
export class BudgetLedger {
  constructor(limits = DEFAULT_BUDGET) { this.limits = effectiveBudget(limits); this.used = Object.fromEntries(Object.keys(this.limits).map(key => [key, 0])); }
  remaining(key) { return this.limits[key] - this.used[key]; }
  charge(key, amount) { if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.remaining(key)) fail("budget_exhausted", `Budget exhausted: ${key}.`); this.used[key] += amount; }
  reserve(costs) { for (const [key, amount] of Object.entries(costs)) if (!(key in this.limits) || !Number.isSafeInteger(amount) || amount < 0 || amount > this.remaining(key)) fail("budget_exhausted", `Budget exhausted: ${key}.`); for (const [key, amount] of Object.entries(costs)) this.charge(key, amount); }
}
export function validateScores(value, candidates) {
  try { exact(value, ["scores"], "scores"); } catch { fail("invalid_scores", "Return only the scores object."); }
  if (!Array.isArray(value.scores) || value.scores.length !== candidates.length) fail("invalid_scores", "Score every candidate exactly once.");
  const allowed = new Set(candidates.map(c => c.id)), seen = new Set();
  for (const score of value.scores) {
    try { exact(score, ["id", "score"], "score"); } catch { fail("invalid_scores", "Each score contains only id and score."); }
    if (!allowed.has(score.id) || seen.has(score.id) || !Number.isInteger(score.score) || score.score < 0 || score.score > 100) fail("invalid_scores", "Invalid candidate or score.");
    seen.add(score.id);
  }
  return value.scores;
}
export function rankScores(value, candidates) {
  const scores = validateScores(value, candidates).filter(item => item.score > 0);
  const words = text => new Set(text.toLowerCase().match(/[\p{Script=Han}]{2}|[a-z0-9_]+/gu) ?? []);
  const descriptions = new Map(candidates.map(c => [c.id, words(`${c.title} ${c.summary} ${c.excerpt}`)]));
  const picked = [], used = new Set();
  while (picked.length < scores.length) {
    let best, merit = -Infinity;
    for (const item of scores) {
      if (used.has(item.id)) continue;
      const terms = descriptions.get(item.id); let similarity = 0;
      for (const previous of picked) { const other = descriptions.get(previous); const shared = [...terms].filter(t => other.has(t)).length; similarity = Math.max(similarity, shared / Math.max(1, terms.size + other.size - shared)); }
      const value = item.score / 100 - 0.12 * similarity;
      if (value > merit) { merit = value; best = item; }
    }
    picked.push(best.id); used.add(best.id);
  }
  return picked;
}
