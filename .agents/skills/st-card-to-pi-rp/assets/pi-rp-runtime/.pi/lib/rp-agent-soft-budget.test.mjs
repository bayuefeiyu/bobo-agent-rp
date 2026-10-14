import assert from "node:assert/strict";
import test from "node:test";
import { agentSoftBudgetExtension, createAgentSoftBudget, resolveAgentSoftBudget } from "./rp-agent-soft-budget.mjs";

test("soft budgets narrow work on the next request without editing messages or stopping completion", () => {
  let now = 0;
  const controller = createAgentSoftBudget({ modelRequests: 4, outputTokens: 100, elapsedSeconds: 30 }, { now: () => now });
  const source = [{ role: "user", content: "task" }];
  assert.equal(controller.beforeRequest(source), source);
  assert.match(controller.beforeRequest(source, { foregroundWaiting: true }).at(-1).content[0].text, /前台任务正在等待/);
  const message = { role: "assistant", usage: { output: 80 } };
  controller.record(message); controller.record(message);
  const reminded = controller.beforeRequest(source);
  assert.equal(reminded.length, 2);
  assert.match(reminded.at(-1).content[0].text, /输出 80\/100/);
  assert.match(reminded.at(-1).content[0].text, /缩小探索范围、降低分析深度/);
  assert.match(reminded.at(-1).content[0].text, /完成全部必需交付/);
  assert.equal(source.length, 1, "reminders are provider-only context");
  now = 100000;
  assert.match(controller.beforeRequest(source).at(-1).content[0].text, /已达到建议预算/);
  for (let index = 0; index < 20; index++) assert.equal(controller.beforeRequest(source).length, 2, "exhaustion never aborts a request or grows reminder history");
});

test("auxiliary defaults, explicit budgets, and extension events preserve ordinary foreground work", () => {
  assert.equal(resolveAgentSoftBudget({}, { kind: "foreground" }), null);
  assert.ok(resolveAgentSoftBudget({}, { kind: "module-external" }));
  assert.deepEqual(agentSoftBudgetExtension({ metadata: { softBudget: false } }, { kind: "global-background" }), []);
  assert.throws(() => resolveAgentSoftBudget({ metadata: { softBudget: { modelRequests: 0 } } }, {}), /Invalid soft budget/);
  const handlers = {};
  const [extension] = agentSoftBudgetExtension({ metadata: { softBudget: { modelRequests: 2 } } }, { kind: "module-external" });
  extension.factory({ on: (name, fn) => { handlers[name] = fn; } });
  assert.equal(handlers.context({ messages: [] }).messages.length, 0);
  handlers.message_end({ message: { role: "assistant", usage: { output: 1 } } });
  assert.match(handlers.context({ messages: [] }).messages.at(-1).content[0].text, /已达到建议预算/);
});
