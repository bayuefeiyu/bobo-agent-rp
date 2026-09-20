import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDeliveryContract, createAgentDelivery, runAgentDeliverySession } from "./rp-agent-delivery.mjs";
import { agentFiles, countText } from "./rp-agent-files.mjs";

async function fixture(t, outputs = { narrative: { path: "narrative.md", kind: "file", format: "narrative" } }, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "rp-delivery-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const node = { id: "writer", outputs, delivery: { primaryOutput: Object.keys(outputs).find(id => outputs[id].kind !== "directory") || null }, ...options.node };
  const delivery = await createAgentDelivery({ workspace, node, agent: options.agent || {}, beforeComplete: options.beforeComplete });
  const put = async (path, content) => { const absolute = join(workspace, path); await mkdir(join(absolute, ".."), { recursive: true }); await writeFile(absolute, content); };
  return { workspace, delivery, put };
}

test("a draft can be delivered directly; completion is separate and result comes from the artifact", async t => {
  const { workspace, delivery, put } = await fixture(t);
  await put("drafts/scene.md", "正式正文");
  const receipt = await delivery.deliver({ output: "narrative", path: "drafts/scene.md" });
  assert.equal(receipt.ok, true);
  assert.equal(delivery.completed, false);
  assert.equal(await readFile(join(workspace, "narrative.md"), "utf8"), "正式正文");
  assert.equal(await readFile(join(workspace, "drafts/scene.md"), "utf8"), "正式正文");
  await delivery.complete();
  assert.equal(await delivery.result(), "正式正文");
  await assert.rejects(delivery.complete(), { code: "node_already_completed" });
  await assert.rejects(delivery.deliver({ output: "narrative", path: "drafts/scene.md" }), { code: "node_already_completed" });
});

test("JSON syntax and field errors can be fixed in-place without losing an accepted version", async t => {
  const { workspace, delivery, put } = await fixture(t, { result: { path: "result.json", kind: "file", format: "json", jsonSchema: { type: "object", required: ["operations"], properties: { operations: { type: "array" } } } } }, { agent: { outputMode: "json" } });
  await put("draft.json", '{"operations":[]}');
  await delivery.deliver({ output: "result", path: "draft.json" });
  await put("draft.json", '{"operations":[],}');
  await assert.rejects(delivery.deliver({ output: "result", path: "draft.json" }), { code: "delivery_invalid_json" });
  assert.equal(await readFile(join(workspace, "draft.json"), "utf8"), '{"operations":[],}');
  assert.equal(await readFile(join(workspace, "result.json"), "utf8"), '{"operations":[]}');
  await put("draft.json", '{"operations":4}');
  await assert.rejects(delivery.deliver({ output: "result", path: "draft.json" }), /\/operations: Expected/);
  await put("draft.json", '{"operations":[{"action":"create"}]}');
  await delivery.deliver({ output: "result", path: "draft.json" });
  await delivery.complete();
  assert.deepEqual(await delivery.result(), { operations: [{ action: "create" }] });
});

test("same-path delivery supports further editing but requires a fresh receipt", async t => {
  const { delivery, put } = await fixture(t);
  await put("narrative.md", "v1");
  await delivery.deliver({ output: "narrative", path: "narrative.md" });
  await put("narrative.md", "v2");
  await assert.rejects(delivery.complete(), /重新交付/);
  assert.equal(delivery.completed, false);
  await delivery.deliver({ output: "narrative", path: "narrative.md" });
  await delivery.complete();
  assert.equal(await delivery.result(), "v2");
});

test("directory redelivery replaces stale files; required children are checked", async t => {
  const { workspace, delivery, put } = await fixture(t, { candidate: { path: "candidate", kind: "directory", format: "story-candidate-draft" } });
  await put("draft/story.md", "故事");
  await assert.rejects(delivery.deliver({ output: "candidate", path: "draft" }), /metadata.json/);
  await put("draft/metadata.json", "{}");
  await put("draft/old.md", "旧文件");
  await delivery.deliver({ output: "candidate", path: "draft" });
  await put("revised/story.md", "新故事");
  await put("revised/metadata.json", "{}");
  await delivery.deliver({ output: "candidate", path: "revised" });
  await assert.rejects(readFile(join(workspace, "candidate/old.md")), { code: "ENOENT" });
  await delivery.complete();
  assert.deepEqual(await delivery.result(), { outputs: { candidate: "candidate" } });
});

test("all required outputs must be submitted; generated snapshot is not an Agent delivery", async t => {
  const { delivery, put } = await fixture(t, { narrative: { path: "narrative.md", kind: "file", format: "narrative" }, notes: { path: "notes.md", kind: "file", required: false }, snapshot: { path: "snapshot", kind: "directory" } }, { node: { metadata: { documentWorkspaceSnapshot: { output: "snapshot" } }, delivery: { primaryOutput: "narrative" } } });
  await put("narrative.md", "正文");
  await assert.rejects(delivery.complete(), /尚未成功交付/);
  await assert.rejects(delivery.deliver({ output: "snapshot", path: "snapshot" }), { code: "delivery_unknown_output" });
  await delivery.deliver({ output: "narrative", path: "narrative.md" });
  await delivery.complete();
});

test("input and private files are protected, traversal and directory overlap are rejected", async t => {
  const { delivery, put } = await fixture(t);
  await put("materials/context.md", "输入");
  await assert.rejects(delivery.access("materials/context.md", true), /read-only/);
  await assert.rejects(delivery.access("../escape.md", true), /traversal/);
  await assert.rejects(delivery.access(".rp-delivery/receipts.json"), /runtime-private/);
  await assert.rejects(delivery.deliver({ output: "narrative", path: "materials/context.md" }), /input/);
  await assert.rejects(delivery.deliver({ output: "narrative", path: "." }), /inside/);
  await assert.rejects(delivery.assertCallOutputPath("narrative.md"), /formal deliveries/);
  await assert.rejects(delivery.assertCallOutputPath("materials/call-output.md"), /read-only/);
  await put("call-output.md", "来自子流程");
  await delivery.assertCallOutputPath("call-output.md");
  await delivery.protect("call-output.md");
  await assert.rejects(delivery.access("call-output.md", true), /read-only/);
  assert.throws(() => agentDeliveryContract({ id: "bad", outputs: { a: { path: "out", kind: "directory" }, b: { path: "out/b.md", kind: "file" } } }), /overlap/);
  assert.throws(() => agentDeliveryContract({ id: "aliases", outputs: { a: { path: "out//result.md", kind: "file" }, b: { path: "out/result.md", kind: "file" } } }), /overlap/);
});

test("text deliveries reject malformed UTF-8 before replacing the accepted file", async t => {
  const { workspace, delivery, put } = await fixture(t, { narrative: { path: "narrative.md", kind: "file", format: "markdown" } });
  await put("draft.md", "valid");
  await delivery.deliver({ output: "narrative", path: "draft.md" });
  await put("draft.md", Buffer.from([0xc3, 0x28]));
  await assert.rejects(delivery.deliver({ output: "narrative", path: "draft.md" }), { code: "delivery_invalid_text" });
  assert.equal(await readFile(join(workspace, "narrative.md"), "utf8"), "valid");
});

test("junctions cannot bypass workspace boundary", async t => {
  const { workspace, delivery } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "rp-delivery-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(delivery.access("link/new.md", true), /links|junctions/);
});

test("missing end triggers a bounded continuation in the same session", async t => {
  const { delivery, put } = await fixture(t);
  let calls = 0;
  const session = { messages: [], async prompt(prompt) {
    calls++;
    if (calls === 1) { await put("draft.md", "正文"); await delivery.deliver({ output: "narrative", path: "draft.md" }); }
    else { assert.match(prompt, /rp_node_complete/); await delivery.complete(); }
  } };
  await runAgentDeliverySession({ session, prompt: "创作", delivery });
  assert.equal(calls, 2);
  const second = await fixture(t);
  let rounds = 0;
  await assert.rejects(runAgentDeliverySession({ delivery: second.delivery, prompt: "work", session: { messages: [], async prompt() { rounds++; } } }), { code: "agent_delivery_not_completed" });
  assert.equal(rounds, 3);
});

test("required workflow calls gate completion and can be repaired", async t => {
  let called = false;
  const { delivery, put } = await fixture(t, undefined, { beforeComplete: () => { if (!called) throw new Error("required call missing"); } });
  await put("draft.md", "正文");
  await delivery.deliver({ output: "narrative", path: "draft.md" });
  await assert.rejects(delivery.complete(), /required call/);
  called = true;
  await delivery.complete();
});

test("listing excludes private staging; counts are objective and newline-stable", async t => {
  const { delivery, put } = await fixture(t);
  await put("draft.md", "# 标题\r\n\r\n你好，world！");
  await put("materials/context.md", "只读");
  const listed = await agentFiles(delivery, { action: "list", recursive: true });
  assert.ok(listed.entries.every(entry => !entry.path.startsWith(".rp-delivery")));
  assert.equal(listed.entries.find(entry => entry.path === "materials/context.md").writable, false);
  const counted = await agentFiles(delivery, { action: "count", path: "draft.md" });
  assert.equal(counted.words, 7);
  assert.equal("passed" in counted, false);
  assert.equal(countText("甲\r\n乙").chars, countText("甲\n乙").chars);
});
