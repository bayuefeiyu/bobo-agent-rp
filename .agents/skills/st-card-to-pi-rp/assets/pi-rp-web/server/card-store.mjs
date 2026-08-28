import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function safeCardPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath)) {
    throw new Error("Card manifest contains an invalid relative path.");
  }
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Card manifest path escapes the card directory.");
  }
  return target;
}

function stripFrontmatter(markdown) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? normalized.trim() : normalized.slice(end + 5).trim();
}

function substituteMacros(text, cardName, playerName) {
  return text
    .replaceAll("{{char}}", cardName)
    .replaceAll("<char>", cardName)
    .replaceAll("<bot>", cardName)
    .replaceAll("{{user}}", playerName)
    .replaceAll("<user>", playerName);
}

export function createCardStore(cardDirectory) {
  const root = resolve(cardDirectory);

  async function readManifest() {
    const raw = await readFile(resolve(root, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    if (!manifest.id || !manifest.name || !Array.isArray(manifest.openings) || manifest.openings.length === 0) {
      throw new Error("Card manifest must include id, name, and at least one opening.");
    }
    return manifest;
  }

  async function readOpeningRecord(record) {
    const raw = await readFile(safeCardPath(root, record.file), "utf8");
    return {
      id: record.id,
      title: record.title || record.id,
      source: record.source || "",
      content: stripFrontmatter(raw),
    };
  }

  return {
    async validate() {
      const manifest = await readManifest();
      const ids = new Set();
      for (const record of manifest.openings) {
        if (!record.id || ids.has(record.id)) throw new Error("Opening IDs must be present and unique.");
        ids.add(record.id);
        await readOpeningRecord(record);
      }
    },

    async getPublicCard() {
      const manifest = await readManifest();
      const openings = await Promise.all(manifest.openings.map(readOpeningRecord));
      return {
        id: manifest.id,
        name: manifest.name,
        defaultOpening: manifest.default_opening || openings[0].id,
        openings,
      };
    },

    async getOpening(openingId, playerName) {
      const manifest = await readManifest();
      const record = manifest.openings.find(opening => opening.id === openingId);
      if (!record) {
        const error = new Error("Opening not found.");
        error.status = 404;
        throw error;
      }
      const opening = await readOpeningRecord(record);
      return {
        cardId: manifest.id,
        cardName: manifest.name,
        playerName,
        ...opening,
        content: substituteMacros(opening.content, manifest.name, playerName),
      };
    },

    async getRuntimeCard() {
      const manifest = await readManifest();
      return { directory: root, manifest };
    },
  };
}
