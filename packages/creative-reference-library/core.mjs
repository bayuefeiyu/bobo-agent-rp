import { readFile, writeFile, mkdir, rename, rm, realpath, lstat, copyFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FORMAT, INDEX_VERSION, id, exact, normalizeUnit, normalizeRequest, fail } from "./contract.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8"); };
export function tokens(text) {
  const result = new Set();
  for (const word of String(text).normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) result.add(chars[0]);
      for (let i = 0; i < chars.length - 1; i++) result.add(chars.slice(i, i + 2).join(""));
    } else result.add(word);
  }
  return [...result];
}
async function safeFile(root, path) {
  if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some(p => !p || p === "." || p === "..")) fail("invalid_format", "Unsafe content path.");
  const target = resolve(root, path), base = await realpath(root), actual = await realpath(target), rel = relative(base, actual);
  if (rel.startsWith("..") || isAbsolute(rel) || !(await lstat(target)).isFile()) fail("invalid_format", "Content escapes package.");
  return actual;
}
async function packageDescriptor(directory) {
  const manifest = await json(resolve(directory, "package.json"));
  exact(manifest, ["format", "id", "units"], "package");
  if (manifest.format !== FORMAT || !Array.isArray(manifest.units)) fail("invalid_format");
  id(manifest.id);
  if (new Set(manifest.units).size !== manifest.units.length) fail("invalid_format", "Duplicate unit path.");
  return { id: manifest.id, directory, paths: manifest.units };
}
async function* packageUnits(pack) {
  const seen = new Set(), targets = new Set();
  const directory = pack.directory;
  for (const path of pack.paths) {
    const metadata = await json(await safeFile(directory, path));
    const contentPath = await safeFile(directory, metadata.contentFile);
    const { contentFile, ...fields } = metadata;
    const unit = normalizeUnit({ ...fields, content: await readFile(contentPath, "utf8") });
    if (seen.has(unit.id)) fail("invalid_format", "Duplicate unit ID."); seen.add(unit.id);
    unit.relations.forEach(r => targets.add(r.id)); yield unit;
  }
  for (const target of targets) if (!seen.has(target)) fail("invalid_format", "Relation target is outside the selected package.");
}
export async function* formalUnits(root, snapshot) {
  for (const packageId of snapshot.packages) yield* packageUnits(await packageDescriptor(resolve(root, "versions", snapshot.generation, "packages", packageId)));
}
export async function loadPackage(directory) {
  const pack = await packageDescriptor(directory), units = [];
  for await (const unit of packageUnits(pack)) units.push(unit);
  return { id: pack.id, units };
}
async function writePackage(directory, pack, validate) {
  const paths = [];
  for await (const unit of packageUnits(pack)) {
    validate?.(unit);
    const { content, ...metadata } = unit;
    const path = `units/${unit.id}/unit.json`, contentFile = `units/${unit.id}/content.md`;
    await save(resolve(directory, path), { ...metadata, contentFile });
    await writeFile(resolve(directory, contentFile), content, "utf8"); paths.push(path);
  }
  await save(resolve(directory, "package.json"), { format: FORMAT, id: pack.id, units: paths });
}
async function buildIndex(path, packs, generation, previousPath) {
  if (previousPath) await copyFile(previousPath, path);
  const db = new DatabaseSync(path);
  try {
    if (!previousPath) db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE units(id TEXT PRIMARY KEY,package TEXT,revision INTEGER,title TEXT,summary TEXT,keywords TEXT,aliases TEXT,content TEXT,relations TEXT,fingerprint TEXT,characters INTEGER); CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,summary,terms,body,tokenize='unicode61');");
    db.exec("BEGIN");
    db.exec("CREATE TEMP TABLE selected(id TEXT PRIMARY KEY)");
    const select = db.prepare("INSERT INTO selected VALUES(?)"), oldUnit = db.prepare("SELECT rowid,fingerprint FROM units WHERE id=?"), rowId = db.prepare("SELECT rowid FROM units WHERE id=?"), removeFts = db.prepare("DELETE FROM search WHERE rowid=?");
    const insert = db.prepare("INSERT INTO units VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET package=excluded.package,revision=excluded.revision,title=excluded.title,summary=excluded.summary,keywords=excluded.keywords,aliases=excluded.aliases,content=excluded.content,relations=excluded.relations,fingerprint=excluded.fingerprint,characters=excluded.characters"), fts = db.prepare("INSERT INTO search(rowid,id,title,summary,terms,body) VALUES(?,?,?,?,?,?)");
    const seen = new Set();
    for (const pack of packs) for await (const u of packageUnits(pack)) {
      if (seen.has(u.id)) fail("invalid_format", "Unit IDs must be unique across packages."); seen.add(u.id);
      select.run(u.id); const old = oldUnit.get(u.id), fingerprint = hash(JSON.stringify(u));
      if (old?.fingerprint === fingerprint) continue;
      if (old) removeFts.run(old.rowid);
      insert.run(u.id, pack.id, u.revision, u.title, u.summary, JSON.stringify(u.keywords), JSON.stringify(u.aliases), u.content, JSON.stringify(u.relations), fingerprint, u.content.length);
      fts.run(rowId.get(u.id).rowid, u.id, tokens(u.title).join(" "), tokens(u.summary).join(" "), tokens([...u.keywords, ...u.aliases].join(" ")).join(" "), tokens(u.content).join(" "));
    }
    for (const removed of db.prepare("SELECT rowid FROM units WHERE NOT EXISTS(SELECT 1 FROM selected WHERE selected.id=units.id)").all()) removeFts.run(removed.rowid);
    db.exec("DELETE FROM units WHERE NOT EXISTS(SELECT 1 FROM selected WHERE selected.id=units.id)");
    const meta = db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)"); meta.run("generation", generation); meta.run("indexVersion", INDEX_VERSION);
    db.exec("COMMIT");
    return seen.size;
  } finally { db.close(); }
}
export async function publish(root, packDirectory, reviewPath, { rebuild = false } = {}) {
  await mkdir(root, { recursive: true });
  const lock = resolve(root, ".write-lock");
  try { await mkdir(lock); } catch (error) { if (error.code === "EEXIST") fail("writer_busy", "Another writer holds the library lock. Inspect before recovering a stale lock."); throw error; }
  const generation = randomUUID(), staging = resolve(root, "staging", generation);
  try {
    let current;
    try { current = await openSnapshot(root, undefined, rebuild); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const packs = [];
    if (current) for (const packageId of current.packages) packs.push(await packageDescriptor(resolve(root, "versions", current.generation, "packages", packageId)));
    let review, incoming, approved;
    if (!rebuild) {
      incoming = await packageDescriptor(packDirectory); review = await json(reviewPath);
      if (review.format !== FORMAT || review.approved !== true || review.packageId !== incoming.id || !Array.isArray(review.selectedIds) || new Set(review.selectedIds).size !== review.selectedIds.length || review.selectedIds.length !== incoming.paths.length) fail("review_required", "Approved selection must exactly match the converted units.");
      approved = new Set(review.selectedIds);
      const index = packs.findIndex(p => p.id === incoming.id); if (index >= 0) packs.splice(index, 1); packs.push(incoming);
    } else if (!current) fail("library_unbound");
    await mkdir(staging, { recursive: true });
    const previousReader = current && !rebuild ? new SnapshotReader(root, current) : null;
    const stagedPacks = [];
    try {
      for (const pack of packs) {
        const directory = resolve(staging, "packages", pack.id);
        await writePackage(directory, pack, pack === incoming ? unit => {
          if (!approved.has(unit.id)) fail("review_required", "Converted unit is outside the approved selection.");
          const old = previousReader?.db.prepare("SELECT package,revision,fingerprint FROM units WHERE id=?").get(unit.id);
          if (old?.package === pack.id && hash(JSON.stringify(unit)) !== old.fingerprint && unit.revision <= old.revision) fail("revision_conflict");
        } : null);
        stagedPacks.push(await packageDescriptor(directory));
      }
    } finally { previousReader?.close(); }
    const unitCount = await buildIndex(resolve(staging, "text.sqlite"), stagedPacks, generation, !rebuild && current ? resolve(root, "versions", current.generation, "text.sqlite") : null);
    const manifest = { format: FORMAT, generation, packages: packs.map(p => p.id), indexVersion: INDEX_VERSION };
    await save(resolve(staging, "manifest.json"), manifest);
    await mkdir(resolve(root, "versions"), { recursive: true });
    await rename(staging, resolve(root, "versions", generation));
    if (review) await save(resolve(root, "maintenance", "imports", `${generation}.json`), review);
    const pending = resolve(root, `library.${generation}.json`); await save(pending, manifest);
    await rename(pending, resolve(root, "library.json"));
    return { generation, units: unitCount };
  } finally { await rm(staging, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
}
export async function openSnapshot(root, generation, allowIndexMismatch = false) {
  const manifest = await json(generation ? resolve(root, "versions", id(generation), "manifest.json") : resolve(root, "library.json"));
  if (manifest.format !== FORMAT || !allowIndexMismatch && manifest.indexVersion !== INDEX_VERSION || !Array.isArray(manifest.packages)) fail("index_incompatible");
  id(manifest.generation); manifest.packages.forEach(id);
  return manifest;
}
export class SnapshotReader {
  constructor(root, snapshot) {
    this.snapshot = snapshot;
    this.db = new DatabaseSync(resolve(root, "versions", snapshot.generation, "text.sqlite"), { readOnly: true });
    if (this.db.prepare("SELECT value FROM meta WHERE key='generation'").get()?.value !== snapshot.generation || this.db.prepare("SELECT value FROM meta WHERE key='indexVersion'").get()?.value !== INDEX_VERSION) { this.db.close(); fail("index_incompatible"); }
  }
  close() { this.db.close(); }
  search(input) {
    const request = normalizeRequest(input), terms = tokens([request.text, ...request.keywords].join(" ")).slice(0, 64);
    if (!terms.length) return [];
    const merged = new Map(), perRoute = Math.min(60, request.budget.candidates);
    for (const field of request.fields) {
      const query = `${field} : (${terms.map(t => '"' + t.replaceAll('"', '""') + '"').join(" OR ")})`;
      const rows = this.db.prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?").all(query, perRoute);
      rows.forEach((row, index) => merged.set(row.id, (merged.get(row.id) ?? 0) + 1 / (60 + index)));
    }
    const get = this.db.prepare("SELECT id,title,summary FROM units WHERE id=?");
    const locate = this.db.prepare("SELECT instr(lower(content),?) AS position FROM units WHERE id=?");
    const excerpt = this.db.prepare("SELECT substr(content,?,1200) AS excerpt FROM units WHERE id=?");
    return [...merged].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, request.budget.candidates).map(([unitId]) => {
      const row = get.get(unitId);
      const positions = [...request.keywords, ...terms].slice(0, 16).map(t => locate.get(t.toLowerCase(), unitId).position).filter(n => n > 0);
      const start = Math.max(1, (positions.length ? Math.min(...positions) : 1) - 160);
      return { ...row, excerpt: excerpt.get(start, unitId).excerpt };
    });
  }
  read(unitId) {
    id(unitId); const row = this.db.prepare("SELECT id,title,content,relations FROM units WHERE id=?").get(unitId);
    if (!row) fail("unit_not_found"); return { ...row, relations: JSON.parse(row.relations) };
  }
  inspect(unitId) {
    id(unitId); const row = this.db.prepare("SELECT id,title,characters,length(CAST(content AS BLOB)) AS bytes,fingerprint,relations FROM units WHERE id=?").get(unitId);
    if (!row) fail("unit_not_found"); return { ...row, relations: JSON.parse(row.relations) };
  }
  measureRanges(unitId, ranges) {
    id(unitId); if (!Array.isArray(ranges) || ranges.length > 200) fail("selection_invalid");
    const get = this.db.prepare("SELECT substr(CAST(content AS BLOB),?,?) AS body FROM units WHERE id=?");
    let characters = 0;
    for (const [start, end] of ranges) { if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 8000000) fail("selection_invalid"); const row = get.get(start + 1, end - start, unitId); if (!row) fail("unit_not_found"); characters += Buffer.from(row.body).toString("utf8").length; }
    return characters;
  }
  readRanges(unitId, ranges) {
    this.measureRanges(unitId, ranges);
    const get = this.db.prepare("SELECT substr(CAST(content AS BLOB),?,?) AS body FROM units WHERE id=?");
    return ranges.map(([start, end]) => Buffer.from(get.get(start + 1, end - start, unitId).body).toString("utf8")).join("\n").trim();
  }
}
