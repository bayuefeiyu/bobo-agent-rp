import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MARKER = /^<!-- role: (system|user|assistant) -->$/;

export function parseRolePrompt(source, defaultRole = "system") {
  if (!["system", "user", "assistant"].includes(defaultRole)) throw new Error(`Invalid default prompt role: ${defaultRole}`);
  if (typeof source !== "string" || !source.trim()) return [];
  const blocks = [];
  let role = defaultRole;
  let lines = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) blocks.push({ role, content });
    lines = [];
  };
  for (const line of source.split(/\r?\n/)) {
    const marker = line.match(MARKER);
    if (marker) {
      flush();
      role = marker[1];
    } else if (/^<!--\s*role\s*:/.test(line)) {
      throw new Error(`Invalid role marker: ${line}`);
    } else {
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

export function mergeAdjacentMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (!message?.content?.trim()) continue;
    const previous = result.at(-1);
    if (previous && previous.role === message.role && ["user", "assistant", "system"].includes(message.role)) {
      previous.content += `\n\n${message.content}`;
    } else result.push({ ...message });
  }
  return result;
}

export function selectPrompts(total, model, exclusive = false) {
  return exclusive ? (model.length ? model : total) : [...total, ...model];
}

export function assembleInitialContext({ baseSystem, prefix = [], agent = [], card = [], player = [], history = [], current, tail = [] }) {
  const messages = [...prefix, ...agent, ...card, ...player, ...history, ...(current ? [current] : []), ...tail];
  const system = [baseSystem];
  const conversation = [];
  let seenConversation = false;
  for (const message of messages) {
    if (message.role === "system") {
      if (seenConversation) throw new Error("A system role block cannot follow user or assistant messages.");
      system.push(message.content);
    } else {
      seenConversation = true;
      conversation.push(message);
    }
  }
  return { systemPrompt: system.filter(Boolean).join("\n\n"), messages: mergeAdjacentMessages(conversation) };
}

export function recentNarrativeMessages(records, beforeTurn, limit, truncatedNotice = "") {
  const eligible = records.filter(record => record.binding.turn < beforeTurn && ["user", "assistant"].includes(record.data.role));
  const assistants = eligible.filter(record => record.data.role === "assistant").slice(-limit);
  if (!assistants.length) return [];
  const first = eligible.indexOf(assistants[0]);
  const selected = eligible.slice(first).filter(record => record.data.role === "user" || assistants.includes(record));
  const result = [];
  if (first > 0 && truncatedNotice) result.push({ role: "user", content: truncatedNotice });
  for (const record of selected) {
    const turn = record.binding.turn;
    const content = record.data.role === "assistant"
      ? `【第${turn}轮${record.data.kind === "opening" ? "·开场" : ""}】\n${record.data.content}`
      : record.data.content;
    result.push({ role: record.data.role, content });
  }
  return result;
}

export function conciseWorkspaceIndex(documents, hasFullIndex = false) {
  if (!documents.length) return hasFullIndex ? "完整索引：`WORKSPACE-DOCUMENTS.md`。当前没有预置资料文档。" : "本节点没有预置工作区文档。";
  return ["以下路径相对于当前工作目录。", ...(hasFullIndex ? ["完整说明与元数据：`WORKSPACE-DOCUMENTS.md`。"] : []), ...documents.map(document => {
    const policy = document.readPolicy === "required" ? "必读" : "按需";
    const entry = document.entryPath || document.path;
    return `- ${policy}｜\`${entry}\`：${document.description || document.id}`;
  })].join("\n");
}

export function currentTaskMessage({ input, task, index, additional = "" }) {
  return { role: "user", content: [
    input === null || input === undefined ? "" : `【玩家本轮输入】\n${input}`,
    `【任务】\n${task}`,
    additional,
    `【可用资料】\n${index}`,
  ].filter(Boolean).join("\n\n") };
}

export function seededPiMessage(message, model, timestamp = Date.now()) {
  const content = [{ type: "text", text: message.content }];
  if (message.role === "user") return { role: "user", content, timestamp };
  if (message.role !== "assistant") throw new Error(`Cannot seed conversation role: ${message.role}`);
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    role: "assistant", content,
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost },
    stopReason: "stop", timestamp,
  };
}

export async function readPromptFile(root, path) {
  if (!path) return "";
  if (typeof path !== "string" || isAbsolute(path)) throw new Error("Prompt path must be relative.");
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.startsWith("prompts/")) throw new Error(`Prompt source must be in prompts/: ${path}`);
  const target = resolve(root, path);
  const promptRoot = resolve(root, "prompts");
  const relation = relative(promptRoot, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error(`Prompt path escapes prompts/: ${path}`);
  const actualRoot = await realpath(promptRoot);
  const actualTarget = await realpath(target);
  const actualRelation = relative(actualRoot, actualTarget);
  if (!actualRelation || actualRelation === ".." || actualRelation.startsWith(`..${sep}`) || isAbsolute(actualRelation)) throw new Error(`Prompt symlink escapes prompts/: ${path}`);
  return readFile(target, "utf8");
}

export async function promptSourcePathAllowed(workspace, requested, promptRoots) {
  if (typeof requested !== "string" || !requested.trim()) return false;
  const target = resolve(workspace, requested);
  let ancestor = target;
  const missing = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") return false;
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) return false;
      missing.unshift(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
  const canonical = resolve(ancestor, ...missing);
  for (const root of promptRoots) {
    let canonicalRoot;
    try { canonicalRoot = await realpath(root); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const relation = relative(canonicalRoot, canonical);
    if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) return false;
  }
  return true;
}
