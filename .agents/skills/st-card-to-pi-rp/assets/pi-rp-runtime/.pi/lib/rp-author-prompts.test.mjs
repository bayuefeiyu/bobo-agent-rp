import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { playPromptSources } from "./rp-author-prompts.mjs";

test("base, file, inline, prefix, tail, and tool prompts bind the session player", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-author-prompts-"));
  t.after(async () => {
    const verified = await realpath(root);
    if (!verified.startsWith(`${resolve(tmpdir())}\\rp-author-prompts-`)) throw new Error(`Unexpected test directory: ${verified}`);
    await rm(root, { recursive: true, force: true });
  });
  const card = join(root, "card");
  for (const directory of [join(root, "prompts/system"), join(root, "prompts/prefix"), join(root, "prompts/tail"), join(card, "prompts/agent")]) await mkdir(directory, { recursive: true });
  await writeFile(join(root, "prompts/system/base.md"), "世界：{{user}}\n{{AVAILABLE_TOOLS}}\n{{WORKSPACE}}", "utf8");
  await writeFile(join(root, "prompts/system/tools.json"), JSON.stringify({ read: "读取{{user}}的资料" }), "utf8");
  await writeFile(join(root, "prompts/prefix/total.md"), "总前缀{{user}}", "utf8");
  await writeFile(join(root, "prompts/tail/total.md"), "总尾缀{{user}}", "utf8");
  await writeFile(join(card, "prompts/agent/writer.md"), "Agent 写{{user}}", "utf8");
  const result = await playPromptSources(
    { context: { cwd: root }, cardDirectory: card, playerName: "阿岚" },
    { headPrompt: "模型前缀{{user}}", tailPrompt: "模型尾缀{{user}}" },
    { promptFile: "prompts/agent/writer.md" },
    { id: "write", prompt: "节点写{{user}}" },
    join(root, "workspace"), ["read"],
  );
  assert.match(result.baseSystem, /世界：阿岚/);
  assert.match(result.baseSystem, /读取阿岚的资料/);
  assert.match(result.baseSystem, /workspace/);
  for (const value of [result.prefix, result.tail, result.agent, result.nodeText]) assert.doesNotMatch(JSON.stringify(value), /{{user}}/);
  assert.match(JSON.stringify(result.prefix), /总前缀阿岚.*模型前缀阿岚/);
  assert.match(JSON.stringify(result.tail), /总尾缀阿岚.*模型尾缀阿岚/);
  assert.match(JSON.stringify(result.agent), /Agent 写阿岚/);
  assert.equal(result.nodeText, "节点写阿岚");
});
