// S3：跨语言协议样例的 JS 侧消费者。
//
// 同一份 `protocol-samples.json` 必须同时被本文件与 `scripts/test_contract_samples.py` 消费，
// 且两侧对每个样例给出相同的接受/拒绝结论。任何一侧都不允许通过跳过样例来"对齐"。
//
// 本文件用**运行时归一化实现**（ENGINE/lib）判定每个样例；卡包侧规则（文件存在、组件注册、
// 跨模块引用）不在运行时层执行，因此带 `cardpackOnly` 标记的样例在此显式标注为"本层不适用"，
// 而不是当作通过。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeFeatureModuleManifest } from "../../assets/pi-rp-runtime/.pi/lib/rp-feature-modules.mjs";
import { normalizeWorkflowDefinition } from "../../assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";
import { normalizeDataContract } from "../../assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { normalizeResourceCatalog } from "../../assets/pi-rp-runtime/.pi/lib/rp-resource-catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(readFileSync(join(here, "protocol-samples.json"), "utf8")).samples;

// 样例 ID 前缀 → 运行时归一化入口。前缀即契约族，避免按文件名或"猜目录"分派。
//
// 第二项是"承载模块 id"：数据契约与资源目录的 `moduleId` 规则是**相对于承载它的模块**校验的
// （归一化器接受 `expectedModuleId`），脱离容器就无法判定"不匹配"。因此这里显式给出容器 id，
// 而不是让样例在无容器时碰巧通过——那会让 `struct.datacontract.moduleId` 变成一条空规则。
//
// 对 module.v7 / workflow.v4，容器就是样例自身（清单声明自己的 id，工作流声明 ownerModuleId）。
const NORMALIZERS = {
  "module.v7": { normalize: (input) => normalizeFeatureModuleManifest(input), containerId: (input) => input?.id ?? null },
  "workflow.v4": { normalize: (input) => normalizeWorkflowDefinition(input), containerId: (input) => input?.ownerModuleId ?? null },
  "datacontract.v1": { normalize: (input, containerId) => normalizeDataContract(input, containerId), containerId: () => "demo-module" },
  "catalog.v1": { normalize: (input, containerId) => normalizeResourceCatalog(input, containerId), containerId: () => "demo-module" },
};

function normalizerFor(sampleId) {
  const family = Object.keys(NORMALIZERS).find((prefix) => sampleId.startsWith(prefix));
  if (!family) throw new Error(`样例 ${sampleId} 没有对应的运行时归一化入口；请先声明契约族。`);
  return { family, ...NORMALIZERS[family] };
}

// 判定：抛错即拒绝，返回即接受。诊断用错误文本匹配样例声明的 diagnostic 关键字。
function evaluate(sample) {
  const { normalize, containerId } = normalizerFor(sample.id);
  try {
    normalize(sample.input, containerId(sample.input));
    return { accepted: true, message: null };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

test("样例集非空且每个样例都声明了规则、层次与预期", () => {
  assert.ok(Array.isArray(samples) && samples.length > 0, "样例集不得为空");
  for (const sample of samples) {
    assert.ok(sample.id, "样例必须有 id");
    assert.ok(Array.isArray(sample.ruleIds) && sample.ruleIds.length > 0, `${sample.id} 必须声明 ruleIds`);
    assert.ok(["accept", "reject"].includes(sample.expect), `${sample.id}.expect 必须是 accept 或 reject`);
    assert.ok(sample.input && typeof sample.input === "object", `${sample.id} 必须有 object 输入`);
  }
});

test("每个样例都声明了适用校验层", () => {
  for (const sample of samples) {
    assert.ok(typeof sample.layer === "string" && sample.layer.length > 0, `${sample.id} 必须声明 layer`);
    const known = ["runtime", "cardpack", "runtime+cardpack"];
    assert.ok(known.includes(sample.layer), `${sample.id}.layer 必须是 ${known.join(" / ")}`);
  }
});

test("两种实现必须共同覆盖责任表中的 runtime+cardpack 规则", () => {
  // 追踪方式：规则是否被覆盖，是**从样例文件算出来的**，不靠人工维护清单。
  // `runtime+cardpack` 的样例必须在两侧都执行，否则"共同规则一致"无从谈起。
  const shared = new Set();
  for (const sample of samples) {
    if (sample.layer !== "runtime+cardpack") continue;
    for (const ruleId of sample.ruleIds) shared.add(ruleId);
  }
  assert.ok(shared.size > 0, "必须存在 runtime+cardpack 的共同规则样例");
  // `cardpack` 层样例是刻意的单层样例：input 自包含，无法表达跨文件关系（见 rule-responsibility.md）。
  const cardpackOnly = samples.filter((sample) => sample.layer === "cardpack");
  for (const sample of cardpackOnly) {
    assert.ok(sample.note, `${sample.id} 为单层样例，必须用 note 说明为何运行时层不适用`);
  }
});

test("运行时层对每个适用样例给出声明中的结论", () => {
  const failures = [];
  for (const sample of samples) {
    // 仅卡包层执行的规则在运行时层显式不适用。
    if (sample.layer === "cardpack") continue;
    const { accepted } = evaluate(sample);
    const expected = sample.expect === "accept";
    if (accepted !== expected) {
      const { message } = evaluate(sample);
      failures.push(`${sample.id}: 期望 ${sample.expect}，实际 ${accepted ? "accept" : `reject (${message})`}`);
    }
  }
  assert.deepEqual(failures, [], `运行时层样例不一致：\n${failures.join("\n")}`);
});

test("当前支持版本以外的样例必须被拒绝，而不是被解析", () => {
  const versionSamples = samples.filter((sample) => sample.ruleIds.includes("reject.unsupportedVersion"));
  assert.ok(versionSamples.length > 0, "必须存在旧版本拒绝样例");
  for (const sample of versionSamples) {
    assert.equal(sample.expect, "reject", `${sample.id} 必须是拒绝样例`);
    const { accepted } = evaluate(sample);
    // 只断言结论。错误文案属于实现细节——方案明确不要求各校验器输出相同错误文本。
    assert.equal(accepted, false, `${sample.id} 的旧版本必须被拒绝，而不是被解析`);
  }
});

test("样例数据全部为合成数据，不含真实卡、会话或凭据", () => {
  const forbidden = [/play\//, /my-cards/, /sessions\//, /apiKey/i, /api_key/i, /secret/i, /token/i];
  for (const sample of samples) {
    const text = JSON.stringify(sample.input);
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${sample.id} 不得包含真实运行数据或凭据（命中 ${pattern}）`);
    }
  }
});

// 导出供 Python 侧对照（子进程无法共享模块实例，因此 Python 侧独立复算并比对结论）。
export const sampleIds = samples.map((sample) => sample.id);
