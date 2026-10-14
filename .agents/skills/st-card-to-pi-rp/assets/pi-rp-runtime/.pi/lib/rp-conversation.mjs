import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeDataBatchOrThrow, withDataCommitLock } from "./rp-data-changes.mjs";
import { recoverDataTransactions } from "./rp-data-transactions.mjs";
import { normalizeNarrativeSource } from "./rp-narrative-source.mjs";
import { normalizeTranscriptProvider, projectTranscript, selectTranscriptRange, transcriptFingerprint } from "./rp-transcript-projection.mjs";
import { renderDataRecordView } from "./rp-data-views.mjs";

export { resolveTranscriptProvider } from "./rp-transcript-projection.mjs";
const key = value => createHash("sha256").update(value).digest("hex");
async function optionalText(path) {
  return readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
}

/** Trusted host facade. Agents receive projections, never direct transcript write authority. */
export function createConversationService({ store, provider: configured }) {
  const provider = normalizeTranscriptProvider(configured);
  const contract = store.module(provider.moduleId).contract;
  store.transcriptProvider = provider;
  const capabilities = Object.entries(contract.capabilities).filter(([, capability]) => capability.collections.includes(provider.collectionId)).map(([id]) => id);
  const access = [{ moduleId: provider.moduleId, collectionId: provider.collectionId, capabilities, views: [provider.view] }];
  const state = () => store.readCollection(provider.moduleId, provider.collectionId);
  const committedState = () => withDataCommitLock(store.sessionDirectory, async () => {
    await recoverDataTransactions(store.sessionDirectory);
    return state();
  });
  const projection = current => projectTranscript(current.records, contract, provider);
  const operation = async (action, { id, data, expectedRevision, operationId, binding }) => {
    if (typeof operationId !== "string" || !operationId.trim()) throw new Error("Transcript writes require an operation ID.");
    const batchId = `transcript-${key(operationId)}`;
    const receipt = await executeDataBatchOrThrow(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `op-${key(operationId)}`, moduleId: provider.moduleId, collectionId: provider.collectionId, recordType: provider.recordType, action, targetId: id, ...(data === undefined ? {} : { data }), ...(expectedRevision === undefined ? {} : { expectedRevision }) }] },
      { access, context: { initiatorKind: action === "update" ? "user" : data.role === "user" ? "user" : data.narrativeSource.producerKind, initiatorId: "conversation-service", binding, sourceReferences: [] } });
    const current = (await committedState()).records.find(record => record.id === id);
    if (!current) throw Object.assign(new Error("The transcript operation belongs to a deleted document."), { code: "transcript_operation_pruned" });
    return receipt;
  };
  const currentMessage = async id => (projection(await committedState())).find(record => record.id === id);

  return {
    provider,
    async findOperation(operationId) {
      if (typeof operationId !== "string" || !operationId.trim()) throw new Error("Transcript writes require an operation ID.");
      return currentMessage(`message-${key(operationId).slice(0, 32)}`);
    },
    async load() {
      if (store.executionId) return projection(await committedState());
      const exists = await stat(store.sessionDirectory).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
      if (!exists) return [];
      return withDataCommitLock(store.sessionDirectory, async () => {
        await recoverDataTransactions(store.sessionDirectory);
        const rawMarker = await optionalText(resolve(store.sessionDirectory, "transcript.json"));
        const current = await state();
        const messages = projection(current);
        const cache = await optionalText(resolve(store.sessionDirectory, "messages.jsonl"));
        if (rawMarker === null) {
          if (cache?.trim()) throw Object.assign(new Error("This saved chat uses legacy message authority; explicitly migrate it before opening it with this runtime."), { code: "legacy_transcript_requires_migration" });
          if (messages.length) throw new Error("Transcript authority has no provider binding.");
          return [];
        }
        const marker = JSON.parse(rawMarker);
        if (marker.schemaVersion !== 1 || JSON.stringify(normalizeTranscriptProvider(marker.provider)) !== JSON.stringify(provider)) throw new Error("Saved transcript provider does not match this card.");
        if (marker.recordCount !== messages.length || marker.fingerprint !== transcriptFingerprint(messages)) throw new Error("Transcript authority does not match its committed manifest; recover or repair the saved chat.");
        const output = messages.map(record => JSON.stringify(record)).join("\n") + (messages.length ? "\n" : "");
        if (cache !== output) {
          const temporary = resolve(store.sessionDirectory, `.messages-${key(String(Date.now()))}.tmp`);
          await writeFile(temporary, output, "utf8");
          await rename(temporary, resolve(store.sessionDirectory, "messages.jsonl"));
        }
        return messages;
      });
    },
    async append(message, { operationId }) {
      if (typeof operationId !== "string" || !operationId.trim()) throw new Error("Transcript writes require an operation ID.");
      const id = `message-${key(operationId).slice(0, 32)}`;
      const data = { role: message.role, kind: message.kind, content: message.content, narrativeSource: normalizeNarrativeSource(message.narrativeSource) };
      await operation("create", { id, data, operationId, binding: { messageId: id, turn: message.turn } });
      return currentMessage(id);
    },
    async revise(id, content, { expectedRevision, operationId }) {
      const current = (await committedState()).records.find(record => record.id === id);
      if (!current) throw new Error("Transcript document was not found.");
      await operation("update", { id, data: { ...current.data, content }, expectedRevision, operationId, binding: current.binding });
      return currentMessage(id);
    },
    async query({ fromTurn = 0, toTurn = Number.MAX_SAFE_INTEGER, beforeSequence = Number.MAX_SAFE_INTEGER, limit = 100, cursor = -1 } = {}) {
      if (![fromTurn, toTurn, beforeSequence, limit, cursor].every(Number.isSafeInteger) || fromTurn < 0 || toTurn < fromTurn || limit < 1 || limit > 500 || cursor < -1) throw new Error("Invalid transcript range or page budget.");
      const messages = await this.load();
      const selected = selectTranscriptRange(messages, { fromTurn, toTurn, beforeSequence, afterSequence: cursor });
      const items = selected.slice(0, limit);
      return { items, truncated: selected.length > items.length, nextCursor: selected.length > items.length ? items.at(-1).sequence : null };
    },
    async history(id, { revision = null, limit = 20, beforeRevision = Number.MAX_SAFE_INTEGER } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(beforeRevision) || beforeRevision < 1 || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1))) throw new Error("Invalid transcript history budget.");
      const current = await committedState();
      const records = current.history.filter(record => record.id === id && record.revision < beforeRevision && (revision === null || record.revision === revision)).sort((a, b) => b.revision - a.revision);
      // History is a document result, not a new conversation timeline.
      const items = records.slice(0, limit).map(record => ({ id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, turn: record.binding.turn, data: renderDataRecordView(record, contract, provider.view) }));
      return { items, truncated: records.length > items.length, nextCursor: records.length > items.length ? items.at(-1).revision : null };
    },
    async prune(messageIds) { await store.pruneByMessageIds(messageIds); return this.load(); },
  };
}
