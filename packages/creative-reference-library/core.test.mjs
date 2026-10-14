import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryClient, RetrievalSession } from "./client.mjs";
import { validateScores, normalizeRequest } from "./contract.mjs";
import { readFile } from "node:fs/promises";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "creative-reference-"));
  const pack = join(root, "input"), library = join(root, "library"), review = join(root, "review.json");
  await mkdir(pack); await writeFile(join(pack, "package.json"), JSON.stringify({ format: "creative-reference-library/v1", id: "synthetic", units: ["auction.json", "flower.json"] }));
  for (const [id, title, summary, keywords, aliases, content] of [
    ["auction", "修仙拍卖", "法宝竞价与交易", ["法宝", "拍卖会"], ["宝物竞购"], "序言".repeat(2000) + "\n竞价采用秘密报价，平价时按登记顺序。\n| 类别 | 数值 |\n| 宝物 | 12 |\n例外：损坏法宝需要事先披露。"],
    ["flower", "庭院花卉", "种植与赏花", ["园艺"], [], "花卉清晨浇水。"],
  ]) {
    await writeFile(join(pack, `${id}.json`), JSON.stringify({ id, revision: 1, title, summary, keywords, aliases, contentFile: `${id}.md` }));
    await writeFile(join(pack, `${id}.md`), content);
  }
  await writeFile(review, JSON.stringify({ format: "creative-reference-library/v1", packageId: "synthetic", approved: true, selectedIds: ["auction", "flower"] }));
  const client = new LibraryClient(); t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  return { root, pack, library, review, client };
}
test("portable publication, short Chinese words, middle excerpt, rebuild without source/maintenance and pinned readers", async t => {
  const f = await fixture(t); const first = await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library);
  for (const text of ["法宝", "竞价", "宝物竞购"]) assert.equal((await f.client.search({ text }))[0].id, "auction");
  assert.match((await f.client.search({ text: "竞价" }))[0].excerpt, /秘密报价/);
  await rm(f.pack, { recursive: true }); await rm(join(f.library, "maintenance"), { recursive: true });
  const next = await f.client.publish(f.library, null, null, { rebuild: true }); assert.notEqual(first.generation, next.generation);
  assert.match((await f.client.read("auction")).content, /例外/);
  await f.client.open(f.library, first.generation); assert.equal((await f.client.search({ text: "竞价" })).length, 1);
});
test("review, writer lock, failure preserves published version", async t => {
  const f = await fixture(t); await assert.rejects(f.client.publish(f.library, f.pack, f.review + "missing"));
  const first = await f.client.publish(f.library, f.pack, f.review);
  await writeFile(f.review, JSON.stringify({ approved: false })); await assert.rejects(f.client.publish(f.library, f.pack, f.review), { code: "review_required" });
  assert.equal((await f.client.open(f.library)).generation, first.generation);
  await mkdir(join(f.library, ".write-lock")); await assert.rejects(f.client.publish(f.library, null, null, { rebuild: true }), { code: "writer_busy" });
});
test("ordinary model scoring, repair, unknown IDs, shared budgets, reference-only content", async t => {
  const f = await fixture(t); await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library);
  const session = new RetrievalSession(f.client, { queries: 2, modelCalls: 2 }); let calls = 0;
  const result = await session.searchUnits({ keywords: ["竞价"], context: "准备描写一次拍卖" }, payload => ++calls === 1 ? { scores: [] } : { scores: payload.candidates.map(c => ({ id: c.id, score: 90 })) });
  assert.equal(calls, 2); assert.equal(result.status, "success"); assert.deepEqual(Object.keys(result.documents[0]), ["title", "content"]);
  await session.search({ text: "法宝" }); await assert.rejects(session.search({ text: "法宝" }), { code: "budget_exhausted" });
  await assert.rejects(session.read("flower"), { code: "selection_invalid" });
  assert.throws(() => validateScores({ scores: [{ id: "forged", score: 99 }] }, [{ id: "auction" }]), { code: "invalid_scores" });
  assert.throws(() => normalizeRequest({ text: "竞价", includeSemanticCandidates: true }), { code: "capability_unavailable" });
});

test("incremental keyword/revision updates and removed units leave pinned index intact", async t => {
  const f = await fixture(t); const first = await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library);
  const metadata = JSON.parse(await readFile(join(f.pack, "flower.json"), "utf8")); metadata.keywords.push("竞价");
  await writeFile(join(f.pack, "flower.json"), JSON.stringify(metadata));
  await assert.rejects(f.client.publish(f.library, f.pack, f.review), { code: "revision_conflict" });
  metadata.revision = 2; await writeFile(join(f.pack, "flower.json"), JSON.stringify(metadata));
  const second = await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library, second.generation);
  assert.equal((await f.client.search({ text: "竞价" })).length, 2);
  await writeFile(join(f.pack, "package.json"), JSON.stringify({ format: "creative-reference-library/v1", id: "synthetic", units: ["flower.json"] }));
  await writeFile(f.review, JSON.stringify({ format: "creative-reference-library/v1", packageId: "synthetic", approved: true, selectedIds: ["flower"] }));
  const third = await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library, third.generation);
  await assert.rejects(f.client.read("auction"), { code: "unit_not_found" });
  await f.client.open(f.library, first.generation); assert.match((await f.client.read("auction")).content, /秘密报价/);
});

test("necessary context stays complete; insufficient budgets omit the whole group", async t => {
  const f = await fixture(t);
  const metadata = JSON.parse(await readFile(join(f.pack, "auction.json"), "utf8")); metadata.relations = [{ id: "flower", kind: "context" }]; await writeFile(join(f.pack, "auction.json"), JSON.stringify(metadata));
  await writeFile(join(f.pack, "flower.md"), "背景说明🌸：交易在花园进行。");
  await f.client.publish(f.library, f.pack, f.review); await f.client.open(f.library);
  const limited = new RetrievalSession(f.client); await limited.search({ text: "竞价" });
  const omitted = await limited.compose(["auction"], { ...limited.ledger.limits, results: 1 }); assert.equal(omitted.status, "budget_limited"); assert.equal(omitted.documents.length, 0);
  const session = new RetrievalSession(f.client); await session.search({ text: "竞价" });
  const result = await session.compose(["auction"]); assert.equal(result.documents.length, 2);
  assert.equal(session.ledger.used.readCharacters, result.documents.reduce((sum, d) => sum + d.content.length, 0));
});

test("missing derived SQLite can be rebuilt from formal packages alone", async t => {
  const f = await fixture(t); const first = await f.client.publish(f.library, f.pack, f.review);
  await rm(join(f.library, "versions", first.generation, "text.sqlite")); await rm(f.pack, { recursive: true }); await rm(join(f.library, "maintenance"), { recursive: true });
  await f.client.publish(f.library, null, null, { rebuild: true }); await f.client.open(f.library);
  assert.equal((await f.client.search({ text: "竞价" }))[0].id, "auction");
});
