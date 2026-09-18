import assert from "node:assert/strict";
import test from "node:test";

import { createDataReadViewRegistry } from "./rp-data-read-view-lifecycle.mjs";

/**
 * RC-08: the bridge deleted a run's shared data-read view as soon as the *root* run reached a
 * terminal status. The deep-director wrapper is a descendant of the turn's root run, so finishing
 * the wrapper collected the snapshot its own still-running child was reading, and the child's next
 * memory query failed with a missing `manifest.json`.
 *
 * The registry answers one question: may this view be deleted yet? Only when every run that
 * references it has finished and completed its terminal finalization.
 */

const viewId = "09b79e8b9cc7315b4dd466a8cd8d54e67946bc65bd3b4ea1deb80892d020a607";

function run(id, status, dataReadViewId = viewId, terminalFinalization = undefined) {
  return { id, status, dataReadViewId, ...(terminalFinalization ? { terminalFinalization } : {}) };
}

test("a terminal parent does not release the view while a descendant still reads it", () => {
  const registry = createDataReadViewRegistry();
  registry.register(run("root", "running"));
  registry.register(run("child", "running", viewId));
  assert.equal(registry.activeConsumers(viewId), 2);
  // The wrapper finishes first; the deep-director child it started is still working.
  assert.equal(registry.release("child", viewId), null);
  assert.equal(registry.activeConsumers(viewId), 1);
  assert.equal(registry.release("root", viewId), viewId, "the last consumer frees the view");
});

test("a run whose terminal finalization is unfinished still holds the view", () => {
  const registry = createDataReadViewRegistry();
  assert.equal(registry.hydrate([
    run("root", "completed", viewId, { status: "completed" }),
    run("child", "completed", viewId, { status: "running" }),
  ]), 1);
  // Only the run whose lifecycle work is still pending is a consumer.
  assert.deepEqual(registry.viewIds(), [viewId]);
  assert.equal(registry.release("child", viewId), viewId);
});

test("restart rebuilds the reference graph from persisted runs", () => {
  const registry = createDataReadViewRegistry();
  const revived = registry.hydrate([
    run("root", "completed", viewId, { status: "completed" }),
    run("wrapper", "completed", viewId, { status: "completed" }),
    run("child", "awaiting-model-choice", viewId),
  ]);
  assert.equal(revived, 1, "the waiting descendant is the one that keeps the view");
  assert.equal(registry.release("child", viewId), viewId);
});

test("a run that never registered cannot collect someone else's view", () => {
  const registry = createDataReadViewRegistry();
  registry.register(run("live", "running"));
  assert.equal(registry.release("stranger", viewId), null);
  assert.equal(registry.activeConsumers(viewId), 1);
  assert.equal(registry.release("live", viewId), viewId);
});

test("failures and cancellations release only their own reference", () => {
  const registry = createDataReadViewRegistry();
  const other = "b".repeat(64);
  registry.register(run("failed-run", "running"));
  registry.register(run("cancelled-run", "running"));
  registry.register(run("other-view-run", "running", other));
  assert.equal(registry.release("failed-run", viewId), null);
  assert.equal(registry.release("cancelled-run", viewId), viewId);
  assert.equal(registry.activeConsumers(other), 1, "another operation's view is untouched");
  assert.equal(registry.release("other-view-run", other), other);
});

test("runs without a view are ignored instead of blocking collection", () => {
  const registry = createDataReadViewRegistry();
  assert.equal(registry.register(run("plain", "running", null)), false);
  assert.equal(registry.register(null), false);
  assert.equal(registry.release("plain", null), null);
  assert.equal(registry.size(), 0);
});
