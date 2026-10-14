import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversationService } from "./rp-conversation.mjs";
import { executeDataBatchOrThrow } from "./rp-data-changes.mjs";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { createDataReadView, readDataReadViewCollection } from "./rp-data-read-view.mjs";
import { createDataRecord } from "./rp-data-records.mjs";
import { transcriptFingerprint } from "./rp-transcript-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const narrativeModuleDirectory = resolve(here, "../../../../../../../global-modules/narrative-controls");
const actualContractInput = JSON.parse(await readFile(join(narrativeModuleDirectory, "data-contract.json"), "utf8"));
const narrativeContract = normalizeDataContract(actualContractInput, "narrative-controls");
const narrativeProvider = {
  schemaVersion: 1,
  moduleId: "narrative-controls",
  collectionId: "conversation",
  recordType: "narrative.message",
  view: "rp",
};

const auxiliaryContract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "memory-module",
  collections: {
    notes: {
      storage: { kind: "record-log", partition: { mode: "single" } },
      recordTypes: {
        "memory.note": {
          dataSchemaVersion: 1,
          indexes: {},
          searchableFields: [],
          views: { rp: { format: "object", fields: [{ path: "/data/body", label: "body" }] } },
          actions: ["create"],
        },
      },
    },
  },
  capabilities: {
    "memory.runtime": { collections: ["notes"], actions: ["create"], views: [] },
  },
}, "memory-module");

function customContract() {
  const sourceType = actualContractInput.collections.conversation.recordTypes["narrative.message"];
  return normalizeDataContract({
    schemaVersion: 1,
    moduleId: "custom-transcript",
    collections: {
      chatlog: {
        storage: { kind: "record-log", partition: structuredClone(actualContractInput.collections.conversation.storage.partition) },
        recordTypes: {
          "chat.message": {
            ...structuredClone(sourceType),
            views: { public: structuredClone(sourceType.views.rp) },
          },
        },
      },
    },
    capabilities: {
      "custom.transcript.runtime": { collections: ["chatlog"], actions: ["query", "create", "update", "delete"], views: ["public"] },
    },
  }, "custom-transcript");
}

async function fixture(t, {
  contract = narrativeContract,
  provider = narrativeProvider,
  moduleDirectory = narrativeModuleDirectory,
  extraModules = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "rp-conversation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = [{ contract, moduleDirectory }];
  for (const extra of extraModules) {
    const extraDirectory = extra.moduleDirectory || join(root, extra.directoryName || extra.contract.moduleId);
    await mkdir(extraDirectory, { recursive: true });
    modules.push({ contract: extra.contract, moduleDirectory: extraDirectory });
  }
  const sessionDirectory = join(root, "session");
  const store = new RpDataStore({ sessionDirectory, modules });
  const service = createConversationService({ store, provider });
  await store.initialize();
  return { root, sessionDirectory, store, service };
}

function message(role, kind, content, turn) {
  return {
    role,
    kind,
    content,
    turn,
    narrativeSource: {
      producerKind: role === "user" ? "user" : "agent",
      producerId: role === "user" ? "tester" : "writer",
      layer: role === "user" ? "in-world" : "story",
      characterId: null,
    },
  };
}

function withoutTimes(messages) {
  return messages.map(({ createdAt, updatedAt, ...rest }) => rest);
}

test("projection write failure rolls the authority and revision history back", async t => {
  const { service, sessionDirectory } = await fixture(t);
  const original = await service.append(message("assistant", "opening", "Original.", 0), { operationId: "rollback-opening" });
  const path = join(sessionDirectory, "messages.jsonl");
  await rename(path, `${path}.backup`);
  await mkdir(path);
  await assert.rejects(service.revise(original.id, "Must roll back.", { expectedRevision: 1, operationId: "rollback-edit" }));
  await rm(path, { recursive: true });
  await rename(`${path}.backup`, path);
  assert.deepEqual(await service.load(), [original]);
  assert.deepEqual((await service.history(original.id)).items.map(record => record.revision), [1]);
});

test("opening and turn messages append as one canonical exported projection", async t => {
  const { service, sessionDirectory } = await fixture(t);
  const appended = [
    await service.append(message("assistant", "opening", "The door opens.", 0), { operationId: "opening" }),
    await service.append(message("user", "message", "I step inside.", 1), { operationId: "user-1" }),
    await service.append(message("assistant", "message", "The room is quiet.", 1), { operationId: "assistant-1" }),
  ];

  const loaded = await service.load();
  assert.deepEqual(loaded, appended);
  assert.deepEqual(loaded.map(record => [record.sequence, record.binding.turn, record.data.role, record.data.kind]), [
    [0, 0, "assistant", "opening"],
    [1, 1, "user", "message"],
    [2, 1, "assistant", "message"],
  ]);

  const cacheText = await readFile(join(sessionDirectory, "messages.jsonl"), "utf8");
  assert.deepEqual(cacheText.trim().split("\n").map(line => JSON.parse(line)), loaded);
  const marker = JSON.parse(await readFile(join(sessionDirectory, "transcript.json"), "utf8"));
  assert.deepEqual(marker.provider, narrativeProvider);
  assert.equal(marker.recordCount, loaded.length);
  assert.equal(marker.fingerprint, transcriptFingerprint(loaded));
});

test("revision keeps old history, exposes only the current version, and rejects stale writes", async t => {
  const { service } = await fixture(t);
  const original = await service.append(message("assistant", "opening", "First draft.", 0), { operationId: "revision-opening" });
  const revised = await service.revise(original.id, "Second draft.", { expectedRevision: original.revision, operationId: "revision-update" });

  assert.equal(revised.id, original.id);
  assert.equal(revised.revision, 2);
  assert.equal((await service.load())[0].data.content, "Second draft.");

  const history = await service.history(original.id);
  assert.deepEqual(history.items.map(item => [item.revision, item.data.content]), [[2, "Second draft."], [1, "First draft."]]);
  assert.deepEqual((await service.history(original.id, { revision: 1 })).items.map(item => item.data.content), ["First draft."]);

  await assert.rejects(
    service.revise(original.id, "Rejected stale draft.", { expectedRevision: 1, operationId: "revision-stale" }),
    error => error.code === "revision_conflict",
  );
  assert.equal((await service.load())[0].data.content, "Second draft.");
});

test("concurrent revisions with one expected revision have exactly one winner", async t => {
  const { service } = await fixture(t);
  const original = await service.append(message("assistant", "opening", "Concurrent base.", 0), { operationId: "concurrent-base" });
  const attempts = await Promise.allSettled([
    service.revise(original.id, "Concurrent winner A.", { expectedRevision: 1, operationId: "concurrent-a" }),
    service.revise(original.id, "Concurrent winner B.", { expectedRevision: 1, operationId: "concurrent-b" }),
  ]);

  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const rejected = attempts.find(result => result.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason.code, "revision_conflict");
  const current = await service.load();
  assert.equal(current.length, 1);
  assert.ok(["Concurrent winner A.", "Concurrent winner B."].includes(current[0].data.content));
  assert.equal(current[0].revision, 2);
  assert.deepEqual((await service.history(original.id)).items.map(item => item.revision), [2, 1]);
});

test("append retries replay once and reuse of an operation ID with different data conflicts", async t => {
  const { service, store } = await fixture(t);
  const input = message("user", "message", "Retry me.", 1);
  const first = await service.append(input, { operationId: "append-retry" });
  const replay = await service.append(input, { operationId: "append-retry" });
  assert.deepEqual(replay, first);
  assert.equal((await service.load()).length, 1);

  await assert.rejects(
    service.append({ ...input, content: "Different payload." }, { operationId: "append-retry" }),
    error => error.code === "idempotency_conflict",
  );
  const state = await store.readCollection("narrative-controls", "conversation");
  assert.equal(state.records.length, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.records[0].data.content, "Retry me.");
});

test("missing or tampered cache is rebuilt, while damaged authority cannot be recovered from it", async t => {
  const { service, store, sessionDirectory } = await fixture(t);
  await service.append(message("assistant", "opening", "Authoritative text.", 0), { operationId: "cache-source" });
  const expected = await service.load();
  const cachePath = join(sessionDirectory, "messages.jsonl");
  const expectedCache = expected.map(record => JSON.stringify(record)).join("\n") + "\n";

  await rm(cachePath, { force: true });
  assert.deepEqual(await service.load(), expected);
  assert.equal(await readFile(cachePath, "utf8"), expectedCache);

  await writeFile(cachePath, '{"tampered":true}\n', "utf8");
  assert.deepEqual(await service.load(), expected);
  assert.equal(await readFile(cachePath, "utf8"), expectedCache);

  const authorityPath = await store.authorityFileForRecord("narrative-controls", "conversation", expected[0].id);
  const authority = JSON.parse((await readFile(authorityPath, "utf8")).trim());
  authority.data.content = "Externally changed authority.";
  await writeFile(authorityPath, `${JSON.stringify(authority)}\n`, "utf8");
  await assert.rejects(service.load(), /does not match its committed manifest/);
  await assert.rejects(service.append(message("user", "message", "Must not hide corruption.", 1), { operationId: "corrupt-write" }), /does not match its committed manifest/);
  await writeFile(authorityPath, '{"not":"a record"}\n', "utf8");
  await assert.rejects(service.load(), /Record must use the exact envelope v2 field set/);
});

test("a persisted transcript provider cannot be changed by a later service binding", async t => {
  const { service, store } = await fixture(t, {
    extraModules: [{ contract: customContract(), directoryName: "custom-transcript" }],
  });
  await service.append(message("assistant", "opening", "Provider-bound text.", 0), { operationId: "provider-bound" });
  const changed = createConversationService({
    store,
    provider: { schemaVersion: 1, moduleId: "custom-transcript", collectionId: "chatlog", recordType: "chat.message", view: "public" },
  });
  await assert.rejects(changed.load(), /Saved transcript provider does not match this card/);
  assert.equal((await service.load())[0].data.content, "Provider-bound text.");
});

test("prune removes all revisions by binding across modules and keeps the next sequence contiguous", async t => {
  const { service, store } = await fixture(t, { extraModules: [{ contract: auxiliaryContract, directoryName: "memory-module" }] });
  const opening = await service.append(message("assistant", "opening", "Opening.", 0), { operationId: "prune-opening" });
  const user = await service.append(message("user", "message", "Keep this user turn.", 1), { operationId: "prune-user" });
  const assistant = await service.append(message("assistant", "message", "Remove this assistant turn.", 1), { operationId: "prune-assistant" });
  const later = await service.append(message("assistant", "message", "Remove this later turn.", 2), { operationId: "prune-later" });
  await service.revise(assistant.id, "Remove this revised assistant turn.", { expectedRevision: 1, operationId: "prune-assistant-revision" });

  await executeDataBatchOrThrow(store, {
    protocolVersion: 1,
    batchId: "prune-memory-user",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "memory-user", moduleId: "memory-module", collectionId: "notes", recordType: "memory.note", action: "create", targetId: "memory-user", data: { body: "retain" } }],
  }, {
    access: [{ moduleId: "memory-module", collectionId: "notes", capabilities: ["memory.runtime"], views: [] }],
    context: { initiatorKind: "runtime", initiatorId: "conversation-test", binding: { turn: 1, messageId: user.id }, sourceReferences: [] },
  });
  await executeDataBatchOrThrow(store, {
    protocolVersion: 1,
    batchId: "prune-memory-assistant",
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: "memory-assistant", moduleId: "memory-module", collectionId: "notes", recordType: "memory.note", action: "create", targetId: "memory-assistant", data: { body: "remove" } }],
  }, {
    access: [{ moduleId: "memory-module", collectionId: "notes", capabilities: ["memory.runtime"], views: [] }],
    context: { initiatorKind: "runtime", initiatorId: "conversation-test", binding: { turn: 1, messageId: assistant.id }, sourceReferences: [] },
  });

  const afterPrune = await service.prune(new Set([assistant.id, later.id]));
  assert.deepEqual(afterPrune.map(record => record.id), [opening.id, user.id]);
  assert.deepEqual(afterPrune.map(record => record.sequence), [0, 1]);
  assert.deepEqual((await service.history(assistant.id)).items, []);

  const conversationState = await store.readCollection("narrative-controls", "conversation");
  assert.equal(conversationState.history.some(record => record.binding.messageId === assistant.id), false);
  assert.equal(conversationState.history.some(record => record.binding.messageId === later.id), false);
  const memoryState = await store.readCollection("memory-module", "notes");
  assert.deepEqual(memoryState.records.map(record => [record.id, record.binding.messageId]), [["memory-user", user.id]]);
  await assert.rejects(executeDataBatchOrThrow(store, {
    protocolVersion: 1, batchId: "late-memory-write", status: "pending", commitPolicy: "atomic",
    operations: [{ operationId: "late-memory", moduleId: "memory-module", collectionId: "notes", recordType: "memory.note", action: "create", targetId: "late-memory", data: { body: "Must not commit after source removal." } }],
  }, {
    access: [{ moduleId: "memory-module", collectionId: "notes", capabilities: ["memory.runtime"], views: [] }],
    context: { initiatorKind: "runtime", initiatorId: "conversation-test", binding: { turn: 1, messageId: user.id }, sourceReferences: [{ kind: "message", id: assistant.id, revision: 1 }] },
  }), /references a deleted transcript message/);
  assert.equal((await store.readCollection("memory-module", "notes")).records.some(record => record.id === "late-memory"), false);

  const next = await service.append(message("assistant", "message", "New contiguous turn.", 2), { operationId: "prune-next" });
  assert.equal(next.sequence, 2);
  assert.deepEqual((await service.load()).map(record => record.sequence), [0, 1, 2]);
});

test("replaying an append operation after pruning cannot resurrect its document", async t => {
  const { service, store } = await fixture(t);
  const original = await service.append(message("assistant", "opening", "Delete me.", 0), { operationId: "delete-replay" });
  await service.prune(new Set([original.id]));

  await assert.rejects(
    service.append(message("assistant", "opening", "Delete me.", 0), { operationId: "delete-replay" }),
    error => error.code === "transcript_operation_pruned",
  );
  assert.deepEqual(await service.load(), []);
  assert.deepEqual((await store.readCollection("narrative-controls", "conversation")).records, []);
});

test("a frozen data read view retains the old transcript revision after editing", async t => {
  const { service, store, sessionDirectory } = await fixture(t);
  const original = await service.append(message("assistant", "opening", "Frozen draft.", 0), { operationId: "frozen-draft" });
  const frozen = await createDataReadView({ sessionDirectory, store, sourceId: "conversation-freeze", visibleThroughTurn: 0 });
  await service.revise(original.id, "Live revised draft.", { expectedRevision: 1, operationId: "frozen-revision" });

  const frozenCollection = await readDataReadViewCollection({
    sessionDirectory,
    store,
    viewId: frozen.viewId,
    moduleId: "narrative-controls",
    collectionId: "conversation",
  });
  assert.equal(frozenCollection.records.length, 1);
  assert.equal(frozenCollection.records[0].revision, 1);
  assert.equal(frozenCollection.records[0].data.content, "Frozen draft.");
  assert.equal((await service.load())[0].data.content, "Live revised draft.");
});

test("query supports turn ranges, sequence cursors, and bounded pages", async t => {
  const { service } = await fixture(t);
  await service.append(message("assistant", "opening", "Opening.", 0), { operationId: "query-opening" });
  await service.append(message("user", "message", "User one.", 1), { operationId: "query-user-1" });
  await service.append(message("assistant", "message", "Assistant one.", 1), { operationId: "query-assistant-1" });
  await service.append(message("user", "message", "User two.", 2), { operationId: "query-user-2" });
  await service.append(message("assistant", "message", "Assistant two.", 2), { operationId: "query-assistant-2" });
  await service.append(message("user", "message", "User three.", 3), { operationId: "query-user-3" });

  const first = await service.query({ fromTurn: 1, toTurn: 2, limit: 2 });
  assert.deepEqual(first.items.map(record => [record.sequence, record.binding.turn]), [[1, 1], [2, 1]]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 2);

  const second = await service.query({ fromTurn: 1, toTurn: 2, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(record => [record.sequence, record.binding.turn]), [[3, 2], [4, 2]]);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, null);

  const before = await service.query({ fromTurn: 0, toTurn: 3, beforeSequence: 4, limit: 10 });
  assert.deepEqual(before.items.map(record => record.sequence), [0, 1, 2, 3]);
});

test("range pagination crosses the turn-range partition boundary", async t => {
  const { service, store } = await fixture(t);
  const records = Array.from({ length: 1001 }, (_, sequence) => {
    const role = sequence === 0 ? "assistant" : sequence % 2 === 0 ? "user" : "assistant";
    const kind = sequence === 0 ? "opening" : "message";
    const id = `partition-message-${sequence}`;
    return createDataRecord({
      contract: narrativeContract,
      collectionId: "conversation",
      recordType: "narrative.message",
      id,
      sequence,
      binding: { messageId: id, turn: sequence },
      data: {
        role,
        kind,
        content: `Partition turn ${sequence}.`,
        narrativeSource: {
          producerKind: role === "user" ? "user" : "agent",
          producerId: role === "user" ? "tester" : "writer",
          layer: role === "user" ? "in-world" : "story",
          characterId: null,
        },
      },
      provenance: { initiatorKind: "runtime", initiatorId: "conversation-test" },
    });
  });
  await store.commit("partition-seed", new Map([
    ["narrative-controls/conversation", { moduleId: "narrative-controls", collectionId: "conversation", history: records, records }],
  ]), {
    schemaVersion: 1,
    batchId: "partition-seed",
    status: "committed",
    committedAt: new Date().toISOString(),
    results: [],
  });

  const first = await service.query({ fromTurn: 48, toTurn: 52, limit: 3 });
  assert.deepEqual(first.items.map(record => [record.binding.turn, record.sequence]), [[48, 48], [49, 49], [50, 50]]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 50);
  const second = await service.query({ fromTurn: 48, toTurn: 52, limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(record => [record.binding.turn, record.sequence]), [[51, 51], [52, 52]]);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, null);
  const longPage = await service.query({ limit: 500 });
  assert.equal(longPage.items.length, 500);
  assert.equal(longPage.truncated, true);
  assert.equal(longPage.nextCursor, 499);
  assert.equal((await service.load()).length, 1001);
});

test("an explicitly bound custom module and provider produce the same transcript projection", async t => {
  const standard = await fixture(t);
  const custom = await fixture(t, {
    contract: customContract(),
    provider: { schemaVersion: 1, moduleId: "custom-transcript", collectionId: "chatlog", recordType: "chat.message", view: "public" },
  });
  const inputs = [
    ["assistant", "opening", "Custom opening.", 0, "provider-opening"],
    ["user", "message", "Custom user.", 1, "provider-user"],
    ["assistant", "message", "Custom assistant.", 1, "provider-assistant"],
  ];
  for (const [role, kind, content, turn, operationId] of inputs) {
    await standard.service.append(message(role, kind, content, turn), { operationId });
    await custom.service.append(message(role, kind, content, turn), { operationId });
  }
  assert.deepEqual(withoutTimes(await custom.service.load()), withoutTimes(await standard.service.load()));
});
