import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { normalizeTeamDefinition, teamAbilityCatalog, validateTeamBudgets } from "./rp-team-config.mjs";
import { AssistanceTaskManager } from "./rp-assistance-tasks.mjs";
import { runTeamMeeting } from "./rp-team-runtime.mjs";
import { initialTeamState, reserveTeamBudget, consumeTeamBudget, TeamStateStore } from "./rp-team-state.mjs";

function config({ experts = 0, assistants = 0, references = false } = {}) {
  return {
    schemaVersion: 1,
    leader: { id: "leader", agentId: "deep-leader" },
    secretary: { id: "secretary", agentId: "deep-secretary" },
    experts: Array.from({ length: experts }, (_, index) => ({ id: `expert-${index + 1}`, agentId: "deep-expert", focus: `focus ${index + 1}` })),
    baseRetrieval: {
      id: "base-memory",
      kind: "workflow",
      target: "narrative-memory/narrative-memory-retrieve",
      budgetPool: "base-assistance",
      fixedArguments: { budget: { informationLimit: 40 } },
      exports: ["memory-context"],
      publicDescription: { title: "Base memory" },
    },
    assistants: Array.from({ length: assistants }, (_, index) => ({
      id: `helper-${index + 1}`,
      kind: "workflow",
      target: "narrative-memory/narrative-memory-retrieve",
      budgetPool: "supplemental-assistance",
      exports: ["memory-context"],
      publicDescription: { title: `Helper ${index + 1}`, purpose: "Lookup facts", requestExample: "Check one fact." },
    })),
    agenda: { normalRounds: 1, maxRounds: 2 },
    budgets: {
      preparation: 20,
      "base-assistance": 3,
      discussion: 20,
      "supplemental-assistance": 10,
      coordination: 10,
      closing: 20,
      draft: 3,
      review: 20,
      revision: 3,
      references: 3,
    },
    metadata: { references },
  };
}

test("normalizes dynamic members, public ability descriptions, and independent pools", () => {
  const team = normalizeTeamDefinition(config({ experts: 2, assistants: 2 }));
  assert.equal(team.experts.length, 2);
  assert.equal(team.assistants.length, 2);
  assert.equal(teamAbilityCatalog(team).length, 2);
  assert.equal(teamAbilityCatalog(team)[0].target, undefined);
  assert.notEqual(team.budgets.draft, team.budgets.discussion);
  assert.equal(validateTeamBudgets(team), true);
});

test("rejects duplicate member and ability identities", () => {
  const duplicateMember = config();
  duplicateMember.secretary.id = "leader";
  assert.throws(() => normalizeTeamDefinition(duplicateMember), /member IDs must be unique/);
  const duplicateAbility = config({ assistants: 1 });
  duplicateAbility.assistants[0].id = "base-memory";
  assert.throws(() => normalizeTeamDefinition(duplicateAbility), /ability IDs must be unique/);
  const unknownAdapter = config({ assistants: 1 });
  unknownAdapter.assistants[0].inputAdapter = "imaginary-v1";
  assert.throws(() => normalizeTeamDefinition(unknownAdapter), /inputAdapter is unsupported/);
});

test("budget reservations are idempotent and cannot cross pools", () => {
  const team = normalizeTeamDefinition(config());
  const state = initialTeamState(team);
  reserveTeamBudget(state, "draft", "draft-1");
  reserveTeamBudget(state, "draft", "draft-1");
  consumeTeamBudget(state, "draft-1", { input: 2, output: 3, total: 5 });
  consumeTeamBudget(state, "draft-1");
  assert.equal(state.budgets.draft.used, 1);
  assert.equal(state.usage.calls, 1);
  assert.equal(state.usage.totalTokens, 5);
});

test("assistance tasks deduplicate stable requests and reject changed reuse", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-task-"));
  try {
    const team = normalizeTeamDefinition(config({ assistants: 1 }));
    const store = new TeamStateStore(directory);
    const state = await store.ensure(team);
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: team.assistants,
      startWorkflow: async request => ({ outputs: request.outputPaths }),
      invokeAgent: async () => ({}),
      invokeTool: async () => ({}),
    });
    const first = await manager.start({ abilityId: "helper-1", requestId: "same", text: "question" });
    const replay = await manager.start({ abilityId: "helper-1", requestId: "same", text: "question" });
    assert.equal(replay.taskId, first.taskId);
    assert.equal((await manager.wait([first.taskId]))[0].status, "succeeded");
    await assert.rejects(manager.start({ abilityId: "helper-1", requestId: "same", text: "changed" }), /different input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory assistance adapts natural language and records returned usage", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-adapter-"));
  try {
    const raw = config();
    raw.baseRetrieval.inputAdapter = "memory-request-v1";
    const normalized = normalizeTeamDefinition(raw);
    const ability = normalized.baseRetrieval;
    const store = new TeamStateStore(directory);
    const state = await store.ensure(normalized);
    let received = null;
    let usage = null;
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: [ability],
      startWorkflow: async request => {
        received = request;
        return { outputs: request.outputPaths, usage: { input: 7, output: 3, totalTokens: 10 } };
      },
      invokeAgent: async () => ({}),
      invokeTool: async () => ({}),
      onUsage: value => { usage = value; },
    });
    const started = await manager.start({ abilityId: ability.id, requestId: "memory-one", text: "Find the prior oath." });
    assert.equal((await manager.wait([started.taskId]))[0].status, "succeeded");
    assert.equal(received.arguments.query, "Find the prior oath.");
    assert.equal(received.arguments.requestId, "memory-one");
    assert.equal(usage.totalTokens, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a late tool-assistant result is cancelled instead of delivered", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-tool-cancel-"));
  let cancelled = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const raw = config();
    raw.assistants = [{ id: "tool", kind: "tool", adapter: "declared-document-read-v1", publicDescription: { title: "tool" } }];
    const normalized = normalizeTeamDefinition(raw);
    const store = new TeamStateStore(directory);
    const state = await store.ensure(normalized);
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: normalized.assistants,
      startWorkflow: async () => ({}),
      invokeAgent: async () => ({}),
      invokeTool: async () => { await gate; return { output: "late" }; },
      isCancelled: () => cancelled,
    });
    const started = await manager.start({ abilityId: "tool", requestId: "tool-one", text: "read" });
    await new Promise(resolve => setImmediate(resolve));
    cancelled = true;
    release();
    const [task] = await manager.wait([started.taskId]);
    assert.equal(task.status, "cancelled");
    const deliveries = await readFile(resolve(directory, "shared", "DELIVERIES.json"), "utf8").then(JSON.parse).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    assert.deepEqual(deliveries, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const combination of [
  { experts: 0, assistants: 0 },
  { experts: 0, assistants: 1 },
  { experts: 2, assistants: 0 },
  { experts: 2, assistants: 1 },
]) {
  test(`runs a complete fixed-agenda meeting with ${combination.experts} experts and ${combination.assistants} assistants`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-meeting-"));
    const calls = [];
    try {
      const result = await runTeamMeeting({
        config: config(combination),
        workspace: directory,
        runId: "run",
        nodeId: "team",
        context: "World and story materials.",
        startWorkflow: async request => ({ outputs: request.outputPaths, answer: "retrieved memory" }),
        invokeMember: async request => {
          calls.push(request.executionId);
          if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }), usage: { total: 1 } };
          if (request.executionId === "secretary-draft" || request.executionId === "secretary-revision") {
            return { content: JSON.stringify({ report: { summary: "plan", content: "details" }, referenceUpdates: [] }), usage: { total: 1 } };
          }
          if (request.executionId.startsWith("discussion-") && request.executionId.endsWith("-leader")) return { content: "Round synthesis", control: { action: "close" }, usage: { total: 1 } };
          return { content: `${request.member.id} ${request.phase}`, usage: { total: 1 } };
        },
      });
      assert.equal(result.report, "deliverables/report.json");
      assert.equal(JSON.parse(await readFile(resolve(directory, result.report), "utf8")).summary, "plan");
      assert.deepEqual(JSON.parse(await readFile(resolve(directory, result.references), "utf8")), []);
      const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
      assert.equal(state.status, "completed");
      assert.equal(state.phase, "ready");
      assert.ok(calls.includes("closing-leader"));
      assert.ok(calls.includes("review-leader"));
      assert.equal(calls.filter(id => id === "secretary-draft").length, 1);
      assert.equal(calls.filter(id => id === "secretary-revision").length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("completed meetings resume without invoking members again", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-resume-"));
  let calls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      calls += 1;
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "done" }, referenceUpdates: [] }) };
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await runTeamMeeting(options);
    const before = calls;
    await runTeamMeeting(options);
    assert.equal(calls, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted assistance task requires one explicit recovery retry and then resumes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-recovery-"));
  const team = normalizeTeamDefinition(config());
  const store = new TeamStateStore(resolve(directory, "team"));
  const state = await store.ensure(team, { runId: "run", nodeId: "team" });
  state.tasks ||= {};
  state.tasks.interrupted = { taskId: "interrupted", abilityId: "base-memory", status: "running", createdAt: new Date().toISOString() };
  await store.save(state);
  const options = {
    config: team, workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "recovered" }, referenceUpdates: [] }) };
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), error => error?.code === "workflow_recovery_required");
    const result = await runTeamMeeting(options);
    assert.equal(JSON.parse(await readFile(resolve(directory, result.report), "utf8")).summary, "recovered");
    const recovered = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(recovered.tasks.interrupted.status, "succeeded");
    assert.equal(recovered.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected structured Secretary output retries only that execution from the retry pool", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-structured-retry-"));
  let revisionCalls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (request.executionId === "secretary-draft") return { content: JSON.stringify({ report: { summary: "draft" }, referenceUpdates: [] }) };
      if (request.executionId === "secretary-revision") {
        revisionCalls += 1;
        return { content: revisionCalls === 1 ? "not-json" : JSON.stringify({ report: { summary: "fixed" }, referenceUpdates: [] }) };
      }
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), /valid JSON/);
    const result = await runTeamMeeting(options);
    assert.equal(JSON.parse(await readFile(resolve(directory, result.report), "utf8")).summary, "fixed");
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(revisionCalls, 2);
    assert.equal(state.budgets.retries.used, 1);
    assert.equal(state.executionFailures["secretary-revision"], 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed discussion member resumes the same round without skipping later members", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-round-resume-"));
  const calls = [];
  let fail = true;
  const options = {
    config: config({ experts: 1 }), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      calls.push(request.executionId);
      if (request.executionId === "discussion-1-expert-1" && fail) {
        fail = false;
        throw new Error("temporary member failure");
      }
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "done" }, referenceUpdates: [] }) };
      if (request.executionId === "discussion-1-leader") return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), /temporary member failure/);
    await runTeamMeeting(options);
    assert.equal(calls.filter(id => id === "discussion-1-expert-1").length, 2);
    assert.equal(calls.filter(id => id === "discussion-1-leader").length, 1);
    assert.equal(calls.some(id => id.startsWith("discussion-2-")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("slow Secretary coordination keeps immutable non-overlapping speech ranges", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-coordination-range-"));
  const coordination = [];
  const helperCalls = [];
  try {
    await runTeamMeeting({
      config: { ...config({ assistants: 1 }), agenda: { normalRounds: 1, maxRounds: 4 } },
      workspace: directory, runId: "run", nodeId: "team", context: "context",
      startWorkflow: async request => { helperCalls.push(request.text); return { outputs: request.outputPaths }; },
      invokeMember: async request => {
        if (request.executionId.startsWith("coordination-")) {
          coordination.push(request.executionId);
          if (coordination.length === 1) await new Promise(resolve => setTimeout(resolve, 80));
          return { content: JSON.stringify({ requests: [{ requestId: request.executionId, abilityId: "helper-1", text: request.executionId, disposition: "dispatch" }] }) };
        }
        if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "done" }, referenceUpdates: [] }) };
        if (request.executionId.startsWith("discussion-") && request.executionId.endsWith("leader")) return { content: "round", control: { action: request.round < 4 ? "continue" : "close" } };
        return { content: "ok" };
      },
    });
    assert.equal(coordination.length, 4, JSON.stringify(coordination));
    assert.equal(new Set(coordination).size, 4);
    assert.equal(helperCalls.filter(text => text.startsWith("coordination-")).length, 4);
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    const ranges = Object.values(state.coordinationBatches).sort((left, right) => left.startSpeechSeq - right.startSpeechSeq);
    assert.ok(ranges.every((item, index) => index === 0 || item.startSpeechSeq === ranges[index - 1].speechCutoff + 1));
    assert.ok(ranges.every(item => item.status === "completed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required base retrieval retries the same logical task after a known failure", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-base-retry-"));
  let retrievalCalls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => {
      retrievalCalls += 1;
      if (retrievalCalls === 1) throw new Error("temporary retrieval failure");
      return { outputs: request.outputPaths };
    },
    invokeMember: async request => {
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "done" }, referenceUpdates: [] }) };
      if (request.executionId.startsWith("discussion-") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "unchanged request bytes" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), /Required base retrieval failed/);
    await runTeamMeeting(options);
    assert.equal(retrievalCalls, 2);
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    const task = Object.values(state.tasks).find(item => item.requestId === "base-retrieval");
    assert.equal(task.status, "succeeded");
    assert.equal(task.attempt, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state recovery restores the valid previous snapshot after an interrupted replacement", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-state-backup-"));
  try {
    const team = normalizeTeamDefinition(config());
    const store = new TeamStateStore(resolve(directory, "team"));
    const state = await store.ensure(team);
    state.phase = "revision";
    state.round = 3;
    await store.save(state);
    await rename(store.statePath, `${store.statePath}.previous`);
    const recovered = await new TeamStateStore(resolve(directory, "team")).ensure(team);
    assert.equal(recovered.phase, "revision");
    assert.equal(recovered.round, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state recovery can rebuild from the durable event journal", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-state-journal-"));
  try {
    const team = normalizeTeamDefinition(config());
    const store = new TeamStateStore(resolve(directory, "team"));
    const state = await store.ensure(team);
    state.phase = "closing";
    state.round = 4;
    await store.event(state, "checkpoint", { reason: "fault injection" });
    await writeFile(store.statePath, "{broken", "utf8");
    await writeFile(`${store.statePath}.previous`, "{also-broken", "utf8");
    const recovered = await new TeamStateStore(resolve(directory, "team")).ensure(team);
    assert.equal(recovered.phase, "closing");
    assert.equal(recovered.round, 4);
    assert.equal(recovered.eventSeq, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
