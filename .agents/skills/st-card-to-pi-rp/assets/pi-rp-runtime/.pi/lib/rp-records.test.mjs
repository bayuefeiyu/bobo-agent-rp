import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalog,
  createRecordEnvelope,
  normalizeRetrievalPolicy,
  reviseRecord,
  selectRecords,
} from "./rp-records.mjs";

function record(sequence, entity = "seraphina") {
  return createRecordEnvelope({
    id: `memory-${sequence}`,
    source: "module:character-memory",
    sequence,
    binding: { turn: sequence },
    metadata: { recordType: "character-memory", entityIds: [entity], tags: [] },
    data: { characterId: entity, content: `memory ${sequence}` },
  });
}

test("uses all messages and latest module record as deterministic defaults", () => {
  assert.deepEqual(normalizeRetrievalPolicy({}, "messages").code.selector, { type: "all" });
  assert.deepEqual(normalizeRetrievalPolicy({}, "module-records").code.selector, { type: "latest", limit: 1 });
});

test("normalizes the four author-facing retrieval combinations on orthogonal axes", () => {
  const custom = { type: "latest", limit: 3 };
  const modes = [
    [{ code: { profile: "default" }, agent: { mode: "disabled" } }, "default", "disabled", { type: "latest", limit: 1 }],
    [{ code: { profile: "custom", selector: custom }, agent: { mode: "disabled" } }, "custom", "disabled", custom],
    [{ code: { profile: "default" }, agent: { mode: "append" } }, "default", "append", { type: "latest", limit: 1 }],
    [{ code: { profile: "custom", selector: custom }, agent: { mode: "override" } }, "custom", "override", custom],
  ];
  for (const [input, codeProfile, agentMode, selector] of modes) {
    const policy = normalizeRetrievalPolicy(input, "module-records");
    assert.equal(policy.code.profile, codeProfile);
    assert.equal(policy.agent.mode, agentMode);
    assert.deepEqual(policy.code.selector, selector);
    assert.equal(policy.agent.fallback, "code");
  }
});

test("selects exact IDs, ranges, windows, and latest records per key", () => {
  const records = [record(1), record(2, "other"), record(3), record(4, "other")];
  assert.deepEqual(selectRecords(records, { type: "latest", limit: 2 }).records.map(item => item.id), ["memory-3", "memory-4"]);
  assert.deepEqual(selectRecords(records, { type: "ids", ids: ["memory-3", "missing"] }).missing, ["missing"]);
  assert.deepEqual(selectRecords(records, { type: "range", fromSequence: 2, toSequence: 3 }).records.map(item => item.id), ["memory-2", "memory-3"]);
  assert.deepEqual(selectRecords(records, { type: "around", id: "memory-3", before: 1, after: 1 }).records.map(item => item.id), ["memory-2", "memory-3", "memory-4"]);
  assert.deepEqual(selectRecords(records, { type: "latest_per_key", path: "data.characterId", limitPerKey: 1 }).records.map(item => item.id), ["memory-3", "memory-4"]);
});

test("rebuilds message catalogs entirely from authoritative records", () => {
  const original = record(1);
  const first = buildCatalog([original]);
  const changed = reviseRecord(original, { characterId: "seraphina", content: "changed" });
  const rebuilt = buildCatalog([changed]);
  assert.equal(first.entries[0].recordRevision, 1);
  assert.equal(rebuilt.entries[0].recordRevision, 2);
  assert.notEqual(rebuilt.entries[0].contentHash, first.entries[0].contentHash);
  assert.equal(Object.hasOwn(rebuilt.entries[0], "generated"), false);
});
