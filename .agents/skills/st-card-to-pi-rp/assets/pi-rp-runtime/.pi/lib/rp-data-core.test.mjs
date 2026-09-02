import assert from "node:assert/strict";
import test from "node:test";
import { capabilityAllows, normalizeDataContract } from "./rp-data-contracts.mjs";
import { createDataRecord, reviseDataRecord, validateDataRecord } from "./rp-data-records.mjs";
import { buildDataIndex, buildIdentityEntries, extractRecordIndexes, queryDataIndex } from "./rp-data-index.mjs";
import { renderDataRecordView } from "./rp-data-views.mjs";
import { validateJsonSchema } from "./rp-data-schema.mjs";

const contract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "knowledge",
  collections: {
    secrets: {
      storage: { kind: "record-log", partition: { mode: "single" } },
      recordTypes: {
        "secret.entry": {
          dataSchemaVersion: 1,
          indexes: {
            knowers: { path: "/data/knowers", type: "id-list", operators: ["contains"] },
            secrecy: { path: "/data/secrecy", type: "number", default: 1, operators: ["eq", "gte", "lte"] },
          },
          searchableFields: ["/data/content"],
          views: {
            rp: { format: "text", fields: [{ path: "/data/content" }] },
            review: { format: "object", fields: [{ path: "/data/content", label: "秘密" }, { path: "/data/knowers", label: "知情人" }] },
          },
          actions: ["create", "revise", "archive"],
        },
      },
    },
  },
  capabilities: {
    "secret.query": { collections: ["secrets"], actions: ["query"], views: ["rp"] },
  },
});

test("contract supports collection record types and scoped capabilities", () => {
  assert.equal(contract.collections.secrets.storage.kind, "record-log");
  assert.equal(capabilityAllows(contract, ["secret.query"], { collectionId: "secrets", action: "query", view: "rp" }), true);
  assert.equal(capabilityAllows(contract, ["secret.query"], { collectionId: "secrets", action: "archive" }), false);
});

test("records use strict v2 envelope and preserve identity on revision", () => {
  const record = createDataRecord({ contract, collectionId: "secrets", recordType: "secret.entry", sequence: 0, data: { content: "王冠是赝品", knowers: ["character.queen"] } });
  validateDataRecord(record, contract);
  assert.throws(() => validateDataRecord({ ...record, extra: true }, contract), /exact envelope/);
  const revised = reviseDataRecord(record, { ...record.data, content: "王冠可能是赝品" });
  assert.equal(revised.id, record.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.createdAt, record.createdAt);
});

test("indexes permit missing values, apply defaults, and reject bad present values", () => {
  const record = createDataRecord({ contract, collectionId: "secrets", recordType: "secret.entry", sequence: 0, data: { content: "王冠是赝品", knowers: ["character.queen"] } });
  assert.deepEqual(extractRecordIndexes(record, contract), { knowers: ["character.queen"], secrecy: 1 });
  const invalid = { ...record, data: { ...record.data, secrecy: "high" } };
  assert.throws(() => extractRecordIndexes(invalid, contract), /does not match type number/);
});

test("index query and per-record RP views remain separate", () => {
  const first = createDataRecord({ contract, collectionId: "secrets", recordType: "secret.entry", sequence: 0, data: { content: "王冠是赝品", knowers: ["character.queen"], secrecy: 5 } });
  const second = createDataRecord({ contract, collectionId: "secrets", recordType: "secret.entry", sequence: 1, data: { content: "密道在厨房", knowers: ["character.guard"], secrecy: 2 } });
  const index = buildDataIndex([first, second], contract);
  const matched = queryDataIndex(index, contract, { collectionId: "secrets", where: { knowers: { contains: "character.queen" }, secrecy: { gte: 3 } } });
  assert.deepEqual(matched.map(entry => entry.id), [first.id]);
  assert.equal(renderDataRecordView(first, contract, "rp"), "王冠是赝品");
  assert.deepEqual(renderDataRecordView(first, contract, "review"), { 秘密: "王冠是赝品", 知情人: ["character.queen"] });
});

test("optional module data schemas validate nested authored data", () => {
  const schema = { type: "object", required: ["score"], properties: { score: { type: "integer", minimum: 0, maximum: 10 }, tags: { type: "array", items: { type: "string" } } }, additionalProperties: false };
  assert.deepEqual(validateJsonSchema({ score: 4, tags: ["calm"] }, schema), []);
  assert.deepEqual(validateJsonSchema({ score: 12, extra: true }, schema).map(error => error.code), ["maximum", "additionalProperties"]);
});

test("only author-declared record types register stable identities", () => {
  const identityContract = structuredClone(contract);
  identityContract.collections.secrets.recordTypes["secret.entry"].identity = { namePath: "/data/name", aliasesPath: "/data/aliases" };
  const record = createDataRecord({ contract: identityContract, collectionId: "secrets", recordType: "secret.entry", sequence: 0, id: "character.queen", data: { name: "女王", aliases: ["陛下"], content: "秘密", knowers: [] } });
  assert.deepEqual(buildIdentityEntries([record], identityContract)[0], { id: "character.queen", moduleId: "knowledge", collectionId: "secrets", recordType: "secret.entry", name: "女王", aliases: ["陛下"] });
});
