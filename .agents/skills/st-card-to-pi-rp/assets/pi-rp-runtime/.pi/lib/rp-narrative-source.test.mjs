import assert from "node:assert/strict";
import test from "node:test";

import { mergeSourceReferences, messageSourceReference, normalizeNarrativeSource, normalizeNarrativeSourceDeclaration, workflowNodeNarrativeSource } from "./rp-narrative-source.mjs";

test("keeps producer identity independent from narrative authority", () => {
  assert.deepEqual(normalizeNarrativeSource({ producerKind: "user", producerId: "player", layer: "in-world" }), { producerKind: "user", producerId: "player", layer: "in-world", characterId: null });
  assert.deepEqual(normalizeNarrativeSource({ producerKind: "agent", producerId: "director", layer: "authorial" }), { producerKind: "agent", producerId: "director", layer: "authorial", characterId: null });
  assert.equal(normalizeNarrativeSource().layer, "unspecified");
});

test("workflow declarations cannot forge their technical producer", () => {
  assert.deepEqual(normalizeNarrativeSourceDeclaration({ layer: "authorial", characterId: "character.director" }), { layer: "authorial", characterId: "character.director" });
  assert.throws(() => normalizeNarrativeSourceDeclaration({ layer: "authorial", producerKind: "user" }), /only layer and characterId/);
  const source = workflowNodeNarrativeSource({ id: "directing", defaults: { agentId: "director" } }, { id: "plan", type: "agent", agentId: null, narrativeSource: { layer: "authorial" } });
  assert.deepEqual(source, { producerKind: "agent", producerId: "director", layer: "authorial", characterId: null });
});

test("message references retain the exact message revision and conservative legacy source", () => {
  const legacy = messageSourceReference({ id: "message-1", revision: 2, metadata: {} });
  const current = messageSourceReference({ id: "message-1", revision: 3, metadata: { narrativeSource: { producerKind: "user", layer: "in-world" } } });
  assert.equal(legacy.narrativeSource.layer, "unspecified");
  assert.deepEqual(mergeSourceReferences([legacy, current]).map(item => item.revision), [2, 3]);
});
