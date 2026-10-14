import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { normalizeCollaborationTeam } from "./rp-team-collaboration-config.mjs";
import { CollaborationStateStore } from "./rp-team-collaboration-state.mjs";
import { TeamCollaborationRuntime } from "./rp-team-collaboration-runtime.mjs";
import { createTaskStageController, parseTaskStages } from "./rp-task-stages.mjs";

const PRIMARY_CONTENT = "正文完整草稿";
const CONTEXT_CONTENT = "canon: 原始资料内容";

const member = (id, tools) => ({
  id,
  label: id === "writer" ? "Writer" : id === "co-creator" ? "Co-creator" : "Reviewer",
  agentId: `test/${id}`,
  modelId: null,
  tools,
});

const defaultMembers = () => [
  member("writer", ["read", "write", "edit", "rp_files"]),
  member("co-creator", ["read", "write", "edit", "rp_files", "rp_call"]),
];

function teamConfig({ members = defaultMembers(), initialMemberId = "writer", stageOwnerId = "writer", completionMemberId = "writer", outputOwners = { narrative: "writer" }, limits = {} } = {}) {
  return {
    schemaVersion: 2,
    protocol: "collaboration",
    members,
    initialMemberId,
    stageOwnerId,
    completionMemberId,
    outputOwners,
    limits: { maxActivations: 32, maxToolCalls: 128, maxProtocolReminders: 2, ...limits },
  };
}

function threeMemberTeam(options = {}) {
  return teamConfig({ ...options, members: [
    ...defaultMembers(),
    member("reviewer", ["read", "write", "edit", "rp_files"]),
  ] });
}

function collaborationNode({ team = teamConfig(), workflowCalls = [], requiredCalls = [], narrativePath = "narrative.md" } = {}) {
  return {
    id: "write-narrative",
    team,
    outputs: {
      narrative: { path: narrativePath, kind: "file", format: "narrative", scope: "workflow", retain: "run" },
      "post-turn-context": { path: "post-turn-context", kind: "directory", format: "document-workspace-snapshot", scope: "turn", retain: "turn" },
    },
    metadata: { documentWorkspaceSnapshot: { output: "post-turn-context" } },
    delivery: { primaryOutput: "narrative" },
    workflowCalls,
    requiredCalls,
  };
}

function usage() {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
}

function tool(request, name) {
  return request.collaboration.tools.find(entry => entry.name === name);
}

function executor() {
  let sequence = 0;
  return async (request, name, args = {}) => {
    const selected = tool(request, name);
    assert.ok(selected, `${request.memberId} should have ${name}`);
    return selected.execute(`${request.memberId}-${++sequence}`, args);
  };
}

async function workspaceFor(t, prefix) {
  const workspace = await mkdtemp(resolve(tmpdir(), `${prefix}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

function runtime({ workspace, node, runId = "run-1", taskPrompt = "ordinary task", invokeMember, invokeWorkflow } = {}) {
  return new TeamCollaborationRuntime({
    workspace,
    node,
    runId,
    context: "shared context",
    taskPrompt,
    invokeMember,
    invokeWorkflow,
  });
}

test("writer and co-creator exchange real documents, call the workflow, and complete the formal narrative", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-handoff");
  await mkdir(join(workspace, "materials"), { recursive: true });
  await writeFile(join(workspace, "materials", "context.md"), `${CONTEXT_CONTENT}\n`, "utf8");
  const node = collaborationNode({
    team: teamConfig(),
    workflowCalls: [{ target: "test/memory" }],
    requiredCalls: ["test/memory"],
  });
  const taskPrompt = "共同任务\n<!-- stage -->\n阶段一：起草\n<!-- stage -->\n阶段二：定稿";
  const requests = [];
  const workflowRequests = [];
  const execute = executor();
  let activation = 0;
  const invokeMember = async request => {
    requests.push(request);
    activation++;
    if (request.memberId === "writer" && activation === 1) {
      await request.collaboration.publish("writer proposes the initial direction");
      const read = await execute(request, "read", { path: "materials/context.md" });
      assert.equal(read.details.content, `${CONTEXT_CONTENT}\n`);
      await execute(request, "write", { path: "work/writer/正文.md", content: PRIMARY_CONTENT });
      await execute(request, "rp_team_handoff", {});
    } else if (request.memberId === "co-creator" && activation === 2) {
      assert.match(request.prompt, /writer proposes the initial direction/);
      assert.match(request.prompt, new RegExp(CONTEXT_CONTENT));
      assert.match(request.prompt, new RegExp(PRIMARY_CONTENT));
      const read = await execute(request, "read", { path: "work/writer/正文.md" });
      assert.equal(read.details.content, PRIMARY_CONTENT);
      await execute(request, "write", { path: "work/co-creator/意见.md", content: "保留动机一致性" });
      await execute(request, "rp_call", { workflow: "test/memory", text: "核实关系", outputPaths: {} });
      await execute(request, "rp_team_handoff", {});
    } else if (request.memberId === "writer" && (activation === 3 || activation === 4)) {
      await execute(request, "rp_task_next", {});
    } else if (request.memberId === "writer" && activation === 5) {
      await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
    } else if (request.memberId === "writer" && activation === 6) {
      await execute(request, "rp_node_complete", {});
    } else {
      throw new Error(`unexpected activation ${activation} for ${request.memberId}`);
    }
    return { terminated: true, usage: usage() };
  };
  const invokeWorkflow = async request => {
    workflowRequests.push(request);
    return { outputs: {}, usage: usage() };
  };

  const result = await runtime({ workspace, node, taskPrompt, invokeMember, invokeWorkflow }).run({ inputPaths: ["materials/context.md"] });

  assert.deepEqual(requests.map(request => request.memberId), ["writer", "co-creator", "writer", "writer", "writer", "writer"]);
  assert.equal(workflowRequests.length, 1);
  assert.equal(workflowRequests[0].workflow, "test/memory");
  assert.equal(workflowRequests[0].text, "核实关系");
  assert.equal(await readFile(join(workspace, "work", "co-creator", "意见.md"), "utf8"), "保留动机一致性");
  assert.equal(await readFile(join(workspace, "narrative.md"), "utf8"), PRIMARY_CONTENT);
  assert.equal(result.output, PRIMARY_CONTENT);
  assert.equal(result.state.status, "completed");
  assert.deepEqual(result.state.calledTargets, ["test/memory"]);
});

test("member permissions expose no co-creator delivery and no writer rp_call, and reject cross-owner edit", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-permissions");
  const node = collaborationNode({ team: teamConfig({ limits: { maxActivations: 4 } }) });
  const execute = executor();
  let writerRpCall = false;
  let coEditRejected = false;
  let coDeliverMissing = false;
  let writerActivations = 0;
  const invokeMember = async request => {
    if (request.memberId === "writer") {
      writerActivations++;
      if (writerActivations === 1) {
        writerRpCall = Boolean(tool(request, "rp_call"));
        await execute(request, "rp_team_handoff", {});
      } else {
        throw new Error("permission checks complete");
      }
    } else {
      const edit = tool(request, "edit");
      assert.ok(edit);
      await assert.rejects(
        () => edit.execute("cross-owner-edit", { path: "work/writer/正文.md", oldText: "x", newText: "y" }),
        /Write only your own work directory or an output you own\./,
      );
      coEditRejected = true;
      coDeliverMissing = !tool(request, "rp_deliver");
      await execute(request, "rp_team_handoff", { to: "writer" });
    }
    return { terminated: true, usage: usage() };
  };

  await assert.rejects(runtime({ workspace, node, invokeMember }).run(), /permission checks complete/);
  assert.equal(writerRpCall, false);
  assert.equal(coEditRejected, true);
  assert.equal(coDeliverMissing, true);
});

test("schema v2 rejects an invalid member and an invalid output owner", () => {
  const duplicateMembers = defaultMembers();
  duplicateMembers[1].id = "writer";
  assert.throws(() => normalizeCollaborationTeam(teamConfig({ members: duplicateMembers })), /member IDs must be unique/);
  assert.throws(() => normalizeCollaborationTeam(teamConfig({ outputOwners: { narrative: "ghost" } })), /output owner must reference a team member/);
});

test("three-member teams reject omitted and invalid handoff targets", async t => {
  for (const [label, args] of [["omitted", {}], ["invalid", { to: "missing" }]]) {
    const workspace = await workspaceFor(t, `pi-rp-team-collaboration-handoff-${label}`);
    const node = collaborationNode({ team: threeMemberTeam({ limits: { maxActivations: 3 } }) });
    const execute = executor();
    const invokeMember = async request => {
      await execute(request, "rp_team_handoff", args);
      return { terminated: true, usage: usage() };
    };
    await assert.rejects(runtime({ workspace, node, invokeMember }).run(), /Choose another valid member; to is required in larger teams\./);
  }
});

test("an ordinary response leaves the floor with the same member until an explicit handoff", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-no-rotation");
  const node = collaborationNode();
  const execute = executor();
  const members = [];
  const invokeMember = async request => {
    members.push(request.memberId);
    if (members.length === 1) return { terminated: true, usage: usage() };
    await execute(request, "write", { path: "work/writer/正文.md", content: "ordinary response" });
    await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
    await execute(request, "rp_node_complete", {});
    return { terminated: true, usage: usage() };
  };

  const result = await runtime({ workspace, node, invokeMember }).run();
  assert.deepEqual(members, ["writer", "writer"]);
  assert.equal(result.output, "ordinary response");
});

test("a formal document changed after delivery blocks completion", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-delivery-tamper");
  const node = collaborationNode();
  const execute = executor();
  let activation = 0;
  const invokeMember = async request => {
    activation++;
    if (activation === 1) {
      await execute(request, "write", { path: "work/writer/正文.md", content: "accepted" });
      await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
    } else {
      await writeFile(join(workspace, "narrative.md"), "tampered", "utf8");
      await execute(request, "rp_node_complete", {});
    }
    return { terminated: true, usage: usage() };
  };

  await assert.rejects(runtime({ workspace, node, invokeMember }).run(), error => error?.code === "delivery_incomplete" && /交付后内容发生变化/.test(error.message));
  assert.equal(await readFile(join(workspace, "narrative.md"), "utf8"), "tampered");
});

test("a completed collaboration resumes from its formal result without invoking a member", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-completed");
  const node = collaborationNode();
  const execute = executor();
  let calls = 0;
  const invokeMember = async request => {
    calls++;
    await execute(request, "write", { path: "work/writer/正文.md", content: "completed once" });
    await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
    await execute(request, "rp_node_complete", {});
    return { terminated: true, usage: usage() };
  };
  const first = await runtime({ workspace, node, runId: "completed-run", invokeMember }).run();
  const second = await runtime({
    workspace,
    node,
    runId: "completed-run",
    invokeMember: async () => { throw new Error("completed run must not invoke a member"); },
  }).run();

  assert.equal(first.output, "completed once");
  assert.equal(second.output, "completed once");
  assert.equal(calls, 1);
  assert.equal(second.state.status, "completed");
});

test("pending file recovery preserves the current stage instead of restarting the plan", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-recovery");
  const node = collaborationNode();
  const taskPrompt = "共同任务\n<!-- stage -->\nfirst stage\n<!-- stage -->\nsecond stage";
  const plan = parseTaskStages(taskPrompt);
  const config = normalizeCollaborationTeam(node.team);
  const store = new CollaborationStateStore(workspace);
  const state = await store.load(config, { runId: "recovery-run", nodeId: node.id }, plan);
  const seededStages = createTaskStageController(plan);
  await seededStages.advance("seed-stage");
  state.stageState = seededStages.snapshot();
  state.pendingOperation = {
    kind: "file",
    id: "recover-file",
    memberId: "writer",
    path: "work/writer/recovered.md",
    content: "recovered content",
    beforeHash: null,
  };
  await store.save();

  const execute = executor();
  const requests = [];
  const invokeMember = async request => {
    requests.push(request);
    if (requests.length === 1) {
      assert.match(request.prompt, /second stage/);
      assert.equal(await readFile(join(workspace, "work", "writer", "recovered.md"), "utf8"), "recovered content");
      await execute(request, "rp_task_next", {});
    } else {
      await execute(request, "write", { path: "work/writer/正文.md", content: "recovered final" });
      await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
      await execute(request, "rp_node_complete", {});
    }
    return { terminated: true, usage: usage() };
  };

  const result = await runtime({ workspace, node, runId: "recovery-run", taskPrompt, invokeMember }).run();
  assert.equal(result.output, "recovered final");
  assert.equal(requests.length, 2);
  assert.equal(result.state.stageState.currentIndex, 1);
  assert.equal(result.state.stageState.exhausted, true);
});

test("a linked formal output path is rejected before a member can write outside the workspace", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-collaboration-output-link");
  const outside = await mkdtemp(resolve(tmpdir(), "pi-rp-team-collaboration-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(workspace, "narrative.md"), process.platform === "win32" ? "junction" : "dir");
  const node = collaborationNode();
  let invoked = false;
  const invokeMember = async () => {
    invoked = true;
    return { terminated: true, usage: usage() };
  };

  await assert.rejects(runtime({ workspace, node, invokeMember }).run(), error => error?.code === "delivery_path_invalid" && /Symbolic links and junctions are not allowed/.test(error.message));
  assert.equal(invoked, false);
});

test("required calls reject completion when missing and when the workflow fails", async t => {
  {
    const workspace = await workspaceFor(t, "pi-rp-team-collaboration-required-missing");
    const node = collaborationNode({ requiredCalls: ["test/required"] });
    const execute = executor();
    const invokeMember = async request => {
      await execute(request, "write", { path: "work/writer/正文.md", content: "missing call" });
      await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/正文.md" });
      await execute(request, "rp_node_complete", {});
      return { terminated: true, usage: usage() };
    };
    await assert.rejects(runtime({ workspace, node, invokeMember }).run(), error => error?.code === "required_call_missing");
  }

  {
    const workspace = await workspaceFor(t, "pi-rp-team-collaboration-required-failed");
    const node = collaborationNode({ workflowCalls: [{ target: "test/required" }], requiredCalls: ["test/required"] });
    const execute = executor();
    const invokeMember = async request => {
      if (request.memberId === "writer") {
        await execute(request, "rp_team_handoff", {});
        return { terminated: true, usage: usage() };
      }
      await execute(request, "rp_call", { workflow: "test/required", text: "required query", outputPaths: {} });
      return { terminated: true, usage: usage() };
    };
    const invokeWorkflow = async () => { throw new Error("required workflow failed"); };
    await assert.rejects(runtime({ workspace, node, invokeMember, invokeWorkflow }).run(), /required workflow failed/);
    const state = JSON.parse(await readFile(join(workspace, "team", "state.json"), "utf8"));
    assert.deepEqual(state.calledTargets, []);
  }
});

test("cancelled activations reject delayed speech and tools without modifying files", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-cancel");
  let cancelled = false, stale;
  const instance = new TeamCollaborationRuntime({ workspace, node: collaborationNode(), runId: "cancel", taskPrompt: "task", isCancelled: () => cancelled, invokeMember: async request => {
    stale = request;
    cancelled = true;
    await request.collaboration.publish("late speech");
    return { terminated: true };
  } });
  await assert.rejects(instance.run(), /cancelled/);
  await assert.rejects(tool(stale, "write").execute("late", { path: "work/writer/late.md", content: "late" }), /cancelled/);
  const state = JSON.parse(await readFile(join(workspace, "team/state.json"), "utf8"));
  assert.equal(state.status, "cancelled");
  assert.equal(state.events.some(event => event.text === "late speech"), false);
  await assert.rejects(readFile(join(workspace, "work/writer/late.md")), { code: "ENOENT" });
});

test("an external edit after an interrupted write requires recovery and is preserved", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-file-conflict");
  const node = collaborationNode(), store = new CollaborationStateStore(workspace);
  const state = await store.load(normalizeCollaborationTeam(node.team), { runId: "conflict", nodeId: node.id }, parseTaskStages("task"));
  state.pendingOperation = { kind: "file", id: "interrupted", memberId: "writer", path: "work/writer/draft.md", content: "model version", beforeHash: null };
  await store.save();
  await mkdir(join(workspace, "work/writer"), { recursive: true });
  await writeFile(join(workspace, "work/writer/draft.md"), "human version");
  let invoked = false;
  await assert.rejects(runtime({ workspace, node, runId: "conflict", taskPrompt: "task", invokeMember: async () => { invoked = true; } }).run(), error => error.code === "workflow_recovery_required");
  assert.equal(invoked, false);
  assert.equal(await readFile(join(workspace, "work/writer/draft.md"), "utf8"), "human version");
});

test("pending workflow reconnects with its original operation ID before resuming the frozen stage", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-workflow-recovery");
  const node = collaborationNode({ workflowCalls: [{ target: "test/memory", maxCalls: 1 }], requiredCalls: ["test/memory"] });
  const store = new CollaborationStateStore(workspace), plan = parseTaskStages("common\n<!-- stage -->\nfirst\n<!-- stage -->\nsecond");
  const state = await store.load(normalizeCollaborationTeam(node.team), { runId: "pending", nodeId: node.id }, plan);
  const stages = createTaskStageController(plan); await stages.advance("previous"); state.stageState = stages.snapshot();
  state.pendingOperation = { kind: "workflow", id: "original-operation", memberId: "co-creator", request: { workflow: "test/memory", text: "frozen request", outputPaths: {} } };
  state.events.push({ seq: 1, type: "workflow-started", memberId: "co-creator", detail: { workflow: "test/memory" } });
  await store.save();
  let calls = 0;
  const execute = executor();
  const result = await runtime({ workspace, node, runId: "pending", taskPrompt: "changed task ignored", invokeWorkflow: async (request, options) => {
    calls++; assert.equal(options.operationId, "original-operation"); assert.equal(request.text, "frozen request"); return { outputs: {} };
  }, invokeMember: async request => {
    assert.match(request.prompt, /second/);
    assert.doesNotMatch(request.prompt, /changed task ignored/);
    assert.match(request.prompt, /workflow-returned/);
    await execute(request, "write", { path: "work/writer/draft.md", content: "recovered" });
    await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/draft.md" });
    await execute(request, "rp_task_next", {});
    await execute(request, "rp_node_complete", {});
    return { terminated: true, usage: usage() };
  } }).run();
  assert.equal(calls, 1);
  assert.equal(result.state.operations["original-operation"].outputs instanceof Object, true);
  assert.equal(result.output, "recovered");
});

test("workflow call limits apply across authorized members and forbid returned-document writes", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-shared-call-limit");
  const config = teamConfig(); config.members[0].tools.push("rp_call");
  const node = collaborationNode({ team: config, workflowCalls: [{ target: "test/memory", maxCalls: 1 }] });
  const execute = executor(); let calls = 0, activation = 0;
  const result = await runtime({ workspace, node, invokeWorkflow: async () => {
    calls++; await mkdir(join(workspace, "work/writer/call"), { recursive: true }); await writeFile(join(workspace, "work/writer/call/result.md"), "returned");
    return { outputs: { result: "work/writer/call/result.md" } };
  }, invokeMember: async request => {
    activation++;
    if (activation === 1) {
      await execute(request, "rp_call", { workflow: "test/memory", outputPaths: { result: "work/writer/call/result.md" } });
      await assert.rejects(execute(request, "write", { path: "work/writer/call/result.md", content: "overwrite" }), /read-only/);
      await execute(request, "rp_team_handoff", {});
    } else if (activation === 2) {
      await assert.rejects(execute(request, "rp_call", { workflow: "test/memory", outputPaths: {} }), /limit exceeded/);
      await execute(request, "rp_team_handoff", {});
    } else {
      await execute(request, "write", { path: "work/writer/draft.md", content: "done" });
      await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/draft.md" });
      await execute(request, "rp_node_complete", {});
    }
    return { terminated: true, usage: usage() };
  } }).run();
  assert.equal(calls, 1);
  assert.equal(result.output, "done");
});

test("frozen common context, role prompt and current floor survive a failed member retry", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-frozen-retry");
  const node = collaborationNode(), firstPrompt = [{ role: "user", content: "frozen role" }];
  const first = runtime({ workspace, node, invokeMember: async request => {
    assert.deepEqual(await request.collaboration.freezeAgentPrompt(firstPrompt), firstPrompt);
    await request.collaboration.publish("accepted speech");
    throw new Error("temporary provider failure");
  } });
  await assert.rejects(first.run(), /temporary provider failure/);
  node.team.initialMemberId = "co-creator";
  const execute = executor();
  const second = runtime({ workspace, node, taskPrompt: "new task", invokeMember: async request => {
    assert.equal(request.memberId, "writer");
    assert.match(request.prompt, /shared context/);
    assert.match(request.prompt, /accepted speech/);
    assert.doesNotMatch(request.prompt, /new context|new task/);
    assert.deepEqual(await request.collaboration.freezeAgentPrompt([{ role: "user", content: "changed role" }]), firstPrompt);
    await execute(request, "write", { path: "work/writer/draft.md", content: "done" });
    await execute(request, "rp_deliver", { output: "narrative", path: "work/writer/draft.md" });
    await execute(request, "rp_node_complete", {});
    return { terminated: true, usage: usage() };
  } });
  second.context = "new context";
  const result = await second.run();
  assert.equal(result.state.activation, 2);
  assert.equal(result.output, "done");
});

test("malformed model request loops have a persisted resource budget", async t => {
  const workspace = await workspaceFor(t, "pi-rp-team-dispatch-budget");
  const node = collaborationNode({ team: teamConfig({ limits: { maxActivations: 1, maxToolCalls: 1, maxProtocolReminders: 1 } }) });
  const instance = runtime({ workspace, node, invokeMember: async request => {
    for (let call = 0; call < 4; call++) await request.collaboration.beforeModel();
    return { terminated: true };
  } });
  await assert.rejects(instance.run(), /model request budget exhausted/);
  assert.equal(instance.state.modelDispatches, 3);
});
