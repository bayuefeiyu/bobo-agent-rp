import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { cleanupArtifacts, readVisibleArtifacts, registerNodeArtifacts, workflowNodeWorkspace } from "./rp-data-artifacts.mjs";
import { readWorkflowCallTextFile, stageWorkflowCallInputs, stageWorkspaceHandoffs } from "./rp-workspace-handoff.mjs";

test("textFile reads the entire caller file without parsing Markdown and rejects invalid sources", async t => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "rp-call-text-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const workflow = { id: "story" }, run = { id: "turn-1" }, node = { id: "writer" };
  const workspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id);
  await mkdir(resolve(workspace, "notes"), { recursive: true });
  const content = "\uFEFF# 情景分析\r\n林月也许认出了他。\r\n\r\n# 查询清单\r\n- 她以前见过青鸦吗？\r\n";
  await writeFile(resolve(workspace, "notes/analysis.md"), content);
  const read = path => readWorkflowCallTextFile({ sessionDirectory, workflow, run, node, path });
  assert.equal(await read("notes/analysis.md"), content);
  assert.equal(await read("notes\\analysis.md"), content);
  for (const path of ["../private.md", resolve(workspace, "notes/analysis.md"), "C:\\private.md", "notes/analysis.md:secret", "\0", " "]) {
    await assert.rejects(() => read(path), /safe caller-workspace relative path/);
  }
  await assert.rejects(() => read("notes"), /regular file/);
  await assert.rejects(() => read("missing.md"), /ENOENT/);
  await writeFile(resolve(workspace, "binary.md"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(() => read("binary.md"), /encoded data|UTF-8/i);
  await writeFile(resolve(workspace, "nul.md"), "before\0after");
  await assert.rejects(() => read("nul.md"), /UTF-8/);
  // Windows junctions exercise an ancestor-link escape without symlink privileges.
  const outside = resolve(sessionDirectory, "outside");
  await mkdir(outside);
  await writeFile(resolve(outside, "private.md"), "outside");
  await symlink(outside, resolve(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => read("linked/private.md"), /symbolic links/);
});

function sourceNode() {
  return {
    id: "prepare",
    outputs: {
      plan: { path: "plan.md", kind: "file", format: "markdown", scope: "workflow", retain: "run" },
      materials: { path: "materials", kind: "directory", format: null, scope: "workflow", retain: "run" },
      workspaceMap: { path: "WORKSPACE-DOCUMENTS.md", kind: "file", format: "markdown", scope: "workflow", retain: "run" },
      inherited: { path: "handoff/earlier/reference", kind: "directory", format: null, scope: "workflow", retain: "run" },
      privateDraft: { path: "private.md", kind: "file", format: "markdown", scope: "workflow", retain: "run" },
    },
    workspaceHandoff: { include: [
      { output: "plan", as: "approved-plan.md" },
      { output: "materials" },
      { output: "workspaceMap" },
      { output: "inherited" },
    ] },
  };
}

test("registers only explicitly included files and directories as workspace handoffs", async t => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "rp-artifacts-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const workflow = { id: "story" };
  const run = {
    id: "run-current",
    turn: 3,
    nodes: { prepare: { narrativeSource: { producerKind: "code", producerId: "prepare", layer: "unspecified", characterId: null } } },
  };
  const node = sourceNode();
  const workspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id);
  await mkdir(resolve(workspace, "materials", "nested"), { recursive: true });
  await mkdir(resolve(workspace, "handoff", "earlier", "reference"), { recursive: true });
  await writeFile(resolve(workspace, "plan.md"), "Plan\n");
  await writeFile(resolve(workspace, "private.md"), "Do not transfer\n");
  await writeFile(resolve(workspace, "materials", "nested", "fact.md"), "Fact\n");
  const workspaceMap = "# Source map\n\n- `materials/nested/fact.md`\n- `handoff/earlier/reference/history.md`\n";
  await writeFile(resolve(workspace, "WORKSPACE-DOCUMENTS.md"), workspaceMap);
  await writeFile(resolve(workspace, "handoff", "earlier", "reference", "history.md"), "History\n");
  const registered = await registerNodeArtifacts({ sessionDirectory, workflow, run, node });
  assert.equal(registered.materials.kind, "directory");
  assert.equal(registered.materials.handoffPath, "materials");
  assert.equal(registered.privateDraft.handoffPath, null);
  const visible = await readVisibleArtifacts({
    sessionDirectory,
    target: { workflowRunId: run.id, nodeId: "consume", turn: 3 },
    fromNodeIds: ["prepare"],
    sourceWorkflowRunId: run.id,
    handoffOnly: true,
  });
  assert.deepEqual(visible.map(item => item.id).sort(), ["inherited", "materials", "plan", "workspaceMap"]);
  assert.equal(await readFile(resolve(visible.find(item => item.id === "plan").path), "utf8"), "Plan\n");
  const consumer = { id: "consume", dependsOn: ["prepare"], context: { fromNodes: ["prepare"] } };
  const staged = await stageWorkspaceHandoffs({ sessionDirectory, workflow, run, node: consumer });
  assert.deepEqual(staged.map(item => item.stagedPath).sort(), [
    "handoff/prepare/WORKSPACE-DOCUMENTS.md",
    "handoff/prepare/approved-plan.md",
    "handoff/prepare/handoff/earlier/reference",
    "handoff/prepare/materials",
  ]);
  const consumerWorkspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, consumer.id);
  assert.equal(await readFile(resolve(consumerWorkspace, "handoff", "prepare", "approved-plan.md"), "utf8"), "Plan\n");
  assert.equal(await readFile(resolve(consumerWorkspace, "handoff", "prepare", "materials", "nested", "fact.md"), "utf8"), "Fact\n");
  assert.equal(await readFile(resolve(consumerWorkspace, "handoff", "prepare", "WORKSPACE-DOCUMENTS.md"), "utf8"), workspaceMap);
  assert.equal(await readFile(resolve(consumerWorkspace, "handoff", "prepare", "handoff", "earlier", "reference", "history.md"), "utf8"), "History\n");
  await assert.rejects(() => readFile(resolve(consumerWorkspace, "handoff", "prepare", "private.md"), "utf8"), /ENOENT/);
  await cleanupArtifacts(sessionDirectory, { type: "run", workflowRunId: run.id });
  await assert.rejects(() => readFile(resolve(workspace, "plan.md"), "utf8"), /ENOENT/);
});

test("module call inputs accept explicitly named files and directories", async t => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "rp-call-inputs-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const parentWorkspace = workflowNodeWorkspace(sessionDirectory, "parent", "parent-run", "caller");
  await mkdir(resolve(parentWorkspace, "bundle"), { recursive: true });
  await writeFile(resolve(parentWorkspace, "request.md"), "Request\n");
  await writeFile(resolve(parentWorkspace, "bundle", "data.json"), "{}\n");
  const workflow = { id: "child", interface: { inputs: { request: { kind: "file" }, bundle: { kind: "directory" } } } };
  const run = {
    id: "child-run",
    callContext: { parentWorkflowId: "parent", parentRunId: "parent-run", parentNodeId: "caller" },
    arguments: {},
    documents: { request: "request.md", bundle: "bundle" },
  };
  const inputs = await stageWorkflowCallInputs({ sessionDirectory, workflow, run, node: { id: "worker", metadata: { callInputs: ["request", "bundle"] } } });
  assert.deepEqual(inputs.map(item => [item.id, item.kind]), [["request", "file"], ["bundle", "directory"]]);
  const workspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, "worker");
  assert.equal(await readFile(resolve(workspace, "inputs", "request.md"), "utf8"), "Request\n");
  assert.equal(await readFile(resolve(workspace, "inputs", "bundle", "data.json"), "utf8"), "{}\n");
  await assert.rejects(() => stageWorkflowCallInputs({
    sessionDirectory,
    workflow: { id: "other-child", interface: { inputs: { bundle: { kind: "file" } } } },
    run: { ...run, id: "other-run", documents: { bundle: "bundle" } },
    node: { id: "worker", metadata: { callInputs: ["bundle"] } },
  }), /must be a file/);
});
