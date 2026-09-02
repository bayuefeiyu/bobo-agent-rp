import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextProcessorInput,
  runContextProcessor,
  validateContextProcessorDefinition,
  validateContextProcessorResult,
} from "./rp-context-processors.mjs";

function definition(overrides = {}) {
  return {
    schemaVersion: 2,
    id: "character-stage",
    description: "Select the authored character stage.",
    phase: "before-narrative",
    contextOrder: 300,
    entryFile: "index.mjs",
    dependencies: {
      currentInput: true,
      opening: true,
      player: false,
      messages: "none",
      dataQueries: [{ id: "active-quests", moduleId: "quests", collectionId: "entries", view: "rp", limit: 10 }],
      settings: false,
    },
    fragments: [
      { id: "low", title: "Low stage", file: "fragments/low.md" },
      { id: "high", title: "High stage", file: "fragments/high.md" },
    ],
    failure: "error",
    ...overrides,
  };
}

test("validates the strict deterministic processor contract", () => {
  const parsed = validateContextProcessorDefinition(definition());
  assert.equal(parsed.id, "character-stage");
  assert.throws(() => validateContextProcessorDefinition(definition({ entryFile: "../escape.mjs" })), /safe relative/);
  assert.throws(() => validateContextProcessorDefinition(definition({ phase: "after-narrative" })), /before-narrative/);
});

test("exposes only declared dependencies through a frozen input", () => {
  const parsed = validateContextProcessorDefinition(definition());
  const input = buildContextProcessorInput(parsed, {
    card: { id: "card", name: "Card" },
    turn: 4,
    currentInput: "hello",
    openingId: "opening-00",
    player: { name: "Player", description: "hidden by declaration" },
    messages: [{ id: "message-1" }],
    dataQueries: { "active-quests": { items: [{ id: "quest-1", value: "active" }] } },
    settings: { common: { fontSize: 16 } },
  });
  assert.equal(input.currentInput, "hello");
  assert.equal(input.openingId, "opening-00");
  assert.equal(input.player, null);
  assert.deepEqual(input.messages, []);
  assert.deepEqual(Object.keys(input.data), ["active-quests"]);
  assert.equal(input.settings, null);
  assert.ok(Object.isFrozen(input.data));
});

test("accepts only known, unique authored fragment ids", () => {
  const parsed = validateContextProcessorDefinition(definition());
  assert.deepEqual(validateContextProcessorResult(parsed, { include: ["high"] }), { include: ["high"] });
  assert.throws(() => validateContextProcessorResult(parsed, { include: ["missing"] }), /unknown fragment/);
  assert.throws(() => validateContextProcessorResult(parsed, { include: ["low", "low"] }), /duplicate/);
});

test("runs an asynchronous authored branch against the declared state", async () => {
  const parsed = validateContextProcessorDefinition(definition({ dependencies: {
    currentInput: false,
    opening: false,
    player: false,
    messages: "none",
    dataQueries: [{ id: "score", moduleId: "state", collectionId: "values", view: "rp" }],
    settings: false,
  } }));
  const result = await runContextProcessor(parsed, async ({ data }) => ({
    include: [data.score.items[0].value < 40 ? "low" : "high"],
  }), {
    card: { id: "card", name: "Card" },
    turn: 1,
    currentInput: "ignored",
    openingId: "opening-00",
    player: { name: "Player", description: "" },
    messages: [],
    dataQueries: { score: { items: [{ id: "score", value: 39 }] } },
    settings: {},
  });
  assert.deepEqual(result, { include: ["low"] });
});
