// 会话转录与角色资料的展示层格式化（S5 批次 2）。
//
// 只做纯字符串/结构转换：把 provider 消息内容归一为文本、取最近一次 Agent 往返、拼装玩家资料。
// 不持有会话状态、不做 I/O，因此可独立测试（见 rp-transcript-display.test.mjs）。
//
// 从 `../extensions/pi-rp-web.ts` 原样搬出，函数体与类型注解未改写。

export {
  debugMessageContent,
  lastAgentExchange,
  messageText,
  playerProfileContext,
  playerProfileMessage,
};

function playerProfileContext(playerName: string, description: string) {
  return [
    "# Player character profile (fixed RP context)",
    `Name: ${playerName}`,
    description.trim() ? `Description:\n${description.trim()}` : "Description: not specified",
  ].join("\n\n");
}

function playerProfileMessage(playerName: string, description: string) {
  return `玩家角色：\n姓名：${playerName}${description.trim() ? `\n描述：${description.trim()}` : ""}`;
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function debugMessageContent(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (message?.content === undefined) return "";
  return JSON.stringify(message.content, null, 2);
}

function lastAgentExchange(messages: any[], startedAt = 0) {
  const relevant = messages.filter(message => {
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : Date.parse(message?.timestamp || "");
    return !startedAt || !Number.isFinite(timestamp) || timestamp >= startedAt;
  });
  let assistantIndex = -1;
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    if (relevant[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex === -1) return null;
  const received = relevant.slice(0, assistantIndex).reverse().find(message => message?.role !== "assistant");
  const sent = relevant[assistantIndex];
  return {
    received: received ? { role: received.role || received.customType || "unknown", content: debugMessageContent(received) } : null,
    sent: { role: sent.role || "assistant", content: debugMessageContent(sent) },
  };
}
