import { chunkKey, digest } from "./contract.mjs";

// JavaScript UTF-16 offsets address the unchanged source string. Never split a surrogate pair.
function safeEnd(text, end) { return end < text.length && /[\uD800-\uDBFF]/.test(text[end-1]) ? end-1 : end; }
export function sliceNarrative(source, settings) {
  const text = source.content, blocks = [];
  for (const match of text.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)) {
    let start = match.index, stop = start + match[0].length;
    while (stop-start > settings.maxCharacters) {
      let end = safeEnd(text, start + settings.maxCharacters);
      const segment = text.slice(start,end), boundary = [...segment.matchAll(/[。！？.!?；;][”’"']?\s*/g)].at(-1);
      if (boundary && boundary.index >= segment.length/2) end = start + boundary.index + boundary[0].length;
      blocks.push([start,end]); start = end;
    }
    if (stop > start) blocks.push([start,stop]);
  }
  const ranges = []; let start = null, end = null;
  for (const [a,b] of blocks) {
    if (start !== null && (b-start > settings.maxCharacters || end-start >= settings.targetCharacters)) { ranges.push([start,end]); start = null; }
    if (start === null) start = a; end = b;
  }
  if (start !== null) ranges.push([start,end]);
  if (ranges.length > 1) {
    const tail = ranges.at(-1), previous = ranges.at(-2);
    if (tail[1]-tail[0] < settings.shortTailCharacters && tail[1]-previous[0] <= settings.maxCharacters) { previous[1] = tail[1]; ranges.pop(); }
  }
  return ranges.map(([a,b], index) => {
    let overlapStart = a;
    if (index && settings.overlapCharacters) {
      const previous = ranges[index-1];
      const lower = Math.max(previous[0], previous[1]-settings.overlapCharacters, b-settings.maxCharacters);
      const paragraph = blocks.find(([x,y]) => x >= lower && y <= a);
      if (paragraph) overlapStart = paragraph[0];
      else { const suffix = text.slice(lower,a), boundary = suffix.search(/[。！？.!?；;]\s*/); if (boundary >= 0) overlapStart = lower + boundary + 1; }
    }
    return { id: digest([source.key,chunkKey(settings),overlapStart,b]), sourceKey: source.key, messageId: source.id, revision: source.revision, turn: source.turn, start: overlapStart, end: b, content: text.slice(overlapStart,b) };
  });
}
export function composeExcerpts(selected, all, settings) {
  const byKey = new Map(all.map(source => [source.key,source])), groups = new Map();
  for (const item of selected) {
    const source = byKey.get(item.sourceKey); if (!source) continue;
    // Add at most one adjacent paragraph on either side, under a fixed expansion budget.
    const before = source.content.slice(0,item.start), after = source.content.slice(item.end);
    const left = before.match(/[^\r\n]+(?:\r?\n)?\s*$/)?.[0] ?? "";
    const right = after.match(/^\s*[^\r\n]+/)?.[0] ?? "";
    const start = item.start-(left.length <= 300 ? left.length : 0), end = item.end+(right.length <= 300 ? right.length : 0);
    const entries = groups.get(source.key) ?? []; entries.push({ ...item,start,end }); groups.set(source.key,entries);
  }
  const merged = [];
  for (const [key,items] of groups) {
    items.sort((a,b) => a.start-b.start); const ranges = [];
    for (const item of items) { const previous = ranges.at(-1); if (previous && item.start <= previous.end) { previous.end = Math.max(previous.end,item.end); previous.score = Math.max(previous.score,item.score); } else ranges.push({ ...item }); }
    for (const range of ranges) merged.push({ ...range, content: byKey.get(key).content.slice(range.start,range.end) });
  }
  merged.sort((a,b) => b.score-a.score || a.turn-b.turn || a.start-b.start);
  const result = [], perTurn = new Map(); let size = 0;
  for (const item of merged) {
    if (result.length >= settings.maxResults) break;
    if ((perTurn.get(item.turn) ?? 0) >= settings.maxPerTurn || size+item.content.length > settings.maxOutputCharacters) continue;
    result.push(item); size += item.content.length; perTurn.set(item.turn,(perTurn.get(item.turn) ?? 0)+1);
  }
  return result.sort((a,b) => a.turn-b.turn || a.start-b.start).map(({ turn,content,messageId,revision,start,end }) => ({ turn,content,messageId,revision,start,end }));
}
