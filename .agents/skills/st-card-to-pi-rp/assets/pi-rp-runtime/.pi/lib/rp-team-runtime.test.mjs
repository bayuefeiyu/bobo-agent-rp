import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { normalizeTeamDefinition, teamAbilityCatalog, validateTeamBudgets } from "./rp-team-config.mjs";
import { AssistanceTaskManager } from "./rp-assistance-tasks.mjs";
import { readAuthorizedTeamMaterial } from "./rp-team-access.mjs";
import { runTeamMeeting } from "./rp-team-runtime.mjs";
import { initialTeamState, reserveTeamBudget, consumeTeamBudget, recordTeamUsage, TeamStateStore } from "./rp-team-state.mjs";
import { normalizeWorkflowCallRequest, normalizeWorkflowDefinition } from "./rp-workflows.mjs";

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

test("assistance success is published only after its delivery evidence is durable", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-publish-"));
  let releaseRegistration;
  let registrationEntered;
  const registrationGate = new Promise(resolve => { releaseRegistration = resolve; });
  const entered = new Promise(resolve => { registrationEntered = resolve; });
  try {
    const team = normalizeTeamDefinition(config());
    const store = new TeamStateStore(directory);
    const state = await store.ensure(team);
    const registerDeliveries = store.registerDeliveries.bind(store);
    store.registerDeliveries = async entries => {
      registrationEntered();
      await registrationGate;
      return registerDeliveries(entries);
    };
    const ability = {
      id: "tool-helper",
      enabled: true,
      kind: "tool",
      adapter: "test-tool",
      inputAdapter: "natural-language-v1",
      fixedArguments: {},
      documents: {},
      exports: [],
      timeoutMs: 10_000,
    };
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: [ability],
      startWorkflow: async () => ({}),
      invokeAgent: async () => ({}),
      invokeTool: async () => ({ output: "evidence" }),
    });
    const { taskId } = await manager.start({ abilityId: ability.id, requestId: "publish-once", text: "question" });
    await entered;

    let waitSettled = false;
    const waiting = manager.wait([taskId]).then(tasks => {
      waitSettled = true;
      return tasks;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waitSettled, false);
    assert.equal(manager.get(taskId).status, "publishing");
    assert.deepEqual(await store.registerDeliverySnapshot("before-publication", [taskId]), []);

    releaseRegistration();
    const [task] = await waiting;
    assert.equal(task.status, "succeeded");
    assert.equal(task.publication.status, "confirmed");
    assert.equal(Number.isInteger(task.publication.confirmationEventSeq), true);
    const snapshot = await store.registerDeliverySnapshot("after-publication", [taskId]);
    assert.deepEqual(snapshot, [{ path: `tasks/${taskId}/report.json`, kind: "file", taskId }]);
    assert.deepEqual(JSON.parse(await store.readArtifact(task.publication.report.relativePath, task.publication.report.hash)), { output: "evidence" });
    assert.equal((await store.read()).tasks[taskId].status, "succeeded");
  } finally {
    releaseRegistration?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent delivery writers preserve every immutable task manifest", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-delivery-union-"));
  try {
    const firstStore = new TeamStateStore(directory);
    const secondStore = new TeamStateStore(directory);
    await firstStore.registerDeliveries([{ path: "tasks/old/report.json", kind: "file", taskId: "old" }]);
    const results = await Promise.all([
      firstStore.registerDeliveries([{ path: "tasks/a/report.json", kind: "file", taskId: "a" }]),
      secondStore.registerDeliveries([{ path: "tasks/b/report.json", kind: "file", taskId: "b" }]),
    ]);
    assert.equal(results.length, 2);
    const catalog = JSON.parse(await readFile(resolve(directory, "shared/DELIVERIES.json"), "utf8"));
    assert.deepEqual(catalog.map(entry => entry.taskId), ["a", "b", "old"]);
    for (const taskId of ["a", "b", "old"]) {
      const manifest = JSON.parse(await readFile(resolve(directory, `shared/delivery-manifests/${taskId}.json`), "utf8"));
      assert.equal(manifest.taskId, taskId);
      assert.equal(typeof manifest.hash, "string");
      assert.deepEqual(manifest.entries, [{ path: `tasks/${taskId}/report.json`, kind: "file", taskId }]);
    }
    await firstStore.registerDeliveries([{ path: "tasks/a/report.json", kind: "file", taskId: "a" }]);
    await assert.rejects(
      firstStore.registerDeliveries([{ path: "tasks/a/changed.json", kind: "file", taskId: "a" }]),
      error => error?.code === "team_delivery_manifest_conflict",
    );
    const snapshot = await firstStore.registerDeliverySnapshot("round-union", ["a", "b"]);
    assert.deepEqual(snapshot.map(entry => entry.taskId), ["a", "b"]);
    assert.deepEqual(await secondStore.registerDeliverySnapshot("round-union", ["a", "b"]), snapshot);
    await assert.rejects(
      firstStore.registerDeliverySnapshot("round-union", ["a"]),
      error => error?.code === "team_delivery_snapshot_conflict",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery publication rejects an unproven external writer", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-delivery-lock-"));
  const lockPath = resolve(directory, "shared/.delivery-write.lock");
  try {
    await mkdir(resolve(directory, "shared"), { recursive: true });
    await writeFile(lockPath, "external writer\n", { encoding: "utf8", flag: "wx" });
    const store = new TeamStateStore(directory);
    await assert.rejects(
      store.registerDeliveries([{ path: "tasks/a/report.json", kind: "file", taskId: "a" }]),
      error => error?.code === "team_delivery_writer_conflict",
    );
    const catalogExists = await readFile(resolve(directory, "shared/DELIVERIES.json"), "utf8").then(() => true).catch(error => error.code === "ENOENT" ? false : Promise.reject(error));
    assert.equal(catalogExists, false);
  } finally {
    await rm(lockPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("base and supplemental memory assistance honor the real target contract and publish readable directories", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-adapter-"));
  try {
    const raw = config({ assistants: 1 });
    raw.baseRetrieval.inputAdapter = "memory-request-v1";
    raw.assistants[0].inputAdapter = "memory-request-v1";
    raw.assistants[0].fixedArguments = { budget: { informationLimit: 5 } };
    const normalized = normalizeTeamDefinition(raw);
    const abilities = [normalized.baseRetrieval, normalized.assistants[0]];
    const store = new TeamStateStore(resolve(directory, "team"));
    const state = await store.ensure(normalized);
    const received = [];
    const normalizedRequests = [];
    const usage = [];
    const target = normalizeWorkflowDefinition(JSON.parse(await readFile(resolve("global-modules/narrative-memory/workflows/narrative-memory-retrieve/workflow.json"), "utf8")));
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities,
      startWorkflow: async request => {
        received.push(request);
        normalizedRequests.push(normalizeWorkflowCallRequest(target, request));
        const output = resolve(directory, request.outputPaths["memory-context"]);
        await mkdir(output, { recursive: true });
        await writeFile(resolve(output, "DOCUMENTS.md"), "# Memory context\n\n- GENERAL.md\n", "utf8");
        await writeFile(resolve(output, "GENERAL.md"), `retrieved: ${request.text}\n`, "utf8");
        return {
          outputs: request.outputPaths,
          outputArtifacts: { "memory-context": { kind: "directory" } },
          usage: { input: 7, output: 3, totalTokens: 10 },
        };
      },
      invokeAgent: async () => ({}),
      invokeTool: async () => ({}),
      onUsage: value => { usage.push(value); },
    });
    const started = await Promise.all([
      manager.start({ abilityId: abilities[0].id, requestId: "memory-base", text: "Find the prior oath." }),
      manager.start({ abilityId: abilities[1].id, requestId: "memory-supplemental", text: "Check who witnessed it." }),
    ]);
    const completed = await manager.wait(started.map(item => item.taskId));
    assert.deepEqual(completed.map(item => item.status), ["succeeded", "succeeded"]);
    assert.deepEqual(received.map(item => item.text).sort(), ["Check who witnessed it.", "Find the prior oath."]);
    assert.deepEqual(normalizedRequests.map(item => item.arguments.budget.informationLimit).sort((a, b) => a - b), [5, 40]);
    assert.equal(received.every(item => !("query" in item.arguments) && !("requestId" in item.arguments)), true);
    assert.throws(() => normalizeWorkflowCallRequest(target, { ...received[0], arguments: { ...received[0].arguments, query: received[0].text } }), /undeclared parameter inputs: query/);
    assert.deepEqual(usage.map(item => item.totalTokens), [10, 10]);
    for (let index = 0; index < completed.length; index += 1) {
      const deliveryId = `memory-delivery-${index + 1}`;
      await store.registerDeliverySnapshot(deliveryId, [completed[index].taskId]);
      const path = `${completed[index].result.outputs["memory-context"]}/GENERAL.md`;
      const material = await readAuthorizedTeamMaterial({ path, teamRoot: store.root, teamNodeRoot: directory, memberRoot: resolve(store.root, "members", "leader"), deliveryId });
      assert.match(material.content, /^retrieved: /);
    }
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

test("failed assistant attempts retain exact usage once across persistence and replay", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-assistant-usage-"));
  try {
    const team = normalizeTeamDefinition(config());
    const store = new TeamStateStore(directory);
    const state = await store.ensure(team);
    reserveTeamBudget(state, "supplemental-assistance", "assistance-failed-usage");
    consumeTeamBudget(state, "assistance-failed-usage");
    const ability = {
      id: "agent-helper",
      enabled: true,
      kind: "agent",
      agentId: "helper",
      inputAdapter: "natural-language-v1",
      fixedArguments: {},
      documents: {},
      exports: [],
      timeoutMs: 10_000,
    };
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: [ability],
      startWorkflow: async () => ({}),
      invokeTool: async () => ({}),
      invokeAgent: async () => { throw Object.assign(new Error("provider failed after output"), { usage: { input: 7, output: 3, totalTokens: 10 } }); },
      onUsage: (usage, metadata) => recordTeamUsage(state, usage, metadata),
    });
    const { taskId } = await manager.start({ abilityId: ability.id, requestId: "failed-usage", text: "question" });
    const [task] = await manager.wait([taskId]);
    const attemptId = `${taskId}#attempt-1`;
    assert.equal(task.status, "failed");
    assert.deepEqual(task.usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 });
    assert.deepEqual(task.usageAttempts[attemptId].usage, task.usage);
    assert.equal(task.usageAttempts[attemptId].outcome, "failed");
    assert.equal(state.usage.input, 7);
    assert.equal(state.usage.output, 3);
    assert.equal(state.usage.totalTokens, 10);
    assert.equal(state.usage.recordedCalls, 1);
    assert.equal(state.usage.unrecordedCalls, 0);

    const recovered = await new TeamStateStore(directory).read();
    assert.equal(recordTeamUsage(recovered, task.usage, { attemptId, status: "recorded", outcome: "failed", source: "replay" }), false);
    assert.equal(recovered.usage.totalTokens, 10);
    assert.equal(recovered.usage.recordedCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late timeout usage supplements the same attempt without publishing its result", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-late-usage-"));
  let release;
  let usageSupplemented;
  const execution = new Promise(resolve => { release = resolve; });
  const supplemented = new Promise(resolve => { usageSupplemented = resolve; });
  try {
    const team = normalizeTeamDefinition(config());
    const store = new TeamStateStore(directory);
    const event = store.event.bind(store);
    store.event = async (state, type, detail) => {
      const result = await event(state, type, detail);
      if (type === "assistance-task-usage-supplemented") usageSupplemented();
      return result;
    };
    const state = await store.ensure(team);
    reserveTeamBudget(state, "supplemental-assistance", "assistance-timeout-usage");
    consumeTeamBudget(state, "assistance-timeout-usage");
    const ability = {
      id: "agent-helper",
      enabled: true,
      kind: "agent",
      agentId: "helper",
      inputAdapter: "natural-language-v1",
      fixedArguments: {},
      documents: {},
      exports: [],
      timeoutMs: 10,
    };
    const manager = new AssistanceTaskManager({
      state,
      store,
      abilities: [ability],
      startWorkflow: async () => ({}),
      invokeTool: async () => ({}),
      invokeAgent: async () => execution,
      onUsage: (usage, metadata) => recordTeamUsage(state, usage, metadata),
    });
    const { taskId } = await manager.start({ abilityId: ability.id, requestId: "late-usage", text: "question" });
    const [timedOut] = await manager.wait([taskId]);
    const attemptId = `${taskId}#attempt-1`;
    assert.equal(timedOut.status, "timed-out");
    assert.equal(timedOut.usage, null);
    assert.equal(timedOut.usageAttempts[attemptId].status, "unknown");

    release({ content: "late business result", usage: { input: 7, output: 3, totalTokens: 10 } });
    await supplemented;
    const persisted = await store.read();
    assert.equal(persisted.tasks[taskId].status, "timed-out");
    assert.equal(persisted.tasks[taskId].result, null);
    assert.equal(persisted.tasks[taskId].usageAttempts[attemptId].outcome, "late-succeeded");
    assert.equal(persisted.usage.totalTokens, 10);
    assert.equal(persisted.usage.recordedCalls, 1);
    assert.equal(persisted.usage.unrecordedCalls, 0);
  } finally {
    release?.({ content: "cleanup" });
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

test("completed replay restores changed or missing deliverables from the approved final basis", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-completed-restore-"));
  let calls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      calls += 1;
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "approved" }, referenceUpdates: [] }) };
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    const first = await runTeamMeeting(options);
    const before = calls;
    const completed = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(completed.completion.manifest.artifacts.report.path, first.report);
    assert.equal(typeof completed.completion.manifest.basisHash, "string");
    await writeFile(resolve(directory, first.report), JSON.stringify({ summary: "unapproved replacement" }), "utf8");
    await rm(resolve(directory, first.references), { force: true });
    await rm(resolve(directory, "team/completion-manifest.json"), { force: true });

    const replay = await runTeamMeeting(options);
    assert.equal(calls, before);
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, replay.report), "utf8")), { summary: "approved", referenceUpdates: [] });
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, replay.references), "utf8")), []);
    const recovered = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(recovered.status, "completed");
    assert.equal(typeof recovered.completion.artifact.hash, "string");
    const events = await readFile(resolve(directory, "team/events.jsonl"), "utf8");
    assert.match(events, /meeting-deliverables-restored/);
    assert.match(events, /content-changed/);
    assert.match(events, /completion-manifest-missing-or-changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed replay blocks when its completion manifest conflicts with the approved basis", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-completed-conflict-"));
  let calls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      calls += 1;
      if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: [] }) };
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "approved" }, referenceUpdates: [] }) };
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await runTeamMeeting(options);
    const before = calls;
    const statePath = resolve(directory, "team/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.completion.manifest.basisHash = "0".repeat(64);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await assert.rejects(runTeamMeeting(options), error => error?.code === "workflow_recovery_required" && /manifest conflicts/.test(error.message));
    assert.equal(calls, before);
    const blocked = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(blocked.status, "awaiting-recovery");
    assert.equal(blocked.completionRecovery.status, "blocked");
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
        return { content: revisionCalls === 1 ? JSON.stringify({ report: { summary: "rejected" } }) : JSON.stringify({ report: { summary: "fixed" }, referenceUpdates: [] }) };
      }
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), /referenceUpdates must be an array/);
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

test("structurally invalid coordination is rejected before confirmation and regenerated on retry", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-coordination-structure-retry-"));
  let coordinationCalls = 0;
  const options = {
    config: config(), workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      if (request.executionId.startsWith("coordination-")) {
        coordinationCalls += 1;
        return { content: coordinationCalls === 1 ? JSON.stringify({ requests: {} }) : JSON.stringify({ requests: [] }) };
      }
      if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "fixed" }, referenceUpdates: [] }) };
      if (request.executionId.includes("discussion") && request.executionId.endsWith("leader")) return { content: "close", control: { action: "close" } };
      return { content: "ok" };
    },
  };
  try {
    await assert.rejects(runTeamMeeting(options), /requests must be an array/);
    const result = await runTeamMeeting(options);
    assert.equal(JSON.parse(await readFile(resolve(directory, result.report), "utf8")).summary, "fixed");
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    const executionId = Object.keys(state.executionFailures).find(id => id.startsWith("coordination-"));
    assert.ok(executionId);
    assert.equal(coordinationCalls, 2);
    assert.equal(state.executionFailures[executionId], 1);
    assert.equal(state.budgets.retries.used, 1);
    assert.match(await readFile(resolve(directory, "team", state.executions[executionId].artifact.relativePath), "utf8"), /"requests":\[\]/);
    assert.match(await readFile(resolve(directory, "team/diagnostics/rejected", `${executionId}-attempt-1.md`), "utf8"), /"requests":\{\}/);
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
          return { content: JSON.stringify({ requests: [{ requestId: request.executionId, abilityId: "helper-1", text: request.executionId, disposition: "dispatch", reason: "requested during discussion" }] }) };
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
    assert.equal(state.budgets.retries.used, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistance retries stop at the retry budget", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-retry-limit-"));
  const definition = config();
  definition.budgets.retries = 1;
  let retrievalCalls = 0;
  const options = {
    config: definition, workspace: directory, runId: "run", nodeId: "team", context: "context",
    startWorkflow: async () => { retrievalCalls += 1; throw new Error("persistent retrieval failure"); },
    invokeMember: async request => ({ content: request.executionId === "base-retrieval-brief" ? "same request" : "ok" }),
  };
  try {
    await assert.rejects(runTeamMeeting(options), error => error?.code === "workflow_recovery_required");
    await assert.rejects(runTeamMeeting(options), error => error?.code === "workflow_recovery_required");
    await assert.rejects(runTeamMeeting(options), error => error?.code === "team_budget_exhausted");
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(retrievalCalls, 2);
    assert.equal(state.budgets.retries.used, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persisted speech is never reused after its artifact hash changes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-artifact-integrity-"));
  const team = normalizeTeamDefinition(config());
  const store = new TeamStateStore(resolve(directory, "team"));
  const state = await store.ensure(team, { runId: "run", nodeId: "team" });
  await store.publishSpeech(state, { executionId: "initial-leader", memberId: "leader", phase: "initial-analysis", content: "confirmed output" });
  await writeFile(resolve(store.root, state.executions["initial-leader"].artifact.relativePath), "damaged output", "utf8");
  let calls = 0;
  try {
    await assert.rejects(runTeamMeeting({ config: team, workspace: directory, runId: "run", nodeId: "team", startWorkflow: async () => ({}), invokeMember: async () => { calls += 1; return { content: "unexpected" }; } }), error => error?.code === "workflow_recovery_required");
    const recovered = await store.read();
    assert.equal(calls, 0);
    assert.equal(recovered.status, "awaiting-recovery");
    assert.match(recovered.error, /hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed member attempts retain provider-reported token usage", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-failed-usage-"));
  try {
    await assert.rejects(runTeamMeeting({
      config: config(), workspace: directory, runId: "run", nodeId: "team", startWorkflow: async () => ({}),
      invokeMember: async () => { throw Object.assign(new Error("provider failure"), { usage: { input: 7, output: 3, totalTokens: 10 } }); },
    }), /provider failure/);
    const state = JSON.parse(await readFile(resolve(directory, "team/state.json"), "utf8"));
    assert.equal(state.usage.input, 7);
    assert.equal(state.usage.output, 3);
    assert.equal(state.usage.totalTokens, 10);
    assert.equal(state.usage.recordedCalls, 1);
    assert.equal(state.usage.unrecordedCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an assistance task's default timeout can cover a real model call", () => {
  // The previous 120 s default timed out every required base retrieval in a real team meeting
  // ("Required base retrieval failed: Assistance task timed out after 120000ms.") while a single
  // memory retrieval call takes minutes. A team that wants a tighter bound declares `timeoutMs`.
  const normalized = normalizeTeamDefinition(config({ assistants: 1 }));
  assert.equal(normalized.baseRetrieval.timeoutMs, 600000, "a real workflow assistance task needs minutes, not 120 s");
  assert.equal(normalized.assistants[0].timeoutMs, 600000);
  const explicit = normalizeTeamDefinition({
    ...config({ assistants: 1 }),
    baseRetrieval: { ...config().baseRetrieval, timeoutMs: 900000 },
    assistants: [{ ...config({ assistants: 1 }).assistants[0], timeoutMs: 240000 }],
  });
  assert.equal(explicit.baseRetrieval.timeoutMs, 900000);
  assert.equal(explicit.assistants[0].timeoutMs, 240000);
  // A value that is not a positive integer falls back to the default instead of disabling the bound.
  assert.equal(normalizeTeamDefinition({ ...config(), baseRetrieval: { ...config().baseRetrieval, timeoutMs: "soon" } }).baseRetrieval.timeoutMs, 600000);
  assert.equal(normalizeTeamDefinition({ ...config(), baseRetrieval: { ...config().baseRetrieval, timeoutMs: 0 } }).baseRetrieval.timeoutMs, 600000);
});

test("Secretary side failures are caught by the meeting while discussion is active", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-rp-team-side-failure-"));
  const runtimeUrl = pathToFileURL(resolve(".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-team-runtime.mjs")).href;
  const definition = config();
  definition.agenda = { normalRounds: 2, maxRounds: 3 };
  const program = `
    import { runTeamMeeting } from ${JSON.stringify(runtimeUrl)};
    try {
      await runTeamMeeting({ config: ${JSON.stringify(definition)}, workspace: ${JSON.stringify(directory)}, runId: 'run', nodeId: 'team',
        startWorkflow: async request => ({ outputs: request.outputPaths }),
        invokeMember: async request => {
          if (request.executionId.startsWith('coordination-')) throw new Error('SECRETARY_SIDE_FAILURE');
          if (request.executionId === 'discussion-2-leader') await new Promise(done => setTimeout(done, 150));
          return { content: request.executionId, control: { action: 'continue' } };
        }
      });
    } catch (error) { console.log('CAUGHT_BY_MEETING', error.message); process.exitCode = 23; }
  `;
  try {
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", program], { encoding: "utf8", timeout: 10000 });
    if (child.error) {
      // This case asserts a property of the *process*: an unhandled rejection must not tear it down.
      // Observing that needs a child process with piped stdio, which some sandboxes deny outright
      // (`spawn EPERM`). Report that as a skip rather than as a product failure; the in-process
      // behaviour of the same meeting is covered by the surrounding tests.
      t.skip(`cannot spawn a child process in this environment: ${child.error.code || child.error.message}`);
      return;
    }
    assert.equal(child.status, 23, child.stderr);
    assert.match(child.stdout, /CAUGHT_BY_MEETING SECRETARY_SIDE_FAILURE/);
    assert.doesNotMatch(child.stderr, /SECRETARY_SIDE_FAILURE/);
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
