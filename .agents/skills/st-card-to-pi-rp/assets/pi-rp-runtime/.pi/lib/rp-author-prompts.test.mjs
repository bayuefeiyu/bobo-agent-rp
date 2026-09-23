import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { playNodePrompt, playPromptSources } from "./rp-author-prompts.mjs";

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
  assert.equal(result.fullNodeText, "节点写阿岚");
  assert.equal(result.taskStages.staged, false);
});

test("staged node prompts expose only shared text and the first stage", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-author-prompts-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const card = join(root, "card");
  for (const directory of [join(root, "prompts/system"), join(card, "prompts/workflows")]) await mkdir(directory, { recursive: true });
  await writeFile(join(root, "prompts/system/base.md"), "{{AVAILABLE_TOOLS}}\n{{WORKSPACE}}", "utf8");
  await writeFile(join(root, "prompts/system/tools.json"), "{}", "utf8");
  await writeFile(join(card, "prompts/workflows/staged.md"), "共同{{user}}\n<!-- stage -->\n分析\n<!-- stage -->\n创作", "utf8");
  const result = await playPromptSources(
    { context: { cwd: root }, cardDirectory: card, playerName: "阿岚" },
    null, null, { id: "work", promptFile: "prompts/workflows/staged.md" }, join(root, "workspace"), [],
  );
  assert.match(result.nodeText, /共同阿岚.*分析/s);
  assert.doesNotMatch(result.nodeText, /创作/);
  assert.match(result.fullNodeText, /创作/);
  assert.deepEqual(result.taskStages.stages, ["分析", "创作"]);
});

test("isolated cards reject missing prompts even when the shared root has a matching file", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-author-prompts-"));
  t.after(async () => {
    const verified = await realpath(root);
    if (!verified.startsWith(`${resolve(tmpdir())}\\rp-author-prompts-`)) throw new Error(`Unexpected test directory: ${verified}`);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "prompts", "system"), { recursive: true });
  await writeFile(join(root, "prompts", "system", "base.md"), "shared", "utf8");
  await writeFile(join(root, "prompts", "system", "tools.json"), "{}", "utf8");
  await assert.rejects(playPromptSources(
    { context: { cwd: root }, cardDirectory: join(root, "card"), playerName: "阿岚", isolatedRuntime: true },
    null, null, { id: "write", prompt: "write" }, join(root, "workspace"), [],
  ), /Missing play prompt/);
});

test("team nodes load their card-owned promptFile", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-author-prompts-"));
  t.after(async () => {
    const verified = await realpath(root);
    if (!verified.startsWith(`${resolve(tmpdir())}\\rp-author-prompts-`)) throw new Error(`Unexpected test directory: ${verified}`);
    await rm(root, { recursive: true, force: true });
  });
  const card = join(root, "card");
  await mkdir(join(card, "prompts/modules/director/workflows/planning"), { recursive: true });
  await writeFile(join(card, "prompts/modules/director/workflows/planning/meeting.md"), "为{{user}}召开会议", "utf8");
  assert.equal(await playNodePrompt(
    { context: { cwd: root }, cardDirectory: card, playerName: "阿岚", isolatedRuntime: true },
    { id: "meeting", type: "team", promptFile: "prompts/modules/director/workflows/planning/meeting.md" },
  ), "为阿岚召开会议");
});

test("development mode resolves a module prompt from its global source package", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-author-prompts-"));
  t.after(async () => {
    const verified = await realpath(root);
    if (!verified.startsWith(`${resolve(tmpdir())}\\rp-author-prompts-`)) throw new Error(`Unexpected test directory: ${verified}`);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "global-modules/director/prompts/workflows/planning"), { recursive: true });
  await writeFile(join(root, "global-modules/director/prompts/workflows/planning/meeting.md"), "开发态会议", "utf8");
  const node = { id: "meeting", promptFile: "prompts/modules/director/workflows/planning/meeting.md" };
  assert.equal(await playNodePrompt({ context: { cwd: root }, cardDirectory: join(root, "card"), playerName: "阿岚" }, node), "开发态会议");
  await assert.rejects(
    playNodePrompt({ context: { cwd: root }, cardDirectory: join(root, "card"), playerName: "阿岚", isolatedRuntime: true }, node),
    /Missing node prompt file/,
  );
});
