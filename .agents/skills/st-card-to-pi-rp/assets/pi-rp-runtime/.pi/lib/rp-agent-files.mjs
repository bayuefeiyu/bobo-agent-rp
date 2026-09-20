import { lstat, readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";

const TEXT = new Set([".md", ".txt", ".json", ".jsonl", ".csv", ".yaml", ".yml"]);

export function countText(raw, { stripMarkdown = false } = {}) {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const text = stripMarkdown ? normalized
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]/g, "") : normalized;
  const graphemes = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text)].map(item => item.segment);
  const cjkChars = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const cjkPunctuation = (text.match(/[、。，！？；：「」『』（）【】《》〈〉〔〕［］｛｝“”‘’—…]/gu) || []).length;
  const latinWords = (text.match(/[\p{Script=Latin}\p{N}]+(?:['’\-][\p{Script=Latin}\p{N}]+)*/gu) || []).length;
  return { words: cjkChars + cjkPunctuation + latinWords, wordsNoPunctuation: cjkChars + latinWords, cjkChars, latinWords, chars: graphemes.length, charsNoWhitespace: graphemes.filter(value => !/^\s+$/u.test(value)).length, lines: text ? text.split("\n").length : 0, paragraphs: text.trim() ? text.trim().split(/\n\s*\n/).length : 0, bytes: Buffer.byteLength(raw), stripMarkdown, countingRule: "CJK characters + Chinese punctuation + Latin/numeric words; bytes are not words. Markdown stripping is approximate." };
}

export async function agentFiles(delivery, { action, path = ".", recursive = false, limit = 100 }) {
  const target = await delivery.access(path, false, action === "list");
  if (action === "count") {
    const info = await lstat(target.path);
    if (!info.isFile() || !TEXT.has(extname(path).toLowerCase())) throw new Error("count accepts a text file (.md, .txt, .json, .jsonl, .csv, .yaml, .yml).");
    if (info.size > 1024 * 1024) throw new Error("count accepts files up to 1 MiB; the file was not partially counted.");
    return { path, ...countText(await readFile(target.path, "utf8"), { stripMarkdown: extname(path).toLowerCase() === ".md" }) };
  }
  if (action !== "list") throw new Error("Supported actions: list, count.");
  const maximum = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 100, 500));
  const entries = [];
  let truncated = false;
  const visit = async (directory, relativePath, depth) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".rp-delivery") continue;
      if (entries.length >= maximum) { truncated = true; return; }
      const child = [relativePath, entry.name].filter(Boolean).join("/");
      if (entry.isSymbolicLink()) { entries.push({ path: child, kind: "unavailable-link" }); continue; }
      const resolved = await delivery.access(child);
      const info = await lstat(resolved.path);
      let writable = true;
      try { await delivery.access(child, true); } catch { writable = false; }
      entries.push({ path: child, kind: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : null, writable });
      if (recursive && info.isDirectory()) {
        if (depth < 3) await visit(resolved.path, child, depth + 1);
        else truncated = true;
      }
    }
  };
  await visit(target.path, target.relative, 0);
  return { entries, truncated, deliveries: delivery.receipts.map(({ output, path, version }) => ({ output, path, version })) };
}
