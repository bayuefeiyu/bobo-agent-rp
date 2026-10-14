import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { LibraryClient, RetrievalSession } from "./client.mjs";
import { buildSemanticIndex } from "./semantic-build.mjs";
import { normalizeSemanticConfig, DEFAULT_SEMANTIC_CONFIG, normalizedVector } from "./semantic-contract.mjs";
import { createSemanticServices } from "./service-adapters.mjs";
import { createSemanticManager } from "./semantic-manager.mjs";
import { slicePassages } from "./passages.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reference-semantic-"));
  const counts = { embeddings: 0, reranks: 0, bodies: [], fail: false, delay: 0 };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk; const body = JSON.parse(text); counts.bodies.push(body);
    if (counts.delay) await new Promise(resolve => setTimeout(resolve, counts.delay));
    response.setHeader("content-type", "application/json");
    if (counts.fail) { response.statusCode = 503; return response.end("{}"); }
    if (request.url === "/embeddings") { counts.embeddings++; response.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: text.includes("竞价") ? [1, 0, .1] : text.includes("花园") ? [0, 1, .1] : [.1, .1, 1] })).reverse() })); }
    else { counts.reranks++; response.end(JSON.stringify({ results: body.documents.map((text, index) => ({ index, relevance_score: text.includes("竞价") ? .9 : .1 })).reverse() })); }
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `http://127.0.0.1:${server.address().port}`;
  const config = normalizeSemanticConfig({ enabled: true, embedding: { url: `${address}/embeddings`, model: "synthetic", dimensions: 3, batchSize: 2 }, rerank: { url: `${address}/rerank`, model: "synthetic", minScore: .5 }, chunking: { targetCharacters: 64, maxCharacters: 128, overlapCharacters: 12 } });
  const client = new LibraryClient(), clients = [client], managers = [];
  t.after(async () => { await Promise.all(managers.map(m => m.close())); await Promise.all(clients.map(c => c.close())); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  const library = join(root, "library"), pack = join(root, "pack"), review = join(root, "review.json");
  await mkdir(pack);
  let revision = 1;
  async function publish({ auction = true, changed = false } = {}) {
    const units = [ ...(auction ? [{ id: "auction", title: "交易资料", content: "# 序章\n\n" + "普通街景与路人。".repeat(25) + "\n\n# 中部交易\n\n竞价会以暗号确认最终价格😀。\n\n| 拍品 | 数量 |\n| --- | --- |\n| 竞价宝物 | 3 |\n| 清晨露水 | 1 |\n\n" + (changed ? "新增条件。" : "") }] : []), { id: "garden", title: "花园", content: "花园中留有新的观察线索。" } ];
    await writeFile(join(pack, "package.json"), JSON.stringify({ format: "creative-reference-library/v1", id: "synthetic", units: units.map(u => `${u.id}.json`) }));
    for (const unit of units) { await writeFile(join(pack, `${unit.id}.json`), JSON.stringify({ id: unit.id, revision: unit.id === "garden" ? 1 : revision, title: unit.title, summary: unit.title, keywords: [unit.id], aliases: [], relations: [], contentFile: `${unit.id}.md` })); await writeFile(join(pack, `${unit.id}.md`), unit.content); }
    await writeFile(review, JSON.stringify({ format: "creative-reference-library/v1", packageId: "synthetic", approved: true, selectedIds: units.map(u => u.id) })); revision++;
    return client.publish(library, pack, review);
  }
  const first = await publish();
  return { root, library, config, counts, client, clients, managers, publish, first };
}

test("structural passages preserve Unicode offsets, table headers, fences and deterministic identities", () => {
  const config = normalizeSemanticConfig(), unit = { id: "u", revision: 1, title: "Example", content: "# Rules\n\n😀 condition.\n\n| Thing | Count |\n| --- | --- |\n| A | 3 |\n\n```js\nx()\n```\n", relations: [] };
  const result = slicePassages(unit, config); assert.equal(result.skipped, 0); assert.ok(result.passages.some(p => p.content.includes("| --- | --- |"))); assert.ok(result.passages.some(p => p.content.includes("```js") && p.content.endsWith("```")));
  for (const p of result.passages) for (const [a, b] of p.ranges) assert.ok(!Buffer.from(unit.content).subarray(a, b).toString("utf8").includes("�"));
  assert.deepEqual(result, slicePassages(unit, config));
  assert.equal(slicePassages({ ...unit, content: "```\n" + "x".repeat(10000) + "\n```" }, config).skipped, 1);
});

test("portable semantic build, body-middle search, strict rerank and source-free incremental cache", async t => {
  const f = await fixture(t), result = await buildSemanticIndex(f.library, f.config);
  assert.equal(result.status, "completed"); assert.ok(result.passages > 2); const before = f.counts.embeddings;
  await rm(join(f.root, "pack"), { recursive: true }); await rm(join(f.root, "review.json"));
  const update = await buildSemanticIndex(f.library, f.config); assert.equal(update.encoded, 0); assert.equal(f.counts.embeddings, before);
  await f.client.open(f.library); const info = await f.client.openSemantic(f.library, f.config);
  const session = new RetrievalSession(f.client, undefined, { config: f.config, info });
  const found = await session.searchPassages({ text: "竞价" });
  assert.equal(found.status, "success"); assert.ok(found.documents.some(d => d.content.includes("竞价"))); assert.ok(found.documents.every(d => !d.content.includes("普通街景"))); assert.equal(f.counts.reranks, 1);
  assert.ok(f.counts.bodies.at(-1).documents.every(text => !text.includes("maintenance")));
  assert.equal(session.ledger.used.modelCalls, 0);
});

test("changed and deleted units are filtered before vector top-k; pinned readers keep their version", async t => {
  const f = await fixture(t); await buildSemanticIndex(f.library, f.config); await f.client.open(f.library, f.first.generation);
  const oldInfo = await f.client.openSemantic(f.library, f.config);
  await f.publish({ auction: false });
  const current = new LibraryClient(); f.clients.push(current); await current.open(f.library); const info = await current.openSemantic(f.library, f.config);
  assert.equal(info.coverage.partial, true);
  const old = new RetrievalSession(f.client, undefined, { config: f.config, info: oldInfo }); assert.ok((await old.searchPassages({ text: "竞价" })).documents.length);
  const next = new RetrievalSession(current, undefined, { config: { ...f.config, rerank: { ...f.config.rerank, minScore: null } }, info });
  const rows = await next.searchPassageCandidates({ text: "竞价" }, 1); assert.equal(rows[0].unitId, "garden");
});

test("mixed passage/unit output cannot bypass budgets; service retries consume shared allowances", async t => {
  const f = await fixture(t); await buildSemanticIndex(f.library, f.config); await f.client.open(f.library); const info = await f.client.openSemantic(f.library, f.config);
  const session = new RetrievalSession(f.client, { results: 1 }, { config: f.config, info });
  const candidates = await session.searchPassageCandidates({ text: "竞价" });
  const first = { kind: "passage", id: candidates[0].id }; assert.equal((await session.composeReferences([first])).documents.length, 1);
  assert.equal((await session.composeReferences([first])).documents.length, 1);
  session.seen.add("auction"); assert.equal((await session.compose(["auction"])).status, "budget_limited");
  f.counts.fail = true;
  const limited = new RetrievalSession(f.client, { embeddingCalls: 1 }, { config: f.config, info });
  await assert.rejects(() => limited.searchPassages({ text: "竞价" }), e => e.code === "budget_exhausted"); assert.equal(limited.ledger.used.embeddingCalls, 1);
});

test("capacity failure preserves the active index, cancellation is recoverable and configuration never builds", async t => {
  const f = await fixture(t); const manager = createSemanticManager({ configurationDirectory: join(f.root, "settings"), getRoot: () => f.library }); f.managers.push(manager);
  await manager.save({ config: f.config, embeddingKey: "fixture-key" }); assert.equal(f.counts.embeddings, 0); assert.equal((await manager.status()).status, "semantic_services_unverified");
  await manager.test(); assert.equal((await manager.status()).status, "semantic_not_built");
  const job = await manager.start(); const completed = await manager.wait(job.jobId); assert.equal(completed.status, "completed"); assert.equal((await manager.status()).ready, true);
  assert.equal((await manager.publicSettings()).embeddingKey, undefined);
  const pointer = await readFile(join(f.library, "semantic", "active.json"), "utf8");
  await assert.rejects(() => buildSemanticIndex(f.library, { ...f.config, retrieval: { ...f.config.retrieval, maxVectors: 1 } }), e => e.code === "semantic_capacity_exceeded"); assert.equal(await readFile(join(f.library, "semantic", "active.json"), "utf8"), pointer);
  f.counts.delay = 250;
  const cancelled = await manager.start({ forceEncoding: true });
  await manager.cancel(cancelled.jobId); const cancellation = await manager.wait(cancelled.jobId); assert.equal(cancellation.status, "cancelled", JSON.stringify(cancellation)); assert.equal(await readFile(join(f.library, "semantic", "active.json"), "utf8"), pointer);
  f.counts.delay = 0; const resumed = await manager.start({ resumeJobId: cancelled.jobId }); assert.equal((await manager.wait(resumed.jobId)).status, "completed");
  await manager.save({ config: f.config, embeddingKey: "changed-fixture-key" }); assert.equal((await manager.status()).status, "semantic_services_unverified");
});

test("service adapters reject malformed vectors and missing/duplicated rerank mappings", async () => {
  assert.throws(() => normalizedVector([0, 0], 2), e => e.code === "invalid_embedding"); assert.throws(() => normalizedVector([NaN, 1], 2), e => e.code === "invalid_embedding");
  const config = normalizeSemanticConfig({ embedding: { url: "http://fixture.invalid", model: "x", dimensions: 2 }, rerank: { url: "http://fixture.invalid", model: "x" } });
  const services = createSemanticServices(config, { fetchImpl: async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: .5 }, { index: 0, relevance_score: .9 }] })), retries: 0 });
  await assert.rejects(() => services.rerank("x", ["a", "b"]), e => e.code === "invalid_rerank");
  const malformed = createSemanticServices(config, { fetchImpl: async () => new Response(JSON.stringify({ data: [null], results: [null] })), retries: 0 });
  await assert.rejects(() => malformed.embed(["a"]), { code: "invalid_embedding" }); await assert.rejects(() => malformed.rerank("x", ["a"]), { code: "invalid_rerank" });
  assert.throws(() => normalizeSemanticConfig({ ...DEFAULT_SEMANTIC_CONFIG, retrieval: { maxVectors: 100001 } }), e => e.code === "invalid_request");
  for (const group of ["embedding", "rerank", "chunking", "retrieval"]) assert.throws(() => normalizeSemanticConfig({ [group]: null }));
  await assert.rejects(() => services.embed([123]), { code: "service_input_limit" });
  await assert.rejects(() => services.rerank("x", [1]), { code: "service_input_limit" });
  await assert.rejects(() => services.rerank("x", Array(201).fill("a")), { code: "service_input_limit" });
  const large = createSemanticServices(normalizeSemanticConfig({ ...config, rerank: { ...config.rerank, maxInputCharacters: 100000 } }), { fetchImpl: () => { throw new Error("No dispatch"); } });
  await assert.rejects(() => large.rerank("x", Array(18).fill("a".repeat(8000))), { code: "service_input_limit" });
});

test("b semantic coarse screening finds parents beyond supplied text fields and uses bounded ordinary scoring", async t => {
  const f = await fixture(t); await buildSemanticIndex(f.library, f.config); await f.client.open(f.library); const info = await f.client.openSemantic(f.library, f.config);
  const request = { text: "竞价", fields: ["terms"], context: "synthetic creative context" };
  const plain = new RetrievalSession(f.client); assert.equal((await plain.search(request)).length, 0);
  const session = new RetrievalSession(f.client, undefined, { config: f.config, info });
  let scored = [];
  const result = await session.searchUnits({ ...request, includeSemanticCandidates: true }, async payload => { scored = payload.candidates; assert.equal(payload.context, request.context); return { scores: scored.map(c => ({ id: c.id, score: 90 })) }; });
  assert.ok(scored.some(c => c.id === "auction")); assert.ok(result.documents.length);
  assert.equal(session.ledger.used.modelCalls, 1); assert.equal(session.ledger.used.rerankCalls, 1); assert.ok(session.ledger.used.candidates <= 200);
  assert.ok(!JSON.stringify(f.counts.bodies.at(-1)).includes(request.context));
  await assert.rejects(() => f.client.semanticSearch([NaN, 0, 1], 1), { code: "invalid_embedding" });
});

test("portable IDs and per-delivery read budgets remain valid for mixed references", async () => {
  const client = { inspect: async id => ({ id, unitId: id, title: id, characters: 4, bytes: 4, relations: [] }), measureRanges: async (_id, ranges) => ranges.reduce((n, [a,b]) => n+b-a, 0), read: async id => ({ id, title: id, content: "body", relations: [] }) };
  const session = new RetrievalSession(client); session.seen.add("constructor"); session.seen.add("second");
  assert.equal((await session.compose(["constructor"])).documents.length, 1);
  assert.equal((await session.compose(["constructor", "second"], { ...session.ledger.limits, reads: 1 })).documents.length, 1);
});

test("cancellation at validation preserves the active pointer and native abort is recorded consistently", async t => {
  const f = await fixture(t); await buildSemanticIndex(f.library, f.config);
  const pointer = await readFile(join(f.library, "semantic", "active.json"), "utf8"), controller = new AbortController(); let jobId;
  await assert.rejects(() => buildSemanticIndex(f.library, f.config, { signal: controller.signal, onProgress: async progress => { jobId = progress.jobId; if (progress.phase === "validating") controller.abort(); } }), { code: "cancelled" });
  const job = JSON.parse(await readFile(join(f.library, "semantic", "jobs", jobId, "job.json"), "utf8")); assert.equal(job.status, "cancelled"); assert.equal(job.errorCode, "cancelled");
  assert.equal(await readFile(join(f.library, "semantic", "active.json"), "utf8"), pointer);
});

test("disabling c cancels a dispatched query and preserves the built index", async t => {
  const f = await fixture(t), manager = createSemanticManager({ configurationDirectory: join(f.root, "settings"), getRoot: () => f.library }); f.managers.push(manager);
  await manager.save({ config: f.config }); await manager.test(); const job = await manager.start(); await manager.wait(job.jobId);
  const snapshot = await manager.snapshot(), controller = new AbortController(), unregister = manager.registerController(controller);
  const pointer = await readFile(join(f.library, "semantic", "active.json"), "utf8"), before = f.counts.bodies.length; f.counts.delay = 300;
  const pending = manager.withClient(f.library, undefined, snapshot, async (client, _formal, info) => new RetrievalSession(client, undefined, { ...snapshot, info, signal: controller.signal }).searchPassages({ text: "竞价" }));
  const rejection = assert.rejects(pending, { code: "cancelled" });
  while (f.counts.bodies.length === before) await new Promise(r => setTimeout(r, 5));
  await manager.save({ config: { ...f.config, enabled: false } }); await rejection; unregister();
  assert.equal((await manager.status()).ready, false); assert.equal(await readFile(join(f.library, "semantic", "active.json"), "utf8"), pointer);
});
