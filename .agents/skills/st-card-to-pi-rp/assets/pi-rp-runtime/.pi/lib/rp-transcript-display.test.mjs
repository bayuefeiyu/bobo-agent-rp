// S5 批次 2 回归：会话转录与角色资料展示层。
import test from "node:test";
import assert from "node:assert/strict";

import {
  debugMessageContent,
  lastAgentExchange,
  messageText,
  playerProfileContext,
  playerProfileMessage,
} from "./rp-transcript-display.ts";

test("messageText 只取文本块，忽略非文本并去除首尾空白", () => {
  assert.equal(messageText({ content: "  hello  " }), "hello");
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(messageText({ content: [{ type: "image" }] }), "");
  assert.equal(messageText({}), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText(undefined), "");
  assert.equal(messageText({ content: 42 }), "");
});

test("debugMessageContent 保留原始内容以便诊断", () => {
  assert.equal(debugMessageContent({ content: "raw text" }), "raw text");
  assert.equal(debugMessageContent({}), "");
  // 非字符串内容按 JSON 展开，便于面板显示 provider 真实返回。
  assert.equal(debugMessageContent({ content: [{ type: "text", text: "x" }] }), JSON.stringify([{ type: "text", text: "x" }], null, 2));
});

test("lastAgentExchange 返回最近一次助手往返，并在窗口内筛选", () => {
  const messages = [
    { role: "user", content: "first", timestamp: 100 },
    { role: "assistant", content: "reply-1", timestamp: 200 },
    { role: "user", content: "second", timestamp: 300 },
    { role: "assistant", content: "reply-2", timestamp: 400 },
  ];
  assert.deepEqual(lastAgentExchange(messages), { received: { role: "user", content: "second" }, sent: { role: "assistant", content: "reply-2" } });

  // startedAt 之后没有助手消息 -> null
  assert.equal(lastAgentExchange(messages, 500), null);
  // 只看 300 之后：最近一次助手仍是 reply-2，收到的输入是 second
  assert.deepEqual(lastAgentExchange(messages, 300), { received: { role: "user", content: "second" }, sent: { role: "assistant", content: "reply-2" } });
});

test("lastAgentExchange 在没有助手消息时返回 null", () => {
  assert.equal(lastAgentExchange([{ role: "user", content: "only user" }]), null);
  assert.equal(lastAgentExchange([]), null);
});

test("playerProfileMessage 只在有描述时追加描述行", () => {
  assert.equal(playerProfileMessage("阿岚", "  "), "玩家角色：\n姓名：阿岚");
  assert.equal(playerProfileMessage("阿岚", " 一位旅人 "), "玩家角色：\n姓名：阿岚\n描述：一位旅人");
});

test("playerProfileContext 缺描述时给出明确占位而不是空行", () => {
  assert.equal(playerProfileContext("阿岚", "  "), "# Player character profile (fixed RP context)\n\nName: 阿岚\n\nDescription: not specified");
  assert.match(playerProfileContext("阿岚", "旅人"), /Description:\n旅人/);
});
