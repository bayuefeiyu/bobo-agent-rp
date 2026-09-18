import assert from "node:assert/strict";
import test from "node:test";

import { deepOperationId, deepStateVerdict, isNonTerminalDeepStatus, recordedChildRun } from "../lib/deep-operation-identity.mjs";

/**
 * RC-08: the wrapper derived its operation id from its own run id and compared that against
 * `deep-state.currentRunId`, which holds the *child* `deep-director-planning` run id. After a restart
 * the two never matched, so the wrapper reported `{started:false, reason:"already-running"}` and
 * completed — finishing the parent run while its own child kept working, after which the child's
 * memory query failed because the parent's terminal cleanup had deleted the shared read view.
 */

const operationId = deepOperationId(4);

test("the operation identity comes from the trigger turn, not from a run id", () => {
  assert.equal(operationId, "deep-operation-turn-4");
  assert.equal(deepOperationId(0), "deep-operation-turn-0");
  assert.equal(deepOperationId(4), deepOperationId(4), "the same turn is the same operation");
  assert.throws(() => deepOperationId(undefined), /requires the trigger turn/);
  assert.throws(() => deepOperationId(-1), /requires the trigger turn/);
});

test("a restarted wrapper recognises its own operation and reattaches to the existing child", () => {
  const state = { value: { status: "running", currentRunId: operationId, currentChildRunId: "workflow-child-1" } };
  const verdict = deepStateVerdict({ operationId, state, turn: 4 });
  assert.equal(verdict.action, "resume-child");
  assert.equal(verdict.childRunId, "workflow-child-1");
  // The wrapper's own run id appears nowhere in the decision, which is the whole point.
  assert.equal(recordedChildRun({ verdict, wrapperRunId: "workflow-restarted-wrapper" }), "workflow-child-1");
});

test("an operation without a recorded child resumes the operation instead of starting a second one", () => {
  const state = { value: { status: "running", currentRunId: operationId, currentChildRunId: null } };
  const verdict = deepStateVerdict({ operationId, state, turn: 4 });
  assert.equal(verdict.action, "resume-operation");
  assert.equal(recordedChildRun({ verdict, wrapperRunId: "workflow-wrapper" }), null);
});

test("another operation's running state is waited on, never overwritten", () => {
  const state = { value: { status: "running", currentRunId: "deep-operation-turn-3", currentChildRunId: "workflow-child-3" } };
  const verdict = deepStateVerdict({ operationId, state, turn: 4 });
  assert.equal(verdict.action, "wait");
  assert.equal(verdict.currentRunId, "deep-operation-turn-3");
});

test("a closed operation blocks a new attempt, and an idle or failed state starts one", () => {
  const closed = deepStateVerdict({ operationId, state: { value: { status: "failed", currentRunId: null } }, operation: { id: operationId }, turn: 4 });
  assert.equal(closed.action, "blocked");
  assert.equal(closed.reason, "operation_closed");
  const idle = deepStateVerdict({ operationId, state: { value: { status: "idle", currentRunId: null } }, turn: 4 });
  assert.equal(idle.action, "start");
  const failed = deepStateVerdict({ operationId, state: { value: { status: "failed", currentRunId: null } }, turn: 4 });
  assert.equal(failed.action, "start");
  const missing = deepStateVerdict({ operationId, state: null, turn: 4 });
  assert.equal(missing.action, "start");
  assert.equal(missing.reason, "deep-state-missing");
});

test("waiting for a child, restart recovery, and model choice are not terminal statuses", () => {
  for (const status of ["running", "awaiting-child", "awaiting-recovery", "awaiting-model-choice", "awaiting-retry", "pending"]) {
    assert.equal(isNonTerminalDeepStatus(status), true, status);
  }
  for (const status of ["completed", "skipped", "failed", "cancelled"]) {
    assert.equal(isNonTerminalDeepStatus(status), false, status);
  }
});
