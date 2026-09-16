import assert from "node:assert/strict";
import test from "node:test";

import { checkpointTeamSessionAttempt, rollbackTeamSessionAttempt } from "./rp-team-session.mjs";

test("failed team attempts branch back to the pre-call session leaf", () => {
  const calls = [];
  const manager = {
    getLeafId: () => "confirmed-leaf",
    branch: id => calls.push(["branch", id]),
    resetLeaf: () => calls.push(["reset"]),
    appendCustomEntry: (type, detail) => { calls.push(["append", type, detail]); return "rollback-marker"; },
  };
  const checkpoint = checkpointTeamSessionAttempt(manager);
  assert.equal(rollbackTeamSessionAttempt(manager, checkpoint, { executionId: "speech", attemptId: "attempt-2", error: "failed" }), "rollback-marker");
  assert.deepEqual(calls, [
    ["branch", "confirmed-leaf"],
    ["append", "rp-team-attempt-rollback", { executionId: "speech", attemptId: "attempt-2", error: "failed" }],
  ]);
});

test("a failed first team attempt resets before writing its rollback marker", () => {
  const calls = [];
  const manager = {
    getLeafId: () => null,
    branch: id => calls.push(["branch", id]),
    resetLeaf: () => calls.push(["reset"]),
    appendCustomEntry: type => { calls.push(["append", type]); return "rollback-marker"; },
  };
  rollbackTeamSessionAttempt(manager, checkpointTeamSessionAttempt(manager));
  assert.deepEqual(calls, [["reset"], ["append", "rp-team-attempt-rollback"]]);
});
