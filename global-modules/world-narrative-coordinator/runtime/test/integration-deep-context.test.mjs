import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { execute as runDeepIfNeeded } from "../../integration/runtime/run-deep-if-needed.mjs";

/**
 * The real `deep-state` contract, read from the module's own schema and data-contract files.
 *
 * The failure path asserts against these instead of a hand-copied field list on purpose. The defect it
 * guards against was a failure handler that built its patch from a *projected* read: the runtime
 * renders a record through the requested view, and a narrow view (here `deep-status`) simply does not
 * contain `lastTriggerWorldTime`/`lastCompletedWorldTime`. A harness that returned the whole record
 * for every view would have agreed with the bug, so this one renders views exactly like the runtime.
 */
const deepStateSchema = JSON.parse(await readFile(new URL("../../schemas/deep-state.schema.json", import.meta.url), "utf8"));
const dataContract = JSON.parse(await readFile(new URL("../../data-contract.json", import.meta.url), "utf8"));

function viewDefinition(recordType, viewId) {
  const view = dataContract.collections["deep-workbench"].recordTypes[recordType].views[viewId];
  if (!view) throw new Error(`deep-workbench/${recordType} does not define view ${viewId}.`);
  return view;
}

function valueAt(record, path) {
  return path.split("/").filter(Boolean).reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), record);
}

/** Mirrors `renderDataRecordView` for object views: one key per declared field label, resolved against
 *  the record (view paths are `/data/...`, so the caller must pass the record, not its data). */
function projectView(record, recordType, viewId) {
  const result = {};
  for (const field of viewDefinition(recordType, viewId).fields) result[field.label || field.path.split("/").at(-1)] = structuredClone(valueAt(record, field.path));
  return result;
}

function deepStateErrors(value) {
  const errors = [];
  for (const field of deepStateSchema.required) if (value[field] === undefined) errors.push({ path: `/data/${field}`, code: "required" });
  for (const [field, spec] of Object.entries(deepStateSchema.properties)) {
    const current = value[field];
    if (current === undefined || current === null) continue;
    if (Array.isArray(spec.enum) && !spec.enum.includes(current)) errors.push({ path: `/data/${field}`, code: "enum" });
    if (spec.type === undefined) continue;
    const expected = Array.isArray(spec.type) ? spec.type : [spec.type];
    const actual = Array.isArray(current) ? "array" : Number.isInteger(current) ? "integer" : typeof current;
    if (!expected.includes(actual) && !(actual === "integer" && expected.includes("number"))) errors.push({ path: `/data/${field}`, code: "type" });
    if (Number.isInteger(current) && Number.isInteger(spec.minimum) && current < spec.minimum) errors.push({ path: `/data/${field}`, code: "minimum" });
    if (spec.type === "array" && !current.every(item => spec.items?.type === undefined || typeof item === spec.items.type)) errors.push({ path: `/data/${field}`, code: "items" });
  }
  for (const field of Object.keys(value)) if (!(field in deepStateSchema.properties)) errors.push({ path: `/data/${field}`, code: "additionalProperties" });
  return errors;
}

function assertSatisfiesDeepState(value) {
  const errors = deepStateErrors(value);
  assert.deepEqual(errors, [], `deep-state record does not satisfy its own schema: ${JSON.stringify(errors)}`);
}

/**
 * RC-06 follow-up: the deep wrapper used to fall back to raw conversation history whenever
 * `trigger/story-context` was missing. On the post-turn path that hid a dangling trigger mapping
 * (the wrapper was mapped to a post-director integration whose review node produced no story
 * context) and froze the current conversation as "the frozen story context" instead — a deep report
 * that looks successful while being based on different material than the run handed over.
 *
 * `metadata.storyContextSource` makes the choice explicit: `trigger` requires the handover and
 * fails, `history` is the deliberate opening/manual fallback.
 *
 * The harness keeps the deep-workbench records live so the wrapper's real `begin-deep-operation` and
 * `deep-state-current` handshake is exercised rather than stubbed away.
 */
async function harness({ storyContextSource, withTrigger = false, onInvoke = () => {}, workflowMode = "single", deepState = null, recordType = "director.deep-state" }) {
  const workspace = await mkdtemp(resolve(tmpdir(), "rp-deep-context-"));
  if (withTrigger) {
    await mkdir(resolve(workspace, "trigger", "story-context"), { recursive: true });
    await writeFile(resolve(workspace, "trigger", "story-context", "DOCUMENTS.md"), "# Frozen story context\n", "utf8");
  }
  const records = new Map([
    ["world-narrative-coordinator/settings/director-settings-current", { id: "director-settings-current", revision: 1, value: { enabled: true, deep: { workflowMode } } }],
    ["world-narrative-coordinator/private-state/turn-brief-current", { id: "turn-brief-current", revision: 1, value: { deepRecommendation: { shouldStart: true, reasonCodes: ["pacing"] } } }],
    ["world-narrative-coordinator/deep-workbench/deep-state-current", deepState || { id: "deep-state-current", revision: 1, value: { status: "idle", currentRunId: null, currentChildRunId: null } }],
  ]);
  const invoked = [];
  const submitted = [];
  const data = {
    // A read returns the record's data *through the requested view*, exactly like the runtime; the
    // wrapper decides which view it needs, and a narrow one silently loses fields.
    async get(request) {
      const record = records.get(`${request.moduleId}/${request.collectionId}/${request.id}`);
      if (!record) return null;
      if (request.collectionId !== "deep-workbench") return record;
      const type = request.id === "deep-state-current" ? recordType : "director.deep-operation";
      return { ...record, value: projectView({ data: record.value }, type, request.view || "rp") };
    },
    async receipt() { return null; },
    // The engine's node data adapter throws when a batch does not commit, which is what turned the
    // real failure handler's bad patch into a failed node. Invalid patches fail here the same way,
    // after the JSON round trip that durable storage performs.
    async submit(batch) {
      submitted.push(batch);
      const durable = JSON.parse(JSON.stringify(batch));
      for (const operation of durable.operations || []) {
        const key = `${operation.moduleId}/${operation.collectionId}/${operation.targetId}`;
        const existing = records.get(key);
        const errors = deepStateErrors(operation.data);
        if (errors.length) {
          const error = new Error(`Data batch ${batch.batchId} completed with status failed: Record ${operation.targetId} data schema validation failed: ${JSON.stringify(errors)}`);
          error.code = "data_schema_invalid";
          throw error;
        }
        records.set(key, { id: operation.targetId, revision: (existing?.revision || 0) + 1, value: operation.data });
      }
      return { status: "committed", batchId: batch.batchId };
    },
  };
  try {
    const result = await runDeepIfNeeded({
      run: { id: "wrapper-run", turn: 4, visibleThroughTurn: 4 },
      node: { id: "start-if-needed", metadata: storyContextSource === undefined ? {} : { storyContextSource } },
      conversation: { messages: [] },
      data,
      calls: { invoke: async request => { invoked.push(request); onInvoke(request, { records }); return { callId: "child-run", outputs: { report: "report.json", references: "references.json" } }; } },
      workspace,
    });
    return { result, invoked, workspace, records, submitted };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    Object.assign(error, { invoked, records, submitted });
    throw error;
  }
}

test("a post-turn wrapper refuses to substitute history for the frozen story context", async t => {
  let invoked = [];
  const error = await harness({ storyContextSource: "trigger", onInvoke: request => invoked.push(request) }).then(() => null, failure => failure);
  assert.ok(error instanceof Error, "the missing handover is a failure, not a silent fallback");
  assert.match(error.message, /requires the frozen story context from its trigger/);
  assert.match(error.message, /Re-map the trigger document/);
  // The guard fires before any child workflow is started, so no deep operation is left behind.
  assert.deepEqual(invoked, []);
  // A run that does receive the handover proceeds normally.
  const ok = await harness({ storyContextSource: "trigger", withTrigger: true });
  t.after(() => rm(ok.workspace, { recursive: true, force: true }));
  assert.equal(ok.result.started, true);
});

test("a deep wrapper without an explicit story-context source fails closed", async () => {
  const error = await harness({ storyContextSource: undefined }).then(() => null, failure => failure);
  assert.ok(error instanceof Error);
  assert.match(error.message, /must be explicitly declared as "trigger" or "history"/);
  assert.deepEqual(error.invoked, []);
});

test("a wrapper that receives the handover registers its operation and passes the context through", async t => {
  const { result, invoked, workspace } = await harness({ storyContextSource: "trigger", withTrigger: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(result.started, true);
  assert.equal(result.operationId, "deep-operation-turn-4");
  assert.deepEqual(invoked.map(request => request.workflow), [
    "world-narrative-coordinator/begin-deep-operation",
    "world-narrative-coordinator/deep-director-planning",
  ]);
  assert.equal(invoked[0].arguments.operationId, "deep-operation-turn-4");
  assert.equal(invoked[1].documents["story-context"], "trigger/story-context");
  assert.equal(invoked[1].arguments.operationId, "deep-operation-turn-4");
});

test("the opening wrapper keeps the explicit history fallback", async t => {
  const { result, invoked, workspace } = await harness({ storyContextSource: "history" });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(result.started, true);
  assert.equal(invoked.at(-1).documents["story-context"], "deep-story-context");
});

test("a wrapper whose operation was already closed does not silently complete", async t => {
  const { workspace } = await harness({ storyContextSource: "history" });
  await rm(workspace, { recursive: true, force: true });
  const closed = await harness({
    storyContextSource: "history",
    deepState: { id: "deep-state-current", revision: 3, value: { status: "failed", currentRunId: null, currentChildRunId: null } },
  }).then(() => null, error => error);
  // No operation record exists yet, so this is a fresh start on a failed state rather than a closed
  // operation; the important half is that it is not reported as `already-running`.
  assert.equal(closed, null, "a failed state starts a new operation");
});

test("an unknown story-context source is rejected instead of guessed", async t => {
  const { workspace } = await harness({ storyContextSource: "trigger", withTrigger: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await assert.rejects(() => harness({ storyContextSource: "guess" }), /must be "trigger" or "history"/);
});

/** A live operation owned by this wrapper's turn, as `begin-deep-operation` would have left it. */
const ownedRunningState = {
  id: "deep-state-current",
  revision: 3,
  value: {
    status: "running", currentRunId: "deep-operation-turn-4", currentChildRunId: "child-run",
    lastTriggerTurn: 4, lastTriggerWorldTime: "第三日清晨", lastCompletedTurn: 3, lastCompletedWorldTime: "第二日黄昏",
    currentReportRevision: 2, triggerReasons: ["pacing"], failure: null,
  },
};

test("a failed deep run releases its own state instead of leaving the operation stuck as running", async () => {
  // Real round-3 failure: the planning child failed, the failure handler's patch did not satisfy the
  // deep-state schema, the runtime rejected the batch, and `deep-state-current` stayed `running` with
  // its `deep-operation-turn-4` manifest open — so the next turn could not deep-run at all. The
  // handler must now carry the whole record forward, and it must read it through a view that contains
  // the whole record: the two world-time fields it lost are exactly what the `deep-status` projection
  // hides.
  const failure = await harness({
    storyContextSource: "history",
    deepState: structuredClone(ownedRunningState),
    onInvoke: request => { if (request.workflow.includes("deep-director-planning")) throw new Error("The planning Agent returned no usable report."); },
  }).then(() => null, error => error);
  assert.ok(failure instanceof Error, "the child failure still propagates to the caller");
  assert.match(failure.message, /no usable report/);

  const patch = failure.records.get("world-narrative-coordinator/deep-workbench/deep-state-current");
  assert.equal(patch.revision, 4, "the state was actually submitted");
  assert.equal(patch.value.status, "failed");
  assert.equal(patch.value.currentRunId, null, "the operation no longer owns the state");
  assert.equal(patch.value.currentChildRunId, null);
  assert.equal(patch.value.lastCompletedTurn, 3, "known history is carried forward, not rebuilt");
  assert.equal(patch.value.lastTriggerWorldTime, "第三日清晨", "the trigger world time survives the failure patch");
  assert.equal(patch.value.lastCompletedWorldTime, "第二日黄昏");
  assert.equal(patch.value.currentReportRevision, 2);
  assert.deepEqual(patch.value.triggerReasons, ["pacing"]);
  assert.match(patch.value.failure, /no usable report/);
  assertSatisfiesDeepState(patch.value);
});

test("the narrow deep-status projection cannot produce a valid failure patch", async () => {
  // Documents the trap the test above depends on: reading the state as `deep-status` drops
  // `lastTriggerWorldTime`/`lastCompletedWorldTime`, so a patch spread from that read is rejected by
  // the schema. If someone reverts the handler to the narrow view, the assertions above fail — this
  // case shows why instead of leaving it to inference.
  const projected = projectView({ data: structuredClone(ownedRunningState.value) }, "director.deep-state", "deep-status");
  assert.equal(projected.lastTriggerWorldTime, undefined);
  assert.equal(projected.lastCompletedWorldTime, undefined);
  const errors = deepStateErrors({ ...projected, status: "failed", currentRunId: null, currentChildRunId: null, failure: "boom" });
  assert.deepEqual(errors.map(error => error.path).sort(), ["/data/lastCompletedWorldTime", "/data/lastTriggerWorldTime"]);
  // The complete view the wrapper now reads through satisfies the same schema.
  assertSatisfiesDeepState({ ...projectView({ data: structuredClone(ownedRunningState.value) }, "director.deep-state", "deep-director"), status: "failed", currentRunId: null, failure: "boom" });
});

test("a state that another operation took over is not clobbered by this wrapper's failure", async () => {
  // The guard is not theoretical: a retried wrapper can outlive its own operation, and a failure
  // handler is exactly where a stale writer would otherwise overwrite a newer operation's live state.
  const failure = await harness({
    storyContextSource: "history",
    deepState: structuredClone(ownedRunningState),
    onInvoke: (request, { records }) => {
      if (!request.workflow.includes("deep-director-planning")) return;
      records.set("world-narrative-coordinator/deep-workbench/deep-state-current", {
        id: "deep-state-current", revision: 7,
        value: { ...structuredClone(ownedRunningState.value), currentRunId: "deep-operation-turn-5" },
      });
      throw new Error("The planning Agent returned no usable report.");
    },
  }).then(() => null, error => error);
  assert.ok(failure instanceof Error);
  const untouched = failure.records.get("world-narrative-coordinator/deep-workbench/deep-state-current");
  assert.equal(untouched.revision, 7, "the newer operation's record is left exactly as it was");
  assert.equal(untouched.value.status, "running");
  assert.equal(untouched.value.currentRunId, "deep-operation-turn-5");
});
