import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVariableOperations,
  createVariableDraft,
  mergeVariableState,
  projectVariableState,
  renderVariableTemplates,
  updateVariableDraft,
} from "./rp-variables.mjs";

test("merges an opening overlay without merging arrays", () => {
  assert.deepEqual(
    mergeVariableState({ world: { place: "gate", flags: [1], time: "day" } }, { world: { place: "forest", flags: [2] } }),
    { world: { place: "forest", flags: [2], time: "day" } },
  );
});

test("applies supported operations and reports only failed operations", () => {
  const result = applyVariableOperations(
    { actor: { score: 2, tags: [], profile: { mood: "calm" } } },
    [
      { operationId: "one", operation: "delta", path: "/actor/score", value: 3 },
      { operationId: "two", operation: "append", path: "/actor/tags", value: "known" },
      { operationId: "three", operation: "merge", path: "/actor/profile", value: { goal: "leave" } },
      { operationId: "bad", operation: "delta", path: "/actor/missing", value: 1 },
    ],
  );
  assert.deepEqual(result.state, { actor: { score: 5, tags: ["known"], profile: { mood: "calm", goal: "leave" } } });
  assert.deepEqual(result.applied, ["one", "two", "three"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].operationId, "bad");
  assert.equal(result.errors[0].path, "/actor/missing");
});

test("draft updates are idempotent and replaceable", () => {
  let draft = createVariableDraft({
    turnId: "turn-1",
    moduleId: "variables",
    assistantMessageId: "message-1",
    userMessage: "hello",
    assistantMessage: "world",
    baseRecordId: "variable-0",
  });
  const add = { action: "add", operationId: "op-1", operation: "set", path: "/x", value: 1 };
  draft = updateVariableDraft(draft, [add, add]);
  assert.equal(draft.operations.length, 1);
  draft = updateVariableDraft(draft, [{ ...add, action: "replace", value: 2 }]);
  assert.equal(draft.operations[0].value, 2);
  draft = updateVariableDraft(draft, [{ action: "cancel", operationId: "op-1" }]);
  assert.equal(draft.operations.length, 0);
});

test("projects exact paths and named bindings and renders scalar templates", () => {
  const state = { actor: { score: 7, profile: { mood: "calm" } } };
  const definitions = {
    score: { path: "/actor/score", shape: "scalar", missing: "error" },
    actor_state: { paths: ["/actor/score", "/actor/profile"], shape: "object", missing: "omit" },
  };
  assert.deepEqual(
    projectVariableState(state, { paths: ["/actor/profile"], bindings: ["score", "actor_state"] }, definitions).selected,
    {
      "/actor/profile": { mood: "calm" },
      score: 7,
      actor_state: { "/actor/score": 7, "/actor/profile": { mood: "calm" } },
    },
  );
  assert.equal(renderVariableTemplates("score={{rp_var:score}}", state, definitions), "score=7");
});
