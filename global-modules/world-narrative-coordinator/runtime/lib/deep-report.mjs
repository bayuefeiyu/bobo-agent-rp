/**
 * The deep report contract.
 *
 * The planning Agent returns the report as JSON text. Returning JSON is not the same as writing the
 * declared `deep-report.json` file, so the file is materialized by a deterministic node from the
 * Agent's structured output, and the commit node re-validates it before touching authoritative data
 * (RC-09). Both the materializer and the commit path use the functions below, so the report shape,
 * `basisTurn` and the world-narrative-topic rules cannot drift between them.
 */

export function parseDeepReport(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return structuredClone(value);
  if (typeof value !== "string") throw new Error("Deep report must be a JSON object or JSON text.");
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Deep report text is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Deep report must be a JSON object.");
  return parsed;
}

/**
 * Validate and normalize one deep report.
 *
 * The planning Agent is asked for a fixed set of fields and for `basisTurn` to equal the run's own
 * turn; `schemaVersion` is the materializer's marker, so a reply that omits it is normal and one that
 * contradicts it is not.
 *
 * Both directions of the `basisTurn` rule matter and they are different failures:
 *   - the Agent states a turn that is not this run's turn → reject, the report is about other inputs;
 *   - the Agent omits the turn → adopt the run's turn, because the run already froze it and demanding
 *     that the model echo a number the runtime owns turns a usable report into a failed node.
 */
export function validateDeepReport(value, { basisTurn } = {}) {
  // The run turn is the report's basis, so it is required from the caller rather than optional: a
  // report accepted without one would be stored without a basis and could not be checked again.
  if (!Number.isSafeInteger(basisTurn)) throw new Error("A deep report requires the run's turn as its basis.");
  const proposed = parseDeepReport(value);
  if (proposed.schemaVersion !== undefined && proposed.schemaVersion !== 1) throw new Error("Deep report schemaVersion must be 1 when it is present.");
  if (proposed.basisTurn !== undefined && proposed.basisTurn !== null && proposed.basisTurn !== basisTurn) {
    throw new Error(`Deep report basisTurn ${JSON.stringify(proposed.basisTurn)} is not this run's turn ${basisTurn}.`);
  }
  proposed.schemaVersion = 1;
  proposed.basisTurn = basisTurn;
  for (const field of ["coverage", "assumptions", "invalidatingSignals", "worldNarrativeTopics", "nextReviewTriggers"]) {
    if (!Array.isArray(proposed[field])) throw new Error(`Deep report ${field} must be an array.`);
  }
  for (const field of ["summary", "content"]) if (typeof proposed[field] !== "string") throw new Error(`Deep report ${field} must be text.`);
  if (proposed.referenceUpdates === undefined) proposed.referenceUpdates = [];
  if (!Array.isArray(proposed.referenceUpdates)) throw new Error("Deep report referenceUpdates must be an array.");
  if (proposed.worldNarrativeTopics.filter(item => item?.status === "active").length !== 1) throw new Error("Deep report must contain exactly one active world narrative topic.");
  if (!proposed.worldNarrativeTopics.some(item => item?.status === "backup")) throw new Error("Deep report must contain at least one backup world narrative topic.");
  return proposed;
}

/** The report as the declared artifact: the same validated object, serialized once. */
export function deepReportDocument(proposed) {
  return `${JSON.stringify(proposed, null, 2)}\n`;
}
