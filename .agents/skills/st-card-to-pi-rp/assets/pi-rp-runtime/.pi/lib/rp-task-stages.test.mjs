import assert from "node:assert/strict";
import test from "node:test";

import { createTaskStageController, parseTaskStages, registerTaskStageTool } from "./rp-task-stages.mjs";

test("parses shared instructions and hides later stages", () => {
  const plan = parseTaskStages("共同要求\r\n\r\n<!-- stage -->\r\n第一阶段\r\n<!-- stage -->\r\n第二阶段", "fixture.md");
  assert.equal(plan.staged, true);
  assert.equal(plan.common, "共同要求");
  assert.deepEqual(plan.stages, ["第一阶段", "第二阶段"]);
  assert.match(plan.initialText, /共同要求.*第一阶段/s);
  assert.doesNotMatch(plan.initialText, /第二阶段/);
  assert.match(plan.sourceHash, /^sha256:/);
});

test("ignores stage markers in fenced code and rejects empty stages", () => {
  const plan = parseTaskStages("```md\n<!-- stage -->\n```\n<!-- stage -->\n实际阶段");
  assert.equal(plan.stages.length, 1);
  assert.match(plan.common, /```md/);
  assert.throws(() => parseTaskStages("<!-- stage -->\n\n<!-- stage -->\n二", "bad.md"), /bad\.md.*empty task stage after line 1/);
});

test("plain prompts stay compatible and may complete immediately", async () => {
  const plan = parseTaskStages("普通任务");
  const controller = createTaskStageController(plan);
  assert.equal(plan.initialText, "普通任务");
  assert.equal(controller.exhausted, true);
  controller.assertExhausted();
  assert.equal((await controller.advance("plain")).status, "all_stages_issued");
});

test("advances only after delivery, deduplicates call IDs, and gates completion", async () => {
  let tick = 0;
  const controller = createTaskStageController(parseTaskStages("<!-- stage -->\n一\n<!-- stage -->\n二"), { now: () => `t${++tick}` });
  assert.throws(() => controller.assertExhausted(), /Task stages remain/);
  const delivered = [];
  assert.deepEqual(await controller.advance("call-1", message => delivered.push(message)), { status: "next_stage_scheduled", stage: 2 });
  assert.deepEqual(await controller.advance("call-1", message => delivered.push(message)), { status: "next_stage_scheduled", stage: 2 });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /任务阶段 2.*二/s);
  assert.equal((await controller.advance("call-2")).status, "all_stages_issued");
  assert.equal((await controller.advance("call-3")).status, "all_stages_issued");
  controller.assertExhausted();
  assert.deepEqual(controller.events.map(event => event.type), ["stage-issued", "stage-issued", "stages-exhausted"]);
});

test("tool requires an otherwise empty assistant tool-call message", async () => {
  const plan = parseTaskStages("<!-- stage -->\n一\n<!-- stage -->\n二");
  const controller = createTaskStageController(plan);
  const tools = [];
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "next", name: "rp_task_next", arguments: {} }] }];
  registerTaskStageTool({ registerTool: tool => tools.push(tool) }, controller, { currentMessages: () => messages, enqueueStage: async () => {} }, {
    Object: (_properties, options) => ({ type: "object", ...options }),
  });
  const result = await tools[0].execute("next", {});
  assert.equal(result.details.status, "next_stage_scheduled");
  messages[0].content.push({ type: "toolCall", id: "read", name: "read", arguments: {} });
  await assert.rejects(tools[0].execute("mixed", {}), /alone/);
});
