import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

parentPort.on("message", ({ id, path, operation, input }) => {
  let db;
  try {
    mkdirSync(dirname(path), { recursive: true }); db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS passages (id TEXT PRIMARY KEY, space TEXT NOT NULL, chunk TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, vector BLOB NOT NULL); CREATE INDEX IF NOT EXISTS passage_source ON passages(space,chunk,source); CREATE TABLE IF NOT EXISTS coverage (space TEXT NOT NULL, chunk TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(space,chunk,source));");
    let result;
    if (operation === "coverage") result = db.prepare("SELECT source FROM coverage WHERE space=? AND chunk=?").all(input.space,input.chunk).map(row => row.source);
    else if (operation === "publish") {
      db.exec("BEGIN IMMEDIATE");
      try {
        const totals = db.prepare("SELECT count(*) count,coalesce(sum(length(vector)),0) bytes FROM passages").get();
        const fresh = input.passages.filter(item => !db.prepare("SELECT 1 FROM passages WHERE id=? AND space=?").get(`${input.space}:${item.id}`,input.space));
        if (totals.count+fresh.length > 100000 || totals.bytes+fresh.reduce((sum,item) => sum+item.vector.length*4,0) > 536870912) throw Object.assign(new Error("History index capacity exceeded."), { code: "history_capacity_exceeded" });
        const put = db.prepare("INSERT OR REPLACE INTO passages VALUES (?,?,?,?,?,?)");
        for (const { vector,...item } of input.passages) put.run(`${input.space}:${item.id}`,input.space,input.chunk,item.sourceKey,JSON.stringify(item),Buffer.from(new Float32Array(vector).buffer));
        db.prepare("INSERT OR IGNORE INTO coverage VALUES (?,?,?)").run(input.space,input.chunk,input.source);
        db.exec("COMMIT"); result = true;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } else if (operation === "search") {
      const allowed = new Set(input.allowed), vectors = input.vectors, top = vectors.map(() => []);
      for (const row of db.prepare("SELECT data,source,vector FROM passages WHERE space=? AND chunk=?").iterate(input.space,input.chunk)) {
        if (!allowed.has(row.source)) continue;
        if (Date.now() > input.deadline) throw Object.assign(new Error("History query timed out."), { code: "query_timeout" });
        const bytes = Buffer.from(row.vector);
        if (bytes.length !== input.dimensions*4) throw Object.assign(new Error("Corrupt history vector."), { code: "history_index_corrupt" });
        for (let q=0;q<vectors.length;q++) {
          let score = 0; for (let i=0;i<input.dimensions;i++) { const n = bytes.readFloatLE(i*4); if (!Number.isFinite(n)) throw Object.assign(new Error("Corrupt history vector."), { code: "history_index_corrupt" }); score += n*vectors[q][i]; }
          const list = top[q]; if (list.length < input.limit || score > list.at(-1).vectorScore) { list.push({ ...JSON.parse(row.data),vectorScore: score }); list.sort((a,b) => b.vectorScore-a.vectorScore || a.id.localeCompare(b.id)); if (list.length > input.limit) list.pop(); }
        }
      }
      result = [...new Map(top.flat().map(item => [item.id,item])).values()];
    } else if (operation === "reset") { db.prepare("DELETE FROM passages WHERE space=? AND chunk=?").run(input.space,input.chunk); db.prepare("DELETE FROM coverage WHERE space=? AND chunk=?").run(input.space,input.chunk); result = true; }
    else throw new Error("Unknown history index operation.");
    parentPort.postMessage({ id,result });
  } catch (error) { const code = error.code?.startsWith("ERR_SQLITE") ? /malformed|not a database|corrupt/i.test(error.message) ? "history_index_corrupt" : "history_index_unavailable" : error.code ?? "history_index_unavailable"; parentPort.postMessage({ id,error: { code,message:error.message } }); }
  finally { db?.close(); }
});
