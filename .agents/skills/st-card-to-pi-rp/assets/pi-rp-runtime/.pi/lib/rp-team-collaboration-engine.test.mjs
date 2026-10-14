import assert from "node:assert/strict";
import test from "node:test";

import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";

const childWorkflow = {
  schemaVersion: 4,
  ownerModuleId: "test",
  id: "test/collaboration-child",
  kind: "module-external",
  agentCallable: true,
  instancePolicy: { mode: "multiple", maxConcurrentInstances: 8, reuseCompleted: false },
  interface: {
    inputs: { operationId: { type: "parameter", valueType: "string", required: true } },
    exports: { report: { kind: "file", format: "markdown" } },
  },
  nodes: [
    {
      id: "work",
      type: "agent",
      agentId: "test/child-agent",
      modelId: "shared-model",
      outputs: { report: { path: "report.md", format: "markdown" } },
    },
    {
      id: "return",
      type: "workflow-return",
      dependsOn: ["work"],
      exports: { report: { fromNode: "work", output: "report" } },
    },
  ],
};

function collaborationTeam({ writerAgentId = "test/writer-agent", reviewerAgentId = "test/reviewer-agent", writerTools = ["read", "write", "rp_call"], reviewerTools = ["read", "write", "rp_call"] } = {}) {
  return {
    schemaVersion: 2,
    protocol: "collaboration",
    members: [
      { id: "writer", label: "Writer", agentId: writerAgentId, modelId: "shared-model", tools: writerTools },
      { id: "reviewer", label: "Reviewer", agentId: reviewerAgentId, modelId: "shared-model", tools: reviewerTools },
    ],
    initialMemberId: "writer",
    stageOwnerId: "writer",
    completionMemberId: "reviewer",
    outputOwners: {},
    limits: { maxActivations: 16, maxToolCalls: 32, maxProtocolReminders: 2 },
  };
}

function teamNode(id, team = collaborationTeam()) {
  return { id, type: "team", team, workflowCalls: [childWorkflow.id] };
}

function parentWorkflow(id, nodes) {
  return { schemaVersion: 4, ownerModuleId: "test", id: `test/${id}`, kind: "global-background", nodes };
}

function resolveAgent(id) {
  return { id, ownerModuleId: "test", defaultModelId: "shared-model", prompt: `prompt:${id}`, tools: ["read", "write", "rp_call"] };
}

function resolveModel(id) {
  return id === "shared-model" ? { id, maxConcurrency: 1, provider: "offline" } : { id, maxConcurrency: 4, provider: "offline" };
}

function childExecutor(task, childRuns) {
  if (task.workflow.id === childWorkflow.id && task.node.id === "work") {
    childRuns.push(task.run.id);
    return { output: "offline child result" };
  }
  if (task.workflow.id === childWorkflow.id && task.node.type === "workflow-return") {
    return { output: { outputs: { report: task.run.outputPaths.report } } };
  }
  return { output: null };
}

test("collaboration preflight rejects an Agent missing declared tools before executor", async () => {
  let executorCalls = 0;
  const workflow = parentWorkflow("collaboration-preflight-tools", [
    teamNode("collab", collaborationTeam({ writerTools: ["read", "write", "rp_call"] })),
  ]);
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => id === "test/writer-agent"
      ? { id, tools: ["read"] }
      : resolveAgent(id),
    resolveModel,
    executor: async () => {
      executorCalls += 1;
      return { output: null };
    },
  });

  const started = await engine.start(workflow, { id: "collaboration-preflight-tools-run" });
  const completed = await engine.wait(started.id);

  assert.equal(completed.status, "failed");
  assert.equal(executorCalls, 0);
  assert.equal(completed.nodes.collab.status, "failed");
  assert.match(completed.nodes.collab.error, /lacks declared tools/);
  assert.match(completed.nodes.collab.error, /write/);
  assert.match(completed.nodes.collab.error, /rp_call/);
});

test("a collaboration member invokes a nested workflow without deadlocking its shared model slot", async () => {
  const childRuns = [];
  let memberRequest = null;
  const workflow = parentWorkflow("collaboration-nested-call", [teamNode("collab")]);
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => resolveAgent(id),
    resolveModel,
    resolveWorkflow: reference => reference === childWorkflow.id ? childWorkflow : null,
    executor: async task => {
      if (task.node.type === "team") {
        const member = task.node.team.members[0];
        return {
          output: await task.invokeAgent({
            executionId: "writer-step",
            memberId: member.id,
            agentId: member.agentId,
            modelId: member.modelId,
            member,
            collaboration: {},
            freezeKey: `${task.node.id}:member:${member.id}`,
          }),
        };
      }
      if (task.teamMember) {
        memberRequest = task.teamMember;
        assert.equal(task.agent.ownerModuleId, "test", "frozen member retains ownership for promptFile loading");
        assert.deepEqual(task.teamMember.collaboration, {});
        assert.deepEqual(task.teamMember.member.tools, ["read", "write", "rp_call"]);
        assert.equal(task.teamMember.freezeKey, "collab:member:writer");
        const nested = await task.invokeWorkflow({
          workflow: childWorkflow.id,
          arguments: { operationId: "nested-1" },
          outputPaths: { report: "reports/nested-1.md" },
        }, { operationId: "nested-1" });
        return { output: nested };
      }
      return childExecutor(task, childRuns);
    },
  });

  const started = await engine.start(workflow, { id: "collaboration-nested-call-run" });
  const completed = await Promise.race([
    engine.wait(started.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("collaboration nested call deadlocked")), 1000)),
  ]);

  assert.equal(completed.status, "completed", completed.nodes.collab.error);
  assert.equal(childRuns.length, 1);
  assert.equal(memberRequest.freezeKey, "collab:member:writer");
});

test("team member operation IDs replay the same child while a distinct ID starts another child", async () => {
  const childRuns = [];
  const callIds = [];
  const workflow = parentWorkflow("collaboration-operation-replay", [teamNode("collab")]);
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => resolveAgent(id),
    resolveModel,
    resolveWorkflow: reference => reference === childWorkflow.id ? childWorkflow : null,
    executor: async task => {
      if (task.node.type === "team") {
        const member = task.node.team.members[0];
        return {
          output: await task.invokeAgent({
            executionId: "writer-replay",
            memberId: member.id,
            agentId: member.agentId,
            modelId: member.modelId,
            member,
            collaboration: {},
            freezeKey: `${task.node.id}:member:${member.id}`,
          }),
        };
      }
      if (task.teamMember) {
        const request = operationId => ({
          workflow: childWorkflow.id,
          arguments: { operationId },
          outputPaths: { report: `reports/${operationId}.md` },
        });
        const first = await task.invokeWorkflow(request("same"), { operationId: "same" });
        const replay = await task.invokeWorkflow(request("same"), { operationId: "same" });
        const second = await task.invokeWorkflow(request("different"), { operationId: "different" });
        callIds.push(first.callId, replay.callId, second.callId);
        return { output: { first, replay, second } };
      }
      return childExecutor(task, childRuns);
    },
  });

  const started = await engine.start(workflow, { id: "collaboration-operation-replay-run" });
  const completed = await Promise.race([
    engine.wait(started.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("operation replay deadlocked")), 1000)),
  ]);

  assert.equal(completed.status, "completed", completed.nodes.collab.error);
  assert.equal(callIds[0], callIds[1]);
  assert.notEqual(callIds[1], callIds[2]);
  assert.equal(childRuns.length, 2);
  assert.equal(engine.snapshot().filter(run => run.workflowId === childWorkflow.id).length, 2);
});

test("changed replay output paths are rejected for a collaboration operation", async () => {
  const childRuns = [];
  let recoveryCode = null;
  const workflow = parentWorkflow("collaboration-operation-output-recovery", [teamNode("collab")]);
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => resolveAgent(id),
    resolveModel,
    resolveWorkflow: reference => reference === childWorkflow.id ? childWorkflow : null,
    executor: async task => {
      if (task.node.type === "team") {
        const member = task.node.team.members[0];
        return {
          output: await task.invokeAgent({
            executionId: "writer-output-recovery",
            memberId: member.id,
            agentId: member.agentId,
            modelId: member.modelId,
            member,
            collaboration: {},
            freezeKey: `${task.node.id}:member:${member.id}`,
          }),
        };
      }
      if (task.teamMember) {
        await task.invokeWorkflow({
          workflow: childWorkflow.id,
          arguments: { operationId: "output-recovery" },
          outputPaths: { report: "reports/original.md" },
        }, { operationId: "output-recovery" });
        try {
          await task.invokeWorkflow({
            workflow: childWorkflow.id,
            arguments: { operationId: "output-recovery" },
            outputPaths: { report: "reports/changed.md" },
          }, { operationId: "output-recovery" });
        } catch (error) {
          recoveryCode = error.code;
        }
        return { output: "recovered" };
      }
      return childExecutor(task, childRuns);
    },
  });

  const started = await engine.start(workflow, { id: "collaboration-operation-output-recovery-run" });
  const completed = await Promise.race([
    engine.wait(started.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("output replay recovery deadlocked")), 1000)),
  ]);

  assert.equal(completed.status, "completed", completed.nodes.collab.error);
  assert.equal(recoveryCode, "workflow_recovery_required");
  assert.equal(childRuns.length, 1);
});

test("two collaboration nodes namespace frozen bindings even when member IDs repeat", async () => {
  const workflow = parentWorkflow("collaboration-namespaced-bindings", [
    teamNode("alpha", collaborationTeam({ writerAgentId: "test/writer-alpha", reviewerAgentId: "test/reviewer-alpha" })),
    teamNode("beta", collaborationTeam({ writerAgentId: "test/writer-beta", reviewerAgentId: "test/reviewer-beta" })),
  ]);
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => resolveAgent(id),
    resolveModel: async id => id === "shared-model" ? { id, maxConcurrency: 4, provider: "offline" } : null,
    executor: async task => {
      if (task.node.type === "team") {
        const member = task.node.team.members[0];
        await task.invokeAgent({
          executionId: `${task.node.id}-writer`,
          memberId: member.id,
          agentId: member.agentId,
          modelId: member.modelId,
          member,
          collaboration: {},
          freezeKey: `${task.node.id}:member:${member.id}`,
        });
      }
      return { output: null };
    },
  });

  const started = await engine.start(workflow, { id: "collaboration-namespaced-bindings-run" });
  const completed = await engine.wait(started.id);

  assert.equal(completed.status, "completed");
  assert.ok(completed.teamPreflights.alpha.bindings["alpha:member:writer"]);
  assert.ok(completed.teamPreflights.beta.bindings["beta:member:writer"]);
  assert.equal(completed.teamPreflights.alpha.bindings["alpha:member:writer"].agentId, "test/writer-alpha");
  assert.equal(completed.teamPreflights.beta.bindings["beta:member:writer"].agentId, "test/writer-beta");
  assert.equal(completed.teamPreflights.alpha.bindings["member:writer"], undefined);
  assert.equal(completed.teamPreflights.beta.bindings["member:writer"], undefined);
});
