import assert from "node:assert/strict";
import test from "node:test";

import { createOutputDraft, unresolvedOutputModuleIds, updateOutputDraft } from "./rp-outputs.mjs";

test("resolves every auxiliary output as emitted or not triggered", () => {
  const draft = createOutputDraft({
    id: "draft-1",
    turn: 2,
    assistantMessageId: "message-4",
    userMessage: "继续",
    assistantMessage: "正文",
    moduleIds: ["meanwhile", "status"],
  });
  const first = updateOutputDraft(draft, [{ moduleId: "meanwhile", decision: "emit", content: "另一边……" }]);
  assert.deepEqual(unresolvedOutputModuleIds(first), ["status"]);
  const complete = updateOutputDraft(first, [{ moduleId: "status", decision: "not_triggered" }]);
  assert.deepEqual(unresolvedOutputModuleIds(complete), []);
  assert.equal(complete.decisions.meanwhile.content, "另一边……");
});

test("replaces decisions idempotently and rejects invalid output", () => {
  const draft = createOutputDraft({
    id: "draft-2",
    turn: 1,
    assistantMessageId: "message-2",
    userMessage: "行动",
    assistantMessage: "正文",
    moduleIds: ["meanwhile"],
  });
  const revised = updateOutputDraft(
    updateOutputDraft(draft, [{ moduleId: "meanwhile", decision: "emit", content: "旧内容" }]),
    [{ moduleId: "meanwhile", decision: "emit", content: "新内容" }],
  );
  assert.equal(revised.decisions.meanwhile.content, "新内容");
  assert.throws(() => updateOutputDraft(draft, [{ moduleId: "unknown", decision: "not_triggered" }]), /Unknown/);
  assert.throws(() => updateOutputDraft(draft, [{ moduleId: "meanwhile", decision: "emit", content: "" }]), /non-empty/);
});
