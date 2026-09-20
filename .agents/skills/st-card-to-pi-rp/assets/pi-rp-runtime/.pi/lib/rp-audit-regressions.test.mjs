/**
 * Regressions for the defects found by the 2026-09-18 card audit.
 *
 * Each test here fails against the pre-fix runtime. They share one cause -- a value or a state that
 * is authoritative on disk being ignored in favour of a derived or stale one -- and each only
 * reproduces through a window the previous suites never opened: durable output produced by a step
 * that never finished, a run unblocked while a sibling is still blocked, terminal cleanup after a
 * cancel, and a read budget applied to the first record.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { applyFrontendSettingsValues, normalizeModuleFrontendView } from "./rp-module-frontend.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { executeDataBatch } from "./rp-data-changes.mjs";
import { queryData, queryDataStable } from "./rp-data-query.mjs";
import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";
import { normalizeWorkflowDefinition, workflowTriggerMatches } from "./rp-workflows.mjs";
import { runTeamMeeting } from "./rp-team-runtime.mjs";

// A minimal record-log module, mirroring the shape the shipped modules use.
const contract = normalizeDataContract({
  schemaVersion: 1,
  moduleId: "audit",
  collections: {
    notes: {
      storage: { kind: "record-log", partition: { mode: "single" } },
      recordTypes: {
        "audit.note": {
          dataSchemaVersion: 1,
          indexes: { kind: { path: "/data/kind", type: "id", operators: ["eq"] } },
          searchableFields: ["/data/body"],
          views: {
            text: { format: "text", fields: [{ path: "/data/body" }] },
            object: { format: "object", fields: [{ path: "/data/body" }, { path: "/data/kind" }] },
          },
          actions: ["create", "update"],
        },
      },
    },
  },
  capabilities: {
    "audit.query": { collections: ["notes"], actions: ["query"], views: ["text", "object"] },
    "audit.write": { collections: ["notes"], actions: ["create", "update"], views: [] },
  },
});

async function dataFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rp-audit-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = join(root, "card", "features", "audit");
  const store = new RpDataStore({ sessionDirectory: join(root, "session"), modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  return { root, store };
}

function createNote(store, batchId, id, body) {
  return executeDataBatch(store, {
    protocolVersion: 1,
    batchId,
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: `${batchId}-op`, moduleId: "audit", collectionId: "notes", recordType: "audit.note", action: "create", targetId: id, data: { body, kind: "note" } }],
  }, {
    access: { audit: ["audit.write"] },
    context: { initiatorKind: "code", initiatorId: "test", binding: { turn: 1, messageId: null } },
  });
}

const queryAccess = { capabilities: ["audit.query"], views: ["text", "object"] };

test("a read budget constrains the first record instead of letting it through unbounded", { timeout: 15000 }, async t => {
  const { store } = await dataFixture(t);
  await createNote(store, "budget-seed", "note.big", "x".repeat(4000));

  const bounded = await queryDataStable(store, { moduleId: "audit", collectionId: "notes", view: "text", limit: 10 }, {
    ...queryAccess, runtimeLimit: 10, runtimeCharacters: 500,
  });
  assert.equal(bounded.items.length, 0, "a record larger than the budget must not be delivered");
  assert.equal(bounded.truncated, true, "hitting the budget must be reported as truncation");

  // The same read with a budget that fits must still deliver the record.
  const fitting = await queryDataStable(store, { moduleId: "audit", collectionId: "notes", view: "text", limit: 10 }, {
    ...queryAccess, runtimeLimit: 10, runtimeCharacters: 8000,
  });
  assert.equal(fitting.items.length, 1);
  assert.equal(fitting.items[0].value.length, 4000);

  // The offset-keyed query path must obey the same rule.
  const offsetPath = await queryData(store, { moduleId: "audit", collectionId: "notes", view: "text", limit: 10, maxCharacters: 500 }, {
    ...queryAccess, runtimeLimit: 10, runtimeCharacters: 500,
  });
  assert.equal(offsetPath.items.length, 0);
  assert.equal(offsetPath.truncated, true);
});

test("a leftover transaction journal does not mask an already-committed batch", { timeout: 15000 }, async t => {
  const { store } = await dataFixture(t);
  const committed = await createNote(store, "orphan-journal", "note.kept", "committed body");
  assert.equal(committed.status, "committed");

  // Simulate the cleanup that could not happen (a Windows file lock, a scanner, a sync client):
  // `commitDataFiles` removes this journal on success but swallows a removal failure, so a `staged`
  // journal can survive next to a committed receipt.
  const transactionRoot = join(store.sessionDirectory, "workspace", "transactions");
  await mkdir(transactionRoot, { recursive: true });
  await writeFile(join(transactionRoot, "orphan-journal.json"), JSON.stringify({
    schemaVersion: 1,
    batchId: "orphan-journal",
    status: "staged",
    entries: [],
  }), "utf8");

  const replay = await createNote(store, "orphan-journal", "note.kept", "committed body");
  assert.equal(replay.status, "committed", "the committed receipt must remain authoritative");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(
    replay.results.some(result => result.code === "commit_outcome_unknown"),
    false,
    "a leftover journal must not turn a committed batch into an unknown outcome",
  );

  // A genuinely unresolved journal for a batch with no durable outcome must still block.
  await writeFile(join(transactionRoot, "still-unknown.json"), JSON.stringify({
    schemaVersion: 1, batchId: "still-unknown", status: "rollback-failed", entries: [],
  }), "utf8");
  const unknown = await createNote(store, "still-unknown", "note.blocked", "must not land");
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.results[0].code, "commit_outcome_unknown");
});

test("unblocking one node keeps the run blocked while a sibling still awaits a model choice", { timeout: 15000 }, async t => {
  const parent = {
    schemaVersion: 3,
    id: "audit-parent",
    kind: "turn-background",
    nodes: [
      { id: "first", type: "agent" },
      { id: "second", type: "agent" },
    ],
  };

  // Both nodes stop for a model choice, which is what leaves the run itself blocked.
  let failing = new Set(["first", "second"]);
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: {}, outputPaths: {} }) };
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      task.markModelDispatched?.();
      if (task.workflow.id === parent.id && failing.has(task.node.id)) throw new Error("provider offline");
      return { output: "ok" };
    },
  });

  const started = await engine.start(parent, { id: "audit-parent-run" });
  const blocked = await engine.wait(started.id);
  assert.equal(blocked.status, "awaiting-model-choice");
  assert.equal(blocked.nodes.first.status, "awaiting-model-choice");
  assert.equal(blocked.nodes.second.status, "awaiting-model-choice");

  // Retry only the first node. The second is still waiting for a model choice, so the run must stay
  // reported as blocked. Writing `running` here left the run in a status `wait()` does not stop on,
  // and the caller below never returned.
  await engine.retry(started.id, "first", null);
  failing = new Set();
  const afterRetry = await engine.snapshot().find(run => run.id === started.id);
  assert.equal(afterRetry.nodes.second.status, "awaiting-model-choice", "the untouched node must stay blocked");
  assert.equal(afterRetry.status, "awaiting-model-choice", "a run with a blocked sibling must stay blocked");

  let settled = null;
  engine.wait(started.id).then(run => { settled = run; }, error => { settled = { error: String(error) }; });
  const deadline = Date.now() + 4000;
  while (!settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(settled, "wait() must return instead of hanging on a run whose sibling is blocked");
  assert.equal(settled.status, "awaiting-model-choice");

  // Retrying the remaining node must let the run finish.
  await engine.retry(started.id, "second", null);
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
});

test("a cancelled run still executes its declared terminal finalizer", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-audit-finalizer-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // `terminalStatus` / `terminalError` reach the finalizer only because this workflow forwards them:
  // the engine passes exactly the arguments `forwardArguments` names, so a target that needs them must
  // declare them and the finalizer must forward them, just like the shipped `finish-deep-operation`.
  const finalizer = {
    schemaVersion: 3,
    id: "audit-release",
    ownerModuleId: "audit",
    kind: "module-internal",
    interface: {
      inputs: {
        operationId: { type: "parameter", required: true, valueType: "string" },
        terminalStatus: { type: "parameter", required: true, valueType: "string" },
        terminalError: { type: "parameter", required: false, valueType: "any" },
      },
      exports: {},
    },
    nodes: [{ id: "release", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["release"], exports: {} }],
  };
  const owner = {
    schemaVersion: 3,
    id: "audit-owner",
    ownerModuleId: "audit",
    kind: "module-external",
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.operationId" },
    interface: { inputs: { operationId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    terminalFinalizer: { target: "audit/audit-release", statuses: ["failed", "cancelled", "skipped"], forwardArguments: ["operationId", "terminalStatus", "terminalError"] },
    nodes: [{ id: "work", type: "agent" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  const host = {
    schemaVersion: 3,
    id: "audit-host",
    kind: "global-background",
    nodes: [{ id: "call", type: "call", target: "audit/audit-owner", arguments: { operationId: "op-1" }, outputPaths: {} }],
  };

  const releases = [];
  let ownerRunId = null;
  let releaseWork;
  const workGate = new Promise(resolve => { releaseWork = resolve; });
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async reference => (reference === "audit/audit-owner" ? owner : reference === "audit/audit-release" ? finalizer : null),
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    onRunStart: async ({ run }) => { if (run.workflowId === owner.id) ownerRunId = run.id; return null; },
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: task.node.arguments, outputPaths: {} }) };
      // Only the finalizer's own code node observes the forwarded cleanup arguments.
      if (task.workflow.id === finalizer.id && task.node.id === "release") {
        releases.push([task.run.arguments?.operationId || null, task.run.arguments?.terminalStatus || null]);
        return { output: "released" };
      }
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      // Hold the owner mid-flight so the cancel certainly lands on a live run.
      task.markModelDispatched?.();
      await workGate;
      return { output: "ok" };
    },
  });

  const hostRun = await engine.start(host, { id: "audit-host-run" });
  for (let attempt = 0; attempt < 400 && !ownerRunId; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ownerRunId, "the called owner run must start");
  assert.equal(engine.snapshot().find(run => run.id === ownerRunId).status, "running", "the cancel must land on a live run");

  await engine.cancel(ownerRunId, "audit cancel");
  releaseWork();
  await engine.wait(hostRun.id).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 50));

  const cancelled = engine.snapshot().find(run => run.id === ownerRunId);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(releases, [["op-1", "cancelled"]], "the terminal finalizer must run exactly once, for the cancelled status");
  assert.equal(cancelled.terminalFinalization?.status, "completed", `finalization failed: ${cancelled.terminalFinalization?.error}`);
});

test("a re-queued coordination batch whose artifact already exists resumes instead of poisoning the meeting", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "rp-audit-team-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const config = {
    schemaVersion: 1,
    leader: { id: "leader", agentId: "audit-leader" },
    secretary: { id: "secretary", agentId: "audit-secretary" },
    experts: [],
    agenda: { normalRounds: 1, maxRounds: 2 },
    budgets: { preparation: 20, discussion: 20, coordination: 10, closing: 20, draft: 3, review: 20, revision: 3, references: 3 },
  };
  const coordinationCalls = [];
  const options = {
    config,
    workspace: directory,
    runId: "run",
    nodeId: "team",
    context: "Audit context.",
    startWorkflow: async request => ({ outputs: request.outputPaths }),
    invokeMember: async request => {
      if (request.executionId.startsWith("coordination-")) { coordinationCalls.push(request.executionId); return { content: JSON.stringify({ requests: [] }) }; }
      if (request.executionId === "secretary-draft" || request.executionId === "secretary-revision") {
        return { content: JSON.stringify({ report: { summary: "plan", content: "details" }, referenceUpdates: [] }) };
      }
      if (request.executionId.startsWith("discussion-") && request.executionId.endsWith("-leader")) return { content: "synthesis", control: { action: "close" } };
      return { content: `${request.member.id} ${request.phase}` };
    },
  };

  await runTeamMeeting(options);
  assert.ok(coordinationCalls.length > 0, "the first run must have coordinated at least one batch");

  // Reproduce the ordinary crash window: the coordination artifact is durable, but the batch never
  // recorded its completion. `run()` re-queues every batch still marked unfinished, so the next
  // attempt reaches the reuse branch with the artifact already on disk. The discussion is closed so
  // the resumed run goes straight to the coordination flush plus the remaining phases.
  const statePath = join(directory, "team", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const batchId = coordinationCalls[0];
  state.coordinationBatches[batchId].status = "queued";
  state.coordinationCursor = 0;
  state.coordinationQueuedThrough = 0;
  state.closeRequested = true;
  state.discussionRound = null;
  state.phase = "discussion";
  state.status = "running";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const before = coordinationCalls.length;
  const resumed = await runTeamMeeting(options);
  assert.equal(resumed.report, "deliverables/report.json");
  assert.equal(
    coordinationCalls.length,
    before,
    "the re-queued batch must be re-coordinated by reusing its durable artifact, not by calling the member again",
  );
  const finalState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(finalState.status, "completed", `the resumed meeting must complete: ${finalState.error || ""}`);
  assert.equal(finalState.coordinationBatches[batchId].status, "completed");
  assert.equal(finalState.error, null, "a reused execution must not poison the coordination batch");
});

test("the terminal finalizer receives exactly the arguments forwardArguments declares", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-audit-forwardargs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Two targets so each workflow can be paired with a target whose declared inputs match what it
  // forwards. A workflow that forwards fewer arguments than its target requires is *rejected* — that
  // is the contract working, not a bug — so the comparison needs one target per argument set.
  const fullTarget = {
    schemaVersion: 3,
    id: "audit-release-full",
    ownerModuleId: "audit",
    kind: "module-internal",
    interface: {
      inputs: {
        operationId: { type: "parameter", required: true, valueType: "string" },
        terminalStatus: { type: "parameter", required: true, valueType: "string" },
      },
      exports: {},
    },
    nodes: [{ id: "release", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["release"], exports: {} }],
  };
  const narrowTarget = {
    schemaVersion: 3,
    id: "audit-release-narrow",
    ownerModuleId: "audit",
    kind: "module-internal",
    interface: { inputs: { operationId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    nodes: [{ id: "release", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["release"], exports: {} }],
  };
  const targets = new Map([[fullTarget.id, fullTarget], [narrowTarget.id, narrowTarget]]);
  const owner = (id, target, forwardArguments) => ({
    schemaVersion: 3,
    id,
    ownerModuleId: "audit",
    kind: "module-external",
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 2, dedupeKey: "$.operationId" },
    interface: { inputs: { operationId: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    terminalFinalizer: { target: `audit/${target}`, statuses: ["failed", "cancelled", "skipped"], forwardArguments },
    nodes: [{ id: "work", type: "agent" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  });
  const ownerFull = owner("audit-owner-full", fullTarget.id, ["operationId", "terminalStatus"]);
  const ownerNarrow = owner("audit-owner-narrow", narrowTarget.id, ["operationId"]);
  const owners = new Map([[ownerFull.id, ownerFull], [ownerNarrow.id, ownerNarrow]]);

  const observed = [];
  let pendingOwnerRunId = null;
  let releaseWork;
  const workGate = new Promise(resolve => { releaseWork = resolve; });
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async reference => {
      const targetId = reference.replace("audit/", "");
      return targets.get(targetId) || owners.get(targetId) || null;
    },
    resolveModel: async id => ({ id, maxConcurrency: 2 }),
    onRunStart: async ({ run }) => { if (owners.has(run.workflowId)) pendingOwnerRunId = run.id; return null; },
    executor: async task => {
      if (task.node.type === "call") return { output: await task.invokeWorkflow({ workflow: task.node.target, arguments: task.node.arguments, outputPaths: {} }) };
      if (targets.has(task.workflow.id) && task.node.id === "release") {
        observed.push({ report: String(task.run.arguments?.operationId || ""), args: Object.keys(task.run.arguments || {}).sort() });
        return { output: "released" };
      }
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      // Hold the owner mid-flight so a cancel certainly lands on a live run.
      task.markModelDispatched?.();
      await workGate;
      return { output: "ok" };
    },
  });

  // Cancel each owner in turn; `cancelled` is a terminal status both workflows list.
  for (const [runId, operationId] of [[ownerFull.id, "op-full"], [ownerNarrow.id, "op-narrow"]]) {
    const host = { schemaVersion: 3, id: `audit-host-${runId}`, kind: "global-background", nodes: [{ id: "call", type: "call", target: `audit/${runId}`, arguments: { operationId }, outputPaths: {} }] };
    const hostRun = await engine.start(host, { id: `host-${runId}` });
    for (let attempt = 0; attempt < 400 && !pendingOwnerRunId; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pendingOwnerRunId, `${runId} must start`);
    await engine.cancel(pendingOwnerRunId, "audit cancel");
    pendingOwnerRunId = null;
    await engine.wait(hostRun.id).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  releaseWork();

  const declared = observed.find(entry => entry.report === "op-full");
  assert.ok(declared, "the finalizer must run for the forwarding workflow");
  assert.deepEqual(declared.args, ["operationId", "terminalStatus"], "exactly the declared arguments are forwarded");

  const narrow = observed.find(entry => entry.report === "op-narrow");
  assert.ok(
    narrow,
    `the finalizer must run for the narrow workflow; observed=${JSON.stringify(observed)} runs=${JSON.stringify(engine.snapshot().map(run => [run.workflowId, run.status, run.terminalFinalization?.error || null]))}`,
  );
  assert.deepEqual(narrow.args, ["operationId"], "an argument the workflow did not declare must not be forwarded");
});

test("a settings field path cannot reach the prototype chain", () => {
  // A settings form writes its values with a plain property assignment, so `/__proto__/x` used to walk
  // the prototype chain and pollute `Object.prototype` for the whole process.
  const contract = normalizeDataContract({
    schemaVersion: 1,
    moduleId: "audit",
    collections: {
      settings: {
        storage: { kind: "snapshot", partition: { mode: "single" } },
        recordTypes: {
          "audit.settings": {
            dataSchemaVersion: 1,
            indexes: {},
            searchableFields: [],
            views: { maintenance: { format: "object", fields: [{ path: "/data/theme" }] } },
            actions: ["update"],
          },
        },
      },
    },
    capabilities: {
      "audit.settings.read": { collections: ["settings"], actions: ["query"], views: ["maintenance"] },
      "audit.settings.write": { collections: ["settings"], actions: ["update"], views: ["maintenance"] },
    },
  });
  const region = unsafePath => ({
    id: "settings-form",
    type: "settings-form",
    title: "Settings",
    collectionId: "settings",
    recordType: "audit.settings",
    recordId: "audit-settings-current",
    view: "maintenance",
    readCapability: "audit.settings.read",
    updateCapability: "audit.settings.write",
    fields: [{ path: unsafePath, label: "Theme", type: "text" }],
  });

  // Gate 1: the declaration itself is refused, whichever unsafe segment it uses.
  for (const unsafePath of ["/__proto__/pollutedByCard", "/constructor/prototype/x", "/data/__proto__/x"]) {
    assert.throws(
      () => normalizeModuleFrontendView({ schemaVersion: 2, regions: [region(unsafePath)] }, contract),
      /must not traverse/,
      `${unsafePath} must be rejected when the region is normalized`,
    );
  }

  // A plain path is still accepted, so the gate is not simply refusing every settings form.
  assert.doesNotThrow(() => normalizeModuleFrontendView({ schemaVersion: 2, regions: [region("/theme")] }, contract));

  // Gate 2: the writer refuses as well, for a region that never went through normalization.
  assert.throws(
    () => applyFrontendSettingsValues(region("/__proto__/pollutedByCard"), {}, { "/__proto__/pollutedByCard": "from a card" }),
    /must not traverse/,
  );
  assert.equal({}.pollutedByCard, undefined, "the process prototype must stay clean");
});

test("a blocking run that stopped because a host hook failed reports the reason", { timeout: 20000 }, async t => {
  // A host-hook failure (persistence, event dispatch) is recorded on the run and deliberately does not
  // fail it. Nothing then moves the node, so the run keeps blocking the next turn. Without the reason
  // reaching `blockingTurnRuns` the panel can only say "waiting for a background workflow", which is
  // indistinguishable from normal progress.
  const workflow = {
    schemaVersion: 3,
    id: "audit-stuck",
    title: "Stuck archive",
    kind: "turn-background",
    trigger: { type: "manual", blockNextTurnUntilReady: true },
    nodes: [{ id: "archive", title: "Archive", type: "agent" }],
  };

  let hookCalls = 0;
  const engine = new RpWorkflowEngine({
    // A model failure after dispatch is retryable, so the node stops for a model choice and the run
    // stays alive (and blocking) instead of reaching a terminal status where nothing is stuck.
    executor: async task => {
      task.markModelDispatched?.();
      throw new Error("provider offline");
    },
    // The host hook fails from the third propagation on: `start()` and `retry()` await it directly, so
    // the failure has to land in the scheduler's own path (the pump) to be recorded on the run.
    onChange: async () => {
      hookCalls += 1;
      if (hookCalls > 2) throw new Error("host persistence is unavailable");
    },
  });

  const started = await engine.start(workflow, { id: "audit-stuck-run", turn: 7 });
  const blocked = await engine.wait(started.id);
  assert.equal(blocked.status, "awaiting-model-choice");
  assert.equal(hookCalls > 0, true);

  // Retrying passes through the host hook by design, so the expected failure surfaces here; the pump
  // that follows is where it gets recorded on the run.
  await engine.retry(started.id, "archive", null).catch(error => {
    assert.match(String(error?.message || error), /host persistence is unavailable/);
  });

  let stuck = null;
  for (let attempt = 0; attempt < 600 && !stuck; attempt += 1) {
    stuck = engine.blockingTurnRuns().find(item => (item.changeFailures || []).length) || null;
    if (!stuck) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(stuck, "the blocking run must report the hook failure that stopped it");
  assert.equal(stuck.runId, started.id);
  assert.equal(stuck.workflowTitle, "Stuck archive");
  assert.match(stuck.changeFailures.at(-1).message, /host persistence is unavailable/);
  assert.equal(engine.hasBlockingTurnRun(), true, "the run still blocks the next turn");

  // A completed run reports no failures, so the panel only warns when there is something to warn about.
  const healthy = new RpWorkflowEngine({ executor: async () => ({ output: "archived" }) });
  const healthyRun = await healthy.start(workflow, { id: "audit-healthy-run", turn: 8 });
  await healthy.wait(healthyRun.id);
  assert.deepEqual(healthy.blockingTurnRuns(), []);
});

test("reuseCompleted works for a multiple-instance workflow that declares no dedupeKey", { timeout: 20000 }, async t => {
  // `reuseCompleted` defaults to true. A `multiple` workflow without a `dedupeKey` used to get a freshly
  // minted random suffix in its instance key, so the reuse lookup compared against a value that could
  // never match and the branch was dead: the same node asking for the same call twice re-ran the child
  // (and its side effects) instead of reusing the completed result.
  const child = {
    schemaVersion: 3,
    id: "audit-child",
    ownerModuleId: "audit",
    kind: "module-external",
    interface: { inputs: { label: { type: "parameter", required: true, valueType: "string" } }, exports: {} },
    instancePolicy: { mode: "multiple", maxConcurrentInstances: 4 },
    nodes: [{ id: "work", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  const parent = {
    schemaVersion: 3,
    id: "audit-parent",
    kind: "global-background",
    nodes: [{ id: "call-twice", type: "code", workflowCalls: ["audit/audit-child"] }],
  };

  let childWorkRuns = 0;
  const engine = new RpWorkflowEngine({
    resolveWorkflow: async () => child,
    executor: async task => {
      if (task.workflow.id === parent.id) {
        const request = { workflow: "audit/audit-child", arguments: { label: "same-call" }, outputPaths: {} };
        const first = await task.invokeWorkflow(request);
        const second = await task.invokeWorkflow(request);
        return { output: { first: first.callId, second: second.callId } };
      }
      if (task.node.id === "work") childWorkRuns += 1;
      if (task.node.type === "workflow-return") return { output: { outputs: {} } };
      return { output: "done" };
    },
  });

  const started = await engine.start(parent, { id: "audit-parent-run" });
  const completed = await engine.wait(started.id);
  assert.equal(completed.status, "completed");
  const { first, second } = completed.nodes["call-twice"].output;
  assert.equal(first, second, "the second identical call must reuse the completed child run");
  assert.equal(engine.snapshot().filter(run => run.workflowId === child.id).length, 1, "the child must not run twice");
  assert.equal(childWorkRuns, 1, "the child's work must execute once");
});

test("the extension wires the frozen read boundary into data.getCurrent", async () => {
  // `getCurrent` lives in the Pi extension, which cannot be imported here (it needs the Pi runtime), so
  // this pins the wiring rather than the behaviour: before the fix the call passed capabilities and
  // views only, so a code node could read a record committed after its own run started.
  const extension = await readFile(new URL("../extensions/pi-rp-web.ts", import.meta.url), "utf8");
  const start = extension.indexOf("getCurrent: (request: any) => {");
  assert.ok(start > 0, "the code-node data service must still expose getCurrent");
  const body = extension.slice(start, extension.indexOf("},", start));
  assert.match(body, /workflowDataReadAccess\(run, store, dataReadBatchIds\)/, "getCurrent must read through the run's frozen view");
  assert.match(body, /accessFor\(request\.moduleId, request\.collectionId\)/, "getCurrent must still require a declared collection access");

  // The restore path must not leave an unrestorable run blocking the chat for ever.
  const marker = extension.indexOf("Could not be restored:");
  assert.ok(marker > 0, "a failed restore must record why it failed");
  const restoreCatch = extension.slice(Math.max(0, marker - 400), marker + 1400);
  assert.match(restoreCatch, /status: "failed"/, "a failed restore must leave the run in a terminal status");
  assert.match(restoreCatch, /appendWorkflowRunRecord/, "the terminal status must be persisted, not only held in memory");
  assert.match(restoreCatch, /hook: "restore"/, "the persisted run must carry the reason for the panel");
});

test("module workflows are never matched as top-level trigger targets", () => {
  const moduleWorkflow = {
    schemaVersion: 3,
    id: "m",
    ownerModuleId: "audit",
    kind: "module-internal",
    nodes: [{ id: "work", type: "code" }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: {} }],
  };
  assert.equal(workflowTriggerMatches(moduleWorkflow, { type: "manual" }), false);
  assert.equal(normalizeWorkflowDefinition({ schemaVersion: 3, id: "x", kind: "turn-background", trigger: { type: "after-workflow", workflowId: "audit-parent" }, nodes: [{ id: "n", type: "code" }] }).trigger.workflowId, "audit-parent");
});
