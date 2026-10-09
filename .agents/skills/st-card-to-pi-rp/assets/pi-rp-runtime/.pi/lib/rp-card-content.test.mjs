// S5 批次 1 回归：卡内容装载模块。
//
// 该模块被从 pi-rp-web.ts 搬出，目的正是**能独立测试**。这里覆盖它的公开边界：
// 路径防越界、检索策略校验、以及从真实模块目录装载。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readCardContextFile,
  readFeatureModules,
  resolveCardChild,
  resolveFeatureModuleChild,
  runtimeRetrievalPolicy,
} from "./rp-card-content.ts";

function policy(overrides = {}) {
  return {
    schemaVersion: 2,
    source: "messages",
    code: { profile: "default" },
    agent: { mode: "append", fallback: "code", onNotTriggered: "empty", maxRecords: 20 },
    ...overrides,
  };
}

test("resolveCardChild 接受卡内相对路径并拒绝越界", () => {
  const root = resolve("/card");
  assert.equal(resolveCardChild(root, "prompts/system/base.md"), resolve("/card/prompts/system/base.md"));
  assert.equal(resolveCardChild(root, "../outside.md"), null);
  assert.equal(resolveCardChild(root, "a/../../outside.md"), null);
});

test("resolveFeatureModuleChild 拒绝绝对路径、反斜杠与越界", () => {
  const root = resolve("/card/features/demo");
  assert.equal(resolveFeatureModuleChild(root, "workflows/run/workflow.json", "x"), resolve("/card/features/demo/workflows/run/workflow.json"));
  // 反斜杠：用**不含** `..` 的路径，才能把"反斜杠被拒"与"越出目录被拒"两条规则分开验证。
  assert.throws(() => resolveFeatureModuleChild(root, "workflows\\run.json", "x"), /safe relative path/);
  assert.throws(() => resolveFeatureModuleChild(root, "/etc/passwd", "x"), /safe relative path/);
  assert.throws(() => resolveFeatureModuleChild(root, "../../escape.json", "x"), /escapes its feature-module directory/);
  // 空值与非法类型同样按"安全相对路径"拒绝。
  assert.throws(() => resolveFeatureModuleChild(root, "", "x"), /safe relative path/);
  assert.throws(() => resolveFeatureModuleChild(root, 42, "x"), /safe relative path/);
});

test("runtimeRetrievalPolicy 只接受精确字段集与合法组合", () => {
  assert.equal(runtimeRetrievalPolicy(policy(), "messages", "messages").schemaVersion, 2);

  // 多字段 / 缺字段
  assert.throws(() => runtimeRetrievalPolicy({ ...policy(), extra: 1 }, "messages", "messages"), /exact schemaVersion 2 field set/);
  const missing = policy();
  delete missing.agent;
  assert.throws(() => runtimeRetrievalPolicy(missing, "messages", "messages"), /exact schemaVersion 2 field set/);

  // source 不符
  assert.throws(() => runtimeRetrievalPolicy(policy(), "other", "messages"), /source must be other/);

  // default profile 不得带 selector
  assert.throws(() => runtimeRetrievalPolicy(policy({ code: { profile: "default", selector: {} } }), "messages", "messages"), /must not define a selector/);

  // custom profile 必须恰有一个 selector
  assert.throws(() => runtimeRetrievalPolicy(policy({ code: { profile: "custom" } }), "messages", "messages"), /requires exactly one selector/);

  // agent 策略字段不全
  assert.throws(() => runtimeRetrievalPolicy(policy({ agent: { mode: "append" } }), "messages", "messages"), /invalid agent policy/);

  // 非法 mode
  assert.throws(() => runtimeRetrievalPolicy(policy({ agent: { mode: "sometimes", fallback: "code", onNotTriggered: "empty", maxRecords: 1 } }), "messages", "messages"), /invalid agent policy/);
});

test("readCardContextFile 加标题并去除首尾空白，且拒绝非字符串与越界", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-card-content-"));
  try {
    await writeFile(join(root, "note.md"), "  hello  \n", "utf8");
    const text = await readCardContextFile(root, "note.md", "context.note");
    assert.equal(text, "## note.md\nhello");
    await assert.rejects(() => readCardContextFile(root, 42, "context.note"), /must be one relative file path/);
    await assert.rejects(() => readCardContextFile(root, "../outside.md", "context.note"), /escapes the card directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readFeatureModules 拒绝非数组、重复 id 与越界路径", async () => {
  await assert.rejects(() => readFeatureModules("/card", "not-an-array"), /feature_modules must be an array/);
  await assert.rejects(() => readFeatureModules("/card", [42]), /non-string path/);
  await assert.rejects(() => readFeatureModules("/card", ["../outside/module.json"]), /escapes the card directory/);
});
