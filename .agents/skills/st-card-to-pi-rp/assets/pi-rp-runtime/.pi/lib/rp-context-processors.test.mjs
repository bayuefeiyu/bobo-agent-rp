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
    schemaVersion: 1,
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
      variables: "all",
      modules: ["quests"],
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
    variables: { score: 30 },
    modules: { quests: { snapshot: { data: { active: true } } }, secret: { snapshot: {} } },
    settings: { common: { fontSize: 16 } },
  });
  assert.equal(input.currentInput, "hello");
  assert.equal(input.openingId, "opening-00");
  assert.equal(input.player, null);
  assert.deepEqual(input.messages, []);
  assert.deepEqual(input.variables, { score: 30 });
  assert.deepEqual(Object.keys(input.modules), ["quests"]);
  assert.equal(input.settings, null);
  assert.ok(Object.isFrozen(input.variables));
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
    variables: "all",
    modules: [],
    settings: false,
  } }));
  const result = await runContextProcessor(parsed, async ({ variables }) => ({
    include: [variables.score < 40 ? "low" : "high"],
  }), {
    card: { id: "card", name: "Card" },
    turn: 1,
    currentInput: "ignored",
    openingId: "opening-00",
    player: { name: "Player", description: "" },
    messages: [],
    variables: { score: 39 },
    modules: {},
    settings: {},
  });
  assert.deepEqual(result, { include: ["low"] });
});
