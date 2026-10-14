import { CHUNKER_VERSION, digest } from "./semantic-contract.mjs";

// Offsets address the original UTF-8 body; generated table headers are explicit
// ranges, not invented prose. Each yielded reading block has closed structure.
export function slicePassages(unit, config) {
  const text = unit.content, lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
  const blocks = [], headings = []; let skipped = 0;
  const block = (start, end, kind, extra = []) => ({ start, end, kind, extra, headingPath: [...headings] });
  for (let i = 0; i < lines.length;) {
    const line = lines[i], trimmed = line[0].trim();
    if (!trimmed) { i++; continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { headings.length = heading[1].length - 1; headings[heading[1].length - 1] = heading[2]; i++; continue; }
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const start = i++; while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i][0])) i++;
      if (i === lines.length) { skipped++; continue; } i++;
      blocks.push(block(lines[start].index, i < lines.length ? lines[i].index : text.length, "atomic")); continue;
    }
    if (i + 1 < lines.length && trimmed.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1][0])) {
      const start = i, headerEnd = lines[i + 1].index + lines[i + 1][0].length; i += 2;
      const rows = []; while (i < lines.length && lines[i][0].trim().includes("|")) rows.push(lines[i++]);
      if (!rows.length) blocks.push(block(lines[start].index, headerEnd, "atomic"));
      else for (const row of rows) blocks.push(block(row.index, row.index + row[0].length, "table", [[lines[start].index, headerEnd]]));
      continue;
    }
    const structured = /^\s*(?:[-+*]\s|\d+[.)]\s|>)/.test(line[0]);
    const start = i++;
    while (i < lines.length && lines[i][0].trim() && !/^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(lines[i][0]) && !(i + 1 < lines.length && lines[i][0].includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1][0]))) i++;
    blocks.push(block(lines[start].index, i < lines.length ? lines[i].index : text.length, structured ? "atomic" : "paragraph"));
  }
  const pieces = [];
  for (const item of blocks) {
    const raw = text.slice(item.start, item.end), overhead = item.extra.reduce((n, [a, b]) => n + b - a, 0);
    const max = config.chunking.maxCharacters;
    if (item.kind === "paragraph" && raw.length > max) {
      let cursor = item.start;
      while (cursor < item.end) {
        let end = Math.min(cursor + max, item.end);
        if (end < item.end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const segment = text.slice(cursor, end); let count = segment.length;
        const boundary = [...segment.matchAll(/[。！？.!?;；\n]\s*/g)].at(-1); if (boundary && boundary.index >= count / 2) count = boundary.index + boundary[0].length;
        pieces.push({ ...item, start: cursor, end: cursor + count }); cursor += count;
      }
    } else if (raw.length + overhead + unit.title.length + item.headingPath.join(" / ").length + 4 > Math.min(config.embedding.maxInputCharacters - config.embedding.documentPrefix.length, config.rerank.maxInputCharacters - 128)) skipped++;
    else pieces.push(item);
  }
  const fingerprint = digest(JSON.stringify(unit)), result = [];
  const offsets = [...new Set(pieces.flatMap(p => [p.start, p.end, ...p.extra.flat()]))].sort((a, b) => a - b), byteOffsets = new Map();
  let previousOffset = 0, bytes = 0;
  for (const offset of offsets) { bytes += Buffer.byteLength(text.slice(previousOffset, offset), "utf8"); byteOffsets.set(offset, bytes); previousOffset = offset; }
  const byteOffset = offset => byteOffsets.get(offset);
  let bucket = [], size = 0;
  const emit = () => {
    if (!bucket.length) return;
    const spans = [], added = new Set();
    for (const piece of bucket) { for (const range of [...piece.extra, [piece.start, piece.end]]) { const key = range.join(":"); if (!added.has(key)) { added.add(key); spans.push(range); } } }
    const content = spans.map(([a, b]) => text.slice(a, b)).join("").trim(), headingPath = bucket[0].headingPath.filter(Boolean), prefix = [unit.title, ...headingPath].join(" / ");
    const input = `${prefix}\n\n${content}`;
    if (input.length + config.embedding.documentPrefix.length > config.embedding.maxInputCharacters || input.length + 128 > config.rerank.maxInputCharacters) { skipped++; bucket = []; size = 0; return; }
    const ranges = spans.map(([a, b]) => [byteOffset(a), byteOffset(b)]);
    const passageId = `p-${digest({ unit: unit.id, fingerprint, ranges, chunker: CHUNKER_VERSION }).slice(0, 40)}`;
    result.push({ id: passageId, unitId: unit.id, unitRevision: unit.revision, unitFingerprint: fingerprint, headingPath, title: prefix, ranges, content, input, inputHash: digest(input), relations: unit.relations });
    bucket = []; size = 0;
  };
  for (const piece of pieces) {
    const pieceSize = piece.end - piece.start + piece.extra.reduce((n, [a, b]) => n + b - a, 0);
    const compatible = bucket.length && JSON.stringify(bucket[0].headingPath) === JSON.stringify(piece.headingPath) && bucket[0].kind === piece.kind && piece.kind !== "atomic";
    if (bucket.length && (!compatible || size + pieceSize > config.chunking.targetCharacters)) {
      const previous = bucket.at(-1); emit();
      if (compatible && previous.end - previous.start <= config.chunking.overlapCharacters && piece.kind === "paragraph") { bucket.push(previous); size += previous.end - previous.start; }
    }
    bucket.push(piece); size += pieceSize;
    if (piece.kind === "atomic") emit();
  }
  emit(); return { passages: result, skipped };
}
