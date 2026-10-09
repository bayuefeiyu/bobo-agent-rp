// S5 批次 4b 回归：回合状态观测与 Web 快照。
//
// 重点守两条契约：
//   1. 快照始终带上页面依赖的字段（尤其"上一回合没有产出正文"的说明）；
//   2. 该失败**只属于当前聊天**时才上报——切到别的聊天不得再看到旧失败（方案 10 的必需验收）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  blockingTurnWorkflows,
  bridgeBusy,
  latestCompletedTurn,
  recordToWebMessage,
  recordsToWebMessages,
  unfinishedWorkflowRunCount,
  webSnapshot,
} from "./rp-turn-state.ts";
import { createRecordEnvelope } from "./rp-records.mjs";

// 用真实的记录工厂构造消息记录：手工拼一个"看起来像"的对象会被 validateRecordEnvelope 拒绝，
// 那正是它该做的事。
function envelope({ id = "rec-1", turn = 1, role = "user", kind = "message", content = "你好", revision } = {}) {
  const record = createRecordEnvelope({
    id,
    source: "messages",
    sequence: turn,
    binding: { turn, messageId: null },
    metadata: { recordType: "message", entityIds: [], tags: [] },
    data: { role, kind, content },
  });
  return revision === undefined ? record : { ...record, revision };
}

function bridge(overrides = {}) {
  return {
    recordId: "chat-1",
    openingId: null,
    playerName: "阿岚",
    turn: 3,
    messages: [],
    pending: false,
    context: { isIdle: () => true },
    workflowEngine: { snapshot: () => [], blockingTurnRuns: () => [], hasBlockingTurnRun: () => false },
    ...overrides,
  };
}

test("latestCompletedTurn 只统计助手消息的最大回合", () => {
  const target = bridge({
    messages: [
      envelope({ turn: 1, role: "user", content: "a" }),
      envelope({ turn: 2, role: "assistant", content: "b" }),
      envelope({ turn: 5, role: "user", content: "c" }),
      envelope({ turn: 4, role: "assistant", content: "d" }),
    ],
  });
  assert.equal(latestCompletedTurn(target), 4);
  assert.equal(latestCompletedTurn(bridge({ messages: [] })), 0);
});

test("bridgeBusy 综合 pending、上下文空闲与阻塞回合", () => {
  assert.equal(bridgeBusy(bridge()), false);
  assert.equal(bridgeBusy(bridge({ pending: true })), true);
  assert.equal(bridgeBusy(bridge({ context: { isIdle: () => false } })), true);
  assert.equal(bridgeBusy(bridge({ workflowEngine: { hasBlockingTurnRun: () => true } })), true);
});

test("blockingTurnWorkflows 与 unfinishedWorkflowRunCount 对 null 安全", () => {
  assert.deepEqual(blockingTurnWorkflows(null), []);
  assert.equal(unfinishedWorkflowRunCount(null), 0);
  assert.deepEqual(blockingTurnWorkflows(bridge({ workflowEngine: { blockingTurnRuns: () => [{ id: "r1" }] } })), [{ id: "r1" }]);
});

test("未完成运行计数包含终态但仍待收尾的运行", () => {
  const target = bridge({
    workflowEngine: {
      snapshot: () => [
        { id: "done", status: "completed" },
        { id: "running", status: "running" },
        { id: "pending-finalize", status: "completed", terminalFinalization: { status: "pending" } },
        { id: "finalizing", status: "failed", terminalFinalization: { status: "running" } },
        { id: "skipped", status: "skipped" },
      ],
    },
  });
  assert.equal(unfinishedWorkflowRunCount(target), 3);
});

test("recordToWebMessage 与 recordsToWebMessages 保留顺序与角色", () => {
  const converted = recordToWebMessage(envelope());
  assert.equal(converted.role, "user");
  assert.equal(converted.content, "你好");
  const many = recordsToWebMessages([envelope({ id: "a" }), envelope({ id: "b", role: "assistant", content: "嗨" })]);
  assert.equal(many.length, 2);
  assert.deepEqual(many.map((m) => m.role), ["user", "assistant"]);
});

test("快照始终带上页面依赖的字段", () => {
  const snapshot = webSnapshot(bridge({ openingId: "opening-1", messages: [envelope()] }), false);
  for (const key of ["sessionId", "openingId", "playerName", "messages", "busy", "blockingWorkflows", "activeWorkflowRuns", "selectorUrl", "isolatedRuntime", "lastTurnFailure"]) {
    assert.ok(key in snapshot, `快照缺少字段 ${key}`);
  }
  assert.equal(snapshot.sessionId, "chat-1");
  assert.equal(snapshot.playerName, "阿岚");
  assert.equal(snapshot.messages.length, 1);
});

test("额外字段可覆盖，但不得挤掉契约字段", () => {
  const snapshot = webSnapshot(bridge(), false, { custom: 1 });
  assert.equal(snapshot.custom, 1);
  assert.equal(snapshot.sessionId, "chat-1");
});

test("上一回合失败只在属于当前聊天时上报", () => {
  const failure = { turn: 3, detail: "没有产出正文", at: "2026-10-09T00:00:00.000Z", recordId: "chat-1" };
  // 同属当前聊天 -> 上报
  assert.deepEqual(webSnapshot(bridge({ lastTurnFailure: failure }), false).lastTurnFailure, failure);
  // 属于别的聊天 -> 不得上报（玩家切走后不该看到旧失败）
  assert.equal(webSnapshot(bridge({ recordId: "chat-2", lastTurnFailure: failure }), false).lastTurnFailure, null);
});

test("isolatedRuntime 决定 selectorUrl 是否暴露", () => {
  const previous = process.env.BOBO_RP_LAUNCHER_URL;
  process.env.BOBO_RP_LAUNCHER_URL = "http://127.0.0.1:9/launcher";
  try {
    assert.equal(webSnapshot(bridge(), false).selectorUrl, null);
    assert.equal(webSnapshot(bridge(), true).selectorUrl, "http://127.0.0.1:9/launcher");
  } finally {
    if (previous === undefined) delete process.env.BOBO_RP_LAUNCHER_URL;
    else process.env.BOBO_RP_LAUNCHER_URL = previous;
  }
});

test("没有活动会话时快照仍返回完整字段", () => {
  const snapshot = webSnapshot(null, false);
  assert.equal(snapshot.sessionId, null);
  assert.equal(snapshot.playerName, "玩家");
  assert.deepEqual(snapshot.messages, []);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.lastTurnFailure, null);
});
