/**
 * Parsing a JSON-mode Agent reply.
 *
 * An Agent told to "reply with JSON" still writes like a model: a sentence of preamble, a fenced
 * block, or a trailing note. The runtime used to accept only a reply that was JSON from its first
 * character, so a perfectly good answer failed with "must return valid JSON" and the node stopped —
 * on the opening director that blocked the whole card before the first player input (and the field
 * log had no way to tell why, because the message did not quote what arrived).
 *
 * The contract is therefore explicit: a JSON-mode node's reply may carry prose around **one** JSON
 * document, and it is located in this order — the whole reply, the first fenced block, then the first
 * balanced value. Anything else is a real failure and is reported with the reply's opening text.
 */

/** Attempts, in order, that {@link parseAgentJson} makes on one reply. */
export function extractJsonCandidates(text) {
  const candidates = [];
  const trimmed = String(text ?? "").trim();
  if (trimmed) candidates.push({ source: "whole-reply", text: trimmed });
  const fence = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/.exec(trimmed);
  if (fence) candidates.push({ source: "fenced-block", text: fence[1].trim() });
  const balanced = firstBalancedValue(trimmed);
  if (balanced) candidates.push({ source: "balanced-value", text: balanced });
  return candidates.filter((candidate, index, list) => candidate.text && list.findIndex(item => item.text === candidate.text) === index);
}

/** The first complete `{...}` or `[...]` in the text, ignoring braces inside strings. */
function firstBalancedValue(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const stack = [];
  const pairs = { "{": "}", "[": "]" };
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (pairs[character]) {
      stack.push(pairs[character]);
      continue;
    }
    if (character === "}" || character === "]") {
      if (!stack.length || stack.pop() !== character) return null;
      if (!stack.length) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parse one JSON-mode reply.
 *
 * Returns `{ ok: true, value, source }` or `{ ok: false, reason, characters, preview }`, where
 * `preview` is bounded and whitespace-collapsed so an error message can quote what actually arrived.
 */
export function parseAgentJson(text) {
  const raw = String(text ?? "");
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  const candidates = extractJsonCandidates(normalized);
  let lastReason = "the reply contained no JSON value";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate.text), source: candidate.source };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ok: false,
    reason: lastReason,
    characters: normalized.length,
    preview: normalized.replace(/\s+/g, " ").slice(0, 400),
  };
}
