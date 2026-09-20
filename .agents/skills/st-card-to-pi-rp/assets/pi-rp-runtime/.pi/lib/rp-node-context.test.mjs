import assert from "node:assert/strict";
import test from "node:test";
import { assembleInitialContext, conciseWorkspaceIndex, currentTaskMessage, parseRolePrompt, promptSourcePathAllowed, readPromptFile, recentNarrativeMessages, seededPiMessage, selectPrompts } from "./rp-node-context.mjs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("role markers produce real messages and adjacent author blocks merge", () => {
  const prefix = parseRolePrompt("System rule\n<!-- role: user -->\nQuestion\n<!-- role: assistant -->\nAnswer");
  const context = assembleInitialContext({ baseSystem: "BASE", prefix, current: { role: "user", content: "CURRENT" } });
  assert.equal(context.systemPrompt, "BASE\n\nSystem rule");
  assert.deepEqual(context.messages.map(item => item.role), ["user", "assistant", "user"]);
  assert.throws(() => assembleInitialContext({ baseSystem: "BASE", prefix: parseRolePrompt("<!-- role: user -->\nA\n<!-- role: system -->\nB") }), /system role block/);
});

test("exclusive prompt selection falls back only when model content is empty", () => {
  const total = [{ role: "user", content: "TOTAL" }];
  const model = [{ role: "user", content: "MODEL" }];
  assert.deepEqual(selectPrompts(total, model, false), [...total, ...model]);
  assert.deepEqual(selectPrompts(total, model, true), model);
  assert.deepEqual(selectPrompts(total, [], true), total);
});

test("history starts at the first selected published assistant, including opening", () => {
  const record = (turn, role, content, kind = "message") => ({ binding: { turn }, data: { role, content, kind } });
  const records = [record(0, "assistant", "Opening", "opening"), record(1, "user", "U1"), record(1, "assistant", "A1"), record(2, "user", "U2"), record(2, "assistant", "A2")];
  const three = recentNarrativeMessages(records, 3, 3, "TRUNCATED");
  assert.deepEqual(three.map(item => item.role), ["assistant", "user", "assistant", "user", "assistant"]);
  assert.match(three[0].content, /【第0轮·开场】/);
  const one = recentNarrativeMessages(records, 3, 1, "TRUNCATED");
  assert.deepEqual(one.map(item => item.role), ["user", "assistant"]);
  assert.equal(one[0].content, "TRUNCATED");
  assert.match(one[1].content, /【第2轮】/);
});

test("current user contains input, task, and concise index", () => {
  const index = conciseWorkspaceIndex([{ id: "card", entryPath: "handoff/card/DOCUMENTS.md", path: "handoff/card", readPolicy: "required", description: "资料目录" }]);
  const current = currentTaskMessage({ input: "你好", task: "创作正文", index });
  assert.match(current.content, /【玩家本轮输入】\n你好/);
  assert.match(current.content, /【任务】\n创作正文/);
  assert.match(current.content, /必读｜`handoff\/card\/DOCUMENTS\.md`/);
});

test("seeded assistant history uses Pi's complete assistant message shape", () => {
  const model = { api: "openai-completions", provider: "fixture", id: "fixture-model" };
  const message = seededPiMessage({ role: "assistant", content: "Published story" }, model, 42);
  assert.equal(message.role, "assistant");
  assert.equal(message.api, model.api);
  assert.equal(message.model, model.id);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.totalTokens, 0);
  assert.deepEqual(message.content, [{ type: "text", text: "Published story" }]);
});

test("file tools cannot read prompt sources through absolute or symlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-context-"));
  const workspace = join(root, "work");
  const prompts = join(root, "prompts");
  await mkdir(workspace);
  await mkdir(prompts);
  assert.equal(await promptSourcePathAllowed(workspace, join(prompts, "system", "base.md"), [prompts]), false);
  assert.equal(await promptSourcePathAllowed(workspace, "notes.md", [prompts]), true);
  await symlink(prompts, join(workspace, "shortcut"), "junction");
  assert.equal(await promptSourcePathAllowed(workspace, "shortcut/base.md", [prompts]), false);
});

test("prompt source loader stays inside prompts and rejects escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-prompt-loader-"));
  const prompts = join(root, "prompts");
  await mkdir(prompts);
  await writeFile(join(prompts, "valid.md"), "valid");
  await writeFile(join(root, "outside.md"), "outside");
  assert.equal(await readPromptFile(root, "prompts/valid.md"), "valid");
  await assert.rejects(() => readPromptFile(root, "outside.md"), /must be in prompts/);
  await assert.rejects(() => readPromptFile(root, "prompts/../outside.md"), /escapes prompts/);
  await symlink(join(root, "outside.md"), join(prompts, "shortcut.md"));
  await assert.rejects(() => readPromptFile(root, "prompts/shortcut.md"), /symlink escapes prompts/);
});
