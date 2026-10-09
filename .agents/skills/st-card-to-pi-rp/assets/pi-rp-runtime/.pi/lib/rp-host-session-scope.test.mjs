import test from "node:test";
import assert from "node:assert/strict";
import { createHostSessionScope } from "./rp-host-session-scope.ts";
import { bindWebBridge } from "./rp-web-bridge.ts";

const owner = (id) => ({ recordId: id, sessionDirectory: `/test/${id}`, value: 0 });
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

for (const change of ["replace-bridge", "switch-chat", "close-bridge"]) {
  test(`async request rejects after ${change} without writing another chat`, async () => {
    const scope = createHostSessionScope();
    const first = owner("first"); scope.current = first;
    const hold = deferred();
    const bridge = bindWebBridge(scope, { update: async () => {
      const captured = scope.requireCurrent();
      await hold.promise;
      captured.value += 1;
    } });
    const pending = bridge.update();
    const second = owner("second");
    if (change === "replace-bridge") scope.current = second;
    if (change === "switch-chat") scope.updateChat("second", "/test/second");
    if (change === "close-bridge") scope.current = null;
    hold.release();
    await assert.rejects(pending, error => error.status === 409);
    assert.equal(first.value, 0); assert.equal(second.value, 0);
  });
}

test("explicit chat transition is atomic, invalidates other pending requests, and supports nested calls", async () => {
  const scope = createHostSessionScope(); scope.current = owner("first");
  const hold = deferred();
  const bridge = bindWebBridge(scope, {
    slow: async () => { await hold.promise; return scope.requireCurrent().value++; },
    resume: () => { scope.updateChat("second", "/test/second"); return scope.requireChat().recordId; },
    value: () => scope.requireCurrent().value,
  });
  const pending = bridge.slow();
  assert.equal(bridge.resume(), "second"); hold.release();
  await assert.rejects(pending, error => error.status === 409);
  assert.equal(scope.run(() => bridge.value()), 0);
  scope.current = owner("third");
  assert.throws(() => bridge.value(), error => error.status === 409);
});

test("an unchanged owner completes and absent chat data reports a 409", async () => {
  const scope = createHostSessionScope();
  scope.current = owner("first");
  await scope.run(async () => { await Promise.resolve(); scope.requireCurrent().value++; });
  assert.equal(scope.current.value, 1);
  scope.updateChat(null, null);
  assert.throws(() => scope.requireChat(), error => error.status === 409);
});
