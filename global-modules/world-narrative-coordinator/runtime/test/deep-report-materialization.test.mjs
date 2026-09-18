import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { execute as materializeReport } from "../workflow/materialize-deep-report.mjs";
import { execute as commitReport } from "../workflow/commit-deep-report.mjs";
import { parseDeepReport, validateDeepReport } from "../lib/deep-report.mjs";

/**
 * RC-09: the plan node declared `deep-report.json` and a required workspace handoff, but nothing
 * wrote the file — the Agent's task said "reply with JSON", and the commit node read a path that only
 * exists if someone writes it. A correct JSON reply therefore ended in
 * `Required workspace handoff output report is missing.`, and the commit node never ran.
 *
 * The report is now materialized by a deterministic node from the plan's structured output, the
 * materializer declares the artifact and hands it to commit, and commit re-validates what it reads.
 */

const basisTurn = 4;

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    basisTurn,
    basisWorldTime: "第三日黄昏",
    coverage: ["世界现状", "角色走势"],
    assumptions: ["商路仍开放"],
    invalidatingSignals: ["城门封锁"],
    summary: "一句话摘要。",
    content: "完整推演正文。",
    worldNarrativeTopics: [{ id: "topic-haven", status: "active", premise: "避难所网络" }, { id: "topic-ruins", status: "backup", premise: "遗迹回声" }],
    nextReviewTriggers: ["玩家离开城镇"],
    referenceUpdates: [],
    ...overrides,
  };
}

async function workspaceWith(contents) {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-report-"));
  if (contents !== null) await writeFile(resolve(workspace, "deep-report.json"), contents, "utf8");
  return workspace;
}

function runState(status = "completed", output = report()) {
  return { id: "run-1", turn: basisTurn, nodes: { plan: { id: "plan", status, output } } };
}

const materializeNode = { id: "materialize-report", metadata: { sourceNode: "plan", sourceOutput: "report", outputName: "report" }, outputs: { report: { path: "deep-report.json", format: "json", kind: "file" } } };

test("a JSON reply becomes the declared report artifact", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-materialize-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await materializeReport({ run: runState(), node: materializeNode, workspace });
  assert.equal(result.output.materialized, true);
  assert.equal(result.output.path, "deep-report.json");
  const written = JSON.parse(await readFile(resolve(workspace, "deep-report.json"), "utf8"));
  assert.equal(written.basisTurn, basisTurn);
  assert.equal(written.worldNarrativeTopics.length, 2);
  // A fenced JSON answer is accepted, because models fence JSON even when told not to.
  const fenced = await mkdtemp(resolve(tmpdir(), "rp-deep-materialize-"));
  t.after(() => rm(fenced, { recursive: true, force: true }));
  await materializeReport({ run: runState("completed", `\`\`\`json\n${JSON.stringify(report())}\n\`\`\``), node: materializeNode, workspace: fenced });
  assert.equal(JSON.parse(await readFile(resolve(fenced, "deep-report.json"), "utf8")).summary, "一句话摘要。");
});

test("a plan that did not produce a structurally valid report is refused", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-materialize-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await assert.rejects(() => materializeReport({ run: runState("completed", "not json at all"), node: materializeNode, workspace }), /not valid JSON/);
  await assert.rejects(() => materializeReport({ run: runState("completed", report({ basisTurn: 3 })), node: materializeNode, workspace }), /is not this run's turn/);
  await assert.rejects(() => materializeReport({ run: runState("completed", report({ worldNarrativeTopics: [{ id: "a", status: "active" }] })), node: materializeNode, workspace }), /at least one backup/);
  await assert.rejects(() => materializeReport({ run: runState("completed", report({ worldNarrativeTopics: [{ id: "a", status: "backup" }, { id: "b", status: "backup" }] })), node: materializeNode, workspace }), /exactly one active/);
  await assert.rejects(() => materializeReport({ run: runState("failed", report()), node: materializeNode, workspace }), /is failed; the report cannot be materialized/);
  assert.equal(await readFile(resolve(workspace, "deep-report.json"), "utf8").then(() => true, () => false), false, "nothing is written when validation fails");
});

test("the report contract rejects bad JSON, missing fields, and an off-turn basis", () => {
  assert.throws(() => parseDeepReport("{oops"), /not valid JSON/);
  assert.throws(() => parseDeepReport("[]"), /must be a JSON object/);
  assert.throws(() => validateDeepReport(report({ coverage: "everything" }), { basisTurn }), /coverage must be an array/);
  assert.throws(() => validateDeepReport(report({ content: 42 }), { basisTurn }), /content must be text/);
  assert.throws(() => validateDeepReport(report({ basisTurn: 9 }), { basisTurn }), /is not this run's turn/);
  assert.throws(() => validateDeepReport(report({ referenceUpdates: "none" }), { basisTurn }), /referenceUpdates must be an array/);
  assert.deepEqual(validateDeepReport(report({ referenceUpdates: undefined }), { basisTurn }).referenceUpdates, []);
});

test("the agent's documented field set is accepted, with or without the version marker", () => {
  // The planning prompt asks for exactly these nine fields. `schemaVersion` is the materializer's own
  // marker, so a reply that omits it is normal — the real run's plan node produced precisely this
  // shape and the strict check turned a usable report into a failed node.
  const agentReply = {
    basisTurn,
    basisWorldTime: "第三日黄昏",
    coverage: ["世界现状"],
    assumptions: [],
    invalidatingSignals: [],
    summary: "摘要。",
    content: "正文。",
    worldNarrativeTopics: [{ topicId: "a", status: "active" }, { topicId: "b", status: "backup" }],
    nextReviewTriggers: [],
  };
  const normalized = validateDeepReport(agentReply, { basisTurn });
  assert.equal(normalized.schemaVersion, 1, "the marker is filled in rather than demanded from the model");
  assert.equal(normalized.basisTurn, basisTurn);
  assert.deepEqual(normalized.referenceUpdates, []);

  // An omitted basisTurn adopts the run's turn; a stated one that differs is still rejected.
  const withoutTurn = { ...agentReply };
  delete withoutTurn.basisTurn;
  assert.equal(validateDeepReport(withoutTurn, { basisTurn }).basisTurn, basisTurn);
  assert.throws(() => validateDeepReport({ ...agentReply, schemaVersion: 2 }, { basisTurn }), /schemaVersion must be 1/);
  // The run turn is the basis itself, so a caller that forgot it must not get a report without one.
  assert.throws(() => validateDeepReport(withoutTurn, {}), /requires the run's turn as its basis/);
  assert.throws(() => validateDeepReport(withoutTurn), /requires the run's turn as its basis/);
});

function commitHarness({ reportContents, submits }) {
  const workspace = resolve("/tmp/placeholder");
  return { workspace, submits };
}

test("commit reads the materialized artifact through the handoff and re-validates it", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-commit-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(resolve(workspace, "handoff", "materialize-report"), { recursive: true });
  await writeFile(resolve(workspace, "handoff", "materialize-report", "deep-report.json"), JSON.stringify(report()), "utf8");
  const submits = [];
  const record = (id, revision, data) => ({ id, revision, value: data });
  const data = {
    async get(request) {
      if (request.id === "deep-report-current") return record(request.id, 2, { basisTurn: 3 });
      if (request.id === "deep-state-current") return record(request.id, 5, { status: "running", currentRunId: `deep-operation-turn-${basisTurn}` });
      if (request.id === `deep-operation-turn-${basisTurn}`) return record(request.id, 1, { operationId: `deep-operation-turn-${basisTurn}`, rootRunId: "run-1", status: "running", openedTurn: basisTurn, closedTurn: null, terminalError: null });
      return null;
    },
    async submit(batch, options) { submits.push({ batch, options }); return { status: "committed", batchId: batch.batchId }; },
  };
  const run = { id: "run-1", turn: basisTurn, arguments: { triggerReasons: ["pacing"] }, nodes: { "materialize-report": { id: "materialize-report", status: "completed", output: { materialized: true } } }, sourceReferences: [] };
  const result = await commitReport({ run, node: { id: "commit", metadata: { reportNode: "materialize-report" } }, workspace, conversation: { messages: [] }, data });
  assert.equal(result.committed, true);
  assert.equal(submits.length, 1, "one commit for one report");
  const [reportOperation, stateOperation, manifestOperation] = submits[0].batch.operations;
  assert.equal(reportOperation.data.content, "完整推演正文。");
  assert.equal(reportOperation.data.basisTurn, basisTurn);
  assert.equal(stateOperation.data.status, "idle");
  assert.equal(stateOperation.data.currentRunId, null);
  assert.equal(stateOperation.data.currentChildRunId, null);
  assert.equal(stateOperation.data.currentReportRevision, 3);
  // The manifest is closed in the same batch. Releasing the state alone left `deep-operation-turn-<n>`
  // `running` forever, because nothing else closes it on the single-mode path.
  assert.equal(manifestOperation.recordType, "director.deep-operation");
  assert.equal(manifestOperation.targetId, `deep-operation-turn-${basisTurn}`);
  assert.equal(manifestOperation.data.status, "completed");
  assert.equal(manifestOperation.data.closedTurn, basisTurn);
  assert.equal(manifestOperation.data.rootRunId, "run-1", "the manifest keeps the fields its schema requires");
  assert.equal(result.operationClosed, true);

  // A retried commit that finds the manifest already terminal must not rewrite it.
  const settled = {
    async get(request) {
      if (request.id === "deep-report-current") return record(request.id, 2, { basisTurn: 3 });
      if (request.id === "deep-state-current") return record(request.id, 5, { status: "running", currentRunId: `deep-operation-turn-${basisTurn}` });
      if (request.id === `deep-operation-turn-${basisTurn}`) return record(request.id, 2, { operationId: `deep-operation-turn-${basisTurn}`, rootRunId: "run-1", status: "completed", openedTurn: basisTurn, closedTurn: basisTurn, terminalError: null });
      return null;
    },
    async submit(batch) { submits.push({ batch }); return { status: "committed", batchId: batch.batchId }; },
  };
  const retried = await commitReport({ run, node: { id: "commit", metadata: { reportNode: "materialize-report" } }, workspace, conversation: { messages: [] }, data: settled });
  assert.equal(retried.operationClosed, false);
  assert.equal(submits[1].batch.operations.length, 2, "a terminal manifest is left alone");
});

test("commit refuses to run when the report node did not complete or the file is bad", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-commit-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(resolve(workspace, "handoff", "materialize-report"), { recursive: true });
  const data = { async get() { return null; }, async submit() { return { status: "committed" }; } };
  const base = { id: "run-1", turn: basisTurn, arguments: {}, nodes: { "materialize-report": { id: "materialize-report", status: "completed" } }, sourceReferences: [] };
  const node = { id: "commit", metadata: { reportNode: "materialize-report" } };

  await assert.rejects(
    () => commitReport({ run: { ...base, nodes: { "materialize-report": { id: "materialize-report", status: "awaiting-model-choice", attempts: [{ error: "agent returned no text output" }] } } }, node, workspace, conversation: { messages: [] }, data }),
    /is awaiting-model-choice \(agent returned no text output\); refusing to commit/,
  );

  for (const contents of [null, "{broken", JSON.stringify(report({ basisTurn: 1 }))]) {
    await rm(resolve(workspace, "handoff", "materialize-report", "deep-report.json"), { force: true });
    if (contents !== null) await writeFile(resolve(workspace, "handoff", "materialize-report", "deep-report.json"), contents, "utf8");
    await assert.rejects(() => commitReport({ run: base, node, workspace, conversation: { messages: [] }, data }), /ENOENT|not valid JSON|is not this run's turn/);
  }
});

test("retrying materialization and commit does not submit twice", async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-retry-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // Materialization is a pure function of the plan output, so a retry rewrites identical bytes.
  await materializeReport({ run: runState(), node: materializeNode, workspace });
  const first = await readFile(resolve(workspace, "deep-report.json"), "utf8");
  await materializeReport({ run: runState(), node: materializeNode, workspace });
  assert.equal(await readFile(resolve(workspace, "deep-report.json"), "utf8"), first);
  // And commit is idempotent by batchId: the second attempt is the same batch, not a new one.
  const submits = [];
  const data = {
    async get(request) { return request.id === "deep-report-current" ? { id: request.id, revision: 2, value: {} } : { id: request.id, revision: 5, value: { status: "idle" } }; },
    async submit(batch) { submits.push(batch.batchId); return { status: "committed", batchId: batch.batchId }; },
  };
  await mkdir(resolve(workspace, "handoff", "materialize-report"), { recursive: true });
  await writeFile(resolve(workspace, "handoff", "materialize-report", "deep-report.json"), first, "utf8");
  const run = { id: "run-1", turn: basisTurn, arguments: {}, nodes: { "materialize-report": { id: "materialize-report", status: "completed" } }, sourceReferences: [] };
  const node = { id: "commit", metadata: { reportNode: "materialize-report" } };
  await commitReport({ run, node, workspace, conversation: { messages: [] }, data });
  await commitReport({ run, node, workspace, conversation: { messages: [] }, data });
  assert.deepEqual(submits, ["run-1-deep-complete", "run-1-deep-complete"]);
});
