import { Worker } from "node:worker_threads";
import { LibraryError, normalizeRequest, BudgetLedger, validateScores, rankScores } from "./contract.mjs";
import { normalizeSemanticRequest, normalizeSemanticConfig, digest, spaceFingerprint } from "./semantic-contract.mjs";
import { createSemanticServices } from "./service-adapters.mjs";
export class LibraryClient {
  constructor() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 24 || major === 24 && minor < 14) throw new LibraryError("runtime_incompatible", "Reference library requires Node.js 24.14 or newer.");
    this.worker = new Worker(new URL("./worker.mjs", import.meta.url)); this.sequence = 0; this.pending = new Map();
    this.worker.on("message", ({ sequence, result, error }) => { const pending = this.pending.get(sequence); this.pending.delete(sequence); if (!pending) return; error ? pending.reject(new LibraryError(error.code, error.message)) : pending.resolve(result); });
    this.worker.on("error", error => { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); });
  }
  call(operation, ...args) { return new Promise((resolve, reject) => { const sequence = ++this.sequence; this.pending.set(sequence, { resolve, reject }); this.worker.postMessage({ sequence, operation, arguments: args }); }); }
  open(root, generation) { return this.call("open", root, generation); }
  search(request) { return this.call("search", request); }
  read(id) { return this.call("read", id); }
  inspect(id) { return this.call("inspect", id); }
  measureRanges(id, ranges) { return this.call("measureRanges", id, ranges); }
  readRanges(id, ranges) { return this.call("readRanges", id, ranges); }
  openSemantic(root, config, generation) { return this.call("openSemantic", root, config, generation); }
  semanticSearch(vector, limit, options) { return this.call("semanticSearch", vector, limit, options); }
  passage(id) { return this.call("passage", id); }
  passageInfo(id) { return this.call("passageInfo", id); }
  buildSemantic(root, config, options) { return this.call("semanticBuild", root, config, options); }
  publish(...args) { return this.call("publish", ...args); }
  close() { for (const p of this.pending.values()) p.reject(new LibraryError("cancelled")); this.pending.clear(); return this.worker.terminate(); }
}
export class RetrievalSession {
  constructor(client, budget, semantic = null) { this.client = client; this.ledger = new BudgetLedger(budget); this.seen = new Set(); this.outputIds = new Set(); this.seenPassages = new Set(); this.outputRefs = new Set(); this.outputRanges = Object.create(null); this.passageGroups = Object.create(null); this.semantic = semantic; }
  async search(input) {
    const request = normalizeRequest(input); this.ledger.charge("queries", 1);
    const limit = Math.min(request.budget.candidates, this.ledger.remaining("candidates"));
    if (!limit) throw new LibraryError("budget_exhausted");
    const results = await this.client.search({ ...input, budget: { ...request.budget, candidates: limit } });
    this.ledger.charge("candidates", results.length); results.forEach(r => this.seen.add(r.id)); return results;
  }
  async read(id) {
    if (!this.seen.has(id)) throw new LibraryError("selection_invalid", "Read only discovered candidates.");
    this.ledger.charge("reads", 1);
    const info = await this.client.inspect(id); this.ledger.charge("readCharacters", info.characters);
    const unit = await this.client.read(id); unit.relations.forEach(r => this.seen.add(r.id)); return unit;
  }
  async searchUnits(input, score) {
    const request = normalizeRequest(input, { allowSemantic: Boolean(this.semantic) });
    const found = (await this.collectUnitCandidates(input)).slice(0, Math.min(request.budget.scored, this.ledger.remaining("scored")));
    const candidates = [];
    let inputSize = JSON.stringify({ text: request.text, keywords: request.keywords, context: request.context }).length;
    for (const item of found) { const size = JSON.stringify(item).length; if (inputSize + size > Math.min(request.budget.scoreCharacters, this.ledger.remaining("scoreCharacters")) / 2) break; inputSize += size; candidates.push(item); }
    if (!candidates.length) return { status: found.length ? "budget_limited" : "no_results", documents: [], omitted: found.length };
    this.ledger.charge("scored", candidates.length);
    const payload = { text: request.text, keywords: request.keywords, context: request.context, candidates };
    const size = JSON.stringify(payload).length; let scores;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.ledger.charge("scoreCharacters", size); this.ledger.charge("modelCalls", 1);
      try { scores = validateScores(await score(payload, attempt), candidates); break; } catch (error) { if (error.code !== "invalid_scores" || attempt) throw error; }
    }
    return this.compose(rankScores({ scores }, candidates), request.budget);
  }
  async collectUnitCandidates(input) {
    const request = normalizeRequest(input, { allowSemantic: Boolean(this.semantic) });
    if (!request.includeSemanticCandidates) return this.search(input);
    if (!this.semantic) throw new LibraryError("capability_unavailable");
    const remaining = Math.min(request.budget.candidates, this.ledger.remaining("candidates"));
    const semanticLimit = Math.min(60, this.semantic.config.retrieval.candidates, Math.max(1, Math.floor(remaining * .3))), textLimit = remaining - semanticLimit;
    const text = textLimit ? await this.search({ ...input, includeSemanticCandidates: false, budget: { ...request.budget, candidates: textLimit } }) : [];
    const passages = await this.searchPassageCandidates({ text: request.text, keywords: request.keywords, budget: request.budget }, semanticLimit);
    const semanticUnits = new Map();
    for (const passage of passages) {
      if (!semanticUnits.has(passage.unitId)) { const unit = await this.client.inspect(passage.unitId); semanticUnits.set(passage.unitId, { id: passage.unitId, title: unit.title, summary: "", excerpt: passage.content, order: semanticUnits.size }); this.seen.add(passage.unitId); }
    }
    const merged = new Map();
    for (const list of [text, [...semanticUnits.values()]]) list.forEach((item, index) => { const old = merged.get(item.id); merged.set(item.id, { ...item, excerpt: semanticUnits.get(item.id)?.excerpt ?? item.excerpt, rank: (old?.rank ?? 0) + 1 / (60 + index) }); });
    return [...merged.values()].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).map(({ rank, order, ...item }) => item);
  }
  async searchPassageCandidates(input, limitOverride) {
    const request = normalizeSemanticRequest(input);
    if (!this.semantic) throw new LibraryError("capability_unavailable");
    const config = normalizeSemanticConfig(this.semantic.config), info = this.semantic.info;
    if (!config.enabled) throw new LibraryError("semantic_disabled");
    if (info.count > config.retrieval.maxVectors || info.vectorBytes > config.retrieval.maxVectorBytes) throw new LibraryError("semantic_capacity_exceeded");
    this.ledger.charge("queries", 1);
    if (!info.coverage.validPassages) return [];
    const limit = Math.min(limitOverride ?? config.retrieval.candidates, request.budget.candidates, this.ledger.remaining("candidates")); if (!limit) throw new LibraryError("budget_exhausted");
    const query = [request.text.trim(), ...request.keywords].filter(Boolean).join("\n").normalize("NFC");
    if (query.length + config.embedding.queryPrefix.length > config.embedding.maxInputCharacters || query.length > config.rerank.maxInputCharacters - 128) throw new LibraryError("service_input_limit");
    const deadline = Date.now() + config.retrieval.deadlineMs, timed = AbortSignal.timeout(config.retrieval.deadlineMs), signal = this.semantic.signal ? AbortSignal.any([timed, this.semantic.signal]) : timed;
    const startingUsed = { ...this.ledger.used };
    const reserve = costs => { for (const [key, amount] of Object.entries(costs)) if (this.ledger.used[key] - startingUsed[key] + amount > request.budget[key]) throw new LibraryError("budget_exhausted"); this.ledger.reserve(costs); };
    const services = createSemanticServices(config, { ...this.semantic.secrets, fetchImpl: this.semantic.fetchImpl, signal, beforeRequest: async (kind, cost) => {
      reserve(kind === "embedding" ? { embeddingCalls: 1 } : { rerankCalls: 1, rerankDocuments: cost.documents, rerankCharacters: cost.characters });
      await this.semantic.onCharge?.();
    } });
    const cache = this.semantic.queryCache, cacheKey = digest({ query, space: spaceFingerprint(config) }), cached = cache?.get(cacheKey);
    const vector = cached && Date.now() - cached.time < 30000 ? cached.vector : (await services.embed([query], "query"))[0];
    if (cache && (!cached || cached.vector !== vector)) { cache.set(cacheKey, { vector, time: Date.now() }); while (cache.size > 128 || [...cache.values()].reduce((n, row) => n + row.vector.byteLength, 0) > 4194304) cache.delete(cache.keys().next().value); }
    reserve({ scanValues: info.count * info.dimensions, scanBytes: info.vectorBytes }); await this.semantic.onCharge?.();
    const cancelled = new Int32Array(new SharedArrayBuffer(4)), abort = () => Atomics.store(cancelled, 0, 1); signal.addEventListener("abort", abort, { once: true });
    let found; try { found = await this.client.semanticSearch(vector, limit, { deadline, cancelled: cancelled.buffer }); } finally { signal.removeEventListener("abort", abort); }
    signal.throwIfAborted(); this.ledger.charge("candidates", found.length);
    const candidates = []; let characters = query.length;
    const duplicates = new Set();
    for (const candidate of found) {
      if (duplicates.has(candidate.inputHash)) continue;
      if (candidate.input.length + query.length > config.rerank.maxInputCharacters || candidates.length >= Math.min(request.budget.rerankDocuments, this.ledger.remaining("rerankDocuments")) || characters + candidate.input.length > Math.min(request.budget.rerankCharacters, this.ledger.remaining("rerankCharacters"), 120000)) continue;
      duplicates.add(candidate.inputHash); characters += candidate.input.length; candidates.push(candidate);
    }
    if (!candidates.length) { if (found.length) throw new LibraryError("budget_exhausted"); return []; }
    const scores = await services.rerank(query, candidates.map(p => p.input)); signal.throwIfAborted();
    const output = scores.filter(row => config.rerank.minScore === null || row.score >= config.rerank.minScore).map(row => ({ ...candidates[row.index], rerankScore: row.score }));
    output.forEach(p => this.seenPassages.add(p.id)); return output;
  }
  async searchPassages(input) {
    const request = normalizeSemanticRequest(input), found = await this.searchPassageCandidates(input);
    const perUnit = new Map(), selected = [], groups = [];
    for (const passage of found) {
      const match = groups.find(group => group.unitId === passage.unitId && group.members.length < 4 && group.members.some(p => p.ranges.some(([a, b]) => passage.ranges.some(([c, d]) => Math.max(a, c) <= Math.min(b, d)))));
      if (match) { const length = [...match.members, passage].reduce((sum, p) => sum + p.content.length, 0); if (length <= this.semantic.config.chunking.maxCharacters * 2) { match.members.push(passage); continue; } }
      const count = perUnit.get(passage.unitId) ?? 0; if (count >= this.semantic.config.retrieval.maxPerUnit) continue; perUnit.set(passage.unitId, count + 1); groups.push({ unitId: passage.unitId, members: [passage] });
    }
    for (const group of groups) {
      let passageId = group.members[0].id;
      if (group.members.length > 1) { passageId = `g-${digest(group.members.map(p => p.id).sort()).slice(0, 40)}`; this.passageGroups[passageId] = group.members.map(p => p.id); this.seenPassages.add(passageId); }
      selected.push({ kind: "passage", id: passageId });
    }
    const result = await this.composeReferences(selected, request.budget); result.partialCoverage = this.semantic.info.coverage.partial; return result;
  }
  async compose(ids, budget = this.ledger.limits) {
    const result = await this.composeReferences(ids?.map(id => ({ kind: "unit", id })), budget);
    return result;
  }
  validateReferences(items) {
    if (!Array.isArray(items) || items.length > 200 || new Set(items.map(item => `${item?.kind}:${item?.id}`)).size !== items.length || items.some(item => !item || Object.keys(item).some(key => !["kind", "id"].includes(key)) || !["unit", "passage"].includes(item.kind) || !(item.kind === "unit" ? this.seen : this.seenPassages).has(item.id))) throw new LibraryError("selection_invalid");
  }
  async readPassage(passageId) {
    if (!this.seenPassages.has(passageId)) throw new LibraryError("selection_invalid");
    const info = await this.passageInfo(passageId); this.ledger.reserve({ reads: 1, readCharacters: info.characters });
    return this.passageGroups[passageId] ? { ...info, content: await this.client.readRanges(info.unitId, info.ranges) } : this.client.passage(passageId);
  }
  async passageInfo(passageId) {
    const members = this.passageGroups[passageId]; if (!members) return this.client.passageInfo(passageId);
    const infos = await Promise.all(members.map(id => this.client.passageInfo(id))), ranges = unionRanges(infos.flatMap(p => p.ranges));
    return { ...infos[0], id: passageId, ranges, characters: await this.client.measureRanges(infos[0].unitId, ranges) + Math.max(0, ranges.length - 1) };
  }
  async composeReferences(items, budget = this.ledger.limits) {
    this.validateReferences(items);
    const documents = [], selectedRefs = [], selectedIds = [], fingerprints = new Set(), delivered = new Set(); let omitted = 0, characters = 0;
    const startingReads = this.ledger.used.reads, startingCharacters = this.ledger.used.readCharacters;
    const key = ref => `${ref.kind}:${ref.id}`;
    const describe = async ref => ref.kind === "unit" ? { ...(await this.client.inspect(ref.id)), unitId: ref.id } : await this.passageInfo(ref.id);
    for (const ref of items) {
      if (delivered.has(key(ref))) continue;
      const group = new Map(), pending = [{ ref, depth: 0 }]; let complete = true;
      while (pending.length) {
        const item = pending.shift(); if (group.has(key(item.ref)) || delivered.has(key(item.ref))) continue;
        if (item.depth > 2 || group.size >= 4) { complete = false; break; }
        const info = await describe(item.ref); group.set(key(item.ref), { ref: item.ref, info });
        for (const relation of info.relations.filter(r => r.kind === "context")) pending.push({ ref: { kind: "unit", id: relation.id }, depth: item.depth + 1 });
      }
      const length = [...group.values()].reduce((sum, { info }) => sum + info.characters + info.title.length + 5, 0);
      if (!complete || group.size > Math.min(budget.results - documents.length, this.ledger.remaining("reads"), budget.reads - (this.ledger.used.reads - startingReads)) || length > Math.min(budget.outputCharacters - characters, this.ledger.remaining("readCharacters"), budget.readCharacters - (this.ledger.used.readCharacters - startingCharacters))) { omitted++; continue; }
      let freshCount = 0, freshCharacters = 0;
      const updates = [];
      for (const { ref: member, info } of group.values()) {
        const old = Object.hasOwn(this.outputRanges, info.unitId) ? this.outputRanges[info.unitId] : [], ranges = member.kind === "unit" ? [[0, info.bytes]] : info.ranges;
        const fresh = subtractRanges(ranges, old), unique = !this.outputRefs.has(key(member));
        if (unique) { freshCount++; freshCharacters += await this.client.measureRanges(info.unitId, fresh) + info.title.length + 5; }
        updates.push({ key: key(member), unitId: info.unitId, ranges: unionRanges([...old, ...ranges]) });
      }
      if (freshCount > this.ledger.remaining("results") || freshCharacters > this.ledger.remaining("outputCharacters")) { omitted++; continue; }
      for (const { ref: member, info } of group.values()) {
        let value;
        if (member.kind === "unit") { this.seen.add(member.id); value = await this.read(member.id); }
        else value = await this.readPassage(member.id);
        delivered.add(key(member)); const fingerprint = value.content.trim();
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint); characters += value.content.length + value.title.length + 5;
        selectedRefs.push(member); if (member.kind === "unit") selectedIds.push(member.id);
        documents.push({ title: value.title, content: value.content });
      }
      this.ledger.reserve({ results: freshCount, outputCharacters: freshCharacters });
      for (const update of updates) { this.outputRefs.add(update.key); this.outputRanges[update.unitId] = update.ranges; if (update.key.startsWith("unit:")) this.outputIds.add(update.unitId); }
    }
    return { status: omitted ? "budget_limited" : documents.length ? "success" : "no_results", documents, omitted, selectedIds, selectedRefs };
  }
}

export function unionRanges(ranges) {
  const result = [];
  for (const range of ranges.map(r => [...r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) { const previous = result.at(-1); if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else result.push(range); }
  return result;
}
export function subtractRanges(ranges, existing) {
  let result = unionRanges(ranges);
  for (const [start, end] of unionRanges(existing)) result = result.flatMap(([a, b]) => end <= a || start >= b ? [[a, b]] : [...(a < start ? [[a, start]] : []), ...(b > end ? [[end, b]] : [])]);
  return result;
}
