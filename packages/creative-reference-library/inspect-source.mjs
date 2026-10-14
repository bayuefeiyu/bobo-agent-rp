#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: inspect-source.mjs SOURCE PRIVATE-CHECKLIST.json");
const source = await readFile(input, "utf8");
let items;
if (input.toLowerCase().endsWith(".json")) {
  const parsed = JSON.parse(source), entries = parsed.entries ?? parsed.character_book?.entries ?? parsed.data?.character_book?.entries;
  if (!entries || typeof entries !== "object") throw new Error("Unsupported source: expected entries object/array. Inspect manually; no content was imported.");
  items = Object.entries(entries).map(([key, entry]) => ({ sourceId: String(entry.uid ?? entry.id ?? key), title: String(entry.comment ?? entry.name ?? entry.title ?? `条目${key}`), description: String(entry.content ?? "").slice(0, 200), sourceKeywords: entry.key ?? entry.keys ?? [], originalDisabled: entry.disable ?? (entry.enabled === undefined ? null : !entry.enabled), selected: null }));
} else items = [{ sourceId: "document", title: input.split(/[\\/]/).at(-1), description: source.slice(0, 200), selected: null }];
await writeFile(output, JSON.stringify({ schemaVersion: 1, sourceFingerprint: createHash("sha256").update(source).digest("hex"), approved: false, items }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Private review checklist created: ${items.length} candidates; nothing approved or published.`);
