// Repeatable synthetic benchmark; no community material or model/network calls.
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { LibraryClient } from "./client.mjs";
const count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 10 || count > 100000) throw new Error("Count must be 10..100000.");
const root = await mkdtemp(join(tmpdir(), "reference-benchmark-")), pack = join(root, "source"), client = new LibraryClient();
try {
  await mkdir(pack); const paths = [], ids = [];
  for (let i = 0; i < count; i++) {
    const id = `synthetic-${i}`, auction = i % 20 === 0, title = auction ? `修仙拍卖素材${i}` : `庭院资料${i}`;
    paths.push(`${id}.json`); ids.push(id);
    await writeFile(join(pack, `${id}.json`), JSON.stringify({ id, revision: 1, title, summary: auction ? "珍宝竞价与社交交往" : "植物种植记录", keywords: auction ? ["法宝", "竞价"] : ["花园"], aliases: [], contentFile: `${id}.md` }));
    await writeFile(join(pack, `${id}.md`), `原创合成材料${i}。` + "日常观察记录，内容仅用于测试。".repeat(40) + (auction ? "\n竞价采用轮次报价，法宝需要展示。" : "\n花园清晨浇水。"));
  }
  await writeFile(join(pack, "package.json"), JSON.stringify({ format: "creative-reference-library/v1", id: "benchmark", units: paths }));
  const review = join(root, "review.json"); await writeFile(review, JSON.stringify({ format: "creative-reference-library/v1", packageId: "benchmark", approved: true, selectedIds: ids }));
  const started = performance.now(), published = await client.publish(join(root, "library"), pack, review), buildMs = performance.now() - started;
  const coldStart = performance.now(); await client.open(join(root, "library")); const coldResult = await client.search({ text: "竞价", budget: { candidates: 40 } }); const coldMs = performance.now() - coldStart;
  const timings = [];
  for (let i = 0; i < 30; i++) { const start = performance.now(); const results = await client.search({ keywords: i % 2 ? ["竞价", "法宝"] : ["花园"], budget: { candidates: 40 } }); if (results.length > 40) throw new Error("Candidate budget violated."); timings.push(performance.now() - start); }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ count, buildMs, coldMs, p50Ms: timings[15], p95Ms: timings[28], indexBytes: (await stat(join(root, "library", "versions", published.generation, "text.sqlite"))).size, processRssBytes: process.memoryUsage().rss, candidates: coldResult.length, relevantCandidates: coldResult.filter(r => r.title.startsWith("修仙拍卖")).length, node: process.versions.node }, null, 2));
} finally { await client.close(); await rm(root, { recursive: true, force: true }); }
