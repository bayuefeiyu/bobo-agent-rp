// S5 批次 6 回归：转录来源。
//
// 一个"来源"的正确性取决于三件事始终指向同一来源：它的**记录**、它的**策略**、它的**派生目录**。
// 这里同时覆盖这三者，以及"未知来源必须拒绝而不是静默空结果"。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readSourceRecords,
  refreshSourceCatalog,
  sourceCatalogPath,
  sourcePolicy,
} from "./rp-transcript-source.ts";
import { createRecordEnvelope } from "./rp-records.mjs";

function messageRecord(sequence, turn, content) {
  return createRecordEnvelope({
    id: `msg-${sequence}`,
    source: "messages",
    sequence,
    binding: { turn, messageId: null },
    metadata: { recordType: "message", entityIds: [], tags: [] },
    data: { role: sequence % 2 === 0 ? "assistant" : "user", kind: "message", content },
  });
}

function bridge(overrides = {}) {
  return {
    messages: [messageRecord(1, 1, "一"), messageRecord(2, 1, "二"), messageRecord(3, 2, "三")],
    messagePolicy: { schemaVersion: 2, source: "messages", code: { profile: "default" }, agent: { mode: "append", fallback: "code", onNotTriggered: "empty", maxRecords: 10 } },
    sessionDirectory: null,
    turn: 2,
    ...overrides,
  };
}

test("readSourceRecords 只取本次提交之前的消息", async () => {
  const target = bridge();
  const run = { submittedSequence: 3 };
  const records = await readSourceRecords(target, "messages", run);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
  // 含本次提交的那条不纳入来源。
  assert.ok(!records.some((record) => record.sequence >= 3));
});

test("readSourceRecords 与 sourcePolicy 对未知来源必须报错而不是返回空", async () => {
  const target = bridge();
  await assert.rejects(() => readSourceRecords(target, "elsewhere", { submittedSequence: 9 }), /Unknown RP transcript source: elsewhere/);
  assert.throws(() => sourcePolicy(target, "elsewhere"), /Unknown RP transcript source: elsewhere/);
});

test("sourcePolicy 返回该来源声明的检索策略", () => {
  const target = bridge();
  assert.equal(sourcePolicy(target, "messages"), target.messagePolicy);
});

test("sourceCatalogPath 要求会话目录，并把目录放在会话下的 catalog/messages.json", () => {
  assert.throws(() => sourceCatalogPath(bridge(), "messages"), /has no session directory/);
  const sessionDirectory = join(tmpdir(), "rp-transcript-source-virtual");
  const withDirectory = bridge({ sessionDirectory });
  // 用 resolve 构造期望值：`/sessions/...` 这类 POSIX 风格路径在 Windows 上会落到当前盘，
  // 硬编码分隔符或前导斜杠都会让断言依赖平台。
  assert.equal(sourceCatalogPath(withDirectory, "messages"), resolve(sessionDirectory, "catalog", "messages.json"));
});

test("refreshSourceCatalog 在没有会话目录时只返回目录对象，不写盘", async () => {
  const records = [messageRecord(1, 1, "一")];
  const catalog = await refreshSourceCatalog(bridge(), "messages", records);
  assert.ok(catalog, "必须返回可重建的目录对象");
});

test("refreshSourceCatalog 在有会话目录时落盘且内容可被读回", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rp-transcript-source-"));
  try {
    const target = bridge({ sessionDirectory: directory });
    const records = [messageRecord(1, 1, "一"), messageRecord(2, 1, "二")];
    const catalog = await refreshSourceCatalog(target, "messages", records);

    const path = sourceCatalogPath(target, "messages");
    assert.equal(existsSync(path), true, "派生目录必须被写出");
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(written, catalog, "返回值与落盘内容必须一致（同一份可重建派生数据）");
    // 目标路径位于会话目录下，不得逃出。
    assert.equal(resolve(path).startsWith(resolve(directory)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
