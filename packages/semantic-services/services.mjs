const fail = (code,message = code) => { throw Object.assign(new Error(message),{ code }); };
function normalizedVector(value,dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => typeof n !== "number" || !Number.isFinite(n))) fail("invalid_embedding");
  const scale = Math.max(...value.map(Math.abs)); if (!scale) fail("invalid_embedding");
  const norm = Math.sqrt(value.reduce((sum,n) => sum+(n/scale)**2,0));
  return Float32Array.from(value,n => n/scale/norm);
}

async function responseJson(response, maxBytes = 16777216) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(response.status === 429 || response.status >= 500 ? "service_retryable" : "service_unavailable", "Semantic service request failed."); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) fail("service_response_invalid", "Response is too large."); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("service_response_invalid", "Invalid service JSON."); }
}
export function createSemanticServices(config, { embeddingKey = "", rerankKey = "", fetchImpl = fetch, signal, beforeRequest = async () => {}, retries = 1 } = {}) {
  async function request(kind, body, cost) {
    const service = config[kind];
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted(); await beforeRequest(kind, cost);
      try {
        const timeout = AbortSignal.timeout(service.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const key = kind === "embedding" ? embeddingKey : rerankKey;
        const response = await fetchImpl(service.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: combined });
        return await responseJson(response);
      } catch (error) {
        if (signal?.aborted) fail("cancelled");
        if (attempt >= retries || !["service_retryable", "TimeoutError", "TypeError"].includes(error.code ?? error.name)) { if (error.code) throw error; fail("service_unavailable", "Semantic service request failed."); }
      }
    }
  }
  return {
    async embed(texts, mode = "document") {
      if (!Array.isArray(texts) || texts.some(text => typeof text !== "string") || !["query", "document"].includes(mode)) fail("service_input_limit");
      const prefix = mode === "query" ? config.embedding.queryPrefix : config.embedding.documentPrefix;
      const input = texts.map(text => prefix + text);
      if (!input.length || input.length > config.embedding.batchSize || input.some(text => typeof text !== "string" || text.length > config.embedding.maxInputCharacters) || input.reduce((n, text) => n + text.length, 0) > 250000) fail("service_input_limit");
      const data = await request("embedding", { model: config.embedding.model, input, encoding_format: "float" }, { mode, documents: input.length, characters: input.reduce((n, t) => n + t.length, 0) });
      if (!Array.isArray(data.data) || data.data.length !== input.length) fail("invalid_embedding");
      const result = Array(input.length), seen = new Set();
      for (const row of data.data) { if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= input.length || seen.has(row.index)) fail("invalid_embedding"); seen.add(row.index); result[row.index] = normalizedVector(row.embedding, config.embedding.dimensions); }
      return result;
    },
    async rerank(query, documents) {
      if (typeof query !== "string" || !Array.isArray(documents) || documents.some(text => typeof text !== "string") || documents.length > 200) fail("service_input_limit");
      if (!documents.length) return [];
      if (query.length > config.rerank.maxInputCharacters || documents.some(text => text.length + query.length > config.rerank.maxInputCharacters)) fail("service_input_limit");
      const characters = query.length + documents.reduce((sum, t) => sum + t.length, 0);
      if (characters > 120000) fail("service_input_limit");
      const data = await request("rerank", { model: config.rerank.model, query, documents, top_n: documents.length, return_documents: false }, { documents: documents.length, characters });
      if (!Array.isArray(data.results) || data.results.length !== documents.length) fail("invalid_rerank");
      const seen = new Set();
      return data.results.map(row => { if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= documents.length || seen.has(row.index) || typeof row.relevance_score !== "number" || !Number.isFinite(row.relevance_score)) fail("invalid_rerank"); seen.add(row.index); return { index: row.index, score: row.relevance_score }; }).sort((a, b) => b.score - a.score || a.index - b.index);
    },
  };
}
