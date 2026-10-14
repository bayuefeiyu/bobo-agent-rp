import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { renderDataRecordView } from "./rp-data-views.mjs";
import { validateRecordEnvelope } from "./rp-records.mjs";
import { normalizeNarrativeSource } from "./rp-narrative-source.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function normalizeTranscriptProvider(value) {
  const fields = ["schemaVersion", "moduleId", "collectionId", "recordType", "view"];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error("Transcript provider must use the exact v1 field set.");
  for (const key of fields.slice(1)) if (typeof value[key] !== "string" || !SAFE_ID.test(value[key])) throw new Error(`Invalid transcript provider ${key}.`);
  return { schemaVersion: 1, moduleId: value.moduleId, collectionId: value.collectionId, recordType: value.recordType, view: value.view };
}

export function resolveTranscriptProvider(manifest, modules) {
  let value = manifest.transcript_provider;
  if (value === undefined) {
    const candidates = modules.filter(module => module.contract?.collections?.conversation?.recordTypes?.["narrative.message"]);
    if (candidates.length !== 1) throw new Error("Declare exactly one transcript_provider for this card.");
    value = { schemaVersion: 1, moduleId: candidates[0].contract.moduleId, collectionId: "conversation", recordType: "narrative.message", view: "rp" };
  }
  const provider = normalizeTranscriptProvider(value);
  const contract = modules.find(module => module.contract?.moduleId === provider.moduleId)?.contract;
  const collection = contract?.collections?.[provider.collectionId];
  const type = collection?.recordTypes?.[provider.recordType];
  if (collection?.storage?.kind !== "record-log" || !type || type.views?.[provider.view]?.format !== "object" || !["create", "update", "delete"].every(action => type.actions?.includes(action))) throw new Error("Transcript provider must reference an installed record-log type with an object view and create/update/delete actions.");
  const keys = new Set(type.views[provider.view].fields.map(field => field.label || field.path.split("/").at(-1)));
  if (!["role", "kind", "content", "narrativeSource"].every(key => keys.has(key))) throw new Error("Transcript provider view must expose role, kind, content, and narrativeSource.");
  return provider;
}

export function projectTranscript(records, contract, provider) {
  const result = records.filter(record => record.recordType === provider.recordType && record.status === "active").sort((a, b) => a.sequence - b.sequence).map(record => {
    if (record.binding.messageId !== record.id) throw new Error(`Transcript document ${record.id} must bind to its own message ID.`);
    const value = renderDataRecordView(record, contract, provider.view);
    if (!["user", "assistant"].includes(value.role) || !["opening", "message"].includes(value.kind) || typeof value.content !== "string") throw new Error(`Transcript document ${record.id} does not satisfy the message view protocol.`);
    return validateRecordEnvelope({ schemaVersion: 1, id: record.id, source: "messages", sequence: record.sequence, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
      binding: { messageId: record.id, turn: record.binding.turn }, metadata: { recordType: value.kind, entityIds: [], tags: [value.role], narrativeSource: normalizeNarrativeSource(value.narrativeSource) }, data: { role: value.role, kind: value.kind, content: value.content } });
  });
  if (result.some((record, index) => record.sequence !== index || (index > 0 && record.binding.turn < result[index - 1].binding.turn))) throw new Error("Transcript document sequence must be a contiguous message timeline with nondecreasing turns.");
  return result;
}

export function transcriptFingerprint(messages) {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/** One range view over live or frozen message projections; no separate archive store. */
export function selectTranscriptRange(messages, { fromTurn = 0, toTurn = Number.MAX_SAFE_INTEGER, afterSequence = -1, beforeSequence = Number.MAX_SAFE_INTEGER } = {}) {
  return messages.filter(record => record.binding.turn >= fromTurn && record.binding.turn <= toTurn && (afterSequence === -1 || record.sequence > afterSequence) && (beforeSequence === Number.MAX_SAFE_INTEGER || record.sequence < beforeSequence));
}

export function transcriptProjectionFiles(sessionDirectory, state, contract, provider) {
  const messages = projectTranscript(state.records, contract, provider);
  const marker = { schemaVersion: 1, provider, recordCount: messages.length, fingerprint: transcriptFingerprint(messages) };
  return [
    { path: resolve(sessionDirectory, "messages.jsonl"), content: messages.map(record => JSON.stringify(record)).join("\n") + (messages.length ? "\n" : "") },
    { path: resolve(sessionDirectory, "transcript.json"), content: `${JSON.stringify(marker, null, 2)}\n` },
  ];
}
